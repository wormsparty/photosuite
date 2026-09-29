import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { pointInPolygon } from "../../../src/engine/compositing/bitmap-contour-tracer.js";

const restore = installBrowserGlobals();
after(restore);
let LassoTool;
before(async () => {
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  ({ LassoTool } = await import("../../../src/document/tools/lasso-tools.js"));
});

const keyboard = { isPressed: () => false };
const appData = { snapEnabled: false, prefs: { showSelectionEdges: true } };
const dispatcher = { dispatch() {} };
const pointer = (x, y) => ({ x, y, screenX: x, screenY: y, isDown: true });

function gesture(points) {
  const doc = {
    width: 8, height: 8, selectionMask: null,
    toolOverlayState: { overlayTransform: null },
    pathViewport: { zoomScale: 1, screenToDocPoint: (x, y) => new Point(x, y) },
  };
  const tool = new LassoTool();
  tool.onMouseDown(doc, dispatcher, appData, keyboard, pointer(...points[0]));
  for (const [x, y] of points.slice(1)) {
    tool.onMouseMove(doc, dispatcher, appData, keyboard, pointer(x, y));
  }
  return { tool, doc };
}

function assertPolygonContainsArea(tool, doc, expectedCoords) {
  const action = tool.getSelection(doc, appData, keyboard);
  assert.ok(action, "a traced region must produce a polygon selection action");
  assert.equal(action.uf, "set");
  assert.equal(action.actionDescriptor.T.v.classID, "Plgn");
  const points = action.actionDescriptor.T.v.Pts.v.arr;
  const coords = points[0].arr.flatMap((x, index) => [x, points[1].arr[index]]);
  assert.deepEqual(coords, expectedCoords);
  // Node's DOM fixture has no 2D canvas. Verify the real polygon geometry;
  // the resulting raster selection mask requires native integration.
  assert.equal(pointInPolygon(coords, 3.5, 3.5), true);
  assert.equal(pointInPolygon(coords, 0.5, 0.5), false);
  assert.equal(pointInPolygon(coords, 7.5, 7.5), false);
}

it("keeps an enclosed freehand selection when the pointer returns exactly to its start", () => {
  const { tool, doc } = gesture([[1, 1], [7, 1], [7, 7], [1, 7], [1, 1]]);
  assert.equal(tool.exceededDragThreshold, true);
  assert.equal(tool.startPos.equals(tool.cursorPos), true);
  assertPolygonContainsArea(tool, doc, [1, 1, 7, 1, 7, 7, 1, 7, 1, 1]);
});

it("keeps an ordinary nonclosed freehand trace as a polygon selection", () => {
  const { tool, doc } = gesture([[1, 1], [7, 1], [7, 7], [1, 7]]);
  assert.equal(tool.exceededDragThreshold, true);
  assertPolygonContainsArea(tool, doc, [1, 1, 7, 1, 7, 7, 1, 7]);
});

it("a click without a traced outline produces no selection", () => {
  const { tool, doc } = gesture([[2, 2], [2, 2]]);
  assert.equal(tool.exceededDragThreshold, false);
  assert.equal(tool.getSelection(doc, appData, keyboard), null);
});

it("an outline that stays below the drag threshold produces no selection", () => {
  const { tool, doc } = gesture([[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]);
  assert.equal(tool.exceededDragThreshold, false);
  assert.equal(tool.getSelection(doc, appData, keyboard), null);
});
