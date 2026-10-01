import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import pako from "../../../src/vendor/pako/index.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, Layer, restore, oldPako, oldAlert;
before(async () => {
  oldPako = globalThis.pako; oldAlert = globalThis.alert;
  restore = installBrowserGlobals(); globalThis.pako = pako; globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});
after(() => {
  restore?.();
  if (oldPako === undefined) delete globalThis.pako; else globalThis.pako = oldPako;
  if (oldAlert === undefined) delete globalThis.alert; else globalThis.alert = oldAlert;
});
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const prop = (type, bytes = Buffer.alloc(0)) => Buffer.concat([u32(type), u32(bytes.length), bytes]);
const palette = [23, 61, 107, 199, 151, 73, 0, 255, 41, 255, 0, 219];
// Independent, at most four tiles and 65×65 pixels; no production encoder.
function fixture({ idSize, compression, baseType, precision, width = 65, height = 65 }) {
  const id = idSize === 4 ? u32 : u64;
  const samples = baseType % 2 ? 2 : 1;
  const indexed = baseType >= 4;
  const expected = Buffer.alloc(width * height * 4);
  const tiles = [];
  for (let y = 0; y < height; y += 64) for (let x = 0; x < width; x += 64) {
    const raw = [];
    for (let dy = 0; dy < Math.min(64, height - y); dy++) for (let dx = 0; dx < Math.min(64, width - x); dx++) {
      const value = indexed ? (x + dx + y + dy) % 4 : (3 * (x + dx) + 5 * (y + dy)) % 256;
      const alpha = (7 * (x + dx) + 11 * (y + dy)) % 256;
      raw.push(value); if (samples === 2) raw.push(alpha);
      const normalized = value / 255;
      const gray = precision === 100 ? Math.round(255 * (normalized <= 0.0031308 ? 12.92 * normalized : 1.055 * normalized ** (1 / 2.4) - 0.055)) : value;
      expected.set([...(indexed ? palette.slice(value * 3, value * 3 + 3) : [gray, gray, gray]), samples === 2 ? alpha : 255], ((y + dy) * width + x + dx) * 4);
    }
    if (compression === 1) {
      const parts = [];
      for (let ch = 0; ch < samples; ch++) {
        const plane = raw.filter((_, index) => index % samples === ch);
        for (let start = 0; start < plane.length; start += 127) {
          const chunk = plane.slice(start, start + 127);
          parts.push(Buffer.from([256 - chunk.length, ...chunk]));
        }
      }
      tiles.push(Buffer.concat(parts));
    } else tiles.push(compression === 2 ? deflateSync(Buffer.from(raw)) : Buffer.from(raw));
  }
  const header = Buffer.concat([Buffer.from(idSize === 4 ? "gimp xcf v010\0" : "gimp xcf v012\0"), u32(width), u32(height), u32(indexed ? 2 : 1), u32(precision),
    prop(17, Buffer.from([compression])), ...(indexed ? [prop(1, Buffer.concat([u32(4), Buffer.from(palette)]))] : []), prop(0)]);
  const layer = Buffer.concat([u32(width), u32(height), u32(baseType), u32(5), Buffer.from("Tiny\0"), prop(0)]);
  const layerOffset = header.length + 3 * idSize;
  const hierarchyOffset = layerOffset + layer.length + 2 * idSize;
  const levelOffset = hierarchyOffset + 12 + idSize;
  let tileOffset = levelOffset + 8 + (tiles.length + 1) * idSize;
  const pointers = tiles.map(tile => { const pointer = id(tileOffset); tileOffset += tile.length; return pointer; });
  return { expected, bytes: Buffer.concat([header, id(layerOffset), id(0), id(0), layer, id(hierarchyOffset), id(0),
    u32(width), u32(height), u32(samples), id(levelOffset), u32(width), u32(height), ...pointers, id(0), ...tiles]) };
}
describe("XCF tiled grayscale and indexed color fidelity", () => {
  for (const idSize of [4, 8]) for (const compression of [0, 1, 2]) for (const baseType of [2, 3, 4, 5]) for (const precision of [100, 150]) {
    it(`decodes all full/right/bottom/corner pixels: type ${baseType}, precision ${precision}, compression ${compression}, ${idSize * 8}-bit pointers`, () => {
      const { bytes, expected } = fixture({ idSize, compression, baseType, precision });
      const doc = { layers: [], newLayer() { return new Layer(); } };
      XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
      assert.deepEqual(Buffer.from(doc.layers[0].buffer), expected);
    });
  }
});
