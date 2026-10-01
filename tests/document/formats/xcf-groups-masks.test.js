import assert from "node:assert/strict";
import { Rect } from "../../../src/core/math/rect.js";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, Layer, LayerSectionType, restore;
before(async () => {
  restore = installBrowserGlobals();
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
});
after(() => restore?.());
import { fixture, stackFixture, parse as parseFixture } from "../../helpers/xcf-structure-fixture.js";
const parse = bytes => parseFixture(bytes, XCFParser, Layer, LayerSectionType);
// Nonempty groups derive their origin from children, as GIMP restores sizing
// before attaching masks. Keep offset controls distinct from empty-group cases.
const maskFixture = options => options.group ? stackFixture({ idSize: options.idSize, layers: [
  { ...options, maskPixels: options.maskPixels, path: [0] },
  { offsets: options.offsets, width: options.width, height: options.height, pixels: options.pixels, path: [0, 0] },
] }) : fixture(options);

describe("XCF attached layer and group masks", () => {
  for (const idSize of [4, 8]) {
    for (const group of [false, true]) for (const applyMask of [false, true]) {
      it(`retains ${group ? "group" : "layer"} mask pixels, offsets and enabled=${applyMask} (${idSize * 8}-bit)`, () => {
        const layer = parse(fixture({ idSize, group, mask: true, applyMask })).layers.at(-1);
        assert.ok(layer.d); assert.deepEqual(Array.from(layer.d.channel.subarray(0, 1)), [89]);
        assert.deepEqual([layer.d.rect.x, layer.d.rect.y, layer.d.rect.width, layer.d.rect.height], [...(group ? [0, 0] : [3, 5]), 1, 1]);
        assert.equal(layer.d.isEnabled, applyMask);
      });
    }
    for (const group of [false, true]) {
      it(`rejects multichannel ${group ? "group" : "layer"} mask (${idSize * 8}-bit)`, () => {
        assert.throws(() => parse(fixture({ idSize, group, mask: true, maskBpp: 2 })), /pixel channel type mismatch/);
      });
    }
  }
});

// Independent mask samples make row/column swaps and coordinate clipping visible.
describe("XCF attached mask document alignment", () => {
  for (const idSize of [4, 8]) for (const group of [false, true]) {
    for (const offsets of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      it(`rasterizes ${group ? "group" : "raster"} mask at ${offsets} (${idSize * 8}-bit)`, () => {
        const samples = [17, 61, 139, 233];
        const layer = parse(maskFixture({ idSize, group, mask: true, offsets, width: 2, height: 2,
          pixels: Array(4).fill([23, 61, 107, 255]).flat(), bpp: 4, maskPixels: samples })).layers.at(-1);
        assert.deepEqual(Array.from(layer.d.channel.subarray(0, 4)), samples);
        assert.deepEqual([layer.d.rect.x, layer.d.rect.y, layer.d.rect.width, layer.d.rect.height], [...offsets, 2, 2]);
        const expected = [];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
          const localX = x - offsets[0], localY = y - offsets[1];
          expected.push(localX >= 0 && localX < 2 && localY >= 0 && localY < 2 ? samples[localY * 2 + localX] : 0);
        }
        assert.deepEqual(Array.from(layer.d.rasterizeTo(new Rect(0, 0, 3, 3)).subarray(0, 9)), expected);
        assert.deepEqual(Array.from(layer.d.rasterizeTo(layer.d.rect).subarray(0, 4)), samples);
      });
    }
    if (!group) it(`rejects equal-area wrong-shape raster mask (${idSize * 8}-bit)`, () => {
      assert.throws(() => parse(fixture({ idSize, group, mask: true, width: 2, height: 1,
        pixels: [23, 61, 107, 255, 73, 97, 151, 255], bpp: 4, maskWidth: 1, maskHeight: 2,
        maskPixels: [17, 233] })), /channel dimensions mismatch/);
    });
  }
});

describe("XCF group masks with independent stored dimensions", () => {
  for (const idSize of [4, 8]) for (const offsets of [[1, 1], [-1, -1]]) {
    for (const [maskWidth, maskHeight, samples] of [[1, 1, [233]], [1, 2, [17, 233]], [3, 1, [17, 139, 233]]]) {
      it(`retains ${maskWidth}×${maskHeight} group mask on 2×1 header at ${offsets} (${idSize * 8}-bit)`, () => {
        const layer = parse(maskFixture({ idSize, group: true, mask: true, offsets, width: 2, height: 1,
          pixels: [23, 61, 107, 255, 73, 97, 151, 255], bpp: 4, maskWidth, maskHeight,
          maskPixels: samples })).layers.at(-1);
        assert.deepEqual([layer.d.rect.x, layer.d.rect.y, layer.d.rect.width, layer.d.rect.height],
          [...offsets, maskWidth, maskHeight]);
        assert.deepEqual(Array.from(layer.d.channel.subarray(0, samples.length)), samples);
        assert.deepEqual(Array.from(layer.d.rasterizeTo(layer.d.rect).subarray(0, samples.length)), samples);
      });
    }
  }
});
