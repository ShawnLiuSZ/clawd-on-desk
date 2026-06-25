"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");

function createMockResponse() {
  const captured = { body: "", ended: false, listeners: {} };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk); captured.ended = true; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
    on(evt, fn) { (captured.listeners[evt] = captured.listeners[evt] || []).push(fn); },
    removeListener(evt, fn) {
      const l = captured.listeners[evt] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    permDebugLog: null,
    win: null,
    sessions: new Map([["sid", { cwd: "/work/project-alpha" }]]),
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    ...overrides,
  };
}

function makePermEntry(overrides = {}) {
  return {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "sid",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "npm test", description: "Run project tests" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
}

function makeBridge(requests) {
  return {
    start: () => {},
    requestApproval: (permEntry, _resolveFn, config) => { requests.push({ kind: "approval", permEntry, config }); return true; },
    requestElicitation: (permEntry, _resolveFn, config) => { requests.push({ kind: "elicitation", permEntry, config }); return true; },
    cancelApproval: () => {},
  };
}

describe("permission WeChat remote approval enable gate", () => {
  it("does NOT send a WeChat approval when wechatBot.enabled is false", () => {
    const requests = [];
    const perm = initPermission(makeCtx({
      getWechatApprovalBridge: () => makeBridge(requests),
      getWechatBotConfig: () => ({ enabled: false, token: "t" }),
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteWechatApproval(entry), false);
    assert.deepEqual(requests, []);
  });

  it("sends a WeChat approval when wechatBot.enabled is true", () => {
    const requests = [];
    const perm = initPermission(makeCtx({
      getWechatApprovalBridge: () => makeBridge(requests),
      getWechatBotConfig: () => ({ enabled: true, token: "t" }),
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteWechatApproval(entry), true);
    assert.equal(requests.length, 1);
  });
});
