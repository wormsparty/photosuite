/**
 * Colour distance and sampling goldens for the wand's flood select.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let colorDistance;
let floodSelectMask;
let minColorDistance;
let readSampleColors;
let sampleSelectionAtPoint;

before(async () => {
  ({ colorDistance, floodSelectMask, minColorDistance, readSampleColors, sampleSelectionAtPoint } = await import(
    "../../../src/document/tools/flood-select.js"
  ));
});

describe("document/tools/flood-select.js", () => {
  // Distance is the widest single-channel gap, so one badly mismatched channel
  // is enough to put a pixel outside the tolerance.
  it("colorDistance takes the largest channel difference", () => {
    const packed = (255 << 24) | (10 << 16) | (20 << 8) | 30;
    assert.equal(colorDistance(packed, [30, 20, 10, 255]), 0);
    assert.equal(colorDistance(packed, [0, 0, 0, 255]), 30);
    assert.equal(colorDistance(packed, [0, 0, 0, 0]), 255);
  });

  // Several sampled colours widen the selection: a pixel need only be near one.
  it("minColorDistance takes the nearest of the sampled colours", () => {
    const packed = (255 << 24) | (10 << 16) | (20 << 8) | 30;
    assert.equal(minColorDistance(packed, [[0, 0, 0, 0], [30, 20, 10, 255]]), 0);
  });

  // A sample point sits at a pixel centre, so 0.5 reads the pixel at 0.
  it("readSampleColors reads the pixel under each sample point", () => {
    const buffer = new Uint8ClampedArray(4 * 4);
    buffer[0] = 1;
    buffer[1] = 2;
    buffer[2] = 3;
    buffer[3] = 255;
    assert.deepEqual(
      readSampleColors(buffer, new Rect(0, 0, 2, 2), [new Point(0.5, 0.5)]),
      [[1, 2, 3, 255]],
    );
  });

  it("ignores a sample exactly on the right or bottom canvas edge", () => {
    const buffer = new Uint8ClampedArray(2 * 2 * 4);
    buffer.fill(255);
    const doc = {
      width: 2,
      height: 2,
      selectedLayerIndices: [0],
      layers: [{ pixelContent: 0, add: { lsct: null }, rect: new Rect(0, 0, 2, 2), buffer }],
    };
    assert.equal(sampleSelectionAtPoint(doc, new Point(2, 0), [0, false, true]), null);
    assert.equal(sampleSelectionAtPoint(doc, new Point(0, 2), [0, false, true]), null);
  });

  it("applies tolerance inclusively and fades only the next band when anti-aliasing", () => {
    const buffer = new Uint8ClampedArray(4 * 4);
    for (let x = 0; x < 4; x++) {
      const value = [0, 16, 17, 32][x];
      buffer.set([value, value, value, 255], x * 4);
    }
    const rect = new Rect(0, 0, 4, 1);
    const point = new Point(0.5, 0.5);
    for (const contiguous of [false, true]) {
      assert.deepEqual([...floodSelectMask(buffer, rect, point, null, [0, true, contiguous])], [255, 0, 0, 0]);
      assert.deepEqual([...floodSelectMask(buffer, rect, point, null, [16, false, contiguous])], [255, 255, 0, 0]);
      assert.deepEqual([...floodSelectMask(buffer, rect, point, null, [16, true, contiguous])], [255, 255, 239, 0]);
      assert.deepEqual([...floodSelectMask(buffer, rect, point, null, [32, false, contiguous])], [255, 255, 255, 255]);
    }
  });
});
