/**
 * ActionsPanel / ActionsListItem (tree events, export payload).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { clearElement } from "../../../src/core/dom.js";
import { iconImgHtml } from "../../../src/assets/icon-registry.js";

installBrowserGlobals();

let ActionsPanel;
let ActionsListItem;
let Locale;
let PopupTypes;
let ActionParser;

before(async () => {
  ({ Locale } = await import("../../../src/core/i18n/locale.js"));
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ ActionParser } = await import("../../../src/features/scripting/action-file.js"));
  Locale.get = (key) => (typeof key === "string" ? key : String(key));
  ({ ActionsPanel, ActionsListItem } = await import(
    "../../../src/ui/panels/actions-panel.js"
  ));
});

describe("ui/panels/actions-panel.js", () => {
  it("ActionsListItem click dispatches rowAction sel + treePath", () => {
    const item = new ActionsListItem([0, 1], "[]", true, "Action 0");
    const events = [];
    item.dispatch = (evt) => events.push(evt);
    item.onMouseUp({
      detail: 1,
      target: { tagName: "DIV" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.rowAction, "sel");
    assert.deepEqual(events[0].data.treePath, [0, 1]);
  });

  it("rename confirm uses newName", () => {
    const item = new ActionsListItem([0], "[]", true, "Set");
    const events = [];
    item.dispatch = (evt) => events.push(evt);
    item.onRenameConfirm("Renamed");
    assert.equal(events[0].data.rowAction, "nchange");
    assert.equal(events[0].data.newName, "Renamed");
    assert.deepEqual(events[0].data.treePath, [0]);
  });

  it("fold / enab / nchange mutate name/expanded/enabled", () => {
    const panel = Object.create(ActionsPanel.prototype);
    panel.redraw = () => {};
    const actionSets = [
      {
        name: "Action Set 0",
        expanded: true,
        children: [
          {
            name: "Action 0",
            expanded: true,
            commandKeyEnabled: false,
            children: [{ enabled: true, uf: "set" }],
          },
        ],
      },
    ];
    panel.doc = { actionSets, recordingActionSet: null };

    panel.onItemSelect({ data: { rowAction: "fold", treePath: [0] } });
    assert.equal(actionSets[0].expanded, false);

    panel.onItemSelect({ data: { rowAction: "enab", treePath: [0, 0, 0] } });
    assert.equal(actionSets[0].children[0].children[0].enabled, false);

    panel.onItemSelect({
      data: { rowAction: "nchange", treePath: [0], newName: "Renamed Set" },
    });
    assert.equal(actionSets[0].name, "Renamed Set");
  });

  it("export dispatch uses popupTypeId", () => {
    const panel = Object.create(ActionsPanel.prototype);
    panel.doc = {
      actionSets: [{ name: "S", children: [], expanded: true }],
      recordingActionSet: null,
    };
    panel.selectedPath = [0];
    const exportBtn = {};
    panel.items = [null, null, null, null, null, exportBtn];
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onFooterClick({ currentTarget: exportBtn });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.popupTypeId, PopupTypes.ACTIONS);
    assert.equal(events[0].data.actionSetIndex, 0);
  });

  it("renamed selected set and action survive export and import", () => {
    const actionSets = [
      { name: "Other", expanded: true, children: [] },
      {
        name: "Original Set", expanded: true,
        children: [{
          index: 0, shift: false, commandKeyEnabled: false, color: 0,
          name: "Original Action", expanded: true,
          children: [{
            expanded: false, enabled: false, dialogOptionsEnabled: false,
            dialogOptions: 0, uf: "set", eventClassName: "",
            actionDescriptor: { classID: "null" },
          }],
        }],
      },
    ];
    const panel = Object.create(ActionsPanel.prototype);
    panel.doc = { actionSets, recordingActionSet: null };
    panel.selectedPath = [1, 0];
    panel.redraw = () => {};
    panel.items = [{}, {}, {}, {}, {}, {}];
    const events = [];
    panel.dispatch = (event) => events.push(event.data);

    panel.onItemSelect({ data: {
      rowAction: "nchange", treePath: [1], newName: "Renamed Set",
    } });
    panel.onItemSelect({ data: {
      rowAction: "nchange", treePath: [1, 0], newName: "Renamed Action",
    } });
    panel.onFooterClick({ currentTarget: panel.items[5] });

    assert.equal(events.length, 1);
    assert.equal(events[0].popupTypeId, PopupTypes.ACTIONS);
    assert.equal(events[0].actionSetIndex, 1);
    const imported = ActionParser.parse(
      ActionParser.serialize(actionSets[events[0].actionSetIndex]),
    );
    assert.equal(imported.length, 1);
    assert.equal(imported[0].name, "Renamed Set");
    assert.equal(imported[0].children[0].name, "Renamed Action");
    assert.deepEqual(imported[0].children[0].children, [{
      expanded: false, enabled: false, dialogOptionsEnabled: false,
      dialogOptions: 0, uf: "set", eventClassName: "",
      actionDescriptor: { classID: "null" },
    }]);
    assert.equal(actionSets[0].name, "Other");

    const importedPanel = Object.create(ActionsPanel.prototype);
    importedPanel.doc = { actionSets: imported, recordingActionSet: null };
    importedPanel.selectedPath = [0, 0];
    const replayEvents = [];
    importedPanel.dispatch = (event) => replayEvents.push(event.data);
    importedPanel.playSelectedAction();
    assert.deepEqual(replayEvents[0].recordedActionPair, [
      "Renamed Action", "Renamed Set",
    ]);
  });

  it("Play with an action set but no selected row does not dispatch or throw", () => {
    const panel = Object.create(ActionsPanel.prototype);
    panel.doc = {
      actionSets: [{ name: "Set", children: [{ name: "Action", children: [] }] }],
      recordingActionSet: null,
    };
    panel.selectedPath = "topMenu.file";
    const dispatched = [];
    panel.dispatch = (event) => dispatched.push(event);
    assert.doesNotThrow(() => panel.playSelectedAction());
    assert.deepEqual(dispatched, []);
  });

  it("Play dispatches the selected action and set names", () => {
    const panel = Object.create(ActionsPanel.prototype);
    panel.doc = {
      actionSets: [{ name: "Set", children: [{ name: "Action", children: [] }] }],
      recordingActionSet: null,
    };
    panel.selectedPath = [0, 0];
    const dispatched = [];
    panel.dispatch = (event) => dispatched.push(event.data);
    panel.playSelectedAction();
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].recordedActionPair, ["Action", "Set"]);
  });

  for (const [label, buttonIndex] of [["Record", 0], ["New Action", 3], ["Delete", 4], ["Export", 5]]) {
    it(`${label} leaves an existing set untouched before row selection`, () => {
      const panel = Object.create(ActionsPanel.prototype);
      const actionSets = [{ name: "Set", children: [{ name: "Action", children: [] }] }];
      panel.doc = { actionSets, recordingActionSet: null };
      panel.selectedPath = "topMenu.file";
      panel.recordGlyph = "record";
      panel.stopGlyph = "stop";
      const labels = [];
      const dispatched = [];
      panel.items = [
        { setLabel(value) { labels.push(value); } },
        {}, {}, {}, {}, {},
      ];
      panel.redraw = () => {};
      panel.dispatch = (event) => dispatched.push(event.data);

      assert.doesNotThrow(() => panel.onFooterClick({ currentTarget: panel.items[buttonIndex] }));
      assert.deepEqual(actionSets, [{ name: "Set", children: [{ name: "Action", children: [] }] }]);
      assert.equal(panel.doc.recordingActionSet, null);
      assert.deepEqual(labels, []);
      assert.deepEqual(dispatched, []);
    });
  }
});
