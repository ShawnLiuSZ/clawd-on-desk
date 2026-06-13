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

// ── Elicitation (single/multi-select) over plain text ──
//
// WeChat ilink has no interactive cards/buttons (the protocol only supports
// text/image/voice/file/video items), so single- and multi-select questions
// are rendered as a globally-numbered list. The user replies with the
// number(s); multi-select takes comma/space-separated numbers.

// Flatten all questions' options into one globally-numbered list so a single
// reply like "2" or "1,3" maps unambiguously back to (question, option).
function flattenElicitationOptions(questions) {
  const qs = Array.isArray(questions) ? questions : [];
  const flat = [];
  let no = 0;
  for (let qi = 0; qi < qs.length; qi++) {
    const q = qs[qi];
    if (!q || typeof q.question !== "string" || !q.question) continue;
    const options = Array.isArray(q.options) ? q.options : [];
    for (let oi = 0; oi < options.length; oi++) {
      no += 1;
      const opt = options[oi];
      flat.push({ no, qi, oi, label: (opt && opt.label != null) ? String(opt.label) : `选项${no}` });
    }
  }
  return flat;
}

function buildElicitationRequest(toolInput, shortCode) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];

  const lines = [`[Clawd] 选择请求 [${shortCode}]`];
  let no = 0;
  for (const q of questions) {
    if (!q || typeof q.question !== "string" || !q.question) continue;
    const multi = q.multiSelect ? "（多选）" : "";
    lines.push(`问题: ${q.question}${multi}`);
    const options = Array.isArray(q.options) ? q.options : [];
    for (const opt of options) {
      no += 1;
      lines.push(`  ${no}. ${(opt && opt.label != null) ? String(opt.label) : ""}`);
    }
  }
  lines.push("");
  lines.push(`回复编号选择（多选用逗号，如 "1,3 ${shortCode}"）`);
  return lines.join("\n");
}

// Map selected global numbers back to per-question answer labels. Returns the
// answers map { question: "label" | "label1, label2" } or null when any
// question has no valid selection (mirrors the desktop "all questions
// required" behaviour and blocks resolution on an incomplete reply).
function buildElicitationAnswers(questions, numbers) {
  const qs = Array.isArray(questions) ? questions : [];
  const picks = Array.isArray(numbers) ? numbers : [];
  const flat = flattenElicitationOptions(qs);
  const byNo = new Map(flat.map((f) => [f.no, f]));

  const selByQi = new Map();
  for (const n of picks) {
    const f = byNo.get(n);
    if (!f) continue;
    if (!selByQi.has(f.qi)) selByQi.set(f.qi, []);
    selByQi.get(f.qi).push(f.oi);
  }

  const answers = {};
  for (let qi = 0; qi < qs.length; qi++) {
    const q = qs[qi];
    if (!q || typeof q.question !== "string" || !q.question) continue;
    const options = Array.isArray(q.options) ? q.options : [];
    const sel = selByQi.get(qi) || [];
    if (q.multiSelect) {
      const labels = sel.map((oi) => options[oi] && options[oi].label).filter((l) => l != null && l !== "");
      if (labels.length === 0) return null;
      answers[q.question] = labels.map(String).join(", ");
    } else {
      const oi = sel[0];
      const opt = oi != null ? options[oi] : null;
      if (!opt || opt.label == null || opt.label === "") return null;
      answers[q.question] = String(opt.label);
    }
  }
  return Object.keys(answers).length ? answers : null;
}

function buildElicitationConfirmation(answers, shortCode) {
  const parts = [];
  for (const [q, a] of Object.entries(answers || {})) {
    parts.push(`${q}: ${a}`);
  }
  return `✅ 已提交 [${shortCode}]\n${parts.join("\n")}`;
}

function createWechatApprovalBridge(wechatClient, options = {}) {
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  const pendingApprovals = new Map();
  const shortCodeToPermId = new Map();
  let messageUnsub = null;
  let lastFromUserId = "";

  // Resolve the send target. The bridge may be created lazily (on the first
  // approval) and so have never observed an inbound message itself, while the
  // client has been polling since startup. Prefer the bridge's own capture,
  // fall back to the client's persistent one.
  function resolveTargetUserId() {
    if (lastFromUserId) return lastFromUserId;
    if (typeof wechatClient.getLastFromUserId === "function") {
      return wechatClient.getLastFromUserId() || "";
    }
    return "";
  }

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

  // Find which pending request a reply targets. A token matching a known short
  // code wins; otherwise, when exactly one request is pending, it's that one.
  function matchPendingPermId(tokens) {
    for (const tok of tokens) {
      const code = String(tok || "").toUpperCase();
      if (shortCodeToPermId.has(code)) return shortCodeToPermId.get(code);
    }
    if (pendingApprovals.size === 1) return pendingApprovals.keys().next().value;
    return null;
  }

  function handleTextMessage(message) {
    if (!message || !message.text) return;
    // Always track from_user_id, even for non-reply chatter — it's the send
    // target for future approvals.
    if (message.fromUserId) lastFromUserId = message.fromUserId;

    const text = String(message.text).trim();
    const tokens = text.split(/[\s,，、]+/).filter(Boolean);
    const permId = matchPendingPermId(tokens);
    if (!permId) return;
    const entry = pendingApprovals.get(permId);
    if (!entry) return;

    if (entry.isElicitation) {
      // Numeric tokens are the option selections; the code token (if any) is
      // excluded because it maps to a known pending short code, not an option.
      const numbers = tokens
        .filter((t) => /^\d+$/.test(t) && !shortCodeToPermId.has(t.toUpperCase()))
        .map((t) => parseInt(t, 10));
      if (numbers.length === 0) return;
      const questions = (entry.permEntry && entry.permEntry.toolInput
        && Array.isArray(entry.permEntry.toolInput.questions))
        ? entry.permEntry.toolInput.questions : [];
      const answers = buildElicitationAnswers(questions, numbers);
      if (!answers) {
        // Incomplete / invalid selection — nudge and keep the request pending.
        if (typeof wechatClient.sendTextMessage === "function") {
          const target = resolveTargetUserId();
          if (target) {
            wechatClient.sendTextMessage(
              `请回复有效的选项编号 [${entry.shortCode || ""}]（多选用逗号）`,
              target
            ).catch(() => {});
          }
        }
        return;
      }
      logFn(`wechat-approval: elicitation resolved permId=${permId} answers=${JSON.stringify(answers)}`);
      resolveElicitationPending(permId, answers);
      return;
    }

    const parsed = parseTextReply(text);
    if (!parsed) return;
    logFn(`wechat-approval: resolved via text reply permId=${permId} behavior=${parsed.behavior}`);
    resolvePending(permId, parsed.behavior);
  }

  function resolveElicitationPending(permId, answers) {
    const entry = pendingApprovals.get(permId);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    pendingApprovals.delete(permId);
    if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
    const permEntry = entry.permEntry;
    const resolveFn = entry.resolveFn;
    if (!permEntry || !resolveFn) return;
    if (typeof wechatClient.sendTextMessage === "function") {
      const target = resolveTargetUserId();
      if (target) {
        wechatClient.sendTextMessage(
          buildElicitationConfirmation(answers, entry.shortCode),
          target
        ).catch(() => {});
      }
    }
    resolveFn(permEntry, answers);
  }

  function requestApproval(permEntry, resolveFn, config) {
    if (!wechatClient || typeof wechatClient.sendTextMessage !== "function") return false;
    if (!wechatClient.isEnabled()) return false;

    const fromUserId = resolveTargetUserId();
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

  function requestElicitation(permEntry, resolveFn, config) {
    if (!wechatClient || typeof wechatClient.sendTextMessage !== "function") return false;
    if (!wechatClient.isEnabled()) return false;

    const fromUserId = resolveTargetUserId();
    if (!fromUserId) {
      logFn("wechat-approval: no from_user_id discovered — user must send the bot a message first");
      return false;
    }

    const permId = generatePermId();
    let shortCode = generateShortCode();
    while (shortCodeToPermId.has(shortCode)) shortCode = generateShortCode();

    const timeoutMs = (config && Number.isFinite(config.approvalTimeoutMs))
      ? config.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;

    const text = buildElicitationRequest(permEntry.toolInput, shortCode);

    pendingApprovals.set(permId, {
      permEntry,
      resolveFn,
      shortCode,
      _permId: permId,
      isElicitation: true,
      timer: setTimeout(() => {
        pendingApprovals.delete(permId);
        shortCodeToPermId.delete(shortCode);
        logFn(`wechat-approval: elicitation timed out permId=${permId}`);
      }, timeoutMs),
      createdAt: nowFn(),
    });
    shortCodeToPermId.set(shortCode, permId);

    wechatClient.sendTextMessage(text, fromUserId).catch((err) => {
      logFn(`wechat-approval: elicitation send failed: ${err && err.message}`);
      pendingApprovals.delete(permId);
      shortCodeToPermId.delete(shortCode);
    });

    return true;
  }

  function sendConfirmation(permEntry, behavior, shortCode) {
    if (!wechatClient || typeof wechatClient.sendTextMessage !== "function") return;
    const target = resolveTargetUserId();
    if (!target) return;
    const text = buildConfirmationText(permEntry, behavior, shortCode || "");
    wechatClient.sendTextMessage(text, target).catch(() => {});
  }

  function cancelApproval(permEntry) {
    for (const [permId, entry] of pendingApprovals) {
      if (entry.permEntry === permEntry) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingApprovals.delete(permId);
        if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
        const target = resolveTargetUserId();
        if (wechatClient && typeof wechatClient.sendTextMessage === "function" && target) {
          wechatClient.sendTextMessage(
            `☑️ 请求 [${entry.shortCode || ""}] 已在其他渠道处理`,
            target
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
    requestElicitation,
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
  flattenElicitationOptions,
  buildElicitationRequest,
  buildElicitationAnswers,
  buildElicitationConfirmation,
  createWechatApprovalBridge,
};
