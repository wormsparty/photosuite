import assert from "node:assert/strict";
import { after, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Rect } from "../../../src/core/math/rect.js";
import { Point } from "../../../src/core/math/point.js";
import { computeGuideSnapDelta, snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../../../src/document/model/guide-snapping.js";

const restore = installBrowserGlobals();
after(restore);
function setup() {
  return {
    doc: { width: 100, height: 80, dpi: 72, guides: [[20], [30]], slices: [], selectedLayerIndices: [], selectedSliceIndices: [], pathViewport: { zoomScale: 1 }, toolOverlayState: {} },
    app: { snapEnabled: true, extras: true, showToggles: [true, false, false, false, false], prefs: { guides: true, showGrid: true, gridSize: 10, gridUnits: 0 } },
  };
}
it("snaps both coordinates and honors the global and guide visibility switches", () => {
  const { doc, app } = setup();
  assert.deepEqual(snapPointToGuides(doc, new Point(18, 33), app), new Point(20, 30));
  app.snapEnabled = false;
  assert.deepEqual(computeGuideSnapDelta(doc, [[18], [33]], app), [0, 0, 1e9, 1e9]);
  app.snapEnabled = true;
  app.extras = false;
  assert.deepEqual(snapPointToGuides(doc, new Point(18, 33), app), new Point(18, 33));
});
it("keeps snap tolerance constant in screen pixels across zoom and pixel density", () => {
  const { doc, app } = setup();
  doc.pathViewport.zoomScale = 2;
  assert.equal(snapPointToGuides(doc, new Point(17, 30), app).x, 17);
  assert.equal(snapPointToGuides(doc, new Point(18, 30), app).x, 20);
  window.devicePixelRatio = 2;
  try { assert.equal(snapPointToGuides(doc, new Point(16, 30), app).x, 20); }
  finally { delete window.devicePixelRatio; }
});
it("chooses the closest rectangle sample and draws translated alignment guides", () => {
  const { doc, app } = setup();
  const rect = new Rect(9, 22, 20, 16);
  const delta = snapRectCornersToGuides(doc, rect, app);
  assert.deepEqual(delta, [1, 0, 20, 30]);
  updateLayerDragPositions(doc, rect, delta);
  assert.deepEqual(doc.toolOverlayState.snapGuides, { commands: ["M", "L", "M", "L"], coords: [20, 22, 20, 38, 10, 30, 30, 30] });
  assert.equal(doc.dirty, true);
});
it("snaps to negative grid lines, document centers, and an explicit reference rectangle", () => {
  const { doc, app } = setup();
  app.showToggles = [false, true, false, false, false];
  assert.deepEqual(snapPointToGuides(doc, new Point(-9, 11), app), new Point(-10, 10));
  app.showToggles = [false, false, false, false, true];
  assert.deepEqual(snapPointToGuides(doc, new Point(48, 43), app), new Point(50, 40));
  app.showToggles[4] = false;
  assert.deepEqual(computeGuideSnapDelta(doc, [[18], [27]], app, [true, new Rect(20, 30, 40, 20), true]), [2, 3, 20, 30]);
});
it("ignores selected and invisible layers while considering visible layer centers", () => {
  const { doc, app } = setup();
  app.showToggles = [false, false, true, false, false];
  const node = (index, rect, visible = true, children) => ({ index, layer: { rect, isVisible: () => visible }, children });
  doc.root = node(-1, new Rect(), true, [node(0, new Rect(19, 0, 2, 2)), node(1, new Rect(10, 20, 20, 20)), node(2, new Rect(21, 29, 2, 2), false)]);
  doc.selectedLayerIndices = [0];
  assert.deepEqual(snapPointToGuides(doc, new Point(21, 31), app), new Point(20, 30));
});
