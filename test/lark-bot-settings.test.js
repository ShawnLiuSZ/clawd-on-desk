"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_LARK_BOT,
  LARK_APPID_RE,
  LARK_CHATID_RE,
  VALID_NOTIFY_STATES,
  VALID_REGIONS,
  VALID_AUTH_MODES,
  AUTH_MODE_APP_SECRET,
  AUTH_MODE_DEVICE_CODE,
  REGION_FEISHU,
  REGION_LARK,
  cloneDefaultLarkBot,
  normalizeLarkBot,
  normalizeAuthMode,
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
    assert.strictEqual(a.region, REGION_FEISHU);
    assert.strictEqual(a.approvalEnabled, true);
    assert.strictEqual(a.approvalTimeoutMs, 300000);
    assert.deepStrictEqual(a.notifyStates, ["attention", "error"]);
    assert.strictEqual(a.minIntervalMs, 5000);
    assert.strictEqual(a.authMode, AUTH_MODE_APP_SECRET);
    assert.strictEqual(a.deviceUserOpenId, "");
    assert.strictEqual(a.deviceUserName, "");
  });
});

describe("lark-bot-settings: normalizeLarkBot", () => {
  it("returns defaults for null/undefined input", () => {
    const result = normalizeLarkBot(null);
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.appId, "");
    assert.strictEqual(result.appSecret, "");
    assert.strictEqual(result.chatId, "");
    assert.strictEqual(result.region, REGION_FEISHU);
  });

  it("normalizes valid input", () => {
    const result = normalizeLarkBot({
      enabled: true,
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
      region: "lark",
      approvalEnabled: true,
      approvalTimeoutMs: 60000,
      notifyStates: ["attention", "error", "notification"],
      minIntervalMs: 3000,
    });
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.appId, "cli_xxxxx");
    assert.strictEqual(result.appSecret, "secret123");
    assert.strictEqual(result.chatId, "oc_xxxxx");
    assert.strictEqual(result.region, REGION_LARK);
    assert.strictEqual(result.approvalEnabled, true);
    assert.strictEqual(result.approvalTimeoutMs, 60000);
    assert.deepStrictEqual(result.notifyStates, ["attention", "error", "notification"]);
    assert.strictEqual(result.minIntervalMs, 3000);
  });

  it("defaults region to feishu when not specified", () => {
    const result = normalizeLarkBot({ enabled: true, appId: "cli_xxxxx" });
    assert.strictEqual(result.region, REGION_FEISHU);
  });

  it("rejects invalid region and defaults to feishu", () => {
    const result = normalizeLarkBot({ region: "invalid" });
    assert.strictEqual(result.region, REGION_FEISHU);
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

  it("preserves authMode defaults to app_secret when not specified", () => {
    const result = normalizeLarkBot({ appId: "cli_xxxxx" });
    assert.strictEqual(result.authMode, AUTH_MODE_APP_SECRET);
  });

  it("normalizes authMode to device_code", () => {
    const result = normalizeLarkBot({ authMode: AUTH_MODE_DEVICE_CODE });
    assert.strictEqual(result.authMode, AUTH_MODE_DEVICE_CODE);
  });

  it("normalizes invalid authMode to app_secret", () => {
    const result = normalizeLarkBot({ authMode: "invalid" });
    assert.strictEqual(result.authMode, AUTH_MODE_APP_SECRET);
  });

  it("preserves deviceUserOpenId and deviceUserName", () => {
    const result = normalizeLarkBot({
      authMode: AUTH_MODE_DEVICE_CODE,
      deviceUserOpenId: "ou_abc123",
      deviceUserName: "张三",
    });
    assert.strictEqual(result.authMode, AUTH_MODE_DEVICE_CODE);
    assert.strictEqual(result.deviceUserOpenId, "ou_abc123");
    assert.strictEqual(result.deviceUserName, "张三");
  });

  it("trims deviceUserOpenId to max 64 chars", () => {
    const result = normalizeLarkBot({ deviceUserOpenId: "a".repeat(100) });
    assert.strictEqual(result.deviceUserOpenId.length, 64);
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

  it("accepts valid authMode", () => {
    const result = validateLarkBot({ authMode: AUTH_MODE_DEVICE_CODE });
    assert.strictEqual(result.status, "ok");
  });

  it("rejects invalid authMode", () => {
    const result = validateLarkBot({ authMode: "invalid" });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("authMode"));
  });

  it("accepts valid deviceUserOpenId", () => {
    const result = validateLarkBot({ deviceUserOpenId: "ou_abc123" });
    assert.strictEqual(result.status, "ok");
  });

  it("rejects invalid deviceUserOpenId type", () => {
    const result = validateLarkBot({ deviceUserOpenId: 123 });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("string"));
  });

  it("accepts valid deviceUserName", () => {
    const result = validateLarkBot({ deviceUserName: "张三" });
    assert.strictEqual(result.status, "ok");
  });

  it("rejects invalid deviceUserName type", () => {
    const result = validateLarkBot({ deviceUserName: 123 });
    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("string"));
  });
});

describe("lark-bot-settings: normalizeAuthMode", () => {
  it("returns app_secret for null/undefined input", () => {
    assert.strictEqual(normalizeAuthMode(null), AUTH_MODE_APP_SECRET);
    assert.strictEqual(normalizeAuthMode(undefined), AUTH_MODE_APP_SECRET);
  });

  it("returns app_secret for invalid input", () => {
    assert.strictEqual(normalizeAuthMode("invalid"), AUTH_MODE_APP_SECRET);
    assert.strictEqual(normalizeAuthMode(""), AUTH_MODE_APP_SECRET);
    assert.strictEqual(normalizeAuthMode(123), AUTH_MODE_APP_SECRET);
  });

  it("returns valid auth modes", () => {
    assert.strictEqual(normalizeAuthMode(AUTH_MODE_APP_SECRET), AUTH_MODE_APP_SECRET);
    assert.strictEqual(normalizeAuthMode(AUTH_MODE_DEVICE_CODE), AUTH_MODE_DEVICE_CODE);
  });

  it("VALID_AUTH_MODES contains both modes", () => {
    assert.deepStrictEqual(VALID_AUTH_MODES, [AUTH_MODE_APP_SECRET, AUTH_MODE_DEVICE_CODE]);
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

  // WebSocket model: chatId is auto-bound when the user messages the bot, so it
  // no longer gates readiness — it's reported separately as `bound`.
  it("is ready-but-unbound when creds are present but no chat bound yet", () => {
    const result = readiness({ enabled: true, appId: "cli_x", appSecret: "secret" });
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.bound, false);
    assert.strictEqual(result.reason, "unbound");
  });

  it("returns ready+bound when creds and a bound chat are present", () => {
    const result = readiness({
      enabled: true,
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    });
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.bound, true);
    assert.ok(result.config);
  });
});
