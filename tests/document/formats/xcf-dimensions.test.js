import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, Layer, restore;
before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
});
after(() => restore?.());

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };

// Hand-encoded 1×1 RGB fixtures. Malformed dimensional claims are after-only:
// their historical implementation could allocate attacker-selected buffers.
function fixture({ idSize = 4, channel = false, width = 1, height = 1 } = {}) {
  const id = idSize === 4 ? u32 : u64;
  const header = Buffer.concat([Buffer.from(idSize === 4 ? "gimp xcf v003\0" : "gimp xcf v012\0"),
    u32(width), u32(height), u32(0), ...(idSize === 8 ? [u32(100)] : []),
    u32(17), u32(1), Buffer.from([1]), Buffer.alloc(8)]);
  const objectOffset = header.length + 3 * idSize;
  const name = Buffer.from("Tiny\0");
  const object = Buffer.concat([u32(width), u32(height), ...(channel ? [] : [u32(1)]), u32(name.length), name,
    ...(channel ? [u32(4), u32(0)] : []), Buffer.alloc(8)]);
  const pointerOffset = objectOffset + object.length;
  const hierarchyOffset = pointerOffset + (channel ? 1 : 2) * idSize;
  const levelOffset = hierarchyOffset + 12 + idSize;
  const tiles = [];
  for (let y = 0; y < height; y += 64) for (let x = 0; x < width; x += 64) {
    const count = Math.min(64, width - x) * Math.min(64, height - y);
    tiles.push(Buffer.from((channel ? [89] : [23 + tiles.length, 61, 107, 255]).flatMap(value =>
      count <= 127 ? [count - 1, value] : [127, count >> 8, count & 255, value])));
  }
  let tileOffset = levelOffset + 8 + (tiles.length + 1) * idSize;
  const tileIds = tiles.map(tile => { const pointer = id(tileOffset); tileOffset += tile.length; return pointer; });
  const bytes = Buffer.concat([header,
    ...(channel ? [id(0), id(objectOffset), id(0)] : [id(objectOffset), id(0), id(0)]),
    object, id(hierarchyOffset), ...(channel ? [] : [id(0)]),
    u32(width), u32(height), u32(channel ? 1 : 4), id(levelOffset),
    u32(width), u32(height), ...tileIds, id(0), ...tiles]);
  return { bytes, objectOffset, hierarchyOffset, levelOffset };
}
function document() {
  return { layers: [], createdLayers: [], newLayer() { const layer = new Layer(); this.createdLayers.push(layer); return layer; } };
}
function parse(bytes, doc = document()) {
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  return doc;
}
function mutate(current, offset, width, height) {
  const bytes = Buffer.from(current.bytes);
  u32(width).copy(bytes, offset); u32(height).copy(bytes, offset + 4);
  return bytes;
}

describe("XCF dimensions and allocation budgets (unsafe claims are after-only)", () => {
  for (const idSize of [4, 8]) {
    for (const [width, height] of [[8192, 8192], [16384, 4096]]) {
      it(`rejects combined ${width}×${height} document/layer allocation before pixel allocation (${idSize * 8}-bit)`, () => {
        const current = fixture({ idSize });
        let bytes = current.bytes;
        for (const offset of [14, current.objectOffset, current.hierarchyOffset, current.levelOffset]) {
          bytes = mutate({ bytes }, offset, width, height);
        }
        const doc = document();
        assert.throws(() => parse(bytes, doc), /decoded allocation budget exceeded/);
        assert.equal(doc.buffer, undefined);
        assert.equal(doc.createdLayers[0].buffer, null);
      });
    }
    it(`retains exact 65×65 pixels across all four edge tiles (${idSize * 8}-bit)`, () => {
      const doc = parse(fixture({ idSize, width: 65, height: 65 }).bytes);
      assert.equal(doc.width, 65); assert.equal(doc.height, 65);
      assert.equal(doc.layers[0].buffer.length, 65 * 65 * 4);
      for (let y = 0; y < 65; y++) for (let x = 0; x < 65; x++) {
        const offset = (y * 65 + x) * 4;
        assert.deepEqual(Array.from(doc.layers[0].buffer.subarray(offset, offset + 4)),
          [23 + (x === 64 ? 1 : 0) + (y === 64 ? 2 : 0), 61, 107, 255]);
      }
    });
    it(`retains exact 1×1 layer and channel data with ${idSize * 8}-bit pointers`, () => {
      const layerDoc = parse(fixture({ idSize }).bytes);
      assert.deepEqual(Array.from(layerDoc.layers[0].buffer), [23, 61, 107, 255]);
      assert.equal(layerDoc.buffer.length, 4);
      const channelDoc = parse(fixture({ idSize, channel: true }).bytes);
      assert.equal(channelDoc.buffer.length, 4);
      assert.deepEqual(channelDoc.layers, []);
      assert.deepEqual(Array.from(channelDoc.selectionMask.channel.subarray(0, 1)), [89]);
      assert.equal(channelDoc.selectionMask.rect.width, 1);
      assert.equal(channelDoc.selectionMask.rect.height, 1);
    });
    for (const [label, width, height] of [
      ["zero width", 0, 1], ["zero height", 1, 0],
      ["axis budget", 16385, 1], ["pixel budget", 8193, 8192],
      ["uint32 maximum", 0xffffffff, 0xffffffff],
    ]) {
      for (const target of ["document", "layer", "channel"]) {
        it(`rejects ${target} ${label} before retaining pixel buffers (${idSize * 8}-bit)`, () => {
          const current = fixture({ idSize, channel: target === "channel" });
          const doc = document();
          const bytes = mutate(current, target === "document" ? 14 : current.objectOffset, width, height);
          assert.throws(() => parse(bytes, doc), /xcf:/);
          if (target === "channel") assert.equal(doc.buffer.length, 4);
          else assert.equal(doc.buffer, undefined);
          assert.ok(doc.createdLayers.every(layer => layer.buffer === null));
        });
      }
    }
    for (const target of ["hierarchy", "level"]) {
      for (const channel of [false, true]) {
        it(`rejects ${channel ? "channel" : "layer"} ${target} equal-area shape mismatch (${idSize * 8}-bit)`, () => {
          const current = fixture({ idSize, channel, width: 2, height: 1 });
          const doc = document();
          assert.throws(() => parse(mutate(current, current[target + "Offset"], 1, 2), doc), /xcf:/);
          assert.ok(doc.createdLayers.every(layer => layer.buffer === null));
        });
      }
      for (const channel of [false, true]) {
        for (const [width, height] of [[0, 1], [1, 0], [2, 1], [1, 2], [0xffffffff, 0xffffffff]]) {
          it(`rejects ${channel ? "channel" : "layer"} ${target} ${width}×${height} mismatch (${idSize * 8}-bit)`, () => {
            const current = fixture({ idSize, channel });
            const doc = document();
            assert.throws(() => parse(mutate(current, current[target + "Offset"], width, height), doc), /xcf:/);
            assert.ok(doc.createdLayers.every(layer => layer.buffer === null));
          });
        }
      }
    }
    it(`rejects a channel whose matching hierarchy differs from its document (${idSize * 8}-bit)`, () => {
      const current = fixture({ idSize, channel: true });
      let bytes = current.bytes;
      for (const offset of [current.objectOffset, current.hierarchyOffset, current.levelOffset]) {
        bytes = mutate({ bytes }, offset, 2, 1);
      }
      const doc = document();
      assert.throws(() => parse(bytes, doc), /channel dimensions mismatch/);
      assert.equal(doc.selectionMask, undefined);
      assert.equal(doc.buffer.length, 4);
    });
    for (const bpp of [0, 5, 0xffffffff]) {
      it(`rejects invalid ${bpp} hierarchy bytes per pixel before layer allocation (${idSize * 8}-bit)`, () => {
        const current = fixture({ idSize });
        const bytes = Buffer.from(current.bytes); u32(bpp).copy(bytes, current.hierarchyOffset + 8);
        const doc = document();
        assert.throws(() => parse(bytes, doc), /xcf:/);
        assert.equal(doc.createdLayers[0].buffer, null);
      });
    }
  }
});
