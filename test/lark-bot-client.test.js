"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createLarkBotClient,
  compactLog,
  REGION_FEISHU,
  REGION_LARK,
  getEndpoints,
} = require("../src/lark-bot-client");

describe("lark-bot-client: compactLog", () => {
  it("truncates long messages", () => {
    const long = "a".repeat(300);
    const result = compactLog(long, 100);
    assert.ok(result.length <= 100);
    assert.ok(result.endsWith("…"));
  });

  it("handles null/undefined", () => {
    assert.strictEqual(compactLog(null), "");
    assert.strictEqual(compactLog(undefined), "");
  });

  it("preserves short messages", () => {
    assert.strictEqual(compactLog("hello"), "hello");
  });
});

describe("lark-bot-client: getEndpoints", () => {
  it("returns Feishu endpoints for feishu region", () => {
    const endpoints = getEndpoints(REGION_FEISHU);
    assert.ok(endpoints.tokenUrl.includes("open.feishu.cn"));
    assert.ok(endpoints.apiBase.includes("open.feishu.cn"));
  });

  it("returns Lark endpoints for lark region", () => {
    const endpoints = getEndpoints(REGION_LARK);
    assert.ok(endpoints.tokenUrl.includes("open.larksuite.com"));
    assert.ok(endpoints.apiBase.includes("open.larksuite.com"));
  });

  it("defaults to Feishu for unknown region", () => {
    const endpoints = getEndpoints("unknown");
    assert.ok(endpoints.tokenUrl.includes("open.feishu.cn"));
    assert.ok(endpoints.apiBase.includes("open.feishu.cn"));
  });
});

describe("lark-bot-client: createLarkBotClient", () => {
  it("creates client with config", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    });
    assert.ok(client);
    assert.strictEqual(client.isEnabled(), true);
    assert.strictEqual(client.getChatId(), "oc_xxxxx");
    assert.strictEqual(client.getRegion(), REGION_FEISHU);
  });

  it("creates client with Lark region", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
      region: "lark",
    });
    assert.ok(client);
    assert.strictEqual(client.isEnabled(), true);
    assert.strictEqual(client.getRegion(), REGION_LARK);
  });

  it("is not enabled when config is incomplete", () => {
    const client = createLarkBotClient({ appId: "cli_xxxxx" });
    assert.strictEqual(client.isEnabled(), false);
  });

  it("updateConfig updates client config", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    });
    assert.strictEqual(client.isEnabled(), true);

    client.updateConfig({ chatId: "oc_new" });
    assert.strictEqual(client.getChatId(), "oc_new");
  });

  it("updateConfig updates region", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
      region: "feishu",
    });
    assert.strictEqual(client.getRegion(), REGION_FEISHU);

    client.updateConfig({ region: "lark" });
    assert.strictEqual(client.getRegion(), REGION_LARK);
  });

  it("buildApprovalCard creates valid card structure", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    }, { getLang: () => "en" });

    const card = client.buildApprovalCard({
      permId: "lark_test123",
      shortCode: "AB12",
      toolName: "Bash",
      agentName: "claude-code",
      cwd: "/home/user/project",
      summary: "rm -rf /tmp/test",
    });

    assert.ok(card.config.wide_screen_mode);
    assert.ok(card.header.title.content.includes("Bash"));
    assert.strictEqual(card.header.template, "red");
    assert.ok(card.elements.length >= 3);

    const actionElement = card.elements.find(e => e.tag === "action");
    assert.ok(actionElement);
    assert.strictEqual(actionElement.actions.length, 2);
    assert.strictEqual(actionElement.actions[0].value.action, "allow");
    assert.strictEqual(actionElement.actions[1].value.action, "deny");
    assert.strictEqual(actionElement.actions[0].value.permId, "lark_test123");

    const noteElement = card.elements.find(e => e.tag === "note");
    assert.ok(noteElement);
    assert.ok(noteElement.elements[0].content.includes("AB12"));
  });

  it("buildConfirmationCard creates valid card structure", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    }, { getLang: () => "en" });

    const card = client.buildConfirmationCard({
      toolName: "Bash",
      agentName: "claude-code",
      shortCode: "AB12",
    }, "allow");

    assert.ok(card.config.wide_screen_mode);
    assert.ok(card.header.title.content.includes("已允许"));
    // Short code in the title lets the user tell which request was acted on.
    assert.ok(card.header.title.content.includes("AB12"));
    assert.strictEqual(card.header.template, "green");
  });

  it("buildConfirmationCard creates deny card", () => {
    const client = createLarkBotClient({
      appId: "cli_xxxxx",
      appSecret: "secret123",
      chatId: "oc_xxxxx",
    }, { getLang: () => "en" });

    const card = client.buildConfirmationCard({
      toolName: "Bash",
      agentName: "claude-code",
    }, "deny");

    assert.ok(card.header.title.content.includes("已拒绝"));
    assert.strictEqual(card.header.template, "red");
  });
});

describe("lark-bot-client: buildElicitationCard", () => {
  const mk = () => createLarkBotClient(
    { appId: "cli_xxxxx", appSecret: "secret123", chatId: "oc_xxxxx" },
    { getLang: () => "en" }
  );

  it("multi-select: ✓/▢ option buttons + submit, encoded values", () => {
    const client = mk();
    const toolInput = { questions: [
      { question: "Pick langs", header: "Langs", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
    ] };
    const card = client.buildElicitationCard(toolInput, "lark_1", "AB12", [[1]], false);

    const actionEls = card.elements.filter((e) => e.tag === "action");
    const optionAction = actionEls[0];
    assert.strictEqual(optionAction.actions[0].value.action, "elicitation:0:0");
    assert.strictEqual(optionAction.actions[1].value.action, "elicitation:0:1");
    assert.strictEqual(optionAction.actions[0].value.permId, "lark_1");
    // option 1 is selected → "✓ B"; option 0 not → "▢ A"
    assert.ok(optionAction.actions[1].text.content.startsWith("✓"));
    assert.ok(optionAction.actions[0].text.content.startsWith("▢"));
    // a submit button exists with the elicitation-submit value
    const submit = actionEls[actionEls.length - 1].actions[0];
    assert.strictEqual(submit.value.action, "elicitation-submit");
  });

  it("single-select: plain option buttons, no submit button", () => {
    const client = mk();
    const toolInput = { questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }] };
    const card = client.buildElicitationCard(toolInput, "lark_2", "CD34", null, false);
    const submits = card.elements
      .filter((e) => e.tag === "action")
      .flatMap((e) => e.actions)
      .filter((b) => b.value.action === "elicitation-submit");
    assert.strictEqual(submits.length, 0, "single-select has no submit button");
  });

  it("buildCardUpdateResponse wraps a card as a raw in-place update", () => {
    const client = mk();
    const resp = client.buildCardUpdateResponse({ x: 1 });
    assert.deepStrictEqual(resp, { card: { type: "raw", data: { x: 1 } } });
  });
});
