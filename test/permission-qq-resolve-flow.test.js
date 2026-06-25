"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");

// ── Helpers ──

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

// ── Tests ──

describe("permission QQ remote approval resolve flow", () => {
  it("resolveFn executes when entry is still in pendingPermissions", () => {
    const requests = [];
    const bridge = {
      start: () => {},
      requestApproval: (permEntry, resolveFn, config) => {
        requests.push({ permEntry, resolveFn, config });
        return true;
      },
      requestElicitation: () => {},
      cancelApproval: () => {},
    };
    const perm = initPermission(makeCtx({
      getQQApprovalBridge: () => bridge,
      getQQBotConfig: () => ({ enabled: true, appId: "1", appSecret: "x", userOpenid: "u" }),
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteQQApproval(entry), true);
    assert.equal(requests.length, 1);

    // Simulate QQ resolver callback — entry is still in pending
    const resolveFn = requests[0].resolveFn;
    assert.equal(perm.pendingPermissions.length, 1);

    resolveFn(entry, "allow");

    assert.equal(perm.pendingPermissions.length, 0, "entry should be removed after resolution");
    assert.equal(entry.res.captured.ended, true);
  });

  it("resolveFn skips when entry already removed from pendingPermissions (multi-channel race)", () => {
    const requests = [];
    const bridge = {
      start: () => {},
      requestApproval: (permEntry, resolveFn, config) => {
        requests.push({ permEntry, resolveFn, config });
        return true;
      },
      requestElicitation: () => {},
      cancelApproval: () => {},
    };
    const perm = initPermission(makeCtx({
      getQQApprovalBridge: () => bridge,
      getQQBotConfig: () => ({ enabled: true, appId: "1", appSecret: "x", userOpenid: "u" }),
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteQQApproval(entry), true);
    assert.equal(requests.length, 1);

    const resolveFn = requests[0].resolveFn;

    // Remove entry from pendingPermissions first (simulate desktop bubble resolving)
    const idx = perm.pendingPermissions.indexOf(entry);
    assert.notEqual(idx, -1);
    perm.pendingPermissions.splice(idx, 1);

    // Now QQ resolver fires — should be a no-op
    resolveFn(entry, "allow");

    // Entry not in pending, response not written
    assert.equal(perm.pendingPermissions.length, 0);
    assert.equal(entry.res.captured.ended, false, "response should not be written for skipped entry");
  });

  it("resolveFn from QQ does not crash when cancellation already happened", () => {
    const requests = [];
    const bridge = {
      start: () => {},
      requestApproval: (permEntry, resolveFn, config) => {
        requests.push({ permEntry, resolveFn, config });
        return true;
      },
      requestElicitation: () => {},
      cancelApproval: () => {},
    };
    const perm = initPermission(makeCtx({
      getQQApprovalBridge: () => bridge,
      getQQBotConfig: () => ({ enabled: true, appId: "1", appSecret: "x", userOpenid: "u" }),
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteQQApproval(entry), true);

    const resolveFn = requests[0].resolveFn;

    // Simulate cancellation: remove the entry from pendingPermissions (as
    // resolvePermissionEntry does via splice internally). cancelRemoteApproval
    // is a private closure function not exposed on the return object, so tests
    // splice directly.
    const idx = perm.pendingPermissions.indexOf(entry);
    if (idx !== -1) perm.pendingPermissions.splice(idx, 1);
    assert.equal(perm.pendingPermissions.length, 0);

    // This should not throw
    resolveFn(entry, "allow");
  });

  it("QQ and WeChat parallel approval both skip when other channel resolves first", () => {
    const qqRequests = [];
    const wxRequests = [];
    const qqBridge = {
      start: () => {},
      requestApproval: (permEntry, resolveFn, config) => {
        qqRequests.push({ permEntry, resolveFn, config });
        return true;
      },
      requestElicitation: () => {},
      cancelApproval: () => {},
    };
    const wxBridge = {
      start: () => {},
      requestApproval: (permEntry, resolveFn, config) => {
        wxRequests.push({ permEntry, resolveFn, config });
        return true;
      },
      requestElicitation: () => {},
      cancelApproval: () => {},
    };
    const resolved = [];
    const perm = initPermission(makeCtx({
      getQQApprovalBridge: () => qqBridge,
      getQQBotConfig: () => ({ enabled: true, appId: "1", appSecret: "x", userOpenid: "u" }),
      getWechatApprovalBridge: () => wxBridge,
      getWechatBotConfig: () => ({ enabled: true, token: "t" }),
      onPermissionResolved: (entry, meta) => resolved.push({ entry, meta }),
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    // Both channels fire
    perm.maybeStartRemoteQQApproval(entry);
    perm.maybeStartRemoteWechatApproval(entry);

    assert.equal(qqRequests.length, 1);
    assert.equal(wxRequests.length, 1);

    // WeChat resolves first
    const wxResolveFn = wxRequests[0].resolveFn;
    wxResolveFn(entry, "deny");

    assert.equal(perm.pendingPermissions.length, 0, "entry resolved by WeChat");

    // QQ resolves late — should be a no-op and not throw
    const qqResolveFn = qqRequests[0].resolveFn;
    qqResolveFn(entry, "allow");

    // Only the WeChat resolution should have taken effect
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].meta.reason, "resolved");
  });
});
