// Lets a Griffin page (Settings → «مرورگر من») see this extension and pair it with one click. Only two
// questions pass, and the service worker decides by the page's real origin: a page that is not this
// browser's Griffin gets a confirmation window the owner must answer, never a silent pairing.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "griffin-page") return;
  const { type, id, code } = event.data;
  if (type !== "hello" && type !== "pair") return;
  chrome.runtime.sendMessage(type === "hello" ? { type: "pageHello" } : { type: "pagePair", code: String(code || "") }, (answer) => {
    window.postMessage({ source: "griffin-ext", id, type, ...(answer || { ok: false, error: chrome.runtime.lastError?.message || "no answer" }) }, window.location.origin);
  });
});
