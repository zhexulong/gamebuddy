import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import type { LiveSourceAttestation } from "./companion-live-source-attestation.js";

const SCHEMA = "gamebuddy-stardew-companion-live-evidence/v1";
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Opt-in production observer. It records only hashed source/receipt-adjacent
 * lifecycle facts emitted by the already-authenticated Host path; it neither
 * accepts commands nor changes game, Pi, bridge, or presentation behaviour.
 */
export function createCompanionLiveEvidenceArtifact(path: string | undefined, manifestSha256: string | undefined) {
  if (path === undefined && manifestSha256 === undefined) return undefined;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof manifestSha256 !== "string" ||
    !SHA256.test(manifestSha256)
  )
    throw new Error("companion_live_evidence_artifact_configuration_invalid");
  let sequence = -1;
  let previousSha256 = "0".repeat(64);
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const last = JSON.parse(lines.at(-1)!) as { sequence?: unknown; recordSha256?: unknown };
      if (!Number.isSafeInteger(last.sequence) || !SHA256.test(String(last.recordSha256)))
        throw new Error("companion_live_evidence_artifact_invalid");
      sequence = last.sequence as number;
      previousSha256 = last.recordSha256 as string;
    }
  }
  return Object.freeze({
    append(evidence: LiveSourceAttestation): void {
      const event = Object.freeze({
        kind: evidence.kind,
        sourceEventSha256: evidence.sourceEventSha256,
        batchIdSha256: evidence.batchIdSha256,
        stopIdSha256: evidence.stopIdSha256,
        epoch: evidence.epoch,
        disposition: evidence.disposition,
        observationRevision: evidence.observationRevision,
      });
      const unsigned = Object.freeze({
        schema: SCHEMA,
        sequence: sequence + 1,
        identity: Object.freeze({
          topology: "native_ai_farmhand_multiplayer",
          manifestSha256,
          runtimeInstanceSha256: evidence.runtimeInstanceSha256,
        }),
        event,
        previousSha256,
      });
      const record = Object.freeze({ ...unsigned, recordSha256: digest(unsigned) });
      appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
      sequence = record.sequence;
      previousSha256 = record.recordSha256;
    },
  });
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
