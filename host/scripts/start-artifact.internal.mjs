import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createProductionChildEnvironment } from "./production-control-launch.mjs";

export async function startArtifact({ resolveEntry, recheckEntry }) {
  if (typeof resolveEntry !== "function" || typeof recheckEntry !== "function") throw new Error("artifact_launcher_resolver_required");
  const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [entry, ...requestedArgs] = process.argv.slice(2);
if (!entry) throw new Error("production_entry_required");
const requireActiveStopProof = requestedArgs[0] === "--require-active-stop-proof";
const configArgs = requireActiveStopProof ? requestedArgs.slice(1) : requestedArgs;
if (requireActiveStopProof && entry !== "farmhand-companion-preview.js")
  throw new Error("active_stop_proof_entry_invalid");
const activeStopProofBinding = requireActiveStopProof ? randomBytes(32).toString("hex") : undefined;
const activeStopProof = activeStopProofBinding === undefined
  ? undefined
  : (await import("./active-stop-proof.mjs")).createActiveStopProofVerifier(activeStopProofBinding);
// The first argument is exclusively the reviewed entry root. Every remaining
// argument is passed unchanged to that entrypoint's own configuration parser.
const selected = await resolveEntry({ hostRoot, outputRoot: resolve(hostRoot, "dist"), entry });
// Pin the immutable generation selected from verified current. Recheck its
// inventory immediately before spawn; a later publisher may advance current
// but cannot alter the selected generation through this protocol.
await recheckEntry({ hostRoot, selected });

// This launcher never offers an environment-selected parent-control handoff.
// It owns the fresh credentials injected into its direct Game child only.
if (process.env.GAMEBUDDY_D0_BOOTSTRAP_TEST !== undefined || process.env.GAMEBUDDY_LIVE_SUPERVISOR !== undefined)
  throw new Error("production_launcher_control_handoff_selector_forbidden");
const child = spawn(process.execPath, [selected.entryPath, ...configArgs], {
  // The wrapper owns the external stdout surface. In proof mode the child may
  // never forge the fixed receipt merely by printing its spelling; stdout is
  // forwarded below with that exact child-originated line removed.
  stdio: ["inherit", "pipe", "pipe", "ipc"],
  env: createProductionChildEnvironment(entry, process.env, undefined, undefined, activeStopProofBinding),
});
const ACTIVE_STOP_PROOF_RECEIPT = "active_stop_proof_verified";
const GAME_TASK_INGRESS_SCHEMA = "gamebuddy-production-game-task-ingress/v1";
const GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA = "gamebuddy-game-operational-gate-evidence/v2";
let task9Mode = false;
let childReady = false;
let parentReadyRelayed = false;
let taskForwarded = false;
let terminalEvidenceRelayed = false;
let task9Ready;

function forwardChildStdout(stream) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      // Match an entire physical line, accepting CRLF from the child, so
      // chunk boundaries and decorated output cannot create a wrapper receipt.
      if (line.replace(/\r$/, "") !== ACTIVE_STOP_PROOF_RECEIPT) process.stdout.write(`${line}\n`);
    }
  });
  stream.once("end", () => {
    if (pending !== "" && pending.replace(/\r$/, "") !== ACTIVE_STOP_PROOF_RECEIPT) process.stdout.write(pending);
  });
}
forwardChildStdout(child.stdout);
child.stderr.pipe(process.stderr);

// This grammar intentionally matches parseLiveSourceAttestation exactly. The
// launcher is executable JavaScript while the in-process parser is TypeScript;
// both accept only JSON wire primitives and the same nullable shape per kind.
function isLiveSourceEvidenceEnvelope(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || Object.getPrototypeOf(message) !== Object.prototype || Object.keys(message).sort().join(",") !== "evidence,schema" || message.schema !== "gamebuddy-production-live-source-attestation/v1") return false;
  const evidence = message.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.getPrototypeOf(evidence) !== Object.prototype) return false;
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const keys = "batchIdSha256,disposition,epoch,evidenceClass,kind,launchBindingSha256,observationRevision,protocolVersion,runtimeInstanceSha256,schema,sourceEventSha256,stopIdSha256";
  if (Object.keys(evidence).sort().join(",") !== keys || evidence.schema !== "gamebuddy-production-live-source-attestation/v1" || evidence.protocolVersion !== 1 || evidence.evidenceClass !== "production_live_source_attestation" || !sha(evidence.launchBindingSha256) || !sha(evidence.runtimeInstanceSha256) || !sha(evidence.sourceEventSha256)) return false;
  const pi = evidence.kind === "pi_turn_accepted" || evidence.kind === "pi_turn_settled";
  const nativeInput = evidence.kind === "native_player_input_observed";
  const nativeStop = evidence.kind === "native_stop_all_observed";
  const observation = evidence.kind === "old_epoch_quiet" || evidence.kind === "body_settled";
  const stop = evidence.kind === "stop_sealed" || evidence.kind === "stop_settled" || evidence.kind === "stop_uncertain";
  if (!pi && !nativeInput && !nativeStop && !observation && !stop) return false;
  if ((evidence.batchIdSha256 !== null && !sha(evidence.batchIdSha256)) || (evidence.stopIdSha256 !== null && !sha(evidence.stopIdSha256)) || (evidence.epoch !== null && (!Number.isSafeInteger(evidence.epoch) || evidence.epoch < 0)) || (evidence.disposition !== null && evidence.disposition !== "steer" && evidence.disposition !== "follow_up") || (evidence.observationRevision !== null && (!Number.isSafeInteger(evidence.observationRevision) || evidence.observationRevision < 0))) return false;
  if (pi) return sha(evidence.batchIdSha256) && evidence.stopIdSha256 === null && evidence.epoch === null && (evidence.disposition === "steer" || evidence.disposition === "follow_up") && evidence.observationRevision === null;
  if (nativeInput) return evidence.batchIdSha256 === null && evidence.stopIdSha256 === null && evidence.epoch === null && evidence.disposition === null && evidence.observationRevision === null;
  if (nativeStop) return evidence.batchIdSha256 === null && sha(evidence.stopIdSha256) && evidence.epoch === null && evidence.disposition === null && evidence.observationRevision === null;
  if (observation) return (evidence.batchIdSha256 === null || sha(evidence.batchIdSha256)) && sha(evidence.stopIdSha256) && Number.isSafeInteger(evidence.epoch) && evidence.epoch >= 0 && evidence.disposition === null && Number.isSafeInteger(evidence.observationRevision) && evidence.observationRevision >= 0;
  return (evidence.batchIdSha256 === null || sha(evidence.batchIdSha256)) && sha(evidence.stopIdSha256) && Number.isSafeInteger(evidence.epoch) && evidence.epoch >= 0 && evidence.disposition === null && evidence.observationRevision === null;
}

let stopping = false;
let proofVerified = false;
let forcedStopTimer;
function stopChild(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  forcedStopTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  forcedStopTimer.unref();
}
process.on("message", (message) => {
  const dispatch = parseGameTaskDispatch(message);
  const taskSchemaMessage = message?.schema === GAME_TASK_INGRESS_SCHEMA || dispatch !== null;
  if (taskSchemaMessage) {
    if (
      !task9Mode ||
      !childReady ||
      !parentReadyRelayed ||
      taskForwarded ||
      dispatch === null ||
      !sameTaskCorrelation(dispatch, true)
    ) {
      failProtocol();
      return;
    }
    taskForwarded = true;
    if (!child.connected) {
      failProtocol();
      return;
    }
    try {
      if (!child.send(dispatch, undefined, undefined, (error) => {
        if (error) failProtocol();
      })) failProtocol();
    } catch {
      failProtocol();
    }
    return;
  }
  // Non-Task 9 entries retain ordinary IPC relay semantics until a child
  // publishes the exact Task 9 ready record. Once pinned, no generic message
  // may cross this launch boundary.
  if (task9Mode) {
    failProtocol();
    return;
  }
  if (!child.connected) {
    failProtocol();
    return;
  }
  try {
    if (!child.send(message, undefined, undefined, (error) => {
      if (error) failProtocol();
    })) failProtocol();
  } catch {
    failProtocol();
  }
});

child.on("message", (message, sendHandle) => {
  const ready = parseGameTaskReady(message);
  if (ready !== null) {
    if (task9Mode || childReady || taskForwarded || !child.connected) {
      failProtocol();
      return;
    }
    task9Mode = true;
    childReady = true;
    task9Ready = ready;
    if (process.connected !== true) {
      failProtocol();
      return;
    }
    try {
      if (!process.send(ready, undefined, undefined, (error) => {
        if (error) {
          failProtocol();
        } else {
          parentReadyRelayed = true;
        }
      })) failProtocol();
    } catch {
      failProtocol();
    }
    return;
  }
  if (message?.schema === GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA) {
    const evidence = parseGameOperationalGateEvidence(message);
    if (
      !task9Mode ||
      !taskForwarded ||
      terminalEvidenceRelayed ||
      evidence === null ||
      !sameTaskCorrelation(evidence, false)
    ) {
      failProtocol();
      return;
    }
    terminalEvidenceRelayed = true;
    if (process.connected !== true) {
      failProtocol();
      return;
    }
    try {
      if (!process.send(evidence, undefined, undefined, (error) => {
        if (error) failProtocol();
      })) failProtocol();
    } catch {
      failProtocol();
    }
    return;
  }
  if (message?.schema === GAME_TASK_INGRESS_SCHEMA) {
    failProtocol();
    return;
  }
  if (message?.schema === "gamebuddy-production-live-source-attestation/v1") {
    if (!isLiveSourceEvidenceEnvelope(message)) {
      process.exitCode = 1;
      stopChild("SIGTERM");
      return;
    }
    // Once the bounded proof reaches its terminal success state, keep the
    // Preview session alive. `/stop` cancels the active Pi turn, not the
    // Host/Preview/game process tree; subsequent well-formed evidence belongs
    // to later turns and must not be interpreted as a replay of this proof.
    if (!proofVerified && activeStopProof !== undefined && !activeStopProof.accept(message.evidence)) {
      process.exitCode = 1;
      stopChild("SIGTERM");
      return;
    }
    if (activeStopProof?.result() === true && !proofVerified) {
      proofVerified = true;
      process.stdout.write(`${ACTIVE_STOP_PROOF_RECEIPT}\n`);
    }
    if (process.connected === true) process.send(message);
    return;
  }
  if (task9Mode) {
    failProtocol();
    return;
  }
  if (process.connected === true) process.send(message, sendHandle);
});

function parseGameTaskReady(value) {
  if (!exactKeys(value, ["gameSessionId", "kind", "nonceSha256", "piSessionId", "schema", "surface"]) || value.schema !== GAME_TASK_INGRESS_SCHEMA || value.kind !== "ready" || value.surface !== "game" || !identifier(value.gameSessionId) || !identifier(value.piSessionId) || !sha256(value.nonceSha256)) return null;
  return Object.freeze({ schema: GAME_TASK_INGRESS_SCHEMA, kind: "ready", surface: "game", nonceSha256: value.nonceSha256, gameSessionId: value.gameSessionId, piSessionId: value.piSessionId });
}
function parseGameTaskDispatch(value) {
  if (!exactKeys(value, ["gameSessionId", "kind", "nonceSha256", "piSessionId", "schema", "surface", "task"]) || value.schema !== GAME_TASK_INGRESS_SCHEMA || value.kind !== "dispatch_task" || value.surface !== "game" || !identifier(value.gameSessionId) || !identifier(value.piSessionId) || !sha256(value.nonceSha256) || !canonicalTask(value.task)) return null;
  return Object.freeze({ schema: GAME_TASK_INGRESS_SCHEMA, kind: "dispatch_task", surface: "game", nonceSha256: value.nonceSha256, gameSessionId: value.gameSessionId, piSessionId: value.piSessionId, task: value.task });
}
function parseGameOperationalGateEvidence(value) {
  if (
    !exactKeys(value, ["capabilityCount", "capabilityRevision", "nonceSha256", "piSessionId", "schema", "stopSettled", "surface", "terminalState", "transitions"]) ||
    value.schema !== GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA ||
    !sha256(value.nonceSha256) ||
    !identifier(value.piSessionId) ||
    value.surface !== "game" ||
    !revision(value.capabilityRevision) ||
    !count(value.capabilityCount) ||
    value.terminalState !== "completed" ||
    value.stopSettled !== true ||
    !exactKeys(value.transitions, ["allPostconditionsObserved", "count", "distinctActionCount", "freshObservationCount"]) ||
    value.transitions.count !== 2 ||
    value.transitions.distinctActionCount !== 2 ||
    value.transitions.freshObservationCount !== 2 ||
    value.transitions.allPostconditionsObserved !== true
  ) return null;
  return Object.freeze({
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    nonceSha256: value.nonceSha256,
    piSessionId: value.piSessionId,
    surface: "game",
    capabilityRevision: value.capabilityRevision,
    capabilityCount: value.capabilityCount,
    transitions: Object.freeze({
      count: 2,
      distinctActionCount: 2,
      freshObservationCount: 2,
      allPostconditionsObserved: true,
    }),
    terminalState: "completed",
    stopSettled: true,
  });
}
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 512; }
function sameTaskCorrelation(value, requireGameSession) {
  return task9Ready !== undefined &&
    value.nonceSha256 === task9Ready.nonceSha256 &&
    value.piSessionId === task9Ready.piSessionId &&
    (!requireGameSession || value.gameSessionId === task9Ready.gameSessionId);
}
function failProtocol() {
  process.exitCode = 1;
  stopChild("SIGTERM");
}
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).sort().join(",") === [...keys].sort().join(",");
}
function sha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function canonicalTask(value) {
  if (typeof value !== "string") return false;
  let scalarValues = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
    scalarValues += 1;
    if (scalarValues > 2_000) return false;
  }
  return scalarValues >= 1;
}
child.once("error", () => process.exit(1));
child.once("exit", (code, signal) => {
  if (forcedStopTimer !== undefined) clearTimeout(forcedStopTimer);
  if (activeStopProof !== undefined) {
    process.exitCode = 1;
    process.stderr.write(proofVerified ? "preview_exited_after_active_stop_proof\n" : "preview_active_stop_proof_unverified\n");
    return;
  }
  process.exit(code ?? (signal ? 1 : 0));
});
process.once("SIGINT", () => stopChild("SIGINT"));
process.once("SIGTERM", () => stopChild("SIGTERM"));
process.once("disconnect", () => stopChild("SIGTERM"));

}
