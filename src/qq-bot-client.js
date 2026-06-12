"use strict";

// ── QQ Bot Client — Token management + HTTP API + WebSocket ──
//
// Connects to the official QQ Bot API (q.qq.com) using AppID / AppSecret.
// Provides:
//   - Automatic access_token refresh (7200s TTL, 5-min early renewal)
//   - C2C (private) message sending with card support
//   - WebSocket event listener for INTERACTION_CREATE (button callbacks)
//
// Constraints:
//   - All HTTP calls are fire-and-forget where possible
//   - No Electron dependencies — pure Node.js (testable in isolation)
//   - WebSocket reconnection is handled internally

const https = require("https");
const http = require("http");
const { URL } = require("url");

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";
const WS_GATEWAY_URL = "https://api.sgroup.qq.com/gateway";
const WS_GATEWAY_SANDBOX = "https://sandbox.api.sgroup.qq.com/gateway";

const INTENTS_C2C = 1 << 25;
const INTENTS_INTERACTION = 1 << 26;
// Subscribe ONLY to C2C/group private messages (1<<25) and interactions
// (1<<26). Per the QQ Bot docs, passing an intent the bot is not authorized
// for makes the gateway error and close the WebSocket immediately on Identify.
// GUILD_MESSAGES (1<<9, private-domain bots only) and DIRECT_MESSAGE (1<<12)
// require separate approval that a normal C2C/group bot does not have — adding
// them as "fallback" intents kills the connection and prevents openid discovery.
const DEFAULT_INTENTS = INTENTS_C2C | INTENTS_INTERACTION;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const HEARTBEAT_BUFFER_MS = 5000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 20;

function compactLog(text, maxLen = 200) {
  let t = String(text == null ? "" : text);
  t = t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\b\d{6,20}\b/g, "<redacted:appid>");
  t = t.replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
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

function httpPut(url, body, options = {}) {
  return httpRequestWithBody("PUT", url, body, options);
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

function createQQBotClient(config, options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const WebSocketCtor = options.WebSocket || null;
  const httpPostFn = options.httpPost || httpPost;
  const httpPutFn = options.httpPut || httpPut;

  let appId = config.appId || "";
  let appSecret = config.appSecret || "";
  let userOpenid = config.userOpenid || "";
  let sandbox = options.sandbox === true;

  let cachedToken = null;
  let tokenExpiresAt = 0;
  let tokenPromise = null;

  let ws = null;
  let wsHeartbeatInterval = null;
  let wsHeartbeatTimeout = null;
  let wsReconnectTimer = null;
  let wsReconnectAttempts = 0;
  let wsSessionId = null;
  let wsConnected = false;
  let wsIdentifySent = false;
  let wsLastSeq = null;
  let wsGatewayUrl = null;

  const interactionListeners = new Set();
  const openidChangeListeners = new Set();
  const messageListeners = new Set();

  function getBaseUrl() {
    return sandbox ? SANDBOX_BASE : API_BASE;
  }

  function updateConfig(newConfig) {
    if (newConfig.appId !== undefined) appId = String(newConfig.appId || "");
    if (newConfig.appSecret !== undefined) appSecret = String(newConfig.appSecret || "");
    if (newConfig.userOpenid !== undefined) userOpenid = String(newConfig.userOpenid || "");
    if (newConfig.sandbox !== undefined) sandbox = newConfig.sandbox === true;
  }

  function isConfigured() {
    return !!(appId && appSecret);
  }

  async function fetchToken() {
    const result = await httpPostFn(TOKEN_URL, {
      appId,
      clientSecret: appSecret,
    }, { timeout: 10000 });
    if (result.status !== 200 || !result.body || !result.body.access_token) {
      throw new Error(`QQ Bot token fetch failed: status=${result.status}`);
    }
    return {
      token: result.body.access_token,
      expiresIn: Number(result.body.expires_in) || 7200,
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
      logFn(`qq-bot: token refreshed, expires in ${result.expiresIn}s`);
      return cachedToken;
    }).catch((err) => {
      tokenPromise = null;
      throw err;
    });
    return tokenPromise;
  }

  async function sendC2CMessage(openid, msgType, body) {
    const targetOpenid = (openid || userOpenid || "").trim();
    if (!targetOpenid) {
      throw new Error("QQ Bot target user openid is not available — send the bot a C2C message first to auto-discover it");
    }
    const token = await getToken();
    const url = `${getBaseUrl()}/v2/users/${encodeURIComponent(targetOpenid)}/messages`;
    const payload = { msg_type: msgType, ...body };
    return httpPostFn(url, payload, {
      headers: { Authorization: `QQBot ${token}` },
      timeout: 10000,
    });
  }

  async function sendTextMessage(text, targetOpenid) {
    const clampedText = typeof text === "string" ? text.slice(0, 2000) : "";
    return sendC2CMessage(targetOpenid || userOpenid, 0, { content: clampedText });
  }

  // Sends a QQ markdown message. `card` is a QQ message body that already
  // carries { markdown, keyboard? } — msg_type 2 is the markdown type for the
  // v2 C2C/group API. (QQ has no Feishu-style "card" / msg_type 10.)
  async function sendCardMessage(card, targetOpenid) {
    return sendC2CMessage(targetOpenid || userOpenid, 2, card);
  }

  // Strip markdown control chars / newlines from interpolated text so a tool
  // name or command can't break the message layout or button rendering.
  function mdSafe(text) {
    return String(text == null ? "" : text).replace(/[\r\n`*_~|]+/g, " ").trim();
  }

  function mdCode(text) {
    return "`" + mdSafe(text) + "`";
  }

  // Inline code, truncated. Multi-line content collapses to one line (mdSafe),
  // with an ellipsis if the raw text was longer than max.
  function mdCodeClamped(text, max) {
    const raw = String(text == null ? "" : text);
    const clipped = raw.length > max ? raw.slice(0, max) + "…" : raw;
    return mdCode(clipped);
  }

  // Per-tool detail lines for the approval card so the user can see WHAT is
  // happening, not just a bare filename. Returns an array of markdown lines.
  function formatToolDetailLines(toolName, toolInput) {
    const lines = [];
    if (!toolInput || typeof toolInput !== "object") return lines;
    const file = toolInput.file_path || toolInput.notebook_path || toolInput.path;
    if (file) lines.push(`**File**: ${mdCode(file)}`); // full path, not just basename

    if (toolName === "Bash" && toolInput.command) {
      lines.push(`**Command**: ${mdCodeClamped(toolInput.command, 400)}`);
    } else if (toolName === "Edit") {
      if (toolInput.old_string != null) lines.push(`**− Old**: ${mdCodeClamped(toolInput.old_string, 200)}`);
      if (toolInput.new_string != null) lines.push(`**+ New**: ${mdCodeClamped(toolInput.new_string, 200)}`);
    } else if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
      lines.push(`**Edits**: ${toolInput.edits.length}`);
      const first = toolInput.edits[0];
      if (first && first.old_string != null) lines.push(`**− Old[0]**: ${mdCodeClamped(first.old_string, 140)}`);
      if (first && first.new_string != null) lines.push(`**+ New[0]**: ${mdCodeClamped(first.new_string, 140)}`);
    } else if (toolName === "Write" && toolInput.content != null) {
      lines.push(`**Content**: ${mdCodeClamped(toolInput.content, 320)}`);
    } else if (toolInput.pattern || toolInput.query) {
      lines.push(`**Query**: ${mdCodeClamped(toolInput.pattern || toolInput.query, 200)}`);
    } else if (toolInput.command) {
      lines.push(`**Command**: ${mdCodeClamped(toolInput.command, 400)}`);
    }
    return lines;
  }

  // QQ inline-keyboard button. action.type 1 = callback → fires
  // INTERACTION_CREATE; permission.type 2 = anyone (in C2C only the recipient
  // can see it). render_data.style: 0 grey, 1 blue. The callback payload we
  // need on click is encoded into action.data as "<permId>|<behavior>".
  function makeButton(id, label, permId, behavior, style) {
    const text = String(label);
    return {
      id: String(id),
      render_data: { label: text, visited_label: text, style: style || 0 },
      action: {
        type: 1,
        permission: { type: 2 },
        data: `${permId}|${behavior}`,
        unsupport_tips: "请升级到最新版本 QQ 以使用按钮，或直接回复 y/n",
      },
    };
  }

  function chunkRows(buttons, perRow) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += perRow) {
      rows.push({ buttons: buttons.slice(i, i + perRow) });
    }
    return rows;
  }

  // Generate a human-readable label for a permission suggestion, mirroring the
  // logic in permission.js buildRemoteSuggestionLabel. Claude Code suggestions
  // carry { type, mode/behavior/toolName } instead of a ready-made label.
  function buildSuggestionLabel(s) {
    if (!s || typeof s !== "object") return "";
    // If the suggestion already has a label, use it (e.g. from CodeBuddy).
    if (s.label && typeof s.label === "string" && s.label.trim()) return s.label.trim();
    if (s.type === "setMode") {
      if (s.mode === "acceptEdits") return "Auto edits";
      if (s.mode === "plan") return "Plan mode";
      const mode = mdSafe(s.mode || "");
      return mode ? `Mode: ${mode}` : "";
    }
    if (s.type === "addRules") {
      const rules = Array.isArray(s.rules) ? s.rules : [s];
      const first = rules.find((rule) => rule && typeof rule === "object") || {};
      const behavior = mdSafe(s.behavior || first.behavior || "allow");
      const isDeny = behavior === "deny";
      const toolName = mdSafe(first.toolName || s.toolName || "");
      if (toolName) return isDeny ? `Always deny ${toolName}` : `Always ${toolName}`;
      return isDeny ? "Always deny" : "Always allow";
    }
    return "";
  }

  function buildApprovalCard(toolName, toolInput, sessionId, permId, suggestions, shortCode) {
    const sessionIdShort = sessionId ? String(sessionId).slice(-6) : "—";
    const lines = [
      `🔐 **${mdSafe(toolName || "Permission Request")}**`,
      `**Agent**: Claude Code`,
      `**Tool**: ${mdCode(toolName || "unknown")}`,
      ...formatToolDetailLines(toolName, toolInput),
      `**Session**: ${mdCode(sessionIdShort)}`,
      "",
      shortCode
        ? `点按钮，或回复 \`y ${shortCode}\` 允许 / \`n ${shortCode}\` 拒绝`
        : "点击下方按钮选择",
    ].filter((l) => l !== null);

    const buttons = [
      makeButton("1", "✅ Allow", permId, "allow", 1),
      makeButton("2", "❌ Deny", permId, "deny", 0),
    ];
    if (Array.isArray(suggestions)) {
      for (let i = 0; i < suggestions.length && i < 3; i++) {
        const s = suggestions[i];
        const label = buildSuggestionLabel(s) || `Suggestion ${i + 1}`;
        buttons.push(makeButton(String(3 + i), `📋 ${label}`, permId, `suggestion:${i}`, 0));
      }
    }
    return {
      // Clamp total content — QQ rejects over-long markdown bodies.
      markdown: { content: lines.join("\n").slice(0, 1800) },
      // One button per row so long suggestion labels render in full (no truncation).
      keyboard: { content: { rows: chunkRows(buttons, 1) } },
    };
  }

  function formatToolInput(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== "object") return "";
    if (toolName === "Bash" && toolInput.command) {
      return String(toolInput.command).slice(0, 120);
    }
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
      return toolInput.file_path ? String(toolInput.file_path).split(/[\\/]/).pop().slice(0, 60) : "";
    }
    if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
      return toolInput.pattern || toolInput.path || toolInput.file_path || "";
    }
    if (toolInput.command) return String(toolInput.command).slice(0, 120);
    if (toolInput.query) return String(toolInput.query).slice(0, 120);
    return "";
  }

  // Confirmation has no buttons — markdown-only body (still msg_type 2).
  function buildConfirmationCard(toolName, decision, permId) {
    const emoji = decision === "allow" ? "✅" : "❌";
    const label = decision === "allow" ? "Allowed" : "Denied";
    return {
      markdown: {
        content: `${emoji} **${label}**\n**Tool**: ${mdCode(toolName || "unknown")}\n**Decision**: ${label} via QQ`,
      },
    };
  }

  // Build an elicitation (AskUserQuestion) card for QQ. Shows the question
  // text and each option as an inline-keyboard button. Behavior encoding:
  //   "<permId>|elicitation:<questionIndex>:<optionIndex>"
  // Multi-question elicitation is supported — all questions' options are
  // rendered as buttons (QQ allows up to 5 buttons per row, max rows vary).
  // The user picks one option at a time; for single-question this resolves
  // immediately. For multi-question the bridge handles sequential resolution.
  function buildElicitationCard(toolInput, permId, shortCode, selections, warn) {
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const hasMulti = questions.some((q) => q && q.multiSelect);
    if (hasMulti) {
      return buildMultiSelectElicitationCard(questions, permId, shortCode, selections, warn);
    }
    return buildSingleSelectElicitationCard(questions, permId, shortCode);
  }

  // Existing single-select behavior: one tap resolves immediately.
  function buildSingleSelectElicitationCard(questions, permId, shortCode) {
    const lines = ["💬 **AskUserQuestion**"];
    const allButtons = [];
    let buttonId = 1;

    for (let qi = 0; qi < questions.length && qi < 3; qi++) {
      const q = questions[qi];
      if (!q || typeof q !== "object") continue;
      const header = mdSafe(q.header || "");
      const prompt = mdSafe(q.question || "");
      if (qi > 0) lines.push("");
      if (header) lines.push(`**${header}**`);
      lines.push(`${prompt}`);

      const options = Array.isArray(q.options) ? q.options : [];
      for (let oi = 0; oi < options.length && oi < 5; oi++) {
        const opt = options[oi];
        if (!opt || typeof opt !== "object") continue;
        const optLabel = mdSafe(opt.label || `Option ${oi + 1}`).slice(0, 30);
        allButtons.push(makeButton(String(buttonId++), optLabel, permId, `elicitation:${qi}:${oi}`, 0));
      }
    }

    lines.push("");
    lines.push(shortCode
      ? `点按钮选择，或回复 \`y ${shortCode}\` 使用默认答案`
      : "点击下方按钮选择");

    return {
      markdown: { content: lines.join("\n").slice(0, 1800) },
      keyboard: { content: { rows: chunkRows(allButtons, 5) } },
    };
  }

  // Multi-select: taps accumulate; user submits with a dedicated button. QQ can't
  // edit a sent card, so each tap re-sends a fresh card reflecting `selections`.
  // `selections` is an array indexed by question → array of selected option indices.
  function buildMultiSelectElicitationCard(questions, permId, shortCode, selections, warn) {
    const sel = Array.isArray(selections) ? selections : [];
    const lines = ["💬 **AskUserQuestion**"];
    const optionButtons = [];
    let buttonId = 1;
    let totalSelected = 0;

    for (let qi = 0; qi < questions.length && qi < 3; qi++) {
      const q = questions[qi];
      if (!q || typeof q !== "object") continue;
      const header = mdSafe(q.header || "");
      const prompt = mdSafe(q.question || "");
      if (qi > 0) lines.push("");
      if (header) lines.push(`**${header}**`);
      lines.push(`${prompt}`);

      const selectedForQ = Array.isArray(sel[qi]) ? sel[qi] : [];
      const options = Array.isArray(q.options) ? q.options : [];
      for (let oi = 0; oi < options.length && oi < 5; oi++) {
        const opt = options[oi];
        if (!opt || typeof opt !== "object") continue;
        const isSel = selectedForQ.indexOf(oi) !== -1;
        if (isSel) totalSelected++;
        const optLabel = mdSafe(opt.label || `Option ${oi + 1}`).slice(0, 28);
        lines.push(`${isSel ? "✓" : "▢"} ${optLabel}`);
        optionButtons.push(makeButton(
          String(buttonId++),
          `${isSel ? "✓ " : ""}${optLabel}`,
          permId,
          `elicitation:${qi}:${oi}`,
          isSel ? 1 : 0
        ));
      }
    }

    lines.push("");
    if (warn) lines.push("⚠️ 还有题未选，请每道题至少选一个");
    lines.push("点按钮切换选择，选好后点「完成」提交");

    const submitButton = makeButton(
      String(buttonId++),
      `✅ 完成 (已选 ${totalSelected})`,
      permId,
      "elicitation-submit",
      1
    );

    const rows = chunkRows(optionButtons, 5);
    rows.push({ buttons: [submitButton] });

    return {
      markdown: { content: lines.join("\n").slice(0, 1800) },
      keyboard: { content: { rows } },
    };
  }

  // QQ INTERACTION_CREATE button callback. The event (msg.d) carries
  // type === 11 (inline-keyboard click) and data.resolved.{button_id,
  // button_data, user_id}. We encoded "<permId>|<behavior>" into the button's
  // action.data, so it comes back as button_data.
  // Acknowledge a button interaction so the QQ client stops its loading
  // spinner. Without this PUT the client sits in "loading" until it shows
  // "请求超时". code 0 = handled OK. Fire-and-forget; errors are logged only.
  async function ackInteraction(interactionId, code) {
    if (!interactionId) return;
    try {
      const token = await getToken();
      await httpPutFn(
        `${getBaseUrl()}/interactions/${encodeURIComponent(interactionId)}`,
        { code: code || 0 },
        { headers: { Authorization: `QQBot ${token}` }, timeout: 5000 }
      );
    } catch (err) {
      logFn(`qq-bot: interaction ack failed: ${compactLog(err, 100)}`);
    }
  }

  function handleInteractionEvent(eventData) {
    if (!eventData || eventData.type !== 11) return;
    // ACK first (independent of whether we can parse the payload) so the
    // client never spins to "请求超时".
    if (eventData.id) ackInteraction(eventData.id, 0);
    const resolved = eventData.data && eventData.data.resolved;
    const raw = resolved && typeof resolved.button_data === "string" ? resolved.button_data : "";
    const sep = raw.indexOf("|");
    if (sep === -1) return;
    const permId = raw.slice(0, sep);
    const behavior = raw.slice(sep + 1) || "deny";
    if (!permId) return;
    for (const listener of interactionListeners) {
      try {
        listener({
          permId,
          behavior,
          userOpenid: (resolved && resolved.user_id) || "",
          msgId: eventData.id || "",
        });
      } catch (err) {
        logFn(`qq-bot: interaction listener error: ${compactLog(err, 100)}`);
      }
    }
  }

  function extractOpenidFromEvent(eventData) {
    if (!eventData || typeof eventData !== "object") return "";
    const candidates = [];
    if (eventData.author && typeof eventData.author === "object") {
      if (eventData.author.user_openid) candidates.push(eventData.author.user_openid);
      if (eventData.author.member_openid) candidates.push(eventData.author.member_openid);
      if (eventData.author.id) candidates.push(eventData.author.id);
      if (eventData.author.openid) candidates.push(eventData.author.openid);
    }
    if (eventData.user_openid) candidates.push(eventData.user_openid);
    if (eventData.member_openid) candidates.push(eventData.member_openid);
    if (eventData.src_router && eventData.src_router.user_openid) {
      candidates.push(eventData.src_router.user_openid);
    }
    for (const candidate of candidates) {
      const v = String(candidate || "").trim();
      if (v && v !== "undefined" && v !== "null") return v;
    }
    return "";
  }

  function handleC2CMessage(eventData) {
    const discoveredOpenid = extractOpenidFromEvent(eventData);
    if (discoveredOpenid && discoveredOpenid !== userOpenid) {
      userOpenid = discoveredOpenid;
      logFn(`qq-bot: auto-discovered userOpenid from C2C message — ${discoveredOpenid.slice(0, 12)}…`);
      for (const listener of openidChangeListeners) {
        try { listener(discoveredOpenid); } catch (err) { logFn(`qq-bot: openid listener error: ${compactLog(err, 100)}`); }
      }
    } else if (!discoveredOpenid) {
      logFn(`qq-bot: C2C message received but could not extract openid — raw event keys: ${Object.keys(eventData || {}).join(",")}`);
    }
    // Surface the message text so the approval bridge can match y/n text
    // replies (the fallback when QQ buttons aren't tappable on a client).
    const text = eventData && typeof eventData.content === "string" ? eventData.content.trim() : "";
    if (text) {
      for (const listener of messageListeners) {
        try { listener({ text, userOpenid: discoveredOpenid || userOpenid }); }
        catch (err) { logFn(`qq-bot: message listener error: ${compactLog(err, 100)}`); }
      }
    }
  }

  function onMessage(callback) {
    if (typeof callback === "function") {
      messageListeners.add(callback);
      return () => messageListeners.delete(callback);
    }
    return () => {};
  }

  function onOpenidDiscovered(callback) {
    if (typeof callback === "function") {
      openidChangeListeners.add(callback);
      if (userOpenid) {
        // Fire immediately if we already have a value, so late subscribers catch up.
        try { callback(userOpenid); } catch (err) { logFn(`qq-bot: openid listener error: ${compactLog(err, 100)}`); }
      }
      return () => openidChangeListeners.delete(callback);
    }
    return () => {};
  }

  function getDiscoveredOpenid() {
    return userOpenid;
  }

  function onInteraction(callback) {
    if (typeof callback === "function") {
      interactionListeners.add(callback);
      return () => interactionListeners.delete(callback);
    }
    return () => {};
  }

  function clearWsTimers() {
    if (wsHeartbeatInterval) { clearInterval(wsHeartbeatInterval); wsHeartbeatInterval = null; }
    if (wsHeartbeatTimeout) { clearTimeout(wsHeartbeatTimeout); wsHeartbeatTimeout = null; }
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  }

  function sendWsPayload(op, d) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify({ op, d })); return true; } catch { return false; }
  }

  async function fetchGatewayUrl() {
    if (wsGatewayUrl) return wsGatewayUrl;
    const gatewayUrl = sandbox ? WS_GATEWAY_SANDBOX : WS_GATEWAY_URL;
    try {
      const result = await httpGet(gatewayUrl, { timeout: 10000 });
      if (result && result.status === 200 && result.body && result.body.url) {
        wsGatewayUrl = result.body.url;
        logFn(`qq-bot: gateway url resolved: ${wsGatewayUrl}`);
        return wsGatewayUrl;
      }
    } catch (err) {
      logFn(`qq-bot: gateway fetch failed, using default: ${compactLog(err, 100)}`);
    }
    wsGatewayUrl = sandbox
      ? "wss://sandbox.api.sgroup.qq.com/websocket/"
      : "wss://api.sgroup.qq.com/websocket/";
    return wsGatewayUrl;
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logFn("qq-bot: ws max reconnect attempts reached");
      return;
    }
    const delay = Math.min(
      WS_RECONNECT_BASE_MS * Math.pow(2, wsReconnectAttempts),
      WS_RECONNECT_MAX_MS
    );
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      wsReconnectAttempts++;
      connectWs().catch((err) => {
        logFn(`qq-bot: ws reconnect failed: ${compactLog(err, 100)}`);
      });
    }, delay);
  }

  function closeWs() {
    clearWsTimers();
    wsConnected = false;
    wsIdentifySent = false;
    try { if (ws) ws.close(1000); } catch {}
    ws = null;
  }

  async function connectWs() {
    if (!isConfigured()) return;
    if (!WebSocketCtor) {
      logFn("qq-bot: WebSocket constructor not available, skipping WS connection");
      return;
    }
    closeWs();
    const token = await getToken();
    const wsUrl = await fetchGatewayUrl();
    ws = new WebSocketCtor(wsUrl);
    ws.on("open", () => {
      wsConnected = true;
      wsReconnectAttempts = 0;
      logFn("qq-bot: WebSocket connected");
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw || "{}")); } catch { return; }
      if (msg.s != null && (wsLastSeq === null || msg.s > wsLastSeq)) {
        wsLastSeq = msg.s;
      }
      if (msg.op === 10) {
        const heartbeatInterval = (msg.d && msg.d.heartbeat_interval) || 41250;
        clearWsTimers();
        wsHeartbeatInterval = setInterval(() => {
          sendWsPayload(1, wsLastSeq);
          if (wsHeartbeatTimeout) clearTimeout(wsHeartbeatTimeout);
          wsHeartbeatTimeout = setTimeout(() => {
            logFn("qq-bot: heartbeat timeout, reconnecting");
            closeWs();
            scheduleReconnect();
          }, heartbeatInterval + HEARTBEAT_BUFFER_MS);
        }, heartbeatInterval);
        // Resume existing session on reconnect, or Identify new session
        if (wsSessionId && wsLastSeq != null) {
          sendWsPayload(6, {
            token: `QQBot ${token}`,
            session_id: wsSessionId,
            seq: wsLastSeq,
          });
          logFn("qq-bot: resuming session");
        } else {
          sendWsPayload(2, {
            token: `QQBot ${token}`,
            intents: DEFAULT_INTENTS,
          });
          wsIdentifySent = true;
          logFn("qq-bot: identify sent — awaiting READY / events");
        }
        return;
      }
      if (msg.op === 11) {
        if (wsHeartbeatTimeout) { clearTimeout(wsHeartbeatTimeout); wsHeartbeatTimeout = null; }
        return;
      }
      if (msg.op === 7) {
        logFn("qq-bot: WebSocket reconnect requested");
        closeWs();
        scheduleReconnect();
        return;
      }
      if (msg.op === 9) {
        logFn("qq-bot: invalid session, clearing session for re-identify");
        wsIdentifySent = false;
        wsSessionId = null;
        wsLastSeq = null;
        return;
      }
      if (msg.op === 0) {
        const eventType = String(msg.t || "");
        if (eventType === "INTERACTION_CREATE" && msg.d) {
          handleInteractionEvent(msg.d);
          return;
        }
        if (eventType === "C2C_MESSAGE_CREATE" && msg.d) {
          handleC2CMessage(msg.d);
          return;
        }
        // Fallback: extract openid from any message-like event so we are
        // resilient to bot platform renames of event types.
        if (msg.d && (eventType.includes("MESSAGE") || eventType.includes("DIRECT"))) {
          const candidate = extractOpenidFromEvent(msg.d);
          if (candidate && candidate !== userOpenid) {
            logFn(`qq-bot: openid extracted from ${eventType} — ${candidate.slice(0, 12)}…`);
            userOpenid = candidate;
            for (const listener of openidChangeListeners) {
              try { listener(candidate); } catch (err) { logFn(`qq-bot: openid listener error: ${compactLog(err, 100)}`); }
            }
          }
          return;
        }
        if (eventType === "READY" && msg.d && msg.d.session_id) {
          wsSessionId = msg.d.session_id;
          logFn(`qq-bot: WebSocket READY received — session=${String(msg.d.session_id).slice(0, 16)}… user=${msg.d.user && msg.d.user.id ? String(msg.d.user.id).slice(0, 10) + "…" : "n/a"}`);
          return;
        }
        if (eventType === "RESUMED") {
          logFn("qq-bot: WebSocket session resumed");
          return;
        }
        logFn(`qq-bot: received op=0 event t=${eventType} (not handled)`);
        return;
      }
      // Any other op — log once so it surfaces in dev logs.
      logFn(`qq-bot: received op=${String(msg.op)} t=${String(msg.t || "")}`);
    });
    ws.on("close", (code) => {
      wsConnected = false;
      clearWsTimers();
      logFn(`qq-bot: WebSocket closed code=${code}`);
      if (code !== 1000) {
        scheduleReconnect();
      }
    });
    ws.on("error", (err) => {
      logFn(`qq-bot: WebSocket error: ${compactLog(err, 100)}`);
    });
  }

  function disconnect() {
    closeWs();
    wsReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  }

  function isConnected() {
    return wsConnected && wsIdentifySent;
  }

  function isEnabled() {
    return isConfigured();
  }

  return {
    updateConfig,
    isConfigured,
    getToken,
    sendTextMessage,
    sendCardMessage,
    sendC2CMessage,
    buildApprovalCard,
    buildElicitationCard,
    buildConfirmationCard,
    onInteraction,
    onOpenidDiscovered,
    onMessage,
    connectWs,
    disconnect,
    isConnected,
    isEnabled,
    getDiscoveredOpenid,
    _testHandleInteraction: handleInteractionEvent,
    _testHandleC2CMessage: handleC2CMessage,
    _testExtractOpenid: extractOpenidFromEvent,
    _testFormatToolInput: formatToolInput,
    _testFormatToolDetails: formatToolDetailLines,
  };
}

module.exports = {
  compactLog,
  httpPost,
  TOKEN_URL,
  API_BASE,
  SANDBOX_BASE,
  DEFAULT_INTENTS,
  createQQBotClient,
};
