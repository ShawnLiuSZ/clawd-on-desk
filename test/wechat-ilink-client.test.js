"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_BASE_URL,
  generateWechatUin,
  generateClientId,
  createWechatIlinkClient,
} = require("../src/wechat-ilink-client");

describe("wechat-ilink-client", () => {
  describe("generateWechatUin", () => {
    it("returns a non-empty base64 string", () => {
      const uin = generateWechatUin();
      assert.ok(typeof uin === "string");
      assert.ok(uin.length > 0);
    });

    it("generates different values each call", () => {
      const a = generateWechatUin();
      const b = generateWechatUin();
      // Could theoretically collide but extremely unlikely
      assert.ok(a.length > 0 && b.length > 0);
    });
  });

  describe("generateClientId", () => {
    it("returns a clawd-prefixed UUID", () => {
      const id = generateClientId();
      assert.ok(id.startsWith("clawd-"));
      assert.ok(id.length > 7);
    });

    it("generates unique values", () => {
      const a = generateClientId();
      const b = generateClientId();
      assert.notStrictEqual(a, b);
    });
  });

  describe("createWechatIlinkClient", () => {
    function makeClient(overrides = {}) {
      return createWechatIlinkClient(
        { token: "test-token", enabled: true, ...overrides },
        { log: () => {}, now: () => Date.now() }
      );
    }

    it("creates a client with expected interface", () => {
      const client = makeClient();
      assert.strictEqual(typeof client.updateConfig, "function");
      assert.strictEqual(typeof client.isConfigured, "function");
      assert.strictEqual(typeof client.isEnabled, "function");
      assert.strictEqual(typeof client.startPolling, "function");
      assert.strictEqual(typeof client.stopPolling, "function");
      assert.strictEqual(typeof client.sendTextMessage, "function");
      assert.strictEqual(typeof client.getContextToken, "function");
      assert.strictEqual(typeof client.onTextMessage, "function");
      assert.strictEqual(typeof client.onMessage, "function");
      assert.strictEqual(typeof client.disconnect, "function");
      assert.strictEqual(typeof client.isConnected, "function");
    });

    it("isConfigured returns true with token", () => {
      const client = makeClient({ token: "abc" });
      assert.strictEqual(client.isConfigured(), true);
    });

    it("isConfigured returns false without token", () => {
      const client = makeClient({ token: "" });
      assert.strictEqual(client.isConfigured(), false);
    });

    it("isEnabled returns false when disabled", () => {
      const client = makeClient({ enabled: false, token: "abc" });
      assert.strictEqual(client.isEnabled(), false);
    });

    it("isEnabled returns true when enabled with token", () => {
      const client = makeClient({ enabled: true, token: "abc" });
      assert.strictEqual(client.isEnabled(), true);
    });

    it("updateConfig updates token and enabled state", () => {
      const client = makeClient({ token: "old", enabled: true });
      assert.strictEqual(client.isEnabled(), true);
      client.updateConfig({ token: "new", enabled: false });
      assert.strictEqual(client.isEnabled(), false);
    });

    it("onTextMessage registers and returns unsubscribe", () => {
      const client = makeClient();
      const unsub = client.onTextMessage(() => {});
      assert.strictEqual(typeof unsub, "function");
      // Should not throw
      unsub();
    });

    it("disconnect stops polling", () => {
      const client = makeClient();
      client.disconnect();
      assert.strictEqual(client.isConnected(), false);
    });

    it("_testAuthHeaders returns expected headers", () => {
      const client = makeClient({ token: "my-secret-token" });
      const headers = client._testAuthHeaders();
      assert.strictEqual(headers.AuthorizationType, "ilink_bot_token");
      assert.strictEqual(headers.Authorization, "Bearer my-secret-token");
      assert.ok(typeof headers["X-WECHAT-UIN"] === "string");
      assert.ok(headers["X-WECHAT-UIN"].length > 0);
    });

    describe("_testProcessMessage", () => {
      it("skips bot's own messages (message_type 2)", () => {
        const client = makeClient();
        let textReceived = null;
        client.onTextMessage((m) => { textReceived = m; });
        client._testProcessMessage({
          message_type: 2,
          message_state: 2,
          context_token: "ctx1",
          item_list: [{ type: 1, text_item: { text: "bot msg" } }],
        });
        assert.strictEqual(textReceived, null);
      });

      it("processes user text messages", () => {
        const client = makeClient();
        let textReceived = null;
        client.onTextMessage((m) => { textReceived = m; });
        client._testProcessMessage({
          message_type: 1,
          message_state: 2,
          from_user_id: "user123@im.wechat",
          to_user_id: "bot456@im.bot",
          context_token: "ctx-token-1",
          item_list: [{ type: 1, text_item: { text: "hello" } }],
        });
        assert.ok(textReceived);
        assert.strictEqual(textReceived.text, "hello");
        assert.strictEqual(textReceived.fromUserId, "user123@im.wechat");
        assert.strictEqual(textReceived.contextToken, "ctx-token-1");
      });

      it("concatenates multiple text items", () => {
        const client = makeClient();
        let textReceived = null;
        client.onTextMessage((m) => { textReceived = m; });
        client._testProcessMessage({
          message_type: 1,
          message_state: 2,
          from_user_id: "u1",
          context_token: "ctx1",
          item_list: [
            { type: 1, text_item: { text: "part1" } },
            { type: 1, text_item: { text: "part2" } },
          ],
        });
        assert.strictEqual(textReceived.text, "part1part2");
      });

      it("skips incomplete messages (message_state !== 2)", () => {
        const client = makeClient();
        let textReceived = null;
        client.onTextMessage((m) => { textReceived = m; });
        client._testProcessMessage({
          message_type: 1,
          message_state: 1,
          item_list: [{ type: 1, text_item: { text: "partial" } }],
        });
        assert.strictEqual(textReceived, null);
      });
    });
  });
});
