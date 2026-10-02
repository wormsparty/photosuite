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
    ensureLayerEditableForTools() { return true; },
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
  for (const kind of ["extra channel", "layer mask", "smart-filter mask"]) {
    for (const cached of kind === "extra channel" ? [false] : [false, true]) {
      for (const opacity of [64, 128, 255]) {
        it(`preserves fractional selection endpoints for ${cached ? "cached" : "uncached"} ${kind} at ${opacity}`, () => {
          const { mask, layer, doc, tool } = fixture(kind, false);
          doc.selectionMask = { rect: mask.rect.clone(), channel: new Uint8Array([0, 1, 64, 127, 128, 192, 254, 255]) };
          if (cached) layer.updatePixCache(doc, doc.selectionMask, true);
          const original = mask.channel.slice();
          tool.fillRegionWithColor(doc, layer, doc.selectionMask, 220, 220, 220, opacity, "norm", "edit.fill");
          const cacheValue = Math.floor(20 + 200 * opacity / 255);
          const expected = Array.from(doc.selectionMask.channel, weight => cached
            ? Math.floor(cacheValue * weight / 255 + 20 * (1 - weight / 255))
            : Math.floor(20 + 200 * Math.floor(opacity * weight / 255) / 255));
          assert.deepEqual(Array.from(mask.channel), expected);
          const filled = mask.channel.slice();
          tool.undo(doc.entry.data, doc);
          assert.deepEqual(mask.channel, original);
          tool.redo(doc.entry.data, doc);
          assert.deepEqual(mask.channel, filled);
        });
      }
    }
  }
  for (const focus of [0, 1, 3]) {
    it(`prioritizes extra channel fill and history over a cached layer with focus ${focus}`, () => {
      const { mask, unrelatedMask, layer, doc, tool } = fixture("layer mask", true);
      doc.extraChannels = [mask, unrelatedMask];
      doc.activeChannels = [1, 0];
      const original = unrelatedMask.channel.slice();
      const layerOriginal = mask.channel.slice();
      const pixelsOriginal = layer.buffer.slice();
      const cacheOriginal = layer.pixCache;
      tool.fillRegionWithColor(doc, layer, doc.selectionMask, 220, 220, 220, 128, "norm", "edit.fill");
      assert.equal(doc.entry.data[0].layerIndex, -2);
      const filled = unrelatedMask.channel.slice();
      assert.notDeepEqual(filled, original);
      doc.activeChannels = [];
      layer.pixelContent = focus;
      tool.undo(doc.entry.data, doc);
      assert.deepEqual(unrelatedMask.channel, original);
      tool.redo(doc.entry.data, doc);
      assert.deepEqual(unrelatedMask.channel, filled);
      assert.deepEqual(mask.channel, layerOriginal);
      assert.deepEqual(layer.buffer, pixelsOriginal);
      assert.equal(layer.pixCache, cacheOriginal);
    });
  }

  for (const preserveTransparency of [false, true]) {
    for (const selected of [false, true]) {
      it(`dispatches Edit Fill on an extra channel with selection ${selected} and preserve transparency ${preserveTransparency}`, () => {
        const { mask, layer, doc, tool } = fixture("extra channel", false);
        if (!selected) doc.selectionMask = null;
        const artwork = layer.buffer.slice();
        const original = mask.channel.slice();
        const descriptor = {
          Usng: { v: { FlCn: "Blck" } },
          Opct: { v: { val: 100 } },
          PrsT: { v: preserveTransparency },
        };
        tool.handleInput({ actionKind: "fromAction", scriptActionPayload: { uf: "fill", actionDescriptor: descriptor } }, {}, doc, {}, {});
        assert.equal(doc.entry.data[0].layerIndex, -1);
        assert.deepEqual(Array.from(mask.getMaskForRect(new Rect(2, 3, 4, 2))), selected
          ? [20, 20, 20, 20, 20, 9, 0, 20]
          : Array(8).fill(0));
        const filled = mask.channel.slice();
        tool.undo(doc.entry.data, doc);
        // Unselected fills extend the channel to document bounds; compare its
        // original region through the production mask extraction method.
        assert.deepEqual(mask.getMaskForRect(new Rect(2, 3, 4, 2)), original);
        tool.redo(doc.entry.data, doc);
        assert.deepEqual(mask.channel, filled);
        assert.deepEqual(layer.buffer, artwork);
        assert.equal(layer.add.lspf, undefined);
      });
    }
  }

  it("dispatches Edit Fill to a smart-filter mask without touching artwork", () => {
    const { mask, layer, doc, tool } = fixture("smart-filter mask", false);
    const originalMask = mask.channel.slice();
    const originalArtwork = layer.buffer.slice();
    const descriptor = {
      Usng: { v: { FlCn: "Wht" } },
      Opct: { v: { val: 50 } },
      PrsT: { v: false },
      Md: { v: { blendMode: "Nrml" } },
    };
    tool.handleInput({ actionKind: "fromAction", scriptActionPayload: { uf: "fill", actionDescriptor: descriptor } }, {}, doc, {}, { colorInt: 0, bgColor: 0 });
    assert.deepEqual(Array.from(mask.channel), [20, 20, 20, 20, 20, 78, 137, 20]);
    assert.deepEqual(layer.buffer, originalArtwork);
    const filled = mask.channel.slice();
    tool.undo(doc.entry.data, doc);
    assert.deepEqual(mask.channel, originalMask);
    tool.redo(doc.entry.data, doc);
    assert.deepEqual(mask.channel, filled);
  });

  it("clears a smart-filter mask over its full surface without selection", () => {
    const { mask, layer, doc, tool } = fixture("smart-filter mask", false);
    doc.selectionMask = null;
    const originalArtwork = layer.buffer.slice();
    tool.handleInput({ actionKind: "fromAction", scriptActionPayload: { uf: "delete" } }, {}, doc, {}, { bgColor: 0 });
    assert.deepEqual(Array.from(mask.channel), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(layer.buffer, originalArtwork);
    tool.undo(doc.entry.data, doc);
    assert.deepEqual(Array.from(mask.channel), new Array(8).fill(20));
    tool.redo(doc.entry.data, doc);
    assert.deepEqual(Array.from(mask.channel), new Array(8).fill(0));
  });

});
