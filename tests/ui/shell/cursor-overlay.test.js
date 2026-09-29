import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
const restore = installBrowserGlobals();
after(restore);
let CursorOverlay;
before(async () => { ({ CursorOverlay } = await import("../../../src/ui/shell/cursor-overlay.js")); });
function element(rect) {
  return { style: {}, attributes: {}, children: [], events: [], getBoundingClientRect: () => rect,
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(...args) { this.events.push(["add", ...args]); }, removeEventListener(...args) { this.events.push(["remove", ...args]); },
    appendChild(child) { this.children.push(child); }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1); } };
}
function setup() {
  const canvas = element({ left: 100, top: 80, right: 300, bottom: 280 });
  const viewport = element();
  viewport.querySelector = () => canvas;
  const container = element({ left: 50, top: 40 });
  container.querySelector = (selector) => selector === ".pbody" ? viewport : canvas;
  const overlay = new CursorOverlay(container);
  overlay.previewImgEl = element();
  return { overlay, canvas, viewport, container };
}
it("positions an image cursor relative to its container and scales its hotspot", () => {
  const { overlay, canvas, container } = setup();
  overlay.open({ boundsRect: { width: 64, height: 64 }, hotspot: { x: 32, y: 32 }, pixelSource: "cursor.png" });
  overlay.refresh({ clientX: 150, clientY: 140 });
  assert.equal(container.children[0], overlay.previewImgEl);
  assert.match(overlay.previewImgEl.attributes.style, /top:84px;left:84px;width:32px;height:32px/);
  assert.equal(canvas.style.cursor, "none");
  assert.equal(overlay.previewImgEl.attributes.src, "cursor.png");
});
it("hides a bitmap on leaving the canvas and restores it on reentry", () => {
  const { overlay, canvas, container } = setup();
  overlay.open({ boundsRect: { width: 16, height: 16 }, hotspot: { x: 0, y: 0 }, pixelSource: "cursor.png" });
  overlay.refresh({ clientX: 150, clientY: 140 });
  overlay._onWindowPointerMove({ clientX: 300, clientY: 140 });
  assert.equal(container.children.length, 0);
  assert.equal(canvas.style.cursor, "default");
  overlay._onWorkingAreaPointerEnter({ clientX: 299, clientY: 140 });
  assert.equal(container.children.length, 1);
  assert.equal(canvas.style.cursor, "none");
});
it("switching to a CSS cursor removes the preview and stops window tracking", () => {
  const { overlay, canvas, viewport, container } = setup();
  overlay.open({ boundsRect: { width: 16, height: 16 }, hotspot: { x: 0, y: 0 }, pixelSource: "cursor.png" });
  overlay.refresh({ clientX: 150, clientY: 140 });
  assert.equal(overlay._trackingWindow, true);
  overlay.open("crosshair");
  assert.equal(overlay._trackingWindow, false);
  assert.equal(container.children.length, 0);
  assert.equal(canvas.style.cursor, "crosshair");
  assert.equal(viewport.style.cursor, "crosshair");
});
it("binds enter/leave listeners once and detaches them when the working canvas changes", () => {
  const { overlay, canvas, viewport } = setup();
  overlay._bindWorkingAreaListeners();
  overlay._bindWorkingAreaListeners();
  assert.deepEqual(canvas.events.map((event) => event.slice(0, 2)), [["add", "pointerleave"], ["add", "pointerenter"]]);
  const replacement = element();
  viewport.querySelector = () => replacement;
  overlay._bindWorkingAreaListeners();
  assert.deepEqual(canvas.events.slice(2).map((event) => event.slice(0, 2)), [["remove", "pointerleave"], ["remove", "pointerenter"]]);
  assert.equal(replacement.events.length, 2);
});
