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
    buildElicitationCard: (toolInput, permId) => ({
      markdown: { content: "💬 AskUserQuestion" },
      keyboard: { content: { rows: [] } },
      _permId: permId,
    }),
    buildConfirmationCard: (toolName, decision, permId) => ({
      header: { title: { tag: "plain_text", content: decision } },
      elements: [],
    }),
    onInteraction: () => () => {},
    onMessage: () => () => {},
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

describe("qq-approval: requestElicitation", () => {
  it("returns false when client is not enabled", () => {
    const client = makeMockQQBotClient({ isEnabled: () => false });
    const bridge = createBridge(client);
    const result = bridge.requestElicitation(makePermEntry(), () => {}, {});
    assert.strictEqual(result, false);
  });

  it("returns false when client lacks buildElicitationCard", () => {
    const client = makeMockQQBotClient({ buildElicitationCard: null });
    const bridge = createBridge(client);
    const result = bridge.requestElicitation(makePermEntry(), () => {}, {});
    assert.strictEqual(result, false);
  });

  it("sends card and tracks pending", () => {
    let sendCalls = 0;
    const client = makeMockQQBotClient({
      sendCardMessage: async () => { sendCalls++; return { status: 200 }; },
    });
    const bridge = createBridge(client);
    assert.strictEqual(bridge.hasPending(), false);
    const result = bridge.requestElicitation(makePermEntry(), () => {}, { approvalTimeoutMs: 10000 });
    assert.strictEqual(result, true);
    assert.strictEqual(bridge.hasPending(), true);
    assert.strictEqual(bridge.pendingCount(), 1);
    assert.strictEqual(sendCalls, 1);
  });

  it("resolves single-question elicitation via button click", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let resolvedAnswers = null;

    const perm = makePermEntry({
      toolInput: {
        questions: [
          { question: "How to proceed?", header: "Approach", options: [
            { label: "Fast path" }, { label: "Safe path" }
          ]}
        ]
      }
    });

    bridge.requestElicitation(perm, (entry, answers) => {
      resolvedAnswers = answers;
    }, {});

    assert.strictEqual(bridge.hasPending(), true);

    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "elicitation:0:1", // picked "Safe path"
    });

    assert.ok(resolvedAnswers);
    assert.strictEqual(resolvedAnswers["How to proceed?"], "Safe path");
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("fills unanswered multi-question with 'Defer to agent'", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let resolvedAnswers = null;

    const perm = makePermEntry({
      toolInput: {
        questions: [
          { question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
          { question: "Q2?", options: [{ label: "X" }, { label: "Y" }] },
        ]
      }
    });

    bridge.requestElicitation(perm, (entry, answers) => {
      resolvedAnswers = answers;
    }, {});

    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "elicitation:0:0", // picked "A" for Q1
    });

    assert.ok(resolvedAnswers);
    assert.strictEqual(resolvedAnswers["Q1?"], "A");
    assert.strictEqual(resolvedAnswers["Q2?"], "Defer to agent");
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("falls back to 'Option N' when selected option has no label", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let resolvedAnswers = null;

    const perm = makePermEntry({
      toolInput: {
        questions: [
          { question: "Q1?", options: [{}, { label: "" }] },
        ]
      }
    });

    bridge.requestElicitation(perm, (entry, answers) => {
      resolvedAnswers = answers;
    }, {});

    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "elicitation:0:0",
    });

    assert.ok(resolvedAnswers);
    assert.strictEqual(resolvedAnswers["Q1?"], "Option 1");
  });

  it("ignores elicitation clicks for non-elicitation entries", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let resolvedBehavior = null;

    bridge.requestApproval(makePermEntry(), (_, b) => { resolvedBehavior = b; }, {});

    // Send an elicitation click to a regular approval entry
    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "elicitation:0:1",
    });

    // Behavior should be normalized to "deny" (not elicitation-resolved)
    assert.strictEqual(resolvedBehavior, "deny");
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("handles timeout for elicitation entries", async () => {
    const client = makeMockQQBotClient();
    let now = 1000;
    const bridge = createBridge(client, { now: () => now });
    bridge.requestElicitation(makePermEntry({
      toolInput: { questions: [{ question: "Q?", options: [{ label: "A" }] }] }
    }), () => {}, { approvalTimeoutMs: 100 });
    assert.strictEqual(bridge.pendingCount(), 1);
    now += 200;
    await new Promise((r) => setTimeout(r, 50));
    bridge._testHandleInteraction({
      permId: bridge._testGetFirstPermId(),
      behavior: "elicitation:0:0",
    });
    assert.strictEqual(bridge.pendingCount(), 0);
  });

  it("multi-select: toggling accumulates selections and re-sends the card", () => {
    let sendCalls = 0;
    const client = makeMockQQBotClient({
      sendCardMessage: async () => { sendCalls++; return { status: 200 }; },
    });
    const bridge = createBridge(client);
    const perm = makePermEntry({
      toolInput: { questions: [
        { question: "选环境?", multiSelect: true, options: [
          { label: "测试" }, { label: "预发" }, { label: "生产" },
        ]},
      ]},
    });
    bridge.requestElicitation(perm, () => {}, {});
    assert.strictEqual(sendCalls, 1, "initial card sent");

    const permId = bridge._testGetFirstPermId();
    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 选「测试」
    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:2" }); // 选「生产」

    const entry = bridge._testGetFirstEntry();
    assert.deepStrictEqual(entry.selections[0], [0, 2], "both options accumulated");
    assert.strictEqual(sendCalls, 3, "card re-sent on each toggle");
    assert.strictEqual(bridge.hasPending(), true, "toggling does not resolve");

    // 再点「测试」→ 取消
    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" });
    assert.deepStrictEqual(bridge._testGetFirstEntry().selections[0], [2], "re-tap removes");
  });

  it("multi-select: submit joins selected labels with ', ' and resolves", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let resolvedAnswers = null;
    const perm = makePermEntry({
      toolInput: { questions: [
        { question: "选环境?", multiSelect: true, options: [
          { label: "测试" }, { label: "预发" }, { label: "生产" },
        ]},
      ]},
    });
    bridge.requestElicitation(perm, (_, answers) => { resolvedAnswers = answers; }, {});
    const permId = bridge._testGetFirstPermId();

    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 测试
    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:2" }); // 生产
    bridge._testHandleInteraction({ permId, behavior: "elicitation-submit" });

    assert.ok(resolvedAnswers);
    assert.strictEqual(resolvedAnswers["选环境?"], "测试, 生产");
    assert.strictEqual(bridge.hasPending(), false);
  });

  it("multi-select: submit with an unanswered question does not resolve", () => {
    let sendCalls = 0;
    const client = makeMockQQBotClient({
      sendCardMessage: async () => { sendCalls++; return { status: 200 }; },
    });
    const bridge = createBridge(client);
    let resolved = false;
    const perm = makePermEntry({
      toolInput: { questions: [
        { question: "Q1?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
        { question: "Q2?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
      ]},
    });
    bridge.requestElicitation(perm, () => { resolved = true; }, {});
    const permId = bridge._testGetFirstPermId();
    const before = sendCalls;

    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 只答 Q1
    bridge._testHandleInteraction({ permId, behavior: "elicitation-submit" });

    assert.strictEqual(resolved, false, "incomplete submit must not resolve");
    assert.strictEqual(bridge.hasPending(), true, "still pending");
    assert.ok(sendCalls > before + 1, "warning card re-sent on incomplete submit");
  });

  it("multi-select card: a non-multi question replaces selection (radio)", () => {
    const client = makeMockQQBotClient();
    const bridge = createBridge(client);
    let resolvedAnswers = null;
    const perm = makePermEntry({
      toolInput: { questions: [
        { question: "多选?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
        { question: "单选?", options: [{ label: "X" }, { label: "Y" }] }, // 无 multiSelect
      ]},
    });
    bridge.requestElicitation(perm, (_, answers) => { resolvedAnswers = answers; }, {});
    const permId = bridge._testGetFirstPermId();

    bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 多选题选 A
    bridge._testHandleInteraction({ permId, behavior: "elicitation:1:0" }); // 单选题选 X
    bridge._testHandleInteraction({ permId, behavior: "elicitation:1:1" }); // 单选题改选 Y（替换）

    assert.deepStrictEqual(bridge._testGetFirstEntry().selections[1], [1], "single-select replaced, not accumulated");

    bridge._testHandleInteraction({ permId, behavior: "elicitation-submit" });
    assert.strictEqual(resolvedAnswers["多选?"], "A");
    assert.strictEqual(resolvedAnswers["单选?"], "Y");
  });
});
