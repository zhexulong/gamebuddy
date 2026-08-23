export const COMPANION_LIVE_EVIDENCE_SCHEMA = "gamebuddy-stardew-companion-live-evidence/v1";

import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const _ID = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = new Set([
  "native_player_input_observed",
  "native_stop_all_observed",
  "pi_turn_accepted",
  "pi_turn_settled",
  "stop_sealed",
  "stop_settled",
  "stop_uncertain",
  "old_epoch_quiet",
  "body_settled",
]);

export class CompanionLiveEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new CompanionLiveEvidenceError(code);
};

/**
 * Parses deterministic/redacted evidence for fixture analysis only. Its
 * append-chain digest is integrity metadata, not an origin credential.
 * Production admission must not treat this caller-supplied JSONL as evidence.
 */
export function parseCompanionLiveEvidenceArtifact(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 1_000_000)
    fail("live_evidence_artifact_unavailable");
  const records = text
    .trimEnd()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        fail("live_evidence_artifact_invalid");
      }
    });
  if (records.length === 0) fail("live_evidence_artifact_unavailable");
  const parsed = records.map(parseRecord);
  const identity = parsed[0].identity;
  if (parsed.some((record) => JSON.stringify(record.identity) !== JSON.stringify(identity)))
    fail("live_evidence_identity_drift");
  for (let index = 1; index < parsed.length; index += 1)
    if (
      parsed[index].sequence !== parsed[index - 1].sequence + 1 ||
      parsed[index].previousSha256 !== parsed[index - 1].recordSha256
    )
      fail("live_evidence_append_chain_invalid");
  return Object.freeze({ identity, records: Object.freeze(parsed) });
}

function parseRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "event,identity,previousSha256,recordSha256,schema,sequence"
  )
    fail("live_evidence_artifact_invalid");
  const { schema, sequence, identity, event, previousSha256, recordSha256 } = value;
  if (
    schema !== COMPANION_LIVE_EVIDENCE_SCHEMA ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !SHA256.test(previousSha256) ||
    !SHA256.test(recordSha256)
  )
    fail("live_evidence_artifact_invalid");
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(",") !== "manifestSha256,runtimeInstanceSha256,topology"
  )
    fail("live_evidence_artifact_invalid");
  if (
    identity.topology !== "native_ai_farmhand_multiplayer" ||
    !SHA256.test(identity.manifestSha256) ||
    !SHA256.test(identity.runtimeInstanceSha256)
  )
    fail("live_evidence_artifact_invalid");
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    Object.keys(event).sort().join(",") !==
      "batchIdSha256,disposition,epoch,kind,observationRevision,sourceEventSha256,stopIdSha256"
  )
    fail("live_evidence_artifact_invalid");
  const observation = event.kind === "old_epoch_quiet" || event.kind === "body_settled";
  if (
    !KINDS.has(event.kind) ||
    !SHA256.test(event.sourceEventSha256) ||
    (event.batchIdSha256 !== null && !SHA256.test(event.batchIdSha256)) ||
    (event.stopIdSha256 !== null && !SHA256.test(event.stopIdSha256)) ||
    (event.epoch !== null && (!Number.isSafeInteger(event.epoch) || event.epoch < 0)) ||
    (event.disposition !== null && !["steer", "follow_up"].includes(event.disposition)) ||
    (observation
      ? !Number.isSafeInteger(event.observationRevision) ||
        event.observationRevision < 0 ||
        event.stopIdSha256 === null ||
        event.epoch === null ||
        event.disposition !== null
      : event.observationRevision !== null)
  )
    fail("live_evidence_artifact_invalid");
  const unsigned = { schema, sequence, identity, event, previousSha256 };
  if (digest(unsigned) !== recordSha256) fail("live_evidence_record_digest_invalid");
  return Object.freeze({ ...unsigned, recordSha256 });
}

/**
 * Production admission has no receipt verifier or Host-owned evidence channel
 * in this tool boundary. A JSONL file, even with a valid append chain, is
 * hand-authorable and therefore can never establish production readiness.
 */
export function gateProductionCompanionLiveEvidence(_input) {
  return Object.freeze({
    state: "blocked",
    reasonCodes: Object.freeze(["companion_live_receipt_evidence_unavailable"]),
  });
}

export function evaluateCompanionLiveEvidence(artifact) {
  const { identity, records } = artifact;
  const bySource = new Map();
  for (const record of records) {
    const values = bySource.get(record.event.sourceEventSha256) ?? [];
    values.push(record.event);
    bySource.set(record.event.sourceEventSha256, values);
  }
  const failures = [];
  let nativeInputScenarioObserved = false;
  let nativeStopScenarioObserved = false;
  for (const events of bySource.values()) {
    const input = events.filter((event) => event.kind === "native_player_input_observed");
    if (input.length) nativeInputScenarioObserved = true;
    const piAccepted = events.filter((event) => event.kind === "pi_turn_accepted" && event.disposition === "steer");
    const piSettled = events.filter((event) => event.kind === "pi_turn_settled" && event.disposition === "steer");
    if (
      input.length &&
      (piAccepted.length !== 1 || piSettled.length !== 1 || piAccepted[0].batchIdSha256 !== piSettled[0].batchIdSha256)
    )
      failures.push("native_player_input_pi_lineage_missing");
    const nativeStop = events.filter((event) => event.kind === "native_stop_all_observed");
    if (nativeStop.length) {
      nativeStopScenarioObserved = true;
      const stop = nativeStop[0].stopIdSha256;
      const sealed = events.filter((event) => event.kind === "stop_sealed" && event.stopIdSha256 === stop);
      const settled = events.filter((event) => event.kind === "stop_settled" && event.stopIdSha256 === stop);
      const quiet = events.filter((event) => event.kind === "old_epoch_quiet");
      const body = events.filter((event) => event.kind === "body_settled");
      if (sealed.length !== 1 || settled.length !== 1 || sealed[0].epoch !== settled[0].epoch)
        failures.push("native_stop_epoch_lineage_missing");
      const observationMatchesStop = (event) =>
        event.stopIdSha256 === stop && event.epoch === settled[0]?.epoch && event.observationRevision !== null;
      if (quiet.length !== 1 || !observationMatchesStop(quiet[0])) failures.push("native_stop_old_epoch_quiet_missing");
      if (body.length !== 1 || !observationMatchesStop(body[0]))
        failures.push("production_live_body_settle_evidence_unavailable");
      if (quiet[0] && body[0] && quiet[0].observationRevision !== body[0].observationRevision)
        failures.push("native_stop_observation_revision_mismatch");
    }
  }
  if (!nativeInputScenarioObserved) failures.push("native_player_input_scenario_missing");
  if (!nativeStopScenarioObserved) failures.push("native_stop_scenario_missing");
  return Object.freeze({
    state: failures.length ? "blocked" : "ready",
    identity,
    reasonCodes: Object.freeze([...new Set(failures)]),
  });
}
function digest(value) {
  // This deterministic digest exists only to parse fixture-chain metadata; it
  // is explicitly not a signature, receipt, or production attestation.
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
export function sealCompanionLiveEvidenceRecord(unsigned) {
  return Object.freeze({ ...unsigned, recordSha256: digest(unsigned) });
}
