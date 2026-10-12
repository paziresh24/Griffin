import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { AuthGate } from "./components/Login.jsx";
import { PublicChat, shareToken } from "./Public.jsx";
import { PeerStatus, peerStatusToken } from "./PeerStatus.jsx";
import "./styles.css";
import { applyDocumentLang } from "./i18n.js";
import { loadBrand } from "./brand.js";
import { startVersionWatch } from "./new-version.js";

applyDocumentLang();

try {
  document.documentElement.classList.toggle("dark", (localStorage.getItem("griffin.theme") || "dark") === "dark");
} catch {
  // storage unavailable: keep the default dark theme
}

// A shared link (#/s/<token>) is a separate, login-free page; switching between the two reloads.
const token = shareToken();
const statusToken = peerStatusToken();
window.addEventListener("hashchange", () => {
  if (shareToken() !== token || peerStatusToken() !== statusToken) window.location.reload();
});

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
loadBrand().finally(() =>
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      {token ? (
        <PublicChat token={token} />
      ) : statusToken ? (
        <PeerStatus token={statusToken} />
      ) : (
        <AuthGate>
          <App />
        </AuthGate>
      )}
    </StrictMode>,
  ),
);
