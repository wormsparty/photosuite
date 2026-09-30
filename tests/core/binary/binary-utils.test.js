import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BinaryUtils } from "../../../src/core/binary/binary-utils.js";

describe("core/binary/binary-utils.js", () => {
  it("fourCC round-trip", () => {
    const code = "8BIM";
    assert.equal(BinaryUtils.uint32ToFourCC(BinaryUtils.fourCCToUint32(code)), code);
  });

  it("read/write uint16 LE raw", () => {
    const buf = new Uint8Array(2);
    BinaryUtils.writeUint16LEraw(buf, 0, 0x1234);
    assert.equal(BinaryUtils.readUint16LE(buf, 0), 0x1234);
  });

  it("readUtf8 decodes ASCII", () => {
    const bytes = new Uint8Array([72, 105]);
    assert.equal(BinaryUtils.readUtf8(bytes, 0, 2), "Hi");
  });

  describe("unsigned 64-bit sizes and offsets", () => {
    const fixtures = [
      [0, [0, 0, 0, 0, 0, 0, 0, 0]],
      [42, [0, 0, 0, 0, 0, 0, 0, 42]],
      [0x80000000, [0, 0, 0, 0, 128, 0, 0, 0]],
      [0xffffffff, [0, 0, 0, 0, 255, 255, 255, 255]],
      [0x100000000, [0, 0, 0, 1, 0, 0, 0, 0]],
      [0x100000001, [0, 0, 0, 1, 0, 0, 0, 1]],
      [Number.MAX_SAFE_INTEGER, [0, 31, 255, 255, 255, 255, 255, 255]],
    ];
    for (const [value, bytes] of fixtures) {
      it(`reads independently encoded ${value} with a nonzero view offset`, () => {
        const backing = new Uint8Array([99, 98, 97, ...bytes, 96]);
        assert.equal(BinaryUtils.readInt64BE(backing.subarray(1), 2), value);
      });
      it(`writes independently expected bytes for ${value}`, () => {
        const dest = new Uint8Array(10).fill(99);
        BinaryUtils.writeInt64BERaw(dest, 1, value);
        assert.deepEqual(dest, new Uint8Array([99, ...bytes, 99]));
      });
    }

    it("grows the writer for eight bytes and preserves neighboring data", () => {
      const calls = [];
      const writer = {
        data: new Uint8Array([99]),
        ensureCapacity(pos, size) {
          calls.push([pos, size]);
          const next = new Uint8Array(pos + size);
          next.set(this.data);
          this.data = next;
        },
      };
      BinaryUtils.writeInt64BE(writer, 1, 0x100000001);
      assert.deepEqual(calls, [[1, 8]]);
      assert.deepEqual(writer.data, new Uint8Array([99, 0, 0, 0, 1, 0, 0, 0, 1]));
    });

    it("rejects unsafe unsigned reads instead of returning rounded values", () => {
      for (const bytes of [[0, 32, 0, 0, 0, 0, 0, 0], Array(8).fill(255)]) {
        assert.throws(() => BinaryUtils.readInt64BE(new Uint8Array(bytes), 0), RangeError);
      }
    });

    it("rejects invalid values before writing or growing", () => {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const dest = new Uint8Array(8).fill(99);
        assert.throws(() => BinaryUtils.writeInt64BERaw(dest, 0, value), RangeError);
        assert.deepEqual(dest, new Uint8Array(8).fill(99));
        let grew = false;
        const writer = { data: dest, ensureCapacity() { grew = true; } };
        assert.throws(() => BinaryUtils.writeInt64BE(writer, 0, value), RangeError);
        assert.equal(grew, false);
      }
    });

    it("rejects truncated reads and writes without modifying output", () => {
      for (const [length, offset] of [[7, 0], [8, 1], [8, -1], [8, 0.5]]) {
        const dest = new Uint8Array(length).fill(99);
        assert.throws(() => BinaryUtils.readInt64BE(dest, offset), RangeError);
        assert.throws(() => BinaryUtils.writeInt64BERaw(dest, offset, 42), RangeError);
        assert.deepEqual(dest, new Uint8Array(length).fill(99));
      }
    });

    it("honors the visible typed-array boundary", () => {
      const backing = new Uint8Array(10).fill(99);
      const truncated = backing.subarray(2, 9);
      assert.throws(() => BinaryUtils.readInt64BE(truncated, 0), RangeError);
      assert.throws(() => BinaryUtils.writeInt64BERaw(truncated, 0, 42), RangeError);
      assert.deepEqual(backing, new Uint8Array(10).fill(99));
    });

    it("rejects invalid writer positions before capacity requests", () => {
      for (const pos of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        let grew = false;
        const writer = { data: new Uint8Array(8), ensureCapacity() { grew = true; } };
        assert.throws(() => BinaryUtils.writeInt64BE(writer, pos, 42), RangeError);
        assert.equal(grew, false);
      }
    });
  });
});
