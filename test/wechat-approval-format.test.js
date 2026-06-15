"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTextRequest,
  buildConfirmationText,
  buildElicitationRequest,
  buildElicitationConfirmation,
  parseTextReply,
} = require("../src/wechat-approval");

// ── buildTextRequest ──

describe("buildTextRequest", () => {
  const SEP = " ---|||--- ";

  it("includes all fields for Bash command", () => {
    const text = buildTextRequest(
      { toolName: "Bash", toolInput: { command: "echo hello" }, sessionId: "test-session-123" },
      "ABCD",
    );

    assert.ok(text.includes("🔒 权限请求 [ABCD]"));
    assert.ok(text.includes("🛠 Bash"));
    assert.ok(text.includes("echo hello"));
    assert.ok(text.includes("💬 会话:")); // sessionId short code included
    assert.ok(text.includes("n-123")); // last 6 chars of "test-session-123"
    assert.ok(text.includes('"y ABCD"'));
    assert.ok(text.includes('"n ABCD"'));
  });

  it("uses ---|||--- as separator", () => {
    const text = buildTextRequest(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "abc123" },
      "EFGH",
    );

    assert.ok(text.includes(SEP));
    // Should have multiple segments separated by ---|||---
    const parts = text.split(SEP);
    assert.ok(parts.length >= 4);
  });

  it("includes file path for Read tool", () => {
    const text = buildTextRequest(
      { toolName: "Read", toolInput: { file_path: "/etc/hosts" }, sessionId: "sess-1" },
      "ABCD",
    );

    assert.ok(text.includes("/etc/hosts"));
    assert.ok(text.includes("📄"));
  });

  it("shows command detail for Bash", () => {
    const text = buildTextRequest(
      { toolName: "Bash", toolInput: { command: "cat /var/log/syslog | grep error" }, sessionId: "sess-1" },
      "ABCD",
    );

    assert.ok(text.includes("cat /var/log/syslog | grep error"));
  });

  it("shows content detail for Write/Edit tools", () => {
    const text = buildTextRequest(
      { toolName: "Edit", toolInput: { file_path: "test.txt", new_string: "new content" }, sessionId: "sess-1" },
      "ABCD",
    );

    assert.ok(text.includes("test.txt"));
    assert.ok(text.includes("new content"));
  });

  it("shows query detail for Grep tool", () => {
    const text = buildTextRequest(
      { toolName: "Grep", toolInput: { pattern: "error\\s+log" }, sessionId: "sess-1" },
      "ABCD",
    );

    assert.ok(text.includes("error"));
  });

  it("omits detail line when there is no toolInput", () => {
    const text = buildTextRequest(
      { toolName: "Bash", toolInput: null, sessionId: "sess-1" },
      "ABCD",
    );

    assert.ok(!text.includes("📄"));
    assert.ok(!text.includes("文件:"));
  });

  it("handles empty sessionId gracefully", () => {
    const text = buildTextRequest(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "" },
      "ABCD",
    );

    // Should still produce valid output with "—" for missing session
    assert.ok(text.includes("会话:"));
  });
});

// ── buildConfirmationText ──

describe("buildConfirmationText", () => {
  it("returns allow confirmation with emoji and separator", () => {
    const text = buildConfirmationText(
      { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s1" },
      "allow",
      "ABCD",
    );

    assert.ok(text.includes("✅"));
    assert.ok(text.includes("已允许"));
    assert.ok(text.includes("[ABCD]"));
    assert.ok(text.includes("🛠 Bash"));
    assert.ok(text.includes("---|||---"));
  });

  it("returns deny confirmation with emoji and separator", () => {
    const text = buildConfirmationText(
      { toolName: "Read", toolInput: { file_path: "test.txt" }, sessionId: "s1" },
      "deny",
      "EFGH",
    );

    assert.ok(text.includes("❌"));
    assert.ok(text.includes("已拒绝"));
    assert.ok(text.includes("[EFGH]"));
    assert.ok(text.includes("🛠 Read"));
  });
});

// ── buildElicitationRequest ──

describe("buildElicitationRequest", () => {
  const SEP = " ---|||--- ";

  it("formats single-question elicitation", () => {
    const text = buildElicitationRequest(
      {
        questions: [
          { question: "Which file?", options: [{ label: "a.txt" }, { label: "b.txt" }] },
        ],
      },
      "ABCD",
    );

    assert.ok(text.includes("❓ 选择请求 [ABCD]"));
    assert.ok(text.includes("📝 Which file?"));
    assert.ok(text.includes("1. a.txt"));
    assert.ok(text.includes("2. b.txt"));
    assert.ok(text.includes(SEP));
  });

  it("formats multi-question elicitation", () => {
    const text = buildElicitationRequest(
      {
        questions: [
          { question: "Pick tool?", options: [{ label: "Bash" }, { label: "Read" }] },
          { question: "Confirm?", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
      "EFGH",
    );

    assert.ok(text.includes("1. Bash"));
    assert.ok(text.includes("2. Read"));
    assert.ok(text.includes("3. Yes"));
    assert.ok(text.includes("4. No"));
  });

  it("shows (多选) for multiSelect questions", () => {
    const text = buildElicitationRequest(
      {
        questions: [
          { question: "Select all that apply?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
        ],
      },
      "ABCD",
    );

    assert.ok(text.includes("(多选)"));
  });

  it("includes reply instruction", () => {
    const text = buildElicitationRequest(
      { questions: [{ question: "Q?", options: [{ label: "A" }] }] },
      "ABCD",
    );

    assert.ok(text.includes("✉️"));
    assert.ok(text.includes("1,3"));
  });
});

// ── buildElicitationConfirmation ──

describe("buildElicitationConfirmation", () => {
  it("confirms with submitted answers", () => {
    const text = buildElicitationConfirmation(
      { "Pick tool?": "Bash", "Confirm?": "Yes" },
      "ABCD",
    );

    assert.ok(text.includes("✅"));
    assert.ok(text.includes("已提交"));
    assert.ok(text.includes("[ABCD]"));
    assert.ok(text.includes("---|||---"));
    assert.ok(text.includes("Pick tool?: Bash"));
    assert.ok(text.includes("Confirm?: Yes"));
  });

  it("handles empty answers gracefully", () => {
    const text = buildElicitationConfirmation({}, "ABCD");
    assert.ok(text.includes("已提交 [ABCD]"));
  });
});

// ── parseTextReply ──

describe("parseTextReply (WeChat)", () => {
  it('parses "y SHORT" as allow', () => {
    assert.deepEqual(parseTextReply("y AB12"), { behavior: "allow", code: "AB12" });
  });

  it('parses "n SHORT" as deny', () => {
    assert.deepEqual(parseTextReply("n CD34"), { behavior: "deny", code: "CD34" });
  });

  it('parses "allow SHORT" as allow', () => {
    assert.deepEqual(parseTextReply("allow EF56"), { behavior: "allow", code: "EF56" });
  });

  it('parses "deny SHORT" as deny', () => {
    assert.deepEqual(parseTextReply("deny GH78"), { behavior: "deny", code: "GH78" });
  });

  it("returns null for unrecognized text", () => {
    assert.equal(parseTextReply("hello world"), null);
    assert.equal(parseTextReply(""), null);
    assert.equal(parseTextReply(null), null);
  });
});
