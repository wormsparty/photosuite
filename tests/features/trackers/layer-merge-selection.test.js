import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let Document;
let Layer;
let LayerSectionType;
let Rect;
let TrackerRegistry;

before(async () => {
  await import("../../../src/features/trackers/layer-effects-stack-actions.js");
  await import("../../../src/features/trackers/layer-effects-history.js");
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import("../../../src/features/trackers/register-trackers.js");
  registerTrackers(TrackerRegistry);
  ({ Document } = await import("../../../src/document/model/document.js"));
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

function makeDocument() {
  const doc = new Document("merge.psd");
  doc.width = 2;
  doc.height = 1;
  const layers = ["bottom", "middle", "top"].map((name, index) => {
    const layer = doc.newLayer();
    layer.setName(name);
    layer.rect = new Rect(index === 0 ? 0 : 1, 0, 1, 1);
    layer.buffer = new Uint8Array([index * 40 + 10, 0, 0, 255]);
    return layer;
  });
  doc.setLayers(layers);
  doc.selectedLayerIndices = [0, 2];
  return { doc, layers };
}

function merge(doc, kind, alt = false) {
  const tracker = new TrackerRegistry.LayerEffectsTracker();
  tracker.handleInput(
    { actionKind: kind }, {}, doc, { isPressed() { return alt; } }, {},
  );
  return tracker;
}

describe("selected layer merge actions", () => {
  it("rasterizes a selected pass-through group with overlapping children and restores the stack on undo", () => {
    const doc = new Document("group-merge.psd");
    doc.width = 2;
    doc.height = 1;
    const bottom = doc.newLayer();
    bottom.setName("Bottom");
    bottom.rect = new Rect(0, 0, 2, 1);
    bottom.buffer = new Uint8Array([10, 0, 0, 255, 10, 0, 0, 255]);
    const end = doc.createGroupEndLayer();
    const red = doc.newLayer();
    red.setName("Red child");
    red.rect = new Rect(0, 0, 1, 1);
    red.buffer = new Uint8Array([80, 0, 0, 255]);
    const blue = doc.newLayer();
    blue.setName("Blue child");
    blue.rect = new Rect(0, 0, 1, 1);
    blue.buffer = new Uint8Array([0, 0, 120, 255]);
    const group = doc.newLayer();
    group.setName("Group");
    group.add.lsct = LayerSectionType.OpenGroup;
    group.blendMode = "pass";
    group.layerFlags = 24;
    doc.setLayers([bottom, end, red, blue, group]);
    doc.selectedLayerIndices = [4];
    doc.markDirty();
    const before = doc.getRasterData().slice();
    assert.deepEqual([...before], [0, 0, 120, 255, 10, 0, 0, 255]);

    const tracker = merge(doc, Layer.mergeCopy);
    assert.equal(doc.layers.length, 2);
    assert.equal(doc.layers[0], bottom);
    assert.deepEqual(doc.selectedLayerIndices, [1]);
    assert.deepEqual(doc.getRasterData(), before);
    const snapshot = doc.getLastHistoryEntry().data;
    tracker.undo(snapshot, doc);
    assert.deepEqual(doc.layers, [bottom, end, red, blue, group]);
    assert.deepEqual(doc.selectedLayerIndices, [4]);
    assert.deepEqual(doc.getRasterData(), before);
    tracker.redo(snapshot, doc);
    assert.equal(doc.layers.length, 2);
    assert.deepEqual(doc.getRasterData(), before);
  });

  it("merge copy keeps the selected sources, inserts their raster result above them, and supports undo/redo", () => {
    const { doc, layers } = makeDocument();
    const rasterCalls = [];
    doc.getRasterData = (indices) => {
      rasterCalls.push(indices.slice());
      return new Uint8Array([10, 0, 0, 255, 90, 0, 0, 255]);
    };
    const tracker = merge(doc, Layer.mergeCopy, true);
    assert.deepEqual(rasterCalls, [[0, 2]]);
    assert.deepEqual(doc.layers.slice(0, 3), layers);
    assert.equal(doc.layers.length, 4);
    assert.equal(doc.layers[3].getName(), "top");
    assert.deepEqual([...doc.layers[3].buffer], [10, 0, 0, 255, 90, 0, 0, 255]);
    assert.deepEqual(doc.selectedLayerIndices, [3]);
    const snapshot = doc.getLastHistoryEntry().data;
    tracker.undo(snapshot, doc);
    assert.deepEqual(doc.layers, layers);
    assert.deepEqual(doc.selectedLayerIndices, [0, 2]);
    tracker.redo(snapshot, doc);
    assert.equal(doc.layers.length, 4);
    assert.deepEqual(doc.selectedLayerIndices, [3]);
  });

  it("merge copy removes only selected layers, preserving an intervening locked layer", () => {
    const { doc, layers } = makeDocument();
    layers[1].add.lspf = 1 << 31;
    doc.markDirty();
    const compositeBefore = doc.getRasterData().slice();
    assert.deepEqual([...compositeBefore], [10, 0, 0, 255, 90, 0, 0, 255]);
    const tracker = merge(doc, Layer.mergeCopy);
    assert.equal(doc.layers.length, 2);
    assert.equal(doc.layers[0], layers[1]);
    assert.equal(doc.layers[0].add.lspf, 1 << 31);
    assert.deepEqual(doc.selectedLayerIndices, [1]);
    assert.deepEqual(doc.getRasterData(), compositeBefore);
    tracker.undo(doc.getLastHistoryEntry().data, doc);
    assert.deepEqual(doc.layers, layers);
    assert.equal(doc.layers[1].add.lspf, 1 << 31);
  });

  it("merge down replaces a locked lower layer and restores both layers on undo", () => {
    const { doc, layers } = makeDocument();
    layers[1].add.lspf = 1 << 31;
    doc.selectedLayerIndices = [2];
    const rasterCalls = [];
    doc.getRasterData = (indices) => {
      rasterCalls.push(indices.slice());
      return new Uint8Array([0, 0, 0, 0, 90, 0, 0, 255]);
    };
    const tracker = merge(doc, Layer.mergeDown);
    assert.deepEqual(rasterCalls, [[1, 2]]);
    assert.equal(doc.layers.length, 2);
    assert.equal(doc.layers[0], layers[0]);
    assert.deepEqual([...doc.layers[1].buffer], [90, 0, 0, 255]);
    assert.deepEqual(doc.selectedLayerIndices, [1]);
    const snapshot = doc.getLastHistoryEntry().data;
    tracker.undo(snapshot, doc);
    assert.deepEqual(doc.layers, layers);
    assert.deepEqual(doc.selectedLayerIndices, [2]);
    tracker.redo(snapshot, doc);
    assert.equal(doc.layers.length, 2);
    assert.deepEqual(doc.selectedLayerIndices, [1]);
  });

  it("merge visible includes visible layers even when the former selection is locked", () => {
    const { doc, layers } = makeDocument();
    layers[0].add.lspf = 1 << 31;
    layers[1].setVisible(false);
    doc.selectedLayerIndices = [0];
    const rasterCalls = [];
    doc.getRasterData = (indices) => {
      rasterCalls.push(indices.slice());
      return new Uint8Array([10, 0, 0, 255, 90, 0, 0, 255]);
    };
    const tracker = merge(doc, Layer.mergeLayers);
    assert.deepEqual(rasterCalls, [[0, 2]]);
    assert.equal(doc.layers[0], layers[1]);
    assert.equal(doc.layers.length, 2);
    tracker.undo(doc.getLastHistoryEntry().data, doc);
    assert.deepEqual(doc.layers, layers);
    assert.deepEqual(doc.selectedLayerIndices, [0]);
  });
});
