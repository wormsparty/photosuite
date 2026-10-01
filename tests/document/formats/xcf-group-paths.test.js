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
describe("XCF group topology", () => {
  for (const idSize of [4, 8]) {
    for (const path of [[0, 0], [0, 0, 0]]) {
      it(`rejects orphan depth ${path.length - 1} (${idSize * 8}-bit)`, () => {
        assert.throws(() => parse({ idSize, layers: [{ path }] }), /invalid group parent path/);
      });
    }
    it(`rejects skipped group depth (${idSize * 8}-bit)`, () => {
      assert.throws(() => parse({ idSize, layers: [{ group: true }, { path: [0, 0, 0] }] }), /invalid group parent path/);
    });
    it(`rejects incorrect parent index (${idSize * 8}-bit)`, () => {
      assert.throws(() => parse({ idSize, layers: [{ group: true }, { path: [1, 0] }] }), /invalid group parent path/);
    });
    it(`retains two nested groups, sibling and root closures (${idSize * 8}-bit)`, () => {
      const doc = parse({ idSize, layers: [
        { group: true, flags: 1, path: [0], title: "outer" },
        { group: true, flags: 0, path: [0, 0], title: "inner" },
        { path: [0, 0, 0], title: "child" }, { path: [0, 1], title: "sibling" },
        { path: [1], title: "root" },
      ] });
      assert.deepEqual(doc.layers.map(layer => layer.add.lsct || 0), [0, 3, 0, 3, 0, 2, 1]);
      assert.equal(doc.layers.filter(layer => layer.isGroup()).length, 2);
      for (const layer of doc.layers.filter(layer => layer.hasPixelData())) {
        assert.deepEqual(Array.from(layer.buffer), [23, 61, 107, 255]);
      }
      assert.equal(doc.openGroupPaths, undefined);
    });
  }
});
