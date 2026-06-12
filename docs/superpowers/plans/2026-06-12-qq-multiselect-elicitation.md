# QQ 多选 Elicitation 卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 QQ 官方机器人的 AskUserQuestion 卡片增加多选交互——勾选多个选项后点「完成」一起提交。

**Architecture:** QQ C2C 消息无法原地编辑，故多选靠「每次点击重发带 ✓ 标记的新卡片」实现。当 elicitation 任一问题 `multiSelect=true` 时进入多选模式（累积选择 + 提交按钮）；否则保持现有单选「点一下立即 resolve」行为。答案格式复刻桌面端：每题选中项 label 用 `", "` 拼成一个字符串，经 `buildElicitationUpdatedInput` 回传。

**Tech Stack:** Node.js，`node:test` + `node:assert`。无新依赖。

参考设计：`docs/superpowers/specs/2026-06-12-qq-multiselect-elicitation-design.md`

---

## File Structure

- **Modify** `src/qq-bot-client.js` — `buildElicitationCard` 增加 multi 分支与渲染；新增 `buildMultiSelectElicitationCard` 私有函数。
- **Modify** `src/qq-approval.js` — `requestElicitation` 初始化多选状态；`handleInteraction` 路由 toggle / submit；新增 `handleElicitationToggle`、`handleElicitationSubmit`、`buildMultiSelectAnswers`、`resendElicitationCard`、`resetElicitationTimer`；新增测试辅助 `_testGetFirstEntry`。
- **Modify** `test/qq-bot-client.test.js` — multi 渲染测试。
- **Modify** `test/qq-approval.test.js` — toggle / submit / 未选阻止 / 单选替换 / 向后兼容测试。

约定：测试运行命令统一为
`node --test test/qq-bot-client.test.js test/qq-approval.test.js`

---

## Task 1: 客户端多选卡片渲染

**Files:**
- Modify: `src/qq-bot-client.js`（`buildElicitationCard` 约 393-435 行）
- Test: `test/qq-bot-client.test.js`

- [ ] **Step 1: 写失败测试 —— multi 卡片含 ✓/▢ 与提交按钮**

加到 `test/qq-bot-client.test.js` 的 `describe("qq-bot-client: buildElicitationCard", ...)` 块内：

```js
it("multi-select: marks selected options and adds a submit button", () => {
  const client = createQQBotClient({ appId: "x", appSecret: "y" });
  const toolInput = {
    questions: [
      { header: "部署", question: "选哪些环境?", multiSelect: true, options: [
        { label: "测试" }, { label: "预发" }, { label: "生产" },
      ]},
    ],
  };
  // selections[0] = [0, 2] → 选中「测试」「生产」
  const card = client.buildElicitationCard(toolInput, "qq_p", "AB", [[0, 2]]);
  const md = card.markdown.content;
  assert.ok(md.includes("✓ 测试"), "selected option marked with ✓");
  assert.ok(md.includes("▢ 预发"), "unselected option marked with ▢");
  assert.ok(md.includes("✓ 生产"), "selected option marked with ✓");

  const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
  const submit = buttons.find((b) => b.action.data === "qq_p|elicitation-submit");
  assert.ok(submit, "submit button exists with elicitation-submit behavior");
  assert.ok(submit.render_data.label.includes("已选 2"), "submit label shows selected count");
  // option buttons keep elicitation:<qi>:<oi> encoding
  assert.ok(buttons.some((b) => b.action.data === "qq_p|elicitation:0:0"));
});

it("non-multi elicitation keeps the immediate-select card (no submit button)", () => {
  const client = createQQBotClient({ appId: "x", appSecret: "y" });
  const toolInput = { questions: [
    { question: "选一个", options: [{ label: "A" }, { label: "B" }] },
  ]};
  const card = client.buildElicitationCard(toolInput, "qq_p", "AB");
  const buttons = card.keyboard.content.rows.flatMap((r) => r.buttons);
  assert.ok(!buttons.some((b) => b.action.data === "qq_p|elicitation-submit"),
    "single-select card has no submit button");
  assert.ok(!card.markdown.content.includes("▢"), "single-select card has no checkbox glyphs");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/qq-bot-client.test.js`
Expected: FAIL —— `multi-select` 用例报错（找不到 ✓ 标记 / submit 按钮）。

- [ ] **Step 3: 重构出单选 helper 并新增多选 helper**

在 `src/qq-bot-client.js` 中，把现有 `buildElicitationCard`（393-435 行）整体替换为下面三段。先保留现有单选逻辑为 `buildSingleSelectElicitationCard`，新增 `buildMultiSelectElicitationCard`，并让 `buildElicitationCard` 按 `multiSelect` 分流：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/qq-bot-client.test.js`
Expected: PASS —— 新 2 个用例 + 原有 `buildElicitationCard` 用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/qq-bot-client.js test/qq-bot-client.test.js
git commit -m "feat(qqbot): render multi-select elicitation card with checkmarks + submit button"
```

---

## Task 2: 审批桥 —— 多选状态初始化、路由与 toggle

**Files:**
- Modify: `src/qq-approval.js`（`requestElicitation` 220-261 行；`handleInteraction` 101-114 行；导出对象 317-331 行）
- Test: `test/qq-approval.test.js`

- [ ] **Step 1: 写失败测试 —— multiSelect 题 toggle 累积选择**

加到 `test/qq-approval.test.js` 的 `describe("qq-approval: requestElicitation", ...)` 块内：

```js
it("multi-select: toggling accumulates selections and re-sends the card", () => {
  let sendCalls = 0;
  const client = makeMockQQBotClient({
    sendCardMessage: async () => { sendCalls++; return { status: 200 }; },
  });
  const bridge = createBridge(client);
  const perm = makePermEntry({
    toolInput: { questions: [
      { question: "选环境?", multiSelect: true, options: [
        { label: "测试" }, { label: "预发" }, { label: "生产" },
      ]},
    ]},
  });
  bridge.requestElicitation(perm, () => {}, {});
  assert.strictEqual(sendCalls, 1, "initial card sent");

  const permId = bridge._testGetFirstPermId();
  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 选「测试」
  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:2" }); // 选「生产」

  const entry = bridge._testGetFirstEntry();
  assert.deepStrictEqual(entry.selections[0], [0, 2], "both options accumulated");
  assert.strictEqual(sendCalls, 3, "card re-sent on each toggle");
  assert.strictEqual(bridge.hasPending(), true, "toggling does not resolve");

  // 再点「测试」→ 取消
  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" });
  assert.deepStrictEqual(bridge._testGetFirstEntry().selections[0], [2], "re-tap removes");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/qq-approval.test.js`
Expected: FAIL —— `_testGetFirstEntry is not a function` 或 selections 不存在。

- [ ] **Step 3: requestElicitation 初始化多选状态**

在 `src/qq-approval.js` 的 `requestElicitation` 中，把 `buildElicitationCard` 调用前后改为（替换 233-251 行的 card 构建与 `pendingApprovals.set`）：

```js
const questions = (permEntry.toolInput && Array.isArray(permEntry.toolInput.questions))
  ? permEntry.toolInput.questions : [];
const isMulti = questions.some((q) => q && q.multiSelect);
const selections = isMulti ? questions.map(() => []) : null;

const card = qqBotClient.buildElicitationCard(
  permEntry.toolInput,
  permId,
  shortCode,
  selections
);

pendingApprovals.set(permId, {
  permEntry,
  resolveFn,
  shortCode,
  _permId: permId,
  isElicitation: true,
  isElicitationMulti: isMulti,
  selections,
  timeoutMs,
  timer: setTimeout(() => {
    pendingApprovals.delete(permId);
    shortCodeToPermId.delete(shortCode);
    logFn(`qq-approval: elicitation timed out permId=${permId}`);
  }, timeoutMs),
  createdAt: nowFn(),
});
```

- [ ] **Step 4: handleInteraction 路由 toggle / submit；新增 toggle、resend、reset-timer**

替换 `handleInteraction` 中的 elicitation 分支（当前 107-110 行的 `if (entry.isElicitation && event.behavior && event.behavior.startsWith("elicitation:"))` 整块）为：

```js
    if (entry.isElicitation && event.behavior) {
      if (entry.isElicitationMulti) {
        if (event.behavior === "elicitation-submit") {
          handleElicitationSubmit(entry);
          return;
        }
        if (event.behavior.startsWith("elicitation:")) {
          handleElicitationToggle(entry, event.behavior);
          return;
        }
      } else if (event.behavior.startsWith("elicitation:")) {
        handleElicitationClick(entry, event.behavior);
        return;
      }
    }
```

在 `handleElicitationClick` 函数之后新增（`handleElicitationSubmit` 在 Task 3 加入）：

```js
  function handleElicitationToggle(entry, behavior) {
    const parts = behavior.split(":");
    const qi = parseInt(parts[1], 10);
    const oi = parseInt(parts[2], 10);
    if (!Number.isInteger(qi) || !Number.isInteger(oi)) return;

    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const q = questions[qi];
    if (!q) return;

    if (!Array.isArray(entry.selections)) entry.selections = questions.map(() => []);
    if (!Array.isArray(entry.selections[qi])) entry.selections[qi] = [];
    const cur = entry.selections[qi];

    if (q.multiSelect) {
      const pos = cur.indexOf(oi);
      if (pos === -1) cur.push(oi);
      else cur.splice(pos, 1);
    } else {
      entry.selections[qi] = [oi]; // single-select within a multi card = radio
    }

    resetElicitationTimer(entry);
    resendElicitationCard(entry, false);
  }

  function resendElicitationCard(entry, warn) {
    if (!qqBotClient || typeof qqBotClient.sendCardMessage !== "function") return;
    const card = qqBotClient.buildElicitationCard(
      entry.permEntry.toolInput,
      entry._permId,
      entry.shortCode,
      entry.selections,
      warn
    );
    qqBotClient.sendCardMessage(card).catch((err) => {
      logFn(`qq-approval: elicitation re-send failed: ${err && err.message}`);
    });
  }

  function resetElicitationTimer(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    const permId = entry._permId;
    entry.timer = setTimeout(() => {
      pendingApprovals.delete(permId);
      if (entry.shortCode) shortCodeToPermId.delete(entry.shortCode);
      logFn(`qq-approval: elicitation timed out permId=${permId}`);
    }, entry.timeoutMs || DEFAULT_APPROVAL_TIMEOUT_MS);
  }
```

- [ ] **Step 5: 暴露测试辅助 `_testGetFirstEntry`**

在 `src/qq-approval.js` 返回对象（317-331 行）的 `_testGetFirstPermId` 旁新增：

```js
    _testGetFirstEntry: () => {
      for (const [, entry] of pendingApprovals) return entry;
      return null;
    },
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test test/qq-approval.test.js`
Expected: 新 toggle 用例 PASS。注意：此时 `handleElicitationSubmit` 尚未定义，但本任务测试不触发 submit，故不报错。

- [ ] **Step 7: 提交**

```bash
git add src/qq-approval.js test/qq-approval.test.js
git commit -m "feat(qqbot): accumulate multi-select toggles and re-send elicitation card"
```

---

## Task 3: 审批桥 —— 提交与未选校验

**Files:**
- Modify: `src/qq-approval.js`
- Test: `test/qq-approval.test.js`

- [ ] **Step 1: 写失败测试 —— 提交拼接答案 + 未选阻止提交**

加到 `test/qq-approval.test.js` 的 `describe("qq-approval: requestElicitation", ...)` 块内：

```js
it("multi-select: submit joins selected labels with ', ' and resolves", () => {
  const client = makeMockQQBotClient();
  const bridge = createBridge(client);
  let resolvedAnswers = null;
  const perm = makePermEntry({
    toolInput: { questions: [
      { question: "选环境?", multiSelect: true, options: [
        { label: "测试" }, { label: "预发" }, { label: "生产" },
      ]},
    ]},
  });
  bridge.requestElicitation(perm, (_, answers) => { resolvedAnswers = answers; }, {});
  const permId = bridge._testGetFirstPermId();

  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 测试
  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:2" }); // 生产
  bridge._testHandleInteraction({ permId, behavior: "elicitation-submit" });

  assert.ok(resolvedAnswers);
  assert.strictEqual(resolvedAnswers["选环境?"], "测试, 生产");
  assert.strictEqual(bridge.hasPending(), false);
});

it("multi-select: submit with an unanswered question does not resolve", () => {
  let sendCalls = 0;
  const client = makeMockQQBotClient({
    sendCardMessage: async () => { sendCalls++; return { status: 200 }; },
  });
  const bridge = createBridge(client);
  let resolved = false;
  const perm = makePermEntry({
    toolInput: { questions: [
      { question: "Q1?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
      { question: "Q2?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
    ]},
  });
  bridge.requestElicitation(perm, () => { resolved = true; }, {});
  const permId = bridge._testGetFirstPermId();
  const before = sendCalls;

  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 只答 Q1
  bridge._testHandleInteraction({ permId, behavior: "elicitation-submit" });

  assert.strictEqual(resolved, false, "incomplete submit must not resolve");
  assert.strictEqual(bridge.hasPending(), true, "still pending");
  assert.ok(sendCalls > before + 1, "warning card re-sent on incomplete submit");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/qq-approval.test.js`
Expected: FAIL —— `handleElicitationSubmit is not defined`。

- [ ] **Step 3: 新增 `handleElicitationSubmit` 与 `buildMultiSelectAnswers`**

在 `src/qq-approval.js` 的 `handleElicitationToggle` 之后新增：

```js
  function handleElicitationSubmit(entry) {
    const answers = buildMultiSelectAnswers(entry);
    if (!answers) {
      resendElicitationCard(entry, true); // 有题未选 → 重发带警告的卡片
      resetElicitationTimer(entry);
      return;
    }
    logFn(`qq-approval: elicitation submitted permId=${entry._permId} answers=${JSON.stringify(answers)}`);
    resolveElicitationPending(entry, answers);
  }

  // Build the answers map QQ submits. Each question's selected option labels are
  // joined with ", " — matching the desktop renderer's getElicitationAnswerText.
  // Returns null if any question has no selection (blocks submit).
  function buildMultiSelectAnswers(entry) {
    const toolInput = entry.permEntry && entry.permEntry.toolInput;
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    const selections = Array.isArray(entry.selections) ? entry.selections : [];
    const answers = {};
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      if (!q || typeof q.question !== "string" || !q.question) continue;
      const options = Array.isArray(q.options) ? q.options : [];
      const sel = Array.isArray(selections[qi]) ? selections[qi] : [];
      const labels = [];
      for (const oi of sel) {
        const opt = options[oi];
        if (opt && opt.label) labels.push(opt.label);
      }
      if (labels.length === 0) return null;
      answers[q.question] = labels.join(", ");
    }
    return answers;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/qq-approval.test.js`
Expected: 两个新用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/qq-approval.js test/qq-approval.test.js
git commit -m "feat(qqbot): submit multi-select answers and block incomplete submissions"
```

---

## Task 4: 多选卡片内的单选题 = radio 替换

**Files:**
- Test: `test/qq-approval.test.js`（仅加测试，逻辑已在 Task 2 的 `handleElicitationToggle` 的 else 分支实现）

- [ ] **Step 1: 写测试 —— 单选题在多选卡内点击会替换而非累积**

加到 `test/qq-approval.test.js`：

```js
it("multi-select card: a non-multi question replaces selection (radio)", () => {
  const client = makeMockQQBotClient();
  const bridge = createBridge(client);
  let resolvedAnswers = null;
  const perm = makePermEntry({
    toolInput: { questions: [
      { question: "多选?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
      { question: "单选?", options: [{ label: "X" }, { label: "Y" }] }, // 无 multiSelect
    ]},
  });
  bridge.requestElicitation(perm, (_, answers) => { resolvedAnswers = answers; }, {});
  const permId = bridge._testGetFirstPermId();

  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:0" }); // 多选题选 A
  bridge._testHandleInteraction({ permId, behavior: "elicitation:1:0" }); // 单选题选 X
  bridge._testHandleInteraction({ permId, behavior: "elicitation:1:1" }); // 单选题改选 Y（替换）

  assert.deepStrictEqual(bridge._testGetFirstEntry().selections[1], [1], "single-select replaced, not accumulated");

  bridge._testHandleInteraction({ permId, behavior: "elicitation-submit" });
  assert.strictEqual(resolvedAnswers["多选?"], "A");
  assert.strictEqual(resolvedAnswers["单选?"], "Y");
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `node --test test/qq-approval.test.js`
Expected: PASS（无需改实现——Task 2 已实现 radio 替换）。

- [ ] **Step 3: 提交**

```bash
git add test/qq-approval.test.js
git commit -m "test(qqbot): radio replacement for non-multi questions inside a multi card"
```

---

## Task 5: 向后兼容回归

**Files:**
- Test: `test/qq-approval.test.js`

- [ ] **Step 1: 写测试 —— 无 multiSelect 题仍走单选立即 resolve**

加到 `test/qq-approval.test.js`：

```js
it("backward-compat: no multiSelect question still resolves on first tap", () => {
  const client = makeMockQQBotClient();
  const bridge = createBridge(client);
  let resolvedAnswers = null;
  const perm = makePermEntry({
    toolInput: { questions: [
      { question: "选一个?", options: [{ label: "甲" }, { label: "乙" }] }, // 无 multiSelect
    ]},
  });
  bridge.requestElicitation(perm, (_, answers) => { resolvedAnswers = answers; }, {});
  const permId = bridge._testGetFirstPermId();

  bridge._testHandleInteraction({ permId, behavior: "elicitation:0:1" }); // 点「乙」立即 resolve

  assert.ok(resolvedAnswers, "resolved immediately without a submit step");
  assert.strictEqual(resolvedAnswers["选一个?"], "乙");
  assert.strictEqual(bridge.hasPending(), false);
});
```

- [ ] **Step 2: 运行全部 QQ 测试确认通过**

Run: `node --test test/qq-bot-client.test.js test/qq-approval.test.js`
Expected: 全绿，0 fail。

- [ ] **Step 3: 提交**

```bash
git add test/qq-approval.test.js
git commit -m "test(qqbot): backward-compat single-select elicitation still immediate-resolves"
```

---

## Follow-up（可选，不阻塞）

- **消息撤回减少刷屏**：核实 QQ 是否提供机器人 C2C 消息撤回 / 删除接口（查 q.qq.com 官方文档）。若有，在 `qq-bot-client.js` 增加 `recallMessage(messageId)`，并让 `requestElicitation`/`resendElicitationCard` 记录上一条 card 的 message id、重发时撤回旧卡，使聊天中只留一张活动卡片。若文档确认不支持，则不实现，接受轻微刷屏。
- **真机验证**：app 关闭状态下复用 `scripts/qq-elicitation-live-test.js` 的模式发一条 multiSelect 卡片，人工点选 + 提交，确认 toggle 重发与提交在真实 QQ 客户端表现正常。

---

## Self-Review

**Spec coverage：**
- 触发分支（向后兼容）→ Task 1 Step 3 + Task 5 ✅
- 卡片渲染（✓/▢ + 完成按钮 + 上限）→ Task 1 ✅
- 状态与按钮编码（toggle / replace / submit）→ Task 2 + Task 3 + Task 4 ✅
- 未选阻止提交 + 警告重发 → Task 3 ✅
- 超时重置 → Task 2 `resetElicitationTimer`（toggle/submit 校验失败时调用）✅
- 答案格式 `", "` 拼接 → Task 3 `buildMultiSelectAnswers` ✅
- 已知限制（无 Other）→ 不渲染 Other 按钮，设计内不实现 ✅
- 消息撤回（可选）→ Follow-up ✅
- 跨渠道 cancel → 复用现有 `cancelApproval`，无需改动；旧卡点击无 entry 即 no-op（现有行为）✅

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码。Follow-up 的撤回任务是有意标注的可选项，非占位符。

**Type consistency：** `selections` 全程为「按题 index 的二维数组」；`isElicitationMulti`、`timeoutMs`、`_permId`、`shortCode` 字段名在 Task 2/3 一致；函数名 `handleElicitationToggle` / `handleElicitationSubmit` / `buildMultiSelectAnswers` / `resendElicitationCard` / `resetElicitationTimer` 在路由与定义处拼写一致；提交编码 `elicitation-submit`（不以 `elicitation:` 开头，故不与 toggle 路由冲突）在客户端按钮与桥路由两处一致。
