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

before(async () => {
  await import("../../../src/features/filters/filter-registry.js");
  await import("../../../src/features/filters/gallery/gallery-filter-defs.js");
  ({ ActionDescUtil } = await import("../../../src/features/scripting/action-desc.js"));
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import("../../../src/features/trackers/register-trackers.js");
  registerTrackers(TrackerRegistry);
  ({ Layer } = await import("../../../src/document/model/layer.js"));
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
    ActionDescUtil.playActionSetSteps({}, actionSets, "Action", "Set", {
      dispatch(event) { dispatched.push(event.data.uf); },
    });
    assert.deepEqual(dispatched, []);
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
