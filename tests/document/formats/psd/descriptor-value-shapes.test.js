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
const invalid = [
  ["bool truthy string", { t: "bool", v: "false" }],
  ["bool number", { t: "bool", v: 1 }],
  ["double numeric string", { t: "doub", v: "3.5" }],
  ["double null", { t: "doub", v: null }],
  ["unit numeric string", { t: "UntF", v: { type: "#Pxl", val: "2" } }],
  ["text array", { t: "TEXT", v: ["x"] }],
  ["text number", { t: "TEXT", v: 2 }],
  ["list array-like", { t: "VlLs", v: { length: 1, 0: { t: "bool", v: true } } }],
  ["reference-list array-like", { t: "obj ", v: { length: 0 } }],
  ["sparse list", { t: "VlLs", v: Array(1) }],
  ["enum multiple pairs", { t: "enum", v: { mode: "first", kind: "second" } }],
  ["enum numeric key value", { t: "enum", v: { mode: 3 } }],
  ["enum empty", { t: "enum", v: {} }],
  ["enum array", { t: "enum", v: ["mode"] }],
];
for (const [label, node] of invalid) {
  it(`rejects ${label} before emitting the typed node`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, node), /psd-descriptor:/);
    assert.deepEqual([...buf.data.slice(0, 4)], [0, 0, 0, 0]);
  });
}
const ascii = s => [...s].map(c => c.charCodeAt(0));
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
it("writes independent scalar/list/enum bytes and preserves following value boundaries", () => {
  const node = { t: "VlLs", v: [
    { t: "bool", v: false }, { t: "bool", v: true }, { t: "doub", v: 1.5 },
    { t: "UntF", v: { type: "#Pxl", val: -2 } }, { t: "TEXT", v: "é" },
    { t: "enum", v: { mode: "test" } }, { t: "VlLs", v: [] }, { t: "long", v: 7 },
  ] };
  const expected = [...ascii("VlLs"), ...u32(8), ...ascii("bool"), 0, ...ascii("bool"), 1,
    ...ascii("doub"), 63, 248, 0, 0, 0, 0, 0, 0,
    ...ascii("UntF#Pxl"), 192, 0, 0, 0, 0, 0, 0, 0,
    ...ascii("TEXT"), ...u32(2), 0, 233, 0, 0,
    ...ascii("enum"), ...u32(0), ...ascii("mode"), ...u32(0), ...ascii("test"),
    ...ascii("VlLs"), ...u32(0), ...ascii("long"), ...u32(7)];
  const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, node);
  assert.deepEqual([...buf.data.slice(0, size)], expected);
  const parsed = DescriptorCodec.readValue(Uint8Array.from(expected), 0);
  assert.equal(parsed.size, size);
  delete parsed.size;
  assert.deepEqual(parsed, node);
});
it("retains IEEE double values including negative zero, infinity and NaN", () => {
  for (const value of [-0, Infinity, -Infinity, NaN]) {
    const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, { t: "doub", v: value });
    assert.equal(size, 12);
    assert.ok(Object.is(DescriptorCodec.readValue(buf.data.slice(0, size), 0).v, value));
  }
});
it("retains empty reference lists and enum pairs with inherited unrelated metadata", () => {
  for (const node of [
    { t: "obj ", v: [] },
    { t: "enum", v: Object.assign(Object.create({ ignored: "metadata" }), { mode: "test" }) },
  ]) {
    const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, node);
    const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
    delete parsed.size;
    assert.deepEqual(parsed, { t: node.t, v: node.t === "enum" ? { mode: "test" } : [] });
  }
});
