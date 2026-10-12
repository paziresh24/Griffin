import { genv, setConfigOverrides } from "./env.mjs";

// Settings that used to need an env edit and a redeploy; setting up should never need leaving the UI
// or the CLI. Each one is still read through genv(), so the env stays the fallback; a
// value set here (kv "config") wins. live:false ones are read once at start — the UI says so and
// offers a restart. Paths, ports and the broker socket stay deploy-time on purpose, and so do
// OWNER_NAME and TZ (read while modules load, before this store exists).
export const CONFIG_SCHEMA = [
  { key: "PUBLIC_URL", label: "آدرس عمومی (لینک‌های نمودار/فایل در پیام‌رسان‌ها)", live: false },
  { key: "OPS_MODE", label: "اتاق عملیات هشدارها", options: ["off", "record", "critical", "shadow"], live: false },
  { key: "SELF_HEAL", label: "تعمیر خودکار هر ۱۵ دقیقه", options: ["on", "off"], live: false },
  { key: "REVIEW", label: "بازبینی دوگانهٔ تغییرها قبل از اجرا", options: ["on", "off"], live: true },
  { key: "AUTO_CONTINUE", label: "ادامهٔ خودکار گفتگو بعد از بازشدن سقف مصرف (حداکثر سه بار پشت هم؛ هر پیام شما لغوش می‌کند؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PROMPT_SUGGESTIONS", label: "پیشنهاد پیام بعدی در کادر (فقط Claude؛ Tab برای پذیرفتن؛ هر پیشنهاد کمی از سهم مصرف می‌برد؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "TEAM_PROVIDER", label: "رشته‌های همکاران: حساب موتور", kind: "account", live: true },
  { key: "TEAM_MODEL", label: "رشته‌های همکاران: مدل", live: true },
  { key: "TEAM_EFFORT", label: "رشته‌های همکاران: میزان فکر", options: ["", "low", "medium", "high", "xhigh", "max"], live: true },
  { key: "TEAM_SUB_PROVIDER", label: "زیرکارهای رشتهٔ همکار: حساب موتور", kind: "account", live: true },
  { key: "TEAM_SUB_MODEL", label: "زیرکارهای رشتهٔ همکار: مدل", live: true },
  { key: "FALLBACK_CLAUDE_MODEL", label: "مدل جایگزین Claude وقتی موتور OpenAI-compatible پر شد", live: true },
  { key: "TITLE_MODEL", label: "مدل ساختن عنوان چت", live: true },
  { key: "DEFAULT_REPO", label: "ریپوی پیش‌فرض چت تازه", live: true },
  { key: "PEER_SELF_SERVE", label: "راهنمای «خودت انجام بده» برای ایجنت همکاران ({user} = شناسهٔ همکار)", multiline: true, live: true },
  { key: "STT_BASE_URL", label: "تبدیل صدا به متن: آدرس سرویس", live: true },
  { key: "STT_MODEL", label: "تبدیل صدا به متن: مدل", live: true },
  { key: "STT_LANGUAGE", label: "تبدیل صدا به متن: زبان", live: true },
];
const KEYS = new Set(CONFIG_SCHEMA.map((c) => c.key));

export function createConfig({ store }) {
  let cache = null;
  const read = () => {
    if (!cache) {
      try {
        cache = JSON.parse(store.getKv("config") || "{}") || {};
      } catch {
        cache = {};
      }
    }
    return cache;
  };
  setConfigOverrides(read);

  return {
    view() {
      const saved = read();
      return CONFIG_SCHEMA.map((c) => {
        const own = saved[c.key];
        return { ...c, value: own ?? "", effective: genv(c.key, "") || "", fromEnv: own === undefined && Boolean(genv(c.key, "")) };
      });
    },
    set(patch) {
      const next = { ...read() };
      const changed = [];
      for (const [key, value] of Object.entries(patch || {})) {
        if (!KEYS.has(key)) throw new Error(`unknown setting ${key}`);
        const text = value == null ? "" : String(value).trim().slice(0, 4000);
        const spec = CONFIG_SCHEMA.find((c) => c.key === key);
        if (text && spec.options && !spec.options.includes(text)) throw new Error(`${key} must be one of ${spec.options.filter(Boolean).join(", ")}`);
        if (text) next[key] = text;
        else delete next[key];
        changed.push(spec);
      }
      store.setKv("config", JSON.stringify(next));
      cache = next;
      return { restart: changed.some((c) => !c.live) };
    },
  };
}
