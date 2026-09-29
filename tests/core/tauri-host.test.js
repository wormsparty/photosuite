import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { canWriteClipboard, listPrinters, nativeSaveAs, nativeWriteFile, openExternalUrl, pickAndReadFile, pickSavePath, readThirdPartyNotices, submitPrintJob } from "../../src/core/tauri-host.js";
const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });
function bridge(invoke) { globalThis.window = { __TAURI__: { core: { invoke } } }; }
it("save dialog options select the remembered directory and cancellation performs no write", async () => {
  const calls = [];
  bridge(async (...args) => { calls.push(args); return null; });
  assert.equal(await nativeSaveAs(new Uint8Array([1]), "art.psd", { directoryKey: "lastSaveDirectory", defaultDirectory: "/tmp/art" }), null);
  assert.deepEqual(calls, [["pick_save_path", { defaultName: "art.psd", defaultDirectory: "/tmp/art", directoryKey: "lastSaveDirectory" }]]);
  await pickSavePath("export.png");
  assert.equal(calls[1][1].directoryKey, "lastExportDirectory");
});
it("writes the exact byte view and encodes Unicode paths in the header", async () => {
  const calls = [];
  bridge(async (...args) => { calls.push(args); if (args[0] === "pick_save_path") return "/tmp/Zürich-写真.psd"; });
  const bytes = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
  assert.equal(await nativeSaveAs(bytes, "art.psd"), "/tmp/Zürich-写真.psd");
  assert.equal(calls[1][1], bytes);
  assert.equal(decodeURIComponent(calls[1][2].headers["X-PhotoSuite-Path"]), "/tmp/Zürich-写真.psd");
  assert.deepEqual([...calls[1][1]], [1, 2]);
});
it("propagates native write failures to the caller", async () => {
  bridge(async () => { throw new Error("disk full"); });
  await assert.rejects(nativeWriteFile("/tmp/art", [1]), /disk full/);
  await assert.rejects(readThirdPartyNotices(), /disk full/);
});
it("opens only the first selected file and returns its binary data", async () => {
  const calls = [];
  bridge(async (command, args) => { calls.push([command, args]); return command === "open_files" ? [{ name: "a.png", path: "/tmp/a.png" }, { name: "b.png", path: "/tmp/b.png" }] : new Uint8Array([1, 2]).buffer; });
  const file = await pickAndReadFile(true);
  assert.deepEqual(file, { name: "a.png", path: "/tmp/a.png", bytes: new Uint8Array([1, 2]) });
  assert.deepEqual(calls, [["open_files", { imagesOnly: true }], ["read_file_raw", { path: "/tmp/a.png" }]]);
});
it("handles absent host and cancelled Open without reading a file", async () => {
  delete globalThis.window;
  assert.equal(await pickAndReadFile(), null);
  assert.deepEqual(await listPrinters(), { printers: [], warning: "the print service is unavailable" });
  openExternalUrl("https://example.test");
  const calls = [];
  bridge(async (command) => { calls.push(command); return []; });
  assert.equal(await pickAndReadFile(), null);
  assert.deepEqual(calls, ["open_files"]);
});
it("serializes print settings in the header while retaining the raw PDF byte view", async () => {
  let call;
  bridge(async (...args) => { call = args; return 42; });
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const options = { printerId: "test", jobName: "写真 Zürich", copies: 2 };
  assert.equal(await submitPrintJob(bytes, options), 42);
  assert.equal(call[0], "submit_print_job");
  assert.equal(call[1], bytes);
  assert.deepEqual(JSON.parse(decodeURIComponent(call[2].headers["X-PhotoSuite-Print"])), options);
});
it("permits clipboard access only in the top-level webview", () => {
  globalThis.window = {};
  window.top = window.self = window;
  assert.equal(canWriteClipboard(), true);
  window.top = {};
  assert.equal(canWriteClipboard(), false);
});
