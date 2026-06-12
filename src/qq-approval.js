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
    sendConfirmation(permEntry, normalized, entry.shortCode);
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
    const entry = pendingApprovals.get(event.permId);
    if (!entry) return;

    // Elicitation button clicks encode "elicitation:<qi>:<oi>" in behavior.
    if (entry.isElicitation && event.behavior) {
      if (entry.isElicitationMulti) {
        if (event.behavior === "elicitation-submit") {
          handleElicitationSubmit(entry);
          return;
        }
        if (event.behavior.startsWith("elicitation:")) {
          handleElicitationToggle(entry, event.behavior);
          return;
        }
      } else if (event.behavior.startsWith("elicitation:")) {
        handleElicitationClick(entry, event.behavior);
        return;
      }
    }

    logFn(`qq-approval: resolved permId=${event.permId} behavior=${normalizeBehavior(event.behavior)}`);
    resolvePending(event.permId, event.behavior);
  }

  // Parse an elicitation button click and resolve the entry. For single-question
  // forms this resolves immediately with the selected answer. For multi-question
  // forms, remaining unanswered questions get a "Defer to agent" fallback so the
  // permission resolves rather than hanging.
  function handleElicitationClick(entry, behavior) {
    const parts = behavior.split(":");
    const qi = parseInt(parts[1], 10);
    const oi = parseInt(parts[2], 10);

    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const answers = {};

    // Build answers for ALL questions, using the selected option for the
    // clicked question and "Defer to agent" for the rest.
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q || typeof q.question !== "string" || !q.question) continue;
      if (i === qi) {
        const options = Array.isArray(q.options) ? q.options : [];
        const opt = options[oi];
        answers[q.question] = (opt && opt.label) ? opt.label : `Option ${oi + 1}`;
      } else {
        // Multi-question: fill unanswered with a neutral fallback so the
        // agent receives a complete answer map and doesn't hang.
        answers[q.question] = "Defer to agent";
      }
    }

    logFn(`qq-approval: elicitation resolved permId=${entry._permId || "?"} answers=${JSON.stringify(answers)}`);
    resolveElicitationPending(entry, answers);
  }

  // Multi-select toggle: flip an option (multiSelect) or replace the question's
  // selection (single-select within a multi card = radio), then re-send the card
  // since QQ can't edit a sent message.
  function handleElicitationToggle(entry, behavior) {
    const parts = behavior.split(":");
    const qi = parseInt(parts[1], 10);
    const oi = parseInt(parts[2], 10);
    if (!Number.isInteger(qi) || !Number.isInteger(oi)) return;

    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const q = questions[qi];
    if (!q) return;

    if (!Array.isArray(entry.selections)) entry.selections = questions.map(() => []);
    if (!Array.isArray(entry.selections[qi])) entry.selections[qi] = [];
    const cur = entry.selections[qi];

    if (q.multiSelect) {
      const pos = cur.indexOf(oi);
      if (pos === -1) cur.push(oi);
      else cur.splice(pos, 1);
    } else {
      entry.selections[qi] = [oi]; // single-select within a multi card = radio
    }

    resetElicitationTimer(entry);
    resendElicitationCard(entry, false);
  }

  function handleElicitationSubmit(entry) {
    const answers = buildMultiSelectAnswers(entry);
    if (!answers) {
      resendElicitationCard(entry, true); // 有题未选 → 重发带警告的卡片
      resetElicitationTimer(entry);
      return;
    }
    logFn(`qq-approval: elicitation submitted permId=${entry._permId} answers=${JSON.stringify(answers)}`);
    resolveElicitationPending(entry, answers);
  }

  // Build the answers map QQ submits. Each question's selected option labels are
  // joined with ", " — matching the desktop renderer's getElicitationAnswerText.
  // Returns null if any question has no selection (blocks submit).
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

  function resendElicitationCard(entry, warn) {
    if (!qqBotClient || typeof qqBotClient.sendCardMessage !== "function") return;
    const card = qqBotClient.buildElicitationCard(
      entry.permEntry.toolInput,
      entry._permId,
      entry.shortCode,
      entry.selections,
      warn
    );
    qqBotClient.sendCardMessage(card).catch((err) => {
      logFn(`qq-approval: elicitation re-send failed: ${err && err.message}`);
    });
  }

  function resetElicitationTimer(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    const permId = entry._permId;
    entry.timer = setTimeout(() => {
      pendingApprovals.delete(permId);
      if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
      logFn(`qq-approval: elicitation timed out permId=${permId}`);
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
    resolveFn(permEntry, answers);
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
      _permId: permId,
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

  function requestElicitation(permEntry, resolveFn, config) {
    if (!qqBotClient || typeof qqBotClient.buildElicitationCard !== "function") return false;
    if (!qqBotClient.isEnabled()) return false;
    if (typeof qqBotClient.sendCardMessage !== "function") return false;

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

    const card = qqBotClient.buildElicitationCard(
      permEntry.toolInput,
      permId,
      shortCode,
      selections
    );

    pendingApprovals.set(permId, {
      permEntry,
      resolveFn,
      shortCode,
      _permId: permId,
      isElicitation: true,
      isElicitationMulti: isMulti,
      selections,
      timeoutMs,
      timer: setTimeout(() => {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
        logFn(`qq-approval: elicitation timed out permId=${permId}`);
      }, timeoutMs),
      createdAt: nowFn(),
    });
    shortCodeToPermId.set(shortCode, permId);

    qqBotClient.sendCardMessage(card).catch((err) => {
      logFn(`qq-approval: elicitation card send failed: ${err && err.message}`);
      pendingApprovals.delete(permId);
      shortCodeToPermId.delete(shortCode);
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

  function sendConfirmation(permEntry, behavior, shortCode) {
    if (!qqBotClient || typeof qqBotClient.sendCardMessage !== "function") return;
    const card = qqBotClient.buildConfirmationCard(
      permEntry.toolName,
      behavior === "allow" ? "allow" : "deny",
      shortCode || ""
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
    requestElicitation,
    cancelApproval,
    hasPending,
    pendingCount,
    _testHandleInteraction: handleInteraction,
    _testHandleTextReply: handleTextReply,
    _testGetFirstPermId: () => {
      for (const [key] of pendingApprovals) return key;
      return null;
    },
    _testGetFirstEntry: () => {
      for (const [, entry] of pendingApprovals) return entry;
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
