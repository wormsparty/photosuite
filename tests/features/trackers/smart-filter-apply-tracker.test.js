/**
 * Golden + instance behavior for SmartFilterApplyTracker.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let TrackerRegistry;
let FilterDefs;

before(async () => {

  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
  ({ FilterDefs } = await import("../../../src/features/filters/filter-apply.js"));
});

function makePlacedLayer() {
  return {
    pixelContent: 0,
    layerFlags: 0,
    add: {
      placedData: {
        placed: { v: "item-tag" },
        filterFX: null,
      },
    },
    hasSmartFilters() {
      return this.add.placedData.filterFX != null;
    },
    applySmartFilters() {
      this.applied = true;
    },
    rasterizeSmartObject() {
      this.rasterized = true;
    },
    isEffectsExpanded() {
      return true;
    },
    getMask() {
      return null;
    },
  };
}

function makeDoc(layers) {
  return {
    layers,
    selectedLayerIndices: [0],
    history: [],
    historyIndex: -1,
    dirty: false,
    stateChanged: false,
    add: {},
    extraChannels: [],
    markDirty() {
      this.dirty = true;
    },
    pushHistory(entry) {
      this.history.push(entry);
      this.historyIndex = this.history.length - 1;
    },
    addPlacedItemId() {},
    removePlacedItemId() {},
    ensureSelectedLayersPixelEditable(_doc, _x, _y, cb) {
      cb(true);
    },
  };
}

describe("features/trackers/smart-filter-apply-tracker.js", () => {
  it("buildFilterStartDispatch routes dialog filters to afw_ dialogRouteId", () => {
    const placedTarget = { layerIndex: 1, index: 0 };
    assert.deepEqual(TrackerRegistry.SmartFilterApplyTracker.buildFilterStartDispatch("GsnB", placedTarget), {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "afw_GsnB",
      smartFilterRef: placedTarget,
    });
  });

  it("buildFilterStartDispatch routes tool-linked filters to setActiveToolPanelMode", () => {
    const placedTarget = { layerIndex: 0, index: 2 };
    FilterDefs.toolLinkedFilterIds.__crTestFilter = "tool-channel-x";
    try {
      assert.deepEqual(
        TrackerRegistry.SmartFilterApplyTracker.buildFilterStartDispatch("__crTestFilter", placedTarget),
        {
          dispatchKind: UiCommand.setActiveToolPanelMode,
          routingChannel: "tool-channel-x",
          toolOptions: { smartFilterRef: placedTarget },
        },
      );
    } finally {
      delete FilterDefs.toolLinkedFilterIds.__crTestFilter;
    }
  });

  it("unpackRgbFromColorInt splits a packed RGB int into h/l/O", () => {
    const tracker = new TrackerRegistry.SmartFilterApplyTracker();
    assert.deepEqual(tracker.unpackRgbFromColorInt(0x112233), { h: 17, l: 34, O: 51 });
  });

  it("getPlacedLayerFilterTarget returns layerIndex/index for a blank smart object", () => {
    const tracker = new TrackerRegistry.SmartFilterApplyTracker();
    const layer = makePlacedLayer();
    const doc = makeDoc([layer]);
    assert.deepEqual(tracker.getPlacedLayerFilterTarget(doc, "GsnB"), {
      layerIndex: 0,
      index: 0,
    });
  });

  it("placed-layer edit/confirm pushes history and undo restores placedDataBefore", () => {
    const tracker = new TrackerRegistry.SmartFilterApplyTracker();
    const layer = makePlacedLayer();
    const doc = makeDoc([layer]);
    const filterOptions = { classID: "GsnB", Rds: { t: "UntF", v: { type: "#Pxl", val: 2 } } };
    const placedRef = { layerIndex: 0, index: 0 };
    tracker.handleInput(
      { actionKind: "edit", operationId: "GsnB", operationData: filterOptions, smartFilterRef: placedRef, skipCanvasPreview: false },
      {},
      doc,
      {},
      { colorInt: 0, bgColor: 0xffffff },
    );
    assert.ok(tracker.filterEditHistoryEntry);
    assert.ok(layer.add.placedData.filterFX);
    const before = tracker.filterEditHistoryEntry.data.placedDataBefore;
    tracker.handleInput({ actionKind: "confirm", operationId: "GsnB", smartFilterRef: placedRef }, {}, doc, {}, {});
    assert.equal(doc.history.length, 1);
    assert.equal(tracker.filterEditHistoryEntry, null);
    layer.add.placedData = { placed: { v: "mutated" }, filterFX: { v: { filterFXList: { v: [] } } } };
    tracker.undo(doc.history[0].data, doc);
    assert.deepEqual(layer.add.placedData, before);
  });

  it("handles cancel action safely when no preview snapshots exist", () => {
    const tracker = new TrackerRegistry.SmartFilterApplyTracker();
    const doc = makeDoc([{ pixelContent: 0 }]);
    assert.doesNotThrow(() => {
      tracker.handleInput({ actionKind: "cancel", operationId: "LnCr" }, {}, doc, {}, {});
    });
    assert.equal(tracker.previewSnapshots, null);
  });

  it("ignores stale or malformed placed-filter references before mutation", () => {
    const tracker = new TrackerRegistry.SmartFilterApplyTracker();
    const layer = makePlacedLayer();
    const doc = makeDoc([layer]);
    const colorEnv = { colorInt: 0, bgColor: 0xffffff };
    const refs = [
      { layerIndex: -1, index: 0 },
      { layerIndex: 1, index: 0 },
      { layerIndex: 0.5, index: 0 },
      { layerIndex: 0, index: -1 },
      { layerIndex: 0, index: 0.5 },
      { layerIndex: 0, index: 2 },
    ];
    for (const smartFilterRef of refs) {
      assert.doesNotThrow(() => tracker.handleInput(
        { actionKind: "edit", operationId: "GsnB", operationData: { value: 1 }, smartFilterRef },
        {},
        doc,
        {},
        colorEnv,
      ));
      assert.equal(tracker.filterEditHistoryEntry, null);
      assert.equal(layer.add.placedData.filterFX, null);
    }
  });

  it("does not create a filter entry for an index beyond the current stack", () => {
    const tracker = new TrackerRegistry.SmartFilterApplyTracker();
    const layer = makePlacedLayer();
    layer.add.placedData.filterFX = FilterDefs.createEmptyFilterFxStyle();
    const doc = makeDoc([layer]);
    assert.doesNotThrow(() => tracker.handleInput(
      {
        actionKind: "edit",
        operationId: "GsnB",
        operationData: { value: 1 },
        smartFilterRef: { layerIndex: 0, index: 2 },
      },
      {},
      doc,
      {},
      { colorInt: 0, bgColor: 0xffffff },
    ));
    assert.equal(layer.add.placedData.filterFX.v.filterFXList.v.length, 0);
    assert.equal(tracker.filterEditHistoryEntry, null);
  });
});
