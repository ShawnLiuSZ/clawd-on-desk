"use strict";

const DEFAULT_WECHAT_BOT = Object.freeze({
  enabled: false,
  token: "",
  approvalEnabled: true,
  approvalTimeoutMs: 300000,
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "default",
  // Auto-discovered from the first inbound message and persisted so approval
  // sends survive a restart without the user re-messaging the bot. Mirrors the
  // QQ Bot userOpenid anchor. contextToken refreshes on every inbound message.
  userId: "",
  contextToken: "",
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultWechatBot() {
  return { ...DEFAULT_WECHAT_BOT };
}

function trimString(value, maxLen = 4096) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function normalizeWechatBot(value, defaultsValue = DEFAULT_WECHAT_BOT) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_WECHAT_BOT;
  const out = {
    enabled: defaults.enabled === true,
    token: trimString(defaults.token, 4096),
    approvalEnabled: defaults.approvalEnabled !== false,
    approvalTimeoutMs: Number.isFinite(defaults.approvalTimeoutMs) && defaults.approvalTimeoutMs > 0
      ? Math.min(defaults.approvalTimeoutMs, 600000)
      : DEFAULT_WECHAT_BOT.approvalTimeoutMs,
    baseUrl: trimString(defaults.baseUrl, 512) || DEFAULT_WECHAT_BOT.baseUrl,
    accountId: trimString(defaults.accountId, 256) || DEFAULT_WECHAT_BOT.accountId,
    userId: trimString(defaults.userId, 256),
    contextToken: trimString(defaults.contextToken, 4096),
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.approvalEnabled === "boolean") out.approvalEnabled = value.approvalEnabled;
  if (typeof value.token === "string") {
    out.token = trimString(value.token, 4096);
  }
  if (typeof value.baseUrl === "string") {
    const candidate = trimString(value.baseUrl, 512);
    if (candidate) out.baseUrl = candidate;
  }
  if (typeof value.accountId === "string") {
    const candidate = trimString(value.accountId, 256);
    if (candidate) out.accountId = candidate;
  }
  if (typeof value.userId === "string") {
    out.userId = trimString(value.userId, 256);
  }
  if (typeof value.contextToken === "string") {
    out.contextToken = trimString(value.contextToken, 4096);
  }
  if (Number.isFinite(value.approvalTimeoutMs) && value.approvalTimeoutMs > 0) {
    out.approvalTimeoutMs = Math.min(value.approvalTimeoutMs, 600000);
  }
  return out;
}

function validateWechatBot(value) {
  if (!isPlainObject(value)) {
    return { status: "error", message: "wechatBot must be a plain object" };
  }
  for (const key of Object.keys(value)) {
    if (![
      "enabled", "token", "approvalEnabled", "approvalTimeoutMs", "baseUrl", "accountId",
      "userId", "contextToken",
    ].includes(key)) {
      return { status: "error", message: `wechatBot.${key} is not supported` };
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { status: "error", message: "wechatBot.enabled must be a boolean" };
  }
  if (value.approvalEnabled !== undefined && typeof value.approvalEnabled !== "boolean") {
    return { status: "error", message: "wechatBot.approvalEnabled must be a boolean" };
  }
  if (value.token !== undefined && typeof value.token !== "string") {
    return { status: "error", message: "wechatBot.token must be a string" };
  }
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") {
    return { status: "error", message: "wechatBot.baseUrl must be a string" };
  }
  if (value.accountId !== undefined && typeof value.accountId !== "string") {
    return { status: "error", message: "wechatBot.accountId must be a string" };
  }
  if (value.userId !== undefined && typeof value.userId !== "string") {
    return { status: "error", message: "wechatBot.userId must be a string" };
  }
  if (value.contextToken !== undefined && typeof value.contextToken !== "string") {
    return { status: "error", message: "wechatBot.contextToken must be a string" };
  }
  if (value.approvalTimeoutMs !== undefined) {
    if (!Number.isFinite(value.approvalTimeoutMs) || value.approvalTimeoutMs <= 0) {
      return { status: "error", message: "wechatBot.approvalTimeoutMs must be a positive number" };
    }
  }
  return { status: "ok" };
}

function readiness(config) {
  const normalized = normalizeWechatBot(config);
  if (!normalized.enabled) return { ready: false, reason: "disabled", config: normalized };
  if (!normalized.token) {
    return { ready: false, reason: "missing-token", message: "WeChat ilink token is not configured", config: normalized };
  }
  return { ready: true, config: normalized };
}

module.exports = {
  DEFAULT_WECHAT_BOT,
  cloneDefaultWechatBot,
  normalizeWechatBot,
  validateWechatBot,
  readiness,
};
