import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { fixture, parse as parseFixture } from "../../helpers/xcf-structure-fixture.js";

let XCFParser, Layer, LayerSectionType, restore;
before(async () => {
  restore = installBrowserGlobals();
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
});
after(() => restore?.());
const parse = bytes => parseFixture(bytes, XCFParser, Layer, LayerSectionType);

describe("XCF version headers and canonical pointer widths", () => {
  for (const version of [0, 1, 2, 3, 7, 8, 9, 10, 11, 12, 26]) {
    it(`decodes v${version} layer, hierarchy, tile and mask offsets with exact pixels`, () => {
      const doc = parse(fixture({ version, idSize: version >= 11 ? 8 : 4, precision: 150, mask: true }));
      assert.equal(doc.width, 1);
      assert.equal(doc.height, 1);
      assert.equal(doc.layers.length, 1);
      assert.deepEqual(Array.from(doc.layers[0].buffer), [23, 61, 107, 255]);
      assert.equal(doc.layers[0].d.channel[0], 89);
    });
  }
  for (const [version, precision] of [[4, 0], [5, 150], [6, 150]]) {
    it(`rejects unsupported development v${version} before constructing layers`, () => {
      const doc = { layers: [], newLayer() { assert.fail("must reject before constructing a layer"); } };
      const bytes = fixture({ version, precision });
      assert.throws(() => XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc), /unsupported development version/);
    });
  }
});
