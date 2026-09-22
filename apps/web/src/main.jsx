import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { AuthGate } from "./components/Login.jsx";
import { PublicChat, shareToken } from "./Public.jsx";
import "./styles.css";

try {
  document.documentElement.classList.toggle("dark", (localStorage.getItem("griffin.theme") || "dark") === "dark");
} catch {
  // storage unavailable: keep the default dark theme
}

// A shared link (#/s/<token>) is a separate, login-free page; switching between the two reloads.
const token = shareToken();
window.addEventListener("hashchange", () => {
  if (shareToken() !== token) window.location.reload();
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {token ? (
      <PublicChat token={token} />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);
