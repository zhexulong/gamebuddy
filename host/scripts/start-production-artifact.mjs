import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { recheckProductionEntry, resolveProductionEntry } from "./production-artifact.mjs";
import { createProductionChildEnvironment } from "./production-control-launch.mjs";
import { randomBytes } from "node:crypto";

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
const selected = await resolveProductionEntry({ hostRoot, outputRoot: resolve(hostRoot, "dist"), entry });
// Pin the immutable generation selected from verified current. Recheck its
// inventory immediately before spawn; a later publisher may advance current
// but cannot alter the selected generation through this protocol.
await recheckProductionEntry({ hostRoot, selected });

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
child.on("message", (message, sendHandle) => {
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
  if (process.connected === true) process.send(message, sendHandle);
});
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
