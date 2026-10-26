import { t } from "./i18n.js";
// The phone over WebUSB: this tab talks ADB to an Android phone plugged into this computer and pipes the raw
// ADB packets to the server over a WebSocket. The server serves them as an adbd on the install's loopback, so
// the agent runs real `adb` (install, logcat, reverse, screencap) against a phone that is on the person's desk
// — no laptop agent, no adb on this computer. Same USB handling as webadb (Tango): one bulk transfer for the
// 24-byte header, one for the payload, and a zero-length packet when the payload fills whole USB packets.

export const ADB_INTERFACE = { classCode: 0xff, subclassCode: 0x42, protocolCode: 1 };
const HEADER = 24;

export function usbSupported() {
  return typeof navigator !== "undefined" && !!navigator.usb && typeof window !== "undefined" && window.isSecureContext;
}

// The ADB interface of a USB device: { configuration, interfaceNumber, alternateSetting, inEp, outEp } or null.
export function findAdbInterface(device) {
  for (const configuration of device.configurations || []) {
    for (const iface of configuration.interfaces || []) {
      for (const alt of iface.alternates || []) {
        if (alt.interfaceClass !== ADB_INTERFACE.classCode || alt.interfaceSubclass !== ADB_INTERFACE.subclassCode
          || alt.interfaceProtocol !== ADB_INTERFACE.protocolCode) continue;
        const inEp = alt.endpoints.find((e) => e.direction === "in");
        const outEp = alt.endpoints.find((e) => e.direction === "out");
        if (inEp && outEp) return { configuration, interfaceNumber: iface.interfaceNumber, alternateSetting: alt.alternateSetting, inEp, outEp };
      }
    }
  }
  return null;
}

// A valid ADB header: magic is command ^ 0xffffffff. Returns { command, payloadLength } or null.
export function readHeader(bytes) {
  if (!bytes || bytes.byteLength !== HEADER) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, HEADER);
  const command = v.getUint32(0, true);
  const magic = v.getUint32(20, true);
  if ((magic ^ 0xffffffff) >>> 0 !== command) return null;
  return { command, payloadLength: v.getUint32(12, true) };
}

export function deviceLabel(device) {
  const name = [device.manufacturerName, device.productName].filter(Boolean).join(" ");
  return name || `USB ${device.vendorId.toString(16)}:${device.productId.toString(16)}`;
}

/**
 * Open the phone and bridge it to `wsUrl`. Returns { close, done } — done settles when either side ends.
 * `onState(text)` gets short Persian status lines. Throws a Persian message for the usual failures.
 */
export async function bridgePhone(device, wsUrl, { onState = () => {} } = {}) {
  const found = findAdbInterface(device);
  if (!found) throw new Error(t("این دستگاه رابط ADB ندارد؛ روی گوشی «اشکال‌زدایی USB» را روشن کنید."));
  try {
    if (!device.opened) await device.open();
    if (device.configuration?.configurationValue !== found.configuration.configurationValue) {
      await device.selectConfiguration(found.configuration.configurationValue);
    }
    await device.claimInterface(found.interfaceNumber);
    if (found.alternateSetting) await device.selectAlternateInterface(found.interfaceNumber, found.alternateSetting);
  } catch (e) {
    if (e?.name === "NetworkError" || e?.name === "SecurityError" || e?.name === "InvalidStateError") {
      throw new Error(t("گوشی دست برنامهٔ دیگری است (adb، Android Studio یا scrcpy روی همین کامپیوتر). آن را ببندید (adb kill-server) و دوباره وصل کنید."));
    }
    throw e;
  }
  const { inEp, outEp } = found;
  const zeroMask = outEp.packetSize - 1;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  let closed = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const close = async (why) => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch {}
    try { await device.releaseInterface(found.interfaceNumber); } catch {}
    try { await device.close(); } catch {}
    resolveDone(why || "closed");
  };

  // Server → phone: each WebSocket message is one whole ADB packet (the server frames the TCP stream).
  let writing = Promise.resolve();
  const toPhone = async (buf) => {
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength < HEADER) return;
    await device.transferOut(outEp.endpointNumber, bytes.subarray(0, HEADER));
    const payload = bytes.subarray(HEADER);
    if (payload.byteLength) {
      await device.transferOut(outEp.endpointNumber, payload);
      if (zeroMask && (payload.byteLength & zeroMask) === 0) await device.transferOut(outEp.endpointNumber, new Uint8Array(0));
    }
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try { const m = JSON.parse(ev.data); if (m?.state) onState(m.state); } catch {}
      return;
    }
    writing = writing.then(() => toPhone(ev.data)).catch((e) => close(`usb-out: ${e?.message || e}`));
  };
  ws.onclose = () => close("ws closed");
  ws.onerror = () => close("ws error");

  // Phone → server: read a header, then its payload, and send them as one message.
  const pump = async () => {
    while (!closed) {
      const r = await device.transferIn(inEp.endpointNumber, inEp.packetSize);
      if (closed) return;
      if (r.status !== "ok" || !r.data) continue;
      const head = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      const h = readHeader(head);
      if (!h) continue;
      const msg = new Uint8Array(HEADER + h.payloadLength);
      msg.set(head, 0);
      let got = 0;
      while (got < h.payloadLength) {
        const p = await device.transferIn(inEp.endpointNumber, h.payloadLength - got);
        if (closed) return;
        if (!p.data) continue;
        msg.set(new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), HEADER + got);
        got += p.data.byteLength;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(t("اتصال به سرور برقرار نشد.")));
  }).catch(async (e) => { await close("ws failed"); throw e; });
  ws.onerror = () => close("ws error");
  ws.send(JSON.stringify({ hello: { serial: device.serialNumber || "", label: deviceLabel(device) } }));
  pump().catch((e) => close(`usb-in: ${e?.message || e}`));
  const onDisconnect = (ev) => { if (ev.device === device) close("unplugged"); };
  navigator.usb.addEventListener("disconnect", onDisconnect);
  done.then(() => navigator.usb.removeEventListener("disconnect", onDisconnect));
  return { close, done };
}
