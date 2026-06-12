"use strict";

// ── WeChat iLink Client — HTTP long-polling client for WeChat Bot API ──
//
// Connects to WeChat's ilink Bot API (ilinkai.weixin.qq.com) using a
// Bearer token obtained via QR-code login. Provides:
//   - Long-poll getUpdates for receiving messages
//   - sendMessage for sending text replies
//   - Context-token tracking for conversation threading
//
//   - context_token required for every reply (carried from incoming msg)
//   - X-WECHAT-UIN anti-replay header regenerated per request
//
// Constraints:
//   - No Electron dependencies — pure Node.js (testable in isolation)
//   - Long-poll reconnection is handled internally
//   - All HTTP calls are fire-and-forget where possible

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 20;

function compactLog(text, maxLen = 200) {
  let t = String(text == null ? "" : text);
  t = t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\b[0-9a-fA-F]{32,}\b/g, "<redacted:token>");
  t = t.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<redacted:b64>");
  if (t.length > maxLen) t = `${t.slice(0, Math.max(0, maxLen - 1))}…`;
  return t;
}

function generateWechatUin() {
  const uin = String(Math.floor(Math.random() * 4294967296));
  return Buffer.from(uin).toString("base64");
}

function generateClientId() {
  return `clawd-${crypto.randomUUID()}`;
}

function httpRequest(method, url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    if (payload) {
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const timeout = options.timeout || 15000;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout,
      rejectUnauthorized: options.rejectUnauthorized !== false,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (data.length < 65536) data += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data || "{}") });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpPostJson(url, body, options = {}) {
  return httpRequest("POST", url, body, options);
}

function httpGetJson(url, options = {}) {
  return httpRequest("GET", url, null, options);
}

async function fetchQrcode(baseUrl = DEFAULT_BASE_URL) {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const result = await httpGetJson(url, { timeout: 15000 });
  if (result.status !== 200) {
    throw new Error(`get_bot_qrcode failed: status=${result.status}`);
  }
  const body = result.body;
  if (!body || !body.qrcode) {
    throw new Error("get_bot_qrcode returned unexpected response: missing qrcode key");
  }
  const qrcode = body.qrcode;

  // qrcode_img_content is a URL (e.g. https://liteapp.weixin.qq.com/q/xxx?qrcode=yyy)
  // that WeChat scans — encode it into a QR code image.
  const qrContent = (body.qrcode_img_content && typeof body.qrcode_img_content === "string")
    ? body.qrcode_img_content.trim()
    : "";

  let qrcodeImg = "";
  if (qrContent) {
    try {
      const QRCode = require("qrcode");
      qrcodeImg = await QRCode.toDataURL(qrContent, { width: 200, margin: 2, errorCorrectionLevel: "M" });
    } catch {
      // Local generation failed — use the URL directly (won't render as image but at least logged)
      qrcodeImg = qrContent;
    }
  }

  return { qrcodeImg, loginUrl: qrContent, qrcode };
}

async function pollQrcodeStatus(qrcodeKey, baseUrl = DEFAULT_BASE_URL) {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`;
  const result = await httpGetJson(url, { timeout: 35000 });
  if (result.status !== 200) {
    return { status: "pending" };
  }
  const body = result.body;
  if (body && body.bot_token) {
    return {
      status: "ok",
      botToken: body.bot_token,
      baseUrl: body.baseurl || baseUrl,
    };
  }
  return { status: "pending" };
}

function createWechatIlinkClient(config, options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const logFn = typeof options.log === "function" ? options.log : () => {};

  let token = config.token || "";
  let baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  let enabled = config.enabled !== false;

  // Long-poll state
  let getUpdatesBuf = "";
  let contextToken = "";
  let botUserId = "";
  let longPollAbortController = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let polling = false;

  const messageListeners = new Set();
  const textMessageListeners = new Set();

  function updateConfig(newConfig) {
    if (newConfig.token !== undefined) token = String(newConfig.token || "");
    if (newConfig.baseUrl !== undefined) baseUrl = String(newConfig.baseUrl || "") || DEFAULT_BASE_URL;
    if (newConfig.enabled !== undefined) enabled = newConfig.enabled === true;
  }

  function isConfigured() {
    return !!(token && baseUrl);
  }

  function isEnabled() {
    return enabled && isConfigured();
  }

  function authHeaders() {
    return {
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${token}`,
      "X-WECHAT-UIN": generateWechatUin(),
    };
  }

  // ── Long-poll loop ──

  function stopPolling() {
    if (longPollAbortController) {
      try { longPollAbortController.abort(); } catch {}
      longPollAbortController = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    polling = false;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logFn("wechat-ilink: max reconnect attempts reached");
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempts++;
      startPolling().catch((err) => {
        logFn(`wechat-ilink: reconnect poll failed: ${compactLog(err, 100)}`);
      });
    }, delay);
  }

  async function startPolling() {
    if (!isConfigured()) return;
    stopPolling();

    longPollAbortController = typeof AbortController === "function"
      ? new AbortController() : null;
    polling = true;

    const url = `${baseUrl}/ilink/bot/getupdates`;

    while (polling) {
      try {
        const body = {
          get_updates_buf: getUpdatesBuf,
          base_info: { channel_version: "1.0.2" },
        };
        const signal = longPollAbortController ? longPollAbortController.signal : null;
        const result = await httpPostJson(url, body, {
          headers: authHeaders(),
          timeout: DEFAULT_LONGPOLL_TIMEOUT_MS + 10000,
          signal,
        });

        if (!polling) break;

        if (result.status !== 200) {
          logFn(`wechat-ilink: getupdates status=${result.status}`);
          stopPolling();
          scheduleReconnect();
          break;
        }

        const rb = result.body;
        if (rb && rb.ret !== 0) {
          logFn(`wechat-ilink: getupdates ret=${rb.ret} errcode=${rb.errcode || ""} errmsg=${compactLog(rb.errmsg || "", 100)}`);
          // errcode -14 = session expired, need re-login
          if (rb.errcode === -14) {
            logFn("wechat-ilink: session expired, stopping poll");
            stopPolling();
            break;
          }
          // Other errors: back off and retry
          stopPolling();
          scheduleReconnect();
          break;
        }

        // Save cursor for next poll
        if (rb && typeof rb.get_updates_buf === "string") {
          getUpdatesBuf = rb.get_updates_buf;
        }

        // Reset reconnect counter on success
        reconnectAttempts = 0;

        // Process messages
        const msgs = (rb && Array.isArray(rb.msgs)) ? rb.msgs : [];
        for (const msg of msgs) {
          processMessage(msg);
        }

        // Immediately start next poll (no delay when messages arrived)
      } catch (err) {
        if (!polling) break;
        // Aborted intentionally (stopPolling or new startPolling)
        if (err && err.name === "AbortError") break;
        logFn(`wechat-ilink: poll error: ${compactLog(err, 100)}`);
        stopPolling();
        scheduleReconnect();
        break;
      }
    }
  }

  function processMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    // message_type 2 = bot's own outgoing message — skip
    if (msg.message_type === 2) return;

    // Only handle complete messages
    if (msg.message_state !== 2) return;

    // Save context_token for replies
    if (msg.context_token && typeof msg.context_token === "string") {
      contextToken = msg.context_token;
    }

    // Track bot's own user ID from incoming messages
    if (msg.to_user_id && typeof msg.to_user_id === "string" && msg.to_user_id.endsWith("@im.bot")) {
      botUserId = msg.to_user_id;
    }

    // Extract text content
    const itemList = Array.isArray(msg.item_list) ? msg.item_list : [];
    const textParts = [];
    for (const item of itemList) {
      if (item && item.type === 1 && item.text_item && typeof item.text_item.text === "string") {
        textParts.push(item.text_item.text);
      }
    }
    const text = textParts.join("").trim();
    const fromUserId = msg.from_user_id || "";

    // Notify general message listeners
    for (const listener of messageListeners) {
      try {
        listener({ msg, text, fromUserId });
      } catch (err) {
        logFn(`wechat-ilink: message listener error: ${compactLog(err, 100)}`);
      }
    }

    // Notify text-specific listeners (approval bridge)
    if (text) {
      for (const listener of textMessageListeners) {
        try {
          listener({ text, fromUserId, contextToken: msg.context_token, msg });
        } catch (err) {
          logFn(`wechat-ilink: text listener error: ${compactLog(err, 100)}`);
        }
      }
    }
  }

  // ── Send message ──

  async function sendTextMessage(text, targetUserId) {
    if (!isConfigured()) {
      throw new Error("WeChat ilink client is not configured");
    }

    const toUserId = targetUserId || "";
    if (!toUserId) {
      // Try to derive from last incoming message's from_user_id
      // If we have contextToken, use botUserId as to_user_id
      throw new Error("No target user ID available — send the bot a message first");
    }

    const clampedText = typeof text === "string" ? text.slice(0, 2000) : "";

    const body = {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [
          {
            type: 1,
            text_item: { text: clampedText },
          },
        ],
      },
      base_info: { channel_version: "1.0.2" },
    };

    const url = `${baseUrl}/ilink/bot/sendmessage`;
    return httpPostJson(url, body, {
      headers: authHeaders(),
      timeout: 15000,
    });
  }

  function getContextToken() {
    return contextToken;
  }

  function getBotUserId() {
    return botUserId;
  }

  function getLastFromUserId() {
    return "";
  }

  function onMessage(callback) {
    if (typeof callback === "function") {
      messageListeners.add(callback);
      return () => messageListeners.delete(callback);
    }
    return () => {};
  }

  function onTextMessage(callback) {
    if (typeof callback === "function") {
      textMessageListeners.add(callback);
      return () => textMessageListeners.delete(callback);
    }
    return () => {};
  }

  function disconnect() {
    stopPolling();
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  }

  function isConnected() {
    return polling;
  }

  return {
    updateConfig,
    isConfigured,
    isEnabled,
    startPolling,
    stopPolling,
    sendTextMessage,
    getContextToken,
    getBotUserId,
    onMessage,
    onTextMessage,
    disconnect,
    isConnected,
    _testGenerateWechatUin: generateWechatUin,
    _testGenerateClientId: generateClientId,
    _testProcessMessage: processMessage,
    _testAuthHeaders: authHeaders,
  };
}

module.exports = {
  compactLog,
  DEFAULT_BASE_URL,
  DEFAULT_LONGPOLL_TIMEOUT_MS,
  generateWechatUin,
  generateClientId,
  createWechatIlinkClient,
  fetchQrcode,
  pollQrcodeStatus,
};
