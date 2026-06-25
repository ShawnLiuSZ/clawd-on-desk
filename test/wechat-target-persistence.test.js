"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeWechatBot, validateWechatBot } = require("../src/wechat-bot-settings");
const { createWechatIlinkClient } = require("../src/wechat-ilink-client");

function makeClient(overrides = {}) {
  return createWechatIlinkClient(
    { token: "test-token", enabled: true, ...overrides },
    { log: () => {}, now: () => Date.now() }
  );
}

function inboundMsg(fromUserId, contextToken, text = "hi") {
  return {
    message_type: 1,
    message_state: 2,
    from_user_id: fromUserId,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("wechat target persistence — settings", () => {
  it("normalize keeps userId and contextToken", () => {
    const out = normalizeWechatBot({ token: "t", userId: "u-123", contextToken: "ctx-abc" });
    assert.equal(out.userId, "u-123");
    assert.equal(out.contextToken, "ctx-abc");
  });

  it("normalize defaults userId/contextToken to empty strings", () => {
    const out = normalizeWechatBot({ token: "t" });
    assert.equal(out.userId, "");
    assert.equal(out.contextToken, "");
  });

  it("validate accepts userId/contextToken and rejects non-strings", () => {
    assert.equal(validateWechatBot({ userId: "u", contextToken: "c" }).status, "ok");
    assert.equal(validateWechatBot({ userId: 5 }).status, "error");
    assert.equal(validateWechatBot({ contextToken: {} }).status, "error");
  });
});

describe("wechat target persistence — client", () => {
  it("restores persisted userId/contextToken so a send target exists before any inbound message", () => {
    const client = makeClient({ userId: "persisted-user", contextToken: "persisted-ctx" });
    assert.equal(client.getLastFromUserId(), "persisted-user");
    assert.equal(client.getContextToken(), "persisted-ctx");
  });

  it("notifies onTargetDiscovered with userId + contextToken on an inbound message", () => {
    const client = makeClient();
    const seen = [];
    client.onTargetDiscovered((t) => seen.push(t));
    client._testProcessMessage(inboundMsg("u-live", "ctx-live"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].userId, "u-live");
    assert.equal(seen[0].contextToken, "ctx-live");
  });

  it("a live inbound message overrides the restored value", () => {
    const client = makeClient({ userId: "persisted-user", contextToken: "persisted-ctx" });
    client._testProcessMessage(inboundMsg("u-live", "ctx-live"));
    assert.equal(client.getLastFromUserId(), "u-live");
    assert.equal(client.getContextToken(), "ctx-live");
  });

  it("updateConfig never clobbers an already-discovered target with a stale persisted one", () => {
    const client = makeClient();
    client._testProcessMessage(inboundMsg("u-live", "ctx-live"));
    client.updateConfig({ userId: "stale-user", contextToken: "stale-ctx" });
    assert.equal(client.getLastFromUserId(), "u-live");
    assert.equal(client.getContextToken(), "ctx-live");
  });
});
