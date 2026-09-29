import assert from "node:assert/strict";
import { it } from "node:test";
import { applyCutout } from "../../../src/engine/compositing/cutout-filter.js";
function solid(width, height, color) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(color, i);
  return pixels;
}
it("preserves a constant opaque color without modifying the source or output tail", () => {
  const source = solid(8, 8, [120, 80, 40, 255]);
  const before = source.slice();
  const output = new Uint8Array(source.length + 4).fill(17);
  applyCutout(source, 8, 8, output, [4, 2, 1]);
  assert.deepEqual(output.subarray(0, source.length), source);
  assert.deepEqual(output.subarray(source.length), new Uint8Array([17, 17, 17, 17]));
  assert.deepEqual(source, before);
});
it("processes a one-pixel image and supports in-place filtering", () => {
  const pixels = new Uint8Array([120, 80, 40, 255]);
  applyCutout(pixels, 1, 1, pixels, [4, 3, 1]);
  assert.deepEqual(pixels, new Uint8Array([120, 80, 40, 255]));
});
it("produces deterministic separated color regions for each edge-fidelity setting", () => {
  const width = 24, height = 12;
  const source = solid(width, height, [220, 30, 30, 255]);
  for (let y = 0; y < height; y++) for (let x = 12; x < width; x++) source.set([30, 40, 220, 255], (y * width + x) * 4);
  for (const fidelity of [1, 2, 3]) {
    const first = new Uint8Array(source.length), second = new Uint8Array(source.length);
    applyCutout(source, width, height, first, [4, 3, fidelity]);
    applyCutout(source, width, height, second, [4, 3, fidelity]);
    assert.deepEqual(first, second);
    const left = (6 * width + 3) * 4, right = (6 * width + 20) * 4;
    assert.ok(first[left] > first[left + 2]);
    assert.ok(first[right + 2] > first[right]);
  }
});
it("rejects undersized buffers before any segmentation work", () => {
  assert.throws(() => applyCutout(new Uint8Array(4), 2, 2, new Uint8Array(16), []), /buffer length mismatch/);
  assert.throws(() => applyCutout(new Uint8Array(16), 2, 2, new Uint8Array(4), []), /buffer length mismatch/);
});
it("clamps parameter values to their declared range", () => {
  const source = solid(8, 8, [120, 80, 40, 255]);
  const first = new Uint8Array(source.length), second = new Uint8Array(source.length);
  applyCutout(source, 8, 8, first, [100, 100, 100]);
  applyCutout(source, 8, 8, second, [8, 10, 3]);
  assert.deepEqual(first, second);
});
