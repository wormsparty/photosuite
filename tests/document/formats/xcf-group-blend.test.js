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

describe("XCF group blend and expansion", () => {
  for (const idSize of [4, 8]) {
    for (const [mode, expected] of [[0, "norm"], [28, "norm"], [61, "pass"], [3, "mul "]]) {
      it(`preserves group blend ${mode} (${idSize * 8}-bit)`, () => {
        const layer = parse(fixture({ idSize, group: true, mode })).layers.at(-1);
        assert.equal(layer.blendMode, expected);
      });
    }
    for (const flags of [0, 1, 2, 3]) {
      it(`preserves group expanded flag ${flags} (${idSize * 8}-bit)`, () => {
        const layer = parse(fixture({ idSize, group: true, flags })).layers.at(-1);
        assert.equal(layer.add.lsct, flags & 1 ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup);
      });
    }
  }
});
