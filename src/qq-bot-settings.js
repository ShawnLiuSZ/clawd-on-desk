"use strict";

const DEFAULT_QQ_BOT = Object.freeze({
  enabled: false,
  appId: "",
  appSecret: "",
  userOpenid: "",
  approvalEnabled: true,
  approvalTimeoutMs: 300000,
  notifyStates: ["attention", "error"],
  minIntervalMs: 5000,
});

const QQ_APPID_RE = /^\d{6,20}$/;
const QQ_OPENID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_NOTIFY_STATES = Object.freeze([
  "attention", "error", "notification", "sleeping",
]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultQQBot() {
  return { ...DEFAULT_QQ_BOT };
}

function trimString(value, maxLen = 256) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function isValidQQAppId(value) {
  return QQ_APPID_RE.test(String(value || "").trim());
}

function isValidQQOpenid(value) {
  return QQ_OPENID_RE.test(String(value || "").trim());
}

function normalizeNotifyStates(value) {
  if (!Array.isArray(value)) return [...DEFAULT_QQ_BOT.notifyStates];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && VALID_NOTIFY_STATES.includes(item) && !out.includes(item)) {
      out.push(item);
    }
  }
  return out.length ? out : [...DEFAULT_QQ_BOT.notifyStates];
}

function normalizeQQBot(value, defaultsValue = DEFAULT_QQ_BOT) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_QQ_BOT;
  const out = {
    enabled: defaults.enabled === true,
    appId: trimString(defaults.appId, 64),
    appSecret: trimString(defaults.appSecret, 512),
    userOpenid: trimString(defaults.userOpenid, 64),
    approvalEnabled: defaults.approvalEnabled !== false,
    approvalTimeoutMs: Number.isFinite(defaults.approvalTimeoutMs) && defaults.approvalTimeoutMs > 0
      ? Math.min(defaults.approvalTimeoutMs, 600000)
      : DEFAULT_QQ_BOT.approvalTimeoutMs,
    notifyStates: normalizeNotifyStates(defaults.notifyStates),
    minIntervalMs: Number.isFinite(defaults.minIntervalMs) && defaults.minIntervalMs > 0
      ? Math.max(defaults.minIntervalMs, 1000)
      : DEFAULT_QQ_BOT.minIntervalMs,
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.approvalEnabled === "boolean") out.approvalEnabled = value.approvalEnabled;
  if (typeof value.appId === "string") {
    const candidate = trimString(value.appId, 64);
    out.appId = isValidQQAppId(candidate) ? candidate : "";
  }
  if (typeof value.appSecret === "string") {
    out.appSecret = trimString(value.appSecret, 512);
  }
  if (typeof value.userOpenid === "string") {
    const candidate = trimString(value.userOpenid, 64);
    out.userOpenid = isValidQQOpenid(candidate) ? candidate : "";
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

function validateQQBot(value) {
  if (!isPlainObject(value)) {
    return { status: "error", message: "qqBot must be a plain object" };
  }
  for (const key of Object.keys(value)) {
    if (![
      "enabled", "appId", "appSecret", "userOpenid",
      "approvalEnabled", "approvalTimeoutMs", "notifyStates", "minIntervalMs",
    ].includes(key)) {
      return { status: "error", message: `qqBot.${key} is not supported` };
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { status: "error", message: "qqBot.enabled must be a boolean" };
  }
  if (value.approvalEnabled !== undefined && typeof value.approvalEnabled !== "boolean") {
    return { status: "error", message: "qqBot.approvalEnabled must be a boolean" };
  }
  if (value.appId !== undefined && typeof value.appId !== "string") {
    return { status: "error", message: "qqBot.appId must be a string" };
  }
  if (value.appSecret !== undefined && typeof value.appSecret !== "string") {
    return { status: "error", message: "qqBot.appSecret must be a string" };
  }
  if (value.userOpenid !== undefined && typeof value.userOpenid !== "string") {
    return { status: "error", message: "qqBot.userOpenid must be a string" };
  }
  if (value.approvalTimeoutMs !== undefined) {
    if (!Number.isFinite(value.approvalTimeoutMs) || value.approvalTimeoutMs <= 0) {
      return { status: "error", message: "qqBot.approvalTimeoutMs must be a positive number" };
    }
  }
  if (value.notifyStates !== undefined && !Array.isArray(value.notifyStates)) {
    return { status: "error", message: "qqBot.notifyStates must be an array" };
  }
  if (value.minIntervalMs !== undefined) {
    if (!Number.isFinite(value.minIntervalMs) || value.minIntervalMs <= 0) {
      return { status: "error", message: "qqBot.minIntervalMs must be a positive number" };
    }
  }
  return { status: "ok" };
}

function maskQQAppSecret(secret) {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (!value) return "";
  if (value.length < 10) return "••••";
  return `${value.slice(0, 4)}……${value.slice(-4)}`;
}

function readiness(config) {
  const normalized = normalizeQQBot(config);
  if (!normalized.enabled) return { ready: false, reason: "disabled", config: normalized };
  if (!normalized.appId) {
    return { ready: false, reason: "missing-appid", message: "QQ Bot AppID is not configured", config: normalized };
  }
  if (!normalized.appSecret) {
    return { ready: false, reason: "missing-secret", message: "QQ Bot AppSecret is not configured", config: normalized };
  }
  return { ready: true, config: normalized };
}

module.exports = {
  DEFAULT_QQ_BOT,
  QQ_APPID_RE,
  QQ_OPENID_RE,
  VALID_NOTIFY_STATES,
  cloneDefaultQQBot,
  normalizeQQBot,
  validateQQBot,
  maskQQAppSecret,
  isValidQQAppId,
  isValidQQOpenid,
  readiness,
};
