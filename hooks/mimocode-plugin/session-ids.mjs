const SESSION_ID_PREFIX = "mimocode:";

export const DEFAULT_SESSION_ID = `${SESSION_ID_PREFIX}default`;

function normalizeSessionText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeMiMoCodeSessionId(value) {
  const raw = normalizeSessionText(value);
  if (!raw) return null;
  return raw.startsWith(SESSION_ID_PREFIX) ? raw : `${SESSION_ID_PREFIX}${raw}`;
}

export function getEventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  return normalizeSessionText(props.sessionID) || normalizeSessionText(event.sessionID);
}

export function resolveMiMoCodeSessionId(current, fallback) {
  return normalizeMiMoCodeSessionId(current)
    || normalizeMiMoCodeSessionId(fallback)
    || DEFAULT_SESSION_ID;
}

export function shouldDropMappedEventWithoutSessionId(event, mapped) {
  return mapped
    && mapped.event === "SessionEnd"
    && !getEventSessionId(event);
}

export function getEventParentSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = props.info && typeof props.info === "object" ? props.info : {};
  const parentID = info.parentID;
  return typeof parentID === "string" && parentID.trim() ? parentID.trim() : null;
}

export function isChildSessionId(sessionId, sessionParentById) {
  if (!sessionId || !sessionParentById || typeof sessionParentById.has !== "function") {
    return false;
  }
  const normalized = normalizeMiMoCodeSessionId(sessionId);
  if (!normalized) return false;
  return sessionParentById.has(normalized);
}

export function cleanupSessionParentMap(event, map) {
  if (!event || typeof event.type !== "string") return;
  if (!map || typeof map.clear !== "function") return;

  if (event.type === "server.instance.disposed") {
    map.clear();
    return;
  }

  if (event.type === "session.deleted") {
    const rawSid = getEventSessionId(event);
    const normSid = normalizeMiMoCodeSessionId(rawSid);
    if (normSid && map.has(normSid)) {
      map.delete(normSid);
    }
  }
}
