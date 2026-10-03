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
const floats = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatBE(v, i * 4)); return Array.from(b); };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
function channelFixture(precision, pixels, selection = true) {
  const header = Buffer.concat([Buffer.from("gimp xcf v012\0"), u32(1), u32(1), u32(0), u32(precision), u32(17), u32(1), Buffer.from([0]), Buffer.alloc(8)]);
  const channelOffset = header.length + 24;
  const channel = Buffer.concat([u32(1), u32(1), u32(5), Buffer.from("Tiny\0"), ...(selection ? [u32(4), u32(0)] : []), Buffer.alloc(8)]);
  const hierarchyOffset = channelOffset + channel.length + 8;
  const levelOffset = hierarchyOffset + 20;
  return Buffer.concat([header, u64(0), u64(channelOffset), u64(0), channel, u64(hierarchyOffset),
    u32(1), u32(1), u32(pixels.length), u64(levelOffset), u32(1), u32(1), u64(levelOffset + 24), u64(0), Buffer.from(pixels)]);
}
describe("XCF multibyte channel coverage", () => {
  it("converts float-linear RGB while alpha remains coverage", () => {
    assert.deepEqual(Array.from(parse(fixture({ idSize: 8, precision: 600, pixels: floats([0.25, 0.5, 0.75, 0.5]) })).layers[0].buffer), [137, 188, 225, 128]);
  });
  it("keeps float-linear layer mask samples as coverage", () => {
    const bytes = fixture({ idSize: 8, precision: 600, pixels: floats([0.25, 0.5, 0.75, 0.5]), mask: true, maskBpp: 4 });
    const patched = Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from(floats([0.5]))]);
    assert.equal(parse(patched).layers[0].d.channel[0], 128);
  });
  it("keeps float-linear selection samples as coverage", () => {
    assert.equal(parse(channelFixture(600, floats([0.5]))).selectionMask.channel[0], 128);
  });
  for (const [precision, pixels] of [[250, [0x80, 0x00]], [600, floats([0.5])]]) {
    it(`imports precision ${precision} saved-channel samples as coverage`, () => {
      const doc = parse(channelFixture(precision, pixels, false));
      assert.equal(doc.extraChannels.length, 1);
      assert.equal(doc.extraChannels[0].name, "Tiny");
      assert.equal(doc.extraChannels[0].channel[0], 128);
      assert.equal(doc.selectionMask, undefined);
    });
  }
});
