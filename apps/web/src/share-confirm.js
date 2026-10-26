import { t } from "./i18n.js";
// Private share: who a search result is. "contact" = one of the owner's Telegram contacts; "chat" =
// in the owner's recent chats but not a contact (anyone can write first); anything else was found
// through Telegram's own search. Only a contact is invited without the owner typing the exact
// @username (the server checks it too, and asks for it when it knows better — afterRefusal).
export const sourceLabel = (person) =>
  person?.source === "contact" ? t("از مخاطبانِ شما") : person?.source === "chat" ? t("در گفتگوهای شما، نه در مخاطبان") : t("پیداشده در تلگرام");
export const needsConfirm = (person) => person?.source !== "contact";
export const confirmMatches = (person, typed) =>
  Boolean(person?.username) && String(typed || "").trim().replace(/^@/, "").toLowerCase() === String(person.username).toLowerCase();
// The server refused because the person is not a contact (409 + confirm): the picked person, now
// needing the confirmation field. Anything else: null (an ordinary error).
export function afterRefusal(picked, error) {
  const confirm = error?.status === 409 ? error?.body?.confirm : null;
  if (!picked || !confirm?.username) return null;
  return { ...picked, username: confirm.username, source: picked.source === "contact" ? "chat" : picked.source };
}

// Invites that went pending and then failed (GET …/private-shares failedInvites, told once).
export const failedInviteNotes = (answer) =>
  (Array.isArray(answer?.failedInvites) ? answer.failedInvites : []).map((f) => t("دعوتِ {grantee} در تلگرام نرسید و اشتراکش برداشته شد؛ دوباره دعوت کنید.", { grantee: f.grantee }));
