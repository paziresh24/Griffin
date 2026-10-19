import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSlug } from "../persona.mjs";

// The owner's full Claude Code (config CLAUDE_CODE=on) runs Bash as the app's user, which owns the
// data folder (the owner token, secrets.key, the database, engine keys) and the knowledge store.
// providers/file-scope.mjs fences the file tools; Bash was left open. A chat that had read
// third-party text could then write a note marked «reviewed: true» that every later prompt carries
// as trusted, or rewrite the owner token. This state guard is on by default wherever CLAUDE_CODE is on (config STATE_GUARD=off turns it off): the owner's
// chats keep the full toolset and every folder they work in; only the knowledge store and Griffin's
// data folder refuse changes. The owner's home folder, when it lies inside the data folder
// (HOME=/data/home in the image), stays the owner's: it is excepted.
//
// Bash is checked by its text (paths it names, its working folder): a best-effort fence, not a
// sandbox — a path assembled at run time (variables, base64, a script file written first) is not
// seen. The file tools are checked exactly, through symlinks and "..".

// Each file-writing built-in and the input field holding its path.
export const WRITE_TOOLS = Object.freeze({ Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" });

// The real path of `target` through symlinks, even when it does not exist yet: the nearest
// existing ancestor is resolved and the rest appended. A dangling symlink on the way (a link to a
// file not written yet) is followed to its target, part by part, up to 40 links.
export function realish(target, depth = 0) {
  let dir = target;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...[...rest].reverse());
    } catch {
      try {
        if (depth < 40 && fs.lstatSync(dir).isSymbolicLink()) {
          const to = path.resolve(path.dirname(dir), fs.readlinkSync(dir));
          return realish(path.join(to, ...[...rest].reverse()), depth + 1);
        }
      } catch {
        /* not there at all: go up */
      }
      const up = path.dirname(dir);
      if (up === dir) return target;
      rest.push(path.basename(dir));
      dir = up;
    }
  }
}

const within = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// $VAR / ${VAR} from the environment the guard was given; an unknown one stays as written.
function expandVars(text, env) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
    const value = env[a || b];
    return typeof value === "string" && value ? value : whole;
  });
}

// A glob segment as a regular expression (*, ?, [..]).
function segmentRegex(seg) {
  let out = "";
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i];
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end > i) {
        out += `[${seg.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      } else out += "\\[";
    } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// How the absolute glob `pattern` relates to `root`: "inside" when it can name root or something in
// it, "above" when it can name a folder above it, else null.
function globRelation(pattern, root) {
  const p = pattern.split("/").filter(Boolean);
  const r = root.split("/").filter(Boolean);
  for (let i = 0; i < Math.min(p.length, r.length); i += 1) {
    if (p[i] === "**") return "inside";
    if (!segmentRegex(p[i]).test(r[i])) return null;
  }
  return p.length >= r.length ? "inside" : "above";
}

// Shell text read roughly the way bash reads words: $'…' escapes decoded, $"…" (a locale string,
// the same text as "…") undone, line continuations joined, backslashes dropped, quotes removed.
function unshell(text) {
  const named = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
  return String(text)
    .replace(/\$"/g, '"')
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, body) =>
      body.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(.))/g, (m, o, x, u, U, c) =>
        o ? String.fromCharCode(parseInt(o, 8)) : x ? String.fromCharCode(parseInt(x, 16)) : u || U ? String.fromCodePoint(parseInt(u || U, 16)) : named[c] ?? c,
      ),
    )
    .replace(/\\\n/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/["']/g, "");
}

// Brace expansion: a{b,c}d -> abd, acd, and sequences a{1..3} / a{x..z} (nested braces are expanded
// in turn, up to 64 words). The result carries `capped` when the 64 words did not cover it all: the
// caller then treats the word as naming the store, since the words it did not see could.
const BRACE_SEQ = /^(.*?)\{(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?\}(.*)$/s;
function braces(word) {
  const out = [];
  const queue = [word];
  let capped = false;
  while (queue.length) {
    if (out.length + queue.length > 64) {
      capped = true;
      break;
    }
    const w = queue.shift();
    const list = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s.exec(w);
    const seq = list ? null : BRACE_SEQ.exec(w);
    if (list) for (const part of list[2].split(",")) queue.push(list[1] + part + list[3]);
    else if (seq) {
      const numeric = /\d/.test(seq[2]);
      const a = numeric ? Number(seq[2]) : seq[2].charCodeAt(0);
      const b = numeric ? Number(seq[3]) : seq[3].charCodeAt(0);
      const step = Math.max(1, Math.abs(Number(seq[4] || 1)));
      const n = Math.floor(Math.abs(b - a) / step) + 1;
      if (n > 64) {
        capped = true;
        out.push(w);
        continue;
      }
      for (let k = 0; k < n; k += 1) {
        const v = a + (b >= a ? 1 : -1) * k * step;
        queue.push(seq[1] + (numeric ? String(v) : String.fromCharCode(v)) + seq[5]);
      }
    } else out.push(w);
  }
  return Object.assign(out.concat(queue), { capped });
}

function expandTilde(p, home) {
  if (p === "~" || p.startsWith("~/")) return path.join(home, p.slice(1));
  const m = /^~([A-Za-z0-9._-]+)(\/.*)?$/.exec(p);
  return m ? path.join(path.dirname(home), m[1], m[2] || "") : p;
}

// The words of one command segment: split on blanks, redirection signs and grouping.
const wordsOf = (segment) => segment.split(/[\s()<>`]+/).filter(Boolean);
// Also the part after "=" (--output=/x, VAR=/x) and after "host:" (scp-style).
function pathCandidates(word) {
  const out = [word];
  const eq = word.indexOf("=");
  if (eq >= 0 && eq < word.length - 1) out.push(word.slice(eq + 1));
  const colon = word.indexOf(":");
  if (colon > 0 && word.slice(colon + 1).startsWith("/")) out.push(word.slice(colon + 1));
  // A short option with its value attached (`-t/dir`, `-vt~/dir`): the value is a path too.
  const attached = /^-[A-Za-z]+([/~].*)$/s.exec(word);
  if (attached) out.push(attached[1]);
  const expanded = out.map(braces);
  return Object.assign(expanded.flat(), { capped: expanded.some((list) => list.capped) });
}

// Text in a command that is data, never run and never a path: the body of a heredoc fed to cat or
// tee (when it cannot run a substitution), and the quoted message of git/gh/glab (-m, --message,
// --title, --body, --description) when it cannot run one either. Removed before the store check, so
// a commit message or a note written elsewhere may mention the store's path.
// `<<<` is a here-string, not a heredoc: its word is not a delimiter and nothing after it is data.
const HEREDOC = /(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/;
function dropData(raw) {
  const lines = String(raw).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    const m = HEREDOC.exec(line);
    if (!m) continue;
    const before = line.slice(0, m.index).split(/\|\||&&|[|;&(]/).at(-1);
    const sink = path.basename(wordsOf(unshell(before)).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))[0] || "");
    let end = i + 1;
    while (end < lines.length && (m[1] ? lines[end].replace(/^\t+/, "") : lines[end]) !== m[3]) end += 1;
    const body = lines.slice(i + 1, end).join("\n");
    // Not when the output goes on to another command (`cat <<EOF | sh` runs the body).
    const piped = /\|/.test(line.slice(m.index + m[0].length));
    if ((sink === "cat" || sink === "tee") && !piped && (m[2] || !/\$\(|`/.test(body))) {
      i = end - 1; // the body is skipped; the closing line is kept
    }
  }
  let text = out.join("\n");
  // Only inside a git/gh/glab command (the flag must follow it within the same command).
  const message = /((?:^|[;&|(\n])\s*(?:git|gh|glab)\b(?:[^;&|\n"']|"")*?\s(?:-m|--message|--title|--body|--description)(?:\s+|=))("(?:[^"\\$`]|\\[^$`])*[^"\\$`]"|'[^']+')/g;
  // The git/gh/glab word must itself be outside quotes: inside `echo "; git x -m"` it is data, and
  // the quoted text after it is a real argument of the command around it.
  const quotedAt = (str, at) => {
    let q = null;
    for (let k = 0; k < at; k += 1) {
      const ch = str[k];
      if (q === "'") {
        if (ch === "'") q = null;
      } else if (ch === "\\") k += 1;
      else if (q === '"') {
        if (ch === '"') q = null;
      } else if (ch === "'" || ch === '"') q = ch;
    }
    return q !== null;
  };
  for (let n = 0; n < 8; n += 1) {
    const next = text.replace(message, (whole, head, _msg, at, str) => (quotedAt(str, at) ? whole : `${head}""`));
    if (next === text) break;
    text = next;
  }
  return text;
}

// Commands that only read: a Bash call that names the store may use these and nothing else.
const READERS = new Set(["cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ls", "ll", "wc", "stat", "file", "diff", "cmp", "du", "df", "tree", "realpath", "readlink", "basename", "dirname", "pwd", "cd", "echo", "printf", "true", "false", "test", "[", "sha256sum", "sha1sum", "md5sum", "cksum", "jq", "column", "nl", "comm", "strings", "od", "hexdump", "date", "which", "type", "find", "sort", "cut", "tr", "awk", "git", "cp", "rsync", "install", "sed", "uniq", "tac", "rev", "fold", "fmt", "paste", "expand", "unexpand", "sleep", "base64", "zcat", "zgrep", "xzcat", "bzcat"]);
// Wrappers that run the command after them: judged by that command.
const WRAPPER_ARGS = { timeout: new Set(["-s", "--signal", "-k", "--kill-after"]), nice: new Set(["-n", "--adjustment"]), ionice: new Set(["-c", "-n", "-p", "--class", "--classdata"]), stdbuf: new Set(["-i", "-o", "-e"]), env: new Set(["-u", "--unset", "-C", "--chdir"]), command: new Set(), xargs: new Set(["-n", "-I", "-i", "-P", "-d", "-L", "-l", "-s", "-E", "-e", "--max-args", "--max-procs", "--delimiter", "--max-lines", "--max-chars"]) };
const SHELL_KEYWORDS = new Set(["until", "while", "do", "then", "else", "if", "elif", "!", "{", "time", "done", "fi", "}"]);
// The words of the command a segment really runs: shell keywords and wrappers peeled off.
// The result carries what was peeled: `xargs` (stdin words are appended, or replace a -I
// placeholder, so argument positions mean nothing) and `chdir` (env -C moved the working folder).
const XARGS_SAFE = new Set(["cat", "head", "tail", "grep", "egrep", "fgrep", "wc", "ls", "stat", "du", "realpath", "readlink", "basename", "dirname", "sha256sum", "sha1sum", "md5sum", "cksum", "echo", "printf", "true"]);
function realCommand(words) {
  const out = (list, flags) => Object.assign(list, flags);
  const flags = { xargs: false, chdir: null };
  let w = words.filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
  for (let guard = 0; guard < 8; guard += 1) {
    while (w.length && SHELL_KEYWORDS.has(w[0])) w = w.slice(1);
    const name = path.basename(w[0] || "");
    const takes = WRAPPER_ARGS[name];
    if (!takes) return out(w, flags);
    if (name === "xargs") flags.xargs = true;
    if (name === "env") {
      const c = w.findIndex((x) => /^(?:-C|--chdir)(?:=|$)|^-[A-Za-z]*C/.test(x));
      if (c >= 0) flags.chdir = w[c].includes("=") ? w[c].split("=").slice(1).join("=") : w[c].length > 2 && !w[c].startsWith("--") ? w[c].slice(w[c].indexOf("C") + 1) || w[c + 1] || "" : w[c + 1] || "";
    }
    if (name === "xargs" && w.some((x) => /^-(?:a|-arg-file)/.test(x))) return ["xargs-file"];
    if (name === "env" && w.some((x) => /^-(?:S|-split-string)/.test(x))) return ["env-split"];
    let i = 1;
    while (i < w.length && (w[i].startsWith("-") || (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])))) i += takes.has(w[i]) ? 2 : 1;
    if (name === "timeout") i += 1; // the duration
    w = w.slice(i);
    if (!w.length) return out(name === "xargs" ? ["echo"] : [], flags);
  }
  return out(w, flags);
}
const GIT_READ = new Set(["log", "show", "diff", "status", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "cat-file", "shortlog", "describe", "reflog", "whatchanged", "branch", "tag", "remote", "config"]);
// Commands that wipe or move a whole folder: refused when they name a folder above the store.
// Commands that run the command after them (their own options and a duration skipped).
const RUNNERS = new Set(["sudo", "doas", "nohup", "setsid", "exec", "busybox", "time", "command", "builtin", "nice", "ionice", "timeout", "env", "stdbuf", "xargs", "flock", "chrt", "taskset", "unbuffer", "strace", "chroot", "runuser", "su"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "chmod", "chown", "chgrp", "shred", "unlink", "srm"]);

export const STATE_REASON = "This path is the knowledge store or its own state (the data folder): a note changes only through the knowledge tools and the owner's review, never by writing the file.";

/**
 * stateGuard({ protect: [paths], match, reason, cwd, env, home }): (toolName, input, hookCwd) ->
 * null when the call may run, else the reason it is refused (the model reads it).
 * `match` (optional): a test on a resolved path for files named by pattern rather than by a root
 * (e.g. any .claude/settings*.json); it is checked wherever a root is, except for "a folder above".
 * `matchText` (optional RegExp): the same files as written in command text (a root is found by its path).
 * `guardContainers`: a Bash command may only read the folder that directly holds a protected FILE
 * (`cp x ~/.claude/`, `tar -C`, `git checkout` in the brain repo), and a bare file name is resolved
 * against the working folder. Off for the state guard (its roots are folders), on for the
 * instruction files.
 * `readable` (default true): false refuses reading the roots too — a Bash command that names one, or
 * any tool given a path inside one (an owner job's run, jobs/owner-jobs.mjs). Literal paths only: a
 * speed bump, not a boundary. Excepted folders stay open.
 */
export function stateGuard({ protect = [], except = [], match = null, matchText = null, guardContainers = false, readable = true, reason = STATE_REASON, cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  const roots = [...new Set(protect.filter(Boolean).flatMap((p) => {
    const abs = path.resolve(p);
    return [abs, realish(abs)];
  }))];
  if (!roots.length && !match) return () => null;
  // Folders inside a root that stay open (the owner's home inside the data folder).
  const excepted = [...new Set(except.filter(Boolean).flatMap((p) => {
    const abs = path.resolve(p);
    return [abs, realish(abs)];
  }))];
  const exempt = (p) => excepted.some((e) => within(e, p));
  const hits = (p) => (roots.some((root) => within(root, p)) && !exempt(p)) || Boolean(match?.(p));
  // A root named in the command text: it must start a word (not src/data, ./data, https://x/data)
  // and must not run on into another name (/data vs /dataset) nor into an excepted folder.
  const namesRoot = (text) =>
    roots.some((root) => {
      for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
        const prev = at > 0 ? text[at - 1] : undefined;
        if (prev !== undefined && !/[\s'"`;|&<>()=:,{]/.test(prev)) continue;
        const next = text[at + root.length];
        if (next !== undefined && next !== "/" && !/[\s'"`;|&<>()=:,]/.test(next)) continue;
        const word = root + (/^[^\s'"`;|&<>()]*/.exec(text.slice(at + root.length))?.[0] || "");
        if (!exempt(path.normalize(word))) return true;
      }
      return false;
    });
  // Folders that directly hold a protected file (a root that is not an existing folder), and with a
  // pattern, any folder named .claude: Bash may read them, never write into them.
  const containers = new Set();
  if (guardContainers) {
    for (const root of roots) {
      let isDir = false;
      try {
        isDir = fs.statSync(root).isDirectory();
      } catch {
        /* a file that does not exist yet */
      }
      if (!isDir) containers.add(path.dirname(root));
    }
  }
  const isContainer = (p) => containers.has(p) || (guardContainers && Boolean(match) && path.basename(p) === ".claude");
  // A pattern is tested on the path as written too: a symlinked .claude folder resolves elsewhere,
  // and Claude Code still reads it through .claude.
  const matchAsGiven = (base, given) => Boolean(match?.(path.resolve(base, expandTilde(String(given), home))));
  const above = (p) => roots.some((root) => p !== root && within(p, root));
  const resolveIn = (base, given) => realish(path.resolve(base, expandTilde(given, home)));
  const realBases = new Map();
  const realBase = (base) => {
    if (!realBases.has(base)) realBases.set(base, realish(path.resolve(base)));
    return realBases.get(base);
  };

  // A hard link elsewhere to a file in the store (rare in ordinary work): refused unless the store
  // was walked in full and holds no file with that inode.
  function hardLinkedIn(target) {
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      return false;
    }
    if (!st.isFile() || st.nlink < 2) return false;
    let seen = 0;
    for (const root of roots) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if ((seen += 1) > 20000) return true;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!exempt(full)) stack.push(full);
          } else if (exempt(full)) continue;
          if (e.isFile()) {
            try {
              const s = fs.statSync(full);
              if (s.ino === st.ino && s.dev === st.dev) return true;
            } catch {
              /* gone */
            }
          }
        }
      }
    }
    return false;
  }

  // How a path word relates to the store: "inside", "above" or null.
  function relation(word, base) {
    const cands = pathCandidates(word);
    // Brace expansion past its cap: the unseen words could name the store (only for a path word).
    // A literal folder before the first "{" bounds where the words can land: `/tmp/out/{1..100}`
    // cannot reach the store, `/{a..z}…` or a "..", after the brace, can.
    if (cands.capped && word.includes("/")) {
      // Judge the path part: `--opt=PATH` and `-tPATH` carry it after the option.
      const pathPart = word.replace(/^--?[A-Za-z][\w-]*=/, "").replace(/^-[A-Za-z]+(?=[/~])/, "");
      const brace = pathPart.indexOf("{");
      const pre = pathPart.slice(0, brace);
      const dir = pre.includes("/") ? pre.slice(0, pre.lastIndexOf("/")) || "/" : ".";
      const t = resolveIn(base, dir);
      if (/(?:^|[/{,])\.\.(?:[/},]|$)/.test(pathPart.slice(brace)) || hits(t) || above(t) || t === path.parse(t).root) return "inside";
    }
    for (const cand of cands) {
      const w = expandTilde(cand, home);
      if (/[*?[]/.test(w)) {
        const abs = path.resolve(base, w);
        for (const root of roots) {
          const rel = globRelation(abs, root);
          if (rel) return rel;
        }
        continue;
      }
      if (!w.includes("/") && w !== "." && w !== ".." && w !== "~") {
        // A bare name is a protected path when the working folder makes it one
        // (`cd ~/.claude && sed -i … settings.json`, `cd brain && echo >> core.md`, and for the
        // state guard `cd /workspace && rm -rf knowledge`).
        if (!w || w.startsWith("-")) continue;
        // Cheap first: a plain join of the folder and the word. The symlink walk only when the word
        // itself is a link (a long script has thousands of bare words).
        const plain = path.resolve(realBase(base), w);
        let isLink = false;
        try {
          isLink = fs.lstatSync(plain).isSymbolicLink();
        } catch {
          /* not there */
        }
        const bare = isLink ? resolveIn(base, w) : plain;
        if (hits(bare)) return "inside";
        if (guardContainers && (matchAsGiven(base, w) || isContainer(bare))) return "inside";
        if (above(bare)) return "above";
        continue;
      }
      const target = resolveIn(base, w);
      if (hits(target) || matchAsGiven(base, w) || isContainer(target)) return "inside";
      if (above(target)) return "above";
    }
    return null;
  }

  function checkCommand(command, base) {
    const raw = String(command || "");
    if (!raw.trim()) return null;
    const data = dropData(raw);
    const text = unshell(expandVars(data, env));
    // fd duplications (2>&1, <&0) are not separators; `|&` pipes stderr too.
    const segments = text.replace(/\d*[<>]&(?:\d+|-)/g, " ").split(/\|\||&&|\|&|[|;&\n]/);
    // Each segment's working folder: a `cd`/`pushd` earlier in the same command moves it.
    const bases = [];
    let at = base;
    for (const seg of segments) {
      bases.push(at);
      const w = wordsOf(seg);
      if (w[0] === "cd" || w[0] === "pushd") {
        const dest = w.slice(1).find((a) => !a.startsWith("-"));
        at = dest ? resolveIn(at, dest) : home;
      }
    }
    const inStore = (b) => hits(realish(path.resolve(b))) || isContainer(realish(path.resolve(b)));
    // A segment that only moves the working folder (`cd out`) runs nothing in it.
    const movesOnly = (seg) => ["cd", "pushd", "popd"].includes(wordsOf(seg)[0]);
    let named = segments.some((seg, i) => !movesOnly(seg) && inStore(bases[i])) || namesRoot(text) || Boolean(matchText?.test(text));
    segments.forEach((seg, i) => {
      for (const w of wordsOf(seg)) if (relation(w, bases[i]) === "inside") named = true;
    });

    for (const [i, seg] of segments.entries()) {
      const base = bases[i];
      const words = realCommand(wordsOf(seg.replace(/\d*>&\d+/g, " ")));
      if (!words.length) continue;
      const cmd = path.basename(words[0]);
      // rm -rf of a folder above the store, mv of a parent, find … -delete.
      if (words.chdir != null) {
        // env -C <dir> rm -rf …: judge the paths from that folder.
        const moved = resolveIn(base, words.chdir || home);
        if (hits(moved) || above(moved)) {
          if (DESTRUCTIVE.has(cmd) || cmd === "find" || cmd === "rsync") return reason;
        }
      }
      // At every position, not only after the wrappers realCommand knows (sudo, doas, busybox, a
      // function): any destructive command word followed by a folder above the store.
      const all = wordsOf(seg.replace(/\d*>&\d+/g, " "));
      // Command positions only, so a search pattern such as `grep -rn 'chmod' /` is not a command:
      // the first word once assignments and shell keywords are peeled (then, do, if, {, !, VAR=x),
      // and, after a runner (sudo -u x, timeout -s KILL 5, flock FILE, chroot DIR, xargs -I{}),
      // every later word, since its own arguments are not modelled.
      const positions = [];
      let j0 = 0;
      while (j0 < all.length && (SHELL_KEYWORDS.has(all[j0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[j0]))) j0 += 1;
      if (j0 < all.length) {
        positions.push(j0);
        if (RUNNERS.has(path.basename(all[j0]))) for (let j = j0 + 1; j < all.length; j += 1) positions.push(j);
      }
      for (const j of positions) {
        const name = path.basename(all[j] || "");
        const after = all.slice(j + 1);
        const wipes = DESTRUCTIVE.has(name) || (name === "find" && after.some((w) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(w))) || (name === "rsync" && after.some((w) => w.startsWith("--delete") || w.startsWith("--remove-source")));
        if (wipes && after.some((w) => relation(w, base) === "above")) return reason;
      }
    }
    if (!named) return null;
    if (!readable) return reason;

    // The command names the store (or runs inside it): reading only.
    // Command substitution, process substitution and a read-write redirection (<>) are refused outright.
    if (/\$\(|`|<\(|>\(|<>/.test(data)) return reason;
    for (const [i, seg] of segments.entries()) {
      const base = bases[i];
      const cwdInside = inStore(base);
      // Redirections: their targets must lie outside the store.
      const redirect = /(?:^|[^<>&\d])(?:\d*|&)>>?\|?\s*([^\s;&|<>()]+)/g;
      for (const m of seg.matchAll(redirect)) {
        if (m[1].startsWith("&")) continue;
        if (relation(m[1], base) === "inside" || hits(resolveIn(base, m[1]))) return reason;
      }
      const words = realCommand(wordsOf(seg.replace(/\d*>&\d+/g, " ").replace(/(?:\d*|&)>>?\|?\s*[^\s;&|<>()]+/g, " ")));
      if (!words.length) continue;
      const cmd = path.basename(words[0]);
      if (cmd === "sqlite3") {
        // Read-only opening, and none of the dot-commands or statements that reach other files.
        const uri = words.find((w) => /^file:/.test(w)) || "";
        const roUri = /[?&]mode=ro(?:&|$)/.test(uri) && !/[?&]mode=(?!ro(?:&|$))/.test(uri);
        if (!(words.includes("-readonly") || roUri) || /(?:^|\s|;)\.(?:shell|system|output|once|save|backup|import|load|restore|clone|excel|open|cd)\b|\battach\b|\bvacuum\b|\bload_extension\b|\bwritefile\b/i.test(seg)) return reason;
        continue;
      }
      if (!READERS.has(cmd)) return reason;
      // env -C moves the folder relative paths resolve from; xargs adds or substitutes arguments.
      if (words.chdir != null) return reason;
      if (words.xargs && !XARGS_SAFE.has(cmd)) return reason;
      const args = words.slice(1);
      // Options of a reader that write a file or run a program.
      if (args.some((a) => /^--(?:output|pre|exec|ext-diff|upload-pack|receive-pack)(?:=|$)/.test(a))) return reason;
      if ((cmd === "tree" || cmd === "file") && args.some((a) => /^-[A-Za-z]*[oC]/.test(a))) return reason;
      if (cmd === "git") {
        if (args.some((a) => a === "-c" || a.startsWith("--config-env") || a.startsWith("-c"))) return reason;
        let i = 0;
        while (i < args.length && args[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree"].includes(args[i]) ? 2 : 1;
        if (!GIT_READ.has(args[i] || "")) return reason;
        // git grep -O runs a pager program on the matches; reflog expire/delete rewrites the logs.
        if (args[i] === "grep" && args.slice(i + 1).some((a) => /^-[A-Za-z]*O|^--op/.test(a))) return reason;
        if (args[i] === "reflog" && ["expire", "delete"].includes(args.slice(i + 1).find((a) => !a.startsWith("-")))) return reason;
        if (["branch", "tag", "remote", "config"].includes(args[i]) && args.slice(i + 1).some((a) => !a.startsWith("-") || /^-(?:d|D|m|M|-delete|-move|-add|-unset|-replace-all)/.test(a))) return reason;
        continue;
      }
      if (cmd === "find" && args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a))) return reason;
      // sort --compress-program runs a program (GNU takes any unambiguous prefix of the option).
      if (cmd === "sort" && args.some((a) => /^-[A-Za-z]*o|^--o|^--co/.test(a))) return reason;
      if (cmd === "awk") {
        // A pipe, getline, system() or a redirection inside the program runs or writes something
        // (segment splitting may have cut the program at its own "|", so the whole command is read).
        if (/system|>|getline/.test(seg)) return reason;
        for (const m of data.matchAll(/(?:^|[\s;&|(])(?:g|m|n)?awk\b[^'"\n|;&]*(['"])((?:(?!\1)[\s\S])*)\1/g)) {
          if (/[|>]|getline|system/.test(m[2])) return reason;
        }
        if (args.some((a) => /^-[A-Za-z]*f|^--file/.test(a))) return reason;
        // mawk -W exec / -W file reads the program from a file (the image's awk is mawk).
        if (args.some((a) => /^-W/.test(a))) return reason;
        // gawk -i/--include and -E/--exec read a program file, -l/--load a shared library (not the
        // value of -v or -F).
        // -o/-p/-d (pretty-print, profile, dump-variables) write a file.
        if (args.some((a) => !/^-[vF]/.test(a) && /^-[A-Za-z]*[ilEopd]|^--(?:include|load|exec|pretty-print|profile|dump-variables)(?:=|$)/.test(a))) return reason;
      }
      if (cmd === "sed") {
        // No in-place editing, and no script command that writes (w, W, s///w) or runs (e).
        if (args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a))) return reason;
        const scripts = args.map((a) => (a.startsWith("--expression=") ? a.slice(13) : /^-e./.test(a) ? a.slice(2) : a.startsWith("-") ? "" : a));
        if (scripts.some((a) => /(?:^|[;{}!\d$\/\s])[wWe](?:\s|$|;)/.test(a))) return reason;
        // s commands: a w (write) or e (execute) among the flags, whatever comes before it (gw, pw, Iw).
        const sCommand = /s([^\w\s\\])(?:(?!\1)[^\\\n]|\\.)*\1(?:(?!\1)[^\\\n]|\\.)*\1([A-Za-z0-9]*)/g;
        for (const m of seg.matchAll(sCommand)) if (/[wWe]/.test(m[2])) return reason;
        // A script file the check never sees.
        if (args.some((a) => /^-[A-Za-z]*f|^--file/.test(a))) return reason;
      }
      if (cmd === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return reason;
      if (cmd === "cp" || cmd === "rsync" || cmd === "install") {
        // Copying out of the store is reading; the destination decides.
        // cp/install -t DIR, also inside a short-option group (-vt DIR) or attached (-tDIR, -vtDIR).
        // rsync's -t is --times, not a target.
        const group = cmd === "rsync" ? -1 : args.findIndex((a) => /^-[A-Za-z]*t/.test(a) && !a.startsWith("--"));
        const attached = group >= 0 ? args[group].slice(args[group].indexOf("t") + 1) : "";
        const t = args.findIndex((a) => a === "--target-directory");
        const tEq = args.find((a) => a.startsWith("--target-directory="));
        const dest = tEq ? tEq.split("=")[1] : t >= 0 ? args[t + 1] : group >= 0 ? attached || args[group + 1] : args.filter((a) => !a.startsWith("-")).at(-1);
        if (!dest || relation(dest, base) === "inside" || hits(resolveIn(base, dest))) return reason;
        if (cmd === "rsync" && args.some((a) => a.startsWith("--delete") || a.startsWith("--remove-source"))) return reason;
        // rsync options that run a program (-e/--rsh, --rsync-path) or write elsewhere.
        if (cmd === "rsync" && args.some((a) => /^-[A-Za-z]*[eT]/.test(a) && !a.startsWith("--") || /^--(?:rsh|rsync-path|log-file|backup-dir|partial-dir|temp-dir|write-batch|only-write-batch)(?:=|$)/.test(a))) return reason;
        continue;
      }
    }
    return null;
  }

  // Tools that only read, or whose own calls are hooked separately (a subagent's tools).
  const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "Skill", "AskUserQuestion", "ExitPlanMode", "Task", "Agent", "TaskOutput", "TaskStop", "BashOutput", "KillShell", "KillBash"]);

  return (toolName, input = {}, hookCwd = null) => {
    const base = hookCwd || cwd;
    const name = String(toolName || "");
    const field = WRITE_TOOLS[name];
    if (field) {
      const given = input?.[field];
      if (given == null || String(given).trim() === "") return null;
      const target = resolveIn(base, String(given).trim());
      return hits(target) || matchAsGiven(base, String(given).trim()) || hardLinkedIn(target) ? reason : null;
    }
    if (name === "Bash" || name === "Monitor") return checkCommand(input?.command, base);
    // The app's own tools (MCP server named after the assistant) are gated in the app (its knowledge tools never take a path).
    if (name.startsWith(`mcp__${agentSlug()}__`) || (readable && READ_ONLY.has(name))) return null;
    // Any other tool (Artifact out_dir, a browser's file save, an unknown built-in): a path-like
    // string argument that points into the store refuses the call; a `command` is read as shell.
    if (typeof input?.command === "string" && checkCommand(input.command, base)) return reason;
    // Free text that only mentions the store (a doc, a reminder) is fine; code a tool runs is not.
    for (const key of ["code", "script", "source"]) {
      if (typeof input?.[key] === "string" && (namesRoot(input[key]) || matchText?.test(input[key]))) return reason;
    }
    const stack = [[input, 0]];
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (typeof value === "string") {
        const v = value.trim();
        if (v.length < 4096 && !v.includes("\n") && /^(?:\/|~|\.\.?\/)/.test(v)) {
          // The same tests as a file tool: the resolved path, the pattern as written, and a folder
          // that holds a protected file (writing into it is refused).
          const target = resolveIn(base, v);
          if (hits(target) || matchAsGiven(base, v) || isContainer(target)) return reason;
        }
      } else if (value && typeof value === "object" && depth < 4) {
        for (const item of Object.values(value)) stack.push([item, depth + 1]);
      }
    }
    return null;
  };
}

// What Griffin protects (index.mjs): the knowledge store and the whole data folder (database, owner
// token, secrets.key, engine keys, TLS), except the owner's home when it lies inside the data folder.
export const griffinStatePaths = ({ knowledgeRoot, data, home = os.homedir() }) => {
  const protect = [knowledgeRoot, data].filter(Boolean);
  const except = data && home && within(path.resolve(data), path.resolve(home)) && path.resolve(home) !== path.resolve(data) ? [home] : [];
  return { protect, except };
};

// The PreToolUse hook output for a refusal.
export const denyOutput = (why) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });

// --- The owner's instruction files, closed to a chat born from someone else's messenger message ---
// chat-origin.mjs; config TELEGRAM_INSTRUCTION_GUARD, on by default. These files feed every
// later session's instructions: the Claude config folder's CLAUDE.md, settings.json,
// settings.local.json, memory/, skills/, hooks/, agents/, commands/, plugins/, rules/, output-styles/,
// agent-memory/, projects/ (per-project auto-memory) and .claude.json (MCP servers), the brain's
// core.md that CLAUDE.md imports and its hooks, and any .claude/settings*.json in a worktree (matched
// by pattern). Not the agent folder's CLAUDE.md: Griffin rewrites it before every run (installRules),
// and protecting it would make the agent folder a container where Bash may only read. Every other chat is
// unchanged; reading stays open to all.
export const INSTRUCTION_FILES_REASON =
  "This chat was started from someone else's Telegram message, so it may not write the files every session reads its instructions from " +
  "(CLAUDE.md, settings.json, memory, skills, hooks, .claude.json, the brain's core.md, and .claude/settings*.json). " +
  "Propose the change to the owner instead: write the exact path and text in your answer, or suggest a new chat for it; the owner applies it himself.";

export const CLAUDE_SETTINGS_FILE = /(?:^|\/)\.claude\/settings[^/]*\.json$/;
export const CLAUDE_SETTINGS_TEXT = /\.claude\/settings[^\s/'"`;|&<>()]*\.json/;

export function instructionFilePaths({ configDirs = [], reposRoot = null } = {}) {
  const out = [];
  for (const dir of [...new Set(configDirs.filter(Boolean).map((d) => path.resolve(d)))]) {
    for (const name of ["CLAUDE.md", "settings.json", "settings.local.json", "memory", "skills", ".claude.json", "hooks", "agents", "commands", "plugins", "rules", "output-styles", "agent-memory", "projects"]) out.push(path.join(dir, name));
    // Without CLAUDE_CONFIG_DIR, Claude Code keeps .claude.json beside ~/.claude.
    if (path.basename(dir) === ".claude") out.push(path.join(path.dirname(dir), ".claude.json"));
  }
  // core.md, which the owner's CLAUDE.md imports, and the hooks his settings run in every session.
  if (reposRoot) out.push(path.join(reposRoot, "brain", "core.md"), path.join(reposRoot, "brain", "hooks"));
  return out;
}

/** The guard options for a Telegram-born chat (claude.mjs runs it beside the state guard). */
export const instructionGuardOptions = (paths) => ({
  protect: paths,
  match: (p) => CLAUDE_SETTINGS_FILE.test(p),
  matchText: CLAUDE_SETTINGS_TEXT,
  guardContainers: true,
  reason: INSTRUCTION_FILES_REASON,
});

