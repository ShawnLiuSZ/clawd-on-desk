"use strict";

// ── Lark card button-text i18n ──
// Small, self-contained string pool for the Lark bot card BUTTON labels only.
// Kept separate from src/i18n.js (the menu/settings pool) so the pure-Node
// lark-bot-client stays focused. Values may contain {tool}/{mode}/{n}/{code} placeholders.

const LARK_CARD_STRINGS = {
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
    submitDone: "Done (selected {n})",
    approvalHint: "Reply y/n for quick decision | Code: {code}",
    stateIdle: "Idle",
    stateWorking: "Working",
    stateThinking: "Thinking",
    stateAttention: "Attention",
    stateError: "Error",
    stateNotification: "Notification",
    stateSleeping: "Sleeping",
    stateSweeping: "Sweeping",
    stateJuggling: "Juggling",
    stateCarrying: "Carrying",
  },
  zh: {
    allow: "允许",
    deny: "拒绝",
    alwaysAllow: "始终允许",
    alwaysDenyTool: "始终拒绝 {tool}",
    alwaysTool: "始终 {tool}",
    alwaysDeny: "始终拒绝",
    autoEdits: "自动编辑",
    planMode: "计划模式",
    modePrefix: "模式: {mode}",
    submitDone: "完成 (已选 {n})",
    approvalHint: "回复 y/n 快速决策 | 短码: {code}",
    stateIdle: "空闲",
    stateWorking: "工作中",
    stateThinking: "思考中",
    stateAttention: "注意",
    stateError: "错误",
    stateNotification: "通知",
    stateSleeping: "休眠",
    stateSweeping: "清理中",
    stateJuggling: "多任务中",
    stateCarrying: "搬运中",
  },
  "zh-TW": {
    allow: "允許",
    deny: "拒絕",
    alwaysAllow: "始終允許",
    alwaysDenyTool: "始終拒絕 {tool}",
    alwaysTool: "始終 {tool}",
    alwaysDeny: "始終拒絕",
    autoEdits: "自動編輯",
    planMode: "計劃模式",
    modePrefix: "模式: {mode}",
    submitDone: "完成 (已選 {n})",
    approvalHint: "回覆 y/n 快速決策 | 短碼: {code}",
    stateIdle: "閒置",
    stateWorking: "工作中",
    stateThinking: "思考中",
    stateAttention: "注意",
    stateError: "錯誤",
    stateNotification: "通知",
    stateSleeping: "休眠",
    stateSweeping: "清理中",
    stateJuggling: "多任務中",
    stateCarrying: "搬運中",
  },
  ko: {
    allow: "허용",
    deny: "거부",
    alwaysAllow: "항상 허용",
    alwaysDenyTool: "항상 {tool} 거부",
    alwaysTool: "항상 {tool}",
    alwaysDeny: "항상 거부",
    autoEdits: "자동 편집",
    planMode: "계획 모드",
    modePrefix: "모드: {mode}",
    submitDone: "완료 ({n}개 선택)",
    approvalHint: "y/n로 빠른 결정 | 코드: {code}",
    stateIdle: "유휴",
    stateWorking: "작업 중",
    stateThinking: "사고 중",
    stateAttention: "주의",
    stateError: "오류",
    stateNotification: "알림",
    stateSleeping: "수면",
    stateSweeping: "정리 중",
    stateJuggling: "다중 작업 중",
    stateCarrying: "운반 중",
  },
  ja: {
    allow: "許可",
    deny: "拒否",
    alwaysAllow: "常に許可",
    alwaysDenyTool: "常に {tool} を拒否",
    alwaysTool: "常に {tool}",
    alwaysDeny: "常に拒否",
    autoEdits: "自動編集",
    planMode: "プランモード",
    modePrefix: "モード: {mode}",
    submitDone: "完了 ({n}個選択)",
    approvalHint: "y/n で迅速な決定 | コード: {code}",
    stateIdle: "アイドル",
    stateWorking: "作業中",
    stateThinking: "思考中",
    stateAttention: "注意",
    stateError: "エラー",
    stateNotification: "通知",
    stateSleeping: "スリープ",
    stateSweeping: "清掃中",
    stateJuggling: "マルチタスク中",
    stateCarrying: "搬送中",
  },
};

function larkCardText(lang, key, params) {
  const strings = LARK_CARD_STRINGS[lang] || LARK_CARD_STRINGS.en;
  let text = strings[key] || LARK_CARD_STRINGS.en[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

module.exports = {
  LARK_CARD_STRINGS,
  larkCardText,
};
