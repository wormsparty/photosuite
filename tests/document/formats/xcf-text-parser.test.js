import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser, restore;
before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
});
after(() => restore?.());

const parasite = source => new TextEncoder().encode(source + "\0");
const parse = source => XCFParser.parseTextParasite(parasite(source));

describe("XCF text parasite parser (hazardous malformed controls are after-only)", () => {
  it("preserves UTF-8, quoted escapes, numeric atoms and whitespace-separated bindings", () => {
    assert.deepEqual(parse('(text "été 😀 \\"quoted\\" \\\\ path")\t(font\n"Sans")\r(font-size\t12) (color 1 0.25 0 1)'), {
      text: 'été 😀 "quoted" \\ path', font: "Sans", "font-size": "12", color: ["1", "0.25", "0", "1"],
    });
  });
  it("recognizes adjacent lists and returns the consumed close position", () => {
    const tokens = [];
    assert.equal(XCFParser.parseSExprTokens('(a(b)c)tail', 1, tokens), 7);
    assert.deepEqual(tokens, ["a", ["b"], "c"]);
    assert.deepEqual(parse('(text "ok")(font "Sans")'), { text: "ok", font: "Sans" });
    assert.deepEqual(parse(""), {});
  });
  for (const source of ['(text "unfinished', '(text "unfinished\\', '(text value', '(text value\n', '(text (value)', '(text "ok"))', '(text "ok") garbage', 'atom', '()', '(text)', '((text) value)']) {
    it(`rejects malformed parasite ${JSON.stringify(source)}`, { timeout: 1000 }, () => {
      assert.throws(() => parse(source), /xcf:/);
    });
  }
  for (const source of ['"unfinished', '"unfinished\\', 'atom', '(atom)']) {
    it(`rejects direct tokenizer EOF ${JSON.stringify(source)}`, { timeout: 1000 }, () => {
      assert.throws(() => XCFParser.parseSExprTokens(source, 0, []), /xcf:/);
    });
  }
  it("requires the payload's terminal NUL byte", () => {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode('(text "ok")')]) {
      assert.throws(() => XCFParser.parseTextParasite(bytes), /unterminated text parasite/);
    }
  });
  it("accepts the 128-list boundary and rejects deeper input without recursive stack growth", { timeout: 1000 }, () => {
    const value = depth => '(text ' + '('.repeat(depth) + 'atom' + ')'.repeat(depth) + ')';
    let result = parse(value(126)).text;
    for (let index = 0; index < 126; index++) {
      assert.equal(result.length, 1);
      result = result[0];
    }
    assert.equal(result, "atom");
    assert.throws(() => parse(value(127)), /nesting limit/);
    assert.throws(() => parse(value(1024)), /nesting limit/);
    assert.deepEqual(parse('(text "recovered")'), { text: "recovered" });
  });
});
