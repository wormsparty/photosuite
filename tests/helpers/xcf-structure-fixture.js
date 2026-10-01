const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const prop = (type, bytes = Buffer.alloc(0)) => Buffer.concat([u32(type), u32(bytes.length), bytes]);
const name = s => { const b = Buffer.from(s + "\0"); return Buffer.concat([u32(b.length), b]); };

// Tiny synthetic fixtures exercise parser semantics, not GIMP interoperability.
export function fixture({ idSize = 4, colorMode = 0, baseType = 1, pixels = [23, 61, 107, 255],
  palette = [23, 61, 107, 199, 151, 73], group = false, mode = 0, mask = false,
  applyMask = true, offsets = [3, 5], bpp = pixels.length, path = [0], flags = 1, maskBpp = 1, precision = 100 } = {}) {
  const id = idSize === 4 ? u32 : u64;
  const header = Buffer.concat([Buffer.from(idSize === 4 ? "gimp xcf v003\0" : "gimp xcf v007\0"),
    u32(1), u32(1), u32(colorMode), ...(idSize === 8 ? [u32(precision)] : []),
    prop(17, Buffer.from([0])), ...(colorMode === 2 && palette != null ? [prop(1, Buffer.concat([u32(palette.length / 3), Buffer.from(palette)]))] : []), prop(0)]);
  const objectOffset = header.length + idSize * 3;
  const object = Buffer.concat([u32(1), u32(1), u32(baseType), name("Tiny"),
    prop(15, Buffer.concat(offsets.map(u32))), prop(7, u32(mode)), prop(30, Buffer.concat(path.map(u32))),
    ...(group ? [prop(29), prop(31, u32(flags))] : []), ...(mask ? [prop(11, u32(applyMask ? 1 : 0))] : []), prop(0)]);
  const hierarchyOffset = objectOffset + object.length + idSize * 2;
  const levelOffset = hierarchyOffset + 12 + idSize;
  const tileOffset = levelOffset + 8 + idSize * 2;
  const maskOffset = tileOffset + pixels.length;
  const channel = Buffer.concat([u32(1), u32(1), name("Mask"), prop(0)]);
  const channelHierarchyOffset = maskOffset + channel.length + idSize;
  const channelLevelOffset = channelHierarchyOffset + 12 + idSize;
  const channelTileOffset = channelLevelOffset + 8 + idSize * 2;
  return Buffer.concat([header, id(objectOffset), id(0), id(0), object,
    id(group ? 0 : hierarchyOffset), id(mask ? maskOffset : 0),
    u32(1), u32(1), u32(bpp), id(levelOffset), u32(1), u32(1), id(tileOffset), id(0), Buffer.from(pixels),
    ...(mask ? [channel, id(channelHierarchyOffset), u32(1), u32(1), u32(maskBpp), id(channelLevelOffset),
      u32(1), u32(1), id(channelTileOffset), id(0), Buffer.from([89])] : [])]);
}
export function parse(bytes, XCFParser, Layer, LayerSectionType) {
  const doc = { layers: [], newLayer() { return new Layer(); }, createGroupEndLayer() {
    const layer = new Layer(); layer.add.lsct = LayerSectionType.BoundingDivider; layer.layerFlags = 24; return layer;
  } };
  XCFParser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), doc);
  return doc;
}

// One-pixel stack for nested topology checks; paths are stored verbatim.
export function stackFixture({ idSize = 4, layers = [] } = {}) {
  const id = idSize === 4 ? u32 : u64;
  const header = Buffer.concat([Buffer.from(idSize === 4 ? "gimp xcf v003\0" : "gimp xcf v011\0"),
    u32(1), u32(1), u32(0), ...(idSize === 8 ? [u32(100)] : []), prop(17, Buffer.from([0])), prop(0)]);
  let cursor = header.length + idSize * (layers.length + 2);
  const pointers = [], objects = [];
  for (const { group = false, flags, path = [0], title = "Tiny" } of layers) {
    const object = Buffer.concat([u32(1), u32(1), u32(1), name(title),
      prop(30, Buffer.concat(path.map(u32))), ...(group ? [prop(29)] : []),
      ...(flags != null ? [prop(31, u32(flags))] : []), prop(0)]);
    const hierarchy = cursor + object.length + idSize * 2;
    const level = hierarchy + 12 + idSize;
    const tile = level + 8 + idSize * 2;
    const payload = Buffer.concat([object, id(group ? 0 : hierarchy), id(0),
      u32(1), u32(1), u32(4), id(level), u32(1), u32(1), id(tile), id(0), Buffer.from([23, 61, 107, 255])]);
    pointers.push(id(cursor)); objects.push(payload); cursor += payload.length;
  }
  return Buffer.concat([header, ...pointers, id(0), id(0), ...objects]);
}
