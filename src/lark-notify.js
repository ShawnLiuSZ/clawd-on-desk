"use strict";

// ── Lark Bot State Notification ──
//
// Pushes agent state changes to the user's Lark chat as text messages.
// Throttled by minIntervalMs to avoid spam.
// Respects DND mode and per-agent enabled flags.

const STATE_LABELS = {
  idle: "💤 Idle",
  working: "⚙️ Working",
  thinking: "🤔 Thinking",
  attention: "🔔 Attention",
  error: "❌ Error",
  notification: "📢 Notification",
  sleeping: "😴 Sleeping",
  sweeping: "🧹 Sweeping",
  juggling: "🤹 Juggling",
  carrying: "📦 Carrying",
};

function createLarkNotifier(larkBotClient, options = {}) {
  const logFn = typeof options.log === "function" ? options.log : () => {};
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  const lastNotified = new Map();

  function shouldNotify(agentId, state, config) {
    if (!larkBotClient || !larkBotClient.isEnabled()) return false;
    if (!config || !config.enabled) return false;
    if (!Array.isArray(config.notifyStates) || !config.notifyStates.includes(state)) return false;
    const minInterval = Number.isFinite(config.minIntervalMs) ? config.minIntervalMs : 5000;
    const key = `${agentId}:${state}`;
    const last = lastNotified.get(key);
    if (last && (nowFn() - last) < minInterval) return false;
    lastNotified.set(key, nowFn());
    return true;
  }

  function formatStateMessage(agentName, state, sessionId) {
    const label = STATE_LABELS[state] || state;
    const sessionIdShort = sessionId ? String(sessionId).slice(-4) : "";
    const parts = [`[${agentName}] ${label}`];
    if (sessionIdShort) parts.push(`Session: ${sessionIdShort}`);
    return parts.join("\n");
  }

  async function notifyStateChange(agentName, state, sessionId, config) {
    if (!shouldNotify(agentName, state, config)) return;
    const text = formatStateMessage(agentName, state, sessionId);
    try {
      await larkBotClient.sendTextMessage(text);
    } catch (err) {
      logFn(`lark-notify: send failed: ${err && err.message}`);
    }
  }

  function pruneStale(maxAge = 600000) {
    const cutoff = nowFn() - maxAge;
    for (const [key, ts] of lastNotified) {
      if (ts < cutoff) lastNotified.delete(key);
    }
  }

  function reset() {
    lastNotified.clear();
  }

  return {
    notifyStateChange,
    shouldNotify,
    pruneStale,
    reset,
    _testGetLastNotifiedSize: () => lastNotified.size,
  };
}

module.exports = {
  STATE_LABELS,
  createLarkNotifier,
};
