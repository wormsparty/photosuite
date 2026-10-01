import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let DescriptorCodec, restore;
before(async () => {
  restore = installBrowserGlobals();
  ({ DescriptorCodec } = await import("../../../../src/document/formats/psd/descriptor-codec.js"));
});
after(() => restore?.());
const buffer = () => ({ data: new Uint8Array(1024).fill(0xa5), ensureCapacity(pos, size) {
  assert.ok(Number.isFinite(pos) && pos + size <= this.data.length, "bounded metadata fixture");
} });
const ascii = s => Array.from(s, c => c.charCodeAt(0));
const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const unicode = s => [...u32(s.length + 1), ...s.split("").flatMap(c => [c.charCodeAt(0) >>> 8, c.charCodeAt(0) & 255]), 0, 0];
const key = s => [...u32(0), ...ascii(s)];
const refTypes = ["Clss", "type", "rele", "prop", "Enmr", "indx", "name"];
const reference = t => ({ classID: "Lyr ".trim(), ...(t === "prop" ? { keyID: "Nm" } : {}),
  ...(t === "Enmr" ? { typeID: "Ordn", enum: "Trgt" } : {}),
  ...(["rele", "indx"].includes(t) ? { val: 7 } : t === "name" ? { val: "表é" } : {}) });

for (const value of [7, [], {}, true]) {
  it(`descriptor rejects nonstring name ${JSON.stringify(value)} before writes`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeDescriptor(buf, { classID: "test", __name: value }, 0), /psd-descriptor:/);
    assert.ok(buf.data.every(v => v === 0xa5));
  });
}
for (const t of refTypes) {
  it(`${t} rejects malformed metadata before its type tag`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, { t, v: { ...reference(t), __name: 7 } }), /psd-descriptor:/);
    assert.ok(buf.data.every(v => v === 0xa5));
  });
  it(`${t} rejects a missing class identifier before its type tag`, () => {
    const buf = buffer(), v = reference(t);
    delete v.classID;
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, { t, v }), /psd-descriptor:/);
    assert.ok(buf.data.every(n => n === 0xa5));
  });
}
for (const val of [7, null, ["x"], { length: 1 }]) {
  it(`named reference rejects nonstring value ${JSON.stringify(val)}`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, { t: "name", v: { classID: "Lyr", val } }), /psd-descriptor:/);
    assert.ok(buf.data.every(v => v === 0xa5));
  });
}
for (const t of ["Objc", ...refTypes]) {
  it(`${t} rejects an array structured payload`, () => {
    const buf = buffer(), v = Object.assign([], reference(t));
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, { t, v }), /psd-descriptor:/);
    assert.ok(buf.data.every(n => n === 0xa5));
  });
}
it("named reference has independent Unicode bytes and preserves following scalar", () => {
  const buf = buffer(), node = { t: "VlLs", v: [
    { t: "name", v: { classID: "Lyr", __name: "é", val: "表é" } }, { t: "long", v: 9 },
  ] };
  const size = DescriptorCodec.writeValue(buf, 0, node);
  const fixture = [...ascii("VlLs"), ...u32(2), ...ascii("name"), ...unicode("é"), ...key("Lyr "), ...unicode("表é"), ...ascii("long"), ...u32(9)];
  assert.deepEqual([...buf.data.slice(0, size)], fixture);
  const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
  assert.equal(parsed.size, size); delete parsed.size;
  assert.deepEqual(parsed, node);
});
for (const t of refTypes) {
  it(`${t} retains nullable metadata and a following boolean`, () => {
    const buf = buffer(), node = { t: "VlLs", v: [{ t, v: { ...reference(t), __name: null } }, { t: "bool", v: true }] };
    const size = DescriptorCodec.writeValue(buf, 0, node);
    const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
    assert.equal(parsed.size, size); delete parsed.size;
    delete node.v[0].v.__name;
    assert.deepEqual(parsed, node);
  });
}

it("embedded NUL metadata and named value retain their counted Unicode units", () => {
  const buf = buffer(), node = { t: "name", v: { classID: "Lyr", __name: "a\0b", val: "c\0d" } };
  const size = DescriptorCodec.writeValue(buf, 0, node);
  assert.deepEqual([...buf.data.slice(0, size)], [...ascii("name"), ...unicode("a\0b"), ...key("Lyr "), ...unicode("c\0d")]);
  const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
  assert.equal(parsed.size, size); delete parsed.size;
  assert.deepEqual(parsed, node);
});
for (const [t, field] of [["prop", "keyID"], ["Enmr", "typeID"], ["Enmr", "enum"]]) {
  it(`${t} validates ${field} before emitting any bytes`, () => {
    const buf = buffer(), v = reference(t); delete v[field];
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, { t, v }), /psd-descriptor:/);
    assert.ok(buf.data.every(n => n === 0xa5));
  });
}
for (const desc of [null, Object.assign([], { classID: "test" })]) {
  it(`top descriptor rejects ${desc === null ? "null" : "array"} payload before writes`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeDescriptor(buf, desc, 0), /psd-descriptor:/);
    assert.ok(buf.data.every(n => n === 0xa5));
  });
}
it("nested descriptor rejects malformed metadata before the Objc tag", () => {
  const buf = buffer();
  assert.throws(() => DescriptorCodec.writeValue(buf, 0, { t: "Objc", v: { classID: "test", __name: 7 } }), /psd-descriptor:/);
  assert.ok(buf.data.every(n => n === 0xa5));
});
