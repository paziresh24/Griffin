// Commits carry whoever pushes them (owner 2026-10-29). Platform's author watch flagged a dozen pushes
// made with a person's token whose commits said «Nova», «Atlas» or «Kian»: in Bash the model set the
// name itself (`git -c user.name=Nova commit`, `--author`, GIT_AUTHOR_NAME=…). This PreToolUse check
// refuses a shell command that picks a commit identity, so a commit gets the machine's own git
// identity — the person whose credentials push it. Reading it (`git config user.name`, `git log
// --author=…`) stays allowed. Config GIT_IDENTITY_GUARD=off turns it off.

// One shell command at a time: separators end the git invocation a flag belongs to.
const PART = String.raw`[^;&|\n]*`;
const RULES = [
  // git -c user.name=… / -c user.email=… (anywhere in the git invocation)
  new RegExp(String.raw`\bgit\b${PART}\s-c\s*["']?user\.(name|email)\s*=`, "i"),
  // git config [--global|--local|set] user.name <value>; reads (--get, --list, no value) pass
  new RegExp(String.raw`\bgit\s+config\b(?!${PART}\s--(get|get-all|get-regexp|list|unset|unset-all)\b)${PART}\buser\.(name|email)\s+["']?[^\s;&|"'-]`, "i"),
  // git commit --author …
  new RegExp(String.raw`\bgit\b${PART}\bcommit\b${PART}\s--author(=|\s)`, "i"),
  // GIT_AUTHOR_NAME=… / export GIT_COMMITTER_EMAIL=… (also inside filter-branch --env-filter)
  /\bGIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)\s*=/,
];

export const GIT_IDENTITY_REFUSAL =
  "Refused: a commit carries the identity of whoever pushes it (this machine's own git config / the install's GitLab token), never a name the agent picks. Do not set user.name or user.email (git -c, git config), --author, or GIT_AUTHOR_*/GIT_COMMITTER_*; run the command again without it. Commits already made under another name: `git commit --amend --reset-author --no-edit` (last one) before pushing.";

/** The refusal for a Bash command that sets a commit's author or committer, else null. */
export function gitIdentityRefusal(toolName, input = {}) {
  if (toolName !== "Bash") return null;
  const command = String(input?.command || "");
  if (!/git|GIT_/i.test(command)) return null;
  return RULES.some((rule) => rule.test(command)) ? GIT_IDENTITY_REFUSAL : null;
}
