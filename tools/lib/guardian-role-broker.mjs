/**
 * The launcher-side role broker: the Guardian session peer the Desktop app is in production.
 *
 * The composition gate used to answer `hello` and then destroy the socket on any
 * `arm_attempt`/`launch_role`/`contain_role` frame, because nothing in this tree could serve them.
 * The frames are real work - they arm a named Job pair and a lease, start the Player Host suspended
 * and resume it inside its Job, and contain it on request - and the device that does that work
 * already exists: the generation publishes the resident Guardian
 * (`native/windows-bootstrap-guardian/win-x64/GameBuddy.WindowsBootstrapGuardian.exe`). This module
 * runs that binary out of the installed generation and speaks both halves of what the Desktop
 * speaks to it:
 *
 *   Host -- GameBuddy.HostGuardian.<bootstrapId> --> this module -- guardian control (stdin/stdout)
 *                                                       `-- private ingress (arm / launch plan)
 *
 * WHAT THE DESKTOP DOES THAT THIS CANNOT, AND WHAT THAT COSTS THE EVIDENCE.
 *
 * `DesktopHostBootstrapBroker.AuthenticateHostAsync` authenticates the Host by identity before it
 * parses a byte: `GetNamedPipeClientProcessId` must equal the exact child handle it created,
 * `ProcessIdToSessionId` must match its own session, and the child's user SID must be equal
 * (`desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs:60-79`). Node exposes none of the three:
 * a `net` server cannot ask who its named-pipe client is, and there is no impersonation shortcut.
 * A fabricated pid check would be worse than none, so it is not attempted.
 *
 * This broker therefore authenticates the Host by CAPABILITY ONLY: the endpoint is
 * `GameBuddy.HostGuardian.<bootstrapId>` where `bootstrapId` is 32 random bytes written once into
 * the child's private bootstrap frame, and the session is refused unless the hello repeats the exact
 * generation/inventoryDigest/runtimeAdmissionSha256 triple. Any local process that knew the id could
 * take the Host's place; no local process is told it.
 *
 * What that means for a run, stated so no reader has to infer it:
 *   - about the LAUNCH CHAIN (Host -> broker -> guardian -> Job -> role process -> bridge -> Mod)
 *     this is full evidence: every step is the production one, driven by real frames;
 *   - about CONTAINMENT POLICY it is weaker evidence: the Job/lease/suspended-start/contain
 *     mechanics are the guardian's own and are exercised for real, but the guard that the process
 *     which connects is the one this launcher started is absent. A run that contains a role here
 *     proves what the guardian does to a role; it does not prove the Desktop would have admitted
 *     the caller.
 *
 * It also starts the generation's Guardian image without the Desktop's own admission of it: the
 * Desktop holds a locked handle on an admitted image and re-verifies the created process's image
 * path (`GuardianSupervisor.cs:44,86`). Here the image is admitted by digest against the
 * generation's own `windows-bootstrap-guardian.manifest.json` - the publisher's authority rather
 * than a second copy - which names exactly the bytes that ran, and its path and digest are
 * reported. The handle lock and the created-process path check are not reproduced.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { killProcessTree } from "./windows-process-tree.mjs";

/** The endpoint family the Host dials. One spelling, asserted against its producers and consumer. */
export const GUARDIAN_PIPE_PREFIX = "GameBuddy.HostGuardian.";

/** Where the generation publishes the resident Guardian image it was built with. */
export const GUARDIAN_IMAGE_SEGMENTS = Object.freeze([
  "native",
  "windows-bootstrap-guardian",
  "win-x64",
  "GameBuddy.WindowsBootstrapGuardian.exe",
]);
export const GUARDIAN_MANIFEST_FILE = "windows-bootstrap-guardian.manifest.json";

const GUARDIAN_SESSION_SCHEMA = "gamebuddy-desktop-guardian-session/v1";
const MAX_FRAME_BYTES = 16_384;
const MAX_PRIVATE_FRAME_BYTES = 65_536;
const MAX_OPERATION_WAIT_BUDGET_MS = 300_000;
const MAX_DEADLINE_HORIZON_MS = 300_000;
const HEX64 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_FRAME = /^[A-Za-z0-9_-]{1,87382}$/;

const HELLO_KEYS = Object.freeze([
  "schema",
  "protocolVersion",
  "operation",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
]);

// `status` sits after `operation`, exactly where the Desktop writes it and where the Host reads
// it; appending it would order this broker's own acknowledgement outside the wire it serves.
const HELLO_ACK_KEYS = Object.freeze([
  "schema",
  "protocolVersion",
  "operation",
  "status",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
]);

const CORRELATION_KEYS = Object.freeze([
  "schema",
  "protocolVersion",
  "operation",
  "status",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
  "guardianInstanceId",
  "guardianEpoch",
  "attemptId",
]);
const ROLE_ACK_KEYS = Object.freeze([
  "schema",
  "protocolVersion",
  "operation",
  "status",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
  "guardianInstanceId",
  "guardianEpoch",
  "attemptId",
  "role",
]);
const ROLE_EXIT_KEYS = Object.freeze([
  "schema",
  "protocolVersion",
  "operation",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
  "guardianInstanceId",
  "guardianEpoch",
  "attemptId",
  "role",
  "exitCode",
]);

/**
 * The command key lists, in the ORDINAL order the Desktop compares them by
 * (`DesktopHostBootstrapBroker.cs:245-252` validated through `:467`, where `ExactObject` is a
 * `SequenceEqual`). A frame carrying the right keys in another order is refused there, so every
 * writer of this wire has to read this table instead of restating it.
 */
const COMMAND_KEYS = Object.freeze({
  arm_attempt: Object.freeze([
    "schema",
    "protocolVersion",
    "operation",
    "bootstrapId",
    "generation",
    "inventoryDigest",
    "runtimeAdmissionSha256",
    "operationWaitBudgetMs",
    "guardianInstanceId",
    "guardianEpoch",
    "attemptId",
    "privateFrame",
  ]),
  launch_role: Object.freeze([
    "schema",
    "protocolVersion",
    "operation",
    "bootstrapId",
    "generation",
    "inventoryDigest",
    "runtimeAdmissionSha256",
    "deadlineUnixMs",
    "guardianInstanceId",
    "guardianEpoch",
    "attemptId",
    "role",
    "privateFrame",
  ]),
  contain_role: Object.freeze([
    "schema",
    "protocolVersion",
    "operation",
    "bootstrapId",
    "generation",
    "inventoryDigest",
    "runtimeAdmissionSha256",
    "operationWaitBudgetMs",
    "guardianInstanceId",
    "guardianEpoch",
    "attemptId",
    "role",
  ]),
});

/** The one status each command must be answered with, per the Host client's own table. */
const COMMAND_STATUS = Object.freeze({
  arm_attempt: "armed",
  launch_role: "role_active",
  contain_role: "role_contained",
});

/**
 * The Guardian's own control frames, written to its stdin.
 *
 * `GuardianProtocol.Parse` compares the key SET, not the order, so this is the canonical order
 * rather than a load-bearing one - unlike the Host wire above.
 */
const NATIVE_CONTROL_KEYS = Object.freeze({
  arm_attempt: Object.freeze(["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId"]),
  launch_role: Object.freeze(["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "role"]),
  contain_role: Object.freeze(["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "role"]),
});

/** The environment the Desktop hands the Guardian, and nothing else (`GuardianSupervisor.cs:143-162`). */
const GUARDIAN_INHERITED_ENVIRONMENT = Object.freeze(["SystemRoot", "TEMP", "TMP"]);

export function guardianPipeEndpoint(bootstrapId) {
  if (typeof bootstrapId !== "string" || !HEX64.test(bootstrapId))
    throw new Error(`role_broker_bootstrap_id_invalid:${String(bootstrapId)}`);
  return `\\\\.\\pipe\\${GUARDIAN_PIPE_PREFIX}${bootstrapId}`;
}

/** The two files a generation's Guardian publication consists of, from its installed root. */
export function guardianImagePaths(generationRoot) {
  if (typeof generationRoot !== "string" || generationRoot.length === 0)
    throw new Error(`role_broker_generation_root_invalid:${String(generationRoot)}`);
  const directory = join(generationRoot, ...GUARDIAN_IMAGE_SEGMENTS.slice(0, -1));
  return Object.freeze({
    directory,
    image: join(directory, GUARDIAN_IMAGE_SEGMENTS.at(-1)),
    manifest: join(directory, GUARDIAN_MANIFEST_FILE),
  });
}

/**
 * Admits the generation's Guardian image by the digest its own manifest declares.
 *
 * Returns `Object.freeze({ path, sha256 })`, or `null` when the generation publishes no image at
 * all - a generation without the resident Guardian can serve `hello` and nothing else, and the
 * caller names that state rather than this function throwing for it. A published image whose bytes
 * disagree with its manifest is never tolerated: it throws, because a Guardian that is not the one
 * the generation was released with is not this generation's Guardian.
 */
export async function admitGuardianImage({ generationRoot }) {
  const paths = guardianImagePaths(generationRoot);
  let manifestBytes;
  try {
    manifestBytes = await readFile(paths.manifest);
  } catch {
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(`role_broker_guardian_manifest_invalid:${paths.manifest}`);
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== 1 ||
    manifest.protocolVersion !== 1 ||
    manifest.rid !== "win-x64" ||
    manifest.helperFileName !== GUARDIAN_IMAGE_SEGMENTS.at(-1) ||
    typeof manifest.sha256 !== "string" ||
    !HEX64.test(manifest.sha256)
  )
    throw new Error(`role_broker_guardian_manifest_invalid:${paths.manifest}`);
  let imageBytes;
  try {
    imageBytes = await readFile(paths.image);
  } catch {
    throw new Error(`role_broker_guardian_image_missing:${paths.image}`);
  }
  const sha256 = createHash("sha256").update(imageBytes).digest("hex");
  if (sha256 !== manifest.sha256)
    throw new Error(`role_broker_guardian_image_mismatch:${paths.image}:${sha256}`);
  return Object.freeze({ path: paths.image, sha256 });
}

export function validateGuardianHelloRequest(value, expected) {
  return (
    exactKeysInOrder(value, HELLO_KEYS) &&
    value.schema === GUARDIAN_SESSION_SCHEMA &&
    value.protocolVersion === 1 &&
    value.operation === "hello" &&
    value.bootstrapId === expected.bootstrapId &&
    value.generation === expected.generation &&
    value.inventoryDigest === expected.inventoryDigest &&
    value.runtimeAdmissionSha256 === expected.runtimeAdmissionSha256
  );
}

/**
 * Parses one Host command frame, or returns `undefined`.
 *
 * The `undefined` is not a detail: the caller answers it by ending the session, which is the only
 * refusal this wire has.
 */
export function validateGuardianCommandFrame(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = COMMAND_KEYS[value.operation];
  if (keys === undefined || !exactKeysInOrder(value, keys)) return undefined;
  if (
    value.schema !== GUARDIAN_SESSION_SCHEMA ||
    value.protocolVersion !== 1 ||
    value.bootstrapId !== expected.bootstrapId ||
    value.generation !== expected.generation ||
    value.inventoryDigest !== expected.inventoryDigest ||
    value.runtimeAdmissionSha256 !== expected.runtimeAdmissionSha256
  )
    return undefined;
  if (typeof value.guardianInstanceId !== "string" || !OPAQUE.test(value.guardianInstanceId)) return undefined;
  if (!Number.isSafeInteger(value.guardianEpoch) || value.guardianEpoch < 1) return undefined;
  if (typeof value.attemptId !== "string" || !OPAQUE.test(value.attemptId)) return undefined;
  const role = "role" in value ? value.role : undefined;
  if ("role" in value && (role !== "player_host" && role !== "ai_client")) return undefined;
  if ("privateFrame" in value) {
    const privateFrame = value.privateFrame;
    if (typeof privateFrame !== "string" || !PRIVATE_FRAME.test(privateFrame)) return undefined;
  }
  if (value.operation === "launch_role") {
    if (!Number.isSafeInteger(value.deadlineUnixMs) || value.deadlineUnixMs <= 0) return undefined;
  } else if (
    !Number.isSafeInteger(value.operationWaitBudgetMs) ||
    value.operationWaitBudgetMs < 1 ||
    value.operationWaitBudgetMs > MAX_OPERATION_WAIT_BUDGET_MS
  )
    return undefined;
  return Object.freeze({
    operation: value.operation,
    guardianInstanceId: value.guardianInstanceId,
    guardianEpoch: value.guardianEpoch,
    attemptId: value.attemptId,
    role,
    privateFrame: value.privateFrame,
    deadlineUnixMs: value.deadlineUnixMs,
    operationWaitBudgetMs: value.operationWaitBudgetMs,
  });
}

export function composeGuardianHelloAck(binding) {
  return Object.freeze({
    schema: GUARDIAN_SESSION_SCHEMA,
    protocolVersion: 1,
    operation: "hello",
    status: "accepted",
    bootstrapId: binding.bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
  });
}

export function composeGuardianAck({ operation, status, binding, command }) {
  return Object.freeze({
    schema: GUARDIAN_SESSION_SCHEMA,
    protocolVersion: 1,
    operation,
    status,
    bootstrapId: binding.bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
    guardianInstanceId: command.guardianInstanceId,
    guardianEpoch: command.guardianEpoch,
    attemptId: command.attemptId,
    ...(command.role === undefined ? {} : { role: command.role }),
  });
}

export function composeGuardianRoleExit({ binding, correlation, role, exitCode }) {
  return Object.freeze({
    schema: GUARDIAN_SESSION_SCHEMA,
    protocolVersion: 1,
    operation: "role_exited",
    bootstrapId: binding.bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
    guardianInstanceId: correlation.guardianInstanceId,
    guardianEpoch: correlation.guardianEpoch,
    attemptId: correlation.attemptId,
    role,
    exitCode,
  });
}

export const GUARDIAN_WIRE_KEYS = Object.freeze({
  hello: HELLO_KEYS,
  helloAck: HELLO_ACK_KEYS,
  correlationAck: CORRELATION_KEYS,
  roleAck: ROLE_ACK_KEYS,
  roleExit: ROLE_EXIT_KEYS,
  commands: COMMAND_KEYS,
});

function exactKeysInOrder(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

/**
 * The broker's one failure channel: a name, thrown and logged.
 *
 * The Host wire has no error frame - a refusal IS the session ending, exactly as the Desktop
 * refuses - so the name can only travel in the launcher's own stderr. Every value it carries is
 * content: a path, a native result token, a millisecond budget. Never a frame, never a token,
 * never an endpoint: those are the three things this protocol must not publish.
 */
export class RoleBrokerRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "RoleBrokerRefusal";
    this.code = code;
  }
}

const refuse = (code) => new RoleBrokerRefusal(code);
const milliseconds = (value) => `${Math.max(0, Math.round(value))}ms`;
const delay = (value) => new Promise((resolve) => setTimeout(resolve, value));

/** `arm`/`launch`/`contain`: the one spelling a refusal family and a timeout share. */
function commandFamily(operation) {
  return operation === "arm_attempt" ? "arm" : operation === "launch_role" ? "launch" : "contain";
}

/**
 * A reader over a byte stream that yields whole `\n`-terminated lines, in order.
 *
 * One reader per stream, installed once: attaching and detaching `data` listeners per line loses
 * whatever arrived between two attachments, and a pipelined reply would then be waited for for ever.
 */
function lineReader(stream, { maxBytes = MAX_FRAME_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  const lines = [];
  let waiter;
  let failure;
  const settle = () => {
    if (waiter === undefined) return;
    if (lines.length > 0) {
      const next = waiter;
      waiter = undefined;
      next.resolve(lines.shift());
      return;
    }
    if (failure !== undefined) {
      const next = waiter;
      waiter = undefined;
      next.reject(refuse(failure));
    }
  };
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      lines.push(buffer.subarray(0, newline).toString("utf8"));
      buffer = buffer.subarray(newline + 1);
    }
    if (buffer.length > maxBytes) failure = "line_oversized";
    settle();
  });
  const fail = (reason) => {
    failure = reason;
    settle();
  };
  stream.once("error", () => fail("line_stream_error"));
  stream.once("close", () => fail("line_stream_closed"));
  stream.once("end", () => fail("line_stream_closed"));
  return Object.freeze({
    next: () => {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (failure !== undefined) return Promise.reject(refuse(failure));
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    pending: () => lines.length,
  });
}

/**
 * Creates the session peer for one launch.
 *
 * `image` is what `admitGuardianImage` returned, or `null` when the generation publishes none. A
 * broker without an image behaves exactly like the launcher's previous hello-only peer: it accepts
 * the authenticated hello and destroys the socket on the first command, so a run that never needs a
 * role is unaffected and a run that does says why in one line.
 */
export function createGuardianRoleBroker({
  bootstrapId,
  binding,
  image = null,
  imagePath = null,
  endpoint = guardianPipeEndpoint(bootstrapId),
  spawnImpl = spawn,
  killTree = killProcessTree,
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
  helloTimeoutMs = 30_000,
  privateConnectTimeoutMs = 10_000,
  guardianEnvironment = process.env,
}) {
  // One binding, composed once. The endpoint id is this launcher's; the three generation facts come
  // from the pointer the Host is admitted against. Keeping them in one object is what stops a hello
  // acknowledgement and a role acknowledgement from disagreeing about which launch they belong to.
  if (typeof binding?.bootstrapId === "string" && binding.bootstrapId !== bootstrapId)
    throw new Error(`role_broker_binding_conflict:${binding.bootstrapId}`);
  const launch = Object.freeze({
    bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
  });
  let sessionBuffer = Buffer.alloc(0);
  let server = null;
  let socket = null;
  let socketClosed = false;
  const inbound = [];
  let inboundBusy = false;
  let armed = false;
  let correlation = null;
  let helloAccepted = false;
  const launchedRoles = new Set();
  const containedRoles = new Set();
  const operations = [];
  const refusals = [];
  const guardianRuns = [];
  let guardian = null;
  let closed = false;
  let helloTimeout;

  const note = (code) => {
    if (!refusals.includes(code)) refusals.push(code);
    log(`role-broker: ${code}`);
  };

  let resolveHello;
  let rejectHello;
  const hello = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  hello.catch(() => undefined);

  function facts() {
    return Object.freeze({
      mode: image === null ? "hello_only" : "armable",
      image: image === null ? null : Object.freeze({ path: image.path, sha256: image.sha256 }),
      helloAccepted,
      guardians: Object.freeze([...guardianRuns]),
      operations: Object.freeze([...operations]),
      refusals: Object.freeze([...refusals]),
    });
  }

  function endGuardian(reason) {
    if (guardian === null) return;
    const running = guardian;
    guardian = null;
    try {
      running.stdin.destroy();
    } catch {
      /* already gone */
    }
    try {
      running.ingress?.destroy();
    } catch {
      /* already gone */
    }
    // The guardian's Player Job is deliberately NOT kill-on-close (#506), so an ordinary control
    // close leaves a game running by design. A harness run may not leave one: it ends the tree it
    // started, by the one pid it knows, and records which of the two outcomes happened.
    let ended;
    try {
      ended = killTree(running.pid);
    } catch (error) {
      ended = `failed:${String(error?.code ?? error).slice(0, 80)}`;
    }
    running.record.endedAtMs = now();
    running.record.ended = ended;
    log(`role-broker: guardian pid ${running.pid} ${ended} (${reason})`);
  }

  function writeHostFrame(value, keys) {
    if (socket === null || socketClosed) return;
    if (keys !== undefined && !exactKeysInOrder(value, keys)) {
      destroySocket("role_broker_frame_key_order_invalid");
      return;
    }
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length > MAX_FRAME_BYTES) {
      destroySocket("role_broker_frame_oversized");
      return;
    }
    try {
      socket.write(bytes, (error) => {
        if (error != null) destroySocket("role_broker_session_write_failed");
      });
    } catch {
      destroySocket("role_broker_session_write_failed");
    }
  }

  function destroySocket(code) {
    note(code);
    socketClosed = true;
    if (socket !== null) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    rejectHello(refuse(code));
    endGuardian(`session_refused:${code}`);
  }

  async function startGuardian() {
    if (image === null)
      throw refuse(`role_broker_guardian_binary_absent:${String(imagePath ?? "<generation publishes none>")}`);
    const token = randomBytes(32).toString("hex");
    const pipeName = `GameBuddy.Guardian.${randomUUID().replaceAll("-", "")}`;
    const environment = {
      GAMEBUDDY_GUARDIAN_MODE: "resident",
      GAMEBUDDY_GUARDIAN_CONTROL_PIPE: pipeName,
      GAMEBUDDY_GUARDIAN_CONTROL_TOKEN: token,
    };
    for (const name of GUARDIAN_INHERITED_ENVIRONMENT) {
      const value = guardianEnvironment[name];
      if (typeof value !== "string" || value.length === 0)
        throw refuse(`role_broker_guardian_environment_incomplete:${name}`);
      environment[name] = value;
    }
    let child;
    try {
      child = spawnImpl(image.path, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment });
    } catch (error) {
      throw refuse(`role_broker_guardian_spawn_failed:${String(error?.code ?? error).slice(0, 80)}`);
    }
    const record = { pid: child.pid, startedAtMs: now(), endedAtMs: null, ended: null };
    guardianRuns.push(record);
    const running = {
      pid: child.pid,
      record,
      token,
      pipeName,
      stdin: child.stdin,
      ingress: null,
      failure: undefined,
      results: [],
      resultWaiter: undefined,
    };
    const stdout = lineReader(child.stdout);
    void (async () => {
      for (;;) {
        let line;
        try {
          line = await stdout.next();
        } catch (error) {
          running.failure = error instanceof RoleBrokerRefusal ? error.code : "guardian_stream_closed";
          failResultWaiter(running);
          return;
        }
        receiveGuardianLine(running, line);
      }
    })();
    child.stderr.setEncoding("utf8");
    // The guardian writes exactly one bounded token to stderr on its own fail-closed path
    // (`windows_bootstrap_guardian_invalid_request`); it is the only statement of why it stopped.
    // Once this broker has ended the guardian itself that token is this broker's own doing, so it is
    // not forwarded: a run's log must not show a fail-closed line for a guardian the harness killed.
    child.stderr.on("data", (chunk) => {
      if (record.ended !== null) return;
      const text = String(chunk).trim().slice(0, 200);
      if (text.length > 0) log(`role-broker: guardian stderr: ${text}`);
    });
    child.once("exit", (code) => {
      running.exitCode = code ?? null;
      if (running.failure === undefined) running.failure = `guardian_exited:${String(code ?? "unknown")}`;
      failResultWaiter(running);
    });
    child.once("error", () => {
      running.failure = "guardian_spawn_error";
      failResultWaiter(running);
    });
    guardian = running;
    log(`role-broker: guardian pid ${child.pid} started from ${image.path}`);
    return running;
  }

  function failResultWaiter(running) {
    const waiter = running.resultWaiter;
    running.resultWaiter = undefined;
    waiter?.reject(refuse(`role_broker_${running.failure ?? "guardian_unavailable"}`));
  }

  /**
   * Separates the Guardian's two public frame shapes: a `role_exited` event, which is unsolicited and
   * travels to the Host the moment it is read, and the single `{schemaVersion, result}` reply a
   * command is waiting for.
   */
  function receiveGuardianLine(running, line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      running.failure = "guardian_frame_not_json";
      failResultWaiter(running);
      return;
    }
    if (
      exactKeysInOrder(value, ["operation", "role", "exitCode"]) &&
      value.operation === "role_exited" &&
      (value.role === "player_host" || value.role === "ai_client") &&
      Number.isSafeInteger(value.exitCode) &&
      value.exitCode >= 0 &&
      value.exitCode <= 4_294_967_295
    ) {
      // A role cannot end before the session is armed, so an exit with no correlation has nothing
      // to bind to and is recorded rather than sent unbound.
      if (correlation === null) {
        note("role_broker_role_exit_without_correlation");
        return;
      }
      writeHostFrame(
        composeGuardianRoleExit({ binding: launch, correlation, role: value.role, exitCode: value.exitCode }),
        ROLE_EXIT_KEYS,
      );
      operations.push(Object.freeze({ operation: "role_exited", outcome: value.role }));
      log(`role-broker: guardian reported ${value.role} exited with ${String(value.exitCode)}`);
      return;
    }
    if (
      !exactKeysInOrder(value, ["schemaVersion", "result"]) ||
      value.schemaVersion !== 1 ||
      typeof value.result !== "string"
    ) {
      running.failure = "guardian_public_frame_invalid";
      failResultWaiter(running);
      return;
    }
    const waiter = running.resultWaiter;
    running.resultWaiter = undefined;
    if (waiter === undefined) {
      running.results.push(value.result);
      return;
    }
    waiter.resolve(value.result);
  }

  function nextPublicResult(running) {
    if (running.results.length > 0) return Promise.resolve(running.results.shift());
    if (running.failure !== undefined) return Promise.reject(refuse(`role_broker_${running.failure}`));
    return new Promise((resolve, reject) => {
      running.resultWaiter = { resolve, reject };
    });
  }

  /**
   * Connects the Guardian's private ingress, retrying inside one bounded window.
   *
   * The Guardian creates that pipe only after it has parsed this very command from its stdin, so the
   * first attempt legitimately finds no endpoint. The Desktop's .NET client retries internally;
   * Node's `createConnection` reports ENOENT and stops, so the retry is stated here, not assumed.
   */
  async function connectIngress(running, deadlineMs) {
    if (running.ingress !== null) return running.ingress;
    for (;;) {
      const attempt = await new Promise((resolveAttempt) => {
        const candidate = createConnection(`\\\\.\\pipe\\${running.pipeName}`);
        const settle = (value) => {
          candidate.off("connect", onConnect);
          candidate.off("error", onError);
          resolveAttempt(value);
        };
        const onConnect = () => settle({ socket: candidate });
        const onError = (error) => {
          candidate.destroy();
          settle({ error });
        };
        candidate.once("connect", onConnect);
        candidate.once("error", onError);
      });
      if (attempt.socket !== undefined) {
        attempt.socket.on("error", () => undefined);
        running.ingress = attempt.socket;
        running.ingressLines = lineReader(attempt.socket);
        return running.ingress;
      }
      if (running.failure !== undefined) throw refuse(`role_broker_${running.failure}`);
      if (now() >= deadlineMs)
        throw refuse(`role_broker_private_ingress_unavailable:${String(attempt.error?.code ?? "unreachable")}`);
      await delay(50);
    }
  }

  async function writeThenFlush(stream, frame) {
    if (frame.length === 0 || frame.length > MAX_PRIVATE_FRAME_BYTES) throw refuse("role_broker_private_frame_invalid");
    if (frame.includes(10) || frame.includes(13) || frame.includes(0)) throw refuse("role_broker_private_frame_invalid");
    await writeStream(stream, frame);
    await writeStream(stream, Buffer.from("\n"));
  }

  /**
   * Mirrors `GuardianPrivateIngress.InjectArmToken`: the Host's arm body is tokenless by
   * construction and the launcher is the only party holding the token.
   */
  function injectArmToken(token, body) {
    if (body.length < 2 || body[0] !== 0x7b || body.at(-1) !== 0x7d) throw refuse("role_broker_arm_body_invalid");
    const text = body.toString("utf8");
    if (text.includes("\u0000") || text.includes('"token"')) throw refuse("role_broker_arm_body_invalid");
    return Buffer.concat([Buffer.from(`{"token":"${token}",`, "utf8"), body.subarray(1)]);
  }

  function decodePrivateFrame(encoded) {
    if (typeof encoded !== "string" || encoded.length === 0) throw refuse("role_broker_private_frame_invalid");
    const body = Buffer.from(encoded, "base64url");
    if (body.length === 0 || body.length > MAX_PRIVATE_FRAME_BYTES) throw refuse("role_broker_private_frame_invalid");
    return body;
  }

  /**
   * Runs one command against the Guardian and returns the status it replied with.
   *
   * The budget is the one the Desktop binds: a launch is bounded by the Host's own absolute
   * deadline, everything else by the Host's bounded operation wait. A command that does not finish
   * inside it leaves an unknown native outcome, which is never retried (#3795): the guardian is ended
   * and the name says which budget ran out.
   */
  async function relay(command) {
    const operation = command.operation;
    const budget = operation === "launch_role" ? command.deadlineUnixMs - now() : command.operationWaitBudgetMs;
    if (budget <= 0)
      throw refuse(`role_broker_${commandFamily(operation)}_timeout:${milliseconds(0)}`);
    if (operation === "launch_role" && budget > MAX_DEADLINE_HORIZON_MS)
      throw refuse(`role_broker_launch_refused:deadline_out_of_horizon:${milliseconds(budget)}`);
    const running = guardian ?? (await startGuardian());
    const deadlineMs = now() + budget;
    try {
      return await withDeadline(commandFamily(operation), budget, async () => {
        await writeStream(running.stdin, nativeControlFrame(operation, command));
        if (operation === "arm_attempt" || operation === "launch_role") {
          await connectIngress(running, Math.min(deadlineMs, now() + privateConnectTimeoutMs));
          const body =
            operation === "arm_attempt"
              ? injectArmToken(running.token, decodePrivateFrame(command.privateFrame))
              : decodePrivateFrame(command.privateFrame);
          await writeThenFlush(running.ingress, body);
          const reply = await running.ingressLines.next();
          if (reply !== "accepted")
            throw refuse(`role_broker_${commandFamily(operation)}_refused:ingress_${reply.slice(0, 40)}`);
        }
        const status = await nextPublicResult(running);
        if (status !== COMMAND_STATUS[operation])
          throw refuse(`role_broker_${commandFamily(operation)}_refused:${status.slice(0, 40)}`);
        return status;
      });
    } catch (error) {
      endGuardian(error instanceof RoleBrokerRefusal ? error.code : "role_broker_relay_failed");
      throw error;
    }
  }

  async function withDeadline(family, budget, run) {
    let timer;
    const running = run();
    running.catch(() => undefined);
    const timeout = new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(refuse(`role_broker_${family}_timeout:${milliseconds(budget)}`)), budget);
      timer.unref?.();
    });
    try {
      return await Promise.race([running, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function nativeControlFrame(operation, command) {
    const keys = NATIVE_CONTROL_KEYS[operation];
    const values = {
      schemaVersion: 1,
      operation,
      guardianInstanceId: command.guardianInstanceId,
      guardianEpoch: command.guardianEpoch,
      attemptId: command.attemptId,
      role: command.role,
    };
    const ordered = {};
    for (const key of keys) ordered[key] = values[key];
    return Buffer.from(`${JSON.stringify(ordered)}\n`, "utf8");
  }

  /**
   * The transition table the Desktop enforces (`DesktopHostBootstrapBroker.cs:268-286`). It is not a
   * courtesy check: a Host that arms twice, launches a role twice, or contains a role it never
   * launched is refused there, and the two peers must not disagree about what the session has done.
   */
  function nextTransition(command) {
    const next = {
      guardianInstanceId: command.guardianInstanceId,
      guardianEpoch: command.guardianEpoch,
      attemptId: command.attemptId,
    };
    if (command.operation === "arm_attempt") {
      if (armed) throw refuse("role_broker_arm_refused:already_armed");
      return next;
    }
    const same =
      correlation !== null &&
      correlation.guardianInstanceId === next.guardianInstanceId &&
      correlation.guardianEpoch === next.guardianEpoch &&
      correlation.attemptId === next.attemptId;
    const family = commandFamily(command.operation);
    if (!armed || !same) throw refuse(`role_broker_${family}_refused:correlation_mismatch`);
    if (command.role === undefined) throw refuse(`role_broker_${family}_refused:role_missing`);
    if (command.operation === "launch_role" && launchedRoles.has(command.role))
      throw refuse(`role_broker_launch_refused:role_already_launched:${command.role}`);
    if (command.operation === "contain_role" && (!launchedRoles.has(command.role) || containedRoles.has(command.role)))
      throw refuse(`role_broker_contain_refused:role_not_containable:${command.role}`);
    return next;
  }

  async function serveCommand(command) {
    let next;
    try {
      next = nextTransition(command);
    } catch (error) {
      destroySocket(error instanceof RoleBrokerRefusal ? error.code : "role_broker_transition_refused");
      return;
    }
    if (command.operation === "arm_attempt") correlation = next;
    let status;
    try {
      status = await relay(command);
    } catch (error) {
      operations.push(Object.freeze({ operation: command.operation, outcome: "refused" }));
      destroySocket(error instanceof RoleBrokerRefusal ? error.code : "role_broker_relay_failed");
      return;
    }
    if (command.operation === "arm_attempt") {
      armed = true;
    } else if (command.operation === "launch_role") {
      launchedRoles.add(command.role);
    } else {
      containedRoles.add(command.role);
    }
    operations.push(Object.freeze({ operation: command.operation, outcome: status }));
    // The acknowledgement's key ORDER is asserted against the Host's own table before it is
    // written: the Host refuses a frame whose keys it cannot read in order, and a refusal here
    // names the broker rather than surfacing as an unexplained session loss there.
    writeHostFrame(
      composeGuardianAck({ operation: command.operation, status, binding: launch, command }),
      command.role === undefined ? CORRELATION_KEYS : ROLE_ACK_KEYS,
    );
  }

  /** One command at a time, in the order the Host wrote them: this wire is a conversation. */
  async function pump() {
    if (inboundBusy) return;
    inboundBusy = true;
    try {
      for (;;) {
        const command = inbound.shift();
        if (command === undefined) return;
        await serveCommand(command);
        if (socketClosed) return;
      }
    } finally {
      inboundBusy = false;
    }
  }

  function acceptFrame(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      destroySocket("role_broker_frame_not_json");
      return;
    }
    if (!helloAccepted) {
      if (!validateGuardianHelloRequest(value, launch)) {
        destroySocket("role_broker_hello_rejected");
        return;
      }
      helloAccepted = true;
      clearTimeout(helloTimeout);
      writeHostFrame(composeGuardianHelloAck(launch), HELLO_ACK_KEYS);
      resolveHello();
      return;
    }
    const command = validateGuardianCommandFrame(value, launch);
    if (command === undefined) {
      destroySocket("role_broker_command_frame_invalid");
      return;
    }
    if (image === null) {
      destroySocket(`role_broker_hello_only_refused:${command.operation}`);
      return;
    }
    inbound.push(command);
    void pump();
  }

  function onSessionData(chunk) {
    sessionBuffer = Buffer.concat([sessionBuffer, chunk]);
    for (;;) {
      const newline = sessionBuffer.indexOf(10);
      if (newline < 0) {
        if (sessionBuffer.length > MAX_FRAME_BYTES) destroySocket("role_broker_frame_oversized");
        return;
      }
      const line = sessionBuffer.subarray(0, newline);
      sessionBuffer = sessionBuffer.subarray(newline + 1);
      if (line.length === 0 || line.includes(0) || line.includes(13)) {
        destroySocket("role_broker_frame_invalid");
        return;
      }
      acceptFrame(line.toString("utf8"));
      if (socketClosed) return;
    }
  }

  return Object.freeze({
    hello,
    facts,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        if (image === null)
          log(
            `role-broker: role_broker_guardian_binary_absent:${String(imagePath ?? "<generation publishes none>")} - serving hello only`,
          );
        server = createServer((candidate) => {
          if (socket !== null || socketClosed) {
            candidate.destroy();
            return;
          }
          socket = candidate;
          socket.on("data", onSessionData);
          socket.on("error", () => undefined);
          socket.on("close", () => {
            if (socket !== candidate) return;
            socket = null;
            socketClosed = true;
            if (!helloAccepted) rejectHello(refuse("role_broker_session_closed_before_hello"));
            endGuardian("session_closed");
          });
        });
        server.once("error", (error) =>
          rejectListen(refuse(`role_broker_pipe_unavailable:${String(error?.code ?? error)}`)),
        );
        helloTimeout = setTimeout(() => rejectHello(refuse("role_broker_hello_timeout")), helloTimeoutMs);
        helloTimeout.unref?.();
        server.listen(endpoint, () => resolveListen());
      }),
    dispose: async () => {
      if (closed) return;
      closed = true;
      clearTimeout(helloTimeout);
      if (socket !== null) {
        socketClosed = true;
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
        socket = null;
      }
      rejectHello(refuse("role_broker_disposed"));
      endGuardian("dispose");
      if (server !== null) {
        const closing = server;
        server = null;
        await new Promise((resolveClose) => closing.close(() => resolveClose()));
      }
    },
  });
}

function writeStream(stream, bytes) {
  return new Promise((resolve, reject) => {
    try {
      stream.write(bytes, (error) => (error == null ? resolve() : reject(refuse("role_broker_write_failed"))));
    } catch {
      reject(refuse("role_broker_write_failed"));
    }
  });
}
