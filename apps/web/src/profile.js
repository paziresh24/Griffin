// The owner's name and photo at the foot of the sidebar (GET /api/profile): the
// connected Telegram account's, or a name typed in Settings; with neither, the app icon and «Owner».
// The owner, not the assistant (BRAND.name is the assistant's name).
import { iconUrl } from "./brand.js";

export const PROFILE_EVENT = "griffin:profile";

export function ownerView(profile) {
  const photo = profile?.photo || null;
  return { name: profile?.name || "Owner", photo: photo || iconUrl(), isPhoto: Boolean(photo) };
}

// Settings saved a name: the sidebar shows it at once, without waiting for its next ask.
export const profileChanged = (profile) => window.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: profile }));
