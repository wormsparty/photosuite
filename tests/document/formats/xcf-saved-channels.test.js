import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, loadChannelAsSelectionMask, restore;
before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ loadChannelAsSelectionMask } = await import("../../../src/document/tools/selection-actions.js"));
});
after(() => restore?.());

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const prop = (type, payload = Buffer.alloc(0)) => Buffer.concat([u32(type), u32(payload.length), payload]);
const name = value => { const bytes = Buffer.from(value + "\0"); return Buffer.concat([u32(bytes.length), bytes]); };

// Two tiny v003 channels: a named saved channel and the active selection.
// Compression 1 uses a two-pixel literal run, so both pixel positions matter.
function fixture() {
  const header = Buffer.concat([
    Buffer.from("gimp xcf v003\0"), u32(2), u32(1), u32(0), prop(17, Buffer.from([1])), prop(0),
  ]);
  const entries = [
    { title: "Saved alpha", values: [89, 193], selection: false },
    { title: "Selection", values: [255, 0], selection: true },
  ];
  let offset = header.length + 4 * 4;
  const pointers = [];
  const objects = [];
  for (const entry of entries) {
    const channel = Buffer.concat([u32(2), u32(1), name(entry.title), ...(entry.selection ? [prop(4)] : []), prop(0)]);
    const hierarchy = offset + channel.length + 4;
    const level = hierarchy + 16;
    const tile = level + 16;
    const object = Buffer.concat([
      channel, u32(hierarchy), u32(2), u32(1), u32(1), u32(level),
      u32(2), u32(1), u32(tile), u32(0), Buffer.from([254, ...entry.values]),
    ]);
    pointers.push(u32(offset));
    objects.push(object);
    offset += object.length;
  }
  return Buffer.concat([header, u32(0), ...pointers, u32(0), ...objects]);
}

it("imports a named XCF saved channel separately from selection and loads its pixels", () => {
  const bytes = fixture();
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  assert.deepEqual(Array.from(doc.selectionMask.channel.subarray(0, 2)), [255, 0]);
  assert.equal(doc.extraChannels.length, 1);
  assert.equal(doc.extraChannels[0].name, "Saved alpha");
  assert.deepEqual(Array.from(doc.extraChannels[0].channel.subarray(0, 2)), [89, 193]);
  const loaded = loadChannelAsSelectionMask(doc, -5);
  assert.deepEqual([loaded.rect.x, loaded.rect.y, loaded.rect.width, loaded.rect.height], [0, 0, 2, 1]);
  assert.deepEqual(Array.from(loaded.channel.subarray(0, 2)), [89, 193]);
});
