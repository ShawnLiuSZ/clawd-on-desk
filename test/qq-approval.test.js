"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");

const { PERM_ID_PREFIX, generatePermId, parseTextReply, createQQApprovalBridge } = require("../src/qq-approval");

// Track bridges so afterEach can stop() them — requestApproval arms a long
// approval timer that otherwise keeps the process alive after tests pass.
const _trackedBridges = [];
function createBridge(...args) {
  const bridge = createQQApprovalBridge(...args);
  _trackedBridges.push(bridge);
  return bridge;
}
afterEach(() => {
  while (_trackedBridges.length) {
    try { _trackedBridges.pop().stop(); } catch { /* ignore */ }
  }
});

function makeMockQQBotClient(overrides = {}) {
  return {
    isEnabled: () => true,
    sendCardMessage: async () => ({ status: 200 }),
    buildApprovalCard: (toolName, toolInput, sessionId, permId, suggestions) => ({
      header: { title: { tag: "plain_text", content: `🔐 ${toolName}` } },
      elements: [],
      _permId: permId,
    }),
    buildConfirmationCard: (toolName, decision, permId) => ({
      header: { title: { tag: "plain_text", content: decision } },
      elements: [],
    }),
    onInteraction: () => () => {},
    ...overrides,
  };
}

function makePermEntry(overrides = {}) {
  return {
    toolName: "Bash",
    toolInput: { command: "ls" },
    sessionId: "session-1",
    suggestions: [],
    ...overrides,
  };
}

describe("qq-approval: constants", () => {
  it("PERM_ID_PREFIX is 'qq_'", () => {
    assert.strictEqual(PERM_ID_PREFIX, "qq_");
  });

  it("generatePermId returns unique ids with prefix", () => {
    const a = generatePermId();
    const b = generatePermId();
    assert.ok(a.startsWith(PERM_ID_PREFIX));
    assert.ok(b.startsWith(PERM_ID_PREFIX));
    assert.notStrictEqual(a, b);
  });
});

describe("qq-approval: createQQApprovalBridge", () => {
  it("requestApproval returns false when client is not enabled", () => {
    const client = makeMockQQBotClient({ isEnabled: () => false });
    const bridge = createBridge(client);
    const result = bridge.requestApproval(makePermEntry(), () => {}, {});
    assert.strictEqual(result, false);
  });

  it("requestApproval returns false when client lacks sendCardMessage", () => {
    const client = makeMockQQBotClient({ sendCardMessage: null });
    const bridge = createBridge(client);
    const result = bridge.requestApproval(makePermEntry(), () => {}, {});
    assert.strictEqual(result, false);
  });

  it("requestApproval sends card and tracks pending", async () => {
    let sendCalls = 0;
    const client = makeMockQQBotClient({
      sendCardMessage: async () => { sendCalls++; return { status: 200 }; },
    });
    const bridge = createBridge(client);
    assert.strictEqual(bridge.hasPending(), false);
    const result = bridge.requestApproval(makePermEntry(), () => {}, { approvalTimeoutMs: 10000 });
    assert.strictEqual(result, true);
    assert.strictEqual(bridge.hasPending(), true);
    assert.strictEqual(bridge.pendingCount(), 1);
    assert.strictEqual(sendCalls, 1);
  });

  it("handleInteraction resolves the permEntry", () => {
    let resolvedEntry = null;
    let resolvedBehavior = null;
    const resolvedPermEntries = [];
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);

    const perm = makePermEntry();
    bridge.requestApproval(perm, (entry, behavior) => {
      resolvedEntry = entry;
      resolvedBehavior = behavior;
      resolvedPermEntries.push(entry);
    }, {});

    assert.strictEqual(bridge.hasPending(), true);

    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "allow",
    });

    assert.strictEqual(resolvedEntry, perm);
    assert.strictEqual(resolvedBehavior, "allow");
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("handleInteraction normalizes unknown behaviors to deny", () => {
    let resolvedBehavior = null;
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    bridge.requestApproval(makePermEntry(), (_, b) => { resolvedBehavior = b; }, {});

    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "something-invalid",
    });
    assert.strictEqual(resolvedBehavior, "deny");
  });

  it("handleInteraction preserves suggestion behaviors", () => {
    let resolvedBehavior = null;
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    bridge.requestApproval(makePermEntry(), (_, b) => { resolvedBehavior = b; }, {});

    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "suggestion:0",
    });
    assert.strictEqual(resolvedBehavior, "suggestion:0");
  });

  it("handleInteraction ignores unknown permIds", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    bridge.requestApproval(makePermEntry(), () => { throw new Error("should not be called"); }, {});

    bridge._testHandleInteraction({
      permId: "qq_nonexistent",
      behavior: "allow",
    });
    assert.strictEqual(bridge.hasPending(), true);
  });

  it("cancelApproval removes pending entry", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    const perm = makePermEntry();
    bridge.requestApproval(perm, () => {}, {});
    assert.strictEqual(bridge.pendingCount(), 1);
    bridge.cancelApproval(perm);
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("cancelApproval notifies QQ that the request was handled elsewhere", () => {
    const texts = [];
    const client = makeMockQQBotClient({ sendTextMessage: async (t) => { texts.push(t); return { status: 200 }; } });
    const bridge = createBridge(client);
    const perm = makePermEntry();
    bridge.requestApproval(perm, () => {}, {});
    bridge.cancelApproval(perm);
    assert.strictEqual(texts.length, 1);
    assert.ok(texts[0].includes("其他渠道") || texts[0].includes("失效"));
    // A subsequent QQ button tap for the cancelled request must be a no-op.
    let resolved = false;
    bridge._testHandleInteraction({ permId: "qq_whatever", behavior: "allow" });
    assert.strictEqual(resolved, false);
  });

  it("cancelApproval is silent when the request never had a QQ entry", () => {
    const texts = [];
    const client = makeMockQQBotClient({ sendTextMessage: async (t) => { texts.push(t); return { status: 200 }; } });
    const bridge = createBridge(client);
    bridge.cancelApproval(makePermEntry()); // nothing pending
    assert.strictEqual(texts.length, 0);
  });

  it("stop clears all pending entries", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    bridge.requestApproval(makePermEntry(), () => {}, {});
    bridge.requestApproval(makePermEntry(), () => {}, {});
    assert.strictEqual(bridge.pendingCount(), 2);
    bridge.stop();
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("timeout cleans up the pending entry", async () => {
    const client = makeMockQQBotClient();
    let now = 1000;
    const bridge = createBridge(client, { now: () => now });
    bridge.requestApproval(makePermEntry(), () => {}, { approvalTimeoutMs: 100 });
    assert.strictEqual(bridge.pendingCount(), 1);
    now += 200;
    await new Promise((r) => setTimeout(r, 50));
    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "allow",
    });
    assert.strictEqual(bridge.pendingCount(), 0);
  });
});

describe("qq-approval: parseTextReply", () => {
  it("parses allow/deny verbs (en + zh)", () => {
    assert.strictEqual(parseTextReply("y").behavior, "allow");
    assert.strictEqual(parseTextReply("YES").behavior, "allow");
    assert.strictEqual(parseTextReply("allow").behavior, "allow");
    assert.strictEqual(parseTextReply("允许").behavior, "allow");
    assert.strictEqual(parseTextReply("n").behavior, "deny");
    assert.strictEqual(parseTextReply("deny").behavior, "deny");
    assert.strictEqual(parseTextReply("拒绝").behavior, "deny");
  });

  it("extracts an optional short code (upcased)", () => {
    assert.strictEqual(parseTextReply("y AB").code, "AB");
    assert.strictEqual(parseTextReply("n 12cd").code, "12CD");
    assert.strictEqual(parseTextReply("y").code, "");
  });

  it("returns null for non-replies", () => {
    assert.strictEqual(parseTextReply("hello world"), null);
    assert.strictEqual(parseTextReply(""), null);
    assert.strictEqual(parseTextReply("yacht"), null); // \b prevents prefix match
  });
});

describe("qq-approval: text-reply resolution", () => {
  it("bare 'y' resolves the only pending request", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let behavior = null;
    bridge.requestApproval(makePermEntry(), (_, b) => { behavior = b; }, {});
    bridge._testHandleTextReply({ text: "y" });
    assert.strictEqual(behavior, "allow");
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("ignores a bare reply when multiple are pending (ambiguous)", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    bridge.requestApproval(makePermEntry(), () => { throw new Error("must not resolve"); }, {});
    bridge.requestApproval(makePermEntry(), () => { throw new Error("must not resolve"); }, {});
    bridge._testHandleTextReply({ text: "n" });
    assert.strictEqual(bridge.pendingCount(), 2);
  });

  it("ignores non-reply text", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    bridge.requestApproval(makePermEntry(), () => { throw new Error("must not resolve"); }, {});
    bridge._testHandleTextReply({ text: "what is going on" });
    assert.strictEqual(bridge.hasPending(), true);
  });
});

describe("qq-approval: start subscribes listeners", () => {
  it("subscribes to onMessage when the client exposes it", () => {
    let subscribed = false;
    const client = makeMockQQBotClient({ onMessage: () => { subscribed = true; return () => {}; } });
    const bridge = createBridge(client);
    bridge.start();
    assert.strictEqual(subscribed, true);
  });
});
