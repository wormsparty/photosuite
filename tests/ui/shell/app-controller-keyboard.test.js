/**
 * AppController keyboard helpers (path enter mode, brackets, mask view).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let applyKeyboardHandlers;
let isNonModifierKeyInTextField;
let isEditingTextTool;
let computePathFromEnterMode;
let resolveBracketMoveOperation;
let resolveMaskViewModeFromChannelVisibility;
let buildInvertSelectionHistoryData;
let DocumentModel;
let KeyboardHandler;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
  ({
    applyKeyboardHandlers,
    isNonModifierKeyInTextField,
    isEditingTextTool,
    computePathFromEnterMode,
    resolveBracketMoveOperation,
    resolveMaskViewModeFromChannelVisibility,
    buildInvertSelectionHistoryData
  } = await import("../../../src/ui/shell/app-controller-keyboard.js"));
});

describe("ui/shell/app-controller-keyboard.js", () => {
  it("computePathFromEnterMode packs shift/alt bits", () => {
    assert.equal(computePathFromEnterMode(false, false), 0);
    assert.equal(computePathFromEnterMode(true, false), 1);
    assert.equal(computePathFromEnterMode(false, true), 2);
    assert.equal(computePathFromEnterMode(true, true), 3);
  });

  it("resolveBracketMoveOperation maps left/right + shift", () => {
    const left = { isPressed: (k) => k === KeyboardHandler.BracketLeft };
    const right = { isPressed: (k) => k === KeyboardHandler.BracketRight };
    assert.equal(resolveBracketMoveOperation(left, false), 2);
    assert.equal(resolveBracketMoveOperation(left, true), 3);
    assert.equal(resolveBracketMoveOperation(right, false), 1);
    assert.equal(resolveBracketMoveOperation(right, true), 0);
  });

  it("resolveMaskViewModeFromChannelVisibility", () => {
    assert.equal(resolveMaskViewModeFromChannelVisibility(null, {}), 0);
    assert.equal(resolveMaskViewModeFromChannelVisibility({ active: false }, {}), 0);
    assert.equal(
      resolveMaskViewModeFromChannelVisibility(
        { active: true },
        { pathViewport: { channelVisibility: [1, 1, 1] } }
      ),
      1
    );
    assert.equal(
      resolveMaskViewModeFromChannelVisibility(
        { active: true },
        { pathViewport: { channelVisibility: [1, 0, 0] } }
      ),
      2
    );
  });

  it("isNonModifierKeyInTextField rejects Escape/Ctrl/Alt", () => {
    assert.equal(isNonModifierKeyInTextField({ code: "KeyA" }), true);
    assert.equal(isNonModifierKeyInTextField({ code: "Escape" }), false);
  });

  it("isEditingTextTool requires active text tool", () => {
    assert.ok(!isEditingTextTool({
      toolRegistry: { entriesById: { [ToolId.TOOL_TYPE]: { tool: null } } }
    }));
    assert.equal(
      isEditingTextTool({
        toolRegistry: {
          entriesById: {
            [ToolId.TOOL_TYPE]: { tool: { isActive: () => true } }
          }
        }
      }),
      true
    );
  });

  it("applyKeyboardHandlers installs prototype methods and toggleBrowserFullscreen", () => {
    function FakeController() {}
    applyKeyboardHandlers(FakeController);
    assert.equal(typeof FakeController.prototype.onKeyEvent, "function");
    assert.equal(typeof FakeController.prototype.isShortcutKeyHeld, "function");
    assert.equal(typeof FakeController.toggleBrowserFullscreen, "function");
    assert.deepEqual(FakeController.prototype.textInputTagNames, ["input", "textarea", "select"]);
  });

  it("Shift+F6 opens Feather only for a document with a selection", () => {
    function FakeController() {}
    applyKeyboardHandlers(FakeController);
    const controller = new FakeController();
    const dispatched = [];
    controller.keyboardHandler = new KeyboardHandler();
    controller.overlayManager = { getTopPopup() { return null; } };
    controller.documentView = { getTopDialog() { return null; } };
    controller.appData = { activeToolId: null };
    controller.toolRegistry = { entriesById: {}, toolbarShortcutKeys: [] };
    let currentDoc = null;
    controller.getCurrentDoc = () => currentDoc;
    controller.updateTemporaryToolFromModifiers = () => {};
    controller.isShortcutKeyHeld = () => false;
    controller.dispatch = (event) => dispatched.push(event);
    const eventFor = (code, key, shiftKey) => ({
      code, key, shiftKey, ctrlKey: false, altKey: false, metaKey: false,
      repeat: false, target: { tagName: "DIV", getAttribute() { return null; } },
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    });

    const bareF6 = eventFor("F6", "F6", false);
    controller.onDocumentKeyDown(bareF6);
    assert.equal(bareF6.defaultPrevented, false);
    assert.equal(dispatched.length, 0);

    controller.keyboardHandler.reset();
    const shift = eventFor("ShiftLeft", "Shift", true);
    controller.onDocumentKeyDown(shift);
    const shiftF6 = eventFor("F6", "F6", true);
    controller.onDocumentKeyDown(shiftF6);
    assert.equal(shiftF6.defaultPrevented, true);
    assert.equal(dispatched.length, 0, "no document");

    currentDoc = { selectedLayerIndices: [], selectionMask: null };
    controller.onDocumentKeyDown(shiftF6);
    assert.equal(dispatched.length, 0, "no selection mask");

    currentDoc.selectionMask = { width: 2, height: 2, data: new Uint8Array(4) };
    controller.onDocumentKeyDown(shiftF6);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].data.dialogRouteId, "sel_feather");
    controller.onKeyEvent("up");
    assert.equal(dispatched.length, 1, "key release must not reopen Feather");
  });

  it("Shift+Plus and Shift+Minus cycle a group's blend modes through Pass Through", () => {
    function FakeController() {}
    applyKeyboardHandlers(FakeController);
    const group = { blendMode: "pass", isGroup() { return true; } };
    const doc = { layers: [group], selectedLayerIndices: [0] };
    const dispatched = [];
    const controller = new FakeController();
    let pressedKey = KeyboardHandler.Plus;
    controller.keyboardHandler = {
      isPressed(key) { return key === KeyboardHandler.Shift || key === pressedKey; },
    };
    controller.overlayManager = { getTopPopup() { return null; } };
    controller.documentView = { getTopDialog() { return null; } };
    controller.appData = { activeToolId: null };
    controller.getCurrentDoc = () => doc;
    controller.updateTemporaryToolFromModifiers = () => {};
    controller.isShortcutKeyHeld = () => false;
    controller.dispatch = (event) => dispatched.push({ ...event.data });

    controller.onKeyEvent("down");
    assert.equal(dispatched.at(-1).layerPropertyValue, 1, "Plus advances Pass Through to Normal");
    group.blendMode = "norm";
    pressedKey = KeyboardHandler.Minus;
    controller.onKeyEvent("down");
    assert.equal(dispatched.at(-1).layerPropertyValue, 0, "Minus returns Normal to Pass Through");
  });

  it("buildInvertSelectionHistoryData keeps uf wire key", () => {
    assert.deepEqual(buildInvertSelectionHistoryData(), { uf: "inverse" });
  });
});
