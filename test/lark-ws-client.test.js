"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createLarkWsClient,
  mapMessageEvent,
  mapCardActionEvent,
} = require("../src/lark-ws-client");

// ── Fake SDK ──────────────────────────────────────────────────────────────
function makeFakeSdk() {
  const calls = { dispatchers: [], wsClients: [] };

  class FakeEventDispatcher {
    constructor() {
      this.handlers = null;
    }
    register(handlers) {
      this.handlers = handlers;
      calls.dispatchers.push(this);
      return this;
    }
  }

  class FakeWSClient {
    constructor(config) {
      this.config = config;
      this.started = false;
      this.closed = false;
      this.eventDispatcher = null;
      calls.wsClients.push(this);
    }
    start({ eventDispatcher }) {
      this.started = true;
      this.eventDispatcher = eventDispatcher;
    }
    close() {
      this.closed = true;
    }
  }

  return {
    sdk: {
      WSClient: FakeWSClient,
      EventDispatcher: FakeEventDispatcher,
      Domain: { Feishu: 0, Lark: 1 },
      LoggerLevel: { info: 3 },
    },
    calls,
  };
}

describe("lark-ws-client: event mappers", () => {
  it("maps im.message.receive_v1 to {chatId,text,senderId}", () => {
    const out = mapMessageEvent({
      sender: { sender_id: { open_id: "ou_abc" } },
      message: {
        chat_id: "oc_123",
        message_type: "text",
        content: JSON.stringify({ text: "y AB12" }),
      },
    });
    assert.deepStrictEqual(out, { chatId: "oc_123", text: "y AB12", senderId: "ou_abc" });
  });

  it("returns empty text for non-text messages", () => {
    const out = mapMessageEvent({ message: { chat_id: "oc_1", message_type: "image", content: "{}" } });
    assert.strictEqual(out.text, "");
    assert.strictEqual(out.chatId, "oc_1");
  });

  it("maps card.action.trigger to {permId,action,chatId}", () => {
    const out = mapCardActionEvent({
      action: { value: { permId: "lark_xyz", action: "allow" } },
      context: { open_chat_id: "oc_777" },
    });
    assert.deepStrictEqual(out, { permId: "lark_xyz", action: "allow", chatId: "oc_777" });
  });

  it("tolerates snake_case + top-level open_chat_id in card events", () => {
    const out = mapCardActionEvent({
      action: { value: { perm_id: "lark_q", behavior: "deny" } },
      open_chat_id: "oc_888",
    });
    assert.deepStrictEqual(out, { permId: "lark_q", action: "deny", chatId: "oc_888" });
  });
});

describe("lark-ws-client: connector", () => {
  it("registers exactly the two subscribed events and dials on start", () => {
    const { sdk, calls } = makeFakeSdk();
    const client = createLarkWsClient({ appId: "cli_x", appSecret: "sec", region: "feishu", sdk });
    client.start();

    assert.strictEqual(calls.wsClients.length, 1);
    const ws = calls.wsClients[0];
    assert.strictEqual(ws.started, true);
    assert.strictEqual(ws.config.domain, sdk.Domain.Feishu);
    assert.deepStrictEqual(
      Object.keys(ws.eventDispatcher.handlers).sort(),
      ["card.action.trigger", "im.message.receive_v1"]
    );
    assert.strictEqual(client.isRunning(), true);
  });

  it("routes message + card events to the callbacks", async () => {
    const { sdk, calls } = makeFakeSdk();
    const messages = [];
    const cards = [];
    const client = createLarkWsClient({
      appId: "cli_x",
      appSecret: "sec",
      region: "feishu",
      sdk,
      onMessage: (m) => { messages.push(m); },
      onCardAction: (c) => { cards.push(c); },
    });
    client.start();
    const handlers = calls.wsClients[0].eventDispatcher.handlers;

    await handlers["im.message.receive_v1"]({
      sender: { sender_id: { open_id: "ou_a" } },
      message: { chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "hi" }) },
    });
    assert.deepStrictEqual(messages, [{ chatId: "oc_1", text: "hi", senderId: "ou_a" }]);

    const ack = await handlers["card.action.trigger"]({
      action: { value: { permId: "lark_1", action: "allow" } },
      context: { open_chat_id: "oc_1" },
    });
    assert.deepStrictEqual(cards, [{ permId: "lark_1", action: "allow", chatId: "oc_1" }]);
    // Returns a toast ack so the Feishu client doesn't time out.
    assert.strictEqual(ack.toast.type, "success");
  });

  it("returns the onCardAction result back over WS (in-place card update)", async () => {
    const { sdk, calls } = makeFakeSdk();
    const updateResp = { card: { type: "raw", data: { updated: true } } };
    const client = createLarkWsClient({
      appId: "cli_x",
      appSecret: "sec",
      sdk,
      onCardAction: () => updateResp,
    });
    client.start();
    const handlers = calls.wsClients[0].eventDispatcher.handlers;
    const ret = await handlers["card.action.trigger"]({
      action: { value: { permId: "lark_1", action: "elicitation:0:0" } },
      context: { open_chat_id: "oc_1" },
    });
    assert.deepStrictEqual(ret, updateResp);
  });

  it("falls back to a toast ack when onCardAction returns nothing", async () => {
    const { sdk, calls } = makeFakeSdk();
    const client = createLarkWsClient({ appId: "cli_x", appSecret: "sec", sdk, onCardAction: () => undefined });
    client.start();
    const handlers = calls.wsClients[0].eventDispatcher.handlers;
    const ret = await handlers["card.action.trigger"]({ action: { value: {} } });
    assert.strictEqual(ret.toast.type, "success");
  });

  it("maps region=lark to the Lark domain", () => {
    const { sdk, calls } = makeFakeSdk();
    const client = createLarkWsClient({ appId: "cli_x", appSecret: "sec", region: "lark", sdk });
    client.start();
    assert.strictEqual(calls.wsClients[0].config.domain, sdk.Domain.Lark);
  });

  it("does not dial when credentials are missing", () => {
    const { sdk, calls } = makeFakeSdk();
    const client = createLarkWsClient({ appId: "", appSecret: "", sdk });
    client.start();
    assert.strictEqual(calls.wsClients.length, 0);
    assert.strictEqual(client.isRunning(), false);
  });

  it("restarts the socket only when credentials change", () => {
    const { sdk, calls } = makeFakeSdk();
    const client = createLarkWsClient({ appId: "cli_x", appSecret: "sec", region: "feishu", sdk });
    client.start();
    assert.strictEqual(calls.wsClients.length, 1);

    // No-op update → same socket.
    client.updateConfig({ appId: "cli_x", appSecret: "sec", region: "feishu" });
    assert.strictEqual(calls.wsClients.length, 1);
    assert.strictEqual(calls.wsClients[0].closed, false);

    // Real change → old socket closed, new one dialed.
    client.updateConfig({ appSecret: "sec2" });
    assert.strictEqual(calls.wsClients[0].closed, true);
    assert.strictEqual(calls.wsClients.length, 2);
    assert.strictEqual(calls.wsClients[1].started, true);
  });

  it("stop closes the socket", () => {
    const { sdk, calls } = makeFakeSdk();
    const client = createLarkWsClient({ appId: "cli_x", appSecret: "sec", sdk });
    client.start();
    client.stop();
    assert.strictEqual(calls.wsClients[0].closed, true);
    assert.strictEqual(client.isRunning(), false);
  });
});
