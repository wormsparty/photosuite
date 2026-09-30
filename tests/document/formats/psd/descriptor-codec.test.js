import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let DescriptorCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ DescriptorCodec } = await import("../../../../src/document/formats/psd/descriptor-codec.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const unicode = (s) => [...u32(s.length + 1), ...s.split("").flatMap((c) => [c.charCodeAt(0) >>> 8, c.charCodeAt(0) & 255]), 0, 0];
// Build independent wire fixtures: a nonzero OSKey length carries exactly that
// many bytes, including when its length is less than four.
const explicitKey = (s) => [...u32(s.length), ...ascii(s)];
const float64 = (n) => {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat64(0, n);
  return [...data];
};
const encodeValue = (node) => {
  const buf = {
    data: new Uint8Array(1024),
    ensureCapacity(pos, size) { assert.ok(pos + size <= this.data.length, "bounded descriptor fixture"); },
  };
  return buf.data.slice(0, DescriptorCodec.writeValue(buf, 0, node));
};
const assertValueFixture = (node, fixture) => {
  const data = new Uint8Array(fixture);
  const decoded = DescriptorCodec.readValue(data, 0);
  assert.equal(decoded.size, data.length);
  delete decoded.size;
  assert.deepEqual(decoded, node);
  assert.deepEqual(encodeValue(node), data);
};

describe("document/formats/psd/descriptor-codec.js", () => {
  it("readOSKey reads a 4-char padded key and a length-prefixed key", () => {
    // len=0 → 4-char padded "Rd  "
    const padded = new Uint8Array([0, 0, 0, 0, ...ascii("Rd  ")]);
    assert.equal(DescriptorCodec.readOSKey(padded, 0), "Rd");
    // len=5 → "warpX"
    const long = new Uint8Array([0, 0, 0, 5, ...ascii("warpX")]);
    assert.equal(DescriptorCodec.readOSKey(long, 0), "warpX");
  });

  it("keySize returns 8 for a padded key, 4+len otherwise", () => {
    assert.equal(DescriptorCodec.keySize(new Uint8Array([0, 0, 0, 0]), 0), 8);
    assert.equal(DescriptorCodec.keySize(new Uint8Array([0, 0, 0, 5]), 0), 9);
  });

  it("readValue decodes a long value node with its byte size", () => {
    const bytes = new Uint8Array([...ascii("long"), 0, 0, 0, 42]);
    const node = DescriptorCodec.readValue(bytes, 0, false, 0);
    assert.equal(node.t, "long");
    assert.equal(node.v, 42);
    assert.equal(node.size, 8);
  });

  describe("signed integer widths", () => {
    // Signed 64-bit wire fixtures use BigInt only to generate independent bytes;
    // application descriptors retain exact, safe JavaScript Number values.
    const int64 = (n) => {
      const data = new Uint8Array(8);
      new DataView(data.buffer).setBigInt64(0, BigInt(n));
      return [...data];
    };
    for (const value of [0, -1, -2147483649, 2147483648, 4294967296, -4294967296,
      Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      it(`comp reads the complete signed 64-bit value ${value}`, () => {
        const data = new Uint8Array([...ascii("comp"), ...int64(value)]);
        assert.deepEqual(DescriptorCodec.readValue(data, 0), { t: "comp", v: value, size: 12 });
      });
      it(`comp writes both integer words for ${value}`, () => {
        assert.deepEqual(encodeValue({ t: "comp", v: value }),
          new Uint8Array([...ascii("comp"), ...int64(value)]));
      });
    }

    for (const value of [-2147483648, -1, 0, 2147483647]) {
      it(`long retains signed 32-bit boundary ${value}`, () => {
        assertValueFixture({ t: "long", v: value }, [...ascii("long"), ...u32(value)]);
      });
    }

    it("rejects signed 64-bit values outside exact Number precision", () => {
      for (const value of [9007199254740992n, -9007199254740992n,
        9223372036854775807n, -9223372036854775808n]) {
        assert.throws(() => DescriptorCodec.readValue(
          new Uint8Array([...ascii("comp"), ...int64(value)]), 0), /safe integer|precision|range/i);
      }
    });

    it("rejects invalid comp exports instead of truncating them", () => {
      for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1,
        1.5, NaN, Infinity, -Infinity, "42", 42n]) {
        assert.throws(() => encodeValue({ t: "comp", v: value }), /safe integer|precision|range/i);
      }
    });

    it("comp overwrites a reused buffer's high word", () => {
      const buf = { data: new Uint8Array(16).fill(255), ensureCapacity() {} };
      assert.equal(DescriptorCodec.writeValue(buf, 0, { t: "comp", v: 42 }), 12);
      assert.deepEqual(buf.data.slice(0, 12), new Uint8Array([...ascii("comp"), ...int64(42)]));
      assert.deepEqual(buf.data.slice(12), new Uint8Array(4).fill(255));
    });

  });

  describe("empty object arrays", () => {
  it("empty ObAr emits a zero array count and round-trips", () => {
    assertValueFixture({ t: "ObAr", v: { classID: "xx", arr: [] } }, [
      ...ascii("ObAr"), ...u32(0), ...unicode(""), ...explicitKey("xx"), ...u32(0),
    ]);
  });

  it("ObAr retains an existing channel with zero float values", () => {
    assertValueFixture({ t: "ObAr", v: { classID: "xx", arr: [
      { id: "yy", type: "UnFl", uID: "#Pxl", arr: [] },
    ] } }, [
      ...ascii("ObAr"), ...u32(0), ...unicode(""), ...explicitKey("xx"), ...u32(1),
      ...explicitKey("yy"), ...ascii("UnFl#Pxl"), ...u32(0),
    ]);
  });

  });

  it("flattenDescriptor recursively strips type tags (Objc/VlLs/UntF)", () => {
    const desc = {
      classID: "Foo",
      amount: { t: "long", v: 5 },
      angle: { t: "UntF", v: { type: "#Ang", val: 90 } },
      nested: { t: "Objc", v: { classID: "Bar", flag: { t: "bool", v: true } } },
      items: { t: "VlLs", v: [{ t: "long", v: 1 }, { t: "long", v: 2 }] },
    };
    assert.deepEqual(DescriptorCodec.flattenDescriptor(desc), {
      classID: "Foo",
      amount: 5,
      angle: 90,
      nested: { classID: "Bar", flag: true },
      items: [1, 2],
    });
  });

  for (const t of ["Clss", "type", "rele"]) {
    it(`${t} writer emits short explicit class keys without padding`, () => {
      const v = { classID: "xx", __name: "Class" };
      if (t === "rele") v.val = -2;
      assert.deepEqual(encodeValue({ t, v }), new Uint8Array([
        ...ascii(t), ...unicode("Class"), ...explicitKey("xx"),
        ...(t === "rele" ? u32(-2) : []),
      ]));
    });
    it(`${t} reads and writes canonical short explicit class keys`, () => {
      const v = { classID: "xx", __name: "Class" };
      if (t === "rele") v.val = -2;
      assertValueFixture({ t, v }, [
        ...ascii(t), ...unicode("Class"), ...explicitKey("xx"),
        ...(t === "rele" ? u32(-2) : []),
      ]);
    });
  }

  const references = [
    ["prop", { classID: "xx", keyID: "yy" }],
    ["Enmr", { classID: "xx", typeID: "yy", enum: "tx" }],
    ["indx", { classID: "xx", val: 7 }],
    ["name", { classID: "xx", val: "Layer" }],
  ];
  for (const [t, v] of references) {
    it(`${t} writer emits consecutive short explicit keys without padding`, () => {
      const keys = Object.entries(v).filter(([key]) => key !== "val").flatMap(([, value]) => explicitKey(value));
      const payload = t === "indx" ? u32(v.val) : t === "name" ? unicode(v.val) : [];
      assert.deepEqual(encodeValue({ t, v }), new Uint8Array([...ascii(t), ...unicode(""), ...keys, ...payload]));
    });
    it(`${t} preserves consecutive short explicit reference keys and payloads`, () => {
      const keys = Object.entries(v).filter(([key]) => key !== "val").flatMap(([, value]) => explicitKey(value));
      const payload = t === "indx" ? u32(v.val) : t === "name" ? unicode(v.val) : [];
      assertValueFixture({ t, v }, [...ascii(t), ...unicode(""), ...keys, ...payload]);
    });
  }

  it("ObAr reads and writes canonical short class/channel keys with doubles", () => {
    const node = { t: "ObAr", v: {
      classID: "xx", arr: [{ id: "yy", type: "UnFl", uID: "#Pxl", arr: [1.25, -2] }],
    } };
    assertValueFixture(node, [
      ...ascii("ObAr"), ...u32(2), ...unicode(""), ...explicitKey("xx"), ...u32(1),
      ...explicitKey("yy"), ...ascii("UnFl#Pxl"), ...u32(2), ...float64(1.25), ...float64(-2),
    ]);
  });

  it("ObAr writer emits short class/channel keys without padding", () => {
    const node = { t: "ObAr", v: {
      classID: "xx", arr: [{ id: "yy", type: "UnFl", uID: "#Pxl", arr: [1.25, -2] }],
    } };
    assert.deepEqual(encodeValue(node), new Uint8Array([
      ...ascii("ObAr"), ...u32(2), ...unicode(""), ...explicitKey("xx"), ...u32(1),
      ...explicitKey("yy"), ...ascii("UnFl#Pxl"), ...u32(2), ...float64(1.25), ...float64(-2),
    ]));
  });

  it("Pth preserves non-ASCII path characters and exact consumed byte count", () => {
    const node = { t: "Pth ", v: { sig: "txtu", pth: "/tmp/café.psd" } };
    const encoded = encodeValue(node);
    const decoded = DescriptorCodec.readValue(encoded, 0);
    assert.equal(decoded.size, encoded.length);
    delete decoded.size;
    assert.deepEqual(decoded, node);
  });

  it("retains padded short and long class/reference/channel keys inside a list", () => {
    const node = { t: "VlLs", v: [] };
    for (const classID of ["Lyr", "layerClass"]) {
      node.v.push(
        { t: "Clss", v: { classID } },
        { t: "rele", v: { classID, val: -1 } },
        { t: "prop", v: { classID, keyID: "Nm" } },
        { t: "Enmr", v: { classID, typeID: "Ordn", enum: "targetEnum" } },
        { t: "indx", v: { classID, val: 2 } },
        { t: "name", v: { classID, val: "Layer A" } },
        { t: "ObAr", v: { classID, arr: [
          { id: "Hrzn", type: "UnFl", uID: "#Pxl", arr: [3] },
          { id: "verticalChannel", type: "UnFl", uID: "#Pxl", arr: [-4] },
        ] } },
      );
    }
    const encoded = encodeValue(node);
    const decoded = DescriptorCodec.readValue(encoded, 0);
    assert.equal(decoded.size, encoded.length);
    delete decoded.size;
    assert.deepEqual(decoded, node);
  });
});
