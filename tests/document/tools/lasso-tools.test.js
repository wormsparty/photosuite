import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Rect } from "../../../src/core/math/rect.js";
import { EventType } from "../../../src/core/event-bus.js";

let restoreBrowserGlobals;
let ToolBase;
let LassoTool;
let MagneticLassoTool;
let PolygonLassoTool;
let RectSelectTool;
let SelectTool;

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  ({ ToolBase } = await import("../../../src/document/model/tool-base.js"));
  ({ LassoTool, MagneticLassoTool, PolygonLassoTool } = await import("../../../src/document/tools/lasso-tools.js"));
  ({ RectSelectTool, SelectTool } = await import("../../../src/document/tools/selection-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});


function installOverlayStub() {
  ToolBase.drawDimensionOverlay = () => {};
}

// A document carrying one vertical and one horizontal guide, at 22 and 150.
// Snapping pulls a coordinate in only from within four screen pixels, so 20
// lands on the guide at 22 while a point out in open canvas is left alone.
function createSnapDoc(Point) {
  return {
    width: 200,
    height: 200,
    selectionMask: null,
    selectedLayerIndices: [0],
    layers: [],
    extraChannels: [],
    guides: [[22, 150], [22, 150]],
    slices: [],
    selectedSliceIndices: [],
    dirty: false,
    toolOverlayState: { overlayTransform: null, floatingBitmapOverlays: [] },
    pathViewport: {
      zoomScale: 1,
      dimensionOverlay: null,
      screenToDocPoint(x, y) {
        return new Point(x, y);
      },
    },
  };
}

const NO_KEYS = { isPressed: () => false };
// showToggles selects what may be snapped to: guides only, so the assertions
// turn on the guides and nothing else.
const APP_DATA = {
  prefs: { showSelectionEdges: true, guides: true, showGrid: false, slices: false },
  extras: true,
  snapEnabled: true,
  showToggles: [true, false, false, false, false],
};
const pointerAt = (x, y, isDown) => ({ x, y, screenX: x, screenY: y, isDown });

describe("document/tools/lasso-tools.js", () => {
  it("registers the three lasso tools as SelectTool subclasses", () => {
    chainToolPrototypes();
    for (const Tool of [PolygonLassoTool, MagneticLassoTool, LassoTool]) {
      const tool = new Tool();
      assert.ok(tool instanceof SelectTool, Tool.name);
      assert.equal(tool.defaultCursorStyle, "crosshair", Tool.name);
    }
  });


  it("freehand lasso samples raw pointer positions, unsnapped", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    chainToolPrototypes();
    installOverlayStub();
    const tool = new LassoTool();
    const doc = createSnapDoc(Point);
    const dispatcher = { dispatch() {} };

    tool.onMouseDown(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(20, 20, true));
    for (const [x, y] of [[38, 24], [61, 47], [43, 72]]) {
      tool.onMouseMove(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(x, y, true));
    }

    // Anchor snaps at mouse-down (20,20 -> 22,22); the traced samples are not.
    assert.deepEqual(tool.polygonPathOverlay.coords, [22, 22, 38, 24, 61, 47, 43, 72]);
    assert.deepEqual(tool.polygonPathOverlay.commands, ["M", "L", "L", "L"]);
  });

  it("marquee still snaps its drag point to guides", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    chainToolPrototypes();
    installOverlayStub();
    const tool = new RectSelectTool();
    const doc = createSnapDoc(Point);
    const dispatcher = { dispatch() {} };

    tool.onMouseDown(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(20, 20, true));
    tool.onMouseMove(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(148, 152, true));
    assert.deepEqual([tool.cursorPos.x, tool.cursorPos.y], [150, 150]);
  });


  it("a traced outline is recorded as a Lasso Select history step", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    chainToolPrototypes();
    installOverlayStub();
    const tool = new LassoTool();
    const doc = createSnapDoc(Point);
    // Rasterising needs a real 2D context; only the history label matters here.
    tool.bezierPathToSelectionMask = () => null;
    const outcome = tool.applyScriptedShapeSelection(
      "set",
      SelectTool.buildPolygonSelectionAction([0, 0, 10, 0, 10, 10]).actionDescriptor,
      { dispatch() {} },
      doc,
      NO_KEYS,
      APP_DATA,
      null,
    );
    assert.equal(outcome.label, "tools.lassoSelect");
  });

  it("commits a feathered freehand outline with soft edges and undoable history", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    const tool = new LassoTool();
    const events = [];
    const dispatcher = { dispatch(event) { events.push(event); } };
    const history = [];
    const appData = { extras: true, prefs: { showSelectionEdges: true }, snapEnabled: false };
    const doc = {
      width: 16, height: 16, selectionMask: null, dirty: false,
      toolOverlayState: { overlayTransform: null },
      pathViewport: {
        zoomScale: 1, dimensionOverlay: null,
        screenToDocPoint(x, y) { return new Point(x, y); },
      },
      pushHistory(entry) { history.push(entry); },
    };
    // Node has no canvas rasterizer. Supply a small hard mask only; the
    // pointer trace, descriptor, feathering, and history paths stay real.
    let tracedPath;
    tool.bezierPathToSelectionMask = (path) => {
      tracedPath = path;
      const channel = new Uint8Array(8 * 8);
      channel.fill(255);
      return { rect: new Rect(4, 4, 8, 8), channel };
    };

    tool.syncToolbarWidget([0, 1, [16, true, true]], null, dispatcher);
    tool.onMouseDown(doc, dispatcher, appData, NO_KEYS, pointerAt(4, 4, true));
    for (const [x, y] of [[12, 4], [12, 12], [4, 12]]) {
      tool.onMouseMove(doc, dispatcher, appData, NO_KEYS, pointerAt(x, y, true));
    }
    tool.onMouseUp(doc, dispatcher, appData, NO_KEYS, pointerAt(4, 12, false));

    const gesture = events.find((event) => event.type === EventType.historyGrouped);
    assert.ok(gesture);
    assert.equal(gesture.data.actionDescriptor.T.v.classID, "Plgn");
    assert.equal(gesture.data.actionDescriptor.Fthr.v.val, 1);
    assert.equal(tool.polygonPathOverlay, null);
    assert.equal(doc.toolOverlayState.overlayTransform, null);
    tool.handleInput({ actionKind: "fromAction", scriptActionPayload: gesture.data }, dispatcher, doc, NO_KEYS, appData);

    assert.deepEqual(tracedPath.coords, [4, 4, 12, 4, 12, 12, 4, 12]);
    assert.deepEqual(tracedPath.commands, ["M", "L", "L", "L", "Z"]);
    assert.equal(history.length, 1);
    assert.equal(history[0].name, "tools.lassoSelect");
    const selection = doc.selectionMask;
    const at = (x, y) => selection.channel[(y - selection.rect.y) * selection.rect.width + x - selection.rect.x];
    assert.ok(selection.rect.x < 4);
    assert.ok(at(3, 8) > 0 && at(3, 8) < 255);
    assert.equal(at(8, 8), 255);

    tool.undo(history[0].data, doc);
    assert.equal(doc.selectionMask, null);
    tool.redo(history[0].data, doc);
    assert.equal(doc.selectionMask, selection);
    assert.ok(at(3, 8) > 0 && at(3, 8) < 255);
  });

  it("polygon lasso activity tracks its path overlay", () => {
    chainToolPrototypes();
    const tool = new PolygonLassoTool();
    assert.equal(tool.isActive(), false);
    assert.equal(tool.shouldCancelMouseDown(), false);
    tool.polygonPathOverlay = { coords: [0, 0, 1, 1], commands: ["M", "L"] };
    assert.equal(tool.isActive(), true);
    assert.equal(tool.shouldCancelMouseDown(), true);
    tool.clearPolygonPathOverlay(null);
    assert.equal(tool.polygonPathOverlay, null);
  });

  it("magnetic lasso maps pixel indices to centred overlay coords", () => {
    chainToolPrototypes();
    const doc = { width: 10 };
    const coords = MagneticLassoTool.indicesToOverlayCoords(doc, [0, 11, 25]);
    assert.deepEqual(coords, [0.5, 0.5, 1.5, 1.5, 5.5, 2.5]);
  });

  it("magnetic lasso clear resets search state and overlay", () => {
    chainToolPrototypes();
    const tool = new MagneticLassoTool();
    tool.nodes = [1, 2];
    tool.magneticAnchorPoints = [{ x: 0, y: 0 }];
    const doc = { toolOverlayState: { overlayTransform: {}, squareMarkerCoords: [1] }, dirty: false };
    tool.clear(doc);
    assert.deepEqual(tool.nodes, []);
    assert.deepEqual(tool.magneticAnchorPoints, []);
    assert.equal(doc.toolOverlayState.overlayTransform, null);
    assert.equal(doc.dirty, true);
  });

  it("Escape cancels an active magnetic outline without committing a selection", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    const { KeyboardHandler } = await import("../../../src/core/keyboard-handler.js");
    const tool = new MagneticLassoTool();
    const doc = {
      width: 8, height: 8,
      getRasterData() { return new Uint8Array(8 * 8 * 4); },
      pathViewport: { zoomScale: 1 },
      toolOverlayState: { overlayTransform: null, squareMarkerCoords: [] },
      selectionMask: null,
      dirty: false,
    };
    const dispatched = [];
    const dispatcher = { dispatch(event) { dispatched.push(event); } };
    const keyboard = { isPressed(key) { return key === KeyboardHandler.Escape; } };
    tool.startPos = new Point(1, 1);
    tool.cursorPos = new Point(1, 1);
    tool.onDragStart(doc, APP_DATA, NO_KEYS, pointerAt(1, 1, true));
    assert.equal(tool.isActive(), true);
    assert.ok(doc.toolOverlayState.overlayTransform);

    tool.onKeyEvent(doc, dispatcher, APP_DATA, keyboard);
    assert.equal(tool.isActive(), false);
    assert.equal(doc.toolOverlayState.overlayTransform, null);
    assert.deepEqual(doc.toolOverlayState.squareMarkerCoords, []);
    assert.equal(doc.selectionMask, null);
    assert.deepEqual(dispatched, []);
  });
});
