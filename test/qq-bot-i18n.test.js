"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { qqCardText, QQ_CARD_STRINGS } = require("../src/qq-bot-i18n");

describe("qq-bot-i18n: qqCardText", () => {
  it("returns the string for a known lang + key", () => {
    assert.strictEqual(qqCardText("zh", "allow"), "批准");
    assert.strictEqual(qqCardText("en", "deny"), "Deny");
    assert.strictEqual(qqCardText("ja", "allow"), "許可");
  });

  it("falls back to en for an unknown lang", () => {
    assert.strictEqual(qqCardText("xx", "allow"), "Allow");
  });

  it("falls back to the key itself for an unknown key", () => {
    assert.strictEqual(qqCardText("zh", "nope"), "nope");
  });

  it("substitutes {tool} / {mode} / {n} placeholders", () => {
    assert.strictEqual(qqCardText("en", "alwaysDenyTool", { tool: "Write" }), "Always deny Write");
    assert.strictEqual(qqCardText("zh", "alwaysDenyTool", { tool: "Write" }), "始终拒绝 Write");
    assert.strictEqual(qqCardText("en", "modePrefix", { mode: "ask" }), "Mode: ask");
    assert.ok(qqCardText("zh", "submitDone", { n: 3 }).includes("3"));
  });

  it("covers all five supported languages for core keys", () => {
    for (const lang of ["en", "zh", "zh-TW", "ko", "ja"]) {
      assert.ok(QQ_CARD_STRINGS[lang], `lang ${lang} present`);
      assert.ok(QQ_CARD_STRINGS[lang].allow, `lang ${lang} has allow`);
      assert.ok(QQ_CARD_STRINGS[lang].deny, `lang ${lang} has deny`);
    }
  });
});
