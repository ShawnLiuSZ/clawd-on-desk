# QQ 卡片按钮文字本地化设计

**日期**: 2026-06-12
**状态**: 已确认，待转实现计划
**涉及文件**: `src/qq-bot-i18n.js`（新增）, `src/qq-bot-client.js`, `src/main.js`, `test/qq-bot-i18n.test.js`（新增）, `test/qq-bot-client.test.js`

## 背景与问题

QQ 机器人卡片的按钮文字目前是**硬编码英文**（`✅ Allow` / `❌ Deny`、`buildSuggestionLabel` 产出的 `Always allow` 等），而正文提示是中文，整体中英文混搭。用户希望**按钮文字跟随 app 的语言设置**（`lang`）。

本设计只本地化**我们自己生成的按钮文字**，不动正文提示、确认回执、文字兜底请求，也不动 elicitation 选项按钮（那是 agent 传入的 `option.label`，非我方文案）。

## 现状架构（已确认）

- app 语言存于设置键 `lang`；主进程持有 `let lang = _settingsController.get("lang")`（`main.js:318`），语言切换经 ctx 的 `lang:` setter 更新（`main.js:2867`）。
- 支持语言：`["en", "zh", "zh-TW", "ko", "ja"]`（`i18n.js` 的 `SUPPORTED_LANGS`）。
- `src/i18n.js` 是纯 Node、可 require 的翻译器（`createTranslator(getLang)` 回调模式，支持运行时切换），但它装的是**菜单/设置**串池，不含卡片串。
- QQ client（`qq-bot-client.js`）是纯 Node、无 Electron 依赖，当前不知道语言。**所有按钮文字都在 client 内生成**（`buildApprovalCard` 的 Allow/Deny、`buildSuggestionLabel`、`buildMultiSelectElicitationCard` 的完成按钮）；`qq-approval.js` 不生成按钮文字。

## 设计

### 1. 范围（只按钮文字）

跟随 `lang` 翻译：

- 审批卡按钮：`Allow`、`Deny`
- 审批建议按钮（`buildSuggestionLabel` 产出）：`Always allow`、`Always deny {tool}`、`Always {tool}`、`Always deny`、`Auto edits`、`Plan mode`、`Mode: {mode}`
- 多选提交按钮：`完成 (已选 {n})`

**不动**：正文 hint（点按钮 / 回复 y-n）、确认回执（Allowed/Denied）、文字兜底请求（`buildTextRequest`）、cancelApproval 文字、elicitation 选项按钮（agent 文案）。

注：`buildSuggestionLabel` 里若 suggestion 自带 `label`（如 CodeBuddy 提供的），仍优先用其原值，不翻译。

### 2. 语言

`en / zh / zh-TW / ko / ja`，对齐 `SUPPORTED_LANGS`；未知或缺失键回退 `en`。

### 3. 数据流

`createQQBotClient(config, options)` 的 `options` 新增 `getLang` 回调，沿用 `i18n.js` 的 `createTranslator(getLang)` 模式（每次读最新 `lang`，运行时切换自动生效）。

- `main.js` 创建 client 时传 `getLang: () => lang`。语言切换无需额外接线（回调每次取当前 `lang`）。
- 默认 `getLang` 为 `() => "en"`，未注入时行为回退英文。
- 只有 `qq-bot-client.js` 需要 `getLang`；`qq-approval.js` 不改。

### 4. 翻译模块

新建 `src/qq-bot-i18n.js`（纯数据 + 函数），导出：

- `QQ_CARD_STRINGS`：`{ [lang]: { allow, deny, alwaysAllow, alwaysDenyTool, alwaysTool, alwaysDeny, autoEdits, planMode, modePrefix, submitDone } }`
- `qqCardText(lang, key, params)`：查 `QQ_CARD_STRINGS[lang]`，缺则回退 `en`，再缺回退 key 本身；对值中的 `{tool}` / `{mode}` / `{n}` 占位做 `params` 替换。

不并入 `i18n.js`（菜单串池），保持 client 依赖面干净、模块可独立测试。

### 5. client 改造

- `createQQBotClient` 取出 `getLang`（默认 `() => "en"`），内部 `const tr = (key, params) => qqCardText(getLang(), key, params)`。
- `buildApprovalCard`：`✅ ${tr("allow")}` / `❌ ${tr("deny")}`。
- `buildSuggestionLabel(s)`：各分支改用 `tr(...)`（自带 label 的仍用原值）。
- `buildMultiSelectElicitationCard`：提交按钮 `✅ ${tr("submitDone", { n: totalSelected })}`。

### 6. 表情符号

`✅ / ❌ / 📋` 等 emoji 与文案分离，不进翻译表，保持各语言一致。

## 测试

### `test/qq-bot-i18n.test.js`（新增）
- 各语言查得到核心键（allow/deny）。
- 未知语言、未知键回退 `en` / 回退 key。
- 占位替换：`alwaysDenyTool` 带 `{tool}`、`submitDone` 带 `{n}` 替换正确。

### `test/qq-bot-client.test.js`
- `getLang` 返回 `zh` 时审批按钮为「允许 / 拒绝」，`en` 时为 `Allow / Deny`。
- 建议按钮随语言翻译（如 zh 下 `setMode/acceptEdits` → 中文「自动编辑」等，断言与 i18n 表一致）。
- 多选完成按钮：`zh` 与 `en` 文案对应，且仍含 `已选/selected` 计数。
- 不注入 `getLang` 时回退英文，既有断言（`Always Bash` 等英文）不回归——**注意**：既有测试不传 `getLang`，应继续通过。

## 范围之外（YAGNI）

- 正文提示、确认回执、文字兜底请求的本地化（用户明确只要按钮）。
- elicitation 选项按钮（agent 文案）。
- 新增 app 语言种类。
