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
const channel = (arr = [1]) => ({ id: "x", type: "UnFl", uID: "#Pxl", arr });
const obar = arr => ({ t: "ObAr", v: { classID: "test", arr } });
const invalid = [
  ["raw wide typed array", { t: "tdta", v: Uint16Array.of(256) }],
  ["path null", { t: "Pth ", v: null }],
  ["channel null", obar([null])],
  ["raw string", { t: "tdta", v: "abc" }],
  ["raw sparse array", { t: "tdta", v: Array(1) }],
  ["raw negative byte", { t: "tdta", v: [-1] }],
  ["raw overflow byte", { t: "tdta", v: [256] }],
  ["raw fractional byte", { t: "tdta", v: [1.5] }],
  ["raw numeric string", { t: "tdta", v: ["1"] }],
  ["alias array", { t: "alis", v: [65] }],
  ["alias nonbyte text", { t: "alis", v: "表" }],
  ["path array", { t: "Pth ", v: { sig: "txtu", pth: ["x"] } }],
  ["path number", { t: "Pth ", v: { sig: "txtu", pth: 3 } }],
  ["channels array-like", obar({ length: 0 })],
  ["channels sparse", obar(Array(1))],
  ["channel samples array-like", obar([channel({ length: 0 })])],
  ["channel samples sparse", obar([channel(Array(1))])],
  ["channel sample string", obar([channel(["3"])])],
  ["channel sample null", obar([channel([null])])],
  ["array name number", { t: "ObAr", v: { classID: "test", __name: 7, arr: [] } }],
];
for (const [label, node] of invalid) {
  it(`rejects ${label} before emitting the typed node`, () => {
    const buf = buffer();
    assert.throws(() => DescriptorCodec.writeValue(buf, 0, node), /psd-descriptor:/);
    assert.deepEqual([...buf.data.slice(0, 4)], [0, 0, 0, 0]);
  });
}
const ascii = s => Array.from(s, c => c.charCodeAt(0));
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
it("writes independent raw and alias bytes and retains a following node", () => {
  for (const raw of [[0, 128, 255], Uint8Array.of(0, 128, 255), Buffer.from([0,128,255])]) {
    const node = { t: "VlLs", v: [{ t: "tdta", v: raw }, { t: "alis", v: "\x00\x80\xff" }, { t: "long", v: 7 }] };
    const expected = [...ascii("VlLs"), ...u32(3), ...ascii("tdta"), ...u32(3), 0,128,255,
      ...ascii("alis"), ...u32(3), 0,128,255, ...ascii("long"), ...u32(7)];
    const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, node);
    assert.deepEqual([...buf.data.slice(0, size)], expected);
    const parsed = DescriptorCodec.readValue(Uint8Array.from(expected), 0);
    assert.equal(parsed.size, expected.length);
    assert.deepEqual(parsed.v[0].v, [0,128,255]);
    assert.equal(parsed.v[1].v, "\x00\x80\xff");
    assert.equal(parsed.v[2].v, 7);
  }
});
it("retains IEEE numeric object-array samples", () => {
  const samples = [-0, Infinity, -Infinity, NaN];
  const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, obar([channel(samples)]));
  const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
  for (let i = 0; i < samples.length; i++) assert.ok(Object.is(parsed.v.arr[0].arr[i], samples[i]));
});
it("writes empty raw, alias, path and object-array layouts independently", () => {
  const cases = [
    [{ t: "tdta", v: [] }, [...ascii("tdta"), ...u32(0)]],
    [{ t: "alis", v: "" }, [...ascii("alis"), ...u32(0)]],
    [{ t: "Pth ", v: { sig: "txtu", pth: "" } }, [...ascii("Pth "), ...u32(12), ...ascii("txtu"), 12,0,0,0, 0,0,0,0]],
    [obar([]), [...ascii("ObAr"), ...u32(0), ...u32(1), 0,0, ...u32(0), ...ascii("test"), ...u32(0)]],
  ];
  for (const [node, expected] of cases) {
    const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, node);
    assert.deepEqual([...buf.data.slice(0, size)], expected);
    const parsed = DescriptorCodec.readValue(Uint8Array.from(expected), 0);
    delete parsed.size;
    assert.deepEqual(parsed, node);
  }
});
it("writes independent Unicode path bytes", () => {
  const node = { t: "Pth ", v: { sig: "txtu", pth: "é表" } };
  const expected = [...ascii("Pth "), ...u32(16), ...ascii("txtu"), 16,0,0,0, 2,0,0,0, 233,0,104,136];
  const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, node);
  assert.deepEqual([...buf.data.slice(0, size)], expected);
  const parsed = DescriptorCodec.readValue(Uint8Array.from(expected), 0);
  delete parsed.size;
  assert.deepEqual(parsed, node);
});
