"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createLarkBotClient, compactLog } = require("../src/lark-bot-client");

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
