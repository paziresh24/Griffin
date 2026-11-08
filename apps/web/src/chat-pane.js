// The pane beside a chat (components/ChatPane.jsx). Pure logic, so node tests import it directly.
// A view is one tab of the pane; one may be pinned: it stays first, has no close, the panel opens on
// it, and the top button of the chat shows it. Kept on this device, the same for every chat.

export const PANE_VIEWS = ["plan", "changes", "terminal", "browser", "side"];
export const emptyPane = () => ({ open: false, tabs: ["plan"], tab: "plan", pinned: "plan" });

export function cleanPane(value) {
  const base = emptyPane();
  if (!value || typeof value !== "object") return base;
  const tabs = Array.isArray(value.tabs) ? [...new Set(value.tabs)].filter((id) => PANE_VIEWS.includes(id)) : base.tabs;
  const pinned = value.pinned == null ? null : PANE_VIEWS.includes(value.pinned) ? value.pinned : base.pinned;
  const all = pinned && !tabs.includes(pinned) ? [pinned, ...tabs] : tabs;
  return { open: Boolean(value.open), tabs: all, tab: all.includes(value.tab) ? value.tab : all[0] || "plan", pinned };
}

export function paneReducer(state, action) {
  switch (action?.type) {
    case "tab": {
      const tabs = state.tabs.includes(action.id) ? state.tabs : [...state.tabs, action.id];
      return { ...state, open: true, tabs, tab: action.id };
    }
    case "toggle": {
      if (state.open) return { ...state, open: false };
      const tabs = state.tabs.length ? state.tabs : [state.pinned || "plan"];
      return { ...state, open: true, tabs, tab: state.pinned || (tabs.includes(state.tab) ? state.tab : tabs[0]) };
    }
    case "close":
      return { ...state, open: false };
    case "closeTab": {
      if (action.id === state.pinned) return state;
      const tabs = state.tabs.filter((id) => id !== action.id);
      const tab = state.tab === action.id ? state.pinned || tabs[tabs.length - 1] || "plan" : state.tab;
      return { ...state, tabs, tab, open: tabs.length ? state.open : false };
    }
    case "pin": {
      if (state.pinned === action.id) return { ...state, pinned: null };
      return { ...state, pinned: action.id, tabs: [action.id, ...state.tabs.filter((id) => id !== action.id)] };
    }
    default:
      return state;
  }
}

/** What «+» offers: only the views that are not open. */
export const missingViews = (state, available = PANE_VIEWS) => available.filter((id) => !state.tabs.includes(id));

export function planSummary(plan) {
  const subs = (plan?.tasks || []).flatMap((t) => t.subs);
  const done = subs.filter((s) => s.status === "done").length;
  const proposed = plan?.state === "proposed";
  const active = plan?.state === "active";
  return {
    none: !plan,
    proposed,
    active,
    done,
    total: subs.length,
    finished: active && subs.length > 0 && done === subs.length,
    // What the agent is on: what it marked, else the next one.
    current: active ? subs.find((s) => s.status === "in_progress") || subs.find((s) => s.status !== "done") || null : null,
  };
}

export const taskDone = (task) => task.subs.length > 0 && task.subs.every((s) => s.status === "done");

/** A unified diff as rows to draw: no file header, each line with its kind. */
export function diffRows(text) {
  const rows = [];
  let body = false;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("@@")) body = true;
    if (!body) continue;
    rows.push({ kind: line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same", text: line });
  }
  if (rows[rows.length - 1]?.text === "") rows.pop();
  return rows;
}
