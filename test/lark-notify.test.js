"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { STATE_LABELS, createLarkNotifier } = require("../src/lark-notify");

describe("lark-notify: STATE_LABELS", () => {
  it("contains all expected states", () => {
    assert.ok(STATE_LABELS.idle);
    assert.ok(STATE_LABELS.working);
    assert.ok(STATE_LABELS.thinking);
    assert.ok(STATE_LABELS.attention);
    assert.ok(STATE_LABELS.error);
    assert.ok(STATE_LABELS.notification);
    assert.ok(STATE_LABELS.sleeping);
  });
});

describe("lark-notify: createLarkNotifier", () => {
  it("creates notifier with mock client", () => {
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient);
    assert.ok(notifier);
    assert.strictEqual(typeof notifier.notifyStateChange, "function");
    assert.strictEqual(typeof notifier.shouldNotify, "function");
  });

  it("shouldNotify returns false when client is disabled", () => {
    const mockClient = {
      isEnabled: () => false,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };
    assert.strictEqual(notifier.shouldNotify("agent1", "attention", config), false);
  });

  it("shouldNotify returns false when config is disabled", () => {
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: false, notifyStates: ["attention"], minIntervalMs: 5000 };
    assert.strictEqual(notifier.shouldNotify("agent1", "attention", config), false);
  });

  it("shouldNotify returns false for non-notifiable states", () => {
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };
    assert.strictEqual(notifier.shouldNotify("agent1", "idle", config), false);
  });

  it("shouldNotify returns true for notifiable states", () => {
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };
    assert.strictEqual(notifier.shouldNotify("agent1", "attention", config), true);
  });

  it("shouldNotify throttles repeated notifications", () => {
    let now = 1000;
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient, { now: () => now });
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };

    assert.strictEqual(notifier.shouldNotify("agent1", "attention", config), true);
    assert.strictEqual(notifier.shouldNotify("agent1", "attention", config), false);

    now += 5001;
    assert.strictEqual(notifier.shouldNotify("agent1", "attention", config), true);
  });

  it("notifyStateChange sends message when should notify", async () => {
    let sentText = null;
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: (text) => { sentText = text; return Promise.resolve(); },
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };

    await notifier.notifyStateChange("claude-code", "attention", "session123", config);
    assert.ok(sentText);
    assert.ok(sentText.includes("claude-code"));
    assert.ok(sentText.includes("Attention"));
    assert.ok(sentText.includes("123"));
  });

  it("notifyStateChange does not send when should not notify", async () => {
    let sentText = null;
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: (text) => { sentText = text; return Promise.resolve(); },
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };

    await notifier.notifyStateChange("claude-code", "idle", "session123", config);
    assert.strictEqual(sentText, null);
  });

  it("pruneStale removes old entries", () => {
    let now = 1000;
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient, { now: () => now });
    const config = { enabled: true, notifyStates: ["attention"], minIntervalMs: 5000 };

    notifier.shouldNotify("agent1", "attention", config);
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 1);

    now += 600001;
    notifier.pruneStale(600000);
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 0);
  });

  it("reset clears all entries", () => {
    const mockClient = {
      isEnabled: () => true,
      sendTextMessage: () => Promise.resolve(),
    };

    const notifier = createLarkNotifier(mockClient);
    const config = { enabled: true, notifyStates: ["attention", "error"], minIntervalMs: 5000 };

    notifier.shouldNotify("agent1", "attention", config);
    notifier.shouldNotify("agent2", "error", config);
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 2);

    notifier.reset();
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 0);
  });
});
