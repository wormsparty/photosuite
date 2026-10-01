import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { fixture, parse as parseFixture } from "../../helpers/xcf-structure-fixture.js";
let XCFParser, Layer, LayerSectionType, restore;
before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
});
after(() => restore?.());
const parse = bytes => parseFixture(bytes, XCFParser, Layer, LayerSectionType);
describe("XCF unsupported precision rejection", () => {
  for (const version of [7, 10, 11]) it(`rejects development multi-byte precision in v${version}`, () => {
    assert.throws(() => parse(fixture({ idSize: version >= 11 ? 8 : 4, version, precision: 250 })), /unsupported development precision/);
  });
  for (const precision of [200, 300, 350, 500, 550, 650, 700, 750, 175, 999]) it(`rejects unimplemented precision ${precision} before constructing layers`, () => {
    const bytes = fixture({ idSize: 8, precision });
    const doc = { layers: [], newLayer() { assert.fail("precision must be rejected before layer creation"); } };
    assert.throws(() => XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc), /unsupported image precision/);
  });
});
