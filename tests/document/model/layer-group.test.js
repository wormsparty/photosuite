import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let LayerGroup;
let needsOpacityWrapper;
let LayerSectionType;
let Rect;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ LayerSectionType } = await import("../../../src/document/model/layer.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ LayerGroup } = await import("../../../src/document/model/layer-group.js"));
  ({ needsOpacityWrapper } = await import(
    "../../../src/document/render/layer-compositor.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

function makeLayer(name, options = {}) {
  const buffer = options.buffer ?? null;
  return {
    blendMode: options.blendMode ?? "norm",
    Opct: options.Opct ?? 255,
    pixelContent: options.pixelContent ?? 0,
    add: {
      lsct: options.lsct ?? LayerSectionType.Normal,
      lyid: options.lyid ?? 1,
    },
    buffer,
    rect: options.rect ?? null,
    isGroup() {
      return (
        this.add.lsct === LayerSectionType.OpenGroup ||
        this.add.lsct === LayerSectionType.ClosedGroup
      );
    },
    getName() {
      return name;
    },
    isVisible() {
      return options.visible !== false;
    },
    isLockBitSet(bit) {
      return options.lockBits?.has(bit) ?? false;
    },
    isVectorShape() {
      return false;
    },
    getMask() {
      return { enabled: false };
    },
  };
}

describe("document/model/layer-group.js", () => {
  it("buildFromLayers maps a single document layer under the root group", () => {
    const pixelLayer = makeLayer("Background", { buffer: new Uint8Array(16) });
    const groupEnd = makeLayer("end", {
      lsct: LayerSectionType.BoundingDivider,
      lyid: 99,
    });
    const rootHeader = makeLayer("Root", {
      lsct: LayerSectionType.OpenGroup,
      lyid: 99,
      blendMode: "pass",
    });
    const root = new LayerGroup();
    root.buildFromLayers([groupEnd, pixelLayer, rootHeader], 0, 0);

    assert.equal(root.layer.getName(), "Root");
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].layer.getName(), "Background");
    assert.equal(root.children[0].index, 0);
    assert.equal(root.getSectionByIndex(0), root.children[0]);
  });

  it("collectPaths records the deepest nesting path", () => {
    const pixelLayer = makeLayer("Background");
    const groupEnd = makeLayer("end", {
      lsct: LayerSectionType.BoundingDivider,
      lyid: 99,
    });
    const rootHeader = makeLayer("Root", {
      lsct: LayerSectionType.OpenGroup,
      lyid: 99,
    });
    const root = new LayerGroup();
    root.buildFromLayers([groupEnd, pixelLayer, rootHeader], 0, 0);

    const pathCollectOutput = { deepestPath: [] };
    root.collectPaths([], pathCollectOutput);
    assert.deepEqual(pathCollectOutput.deepestPath, ["Background"]);
  });

  it("calculateSize sums leaf buffer lengths", () => {
    const pixelLayer = makeLayer("Background", { buffer: new Uint8Array(32) });
    const groupEnd = makeLayer("end", {
      lsct: LayerSectionType.BoundingDivider,
      lyid: 99,
    });
    const rootHeader = makeLayer("Root", {
      lsct: LayerSectionType.OpenGroup,
      lyid: 99,
    });
    const root = new LayerGroup();
    root.buildFromLayers([groupEnd, pixelLayer, rootHeader], 0, 0);
    assert.equal(root.calculateSize(), 32);
  });

  it("collectLayerIndices includes group end markers", () => {
    const pixelLayer = makeLayer("Background", { buffer: new Uint8Array(4) });
    const groupEnd = makeLayer("end", {
      lsct: LayerSectionType.BoundingDivider,
      lyid: 99,
    });
    const rootHeader = makeLayer("Root", {
      lsct: LayerSectionType.OpenGroup,
      lyid: 99,
    });
    const root = new LayerGroup();
    root.buildFromLayers([groupEnd, pixelLayer, rootHeader], 0, 0);

    const indices = [];
    root.collectLayerIndices(indices);
    assert.deepEqual(indices, [root.index, root.groupEndIndex, 0]);
  });

  it("hitTestPoint returns the uppermost eligible pixel and omits locked or hidden groups", () => {
    const rect = new Rect(0, 0, 1, 1);
    const bottom = makeLayer("Bottom", { rect, buffer: new Uint8Array([10, 20, 30, 255]) });
    const topOptions = { rect, buffer: new Uint8Array([40, 50, 60, 255]), lockBits: new Set() };
    const top = makeLayer("Top", topOptions);
    const groupOptions = { lsct: LayerSectionType.OpenGroup, lyid: 99, lockBits: new Set() };
    const root = new LayerGroup();
    root.buildFromLayers([
      makeLayer("end", { lsct: LayerSectionType.BoundingDivider, lyid: 99 }),
      bottom,
      top,
      makeLayer("Root", groupOptions),
    ], 0, 0);
    const point = { x: 0, y: 0 };

    assert.equal(root.hitTestPoint(point).layer.getName(), "Top");
    const allHits = [];
    root.hitTestPoint(point, allHits);
    assert.deepEqual(allHits, [1, 0], "multi-hit order follows the visible stack");

    topOptions.lockBits.add(2);
    assert.equal(root.hitTestPoint(point).layer.getName(), "Bottom");
    topOptions.lockBits.clear();
    topOptions.lockBits.add(31);
    assert.equal(root.hitTestPoint(point).layer.getName(), "Bottom");
    topOptions.lockBits.clear();
    groupOptions.lockBits.add(2);
    assert.equal(root.hitTestPoint(point), null, "a locked parent blocks its children");
    groupOptions.lockBits.clear();
    groupOptions.visible = false;
    assert.equal(root.hitTestPoint(point), null, "a hidden parent blocks its children");
  });

  it("collectLayerIndices skips pass-through group's children only for its disabled mask", () => {
    const groupOptions = {
      lsct: LayerSectionType.OpenGroup,
      lyid: 99,
      pixelContent: 1,
    };
    const root = new LayerGroup();
    root.buildFromLayers([
      makeLayer("end", { lsct: LayerSectionType.BoundingDivider, lyid: 99 }),
      makeLayer("Child"),
      makeLayer("Root", groupOptions),
    ], 0, 0);

    const allIndices = [];
    root.collectLayerIndices(allIndices, false);
    assert.deepEqual(allIndices, [root.index, root.groupEndIndex, 0]);

    const skippedIndices = [];
    root.collectLayerIndices(skippedIndices, true);
    assert.deepEqual(skippedIndices, [root.index, root.groupEndIndex]);

    root.layer.pixelContent = 0;
    const normalIndices = [];
    root.collectLayerIndices(normalIndices, true);
    assert.deepEqual(normalIndices, allIndices);
  });

  it("needsOpacityWrapper is true when opacity is below full and effects exist", () => {
    const layer = {
      Opct: 128,
      isGroup() {
        return false;
      },
      hasEnabledEffects() {
        return true;
      },
    };
    assert.equal(
      needsOpacityWrapper(layer, [], { channelRestrictions: [1, 1, 1] }),
      true,
    );
    assert.equal(
      needsOpacityWrapper(
        { Opct: 255, isGroup: () => false, hasEnabledEffects: () => false },
        [],
        { channelRestrictions: [1, 1, 1] },
      ),
      false,
    );
  });
});
