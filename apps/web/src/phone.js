import { api } from "./api.js";
import { bridgePhone, deviceLabel, findAdbInterface, usbSupported } from "./phone-usb.js";
import { t } from "./i18n.js";

// The phone bridge of this tab, outside any component: it lives while the tab is open, whichever page is
// showing. Settings → «گوشی» starts and stops it. Once a phone was bridged here, it comes back by itself
// on a reload and when that phone is plugged in again (the browser remembers the permission).

const AUTO = "griffin.phone.auto";
let state = { status: "off", label: "", message: "", serial: "" }; // off | connecting | on | error
let current = null;
const listeners = new Set();

const set = (patch) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
};

export const phoneState = () => state;
export function subscribePhone(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const wsUrl = (ticket, path) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}?ticket=${encodeURIComponent(ticket)}`;
const auto = (on) => { try { on ? localStorage.setItem(AUTO, "1") : localStorage.removeItem(AUTO); } catch {} };
const autoOn = () => { try { return localStorage.getItem(AUTO) === "1"; } catch { return false; } };

async function bridge(device) {
  if (current) return;
  set({ status: "connecting", label: deviceLabel(device), message: "" });
  try {
    const { ticket, path } = await api("/api/phone/ticket", { method: "POST" });
    current = await bridgePhone(device, wsUrl(ticket, path), {
      onState: (s) => (s === "ready" ? set({ status: "on", message: "" }) : set({ message: s })),
    });
    auto(true);
    current.done.then((why) => {
      current = null;
      set({ status: why === "stopped" ? "off" : "error", message: why === "stopped" ? "" : why === "unplugged" ? t("گوشی از USB جدا شد؛ دوباره وصل کنید، خودش برمی‌گردد.") : t("اتصال قطع شد.") });
    });
  } catch (e) {
    current = null;
    set({ status: "error", message: e?.message || String(e) });
  }
}

// «اتصال گوشی»: the browser's own device picker (needs a click), then the bridge.
export async function connectPhone() {
  if (!usbSupported()) return set({ status: "error", message: t("این مرورگر WebUSB ندارد؛ Chrome یا Edge روی کامپیوتر (با https) لازم است.") });
  let device;
  try {
    device = await navigator.usb.requestDevice({ filters: [{ classCode: 0xff, subclassCode: 0x42, protocolCode: 1 }] });
  } catch (e) {
    if (e?.name === "NotFoundError") return; // picker closed
    return set({ status: "error", message: e?.message || String(e) });
  }
  await bridge(device);
}

export async function disconnectPhone() {
  auto(false);
  const c = current;
  current = null;
  if (c) await c.close("stopped");
  set({ status: "off", message: "" });
}

// Called once at start: bring back a phone this tab bridged before.
export async function resumePhone() {
  if (!usbSupported() || !autoOn()) return;
  const known = async () => (await navigator.usb.getDevices()).find((d) => findAdbInterface(d));
  const d = await known().catch(() => null);
  if (d) bridge(d);
  navigator.usb.addEventListener("connect", (ev) => {
    if (autoOn() && !current && findAdbInterface(ev.device)) bridge(ev.device);
  });
}
