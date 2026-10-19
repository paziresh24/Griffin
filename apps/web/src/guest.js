// Private share (server private-share.mjs): the guest page's address and how a guest's note reaches
// assistant-ui. Pure, so the node tests cover it.

// #/p/<token> is the guest page, a separate login-free page like the public #/s/<token>.
export function guestToken(hash = window.location.hash) {
  return hash.match(/^#\/p\/([A-Za-z0-9_-]{32})$/)?.[1] || null;
}

// A note from the person a chat was privately shared with: a labelled system row, never the owner's
// message (and never an assistant turn).
export function guestMessage(message) {
  return {
    id: message.id,
    role: "system",
    content: [{ type: "text", text: String(message.text || "") }],
    createdAt: message.at ? new Date(message.at) : undefined,
    metadata: { custom: { guest: { from: String(message.from || "") } } },
  };
}

// The code box: Persian digits are typed as ASCII, anything else is dropped, six at most.
export function codeDigits(value) {
  return String(value || "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))) // i18n-ignore
    .replace(/\D/g, "")
    .slice(0, 6);
}
