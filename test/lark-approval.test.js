"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createLarkApprovalBridge,
  parseTextReply,
  generatePermId,
  generateShortCode,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} = require("../src/lark-approval");

describe("lark-approval: parseTextReply", () => {
  it("parses allow variants", () => {
    assert.deepStrictEqual(parseTextReply("y"), { behavior: "allow", code: "" });
    assert.deepStrictEqual(parseTextReply("yes"), { behavior: "allow", code: "" });
    assert.deepStrictEqual(parseTextReply("allow"), { behavior: "allow", code: "" });
    assert.deepStrictEqual(parseTextReply("ok"), { behavior: "allow", code: "" });
    assert.deepStrictEqual(parseTextReply("允许"), { behavior: "allow", code: "" });
  });

  it("parses deny variants", () => {
    assert.deepStrictEqual(parseTextReply("n"), { behavior: "deny", code: "" });
    assert.deepStrictEqual(parseTextReply("no"), { behavior: "deny", code: "" });
    assert.deepStrictEqual(parseTextReply("deny"), { behavior: "deny", code: "" });
    assert.deepStrictEqual(parseTextReply("拒绝"), { behavior: "deny", code: "" });
  });

  it("parses with short code", () => {
    assert.deepStrictEqual(parseTextReply("y AB12"), { behavior: "allow", code: "AB12" });
    assert.deepStrictEqual(parseTextReply("n XY34"), { behavior: "deny", code: "XY34" });
  });

  it("returns null for non-matching text", () => {
    assert.strictEqual(parseTextReply("hello"), null);
    assert.strictEqual(parseTextReply(""), null);
    assert.strictEqual(parseTextReply(null), null);
  });
});

describe("lark-approval: generatePermId", () => {
  it("generates unique IDs with lark_ prefix", () => {
    const id1 = generatePermId();
    const id2 = generatePermId();
    assert.ok(id1.startsWith("lark_"));
    assert.ok(id2.startsWith("lark_"));
    assert.notStrictEqual(id1, id2);
  });
});

describe("lark-approval: generateShortCode", () => {
  it("generates 4-character hex codes", () => {
    const code1 = generateShortCode();
    const code2 = generateShortCode();
    assert.strictEqual(code1.length, 4);
    assert.strictEqual(code2.length, 4);
    assert.ok(/^[A-F0-9]{4}$/.test(code1));
    assert.ok(/^[A-F0-9]{4}$/.test(code2));
  });
});

describe("lark-approval: createLarkApprovalBridge", () => {
  it("creates bridge with mock client", () => {
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: () => Promise.resolve(),
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    assert.ok(bridge);
    assert.strictEqual(typeof bridge.requestApproval, "function");
    assert.strictEqual(typeof bridge.cancelApproval, "function");
    assert.strictEqual(typeof bridge.handleCardCallback, "function");
    assert.strictEqual(typeof bridge.handleTextReply, "function");
  });

  it("requestApproval sends card and stores pending", () => {
    let sentCard = null;
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: (card) => { sentCard = card; return Promise.resolve(); },
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    const permEntry = {
      toolName: "Bash",
      agentName: "claude-code",
      cwd: "/home/user",
      toolInput: { command: "ls" },
    };
    let resolvedBehavior = null;
    const resolveFn = (entry, behavior) => { resolvedBehavior = behavior; };

    const result = bridge.requestApproval(permEntry, resolveFn);
    assert.strictEqual(result, true);
    assert.ok(sentCard);
    assert.ok(bridge.hasPending());
    assert.strictEqual(bridge.getPendingCount(), 1);
  });

  it("handleCardCallback resolves pending approval", () => {
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: () => Promise.resolve(),
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    const permEntry = { toolName: "Bash", agentName: "claude-code" };
    let resolvedBehavior = null;
    const resolveFn = (entry, behavior) => { resolvedBehavior = behavior; };

    bridge.requestApproval(permEntry, resolveFn);
    assert.strictEqual(bridge.getPendingCount(), 1);

    const pending = bridge._testGetPendingApprovals();
    const permId = pending.keys().next().value;
    const shortCode = pending.get(permId).shortCode;

    const resp = bridge.handleCardCallback({ permId, action: "allow", chatId: "oc_xxxxx" });
    assert.strictEqual(resolvedBehavior, "allow");
    assert.strictEqual(bridge.getPendingCount(), 0);
    // The tap toast names the short code so the user knows which one was acted on.
    assert.ok(resp && resp.toast && resp.toast.content.includes(shortCode));
  });

  it("handleTextReply resolves when single pending", () => {
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: () => Promise.resolve(),
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    const permEntry = { toolName: "Bash", agentName: "claude-code" };
    let resolvedBehavior = null;
    const resolveFn = (entry, behavior) => { resolvedBehavior = behavior; };

    bridge.requestApproval(permEntry, resolveFn);
    assert.strictEqual(bridge.getPendingCount(), 1);

    bridge.handleTextReply({ text: "y", chatId: "oc_xxxxx" });
    assert.strictEqual(resolvedBehavior, "allow");
    assert.strictEqual(bridge.getPendingCount(), 0);
  });

  it("handleTextReply with short code resolves specific request", () => {
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: () => Promise.resolve(),
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    const permEntry1 = { toolName: "Bash", agentName: "claude-code" };
    const permEntry2 = { toolName: "Write", agentName: "claude-code" };
    let resolved1 = null;
    let resolved2 = null;

    bridge.requestApproval(permEntry1, (e, b) => { resolved1 = b; });
    bridge.requestApproval(permEntry2, (e, b) => { resolved2 = b; });
    assert.strictEqual(bridge.getPendingCount(), 2);

    const pending = bridge._testGetPendingApprovals();
    const entries = Array.from(pending.values());
    const shortCode = entries[0].shortCode;

    bridge.handleTextReply({ text: `n ${shortCode}`, chatId: "oc_xxxxx" });
    assert.strictEqual(resolved1, "deny");
    assert.strictEqual(resolved2, null);
    assert.strictEqual(bridge.getPendingCount(), 1);
  });

  it("cancelApproval removes pending entry", () => {
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: () => Promise.resolve(),
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    const permEntry = { toolName: "Bash", agentName: "claude-code" };
    bridge.requestApproval(permEntry, () => {});
    assert.strictEqual(bridge.getPendingCount(), 1);

    const result = bridge.cancelApproval(permEntry);
    assert.strictEqual(result, true);
    assert.strictEqual(bridge.getPendingCount(), 0);
  });

  it("stop clears all pending approvals", () => {
    const mockClient = {
      isEnabled: () => true,
      sendCardMessage: () => Promise.resolve(),
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
    };

    const bridge = createLarkApprovalBridge(mockClient);
    bridge.requestApproval({ toolName: "Bash" }, () => {});
    bridge.requestApproval({ toolName: "Write" }, () => {});
    assert.strictEqual(bridge.getPendingCount(), 2);

    bridge.stop();
    assert.strictEqual(bridge.getPendingCount(), 0);
  });
});

describe("lark-approval: elicitation (multi-select)", () => {
  function elicClient() {
    const sent = [];
    return {
      sent,
      isEnabled: () => true,
      sendCardMessage: (card) => { sent.push(card); return Promise.resolve(); },
      buildApprovalCard: (payload) => ({ mock: true, payload }),
      buildConfirmationCard: (payload, behavior) => ({ mock: true, payload, behavior }),
      buildElicitationCard: (toolInput, permId, shortCode, selections, warn) => ({
        elic: true, permId, shortCode, selections: JSON.parse(JSON.stringify(selections || null)), warn: !!warn,
      }),
      buildCardUpdateResponse: (card) => ({ card: { type: "raw", data: card } }),
    };
  }

  const multiEntry = () => ({
    isElicitation: true,
    toolName: "AskUserQuestion",
    toolInput: { questions: [
      { question: "Pick langs", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    ] },
  });

  it("requestElicitation sends a card and stores a multi pending entry", () => {
    const client = elicClient();
    const bridge = createLarkApprovalBridge(client);
    const ok = bridge.requestElicitation(multiEntry(), () => {});
    assert.strictEqual(ok, true);
    assert.strictEqual(client.sent.length, 1);
    assert.strictEqual(client.sent[0].elic, true);
    const entry = bridge._testGetPendingApprovals().values().next().value;
    assert.strictEqual(entry.isElicitation, true);
    assert.strictEqual(entry.isElicitationMulti, true);
    assert.deepStrictEqual(entry.selections, [[]]);
  });

  it("toggle updates selections and returns an in-place card update", () => {
    const client = elicClient();
    const bridge = createLarkApprovalBridge(client);
    bridge.requestElicitation(multiEntry(), () => {});
    const permId = bridge._testGetPendingApprovals().keys().next().value;

    const r1 = bridge.handleCardCallback({ permId, action: "elicitation:0:0", chatId: "oc_1" });
    assert.ok(r1 && r1.card && r1.card.type === "raw", "toggle returns a card-update response");
    const r2 = bridge.handleCardCallback({ permId, action: "elicitation:0:2", chatId: "oc_1" });
    assert.deepStrictEqual(r2.card.data.selections, [[0, 2]]);
    assert.strictEqual(bridge.getPendingCount(), 1, "toggles do not resolve");
  });

  it("submit with all questions answered resolves with joined labels", () => {
    const client = elicClient();
    const bridge = createLarkApprovalBridge(client);
    let resolved = null;
    bridge.requestElicitation(multiEntry(), (entry, behavior) => { resolved = behavior; });
    const permId = bridge._testGetPendingApprovals().keys().next().value;

    bridge.handleCardCallback({ permId, action: "elicitation:0:0", chatId: "oc_1" });
    bridge.handleCardCallback({ permId, action: "elicitation:0:2", chatId: "oc_1" });
    const resp = bridge.handleCardCallback({ permId, action: "elicitation-submit", chatId: "oc_1" });

    assert.deepStrictEqual(resolved, { type: "elicitation-submit", answers: { "Pick langs": "A, C" } });
    assert.ok(resp && resp.toast, "submit returns a toast");
    assert.strictEqual(bridge.getPendingCount(), 0);
  });

  it("submit with an unanswered question re-renders with a warning, does not resolve", () => {
    const client = elicClient();
    const bridge = createLarkApprovalBridge(client);
    let resolved = null;
    bridge.requestElicitation(multiEntry(), (e, b) => { resolved = b; });
    const permId = bridge._testGetPendingApprovals().keys().next().value;

    const resp = bridge.handleCardCallback({ permId, action: "elicitation-submit", chatId: "oc_1" });
    assert.strictEqual(resolved, null);
    assert.strictEqual(resp.card.data.warn, true);
    assert.strictEqual(bridge.getPendingCount(), 1);
  });

  it("single-select click resolves immediately, deferring other questions", () => {
    const client = elicClient();
    const bridge = createLarkApprovalBridge(client);
    let resolved = null;
    const entry = {
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: { questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
        { question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
      ] },
    };
    bridge.requestElicitation(entry, (e, b) => { resolved = b; });
    const permId = bridge._testGetPendingApprovals().keys().next().value;

    bridge.handleCardCallback({ permId, action: "elicitation:0:1", chatId: "oc_1" });
    assert.deepStrictEqual(resolved, {
      type: "elicitation-submit",
      answers: { Q1: "B", Q2: "Defer to agent" },
    });
    assert.strictEqual(bridge.getPendingCount(), 0);
  });

  it("ignores elicitation interaction from a non-authorized sender", () => {
    const client = elicClient();
    const bridge = createLarkApprovalBridge(client, { getAuthorizedChatId: () => "oc_owner" });
    let resolved = null;
    bridge.requestElicitation(multiEntry(), (e, b) => { resolved = b; });
    const permId = bridge._testGetPendingApprovals().keys().next().value;

    const resp = bridge.handleCardCallback({ permId, action: "elicitation:0:0", chatId: "oc_intruder" });
    assert.strictEqual(resp, undefined);
    assert.strictEqual(resolved, null);
    assert.strictEqual(bridge.getPendingCount(), 1);
  });
});
