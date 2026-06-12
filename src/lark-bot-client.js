"use strict";

// ── Lark Bot Client — Token management + HTTP API ──
//
// Connects to the Lark Open Platform API (open.feishu.cn) using AppID / AppSecret.
// Provides:
//   - Automatic tenant_access_token refresh (7200s TTL, 5-min early renewal)
//   - Message sending (text + interactive cards)
//   - Approval card building
//
// Constraints:
//   - All HTTP calls are fire-and-forget where possible
//   - No Electron dependencies — pure Node.js (testable in isolation)

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { larkCardText } = require("./lark-bot-i18n");

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const API_BASE = "https://open.feishu.cn/open-apis";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function compactLog(text, maxLen = 200) {
  let t = String(text == null ? "" : text);
  t = t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\b[A-Za-z0-9._~+/=-]{20,}\b/g, "<redacted>");
  if (t.length > maxLen) t = `${t.slice(0, Math.max(0, maxLen - 1))}…`;
  return t;
}

function httpRequestWithBody(method, url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      ...options.headers,
    };
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: options.timeout || 10000,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (data.length < 4096) data += chunk; });
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
    req.end(payload);
  });
}

function httpPost(url, body, options = {}) {
  return httpRequestWithBody("POST", url, body, options);
}

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const headers = { "Content-Type": "application/json", ...options.headers };
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers,
      timeout: options.timeout || 10000,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (data.length < 4096) data += chunk; });
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
    req.end();
  });
}

function createLarkBotClient(config, options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const httpPostFn = options.httpPost || httpPost;
  const getLang = typeof options.getLang === "function" ? options.getLang : () => "en";
  const tr = (key, params) => larkCardText(getLang(), key, params);

  let appId = config.appId || "";
  let appSecret = config.appSecret || "";
  let chatId = config.chatId || "";

  let cachedToken = null;
  let tokenExpiresAt = 0;
  let tokenPromise = null;

  function updateConfig(newConfig) {
    if (newConfig.appId !== undefined) appId = String(newConfig.appId || "");
    if (newConfig.appSecret !== undefined) appSecret = String(newConfig.appSecret || "");
    if (newConfig.chatId !== undefined) chatId = String(newConfig.chatId || "");
  }

  function isConfigured() {
    return !!(appId && appSecret && chatId);
  }

  async function fetchToken() {
    const result = await httpPostFn(TOKEN_URL, {
      app_id: appId,
      app_secret: appSecret,
    }, { timeout: 10000 });
    if (result.status !== 200 || !result.body || !result.body.tenant_access_token) {
      throw new Error(`Lark token fetch failed: status=${result.status}`);
    }
    return {
      token: result.body.tenant_access_token,
      expiresIn: Number(result.body.expire) || 7200,
    };
  }

  async function getToken() {
    const currentTime = nowFn();
    if (cachedToken && currentTime < tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken;
    }
    if (tokenPromise) {
      try { return await tokenPromise; } catch { tokenPromise = null; }
    }
    tokenPromise = fetchToken().then((result) => {
      cachedToken = result.token;
      tokenExpiresAt = nowFn() + result.expiresIn * 1000;
      tokenPromise = null;
      logFn(`lark-bot: token refreshed, expires in ${result.expiresIn}s`);
      return cachedToken;
    }).catch((err) => {
      tokenPromise = null;
      throw err;
    });
    return tokenPromise;
  }

  async function sendMessage(receiveId, msgType, content) {
    if (!isConfigured()) return null;
    const token = await getToken().catch(() => null);
    if (!token) return null;

    const url = `${API_BASE}/im/v1/messages?receive_id_type=chat_id`;
    const body = {
      receive_id: receiveId,
      msg_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
    };

    try {
      const result = await httpPostFn(url, body, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (result.status !== 200 || (result.body && result.body.code !== 0)) {
        logFn(`lark-bot: send message failed: status=${result.status} code=${result.body && result.body.code}`);
        return null;
      }
      return result.body;
    } catch (err) {
      logFn(`lark-bot: send message error: ${compactLog(err && err.message)}`);
      return null;
    }
  }

  async function sendTextMessage(text) {
    return sendMessage(chatId, "text", JSON.stringify({ text }));
  }

  async function sendCardMessage(card) {
    return sendMessage(chatId, "interactive", JSON.stringify(card));
  }

  function buildApprovalCard(payload) {
    const { permId, shortCode, toolName, agentName, cwd, summary } = payload;
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: `权限请求: ${toolName || "Unknown"}` },
        template: "red",
      },
      elements: [
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: `**Agent:** ${agentName || "unknown"}` } },
            { is_short: true, text: { tag: "lark_md", content: `**Tool:** ${toolName || "unknown"}` } },
            { is_short: false, text: { tag: "lark_md", content: `**Folder:** ${cwd || "N/A"}` } },
            { is_short: false, text: { tag: "lark_md", content: `**Summary:** ${summary || "N/A"}` } },
          ],
        },
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: `✅ ${tr("allow")}` },
              type: "primary",
              value: { action: "allow", permId },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: `❌ ${tr("deny")}` },
              type: "danger",
              value: { action: "deny", permId },
            },
          ],
        },
        {
          tag: "note",
          elements: [
            { tag: "plain_text", content: tr("approvalHint", { code: shortCode || "N/A" }) },
          ],
        },
      ],
    };
  }

  function buildConfirmationCard(payload, behavior) {
    const { toolName, agentName } = payload;
    const isAllow = behavior === "allow";
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: isAllow ? "✅ 已允许" : "❌ 已拒绝" },
        template: isAllow ? "green" : "red",
      },
      elements: [
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: `**Agent:** ${agentName || "unknown"}` } },
            { is_short: true, text: { tag: "lark_md", content: `**Tool:** ${toolName || "unknown"}` } },
          ],
        },
      ],
    };
  }

  function isEnabled() {
    return isConfigured();
  }

  function getChatId() {
    return chatId;
  }

  return {
    updateConfig,
    isConfigured,
    getToken,
    sendTextMessage,
    sendCardMessage,
    sendMessage,
    buildApprovalCard,
    buildConfirmationCard,
    isEnabled,
    getChatId,
    _testCompactLog: compactLog,
  };
}

module.exports = {
  compactLog,
  httpPost,
  TOKEN_URL,
  API_BASE,
  createLarkBotClient,
};
