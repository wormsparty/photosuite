import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { confirmUser, installToastPainter, installWebviewConfirm, promptConfirmUser, promptUnsavedCloseForClose, showModalMessage, showToast, tryNativeConfirmSync } from "../../src/core/user-prompts.js";
const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; installWebviewConfirm(null); installToastPainter(null); });
it("uses the captured native confirm even after the window function is replaced", () => {
  globalThis.window = { confirm: () => { throw new Error("wrapped confirm must not run"); } };
  let receiver, message;
  installWebviewConfirm(function(text) { receiver = this; message = text; return false; });
  assert.equal(tryNativeConfirmSync("Discard edits?"), false);
  assert.equal(receiver, window);
  assert.equal(message, "Discard edits?");
});
it("fails closed if confirmation is absent or blocked and honors an explicit safe fallback", () => {
  globalThis.window = {};
  assert.equal(confirmUser("Discard?"), false);
  assert.equal(confirmUser("Continue?", { whenBlocked: "proceed" }), true);
  window.confirm = () => { throw new Error("blocked"); };
  assert.equal(confirmUser("Discard?"), false);
});
it("treats an asynchronous native confirmation as unavailable and consumes rejection", async () => {
  globalThis.window = {};
  installWebviewConfirm(() => Promise.reject(new Error("dialog denied")));
  assert.equal(tryNativeConfirmSync("Discard?"), null);
  await Promise.resolve();
});
it("uses the native asynchronous dialog when synchronous confirmation is unavailable", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: { core: { invoke: async (...args) => { calls.push(args); return true; } } } };
  const answer = await new Promise((resolve) => promptConfirmUser("Discard?", { title: "Unsaved" }, resolve));
  assert.equal(answer, true);
  assert.deepEqual(calls, [["confirm_dialog", { message: "Discard?", title: "Unsaved" }]]);
});
it("delivers the fallback once when the host dialog rejects", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => { throw new Error("blocked"); } } } };
  const answers = [];
  await new Promise((resolve) => promptConfirmUser("Discard?", {}, (answer) => { answers.push(answer); resolve(); }));
  assert.deepEqual(answers, [false]);
});
it("closes an unmodified document without opening any confirmation", () => {
  let confirms = 0;
  globalThis.window = { confirm: () => { confirms++; return false; } };
  let answer;
  promptUnsavedCloseForClose({ isModified: () => false }, (value) => { answer = value; });
  assert.equal(answer, true);
  assert.equal(confirms, 0);
});
it("routes toast text and duration to its painter and native acknowledgments to the host", async () => {
  const painted = [], calls = [];
  showToast("before chrome");
  installToastPainter((...args) => painted.push(args));
  showToast("Saved", 2500);
  assert.deepEqual(painted, [["Saved", 2500]]);
  globalThis.window = { __TAURI__: { core: { invoke: async (...args) => { calls.push(args); } } } };
  showModalMessage(123);
  await Promise.resolve();
  assert.deepEqual(calls, [["plugin:dialog|message", { message: "123", title: "PhotoSuite", kind: "info" }]]);
});
