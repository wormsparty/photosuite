import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let DescriptorCodec, restore;
before(async () => {
  restore = installBrowserGlobals();
  ({ DescriptorCodec } = await import("../../../../src/document/formats/psd/descriptor-codec.js"));
});
after(() => restore?.());
const buffer = () => ({
  data: new Uint8Array(1024),
  ensureCapacity(pos, size) { assert.ok(Number.isInteger(pos + size) && pos + size <= this.data.length, "bounded shape fixture"); },
});
for (const [label, key] of [["nonstring", 7], ["nonbyte", "表"], ["over limit", "x".repeat(1001)], ["trimmed padding", " key"]]) {
  it(`rejects ${label} identifier before writing`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeOSKey(buf, 0, key), /psd-descriptor:/);
    assert.ok(buf.data.every(byte => byte === 0));
  });
}
for (const key of ["", "x", "é", "x".repeat(1000)]) {
  it(`retains independent identifier bytes at length ${key.length}`, () => {
    const buf = buffer();
    DescriptorCodec.writeOSKey(buf, 0, key);
    const isLong = key.length > 4;
    const length = isLong ? key.length : 0;
    const bytes = [length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255,
      ...Array.from(key, c => c.charCodeAt(0)), ...Array(isLong ? 0 : 4 - key.length).fill(32)];
    assert.deepEqual([...buf.data.slice(0, bytes.length)], bytes);
    assert.equal(DescriptorCodec.readOSKey(Uint8Array.from(bytes), 0), key);
  });
}
