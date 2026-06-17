import { readFileSync, writeFileSync, mkdirSync, promises as fsp } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { execFileSync, execSync } from "child_process";
import {
  DEFAULT_SESSION_ID,
  getEventSessionId,
  getEventParentSessionId,
  isChildSessionId,
  cleanupSessionParentMap,
  normalizeMiMoCodeSessionId,
  resolveMiMoCodeSessionId,
  shouldDropMappedEventWithoutSessionId,
} from "./session-ids.mjs";

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
const DEBUG_LOG_PATH = join(CLAWD_DIR, "mimocode-plugin.log");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const STATE_PATH = "/state";
const POST_TIMEOUT_MS = 1000;
const AGENT_ID = "mimocode";
const HOOK_SOURCE = "mimocode-plugin";

const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
]);
const TERMINAL_NAMES_LINUX = new Set([
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
]);
const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

let _cachedPort = null;
const _lastStatePerSession = new Map();
let _lastSeenSessionId = null;
let _reqCounter = 0;
let _rootSessionId = null;
const _sessionParentById = new Map();
let _stablePid = null;
let _pidChain = [];
let _detectedEditor = null;
let _tmuxSocket = null;
let _tmuxClient = null;
let _cwd = "";
let _serverUrl = "";
let _ctxClient = null;
let _bridgeUrl = "";
let _bridgeTokenHex = "";
let _bridgeTokenBuf = null;
let _bridgeServer = null;

const _debugBuffer = [];
let _debugFlushing = false;
function debugLog(msg) {
  _debugBuffer.push(`[${new Date().toISOString()}] ${msg}\n`);
  scheduleDebugFlush();
}
function scheduleDebugFlush() {
  if (_debugFlushing || _debugBuffer.length === 0) return;
  _debugFlushing = true;
  setImmediate(async () => {
    const chunk = _debugBuffer.join("");
    _debugBuffer.length = 0;
    try {
      await fsp.appendFile(DEBUG_LOG_PATH, chunk, "utf8");
    } catch {}
    _debugFlushing = false;
    if (_debugBuffer.length > 0) scheduleDebugFlush();
  });
}

function resetDebugLog() {
  try {
    mkdirSync(CLAWD_DIR, { recursive: true });
    writeFileSync(DEBUG_LOG_PATH, "", "utf8");
  } catch {}
}

function readRuntimePort() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && SERVER_PORTS.includes(port)) return port;
  } catch {}
  return null;
}

function getPortCandidates() {
  const ordered = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p) && SERVER_PORTS.includes(p)) {
      seen.add(p);
      ordered.push(p);
    }
  };
  add(_cachedPort);
  if (_cachedPort == null) add(readRuntimePort());
  SERVER_PORTS.forEach(add);
  return ordered;
}

function getWindowsProcessSnapshot() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const trimmed = (out || "").trim();
    if (!trimmed) return new Map();
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const map = new Map();
    for (const proc of list) {
      const pid = Number(proc && proc.ProcessId);
      if (!Number.isFinite(pid)) continue;
      map.set(pid, {
        name: typeof proc.Name === "string" ? proc.Name.toLowerCase() : "",
        ppid: Number(proc.ParentProcessId) || 0,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function getStablePid() {
  if (_stablePid) return _stablePid;
  const isWin = platform() === "win32";
  const isMac = platform() === "darwin";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (isMac ? TERMINAL_NAMES_MAC : TERMINAL_NAMES_LINUX);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (isMac ? SYSTEM_BOUNDARY_MAC : SYSTEM_BOUNDARY_LINUX);
  const editorMap = isWin ? EDITOR_MAP_WIN : (isMac ? EDITOR_MAP_MAC : EDITOR_MAP_LINUX);

  let pid = process.pid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;

  const winSnapshot = isWin ? getWindowsProcessSnapshot() : null;

  for (let i = 0; i < 10 && pid && pid > 1; i++) {
    let name = "";
    let parentPid = 0;
    try {
      if (isWin) {
        const info = winSnapshot.get(pid);
        if (!info) break;
        name = info.name;
        parentPid = info.ppid;
      } else {
        const commOut = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        name = commOut.split("/").pop().toLowerCase();
        if (!_detectedEditor) {
          const fullLower = commOut.toLowerCase();
          if (fullLower.includes("visual studio code")) _detectedEditor = "code";
          else if (fullLower.includes("cursor.app")) _detectedEditor = "cursor";
        }
        const ppidOut = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        parentPid = parseInt(ppidOut, 10) || 0;
      }
    } catch {
      break;
    }
    _pidChain.push(pid);
    if (!_detectedEditor && editorMap[name]) _detectedEditor = editorMap[name];
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }

  _stablePid = terminalPid || lastGoodPid;

  _tmuxSocket = null;
  _tmuxClient = null;
  if (process.env.TMUX) {
    const socketPath = process.env.TMUX.split(",")[0];
    if (typeof socketPath === "string" && socketPath.startsWith("/") && socketPath.length <= 4096 && !/[\0\r\n]/.test(socketPath)) {
      _tmuxSocket = socketPath;
    }
    if (process.env.TMUX_PANE) {
      try {
        const raw = execFileSync("tmux", ["list-clients", "-t", process.env.TMUX_PANE, "-F", "#{client_tty}"],
          { encoding: "utf8", timeout: 500 });
        const target = raw.split("\n").map(s => s.trim()).find(Boolean) || "";
        if (target && target.length <= 256 && !target.startsWith("-") && /^[\w./:-]+$/.test(target)) {
          _tmuxClient = target;
        }
      } catch {}
    }
  }

  debugLog(`PID resolved stable=${_stablePid} editor=${_detectedEditor || "none"} chain=[${_pidChain.join(",")}]`);
  return _stablePid;
}

function postToClawd(urlPath, body, logTag) {
  if (_stablePid) {
    body.source_pid = _stablePid;
    if (_pidChain.length) body.pid_chain = _pidChain;
    if (_detectedEditor) body.editor = _detectedEditor;
    if (_tmuxSocket) body.tmux_socket = _tmuxSocket;
    if (_tmuxClient) body.tmux_client = _tmuxClient;
  }
  if (_cwd) body.cwd = _cwd;
  body.agent_pid = process.pid;
  const payload = JSON.stringify(body);
  const candidates = getPortCandidates();
  const reqId = ++_reqCounter;
  debugLog(`POST[${reqId}] ${logTag} start candidates=[${candidates.join(",")}]`);

  (async () => {
    for (const port of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        const header = res.headers.get("x-clawd-server");
        debugLog(`POST[${reqId}] ${logTag} port=${port} status=${res.status} header=${header} elapsed=${elapsed}ms`);
        if (header === "clawd-on-desk") {
          _cachedPort = port;
          try { await res.text(); } catch {}
          debugLog(`POST[${reqId}] ${logTag} OK port=${port}`);
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        debugLog(`POST[${reqId}] ${logTag} port=${port} ERR ${err && err.name}/${err && err.message} elapsed=${elapsed}ms`);
      }
    }
    debugLog(`POST[${reqId}] ${logTag} EXHAUSTED all candidates failed`);
    _cachedPort = null;
  })().catch((err) => {
    debugLog(`POST[${reqId}] ${logTag} UNCAUGHT ${err && err.message}`);
  });
}

function postStateToClawd(body) {
  postToClawd(STATE_PATH, body, `STATE state=${body.state}`);
}

function postPermissionToClawd(body) {
  postToClawd("/permission", body, `PERM tool=${body.tool_name} req=${body.request_id}`);
}

function buildStateBody(state, eventName, sessionId) {
  if (!state || !eventName) return null;
  const clawdSessionId = normalizeMiMoCodeSessionId(sessionId) || DEFAULT_SESSION_ID;
  const body = {
    state,
    session_id: clawdSessionId,
    event: eventName,
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
  };
  if (isChildSessionId(clawdSessionId, _sessionParentById)) {
    body.headless = true;
  }
  return body;
}

function sendState(state, eventName, sessionId) {
  const body = buildStateBody(state, eventName, sessionId);
  if (!body) return;

  const lastState = _lastStatePerSession.get(body.session_id) || null;
  if (body.state === lastState) {
    return;
  }

  debugLog(`SEND ${lastState || "null"} → ${body.state} event=${body.event} session=${body.session_id}`);
  _lastStatePerSession.set(body.session_id, body.state);

  postStateToClawd(body);
}

function translateEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  const props = event.properties || {};
  const sessionId = getEventSessionId(event);

  switch (event.type) {
    case "session.created":
      return { state: "idle", event: "SessionStart" };

    case "session.status": {
      const type = props.status && props.status.type;
      if (type === "busy") return { state: "thinking", event: "UserPromptSubmit" };
      return null;
    }

    case "message.part.updated": {
      const part = props.part;
      if (!part || typeof part !== "object") return null;

      if (part.type === "tool") {
        const status = part.state && part.state.status;
        if (status === "running") return { state: "working", event: "PreToolUse" };
        if (status === "completed") return { state: "working", event: "PostToolUse" };
        if (status === "error") return { state: "error", event: "PostToolUseFailure" };
        return null;
      }

      if (part.type === "compaction") {
        return { state: "sweeping", event: "PreCompact" };
      }

      return null;
    }

    case "session.compacted":
      return { state: "sweeping", event: "PreCompact" };

    case "session.idle": {
      if (isChildSessionId(sessionId, _sessionParentById)) {
        return { state: "sleeping", event: "SessionEnd" };
      }
      return { state: "attention", event: "Stop" };
    }

    case "session.error":
      return { state: "error", event: "StopFailure" };

    case "session.deleted":
    case "server.instance.disposed":
      return { state: "sleeping", event: "SessionEnd" };

    default:
      return null;
  }
}

const __testInternals = {
  buildStateBody,
  translateEvent,
  get _sessionParentById() { return _sessionParentById; },
  get _rootSessionId() { return _rootSessionId; },
  set _rootSessionId(v) { _rootSessionId = v; },
};

function normalizeServerUrl(raw) {
  if (!raw) return "";
  const s = String(raw);
  return s.endsWith("/") ? s : s + "/";
}

function handlePermissionAsked(event) {
  const p = (event && event.properties) || {};
  const requestId = p.id;
  if (!requestId) {
    debugLog(`PERM skip: no request id in permission.asked`);
    return;
  }
  postPermissionToClawd({
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    tool_name: p.permission || "unknown",
    tool_input: p.metadata || {},
    patterns: Array.isArray(p.patterns) ? p.patterns : [],
    always: Array.isArray(p.always) ? p.always : [],
    session_id: resolveMiMoCodeSessionId(null, _lastSeenSessionId || _rootSessionId),
    request_id: requestId,
    server_url: _serverUrl,
    bridge_url: _bridgeUrl,
    bridge_token: _bridgeTokenHex,
  });
}

function verifyBridgeToken(headerValue) {
  if (!headerValue || !_bridgeTokenBuf) return false;
  const m = /^Bearer\s+([a-f0-9]+)$/i.exec(headerValue);
  if (!m) return false;
  let candidate;
  try { candidate = Buffer.from(m[1], "hex"); } catch { return false; }
  if (candidate.length !== _bridgeTokenBuf.length) return false;
  try { return timingSafeEqual(candidate, _bridgeTokenBuf); } catch { return false; }
}

async function handleBridgeRequest(req) {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/reply") {
    return new Response("not found", { status: 404 });
  }
  if (!verifyBridgeToken(req.headers.get("authorization"))) {
    debugLog(`BRIDGE auth fail from=${req.headers.get("x-forwarded-for") || "local"}`);
    return new Response("unauthorized", { status: 401 });
  }
  let body;
  try { body = await req.json(); } catch {
    return new Response("bad json", { status: 400 });
  }
  const requestId = body && typeof body.request_id === "string" ? body.request_id : "";
  const reply = body && typeof body.reply === "string" ? body.reply : "";
  if (!requestId || !["once", "always", "reject"].includes(reply)) {
    debugLog(`BRIDGE bad payload requestId=${requestId} reply=${reply}`);
    return new Response("bad payload", { status: 400 });
  }
  if (!_ctxClient || !_ctxClient._client) {
    debugLog(`BRIDGE no ctx client available`);
    return new Response("plugin not ready", { status: 503 });
  }

  debugLog(`BRIDGE → mimocode permission reply requestId=${requestId} reply=${reply}`);
  try {
    const result = await _ctxClient._client.post({
      url: `/permission/${encodeURIComponent(requestId)}/reply`,
      body: { reply },
      headers: { "Content-Type": "application/json" },
    });
    const hasError = result && result.error != null;
    debugLog(`BRIDGE reply done requestId=${requestId} hasError=${hasError}`);
    if (hasError) {
      return new Response(JSON.stringify({ ok: false, error: String(result.error) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    debugLog(`BRIDGE reply THROW requestId=${requestId} msg=${err && err.message}`);
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function startBridge() {
  if (typeof Bun === "undefined" || !Bun.serve) {
    debugLog(`BRIDGE start FAILED: Bun.serve not available (not running under Bun?)`);
    return;
  }
  try {
    _bridgeTokenBuf = randomBytes(32);
    _bridgeTokenHex = _bridgeTokenBuf.toString("hex");
    _bridgeServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: handleBridgeRequest,
    });
    const port = _bridgeServer.port;
    _bridgeUrl = `http://127.0.0.1:${port}`;
    debugLog(`BRIDGE listening on ${_bridgeUrl} (token ${_bridgeTokenHex.slice(0, 8)}…)`);
  } catch (err) {
    debugLog(`BRIDGE start THROW: ${err && err.message}`);
    _bridgeServer = null;
    _bridgeUrl = "";
    _bridgeTokenHex = "";
    _bridgeTokenBuf = null;
  }
}

const plugin = async (ctx) => {
  resetDebugLog();
  _serverUrl = normalizeServerUrl(ctx && ctx.serverUrl);
  _ctxClient = ctx && ctx.client ? ctx.client : null;
  _cwd = ctx && typeof ctx.directory === "string" ? ctx.directory : "";
  debugLog(`INIT directory=${_cwd} serverUrl=${_serverUrl} pid=${process.pid} hasClient=${!!_ctxClient}`);
  getStablePid();
  startBridge();

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== "string") return;

        const sid = getEventSessionId(event);
        if (sid && !_rootSessionId) {
          _rootSessionId = sid;
          debugLog(`ROOT session captured id=${sid}`);
        }
        if (sid) _lastSeenSessionId = sid;

        if (event.type === "session.created" && sid) {
          const parentID = getEventParentSessionId(event);
          if (parentID) {
            const normChild = normalizeMiMoCodeSessionId(sid);
            const normParent = normalizeMiMoCodeSessionId(parentID);
            if (normChild && normParent) {
              _sessionParentById.set(normChild, normParent);
              debugLog(`CHILD session id=${normChild} parentId=${normParent}`);
            }
          }
        }

        if (event.type === "permission.asked") {
          handlePermissionAsked(event);
        }

        cleanupSessionParentMap(event, _sessionParentById);

        const mapped = translateEvent(event);
        if (!mapped) {
          if (event.type.startsWith("session.")) {
            const statusType = event.properties && event.properties.status && event.properties.status.type;
            debugLog(`IGNORE ${event.type}${statusType ? ` status=${statusType}` : ""}`);
          }
          return;
        }
        if (shouldDropMappedEventWithoutSessionId(event, mapped)) {
          debugLog(`DROP ${event.type} event=${mapped.event} reason=no-session-id`);
          return;
        }

        const sessionId = resolveMiMoCodeSessionId(
          getEventSessionId(event),
          _lastSeenSessionId || _rootSessionId
        );

        debugLog(`MAP ${event.type} → state=${mapped.state} event=${mapped.event}`);
        sendState(mapped.state, mapped.event, sessionId);
      } catch (err) {
        debugLog(`ERROR in event hook: ${err && err.message}`);
      }
    },
  };
};

Object.defineProperty(plugin, "__test", { value: __testInternals });

export default plugin;
