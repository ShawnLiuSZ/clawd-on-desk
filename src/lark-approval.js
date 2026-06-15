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

  // Returns the Feishu card-callback response object (an in-place card update for
  // elicitation toggles, a toast otherwise) so the WS layer can send it back.
  function handleCardCallback(event) {
    if (!event || !event.permId) return undefined;
    const entry = pendingApprovals.get(event.permId);
    if (!entry) return undefined;
    if (!isAuthorizedSender(event.chatId)) {
      logFn(`lark-approval: ignored interaction from non-authorized sender for permId=${event.permId}`);
      return undefined;
    }

    // Elicitation button clicks encode "elicitation:<qi>:<oi>" or "elicitation-submit".
    const action = event.action;
    if (entry.isElicitation && typeof action === "string") {
      if (entry.isElicitationMulti) {
        if (action === "elicitation-submit") return handleElicitationSubmit(entry);
        if (action.startsWith("elicitation:")) return handleElicitationToggle(entry, action);
      } else if (action.startsWith("elicitation:")) {
        return handleElicitationClick(entry, action);
      }
      return undefined;
    }

    const shortCode = entry.shortCode || "";
    const decision = normalizeBehavior(action);
    logFn(`lark-approval: resolved permId=${event.permId} behavior=${decision}`);
    resolvePending(event.permId, action);
    // Toast tells the tapper exactly which short code was acted on (anti-duplicate).
    const mark = decision === "allow" ? "✅" : "❌";
    return { toast: { type: decision === "allow" ? "success" : "info", content: `${mark} ${shortCode}`.trim() } };
  }

  // ── Elicitation (multi-select / AskUserQuestion) ──
  // Ported from qq-approval.js, but Feishu updates the card in place via the
  // callback response instead of QQ's re-send (QQ's C2C API is send-only).

  function buildElicitationUpdate(entry, warn) {
    if (!larkBotClient || typeof larkBotClient.buildElicitationCard !== "function") return undefined;
    const card = larkBotClient.buildElicitationCard(
      entry.permEntry.toolInput,
      entry._permId,
      entry.shortCode,
      entry.selections,
      warn
    );
    if (typeof larkBotClient.buildCardUpdateResponse === "function") {
      return larkBotClient.buildCardUpdateResponse(card);
    }
    return undefined;
  }

  // Single-select fast path: a click resolves immediately. The clicked question
  // gets the selected label; any other questions get "Defer to agent" so the
  // agent receives a complete answer map and doesn't hang.
  function handleElicitationClick(entry, behavior) {
    const parts = behavior.split(":");
    const qi = parseInt(parts[1], 10);
    const oi = parseInt(parts[2], 10);
    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const answers = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q || typeof q.question !== "string" || !q.question) continue;
      if (i === qi) {
        const options = Array.isArray(q.options) ? q.options : [];
        const opt = options[oi];
        answers[q.question] = (opt && opt.label) ? opt.label : `Option ${oi + 1}`;
      } else {
        answers[q.question] = "Defer to agent";
      }
    }
    const sc = entry.shortCode || "";
    logFn(`lark-approval: elicitation resolved permId=${entry._permId || "?"}`);
    resolveElicitationPending(entry, answers);
    return { toast: { type: "success", content: `✅ ${sc}`.trim() } };
  }

  // Multi-select: flip an option (multiSelect) or radio-replace (single within a
  // multi card), then return an updated card so Feishu re-renders the ✓ marks.
  function handleElicitationToggle(entry, behavior) {
    const parts = behavior.split(":");
    const qi = parseInt(parts[1], 10);
    const oi = parseInt(parts[2], 10);
    if (!Number.isInteger(qi) || !Number.isInteger(oi)) return undefined;
    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const q = questions[qi];
    if (!q) return undefined;
    if (!Array.isArray(entry.selections)) entry.selections = questions.map(() => []);
    if (!Array.isArray(entry.selections[qi])) entry.selections[qi] = [];
    const cur = entry.selections[qi];
    if (q.multiSelect) {
      const pos = cur.indexOf(oi);
      if (pos === -1) cur.push(oi);
      else cur.splice(pos, 1);
    } else {
      entry.selections[qi] = [oi];
    }
    resetElicitationTimer(entry);
    return buildElicitationUpdate(entry, false);
  }

  function handleElicitationSubmit(entry) {
    const answers = buildMultiSelectAnswers(entry);
    if (!answers) {
      resetElicitationTimer(entry);
      return buildElicitationUpdate(entry, true); // 有题未选 → 带警告重渲染
    }
    const sc = entry.shortCode || "";
    logFn(`lark-approval: elicitation submitted permId=${entry._permId}`);
    resolveElicitationPending(entry, answers);
    return { toast: { type: "success", content: `✅ ${sc}`.trim() } };
  }

  // Selected labels joined with ", ", keyed by question text. null if any
  // question has no selection (blocks submit).
  function buildMultiSelectAnswers(entry) {
    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const selections = Array.isArray(entry.selections) ? entry.selections : [];
    const answers = {};
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      if (!q || typeof q.question !== "string" || !q.question) continue;
      const options = Array.isArray(q.options) ? q.options : [];
      const sel = Array.isArray(selections[qi]) ? selections[qi] : [];
      const labels = [];
      for (const oi of sel) {
        const opt = options[oi];
        if (opt && opt.label) labels.push(opt.label);
      }
      if (labels.length === 0) return null;
      answers[q.question] = labels.join(", ");
    }
    return answers;
  }

  function resetElicitationTimer(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    const permId = entry._permId;
    entry.timer = setTimeout(() => {
      pendingApprovals.delete(permId);
      if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
      logFn(`lark-approval: elicitation timed out permId=${permId}`);
    }, entry.timeoutMs || DEFAULT_APPROVAL_TIMEOUT_MS);
  }

  function resolveElicitationPending(entry, answers) {
    const permId = entry._permId;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    pendingApprovals.delete(permId);
    if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
    const permEntry = entry.permEntry;
    const resolveFn = entry.resolveFn;
    if (!permEntry || !resolveFn) return;
    sendConfirmation(permEntry, "allow", entry.shortCode);
    // permission.js resolvePermissionEntry maps this object to updatedInput.answers.
    resolveFn(permEntry, { type: "elicitation-submit", answers });
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

  function requestElicitation(permEntry, resolveFn, config) {
    if (!larkBotClient || typeof larkBotClient.buildElicitationCard !== "function") return false;
    if (!larkBotClient.isEnabled()) return false;
    if (typeof larkBotClient.sendCardMessage !== "function") return false;

    const permId = generatePermId();
    let shortCode = generateShortCode();
    while (shortCodeToPermId.has(shortCode)) shortCode = generateShortCode();
    const timeoutMs = (config && Number.isFinite(config.approvalTimeoutMs))
      ? config.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;

    const questions = (permEntry.toolInput && Array.isArray(permEntry.toolInput.questions))
      ? permEntry.toolInput.questions : [];
    const isMulti = questions.some((q) => q && q.multiSelect);
    const selections = isMulti ? questions.map(() => []) : null;

    const card = larkBotClient.buildElicitationCard(permEntry.toolInput, permId, shortCode, selections, false);

    pendingApprovals.set(permId, {
      permEntry,
      resolveFn,
      permId,
      _permId: permId,
      shortCode,
      isElicitation: true,
      isElicitationMulti: isMulti,
      selections,
      timeoutMs,
      timer: setTimeout(() => {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
        logFn(`lark-approval: elicitation timed out permId=${permId}`);
      }, timeoutMs),
      createdAt: nowFn(),
    });
    shortCodeToPermId.set(shortCode, permId);

    larkBotClient.sendCardMessage(card).catch((err) => {
      logFn(`lark-approval: elicitation card send failed: ${err && err.message}`);
      pendingApprovals.delete(permId);
      shortCodeToPermId.delete(shortCode);
    });

    return true;
  }

  function cancelApproval(permEntry) {
    for (const [permId, entry] of pendingApprovals) {
      if (entry.permEntry === permEntry) {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        pendingApprovals.delete(permId);
        if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
        // Another channel (desktop bubble / terminal / QQ / WeChat) resolved it
        // first — post a notice so the now-stale Lark card isn't mistaken for
        // actionable, matching the QQ/WeChat cross-channel behaviour. A later tap
        // on the stale card is already a no-op (entry gone).
        if (typeof larkBotClient.sendTextMessage === "function") {
          larkBotClient.sendTextMessage(`☑️ 请求 [${entry.shortCode || ""}] 已在其他渠道处理`).catch(() => {});
        }
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
    requestElicitation,
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
