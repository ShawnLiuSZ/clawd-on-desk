"use strict";

// ── WeChat Approval Bridge ──
//
// Bridges Clawd's permission bubble system with WeChat ilink text messages.
// When a permission request arrives, sends a plain-text approval request to
// the user's WeChat DM. User replies "y" / "n" to approve or deny.
//
// Follows the same pattern as QQ remote approval:
// - Parallel channel to desktop bubble (first-to-respond wins)
// - Auto-dismiss the other channel on decision
// - Timeout with no-decision fallback
//
// Differences from QQ:
//   - Text-only (no interactive cards — WeChat personal doesn't support them)
//   - Uses ilink HTTP long-polling instead of WebSocket
//   - context_token from the client is required for every send

const crypto = require("crypto");

const DEFAULT_APPROVAL_TIMEOUT_MS = 300000;
const PERM_ID_PREFIX = "wx_";

function generatePermId() {
  return `${PERM_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}

function generateShortCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

// Parse a free-text WeChat reply into { behavior, code }.
// Accepts y/yes/allow/ok/允许 and n/no/deny/拒绝, optionally followed by a
// short code. Returns null when the message isn't an approval reply.
function parseTextReply(text) {
  const m = String(text || "").trim().match(
    /^(y|yes|allow|ok|n|no|deny|允许|拒绝)(?:\s+([A-Za-z0-9]{1,6}))?\s*$/i
  );
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const behavior = (
    verb === "n" || verb === "no" || verb === "deny" || verb === "拒绝"
  ) ? "deny" : "allow";
  return { behavior, code: m[2] ? m[2].toUpperCase() : "" };
}

// Build the plain-text approval request message.
// WeChat personal doesn't support markdown/cards, so we format with plain text.
function buildTextRequest(permEntry, shortCode) {
  const tool = (permEntry && permEntry.toolName) ? String(permEntry.toolName) : "unknown";
  const ti = permEntry && permEntry.toolInput;
  let detail = "";
  if (ti && typeof ti === "object") {
    if (ti.file_path) detail = `\n文件: ${String(ti.file_path)}`;
    if (ti.command) detail = `\n命令: ${String(ti.command).replace(/\s+/g, " ").slice(0, 300)}`;
    else if (ti.new_string != null) detail = `\n修改: ${String(ti.file_path || "")} ${String(ti.new_string).slice(0, 200)}`;
    else if (ti.content != null) detail = `\n内容: ${String(ti.content).slice(0, 200)}`;
    else if (ti.pattern || ti.query) detail = `\n查询: ${String(ti.pattern || ti.query).slice(0, 200)}`;
  }
  const sessionId = permEntry && permEntry.sessionId
    ? String(permEntry.sessionId).slice(-6) : "—";

  const lines = [
    `[Clawd] 权限请求 [${shortCode}]`,
    `工具: ${tool}`,
    detail ? `详情:${detail}` : null,
    `会话: ${sessionId}`,
    ``,
    `回复 "y ${shortCode}" 允许 / "n ${shortCode}" 拒绝`,
  ].filter(Boolean);

  return lines.join("\n");
}

function buildConfirmationText(permEntry, behavior, shortCode) {
  const tool = (permEntry && permEntry.toolName) ? String(permEntry.toolName) : "unknown";
  const emoji = behavior === "allow" ? "✅" : "❌";
  const label = behavior === "allow" ? "已允许" : "已拒绝";
  return `${emoji} ${label} [${shortCode}]\n工具: ${tool}`;
}

function createWechatApprovalBridge(wechatClient, options = {}) {
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  const pendingApprovals = new Map();
  const shortCodeToPermId = new Map();
  let messageUnsub = null;
  let lastFromUserId = "";

  function start() {
    if (messageUnsub) return;
    // Subscribe to text message events from the ilink client
    if (typeof wechatClient.onTextMessage === "function") {
      messageUnsub = wechatClient.onTextMessage(handleTextMessage);
    }
    // Start polling if not already running
    if (typeof wechatClient.startPolling === "function" && !wechatClient.isConnected()) {
      wechatClient.startPolling().catch((err) => {
        logFn(`wechat-approval: start poll failed: ${err && err.message}`);
      });
    }
  }

  function stop() {
    if (messageUnsub) { messageUnsub(); messageUnsub = null; }
    for (const entry of pendingApprovals.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    pendingApprovals.clear();
    shortCodeToPermId.clear();
  }

  function resolvePending(permId, behavior) {
    const entry = pendingApprovals.get(permId);
    if (!entry) return null;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    pendingApprovals.delete(permId);
    if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
    const permEntry = entry.permEntry;
    const resolveFn = entry.resolveFn;
    if (!permEntry || !resolveFn) return null;
    const normalized = behavior === "allow" || behavior === "deny" ? behavior : "deny";
    sendConfirmation(permEntry, normalized, entry.shortCode);
    resolveFn(permEntry, normalized);
    return entry;
  }

  function handleTextMessage(message) {
    if (!message || !message.text) return;
    const parsed = parseTextReply(message.text);
    if (!parsed) {
      // Could be a non-approval message — track the from_user_id for
      // future use but don't try to match it to an approval request.
      if (message.fromUserId) lastFromUserId = message.fromUserId;
      return;
    }

    // Track from_user_id
    if (message.fromUserId) lastFromUserId = message.fromUserId;

    let permId = null;
    if (parsed.code) {
      permId = shortCodeToPermId.get(parsed.code) || null;
    } else if (pendingApprovals.size === 1) {
      // No code but only one pending — resolve that one
      permId = pendingApprovals.keys().next().value;
    }

    if (!permId) return;
    logFn(`wechat-approval: resolved via text reply permId=${permId} behavior=${parsed.behavior}`);
    resolvePending(permId, parsed.behavior);
  }

  function requestApproval(permEntry, resolveFn, config) {
    if (!wechatClient || typeof wechatClient.sendTextMessage !== "function") return false;
    if (!wechatClient.isEnabled()) return false;

    const fromUserId = lastFromUserId;
    if (!fromUserId) {
      // Need user to send the bot a message first so we can discover
      // their user ID and get context_token.
      logFn("wechat-approval: no from_user_id discovered — user must send the bot a message first");
      return false;
    }

    const permId = generatePermId();
    let shortCode = generateShortCode();
    while (shortCodeToPermId.has(shortCode)) shortCode = generateShortCode();

    const timeoutMs = (config && Number.isFinite(config.approvalTimeoutMs))
      ? config.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;

    const text = buildTextRequest(permEntry, shortCode);

    pendingApprovals.set(permId, {
      permEntry,
      resolveFn,
      shortCode,
      _permId: permId,
      timer: setTimeout(() => {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
        logFn(`wechat-approval: timed out permId=${permId}`);
      }, timeoutMs),
      createdAt: nowFn(),
    });
    shortCodeToPermId.set(shortCode, permId);

    wechatClient.sendTextMessage(text, fromUserId).catch((err) => {
      logFn(`wechat-approval: send failed: ${err && err.message}`);
      pendingApprovals.delete(permId);
      shortCodeToPermId.delete(shortCode);
    });

    return true;
  }

  function sendConfirmation(permEntry, behavior, shortCode) {
    if (!wechatClient || typeof wechatClient.sendTextMessage !== "function") return;
    if (!lastFromUserId) return;
    const text = buildConfirmationText(permEntry, behavior, shortCode || "");
    wechatClient.sendTextMessage(text, lastFromUserId).catch(() => {});
  }

  function cancelApproval(permEntry) {
    for (const [permId, entry] of pendingApprovals) {
      if (entry.permEntry === permEntry) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingApprovals.delete(permId);
        if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
        if (wechatClient && typeof wechatClient.sendTextMessage === "function" && lastFromUserId) {
          wechatClient.sendTextMessage(
            `☑️ 请求 [${entry.shortCode || ""}] 已在其他渠道处理`,
            lastFromUserId
          ).catch(() => {});
        }
        break;
      }
    }
  }

  function hasPending() {
    return pendingApprovals.size > 0;
  }

  function pendingCount() {
    return pendingApprovals.size;
  }

  // Calling start() is idempotent — it subscribes the text-reply listener and
  // ensures polling is running. It MUST be called before requestApproval() so
  // callbacks are delivered.
  return {
    start,
    stop,
    requestApproval,
    cancelApproval,
    hasPending,
    pendingCount,
    _testHandleTextMessage: handleTextMessage,
    _testGetFirstPermId: () => {
      for (const [key] of pendingApprovals) return key;
      return null;
    },
    _testGetFirstEntry: () => {
      for (const [, entry] of pendingApprovals) return entry;
      return null;
    },
    _testParseTextReply: parseTextReply,
    _testBuildTextRequest: buildTextRequest,
  };
}

module.exports = {
  PERM_ID_PREFIX,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  generatePermId,
  generateShortCode,
  parseTextReply,
  buildTextRequest,
  buildConfirmationText,
  createWechatApprovalBridge,
};
