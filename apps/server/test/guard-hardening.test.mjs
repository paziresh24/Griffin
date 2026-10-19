import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { griffinStatePaths, stateGuard } from "../src/providers/state-guard.mjs";

// A review of the state and instruction guards listed conditions in the state guard that were broader or
// narrower than their own comments. One test per condition: what it must refuse, and what stays allowed.

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-hard-")));
  const workspace = path.join(base, "workspace");
  const knowledgeRoot = path.join(workspace, "knowledge");
  const notes = path.join(knowledgeRoot, "agents", "griffin", "knowledge");
  const data = path.join(base, "data");
  const home = path.join(data, "home");
  const worktree = path.join(base, "git-repos", "_wt", "w");
  for (const d of [notes, home, worktree]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(notes, "good.md"), "x");
  const guard = (cwd = worktree) => stateGuard({ ...griffinStatePaths({ knowledgeRoot, data, home }), cwd, home });
  return { base, workspace, knowledgeRoot, notes, data, home, worktree, guard };
}
const refused = (g, command, msg) => assert.equal(typeof g("Bash", { command }), "string", msg || command);
const allowed = (g, command, msg) => assert.equal(g("Bash", { command }), null, msg || command);

test("a here-string (<<<) is not a heredoc: the lines after it stay checked", () => {
  const e = setup();
  refused(e.guard(), `cat <<< EOF\ncp /tmp/x ${e.notes}/\nEOF`);
  allowed(e.guard(), `cat > /tmp/out <<'EOF'\nnote about ${e.notes}\nEOF`);
});

test("a git message is blanked only when git itself is outside quotes", () => {
  const e = setup();
  refused(e.guard(), `bash -c "git commit -m 'x' ; cp /tmp/x ${e.notes}/"`);
  allowed(e.guard(), `git -C /tmp/r commit -m "the store lives at ${e.notes}"`);
});

test("cp/install -t inside an option group or attached to its value names the destination", () => {
  const e = setup();
  refused(e.guard(), `cp -vt ${e.notes} /tmp/x.md`);
  refused(e.guard(), `cp -t${e.notes} /tmp/x.md`);
  refused(e.guard(), `install -vt ${e.notes} /tmp/x.md`);
  allowed(e.guard(), `cp -vt /tmp ${e.notes}/good.md`);
});

test("reader options that run a program or write a file are refused when the store is named", () => {
  const e = setup();
  for (const command of [
    `git -C ${e.knowledgeRoot} grep -O"sh" x`,
    `git -C ${e.knowledgeRoot} reflog expire --all`,
    `sort --compress-program=sh ${e.notes}/good.md`,
    `rsync -e sh ${e.notes}/good.md /tmp/`,
    `rsync --log-file=${e.notes}/l ${e.notes}/good.md /tmp/`,
    `awk -i inplace '{print}' ${e.notes}/good.md`,
    `awk -E /tmp/p.awk ${e.notes}/good.md`,
  ]) refused(e.guard(), command);
  for (const command of [`git -C ${e.knowledgeRoot} grep -n x`, `git -C ${e.knowledgeRoot} reflog`, `sort -n ${e.notes}/good.md`, `rsync -t ${e.notes}/good.md /tmp/`, `awk -v x=1 -F: '{print $1}' ${e.notes}/good.md`]) {
    allowed(e.guard(), command);
  }
});

test("a destructive command behind any runner, aimed at a folder above the store, is refused", () => {
  const e = setup();
  refused(e.guard(), `nohup rm -rf ${e.workspace}`);
  refused(e.guard(), `setsid rm -rf ${e.workspace}`);
  allowed(e.guard(), `nohup rm -rf /tmp/scratch`);
});

test("a bare word that resolves into the store from the working folder is seen", () => {
  const e = setup();
  refused(e.guard(e.workspace), "rm -rf knowledge");
  refused(e.guard(e.workspace), "cp /tmp/x knowledge/agents/griffin/knowledge/");
  allowed(e.guard(e.workspace), "rm -rf scratch");
});

test("$\"…\" quoting is undone before the path is judged", () => {
  const e = setup();
  refused(e.guard(), `cp /tmp/x $"${e.notes}/"`);
});

test("{x..y} ranges are expanded, and a brace word past the cap counts as naming the store", () => {
  const e = setup();
  refused(e.guard(), `cp /tmp/x ${e.workspace}/knowledg{a..z}/agents/griffin/knowledge/`);
  refused(e.guard(), `cp /tmp/x ${e.base}/{${Array.from({ length: 70 }, (_, i) => `d${i}`).join(",")},workspace}/knowledge/`);
  allowed(e.guard(), "mkdir -p /tmp/out/{1..3}");
});

test("a dangling symlink resolves to where a write would land", () => {
  const e = setup();
  const link = path.join(e.worktree, "dangling.md");
  fs.symlinkSync(path.join(e.notes, "new.md"), link);
  assert.equal(typeof e.guard()("Write", { file_path: link, content: "x" }), "string");
  const safe = path.join(e.worktree, "safe.md");
  fs.symlinkSync("/tmp/nowhere-guard-test.md", safe);
  assert.equal(e.guard()("Write", { file_path: safe, content: "x" }), null);
});

test("a cd out of the store in one segment frees the next segment", () => {
  const e = setup();
  allowed(e.guard(e.notes), "cd /tmp && echo x > /tmp/out.txt");
  refused(e.guard(e.notes), "echo x > evil.md");
});

test("other tools: a relative path argument into the store is refused", () => {
  const e = setup();
  const g = e.guard(e.workspace);
  assert.equal(typeof g("SomeTool", { out_dir: "./knowledge/agents/griffin/knowledge" }), "string");
  assert.equal(g("SomeTool", { out_dir: "./elsewhere" }), null);
});

test("guard review: big brace expansions under a literal folder that cannot reach the store stay allowed", () => {
  const e = setup();
  for (const command of ["mkdir -p /tmp/out/{1..100}", "mkdir -p logs/{2020..2026}/{01..12}", "touch ./f{0..99}.txt", "mkdir -p /tmp/t/{a,b,c}/{d,e,f}/{g,h,i}/{j,k,l}"]) allowed(e.guard(), command);
  refused(e.guard(), `cp /tmp/x /{${Array.from({ length: 70 }, (_, i) => `d${i}`).join(",")}}/knowledge`);
  refused(e.guard(), `cp /tmp/x /tmp/{${Array.from({ length: 70 }, (_, i) => `d${i}`).join(",")}}/../..${e.notes}`);
});

test("guard review: a destructive word that is only a search pattern is not a command", () => {
  const e = setup();
  allowed(e.guard(), `grep -rn 'chmod' ${e.workspace.replace("/workspace", "")}`);
  allowed(e.guard(), "grep -rln 'rm -rf' /");
  refused(e.guard(), `sudo rm -rf ${e.workspace}`);
  refused(e.guard(), `timeout 5 rm -rf ${e.workspace}`);
});

test("guard review: option prefixes GNU accepts, and gawk's file-writing options", () => {
  const e = setup();
  for (const command of [`sort --co=sh ${e.notes}/good.md`, `sort --o=/tmp/x ${e.notes}/good.md`, `git -C ${e.knowledgeRoot} grep --op=sh x`, `awk -o/tmp/p '{print}' ${e.notes}/good.md`, `awk --profile=/tmp/p '{print}' ${e.notes}/good.md`]) refused(e.guard(), command);
});

test("guard review: a long script of bare words is checked quickly", () => {
  const e = setup();
  const words = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
  const command = `cat > /tmp/out <<EOF\n${words}\nEOF\necho ${words}`;
  const t0 = performance.now();
  e.guard()("Bash", { command });
  assert.ok(performance.now() - t0 < 3000, `took ${Math.round(performance.now() - t0)} ms`);
});

test("review of 6ceb5fc: a delete is still caught behind assignments, shell keywords and runner arguments", () => {
  const e = setup();
  for (const pre of ["X=1", "if true; then", "for d in a; do", "{", "!", "timeout -s KILL 5", "env -u HOME", "stdbuf -o L", "xargs -I {}", "flock /tmp/l", "chroot /", "taskset 0x1", "sudo -u root", "doas -u root", "strace -o /tmp/s", "runuser -u x --"]) {
    refused(e.guard(), `${pre} rm -rf ${e.workspace}`, pre);
  }
});

test("review of 6ceb5fc: brace cap judges the path part of an option, and a brace item that is ..", () => {
  const e = setup();
  const many = Array.from({ length: 70 }, (_, i) => `d${i}`).join(",");
  refused(e.guard(), `cp /tmp/x --target-directory=/{${many}}/k`);
  refused(e.guard(), `cp /tmp/x ./x/{${many},..}/{${many},..}/workspace/knowledge`);
  allowed(e.guard(), `mkdir -p --mode=755 ./out/{1..100}`);
});

test("mawk -W (program from a file) is refused when the store is named", () => {
  const e = setup();
  refused(e.guard(), `awk -W exec /tmp/p.awk ${e.notes}/good.md`);
  allowed(e.guard(), `awk '{print}' ${e.notes}/good.md`);
});
