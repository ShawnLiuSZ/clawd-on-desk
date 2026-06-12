"use strict";

// ── QQ Bot Approval Bridge ──
//
// Bridges Clawd's permission bubble system with QQ Bot interactive cards.
// When a permission request arrives, sends an interactive card to the user's
// QQ DM. When the user clicks Allow/Deny, resolves the pending permEntry.
//
// Follows the same pattern as Telegram remote approval in permission.js:
// - Parallel channel to desktop bubble (first-to-respond wins)
// - Auto-dismiss the other channel on decision
// - Timeout with no-decision fallback

const crypto = require("crypto");

const DEFAULT_APPROVAL_TIMEOUT_MS = 300000;
const PERM_ID_PREFIX = "qq_";

function generatePermId() {
  return `${PERM_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}

// Short, easy-to-type code for the text-reply fallback ("y AB" / "n AB").
function generateShortCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

// Parse a free-text QQ reply into { behavior, code }. Accepts y/yes/allow/允许
// and n/no/deny/拒绝, optionally followed by a short code. Returns null when the
// message isn't an approval reply.
function parseTextReply(text) {
  // No \b after the verb: it doesn't form a boundary next to CJK chars, so it
  // would reject "允许". Instead require end-of-string or a space + short code.
  const m = String(text || "").trim().match(/^(y|yes|allow|ok|n|no|deny|允许|拒绝)(?:\s+([A-Za-z0-9]{1,6}))?\s*$/i);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const behavior = (verb === "n" || verb === "no" || verb === "deny" || verb === "拒绝") ? "deny" : "allow";
  return { behavior, code: m[2] ? m[2].toUpperCase() : "" };
}

function createQQApprovalBridge(qqBotClient, options = {}) {
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  const pendingApprovals = new Map();
  const shortCodeToPermId = new Map();
  let interactionUnsub = null;
  let messageUnsub = null;

  function start() {
    if (interactionUnsub) return;
    interactionUnsub = qqBotClient.onInteraction(handleInteraction);
    if (typeof qqBotClient.onMessage === "function") {
      messageUnsub = qqBotClient.onMessage(handleTextReply);
    }
  }

  function stop() {
    if (interactionUnsub) { interactionUnsub(); interactionUnsub = null; }
    if (messageUnsub) { messageUnsub(); messageUnsub = null; }
    for (const entry of pendingApprovals.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    pendingApprovals.clear();
    shortCodeToPermId.clear();
  }

  // Resolve a pending approval by permId, running the shared cleanup. Returns
  // the entry (or null). Used by both the button callback and text replies.
  function resolvePending(permId, behavior) {
    const entry = pendingApprovals.get(permId);
    if (!entry) return null;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    pendingApprovals.delete(permId);
    if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
    const permEntry = entry.permEntry;
    const resolveFn = entry.resolveFn;
    if (!permEntry || !resolveFn) return null;
    const normalized = normalizeBehavior(behavior);
    sendConfirmation(permEntry, normalized);
    resolveFn(permEntry, normalized);
    return entry;
  }

  // Text-reply fallback. With a code, resolve that exact request; without a
  // code, only resolve when exactly one request is pending (avoids ambiguity).
  function handleTextReply(message) {
    const parsed = parseTextReply(message && message.text);
    if (!parsed) return;
    let permId = null;
    if (parsed.code) {
      permId = shortCodeToPermId.get(parsed.code) || null;
    } else if (pendingApprovals.size === 1) {
      permId = pendingApprovals.keys().next().value;
    }
    if (!permId) return;
    logFn(`qq-approval: resolved via text reply permId=${permId} behavior=${parsed.behavior}`);
    resolvePending(permId, parsed.behavior);
  }

  function handleInteraction(event) {
    if (!event || !event.permId) return;
    if (!pendingApprovals.has(event.permId)) return;
    logFn(`qq-approval: resolved permId=${event.permId} behavior=${normalizeBehavior(event.behavior)}`);
    resolvePending(event.permId, event.behavior);
  }

  function normalizeBehavior(raw) {
    if (typeof raw !== "string") return "deny";
    if (raw === "allow" || raw === "deny") return raw;
    if (raw.startsWith("suggestion:")) return raw;
    if (raw === "deny-and-focus") return raw;
    return "deny";
  }

  function requestApproval(permEntry, resolveFn, config) {
    if (!qqBotClient || typeof qqBotClient.sendCardMessage !== "function") return false;
    if (!qqBotClient.isEnabled()) return false;
    const permId = generatePermId();
    let shortCode = generateShortCode();
    while (shortCodeToPermId.has(shortCode)) shortCode = generateShortCode();
    const timeoutMs = (config && Number.isFinite(config.approvalTimeoutMs))
      ? config.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;
    const card = qqBotClient.buildApprovalCard(
      permEntry.toolName,
      permEntry.toolInput,
      permEntry.sessionId,
      permId,
      permEntry.suggestions,
      shortCode
    );
    pendingApprovals.set(permId, {
      permEntry,
      resolveFn,
      shortCode,
      timer: setTimeout(() => {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
        logFn(`qq-approval: timed out permId=${permId}`);
      }, timeoutMs),
      createdAt: nowFn(),
    });
    shortCodeToPermId.set(shortCode, permId);
    qqBotClient.sendCardMessage(card).catch((err) => {
      logFn(`qq-approval: card send failed: ${err && err.message} — trying plain text`);
      // Fall back to a plain-text request (msg_type 0 always works, even for
      // bots without raw-markdown/button capability) so the user can still
      // reply y/n. Only drop the pending entry if text also fails.
      if (typeof qqBotClient.sendTextMessage === "function") {
        qqBotClient.sendTextMessage(buildTextRequest(permEntry, shortCode)).catch((err2) => {
          pendingApprovals.delete(permId);
          shortCodeToPermId.delete(shortCode);
          logFn(`qq-approval: text fallback also failed: ${err2 && err2.message}`);
        });
      } else {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
      }
    });
    return true;
  }

  function buildTextRequest(permEntry, shortCode) {
    const tool = permEntry && permEntry.toolName ? String(permEntry.toolName) : "unknown";
    const ti = permEntry && permEntry.toolInput;
    let detail = "";
    if (ti && typeof ti === "object") {
      if (ti.command) detail = String(ti.command);
      else if (ti.new_string != null) detail = `${ti.file_path || ""} → ${String(ti.new_string)}`;
      else if (ti.content != null) detail = `${ti.file_path || ""}: ${String(ti.content)}`;
      else if (ti.file_path) detail = String(ti.file_path);
      else if (ti.pattern || ti.query) detail = String(ti.pattern || ti.query);
    }
    return [
      `🔐 权限请求 [${shortCode}]`,
      `工具: ${tool}`,
      detail ? `内容: ${detail.replace(/\s+/g, " ").slice(0, 400)}` : null,
      `回复 "y ${shortCode}" 允许 / "n ${shortCode}" 拒绝`,
    ].filter(Boolean).join("\n");
  }

  function sendConfirmation(permEntry, behavior) {
    if (!qqBotClient || typeof qqBotClient.sendCardMessage !== "function") return;
    const card = qqBotClient.buildConfirmationCard(
      permEntry.toolName,
      behavior === "allow" ? "allow" : "deny",
      ""
    );
    qqBotClient.sendCardMessage(card).catch(() => {});
  }

  function cancelApproval(permEntry) {
    for (const [permId, entry] of pendingApprovals) {
      if (entry.permEntry === permEntry) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingApprovals.delete(permId);
        if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
        // Another channel (desktop bubble / terminal) resolved it — tell QQ so
        // the now-stale card isn't mistaken for still-actionable. A later tap on
        // it is already a no-op (entry gone) and gets ACKed by the client.
        if (typeof qqBotClient.sendTextMessage === "function") {
          qqBotClient.sendTextMessage(`☑️ 请求 [${entry.shortCode || ""}] 已在其他渠道处理，此卡片已失效`).catch(() => {});
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

  return {
    start,
    stop,
    requestApproval,
    cancelApproval,
    hasPending,
    pendingCount,
    _testHandleInteraction: handleInteraction,
    _testHandleTextReply: handleTextReply,
    _testGetFirstPermId: () => {
      for (const [key] of pendingApprovals) return key;
      return null;
    },
  };
}

module.exports = {
  PERM_ID_PREFIX,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  generatePermId,
  generateShortCode,
  parseTextReply,
  createQQApprovalBridge,
};
