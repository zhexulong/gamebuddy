import net from "node:net";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Client for the Windows DACL-protected product control pipe.
 *
 * This is intentionally a supervisor-side capability: it receives the
 * per-launch pair only over direct-parent IPC and never reads it from an
 * artifact, CLI argument, file, log, or inherited environment. The server
 * remains the PowerShell helper-backed DACL/SID boundary; this client only
 * speaks the already-reviewed, bounded application protocol over that pipe.
 */
export function createProductionControlClient({ pipeName, launchToken, connectPipe = connectWindowsNamedPipe, requestTimeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!IDENTIFIER.test(pipeName ?? "") || !TOKEN.test(launchToken ?? "")) throw new Error("invalid_product_control_capability");
  if (typeof connectPipe !== "function" || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60_000)
    throw new Error("invalid_product_control_client_options");

  let socket;
  let runtimeInstanceId;
  let closed = false;
  let pending;
  let buffered = Buffer.alloc(0);

  const fail = (code) => {
    if (closed) return;
    closed = true;
    const current = pending;
    pending = undefined;
    try { socket?.destroy(); } catch { /* already closed */ }
    current?.reject(new Error(code));
  };

  const onData = (chunk) => {
    if (closed || !Buffer.isBuffer(chunk)) return fail("control_client_response_invalid");
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.byteLength > MAX_LINE_BYTES + 1) return fail("control_client_response_oversize");
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) return;
    if (newline === 0 || newline > MAX_LINE_BYTES || buffered.indexOf(0x0a, newline + 1) >= 0) return fail("control_client_response_invalid");
    const bytes = buffered.subarray(0, newline);
    buffered = Buffer.alloc(0);
    let reply;
    try {
      reply = parseReply(bytes);
    } catch (error) {
      fail(error instanceof Error ? error.message : "control_client_response_invalid");
      return;
    }
    const current = pending;
    if (current === undefined) return fail("control_client_unsolicited_response");
    pending = undefined;
    clearTimeout(current.timer);
    current.resolve(reply);
  };

  const connect = async () => {
    if (closed) throw new Error("control_client_closed");
    if (socket !== undefined) return;
    socket = await new Promise((resolve, reject) => {
      let candidate;
      const timer = setTimeout(() => {
        try { candidate?.destroy(); } catch { /* ignore */ }
        reject(new Error("control_client_connect_timeout"));
      }, requestTimeoutMs);
      timer.unref?.();
      try {
        candidate = connectPipe(pipeName);
      } catch {
        clearTimeout(timer);
        reject(new Error("control_client_connect_failed"));
        return;
      }
      if (!candidate || typeof candidate.once !== "function" || typeof candidate.on !== "function" || typeof candidate.write !== "function") {
        clearTimeout(timer);
        reject(new Error("control_client_connect_failed"));
        return;
      }
      candidate.once("connect", () => { clearTimeout(timer); resolve(candidate); });
      candidate.once("error", () => { clearTimeout(timer); reject(new Error("control_client_connect_failed")); });
    });
    socket.on("data", onData);
    socket.on("error", () => fail("control_client_transport_failed"));
    socket.on("end", () => fail("control_client_transport_closed"));
    socket.on("close", () => fail("control_client_transport_closed"));
  };

  const request = async (value) => {
    await connect();
    if (closed) throw new Error("control_client_closed");
    if (pending !== undefined) throw new Error("control_client_request_in_flight");
    const line = encodeRequest(value);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail("control_client_request_timeout"), requestTimeoutMs);
      timer.unref?.();
      pending = { resolve, reject, timer };
      try {
        socket.write(line, (error) => {
          if (error) fail("control_client_transport_failed");
        });
      } catch {
        fail("control_client_transport_failed");
      }
    });
  };

  return Object.freeze({
    hello: async () => {
      if (runtimeInstanceId !== undefined) throw new Error("control_client_hello_already_completed");
      const reply = await request({ type: "hello", protocolVersion: 1, launchToken });
      if (reply.ok !== true || !IDENTIFIER.test(reply.runtimeInstanceId ?? "") || reply.protocolVersion !== 1)
        throw new Error("control_client_hello_rejected");
      runtimeInstanceId = reply.runtimeInstanceId;
      return Object.freeze({ runtimeInstanceId });
    },
    playerInput: async ({ requestId, sourceEventId, text, locale }) => {
      const runtime = requireRuntime(runtimeInstanceId);
      return expectAcceptance(await request({ type: "player_input", requestId, runtimeInstanceId: runtime, sourceEventId, text, locale }), "player_input");
    },
    stopAll: async ({ requestId, stopId, sourceEventId }) => {
      const runtime = requireRuntime(runtimeInstanceId);
      return expectAcceptance(await request({ type: "stop_all", requestId, runtimeInstanceId: runtime, stopId, sourceEventId }), [
        "stop_all",
        "active_turn_cancelled",
        "queued_turn_cancelled",
        "no_active_turn",
        "duplicate_stop",
      ]);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      const current = pending;
      pending = undefined;
      if (current !== undefined) {
        clearTimeout(current.timer);
        current.reject(new Error("control_client_closed"));
      }
      try { socket?.destroy(); } catch { /* already closed */ }
    },
  });
}

function connectWindowsNamedPipe(pipeName) {
  if (process.platform !== "win32") throw new Error("windows_product_control_required");
  return net.createConnection({ path: `\\\\.\\pipe\\${pipeName}` });
}

function requireRuntime(value) {
  if (!IDENTIFIER.test(value ?? "")) throw new Error("control_client_hello_required");
  return value;
}

function expectAcceptance(reply, expected) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (reply.ok !== true || !accepted.includes(reply.accepted)) throw new Error(`control_client_request_rejected:${reply.code ?? "invalid_reply"}`);
  return Object.freeze({ accepted: reply.accepted });
}

function encodeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") throw new Error("invalid_control_client_request");
  const exact = (keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  if (value.type === "hello") {
    if (!exact(["type", "protocolVersion", "launchToken"]) || value.protocolVersion !== 1 || !TOKEN.test(value.launchToken)) throw new Error("invalid_control_client_request");
  } else if (value.type === "player_input") {
    if (!exact(["type", "requestId", "runtimeInstanceId", "sourceEventId", "text", "locale"]) || !identifiers(value.requestId, value.runtimeInstanceId, value.sourceEventId) || !validText(value.text) || !validLocale(value.locale)) throw new Error("invalid_control_client_request");
  } else if (value.type === "stop_all") {
    if (!exact(["type", "requestId", "runtimeInstanceId", "stopId", "sourceEventId"]) || !identifiers(value.requestId, value.runtimeInstanceId, value.stopId, value.sourceEventId)) throw new Error("invalid_control_client_request");
  } else throw new Error("invalid_control_client_request");
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("invalid_control_client_request");
  return `${line}\n`;
}

function identifiers(...values) { return values.every((value) => IDENTIFIER.test(value ?? "")); }
function validText(value) { return typeof value === "string" && Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= 4_000; }
function validLocale(value) { return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 64 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(value); }

function parseReply(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("control_client_response_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.ok !== "boolean") throw new Error("control_client_response_invalid");
  if (value.ok === true) {
    const allowed = ["ok", "runtimeInstanceId", "protocolVersion", "accepted"];
    if (Object.keys(value).some((key) => !allowed.includes(key)) || (value.runtimeInstanceId !== undefined && !IDENTIFIER.test(value.runtimeInstanceId)) || (value.protocolVersion !== undefined && value.protocolVersion !== 1) || (value.accepted !== undefined && !["player_input", "stop_all", "active_turn_cancelled", "queued_turn_cancelled", "no_active_turn", "duplicate_stop"].includes(value.accepted))) throw new Error("control_client_response_invalid");
  } else {
    if (Object.keys(value).length !== 2 || typeof value.code !== "string" || !/^[a-z0-9_:-]{1,128}$/.test(value.code)) throw new Error("control_client_response_invalid");
  }
  return Object.freeze({ ...value });
}
