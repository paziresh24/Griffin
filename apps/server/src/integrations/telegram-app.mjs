import fs from "node:fs";
import path from "node:path";

// The host's default Telegram client app (api_id/api_hash from my.telegram.org), so a Telegram
// account login on this server needs only a phone number. It lives in the data volume as
// telegram-app.json (mode 0600, same idea as owner.token), never in git, and is read on each use so
// the file can be added or changed without a restart. The ids never leave the server: the UI is
// only told whether a default exists.
export const TELEGRAM_APP_FILE = "telegram-app.json";

export const validTelegramApp = (apiId, apiHash) => /^\d{3,10}$/.test(String(apiId || "")) && /^[a-f0-9]{32}$/i.test(String(apiHash || ""));

// A phone as people paste it: Persian/Arabic digits, spaces, dashes, brackets and the invisible
// direction marks that ride along when a number is copied out of right-to-left text. Keeps a leading
// "+" and ASCII digits only.
export function normalizePhone(raw) {
  const ascii = String(raw || "").replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
  const digits = ascii.replace(/[^\d+]/g, "");
  return (digits.startsWith("+") ? "+" : "") + digits.replace(/\+/g, "");
}

export function readTelegramApp(dataDir) {
  try {
    const { apiId, apiHash } = JSON.parse(fs.readFileSync(path.join(dataDir, TELEGRAM_APP_FILE), "utf8"));
    return validTelegramApp(apiId, apiHash) ? { apiId: String(apiId), apiHash: String(apiHash) } : null;
  } catch {
    return null;
  }
}
