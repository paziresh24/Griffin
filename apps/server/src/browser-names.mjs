// The browser tools' names (browser.mjs), apart so the profile and plan-mode code need not load it.
export const BROWSER_TOOL_NAMES = Object.freeze([
  "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_press",
  "browser_hover", "browser_upload", "browser_wait", "browser_eval", "browser_screenshot", "browser_tabs",
  "browser_console", "browser_close",
]);
// Calls that act on a page (a click can submit a form): plan mode refuses them.
export const BROWSER_WRITE_TOOLS = Object.freeze(["browser_click", "browser_type", "browser_select", "browser_press", "browser_upload", "browser_eval"]);
// The owner's own Chrome through the Griffin extension (my-browser.mjs): owner chats only, once paired.
export const MY_BROWSER_TOOL_NAMES = Object.freeze(["chrome_tabs", "chrome_snapshot", "chrome_act", "chrome_eval", "chrome_screenshot", "chrome_devtools", "chrome_cdp"]);
export const MY_BROWSER_WRITE_TOOLS = Object.freeze(["chrome_tabs", "chrome_act", "chrome_eval", "chrome_cdp"]);
