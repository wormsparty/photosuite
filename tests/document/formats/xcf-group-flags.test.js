import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { stackFixture, parse as parseFixture } from "../../helpers/xcf-structure-fixture.js";
let XCFParser, Layer, LayerSectionType, restore;
before(async () => {
  restore = installBrowserGlobals(); globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
});
after(() => restore?.());
const parse = options => parseFixture(stackFixture(options), XCFParser, Layer, LayerSectionType);
describe("XCF group flag ownership", () => {
  for (const idSize of [4, 8]) {
    for (const flags of [0, 1]) {
      it(`rejects raster group flags ${flags} (${idSize * 8}-bit)`, () => {
        assert.throws(() => parse({ idSize, layers: [{ flags }] }), /group flags without group item/);
      });
    }
  }
});
