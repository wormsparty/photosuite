/**
 * Golden values for action-desc helpers (refs, locale keys, layer index resolve).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ActionDescUtil;
let TrackerRegistry;
let Layer;
let Document;
let installWebviewConfirm;
let installToastPainter;

before(async () => {
  await import("../../../src/features/filters/filter-registry.js");
  await import("../../../src/features/filters/gallery/gallery-filter-defs.js");
  ({ ActionDescUtil } = await import("../../../src/features/scripting/action-desc.js"));
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import("../../../src/features/trackers/register-trackers.js");
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ Document } = await import("../../../src/document/model/document.js"));
  ({ installWebviewConfirm, installToastPainter } = await import("../../../src/core/user-prompts.js"));
});

describe("features/scripting/action-desc.js", () => {
  it("buildTargetRef builds class or Ordn/Trgt enum refs", () => {
    assert.deepEqual(ActionDescUtil.buildTargetRef("Lyr", false), {
      t: "obj ",
      v: [{ t: "Clss", v: { classID: "Lyr" } }],
    });
    assert.deepEqual(ActionDescUtil.buildTargetRef("Lyr", true), {
      t: "obj ",
      v: [
        {
          t: "Enmr",
          v: { classID: "Lyr", typeID: "Ordn", enum: "Trgt" },
        },
      ],
    });
  });

  it("buildSetLayerPropertyAction wraps a set-Lyr descriptor", () => {
    assert.deepEqual(
      ActionDescUtil.buildSetLayerPropertyAction("Nm", { t: "TEXT", v: "X" }),
      {
        uf: "set",
        actionDescriptor: {
          classID: "null",
          null: ActionDescUtil.buildTargetRef("Lyr", true),
          T: {
            t: "Objc",
            v: { classID: "Lyr", Nm: { t: "TEXT", v: "X" } },
          },
        },
      },
    );
  });

  it("getActionStepLocaleKey maps verbs and make/select targets", () => {
    assert.equal(ActionDescUtil.getActionStepLocaleKey({ uf: "cut" }), "clipboard.cut");
    assert.equal(ActionDescUtil.getActionStepLocaleKey({ uf: "feather" }), "select.feather");
    assert.equal(
      ActionDescUtil.getActionStepLocaleKey({
        uf: "make",
        actionDescriptor: {
          null: {
            v: [{ t: "Enmr", v: { classID: "AdjL", typeID: "Ordn", enum: "Trgt" } }],
          },
        },
      }),
      "layer.newAdjustmentLayer",
    );
    assert.equal(
      ActionDescUtil.getActionStepLocaleKey({
        uf: "select",
        actionDescriptor: {
          null: {
            v: [{ t: "name", v: { classID: "Lyr", val: "Background" } }],
          },
        },
      }),
      'Select Layer "Background"',
    );
    assert.equal(ActionDescUtil.getActionStepLocaleKey({ uf: "purge" }), "Purge");
  });

  it("resolveLayerIndexFromRef resolves name and Ordn enums", () => {
    const doc = {
      layers: [{ getName: () => "A" }, { getName: () => "B" }],
      selectedLayerIndices: [1],
    };
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "name", v: { val: "B" } }),
      1,
    );
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "Enmr", v: { enum: "Trgt" } }),
      1,
    );
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "Enmr", v: { enum: "Bckw" } }),
      0,
    );
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "prop", v: { keyID: "Bckg" } }),
      0,
    );
  });

  it("plays the named set's enabled steps in order and skips disabled steps", () => {
    const actionSets = [
      { name: "Other set", children: [{ name: "Action", children: [{ enabled: true, uf: "wrong-set" }] }] },
      { name: "Set", children: [
        { name: "Other action", children: [{ enabled: true, uf: "wrong-action" }] },
        { name: "Action", children: [
          { enabled: true, uf: "first", actionDescriptor: { value: 1 } },
          { enabled: false, uf: "disabled", actionDescriptor: { value: 2 } },
          { enabled: true, uf: "last", actionDescriptor: { value: 3 } },
        ] },
      ] },
    ];
    const dispatched = [];
    ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", {
      dispatch(event) { dispatched.push({ type: event.type, data: structuredClone(event.data) }); },
    });
    assert.deepEqual(dispatched.map(({ data }) => data), [
      { uf: "first", actionDescriptor: { value: 1 } },
      { uf: "last", actionDescriptor: { value: 3 } },
    ]);
  });

  it("ignores playback when a previously saved action name no longer exists", () => {
    const actionSets = [{ name: "Set", children: [{
      name: "Current", children: [{ enabled: true, uf: "make" }],
    }] }];
    const dispatched = [];
    assert.doesNotThrow(() => ActionDescUtil.playActionSetSteps(
      {}, actionSets, "Deleted", "Set", {
        dispatch(event) { dispatched.push(event); },
      },
    ));
    assert.deepEqual(dispatched, []);
  });

  it("does not choose an arbitrary action when a scripted name pair is ambiguous", () => {
    const actionSets = [
      { name: "Set", children: [
        { name: "Action", children: [{ enabled: true, uf: "first" }] },
        { name: "Action", children: [{ enabled: true, uf: "second" }] },
      ] },
      { name: "Set", children: [
        { name: "Action", children: [{ enabled: true, uf: "third" }] },
      ] },
    ];
    const dispatched = [];
    const messages = [];
    installToastPainter((message) => messages.push(message));
    try {
      ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", {
        dispatch(event) { dispatched.push(event.data.uf); },
      });
    } finally {
      installToastPainter(null);
    }
    assert.deepEqual(dispatched, []);
    assert.deepEqual(messages, ['Several actions are named "Action" in set "Set"; none was played.']);
  });

  it("a nested Play dispatches a unique target and leaves an ambiguous target untouched", () => {
    const playStep = (actionName, setName) => ({
      enabled: true,
      uf: "play",
      actionDescriptor: { null: { v: [
        { v: { val: actionName } }, { v: { val: setName } },
      ] } },
    });
    const actionSets = [
      { name: "Set", children: [
        { name: "Caller", children: [
          playStep("Unique", "Set"),
          playStep("Duplicate", "Set"),
          playStep("Removed", "Set"),
        ] },
        { name: "Unique", children: [{ enabled: true, uf: "unique-step" }] },
        { name: "Duplicate", children: [{ enabled: true, uf: "wrong-first" }] },
        { name: "Duplicate", children: [{ enabled: true, uf: "wrong-last" }] },
      ] },
    ];
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          const [actionName, setName] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, actionName, setName, this);
        } else {
          dispatched.push(event.data.uf);
        }
      },
    };
    ActionDescUtil.playActionSetSteps({}, actionSets, "Caller", "Set", dispatcher);
    assert.deepEqual(dispatched, ["unique-step"]);
  });

  it("stops a direct nested Play self-reference and continues the caller", () => {
    const playSelf = {
      enabled: true,
      uf: "play",
      actionDescriptor: { null: { v: [
        { v: { val: "Caller" } }, { v: { val: "Set" } },
      ] } },
    };
    const actionSets = [{ name: "Set", children: [{ name: "Caller", children: [
      { enabled: true, uf: "before" }, playSelf, { enabled: true, uf: "after" },
    ] }] }];
    const dispatched = [];
    let nestedCalls = 0;
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          nestedCalls++;
          const [name, set] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, name, set, this);
        } else dispatched.push(event.data.uf);
      },
    };

    ActionDescUtil.playActionSetSteps({}, actionSets, "Caller", "Set", dispatcher);
    assert.equal(nestedCalls, 1);
    assert.deepEqual(dispatched, ["before", "after"]);
  });

  it("stops a two-action nested Play cycle and preserves remaining steps", () => {
    const play = (name) => ({
      enabled: true,
      uf: "play",
      actionDescriptor: { null: { v: [
        { v: { val: name } }, { v: { val: "Set" } },
      ] } },
    });
    const actionSets = [{ name: "Set", children: [
      { name: "A", children: [
        { enabled: true, uf: "a-before" }, play("B"), { enabled: true, uf: "a-after" },
      ] },
      { name: "B", children: [
        { enabled: true, uf: "b-before" }, play("A"), { enabled: true, uf: "b-after" },
      ] },
    ] }];
    const dispatched = [];
    let nestedCalls = 0;
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          nestedCalls++;
          const [name, set] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, name, set, this);
        } else dispatched.push(event.data.uf);
      },
    };

    const messages = [];
    installToastPainter((message) => messages.push(message));
    try {
      ActionDescUtil.playActionSetSteps({}, actionSets, "A", "Set", dispatcher);
    } finally {
      installToastPainter(null);
    }
    assert.equal(nestedCalls, 2);
    assert.deepEqual(dispatched, ["a-before", "b-before", "b-after", "a-after"]);
    assert.deepEqual(messages, ['Action "A" plays itself; the nested Play was skipped.']);
  });

  it("plays an acyclic nested chain in order", () => {
    const play = (name) => ({
      enabled: true,
      uf: "play",
      actionDescriptor: { null: { v: [
        { v: { val: name } }, { v: { val: "Set" } },
      ] } },
    });
    const actionSets = [{ name: "Set", children: [
      { name: "A", children: [{ enabled: true, uf: "a-before" }, play("B"), { enabled: true, uf: "a-after" }] },
      { name: "B", children: [{ enabled: true, uf: "b-before" }, play("C"), { enabled: true, uf: "b-after" }] },
      { name: "C", children: [{ enabled: true, uf: "c" }] },
    ] }];
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          const [name, set] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, name, set, this);
        } else dispatched.push(event.data.uf);
      },
    };

    ActionDescUtil.playActionSetSteps({}, actionSets, "A", "Set", dispatcher);
    assert.deepEqual(dispatched, ["a-before", "b-before", "c", "b-after", "a-after"]);
  });

  it("bounds conditional self-expansion and resets the limit for a later playback", () => {
    const actionSets = [{ name: "Set", children: [
      { name: "Loop", children: [{
        enabled: true,
        uf: "conditional",
        actionDescriptor: {
          null: { v: { Cndt: "Pxel" } },
          then: { v: [{ v: { val: "Loop" } }, { v: { val: "Set" } }] },
        },
      }] },
      { name: "Later", children: [{ enabled: true, uf: "later-step" }] },
    ] }];
    let conditionChecks = 0;
    const doc = {
      layers: [{}],
      selectedLayerIndices: [0],
      ensureLayerEditableForTools() { conditionChecks++; return true; },
    };
    const dispatched = [];
    const dispatcher = { dispatch(event) { dispatched.push(event.data.uf); } };

    const messages = [];
    installToastPainter((message) => messages.push(message));
    try {
      assert.doesNotThrow(() => ActionDescUtil.playActionSetSteps(doc, actionSets, "Loop", "Set", dispatcher));
    } finally {
      installToastPainter(null);
    }
    assert.equal(conditionChecks, ActionDescUtil.maxRecordedPlaybackSteps);
    assert.deepEqual(dispatched, []);
    assert.deepEqual(messages, [`Action playback stopped after ${ActionDescUtil.maxRecordedPlaybackSteps} steps.`]);
    ActionDescUtil.playActionSetSteps(doc, actionSets, "Later", "Set", dispatcher);
    assert.deepEqual(dispatched, ["later-step"]);
  });

  it("cleans up every nested replay frame after a dispatch error", () => {
    const actionSets = [{ name: "Set", children: [
      { name: "Caller", children: [{ enabled: true, uf: "play", actionDescriptor: {
        null: { v: [{ v: { val: "Child" } }, { v: { val: "Set" } }] },
      } }, { enabled: true, uf: "caller-after" }] },
      { name: "Child", children: [{ enabled: true, uf: "child" }] },
    ] }];
    const failure = new Error("dispatch failed");
    let fail = true;
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          const [name, set] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, name, set, this);
        } else if (fail) throw failure;
        else dispatched.push(event.data.uf);
      },
    };
    assert.throws(() => ActionDescUtil.playActionSetSteps({}, actionSets, "Caller", "Set", dispatcher),
      (error) => error === failure);
    assert.deepEqual(dispatched, []);
    fail = false;
    ActionDescUtil.playActionSetSteps({}, actionSets, "Caller", "Set", dispatcher);
    assert.deepEqual(dispatched, ["child", "caller-after"]);
  });

  it("allows 32 nested actions, excludes the 33rd and resumes each caller", () => {
    const actions = Array.from({ length: 33 }, (_, index) => ({
      name: `Action ${index}`,
      children: [
        { enabled: true, uf: `before-${index}` },
        ...(index === 32 ? [] : [{ enabled: true, uf: "play", actionDescriptor: {
          null: { v: [{ v: { val: `Action ${index + 1}` } }, { v: { val: "Set" } }] },
        } }]),
        { enabled: true, uf: `after-${index}` },
      ],
    }));
    const actionSets = [{ name: "Set", children: actions }];
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          const [name, set] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, name, set, this);
        } else dispatched.push(event.data.uf);
      },
    };
    ActionDescUtil.playActionSetSteps({}, actionSets, "Action 0", "Set", dispatcher);
    assert.deepEqual(dispatched, [
      ...Array.from({ length: 32 }, (_, index) => `before-${index}`),
      ...Array.from({ length: 32 }, (_, index) => `after-${31 - index}`),
    ]);
    dispatched.length = 0;
    ActionDescUtil.playActionSetSteps({}, actionSets, "Action 32", "Set", dispatcher);
    assert.deepEqual(dispatched, ["before-32", "after-32"]);
  });

  it("shares the step budget across nested playback and resets it afterward", () => {
    const limit = ActionDescUtil.maxRecordedPlaybackSteps;
    const actionSets = [{ name: "Set", children: [
      { name: "Caller", children: [
        { enabled: true, uf: "before" },
        { enabled: true, uf: "play", actionDescriptor: {
          null: { v: [{ v: { val: "Child" } }, { v: { val: "Set" } }] },
        } },
        { enabled: true, uf: "after" },
      ] },
      { name: "Child", children: Array.from({ length: limit }, (_, index) => ({
        enabled: true, uf: `child-${index}`,
      })) },
    ] }];
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        if (event.data.dispatchKind) {
          const [name, set] = event.data.recordedActionPair;
          ActionDescUtil.playActionSetSteps({}, actionSets, name, set, this);
        } else dispatched.push(event.data.uf);
      },
    };
    ActionDescUtil.playActionSetSteps({}, actionSets, "Caller", "Set", dispatcher);
    assert.deepEqual(dispatched, ["before", ...Array.from({ length: limit - 2 }, (_, index) => `child-${index}`)]);
    dispatched.length = 0;
    ActionDescUtil.playActionSetSteps({}, actionSets, "Child", "Set", dispatcher);
    assert.deepEqual(dispatched, Array.from({ length: limit }, (_, index) => `child-${index}`));
  });

  it("expands a true conditional in order and leaves a false conditional untouched", () => {
    const actionSets = [{ name: "Set", children: [
      { name: "Caller", children: [
        { enabled: true, uf: "before" },
        { enabled: true, uf: "conditional", actionDescriptor: {
          null: { v: { Cndt: "Pxel" } },
          then: { v: [{ v: { val: "Branch" } }, { v: { val: "Set" } }] },
        } },
        { enabled: true, uf: "after" },
      ] },
      { name: "Branch", children: [
        { enabled: true, uf: "branch-first" },
        { enabled: false, uf: "disabled" },
        { enabled: true, uf: "branch-last" },
      ] },
    ] }];
    let editable = true;
    const doc = { layers: [{}], selectedLayerIndices: [0], ensureLayerEditableForTools: () => editable };
    const dispatched = [];
    const dispatcher = { dispatch(event) { dispatched.push(event.data.uf); } };
    ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", dispatcher);
    assert.deepEqual(dispatched, ["before", "branch-first", "branch-last", "after"]);
    editable = false;
    dispatched.length = 0;
    ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", dispatcher);
    assert.deepEqual(dispatched, ["before", "after"]);
  });

  for (const conditionType of ["Adjs", "Shp", "Grup"]) {
    it(`treats ${conditionType} as false when no layer is selected`, () => {
      const actionSets = [{ name: "Set", children: [
        { name: "Caller", children: [
          { enabled: true, uf: "conditional", actionDescriptor: {
            null: { v: { Cndt: conditionType } },
            then: { v: [{ v: { val: "Branch" } }, { v: { val: "Set" } }] },
          } },
          { enabled: true, uf: "after" },
        ] },
        { name: "Branch", children: [{ enabled: true, uf: "wrong-branch" }] },
      ] }];
      const doc = { layers: [{}], selectedLayerIndices: [], ensureLayerEditableForTools: () => false };
      const dispatched = [];
      const dispatcher = { dispatch(event) { dispatched.push(event.data.uf); } };
      assert.doesNotThrow(() => ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", dispatcher), conditionType);
      assert.deepEqual(dispatched, ["after"], conditionType);
    });
  }

  it("keeps pixel editability conditions operative without a selected layer", () => {
    const actionSets = [{ name: "Set", children: [
      { name: "Caller", children: [{ enabled: true, uf: "conditional", actionDescriptor: {
        null: { v: { Cndt: "Pxel" } },
        then: { v: [{ v: { val: "Branch" } }, { v: { val: "Set" } }] },
      } }] },
      { name: "Branch", children: [{ enabled: true, uf: "editable-pixels" }] },
    ] }];
    const doc = { layers: [], selectedLayerIndices: [], ensureLayerEditableForTools: () => true };
    const dispatched = [];
    ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", {
      dispatch(event) { dispatched.push(event.data.uf); },
    });
    assert.deepEqual(dispatched, ["editable-pixels"]);
  });

  for (const [state, expectedMatch] of [
    ["pixels", true], ["empty-selection", false], ["multiple-selection", false],
    ["locked-pixels", false], ["locked-all", false], ["text", false],
    ["smart-object", false], ["group", false], ["channel-without-layer", true],
  ]) {
    it(`evaluates Pixel through real document editability: ${state}`, () => {
      const doc = new Document("condition.psd");
      const layer = new Layer();
      doc.layers = [layer, new Layer()];
      doc.selectedLayerIndices = [0];
      if (state === "empty-selection") doc.selectedLayerIndices = [];
      if (state === "multiple-selection") doc.selectedLayerIndices = [0, 1];
      if (state === "locked-pixels") layer.add.lspf = 1 << 1;
      if (state === "locked-all") layer.add.lspf = 1 << 31;
      if (state === "text") layer.add.TySh = {};
      if (state === "smart-object") layer.add.placedData = {};
      if (state === "group") layer.add.lsct = 1;
      if (state === "channel-without-layer") {
        doc.selectedLayerIndices = [];
        doc.activeChannels = [0];
      }
      const actionSets = [{ name: "Set", children: [
        { name: "Caller", children: [
          { enabled: true, uf: "conditional", actionDescriptor: {
            null: { v: { Cndt: "Pxel" } },
            then: { v: [{ v: { val: "Branch" } }, { v: { val: "Set" } }] },
          } },
          { enabled: true, uf: "after" },
        ] },
        { name: "Branch", children: [{ enabled: true, uf: "editable-branch" }] },
      ] }];
      const dispatched = [];
      ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", {
        dispatch(event) { dispatched.push(event.data.uf); },
      });
      assert.deepEqual(dispatched, expectedMatch ? ["editable-branch", "after"] : ["after"]);
      assert.equal(doc.layers[0], layer);
      assert.equal(doc.history.length, 1);
    });
  }

  for (const [conditionType, matchingAdd, matchingGroup] of [
    ["Adjs", { levl: {} }, false],
    ["Shp", { vogk: {} }, false],
    ["Grup", {}, true],
  ]) {
    it(`expands ${conditionType} only for a matching selected layer`, () => {
      const selected = { add: matchingAdd, isGroup: () => matchingGroup };
      const ordinary = { add: {}, isGroup: () => false };
      const doc = { layers: [selected, ordinary], selectedLayerIndices: [0],
        ensureLayerEditableForTools: () => false };
      const actionSets = [{ name: "Set", children: [
        { name: "Caller", children: [
          { enabled: true, uf: "conditional", actionDescriptor: {
            null: { v: { Cndt: conditionType } },
            then: { v: [{ v: { val: "Branch" } }, { v: { val: "Set" } }] },
          } },
          { enabled: true, uf: "after" },
        ] },
        { name: "Branch", children: [{ enabled: true, uf: "matching-branch" }] },
      ] }];
      const dispatched = [];
      const dispatcher = { dispatch(event) { dispatched.push(event.data.uf); } };
      ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", dispatcher);
      assert.deepEqual(dispatched, ["matching-branch", "after"]);
      doc.selectedLayerIndices = [1];
      dispatched.length = 0;
      ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", dispatcher);
      assert.deepEqual(dispatched, ["after"]);
    });
  }

  for (const layerState of ["background", "converted-back", "named-and-locked", "other-selected", "unselected"]) {
    it(`evaluates Background from the selected layer marker: ${layerState}`, () => {
      const background = new Layer();
      background.convertToBackground();
      const ordinary = new Layer();
      ordinary.setName("Ordinary");
      if (layerState === "named-and-locked") {
        ordinary.setName("Background");
        ordinary.add.lspf = 1 << 2;
      }
      if (layerState === "converted-back") background.convertFromBackground();
      const doc = {
        layers: [background, ordinary],
        selectedLayerIndices: layerState === "unselected" ? []
          : [layerState === "named-and-locked" || layerState === "other-selected" ? 1 : 0],
        ensureLayerEditableForTools() { assert.fail("Background must not use pixel editability"); },
      };
      const actionSets = [{ name: "Set", children: [
        { name: "Caller", children: [
          { enabled: true, uf: "before" },
          { enabled: true, uf: "conditional", actionDescriptor: {
            null: { v: { Cndt: "Bckg" } },
            then: { v: [{ v: { val: "Branch" } }, { v: { val: "Set" } }] },
          } },
          { enabled: true, uf: "after" },
        ] },
        { name: "Branch", children: [
          { enabled: true, uf: "background-first" },
          { enabled: false, uf: "disabled" },
          { enabled: true, uf: "background-last" },
        ] },
      ] }];
      const dispatched = [];
      ActionDescUtil.playActionSetSteps(doc, actionSets, "Caller", "Set", {
        dispatch(event) { dispatched.push(event.data.uf); },
      });
      assert.deepEqual(dispatched, layerState === "background"
        ? ["before", "background-first", "background-last", "after"]
        : ["before", "after"]);
    });
  }

  for (const [label, confirm, expected] of [
    ["accepted", () => true, ["before", "after"]],
    ["cancelled", () => false, ["before"]],
    ["blocked", () => { throw new Error("dialogs blocked"); }, ["before"]],
    ["asynchronous", () => Promise.resolve(true), ["before"]],
  ]) {
    it(`honours ${label} optional Stop and permits fresh replay afterward`, () => {
      const prompts = [];
      const dispatched = [];
      const stop = { enabled: true, uf: "stop", actionDescriptor: {
        Msge: { t: "TEXT", v: "Continue this action?" },
        Cntn: { t: "bool", v: true },
      } };
      const actionSets = [{ name: "Set", children: [{ name: "Action", children: [
        { enabled: true, uf: "before" }, stop, { enabled: true, uf: "after" },
      ] }] }];
      const dispatcher = { dispatch(event) { dispatched.push(event.data.uf); } };
      installWebviewConfirm((message) => { prompts.push(message); return confirm(); });
      try {
        ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", dispatcher);
        assert.deepEqual(prompts, ["Continue this action?"]);
        assert.deepEqual(dispatched, expected);
        dispatched.length = 0;
        stop.enabled = false;
        ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", dispatcher);
        assert.deepEqual(dispatched, ["before", "after"]);
        assert.equal(prompts.length, 1, "disabled Stop must not prompt");
      } finally {
        installWebviewConfirm(null);
      }
    });
  }

  for (const continueValue of [undefined, false]) {
    it(`stops unconditionally with Cntn=${continueValue} and displays its message`, () => {
      const messages = [];
      const dispatched = [];
      const actionDescriptor = { Msge: { t: "TEXT", v: "Stopped here" } };
      if (continueValue !== undefined) actionDescriptor.Cntn = { t: "bool", v: continueValue };
      const actionSets = [{ name: "Set", children: [{ name: "Action", children: [
        { enabled: true, uf: "before" },
        { enabled: true, uf: "stop", actionDescriptor },
        { enabled: true, uf: "after" },
      ] }] }];
      installToastPainter((message) => messages.push(message));
      installWebviewConfirm(() => { assert.fail("unconditional Stop must not confirm"); });
      try {
        ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", {
          dispatch(event) { dispatched.push(event.data.uf); },
        });
        assert.deepEqual(dispatched, ["before"]);
        assert.deepEqual(messages, ["Stopped here"]);
      } finally {
        installToastPainter(null);
        installWebviewConfirm(null);
      }
    });
  }

  it("plays only the selected duplicate-name action and skips its disabled steps", () => {
    const actionSets = [
      { name: "Set", children: [
        { name: "Action", children: [
          { enabled: true, uf: "selected-first" },
          { enabled: false, uf: "selected-disabled" },
          { enabled: true, uf: "selected-last" },
        ] },
        { name: "Action", children: [{ enabled: true, uf: "other-action" }] },
      ] },
      { name: "Set", children: [
        { name: "Action", children: [{ enabled: true, uf: "other-set" }] },
      ] },
    ];
    const dispatched = [];
    ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", {
      dispatch(event) { dispatched.push(event.data.uf); },
    }, [0, 0]);
    assert.deepEqual(dispatched, ["selected-first", "selected-last"]);
  });

  it("does not replay another duplicate when a selected path is stale", () => {
    const actionSets = [{ name: "Set", children: [
      { name: "Action", children: [{ enabled: true, uf: "wrong" }] },
    ] }];
    const dispatched = [];
    ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", {
      dispatch(event) { dispatched.push(event.data.uf); },
    }, [0, 1]);
    assert.deepEqual(dispatched, []);
  });

  it("replays recorded Pass Through and Multiply group modes with Undo and Redo", () => {
    const group = {
      blendMode: "norm",
      renderCache: { dirty: false },
      isGroup() { return true; },
      convertFromBackground() {},
      markDirty() {},
      invalidate() {},
    };
    const doc = {
      layers: [group],
      selectedLayerIndices: [0],
      history: [],
      historyIndex: -1,
      pushHistory(entry) {
        this.history.push(entry);
        this.historyIndex = this.history.length - 1;
      },
      getLastHistoryEntry() { return this.history.at(-1); },
      markDirty() {},
    };
    const tracker = new TrackerRegistry.LayerEffectsTracker();
    tracker.track = () => {};
    const dispatched = [];
    const controller = {
      dispatch(event) {
        dispatched.push(event.data);
        tracker.handleInput(event.data, {}, doc, { isPressed() { return false; } }, {});
      },
    };
    for (const [psdMode, wireMode, menuIndex] of [
      ["passThrough", "pass", 0],
      ["Mltp", "mul ", 4],
    ]) {
      const step = ActionDescUtil.buildSetLayerPropertyAction("Md", {
        t: "enum", v: { blendMode: psdMode },
      });
      ActionDescUtil.dispatchRecordedAction(step, controller, {}, doc);
      assert.equal(dispatched.at(-1).actionKind, Layer.setBlendMode);
      assert.equal(dispatched.at(-1).layerPropertyValue, menuIndex);
      assert.equal(group.blendMode, wireMode);
      const snapshot = doc.getLastHistoryEntry().data;
      tracker.undo(snapshot, doc);
      assert.equal(group.blendMode, psdMode === "passThrough" ? "norm" : "pass");
      tracker.redo(snapshot, doc);
      assert.equal(group.blendMode, wireMode);
    }
  });
});
