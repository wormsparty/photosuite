import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Rect } from "../../../src/core/math/rect.js";
import { CAMERA_RAW_SECTIONS, collectCameraRawScalars, createCameraRawDefaultDescriptor, RAW_SLIDER_RANGES } from "../../../src/features/filters/camera-raw-descriptor.js";
const restore = installBrowserGlobals();
after(restore);
let FilterParameterPanel, computePreferredCameraRawDialogSize;
before(async () => {
  ({ FilterParameterPanel } = await import("../../../src/ui/filter-panels/filter-parameter-panel.js"));
  ({ computePreferredCameraRawDialogSize } = await import("../../../src/ui/filter-panels/camera-raw-panel.js"));
});
function element(className = "") {
  return { className, style: {}, getAttribute(key) { return key === "class" ? this.className : null; }, setAttribute(key, value) { if (key === "class") this.className = value; } };
}
function widget(value = 0) {
  return { value, el: element(), rangeEl: { removeAttribute(key) { delete this[key]; } }, getValue() { return this.value; }, setValue(value) { this.value = value; }, setDecimalPlaces(value) { this.decimals = value; } };
}
function panel() {
  const result = Object.create(FilterParameterPanel.cameraRaw.prototype);
  const defaults = collectCameraRawScalars(createCameraRawDefaultDescriptor());
  result.widgetsByKey = {};
  for (const section of CAMERA_RAW_SECTIONS) for (const group of section.groups || []) for (const spec of group.sliders) result.widgetsByKey[spec.key] = widget(defaults[spec.key]);
  result.sectionEnabled = {};
  result.sectionButtonsByKey = {};
  result.sectionElementsByKey = {};
  for (const section of CAMERA_RAW_SECTIONS) {
    result.sectionEnabled[section.enableKey] = true;
    result.sectionButtonsByKey[section.enableKey] = element();
    result.sectionElementsByKey[section.enableKey] = element();
  }
  result.geometryButtons = { 0: element(), 1: element() };
  result.whiteBalanceDropdown = widget(0);
  result.processDropdown = widget(0);
  result.redraw = () => { result.redraws = (result.redraws || 0) + 1; };
  result.refresh = () => { result.refreshes = (result.refreshes || 0) + 1; };
  return result;
}
it("loads and saves every slider and section flag with independent source/preview buffers", () => {
  const instance = panel();
  const descriptor = createCameraRawDefaultDescriptor();
  descriptor.Temp.v = 42;
  descriptor.Ex12.v = 1.5;
  const sectionKey = CAMERA_RAW_SECTIONS[0].enableKey;
  descriptor[sectionKey].v = false;
  const source = new Uint8Array([120, 80, 40, 255]);
  const rect = new Rect(7, 9, 1, 1);
  instance.setValue(descriptor, source, rect);
  assert.deepEqual(collectCameraRawScalars(instance.getValue()), collectCameraRawScalars(descriptor));
  assert.equal(instance.sourceBuffer, source);
  assert.notEqual(instance.previewBuffer, source);
  assert.deepEqual(instance.previewBuffer, source);
  assert.deepEqual(instance.previewRect, new Rect(0, 0, 1, 1));
  assert.deepEqual(rect, new Rect(7, 9, 1, 1));
  assert.equal(instance.redraws, 1);
});
it("bypasses a section while retaining its slider values and allowing re-enabling", () => {
  const instance = panel();
  const key = CAMERA_RAW_SECTIONS[0].enableKey;
  instance.widgetsByKey.Temp.setValue(35);
  instance.setSectionEnabled(key, false);
  assert.equal(collectCameraRawScalars(instance.getValue())[key], false);
  assert.match(instance.sectionElementsByKey[key].className, /camera-raw-section-off/);
  assert.match(instance.sectionButtonsByKey[key].className, /bypassed/);
  instance.setSectionEnabled(key, true);
  assert.equal(instance.widgetsByKey.Temp.getValue(), 35);
  assert.equal(collectCameraRawScalars(instance.getValue())[key], true);
  assert.doesNotMatch(instance.sectionElementsByKey[key].className, /camera-raw-section-off/);
});
it("manual temperature/tint changes select Custom while other sliders preserve the white-balance mode", () => {
  const instance = panel();
  instance.setWhiteBalanceEnum("AsSh");
  instance.onSliderChanged({ target: instance.widgetsByKey.Ex12 });
  assert.equal(instance.activeWhiteBalance, "AsSh");
  instance.onSliderChanged({ target: instance.widgetsByKey.Temp });
  assert.equal(instance.activeWhiteBalance, "Cst");
  instance.setWhiteBalanceEnum("Auto");
  instance.onSliderChanged({ target: instance.widgetsByKey.Tint });
  assert.equal(instance.activeWhiteBalance, "Cst");
  assert.equal(instance.refreshes, 3);
});
it("retunes Raw controls, uses camera presets, and releases buffers on returning to Filter mode", () => {
  const instance = panel();
  const source = { asShot: [5200, 12], auto: [6000, 5], previewLinear: { linearRgbBuffer: new Float32Array(3), rawWidth: 1, rawHeight: 1 } };
  instance.setRawSource(source);
  for (const key in RAW_SLIDER_RANGES) {
    const control = instance.widgetsByKey[key], range = RAW_SLIDER_RANGES[key];
    assert.equal(control.minValue, range.min);
    assert.equal(control.maxValue, range.max);
    assert.equal(control.decimals, range.decimals);
    assert.ok(control.getValue() >= range.min && control.getValue() <= range.max);
  }
  assert.equal(collectCameraRawScalars(instance.getValue()).CMod, "Raw");
  assert.deepEqual(instance.resolveWhiteBalancePreset("AsSh"), [5200, 12]);
  assert.deepEqual(instance.resolveWhiteBalancePreset("Auto"), [6000, 5]);
  instance.setTemperatureAndTint(5200, 12);
  instance.widgetsByKey.Ex12.setValue(1.5);
  assert.deepEqual(instance.readRawDecoderSettings(), [5200, 12, 1.5, 0]);
  instance.sourceBuffer = instance.previewBuffer = new Uint8Array(4);
  instance.previewRect = new Rect(0, 0, 1, 1);
  instance.releaseRawSource();
  assert.equal(instance.rawSource, null);
  assert.equal(instance.sourceBuffer, null);
  assert.equal(instance.previewBuffer, null);
  assert.equal(instance.previewRect, null);
  assert.equal(instance.widgetsByKey.Temp.minValue, -100);
  assert.equal(instance.widgetsByKey.Temp.maxValue, 100);
  assert.equal(collectCameraRawScalars(instance.getValue()).CMod, "Filter");
});
it("samples the undeveloped plate, clamps an off-canvas eyedropper, and turns sampling off", () => {
  const instance = panel();
  instance.eyedropperActive = true;
  instance.eyedropperBtn = element("selected");
  instance.sourceBuffer = new Uint8Array([100, 150, 200, 255, 220, 100, 50, 255]);
  instance.previewRect = new Rect(0, 0, 2, 1);
  const dispatched = [];
  instance.view = { el: { style: {} }, pointerToDocPoint: () => ({ x: 500, y: -3 }), setPointerEventsDispatched: (value) => dispatched.push(value) };
  let sample;
  instance.applyNeutralSample = (...channels) => { sample = channels; };
  instance.onPreviewPointerDown();
  assert.deepEqual(sample, [220 / 255, 100 / 255, 50 / 255]);
  assert.equal(instance.activeWhiteBalance, "Cst");
  assert.equal(instance.eyedropperActive, false);
  assert.deepEqual(dispatched, [false]);
  assert.equal(instance.refreshes, 1);
});
it("Auto white balance ignores transparent samples and leaves an empty plate unchanged", () => {
  const instance = panel();
  instance.setTemperatureAndTint(12, 7);
  instance.sourceBuffer = new Uint8Array([255, 0, 0, 0]);
  instance.applyAutoWhiteBalance();
  assert.deepEqual([instance.widgetsByKey.Temp.getValue(), instance.widgetsByKey.Tint.getValue()], [12, 7]);
});
it("fits the available dialog area and resizes the preview with a bounded minimum", () => {
  assert.deepEqual(computePreferredCameraRawDialogSize(600, 400), { width: 600, height: 400 });
  assert.deepEqual(computePreferredCameraRawDialogSize(2000, 1500), { width: 1320, height: 940 });
  const instance = panel(), sizes = [];
  instance.view = { frameSources: [], resize: (...args) => sizes.push(args), fitToBounds: () => sizes.push("fit") };
  instance.resize(400, 80);
  assert.deepEqual(sizes, [[240, 120], "fit"]);
  assert.equal(instance.needsPreviewFit, false);
});
