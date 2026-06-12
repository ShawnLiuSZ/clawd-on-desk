# QQ 多选 Elicitation 卡片设计

**日期**: 2026-06-12
**状态**: 已确认，待转实现计划
**涉及文件**: `src/qq-bot-client.js`, `src/qq-approval.js`, `test/qq-bot-client.test.js`, `test/qq-approval.test.js`

## 背景与问题

QQ 官方机器人的 elicitation（AskUserQuestion）卡片当前**只支持单选**：用户点任意一个选项按钮就立即 resolve 整个 elicitation，其余未答题填 `Defer to agent`（见 `qq-approval.js` 的 `handleElicitationClick`）。

桌面端的 AskUserQuestion 支持 `multiSelect`（每题独立标记，可勾选多个再提交，见 `bubble-renderer.js`），但 QQ 这条远程审批兜底渠道没有覆盖。本设计为 QQ 增加真正的多选交互。

### 根本约束

QQ 的 C2C 消息 API 是 **send-only**（`POST /v2/users/{openid}/messages`），**无法原地编辑已发出的卡片**，且内联按钮是**无状态的一次性回调**（每次点击触发一个独立的 `INTERACTION_CREATE`）。因此「让用户看到当前已勾选了哪些」只能靠**每次点击重发一张新卡片**来实现，没有原地打勾的办法。

## 答案格式（必须复刻桌面端）

多选答案最终都流经 `permission.js` 的 `buildElicitationUpdatedInput`，该函数**只接受非空 string 答案**（`typeof answer === "string"`），非字符串一律丢弃。桌面端（`bubble-renderer.js`）的多选编码为：

- **切换逻辑**（`setElicitationSelection`, 行 382）：`multiSelect` 题把选项 toggle 进/出一个集合；普通题用 `[optionKey]` 替换（radio 语义）。
- **答案字符串**（`getElicitationAnswerText`, 行 417）：选中项的 label 用 `", "`（逗号 + 空格）拼成一个字符串，例如 `"部署A, 部署C"`。
- **完成条件**（`collectElicitationAnswers`, 行 449）：每道题都必须至少有一个选中（答案文本非空），否则不能提交。

QQ 多选必须产出与之**完全一致**的答案 map（`{ [question.question]: "Label1, Label2" }`），以复用 `buildElicitationUpdatedInput`。

## 设计

### 1. 触发分支（向后兼容）

在 `buildElicitationCard` 与审批桥两侧判断 `questions.some(q => q.multiSelect)`：

- **没有任何 multiSelect 题** → 走现有单选逻辑（点一下立即 resolve，零行为变化、不刷屏）。
- **存在至少一个 multiSelect 题** → 走下文的「累积 + 提交」卡片。整张卡的所有题都按此模式渲染（包括其中夹带的单选题，单选题在此模式下表现为 radio 替换）。

### 2. 卡片渲染（每次点击重发）

- markdown 正文逐题列出选项，已选项前缀 `✓`、未选项前缀 `▢`。
- 每个选项渲染一个按钮，已选项的按钮 label 前也加 `✓`。
- 末行加一个 **`✅ 完成 (已选 N)`** 提交按钮（N = 当前总选中数）。
- 沿用现有上限：每题 ≤ 5 个选项、≤ 3 道题。
- 按钮分行沿用 `chunkRows(buttons, 5)`，提交按钮单独成行。

### 3. 状态与按钮编码

- pending entry 增加：`isElicitationMulti: true`，以及 `selections`（结构为 `Map<题index, 选项index[]>` 或等价的二维数组）。
- **切换按钮**复用现有编码 `elicitation:qi:oi`，但在 multi 模式下语义为：
  - `multiSelect` 题 → toggle 该选项；
  - 普通题 → 用该选项替换该题已有选择（radio）；
  - 然后**重发卡片**反映最新状态，**不 resolve**。
- **提交按钮**用新编码 `elicitation-submit`，处理逻辑：
  - 校验每道题都至少选了一个：
    - 全部有选 → 按 `", "` 拼出每题答案 → 调 `resolveFn(entry, answers)` → 经 `buildElicitationUpdatedInput` 回传 → `resolvePermissionEntry(entry, "allow")`。
    - 有题未选 → 重发卡片并在顶部加 `⚠️ 还有题未选` 提示，不 resolve。

### 4. 已知限制（QQ 固有）

- **不支持「Other」自由文本选项**：QQ 按钮无法输入文字，多选只能从预设选项中选。这是单选路径已有的限制，多选延续，不在本设计范围内解决。
- 每次 toggle 会多产生一条卡片消息。**优化（实现时确认）**：核实 QQ 是否提供机器人消息撤回接口（形如 `DELETE /v2/users/{openid}/messages/{id}`）。若有，重发新卡的同时撤回旧卡，使聊天中始终只保留一张活动卡片；若无，接受轻微刷屏。此项为可选增强，不阻塞核心功能。

### 5. 边界与跨渠道

- 每次交互（toggle 或提交校验失败的重发）重置 5 分钟超时（`DEFAULT_APPROVAL_TIMEOUT_MS`），避免用户挑选途中被超时。
- 跨渠道一致性：桌面 / 终端先决定时，现有 `cancelApproval` 已清理 QQ entry；事后点击聊天里的旧多选卡 → 找不到 entry → 仅 ACK，no-op（与现有单选行为一致）。

## 测试

### `test/qq-bot-client.test.js`（`buildElicitationCard` multi 分支）
- 含 multiSelect 题时渲染 ✓/▢ 标记与「完成」按钮。
- multi 卡中的单选题仍渲染为 radio 语义（选项按钮存在，编码正确）。
- 选项数 / 题数上限（5 / 3）仍生效。

### `test/qq-approval.test.js`（审批桥 multi 流程）
- toggle 累积：连续点击 multiSelect 题的多个选项后 `selections` 正确累积。
- 单选替换：multi 卡中单选题再次点击会替换而非累积。
- 提交拼接：`elicitation-submit` 产出 `{ question: "A, C" }` 格式答案。
- 未选题阻止提交：有题未选时点提交不 resolve（仍 pending）。
- 向后兼容：无 multiSelect 题时仍走原单选「立即 resolve」路径。

## 范围之外（YAGNI）

- 「Other」自由文本（见限制）。
- 消息撤回若 QQ 不支持则不实现（可选增强）。
- 不改动桌面端、终端、Telegram 等其它审批渠道。
