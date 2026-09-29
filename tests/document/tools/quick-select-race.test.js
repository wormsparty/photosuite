import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Rect } from "../../../src/core/math/rect.js";

const restore = installBrowserGlobals();
after(restore);
let syncQuickSelectOverlay, getLayerFingerprint, createQuickSelectSession;
before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ syncQuickSelectOverlay, getLayerFingerprint, createQuickSelectSession } =
    await import("../../../src/document/tools/quick-select-session.js"));
});

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let callbacks;
beforeEach(() => {
  callbacks = new Map();
  let timerId = 0;
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 30);
    callbacks.set(++timerId, callback);
    return timerId;
  };
  globalThis.clearTimeout = (id) => callbacks.delete(id);
});
afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function smallDocument(red = 40) {
  const buffer = new Uint8ClampedArray(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel++) {
    buffer.set([red, pixel % 8 < 4 ? 60 : 180, 100, 255], pixel * 4);
  }
  return { selectedLayerIndices: [0], layers: [{ buffer, rect: new Rect(0, 0, 8, 8) }] };
}

const dispatcher = { dispatch() { assert.fail("tiny fixtures need no loading banner"); } };

function assertReady(session, doc) {
  assert.equal(session.key, getLayerFingerprint(doc));
  assert.equal(session.layerRgbaBuffer, doc.layers[0].buffer);
  assert.equal(session.brushMaskBuffer.length, 64);
  assert.ok(session.graph.segmentCount > 0);
  assert.equal(session.graph.labels.length, 64);
  assert.equal(session.selectionMaskBuffer.length, 64);
}

it("keeps the completed key empty while hover analysis is deferred", () => {
  const doc = smallDocument(), session = { key: "" };
  syncQuickSelectOverlay(doc, session, dispatcher, false);
  assert.equal(session.key, "");
  assert.equal(session.graph, undefined);
  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assertReady(session, doc);
});

it("initializes real masks and graph for a same-tick stroke after hover", () => {
  const doc = smallDocument(), session = { key: "" };
  syncQuickSelectOverlay(doc, session, dispatcher, false);
  syncQuickSelectOverlay(doc, session, dispatcher, true);
  assertReady(session, doc);
  assert.deepEqual(session.brushMaskBuffer, new Uint8Array(64).fill(128));
});

it("a superseded hover callback cannot erase marks from the synchronous stroke", () => {
  const doc = smallDocument(), session = { key: "" };
  syncQuickSelectOverlay(doc, session, dispatcher, false);
  const staleCallback = [...callbacks.values()][0];
  syncQuickSelectOverlay(doc, session, dispatcher, true);
  assertReady(session, doc);
  const mask = session.brushMaskBuffer;
  mask[0] = 255;
  staleCallback();
  assert.equal(session.brushMaskBuffer, mask);
  assert.equal(session.brushMaskBuffer[0], 255);
});

it("an old document callback cannot replace the new document analysis", () => {
  const oldDoc = smallDocument(40), newDoc = smallDocument(210), session = { key: "" };
  syncQuickSelectOverlay(oldDoc, session, dispatcher, false);
  const oldCallback = [...callbacks.values()][0];
  syncQuickSelectOverlay(newDoc, session, dispatcher, true);
  assertReady(session, newDoc);
  const graph = session.graph;
  oldCallback();
  assertReady(session, newDoc);
  assert.equal(session.graph, graph);
});

it("coalesces repeated hover into one real analysis and preserves completed selection", () => {
  const doc = smallDocument(), session = { key: "" };
  for (let i = 0; i < 3; i++) syncQuickSelectOverlay(doc, session, dispatcher, false);
  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assertReady(session, doc);
  const mask = session.brushMaskBuffer;
  mask[1] = 255;
  syncQuickSelectOverlay(doc, session, dispatcher, true);
  assert.equal(session.brushMaskBuffer, mask);
  assert.equal(mask[1], 255);
});

it("creates a fully analysed small session directly without scheduling work", () => {
  const doc = smallDocument();
  assertReady(createQuickSelectSession(doc), doc);
  assert.equal(callbacks.size, 0);
});

it("returning to a completed document cancels another document's pending hover", () => {
  const firstDoc = smallDocument(40), otherDoc = smallDocument(210);
  const session = createQuickSelectSession(firstDoc);
  const graph = session.graph;
  session.brushMaskBuffer[3] = 255;
  syncQuickSelectOverlay(otherDoc, session, dispatcher, false);
  const staleCallback = [...callbacks.values()][0];
  syncQuickSelectOverlay(firstDoc, session, dispatcher, true);
  assert.equal(callbacks.size, 0);
  staleCallback();
  assertReady(session, firstDoc);
  assert.equal(session.graph, graph);
  assert.equal(session.brushMaskBuffer[3], 255);
});

it("drops deferred analysis when the document no longer has a selected layer", () => {
  const doc = smallDocument(), session = { key: "" };
  syncQuickSelectOverlay(doc, session, dispatcher, false);
  const deferred = [...callbacks.values()][0];
  doc.selectedLayerIndices = [];
  assert.doesNotThrow(deferred);
  assert.equal(session.key, "");
  assert.equal(session.graph, undefined);
  doc.selectedLayerIndices = [0];
  syncQuickSelectOverlay(doc, session, dispatcher, true);
  assertReady(session, doc);
});
