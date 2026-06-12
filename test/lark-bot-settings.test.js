"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_LARK_BOT,
  LARK_APPID_RE,
  LARK_CHATID_RE,
  VALID_NOTIFY_STATES,
  cloneDefaultLarkBot,
  normalizeLarkBot,
  validateLarkBot,
  maskLarkAppSecret,
  isValidLarkAppId,
  isValidLarkChatId,
  readiness,
} = require("../src/lark-bot-settings");

describe("lark-bot-settings: cloneDefaultLarkBot", () => {
  it("returns a frozen copy of defaults", () => {
    const a = cloneDefaultLarkBot();
    const b = cloneDefaultLarkBot();
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a, b);
    assert.strictEqual(a.enabled, false);
    assert.strictEqual(a.appId, "");
    assert.strictEqual(a.appSecret, "");
    assert.strictEqual(a.chatId, "");
    assert.strictEqual(a.approvalEnabled, true);
    assert.strictEqual(a.approvalTimeoutMs, 300000);
    assert.deepStrictEqual(a.notifyStates, ["attention", "error"]);
    assert.strictEqual(a.minIntervalMs, 5000);
  });
});

describe("lark-bot-settings: normalizeLarkBot", () => {
  it("returns defaults for null/undefined input", () => {
    const result = normalizeLarkBot(null);
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.appId, "");
    assert.strictEqual(result.appSecret, "");
    assert.strictEqual(result.chatId, "");
  });

  it("normalizes valid input", () => {
    const result = normalizeLarkBot({
      enabled: true,
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
      approvalEnabled: true,
      approvalTimeoutMs: 60000,
      notifyStates: ["attention", "error", "notification"],
      minIntervalMs: 3000,
    });
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.appId, "cli_xxxxx");
    assert.strictEqual(result.appSecret, "secret123");
    assert.strictEqual(result.chatId, "oc_xxxxx");
    assert.strictEqual(result.approvalEnabled, true);
    assert.strictEqual(result.approvalTimeoutMs, 60000);
    assert.deepStrictEqual(result.notifyStates, ["attention", "error", "notification"]);
    assert.strictEqual(result.minIntervalMs, 3000);
  });

  it("rejects invalid appId", () => {
    const result = normalizeLarkBot({ appId: "invalid id with spaces" });
    assert.strictEqual(result.appId, "");
  });

  it("rejects invalid chatId", () => {
    const result = normalizeLarkBot({ chatId: "invalid id with spaces" });
    assert.strictEqual(result.chatId, "");
  });

  it("clamps approvalTimeoutMs to max 600000", () => {
    const result = normalizeLarkBot({ approvalTimeoutMs: 999999 });
    assert.strictEqual(result.approvalTimeoutMs, 600000);
  });

  it("clamps minIntervalMs to min 1000", () => {
    const result = normalizeLarkBot({ minIntervalMs: 100 });
    assert.strictEqual(result.minIntervalMs, 1000);
  });

  it("normalizes invalid notifyStates to defaults", () => {
    const result = normalizeLarkBot({ notifyStates: "invalid" });
    assert.deepStrictEqual(result.notifyStates, ["attention", "error"]);
  });

  it("deduplicates notifyStates", () => {
    const result = normalizeLarkBot({ notifyStates: ["attention", "attention", "error"] });
    assert.deepStrictEqual(result.notifyStates, ["attention", "error"]);
  });
});

describe("lark-bot-settings: validateLarkBot", () => {
  it("returns ok for valid input", () => {
    const result = validateLarkBot({ enabled: true, appId: "cli_xxxxx" });
    assert.strictEqual(result.status, "ok");
  });

  it("returns error for non-object input", () => {
    const result = validateLarkBot("invalid");
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("plain object"));
  });

  it("returns error for unsupported keys", () => {
    const result = validateLarkBot({ unknown: true });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("not supported"));
  });

  it("returns error for invalid enabled type", () => {
    const result = validateLarkBot({ enabled: "yes" });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("boolean"));
  });

  it("returns error for invalid appId type", () => {
    const result = validateLarkBot({ appId: 123 });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("string"));
  });

  it("returns error for invalid approvalTimeoutMs", () => {
    const result = validateLarkBot({ approvalTimeoutMs: -1 });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("positive number"));
  });
});

describe("lark-bot-settings: maskLarkAppSecret", () => {
  it("returns empty for empty input", () => {
    assert.strictEqual(maskLarkAppSecret(""), "");
    assert.strictEqual(maskLarkAppSecret(null), "");
  });

  it("masks short secrets", () => {
    assert.strictEqual(maskLarkAppSecret("short"), "••••");
  });

  it("masks long secrets", () => {
    const result = maskLarkAppSecret("abcdefghijklmnop");
    assert.strictEqual(result, "abcd……mnop");
  });
});

describe("lark-bot-settings: isValidLarkAppId", () => {
  it("accepts valid app IDs", () => {
    assert.ok(isValidLarkAppId("cli_xxxxx"));
    assert.ok(isValidLarkAppId("1234567890"));
    assert.ok(isValidLarkAppId("app-id_123"));
  });

  it("rejects invalid app IDs", () => {
    assert.ok(!isValidLarkAppId(""));
    assert.ok(!isValidLarkAppId("invalid id"));
    assert.ok(!isValidLarkAppId(null));
  });
});

describe("lark-bot-settings: isValidLarkChatId", () => {
  it("accepts valid chat IDs", () => {
    assert.ok(isValidLarkChatId("oc_xxxxx"));
    assert.ok(isValidLarkChatId("ou_xxxxx"));
    assert.ok(isValidLarkChatId("chat-id_123"));
  });

  it("rejects invalid chat IDs", () => {
    assert.ok(!isValidLarkChatId(""));
    assert.ok(!isValidLarkChatId("invalid id"));
    assert.ok(!isValidLarkChatId(null));
  });
});

describe("lark-bot-settings: readiness", () => {
  it("returns disabled when not enabled", () => {
    const result = readiness({ enabled: false });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.reason, "disabled");
  });

  it("returns missing-appid when appId is empty", () => {
    const result = readiness({ enabled: true, appSecret: "secret", chatId: "chat" });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.reason, "missing-appid");
  });

  it("returns missing-secret when appSecret is empty", () => {
    const result = readiness({ enabled: true, appId: "app", chatId: "chat" });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.reason, "missing-secret");
  });

  it("returns missing-chatid when chatId is empty", () => {
    const result = readiness({ enabled: true, appId: "app", appSecret: "secret" });
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.reason, "missing-chatid");
  });

  it("returns ready when all required fields are present", () => {
    const result = readiness({
      enabled: true,
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    });
    assert.strictEqual(result.ready, true);
    assert.ok(result.config);
  });
});
