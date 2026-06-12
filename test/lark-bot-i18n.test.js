"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { LARK_CARD_STRINGS, larkCardText } = require("../src/lark-bot-i18n");

describe("lark-bot-i18n: larkCardText", () => {
  it("returns the string for a known lang + key", () => {
    assert.strictEqual(larkCardText("zh", "allow"), "允许");
    assert.strictEqual(larkCardText("en", "deny"), "Deny");
    assert.strictEqual(larkCardText("ja", "allow"), "許可");
  });

  it("falls back to en for an unknown lang", () => {
    assert.strictEqual(larkCardText("xx", "allow"), "Allow");
  });

  it("falls back to the key itself for an unknown key", () => {
    assert.strictEqual(larkCardText("zh", "nope"), "nope");
  });

  it("substitutes {tool} / {mode} / {n} / {code} placeholders", () => {
    assert.strictEqual(larkCardText("en", "alwaysDenyTool", { tool: "Write" }), "Always deny Write");
    assert.strictEqual(larkCardText("zh", "alwaysDenyTool", { tool: "Write" }), "始终拒绝 Write");
    assert.strictEqual(larkCardText("en", "modePrefix", { mode: "ask" }), "Mode: ask");
    assert.ok(larkCardText("zh", "submitDone", { n: 3 }).includes("3"));
    assert.ok(larkCardText("en", "approvalHint", { code: "AB12" }).includes("AB12"));
  });

  it("covers all five supported languages for core keys", () => {
    for (const lang of ["en", "zh", "zh-TW", "ko", "ja"]) {
      assert.ok(LARK_CARD_STRINGS[lang], `lang ${lang} present`);
      assert.ok(LARK_CARD_STRINGS[lang].allow, `lang ${lang} has allow`);
      assert.ok(LARK_CARD_STRINGS[lang].deny, `lang ${lang} has deny`);
    }
  });
});
