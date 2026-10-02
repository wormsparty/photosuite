import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let Layer, Mask, PaintTool, Rect, restoreBrowserGlobals;
before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ Mask } = await import("../../../src/document/model/layer-masks.js"));
  ({ PaintTool } = await import("../../../src/document/tools/paint-tools.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  const { TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js");
  const { registerTrackers } = await import("../../../src/features/trackers/register-trackers.js");
  registerTrackers(TrackerRegistry);
});
after(() => restoreBrowserGlobals?.());

function fixture(kind, cached) {
  const mask = new Mask();
  mask.rect = new Rect(2, 3, 4, 2);
  mask.channel = new Uint8Array(8).fill(20);
  const unrelatedMask = new Mask();
  unrelatedMask.rect = mask.rect.clone();
  unrelatedMask.channel = new Uint8Array(8).fill(90);
  const layer = new Layer();
  layer.rect = mask.rect.clone();
  layer.buffer = new Uint8Array(32).fill(255);
  layer.pixelContent = kind === "smart-filter mask" ? 3 : 1;
  layer.d = kind === "smart-filter mask" ? unrelatedMask : mask;
  layer.getLinkedPlacedItem = () => ({ d: kind === "smart-filter mask" ? mask : unrelatedMask });
  const selection = { rect: new Rect(3, 4, 2, 1), channel: new Uint8Array([128, 255]) };
  const doc = {
    width: 8, height: 8, layers: [layer], selectedLayerIndices: [0],
    activeChannels: kind === "extra channel" ? [0] : [], extraChannels: [mask],
    selectionMask: selection, pathViewport: { channelVisibility: [1, 1, 1] },
    pushHistory(entry) { this.entry = entry; }, markDirty() { this.needsComposite = true; },
  };
  if (cached) layer.updatePixCache(doc, selection, true);
  return { mask, unrelatedMask, layer, selection, doc, tool: new PaintTool() };
}

describe("grayscale fill cache and history", () => {
  for (const kind of ["layer mask", "smart-filter mask"]) {
    for (const opacity of [0, 64, 128, 255]) {
      it(`recomposes an offset cached ${kind} once at opacity ${opacity} through Undo/Redo`, () => {
        const { mask, layer, doc, tool } = fixture(kind, true);
        const original = mask.channel.slice();
        assert.equal(layer.checkPixelCache(doc, doc.selectionMask), true);
        tool.fillRegionWithColor(doc, layer, doc.selectionMask, 220, 220, 220, opacity, "norm", "edit.fill");
        assert.equal(doc.entry.data.actionKind, "drawtemp", "uses actual cache recognition");
        const cachedValue = Math.floor(20 + 200 * opacity / 255);
        const expected = Array(8).fill(20);
        expected[5] = Math.floor(cachedValue * 128 / 255 + 20 * 127 / 255);
        expected[6] = cachedValue;
        assert.deepEqual(Array.from(mask.channel.slice(0, 8)), expected);
        assert.equal(layer.checkPixelCache(doc, doc.selectionMask), true);
        assert.equal(doc.stateChanged, true);
        assert.equal(doc.needsComposite, true);
        tool.undo(doc.entry.data, doc);
        assert.deepEqual(mask.channel, original);
        assert.equal(layer.checkPixelCache(doc, doc.selectionMask), true);
        tool.redo(doc.entry.data, doc);
        assert.deepEqual(Array.from(mask.channel.slice(0, 8)), expected);
      });
    }
    for (const focus of [0, 1, 3]) {
      it(`restores cached ${kind} history after switching focus to ${focus}`, () => {
        const { mask, unrelatedMask, layer, doc, tool } = fixture(kind, true);
        const original = mask.channel.slice();
        const unrelatedOriginal = unrelatedMask.channel.slice();
        tool.fillRegionWithColor(doc, layer, doc.selectionMask, 220, 220, 220, 128, "norm", "edit.fill");
        const filled = mask.channel.slice();
        layer.pixelContent = focus;
        layer.renderCache.dirtyRect = null;
        layer.renderCache.needsRebuild = false;
        tool.undo(doc.entry.data, doc);
        assert.deepEqual(mask.channel, original);
        assert.deepEqual(unrelatedMask.channel, unrelatedOriginal);
        assert.equal(layer.pixelContent, focus, "history preserves current UI focus");
        if (kind === "layer mask") assert.equal(layer.renderCache.needsRebuild, true);
        tool.redo(doc.entry.data, doc);
        assert.deepEqual(mask.channel, filled);
        assert.deepEqual(unrelatedMask.channel, unrelatedOriginal);
      });
    }
  }
  for (const kind of ["extra channel", "layer mask", "smart-filter mask"]) {
    for (const opacity of [64, 255]) {
      it(`restores an uncached offset ${kind} fill at opacity ${opacity}`, () => {
        const { mask, layer, doc, tool } = fixture(kind, false);
        const original = mask.channel.slice();
        tool.fillRegionWithColor(doc, layer, doc.selectionMask, 220, 220, 220, opacity, "norm", "edit.fill");
        assert.equal(Array.isArray(doc.entry.data), true);
        const expected = Array(8).fill(20);
        expected[5] = Math.floor(20 + 200 * Math.floor(opacity * 128 / 255) / 255);
        expected[6] = Math.floor(20 + 200 * opacity / 255);
        assert.deepEqual(Array.from(mask.channel.slice(0, 8)), expected);
        tool.undo(doc.entry.data, doc);
        assert.deepEqual(mask.channel.slice(0, 8), original);
        tool.redo(doc.entry.data, doc);
        assert.deepEqual(Array.from(mask.channel.slice(0, 8)), expected);
      });
    }
  }
  it("undoes an ordinary raster-mask cached fill after RGB focus without resolving a smart object", () => {
    const { mask, layer, doc, tool } = fixture("layer mask", true);
    layer.getLinkedPlacedItem = () => { throw new Error("ordinary raster layer has no placed item"); };
    const original = mask.channel.slice();
    tool.fillRegionWithColor(doc, layer, doc.selectionMask, 220, 220, 220, 128, "norm", "edit.fill");
    const filled = mask.channel.slice();
    layer.pixelContent = 0;
    tool.undo(doc.entry.data, doc);
    assert.deepEqual(mask.channel, original);
    tool.redo(doc.entry.data, doc);
    assert.deepEqual(mask.channel, filled);
  });
  for (const kind of ["layer mask", "smart-filter mask"]) {
    for (const focus of [0, kind === "layer mask" ? 3 : 1]) {
      it(`restores the ${kind} pixel-cache snapshot and invalidation after focus ${focus}`, () => {
        const { mask, unrelatedMask, layer, doc } = fixture(kind, true);
        const original = mask.channel.slice();
        const unrelatedOriginal = unrelatedMask.channel.slice();
        mask.channel = new Uint8Array(8).fill(220);
        layer.pixelContent = focus;
        layer.renderCache.dirtyRect = null;
        layer.renderCache.needsRebuild = false;
        mask.maskCombineDirty = false;
        const replacementCache = { marker: "replacement" };
        layer.restoreFromPixCache(doc, replacementCache);
        assert.deepEqual(mask.channel, original);
        assert.deepEqual(unrelatedMask.channel, unrelatedOriginal);
        assert.equal(layer.pixCache, replacementCache);
        assert.equal(layer.pixelContent, focus);
        assert.notEqual(layer.renderCache.dirtyRect, null);
        if (kind === "layer mask") assert.equal(layer.renderCache.needsRebuild, true);
      });
    }
  }
});
