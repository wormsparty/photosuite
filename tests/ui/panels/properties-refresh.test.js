import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

const restore = installBrowserGlobals();
after(restore);
// The real form constructors render small gradient previews. Supply only the
// canvas surface; this suite asserts lifecycle/resource state, not rendering.
const createElement = document.createElement;
document.createElement = (tag) => {
  const element = createElement(tag);
  if (tag === "canvas") {
    const context = new Proxy({
      getImageData(x, y, width, height) {
        assert.ok(width * height <= 65536, "preview allocation must stay bounded");
        return { data: new Uint8ClampedArray(width * height * 4) };
      },
      measureText() { return { width: 10 }; },
    }, { get(target, key) { return key in target ? target[key] : () => {}; } });
    element.getContext = () => context;
    element.toDataURL = () => "data:image/png;base64,";
  }
  return element;
};

let PropertiesPanel, PopupTypes;
before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ PropertiesPanel } = await import("../../../src/ui/panels/properties-panel.js"));
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
});

function selectedDocument() {
  return {
    width: 8, height: 8, selectedLayerIndices: [0],
    layers: [{ add: {}, pixelContent: 0, pathLayerActive: false,
      hasSmartFilters: () => false, getMask: () => null }],
    getPaths: () => [[], []],
  };
}

function resources() {
  return { colorInt: 0x123456, bgColor: 0xffffff,
    gradientPresets: [], patternPresets: [], contourPresets: [] };
}

function captureRowUpdates(panel) {
  const calls = [];
  for (const row of [panel.layerSection.gradientFillRow, panel.layerSection.patternFillRow]) {
    const original = row.onUpdate;
    row.onUpdate = function(...args) { calls.push(args); return original.apply(this, args); };
  }
  return calls;
}

it("resource refresh preserves the selected document through real form rebuilding", () => {
  const panel = new PropertiesPanel();
  panel.initDom();
  const doc = selectedDocument(), appData = resources();
  panel.open(doc);
  const updates = captureRowUpdates(panel);
  panel.onUpdate(appData, PopupTypes.ALL);
  assert.doesNotThrow(() => panel.buildUI());
  assert.equal(panel.doc, doc);
  assert.equal(panel.previewDoc, doc);
  assert.equal(panel.layerSection.doc, doc);
  assert.equal(panel.maskSection.doc, doc);
  assert.deepEqual(updates, [[appData, PopupTypes.ALL], [appData, PopupTypes.ALL]]);
});

it("lazy initialization retains resource updates separately from the pending document", () => {
  const panel = new PropertiesPanel();
  const doc = selectedDocument(), appData = resources();
  panel.open(doc);
  panel.onUpdate(appData, PopupTypes.ALL);
  const updates = [];
  const originalInit = panel.initDom;
  panel.initDom = function() {
    originalInit.call(this);
    const formUpdate = this.layerSection.onUpdate;
    this.layerSection.onUpdate = function(...args) {
      updates.push(args);
      return formUpdate.apply(this, args);
    };
  };
  document.body.appendChild(panel.panelBody);
  assert.doesNotThrow(() => panel.refresh());
  assert.equal(panel.doc, doc);
  assert.equal(panel.previewDoc, doc);
  assert.deepEqual(updates, [[appData, PopupTypes.ALL]]);
});

it("resource updates with no open document rebuild safely without inventing a document", () => {
  const panel = new PropertiesPanel();
  panel.initDom();
  panel.open(null);
  panel.onUpdate(resources(), PopupTypes.ALL);
  assert.doesNotThrow(() => panel.buildUI());
  assert.equal(panel.doc, null);
  assert.equal(panel.previewDoc, null);
});
