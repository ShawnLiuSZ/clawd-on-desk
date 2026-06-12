"use strict";

(function initSettingsTabTelegramApproval(root) {
  let state = null;
  let coreRef = null;
  let helpers = null;
  let ops = null;

  const view = {
    status: null,
    statusSeq: 0,
    statusLoading: false,
    statusForceRenderPending: false,
    tokenInfo: null,
    tokenInfoSeq: 0,
    tokenInfoLoading: false,
    tokenInfoForceRenderPending: false,
    tokenPending: false,
    tokenEditing: false,
    configPending: false,
    testPending: false,
    formDraft: null,
    formDirty: false,
    wechatBotTestPending: false,
    wechatBotTestResult: null,
    wechatBotTestSeq: 0,
    wechatBotDraft: null,
    wechatBotDirty: false,
    wechatBotEditing: false,
    wechatBotQrcodePending: false,
    wechatBotQrcodeImage: null,
    wechatBotQrcodeKey: null,
    wechatBotQrcodePollTimer: null,
    wechatBotQrcodeError: null,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.tgApproval;
    return {
      enabled: !!(cfg && cfg.enabled),
      allowedTgUserId: cfg && typeof cfg.allowedTgUserId === "string" ? cfg.allowedTgUserId : "",
      targetSessionKey: cfg && typeof cfg.targetSessionKey === "string" ? cfg.targetSessionKey : "",
      // Preserve notifyOnComplete across saves: recipient/toggle payloads are
      // built from this object, so omitting it would let normalize() reset a
      // user's explicit bare-ping choice on the next save.
      notifyOnComplete: !!(cfg && cfg.notifyOnComplete === true),
      completionOutputMode: cfg && (cfg.completionOutputMode === "full" || cfg.completionOutputMode === "tail")
        ? "full"
        : "off",
      r3DirectSendEnabled: !!(cfg && cfg.r3DirectSendEnabled === true),
    };
  }

  function getFormDraft() {
    if (!view.formDraft || !view.formDirty) {
      const cfg = currentConfig();
      view.formDraft = { allowedTgUserId: cfg.allowedTgUserId };
    }
    return view.formDraft;
  }

  function setFormDraftValue(key, value) {
    const draft = getFormDraft();
    draft[key] = value;
    view.formDirty = true;
  }

  function resetFormDraft() {
    view.formDraft = null;
    view.formDirty = false;
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

  function refreshStatus({ forceRender = false } = {}) {
    if (view.statusLoading) {
      if (forceRender) view.statusForceRenderPending = true;
      return;
    }
    view.statusLoading = true;
    const seq = ++view.statusSeq;
    callCommand("telegramApproval.status").then((result) => {
      if (seq !== view.statusSeq) return;
      view.statusLoading = false;
      const previousStatus = view.status;
      const hadStatus = !!previousStatus;
      const updated = result && result.status === "ok";
      const nextStatus = updated ? result.state || null : previousStatus;
      const shouldForceRender = forceRender || view.statusForceRenderPending;
      view.statusForceRenderPending = false;
      const changed = updated && statusRenderKey(previousStatus) !== statusRenderKey(nextStatus);
      if (updated) view.status = result.state || null;
      if ((shouldForceRender || (updated && (!hadStatus || changed))) && state.activeTab === "telegram-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function refreshTokenInfo({ forceRender = false } = {}) {
    if (view.tokenInfoLoading) {
      if (forceRender) view.tokenInfoForceRenderPending = true;
      return;
    }
    view.tokenInfoLoading = true;
    const seq = ++view.tokenInfoSeq;
    callCommand("telegramApproval.tokenInfo").then((result) => {
      if (seq !== view.tokenInfoSeq) return;
      view.tokenInfoLoading = false;
      const previous = view.tokenInfo;
      const updated = result && result.status === "ok";
      const next = updated ? { configured: !!result.configured, masked: result.masked || "" } : previous;
      const shouldForceRender = forceRender || view.tokenInfoForceRenderPending;
      view.tokenInfoForceRenderPending = false;
      const changed = updated && tokenInfoRenderKey(previous) !== tokenInfoRenderKey(next);
      if (updated) view.tokenInfo = next;
      if ((shouldForceRender || (updated && changed)) && state.activeTab === "telegram-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function statusRenderKey(status) {
    const s = status && typeof status === "object" ? status : {};
    return [
      s.status || "",
      s.transport || "",
      s.enabled === true ? "1" : "0",
      s.configured === true ? "1" : "0",
      s.reason || "",
      s.message || "",
      s.tokenStored === true ? "1" : "0",
    ].join("");
  }

  function tokenInfoRenderKey(info) {
    const i = info && typeof info === "object" ? info : {};
    return [i.configured === true ? "1" : "0", i.masked || ""].join("");
  }

  function render(parent) {
    refreshStatus();
    refreshTokenInfo();

    const h1 = document.createElement("h1");
    h1.textContent = t("remoteApprovalTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("remoteApprovalSubtitle");
    parent.appendChild(subtitle);

    // v0.9.0 migration: native vs sidecar transport selector. Lives ABOVE the
    // legacy Telegram card so users see migration progress before the legacy
    // setup steps.
    parent.appendChild(buildTelegramMigrationCard());

    // Each remote approval channel renders as its own collapsible card so the
    // page can stay tidy as external approval channels grow.
    parent.appendChild(buildTelegramChannelCard());
    parent.appendChild(buildHardwareBuddyChannelCard());
    parent.appendChild(buildWechatBotChannelCard());
  }

  // ── v0.9.0 migration card ──────────────────────────────────────────────────
  let migrationSnapshot = null;
  let migrationCardEl = null;
  let migrationPending = false;
  let migrationSnapshotSeq = 0;

  function migrationState() {
    return migrationSnapshot && typeof migrationSnapshot.state === "string"
      ? migrationSnapshot.state
      : "";
  }

  function isNativeMigrationSelected() {
    const s = migrationState();
    return s === "NATIVE_ACTIVE"
      || s === "TESTING_NATIVE"
      || !!(migrationSnapshot && migrationSnapshot.transport === "native");
  }

  function isNativeMigrationActive() {
    const s = migrationState();
    const owner = migrationSnapshot && migrationSnapshot.ownerSnapshot
      ? migrationSnapshot.ownerSnapshot
      : {};
    return s === "NATIVE_ACTIVE" || s === "TESTING_NATIVE" || owner.nativePolling === true;
  }

  function canStartNativeFromSwitch() {
    const s = migrationState();
    return s === "IDLE" || s === "NEEDS_SETUP" || s === "LEGACY_ACTIVE";
  }

  function statusIndicatesNativeApprovalActive() {
    const s = view.status || {};
    return s.transport === "native"
      && (s.enabled === true || s.status === "running" || s.status === "starting");
  }

  function effectiveTelegramApprovalEnabled(cfg) {
    return !!(cfg && cfg.enabled) || isNativeMigrationActive() || statusIndicatesNativeApprovalActive();
  }

  function migrationSnapshotRenderKey(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const owner = snap.ownerSnapshot && typeof snap.ownerSnapshot === "object"
      ? snap.ownerSnapshot
      : {};
    return [
      snap.state || "",
      snap.transport || "",
      owner.nativePolling === true ? "1" : "0",
      owner.sidecarRunning === true ? "1" : "0",
      snap.nativeVerifiedAt || "",
    ].join("\x1f");
  }

  function buildTelegramMigrationCard() {
    migrationCardEl = document.createElement("div");
    migrationCardEl.className = "tg-migration-card";
    renderMigrationCard();
    refreshMigrationSnapshot();
    return migrationCardEl;
  }

  function refreshMigrationSnapshot() {
    if (migrationPending) return;
    const seq = ++migrationSnapshotSeq;
    callCommand("telegramMigration.snapshot").then((res) => {
      if (seq !== migrationSnapshotSeq || migrationPending) return;
      if (res && res.status === "ok") {
        const previousKey = migrationSnapshotRenderKey(migrationSnapshot);
        migrationSnapshot = res.snapshot;
        renderMigrationCard();
        if (migrationSnapshotRenderKey(migrationSnapshot) !== previousKey
          && state.activeTab === "telegram-approval") {
          ops.requestRender({ content: true });
        }
      }
    });
  }

  function migrationDispatch(eventType, extra = {}) {
    if (migrationPending) return;
    migrationPending = true;
    renderMigrationCard();
    callCommand("telegramMigration.dispatch", { type: eventType, ...extra }).then((res) => {
      migrationPending = false;
      if (res && res.snapshot) migrationSnapshot = res.snapshot;
      if (res && res.status !== "ok" && res.errorCode) {
        ops.showToast(`Telegram migration: ${res.errorCode}`, { error: true });
      }
      renderMigrationCard();
      // Status of the legacy sidecar may change as a side-effect (start/stop).
      refreshStatus({ forceRender: true });
    });
  }

  function renderMigrationCard() {
    if (!migrationCardEl) return;
    migrationCardEl.innerHTML = "";
    const snap = migrationSnapshot;
    if (!snap) {
      migrationCardEl.textContent = "Loading migration status…";
      return;
    }
    const state = snap.state;
    const title = document.createElement("h3");
    title.textContent = "Telegram bot transport (v0.9.0 spike)";
    migrationCardEl.appendChild(title);

    const stateLine = document.createElement("p");
    stateLine.className = "tg-migration-state";
    stateLine.textContent = `State: ${state}` +
      (snap.runtimeStatus && snap.runtimeStatus.status === "failed"
        ? ` (runtime: failed — ${snap.runtimeStatus.reason || "unknown"})`
        : "");
    migrationCardEl.appendChild(stateLine);

    const ownerLine = document.createElement("p");
    ownerLine.className = "tg-migration-owner";
    const o = snap.ownerSnapshot || {};
    ownerLine.textContent = `Owner: sidecar=${o.sidecarRunning ? "running" : "stopped"}, native=${o.nativePolling ? "polling" : "stopped"}`;
    migrationCardEl.appendChild(ownerLine);

    const body = document.createElement("div");
    body.className = "tg-migration-body";
    migrationCardEl.appendChild(body);

    const importErr = snap.migrationInfo && snap.migrationInfo.importError;
    if (importErr && state === "LEGACY_ACTIVE") {
      const banner = document.createElement("div");
      banner.className = "tg-migration-banner";
      banner.textContent = `Native config import failed: ${importErr}`;
      body.appendChild(banner);
      body.appendChild(migrationButton("Retry import", () =>
        migrationDispatch("USER_TEST_NATIVE")));
    }

    switch (state) {
      case "IDLE":
      case "NEEDS_SETUP":
        body.appendChild(migrationCopy(
          "Configure the Telegram bot below, then choose how to run it:",
        ));
        body.appendChild(migrationButton("Test native bot and switch", () =>
          migrationDispatch("USER_TEST_NATIVE")));
        body.appendChild(migrationButton("Enable legacy sidecar", () =>
          migrationDispatch("USER_ENABLE_LEGACY")));
        break;
      case "LEGACY_ACTIVE":
        if (snap.runtimeStatus && snap.runtimeStatus.status === "failed") {
          body.appendChild(migrationCopy("Legacy sidecar is not running."));
          body.appendChild(migrationButton("Retry legacy sidecar", () =>
            migrationDispatch("USER_ENABLE_LEGACY")));
        }
        if (!snap.nativeVerifiedAt) {
          body.appendChild(migrationCopy(
            "Native Telegram bot is available. Test it to switch over — legacy stays as fallback.",
          ));
          body.appendChild(migrationButton("Test native and switch", () =>
            migrationDispatch("USER_TEST_NATIVE")));
        } else {
          body.appendChild(migrationCopy("Legacy sidecar is active."));
        }
        body.appendChild(migrationButton("Disable Telegram approval", () =>
          migrationDispatch("USER_DISABLE")));
        break;
      case "TESTING_NATIVE":
        body.appendChild(migrationCopy("Waiting for your Telegram tap… (60s timeout)"));
        break;
      case "NATIVE_ACTIVE":
        body.appendChild(migrationCopy(
          "Native Telegram is active. Legacy files kept for rollback.",
        ));
        body.appendChild(migrationButton("Roll back to legacy", () =>
          migrationDispatch("USER_ROLLBACK_TO_LEGACY")));
        body.appendChild(migrationButton("Delete legacy token file", deleteLegacyTokenFile));
        body.appendChild(migrationButton("Disable Telegram approval", () =>
          migrationDispatch("USER_DISABLE")));
        break;
      case "SWITCHING_TO_LEGACY":
        body.appendChild(migrationCopy("Switching to legacy approval…"));
        break;
    }
    if (migrationPending) {
      const pending = document.createElement("p");
      pending.className = "tg-migration-pending";
      pending.textContent = "Working…";
      migrationCardEl.appendChild(pending);
    }
  }

  function migrationCopy(text) {
    const p = document.createElement("p");
    p.className = "tg-migration-copy";
    p.textContent = text;
    return p;
  }

  function migrationButton(label, handler) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tg-migration-btn";
    btn.textContent = label;
    btn.disabled = migrationPending;
    btn.addEventListener("click", handler);
    return btn;
  }

  function deleteLegacyTokenFile() {
    if (migrationPending) return;
    migrationPending = true;
    renderMigrationCard();
    callCommand("telegramApproval.deleteTokenFile").then((res) => {
      migrationPending = false;
      if (res && res.status === "ok") {
        ops.showToast(res.deleted === false
          ? "Telegram token file was already removed."
          : "Telegram token file deleted.");
      } else {
        ops.showToast((res && res.message) || "Telegram token file delete failed", { error: true });
      }
      view.tokenInfo = null;
      view.status = null;
      renderMigrationCard();
      refreshTokenInfo({ forceRender: true });
      refreshStatus({ forceRender: true });
      refreshMigrationSnapshot();
    });
  }

  function buildTelegramChannelCard() {
    const kind = deriveCardKind();
    // Default-collapse the card once the sidecar is actually running — the
    // user no longer needs to see the setup steps. localStorage persists any
    // manual expand/collapse from there.
    const defaultCollapsed = kind === "running";

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.telegram",
      headerContent: buildChannelHeader(t("telegramApprovalChannelName"), kind),
      defaultCollapsed,
      className: "remote-approval-channel-card tg-approval-channel-card",
      children: [
        buildChannelStatusRow(kind),
        helpers.buildSection(t("telegramApprovalStep1Title"), [buildTokenRow()]),
        helpers.buildSection(t("telegramApprovalStep2Title"), [buildRecipientRow()]),
        buildStep3Section(),
      ],
    });
  }

  function buildHardwareBuddyChannelCard() {
    return root.ClawdSettingsHardwareBuddyPanel.build(coreRef, {
      id: "remote-approval.hardware-buddy",
      activeTabId: "telegram-approval",
      className: "remote-approval-channel-card",
    });
  }

  function buildChannelHeader(channelName, kind) {
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "tg-approval-channel-name";
    nameEl.textContent = channelName;
    wrap.appendChild(nameEl);

    const badge = document.createElement("span");
    badge.className = "tg-approval-channel-badge " + statusBadgeClass(kind);
    const dot = document.createElement("span");
    dot.className = "tg-approval-channel-badge-dot";
    badge.appendChild(dot);
    const badgeText = document.createElement("span");
    badgeText.textContent = t("telegramApprovalCardKind_" + kind);
    badge.appendChild(badgeText);
    wrap.appendChild(badge);

    return wrap;
  }

  function buildChannelStatusRow(kind) {
    const row = document.createElement("div");
    row.className = "tg-approval-channel-status-row " + statusBadgeClass(kind);
    const text = document.createElement("span");
    text.className = "tg-approval-channel-status-text";
    text.textContent = deriveCardMessage(kind);
    row.appendChild(text);
    return row;
  }

  function statusBadgeClass(kind) {
    switch (kind) {
      case "running": return "tg-approval-badge-running";
      case "starting": return "tg-approval-badge-starting";
      case "failed": return "tg-approval-badge-failed";
      case "ready": return "tg-approval-badge-ready";
      case "incomplete":
      default: return "tg-approval-badge-incomplete";
    }
  }

  // ── Status helpers ──

  function deriveCardKind() {
    const s = view.status || {};
    if (s.status === "running") return "running";
    if (s.status === "starting") return "starting";
    if (s.status === "failed") return "failed";
    if (s.configured === true) return "ready";
    return "incomplete";
  }

  function deriveCardMessage(kind) {
    const s = view.status || {};
    if (kind === "failed") {
      return s.message || t("telegramApprovalCardFailed");
    }
    if (kind === "running") return t("telegramApprovalCardRunning");
    if (kind === "starting") return t("telegramApprovalCardStarting");
    if (kind === "ready") return t("telegramApprovalCardReadyToEnable");
    // incomplete — pick the most actionable missing piece
    const tokenOk = !!(view.tokenInfo && view.tokenInfo.configured) || s.tokenStored === true;
    const cfg = currentConfig();
    const recipientOk = !!cfg.allowedTgUserId;
    if (!tokenOk && !recipientOk) return t("telegramApprovalCardMissingBoth");
    if (!tokenOk) return t("telegramApprovalCardMissingToken");
    if (!recipientOk) return t("telegramApprovalCardMissingRecipient");
    return t("telegramApprovalCardReadyToEnable");
  }

  // ── Step 1: Bot Token ──

  function buildTokenRow() {
    const info = view.tokenInfo;
    const configured = !!(info && info.configured);
    if (configured && !view.tokenEditing) {
      return buildTokenStoredRow(info);
    }
    return buildTokenEditRow({ configured, masked: info ? info.masked : "" });
  }

  function buildTokenStoredRow(info) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-stored-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label tg-approval-token-stored-label";
    label.textContent = t("telegramApprovalTokenConfiguredLabel");
    const masked = document.createElement("span");
    masked.className = "tg-approval-token-masked";
    masked.textContent = info && info.masked ? info.masked : t("telegramApprovalTokenConfiguredNoMask");
    label.appendChild(masked);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalTokenConfiguredDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn";
    btn.textContent = t("telegramApprovalReplaceToken");
    btn.addEventListener("click", () => {
      view.tokenEditing = true;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildTokenEditRow({ configured, masked }) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-edit-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalBotToken");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = configured
      ? escapeWithLink(t("telegramApprovalTokenReplaceHintHtml"))
      : escapeWithLink(t("telegramApprovalBotTokenHintHtml"));
    text.appendChild(label);
    if (configured && masked) {
      const current = document.createElement("span");
      current.className = "tg-approval-token-current";
      current.textContent = t("telegramApprovalTokenCurrent").replace("{masked}", masked);
      text.appendChild(current);
    }
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("telegramApprovalBotTokenPlaceholder");
    input.className = "tg-approval-input";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.tokenPending ? t("telegramApprovalSaving") : t("telegramApprovalSaveToken");
    saveBtn.disabled = view.tokenPending;
    saveBtn.addEventListener("click", () => {
      const token = input.value.trim();
      if (!token) {
        ops.showToast(t("telegramApprovalTokenEmpty"), { error: true });
        return;
      }
      view.tokenPending = true;
      ops.requestRender({ content: true });
      callCommand("telegramApproval.setToken", { token }).then((result) => {
        view.tokenPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast((result && result.message) || t("telegramApprovalTokenSaveFailed"), { error: true });
          ops.requestRender({ content: true });
          return;
        }
        ops.showToast(t("telegramApprovalTokenSaved"));
        input.value = "";
        view.tokenEditing = false;
        view.tokenInfo = null;
        view.status = null;
        refreshTokenInfo({ forceRender: true });
        refreshStatus({ forceRender: true });
      });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);

    if (configured) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "soft-btn";
      cancelBtn.textContent = t("telegramApprovalCancel");
      cancelBtn.disabled = view.tokenPending;
      cancelBtn.addEventListener("click", () => {
        view.tokenEditing = false;
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(cancelBtn);
    }

    row.appendChild(ctrl);
    return row;
  }

  // ── Step 2: Recipient ──

  function buildRecipientRow() {
    const draft = getFormDraft();
    const row = document.createElement("div");
    row.className = "row tg-approval-recipient-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalRecipientLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = escapeWithLink(t("telegramApprovalRecipientHintHtml"));
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.spellcheck = false;
    input.placeholder = t("telegramApprovalRecipientPlaceholder");
    input.className = "tg-approval-input";
    input.value = draft.allowedTgUserId || "";
    input.addEventListener("input", () => setFormDraftValue("allowedTgUserId", input.value));

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.configPending ? t("telegramApprovalSaving") : t("telegramApprovalSaveRecipient");
    saveBtn.disabled = view.configPending;
    saveBtn.addEventListener("click", () => {
      const raw = String(getFormDraft().allowedTgUserId || "").trim();
      if (!raw) {
        ops.showToast(t("telegramApprovalRecipientEmpty"), { error: true });
        return;
      }
      if (!/^[1-9]\d{4,19}$/.test(raw)) {
        ops.showToast(t("telegramApprovalRecipientInvalid"), { error: true });
        return;
      }
      saveConfig({
        enabled: currentConfig().enabled,
        allowedTgUserId: raw,
        // UI never asks for chat id separately. We mirror user id into the
        // session key — main-side normalizeTelegramSessionKey adds the
        // `telegram:` prefix. Private-chat scenarios always have chat_id ===
        // user_id in Telegram, so this is correct for the supported path.
        targetSessionKey: raw,
        notifyOnComplete: currentConfig().notifyOnComplete,
        completionOutputMode: currentConfig().completionOutputMode,
        r3DirectSendEnabled: currentConfig().r3DirectSendEnabled,
      });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  // ── Step 3: Enable + Test ──

  function buildStep3Section() {
    const tokenConfigured = !!(view.tokenInfo && view.tokenInfo.configured)
      || (view.status && view.status.tokenStored === true);
    const cfg = currentConfig();
    const recipientConfigured = !!cfg.allowedTgUserId;
    const ready = tokenConfigured && recipientConfigured;

    const rows = [];
    if (!ready) {
      rows.push(buildPrerequisitesRow({ tokenConfigured, recipientConfigured }));
    }
    rows.push(buildEnabledRow({ ready }));
    rows.push(buildCompletionOutputRow());
    rows.push(buildDirectSendRow({ ready }));
    rows.push(buildTestRow({ ready }));
    return helpers.buildSection(t("telegramApprovalStep3Title"), rows);
  }

  function buildPrerequisitesRow({ tokenConfigured, recipientConfigured }) {
    const row = document.createElement("div");
    row.className = "row tg-approval-prereq-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalPrereqLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    const missing = [];
    if (!tokenConfigured) missing.push(t("telegramApprovalPrereqMissingToken"));
    if (!recipientConfigured) missing.push(t("telegramApprovalPrereqMissingRecipient"));
    desc.textContent = t("telegramApprovalPrereqDesc") + " " + missing.join("、");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);
    return row;
  }

  function buildEnabledRow({ ready }) {
    const cfg = currentConfig();
    const effectiveEnabled = effectiveTelegramApprovalEnabled(cfg);
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalToggle");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalToggleDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, effectiveEnabled, { pending: view.configPending || migrationPending });
    const canToggle = ready && !migrationPending && (effectiveEnabled || migrationSnapshot);
    if (!canToggle) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => {
        const turningOff = effectiveEnabled === true;
        // Stop-the-bleed (zombie switch — see docs audit-r1a-notification-switch-2026-05-30):
        // this toggle only writes tgApproval.enabled, but v0.9.0 native runtime
        // (completion notifications + approval transport) is owned by the migration
        // state machine and never reads that field. Turning the switch OFF must also
        // dispatch USER_DISABLE, otherwise the native poller + completion pings keep
        // running and the user thinks they switched it off when they didn't. The
        // ON path now goes through the same native Test flow as the migration
        // card instead of reviving the legacy sidecar flag.
        if (turningOff) {
          if (cfg.enabled === true) {
            saveConfig({ ...cfg, enabled: false }, { resetDraft: false });
          }
          migrationDispatch("USER_DISABLE");
          return;
        }
        if (migrationSnapshot && canStartNativeFromSwitch()) {
          ops.requestRender({ content: true });
          migrationDispatch("USER_TEST_NATIVE");
          return;
        }
      };
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") {
          ev.preventDefault();
          toggle();
        }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildDirectSendRow({ ready }) {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row tg-approval-direct-send-row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalDirectSend");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalDirectSendDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.r3DirectSendEnabled === true, { pending: view.configPending });
    if (!ready || view.configPending) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => {
        saveConfig({ ...cfg, r3DirectSendEnabled: cfg.r3DirectSendEnabled !== true }, { resetDraft: false });
      };
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") {
          ev.preventDefault();
          toggle();
        }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildCompletionOutputRow() {
    const cfg = currentConfig();
    const mode = ["off", "full"].includes(cfg.completionOutputMode)
      ? cfg.completionOutputMode
      : "off";
    const row = document.createElement("div");
    row.className = "row tg-approval-completion-output-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalCompletionOutput");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalCompletionOutputDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const select = document.createElement("select");
    select.className = "tg-approval-input tg-approval-output-select";
    select.disabled = view.configPending;
    for (const value of ["off", "full"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t("telegramApprovalCompletionOutput_" + value);
      select.appendChild(option);
    }
    select.value = mode;
    select.addEventListener("change", () => {
      const nextMode = ["off", "full"].includes(select.value) ? select.value : "off";
      if (nextMode === mode) return;
      if (nextMode === "full") {
        const ok = window.confirm(t("telegramApprovalCompletionOutputFullConfirm"));
        if (!ok) {
          select.value = mode;
          return;
        }
      }
      saveConfig({ ...cfg, completionOutputMode: nextMode }, { resetDraft: false });
    });
    ctrl.appendChild(select);
    row.appendChild(ctrl);
    return row;
  }

  function buildTestRow({ ready }) {
    const s = view.status || {};
    const runtimeReady = s.configured === true;
    const nativeStatus = s.transport === "native" || isNativeMigrationSelected();
    const nativeReady = !nativeStatus || (migrationState() === "NATIVE_ACTIVE" && s.status === "running");
    const testDisabled = view.testPending || !ready || !runtimeReady || !nativeReady;
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalTest");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalTestDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = view.testPending ? t("telegramApprovalTesting") : t("telegramApprovalSendTest");
    btn.disabled = testDisabled;
    if (testDisabled && !view.testPending) {
      btn.title = (s.message && String(s.message)) || t("telegramApprovalCardMissingBoth");
    }
    btn.addEventListener("click", () => {
      if (testDisabled) return;
      view.testPending = true;
      ops.requestRender({ content: true });
      callCommand("telegramApproval.test").then((result) => {
        view.testPending = false;
        if (result && result.status === "ok") {
          ops.showToast(t("telegramApprovalTestSent"));
        } else {
          ops.showToast((result && result.message) || t("telegramApprovalTestFailed"), { error: true });
        }
        view.status = null;
        refreshStatus({ forceRender: true });
      });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  // ── WeChat Bot channel card ──

  function currentWechatBotConfig() {
    const cfg = state.snapshot && state.snapshot.wechatBot;
    return {
      enabled: !!(cfg && cfg.enabled),
      token: cfg && typeof cfg.token === "string" ? cfg.token : "",
      approvalEnabled: !!(cfg && cfg.approvalEnabled !== false),
      baseUrl: cfg && typeof cfg.baseUrl === "string" ? cfg.baseUrl : "",
      accountId: cfg && typeof cfg.accountId === "string" ? cfg.accountId : "default",
    };
  }

  function wechatBotStatusKind(cfg) {
    if (!cfg.token) return "incomplete";
    return "ready";
  }

  function buildWechatBotChannelCard() {
    const cfg = currentWechatBotConfig();
    const statusKind = wechatBotStatusKind(cfg);
    return helpers.buildCollapsibleGroup({
      id: "remote-approval.wechat-bot",
      headerContent: buildWechatBotChannelHeader(statusKind),
      defaultCollapsed: false,
      className: "remote-approval-channel-card tg-approval-channel-card",
      children: [
        buildWechatBotStatusRow(cfg, statusKind),
        helpers.buildSection(t("wechatBotToken"), [buildWechatBotTokenRow(cfg)]),
        helpers.buildSection("Enable / Test", [buildWechatBotEnabledRow(cfg), buildWechatBotTestRow(cfg)]),
      ],
    });
  }

  function buildWechatBotChannelHeader(kind) {
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "tg-approval-channel-name";
    nameEl.textContent = t("wechatBot");
    wrap.appendChild(nameEl);

    const badge = document.createElement("span");
    badge.className = "tg-approval-channel-badge " + statusBadgeClass(kind);
    const dot = document.createElement("span");
    dot.className = "tg-approval-channel-badge-dot";
    badge.appendChild(dot);
    const badgeText = document.createElement("span");
    badgeText.textContent = t("telegramApprovalCardKind_" + kind);
    badge.appendChild(badgeText);
    wrap.appendChild(badge);

    return wrap;
  }

  function buildWechatBotStatusRow(cfg, kind) {
    const row = document.createElement("div");
    row.className = "tg-approval-channel-status-row " + statusBadgeClass(kind);
    const text = document.createElement("span");
    text.className = "tg-approval-channel-status-text";
    if (!cfg.token) {
      text.textContent = "Not configured — login via QR code or paste your Bearer token below.";
    } else {
      text.textContent = "Token configured. Ready to receive approval requests.";
    }
    row.appendChild(text);
    return row;
  }

  function buildWechatBotTokenRow(cfg) {
    if (cfg.token && !view.wechatBotEditing) {
      return buildWechatBotTokenStoredRow();
    }
    return buildWechatBotTokenEditRow(cfg);
  }

  function buildWechatBotTokenStoredRow() {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-stored-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label tg-approval-token-stored-label";
    label.textContent = "Token is configured";
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = "Your ilink Bearer token is stored locally. Click Replace to update it.";
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn";
    btn.textContent = "Replace Token";
    btn.addEventListener("click", () => {
      view.wechatBotEditing = true;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildWechatBotTokenEditRow(cfg) {
    const row = document.createElement("div");
    row.className = "row tg-approval-recipient-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("wechatBotToken");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = cfg.token
      ? "Enter a new token to replace the current one."
      : "Paste your ilink Bearer token, or login via QR code below.";
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = cfg.token ? "Leave blank to keep current" : "Paste ilink Bearer token";
    input.className = "tg-approval-input";
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const val = String(input.value || "").trim();
        if (!val) return;
        saveWechatBotToken(val);
        input.value = "";
        view.wechatBotEditing = false;
        ops.requestRender({ content: true });
      }
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const val = String(input.value || "").trim();
      if (!val) return;
      saveWechatBotToken(val);
      input.value = "";
      view.wechatBotEditing = false;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);

    if (cfg.token) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "soft-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => {
        view.wechatBotEditing = false;
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(cancelBtn);
    }
    row.appendChild(ctrl);

    // ── QR Code login section ──
    if (!cfg.token) {
      const qrRow = document.createElement("div");
      qrRow.className = "row";
      qrRow.style.display = "flex";
      qrRow.style.flexDirection = "column";
      qrRow.style.paddingLeft = "0";

      const qrText = document.createElement("div");
      qrText.className = "row-text";
      const qrLabel = document.createElement("span");
      qrLabel.className = "row-label";
      qrLabel.textContent = "Login with QR Code";
      const qrDesc = document.createElement("span");
      qrDesc.className = "row-desc";
      qrDesc.textContent = view.wechatBotQrcodeImage
        ? "Scan the QR code with WeChat to login."
        : "Click the button below to generate a WeChat login QR code.";
      qrText.appendChild(qrLabel);
      qrText.appendChild(qrDesc);
      qrRow.appendChild(qrText);

      if (view.wechatBotQrcodeImage) {
        const img = document.createElement("img");
        img.src = view.wechatBotQrcodeImage;
        img.alt = "WeChat login QR code";
        img.style.width = "180px";
        img.style.height = "180px";
        img.style.margin = "8px 0";
        img.style.borderRadius = "8px";
        img.style.alignSelf = "center";
        qrRow.appendChild(img);

        const hint = document.createElement("span");
        hint.className = "row-desc";
        hint.textContent = "Open WeChat on your phone, scan QR code, and tap Login.";
        hint.style.textAlign = "center";
        qrRow.appendChild(hint);
      }

      if (view.wechatBotQrcodeError) {
        const errEl = document.createElement("span");
        errEl.className = "form-error";
        errEl.textContent = view.wechatBotQrcodeError;
        qrRow.appendChild(errEl);
      }

      row.appendChild(qrRow);

      const btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "8px";
      btnRow.style.marginTop = "8px";

      const qrBtn = document.createElement("button");
      qrBtn.type = "button";
      qrBtn.className = "soft-btn accent";
      qrBtn.textContent = view.wechatBotQrcodePending ? "Generating QR code…" : "Get QR Code";
      qrBtn.disabled = view.wechatBotQrcodePending;
      qrBtn.addEventListener("click", () => {
        startWechatQrcodeLogin();
      });
      btnRow.appendChild(qrBtn);

      if (view.wechatBotQrcodeImage) {
        const cancelQrBtn = document.createElement("button");
        cancelQrBtn.type = "button";
        cancelQrBtn.className = "soft-btn";
        cancelQrBtn.textContent = "Cancel QR Login";
        cancelQrBtn.addEventListener("click", () => {
          cancelWechatQrcodeLogin();
        });
        btnRow.appendChild(cancelQrBtn);
      }

      row.appendChild(btnRow);
    }

    return row;
  }

  function normalizeQrcodeImage(raw) {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s) return null;
    // Already a data URL or http(s) URL
    if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) {
      return s;
    }
    // Likely raw base64 — prepend PNG data URL prefix
    return `data:image/png;base64,${s}`;
  }

  function startWechatQrcodeLogin() {
    if (view.wechatBotQrcodePending) return;
    view.wechatBotQrcodePending = true;
    view.wechatBotQrcodeError = null;
    ops.requestRender({ content: true });

    callCommand("wechatBot.getQrcode").then((result) => {
      view.wechatBotQrcodePending = false;
      if (!result || result.status !== "ok" || !result.qrcode) {
        view.wechatBotQrcodeError = (result && result.message) || "Failed to get QR code";
        ops.requestRender({ content: true });
        return;
      }
      view.wechatBotQrcodeImage = normalizeQrcodeImage(result.qrcodeImg);
      view.wechatBotQrcodeKey = result.qrcode;
      ops.requestRender({ content: true });
      // Start polling for scan status
      pollWechatQrcodeStatus();
    }).catch((err) => {
      view.wechatBotQrcodePending = false;
      view.wechatBotQrcodeError = err && err.message ? err.message : "Failed to get QR code";
      ops.requestRender({ content: true });
    });
  }

  function pollWechatQrcodeStatus() {
    if (!view.wechatBotQrcodeKey) return;

    callCommand("wechatBot.pollQrcodeStatus", { qrcode: view.wechatBotQrcodeKey }).then((result) => {
      if (!result || !view.wechatBotQrcodeKey) return;

      if (result.status === "ok" && result.botToken) {
        // Login success!
        saveWechatBotToken(result.botToken);
        cancelWechatQrcodeLogin();
        view.wechatBotEditing = false;
        ops.requestRender({ content: true });
        ops.showToast("WeChat login successful!");
        return;
      }

      if (result.status === "pending") {
        // Still waiting - poll again after 1.5s
        view.wechatBotQrcodePollTimer = setTimeout(() => {
          pollWechatQrcodeStatus();
        }, 1500);
      } else if (result.status === "error") {
        view.wechatBotQrcodeError = result.message || "QR code expired or login failed";
        view.wechatBotQrcodeImage = null;
        view.wechatBotQrcodeKey = null;
        ops.requestRender({ content: true });
      } else if (result.status === "timeout") {
        view.wechatBotQrcodeError = "QR code expired. Please generate a new one.";
        view.wechatBotQrcodeImage = null;
        view.wechatBotQrcodeKey = null;
        ops.requestRender({ content: true });
      }
    }).catch(() => {
      // Retry on network error
      view.wechatBotQrcodePollTimer = setTimeout(() => {
        pollWechatQrcodeStatus();
      }, 2000);
    });
  }

  function cancelWechatQrcodeLogin() {
    if (view.wechatBotQrcodePollTimer) {
      clearTimeout(view.wechatBotQrcodePollTimer);
      view.wechatBotQrcodePollTimer = null;
    }
    view.wechatBotQrcodeImage = null;
    view.wechatBotQrcodeKey = null;
    view.wechatBotQrcodeError = null;
    ops.requestRender({ content: true });
  }

  function buildWechatBotEnabledRow(cfg) {
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = "Enabled";
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("wechatBotApprovalEnabledDescription");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.enabled);
    const ready = wechatBotStatusKind(cfg) === "ready";
    if (!ready) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => {
        saveWechatBotField("enabled", !cfg.enabled);
      };
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") {
          ev.preventDefault();
          toggle();
        }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildWechatBotTestRow(cfg) {
    const ready = wechatBotStatusKind(cfg) === "ready";
    const testDisabled = view.wechatBotTestPending || !ready || !cfg.enabled;
    const row = document.createElement("div");
    row.className = "row";
    if (!ready || !cfg.enabled) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("wechatBotTestConnection");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = "Verify that the WeChat Bot can connect to the ilink gateway.";
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = view.wechatBotTestPending ? "Testing…" : t("wechatBotTestConnection");
    btn.disabled = testDisabled;
    btn.addEventListener("click", () => {
      if (testDisabled) return;
      view.wechatBotTestPending = true;
      view.wechatBotTestResult = null;
      ops.requestRender({ content: true });
      callCommand("wechatBot.test").then((result) => {
        view.wechatBotTestPending = false;
        view.wechatBotTestResult = result;
        ops.requestRender({ content: true });
        if (result && result.status === "ok") {
          ops.showToast(t("wechatBotTestSuccess"));
        } else {
          ops.showToast((result && result.message) || t("wechatBotTestFailed"), { error: true });
        }
      });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);

    if (view.wechatBotTestResult && view.wechatBotTestResult.status !== "ok") {
      const errEl = document.createElement("div");
      errEl.className = "form-error";
      errEl.textContent = view.wechatBotTestResult.message || "Unknown error";
      row.appendChild(errEl);
    }

    return row;
  }

  function saveWechatBotToken(token) {
    saveWechatBotField("token", token);
  }

  function saveWechatBotField(key, value) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    const current = (state.snapshot && state.snapshot.wechatBot) ? { ...state.snapshot.wechatBot } : {};
    current[key] = value;
    window.settingsAPI.update("wechatBot", current).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
      } else {
        ops.showToast("WeChat Bot config saved.");
      }
      ops.requestRender({ content: true });
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    });
  }

  // ── Save / shared ──

  function saveConfig(next, options = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    view.configPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.update("tgApproval", next).then((result) => {
      view.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t("telegramApprovalConfigSaved"));
      if (options.resetDraft !== false) resetFormDraft();
      view.status = null;
      refreshStatus({ forceRender: true });
    }).catch((err) => {
      view.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
    });
  }

  // ── Helpers ──

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // i18n hint strings use a constrained mini-syntax: literal text plus
  // [text](https://...) link tokens. We escape the literal text and only
  // expand whitelisted https://t.me/* links so a malicious translation can't
  // inject arbitrary HTML.
  function escapeWithLink(text) {
    const raw = String(text == null ? "" : text);
    const parts = [];
    let lastIdx = 0;
    const re = /\[([^\]]+)\]\((https:\/\/t\.me\/[A-Za-z0-9_./?#=&-]+)\)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      parts.push(escapeHtml(raw.slice(lastIdx, match.index)));
      parts.push(`<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`);
      lastIdx = match.index + match[0].length;
    }
    parts.push(escapeHtml(raw.slice(lastIdx)));
    return parts.join("");
  }

  function init(core) {
    coreRef = core;
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["telegram-approval"] = { render };
  }

  root.ClawdSettingsTabTelegramApproval = { init };
})(globalThis);
