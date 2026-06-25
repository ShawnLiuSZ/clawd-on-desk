"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_QQ_BOT,
  QQ_APPID_RE,
  QQ_OPENID_RE,
  VALID_NOTIFY_STATES,
  cloneDefaultQQBot,
  normalizeQQBot,
  validateQQBot,
  maskQQAppSecret,
  isValidQQAppId,
  isValidQQOpenid,
  readiness,
} = require("../src/qq-bot-settings");

describe("qq-bot-settings: constants", () => {
  it("DEFAULT_QQ_BOT has expected shape", () => {
    assert.strictEqual(DEFAULT_QQ_BOT.enabled, false);
    assert.strictEqual(DEFAULT_QQ_BOT.appId, "");
    assert.strictEqual(DEFAULT_QQ_BOT.appSecret, "");
    assert.strictEqual(DEFAULT_QQ_BOT.userOpenid, "");
    assert.strictEqual(DEFAULT_QQ_BOT.approvalEnabled, true);
    assert.strictEqual(DEFAULT_QQ_BOT.approvalTimeoutMs, 300000);
    assert.ok(Array.isArray(DEFAULT_QQ_BOT.notifyStates));
    assert.ok(DEFAULT_QQ_BOT.notifyStates.includes("attention"));
    assert.ok(DEFAULT_QQ_BOT.notifyStates.includes("error"));
    assert.strictEqual(DEFAULT_QQ_BOT.minIntervalMs, 5000);
  });

  it("QQ_APPID_RE accepts valid app ids", () => {
    assert.ok(QQ_APPID_RE.test("123456"));
    assert.ok(QQ_APPID_RE.test("12345678901234567890"));
    assert.ok(!QQ_APPID_RE.test(""));
    assert.ok(!QQ_APPID_RE.test("abc"));
    assert.ok(!QQ_APPID_RE.test("12345"));
    assert.ok(!QQ_APPID_RE.test("123456789012345678901"));
  });

  it("QQ_OPENID_RE accepts valid openids", () => {
    assert.ok(QQ_OPENID_RE.test("abc123"));
    assert.ok(QQ_OPENID_RE.test("A-B_C"));
    assert.ok(!QQ_OPENID_RE.test(""));
    assert.ok(!QQ_OPENID_RE.test("a".repeat(65)));
  });

  it("VALID_NOTIFY_STATES is frozen with expected values", () => {
    assert.ok(Object.isFrozen(VALID_NOTIFY_STATES));
    assert.ok(VALID_NOTIFY_STATES.includes("attention"));
    assert.ok(VALID_NOTIFY_STATES.includes("error"));
    assert.ok(VALID_NOTIFY_STATES.includes("notification"));
    assert.ok(VALID_NOTIFY_STATES.includes("sleeping"));
  });
});

describe("qq-bot-settings: cloneDefaultQQBot", () => {
  it("returns a fresh object each time", () => {
    const a = cloneDefaultQQBot();
    const b = cloneDefaultQQBot();
    assert.notStrictEqual(a, b);
    assert.deepStrictEqual(a, b);
  });

  it("mutation does not affect defaults", () => {
    const clone = cloneDefaultQQBot();
    clone.enabled = true;
    clone.appId = "999999";
    assert.strictEqual(DEFAULT_QQ_BOT.enabled, false);
    assert.strictEqual(DEFAULT_QQ_BOT.appId, "");
  });
});

describe("qq-bot-settings: isValidQQAppId", () => {
  it("accepts 6-20 digit strings", () => {
    assert.ok(isValidQQAppId("123456"));
    assert.ok(isValidQQAppId("12345678901234567890"));
    assert.ok(isValidQQAppId("  123456  "));
  });

  it("rejects invalid inputs", () => {
    assert.ok(!isValidQQAppId(""));
    assert.ok(!isValidQQAppId("abc"));
    assert.ok(!isValidQQAppId("12345"));
    assert.ok(!isValidQQAppId(null));
    assert.ok(!isValidQQAppId(undefined));
  });
});

describe("qq-bot-settings: isValidQQOpenid", () => {
  it("accepts valid openid strings", () => {
    assert.ok(isValidQQOpenid("abc123"));
    assert.ok(isValidQQOpenid("A-B_C"));
  });

  it("rejects invalid inputs", () => {
    assert.ok(!isValidQQOpenid(""));
    assert.ok(!isValidQQOpenid(null));
    assert.ok(!isValidQQOpenid("a".repeat(65)));
  });
});

describe("qq-bot-settings: maskQQAppSecret", () => {
  it("masks long secrets", () => {
    const masked = maskQQAppSecret("abcdefghijklmnop");
    assert.strictEqual(masked, "abcd……mnop");
  });

  it("masks short secrets", () => {
    assert.strictEqual(maskQQAppSecret("abc"), "••••");
  });

  it("returns empty for empty input", () => {
    assert.strictEqual(maskQQAppSecret(""), "");
    assert.strictEqual(maskQQAppSecret(null), "");
  });
});

describe("qq-bot-settings: normalizeQQBot", () => {
  it("returns defaults for undefined/null input", () => {
    const a = normalizeQQBot(undefined);
    const b = normalizeQQBot(null);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.enabled, false);
    assert.strictEqual(a.approvalEnabled, true);
  });

  it("merges user values with defaults", () => {
    const result = normalizeQQBot({
      enabled: true,
      appId: "123456",
      appSecret: "mysecret123",
    });
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.appId, "123456");
    assert.strictEqual(result.appSecret, "mysecret123");
    assert.strictEqual(result.approvalEnabled, true);
    assert.strictEqual(result.approvalTimeoutMs, 300000);
  });

  it("rejects invalid appId", () => {
    const result = normalizeQQBot({ appId: "not-a-number" });
    assert.strictEqual(result.appId, "");
  });

  it("rejects invalid openid", () => {
    const result = normalizeQQBot({ userOpenid: "open with spaces" });
    assert.strictEqual(result.userOpenid, "");
  });

  it("clamps approvalTimeoutMs to max 600000", () => {
    const result = normalizeQQBot({ approvalTimeoutMs: 9999999 });
    assert.strictEqual(result.approvalTimeoutMs, 600000);
  });

  it("clamps minIntervalMs to min 1000", () => {
    const result = normalizeQQBot({ minIntervalMs: 100 });
    assert.strictEqual(result.minIntervalMs, 1000);
  });

  it("normalizes notifyStates to valid subset", () => {
    const result = normalizeQQBot({ notifyStates: ["attention", "invalid", "error"] });
    assert.deepStrictEqual(result.notifyStates, ["attention", "error"]);
  });

  it("falls back to defaults for empty notifyStates", () => {
    const result = normalizeQQBot({ notifyStates: [] });
    assert.deepStrictEqual(result.notifyStates, DEFAULT_QQ_BOT.notifyStates);
  });

  it("ignores unknown keys from user input", () => {
    const result = normalizeQQBot({ unknownKey: "value", enabled: true });
    assert.strictEqual(result.enabled, true);
    assert.strictEqual("unknownKey" in result, false);
  });
});

describe("qq-bot-settings: validateQQBot", () => {
  it("rejects non-objects", () => {
    assert.strictEqual(validateQQBot(null).status, "error");
    assert.strictEqual(validateQQBot("string").status, "error");
    assert.strictEqual(validateQQBot(42).status, "error");
  });

  it("rejects unknown keys", () => {
    assert.ok(validateQQBot({ foo: "bar" }).status === "error");
    assert.ok(validateQQBot({ foo: "bar" }).message.includes("foo"));
  });

  it("rejects non-boolean enabled", () => {
    assert.strictEqual(validateQQBot({ enabled: "yes" }).status, "error");
  });

  it("rejects non-string appId", () => {
    assert.strictEqual(validateQQBot({ appId: 123 }).status, "error");
  });

  it("rejects non-string appSecret", () => {
    assert.strictEqual(validateQQBot({ appSecret: 123 }).status, "error");
  });

  it("rejects non-string userOpenid", () => {
    assert.strictEqual(validateQQBot({ userOpenid: 123 }).status, "error");
  });

  it("rejects invalid approvalTimeoutMs", () => {
    assert.strictEqual(validateQQBot({ approvalTimeoutMs: -1 }).status, "error");
    assert.strictEqual(validateQQBot({ approvalTimeoutMs: "abc" }).status, "error");
  });

  it("rejects non-array notifyStates", () => {
    assert.strictEqual(validateQQBot({ notifyStates: "bad" }).status, "error");
  });

  it("rejects invalid minIntervalMs", () => {
    assert.strictEqual(validateQQBot({ minIntervalMs: -5 }).status, "error");
  });

  it("accepts valid input", () => {
    const result = validateQQBot({
      enabled: true,
      appId: "123456",
      appSecret: "secret",
      userOpenid: "openid123",
      approvalEnabled: true,
      approvalTimeoutMs: 300000,
      notifyStates: ["attention"],
      minIntervalMs: 5000,
    });
    assert.strictEqual(result.status, "ok");
  });

  it("accepts partial valid input", () => {
    assert.strictEqual(validateQQBot({ enabled: false }).status, "ok");
    assert.strictEqual(validateQQBot({ enabled: true, approvalEnabled: false }).status, "ok");
  });
});

describe("qq-bot-settings: readiness", () => {
  it("ready: false when disabled", () => {
    const r = readiness({ enabled: false });
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.reason, "disabled");
  });

  it("ready: false when missing appId", () => {
    const r = readiness({ enabled: true, appSecret: "s", userOpenid: "u" });
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.reason, "missing-appid");
  });

  it("ready: false when missing appSecret", () => {
    const r = readiness({ enabled: true, appId: "123456", userOpenid: "u" });
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.reason, "missing-secret");
  });

  it("ready: true even without userOpenid", () => {
    const r = readiness({ enabled: true, appId: "123456", appSecret: "s" });
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.reason, undefined);
  });

  it("ready: true when all fields present", () => {
    const r = readiness({
      enabled: true,
      appId: "123456",
      appSecret: "secret",
      userOpenid: "openid123",
    });
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.config.enabled, true);
  });

  it("returns normalized config in result", () => {
    const r = readiness({ enabled: true, appId: "123456", appSecret: "s", userOpenid: "u" });
    assert.ok(r.config);
    assert.strictEqual(typeof r.config.approvalTimeoutMs, "number");
  });
});
