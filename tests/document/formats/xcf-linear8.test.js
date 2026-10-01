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
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
function selectionFixture(precision, pixels) {
  const header = Buffer.concat([Buffer.from("gimp xcf v012\0"), u32(1), u32(1), u32(0), u32(precision), u32(17), u32(1), Buffer.from([0]), Buffer.alloc(8)]);
  const channelOffset = header.length + 24;
  const channel = Buffer.concat([u32(1), u32(1), u32(5), Buffer.from("Tiny\0"), u32(4), u32(0), Buffer.alloc(8)]);
  const hierarchyOffset = channelOffset + channel.length + 8;
  const levelOffset = hierarchyOffset + 20;
  return Buffer.concat([header, u64(0), u64(channelOffset), u64(0), channel, u64(hierarchyOffset),
    u32(1), u32(1), u32(pixels.length), u64(levelOffset), u32(1), u32(1), u64(levelOffset + 24), u64(0), Buffer.from(pixels)]);
}
describe("XCF linear8 color semantics", () => {
  for (const baseType of [1, 3]) it(`converts linear8 color without converting alpha for type ${baseType}`, () => {
    const pixels = baseType === 1 ? [64, 128, 192, 128] : [128, 128];
    const expected = baseType === 1 ? [137, 188, 225, 128] : [188, 188, 188, 128];
    const doc = parse(fixture({ idSize: 8, precision: 100, colorMode: Math.floor(baseType / 2), baseType, pixels, mask: true }));
    assert.deepEqual(Array.from(doc.layers[0].buffer), expected);
    assert.equal(doc.layers[0].d.channel[0], 89);
  });
  it("keeps legacy implicit gamma8 pixels unchanged", () => {
    assert.deepEqual(Array.from(parse(fixture({ precision: 100 })).layers[0].buffer), [23, 61, 107, 255]);
  });
  it("keeps palette indices and palette colors independent of linear8 transfer", () => {
    assert.deepEqual(Array.from(parse(fixture({ idSize: 8, precision: 100, colorMode: 2, baseType: 5, pixels: [1, 128] })).layers[0].buffer), [199, 151, 73, 128]);
  });
  it("keeps linear8 selection samples as coverage", () => {
    assert.equal(parse(selectionFixture(100, [128])).selectionMask.channel[0], 128);
  });
});
