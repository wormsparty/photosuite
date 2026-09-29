import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let FileFormatRegistry;
let FileProcessor;
let restore;

before(async () => {
  restore = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ FileFormatRegistry } = await import("../../../../src/document/formats/registry/file-format-registry.js"));
  ({ FileProcessor } = await import("../../../../src/ui/shell/file-loader.js"));
});
after(() => restore?.());

const pixels = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
]);

// Independent Windows BMP fixture: 24-bit bottom-up BGR rows padded to 8 bytes.
function smallBmp() {
  const bytes = new Uint8Array(70);
  const view = new DataView(bytes.buffer);
  bytes.set([66, 77]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 2, true);
  view.setInt32(22, 2, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, 16, true);
  bytes.set([255, 0, 0, 255, 255, 255, 0, 0], 54);
  bytes.set([0, 0, 255, 0, 255, 0, 0, 0], 62);
  return bytes.buffer;
}

function openPixels(bytes) {
  let result;
  const decodePending = FileProcessor.dispatchOpenBytes(
    { name: "tiny.bmp" }, bytes, { hideOpenVeil() {}, dispatch() {} },
    (rgba, rect) => { result = { rgba, rect }; },
  );
  assert.equal(decodePending, false, "BMP opens synchronously without a deferred decoder");
  assert.ok(result, "the real file-open path must deliver decoded pixels");
  return result;
}

describe("BMP registry and file-open wiring", () => {
  it("opens an independent padded BMP fixture through the real detected-format path", () => {
    const bytes = smallBmp();
    assert.equal(FileFormatRegistry.detectFormat(bytes), "bmp");
    const result = openPixels(bytes);
    assert.equal(result.rect.width, 2);
    assert.equal(result.rect.height, 2);
    assert.deepEqual(result.rgba, pixels);
  });

  it("exports through FileProcessor/registry and reopens pixels in row/color order", () => {
    const doc = {
      width: 2, height: 2, dpi: 72, layers: [], extraChannels: [],
      getRasterData() { return pixels.slice(); },
    };
    const bytes = FileProcessor.encodeDocumentWithFormat(doc, "bmp", {});
    assert.ok(bytes instanceof ArrayBuffer);
    assert.equal(FileFormatRegistry.detectFormat(bytes), "bmp");
    const result = openPixels(bytes);
    assert.equal(result.rect.width, doc.width);
    assert.equal(result.rect.height, doc.height);
    assert.deepEqual(result.rgba, pixels);
  });

  it("offers the usable BMP encoder in the export/save format catalogs", () => {
    assert.ok(FileFormatRegistry.listEncodableFormats().includes("BMP"));
    assert.ok(FileFormatRegistry.listSaveFormats().includes("BMP"));
  });
});
