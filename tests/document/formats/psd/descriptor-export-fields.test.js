import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let DescriptorCodec, restore;
before(async () => {
  restore = installBrowserGlobals();
  ({ DescriptorCodec } = await import("../../../../src/document/formats/psd/descriptor-codec.js"));
});
after(() => restore?.());

const ascii = s => [...s].map(c => c.charCodeAt(0));
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const unicode = s => [...u32(s.length + 1), ...s.split("").flatMap(c => [c.charCodeAt(0) >>> 8, c.charCodeAt(0) & 255]), 0, 0];
const descriptorFixture = (name = "") => [
  ...unicode(name), ...u32(0), ...ascii("test"), ...u32(1),
  ...u32(0), ...ascii("next"), ...ascii("long"), ...u32(7),
];
const buffer = () => ({
  data: new Uint8Array(1024),
  ensureCapacity(pos, size) { assert.ok(pos + size <= this.data.length, "bounded field fixture"); },
});
const assertDescriptorFixture = (desc, fixture = descriptorFixture()) => {
  const buf = buffer(), size = DescriptorCodec.writeDescriptor(buf, desc, 0);
  assert.deepEqual([...buf.data.slice(0, size)], fixture, "independent declared count and fields");
  const parsed = {};
  assert.equal(DescriptorCodec.parseDescriptor(buf.data.slice(0, size), parsed, 0), size);
  assert.deepEqual(parsed, {
    ...(desc.__name ? { __name: desc.__name } : {}), classID: "test", next: { t: "long", v: 7 },
  });
};

for (const name of [null, undefined, "", "é表"]) {
  it(`own name metadata ${String(name)} does not add a descriptor field`, () => {
    assertDescriptorFixture({ classID: "test", __name: name, next: { t: "long", v: 7 } },
      descriptorFixture(name ?? ""));
  });
}

it("inherited enumerable fields are excluded from the count and written fields", () => {
  const desc = Object.assign(Object.create({ extra: { t: "long", v: 99 } }), {
    classID: "test", next: { t: "long", v: 7 },
  });
  assertDescriptorFixture(desc);
});

for (const metadata of [{ classID: "test" }, { __name: "é表" }]) {
  it(`inherited ${Object.keys(metadata)[0]} metadata does not subtract an own field`, () => {
    const desc = Object.assign(Object.create(metadata), { next: { t: "long", v: 7 } });
    if (!desc.classID) desc.classID = "test";
    assertDescriptorFixture(desc, descriptorFixture(desc.__name ?? ""));
  });
}

it("nonenumerable class metadata does not subtract an own field", () => {
  const desc = { next: { t: "long", v: 7 } };
  Object.defineProperty(desc, "classID", { value: "test" });
  assertDescriptorFixture(desc);
});

it("nullable nested name metadata preserves the following list item boundary", () => {
  const node = { t: "VlLs", v: [
    { t: "Objc", v: { classID: "test", __name: null, next: { t: "long", v: 7 } } },
    { t: "bool", v: true },
  ] }, buf = buffer();
  const size = DescriptorCodec.writeValue(buf, 0, node);
  const fixture = [...ascii("VlLs"), ...u32(2), ...ascii("Objc"), ...descriptorFixture(), ...ascii("bool"), 1];
  assert.deepEqual([...buf.data.slice(0, size)], fixture);
  const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
  assert.equal(parsed.size, size);
  delete parsed.size;
  assert.deepEqual(parsed, { t: "VlLs", v: [
    { t: "Objc", v: { classID: "test", next: { t: "long", v: 7 } } }, { t: "bool", v: true },
  ] });
});
