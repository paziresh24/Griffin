const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);
const WORDS = { on: "وصل است؛ گریفین می‌تواند در این مرورگر کار کند", connecting: "در حال اتصال…", paused: "متوقف است", error: "وصل نیست", off: "وصل نیست" };

async function render() {
  const s = await ask({ type: "status" });
  $("state").className = `state ${s.state}`;
  $("stateText").textContent = WORDS[s.state] || s.state;
  $("error").hidden = !s.error;
  $("error").textContent = s.error || "";
  $("update").hidden = !s.latest;
  $("update").textContent = s.latest ? `نسخهٔ ${s.latest} آمده: از تنظیمات گریفین دوباره دانلود کنید، روی همین پوشه باز کنید و در chrome://extensions «Reload» را بزنید.` : "";
  $("pair").hidden = s.paired;
  $("paired").hidden = !s.paired;
  if (!s.paired) {
    if (!$("server").value) $("server").value = s.server || "";
    if (!$("label").placeholder || !$("label").value) $("label").placeholder = s.label;
  } else {
    $("toggle").textContent = s.enabled ? "توقف" : "روشن";
    $("where").textContent = `${s.label} → ${s.server}${s.controlled ? ` · ${s.controlled} تب زیر کنترل` : ""}`;
  }
}

$("pair").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pairBtn").disabled = true;
  $("pairBtn").textContent = "در حال اتصال…";
  const r = await ask({ type: "pair", server: $("server").value, code: $("code").value, label: $("label").value });
  $("pairBtn").disabled = false;
  $("pairBtn").textContent = "اتصال";
  if (!r?.ok) { $("error").hidden = false; $("error").textContent = r?.error || "نشد"; return; }
  $("code").value = "";
  render();
});

$("toggle").addEventListener("click", async () => {
  const s = await ask({ type: "status" });
  await ask({ type: s.enabled ? "pause" : "resume" });
  setTimeout(render, 400);
});

$("unpair").addEventListener("click", async () => { await ask({ type: "unpair" }); render(); });

chrome.runtime.onMessage.addListener((m) => { if (m.type === "state") render(); });
render();
