"use strict";

// Guards a wiring regression: maybeStartRemoteLarkApproval must be exposed on
// the _serverCtx passed to ./server, otherwise server-route-permission.js's
// `ctx.maybeStartRemoteLarkApproval` is undefined and Lark remote approval
// (both single-select and multi-select elicitation) silently never fires —
// the desktop bubble shows but no card reaches Feishu. main.js can't be
// required outside Electron, so we assert on the source of the _serverCtx
// object literal.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("main.js _serverCtx Lark wiring", () => {
  it("exposes maybeStartRemoteLarkApproval on the server ctx", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const start = src.indexOf("const _serverCtx = {");
    assert.ok(start !== -1, "could not find _serverCtx literal");
    const end = src.indexOf("require(\"./server\")", start);
    assert.ok(end !== -1, "could not find server require after _serverCtx");
    const block = src.slice(start, end);
    assert.ok(
      /\bmaybeStartRemoteApproval\b/.test(block),
      "_serverCtx should expose maybeStartRemoteApproval (Telegram)"
    );
    assert.ok(
      /\bmaybeStartRemoteLarkApproval\b/.test(block),
      "_serverCtx must expose maybeStartRemoteLarkApproval so the permission route can start Lark approval"
    );
  });
});
