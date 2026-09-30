/**
 * Golden values for action-file (.atn codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ActionParser;
let RenderBuffer;

const SERIALIZED_SAMPLE = [
  0, 0, 0, 16, 0, 0, 0, 7, 0, 77, 0, 121, 0, 32, 0, 83, 0, 101, 0, 116, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 10, 0, 77, 0, 121, 0, 32, 0, 65, 0, 99, 0, 116, 0, 105, 0, 111, 0, 110, 0, 0, 1, 0,
  0, 0, 1, 0, 1, 0, 0, 84, 69, 88, 84, 0, 0, 0, 3, 115, 101, 116, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0,
  0, 1, 0, 0, 0, 0, 0, 0, 110, 117, 108, 108, 0, 0, 0, 0,
];

const SERIALIZED_EMPTY = [0, 0, 0, 16, 0, 0, 0, 2, 0, 69, 0, 0, 0, 0, 0, 0, 0];

function sampleActionSet() {
  return {
    name: "My Set",
    expanded: true,
    children: [
      {
        index: 1,
        shift: false,
        commandKeyEnabled: false,
        color: 0,
        name: "My Action",
        expanded: true,
        children: [
          {
            expanded: false,
            enabled: true,
            dialogOptionsEnabled: false,
            dialogOptions: 0,
            uf: "set",
            eventClassName: "",
            actionDescriptor: { classID: "null" },
          },
        ],
      },
    ],
  };
}

before(async () => {
  ({ ActionParser } = await import("../../../src/features/scripting/action-file.js"));
  ({ RenderBuffer } = await import("../../../src/core/render-buffer.js"));
});

describe("features/scripting/action-file.js", () => {
  it("serialize writes bytes matching the golden bytes", () => {
    const bytes = new Uint8Array(ActionParser.serialize(sampleActionSet()));
    assert.equal(bytes.byteLength, 103);
    assert.deepEqual([...bytes], SERIALIZED_SAMPLE);
    assert.deepEqual(
      [...new Uint8Array(ActionParser.serialize({ name: "E", expanded: false, children: [] }))],
      SERIALIZED_EMPTY,
    );
  });

  it("parse round-trips serialize and preserves tree fields", () => {
    const parsed = ActionParser.parse(ActionParser.serialize(sampleActionSet()));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "My Set");
    assert.equal(parsed[0].expanded, true);
    assert.equal(parsed[0].children.length, 1);
    assert.equal(parsed[0].children[0].name, "My Action");
    assert.equal(parsed[0].children[0].commandKeyEnabled, false);
    const step = parsed[0].children[0].children[0];
    assert.equal(step.uf, "set");
    assert.equal(step.enabled, true);
    assert.equal(step.eventClassName, "");
    assert.equal(step.actionDescriptor.classID, "null");

    // Round-trip: re-serialising the parsed tree reproduces the original bytes.
    assert.deepEqual(
      [...new Uint8Array(ActionParser.serialize(parsed[0]))],
      SERIALIZED_SAMPLE,
    );
  });

  it("length-prefixed string helpers round-trip", () => {
    const buffer = new RenderBuffer();
    ActionParser.writeLengthPrefixedString(buffer, 0, "abcd");
    assert.equal(ActionParser.readLengthPrefixedString(buffer.data, 0), "abcd");
  });

  it("round-trips a recorded step without an event class name", () => {
    const actionSet = sampleActionSet();
    const step = actionSet.children[0].children[0];
    delete step.eventClassName;

    const [imported] = ActionParser.parse(ActionParser.serialize(actionSet));
    const importedStep = imported.children[0].children[0];
    assert.equal(importedStep.uf, "set");
    assert.equal(importedStep.eventClassName, "");
    assert.equal(importedStep.enabled, true);
    assert.equal(importedStep.actionDescriptor.classID, "null");
  });

  it("round-trips Unicode names, multiple actions and mixed step encodings with their flags", () => {
    const set = sampleActionSet();
    set.name = "Épreuves 🎨";
    set.children[0].name = "調整";
    set.children[0].index = 12;
    set.children[0].shift = true;
    set.children[0].commandKeyEnabled = true;
    set.children[0].color = 5;
    set.children[0].children.push({
      expanded: true, enabled: false, dialogOptionsEnabled: true,
      dialogOptions: 2, uf: "LqFy", eventClassName: "filter",
    });
    set.children.push({
      index: 3, shift: false, commandKeyEnabled: false, color: 0,
      name: "Empty", expanded: false, children: [],
    });
    const bytes = ActionParser.serialize(set);
    const [imported] = ActionParser.parse(bytes);
    assert.deepEqual(imported, set);
    assert.deepEqual(new Uint8Array(ActionParser.serialize(imported)), new Uint8Array(bytes));
  });

  it("rejects a truncated header, Unicode field, action count and step descriptor", () => {
    const sample = new Uint8Array(ActionParser.serialize(sampleActionSet()));
    // Every fixture retains only tiny, known-good declared counts. Never feed
    // the previous parser a large hostile count to obtain before evidence.
    for (const end of [0, 3, 8, 24, sample.length - 1]) {
      assert.throws(() => ActionParser.parse(sample.slice(0, end).buffer),
        `truncated at byte ${end}`);
    }
  });

  it("rejects an unsupported ATN version before reading the tree", () => {
    const bytes = Uint8Array.from(SERIALIZED_EMPTY);
    bytes[3] = 15;
    assert.throws(() => ActionParser.parse(bytes.buffer), /version|action/i);
  });

  it("rejects a declared second action when only one action is present", () => {
    const bytes = Uint8Array.from(SERIALIZED_SAMPLE);
    bytes[26] = 2;
    assert.throws(() => ActionParser.parse(bytes.buffer));
  });

  it("rejects missing empty-set flag and count bytes instead of importing an incomplete set", () => {
    const bytes = Uint8Array.from(SERIALIZED_EMPTY);
    for (const end of [8, 12, 13, 14, 15, 16]) {
      assert.throws(() => ActionParser.parse(bytes.slice(0, end).buffer), `truncated at byte ${end}`);
    }
  });

  it("rejects oversized outer names and record counts before allocating or iterating (after-only)", () => {
    const fixture = sampleActionSet();
    fixture.name = "E";
    fixture.children[0].name = "";
    const original = new Uint8Array(ActionParser.serialize(fixture));
    // Offsets address set name/count, action name/step count, TEXT event
    // length and event-class length. Guarded parser only: never execute these
    // allocation/iteration hazards against its unsafe previous state.
    for (const offset of [4, 13, 23, 30, 42, 49]) {
      const bytes = original.slice();
      bytes.fill(255, offset, offset + 4);
      assert.throws(() => ActionParser.parse(bytes.buffer), /Invalid ATN/, `field at byte ${offset}`);
    }
  });

  it("rejects missing Unicode terminators and an invalid descriptor marker", () => {
    const empty = Uint8Array.from(SERIALIZED_EMPTY);
    empty[11] = 1;
    assert.throws(() => ActionParser.parse(empty.buffer), /Invalid ATN/);
    const sample = Uint8Array.from(SERIALIZED_SAMPLE);
    sample.fill(0, 81, 85);
    sample[84] = 1;
    assert.throws(() => ActionParser.parse(sample.buffer), /Invalid ATN/);
  });

  it("preserves nested typed descriptors and following steps on import", () => {
    const set = sampleActionSet();
    const descriptor = {
      classID: "null", __name: "Paramètres",
      flag: { t: "bool", v: true },
      text: { t: "TEXT", v: "Été 🎨" },
      raw: { t: "tdta", v: [0, 127, 255] },
      list: { t: "VlLs", v: [{ t: "long", v: -7 }, { t: "Objc", v: {
        classID: "null", amount: { t: "UntF", v: { type: "#Prc", val: 12.5 } },
      } }] },
      path: { t: "Pth ", v: { sig: "txtu", pth: "/tmp/été.psd" } },
      alias: { t: "alis", v: "small.bin" },
      reference: { t: "obj ", v: [
        { t: "prop", v: { classID: "Lyr", keyID: "Nm" } },
        { t: "Enmr", v: { classID: "Lyr", typeID: "Ordn", enum: "Trgt" } },
        { t: "indx", v: { classID: "Lyr", val: 2 } },
        { t: "name", v: { classID: "Lyr", val: "Épreuve" } },
      ] },
      array: { t: "ObAr", v: { classID: "null", arr: [
        { id: "Hrzn", type: "UnFl", uID: "#Pxl", arr: [1.25, -2] },
      ] } },
    };
    set.children[0].children[0].actionDescriptor = descriptor;
    set.children[0].children.push({ expanded: false, enabled: true,
      dialogOptionsEnabled: false, dialogOptions: 0, uf: "Mk  ", eventClassName: "" });
    const [parsed] = ActionParser.parse(ActionParser.serialize(set));
    assert.deepEqual(parsed.children[0].children[0].actionDescriptor, descriptor);
    assert.equal(parsed.children[0].children[1].uf, "Mk  ");
    assert.equal(parsed.children[0].children[1].enabled, true);
  });

  it("preserves signed integer widths and a following action step", () => {
    const set = sampleActionSet();
    const descriptor = { classID: "null", values: { t: "VlLs", v: [
      ...[-1, -2147483648, 2147483647].map(v => ({ t: "long", v })),
      ...[-1, 4294967296, -4294967296, Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER].map(v => ({ t: "comp", v })),
    ] } };
    set.children[0].children[0].actionDescriptor = descriptor;
    set.children[0].children.push({ expanded: false, enabled: true,
      dialogOptionsEnabled: false, dialogOptions: 0, uf: "Mk  ", eventClassName: "" });
    const [parsed] = ActionParser.parse(ActionParser.serialize(set));
    assert.deepEqual(parsed.children[0].children[0].actionDescriptor, descriptor);
    assert.equal(parsed.children[0].children[1].uf, "Mk  ");
  });

  it("preserves an empty object array and a following action step", () => {
    const set = sampleActionSet();
    const descriptor = { classID: "null", channels: { t: "ObAr", v: { classID: "null", arr: [] } },
      following: { t: "bool", v: true } };
    set.children[0].children[0].actionDescriptor = descriptor;
    set.children[0].children.push({ expanded: false, enabled: true,
      dialogOptionsEnabled: false, dialogOptions: 0, uf: "Mk  ", eventClassName: "" });
    const [parsed] = ActionParser.parse(ActionParser.serialize(set));
    assert.deepEqual(parsed.children[0].children[0].actionDescriptor, descriptor);
    assert.equal(parsed.children[0].children[1].uf, "Mk  ");
  });

  it("rejects negative embedded descriptor field counts and key lengths", () => {
    // Descriptor starts at byte 85: six-byte empty Unicode name, eight-byte
    // class key, then the four-byte field count. Tiny fixtures are safe before.
    for (const offset of [91, 99]) {
      const bytes = Uint8Array.from(SERIALIZED_SAMPLE);
      bytes.fill(255, offset, offset + 4);
      assert.throws(() => ActionParser.parse(bytes.buffer), `negative field at ${offset}`);
    }
  });

  it("rejects truncated embedded scalar and variable-length payloads", () => {
    for (const node of [
      { t: "bool", v: true }, { t: "long", v: 7 }, { t: "doub", v: 2.5 },
      { t: "UntF", v: { type: "#Prc", val: 25 } },
      { t: "TEXT", v: "é" }, { t: "tdta", v: [7] },
      { t: "alis", v: "a" }, { t: "Pth ", v: { sig: "txtu", pth: "a" } },
    ]) {
      const set = sampleActionSet();
      set.children[0].children[0].actionDescriptor = { classID: "null", data: node };
      const bytes = new Uint8Array(ActionParser.serialize(set));
      assert.throws(() => ActionParser.parse(bytes.slice(0, -1).buffer), node.t);
    }
  });

  it("rejects oversized embedded declarations before allocation or iteration (after-only)", () => {
    // Never run these hostile declarations against the historical decoder.
    for (const type of ["TEXT", "tdta", "alis", "VlLs"]) {
      const set = sampleActionSet();
      const values = { TEXT: "a", tdta: [1], alis: "a", VlLs: [] };
      set.children[0].children[0].actionDescriptor = {
        classID: "null", data: { t: type, v: values[type] },
      };
      const bytes = new Uint8Array(ActionParser.serialize(set));
      // One fixed-size field key and its type follow the empty descriptor header.
      bytes.fill(255, 115, 119);
      assert.throws(() => ActionParser.parse(bytes.buffer), type);
    }
    const bytes = Uint8Array.from(SERIALIZED_SAMPLE);
    bytes.fill(255, 85, 89);
    assert.throws(() => ActionParser.parse(bytes.buffer), "Unicode name count");
  });

  it("rejects excessive embedded nesting and permits a fresh bounded parse (after-only)", () => {
    const set = sampleActionSet();
    let node = { t: "long", v: 1 };
    for (let depth = 0; depth < 80; depth++) node = { t: "VlLs", v: [node] };
    set.children[0].children[0].actionDescriptor = { classID: "null", data: node };
    assert.throws(() => ActionParser.parse(ActionParser.serialize(set)), /depth|nest|limit/i);
    assert.equal(ActionParser.parse(Uint8Array.from(SERIALIZED_SAMPLE).buffer)[0].name, "My Set");
  });


  it("bounds embedded object-array channel and value counts (after-only)", () => {
    const set = sampleActionSet();
    set.children[0].children[0].actionDescriptor = {
      classID: "null", data: { t: "ObAr", v: { classID: "null", arr: [
        { id: "Hrzn", type: "UnFl", uID: "#Pxl", arr: [1] },
      ] } },
    };
    const original = new Uint8Array(ActionParser.serialize(set));
    // Payload starts at 115; count/name/class precede the channel count.
    // A fixed channel header precedes its value count. Guarded decoder only.
    for (const offset of [133, 153]) {
      const bytes = original.slice();
      bytes.fill(255, offset, offset + 4);
      assert.throws(() => ActionParser.parse(bytes.buffer), `array count at ${offset}`);
    }
  });

});
