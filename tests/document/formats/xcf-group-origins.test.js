import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { stackFixture, parse as parseFixture } from "../../helpers/xcf-structure-fixture.js";
let XCFParser, Layer, LayerSectionType, restore;
before(async () => {
  restore = installBrowserGlobals();
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
});
after(() => restore?.());
const parse = options => parseFixture(stackFixture(options), XCFParser, Layer, LayerSectionType);
const geometry = mask => [mask.rect.x, mask.rect.y, mask.rect.width, mask.rect.height];
describe("XCF restored group mask origins", () => {
  for (const idSize of [4, 8]) for (const mode of [0, 61]) {
    for (const offsets of [[0, 0], [-4, -4], [4, 4]]) {
      it(`anchors ${mode} group to child at ${offsets} (${idSize * 8}-bit)`, () => {
        const doc = parse({ idSize, width: 3, height: 3, layers: [
          { group: true, mode, offsets: [1, 1], path: [0], maskWidth: 2, maskHeight: 2, maskPixels: [17, 61, 139, 233] },
          { offsets, width: 3, height: 3, path: [0, 0] },
        ] });
        const mask = doc.layers.at(-1).d;
        assert.deepEqual(geometry(mask), [...offsets, 2, 2]);
        const expected = offsets[0] === 0 ? [17, 61, 0, 139, 233, 0, 0, 0, 0] : Array(9).fill(0);
        assert.deepEqual(Array.from(mask.rasterizeTo(new Rect(0, 0, 3, 3)).subarray(0, 9)), expected);
        assert.deepEqual(Array.from(mask.channel.subarray(0, 4)), [17, 61, 139, 233]);
      });
    }
    it(`includes invisible descendants in union (${mode}, ${idSize * 8}-bit)`, () => {
      const doc = parse({ idSize, layers: [
        { group: true, mode, offsets: [7, 7], path: [0], maskPixels: [233] },
        { offsets: [2, 2], path: [0, 0] },
        { offsets: [-2, -3], visible: false, path: [0, 1] },
      ] });
      assert.deepEqual(geometry(doc.layers.at(-1).d), [-2, -3, 1, 1]);
    });
    it(`resolves nested groups before outer masks (${mode}, ${idSize * 8}-bit)`, () => {
      const doc = parse({ idSize, layers: [
        { group: true, mode, offsets: [7, 7], path: [0], maskPixels: [233] },
        { group: true, offsets: [9, 9], path: [0, 0], maskPixels: [139] },
        { offsets: [-2, 3], path: [0, 0, 0] },
        { group: true, offsets: [-9, -9], path: [0, 1] },
      ] });
      const groups = doc.layers.filter(layer => layer.isGroup() && layer.d);
      assert.equal(groups.length, 2);
      for (const group of groups) assert.deepEqual(geometry(group.d), [-2, 3, 1, 1]);
    });
    it(`retains ordinary raster mask origin (${mode}, ${idSize * 8}-bit)`, () => {
      const doc = parse({ idSize, layers: [{ offsets: [-2, 3], maskPixels: [233] }] });
      assert.deepEqual(geometry(doc.layers[0].d), [-2, 3, 1, 1]);
    });
    it(`includes nonempty group's fallback bounds (${mode}, ${idSize * 8}-bit)`, () => {
      const doc = parse({ idSize, layers: [
        { group: true, mode, offsets: [7, 7], path: [0], maskPixels: [233], applyMask: false },
        { group: true, path: [0, 0] },
        { group: true, path: [0, 0, 0] },
        { offsets: [2, 3], path: [0, 1] },
      ] });
      assert.deepEqual(geometry(doc.layers.at(-1).d), [0, 0, 1, 1]);
      assert.equal(doc.layers.at(-1).d.isEnabled, false);
    });
    it(`uses origin zero for empty groups (${mode}, ${idSize * 8}-bit)`, () => {
      const doc = parse({ idSize, layers: [{ group: true, mode, offsets: [7, 7], maskPixels: [233] }] });
      assert.deepEqual(geometry(doc.layers.at(-1).d), [0, 0, 1, 1]);
    });
  }
});
