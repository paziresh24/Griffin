import crypto from "node:crypto";

// Time-based one-time codes (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits), the kind every
// authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden…) shows.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

// The step the code belongs to (one step of clock drift either way), or null. The caller refuses a
// step it has already accepted, so a code seen over someone's shoulder cannot be used again.
export function totpMatch(secret, code, ms = Date.now()) {
  const given = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const now = stepAt(ms);
  for (const step of [now, now - 1, now + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(given))) return step;
  }
  return null;
}

export function otpauthUri(secret, { issuer, account }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// Recovery codes: ten one-time codes (xxxxx-xxxxx) for a lost phone; only their hashes are kept.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(10);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}
export const normalizeRecovery = (code) => String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const recoveryHash = (code) => crypto.createHash("sha256").update(normalizeRecovery(code)).digest("hex");
