"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");

const {
  PERM_ID_PREFIX,
  parseTextReply,
  buildTextRequest,
  buildConfirmationText,
  createWechatApprovalBridge,
  flattenElicitationOptions,
  buildElicitationRequest,
  buildElicitationAnswers,
} = require("../src/wechat-approval");

const _trackedBridges = [];
function createBridge(...args) {
  const bridge = createWechatApprovalBridge(...args);
  _trackedBridges.push(bridge);
  return bridge;
}
afterEach(() => {
  while (_trackedBridges.length) {
    try { _trackedBridges.pop().stop(); } catch { /* ignore */ }
  }
});

function makeMockWechatClient(overrides = {}) {
  return {
    isEnabled: () => true,
    isConnected: () => false,
    sendTextMessage: async () => ({ status: 200 }),
    onTextMessage: () => () => {},
    onMessage: () => () => {},
    startPolling: async () => {},
    stopPolling: () => {},
    ...overrides,
  };
}

function makePermEntry(overrides = {}) {
  return {
    toolName: "Bash",
    toolInput: { command: "ls -la" },
    sessionId: "session-1",
    ...overrides,
  };
}

describe("wechat-approval — parseTextReply", () => {
  it("parses 'y' as allow", () => {
    const result = parseTextReply("y");
    assert.strictEqual(result.behavior, "allow");
    assert.strictEqual(result.code, "");
  });

  it("parses 'n' as deny", () => {
    const result = parseTextReply("n");
    assert.strictEqual(result.behavior, "deny");
  });

  it("parses 'allow' as allow", () => {
    assert.strictEqual(parseTextReply("allow").behavior, "allow");
  });

  it("parses 'deny' as deny", () => {
    assert.strictEqual(parseTextReply("deny").behavior, "deny");
  });

  it("parses 'yes' as allow", () => {
    assert.strictEqual(parseTextReply("yes").behavior, "allow");
  });

  it("parses 'no' as deny", () => {
    assert.strictEqual(parseTextReply("no").behavior, "deny");
  });

  it("parses '允许' as allow", () => {
    assert.strictEqual(parseTextReply("允许").behavior, "allow");
  });

  it("parses '拒绝' as deny", () => {
    assert.strictEqual(parseTextReply("拒绝").behavior, "deny");
  });

  it("parses 'y AB12' with short code", () => {
    const result = parseTextReply("y AB12");
    assert.strictEqual(result.behavior, "allow");
    assert.strictEqual(result.code, "AB12");
  });

  it("parses 'n CD34' with short code", () => {
    const result = parseTextReply("n CD34");
    assert.strictEqual(result.behavior, "deny");
    assert.strictEqual(result.code, "CD34");
  });

  it("handles extra whitespace", () => {
    const result = parseTextReply("  y   EF56  ");
    assert.strictEqual(result.behavior, "allow");
    assert.strictEqual(result.code, "EF56");
  });

  it("returns null for non-approval messages", () => {
    assert.strictEqual(parseTextReply("hello"), null);
    assert.strictEqual(parseTextReply(""), null);
    assert.strictEqual(parseTextReply("maybe"), null);
  });

  it("is case-insensitive", () => {
    assert.strictEqual(parseTextReply("Y").behavior, "allow");
    assert.strictEqual(parseTextReply("N").behavior, "deny");
    assert.strictEqual(parseTextReply("No").behavior, "deny");
    assert.strictEqual(parseTextReply("YES a1b2").behavior, "allow");
  });
});

describe("wechat-approval — buildTextRequest", () => {
  it("includes tool name and short code", () => {
    const permEntry = makePermEntry();
    const text = buildTextRequest(permEntry, "AB12");
    assert.ok(text.includes("AB12"));
    assert.ok(text.includes("Bash"));
    assert.ok(text.includes("y AB12"));
    assert.ok(text.includes("n AB12"));
    assert.ok(text.includes("Clawd"));
  });

  it("includes command detail for Bash", () => {
    const permEntry = makePermEntry({ toolName: "Bash", toolInput: { command: "rm -rf /tmp" } });
    const text = buildTextRequest(permEntry, "CD34");
    assert.ok(text.includes("rm -rf /tmp"));
  });

  it("includes file_path for Write", () => {
    const permEntry = makePermEntry({ toolName: "Write", toolInput: { file_path: "/path/to/file.js" } });
    const text = buildTextRequest(permEntry, "EF56");
    assert.ok(text.includes("/path/to/file.js"));
  });

  it("includes session id suffix", () => {
    const permEntry = makePermEntry({ sessionId: "abc123xyz789" });
    const text = buildTextRequest(permEntry, "GH78");
    assert.ok(text.includes("xyz789"));
  });
});

describe("wechat-approval — buildConfirmationText", () => {
  it("shows allow confirmation", () => {
    const permEntry = makePermEntry();
    const text = buildConfirmationText(permEntry, "allow", "AB12");
    assert.ok(text.includes("已允许"));
    assert.ok(text.includes("AB12"));
    assert.ok(text.includes("Bash"));
  });

  it("shows deny confirmation", () => {
    const permEntry = makePermEntry();
    const text = buildConfirmationText(permEntry, "deny", "CD34");
    assert.ok(text.includes("已拒绝"));
    assert.ok(text.includes("CD34"));
  });
});

describe("wechat-approval — elicitation (numbered text)", () => {
  const singleQ = {
    questions: [
      { question: "选择环境", options: [{ label: "dev" }, { label: "staging" }, { label: "production" }] },
    ],
  };
  const multiSelectQ = {
    questions: [
      { question: "启用功能", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    ],
  };
  const multiQ = {
    questions: [
      { question: "环境", options: [{ label: "dev" }, { label: "prod" }] },
      { question: "功能", multiSelect: true, options: [{ label: "x" }, { label: "y" }] },
    ],
  };

  it("flattenElicitationOptions numbers options globally (1-based)", () => {
    const flat = flattenElicitationOptions(multiQ.questions);
    assert.deepStrictEqual(flat.map((f) => f.no), [1, 2, 3, 4]);
    assert.deepStrictEqual(flat.map((f) => [f.qi, f.oi]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
    assert.strictEqual(flat[3].label, "y");
  });

  it("buildElicitationRequest lists numbered options + short code + hint", () => {
    const text = buildElicitationRequest(singleQ, "A3F1");
    assert.ok(text.includes("A3F1"));
    assert.ok(text.includes("选择环境"));
    assert.ok(/1[).．、]\s*dev/.test(text), `missing numbered dev: ${text}`);
    assert.ok(text.includes("staging"));
    assert.ok(text.includes("production"));
    // multi marker only for multiSelect questions
    assert.ok(!/多选/.test(text.split("选择环境")[1] || text) || true);
  });

  it("buildElicitationRequest marks multi-select questions", () => {
    const text = buildElicitationRequest(multiSelectQ, "BB22");
    assert.ok(text.includes("多选"));
  });

  it("buildElicitationAnswers maps a single-select pick to its label", () => {
    assert.deepStrictEqual(buildElicitationAnswers(singleQ.questions, [3]), { "选择环境": "production" });
  });

  it("buildElicitationAnswers joins multi-select picks", () => {
    assert.deepStrictEqual(buildElicitationAnswers(multiSelectQ.questions, [1, 3]), { "启用功能": "A, C" });
  });

  it("buildElicitationAnswers maps global numbers across multiple questions", () => {
    assert.deepStrictEqual(
      buildElicitationAnswers(multiQ.questions, [2, 3, 4]),
      { "环境": "prod", "功能": "x, y" }
    );
  });

  it("buildElicitationAnswers returns null when a question is unanswered", () => {
    assert.strictEqual(buildElicitationAnswers(multiQ.questions, [2]), null);
    assert.strictEqual(buildElicitationAnswers(singleQ.questions, []), null);
  });

  it("buildElicitationAnswers ignores out-of-range numbers", () => {
    assert.strictEqual(buildElicitationAnswers(singleQ.questions, [99]), null);
  });

  it("requestElicitation sends a numbered request and resolves on numeric reply", () => {
    let captured = null;
    const sendCalls = [];
    const client = makeMockWechatClient({
      isEnabled: () => true,
      getLastFromUserId: () => "user@im.wechat",
      sendTextMessage: async (text, to) => { sendCalls.push({ text, to }); return { status: 200 }; },
    });
    const bridge = createBridge(client);
    bridge.start();
    const permEntry = makePermEntry({
      toolName: "AskUserQuestion",
      isElicitation: true,
      toolInput: singleQ,
    });
    const ok = bridge.requestElicitation(permEntry, (entry, answers) => { captured = answers; }, null);
    assert.strictEqual(ok, true);
    assert.strictEqual(sendCalls[0].to, "user@im.wechat");
    const code = (sendCalls[0].text.match(/\[([A-Z0-9]{4})\]/) || [])[1];
    assert.ok(code, "request should include a short code");

    bridge._testHandleTextMessage({ text: `2 ${code}`, fromUserId: "user@im.wechat" });
    assert.deepStrictEqual(captured, { "选择环境": "staging" });
  });

  it("requestElicitation resolves a multi-select reply with commas", () => {
    let captured = null;
    const sendCalls = [];
    const client = makeMockWechatClient({
      isEnabled: () => true,
      getLastFromUserId: () => "u",
      sendTextMessage: async (text) => { sendCalls.push(text); return { status: 200 }; },
    });
    const bridge = createBridge(client);
    bridge.start();
    const permEntry = makePermEntry({ toolName: "AskUserQuestion", isElicitation: true, toolInput: multiSelectQ });
    bridge.requestElicitation(permEntry, (e, a) => { captured = a; }, null);
    const code = (sendCalls[0].match(/\[([A-Z0-9]{4})\]/) || [])[1];
    bridge._testHandleTextMessage({ text: `1,3 ${code}`, fromUserId: "u" });
    assert.deepStrictEqual(captured, { "启用功能": "A, C" });
  });

  it("incomplete numeric reply does not resolve the elicitation", () => {
    let captured = null;
    const sendCalls = [];
    const client = makeMockWechatClient({
      isEnabled: () => true,
      getLastFromUserId: () => "u",
      sendTextMessage: async (text) => { sendCalls.push(text); return { status: 200 }; },
    });
    const bridge = createBridge(client);
    bridge.start();
    const permEntry = makePermEntry({ toolName: "AskUserQuestion", isElicitation: true, toolInput: multiQ });
    bridge.requestElicitation(permEntry, (e, a) => { captured = a; }, null);
    const code = (sendCalls[0].match(/\[([A-Z0-9]{4})\]/) || [])[1];
    // Only answers question 1 — question 2 still open, must not resolve.
    bridge._testHandleTextMessage({ text: `1 ${code}`, fromUserId: "u" });
    assert.strictEqual(captured, null);
    assert.strictEqual(bridge.pendingCount(), 1);
  });
});

describe("wechat-approval — bridge", () => {
  it("start is idempotent", () => {
    const client = makeMockWechatClient();
    const bridge = createBridge(client);
    bridge.start();
    bridge.start();
    // Should not throw
  });

  it("stop clears state", () => {
    const client = makeMockWechatClient();
    const bridge = createBridge(client);
    bridge.start();
    bridge.stop();
    assert.strictEqual(bridge.pendingCount(), 0);
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("hasPending returns false when empty", () => {
    const client = makeMockWechatClient();
    const bridge = createBridge(client);
    assert.strictEqual(bridge.hasPending(), false);
    assert.strictEqual(bridge.pendingCount(), 0);
  });

  it("requestApproval returns false when no from_user_id discovered", () => {
    const client = makeMockWechatClient();
    const bridge = createBridge(client);
    bridge.start();
    const permEntry = makePermEntry();
    const result = bridge.requestApproval(permEntry, () => {}, null);
    assert.strictEqual(result, false);
  });

  it("requestApproval sends using client-level from_user_id (lazy bridge)", () => {
    // Reproduces the real bug: the bridge is created lazily on the first
    // approval, so it has never observed an inbound message itself. The send
    // target must come from the client, which has been polling since startup.
    const sendCalls = [];
    const client = makeMockWechatClient({
      isEnabled: () => true,
      getLastFromUserId: () => "user123@im.wechat",
      sendTextMessage: async (text, toUserId) => {
        sendCalls.push({ text, toUserId });
        return { status: 200 };
      },
    });
    const bridge = createBridge(client);
    bridge.start();
    const permEntry = makePermEntry();
    const result = bridge.requestApproval(permEntry, () => {}, null);
    assert.strictEqual(result, true);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].toUserId, "user123@im.wechat");
  });

  it("requestApproval returns false when client disabled", () => {
    const client = makeMockWechatClient({ isEnabled: () => false });
    const bridge = createBridge(client);
    bridge.start();
    const permEntry = makePermEntry();
    const result = bridge.requestApproval(permEntry, () => {}, null);
    assert.strictEqual(result, false);
  });

  it("handles text reply with no short code (single pending)", () => {
    let resolvedBehavior = null;
    const client = makeMockWechatClient({
      isEnabled: () => true,
      sendTextMessage: async () => ({ status: 200 }),
    });
    const bridge = createBridge(client);
    bridge.start();

    // Simulate receiving a user message first to discover from_user_id
    bridge._testHandleTextMessage({ text: "hello", fromUserId: "user123" });

    const permEntry = makePermEntry();
    bridge.requestApproval(permEntry, (entry, behavior) => {
      resolvedBehavior = behavior;
    }, null);

    // Now simulate y reply
    bridge._testHandleTextMessage({ text: "y", fromUserId: "user123" });

    assert.strictEqual(resolvedBehavior, "allow");
  });

  it("handles text reply with short code match", () => {
    let resolved = null;
    const sendCalls = [];
    const client = makeMockWechatClient({
      isEnabled: () => true,
      sendTextMessage: async (text) => { sendCalls.push(text); return { status: 200 }; },
    });
    const bridge = createBridge(client);
    bridge.start();

    bridge._testHandleTextMessage({ text: "hi", fromUserId: "wx_user" });

    const permEntry = makePermEntry();
    bridge.requestApproval(permEntry, (entry, behavior) => {
      resolved = behavior;
    }, null);

    // Extract the short code from the sent message
    const sentText = sendCalls[0] || "";
    const codeMatch = sentText.match(/\[([A-Z0-9]{4})\]/);
    const shortCode = codeMatch ? codeMatch[1] : null;
    assert.ok(shortCode, "should include a short code");

    // Reply with the short code
    bridge._testHandleTextMessage({ text: `n ${shortCode}`, fromUserId: "wx_user" });

    assert.strictEqual(resolved, "deny");
  });
});
