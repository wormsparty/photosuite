import { deflateSync } from "node:zlib";
import pako from "../../../src/vendor/pako/index.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, Layer, restoreBrowserGlobals, originalPako, originalAlert;
before(async () => {
  originalPako = globalThis.pako;
  originalAlert = globalThis.alert;
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.pako = pako;
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});
after(() => { restoreBrowserGlobals?.(); if (originalPako === undefined) delete globalThis.pako; else globalThis.pako = originalPako; if (originalAlert === undefined) delete globalThis.alert; else globalThis.alert = originalAlert; });

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; };
const end = Buffer.alloc(8);
const property = (type, bytes) => Buffer.concat([u32(type), u32(bytes.length), bytes]);

// Independent tiny fixtures use no application encoder. Dimensions stay at most 65×65.
function fixture({ width = 1, height = 1, idSize = 4, compression = 2, precision = 150, samples = 4, layerProperties = Buffer.alloc(0), tile = Buffer.from([0, 23, 0, 61, 0, 107, 0, 255]) } = {}) {
  const id = idSize == 4 ? u32 : u64;
  const name = Buffer.from("Tiny\0");
  const header = Buffer.concat([Buffer.from(idSize == 4 ? "gimp xcf v003\0" : "gimp xcf v012\0"), u32(width), u32(height), u32(0),
    ...(idSize == 8 ? [u32(precision)] : []), property(17, Buffer.from([compression])), end]);
  const layerOffset = header.length + 3 * idSize;
  const layerNameOffset = layerOffset + 12;
  const layerPropertyOffset = layerNameOffset + 4 + name.length;
  const hierarchyPointerOffset = layerPropertyOffset + layerProperties.length + 8;
  const hierarchyOffset = hierarchyPointerOffset + 2 * idSize;
  const levelOffset = hierarchyOffset + 12 + idSize;
  const tilePointerOffset = levelOffset + 8;
  const tileOffset = tilePointerOffset + 2 * idSize;
  const bytes = Buffer.concat([header, id(layerOffset), id(0), id(0), u32(width), u32(height), u32(samples == 3 ? 0 : 1), u32(name.length), name,
    layerProperties, end, id(hierarchyOffset), id(0), u32(width), u32(height), u32(samples * (precision == 250 ? 2 : 1)), id(levelOffset),
    u32(width), u32(height), id(tileOffset), id(0), tile]);
  return { bytes, header, id, idSize, layerOffset, layerNameOffset, layerPropertyOffset, hierarchyPointerOffset, hierarchyOffset, levelOffset, tilePointerOffset, tileOffset };
}
function parse(bytes) {
  const doc = { layers: [], createdLayers: [], newLayer() { const layer = new Layer(); this.createdLayers.push(layer); return layer; } };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  return doc;
}
function rejects(bytes, message = /xcf:/) { assert.throws(() => parse(bytes), message); }

describe("XCF independent raw and zlib tile controls", () => {
  for (const compression of [0, 2]) {
    for (const idSize of [4, 8]) {
      for (const samples of [3, 4]) {
        it(`imports ${samples}-channel compression ${compression} with ${idSize * 8}-bit offsets`, () => {
          const raw = Buffer.from(samples == 3 ? [23, 61, 107, 45, 62, 109] : [23, 61, 107, 255, 45, 62, 109, 128]);
          const tile = compression == 2 ? deflateSync(raw) : raw;
          assert.deepEqual(Array.from(parse(fixture({ width: 2, compression, idSize, samples, tile }).bytes).layers[0].buffer), [23, 61, 107, 255, 45, 62, 109, samples == 3 ? 255 : 128]);
        });
      }
    }
    it(`maps interleaved big-endian 16-bit compression ${compression} into channel planes`, () => {
      const raw = Buffer.from([23, 1, 61, 2, 107, 3, 255, 4, 45, 5, 62, 6, 109, 7, 128, 8]);
      assert.deepEqual(Array.from(parse(fixture({ width: 2, compression, idSize: 8, precision: 250, tile: compression == 2 ? deflateSync(raw) : raw }).bytes).layers[0].buffer), [23, 61, 107, 255, 45, 62, 109, 128]);
    });
  }
  for (const compression of [0, 2]) {
    it(`retains exact pixels across full and edge tiles for compression ${compression}`, () => {
      const current = fixture({ width: 65, compression });
      const first = Buffer.alloc(64 * 4);
      for (let px = 0; px < 64; px++) first.set([px, 61, 107, 255], px * 4);
      const edge = Buffer.from([149, 193, 227, 128]);
      const tileA = compression == 2 ? deflateSync(first) : first;
      const tileB = compression == 2 ? deflateSync(edge) : edge;
      const tileStart = current.tilePointerOffset + 12;
      const bytes = Buffer.concat([current.bytes.subarray(0, current.tilePointerOffset), u32(tileStart), u32(tileStart + tileA.length), u32(0), tileA, tileB]);
      assert.deepEqual(Array.from(parse(bytes).layers[0].buffer), Array.from(Buffer.concat([first, edge])));
    });
  }
  for (const compression of [0, 2]) {
    it(`rejects a first tile crossing the next tile offset for compression ${compression}`, () => {
      const current = fixture({ width: 65, compression });
      const raw = Buffer.alloc(64 * 4, 255);
      const tile = compression == 2 ? deflateSync(raw) : raw;
      const tileStart = current.tilePointerOffset + 12;
      const bytes = Buffer.concat([current.bytes.subarray(0, current.tilePointerOffset), u32(tileStart), u32(tileStart + tile.length - 1), u32(0), tile, deflateSync(Buffer.alloc(4))]);
      rejects(bytes, /xcf:/);
    });
  }
  for (const size of [0, 1, 3, 5, 8]) {
    it(`rejects zlib tile with ${size} inflated bytes for one RGBA pixel`, () => rejects(fixture({ tile: deflateSync(Buffer.alloc(size)) }).bytes, /xcf:/));
  }
  it("rejects truncated raw pixels", () => rejects(fixture({ compression: 0, tile: Buffer.from([23, 61, 107]) }).bytes));
  it("rejects all truncated zlib prefixes including missing checksum bytes", () => {
    const compressed = deflateSync(Buffer.from([23, 61, 107, 255]));
    for (let length = 1; length < compressed.length; length++) assert.throws(() => parse(fixture({ tile: compressed.subarray(0, length) }).bytes));
  });
  it("rejects invalid zlib header and checksum", () => {
    assert.throws(() => parse(fixture({ tile: Buffer.from([0, 0, 0, 0]) }).bytes));
    const compressed = deflateSync(Buffer.from([23, 61, 107, 255])); compressed[compressed.length - 1] ^= 1;
    assert.throws(() => parse(fixture({ tile: compressed }).bytes));
  });
});

// RLE is planar within each tile. All fixtures remain bounded to four tiny tiles.
function rle(raw, samples) {
  const encoded = [];
  for (let ch = 0; ch < samples; ch++) {
    const plane = [];
    for (let px = 0; px < raw.length / samples; px++) plane.push(raw[px * samples + ch]);
    for (let start = 0; start < plane.length; start += 127) {
      const chunk = plane.slice(start, start + 127);
      encoded.push(Buffer.from([256 - chunk.length, ...chunk]));
    }
  }
  return Buffer.concat(encoded);
}
function tiledFixture({ width = 65, height = 1, idSize = 4, compression = 1, samples = 4, tiles, pointerShift = 0 }) {
  const current = fixture({ width, height, idSize, compression, samples });
  const tileStart = current.tilePointerOffset + (tiles.length + 1) * idSize;
  let offset = tileStart;
  const pointers = tiles.map((tile, index) => {
    const pointer = current.id(offset + (index === 1 ? pointerShift : 0));
    offset += tile.length;
    return pointer;
  });
  return Buffer.concat([current.bytes.subarray(0, current.tilePointerOffset), ...pointers, current.id(0), ...tiles]);
}

describe("XCF multi-tile compressed boundaries", () => {
  for (const idSize of [4, 8]) {
    for (const compression of [1, 2]) {
      for (const samples of [3, 4]) {
        it(`retains all 65×65 tile pixels for compression ${compression}, ${samples} samples and ${idSize * 8}-bit offsets`, () => {
          const expected = Buffer.alloc(65 * 65 * 4);
          const tiles = [];
          for (let y = 0; y < 65; y += 64) {
            for (let x = 0; x < 65; x += 64) {
              const raw = [];
              for (let dy = 0; dy < Math.min(64, 65 - y); dy++) {
                for (let dx = 0; dx < Math.min(64, 65 - x); dx++) {
                  const pixel = [(x + dx) * 3 % 256, (y + dy) * 5 % 256, (x + dx + y + dy) * 7 % 256, 37 + (x + dx + y + dy) % 219];
                  raw.push(...pixel.slice(0, samples));
                  expected.set([...pixel.slice(0, 3), samples === 4 ? pixel[3] : 255], ((y + dy) * 65 + x + dx) * 4);
                }
              }
              tiles.push(compression === 1 ? rle(Buffer.from(raw), samples) : deflateSync(Buffer.from(raw)));
            }
          }
          const doc = parse(tiledFixture({ width: 65, height: 65, compression, idSize, samples, tiles }));
          assert.deepEqual(Buffer.from(doc.layers[0].buffer), expected);
        });
      }
    }
    // These malformed first tiles borrow bytes from a separately valid edge
    // tile. Every decode is tiny; downstream decoding cannot mask the defect.
    for (const [label, first, second, padding] of [
      ["repeat value", [63, 23, 63, 61, 63, 107, 63], [0, 149, 0, 193, 0, 227, 0, 128], []],
      ["long repeat length", [63, 23, 63, 61, 63, 107, 127], [0, 64, 0, 193, 0, 227, 0, 128], []],
      ["long copy length", [63, 23, 63, 61, 63, 107, 128], [0, 64, 0, 193, 0, 227, 0, 128], Array(58).fill(99)],
      ["copy payload", [63, 23, 63, 61, 63, 107, 192, ...Array(56).fill(255)], [0, 149, 0, 193, 0, 227, 0, 128], []],
    ]) {
      it(`rejects RLE ${label} crossing a following ${idSize * 8}-bit tile pointer`, () => {
        rejects(tiledFixture({ idSize, tiles: [Buffer.from(first), Buffer.from([...second, ...padding])] }), /xcf:/);
      });
    }
    it(`rejects zlib checksum crossing a following ${idSize * 8}-bit tile pointer`, () => {
      rejects(tiledFixture({ idSize, compression: 2, tiles: [deflateSync(Buffer.alloc(64 * 4, 255)), deflateSync(Buffer.from([149, 193, 227, 128]))], pointerShift: -1 }), /xcf:/);
    });
  }
});
