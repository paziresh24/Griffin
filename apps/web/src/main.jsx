import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { AuthGate } from "./components/Login.jsx";
import { PublicChat, shareToken } from "./Public.jsx";
import { PeerStatus, peerStatusToken } from "./PeerStatus.jsx";
import { GuestChat } from "./Guest.jsx";
import { guestToken } from "./guest.js";
import "./styles.css";
import "./karsara.css";
import { BRAND, applyCachedBrand, loadBrand } from "./brand.js";
import { startVersionWatch } from "./new-version.js";
import { watchErrors } from "./feedback.js";
import { watchStaleChunks } from "./stale-chunks.js";
import { applyDocumentLang } from "./i18n.js";
import { ASK_EVENT, catchAskLink } from "./ask-link.js";

watchStaleChunks();
applyDocumentLang();

try {
  document.documentElement.classList.toggle("dark", (localStorage.getItem("griffin.theme") || localStorage.getItem("sokan.theme") || "dark") === "dark");
} catch {
  // storage unavailable: keep the default dark theme
}

// A shared link (#/s/<token>) and a private one (#/p/<token>) are separate, login-free pages;
// switching between them and the app reloads.
const token = shareToken();
const statusToken = peerStatusToken();
const guest = guestToken();
window.addEventListener("hashchange", () => {
  if (shareToken() !== token || peerStatusToken() !== statusToken || guestToken() !== guest) window.location.reload();
});

// The ticketing page was #/support before it became a module (#/m/tickets/tickets): old links and
// bookmarks still land on it.
const movedPage = () => {
  if (window.location.hash === "#/support") window.location.replace("#/m/tickets/tickets");
};
movedPage();
window.addEventListener("hashchange", movedPage);

// «#/new?ask=<text>» (ask-link.js): the text waits in this tab for the new chat's box and the address
// becomes «#/» before the app reads it (this listener is older than the router's), so a reload does not
// fill the box again. Signed out, the text waits behind the sign-in form.
const askLink = () => {
  let storage = null;
  try {
    storage = window.sessionStorage;
  } catch {
    /* storage unavailable: the link still opens a new chat */
  }
  if (!catchAskLink(storage, window.location.hash)) return;
  window.history.replaceState(window.history.state, "", "#/");
  window.dispatchEvent(new Event(ASK_EVENT));
};
askLink();
window.addEventListener("hashchange", askLink);

// This page's errors, for «ارسال بازخورد» (feedback.js).
watchErrors();
// After an update an open tab finds out by itself and moves to the new version (new-version.js).
startVersionWatch();
// The service worker only shows Web Push notifications; registering it asks nothing — the permission
// prompt comes from the tap in Settings → اعلان‌ها. A notification tap navigates an open tab.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "griffin:navigate" && event.data.url) window.location.hash = new URL(event.data.url, window.location.href).hash || "";
  });
}

// The assistant's name comes from the server: render with the last visit's at once, or on a first visit
// once it is known (defaults on failure).
const start = () => {
  // Before sign-in the tab names the install: «کارسرا» on a Karsara-look install, else the assistant.
  document.title = BRAND.title;
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      {token ? (
        <PublicChat token={token} />
      ) : guest ? (
        <GuestChat token={guest} />
      ) : statusToken ? (
        <PeerStatus token={statusToken} />
      ) : (
        <AuthGate>
          <App />
        </AuthGate>
      )}
    </StrictMode>,
  );
};
if (applyCachedBrand()) {
  start();
  loadBrand();
} else loadBrand().finally(start);
