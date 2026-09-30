/**
 * Golden + post-register behavior for LayerEffectsTracker action/history tables.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TrackerRegistry;
let Layer;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});

function makeLayer(overrides = {}) {
  const layer = {
    name: "Layer 1",
    blendMode: "norm",
    Opct: 255,
    add: { iOpa: 255, lspf: 0, lsct: 0, lnsr: undefined, lclr: 0 },
    pixelContent: 0,
    pathLayerActive: false,
    renderCache: { dirty: false },
    isGroup() {
      return false;
    },
    getName() {
      return this.name;
    },
    setName(name) {
      this.name = name;
    },
    isVisible() {
      return this._visible !== false;
    },
    setVisible(visible) {
      this._visible = visible;
    },
    markDirty() {},
    invalidate() {},
    ...overrides,
  };
  return layer;
}

function makeDoc(layers, extra = {}) {
  const doc = {
    layers,
    selectedLayerIndices: extra.selectedLayerIndices || [0],
    history: [],
    historyIndex: -1,
    stateChanged: false,
    panelsDirty: false,
    dirty: false,
    pathViewport: { channelVisibility: [1, 1, 1] },
    selectedWorkPaths: [],
    selectedLayerPaths: null,
    markDirty() {
      this.dirty = true;
    },
    getLastHistoryEntry() {
      return this.history.length ? this.history[this.history.length - 1] : null;
    },
    pushHistory(entry) {
      this.history.push(entry);
      this.historyIndex = this.history.length - 1;
    },
    setLayers(nextLayers) {
      this.layers = nextLayers;
    },
    resolveLayerSelection() {
      return this.selectedLayerIndices.slice();
    },
    expandParentGroups() {},
    ...extra,
  };
  return doc;
}

function idleKeyboard() {
  return { isPressed() { return false; } };
}

describe("features/trackers/layer-effects-actions.js", () => {
  it("opacity byte 128 serializes to 50 percent on the action descriptor", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const layer = makeLayer({ Opct: 200 });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.setLayerOpacity, layerPropertyValue: 128 },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.Opct, 128);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].data.opacityActionDescriptor.T.v.Opct.v.val, 50);
    assert.equal(doc.history[0].data.layerPropertyValue, 128);
  });

  it("opacity changes apply to every selected layer and a slider drag has one undo step", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const first = makeLayer({ Opct: 255 });
    const unselected = makeLayer({ Opct: 77 });
    const last = makeLayer({ Opct: 192 });
    const doc = makeDoc([first, unselected, last], { selectedLayerIndices: [0, 2] });
    for (const opacity of [160, 64]) {
      tracker.handleInput(
        { actionKind: Layer.setLayerOpacity, layerPropertyValue: opacity },
        {}, doc, idleKeyboard(), {},
      );
    }
    assert.deepEqual(doc.layers.map((layer) => layer.Opct), [64, 77, 64]);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].data.opacityActionDescriptor.T.v.Opct.v.val, 25);
    tracker.undo(doc.history[0].data, doc);
    assert.deepEqual(doc.layers.map((layer) => layer.Opct), [255, 77, 192]);
    tracker.redo(doc.history[0].data, doc);
    assert.deepEqual(doc.layers.map((layer) => layer.Opct), [64, 77, 64]);
  });

  it("setFillOpacity redo/undo swaps iOpa after registry attach", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const layer = makeLayer({ add: { iOpa: 255, lspf: 0, lsct: 0 } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.setFillOpacity, layerPropertyValue: 64 },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.add.iOpa, 64);
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.add.iOpa, 255);
    tracker.redo(doc.history[0].data, doc);
    assert.equal(layer.add.iOpa, 64);
  });

  it("toggleLayerLocks applies bit masks from toggle rows", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const layer = makeLayer({ add: { iOpa: 255, lspf: 0, lsct: 0 } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      {
        actionKind: Layer.toggleLayerLocks,
        layerPropertyValue: [[true, false], [0, 1]],
      },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.add.lspf, 1);
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.add.lspf, 0);
  });

  it("toggleLayerLocks preserves unrelated bits across a multi-layer undo and redo", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const first = makeLayer({ add: { lspf: 1 << 4, lsct: 0 } });
    const second = makeLayer({ add: { lspf: (1 << 4) | (1 << 2), lsct: 0 } });
    const doc = makeDoc([first, second], { selectedLayerIndices: [0, 1] });
    tracker.handleInput(
      { actionKind: Layer.toggleLayerLocks, layerPropertyValue: [[true, false], [2, 1]] },
      {}, doc, idleKeyboard(), {},
    );
    assert.deepEqual([first.add.lspf, second.add.lspf], [20, 20]);
    tracker.undo(doc.history[0].data, doc);
    assert.deepEqual([first.add.lspf, second.add.lspf], [16, 20]);
    tracker.redo(doc.history[0].data, doc);
    assert.deepEqual([first.add.lspf, second.add.lspf], [20, 20]);
  });

  it("all four lock controls set their own bits and Undo restores prior flags", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const layer = makeLayer({ add: { lspf: 1 << 5, lsct: 0 } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      {
        actionKind: Layer.toggleLayerLocks,
        layerPropertyValue: [[true, true, true, true], [0, 1, 2, 31]],
      },
      {}, doc, idleKeyboard(), {},
    );
    assert.equal(layer.add.lspf, (1 << 5) | 7 | (1 << 31));
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.add.lspf, 1 << 5);
    tracker.redo(doc.history[0].data, doc);
    assert.equal(layer.add.lspf, (1 << 5) | 7 | (1 << 31));
  });

  it("combined lock changes preserve each selected layer's other flags through undo and redo", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const pixel = makeLayer({ add: { lspf: (1 << 0) | (1 << 4), lsct: 0 } });
    const group = makeLayer({
      add: { lspf: (1 << 1) | (1 << 31), lsct: 1 },
      isGroup: () => true,
    });
    const untouched = makeLayer({ add: { lspf: 1 << 2, lsct: 0 } });
    const doc = makeDoc([pixel, untouched, group], { selectedLayerIndices: [0, 2] });
    tracker.handleInput(
      {
        actionKind: Layer.toggleLayerLocks,
        layerPropertyValue: [[false, true, true, false], [0, 1, 2, 31]],
      },
      {}, doc, idleKeyboard(), {},
    );
    assert.deepEqual(doc.layers.map((layer) => layer.add.lspf), [22, 4, 6]);
    const snapshot = doc.getLastHistoryEntry().data;
    tracker.undo(snapshot, doc);
    assert.deepEqual(doc.layers.map((layer) => layer.add.lspf), [17, 4, (1 << 1) | (1 << 31)]);
    tracker.redo(snapshot, doc);
    assert.deepEqual(doc.layers.map((layer) => layer.add.lspf), [22, 4, 6]);
  });

  it("an explicit lock target leaves the selected layer alone", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const selected = makeLayer({ add: { lspf: 0, lsct: 0 } });
    const target = makeLayer({ add: { lspf: 2, lsct: 0 } });
    const doc = makeDoc([selected, target]);
    tracker.handleInput(
      {
        actionKind: Layer.toggleLayerLocks,
        layerIndex: 1,
        layerPropertyValue: [[true, false], [2, 1]],
      },
      {}, doc, idleKeyboard(), {},
    );
    assert.deepEqual([selected.add.lspf, target.add.lspf], [0, 4]);
    tracker.undo(doc.history[0].data, doc);
    assert.deepEqual([selected.add.lspf, target.add.lspf], [0, 2]);
    tracker.redo(doc.history[0].data, doc);
    assert.deepEqual([selected.add.lspf, target.add.lspf], [0, 4]);
  });

  it("renameLayer history tuple is [index, oldName, newName, lnsr, null]", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const layer = makeLayer({ name: "Old", add: { iOpa: 255, lspf: 0, lsct: 0, lnsr: "lrsn" } });
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.renameLayer, name: "New" },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.name, "New");
    assert.deepEqual(doc.history[0].data.renameEntries, [[0, "Old", "New", "lrsn", null]]);
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.name, "Old");
    assert.equal(layer.add.lnsr, "lrsn");
  });

  it("setBlendMode writes psdCodes[index] onto the layer", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const layer = makeLayer();
    const doc = makeDoc([layer]);
    tracker.handleInput(
      { actionKind: Layer.setBlendMode, layerPropertyValue: 0 },
      {},
      doc,
      idleKeyboard(),
      {},
    );
    assert.equal(layer.blendMode, "norm");
    tracker.undo(doc.history[0].data, doc);
    assert.equal(layer.blendMode, "norm");
  });

  it("setBlendMode applies pass-through to a group and restores its prior mode", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const group = makeLayer({ blendMode: "norm", isGroup: () => true });
    const doc = makeDoc([group]);
    tracker.handleInput(
      { actionKind: Layer.setBlendMode, layerPropertyValue: 0 },
      {}, doc, idleKeyboard(), {},
    );
    assert.equal(group.blendMode, "pass");
    tracker.undo(doc.history[0].data, doc);
    assert.equal(group.blendMode, "norm");
    tracker.redo(doc.history[0].data, doc);
    assert.equal(group.blendMode, "pass");
  });

  it("tracks the PSD mode actually selected for a group", () => {
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    const tracked = [];
    tracker.track = (descriptor) => tracked.push(descriptor);
    const group = makeLayer({ blendMode: "norm", isGroup: () => true });
    const doc = makeDoc([group]);
    tracker.handleInput(
      { actionKind: Layer.setBlendMode, layerPropertyValue: 0 },
      {}, doc, idleKeyboard(), {},
    );
    assert.equal(group.blendMode, "pass");
    assert.equal(tracked[0].actionDescriptor.T.v.Md.v.blendMode, "passThrough");
    tracker.undo(doc.getLastHistoryEntry().data, doc);
    tracker.handleInput(
      { actionKind: Layer.setBlendMode, layerPropertyValue: 4 },
      {}, doc, idleKeyboard(), {},
    );
    assert.equal(group.blendMode, "mul ");
    assert.equal(tracked[1].actionDescriptor.T.v.Md.v.blendMode, "Mltp");
  });
});
