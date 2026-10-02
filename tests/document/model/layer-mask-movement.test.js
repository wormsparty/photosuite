import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let Layer, LayerSectionType, LayerGroup, Document, Rect, Mask;
let applyLayerTranslations, MoveTool, TransformToolBase, restoreBrowserGlobals;
before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ Layer, LayerSectionType } = await import("../../../src/document/model/layer.js"));
  ({ LayerGroup } = await import("../../../src/document/model/layer-group.js"));
  ({ Document } = await import("../../../src/document/model/document.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ Mask } = await import("../../../src/document/model/layer-masks.js"));
  ({ applyLayerTranslations } = await import("../../../src/document/model/layer-translate.js"));
  ({ MoveTool } = await import("../../../src/document/tools/move-tools.js"));
  const { installTransformLayerApplyStatics } = await import("../../../src/document/transform/transform-layer-apply.js");
  TransformToolBase = function () {};
  installTransformLayerApplyStatics(TransformToolBase, {});
});
after(() => restoreBrowserGlobals?.());

function pixelLayer(linked, focus, enabled = true) {
  const layer = new Layer();
  layer.rect = new Rect(1, 2, 2, 1);
  layer.buffer = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  layer.d = new Mask();
  layer.d.rect = new Rect(1, 2, 2, 1);
  layer.d.channel = new Uint8Array([255, 0]);
  layer.d.color = 0;
  layer.d.enabled = linked;
  layer.d.isEnabled = enabled;
  layer.pixelContent = focus;
  return layer;
}
function documentFor(layers) {
  return {
    width: 12, height: 12, layers, selectedLayerIndices: [0],
    root: { getExpandedDirtyRect: (rect) => rect.clone() },
    markDirty(rect) { this.dirtyRect = rect; },
  };
}

describe("linked and unlinked raster mask movement", () => {
  for (const linked of [false, true]) {
    for (const focus of [0, 1]) {
      for (const enabled of [false, true]) {
        it(`moves and reverses linked=${linked} focus=${focus} enabled=${enabled}`, () => {
          const layer = pixelLayer(linked, focus, enabled);
          const doc = documentFor([layer]);
          layer.invalidate(doc);
          layer.renderCache.needsRebuild = false;
          layer.renderCache.dirtyRect = null;
          const rasterBefore = layer.buffer.slice();
          const maskBefore = layer.d.channel.slice();
          const channels = MoveTool.captureLayerEditFlags(doc, [0]);
          assert.deepEqual(channels, [linked ? [0, 1] : [focus === 0 ? 0 : 1]]);
          const snapshots = TransformToolBase.captureLayerSnapshots(doc, [0]);
          assert.equal(snapshots[0][0] !== null, linked || focus === 0);
          assert.equal(snapshots[0][1] !== null, linked || focus === 1);
          applyLayerTranslations(doc, [0], channels, [3, -1]);
          assert.deepEqual(layer.rect, new Rect(linked || focus === 0 ? 4 : 1, linked || focus === 0 ? 1 : 2, 2, 1));
          assert.deepEqual(layer.d.rect, new Rect(linked || focus === 1 ? 4 : 1, linked || focus === 1 ? 1 : 2, 2, 1));
          assert.deepEqual(layer.buffer, rasterBefore);
          assert.deepEqual(layer.d.channel, maskBefore);
          if (enabled && !linked) assert.equal(layer.renderCache.needsRebuild, true, "relative mask movement invalidates rendered artwork");
          applyLayerTranslations(doc, [0], channels, [3, -1], true);
          assert.deepEqual(layer.rect, new Rect(1, 2, 2, 1));
          assert.deepEqual(layer.d.rect, new Rect(1, 2, 2, 1));
          applyLayerTranslations(doc, [0], channels, [3, -1]);
          TransformToolBase.restoreLayerSnapshots(doc, [0], snapshots);
          assert.deepEqual(layer.rect, new Rect(1, 2, 2, 1));
          assert.deepEqual(layer.d.rect, new Rect(1, 2, 2, 1));
          assert.deepEqual(layer.buffer, rasterBefore);
          assert.deepEqual(layer.d.channel, maskBefore);
        });
      }
    }
  }
  for (const linked of [false, true]) {
    for (const focus of [0, 1]) {
      it(`resolves group descendants once for linked=${linked} focus=${focus}`, () => {
        const child = pixelLayer(true, 0);
        const end = new Layer();
        end.add.lsct = LayerSectionType.BoundingDivider;
        const group = pixelLayer(linked, focus);
        group.add.lsct = LayerSectionType.OpenGroup;
        group.layerFlags |= 1 << 4;
        group.rect = new Rect();
        const root = new LayerGroup();
        const rootEnd = new Layer();
        rootEnd.add.lsct = LayerSectionType.BoundingDivider;
        const rootHeader = new Layer();
        rootHeader.add.lsct = LayerSectionType.OpenGroup;
        root.buildFromLayers([rootEnd, end, child, group, rootHeader], 0, 0);
        const doc = documentFor([end, child, group]);
        doc.root = root;
        doc.selectedLayerIndices = [2];
        doc.collectGroupLayers = Document.prototype.collectGroupLayers;
        const indices = Document.prototype.resolveLayerSelection.call(doc, true);
        assert.deepEqual(indices, !linked && focus === 1 ? [2, 0] : [2, 0, 1]);
        if (linked || focus === 0) {
          doc.selectedLayerIndices = [2, 1];
          assert.deepEqual(Document.prototype.resolveLayerSelection.call(doc, true), [2, 0, 1], "selected child is not translated twice");
        }
      });
    }
  }
  for (const lockBit of [null, 2, 31]) {
    it(`moves hidden nested descendants or rejects descendant lock ${lockBit}`, () => {
      const child = pixelLayer(true, 0);
      child.layerFlags |= 1 << 1;
      if (lockBit !== null) child.add.lspf = 1 << lockBit;
      function groupMarker(kind) {
        const layer = new Layer();
        layer.add.lsct = kind;
        layer.layerFlags |= 1 << 4;
        return layer;
      }
      const outerEnd = groupMarker(LayerSectionType.BoundingDivider);
      const innerEnd = groupMarker(LayerSectionType.BoundingDivider);
      const inner = groupMarker(LayerSectionType.OpenGroup);
      const outer = groupMarker(LayerSectionType.OpenGroup);
      const root = new LayerGroup();
      root.buildFromLayers([
        groupMarker(LayerSectionType.BoundingDivider), outerEnd, innerEnd,
        child, inner, outer, groupMarker(LayerSectionType.OpenGroup),
      ], 0, 0);
      const doc = documentFor([outerEnd, innerEnd, child, inner, outer]);
      doc.root = root;
      doc.selectedLayerIndices = [4];
      doc.activeChannels = [];
      doc.history = [];
      doc.collectGroupLayers = Document.prototype.collectGroupLayers;
      doc.resolveLayerSelection = Document.prototype.resolveLayerSelection;
      const indices = doc.resolveLayerSelection(true);
      assert.deepEqual(indices, [4, 0, 3, 1, 2]);
      if (lockBit === null) {
        const flags = MoveTool.captureLayerEditFlags(doc, indices);
        applyLayerTranslations(doc, indices, flags, indices.flatMap(() => [3, -1]));
        assert.deepEqual(child.rect, new Rect(4, 1, 2, 1));
        assert.deepEqual(child.d.rect, new Rect(4, 1, 2, 1));
        applyLayerTranslations(doc, indices, flags, indices.flatMap(() => [3, -1]), true);
        assert.deepEqual(child.rect, new Rect(1, 2, 2, 1));
        assert.deepEqual(child.d.rect, new Rect(1, 2, 2, 1));
      } else {
        const tool = new MoveTool();
        const previousAlert = globalThis.alert;
        let alerts = 0;
        globalThis.alert = () => alerts++;
        try {
          tool.handleInput({ actionKind: "trsl", translateDeltaX: 3, translateDeltaY: -1 }, {}, doc, {}, {});
          assert.equal(alerts, 1);
          assert.equal(tool.isDragging, false);
          assert.deepEqual(child.rect, new Rect(1, 2, 2, 1));
          assert.deepEqual(child.d.rect, new Rect(1, 2, 2, 1));
          assert.deepEqual(doc.history, []);
        } finally {
          globalThis.alert = previousAlert;
        }
      }
    });
  }

});
