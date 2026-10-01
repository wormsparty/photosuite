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
  data: new Uint8Array(4096),
  ensureCapacity(pos, size) { assert.ok(pos + size <= this.data.length, "bounded export fixture"); },
});
const nested = (type, count) => {
  let node = { t: "long", v: 7 };
  for (let i = 0; i < count; i++) node = type === "Objc"
    ? { t: type, v: { classID: "test", next: node } } : { t: type, v: [node] };
  return node;
};

for (const type of ["VlLs", "obj ", "Objc"]) {
  it(`${type} exports the supported 64-level boundary and reimports it`, () => {
    const node = nested(type, 64), buf = buffer();
    const size = DescriptorCodec.writeValue(buf, 0, node);
    const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
    assert.equal(parsed.size, size);
    delete parsed.size;
    assert.deepEqual(parsed, node);
  });
  it(`${type} rejects a bounded 65-level model rather than exporting unreadable bytes`, () => {
    assert.throws(() => DescriptorCodec.writeValue(buffer(), 0, nested(type, 65)), /nesting limit/);
  });
}

it("top-level descriptor fields use the same depth boundary as imported fields", () => {
  const desc = { classID: "test", next: nested("VlLs", 64) }, buf = buffer();
  const size = DescriptorCodec.writeDescriptor(buf, desc, 0), parsed = {};
  assert.equal(DescriptorCodec.parseDescriptor(buf.data.slice(0, size), parsed, 0), size);
  assert.deepEqual(parsed, desc);
  desc.next = nested("VlLs", 65);
  assert.throws(() => DescriptorCodec.writeDescriptor(buffer(), desc, 0), /nesting limit/);
});

it("mixed object and list nesting uses one shared depth budget", () => {
  let node = { t: "long", v: 7 };
  for (let i = 0; i < 64; i++) node = i % 2
    ? { t: "Objc", v: { classID: "test", next: node } } : { t: "obj ", v: [node] };
  const buf = buffer(), size = DescriptorCodec.writeValue(buf, 0, node);
  const parsed = DescriptorCodec.readValue(buf.data.slice(0, size), 0);
  assert.equal(parsed.size, size);
  delete parsed.size;
  assert.deepEqual(parsed, node);
  assert.throws(() => DescriptorCodec.writeValue(buffer(), 0, { t: "VlLs", v: [node] }), /nesting limit/);
});

// Historical cycles are unsafe and must only run after the writer is bounded.
it("after-only: cyclic lists reject and a fresh export remains usable", () => {
  const node = { t: "VlLs", v: [] };
  node.v.push(node);
  assert.throws(() => DescriptorCodec.writeValue(buffer(), 0, node), /nesting limit/);
  const buf = buffer();
  assert.equal(DescriptorCodec.writeValue(buf, 0, { t: "long", v: 7 }), 8);
  assert.deepEqual([...buf.data.slice(0, 8)], [108, 111, 110, 103, 0, 0, 0, 7]);
});

it("after-only: cyclic descriptor payloads reject within the nesting boundary", () => {
  const desc = { classID: "test" };
  desc.next = { t: "Objc", v: desc };
  assert.throws(() => DescriptorCodec.writeDescriptor(buffer(), desc, 0), /nesting limit/);
});
