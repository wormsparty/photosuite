import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { makeElement } from "../../../src/core/dom.js";
import { EventType } from "../../../src/core/event-bus.js";

let ToolId;
let restoreBrowserGlobals;
let EllipseSelectTool;
let MagicWandTool;
let QuickSelectTool;
let RectSelectTool;
let SelectTool;
let Mask;


// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  ({ EllipseSelectTool, MagicWandTool, QuickSelectTool, RectSelectTool, SelectTool } = await import("../../../src/document/tools/selection-tools.js"));
  ({ Mask } = await import("../../../src/document/model/layer-masks.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/selection-tools.js", () => {
  it("registerSelectionTools wires selection constructors", () => {
    chainToolPrototypes();
    const rect = new RectSelectTool();
    const wand = new MagicWandTool();
    const quick = new QuickSelectTool();

    assert.equal(typeof SelectTool, "function");
    assert.equal(rect.id, ToolId.TOOL_RECT_SELECT);
    assert.equal(wand.id, ToolId.TOOL_MAGIC_WAND);
    assert.equal(quick.id, ToolId.TOOL_QUICK_SELECT);
    assert.equal(quick.strokeCompositeMode, "qselect");
    assert.deepEqual(rect.toolOptions.magicWandOptions, [16, true, true]);
    assert.equal(typeof SelectTool.buildSetSelectionAction, "function");
    assert.equal(typeof SelectTool.resolveSelectionCombineMode, "function");
  });

  it("resolveSelectionCombineMode maps modifiers to modes", () => {
    chainToolPrototypes();
    const resolve = SelectTool.resolveSelectionCombineMode;

    assert.equal(resolve("front", false, false), "front");
    assert.equal(resolve("front", true, false), "union");
    assert.equal(resolve("front", false, true), "difference");
    assert.equal(resolve("front", true, true), "intersection");
    assert.equal(resolve("union", false, false), "union");
  });

  it("buildSetSelectionAction and buildSelectAllAction match descriptor shape", () => {
    chainToolPrototypes();
    const setAction = SelectTool.buildSetSelectionAction("set", { t: "Objc", v: { classID: "Rctn" } });
    assert.equal(setAction.uf, "set");
    assert.equal(setAction.actionDescriptor.classID, "setd");
    assert.equal(setAction.actionDescriptor.T.v.classID, "Rctn");

    const selectAll = SelectTool.buildSelectAllAction(true);
    assert.equal(selectAll.uf, "set");
    assert.equal(selectAll.actionDescriptor.T.v.Ordn, "Al");

    const deselect = SelectTool.buildSelectAllAction();
    assert.equal(deselect.actionDescriptor.T.v.Ordn, "None");
  });

  it("buildRectSelectionAction encodes pixel bounds", () => {
    chainToolPrototypes();
    const action = SelectTool.buildRectSelectionAction(
      "Rctn",
      new Rect(10, 20, 30, 40),
    );
    const shape = action.actionDescriptor.T.v;
    assert.equal(shape.classID, "Rctn");
    assert.equal(shape.Left.v.val, 10);
    assert.equal(shape.Top.v.val, 20);
    assert.equal(shape.Rght.v.val, 40);
    assert.equal(shape.Btom.v.val, 60);
  });

  it("buildPolygonSelectionAction maps combineMode to operation kinds", () => {
    chainToolPrototypes();
    const coords = [0, 0, 10, 0, 10, 10];
    assert.equal(SelectTool.buildPolygonSelectionAction(coords).uf, "set");
    assert.equal(SelectTool.buildPolygonSelectionAction(coords, "union").uf, "addTo");
    assert.equal(SelectTool.buildPolygonSelectionAction(coords, "difference").uf, "subtractFrom");
    assert.equal(
      SelectTool.buildPolygonSelectionAction(coords, "intersection").uf,
      "interfaceWhite",
    );
    const pts = SelectTool.buildPolygonSelectionAction(coords).actionDescriptor.T.v.Pts.v.arr;
    assert.deepEqual(pts[0].arr, [0, 10, 10]);
    assert.deepEqual(pts[1].arr, [0, 0, 10]);
  });

  it("commits a toolbar-feathered rectangle with soft mask bytes and undoable history", () => {
    const tool = new RectSelectTool();
    const events = [];
    const dispatcher = { dispatch(event) { events.push(event); } };
    const appData = { extras: true, prefs: { showSelectionEdges: true } };
    const history = [];
    const doc = {
      width: 16, height: 16, selectionMask: null,
      pushHistory(entry) { history.push(entry); },
    };

    tool.syncToolbarWidget([0, 1, [16, true, true]], null, dispatcher);
    tool.appDispatcher = dispatcher;
    tool.startPos = new Point(4, 4);
    tool.cursorPos = new Point(12, 12);
    tool.exceededDragThreshold = true;
    tool.finish(doc, appData, null, null);

    const gesture = events.find((event) => event.type === EventType.historyGrouped);
    assert.ok(gesture);
    assert.equal(gesture.data.actionDescriptor.Fthr.v.val, 1);
    tool.handleInput({ actionKind: "fromAction", scriptActionPayload: gesture.data }, dispatcher, doc, null, appData);

    assert.equal(history.length, 1);
    assert.equal(history[0].name, "tools.rectangleSelect");
    const selection = doc.selectionMask;
    const at = (x, y) => selection.channel[(y - selection.rect.y) * selection.rect.width + x - selection.rect.x];
    assert.ok(selection.rect.x < 4);
    assert.ok(at(3, 8) > 0 && at(3, 8) < 255);
    assert.equal(at(8, 8), 255);
    assert.ok(at(4, 8) < 255);

    tool.undo(history[0].data, doc);
    assert.equal(doc.selectionMask, null);
    tool.redo(history[0].data, doc);
    assert.equal(doc.selectionMask, selection);
    assert.ok(at(3, 8) > 0 && at(3, 8) < 255);
  });

  it("commits a toolbar-feathered ellipse through its path with undoable soft edges", () => {
    const tool = new EllipseSelectTool();
    const events = [];
    const dispatcher = { dispatch(event) { events.push(event); } };
    const appData = { extras: true, prefs: { showSelectionEdges: true } };
    const history = [];
    const doc = {
      width: 16, height: 16, selectionMask: null,
      pushHistory(entry) { history.push(entry); },
    };
    // The Node browser stub has no canvas rasterizer. Supply only the path's
    // hard mask; the descriptor, feathering, and history paths remain real.
    let receivedPath;
    tool.bezierPathToSelectionMask = (path) => {
      receivedPath = path;
      const channel = new Uint8Array(8 * 8);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          if ((x - 3.5) ** 2 + (y - 3.5) ** 2 < 13) channel[y * 8 + x] = 255;
        }
      }
      return { rect: new Rect(4, 4, 8, 8), channel };
    };

    tool.syncToolbarWidget([0, 1, [16, true, true]], null, dispatcher);
    tool.appDispatcher = dispatcher;
    tool.startPos = new Point(4, 4);
    tool.cursorPos = new Point(12, 12);
    tool.exceededDragThreshold = true;
    tool.finish(doc, appData, null, null);

    const gesture = events.find((event) => event.type === EventType.historyGrouped);
    assert.ok(gesture);
    assert.equal(gesture.data.actionDescriptor.T.v.classID, "Elps");
    assert.equal(gesture.data.actionDescriptor.Fthr.v.val, 1);
    tool.handleInput({ actionKind: "fromAction", scriptActionPayload: gesture.data }, dispatcher, doc, null, appData);

    assert.equal(receivedPath.commands[0], "M");
    assert.equal(receivedPath.commands.filter((command) => command === "C").length, 4);
    assert.equal(history.length, 1);
    assert.equal(history[0].name, "tools.ellipseSelect");
    const selection = doc.selectionMask;
    const at = (x, y) => selection.channel[(y - selection.rect.y) * selection.rect.width + x - selection.rect.x];
    assert.ok(selection.rect.x < 4);
    assert.ok(at(3, 8) > 0 && at(3, 8) < 255);
    assert.equal(at(8, 8), 255);
    assert.ok(at(4, 4) < at(4, 8));

    tool.undo(history[0].data, doc);
    assert.equal(doc.selectionMask, null);
    tool.redo(history[0].data, doc);
    assert.equal(doc.selectionMask, selection);
    assert.ok(at(3, 8) > 0 && at(3, 8) < 255);
  });

  it("EllipseSelectTool.ellipseToBezierPath returns closed path overlay", () => {
    chainToolPrototypes();
    const path = EllipseSelectTool.ellipseToBezierPath(new Rect(0, 0, 100, 50));
    assert.ok(Array.isArray(path.coords));
    assert.ok(Array.isArray(path.commands));
    assert.equal(path.commands[0], "M");
    assert.ok(path.commands.includes("C") || path.commands.includes("Z") || path.commands.length > 1);
    assert.ok(path.coords.length >= 4);
  });

  it("loads a valid extra channel as a selection and ignores stale channel references", () => {
    const channel = new Mask();
    channel.color = 0;
    channel.rect = new Rect(0, 0, 2, 1);
    channel.channel = new Uint8Array([255, 0]);
    const priorSelection = { rect: new Rect(1, 0, 1, 1), channel: new Uint8Array([255]) };
    const history = [];
    const doc = {
      width: 2, height: 1, extraChannels: [channel], activeChannels: [0],
      pathViewport: { channelVisibility: [1, 1, 1] }, selectionMask: priorSelection,
      pushHistory(entry) { history.push(entry); },
    };
    const tool = new SelectTool("Select", ToolId.TOOL_RECT_SELECT, "");
    const dispatcher = { dispatch() {} };
    const appData = { extras: true, prefs: { showSelectionEdges: true } };

    for (const channelIndex of [-6, -5.5, -999]) {
      tool.handleInput({ actionKind: "fromchannel", selectionSource: [channelIndex, 0, 0] }, dispatcher, doc, null, appData);
      assert.equal(doc.selectionMask, priorSelection);
      assert.equal(history.length, 0);
    }
    doc.activeChannels = [4];
    tool.handleInput({ actionKind: "fromchannel", selectionSource: [null, 0, 0] }, dispatcher, doc, null, appData);
    assert.equal(doc.selectionMask, priorSelection);
    assert.equal(history.length, 0);

    tool.handleInput({ actionKind: "fromchannel", selectionSource: [-5, 0, 0] }, dispatcher, doc, null, appData);
    assert.equal(history.length, 1);
    assert.deepEqual(Array.from(doc.selectionMask.channel.subarray(0, doc.selectionMask.rect.area())), [255]);
    assert.deepEqual([doc.selectionMask.rect.x, doc.selectionMask.rect.width], [0, 1]);
  });

  it("does not resolve an absent named extra channel to the first channel", () => {
    const channel = new Mask();
    channel.name = "Existing";
    channel.color = 0;
    channel.rect = new Rect(0, 0, 2, 1);
    channel.channel = new Uint8Array([255, 0]);
    const priorSelection = { rect: new Rect(1, 0, 1, 1), channel: new Uint8Array([255]) };
    const history = [];
    const doc = {
      width: 2, height: 1, extraChannels: [channel], activeChannels: [],
      selectionMask: priorSelection, pushHistory(entry) { history.push(entry); },
    };
    const tool = new SelectTool("Select", ToolId.TOOL_RECT_SELECT, "");
    const dispatcher = { dispatch() {} };
    const appData = { extras: true, prefs: { showSelectionEdges: true } };
    const namedLoad = (name) => ({
      actionKind: "fromAction",
      scriptActionPayload: {
        uf: "set",
        actionDescriptor: { T: { v: [{ t: "name", v: { val: name } }] } },
      },
    });

    tool.handleInput(namedLoad("Missing"), dispatcher, doc, null, appData);
    assert.equal(doc.selectionMask, priorSelection);
    assert.equal(history.length, 0);
    tool.handleInput(namedLoad("Existing"), dispatcher, doc, null, appData);
    assert.equal(history.length, 1);
    assert.deepEqual(Array.from(doc.selectionMask.channel.subarray(0, doc.selectionMask.rect.area())), [255]);
    assert.equal(doc.selectionMask.rect.x, 0);
  });

});
