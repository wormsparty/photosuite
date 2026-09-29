import assert from "node:assert/strict";
import { it } from "node:test";
import { copyBuffer } from "../../../src/engine/compositing/buffer-utils.js";

it("copies all bytes of a three-pixel mask including its trailing samples", () => {
  const destination = new Uint8Array(3);
  copyBuffer(new Uint8Array([20, 80, 255]), destination);
  assert.deepEqual([...destination], [20, 80, 255]);
});

it("respects source and destination view bounds without changing neighboring pixels", () => {
  const source = new Uint8Array([99, 10, 20, 30, 98]);
  const destination = new Uint8Array([7, 7, 7, 7, 7]);
  copyBuffer(source.subarray(1, 4), destination.subarray(1, 4));
  assert.deepEqual([...destination], [7, 10, 20, 30, 7]);
});

it("copies only the shared length when the destination is shorter", () => {
  const destination = new Uint8Array(2);
  copyBuffer(new Uint8Array([1, 2, 3, 4]), destination);
  assert.deepEqual([...destination], [1, 2]);
});

it("copies overlapping views as if the source were snapshotted", () => {
  const buffer = new Uint8Array([1, 2, 3, 4, 5]);
  copyBuffer(buffer.subarray(0, 4), buffer.subarray(1));
  assert.deepEqual([...buffer], [1, 1, 2, 3, 4]);
});

it("handles empty views without copying their backing store", () => {
  const buffer = new Uint8Array([8, 9, 10, 11]);
  copyBuffer(buffer.subarray(0, 0), buffer.subarray(1, 1));
  assert.deepEqual([...buffer], [8, 9, 10, 11]);
});
