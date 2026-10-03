import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, loadChannelAsSelectionMask, Layer, PaintTool, Rect, TrackerRegistry, ChannelsPanel, installPluginToolOverlays, restore;
before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ loadChannelAsSelectionMask } = await import("../../../src/document/tools/selection-actions.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ PaintTool } = await import("../../../src/document/tools/paint-tools.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  ({ ChannelsPanel } = await import("../../../src/ui/panels/channels-panel.js"));
  ({ installPluginToolOverlays } = await import("../../../src/ui/panels/plugin-tool-overlays.js"));
  const { registerTrackers } = await import("../../../src/features/trackers/register-trackers.js");
  registerTrackers(TrackerRegistry);
});

it("duplicates a selected imported saved channel without changing the selection or source", () => {
  const bytes = fixture();
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  doc.activeChannels = [1];
  doc.selectedLayerIndices = [];
  doc.pathViewport = { channelVisibility: [1, 1, 1] };
  doc.getQuickMask = () => null;
  doc.markDirty = () => {};
  doc.pushHistory = entry => { doc.historyEntry = entry; };
  const selection = doc.selectionMask.channel.slice();
  const first = doc.extraChannels[0].channel.slice();
  const source = doc.extraChannels[1];
  source.displayOpacity = 63;
  source.density = 192;
  const tracker = new TrackerRegistry.LayerEffectsTracker();
  tracker.handleInput({
    actionKind: Layer.extraChannelOp,
    operation: "fromAction",
    recordedActionPayload: {
      uf: "duplicate",
      actionDescriptor: { null: { v: [{ v: { keyID: "Chnl" } }] } },
    },
  }, {}, doc, { isPressed: () => false }, {});
  assert.equal(doc.extraChannels.length, 3);
  assert.equal(doc.extraChannels[2].name, "Alpha 3");
  assert.notEqual(doc.extraChannels[2], source);
  assert.notEqual(doc.extraChannels[2].channel, source.channel);
  assert.deepEqual(doc.extraChannels[2].channel, source.channel);
  assert.equal(doc.extraChannels[2].displayOpacity, 63);
  assert.equal(doc.extraChannels[2].density, 192);
  assert.deepEqual(doc.extraChannels[0].channel, first);
  assert.deepEqual(doc.selectionMask.channel, selection);
  tracker.undo(doc.historyEntry.data, doc);
  assert.equal(doc.extraChannels.length, 2);
  assert.deepEqual(doc.selectionMask.channel, selection);
  tracker.redo(doc.historyEntry.data, doc);
  assert.equal(doc.extraChannels.length, 3);
  assert.deepEqual(doc.extraChannels[2].channel, source.channel);
  assert.deepEqual(doc.selectionMask.channel, selection);
});

it("deletes only the selected imported saved channel and restores it through history", () => {
  const bytes = fixture();
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  const layer = new Layer();
  layer.rect = new Rect(0, 0, 2, 1);
  layer.buffer = Uint8Array.from([30, 40, 50, 255, 60, 70, 80, 255]);
  doc.layers = [layer];
  doc.selectedLayerIndices = [0];
  doc.activeChannels = [1];
  doc.pathViewport = { channelVisibility: [1, 1, 1] };
  doc.markDirty = () => {};
  doc.pushHistory = entry => { doc.historyEntry = entry; };
  const first = doc.extraChannels[0];
  const second = doc.extraChannels[1];
  const selection = doc.selectionMask.channel.slice();
  const artwork = layer.buffer.slice();
  const tracker = new TrackerRegistry.LayerEffectsTracker();

  tracker.handleInput({
    actionKind: Layer.extraChannelOp,
    operation: "fromAction",
    recordedActionPayload: { uf: "delete", actionDescriptor: {} },
  }, {}, doc, { isPressed: () => false }, {});
  assert.deepEqual(doc.extraChannels, [first]);
  assert.deepEqual(doc.activeChannels, []);
  assert.deepEqual(doc.historyEntry.data.activeChannelsBefore, [1]);
  assert.deepEqual(doc.selectionMask.channel, selection);
  assert.deepEqual(layer.buffer, artwork);

  tracker.undo(doc.historyEntry.data, doc);
  assert.deepEqual(doc.extraChannels, [first, second]);
  assert.deepEqual(doc.activeChannels, [1]);
  assert.deepEqual(Array.from(doc.extraChannels[1].channel.subarray(0, 2)), [37, 211]);
  tracker.redo(doc.historyEntry.data, doc);
  assert.deepEqual(doc.extraChannels, [first]);
  assert.deepEqual(doc.activeChannels, []);
  assert.deepEqual(doc.selectionMask.channel, selection);
  assert.deepEqual(layer.buffer, artwork);
});
after(() => restore?.());

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const prop = (type, payload = Buffer.alloc(0)) => Buffer.concat([u32(type), u32(payload.length), payload]);
const name = value => { const bytes = Buffer.from(value + "\0"); return Buffer.concat([u32(bytes.length), bytes]); };

// Three tiny v003 channels: two distinct saved channels and the active selection.
// Compression 1 uses a two-pixel literal run, so both pixel positions matter.
function fixture(visibility = null) {
  const header = Buffer.concat([
    Buffer.from("gimp xcf v003\0"), u32(2), u32(1), u32(0), prop(17, Buffer.from([1])), prop(0),
  ]);
  const entries = [
    { title: "Saved alpha", values: [89, 193], selection: false },
    { title: "Saved detail", values: [37, 211], selection: false },
    { title: "Selection", values: [255, 0], selection: true },
  ];
  let offset = header.length + 5 * 4;
  const pointers = [];
  const objects = [];
  for (const [index, entry] of entries.entries()) {
    const visible = visibility?.[index];
    const channel = Buffer.concat([
      u32(2), u32(1), name(entry.title),
      ...(entry.selection ? [prop(4)] : []),
      ...(visible == null ? [] : [prop(8, u32(visible))]),
      prop(0),
    ]);
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

it("imports saved XCF channel visibility for both shown and hidden channels", () => {
  const bytes = fixture([1, 0]);
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  assert.deepEqual(doc.extraChannels.map(channel => channel.active), [true, false]);
  assert.deepEqual(Array.from(doc.extraChannels[0].channel.subarray(0, 2)), [89, 193]);
  assert.deepEqual(Array.from(doc.extraChannels[1].channel.subarray(0, 2)), [37, 211]);
});

it("shows only visible imported saved channels and updates overlays after eye clicks", () => {
  const bytes = fixture([1, 0]);
  const doc = { layers: [], extraChannels: [], activeChannels: [], selectedLayerIndices: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  doc.pathViewport = { channelVisibility: [1, 1, 1] };

  class OverlayPanel {}
  installPluginToolOverlays(OverlayPanel);
  const overlay = new OverlayPanel();
  const drawn = [];
  overlay.drawChannelMaskOverlay = (channel, view, mode) => drawn.push([channel.name, mode]);
  overlay.drawGuideAndOverlayGraphics = () => false;
  overlay.mainCanvasCtx = {};
  overlay.appData = { extras: false };
  const channels = new ChannelsPanel();
  channels.activeDoc = doc;

  assert.equal(overlay.drawActiveMaskOverlays(doc), true);
  assert.deepEqual(drawn, [["Saved alpha", 1]]);
  channels.onLayerClick({ data: { idx: -5, isVisibilityEyeClick: true } });
  channels.onLayerClick({ data: { idx: -6, isVisibilityEyeClick: true } });
  drawn.length = 0;
  assert.equal(overlay.drawActiveMaskOverlays(doc), true);
  assert.deepEqual(drawn, [["Saved detail", 1]]);
  doc.pathViewport.channelVisibility = [0, 0, 0];
  drawn.length = 0;
  assert.equal(overlay.drawActiveMaskOverlays(doc), true);
  assert.deepEqual(drawn, [["Saved detail", 2]]);
  assert.deepEqual(doc.activeChannels, []);
  assert.equal(doc.dirty, true);
  assert.equal(doc.panelsDirty, true);
});

it("imports two distinct named XCF saved channels separately from selection and loads each pixel plane", () => {
  const bytes = fixture();
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  assert.deepEqual(Array.from(doc.selectionMask.channel.subarray(0, 2)), [255, 0]);
  assert.equal(doc.extraChannels.length, 2);
  assert.deepEqual(doc.extraChannels.map(channel => channel.name), ["Saved alpha", "Saved detail"]);
  assert.deepEqual(Array.from(doc.extraChannels[0].channel.subarray(0, 2)), [89, 193]);
  assert.deepEqual(Array.from(doc.extraChannels[1].channel.subarray(0, 2)), [37, 211]);
  for (const [index, expected] of [[-5, [89, 193]], [-6, [37, 211]]]) {
    const loaded = loadChannelAsSelectionMask(doc, index);
    assert.deepEqual([loaded.rect.x, loaded.rect.y, loaded.rect.width, loaded.rect.height], [0, 0, 2, 1]);
    assert.deepEqual(Array.from(loaded.channel.subarray(0, 2)), expected);
  }
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

it("edits only the second imported saved channel and restores it through Undo/Redo", () => {
  const bytes = fixture();
  const doc = { layers: [], extraChannels: [], activeChannels: [] };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  const layer = new Layer();
  layer.rect = new Rect(0, 0, 2, 1);
  layer.buffer = Uint8Array.from([30, 40, 50, 255, 60, 70, 80, 255]);
  doc.layers = [layer];
  doc.selectedLayerIndices = [0];
  doc.activeChannels = [1];
  doc.pathViewport = { channelVisibility: [1, 1, 1] };
  doc.pushHistory = entry => { doc.historyEntry = entry; };
  doc.markDirty = () => {};
  const artwork = layer.buffer.slice();
  const firstChannel = doc.extraChannels[0].channel.slice();
  const selection = doc.selectionMask.channel.slice();
  const tool = new PaintTool();
  tool.handleInput({ actionKind: "fromAction", scriptActionPayload: {
    uf: "fill", actionDescriptor: { Usng: { v: { FlCn: "Blck" } }, Opct: { v: { val: 100 } } },
  } }, null, doc, null, {});
  const secondChannel = doc.extraChannels[1].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2);
  assert.deepEqual(Array.from(secondChannel), [0, 211]);
  assert.equal(doc.historyEntry.data[0].layerIndex, -2);
  assert.deepEqual(doc.extraChannels[0].channel, firstChannel);
  assert.deepEqual(doc.selectionMask.channel, selection);
  assert.deepEqual(layer.buffer, artwork);
  doc.activeChannels = [];
  tool.undo(doc.historyEntry.data, doc);
  assert.deepEqual(Array.from(doc.extraChannels[1].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2)), [37, 211]);
  tool.redo(doc.historyEntry.data, doc);
  assert.deepEqual(doc.extraChannels[1].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2), secondChannel);
  assert.deepEqual(doc.extraChannels[0].channel, firstChannel);
  assert.deepEqual(doc.selectionMask.channel, selection);
  assert.deepEqual(layer.buffer, artwork);
});

it("fills then clears one imported saved channel without changing its neighbors", () => {
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
  const history = [];
  doc.pushHistory = entry => history.push(entry);
  doc.markDirty = () => {};
  const otherChannel = doc.extraChannels[1].channel.slice();
  const selection = doc.selectionMask.channel.slice();
  const artwork = layer.buffer.slice();
  const pixels = () => Array.from(doc.extraChannels[0].getMaskForRect(new Rect(0, 0, 2, 1)).subarray(0, 2));
  const tool = new PaintTool();

  tool.handleInput({ actionKind: "fromAction", scriptActionPayload: {
    uf: "fill", actionDescriptor: { Usng: { v: { FlCn: "Blck" } }, Opct: { v: { val: 100 } } },
  } }, null, doc, null, {});
  assert.deepEqual(pixels(), [0, 193]);
  tool.handleInput({ actionKind: "fromAction", scriptActionPayload: { uf: "delete" } },
    null, doc, null, { bgColor: 0xffffff });
  assert.deepEqual(pixels(), [255, 193]);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(entry => entry.data[0].layerIndex), [-1, -1]);
  assert.deepEqual(doc.extraChannels[1].channel, otherChannel);
  assert.deepEqual(doc.selectionMask.channel, selection);
  assert.deepEqual(layer.buffer, artwork);

  doc.activeChannels = [];
  tool.undo(history[1].data, doc);
  assert.deepEqual(pixels(), [0, 193]);
  tool.undo(history[0].data, doc);
  assert.deepEqual(pixels(), [89, 193]);
  tool.redo(history[0].data, doc);
  assert.deepEqual(pixels(), [0, 193]);
  tool.redo(history[1].data, doc);
  assert.deepEqual(pixels(), [255, 193]);
  assert.deepEqual(doc.extraChannels[1].channel, otherChannel);
  assert.deepEqual(doc.selectionMask.channel, selection);
  assert.deepEqual(layer.buffer, artwork);
});
