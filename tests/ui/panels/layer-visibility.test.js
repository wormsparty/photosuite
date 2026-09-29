import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

const restore = installBrowserGlobals();
after(restore);
let LayerGroupItem;
before(async () => {
  ({ LayerGroupItem } = await import("../../../src/ui/panels/layer-group-item.js"));
});

function row(index = 0) {
  const result = Object.create(LayerGroupItem.prototype);
  result.sectionNode = { index };
  result.visibilityEyeEl = { style: {} };
  result.parent = { doc: { layers: [{ isVisible: () => result.visible }] } };
  result.visible = true;
  result.events = [];
  result.applyEvent = (event) => { result.events.push(event); result.visible = !result.visible; };
  return result;
}

function event(type, target, extras = {}) {
  return { type, target, button: 0, preventDefault() {}, stopPropagation() {}, ...extras };
}

it("toggles an eye exactly once for a complete mouse click and restores it on the next click", () => {
  const instance = row();
  for (const expected of [false, true]) {
    instance.onVisibilityEyeEvent(event("mousedown", instance.visibilityEyeEl));
    LayerGroupItem.endVisibilityPointer();
    instance.onRowClick(event("click", instance.visibilityEyeEl));
    assert.equal(instance.visible, expected);
  }
  assert.equal(instance.events.length, 2, "one history action per user click");
});

it("drags visibility across new rows once while ignoring repeated hover and released pointers", () => {
  const first = row(0), second = row(1);
  first.onVisibilityEyeEvent(event("mousedown", first.visibilityEyeEl));
  second.onVisibilityEyeEvent(event("mouseover", second.visibilityEyeEl));
  second.onVisibilityEyeEvent(event("mouseover", second.visibilityEyeEl));
  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 1);
  LayerGroupItem.endVisibilityPointer();
  first.onVisibilityEyeEvent(event("mouseover", first.visibilityEyeEl));
  assert.equal(first.events.length, 1);
});

it("ignores right-button visibility gestures", () => {
  const instance = row();
  instance.onVisibilityEyeEvent(event("mousedown", instance.visibilityEyeEl, { button: 2 }));
  assert.equal(instance.events.length, 0);
});
