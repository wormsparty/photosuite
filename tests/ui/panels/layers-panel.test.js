/**
 * LayersPanel shell helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let EventChannel;
let LayersPanel;
let DocumentModel;
let Layer;

before(async () => {
  ({ EventChannel } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ LayersPanel } = await import("../../../src/ui/panels/layers-panel.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});

describe("ui/panels/layers-panel.js", () => {
  it("getPreferredSize returns fixed panel width", () => {
    const panel = Object.create(LayersPanel.prototype);
    const size = LayersPanel.prototype.getPreferredSize.call(panel);
    assert.equal(size.x, 253);
    assert.equal(size.y, 0);
  });

  it("applyEvent dispatches documentAction on EVENT_DOCUMENT", () => {
    const panel = Object.create(LayersPanel.prototype);
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    LayersPanel.prototype.applyEvent.call(panel, { actionKind: "test" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EventType.documentAction);
    assert.equal(events[0].routingChannel, EventChannel.EVENT_DOCUMENT);
    assert.deepEqual(events[0].data, { actionKind: "test" });
  });

  it("header controls send opacity bytes and all four lock choices", () => {
    const panel = Object.create(LayersPanel.prototype);
    const actions = [];
    panel.applyEvent = (action) => actions.push(action);
    panel.opacitySlider = { getValue: () => 50 };
    panel.fillSlider = { getValue: () => 25 };
    panel.lockFlagsRadio = { getValue: () => [true, false, true, false] };
    panel.onOpacityChange();
    panel.onFillChange();
    panel.onLockFlagsChange();
    assert.deepEqual(actions, [
      { actionKind: Layer.setLayerOpacity, layerPropertyValue: 128 },
      { actionKind: Layer.setFillOpacity, layerPropertyValue: 64 },
      {
        actionKind: Layer.toggleLayerLocks,
        layerPropertyValue: [[true, false, true, false], [0, 1, 2, 31]],
      },
    ]);
  });
});
