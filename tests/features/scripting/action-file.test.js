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
});
