import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceLabel, findAdbInterface, readHeader } from "../src/phone-usb.js";

const header = (cmd, len, magicOk = true) => {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  const c = new DataView(new TextEncoder().encode(cmd).buffer).getUint32(0, true);
  v.setUint32(0, c, true);
  v.setUint32(12, len, true);
  v.setUint32(20, magicOk ? (c ^ 0xffffffff) >>> 0 : 0, true);
  return b;
};

test("readHeader takes only a 24-byte header whose magic matches", () => {
  assert.equal(readHeader(header("WRTE", 4096)).payloadLength, 4096);
  assert.equal(readHeader(header("WRTE", 1, false)), null);
  assert.equal(readHeader(new Uint8Array(30)), null);
});

test("findAdbInterface picks the ADB interface (ff/42/01) and its two bulk endpoints", () => {
  const ep = (direction, endpointNumber) => ({ direction, endpointNumber, packetSize: 512 });
  const device = {
    configurations: [{
      configurationValue: 1,
      interfaces: [
        { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 6, interfaceSubclass: 1, interfaceProtocol: 1, endpoints: [ep("in", 1)] }] },
        { interfaceNumber: 2, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 1, endpoints: [ep("out", 3), ep("in", 4)] }] },
      ],
    }],
  };
  const f = findAdbInterface(device);
  assert.equal(f.interfaceNumber, 2);
  assert.equal(f.inEp.endpointNumber, 4);
  assert.equal(f.outEp.endpointNumber, 3);
  assert.equal(findAdbInterface({ configurations: [device.configurations[0].interfaces[0]].map((i) => ({ interfaces: [i] })) }), null);
  assert.equal(deviceLabel({ manufacturerName: "samsung", productName: "SM-S918B", vendorId: 0x04e8, productId: 0x6860 }), "samsung SM-S918B");
  assert.equal(deviceLabel({ vendorId: 0x04e8, productId: 0x6860 }), "USB 4e8:6860");
});
