// A fresh install gets a random assistant name, not the product's (owner 2026-10-17: «نام دستیار هم
// دیفالت گریفین نباشه و یه اسم رندوم باشه»). Picked once, on the very first start (no database yet),
// and written to <data>/persona.json, so it never changes by itself. An env name or a persona.json
// that already names the assistant win; an install that has a database keeps what it has.
// index.mjs imports this first: persona.mjs and the agent registry read the name at load.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { genv, resolveDbPath } from "./env.mjs";

export const NAMES = [
  ["آوا", "Ava"], ["نیلا", "Nila"], ["رها", "Raha"], ["سانا", "Sana"], ["تینا", "Tina"],
  ["دارا", "Dara"], ["کیان", "Kian"], ["آیدین", "Aydin"], ["نیکا", "Nika"], ["مانا", "Mana"],
  ["ترانه", "Taraneh"], ["بردیا", "Bardia"], ["سورنا", "Sorena"], ["آسا", "Asa"], ["یارا", "Yara"],
  ["هستی", "Hasti"], ["آرمان", "Arman"], ["پرهام", "Parham"], ["نوا", "Nava"], ["ویدا", "Vida"],
  ["سپند", "Sepand"], ["آتنا", "Atena"], ["ماهان", "Mahan"], ["روشا", "Rosha"], ["پویا", "Pouya"],
  ["آناهید", "Anahid"], ["شیدا", "Sheida"], ["کاوه", "Kaveh"], ["لیان", "Lian"], ["آرین", "Arian"],
];

/** A name from the list, never `not` (the shuffle button asks for «another one»). */
export function randomName(random = Math.random, not = "") {
  const pool = NAMES.filter(([name]) => name !== not);
  const [name, latin] = pool[Math.floor(random() * pool.length) % pool.length];
  return { name, latin };
}

/** Names a fresh install; returns the name it wrote, or null when it left things as they were. */
export function nameFreshInstall({ env = process.env, random = Math.random } = {}) {
  if (env.GRIFFIN_ASSISTANT_NAME) return null;
  const data = env.GRIFFIN_DATA || "/data"; // where persona.mjs reads persona.json
  const file = path.join(data, "persona.json");
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) || {};
  } catch {
    current = {};
  }
  if (current.name || existsSync(resolveDbPath(genv("DATA", "/data", env), env))) return null;
  const picked = randomName(random);
  try {
    mkdirSync(data, { recursive: true });
    writeFileSync(file, JSON.stringify({ ...current, ...picked }));
  } catch {
    return null; // a read-only data folder: the old default stays
  }
  return picked;
}

// Only when the server itself starts, not when a test or a script imports this.
if (/[/\\]index\.mjs$/.test(process.argv[1] || "")) nameFreshInstall();
