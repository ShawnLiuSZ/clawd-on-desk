"use strict";

// ── Lark Bot Approval Bridge ──
//
// Bridges Clawd's permission bubble system with Lark interactive cards.
// When a permission request arrives, sends an interactive card to the user's
// Lark chat. When the user clicks Allow/Deny, resolves the pending permEntry.
//
// Follows the same pattern as Telegram and QQ remote approval in permission.js:
// - Parallel channel to desktop bubble (first-to-respond wins)
// - Auto-dismiss the other channel on decision
// - Timeout with no-decision fallback

const crypto = require("crypto");

const DEFAULT_APPROVAL_TIMEOUT_MS = 300000;
const PERM_ID_PREFIX = "lark_";

function generatePermId() {
  return `${PERM_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}

// Short, easy-to-type code for the text-reply fallback ("y AB" / "n AB").
function generateShortCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

// Parse a free-text Lark reply into { behavior, code }. Accepts y/yes/allow/允许
// and n/no/deny/拒绝, optionally followed by a short code. Returns null when the
// message isn't an approval reply.
function parseTextReply(text) {
  const m = String(text || "").trim().match(
    /^(y|yes|allow|ok|n|no|deny|允许|拒绝)(?:\s+([A-Za-z0-9]{1,6}))?\s*$/i
  );
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const behavior = (verb === "n" || verb === "no" || verb === "deny" || verb === "拒绝") ? "deny" : "allow";
  return { behavior, code: m[2] ? m[2].toUpperCase() : "" };
}

function createLarkApprovalBridge(larkBotClient, options = {}) {
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  const getAuthorizedChatId =
    typeof options.getAuthorizedChatId === "function" ? options.getAuthorizedChatId : null;

  // Enforcement is active only when the host wires an anchor getter (production
  // path). With no getter, behave as before (keeps unit tests host-agnostic).
  // Fail-closed: a known getter that returns empty rejects every decision.
  function isAuthorizedSender(senderChatId) {
    if (!getAuthorizedChatId) return true;
    const authorized = String(getAuthorizedChatId() || "").trim();
    if (!authorized) return false;
    return String(senderChatId || "").trim() === authorized;
  }

  const pendingApprovals = new Map();
  const shortCodeToPermId = new Map();

  function start() {
    // Lark uses webhook callbacks, not WebSocket
    // The webhook handler should call handleCardCallback() directly
  }

  function stop() {
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
    sendConfirmation(permEntry, normalized, entry.shortCode);
    resolveFn(permEntry, normalized);
    return entry;
  }

  // Text-reply fallback. With a code, resolve that exact request; without a
  // code, only resolve when exactly one request is pending (avoids ambiguity).
  function handleTextReply(message) {
    const parsed = parseTextReply(message && message.text);
    if (!parsed) return;
    if (!isAuthorizedSender(message && message.chatId)) {
      logFn("lark-approval: ignored text reply from non-authorized sender");
      return;
    }
    let permId = null;
    if (parsed.code) {
      permId = shortCodeToPermId.get(parsed.code) || null;
    } else if (pendingApprovals.size === 1) {
      permId = pendingApprovals.keys().next().value;
    }
    if (!permId) return;
    logFn(`lark-approval: resolved via text reply permId=${permId} behavior=${parsed.behavior}`);
    resolvePending(permId, parsed.behavior);
  }

  function handleCardCallback(event) {
    if (!event || !event.permId) return;
    const entry = pendingApprovals.get(event.permId);
    if (!entry) return;
    if (!isAuthorizedSender(event.chatId)) {
      logFn(`lark-approval: ignored interaction from non-authorized sender for permId=${event.permId}`);
      return;
    }

    logFn(`lark-approval: resolved permId=${event.permId} behavior=${normalizeBehavior(event.action)}`);
    resolvePending(event.permId, event.action);
  }

  function normalizeBehavior(raw) {
    if (typeof raw !== "string") return "deny";
    if (raw === "allow" || raw === "deny") return raw;
    if (raw.startsWith("suggestion:")) return raw;
    if (raw === "deny-and-focus") return raw;
    return "deny";
  }

  function requestApproval(permEntry, resolveFn, config) {
    if (!larkBotClient || typeof larkBotClient.sendCardMessage !== "function") return false;
    if (!larkBotClient.isEnabled()) return false;
    const permId = generatePermId();
    let shortCode = generateShortCode();
    while (shortCodeToPermId.has(shortCode)) shortCode = generateShortCode();
    const timeoutMs = (config && Number.isFinite(config.approvalTimeoutMs))
      ? config.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;

    const entry = {
      permEntry,
      resolveFn,
      permId,
      shortCode,
      timer: setTimeout(() => {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
        logFn(`lark-approval: timed out permId=${permId}`);
      }, timeoutMs),
      createdAt: nowFn(),
    };

    pendingApprovals.set(permId, entry);
    shortCodeToPermId.set(shortCode, permId);

    const payload = buildApprovalPayload(permEntry, permId, shortCode);
    if (!payload) {
      pendingApprovals.delete(permId);
      shortCodeToPermId.delete(shortCode);
      if (entry.timer) clearTimeout(entry.timer);
      return false;
    }

    const card = larkBotClient.buildApprovalCard(payload);
    larkBotClient.sendCardMessage(card).catch((err) => {
      logFn(`lark-approval: send failed: ${err && err.message}`);
    });

    return true;
  }

  function cancelApproval(permEntry) {
    for (const [permId, entry] of pendingApprovals) {
      if (entry.permEntry === permEntry) {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        pendingApprovals.delete(permId);
        if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
        logFn(`lark-approval: cancelled permId=${permId}`);
        return true;
      }
    }
    return false;
  }

  function sendConfirmation(permEntry, behavior, shortCode) {
    if (!larkBotClient || typeof larkBotClient.sendCardMessage !== "function") return;
    const payload = buildConfirmationPayload(permEntry, shortCode);
    if (!payload) return;
    const card = larkBotClient.buildConfirmationCard(payload, behavior);
    larkBotClient.sendCardMessage(card).catch((err) => {
      logFn(`lark-approval: confirmation send failed: ${err && err.message}`);
    });
  }

  function hasPending() {
    return pendingApprovals.size > 0;
  }

  function getPendingCount() {
    return pendingApprovals.size;
  }

  return {
    start,
    stop,
    requestApproval,
    cancelApproval,
    handleCardCallback,
    handleTextReply,
    hasPending,
    getPendingCount,
    _testParseTextReply: parseTextReply,
    _testGetPendingApprovals: () => pendingApprovals,
  };
}

function buildApprovalPayload(permEntry, permId, shortCode) {
  if (!permEntry) return null;
  const toolName = permEntry.toolName || "Unknown";
  const agentName = permEntry.agentName || "unknown";
  const cwd = permEntry.cwd || "";
  const summary = compactApprovalText(formatToolInput(permEntry.toolInput));
  return { permId, shortCode, toolName, agentName, cwd, summary };
}

function buildConfirmationPayload(permEntry, shortCode) {
  if (!permEntry) return null;
  return {
    toolName: permEntry.toolName || "Unknown",
    agentName: permEntry.agentName || "unknown",
    shortCode,
  };
}

function formatToolInput(toolInput) {
  if (!toolInput) return "";
  if (typeof toolInput === "string") return toolInput;
  try {
    return JSON.stringify(toolInput);
  } catch {
    return String(toolInput);
  }
}

function compactApprovalText(text, maxLen = 200) {
  if (typeof text !== "string") return "";
  let t = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > maxLen) t = `${t.slice(0, Math.max(0, maxLen - 1))}…`;
  return t;
}

module.exports = {
  createLarkApprovalBridge,
  parseTextReply,
  generatePermId,
  generateShortCode,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  PERM_ID_PREFIX,
};
