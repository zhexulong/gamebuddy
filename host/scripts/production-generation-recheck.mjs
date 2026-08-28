const schema = "gamebuddy-production-generation-recheck/v1";
const requestKind = "recheck_current_generation";
const resultKind = "recheck_current_generation_result";
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plainRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Installs the sole redacted selected-generation recheck responder for one
 * exact direct production child. The captured selected generation never crosses
 * IPC; every accepted request rechecks that pinned generation in the wrapper.
 */
export function installProductionGenerationRecheckService({ child, hostRoot, selected, recheck }) {
  if (!child || typeof child.on !== "function" || typeof child.send !== "function"
    || typeof hostRoot !== "string" || !selected || typeof recheck !== "function") {
    throw new Error("invalid_production_generation_recheck_service");
  }

  let active = true;
  let queue = Promise.resolve();
  const responded = new Set();

  const send = (message) => {
    if (!active || child.connected !== true) return;
    try { child.send(message); } catch { /* disconnected children receive no verdict */ }
  };

  const onMessage = (message) => {
    const request = parseRequest(message);
    if (request === undefined || !active || responded.has(request.requestId)) return;
    // One requestId produces at most one terminal response, even if a hostile
    // child repeats a message while the full verifier is still queued.
    responded.add(request.requestId);
    queue = queue.then(async () => {
      let verdict = "rejected";
      if (active && child.connected === true) {
        try {
          await recheck({ hostRoot, selected });
          verdict = "verified";
        } catch { /* redacted rejection is the only failure disclosure */ }
      }
      if (active && child.connected === true) send(Object.freeze({
        schema,
        kind: resultKind,
        requestId: request.requestId,
        phase: request.phase,
        verdict,
      }));
    }, async () => undefined);
  };
  const close = () => { active = false; };

  child.on("message", onMessage);
  child.once("disconnect", close);
  child.once("close", close);
  child.once("exit", close);
  child.once("error", close);

  return Object.freeze({
    close() {
      if (!active) return;
      active = false;
      child.removeListener?.("message", onMessage);
    },
  });
}

export function isProductionGenerationRecheckRequest(message) { return parseRequest(message) !== undefined; }

function parseRequest(message) {
  if (!exactKeys(message, ["schema", "kind", "requestId", "phase"])
    || message.schema !== schema || message.kind !== requestKind
    || typeof message.requestId !== "string" || !requestIdPattern.test(message.requestId)
    || (message.phase !== "pre" && message.phase !== "post")) return undefined;
  return message;
}
