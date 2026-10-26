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
import { applyDocumentLang } from "./i18n.js";
import { BRAND, loadBrand } from "./brand.js";
import { startVersionWatch } from "./new-version.js";
import { watchErrors } from "./feedback.js";
import { watchStaleChunks } from "./stale-chunks.js";

watchStaleChunks();

applyDocumentLang();

try {
  document.documentElement.classList.toggle("dark", (localStorage.getItem("griffin.theme") || "dark") === "dark");
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

// This page's errors, for "send feedback" (feedback.js).
watchErrors();
// After an update an open tab finds out by itself and moves to the new version (new-version.js).
startVersionWatch();
// The service worker only shows Web Push notifications; registering it asks nothing — the permission
// prompt comes from the tap in Settings → Notifications. A notification tap navigates an open tab.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "griffin:navigate" && event.data.url) window.location.hash = new URL(event.data.url, window.location.href).hash || "";
  });
}

// The assistant's name comes from the server; render once it is known (defaults on failure).
loadBrand().finally(() => {
  // Before sign-in the tab names the install: the product title on a Karsara-look install, else the assistant.
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
});
