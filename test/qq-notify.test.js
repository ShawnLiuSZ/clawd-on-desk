"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { STATE_LABELS, createQQNotifier } = require("../src/qq-notify");

function makeMockQQBotClient(overrides = {}) {
  const calls = [];
  return {
    isEnabled: () => true,
    sendTextMessage: async (text) => { calls.push(text); return { status: 200 }; },
    ...overrides,
    _calls: calls,
  };
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    notifyStates: ["attention", "error"],
    minIntervalMs: 5000,
    ...overrides,
  };
}

describe("qq-notify: STATE_LABELS", () => {
  it("has labels for core states", () => {
    assert.ok(STATE_LABELS.idle);
    assert.ok(STATE_LABELS.working);
    assert.ok(STATE_LABELS.thinking);
    assert.ok(STATE_LABELS.attention);
    assert.ok(STATE_LABELS.error);
    assert.ok(STATE_LABELS.sleeping);
  });
});

describe("qq-notify: shouldNotify", () => {
  it("returns false when client is not enabled", () => {
    const client = makeMockQQBotClient({ isEnabled: () => false });
    const notifier = createQQNotifier(client);
    assert.strictEqual(notifier.shouldNotify("claude", "attention", makeConfig()), false);
  });

  it("returns false when config is disabled", () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    assert.strictEqual(notifier.shouldNotify("claude", "attention", { enabled: false }), false);
  });

  it("returns false when state is not in notifyStates", () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    assert.strictEqual(notifier.shouldNotify("claude", "working", makeConfig()), false);
  });

  it("returns true for allowed states", () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    assert.strictEqual(notifier.shouldNotify("claude", "attention", makeConfig()), true);
    assert.strictEqual(notifier.shouldNotify("claude", "error", makeConfig()), true);
  });

  it("throttles within minIntervalMs", () => {
    let now = 1000;
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client, { now: () => now });
    assert.strictEqual(notifier.shouldNotify("claude", "attention", makeConfig()), true);
    now += 2000;
    assert.strictEqual(notifier.shouldNotify("claude", "attention", makeConfig()), false);
  });

  it("allows after minIntervalMs passes", () => {
    let now = 1000;
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client, { now: () => now });
    assert.strictEqual(notifier.shouldNotify("claude", "attention", makeConfig()), true);
    now += 6000;
    assert.strictEqual(notifier.shouldNotify("claude", "attention", makeConfig()), true);
  });

  it("tracks different agents independently", () => {
    let now = 1000;
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client, { now: () => now });
    assert.strictEqual(notifier.shouldNotify("claude", "error", makeConfig()), true);
    assert.strictEqual(notifier.shouldNotify("codex", "error", makeConfig()), true);
  });
});

describe("qq-notify: notifyStateChange", () => {
  it("sends message when shouldNotify passes", async () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    await notifier.notifyStateChange("Claude Code", "attention", "session-abc", makeConfig());
    assert.strictEqual(client._calls.length, 1);
    assert.ok(client._calls[0].includes("Claude Code"));
    assert.ok(client._calls[0].includes("Attention"));
  });

  it("does not send when shouldNotify fails", async () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    await notifier.notifyStateChange("Claude Code", "working", "s1", makeConfig());
    assert.strictEqual(client._calls.length, 0);
  });

  it("does not throw when client.sendTextMessage fails", async () => {
    const client = makeMockQQBotClient({
      sendTextMessage: async () => { throw new Error("network"); },
    });
    const notifier = createQQNotifier(client);
    await notifier.notifyStateChange("Claude Code", "error", "s1", makeConfig());
    assert.strictEqual(client._calls.length, 0);
  });

  it("formats message with session ID", async () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    await notifier.notifyStateChange("Codex", "error", "sess-xyz", makeConfig());
    assert.ok(client._calls[0].includes("Codex"));
    assert.ok(client._calls[0].includes("xyz"));
  });
});

describe("qq-notify: pruneStale", () => {
  it("removes old entries", () => {
    let now = 1000;
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client, { now: () => now });
    notifier.shouldNotify("claude", "error", makeConfig());
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 1);
    now += 700000;
    notifier.pruneStale(600000);
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 0);
  });
});

describe("qq-notify: reset", () => {
  it("clears all state", () => {
    const client = makeMockQQBotClient();
    const notifier = createQQNotifier(client);
    notifier.shouldNotify("claude", "error", makeConfig());
    notifier.shouldNotify("codex", "attention", makeConfig());
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 2);
    notifier.reset();
    assert.strictEqual(notifier._testGetLastNotifiedSize(), 0);
  });
});
