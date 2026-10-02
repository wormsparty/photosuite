/**
 * Golden I/O for gradient / contour dialog helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let GradientEditorDialog;

before(async () => {
  ({ GradientEditorDialog } = await import("../../../src/ui/dialogs/gradient-contour-dialogs.js"));
});

describe("ui/dialogs/gradient-contour-dialogs.js", () => {
  it("compareGradientStopsByLocation sorts by Lctn wire key", () => {
    const cmp = GradientEditorDialog.prototype.compareGradientStopsByLocation;
    assert.equal(cmp({ v: { Lctn: { v: 10 } } }, { v: { Lctn: { v: 20 } } }), -10);
    assert.equal(cmp({ v: { Lctn: { v: 20 } } }, { v: { Lctn: { v: 10 } } }), 10);
    assert.equal(cmp({ v: { Lctn: { v: 5 } } }, { v: { Lctn: { v: 5 } } }), 0);
  });

  it("stores typed fractional midpoints as descriptor integers", () => {
    const stop = () => ({ v: { Lctn: { v: 0 }, Mdpn: { v: 50 } } });
    const dialog = {
      storedValue: { Intr: { v: 4096 }, Trns: { v: [stop(), stop()] }, Clrs: { v: [stop(), stop()] } },
      smoothnessSlider: { getValue: () => 100 },
      selectedTransparencyStopWrapper: null,
      selectedColorStopWrapper: null,
      activeTransparencyMidpointIndex: 1,
      activeColorMidpointIndex: 1,
      transparencyStopPositionSlider: { getValue: () => 33.6 },
      colorStopPositionSlider: { getValue: () => 12.4 },
      redraw() {},
    };
    GradientEditorDialog.prototype.onGradientWidgetChanged.call(dialog, { target: null });
    assert.equal(dialog.storedValue.Trns.v[1].v.Mdpn.v, 34);
    assert.equal(dialog.storedValue.Clrs.v[1].v.Mdpn.v, 12);
  });
});
