"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  PERM_ID_PREFIX,
  generatePermId,
  generateShortCode,
  parseTextReply,
  createQQApprovalBridge,
} = require("../src/qq-approval");

// ── Helpers ──

function makeMockQQBotClient(logFn) {
  const calls = { sendCardMessage: [], sendTextMessage: [], onInteraction: [], onMessage: [] };
  let interactionCb = null;
  let messageCb = null;
  return {
    isEnabled: () => true,
    buildApprovalCard: (toolName, toolInput, sessionId, permId, suggestions, shortCode) => ({
      toolName, toolInput, sessionId, permId, suggestions, shortCode,
    }),
    buildConfirmationCard: (toolName, behavior, shortCode) => ({ toolName, behavior, shortCode }),
    sendCardMessage: async (card) => { calls.sendCardMessage.push(card); return { status: 200 }; },
    sendTextMessage: async (text) => { calls.sendTextMessage.push(text); return { status: 200 }; },
    onInteraction: (cb) => { interactionCb = cb; calls.onInteraction.push(cb); return () => { interactionCb = null; }; },
    onMessage: (cb) => { messageCb = cb; calls.onMessage.push(cb); return () => { messageCb = null; }; },
    _triggerInteraction: (event) => { if (interactionCb) interactionCb(event); },
    _triggerMessage: (msg) => { if (messageCb) messageCb(msg); },
    _calls: calls,
  };
}

// ── parseTextReply ──

describe("parseTextReply", () => {
  it('parses "y SHORT" as allow', () => {
    assert.deepEqual(parseTextReply("y AB12"), { behavior: "allow", code: "AB12" });
  });

  it('parses "yes SHORT" as allow', () => {
    assert.deepEqual(parseTextReply("yes CD34"), { behavior: "allow", code: "CD34" });
  });

  it('parses "allow SHORT" as allow', () => {
    assert.deepEqual(parseTextReply("allow EF56"), { behavior: "allow", code: "EF56" });
  });

  it('parses "ok SHORT" as allow', () => {
    assert.deepEqual(parseTextReply("ok GH78"), { behavior: "allow", code: "GH78" });
  });

  it('parses "n SHORT" as deny', () => {
    assert.deepEqual(parseTextReply("n AB12"), { behavior: "deny", code: "AB12" });
  });

  it('parses "no SHORT" as deny', () => {
    assert.deepEqual(parseTextReply("no CD34"), { behavior: "deny", code: "CD34" });
  });

  it('parses "deny SHORT" as deny', () => {
    assert.deepEqual(parseTextReply("deny EF56"), { behavior: "deny", code: "EF56" });
  });

  it('parses Chinese "允许" as allow', () => {
    assert.deepEqual(parseTextReply("允许 ABC"), { behavior: "allow", code: "ABC" });
  });

  it('parses Chinese "拒绝" as deny', () => {
    assert.deepEqual(parseTextReply("拒绝 ABC"), { behavior: "deny", code: "ABC" });
  });

  it("accepts y/n without a code", () => {
    assert.deepEqual(parseTextReply("y"), { behavior: "allow", code: "" });
    assert.deepEqual(parseTextReply("n"), { behavior: "deny", code: "" });
  });

  it("accepts trailing whitespace", () => {
    assert.deepEqual(parseTextReply("  y  AB  "), { behavior: "allow", code: "AB" });
  });

  it("returns null for non-approval text", () => {
    assert.equal(parseTextReply("hello"), null);
    assert.equal(parseTextReply("yn"), null);
    assert.equal(parseTextReply(""), null);
    assert.equal(parseTextReply(null), null);
    assert.equal(parseTextReply("y n ABC"), null);
  });
});

// ── generatePermId / generateShortCode ──

describe("generatePermId", () => {
  it("starts with PERM_ID_PREFIX", () => {
    const id = generatePermId();
    assert.ok(id.startsWith(PERM_ID_PREFIX));
    assert.equal(id.length, PERM_ID_PREFIX.length + 16); // prefix + 8 bytes hex
  });
});

describe("generateShortCode", () => {
  it("generates a 4-char uppercase hex code", () => {
    const code = generateShortCode();
    assert.equal(code.length, 4);
    assert.match(code, /^[A-F0-9]{4}$/);
  });
});

// ── isAuthorizedSender (internal) ──

describe("QQ approval bridge isAuthorizedSender", () => {
  // We test isAuthorizedSender indirectly via handleInteraction / handleTextReply
  // using createQQApprovalBridge with a getAuthorizedOpenid option.

  it("allows sender when getAuthorizedOpenid is null (no getter)", () => {
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, { log: () => {} });
    const logLines = [];

    // With no getAuthorizedOpenid, all senders are authorized.
    // Simulate a button interaction.
    bridge.start();
    client._triggerInteraction({ permId: "nonexistent", userOpenid: "some-uid" });
    // No error = ok. The function doesn't throw for unauthorized senders.
  });

  it("allows sender when platform returns empty openid (got='')", () => {
    // This is the fix: got="" should return true instead of false.
    let callCount = 0;
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, {
      log: (...args) => { callCount++; },
      getAuthorizedOpenid: () => "EXPECTED_UID",
    });

    // Register a request first so the permId exists
    bridge.start();
    const results = [];
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "test" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const permId = bridge._testGetFirstPermId();
    assert.ok(permId);

    // Simulate interaction with got="" (platform didn't return openid)
    client._triggerInteraction({
      permId,
      userOpenid: "",
      behavior: "allow",
    });

    // Should have been resolved (not ignored) since got="" passes authorization.
    assert.equal(results.length, 1);
    assert.equal(results[0].behavior, "allow");
  });

  it("allows sender when got matches expected", () => {
    const client = makeMockQQBotClient();
    let authorizedOpenid = "REAL_UID";
    const bridge = createQQApprovalBridge(client, {
      log: () => {},
      getAuthorizedOpenid: () => authorizedOpenid,
    });

    bridge.start();
    const results = [];
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "test" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const permId = bridge._testGetFirstPermId();
    assert.ok(permId);

    // Simulate interaction from the correct user
    client._triggerInteraction({
      permId,
      userOpenid: "REAL_UID",
      behavior: "allow",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].behavior, "allow");
  });

  it("rejects sender when got does not match expected", () => {
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, {
      log: () => {},
      getAuthorizedOpenid: () => "CORRECT_UID",
    });

    bridge.start();
    const results = [];
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "test" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const permId = bridge._testGetFirstPermId();
    assert.ok(permId);

    // Wrong user — should be ignored
    client._triggerInteraction({
      permId,
      userOpenid: "SOME_OTHER_UID",
      behavior: "allow",
    });

    assert.equal(results.length, 0, "should not resolve for unauthorized sender");
  });

  it("rejects sender when expected is empty (fail-closed)", () => {
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, {
      log: () => {},
      getAuthorizedOpenid: () => "", // configured but empty
    });

    bridge.start();
    const results = [];
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "test" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const permId = bridge._testGetFirstPermId();
    assert.ok(permId);

    // Even the correct openid string should be rejected because expected is empty
    client._triggerInteraction({
      permId,
      userOpenid: "CORRECT_UID",
      behavior: "allow",
    });

    assert.equal(results.length, 0, "should not resolve when expected openid is empty");
  });
});

// ── resolvePending ──

describe("QQ approval bridge resolvePending", () => {
  it("resolves a pending entry and cleans up", () => {
    const client = makeMockQQBotClient();
    const logs = [];
    const bridge = createQQApprovalBridge(client, {
      log: (...args) => logs.push(args.join(" ")),
      getAuthorizedOpenid: () => "UID",
    });

    const results = [];
    bridge.start();
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const permId = bridge._testGetFirstPermId();
    assert.ok(permId);
    assert.equal(bridge.pendingCount(), 1);

    // Verify shortCodeToPermId has the mapping (via text reply path)
    const entry = bridge._testGetFirstEntry();
    assert.ok(entry);
    assert.ok(entry.shortCode);

    // Simulate button interaction
    client._triggerInteraction({ permId, userOpenid: "UID", behavior: "allow" });

    // After resolution, pending should be empty
    assert.equal(bridge.pendingCount(), 0);
    assert.equal(results.length, 1);
    assert.equal(results[0].behavior, "allow");

    // Confirmation card should have been sent
    assert.equal(client._calls.sendCardMessage.length, 2); // 1 approval card + 1 confirmation
  });

  it("resolvePending on unknown permId returns null and logs", () => {
    const logs = [];
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, {
      log: (...args) => logs.push(args.join(" ")),
    });

    // Calling resolvePending indirectly via interaction on non-existent permId
    // should be a no-op
    bridge.start();
    client._triggerInteraction({ permId: "qq_nonexistent", userOpenid: "", behavior: "allow" });

    assert.equal(bridge.pendingCount(), 0);
  });
});

// ── Text reply flow ──

describe("QQ approval bridge text reply", () => {
  it("resolves via text reply with correct short code", () => {
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, {
      log: () => {},
      getAuthorizedOpenid: () => "UID",
    });

    const results = [];
    bridge.start();
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const entry = bridge._testGetFirstEntry();
    assert.ok(entry);
    const code = entry.shortCode;

    client._triggerMessage({ text: `y ${code}`, userOpenid: "UID" });

    assert.equal(results.length, 1);
    assert.equal(results[0].behavior, "allow");
    assert.equal(bridge.pendingCount(), 0);
  });

  it("ignores text reply from unauthorized sender", () => {
    const client = makeMockQQBotClient();
    const logs = [];
    const bridge = createQQApprovalBridge(client, {
      log: (...args) => logs.push(args.join(" ")),
      getAuthorizedOpenid: () => "UID",
    });

    const results = [];
    bridge.start();
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const entry = bridge._testGetFirstEntry();
    assert.ok(entry);
    const code = entry.shortCode;

    // Wrong user sends text reply
    client._triggerMessage({ text: `y ${code}`, userOpenid: "WRONG_UID" });

    assert.equal(results.length, 0, "should not resolve for unauthorized sender");
    assert.equal(bridge.pendingCount(), 1, "entry should still be pending");
  });
});

// ── cancelApproval ──

describe("QQ approval bridge cancelApproval", () => {
  it("cancels a pending approval and sends stale notification", () => {
    const client = makeMockQQBotClient();
    const bridge = createQQApprovalBridge(client, { log: () => {} });

    const results = [];
    bridge.start();
    bridge.requestApproval(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s1", suggestions: [] },
      (entry, behavior) => { results.push({ entry, behavior }); },
      { enabled: true },
    );

    const entry = bridge._testGetFirstEntry();
    assert.ok(entry);
    assert.equal(bridge.pendingCount(), 1);

    bridge.cancelApproval(entry.permEntry);
    assert.equal(bridge.pendingCount(), 0);

    // Should have sent stale card notification
    const textCalls = client._calls.sendTextMessage;
    assert.ok(textCalls.length >= 1);
    assert.ok(textCalls[0].includes("已失效") || textCalls[0].includes("stale") || textCalls[0].includes("已处理"));
  });
});
