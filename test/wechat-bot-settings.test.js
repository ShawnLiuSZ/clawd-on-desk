"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_WECHAT_BOT,
  cloneDefaultWechatBot,
  normalizeWechatBot,
  validateWechatBot,
  readiness,
} = require("../src/wechat-bot-settings");

describe("wechat-bot-settings", () => {
  describe("DEFAULT_WECHAT_BOT", () => {
    it("is frozen and has expected keys", () => {
      assert.ok(Object.isFrozen(DEFAULT_WECHAT_BOT));
      assert.strictEqual(DEFAULT_WECHAT_BOT.enabled, false);
      assert.strictEqual(DEFAULT_WECHAT_BOT.token, "");
      assert.strictEqual(DEFAULT_WECHAT_BOT.approvalEnabled, true);
      assert.strictEqual(DEFAULT_WECHAT_BOT.approvalTimeoutMs, 300000);
      assert.strictEqual(DEFAULT_WECHAT_BOT.baseUrl, "https://ilinkai.weixin.qq.com");
      assert.strictEqual(DEFAULT_WECHAT_BOT.accountId, "default");
    });
  });

  describe("cloneDefaultWechatBot", () => {
    it("returns a mutable copy", () => {
      const cloned = cloneDefaultWechatBot();
      assert.deepStrictEqual(cloned, DEFAULT_WECHAT_BOT);
      cloned.enabled = true;
      assert.strictEqual(DEFAULT_WECHAT_BOT.enabled, false);
    });
  });

  describe("normalizeWechatBot", () => {
    it("returns defaults for null/undefined", () => {
      const result = normalizeWechatBot(null);
      assert.strictEqual(result.enabled, false);
      assert.strictEqual(result.token, "");
    });

    it("normalizes valid values", () => {
      const result = normalizeWechatBot({
        enabled: true,
        token: "my-bearer-token",
        approvalEnabled: false,
        approvalTimeoutMs: 60000,
        baseUrl: "https://custom.example.com",
        accountId: "my-account",
      });
      assert.strictEqual(result.enabled, true);
      assert.strictEqual(result.token, "my-bearer-token");
      assert.strictEqual(result.approvalEnabled, false);
      assert.strictEqual(result.approvalTimeoutMs, 60000);
      assert.strictEqual(result.baseUrl, "https://custom.example.com");
      assert.strictEqual(result.accountId, "my-account");
    });

    it("clamps approvalTimeoutMs to 600000 max", () => {
      const result = normalizeWechatBot({ approvalTimeoutMs: 999999 });
      assert.strictEqual(result.approvalTimeoutMs, 600000);
    });

    it("trims strings", () => {
      const result = normalizeWechatBot({
        token: "  my-token  ",
        baseUrl: "  https://example.com  ",
      });
      assert.strictEqual(result.token, "my-token");
      assert.strictEqual(result.baseUrl, "https://example.com");
    });

    it("coerces non-plain-object input to defaults", () => {
      const result = normalizeWechatBot("bad");
      assert.strictEqual(result.enabled, false);
    });
  });

  describe("validateWechatBot", () => {
    it("rejects non-plain-object", () => {
      const result = validateWechatBot("bad");
      assert.strictEqual(result.status, "error");
    });

    it("rejects unsupported keys", () => {
      const result = validateWechatBot({ unknownKey: true });
      assert.strictEqual(result.status, "error");
    });

    it("accepts valid config", () => {
      const result = validateWechatBot({
        enabled: true,
        token: "test-token",
      });
      assert.strictEqual(result.status, "ok");
    });

    it("rejects non-boolean enabled", () => {
      const result = validateWechatBot({ enabled: "yes" });
      assert.strictEqual(result.status, "error");
    });

    it("rejects non-string token", () => {
      const result = validateWechatBot({ token: 123 });
      assert.strictEqual(result.status, "error");
    });

    it("rejects invalid approvalTimeoutMs", () => {
      const result = validateWechatBot({ approvalTimeoutMs: -1 });
      assert.strictEqual(result.status, "error");
    });
  });

  describe("readiness", () => {
    it("returns not ready when disabled", () => {
      const result = readiness({ enabled: false });
      assert.strictEqual(result.ready, false);
      assert.strictEqual(result.reason, "disabled");
    });

    it("returns not ready when missing token", () => {
      const result = readiness({ enabled: true });
      assert.strictEqual(result.ready, false);
      assert.strictEqual(result.reason, "missing-token");
    });

    it("returns ready when enabled with token", () => {
      const result = readiness({ enabled: true, token: "my-token" });
      assert.strictEqual(result.ready, true);
    });
  });
});
