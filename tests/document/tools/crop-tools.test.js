import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let ToolId;
let restoreBrowserGlobals;
let CropTool;
let CropToolBase;
let PerspectiveCropTool;
let MoveTool;
let SliceTool;

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/crop-tools.js");
  ({ CropTool, CropToolBase, PerspectiveCropTool } = await import("../../../src/document/tools/crop-tools.js"));
  ({ MoveTool } = await import("../../../src/document/tools/move-tools.js"));
  ({ SliceTool } = await import("../../../src/document/transform/slice-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/crop-tools.js", () => {
  it("registerCropTools wires CropTool and PerspectiveCropTool", () => {
    chainToolPrototypes();
    const cropTool = new CropTool();
    const perspectiveTool = new PerspectiveCropTool();

    assert.equal(typeof CropToolBase, "function");
    assert.equal(cropTool.name, "tools.cropTool");
    assert.equal(cropTool.id, ToolId.TOOL_CROP);
    assert.equal(perspectiveTool.id, ToolId.TOOL_PERSPECTIVE_CROP);
    assert.equal(cropTool.isActive(), false);
  });

  it("buildCropAction maps bounds and angle into descriptor", () => {
    chainToolPrototypes();
    const action = CropToolBase.buildCropAction([10, 20, 100, 80], 15);

    assert.equal(action.uf, "crop");
    assert.equal(action.actionDescriptor.T.v.Top.v.val, 20);
    assert.equal(action.actionDescriptor.T.v.Left.v.val, 10);
    assert.equal(action.actionDescriptor.T.v.Rght.v.val, 110);
    assert.equal(action.actionDescriptor.T.v.Btom.v.val, 100);
    assert.equal(action.actionDescriptor.Angl.v.val, 15);
  });

  it("buildTrimAction maps trim sides", () => {
    chainToolPrototypes();
    const action = CropToolBase.buildTrimAction(2, [true, false, true, false]);

    assert.equal(action.uf, "trim");
    assert.equal(action.actionDescriptor.trimBasedOn.v.trimBasedOn, "Trns");
    assert.equal(action.actionDescriptor.Top.v, true);
    assert.equal(action.actionDescriptor.Left.v, false);
  });

  it("buildCanvasSizeAction maps dimensions and anchor", () => {
    chainToolPrototypes();
    const action = CropToolBase.buildCanvasSizeAction(800, 600, 4);

    assert.equal(action.uf, "canvasSize");
    assert.equal(action.actionDescriptor.Wdth.v.val, 800);
    assert.equal(action.actionDescriptor.Hght.v.val, 600);
    assert.equal(action.actionDescriptor.Hrzn.v.HrzL, "Cntr");
    assert.equal(action.actionDescriptor.Vrtc.v.VrtL, "Cntr");
  });

  it("Image Size sends each interpolation choice through the resize action", () => {
    const modes = ["Nrst", "Blnr", "bicubicSharper"];
    for (let interpolation = 0; interpolation < modes.length; interpolation++) {
      const crop = new CropTool();
      const received = [];
      crop.applyCropTransformToDocument = (_doc, _resample, allLayers, _matrix, mode) => {
        received.push({ allLayers, mode });
        return null;
      };
      const history = [];
      const doc = {
        width: 4, height: 4, dpi: 72,
        layers: [], paths: [], slices: [], extraChannels: [], guides: [[], []],
        selectionMask: null,
        pathViewport: { panOffset: { setXY() {} } },
        pushHistory(entry) { history.push(entry); },
        invalidateAllLayers() {},
      };
      const action = CropToolBase.buildImageSizeAction(2, 2, 72, interpolation);
      assert.equal(action.actionDescriptor.Intr.v.Intp, modes[interpolation]);
      crop.handleInput(
        { actionKind: "fromAction", scriptActionPayload: action },
        { dispatch() {} }, doc, null, null,
      );
      assert.deepEqual(received, [{ allLayers: true, mode: interpolation }]);
      assert.deepEqual([doc.width, doc.height], [2, 2]);
      assert.equal(history.length, 1);
      assert.equal(history[0].name, "dialogs.imageSize");
    }
  });

  it("aspectRatioFromQuadCorners returns 1 for axis-aligned square", () => {
    chainToolPrototypes();
    const aspect = CropToolBase.aspectRatioFromQuadCorners(
      [0, 0, 100, 0, 100, 100, 0, 100],
      50,
      50,
    );
    assert.equal(aspect, 1);
  });

  it("registerCropTools keeps prototype methods after ToolBase chaining", () => {
    // Chaining by assigning `CropToolBase.prototype = new ToolBase()` would wipe
    // every method defined above it, leaving handleInput on ToolBase's empty
    // stub — Image Size and Canvas Size then do nothing at all, silently.
    chainToolPrototypes();
    const crop = new CropTool();
    assert.equal(typeof crop.handleInput, "function");
    assert.ok(crop.handleInput.toString().length > 100, "handleInput must be the real method, not the empty ToolBase stub");
    assert.equal(typeof crop.applyAction, "function");
    assert.equal(typeof crop.commitCrop, "function");
    // Canvas Size must actually resize the document.
    const doc = {
      width: 800, height: 600, dpi: 72,
      layers: [], paths: [], extraChannels: [], slices: [], guides: [[], []],
      selectionMask: null, pathViewport: { panOffset: { setXY() {} } },
      root: { getSelectionRect() { return { isEmpty: () => true }; } },
      pushHistory() {}, invalidateAllLayers() {},
    };
    MoveTool = { translateLayersByDelta() {}, snapPointToGuides: (d, p) => p };
    SliceTool = { rescaleSlicesForCanvas() {} };
    crop.handleInput(
      { actionKind: "fromAction", scriptActionPayload: CropToolBase.buildCanvasSizeAction(400, 300) },
      { dispatch() {} }, doc, null, null,
    );
    assert.equal(doc.width, 400);
    assert.equal(doc.height, 300);
  });

  it("canvas anchors reposition document contents and undo restores them", () => {
    for (let anchor = 0; anchor < 9; anchor++) {
      const history = [];
      const doc = {
        width: 4, height: 4, dpi: 72,
        layers: [], paths: [], slices: [],
        guides: [[3], [3]],
        selectionMask: { rect: { x: 2, y: 2, offset(dx, dy) { this.x += dx; this.y += dy; } } },
        extraChannels: [{ rect: { x: 2, y: 2, offset(dx, dy) { this.x += dx; this.y += dy; } } }],
        pathViewport: { panOffset: { setXY() {} } },
        pushHistory(entry) { history.push(entry); },
        invalidateAllLayers() {},
      };
      const crop = new CropTool();
      crop.handleInput(
        { actionKind: "fromAction", scriptActionPayload: CropToolBase.buildCanvasSizeAction(2, 2, anchor) },
        { dispatch() {} }, doc, null, null,
      );
      const x = anchor % 3;
      const y = Math.floor(anchor / 3);
      assert.equal(history.length, 1, `anchor ${anchor} should record one undo step`);
      assert.deepEqual([doc.width, doc.height], [2, 2]);
      assert.deepEqual([doc.selectionMask.rect.x, doc.selectionMask.rect.y], [2 - x, 2 - y]);
      assert.deepEqual([doc.extraChannels[0].rect.x, doc.extraChannels[0].rect.y], [2 - x, 2 - y]);
      assert.deepEqual(doc.guides, [[3 - x], [3 - y]]);
      crop.undo(history[0].data, doc);
      assert.deepEqual([doc.width, doc.height], [4, 4]);
      assert.deepEqual([doc.selectionMask.rect.x, doc.selectionMask.rect.y], [2, 2]);
      assert.deepEqual([doc.extraChannels[0].rect.x, doc.extraChannels[0].rect.y], [2, 2]);
      assert.deepEqual(doc.guides, [[3], [3]]);
    }
  });
});
