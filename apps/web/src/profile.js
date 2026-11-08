// The owner's name and photo at the foot of the sidebar (GET /api/profile): the
// connected Telegram account's, or a name typed in Settings; with neither, the app icon and «Owner».
// The owner, not the assistant (BRAND.name is the assistant's name).
import { iconUrl } from "./brand.js";

export const PROFILE_EVENT = "griffin:profile";

export function ownerView(profile) {
  const photo = profile?.photo || null;
  return { name: profile?.name || "Owner", photo: photo || iconUrl(), isPhoto: Boolean(photo) };
}

// The last answer, for the first paint of the next visit (the footer's name otherwise pops in).
const CACHE = "griffin.profile.v1";
export function readProfileCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE) || "null");
  } catch {
    return null;
  }
}
export function writeProfileCache(profile) {
  try {
    localStorage.setItem(CACHE, JSON.stringify(profile));
  } catch {
    /* blocked or full: the footer just waits for the server next time */
  }
}

// Settings saved a name: the sidebar shows it at once, without waiting for its next ask.
export const profileChanged = (profile) => window.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: profile }));
