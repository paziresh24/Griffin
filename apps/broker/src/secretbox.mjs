import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The broker's own encrypted store — a copy of apps/server/src/secrets.mjs (the two apps share no
// code). Tool credentials set from the UI land here when no OpenBao is configured; values never
// leave the broker container.

export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/;
const MAX_VALUE = 64 * 1024;

function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* mode bits are advisory on some filesystems */
  }
}

export function createSecretStore({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, "secrets.key");
  const storeFile = path.join(dataDir, "secrets.json");
  let key = null;

  function masterKey() {
    if (key) return key;
    if (!fs.existsSync(keyFile)) writePrivate(keyFile, crypto.randomBytes(32).toString("base64"));
    key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("secret key file is corrupt");
    return key;
  }

  function load() {
    try {
      return JSON.parse(fs.readFileSync(storeFile, "utf8")).items || {};
    } catch {
      return {};
    }
  }
  const save = (items) => writePrivate(storeFile, JSON.stringify({ items }));

  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  function decrypt(box) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  }

  function check(name) {
    if (!SECRET_NAME.test(String(name || ""))) throw new Error("invalid secret name");
  }

  return {
    // Internal only: the code that uses the credential reads it at the moment it needs it.
    get(name) {
      const item = load()[name];
      if (!item) return "";
      try {
        return decrypt(item.box);
      } catch {
        return "";
      }
    },
    has: (name) => Boolean(load()[name]),
    set(name, value, { note } = {}) {
      check(name);
      const plain = String(value ?? "").trim();
      if (!plain) throw new Error("empty value");
      if (plain.length > MAX_VALUE) throw new Error("value too large");
      const items = load();
      items[name] = {
        box: encrypt(plain),
        last4: plain.length > 8 ? plain.slice(-4) : "",
        note: typeof note === "string" ? note.slice(0, 200) : items[name]?.note || "",
        updatedAt: new Date().toISOString(),
      };
      save(items);
    },
    delete(name) {
      const items = load();
      if (!items[name]) return false;
      delete items[name];
      save(items);
      return true;
    },
    list() {
      return Object.entries(load())
        .map(([name, item]) => ({ name, last4: item.last4 || "", note: item.note || "", updatedAt: item.updatedAt || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
