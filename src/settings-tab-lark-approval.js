"use strict";

// ── Settings Tab: Lark/Feishu Bot ──
// Renders the Lark/Feishu bot configuration card in the Remote Approval tab.
//
// Connection model: WebSocket long-connection (official SDK, wired in main.js).
// The user enters App ID + App Secret; the app dials Feishu's gateway — no
// public IP, no webhook. The approval target chat is auto-bound the first time
// the user messages the bot, so there's no manual Chat ID to look up.

(function initSettingsTabLarkApproval(root) {
  let state = null;
  let coreRef = null;
  let helpers = null;
  let ops = null;

  const view = {
    larkTestPending: false,
    larkTestResult: null,
    larkTestSeq: 0,
    larkDraft: null,
    larkDirty: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentLarkBotConfig() {
    const cfg = state.snapshot && state.snapshot.larkBot;
    const appSecret = cfg && typeof cfg.appSecret === "string" ? cfg.appSecret : "";
    return {
      enabled: !!(cfg && cfg.enabled),
      appId: cfg && typeof cfg.appId === "string" ? cfg.appId : "",
      // Real secret is carried through so partial saves don't wipe it (the
      // store replaces the whole larkBot object on each update); the boolean
      // is what the UI renders.
      appSecret,
      appSecretConfigured: !!appSecret,
      chatId: cfg && typeof cfg.chatId === "string" ? cfg.chatId : "",
      region: cfg && typeof cfg.region === "string" ? cfg.region : "feishu",
      approvalEnabled: !!(cfg && cfg.approvalEnabled !== false),
    };
  }

  function larkDraftSecret() {
    if (!view.larkDraft || !view.larkDirty) {
      view.larkDraft = { value: "" };
    }
    return view.larkDraft;
  }

  function callCommand(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error" });
    }
    return window.settingsAPI.command(action, payload).catch((err) => ({
      status: "error",
      message: err && err.message,
    }));
  }

  function render(parent) {
    parent.appendChild(buildLarkBotChannelCard());
  }

  // ── Lark/Feishu Bot channel card ────────────────────────────────────────────

  function buildLarkBotChannelCard() {
    const cfg = currentLarkBotConfig();
    // The Test button is clickable once credentials are present and Lark is
    // enabled — it does NOT require a bound chat. If no chat is bound yet,
    // clicking returns an actionable "message your bot to bind" error instead
    // of leaving the button permanently disabled with no explanation.
    const canTest = cfg.enabled && cfg.appId && cfg.appSecretConfigured;

    const rows = [
      buildLarkBotRegionRow(cfg),
      buildLarkBotAppIdRow(cfg),
      buildLarkBotAppSecretRow(),
      buildLarkBotBindingRow(cfg),
      buildLarkBotEnabledRow(cfg),
      buildLarkBotTestRow(cfg, canTest),
    ];

    const children = [
      // Standalone status banner, then a single bordered row container — the
      // same layout the Telegram channel card uses.
      buildLarkBotStatusRow(cfg),
      helpers.buildSection("", rows),
    ];

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.lark",
      headerContent: buildLarkBotChannelHeader(cfg),
      defaultCollapsed: !cfg.enabled,
      className: "remote-approval-channel-card lark-approval-channel-card",
      children,
    });
  }

  // ── Shared status + row helpers (unified with Telegram / Hardware Buddy) ──

  // Connection state for the WebSocket model:
  //   disabled / missing creds → incomplete (grey "Disconnected")
  //   creds present, no chat bound yet → ready (accent "Connecting / bind hint")
  //   creds present + chat bound → running (green "Connected")
  function larkStatusInfo(cfg) {
    if (!cfg.enabled || !cfg.appId || !cfg.appSecretConfigured) {
      return { kind: "incomplete", text: t("larkBotDisconnected") };
    }
    if (!cfg.chatId) {
      return { kind: "ready", text: t("larkBotBindStatusWaiting") };
    }
    return { kind: "running", text: t("larkBotConnected") };
  }

  function larkBadgeClass(kind) {
    switch (kind) {
      case "running": return "tg-approval-badge-running";
      case "ready": return "tg-approval-badge-ready";
      case "starting": return "tg-approval-badge-starting";
      case "failed": return "tg-approval-badge-failed";
      case "incomplete":
      default: return "tg-approval-badge-incomplete";
    }
  }

  // Builds the shared `.row` skeleton used across remote-approval channels:
  // a row-text column (label + optional desc) and a row-control slot.
  function buildLarkRow(labelText, descText, controlEl, opts = {}) {
    const row = document.createElement("div");
    row.className = "row" + (opts.rowClass ? " " + opts.rowClass : "");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = labelText;
    text.appendChild(label);
    if (descText) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = descText;
      text.appendChild(desc);
    }
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control" + (opts.controlClass ? " " + opts.controlClass : "");
    if (controlEl) ctrl.appendChild(controlEl);
    row.appendChild(ctrl);

    return row;
  }

  function buildLarkBotChannelHeader(cfg) {
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-channel-header lark-approval-channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "tg-approval-channel-name";
    nameEl.textContent = t("larkBot");
    wrap.appendChild(nameEl);

    const info = larkStatusInfo(cfg);
    const badge = document.createElement("span");
    badge.className = "tg-approval-channel-badge " + larkBadgeClass(info.kind);
    const dot = document.createElement("span");
    dot.className = "tg-approval-channel-badge-dot";
    badge.appendChild(dot);
    const badgeText = document.createElement("span");
    badgeText.textContent = info.text;
    badge.appendChild(badgeText);
    wrap.appendChild(badge);

    return wrap;
  }

  function buildLarkBotStatusRow(cfg) {
    const info = larkStatusInfo(cfg);
    const row = document.createElement("div");
    row.className = "tg-approval-channel-status-row " + larkBadgeClass(info.kind);

    const text = document.createElement("span");
    text.className = "tg-approval-channel-status-text";
    text.textContent = info.text;
    row.appendChild(text);
    return row;
  }

  function buildLarkBotRegionRow(cfg) {
    const select = document.createElement("select");
    select.className = "tg-approval-input tg-approval-output-select";
    const options = [
      { value: "feishu", label: t("larkBotRegionFeishu") },
      { value: "lark", label: t("larkBotRegionLark") },
    ];
    for (const opt of options) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    }
    select.value = cfg.region;
    select.addEventListener("change", () => {
      saveLarkField("region", select.value);
    });

    return buildLarkRow(t("larkBotRegion"), t("larkBotRegionDescription"), select);
  }

  function buildLarkBotAppIdRow(cfg) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tg-approval-input";
    input.placeholder = "cli_xxxxx";
    input.value = cfg.appId;
    input.addEventListener("change", () => {
      saveLarkField("appId", input.value.trim());
    });

    return buildLarkRow(t("larkBotAppId"), null, input, {
      rowClass: "lark-input-row",
      controlClass: "tg-approval-input-row",
    });
  }

  function buildLarkBotAppSecretRow() {
    const cfg = currentLarkBotConfig();
    const draft = larkDraftSecret();

    const input = document.createElement("input");
    input.type = "password";
    input.className = "tg-approval-input";
    input.autocomplete = "off";
    input.placeholder = cfg.appSecretConfigured ? "••••••••" : t("larkBotAppSecret");
    input.value = draft.value;
    input.addEventListener("change", () => {
      draft.value = input.value;
      view.larkDirty = true;
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = t("save");
    saveBtn.addEventListener("click", () => {
      if (draft.value) {
        saveLarkField("appSecret", draft.value);
        draft.value = "";
        view.larkDirty = false;
      }
    });

    const control = document.createElement("div");
    control.appendChild(input);
    control.appendChild(saveBtn);

    return buildLarkRow(t("larkBotAppSecret"), null, control, {
      rowClass: "lark-input-row",
      controlClass: "tg-approval-input-row",
    });
  }

  // The approval target chat is auto-bound when the user first messages the bot.
  // Bound → show the chat id + a Rebind button; unbound → show binding instructions.
  function buildLarkBotBindingRow(cfg) {
    if (cfg.chatId) {
      const rebindBtn = document.createElement("button");
      rebindBtn.type = "button";
      rebindBtn.className = "soft-btn";
      rebindBtn.textContent = t("larkBotRebind");
      rebindBtn.addEventListener("click", () => saveLarkField("chatId", ""));
      return buildLarkRow(t("larkBotBoundChat"), cfg.chatId, rebindBtn);
    }
    const hint = document.createElement("span");
    hint.className = "tg-approval-channel-status-text";
    hint.textContent = t("larkBotBindStatusWaiting");
    return buildLarkRow(t("larkBotBoundChat"), null, hint);
  }

  function buildLarkBotEnabledRow(cfg) {
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.enabled, { pending: false });

    const toggle = () => {
      saveLarkField("enabled", !cfg.enabled);
    };
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        toggle();
      }
    });

    return buildLarkRow(t("larkBotApprovalEnabled"), t("larkBotApprovalEnabledDescription"), sw);
  }

  function buildLarkBotTestRow(cfg, ready) {
    // Build the row by hand so the result message lives in the row-text column
    // (.row-desc wraps, full width) instead of the right-side control — a long
    // message must never squeeze the "Test connection" label into a 1-char column.
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("larkBotTestConnection");
    text.appendChild(label);

    if (view.larkTestPending || view.larkTestResult) {
      const resultEl = document.createElement("span");
      resultEl.className = "row-desc";
      if (view.larkTestPending) {
        resultEl.textContent = t("larkBotTesting");
      } else {
        const r = view.larkTestResult;
        resultEl.textContent = r.message
          || (r.status === "ok" ? t("larkBotConnected") : t("larkBotDisconnected"));
        resultEl.style.color = r.status === "ok"
          ? "var(--accent)"
          : "var(--toast-error, #e53935)";
      }
      text.appendChild(resultEl);
    }
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = t("larkBotTestConnection");
    btn.disabled = !ready || view.larkTestPending;
    btn.addEventListener("click", () => {
      view.larkTestPending = true;
      view.larkTestResult = null;
      ops.requestRender({ content: true });
      const seq = ++view.larkTestSeq;

      callCommand("larkBot.test").then((result) => {
        if (seq !== view.larkTestSeq) return;
        view.larkTestPending = false;
        view.larkTestResult = result || { status: "error", message: t("larkBotDisconnected") };
        ops.requestRender({ content: true });
      });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);

    return row;
  }

  function saveLarkField(field, value) {
    const cfg = currentLarkBotConfig();
    cfg[field] = value;
    saveLarkBotConfig(cfg);
  }

  function saveLarkBotConfig(cfg) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    // Send only keys the backend validator accepts — `appSecretConfigured` is a
    // UI-only derived flag and would be rejected as an unsupported field.
    const payload = {
      enabled: !!cfg.enabled,
      appId: typeof cfg.appId === "string" ? cfg.appId : "",
      appSecret: typeof cfg.appSecret === "string" ? cfg.appSecret : "",
      chatId: typeof cfg.chatId === "string" ? cfg.chatId : "",
      region: typeof cfg.region === "string" ? cfg.region : "feishu",
      approvalEnabled: cfg.approvalEnabled !== false,
    };
    window.settingsAPI.update("larkBot", payload).then((result) => {
      if (result && result.status === "ok") {
        ops.showToast(t("toastSaveSuccess"));
      } else {
        ops.showToast(t("toastSaveFailed"), { error: true });
      }
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    });
  }

  // Export
  if (typeof root !== "undefined") {
    root.initSettingsTabLarkApproval = function init(options) {
      state = options.state;
      coreRef = options.coreRef;
      helpers = options.helpers;
      ops = options.ops;
      return { render };
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
