import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
let PrintDialog;
before(async () => {
  ({ PrintDialog } = await import("../../../src/ui/dialogs/print-dialog.js"));
});

function dropdown(value = 0) {
  return {
    value, items: [],
    getValue() { return this.value; },
    setValue(next) { this.value = next; },
    setItems(items) { this.items = items; },
  };
}

function printer(id, overrides = {}) {
  return {
    id, name: id, isDefault: false, papers: [], defaultPaperId: null,
    duplexModes: ["none", "long", "short"], colorModes: ["color", "mono"],
    qualities: ["draft", "normal", "high"], ...overrides,
  };
}

function dialog(printers = []) {
  return Object.assign(Object.create(PrintDialog.prototype), {
    printers, printerDropdown: dropdown(), paperDropdown: dropdown(),
    duplexDropdown: dropdown(), colorDropdown: dropdown(), qualityDropdown: dropdown(),
    duplexKeys: ["none", "long", "short"], colorKeys: ["color", "mono"],
    qualityKeys: ["draft", "normal", "high"], refreshCount: 0,
    refresh() { this.refreshCount++; },
  });
}

describe("print dialog printer capabilities", () => {
  it("selects the system default and provides paper fallbacks for an offline queue", () => {
    const instance = dialog();
    instance.applyPrinters([printer("first"), printer("default", { isDefault: true })], null);
    assert.equal(instance.selectedPrinter().id, "default");
    assert.equal(instance.papers.length, 9);
    assert.ok(instance.papers[instance.paperDropdown.getValue()].label.startsWith("A4"));
    assert.equal(instance.refreshCount, 1);
  });

  it("retains a selected paper when a second queue offers the same size", () => {
    const papers = [
      { id: "custom_small_100x100mm", widthPt: 100, heightPt: 100 },
      { id: "custom_large_200x200mm", widthPt: 200, heightPt: 200 },
    ];
    const instance = dialog([printer("queue", { papers })]);
    instance.selectedPaperId = papers[1].id;
    instance.onPrinterChange();
    assert.equal(instance.papers[instance.paperDropdown.getValue()].id, papers[1].id);
  });

  it("retains supported duplex, monochrome and quality choices when switching printers", () => {
    const instance = dialog([printer("other", {
      duplexModes: ["none", "short", "long"],
      colorModes: ["mono", "color"], qualities: ["high", "normal"],
    })]);
    instance.duplexDropdown.setValue(1);
    instance.colorDropdown.setValue(1);
    instance.qualityDropdown.setValue(2);
    instance.onPrinterChange();
    assert.equal(instance.duplexKeys[instance.duplexDropdown.getValue()], "long");
    assert.equal(instance.colorKeys[instance.colorDropdown.getValue()], "mono");
    assert.equal(instance.qualityKeys[instance.qualityDropdown.getValue()], "high");
  });

  it("falls back to supported defaults when the new queue cannot honor previous settings", () => {
    const instance = dialog([printer("simple", {
      duplexModes: ["none"], colorModes: ["color"], qualities: ["normal"],
    })]);
    instance.duplexDropdown.setValue(2);
    instance.colorDropdown.setValue(1);
    instance.qualityDropdown.setValue(2);
    instance.onPrinterChange();
    assert.equal(instance.duplexDropdown.getValue(), 0);
    assert.equal(instance.colorDropdown.getValue(), 0);
    assert.equal(instance.qualityDropdown.getValue(), 0);
  });

  it("keeps the dialog usable with an empty printer list and its warning", () => {
    const instance = dialog();
    instance.applyPrinters([], "CUPS unavailable");
    assert.equal(instance.selectedPrinter(), null);
    assert.equal(instance.listingWarning, "CUPS unavailable");
    assert.ok(instance.papers.length > 0);
    assert.deepEqual(instance.duplexKeys, ["none"]);
  });

  it("bounds the initial print workspace to the available content area", () => {
    const instance = dialog();
    assert.deepEqual(instance.getPreferredContentSize(640, 400), { width: 640, height: 400 });
    assert.deepEqual(instance.getPreferredContentSize(2000, 1400), { width: 1100, height: 860 });
    assert.equal(instance.canOpen(null), false);
    assert.equal(instance.canOpen({ width: 10, height: 10 }), true);
  });
});
