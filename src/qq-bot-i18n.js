"use strict";

// ── QQ card button-text i18n ──
// Small, self-contained string pool for the QQ bot card BUTTON labels only.
// Kept separate from src/i18n.js (the menu/settings pool) so the pure-Node
// qq-bot-client stays focused. Values may contain {tool}/{mode}/{n} placeholders.

const QQ_CARD_STRINGS = {
  en: {
    allow: "Allow",
    deny: "Deny",
    alwaysAllow: "Always allow",
    alwaysDenyTool: "Always deny {tool}",
    alwaysTool: "Always {tool}",
    alwaysDeny: "Always deny",
    autoEdits: "Auto edits",
    planMode: "Plan mode",
    modePrefix: "Mode: {mode}",
    submitDone: "Done ({n} selected)",
  },
  zh: {
    allow: "批准",
    deny: "拒绝",
    alwaysAllow: "始终允许",
    alwaysDenyTool: "始终拒绝 {tool}",
    alwaysTool: "始终允许 {tool}",
    alwaysDeny: "始终拒绝",
    autoEdits: "自动编辑",
    planMode: "计划模式",
    modePrefix: "模式：{mode}",
    submitDone: "完成（已选 {n}）",
  },
  "zh-TW": {
    allow: "允許",
    deny: "拒絕",
    alwaysAllow: "一律允許",
    alwaysDenyTool: "一律拒絕 {tool}",
    alwaysTool: "一律允許 {tool}",
    alwaysDeny: "一律拒絕",
    autoEdits: "自動編輯",
    planMode: "計畫模式",
    modePrefix: "模式：{mode}",
    submitDone: "完成（已選 {n}）",
  },
  ko: {
    allow: "허용",
    deny: "거부",
    alwaysAllow: "항상 허용",
    alwaysDenyTool: "항상 {tool} 거부",
    alwaysTool: "항상 {tool} 허용",
    alwaysDeny: "항상 거부",
    autoEdits: "자동 편집",
    planMode: "플랜 모드",
    modePrefix: "모드: {mode}",
    submitDone: "완료 ({n}개 선택)",
  },
  ja: {
    allow: "許可",
    deny: "拒否",
    alwaysAllow: "常に許可",
    alwaysDenyTool: "常に {tool} を拒否",
    alwaysTool: "常に {tool} を許可",
    alwaysDeny: "常に拒否",
    autoEdits: "自動編集",
    planMode: "プランモード",
    modePrefix: "モード: {mode}",
    submitDone: "完了（{n}件選択）",
  },
};

function qqCardText(lang, key, params) {
  const dict = QQ_CARD_STRINGS[lang] || QQ_CARD_STRINGS.en;
  let s = dict[key];
  if (s == null) s = (QQ_CARD_STRINGS.en[key] != null ? QQ_CARD_STRINGS.en[key] : key);
  if (params && typeof s === "string") {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m);
  }
  return s;
}

module.exports = { QQ_CARD_STRINGS, qqCardText };
