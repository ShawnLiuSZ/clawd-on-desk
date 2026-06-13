"use strict";

// Auth mode constants
const AUTH_MODE_APP_SECRET = "app_secret";
const AUTH_MODE_DEVICE_CODE = "device_code";
const VALID_AUTH_MODES = Object.freeze([AUTH_MODE_APP_SECRET, AUTH_MODE_DEVICE_CODE]);

// Region constants - Feishu for China, Lark for International
const REGION_FEISHU = "feishu";
const REGION_LARK = "lark";
const VALID_REGIONS = Object.freeze([REGION_FEISHU, REGION_LARK]);

const DEFAULT_LARK_BOT = Object.freeze({
  enabled: false,
  appId: "",
  appSecret: "",
  chatId: "",        // 目标群聊 ID 或用户 open_id
  region: REGION_FEISHU, // 默认使用飞书（国内）
  approvalEnabled: true,
  approvalTimeoutMs: 300000, // 5分钟超时
  notifyStates: ["attention", "error"],
  minIntervalMs: 5000,
  // Device code auth
  authMode: AUTH_MODE_APP_SECRET, // "app_secret" | "device_code"
  deviceUserOpenId: "",           // Auto-populated from device code user info
  deviceUserName: "",             // Auto-populated from device code user info
});

const LARK_APPID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LARK_CHATID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_NOTIFY_STATES = Object.freeze([
  "attention", "error", "notification", "sleeping",
]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultLarkBot() {
  return { ...DEFAULT_LARK_BOT };
}

function trimString(value, maxLen = 256) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function isValidLarkAppId(value) {
  return LARK_APPID_RE.test(String(value || "").trim());
}

function isValidLarkChatId(value) {
  return LARK_CHATID_RE.test(String(value || "").trim());
}

function normalizeNotifyStates(value) {
  if (!Array.isArray(value)) return [...DEFAULT_LARK_BOT.notifyStates];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && VALID_NOTIFY_STATES.includes(item) && !out.includes(item)) {
      out.push(item);
    }
  }
  return out.length ? out : [...DEFAULT_LARK_BOT.notifyStates];
}

function normalizeRegion(value) {
  if (typeof value === "string" && VALID_REGIONS.includes(value)) {
    return value;
  }
  return REGION_FEISHU; // Default to Feishu for China
}

function normalizeAuthMode(value) {
  if (typeof value === "string" && VALID_AUTH_MODES.includes(value)) {
    return value;
  }
  return AUTH_MODE_APP_SECRET;
}

function normalizeLarkBot(value, defaultsValue = DEFAULT_LARK_BOT) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_LARK_BOT;
  const out = {
    enabled: defaults.enabled === true,
    appId: trimString(defaults.appId, 64),
    appSecret: trimString(defaults.appSecret, 512),
    chatId: trimString(defaults.chatId, 64),
    region: normalizeRegion(defaults.region),
    approvalEnabled: defaults.approvalEnabled !== false,
    approvalTimeoutMs: Number.isFinite(defaults.approvalTimeoutMs) && defaults.approvalTimeoutMs > 0
      ? Math.min(defaults.approvalTimeoutMs, 600000)
      : DEFAULT_LARK_BOT.approvalTimeoutMs,
    notifyStates: normalizeNotifyStates(defaults.notifyStates),
    minIntervalMs: Number.isFinite(defaults.minIntervalMs) && defaults.minIntervalMs > 0
      ? Math.max(defaults.minIntervalMs, 1000)
      : DEFAULT_LARK_BOT.minIntervalMs,
    authMode: normalizeAuthMode(defaults.authMode),
    deviceUserOpenId: trimString(defaults.deviceUserOpenId, 64),
    deviceUserName: trimString(defaults.deviceUserName, 64),
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.approvalEnabled === "boolean") out.approvalEnabled = value.approvalEnabled;
  if (typeof value.region === "string") out.region = normalizeRegion(value.region);
  if (typeof value.authMode === "string") out.authMode = normalizeAuthMode(value.authMode);
  if (typeof value.appId === "string") {
    const candidate = trimString(value.appId, 64);
    out.appId = isValidLarkAppId(candidate) ? candidate : "";
  }
  if (typeof value.appSecret === "string") {
    out.appSecret = trimString(value.appSecret, 512);
  }
  if (typeof value.chatId === "string") {
    const candidate = trimString(value.chatId, 64);
    out.chatId = isValidLarkChatId(candidate) ? candidate : "";
  }
  if (typeof value.deviceUserOpenId === "string") {
    out.deviceUserOpenId = trimString(value.deviceUserOpenId, 64);
  }
  if (typeof value.deviceUserName === "string") {
    out.deviceUserName = trimString(value.deviceUserName, 64);
  }
  if (Number.isFinite(value.approvalTimeoutMs) && value.approvalTimeoutMs > 0) {
    out.approvalTimeoutMs = Math.min(value.approvalTimeoutMs, 600000);
  }
  if (Number.isFinite(value.minIntervalMs) && value.minIntervalMs > 0) {
    out.minIntervalMs = Math.max(value.minIntervalMs, 1000);
  }
  if (Array.isArray(value.notifyStates)) {
    out.notifyStates = normalizeNotifyStates(value.notifyStates);
  }
  return out;
}

function validateLarkBot(value) {
  if (!isPlainObject(value)) {
    return { status: "error", message: "larkBot must be a plain object" };
  }
  for (const key of Object.keys(value)) {
    if (![
      "enabled", "appId", "appSecret", "chatId", "region",
      "approvalEnabled", "approvalTimeoutMs", "notifyStates", "minIntervalMs",
      "authMode", "deviceUserOpenId", "deviceUserName",
    ].includes(key)) {
      return { status: "error", message: `larkBot.${key} is not supported` };
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { status: "error", message: "larkBot.enabled must be a boolean" };
  }
  if (value.approvalEnabled !== undefined && typeof value.approvalEnabled !== "boolean") {
    return { status: "error", message: "larkBot.approvalEnabled must be a boolean" };
  }
  if (value.appId !== undefined && typeof value.appId !== "string") {
    return { status: "error", message: "larkBot.appId must be a string" };
  }
  if (value.appSecret !== undefined && typeof value.appSecret !== "string") {
    return { status: "error", message: "larkBot.appSecret must be a string" };
  }
  if (value.chatId !== undefined && typeof value.chatId !== "string") {
    return { status: "error", message: "larkBot.chatId must be a string" };
  }
  if (value.region !== undefined && !VALID_REGIONS.includes(value.region)) {
    return { status: "error", message: `larkBot.region must be one of: ${VALID_REGIONS.join(", ")}` };
  }
  if (value.authMode !== undefined && !VALID_AUTH_MODES.includes(value.authMode)) {
    return { status: "error", message: `larkBot.authMode must be one of: ${VALID_AUTH_MODES.join(", ")}` };
  }
  if (value.deviceUserOpenId !== undefined && typeof value.deviceUserOpenId !== "string") {
    return { status: "error", message: "larkBot.deviceUserOpenId must be a string" };
  }
  if (value.deviceUserName !== undefined && typeof value.deviceUserName !== "string") {
    return { status: "error", message: "larkBot.deviceUserName must be a string" };
  }
  if (value.approvalTimeoutMs !== undefined) {
    if (!Number.isFinite(value.approvalTimeoutMs) || value.approvalTimeoutMs <= 0) {
      return { status: "error", message: "larkBot.approvalTimeoutMs must be a positive number" };
    }
  }
  if (value.notifyStates !== undefined && !Array.isArray(value.notifyStates)) {
    return { status: "error", message: "larkBot.notifyStates must be an array" };
  }
  if (value.minIntervalMs !== undefined) {
    if (!Number.isFinite(value.minIntervalMs) || value.minIntervalMs <= 0) {
      return { status: "error", message: "larkBot.minIntervalMs must be a positive number" };
    }
  }
  return { status: "ok" };
}

function maskLarkAppSecret(secret) {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (!value) return "";
  if (value.length < 10) return "••••";
  return `${value.slice(0, 4)}……${value.slice(-4)}`;
}

// With the WebSocket long-connection, `ready` means "can connect to Feishu"
// (enabled + appId + appSecret). The target chat is auto-bound the first time
// the user messages the bot, so `chatId` no longer gates readiness — it's
// reported separately as `bound`. Until bound, the connection is live but
// approvals can't be pushed yet.
function readiness(config) {
  const normalized = normalizeLarkBot(config);
  if (!normalized.enabled) return { ready: false, bound: false, reason: "disabled", config: normalized };
  if (!normalized.appId) {
    return { ready: false, bound: false, reason: "missing-appid", message: "Lark/Feishu Bot App ID is not configured", config: normalized };
  }
  if (!normalized.appSecret) {
    return { ready: false, bound: false, reason: "missing-secret", message: "Lark/Feishu Bot App Secret is not configured", config: normalized };
  }
  if (!normalized.chatId) {
    return { ready: true, bound: false, reason: "unbound", message: "Send any message to your bot in Feishu/Lark to bind a chat.", config: normalized };
  }
  return { ready: true, bound: true, config: normalized };
}

module.exports = {
  DEFAULT_LARK_BOT,
  LARK_APPID_RE,
  LARK_CHATID_RE,
  VALID_NOTIFY_STATES,
  VALID_REGIONS,
  VALID_AUTH_MODES,
  AUTH_MODE_APP_SECRET,
  AUTH_MODE_DEVICE_CODE,
  REGION_FEISHU,
  REGION_LARK,
  cloneDefaultLarkBot,
  normalizeLarkBot,
  normalizeAuthMode,
  validateLarkBot,
  maskLarkAppSecret,
  isValidLarkAppId,
  isValidLarkChatId,
  readiness,
};
