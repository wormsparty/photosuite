import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clipboardPath = path.join(repoRoot, "src/core/system-clipboard.js");

let clipboardImageSignature;
let isStaleClipboardFrame;
let CLIPBOARD_SIGNATURE_PENDING;
let applyDataTransferToController;
let writeClipboardRgba;
let readSystemClipboardForPaste;
let readClipboardImageSignature;

before(async () => {
  ({
    clipboardImageSignature,
    isStaleClipboardFrame,
    CLIPBOARD_SIGNATURE_PENDING,
    applyDataTransferToController,
    writeClipboardRgba,
    readSystemClipboardForPaste,
    readClipboardImageSignature,
  } = await import(
    "../../src/core/system-clipboard.js"
  ));
});

describe("core/system-clipboard.js", () => {
  it("exports clipboard helpers for Tauri plugin", () => {
    const source = fs.readFileSync(clipboardPath, "utf8");
    assert.match(source, /export function getTauriClipboardManager/);
    assert.match(source, /export function writeClipboardText/);
    assert.match(source, /export function writeClipboardRgba/);
    assert.match(source, /export function readClipboardText/);
    assert.match(source, /export function readSystemClipboardForPaste/);
    assert.match(source, /export function readClipboardImageSignature/);
  });

  it("routes vector path clipboard via uiDispatch wire payload", () => {
    const source = fs.readFileSync(clipboardPath, "utf8");
    assert.match(source, /pasteVectorPathsFromClipboard/);
    assert.match(source, /value:\s*text/);
    assert.match(source, /indexOf\("vcb;"\)/);
  });

  it("caps OS clipboard RGBA writes", () => {
    const source = fs.readFileSync(clipboardPath, "utf8");
    assert.match(source, /OS_CLIPBOARD_WRITE_MAX_PIXELS\s*=\s*1024 \* 1024/);
  });

  describe("clipboardImageSignature", () => {
    it("is width x height for a real frame", () => {
      assert.equal(clipboardImageSignature({ width: 4000, height: 3000 }), "4000x3000");
      assert.equal(clipboardImageSignature({ width: 512, height: 512 }), "512x512");
    });
    it("is 'none' for absent or empty frames", () => {
      assert.equal(clipboardImageSignature(null), "none");
      assert.equal(clipboardImageSignature({ width: 0, height: 0 }), "none");
      assert.equal(clipboardImageSignature({ width: 10 }), "none");
    });
  });

  describe("isStaleClipboardFrame — paste prefers in-app payload when pasteboard is unchanged", () => {
    const car = { width: 4000, height: 3000 };
    const pngIcon = { width: 512, height: 512 };
    const external = { width: 800, height: 600 };

    it("no frame is never stale", () => {
      assert.equal(isStaleClipboardFrame(null, "512x512"), false);
    });

    it("no baseline (no in-app copy tracked) → external content wins", () => {
      assert.equal(isStaleClipboardFrame(external, null), false);
      assert.equal(isStaleClipboardFrame(external, undefined), false);
    });

    it("pending baseline (copy just happened, probe not resolved) → treat OS image as stale", () => {
      // A large copy leaves a stale PNG-file icon on the pasteboard while the real
      // image is still being written; nothing may import it in that window.
      assert.equal(isStaleClipboardFrame(pngIcon, CLIPBOARD_SIGNATURE_PENDING), true);
      assert.equal(isStaleClipboardFrame(car, CLIPBOARD_SIGNATURE_PENDING), true);
    });

    it("pasteboard unchanged since copy (matches baseline) → stale, use in-app payload", () => {
      assert.equal(isStaleClipboardFrame(pngIcon, "512x512"), true);
    });

    it("pasteboard changed since copy (another app copied) → not stale, import it", () => {
      assert.equal(isStaleClipboardFrame(external, "512x512"), false);
    });
  });

  it("loads a newly copied image even when its file size matches the previous image", () => {
    const loaded = [];
    const controller = {
      appData: { lastClipboardImageFileSize: 0 },
      fileLoader: { loadLocalFiles(files) { loaded.push(files[0]); } },
    };
    const transfer = (file) => ({ items: [{ type: "image/png", getAsFile: () => file }] });
    const first = { name: "first.png", size: 8, pixels: [255, 0] };
    const second = { name: "second.png", size: 8, pixels: [0, 255] };

    assert.equal(applyDataTransferToController(controller, transfer(first)), true);
    assert.equal(applyDataTransferToController(controller, transfer(second)), true);
    assert.deepEqual(loaded, [first, second]);
  });

  it("loads a native File clipboard image whose name is read-only", async () => {
    const image = new File([new Uint8Array([1, 2, 3, 4])], "pasted.png", { type: "image/png" });
    const loaded = [];
    const controller = {
      appData: {},
      fileLoader: { loadLocalFiles(files) { loaded.push(files[0]); } },
    };
    const transfer = { items: [{ type: "image/png", getAsFile: () => image }] };

    assert.equal(applyDataTransferToController(controller, transfer), true);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, "pasted.png");
    assert.deepEqual(new Uint8Array(await loaded[0].arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  });

  it("gives an unnamed clipboard File a filename for the image loader", async () => {
    const image = new File([new Uint8Array([5, 6, 7, 8])], "", { type: "image/png" });
    const loaded = [];
    const controller = {
      appData: {},
      fileLoader: { loadLocalFiles(files) { loaded.push(files[0]); } },
    };
    const transfer = { items: [{ type: "image/png", getAsFile: () => image }] };

    assert.equal(applyDataTransferToController(controller, transfer), true);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, "image.png");
    assert.deepEqual(new Uint8Array(await loaded[0].arrayBuffer()), new Uint8Array([5, 6, 7, 8]));
  });

  it("passes a small RGBA image to the native clipboard with exact bytes", async () => {
    const calls = [];
    window.__TAURI__ = { core: { invoke: async (command, payload) => calls.push({ command, payload }) } };
    try {
      await writeClipboardRgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1);
      assert.deepEqual(calls, [{
        command: "plugin:clipboard-manager|write_image",
        payload: { image: { rgba: [1, 2, 3, 4, 5, 6, 7, 8], width: 2, height: 1 } },
      }]);
    } finally {
      delete window.__TAURI__;
    }
  });

  it("rejects an oversized clipboard write before serializing pixels", async () => {
    const calls = [];
    window.__TAURI__ = { core: { invoke: async (...args) => calls.push(args) } };
    try {
      await writeClipboardRgba(new Uint8Array([1, 2, 3, 4]), 1025, 1025);
      assert.deepEqual(calls, []);
    } finally {
      delete window.__TAURI__;
    }
  });

  it("falls back to clipboard text when an OS image has malformed byte length", async () => {
    const received = [];
    window.__TAURI__ = { clipboardManager: {
      readImage: async () => ({ rgba: async () => [1, 2, 3], size: async () => ({ width: 1, height: 1 }) }),
      readText: async () => "https://example.invalid/image",
    } };
    const controller = { onClipboardTextUrl: (value) => received.push(value), applyClipboardImage: () => received.push("image") };
    try {
      assert.equal(await readSystemClipboardForPaste(controller, controller.applyClipboardImage, null), true);
      assert.deepEqual(received, ["https://example.invalid/image"]);
    } finally {
      delete window.__TAURI__;
    }
  });

  it("distinguishes external and unchanged clipboard images with equal dimensions", async () => {
    const imported = [];
    const copiedPixels = [255, 0, 0, 255, 0, 0, 255, 255];
    const externalPixels = [0, 255, 0, 255, 255, 255, 0, 255];
    let currentPixels = copiedPixels;
    window.__TAURI__ = { clipboardManager: {
      readImage: async () => ({
        rgba: async () => currentPixels,
        size: async () => ({ width: 2, height: 1 }),
      }),
      readText: async () => "",
    } };
    const controller = {
      applyClipboardImage(pixels, rect) {
        imported.push({ pixels: [...pixels], rect: [rect.width, rect.height] });
      },
    };
    try {
      const baseline = await readClipboardImageSignature();
      assert.equal(await readSystemClipboardForPaste(
        controller,
        controller.applyClipboardImage.bind(controller),
        null,
        baseline,
      ), false, "unchanged OS image should fall back to the in-app clipboard");
      assert.deepEqual(imported, []);
      currentPixels = externalPixels;
      assert.equal(await readSystemClipboardForPaste(
        controller,
        controller.applyClipboardImage.bind(controller),
        null,
        baseline,
      ), true);
      assert.deepEqual(imported, [{ pixels: externalPixels, rect: [2, 1] }]);
    } finally {
      delete window.__TAURI__;
    }
  });

  it("does not read pixel bytes while fingerprinting oversized clipboard metadata", async () => {
    let rgbaCalls = 0;
    window.__TAURI__ = { clipboardManager: {
      readImage: async () => ({
        size: async () => ({ width: 1025, height: 1025 }),
        rgba: async () => { rgbaCalls++; throw new Error("oversized clipboard pixels requested"); },
      }),
    } };
    try {
      assert.equal(await readClipboardImageSignature(), "1025x1025");
      assert.equal(rgbaCalls, 0);
    } finally {
      delete window.__TAURI__;
    }
  });
});
