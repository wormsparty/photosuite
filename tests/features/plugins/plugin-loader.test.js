import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { convertPluginAssetUrl, ensureSidebarPluginsDirectory, hydrateDiscoveredPluginSpec, loadDiscoveredSidebarPlugins, registerDiscoveredSidebarPlugins } from "../../../src/features/plugins/plugin-loader.js";
const originalWindow = globalThis.window;
const originalWarn = console.warn;
afterEach(() => { globalThis.window = originalWindow; console.warn = originalWarn; });
const record = { id: "sample", name: "Sample", entryPath: "/tmp/plugins/sample/index.html", iconPath: "/tmp/plugins/sample/icon.svg", width: 300, height: 400, themed: true };
function bridge(invoke) { globalThis.window = { __TAURI__: { core: { invoke, convertFileSrc: (path) => "asset:" + path } } }; }
it("returns empty discovery and preserves paths when the native bridge is absent", async () => {
  delete globalThis.window;
  assert.equal(await ensureSidebarPluginsDirectory(), null);
  assert.deepEqual(await loadDiscoveredSidebarPlugins(), []);
  assert.equal(convertPluginAssetUrl("/tmp/plugin.html"), "/tmp/plugin.html");
  assert.equal(convertPluginAssetUrl(null), "");
});
it("hydrates the icon and bundles local UTF-8 scripts/styles while leaving remote references intact", async () => {
  const reads = [];
  const files = {
    [record.entryPath]: '<link rel="stylesheet" href="style.css"><script src="app.js"></script><script src="https://example.test/remote.js"></script>',
    "/tmp/plugins/sample/style.css": "body { color: red; }",
    "/tmp/plugins/sample/app.js": 'window.label = "写真";',
  };
  bridge(async (command, args) => { reads.push([command, args.path]); return command === "read_file_base64" ? "PHN2Zy8+" : [...new TextEncoder().encode(files[args.path])]; });
  const spec = await hydrateDiscoveredPluginSpec(record);
  assert.equal(spec.url, "asset:" + record.entryPath);
  assert.equal(spec.icon, "data:image/svg+xml;base64,PHN2Zy8+");
  assert.equal(spec.sandboxed, true);
  assert.ok(spec.html.includes('<script>\nwindow.label = "写真";\n</script>'));
  assert.ok(spec.html.includes("<style>\nbody { color: red; }\n</style>"));
  assert.ok(spec.html.includes('src="https://example.test/remote.js"'));
  assert.equal(reads.length, 4);
});
it("retains the asset URL if entry text or icon cannot be read", async () => {
  console.warn = () => {};
  bridge(async () => { throw new Error("file removed"); });
  const spec = await hydrateDiscoveredPluginSpec(record);
  assert.equal(spec.url, "asset:" + record.entryPath);
  assert.equal(spec.icon, "asset:" + record.iconPath);
  assert.equal(spec.html, undefined);
});
it("creates the directory before discovery and ignores null or id-less entries", async () => {
  const calls = [];
  bridge(async (command) => { calls.push(command); if (command === "ensure_plugins_directory") return "/tmp/plugins"; if (command === "discover_sidebar_plugins_command") return [null, {}, record]; return null; });
  const specs = await loadDiscoveredSidebarPlugins();
  assert.deepEqual(calls.slice(0, 2), ["ensure_plugins_directory", "discover_sidebar_plugins_command"]);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, "sample");
});
it("reports discovery rejection as an empty result", async () => {
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  bridge(async (command) => { if (command === "ensure_plugins_directory") return "/tmp/plugins"; throw new Error("permission denied"); });
  assert.deepEqual(await loadDiscoveredSidebarPlugins(), []);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][1]), /permission denied/);
});
it("registers only new panel IDs and repeated refresh is idempotent", () => {
  const ids = new Set(["plg_existing"]);
  const registrations = [];
  const sidebar = { findEntryByPanelId: (id) => ids.has(id) ? {} : null, registerRuntimePlugins(specs) { registrations.push(specs); for (const spec of specs) ids.add("plg_" + spec.id); } };
  registerDiscoveredSidebarPlugins(sidebar, [{ id: "existing" }, record]);
  registerDiscoveredSidebarPlugins(sidebar, [{ id: "existing" }, record]);
  assert.deepEqual(registrations, [[record]]);
});
