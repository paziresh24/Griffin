// The optional `description` of a shell step (debug_exec, ssh_exec, kube_exec, mikrotik_exec): the
// step's name in the chat row. The model writes it once per call; the broker never reads it, and the
// guard drops it before it can change what an approval is keyed on. Without it the row could only say
// «دستور روی …» for every step (owner, 2026-10-20: Claude Code names each run, Griffin did not).
export const STEP_TITLE = {
  type: "string",
  maxLength: 120,
  description:
    "A short name for this step, 3–8 words of plain Persian, shown as the step's title in the chat — what it does for the person reading, not the command again. e.g. «بررسی فضای دیسک نود» or «پیدا کردن علت ریستارت پاد».",
};
