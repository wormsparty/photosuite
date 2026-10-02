import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, loadChannelAsSelectionMask, Layer, PaintTool, Rect, restore;
before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ loadChannelAsSelectionMask } = await import("../../../src/document/tools/selection-actions.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ PaintTool } = await import("../../../src/document/tools/paint-tools.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  const { TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js");
  const { registerTrackers } = await import("../../../src/features/trackers/register-trackers.js");
  registerTrackers(TrackerRegistry);
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

it("edits an imported saved channel under the imported selection with Undo/Redo", () => {
  const bytes = fixture();
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  const layer = new Layer();
  layer.rect = new Rect(0, 0, 2, 1);
  layer.buffer = Uint8Array.from([30, 40, 50, 255, 60, 70, 80, 255]);
  doc.layers = [layer];
  doc.selectedLayerIndices = [0];
  doc.activeChannels = [0];
  doc.pathViewport = { channelVisibility: [1, 1, 1] };
  doc.pushHistory = entry => { doc.historyEntry = entry; };
  doc.markDirty = () => {};
  const artwork = layer.buffer.slice();
  const tool = new PaintTool();
  tool.handleInput({ actionKind: "fromAction", scriptActionPayload: {
    uf: "fill", actionDescriptor: { Usng: { v: { FlCn: "Blck" } }, Opct: { v: { val: 100 } } },
  } }, null, doc, null, {});
  assert.deepEqual(Array.from(doc.extraChannels[0].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2)), [0, 193]);
  assert.deepEqual(Array.from(doc.selectionMask.channel.subarray(0, 2)), [255, 0]);
  assert.deepEqual(layer.buffer, artwork);
  const filled = doc.extraChannels[0].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2);
  assert.equal(doc.historyEntry.data[0].layerIndex, -1);
  doc.activeChannels = [];
  tool.undo(doc.historyEntry.data, doc);
  assert.deepEqual(Array.from(doc.extraChannels[0].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2)), [89, 193]);
  tool.redo(doc.historyEntry.data, doc);
  assert.deepEqual(doc.extraChannels[0].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2), filled);
  assert.deepEqual(layer.buffer, artwork);
});
