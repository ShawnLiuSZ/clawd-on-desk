"use strict";

// ── Settings Tab: Lark/Feishu Bot ──
// Renders the Lark/Feishu bot configuration card in the Remote Approval settings tab.

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
    larkEditing: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentLarkBotConfig() {
    const cfg = state.snapshot && state.snapshot.larkBot;
    return {
      enabled: !!(cfg && cfg.enabled),
      appId: cfg && typeof cfg.appId === "string" ? cfg.appId : "",
      appSecretConfigured: !!(cfg && typeof cfg.appSecret === "string" && cfg.appSecret),
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
    const ready = cfg.enabled && cfg.appId && cfg.appSecretConfigured && cfg.chatId;

    const card = helpers.buildCard({
      headerContent: buildLarkBotChannelHeader(cfg),
      collapsible: true,
      collapsed: !cfg.enabled,
    });

    const body = card.querySelector(".card-body") || card;

    // Status row
    body.appendChild(buildLarkBotStatusRow(cfg));

    // Region selector
    body.appendChild(helpers.buildSection(t("larkBotRegion"), [
      buildLarkBotRegionRow(cfg),
    ]));

    // AppID / AppSecret
    body.appendChild(helpers.buildSection(t("larkBotAppId") + " / " + t("larkBotAppSecret"), [
      buildLarkBotAppIdRow(cfg),
      buildLarkBotAppSecretRow(),
    ]));

    // Chat ID
    body.appendChild(helpers.buildSection(t("larkBotChatId"), [
      buildLarkBotChatIdRow(cfg),
    ]));

    // Enable / Test
    body.appendChild(helpers.buildSection(t("larkBotApprovalEnabled"), [
      buildLarkBotEnabledRow(cfg, ready),
      buildLarkBotTestRow(cfg, ready),
    ]));

    return card;
  }

  function buildLarkBotChannelHeader(cfg) {
    const wrapper = document.createElement("div");
    wrapper.className = "channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "channel-name";
    nameEl.textContent = t("larkBot");
    wrapper.appendChild(nameEl);

    const descEl = document.createElement("span");
    descEl.className = "channel-desc";
    descEl.textContent = t("larkBotDescription");
    wrapper.appendChild(descEl);

    return wrapper;
  }

  function buildLarkBotStatusRow(cfg) {
    const row = document.createElement("div");
    row.className = "settings-row status-row";

    const statusEl = document.createElement("span");
    statusEl.className = "status-indicator";

    if (!cfg.enabled) {
      statusEl.textContent = t("larkBotDisconnected");
      statusEl.classList.add("status-off");
    } else if (cfg.appId && cfg.appSecretConfigured && cfg.chatId) {
      statusEl.textContent = t("larkBotConnected");
      statusEl.classList.add("status-on");
    } else {
      statusEl.textContent = t("larkBotDisconnected");
      statusEl.classList.add("status-off");
    }

    row.appendChild(statusEl);
    return row;
  }

  function buildLarkBotRegionRow(cfg) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const desc = document.createElement("div");
    desc.className = "settings-desc";
    desc.textContent = t("larkBotRegionDescription");
    row.appendChild(desc);

    const selector = document.createElement("div");
    selector.className = "radio-group";

    const options = [
      { value: "feishu", label: t("larkBotRegionFeishu") },
      { value: "lark", label: t("larkBotRegionLark") },
    ];

    for (const opt of options) {
      const label = document.createElement("label");
      label.className = "radio-label";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "lark-region";
      input.value = opt.value;
      input.checked = cfg.region === opt.value;
      input.addEventListener("change", () => {
        saveLarkField("region", opt.value);
      });

      const span = document.createElement("span");
      span.textContent = opt.label;

      label.appendChild(input);
      label.appendChild(span);
      selector.appendChild(label);
    }

    row.appendChild(selector);
    return row;
  }

  function buildLarkBotAppIdRow(cfg) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "settings-input";
    input.placeholder = "cli_xxxxx";
    input.value = cfg.appId;
    input.addEventListener("change", () => {
      const val = input.value.trim();
      saveLarkField("appId", val);
    });

    row.appendChild(input);
    return row;
  }

  function buildLarkBotAppSecretRow() {
    const row = document.createElement("div");
    row.className = "settings-row";

    const cfg = currentLarkBotConfig();
    const draft = larkDraftSecret();

    const input = document.createElement("input");
    input.type = "password";
    input.className = "settings-input";
    input.placeholder = cfg.appSecretConfigured ? "••••••••" : "App Secret";
    input.value = draft.value;
    input.addEventListener("change", () => {
      draft.value = input.value;
      view.larkDirty = true;
    });

    const saveBtn = document.createElement("button");
    saveBtn.className = "settings-btn";
    saveBtn.textContent = t("save");
    saveBtn.addEventListener("click", () => {
      if (draft.value) {
        saveLarkField("appSecret", draft.value);
        draft.value = "";
        view.larkDirty = false;
      }
    });

    row.appendChild(input);
    row.appendChild(saveBtn);
    return row;
  }

  function buildLarkBotChatIdRow(cfg) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const desc = document.createElement("div");
    desc.className = "settings-desc";
    desc.textContent = t("larkBotChatIdDescription");
    row.appendChild(desc);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "settings-input";
    input.placeholder = "oc_xxxxx";
    input.value = cfg.chatId;
    input.addEventListener("change", () => {
      const val = input.value.trim();
      saveLarkField("chatId", val);
    });

    row.appendChild(input);
    return row;
  }

  function buildLarkBotEnabledRow(cfg, ready) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const desc = document.createElement("div");
    desc.className = "settings-desc";
    desc.textContent = t("larkBotApprovalEnabledDescription");
    row.appendChild(desc);

    const toggle = document.createElement("label");
    toggle.className = "toggle-switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = cfg.enabled;
    input.addEventListener("change", () => {
      saveLarkField("enabled", input.checked);
    });

    const slider = document.createElement("span");
    slider.className = "slider";

    toggle.appendChild(input);
    toggle.appendChild(slider);
    row.appendChild(toggle);

    return row;
  }

  function buildLarkBotTestRow(cfg, ready) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const btn = document.createElement("button");
    btn.className = "settings-btn";
    btn.textContent = t("larkBotTestConnection");
    btn.disabled = !ready || view.larkTestPending;

    if (view.larkTestResult) {
      const resultEl = document.createElement("span");
      resultEl.className = "test-result";
      if (view.larkTestResult.status === "ok") {
        resultEl.textContent = view.larkTestResult.message || t("larkBotConnected");
        resultEl.classList.add("success");
      } else {
        resultEl.textContent = view.larkTestResult.message || t("larkBotDisconnected");
        resultEl.classList.add("error");
      }
      row.appendChild(resultEl);
    }

    btn.addEventListener("click", () => {
      view.larkTestPending = true;
      view.larkTestResult = null;
      const seq = ++view.larkTestSeq;

      callCommand("larkBot.test").then((result) => {
        if (seq !== view.larkTestSeq) return;
        view.larkTestPending = false;
        view.larkTestResult = result;
        ops.requestRender({ content: true });
      });
    });

    row.appendChild(btn);
    return row;
  }

  function saveLarkField(field, value) {
    const cfg = currentLarkBotConfig();
    cfg[field] = value;
    callCommand("larkBot.save", cfg).then((result) => {
      if (result && result.status === "ok") {
        ops.showToast(t("toastSaveSuccess"));
      } else {
        ops.showToast(t("toastSaveFailed"), { error: true });
      }
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
