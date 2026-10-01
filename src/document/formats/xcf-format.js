// GIMP (.xcf) layered-image loader. Parses the XCF layer stack into the
// document model; property type ids live in metadata/xcf-prop-type.js.
/* global pako, DOMParser, alert */
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { CSS } from "../../features/css-export/css.js";

import { XcfPropType } from "./metadata/xcf-prop-type.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { Mask } from "../model/layer-masks.js";
import { PlanarRgbaBuffer, allocBuffer, planarToInterleaved } from "../../engine/compositing/buffer-utils.js";
import { copyChannelsWithClip } from "../../engine/compositing/pixel-ops.js";
import { linearToSrgb } from "../../engine/compositing/color-math.js";

/** XCF tiles are 64x64 pixels. */
const TILE_SIZE = 64;
// Match the existing raster import pixel ceiling; additionally bound narrow images.
const MAX_IMAGE_DIMENSION = 16384;
const MAX_IMAGE_PIXELS = 8192 * 8192;
// Include retained pixels and temporary planar/interleaved coexistence. Leave room
// for the bounded tile scratch buffers, independently of compressed file size.
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const TILE_SCRATCH_BYTES = TILE_SIZE * TILE_SIZE * 8 * 4;

function validateDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new RangeError("xcf: invalid or excessive image dimensions");
  }
}

function reserveDecodedBytes(budget, byteLength) {
  if (byteLength > MAX_DECODED_BYTES - TILE_SCRATCH_BYTES - budget.used) {
    throw new RangeError("xcf: decoded allocation budget exceeded");
  }
  budget.used += byteLength;
}

function planeBytes(pixelCount) {
  return Math.ceil(pixelCount / 4) * 4;
}
/** Layer-flag bits marking a collapsed group; hidden layers add this bit. */
const GROUP_LAYER_FLAGS = 24;
const HIDDEN_LAYER_FLAG = 2;
/** HDR float→byte lookup table resolution (0..1 sampled in 1/1000 steps). */
const HDR_LUT_SIZE = 1001;
/** RLE tag byte thresholds in the XCF tile compression stream. */
const RLE_LONG_RUN = 127;
const RLE_LONG_COPY = 128;

/** GIMP text style tokens split off the end of a font family name. */
const FONT_STYLE_TOKENS = "bold italic semi extra regular condensed light".split(" ");
/** GIMP text justification names, indexed to PSD Justification values. */
const JUSTIFY_NAMES = ["left", "right", "center", "fill"];

/** Number of raw sample channels for a given XCF bit-depth code. */
function channelCountForBitDepth(bitDepth) {
  if (bitDepth == 100 || bitDepth == 150) return 1;
  if (bitDepth == 200 || bitDepth == 250) return 2;
  if (bitDepth == 300 || bitDepth == 350) return 4;
  if (bitDepth == 500 || bitDepth == 550) return 2;
  if (bitDepth == 600 || bitDepth == 650) return 4;
  if (bitDepth == 700 || bitDepth == 750) return 8;
  alert("unsupported bit depth " + bitDepth);
  throw "xcf: unsupported bit depth";
}

/** Reader for id-sized offsets (4-byte uint or 8-byte int). */
function idReader(idSize) {
  return idSize == 4 ? BinaryUtils.readUint32BE : BinaryUtils.readInt64BE;
}

/** Reject incomplete fields before unchecked shared binary readers see them. */
function requireBytes(bytes, offset, size, endOffset = bytes.length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > endOffset || size > endOffset - offset) {
    throw new RangeError("xcf: truncated or invalid metadata range");
  }
}

/** XCF strings include a length prefix and, when nonempty, a trailing NUL. */
function readXcfString(bytes, offset, endOffset = bytes.length) {
  requireBytes(bytes, offset, 4, endOffset);
  var size = BinaryUtils.readUint32BE(bytes, offset);
  requireBytes(bytes, offset + 4, size, endOffset);
  if (size > 0 && bytes[offset + 3 + size] != 0) throw new RangeError("xcf: unterminated string");
  return BinaryUtils.readLengthPrefixedUtf8(bytes, offset);
}

/** Read an offset field, rejecting pointers that cannot address this file. */
function readOffset(bytes, offset, idSize, required = false) {
  requireBytes(bytes, offset, idSize);
  var id = idReader(idSize)(bytes, offset);
  if (required && id == 0) throw new RangeError("xcf: missing required data offset");
  if (id != 0) requireBytes(bytes, id, 1);
  return id;
}

/**
 * Parse an XCF buffer into the document's layer stack.
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} doc
 */
function parse(arrayBuffer, doc) {
  var bytes = new Uint8Array(arrayBuffer);
  requireBytes(bytes, 0, 26);
  var offset = 0;
  var idSize = 4;
  var bitDepth = 150;
  if (BinaryUtils.readString(bytes, 0, 9) != "gimp xcf " || bytes[13] != 0) {
    throw new RangeError("xcf: invalid file signature");
  }
  offset += 9;
  var versionTag = BinaryUtils.readString(bytes, offset, 4);
  if (versionTag != "file" && !/^v[0-9]{3}$/.test(versionTag)) {
    throw new RangeError("xcf: invalid version tag");
  }
  var version = versionTag == "file" ? 0 : Number(versionTag.slice(1));
  // The documented GIMP format currently ends at v026. Future formats and
  // CinePaint's v100+ dialect need review before decoding their payloads.
  if (version > 26) throw new RangeError("xcf: unsupported file version");
  offset += 4;
  offset++;
  doc.width = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  doc.height = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  validateDimensions(doc.width, doc.height);
  var budget = { used: 0 };
  reserveDecodedBytes(budget, doc.width * doc.height * 4);
  var colorMode = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  if (colorMode > 2) throw new RangeError("xcf: unsupported image color mode");
  if (version >= 4) {
    requireBytes(bytes, offset, 4);
    bitDepth = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    // v004-v006 were development formats with different precision enums.
    if (version < 7) throw new RangeError("xcf: unsupported development version");
    // Precision was added in v004; 64-bit offsets only arrived in v011.
    if (version >= 11) idSize = 8;
  }
  if (![100, 150, 250, 600].includes(bitDepth)) {
    throw new RangeError("xcf: unsupported image precision");
  }
  if (version < 12 && bitDepth != 100 && bitDepth != 150) {
    throw new RangeError("xcf: unsupported development precision");
  }
  // Multi-byte grayscale needs color/coverage-specific transfer conversion;
  // reject it until the decoder supports those semantics explicitly.
  if (colorMode == 1 && bitDepth != 100 && bitDepth != 150) {
    throw new RangeError("xcf: unsupported grayscale precision");
  }

  var compressionProps = {};
  offset = readPropertyList(bytes, offset, compressionProps);
  var colormap = compressionProps[XcfPropType.PROP_COLORMAP];
  if (colorMode == 2) {
    if (!colormap || colormap.length < 4) throw new RangeError("xcf: missing indexed colormap");
    var colorCount = BinaryUtils.readUint32BE(colormap, 0);
    if (colorCount < 1 || colorCount > 256 || colormap.length != 4 + colorCount * 3) {
      throw new RangeError("xcf: invalid indexed colormap");
    }
    if (bitDepth != 100 && bitDepth != 150) throw new RangeError("xcf: unsupported indexed precision");
  }
  var layerIds = [];
  offset = readIdList(bytes, offset, layerIds, idSize);
  var channelIds = [];
  offset = readIdList(bytes, offset, channelIds, idSize);

  doc.openGroupDepth = 0;
  doc.openGroupPaths = [];
  for (var layerIdx = 0; layerIdx < layerIds.length; layerIdx++) {
    readLayer(bytes, layerIds[layerIdx], doc, compressionProps, idSize, bitDepth, budget, colorMode);
  }
  while (doc.openGroupDepth > 0) {
    doc.layers.push(doc.createGroupEndLayer());
    doc.openGroupDepth--;
  }
  doc.layers.reverse();
  delete doc.openGroupDepth;
  delete doc.openGroupPaths;
  doc.buffer = allocBuffer(doc.width * doc.height * 4);
  if (doc.layers.length == 0) console.log("No layers!!!");

  for (var channelIdx = 0; channelIdx < channelIds.length; channelIdx++) {
    var channel = readChannel(bytes, channelIds[channelIdx], compressionProps, idSize, bitDepth, budget, doc.width, doc.height);
    if (channel.properties[XcfPropType.PROP_SELECTION]) {
      doc.selectionMask = { channel: channel.channelPlane, rect: new Rect(0, 0, doc.width, doc.height) };
    }
  }
}

/** Read one layer (header, properties, text, pixel data) and push it. */
function readLayer(bytes, offset, doc, compressionProps, idSize, bitDepth, budget, colorMode) {
  requireBytes(bytes, offset, 12);
  var layer = doc.newLayer();
  var layerWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var layerHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  layer.rect = new Rect(0, 0, layerWidth, layerHeight);
  var baseType = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  if (baseType > 5 || Math.floor(baseType / 2) != colorMode) throw new RangeError("xcf: layer color type mismatch");
  var layerName = readXcfString(bytes, offset);
  offset += layerName.size;
  layer.setName(layerName.str);

  var props = {};
  offset = readPropertyList(bytes, offset, props);
  var itemPath = [];
  if (props[XcfPropType.PROP_ITEM_PATH]) {
    var pathBytes = props[XcfPropType.PROP_ITEM_PATH];
    for (var pathOffset = 0; pathOffset < pathBytes.length; pathOffset += 4) {
      itemPath.push(BinaryUtils.readUint32BE(pathBytes, pathOffset));
    }
  }
  var savedGroupDepth = Math.max(0, itemPath.length - 1);
  if (savedGroupDepth > 128 || savedGroupDepth > doc.openGroupDepth ||
      savedGroupDepth > 0 && !doc.openGroupPaths[savedGroupDepth - 1].every((index, depth) => itemPath[depth] == index)) {
    throw new RangeError("xcf: invalid group parent path");
  }
  if (props[XcfPropType.PROP_GROUP_ITEM_FLAGS] && !props[XcfPropType.PROP_GROUP_ITEM]) {
    throw new RangeError("xcf: group flags without group item");
  }
  applyLayerProps(layer, props);
  var maskRect = new Rect(layer.rect.x, layer.rect.y, layerWidth, layerHeight);
  // Groups have an empty model rect, but their stored mask follows the XCF
  // layer header and offsets, including negative document coordinates.
  if (layer.isGroup() && props[XcfPropType.PROP_OFFSETS]) {
    maskRect.x = BinaryUtils.readInt32BE(props[XcfPropType.PROP_OFFSETS], 0);
    maskRect.y = BinaryUtils.readInt32BE(props[XcfPropType.PROP_OFFSETS], 4);
  }

  if (props[XcfPropType.PROP_PARASITES]) {
    var parasites = props[XcfPropType.PROP_PARASITES];
    for (var parasiteName in parasites) {
      if (parasiteName == "gimp-text-layer") applyGimpTextLayer(layer, parasites[parasiteName]);
      else console.log("Unknown property " + parasiteName);
    }
  }

  while (doc.openGroupDepth > savedGroupDepth) {
    doc.layers.push(doc.createGroupEndLayer());
    doc.openGroupDepth--;
  }
  doc.openGroupDepth = savedGroupDepth;
  doc.openGroupPaths.length = savedGroupDepth;
  if (layer.isGroup()) {
    doc.openGroupDepth++;
    doc.openGroupPaths.push(itemPath.length ? itemPath : [doc.layers.length]);
  }

  if (layer.hasPixelData()) {
    validateDimensions(layerWidth, layerHeight);
    readLayerPixelData(bytes, offset, layer, props, compressionProps, idSize, bitDepth, budget, baseType);
  } else if (layer.isGroup()) {
    readOffset(bytes, offset, idSize);
    readLayerMask(bytes, readOffset(bytes, offset + idSize, idSize), layer, props, compressionProps, idSize, bitDepth, budget, maskRect);
  }
  doc.layers.push(layer);
}

/** Apply offset / opacity / group / mode / visibility properties to a layer. */
function applyLayerProps(layer, props) {
  if (props[XcfPropType.PROP_OFFSETS]) {
    layer.rect.x = BinaryUtils.readInt32BE(props[XcfPropType.PROP_OFFSETS], 0);
    layer.rect.y = BinaryUtils.readInt32BE(props[XcfPropType.PROP_OFFSETS], 4);
  }
  if (props[XcfPropType.PROP_OPACITY]) layer.Opct = BinaryUtils.readUint32BE(props[XcfPropType.PROP_OPACITY], 0);
  if (props[XcfPropType.PROP_GROUP_ITEM]) {
    layer.add.lsct = LayerSectionType.OpenGroup;
    layer.rect = new Rect(0, 0, 0, 0);
    layer.buffer = allocBuffer(0);
    layer.layerFlags = GROUP_LAYER_FLAGS;
  }
  if (props[XcfPropType.PROP_MODE]) {
    var modeCode = BinaryUtils.readUint32BE(props[XcfPropType.PROP_MODE], 0);
    layer.blendMode = XcfPropType.psdBlendModeCodes[modeCode];
  }
  if (props[XcfPropType.PROP_VISIBLE] && BinaryUtils.readUint32BE(props[XcfPropType.PROP_VISIBLE], 0) == 0) {
    layer.layerFlags += HIDDEN_LAYER_FLAG;
  }
  if (props[XcfPropType.PROP_GROUP_ITEM_FLAGS]) {
    var groupFlags = BinaryUtils.readUint32BE(props[XcfPropType.PROP_GROUP_ITEM_FLAGS], 0);
    layer.add.lsct = groupFlags & 1 == 1 ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
  }
}

/** Read a layer's tiled pixel data and optional layer mask. */
function readLayerPixelData(bytes, offset, layer, props, compressionProps, idSize, bitDepth, budget, baseType) {
  var pixelDataOffset = readOffset(bytes, offset, idSize, true);
  offset += idSize;
  var maskChannelId = readOffset(bytes, offset, idSize);
  offset += idSize;
  var sampleCount = [3, 4, 1, 2, 1, 2][baseType];
  validatePixelLayout(bytes, pixelDataOffset, layer.rect.width, layer.rect.height, idSize, bitDepth, sampleCount);
  var temporaryBytes = planeBytes(layer.rect.area()) * 4;
  reserveDecodedBytes(budget, layer.rect.area() * 4 + temporaryBytes);
  layer.buffer = allocBuffer(layer.rect.area() * 4);
  var planarPixels = new PlanarRgbaBuffer(layer.rect.area());
  var colorSamples = baseType < 2 ? 3 : baseType < 4 ? 1 : 0;
  readHierarchicalPixelData(bytes, pixelDataOffset, planarPixels, compressionProps, idSize, bitDepth, colorSamples);
  if (baseType >= 2) {
    var colormap = compressionProps[XcfPropType.PROP_COLORMAP];
    for (var px = 0; px < layer.rect.area(); px++) {
      var value = planarPixels.h[px];
      planarPixels.w[px] = baseType % 2 ? planarPixels.l[px] : 255;
      if (baseType < 4) {
        planarPixels.l[px] = value;
        planarPixels.O[px] = value;
      } else {
        var paletteOffset = 4 + value * 3;
        if (paletteOffset + 3 > colormap.length) throw new RangeError("xcf: palette index out of range");
        planarPixels.h[px] = colormap[paletteOffset];
        planarPixels.l[px] = colormap[paletteOffset + 1];
        planarPixels.O[px] = colormap[paletteOffset + 2];
      }
    }
  }
  planarToInterleaved(planarPixels, layer.buffer);
  readLayerMask(bytes, maskChannelId, layer, props, compressionProps, idSize, bitDepth, budget, layer.rect);
  budget.used -= temporaryBytes;
}

/** Masks belong to both raster layers and groups, independently of pixels. */
function readLayerMask(bytes, maskChannelId, layer, props, compressionProps, idSize, bitDepth, budget, rect) {
  if (maskChannelId == 0) return;
  layer.d = new Mask;
  layer.d.color = 0;
  layer.d.rect = rect.clone();
  layer.d.channel = readChannel(bytes, maskChannelId, compressionProps, idSize, bitDepth, budget, rect.width, rect.height).channelPlane;
  if (props[XcfPropType.PROP_APPLY_MASK]) {
    layer.d.isEnabled = BinaryUtils.readUint32BE(props[XcfPropType.PROP_APPLY_MASK], 0) == 1;
  }
}

/** Build a text layer from a GIMP `gimp-text-layer` parasite. */
function applyGimpTextLayer(layer, parasiteData) {
  var textProps = parseTextParasite(parasiteData);
  var textContent = textProps.text;
  var fontName = textProps.font;
  var textColor = textProps.color;
  var fontSize = textProps["font-size"];
  if (textContent == null && textProps.markup) {
    var markup = parseTextMarkup(textProps.markup, fontName, textColor, fontSize);
    textContent = markup.textContent;
    fontName = markup.fontName;
    textColor = markup.textColor;
    fontSize = markup.fontSize;
  }

  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
  layer.add.TySh.transform = new Matrix2D(1, 0, 0, 1, layer.rect.x, layer.rect.y);
  var engineData = layer.add.TySh.engineData;
  TextEngineData.insertText(engineData, 0, textContent);

  var textStyle = TextEngineData.getTextStyle(engineData, 0, 0);
  if (textColor) {
    textStyle.textStyle.FillColor = {
      Type: 1,
      Values: [1, parseFloat(textColor[1]), parseFloat(textColor[2]), parseFloat(textColor[3])],
    };
  }
  if (fontSize) {
    fontSize = Math.round(parseFloat(fontSize));
    textStyle.textStyle.FontSize = fontSize;
    layer.add.TySh.transform.ty += Math.min(17, fontSize * .17);
  }
  var lineSpacing = textProps["line-spacing"];
  if (lineSpacing) {
    lineSpacing = Math.round(parseFloat(lineSpacing) + textStyle.textStyle.FontSize * 1.2);
    textStyle.textStyle.Leading = lineSpacing;
    textStyle.textStyle.AutoLeading = false;
  }
  if (textProps.justify) textStyle.paraStyle.Justification = JUSTIFY_NAMES.indexOf(textProps.justify);
  if (fontName && fontName != "Sans-serif") TextEngineData.setTextFont(textStyle, resolveGimpFontName(fontName));
  TextEngineData.applyStyle(engineData, 0, textContent.length, textStyle);

  var boxWidth = textProps["box-width"];
  var boxHeight = textProps["box-height"];
  var parsedBoxWidth = boxWidth ? parseFloat(boxWidth) : layer.rect.width;
  var parsedBoxHeight = boxHeight ? parseFloat(boxHeight) : layer.rect.height;
  TextEngineData.setTextType(engineData, 1);
  TextEngineData.setBoxBounds(engineData, [0, 0, Math.ceil(parsedBoxWidth), Math.ceil(parsedBoxHeight)]);
}

/**
 * Resolve text content and style overrides from a GIMP Pango markup string,
 * following the innermost element's font / foreground / size attributes.
 * @returns {{textContent: string, fontName, textColor, fontSize}}
 */
function parseTextMarkup(markup, fontName, textColor, fontSize) {
  var svgRoot = new DOMParser().parseFromString(markup, "image/svg+xml");
  while (svgRoot.firstChild != null && svgRoot.firstChild.tagName != null) {
    svgRoot = svgRoot.firstChild;
    var svgFont = svgRoot.getAttribute("font");
    var svgForeground = svgRoot.getAttribute("foreground");
    var svgSize = svgRoot.getAttribute("size");
    if (svgFont != null) fontName = svgFont;
    if (svgForeground != null) {
      svgForeground = CSS.parseCssColor(svgForeground);
      textColor = [1, svgForeground.h / 255, svgForeground.l / 255, svgForeground.O / 255];
    }
    if (svgSize != null) fontSize = "" + parseFloat(svgSize) / 245;
  }
  return { textContent: svgRoot.textContent, fontName: fontName, textColor: textColor, fontSize: fontSize };
}

/** Rewrite a GIMP font family, splitting a trailing style suffix with a dash. */
function resolveGimpFontName(fontName) {
  var lowerFont = fontName.toLowerCase();
  var splitAt = lowerFont.length;
  for (var tokenIdx = 0; tokenIdx < FONT_STYLE_TOKENS.length; tokenIdx++) {
    var foundAt = lowerFont.indexOf(FONT_STYLE_TOKENS[tokenIdx]);
    if (foundAt != -1 && foundAt < splitAt && lowerFont[foundAt - 1] == " ") splitAt = foundAt;
  }
  if (splitAt != lowerFont.length) {
    fontName = fontName.slice(0, splitAt - 1).split(" ").join("") + "-" + fontName.slice(splitAt).split(" ").join("");
  }
  return fontName;
}

/** Parse a text-layer parasite's S-expression payload into a bindings object. */
function parseTextParasite(parasiteBytes) {
  if (!parasiteBytes.length || parasiteBytes[parasiteBytes.length - 1] != 0) {
    throw "xcf: unterminated text parasite";
  }
  var source = "(" + BinaryUtils.readUtf8(parasiteBytes, 0, parasiteBytes.length - 1) + ")";
  var tokens = [];
  var bindings = {};
  if (parseSExprTokens(source, 1, tokens) != source.length) throw "xcf: trailing text parasite data";
  applySExprBindingsToObject(tokens, bindings);
  return bindings;
}

/** Fold parsed S-expression key/value lists into a target object. */
function applySExprBindingsToObject(tokens, target) {
  for (var tokenIdx = 0; tokenIdx < tokens.length; tokenIdx++) {
    var entry = tokens[tokenIdx];
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] != "string") {
      throw "xcf: invalid text parasite binding";
    }
    var key = entry[0];
    target[key] = entry.length == 2 ? entry[1] : entry.slice(1);
  }
}

/** Bounded iterative tokenizer for the S-expression parasite format. */
function parseSExprTokens(source, pos, outTokens) {
  var lists = [outTokens];
  while (true) {
    if (pos >= source.length) throw "xcf: unterminated s-expression";
    var ch = source.charAt(pos);
    pos++;
    if (ch == "(") {
      if (lists.length >= 128) throw "xcf: text parasite nesting limit exceeded";
      var nested = [];
      outTokens.push(nested);
      lists.push(nested);
      outTokens = nested;
    } else if (ch == " " || ch == "\n" || ch == "\r" || ch == "\t") {
      // whitespace separator
    } else if (ch == ")") {
      lists.pop();
      if (!lists.length) return pos;
      outTokens = lists[lists.length - 1];
    } else if (ch == "\"") {
      var tokenStart = pos;
      while (true) {
        if (pos >= source.length) throw "xcf: unterminated text parasite string";
        var esc = source[pos];
        pos++;
        if (esc == "\"") break;
        if (esc == "\\") {
          if (pos >= source.length) throw "xcf: unterminated text parasite escape";
          pos++;
        }
      }
      outTokens.push(JSON.parse(source.slice(tokenStart - 1, pos)));
    } else {
      var tokenStart = pos - 1;
      while (pos < source.length) {
        var next = source[pos];
        if (next == " " || next == "\n" || next == "\r" || next == "\t" || next == "(" || next == ")" || next == "\"") break;
        pos++;
      }
      outTokens.push(source.slice(tokenStart, pos));
    }
  }
}

/** Read a channel (name, properties, pixel plane) at `offset`. */
function readChannel(bytes, offset, compressionProps, idSize, bitDepth, budget, expectedWidth, expectedHeight) {
  requireBytes(bytes, offset, 8);
  var channelWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var channelHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  validateDimensions(channelWidth, channelHeight);
  var channelName = readXcfString(bytes, offset);
  offset += channelName.size;
  var properties = {};
  offset = readPropertyList(bytes, offset, properties);
  if (expectedWidth != null && (channelWidth != expectedWidth || channelHeight != expectedHeight)) {
    throw new RangeError("xcf: channel dimensions mismatch");
  }
  var pixelDataOffset = readOffset(bytes, offset, idSize, true);
  offset += idSize;
  validatePixelLayout(bytes, pixelDataOffset, channelWidth, channelHeight, idSize, bitDepth, 1);
  var channelPlaneBytes = planeBytes(channelWidth * channelHeight);
  reserveDecodedBytes(budget, channelPlaneBytes * 4);
  var planarBuffer = new PlanarRgbaBuffer(channelWidth * channelHeight);
  readHierarchicalPixelData(bytes, pixelDataOffset, planarBuffer, compressionProps, idSize, bitDepth);
  budget.used -= channelPlaneBytes * 3;
  return { channelPlane: planarBuffer.h, properties: properties };
}

/** Validate hierarchy and level metadata before allocating destination planes. */
function validatePixelLayout(bytes, offset, width, height, idSize, bitDepth, expectedSamples) {
  requireBytes(bytes, offset, 12 + idSize);
  if (BinaryUtils.readUint32BE(bytes, offset) != width || BinaryUtils.readUint32BE(bytes, offset + 4) != height) {
    throw new RangeError("xcf: hierarchy dimensions mismatch");
  }
  var bytesPerPixel = BinaryUtils.readUint32BE(bytes, offset + 8);
  var sampleBytes = channelCountForBitDepth(bitDepth);
  if (bytesPerPixel % sampleBytes != 0 || bytesPerPixel < sampleBytes || bytesPerPixel > sampleBytes * 4) {
    throw new RangeError("xcf: invalid pixel channel layout");
  }
  if (bytesPerPixel != sampleBytes * expectedSamples) throw new RangeError("xcf: pixel channel type mismatch");
  var levelOffset = readOffset(bytes, offset + 12, idSize, true);
  requireBytes(bytes, levelOffset, 8);
  if (BinaryUtils.readUint32BE(bytes, levelOffset) != width || BinaryUtils.readUint32BE(bytes, levelOffset + 4) != height) {
    throw new RangeError("xcf: level dimensions mismatch");
  }
}

/** Read a hierarchy header and decode its level-0 tiled channel data. */
function readHierarchicalPixelData(bytes, offset, planarBuffer, compressionProps, idSize, bitDepth, colorSamples = 0) {
  requireBytes(bytes, offset, 12 + idSize);
  var tileWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var tileHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var bytesPerPixel = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var tiledDataOffset = readOffset(bytes, offset, idSize, true);
  offset += idSize;
  decodeTiledChannelData(bytes, tiledDataOffset, planarBuffer, compressionProps, bytesPerPixel, idSize, bitDepth, colorSamples);
}

/** Decode a tiled channel level into a planar RGBA buffer. */
function decodeTiledChannelData(bytes, offset, planarBuffer, compressionProps, bytesPerPixel, idSize, bitDepth, colorSamples) {
  requireBytes(bytes, offset, 8);
  var imageWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var imageHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var tileRect = new Rect(0, 0, imageWidth, imageHeight);
  var channelCount = channelCountForBitDepth(bitDepth);
  var sampleCount = bytesPerPixel / channelCount;
  channelCount = Math.round(bytesPerPixel / sampleCount);

  var tileIds = [];
  offset = readIdList(bytes, offset, tileIds, idSize);
  if (tileIds.length != Math.ceil(imageWidth / TILE_SIZE) * Math.ceil(imageHeight / TILE_SIZE)) {
    throw new RangeError("xcf: invalid tile offset count");
  }
  var tilePlanar = new PlanarRgbaBuffer(TILE_SIZE * TILE_SIZE * channelCount);
  var tileBounds = new Rect;
  var compressionType = compressionProps[XcfPropType.PROP_COMPRESSION][0];
  var channelSlices = [tilePlanar.h, tilePlanar.l, tilePlanar.O, tilePlanar.w];
  if (sampleCount == 3) tilePlanar.w.fill(255);

  var tileIndex = 0;
  for (var tileY = 0; tileY < imageHeight; tileY += TILE_SIZE) {
    for (var tileX = 0; tileX < imageWidth; tileX += TILE_SIZE) {
      var tileW = Math.min(imageWidth - tileX, TILE_SIZE);
      var tileH = Math.min(imageHeight - tileY, TILE_SIZE);
      var pixelCount = tileW * tileH;
      tileBounds.setXY(tileX, tileY, tileW, tileH);
      var tileOffset = tileIds[tileIndex++];
      var tileEnd = tileIndex < tileIds.length ? tileIds[tileIndex] : bytes.length;
      readTilePixels(bytes, tileOffset, pixelCount * channelCount, compressionType, sampleCount, channelSlices, tileEnd);
      if (bitDepth == 100 || bitDepth == 150) {
        if (bitDepth == 100) {
          for (var ch = 0; ch < colorSamples; ch++) {
            for (var px = 0; px < pixelCount; px++) {
              channelSlices[ch][px] = Math.round(255 * linearToSrgb(channelSlices[ch][px] / 255));
            }
          }
        }
      } else if (bitDepth == 250) {
        unpack16BitTo8(channelSlices, sampleCount, pixelCount);
      } else if (bitDepth == 600) {
        unpackHdrFloatTo8(channelSlices, sampleCount, pixelCount, colorSamples);
      } else {
        throw new RangeError("xcf: unsupported image precision");
      }
      copyChannelsWithClip(tilePlanar, tileBounds, planarBuffer, tileRect);
    }
  }
}

/** Collapse big-endian 16-bit samples to 8-bit in place. */
function unpack16BitTo8(channelSlices, sampleCount, pixelCount) {
  for (var ch = 0; ch < sampleCount; ch++) {
    var channelData = channelSlices[ch];
    for (var px = 0; px < pixelCount; px++) {
      var packed = channelData[px] << 8 | channelData[pixelCount + px];
      channelData[px] = Math.min(packed >>> 8, 255);
    }
  }
}

/** Convert linear float colors to sRGB bytes and keep alpha/mask coverage linear. */
function unpackHdrFloatTo8(channelSlices, sampleCount, pixelCount, colorSamples) {
  var hdrLut = getHdrFloatByteLut();
  var floatBits = new Uint32Array(1);
  var floatView = new Float32Array(floatBits.buffer);
  for (var ch = 0; ch < sampleCount; ch++) {
    var channelData = channelSlices[ch];
    for (var px = 0; px < pixelCount; px++) {
      floatBits[0] = channelData[px] << 24 | channelData[pixelCount + px] << 16 | channelData[(pixelCount << 1) + px] << 8 | channelData[(pixelCount << 1) + pixelCount + px] << 0;
      var floatVal = floatView[0];
      if (floatVal < 0) floatVal = 0;
      else if (floatVal > 1) floatVal = 1;
      channelData[px] = ch < colorSamples ? hdrLut[~~(.5 + floatVal * 1e3)] : Math.round(floatVal * 255);
    }
  }
}

let hdrFloatByteLutCache = null;

/** Lazily build the 0..1 linear-float → sRGB-byte lookup table. */
function getHdrFloatByteLut() {
  if (hdrFloatByteLutCache != null) return hdrFloatByteLutCache;
  hdrFloatByteLutCache = new Uint8Array(HDR_LUT_SIZE);
  for (var lutIdx = 0; lutIdx < HDR_LUT_SIZE; lutIdx++) {
    hdrFloatByteLutCache[lutIdx] = ~~(.49 + 255 * linearToSrgb(lutIdx * .001));
  }
  return hdrFloatByteLutCache;
}

/** Decode one compressed tile's samples into the channel-slice planes. */
function readTilePixels(bytes, offset, byteLength, compressionType, sampleCount, channelSlices, tileEnd) {
  if (compressionType == 1) {
    decodeRleTile(bytes.subarray(0, tileEnd), offset, byteLength, sampleCount, channelSlices);
  } else if (compressionType == 2) {
    decodeInterleavedTile(bytes.subarray(0, tileEnd), offset, byteLength, sampleCount, channelSlices, true);
  } else if (compressionType == 0) {
    decodeInterleavedTile(bytes.subarray(0, tileEnd), offset, byteLength, sampleCount, channelSlices, false);
  } else {
    throw new RangeError("xcf: unsupported compression " + compressionType);
  }
}

/** Decode a run-length-encoded tile into per-channel planes. */
function decodeRleTile(bytes, offset, byteLength, sampleCount, channelSlices) {
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > channelSlices.length || !Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new RangeError("xcf: invalid RLE channel layout");
  }
  for (var ch = 0; ch < sampleCount; ch++) {
    var channelData = channelSlices[ch];
    if (byteLength > channelData.length) throw new RangeError("xcf: RLE channel exceeds tile buffer");
    var writePos = 0;
    while (writePos < byteLength) {
      requireBytes(bytes, offset, 1);
      var runHeader = bytes[offset];
      offset++;
      var repeat = runHeader <= RLE_LONG_RUN;
      var runLength;
      if (runHeader == RLE_LONG_RUN || runHeader == RLE_LONG_COPY) {
        requireBytes(bytes, offset, 2);
        runLength = bytes[offset] << 8 | bytes[offset + 1];
        offset += 2;
      } else {
        runLength = repeat ? runHeader + 1 : 256 - runHeader;
      }
      if (runLength == 0 || runLength > byteLength - writePos) {
        throw new RangeError("xcf: invalid RLE run length");
      }
      requireBytes(bytes, offset, repeat ? 1 : runLength);
      if (repeat) {
        var runValue = bytes[offset++];
        channelData.fill(runValue, writePos, writePos + runLength);
      } else {
        channelData.set(bytes.subarray(offset, offset + runLength), writePos);
        offset += runLength;
      }
      writePos += runLength;
    }
  }
}

/** Decode raw/zlib pixel-interleaved big-endian samples into byte planes. */
function decodeInterleavedTile(bytes, offset, byteLength, sampleCount, channelSlices, compressed) {
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > channelSlices.length || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > channelSlices[0].length) {
    throw new RangeError("xcf: invalid interleaved channel layout");
  }
  var expectedLength = byteLength * sampleCount;
  var decoded;
  if (compressed) {
    decoded = new Uint8Array(expectedLength);
    var written = 0;
    var inflater = new pako.Inflate({ chunkSize: Math.min(expectedLength + 1, 16384) });
    inflater.onData = function(chunk) {
      if (chunk.length > expectedLength - written) throw new RangeError("xcf: invalid zlib tile length");
      decoded.set(chunk, written);
      written += chunk.length;
    };
    // Without a forced finish, ended proves that the checksum/stream end was read.
    inflater.push(bytes.subarray(offset), false);
    if (!inflater.ended || inflater.err || written != expectedLength) throw new RangeError("xcf: invalid zlib tile stream or length");
  } else {
    requireBytes(bytes, offset, expectedLength);
    decoded = bytes.subarray(offset, offset + expectedLength);
  }
  var bytesPerSample = channelSlices[0].length / (TILE_SIZE * TILE_SIZE);
  var pixelCount = byteLength / bytesPerSample;
  for (var px = 0; px < pixelCount; px++) {
    for (var ch = 0; ch < sampleCount; ch++) {
      for (var sampleByte = 0; sampleByte < bytesPerSample; sampleByte++) {
        channelSlices[ch][sampleByte * pixelCount + px] = decoded[(px * sampleCount + ch) * bytesPerSample + sampleByte];
      }
    }
  }
}

/** Read a zero-terminated list of id-sized ids into `outIds`. */
function readIdList(bytes, offset, outIds, idSize) {
  while (true) {
    var id = readOffset(bytes, offset, idSize);
    offset += idSize;
    if (id == 0) break;
    outIds.push(id);
  }
  return offset;
}

/** Read a property list (type, size, payload) until PROP_END. */
function readPropertyList(bytes, offset, outProps) {
  while (true) {
    requireBytes(bytes, offset, 8);
    var propType = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    var propSize = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    requireBytes(bytes, offset, propSize);
    if (propType == XcfPropType.PROP_END) {
      if (propSize != 0) throw new RangeError("xcf: invalid end property size");
      break;
    }
    var minimumSize = propType == XcfPropType.PROP_COMPRESSION ? 1 :
      propType == XcfPropType.PROP_OFFSETS ? 8 :
      [XcfPropType.PROP_OPACITY, XcfPropType.PROP_MODE, XcfPropType.PROP_VISIBLE,
        XcfPropType.PROP_APPLY_MASK, XcfPropType.PROP_GROUP_ITEM_FLAGS, XcfPropType.PROP_ITEM_PATH].includes(propType) ? 4 : 0;
    if (propSize < minimumSize || propType == XcfPropType.PROP_ITEM_PATH && propSize % 4 != 0) {
      throw new RangeError("xcf: invalid property size");
    }
    if (propType == XcfPropType.PROP_PARASITES) outProps[propType] = readParasiteMap(bytes, offset, offset + propSize);
    else outProps[propType] = BinaryUtils.readBytes(bytes, offset, propSize);
    offset += propSize;
  }
  return offset;
}

/** Read a parasite map (name → data bytes) within [offset, endOffset). */
function readParasiteMap(bytes, offset, endOffset) {
  var parasites = {};
  while (offset < endOffset) {
    var nameEntry = readXcfString(bytes, offset, endOffset);
    offset += nameEntry.size;
    requireBytes(bytes, offset, 8, endOffset);
    var flags = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    if (flags != 1) console.log("unknown flags", flags);
    var dataSize = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    requireBytes(bytes, offset, dataSize, endOffset);
    parasites[nameEntry.str] = BinaryUtils.readBytes(bytes, offset, dataSize);
    offset += dataSize;
  }
  return parasites;
}

const XCFParser = { parse, parseTextParasite, parseSExprTokens, channelCountForBitDepth, resolveGimpFontName };

export { XCFParser };
