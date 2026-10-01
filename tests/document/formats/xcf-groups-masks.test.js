import assert from "node:assert/strict";
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
import { fixture, parse as parseFixture } from "../../helpers/xcf-structure-fixture.js";
const parse = bytes => parseFixture(bytes, XCFParser, Layer, LayerSectionType);

describe("XCF attached layer and group masks", () => {
  for (const idSize of [4, 8]) {
    for (const group of [false, true]) for (const applyMask of [false, true]) {
      it(`retains ${group ? "group" : "layer"} mask pixels, offsets and enabled=${applyMask} (${idSize * 8}-bit)`, () => {
        const layer = parse(fixture({ idSize, group, mask: true, applyMask })).layers.at(-1);
        assert.ok(layer.d); assert.deepEqual(Array.from(layer.d.channel.subarray(0, 1)), [89]);
        assert.deepEqual([layer.d.rect.x, layer.d.rect.y, layer.d.rect.width, layer.d.rect.height], [3, 5, 1, 1]);
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
