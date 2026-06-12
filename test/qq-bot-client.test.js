"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");

const { createQQBotClient, compactLog, DEFAULT_INTENTS } = require("../src/qq-bot-client");

function makeMockHttpPost(responses = []) {
  let callIndex = 0;
  const calls = [];
  const fn = async (url, body, options) => {
    calls.push({ url, body, options });
    const resp = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return resp || { status: 200, body: { access_token: "mock-token", expires_in: 7200 } };
  };
  fn.calls = calls;
  return fn;
}

function makeMockHttpPut() {
  const calls = [];
  const fn = async (url, body, options) => { calls.push({ url, body, options }); return { status: 200, body: {} }; };
  fn.calls = calls;
  return fn;
}

function makeConfig(overrides = {}) {
  return {
    appId: "123456",
    appSecret: "test-secret",
    userOpenid: "openid-abc",
    ...overrides,
  };
}

describe("qq-bot-client: compactLog", () => {
  it("truncates long strings", () => {
    const result = compactLog("a".repeat(300), 50);
    assert.ok(result.length <= 50);
    assert.ok(result.includes("…"));
  });

  it("redacts Bearer tokens", () => {
    const result = compactLog("Bearer abcdefghijklmnop1234567890");
    assert.ok(!result.includes("abcdefghijkl"));
    assert.ok(result.includes("<redacted>"));
  });

  it("handles null/undefined", () => {
    assert.strictEqual(compactLog(null), "");
    assert.strictEqual(compactLog(undefined), "");
  });
});

describe("qq-bot-client: createQQBotClient", () => {
  it("isConfigured returns true when all fields present", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    assert.strictEqual(client.isConfigured(), true);
  });

  it("isConfigured returns false when missing fields", () => {
    const client = createQQBotClient(makeConfig({ appId: "" }), { httpPost: makeMockHttpPost() });
    assert.strictEqual(client.isConfigured(), false);
  });

  it("isEnabled delegates to isConfigured", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    assert.strictEqual(client.isEnabled(), true);
    const client2 = createQQBotClient(makeConfig({ appId: "" }), { httpPost: makeMockHttpPost() });
    assert.strictEqual(client2.isEnabled(), false);
  });

  it("updateConfig changes values", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    assert.strictEqual(client.isConfigured(), true);
    client.updateConfig({ appId: "" });
    assert.strictEqual(client.isConfigured(), false);
    client.updateConfig({ appId: "999999" });
    assert.strictEqual(client.isConfigured(), true);
  });
});

describe("qq-bot-client: getToken", () => {
  it("fetches and caches token", async () => {
    const mockPost = makeMockHttpPost([
      { status: 200, body: { access_token: "token-abc", expires_in: 7200 } },
    ]);
    const client = createQQBotClient(makeConfig(), {
      httpPost: mockPost,
      now: () => 1000,
    });
    const token = await client.getToken();
    assert.strictEqual(token, "token-abc");
    assert.strictEqual(mockPost.calls.length, 1);
    assert.ok(mockPost.calls[0].url.includes("getAppAccessToken"));
  });

  it("reuses cached token within TTL", async () => {
    const mockPost = makeMockHttpPost([
      { status: 200, body: { access_token: "token-cached", expires_in: 7200 } },
    ]);
    let now = 1000;
    const client = createQQBotClient(makeConfig(), {
      httpPost: mockPost,
      now: () => now,
    });
    await client.getToken();
    now += 1000;
    await client.getToken();
    assert.strictEqual(mockPost.calls.length, 1);
  });

  it("refreshes token when expired", async () => {
    const mockPost = makeMockHttpPost([
      { status: 200, body: { access_token: "token-old", expires_in: 7200 } },
      { status: 200, body: { access_token: "token-new", expires_in: 7200 } },
    ]);
    let now = 1000;
    const client = createQQBotClient(makeConfig(), {
      httpPost: mockPost,
      now: () => now,
    });
    await client.getToken();
    now += 7200 * 1000;
    const token = await client.getToken();
    assert.strictEqual(token, "token-new");
    assert.strictEqual(mockPost.calls.length, 2);
  });

  it("throws on fetch failure", async () => {
    const mockPost = makeMockHttpPost([{ status: 500, body: {} }]);
    const client = createQQBotClient(makeConfig(), {
      httpPost: mockPost,
      now: () => 1000,
    });
    await assert.rejects(() => client.getToken(), /token fetch failed/i);
  });
});

describe("qq-bot-client: sendTextMessage", () => {
  it("sends text message via C2C API", async () => {
    const mockPost = makeMockHttpPost([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 200, body: { id: "msg-1" } },
    ]);
    const client = createQQBotClient(makeConfig(), { httpPost: mockPost });
    await client.sendTextMessage("Hello QQ");
    assert.strictEqual(mockPost.calls.length, 2);
    const sendCall = mockPost.calls[1];
    assert.ok(sendCall.url.includes("/v2/users/openid-abc/messages"));
    assert.strictEqual(sendCall.body.msg_type, 0);
    assert.strictEqual(sendCall.body.content, "Hello QQ");
    assert.ok(sendCall.options.headers.Authorization.startsWith("QQBot "));
  });

  it("truncates messages over 2000 chars", async () => {
    const mockPost = makeMockHttpPost([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 200, body: { id: "msg-1" } },
    ]);
    const client = createQQBotClient(makeConfig(), { httpPost: mockPost });
    await client.sendTextMessage("x".repeat(3000));
    const content = mockPost.calls[1].body.content;
    assert.ok(content.length <= 2000);
  });
});

describe("qq-bot-client: sendCardMessage", () => {
  it("sends a markdown+keyboard message with msg_type=2", async () => {
    const mockPost = makeMockHttpPost([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 200, body: { id: "msg-2" } },
    ]);
    const client = createQQBotClient(makeConfig(), { httpPost: mockPost });
    const card = { markdown: { content: "hello" }, keyboard: { content: { rows: [] } } };
    await client.sendCardMessage(card);
    assert.strictEqual(mockPost.calls[1].body.msg_type, 2);
    assert.deepStrictEqual(mockPost.calls[1].body.markdown, { content: "hello" });
    assert.ok(mockPost.calls[1].body.keyboard);
    // QQ has no Feishu "card" field — must not leak one.
    assert.strictEqual(mockPost.calls[1].body.card, undefined);
  });
});

describe("qq-bot-client: buildApprovalCard", () => {
  it("returns a QQ markdown+keyboard structure with callback buttons", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildApprovalCard("Bash", { command: "ls -la" }, "session-123", "qq_perm1", [
      { label: "Allow with sudo" },
    ], "AB");
    assert.ok(card.markdown && typeof card.markdown.content === "string");
    assert.ok(card.markdown.content.includes("Bash"));
    assert.ok(card.markdown.content.includes("AB")); // text-reply short code hint
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    assert.ok(buttons.length >= 3);
    assert.strictEqual(buttons[0].action.type, 1); // callback
    assert.strictEqual(buttons[0].action.data, "qq_perm1|allow");
    assert.strictEqual(buttons[1].action.data, "qq_perm1|deny");
    assert.ok(buttons[2].action.data.startsWith("qq_perm1|suggestion:"));
  });

  it("handles missing tool input gracefully", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildApprovalCard(null, null, null, "qq_perm2", []);
    assert.ok(card.markdown.content);
    assert.ok(card.keyboard.content.rows.length >= 1);
  });

  it("shows Edit old/new content + full path, not just a filename", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildApprovalCard(
      "Edit",
      { file_path: "/Users/dev/proj/src/app.js", old_string: "const a = 1", new_string: "const a = 2" },
      "s", "qq_e", []
    );
    const c = card.markdown.content;
    assert.ok(c.includes("/Users/dev/proj/src/app.js")); // full path
    assert.ok(c.includes("const a = 1")); // old
    assert.ok(c.includes("const a = 2")); // new
  });

  it("truncates very long edit content with an ellipsis", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const big = "x".repeat(5000);
    const card = client.buildApprovalCard("Write", { file_path: "/a/b.txt", content: big }, "s", "qq_w", []);
    assert.ok(card.markdown.content.includes("…"));
    assert.ok(card.markdown.content.length <= 1800);
  });

  it("shows MultiEdit edit count and first edit", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildApprovalCard(
      "MultiEdit",
      { file_path: "/a/b.js", edits: [{ old_string: "foo", new_string: "bar" }, { old_string: "x", new_string: "y" }] },
      "s", "qq_m", []
    );
    const c = card.markdown.content;
    assert.ok(c.includes("**Edits**: 2"));
    assert.ok(c.includes("foo") && c.includes("bar"));
  });

  it("limits to 5 buttons per row", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const suggestions = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];
    const card = client.buildApprovalCard("Read", {}, "s1", "qq_perm3", suggestions);
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    assert.ok(buttons.length <= 5); // allow + deny + 3 suggestions
    for (const row of card.keyboard.content.rows) {
      assert.ok(row.buttons.length <= 5);
    }
  });

  it("labels addRules suggestions without a label field", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const suggestions = [
      { type: "addRules", behavior: "allow", toolName: "Bash" },
      { type: "addRules", behavior: "deny", toolName: "Write" },
      { type: "setMode", mode: "acceptEdits" },
    ];
    const card = client.buildApprovalCard("Bash", {}, "s1", "qq_p", suggestions);
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    const labels = buttons.map((b) => b.render_data && b.render_data.label).filter(Boolean);
    // Should generate "Always Bash" / "Always deny Write" / "Auto edits"
    assert.ok(labels.some((l) => l.includes("Always Bash")));
    assert.ok(labels.some((l) => l.includes("Always deny Write")));
    assert.ok(labels.some((l) => l.includes("Auto edits")));
  });

  it("falls back to 'Suggestion N' for unrecognized suggestion shapes", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const suggestions = [{ type: "unknown", foo: "bar" }];
    const card = client.buildApprovalCard("Bash", {}, "s1", "qq_p", suggestions);
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    const labels = buttons.map((b) => b.render_data && b.render_data.label).filter(Boolean);
    assert.ok(labels.some((l) => l.includes("Suggestion 1")));
  });
});

describe("qq-bot-client: buildConfirmationCard", () => {
  it("returns markdown for allow", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildConfirmationCard("Bash", "allow", "p1");
    assert.ok(card.markdown.content.includes("Allowed"));
    assert.strictEqual(card.keyboard, undefined); // no buttons on confirmation
  });

  it("returns markdown for deny", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildConfirmationCard("Bash", "deny", "p1");
    assert.ok(card.markdown.content.includes("Denied"));
  });
});

describe("qq-bot-client: buildElicitationCard", () => {
  it("builds a card with question text and option buttons", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const toolInput = {
      questions: [
        { question: "Pick one", header: "Choice", options: [
          { label: "Option A" }, { label: "Option B" }
        ]}
      ]
    };
    const card = client.buildElicitationCard(toolInput, "qq_e1", "AB");
    assert.ok(card.markdown.content.includes("AskUserQuestion"));
    assert.ok(card.markdown.content.includes("Pick one"));
    assert.ok(card.markdown.content.includes("Choice"));
    assert.ok(card.markdown.content.includes("AB")); // short code hint

    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    assert.strictEqual(buttons.length, 2); // 2 options
    assert.strictEqual(buttons[0].action.data, "qq_e1|elicitation:0:0");
    assert.strictEqual(buttons[1].action.data, "qq_e1|elicitation:0:1");
    assert.ok(buttons[0].render_data.label.includes("Option A"));
    assert.ok(buttons[1].render_data.label.includes("Option B"));
  });

  it("handles empty questions gracefully", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const card = client.buildElicitationCard({ questions: [] }, "qq_e2", "");
    assert.ok(card.markdown.content);
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    assert.strictEqual(buttons.length, 0);
  });

  it("limits to 5 options per question", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const options = Array.from({ length: 8 }, (_, i) => ({ label: `Opt ${i + 1}` }));
    const card = client.buildElicitationCard(
      { questions: [{ question: "Q?", options }] },
      "qq_e3", ""
    );
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    assert.ok(buttons.length <= 5);
  });

  it("supports up to 3 questions with distinct suggestion indices", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const toolInput = {
      questions: [
        { question: "Q1?", options: [{ label: "A1" }] },
        { question: "Q2?", options: [{ label: "A2" }] },
        { question: "Q3?", options: [{ label: "A3" }, { label: "B3" }] },
        { question: "Q4?", options: [{ label: "A4" }] }, // should be capped at 3
      ]
    };
    const card = client.buildElicitationCard(toolInput, "qq_e4", "");
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    // Q1:1 + Q2:1 + Q3:2 = 4 buttons
    assert.strictEqual(buttons.length, 4);
    assert.strictEqual(buttons[0].action.data, "qq_e4|elicitation:0:0");
    assert.strictEqual(buttons[1].action.data, "qq_e4|elicitation:1:0");
    assert.strictEqual(buttons[2].action.data, "qq_e4|elicitation:2:0");
    assert.strictEqual(buttons[3].action.data, "qq_e4|elicitation:2:1");
  });

  it("multi-select: marks selected options and adds a submit button", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const toolInput = {
      questions: [
        { header: "部署", question: "选哪些环境?", multiSelect: true, options: [
          { label: "测试" }, { label: "预发" }, { label: "生产" },
        ]},
      ],
    };
    // selections[0] = [0, 2] → 选中「测试」「生产」
    const card = client.buildElicitationCard(toolInput, "qq_p", "AB", [[0, 2]]);
    const md = card.markdown.content;
    assert.ok(md.includes("✓ 测试"), "selected option marked with ✓");
    assert.ok(md.includes("▢ 预发"), "unselected option marked with ▢");
    assert.ok(md.includes("✓ 生产"), "selected option marked with ✓");

    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    const submit = buttons.find((b) => b.action.data === "qq_p|elicitation-submit");
    assert.ok(submit, "submit button exists with elicitation-submit behavior");
    assert.ok(submit.render_data.label.includes("已选 2"), "submit label shows selected count");
    // option buttons keep elicitation:<qi>:<oi> encoding
    assert.ok(buttons.some((b) => b.action.data === "qq_p|elicitation:0:0"));
  });

  it("non-multi elicitation keeps the immediate-select card (no submit button)", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const toolInput = { questions: [
      { question: "选一个", options: [{ label: "A" }, { label: "B" }] },
    ]};
    const card = client.buildElicitationCard(toolInput, "qq_p", "AB");
    const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
    assert.ok(!buttons.some((b) => b.action.data === "qq_p|elicitation-submit"),
      "single-select card has no submit button");
    assert.ok(!card.markdown.content.includes("▢"), "single-select card has no checkbox glyphs");
  });
});

describe("qq-bot-client: interaction listener", () => {
  function qqEvent(buttonData) {
    return {
      id: "evt-1",
      type: 11, // QQ inline-keyboard click
      chat_type: 2,
      data: { resolved: { button_id: "1", button_data: buttonData, user_id: "openid-xyz" } },
    };
  }
  // httpPut is injected so the interaction ACK doesn't hit the network.
  function makeClient() {
    return createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost(), httpPut: makeMockHttpPut() });
  }

  it("receives events and dispatches to listeners", () => {
    const client = makeClient();
    const received = [];
    client.onInteraction((event) => received.push(event));
    client._testHandleInteraction(qqEvent("qq_test1|allow"));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].permId, "qq_test1");
    assert.strictEqual(received[0].behavior, "allow");
    assert.strictEqual(received[0].userOpenid, "openid-xyz");
  });

  it("parses suggestion behaviors with colons", () => {
    const client = makeClient();
    const received = [];
    client.onInteraction((event) => received.push(event));
    client._testHandleInteraction(qqEvent("qq_t2|suggestion:1"));
    assert.strictEqual(received[0].permId, "qq_t2");
    assert.strictEqual(received[0].behavior, "suggestion:1");
  });

  it("acks the interaction so the QQ client doesn't show 请求超时", async () => {
    const mockPut = makeMockHttpPut();
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost(), httpPut: mockPut });
    client._testHandleInteraction(qqEvent("qq_t3|allow"));
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget ack flush
    assert.strictEqual(mockPut.calls.length, 1);
    assert.ok(mockPut.calls[0].url.includes("/interactions/evt-1"));
    assert.strictEqual(mockPut.calls[0].body.code, 0);
    assert.ok(mockPut.calls[0].options.headers.Authorization.startsWith("QQBot "));
  });

  it("ignores events without button_data", () => {
    const client = makeClient();
    const received = [];
    client.onInteraction((event) => received.push(event));
    client._testHandleInteraction({ type: 11, data: { resolved: {} } });
    assert.strictEqual(received.length, 0);
  });

  it("ignores non-button events (type != 11)", () => {
    const client = makeClient();
    const received = [];
    client.onInteraction((event) => received.push(event));
    client._testHandleInteraction({ type: 2, data: { resolved: { button_data: "qq_p1|allow" } } });
    assert.strictEqual(received.length, 0);
  });

  it("unsubscribe stops delivery", () => {
    const client = makeClient();
    const received = [];
    const unsub = client.onInteraction((event) => received.push(event));
    client._testHandleInteraction(qqEvent("qq_p1|allow"));
    assert.strictEqual(received.length, 1);
    unsub();
    client._testHandleInteraction(qqEvent("qq_p2|deny"));
    assert.strictEqual(received.length, 1);
  });
});

describe("qq-bot-client: formatToolInput", () => {
  it("formats Bash command", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const result = client._testFormatToolInput("Bash", { command: "npm test" });
    assert.strictEqual(result, "npm test");
  });

  it("formats file path for Read", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const result = client._testFormatToolInput("Read", { file_path: "/Users/dev/project/src/main.js" });
    assert.strictEqual(result, "/Users/dev/project/src/main.js");
  });

  it("returns empty for null input", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    assert.strictEqual(client._testFormatToolInput("Bash", null), "");
    assert.strictEqual(client._testFormatToolInput("Bash", {}), "");
  });
});

describe("qq-bot-client: DEFAULT_INTENTS", () => {
  const INTENT_GROUP_AND_C2C = 1 << 25;
  const INTENT_INTERACTION = 1 << 26;
  const INTENT_GUILD_MESSAGES = 1 << 9;
  const INTENT_DIRECT_MESSAGE = 1 << 12;

  // QQ docs: passing intents the bot is NOT authorized for makes the gateway
  // error and close the WS immediately. A C2C/group bot only has access to
  // GROUP_AND_C2C_EVENT + INTERACTION; GUILD_MESSAGES (private-domain only) and
  // DIRECT_MESSAGE require separate approval and break the identify if included.
  it("subscribes to C2C + INTERACTION only", () => {
    assert.strictEqual(DEFAULT_INTENTS, INTENT_GROUP_AND_C2C | INTENT_INTERACTION);
  });

  it("does NOT include guild/direct-message intents that break C2C bots", () => {
    assert.strictEqual(DEFAULT_INTENTS & INTENT_GUILD_MESSAGES, 0);
    assert.strictEqual(DEFAULT_INTENTS & INTENT_DIRECT_MESSAGE, 0);
  });
});

describe("qq-bot-client: message listener (text-reply fallback)", () => {
  it("fires onMessage with text + openid for C2C messages", () => {
    const client = createQQBotClient(makeConfig({ userOpenid: "" }), { httpPost: makeMockHttpPost() });
    const received = [];
    client.onMessage((m) => received.push(m));
    client._testHandleC2CMessage({
      content: "y AB",
      author: { user_openid: "openid-123" },
    });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].text, "y AB");
    assert.strictEqual(received[0].userOpenid, "openid-123");
  });

  it("does not fire for empty content", () => {
    const client = createQQBotClient(makeConfig(), { httpPost: makeMockHttpPost() });
    const received = [];
    client.onMessage((m) => received.push(m));
    client._testHandleC2CMessage({ author: { user_openid: "openid-123" } });
    assert.strictEqual(received.length, 0);
  });
});
