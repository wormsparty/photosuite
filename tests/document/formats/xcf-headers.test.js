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

describe("XCF file signature and supported version validation", () => {
  for (const version of [27, 99, 100, 999]) {
    it(`rejects undocumented or incompatible v${version}`, () => {
      assert.throws(() => parse(fixture({ version, idSize: 8 })), /unsupported file version/);
    });
  }
  for (const [label, offset, value] of [["magic", 0, 0], ["version prefix", 9, 120],
    ["version digit", 10, 120], ["version terminator", 13, 1]]) {
    it(`rejects malformed ${label} before changing document metadata`, () => {
      const bytes = fixture(); bytes[offset] = value;
      const doc = { width: 7, height: 9, layers: [] };
      assert.throws(() => XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc), /invalid (file signature|version tag)/);
      assert.equal(doc.width, 7); assert.equal(doc.height, 9);
      assert.deepEqual(doc.layers, []);
    });
  }
});
