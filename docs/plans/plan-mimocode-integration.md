# Plan: MiMo Code Integration

> Status: IMPLEMENTED (Phase 1-4)
> Date: 2026-06-16
> Scope: Add MiMo Code (XiaomiMiMo/MiMo-Code) as a new AI coding agent integration.
> Pattern: Follows the opencode plugin integration model (in-process Bun plugin → HTTP POST → state machine → permission bubble → reverse bridge reply).
>
> **Key finding:** MiMo Code is a fork of OpenCode (TypeScript/Bun version). The plugin SDK is identical — `ctx.client._client.post()` for in-process permission replies, same event types, same `Bun.serve()` reverse bridge pattern. Binary: `mimo` / `mimo.exe`.

---

## 1. Overview

MiMo Code (`github.com/XiaomiMiMo/MiMo-Code`, 9.3k stars) is an AI coding agent CLI by Xiaomi. It runs on Bun and supports a `plugin` system nearly identical to opencode:

| Dimension | opencode | MiMo Code |
|-----------|----------|-----------|
| Runtime | Bun | Bun |
| Config path | `~/.config/opencode/opencode.json` | `~/.config/mimocode/mimocode.jsonc` |
| Plugin mechanism | `plugin` array (npm pkg or local path) | `plugin` array (npm pkg or local path) |
| Plugin SDK | `opencode` default export | `@@mimocode/cli/plugin` |
| Permission flow | permission.asked → once/always/reject | permission.asked → once/always/reject |
| Session events | session.created / session.status / session.idle / message.part.updated | Same patterns |

**Approach:** Copy the opencode plugin (`hooks/opencode-plugin/`), adapt for MiMo Code's SDK and event names, and register as a new agent.

---

## 2. Files to Create

### 2.1 Plugin: `hooks/mimocode-plugin/`

| File | Source | Purpose |
|------|--------|---------|
| `index.mjs` | Copy from `hooks/opencode-plugin/index.mjs` | Plugin entry: event translation + HTTP POST + reverse bridge |
| `session-ids.mjs` | Copy from `hooks/opencode-plugin/session-ids.mjs` | Session ID normalization (`mimocode:` prefix) |
| `package.json` | Adapt from `hooks/opencode-plugin/package.json` | Package manifest |

**Key adaptations from opencode:**

1. **Constants:** Change `AGENT_ID = "mimocode"`, `HOOK_SOURCE = "mimocode-plugin"`, `DEBUG_LOG_PATH` → `mimocode-plugin.log`
2. **Event translation:** Adapt `translateEvent()` for MiMo Code's event names (need to verify exact names — the docs show similar patterns: `session.created`, `session.status`, `message.part.updated`, `permission.asked`)
3. **Permission handling:** `handlePermissionAsked()` — the permission flow is structurally identical (permission.asked → bridge → reply). The `@@mimocode/cli/plugin` SDK should provide `ctx.client._client.post()` for in-process replies, same as opencode's HeyApi client
4. **Config path:** `~/.config/mimocode/mimocode.jsonc` (JSONC format — need to handle comments when reading)
5. **Session IDs:** Change prefix from `opencode:` to `mimocode:`

### 2.2 Installer: `hooks/mimocode-install.js`

| Aspect | Detail |
|--------|--------|
| Config path | `~/.config/mimocode/mimocode.jsonc` |
| Config field | `plugin` array |
| Plugin dir | `hooks/mimocode-plugin/` (resolved via `asarUnpackedPath` for packaged builds) |
| Idempotency | Match by exact path or basename of absolute paths |
| Uninstall | Remove managed plugin entries from `plugin` array |

Follows `hooks/opencode-install.js` pattern exactly, changing:
- `DEFAULT_PARENT_DIR` → `~/.config/mimocode`
- `DEFAULT_CONFIG_PATH` → `~/.config/mimocode/mimocode.jsonc`
- `PLUGIN_DIR_NAME` → `mimocode-plugin`
- Detection: check `~/.config/mimocode/` exists
- JSONC handling: read as text, strip comments before `JSON.parse` (MiMo Code uses JSONC)

### 2.3 Agent Config: `agents/mimocode.js`

```javascript
module.exports = {
  id: "mimocode",
  name: "MiMo Code",
  processNames: { win: ["mimo.exe"], mac: ["mimo"], linux: ["mimo"] },
  eventSource: "plugin-event",
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    PreCompact: "sweeping",
    PostCompact: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true,
    sessionEnd: true,
    subagent: true,
  },
  pidField: "mimocode_pid",
};
```

**Process name note:** Need to verify the actual process name when MiMo Code is running. The CLI binary might be `mimo`, `mimocode`, or `mi`. Check with `ps aux | grep mimo` during testing.

---

## 3. Files to Modify

### 3.1 `agents/registry.js`

Add:
```javascript
const mimocode = require("./mimocode");
```
Add `mimocode` to the `AGENTS` array.

### 3.2 `src/server-agent-id.js`

Add to `HOOK_SOURCE_AGENT_IDS`:
```javascript
["mimocode-plugin", "mimocode"],
```

### 3.3 `src/integration-sync.js`

Add `syncMiMoCodePlugin()` function (parallel to `syncOpencodePlugin()`):
```javascript
function syncMiMoCodePlugin() {
  try {
    const { registerMiMoCodePlugin } = require("../hooks/mimocode-install.js");
    const result = registerMiMoCodePlugin({ silent: true });
    if (result.added || result.created) {
      console.log(`Clawd: synced mimocode plugin (added=${result.added}, created=${result.created})`);
    }
    if (result && result.reason === "mimocode-not-found") {
      return asSkipped(result, "mimocode-not-found", "mimocode is not installed; skipped plugin sync");
    }
    return asOk(result);
  } catch (err) {
    console.warn("Clawd: failed to sync mimocode plugin:", err.message);
    return { status: "error", message: err && err.message ? err.message : "Failed to sync mimocode plugin" };
  }
}
```

Add to `AGENT_INTEGRATION_SYNCERS`:
```javascript
mimocode: syncMiMoCodePlugin,
```

### 3.4 `src/server.js`

Add `syncMiMoCodePlugin` to destructured imports and exports from `integrationSync`.

### 3.5 `src/server-route-permission.js`

Add a `mimocode` branch parallel to the `opencode` branch. The permission flow is structurally identical:
- Fire-and-forget plugin → server creates bubble → user Allow/Deny → bridge reply to plugin
- DND → silent drop, TUI fallback
- Agent disabled → silent drop, TUI fallback
- Headless session → silent drop

The key fields to add to `permEntry`:
```javascript
mimocodeRequestId: requestId,
mimocodeBridgeUrl: bridgeUrl,
mimocodeBridgeToken: bridgeToken,
mimocodeAlwaysCandidates: alwaysCandidates,
mimocodePatterns: patterns,
```

### 3.6 `src/permission.js`

Add mimocode bridge reply function (parallel to `opencode` reply). The reverse bridge POST pattern is identical.

Add `mimocode-always` behavior handling.

### 3.7 `src/prefs.js`

Add to `agents` default:
```javascript
"mimocode": { integrationInstalled: false, enabled: false, permissionsEnabled: true, notificationHookEnabled: true },
```

### 3.8 `src/settings-actions.js`

Add `"mimocode"` to `MANAGED_CLEANUP_AGENT_IDS`.

### 3.9 `package.json`

Add scripts:
```json
"install:mimocode-plugin": "node hooks/mimocode-install.js",
"uninstall:mimocode-plugin": "node hooks/mimocode-install.js --uninstall"
```

Add to `build.files`:
```json
"hooks/mimocode-plugin/**/*"
```

Add to `build.asarUnpack`:
```json
"hooks/mimocode-plugin/**/*"
```

---

## 4. Event Mapping (Phase 1)

Based on MiMo Code docs and opencode similarity:

| MiMo Code Event | Clawd State | Clawd Event |
|-----------------|-------------|-------------|
| `session.created` | idle | SessionStart |
| `session.status` (busy) | thinking | UserPromptSubmit |
| `message.part.updated` (tool, running) | working | PreToolUse |
| `message.part.updated` (tool, completed) | working | PostToolUse |
| `message.part.updated` (tool, error) | error | PostToolUseFailure |
| `session.idle` | attention | Stop |
| `session.error` | error | StopFailure |
| `session.compacted` | sweeping | PreCompact |
| `session.deleted` / `server.instance.disposed` | sleeping | SessionEnd |

**Unknowns (need runtime verification):**
- Exact event names from `@@mimocode/cli/plugin` SDK
- Whether MiMo Code uses `ctx.client._client.post()` for permission replies
- The actual process name (`mimo`, `mimocode`, or other)
- Whether `session.idle` lacks sessionID (opencode has this issue)

---

## 5. Permission Flow

Identical to opencode's Phase 2 design:

```
MiMo Code permission.asked
  → plugin event handler → POST /permission { tool_name, tool_input, session_id, request_id, bridge_url, bridge_token }
  → Clawd 200 ACK immediately (fire-and-forget)
  → Clawd creates permission bubble
  → User clicks Allow / Always / Deny
  → Clawd POST plugin's reverse bridge → bridge calls ctx.client._client.post("/permission/:id/reply", { reply })
  → MiMo Code executes the decision
```

---

## 6. Testing Strategy

### Unit tests
- `test/mimocode-install.test.js` — installer idempotency, JSONC parsing, register/unregister
- Add mimocode to existing `test/agent-registry.test.js`
- Add mimocode to existing `test/integration-sync.test.js`
- Add mimocode permission cases to `test/server-permission.test.js`

### Manual verification
1. Install MiMo Code locally
2. Run `npm run install:mimocode-plugin`
3. Verify `~/.config/mimocode/mimocode.jsonc` contains the plugin path
4. Start Clawd + MiMo Code, verify session tracking
5. Trigger a permission request, verify bubble appears
6. Click Allow/Deny, verify reply reaches MiMo Code

---

## 7. Risk & Open Questions

| Risk | Mitigation |
|------|------------|
| MiMo Code's plugin SDK differs from opencode | Verify at runtime; the `@@mimocode/cli/plugin` import suggests similar API |
| JSONC config format requires comment stripping | Use `jsonc-parser` or regex strip before `JSON.parse` |
| Process name unknown | Verify with `ps` during testing; document in AGENTS.md |
| MiMo Code may have different event names | Probe with runtime event dump in plugin init |

---

## 8. Implementation Phases

| Phase | Scope | Files | Status |
|-------|-------|-------|--------|
| Phase 1 | Plugin + installer + agent config + registry + gate | `hooks/mimocode-plugin/*`, `hooks/mimocode-install.js`, `agents/mimocode.js`, registry/gate/prefs updates | ✅ Done |
| Phase 2 | Permission bubble + bridge reply | `server-route-permission.js`, `permission.js`, `server-agent-id.js` | ✅ Done |
| Phase 3 | Settings UI + i18n | `settings-renderer.js`, `i18n.js` | ✅ Done (auto from registry) |
| Phase 4 | Subagent tracking | `eventMap` additions, capabilities flip | ✅ Done |
