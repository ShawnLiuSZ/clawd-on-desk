"use strict";

// ── Lark/Feishu WebSocket long-connection client ──
//
// Wraps the official @larksuiteoapi/node-sdk WSClient + EventDispatcher so the
// app can receive Feishu events (incoming messages + interactive-card button
// taps) over an outbound WebSocket — no public IP, no webhook URL, no reverse
// proxy. This replaces the old HTTP webhook (server-route-lark-webhook.js) and
// the device-code scan flow.
//
// The connector stays dependency-light: the SDK is injected (`opts.sdk`) so the
// event-mapping logic is unit-testable with a fake SDK.
//
// Events we subscribe to (must be enabled in the Feishu console under
// 长连接/WebSocket mode):
//   - im.message.receive_v1  → capture chat_id (auto-bind) + text replies
//   - card.action.trigger    → approval button taps

const REGION_LARK = "lark";

// ── Pure event mappers (testable without the SDK) ──────────────────────────

// im.message.receive_v1 → { chatId, text, senderId }
function mapMessageEvent(data) {
  const message = (data && data.message) || {};
  const sender = (data && data.sender) || {};
  const senderId = (sender.sender_id && (sender.sender_id.open_id || sender.sender_id.user_id)) || "";
  const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
  let text = "";
  if (message.message_type === "text") {
    try {
      const content = typeof message.content === "string"
        ? JSON.parse(message.content)
        : (message.content || {});
      text = String(content.text || "");
    } catch {
      text = "";
    }
  }
  return { chatId, text, senderId };
}

// card.action.trigger → { permId, action, chatId }
function mapCardActionEvent(data) {
  const action = (data && data.action) || {};
  const value = action.value && typeof action.value === "object" ? action.value : {};
  const context = (data && data.context) || {};
  const permId = value.permId || value.perm_id || null;
  const behavior = value.action || value.behavior || null;
  const chatId = context.open_chat_id || data.open_chat_id || "";
  return { permId, action: behavior, chatId };
}

function createLarkWsClient(opts = {}) {
  const sdk = opts.sdk;
  if (!sdk || typeof sdk.WSClient !== "function" || typeof sdk.EventDispatcher !== "function") {
    throw new Error("createLarkWsClient: opts.sdk must expose WSClient + EventDispatcher");
  }
  const logFn = typeof opts.log === "function" ? opts.log : () => {};
  const onMessage = typeof opts.onMessage === "function" ? opts.onMessage : () => {};
  const onCardAction = typeof opts.onCardAction === "function" ? opts.onCardAction : () => {};

  let appId = String(opts.appId || "");
  let appSecret = String(opts.appSecret || "");
  let region = opts.region === REGION_LARK ? REGION_LARK : "feishu";
  let wsClient = null;
  let running = false;

  function regionToDomain() {
    return region === REGION_LARK ? sdk.Domain.Lark : sdk.Domain.Feishu;
  }

  function buildDispatcher() {
    return new sdk.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const mapped = mapMessageEvent(data);
        logFn(`lark-ws: im.message.receive_v1 received (chatId=${mapped.chatId || "?"})`);
        try {
          onMessage(mapped);
        } catch (err) {
          logFn(`lark-ws: onMessage handler error: ${err && err.message}`);
        }
      },
      "card.action.trigger": async (data) => {
        const mapped = mapCardActionEvent(data);
        logFn(`lark-ws: card.action.trigger received (permId=${mapped.permId || "?"})`);
        try {
          // The handler may return a Feishu callback response (an in-place card
          // update for elicitation toggles, or a toast). Send it back so Feishu
          // re-renders the card / shows the toast.
          const resp = onCardAction(mapped);
          if (resp) return resp;
        } catch (err) {
          logFn(`lark-ws: onCardAction handler error: ${err && err.message}`);
        }
        // Default ack so the Feishu client doesn't show a timeout.
        return { toast: { type: "success", content: "OK" } };
      },
    });
  }

  function start() {
    if (running) return;
    if (!appId || !appSecret) {
      logFn("lark-ws: start skipped — missing appId/appSecret");
      return;
    }
    const loggerLevel = sdk.LoggerLevel ? sdk.LoggerLevel.info : undefined;
    wsClient = new sdk.WSClient({ appId, appSecret, domain: regionToDomain(), loggerLevel });
    wsClient.start({ eventDispatcher: buildDispatcher() });
    running = true;
    logFn(`lark-ws: started (region=${region})`);
  }

  function stop() {
    if (wsClient && typeof wsClient.close === "function") {
      try {
        wsClient.close();
      } catch (err) {
        logFn(`lark-ws: stop error: ${err && err.message}`);
      }
    }
    wsClient = null;
    running = false;
  }

  // Restart only when credentials/region actually change.
  function updateConfig(next = {}) {
    const nextAppId = next.appId !== undefined ? String(next.appId || "") : appId;
    const nextAppSecret = next.appSecret !== undefined ? String(next.appSecret || "") : appSecret;
    const nextRegion = next.region !== undefined
      ? (next.region === REGION_LARK ? REGION_LARK : "feishu")
      : region;
    const changed = nextAppId !== appId || nextAppSecret !== appSecret || nextRegion !== region;
    if (!changed) return;
    const wasRunning = running;
    if (wasRunning) stop();
    appId = nextAppId;
    appSecret = nextAppSecret;
    region = nextRegion;
    if (wasRunning) start();
  }

  function isRunning() {
    return running;
  }

  return {
    start,
    stop,
    updateConfig,
    isRunning,
  };
}

module.exports = {
  createLarkWsClient,
  mapMessageEvent,
  mapCardActionEvent,
};
