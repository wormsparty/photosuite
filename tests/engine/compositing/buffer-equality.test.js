import assert from "node:assert/strict";
import { it } from "node:test";
import { equals } from "../../../src/engine/compositing/buffer-utils.js";

it("distinguishes displacement channels that differ only in trailing samples", () => {
  assert.equal(equals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(equals(new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([1, 2, 3, 4, 6])), false);
});

it("compares equal view bytes independently of unrelated surrounding bytes", () => {
  const a = new Uint8Array([99, 1, 2, 3, 98]);
  const b = new Uint8Array([88, 1, 2, 3, 87]);
  assert.equal(equals(a.subarray(1, 4), b.subarray(1, 4)), true);
});

it("uses the view length even when both views share a backing store", () => {
  const buffer = new Uint8Array([1, 2, 3, 4]);
  assert.equal(equals(buffer.subarray(0, 2), buffer.subarray(0, 3)), false);
  assert.equal(equals(buffer.subarray(0, 2), buffer.subarray(2, 4)), false);
});

it("compares the word-aligned path and its byte tail", () => {
  const a = new Uint8Array([8, 8, 8, 8, 1, 2, 3, 4, 5]);
  const b = new Uint8Array([9, 9, 9, 9, 1, 2, 3, 4, 5]);
  assert.equal(equals(a.subarray(4), b.subarray(4)), true);
  b[8] = 6;
  assert.equal(equals(a.subarray(4), b.subarray(4)), false);
});

it("treats empty views as equal even when their backing stores differ", () => {
  assert.equal(equals(new Uint8Array([1]).subarray(0, 0), new Uint8Array([2, 3]).subarray(1, 1)), true);
});
