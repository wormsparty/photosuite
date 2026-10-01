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


describe("XCF color modes and strict sample layouts", () => {
  for (const idSize of [4, 8]) {
    for (const [baseType, pixels, expected] of [[0, [23, 61, 107], [23, 61, 107, 255]],
      [1, [23, 61, 107, 127], [23, 61, 107, 127]], [2, [89], [89, 89, 89, 255]],
      [3, [89, 127], [89, 89, 89, 127]], [4, [1], [199, 151, 73, 255]],
      [5, [0, 127], [23, 61, 107, 127]]]) {
      it(`decodes base type ${baseType} exact RGBA (${idSize * 8}-bit offsets)`, () => {
        const doc = parse(fixture({ idSize, colorMode: Math.floor(baseType / 2), baseType, pixels }));
        assert.deepEqual(Array.from(doc.layers[0].buffer), expected);
      });
    }
    if (idSize === 8) for (const colorMode of [1, 2]) {
      it(`rejects unsupported multi-byte color mode ${colorMode} precision before decoding`, () => {
        assert.throws(() => parse(fixture({ idSize, colorMode, baseType: colorMode * 2, pixels: [0], precision: 250 })), /unsupported .* precision/);
      });
    }
    for (const options of [ { colorMode: 3 }, { colorMode: 1, baseType: 1 },
      { colorMode: 2, baseType: 4, pixels: [0], palette: null },
      { colorMode: 2, baseType: 4, pixels: [2] }, { colorMode: 2, baseType: 4, pixels: [0], palette: [] },
      { baseType: 1, pixels: [23, 61, 107], bpp: 3 } ]) {
      it(`rejects inconsistent color metadata ${JSON.stringify(options)} (${idSize * 8}-bit)`, () => {
        assert.throws(() => parse(fixture({ idSize, ...options })), /xcf:/);
      });
    }
  }
});
