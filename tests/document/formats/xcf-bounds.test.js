import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, Layer, restoreBrowserGlobals;
before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});
after(() => restoreBrowserGlobals?.());

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; };
const end = Buffer.alloc(8);
const property = (type, bytes) => Buffer.concat([u32(type), u32(bytes.length), bytes]);

// Independent tiny fixtures use no application encoder. Dimensions stay at most 3×1.
function fixture({ width = 1, idSize = 4, layerProperties = Buffer.alloc(0), tile = Buffer.from([0, 23, 0, 61, 0, 107, 0, 255]) } = {}) {
  const id = idSize == 4 ? u32 : u64;
  const name = Buffer.from("Tiny\0");
  const header = Buffer.concat([Buffer.from(idSize == 4 ? "gimp xcf v003\0" : "gimp xcf v012\0"), u32(width), u32(1), u32(0),
    ...(idSize == 8 ? [u32(100)] : []), property(17, Buffer.from([1])), end]);
  const layerOffset = header.length + 3 * idSize;
  const layerNameOffset = layerOffset + 12;
  const layerPropertyOffset = layerNameOffset + 4 + name.length;
  const hierarchyPointerOffset = layerPropertyOffset + layerProperties.length + 8;
  const hierarchyOffset = hierarchyPointerOffset + 2 * idSize;
  const levelOffset = hierarchyOffset + 12 + idSize;
  const tilePointerOffset = levelOffset + 8;
  const tileOffset = tilePointerOffset + 2 * idSize;
  const bytes = Buffer.concat([header, id(layerOffset), id(0), id(0), u32(width), u32(1), u32(1), u32(name.length), name,
    layerProperties, end, id(hierarchyOffset), id(0), u32(width), u32(1), u32(4), id(levelOffset),
    u32(width), u32(1), id(tileOffset), id(0), tile]);
  return { bytes, header, id, idSize, layerOffset, layerNameOffset, layerPropertyOffset, hierarchyPointerOffset, hierarchyOffset, levelOffset, tilePointerOffset, tileOffset };
}
function parse(bytes) {
  const doc = { layers: [], createdLayers: [], newLayer() { const layer = new Layer(); this.createdLayers.push(layer); return layer; } };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  return doc;
}
function rejects(bytes, message = /xcf:/) { assert.throws(() => parse(bytes), message); }

describe("XCF bounded binary metadata (malformed controls are after-only)", () => {
  for (const idSize of [4, 8]) {
    it(`imports canonical ${idSize * 8}-bit offsets and exact RGBA pixels`, () => {
      const doc = parse(fixture({ idSize }).bytes);
      assert.equal(doc.width, 1); assert.equal(doc.height, 1);
      assert.deepEqual(doc.layers.map(layer => layer.getName()), ["Tiny"]);
      assert.deepEqual(Array.from(doc.layers[0].buffer), [23, 61, 107, 255]);
    });
    it(`rejects every truncated metadata prefix with ${idSize * 8}-bit offsets`, () => {
      const { bytes, tileOffset } = fixture({ idSize });
      for (let length = 0; length <= tileOffset; length++) rejects(bytes.subarray(0, length));
    });
    it(`rejects missing/partial ID terminators and out-of-file ${idSize * 8}-bit offsets`, () => {
      const { bytes, header, id, idSize: width } = fixture({ idSize });
      rejects(Buffer.concat([header, id(header.length)]));
      rejects(Buffer.concat([header, Buffer.alloc(width - 1)]));
      const badPointer = Buffer.from(bytes); id(bytes.length).copy(badPointer, header.length);
      rejects(badPointer);
      const missingChannelList = Buffer.concat([header, id(0)]); rejects(missingChannelList);
    });
    it(`rejects required null hierarchy/level pointers and missing tiles for ${idSize * 8}-bit offsets`, () => {
      const current = fixture({ idSize });
      for (const offset of [current.hierarchyPointerOffset, current.hierarchyOffset + 12]) {
        const malformed = Buffer.from(current.bytes); current.id(0).copy(malformed, offset); rejects(malformed);
      }
      const noTiles = Buffer.from(current.bytes); current.id(0).copy(noTiles, current.tilePointerOffset); rejects(noTiles);
    });
  }
  it("rejects property headers, payload claims and malformed end records", () => {
    const { header } = fixture();
    const base = header.subarray(0, 26);
    for (const tail of [u32(17), Buffer.concat([u32(17), u32(2), Buffer.from([1])]), Buffer.concat([u32(99), u32(0xffffffff)]),
      Buffer.concat([u32(0), u32(1), Buffer.from([0])])]) rejects(Buffer.concat([base, tail]));
  });
  for (const [type, minimum] of [[6, 4], [7, 4], [8, 4], [11, 4], [15, 8], [17, 1], [30, 4], [31, 4]]) {
    it(`rejects undersized consumed property ${type}`, () => rejects(fixture({ layerProperties: property(type, Buffer.alloc(minimum - 1)) }).bytes));
  }
  it("rejects item paths whose payload is not a sequence of uint32 indices", () => rejects(fixture({ layerProperties: property(30, Buffer.alloc(5)) }).bytes));
  it("rejects string length claims and missing NUL terminators", () => {
    const current = fixture();
    const oversized = Buffer.from(current.bytes); u32(0xffffffff).copy(oversized, current.layerNameOffset); rejects(oversized);
    const unterminated = Buffer.from(current.bytes); unterminated[current.layerNameOffset + 8] = 65; rejects(unterminated, /unterminated string/);
  });
  it("rejects hierarchy extents before allocating layer pixel buffers", () => {
    const current = fixture();
    const truncated = Buffer.from(current.bytes); current.id(truncated.length - 1).copy(truncated, current.hierarchyPointerOffset);
    const doc = { layers: [], createdLayers: [], newLayer() { const layer = new Layer(); this.createdLayers.push(layer); return layer; } };
    assert.throws(() => XCFParser.parse(truncated.buffer.slice(truncated.byteOffset, truncated.byteOffset + truncated.length), doc), /metadata range/);
    assert.equal(doc.createdLayers[0].buffer, null);
  });
  it("rejects parasite subfields crossing their enclosing payload", () => {
    const name = Buffer.from("opaque\0");
    for (const payload of [Buffer.from([0, 0, 0]), Buffer.concat([u32(100), name]),
      Buffer.concat([u32(name.length), name, u32(1)]),
      Buffer.concat([u32(name.length), name, u32(1), u32(2), Buffer.from([7])])]) {
      rejects(fixture({ layerProperties: property(21, payload) }).bytes);
    }
  });
  it("retains canonical opaque parasites and empty XCF strings", () => {
    const name = Buffer.from("opaque\0");
    const payload = Buffer.concat([u32(name.length), name, u32(1), u32(1), Buffer.from([7]), u32(0), u32(1), u32(0)]);
    const doc = parse(fixture({ layerProperties: property(21, payload) }).bytes);
    assert.deepEqual(Array.from(doc.layers[0].buffer), [23, 61, 107, 255]);
  });
});


describe("XCF bounded RLE tiles (malformed controls are after-only)", () => {
  it("decodes all four short/long repeat/literal forms without crossing channel boundaries", () => {
    for (const idSize of [4, 8]) {
      const tile = Buffer.from([255, 23, 128, 0, 1, 61, 127, 0, 1, 107, 0, 255]);
      const doc = parse(fixture({ idSize, tile }).bytes);
      assert.deepEqual(Array.from(doc.layers[0].buffer), [23, 61, 107, 255]);
    }
  });
  it("retains mixed three-pixel repeats and literal runs on exact channel boundaries", () => {
    const tile = Buffer.from([1, 23, 0, 45, 253, 61, 62, 63, 127, 0, 3, 107, 128, 0, 3, 255, 128, 64]);
    const doc = parse(fixture({ width: 3, tile }).bytes);
    assert.equal(doc.width, 3);
    assert.deepEqual(Array.from(doc.layers[0].buffer), [23, 61, 107, 255, 23, 62, 107, 128, 45, 63, 107, 64]);
  });
  for (const [label, tile] of [
    ["short repeat value", [0]], ["short literal payload", [255]],
    ["long repeat length", [127]], ["long repeat low byte", [127, 0]], ["long repeat value", [127, 0, 1]],
    ["long literal length", [128]], ["long literal low byte", [128, 0]], ["long literal payload", [128, 0, 1]],
    ["zero long repeat", [127, 0, 0, 23]], ["zero long literal", [128, 0, 0]],
    ["short repeat overrun", [1, 23, 0, 61, 0, 107, 0, 255]],
    ["short literal overrun", [254, 23, 24, 0, 61, 0, 107, 0, 255]],
    ["long repeat overrun", [127, 255, 255, 23]], ["long literal overrun", [128, 255, 255, 23]],
  ]) {
    it(`rejects ${label} in a 1×1 tile`, () => rejects(fixture({ tile: Buffer.from(tile) }).bytes));
  }
  it("rejects every truncated canonical four-form RLE prefix", () => {
    const current = fixture({ tile: Buffer.from([255, 23, 128, 0, 1, 61, 127, 0, 1, 107, 0, 255]) });
    for (let length = current.tileOffset + 1; length < current.bytes.length; length++) rejects(current.bytes.subarray(0, length));
  });
  it("rejects a run exceeding only the remaining samples", () => {
    const tile = Buffer.from([0, 23, 2, 45, 253, 61, 62, 63, 2, 107, 2, 255]);
    rejects(fixture({ width: 3, tile }).bytes, /invalid RLE run length/);
  });
  it("rejects unsupported fractional or excessive RLE channel layouts", () => {
    const current = fixture();
    for (const bpp of [0, 5]) {
      const malformed = Buffer.from(current.bytes); u32(bpp).copy(malformed, current.hierarchyOffset + 8);
      rejects(malformed, /invalid pixel channel layout/);
    }
    const deep = fixture({ idSize: 8 });
    const malformed = Buffer.from(deep.bytes); u32(250).copy(malformed, 26); u32(3).copy(malformed, deep.hierarchyOffset + 8);
    rejects(malformed, /invalid pixel channel layout/);
  });
});
