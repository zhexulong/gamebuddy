import { createHash } from "node:crypto";

import type { DeliveryDisposition } from "./event-pump.js";

/**
 * Ephemeral, content-free evidence emitted only by the production Game child
 * while it is parented by the one-launch Preview supervisor. It is not a game
 * fact, runtime capability, manifest field, or persistent audit record.
 */
export const LIVE_SOURCE_ATTESTATION_SCHEMA = "gamebuddy-production-live-source-attestation/v1" as const;

export type LiveSourceAttestationKind =
  | "native_player_input_observed"
  | "native_stop_all_observed"
  | "pi_turn_accepted"
  | "pi_turn_settled"
  | "stop_sealed"
  | "stop_settled"
  | "stop_uncertain"
  | "old_epoch_quiet"
  | "body_settled";

export type LiveSourceAttestation = Readonly<{
  schema: typeof LIVE_SOURCE_ATTESTATION_SCHEMA;
  protocolVersion: 1;
  evidenceClass: "production_live_source_attestation";
  launchBindingSha256: string;
  runtimeInstanceSha256: string;
  kind: LiveSourceAttestationKind;
  sourceEventSha256: string;
  batchIdSha256: string | null;
  stopIdSha256: string | null;
  epoch: number | null;
  disposition: Exclude<DeliveryDisposition, "hold"> | null;
  observationRevision: number | null;
}>;

export interface CompanionLiveSourceEvidenceSink {
  /** Only the authenticated Stardew Mod bridge path may emit these ingress facts. */
  nativePlayerInputObserved(input: Readonly<{ sourceEventId: string }>): void;
  nativeStopAllObserved(input: Readonly<{ stopId: string; sourceEventId: string }>): void;
  piTurnAccepted(
    input: Readonly<{ batchId: string; sourceEventId: string; disposition: Exclude<DeliveryDisposition, "hold"> }>,
  ): void;
  piTurnSettled(
    input: Readonly<{ batchId: string; sourceEventId: string; disposition: Exclude<DeliveryDisposition, "hold"> }>,
  ): void;
  stopSealed(input: Readonly<{ stopId: string; sourceEventId: string; batchId: string | null; epoch: number }>): void;
  stopSettled(input: Readonly<{ stopId: string; sourceEventId: string; batchId: string | null; epoch: number }>): void;
  stopUncertain(
    input: Readonly<{ stopId: string; sourceEventId: string; batchId: string | null; epoch: number }>,
  ): void;
  oldEpochQuiet(
    input: Readonly<{
      stopId: string;
      sourceEventId: string;
      batchId: string | null;
      epoch: number;
      observationRevision: number;
    }>,
  ): void;
  bodySettled(
    input: Readonly<{
      stopId: string;
      sourceEventId: string;
      batchId: string | null;
      epoch: number;
      observationRevision: number;
    }>,
  ): void;
}

export type LiveSourceAttester = CompanionLiveSourceEvidenceSink &
  Readonly<{
    activate(runtimeInstanceId: string): void;
  }>;

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The caller supplies only the already-private direct-child sender. Raw pipe,
 * token, player text, prompts, receipts, and paths are never emitted.
 */
export function createLiveSourceAttester(
  input: Readonly<{
    launchBindingSha256: string;
    send: (
      message: Readonly<{ schema: typeof LIVE_SOURCE_ATTESTATION_SCHEMA; evidence: LiveSourceAttestation }>,
    ) => boolean;
  }>,
): LiveSourceAttester {
  if (!SHA256.test(input.launchBindingSha256) || typeof input.send !== "function")
    throw new Error("invalid_live_source_attester_input");

  let runtimeInstanceId: string | undefined;
  const activate = (value: string): void => {
    if (runtimeInstanceId !== undefined || !IDENTIFIER.test(value))
      throw new Error("invalid_live_source_attester_activation");
    runtimeInstanceId = value;
  };
  const emit = (
    kind: LiveSourceAttestationKind,
    sourceEventId: string,
    batchId: string | null,
    stopId: string | null,
    epoch: number | null,
    disposition: Exclude<DeliveryDisposition, "hold"> | null,
    observationRevision: number | null = null,
  ): void => {
    // Launch-owned initial facts may be consumed before the post-commit
    // current-user pipe has minted its runtime identity. They are outside the
    // control-supervisor proof and must neither be retroactively attributed
    // nor turn a healthy runtime into a retry loop.
    if (runtimeInstanceId === undefined) return;
    if (
      !IDENTIFIER.test(sourceEventId) ||
      (batchId !== null && !IDENTIFIER.test(batchId)) ||
      (stopId !== null && !IDENTIFIER.test(stopId)) ||
      (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0))
    )
      throw new Error("live_source_attestation_unavailable");
    const evidence = Object.freeze({
      schema: LIVE_SOURCE_ATTESTATION_SCHEMA,
      protocolVersion: 1 as const,
      evidenceClass: "production_live_source_attestation" as const,
      launchBindingSha256: input.launchBindingSha256,
      runtimeInstanceSha256: digest(runtimeInstanceId),
      kind,
      sourceEventSha256: digest(sourceEventId),
      batchIdSha256: batchId === null ? null : digest(batchId),
      stopIdSha256: stopId === null ? null : digest(stopId),
      epoch,
      disposition,
      observationRevision,
    });
    if (!input.send(Object.freeze({ schema: LIVE_SOURCE_ATTESTATION_SCHEMA, evidence })))
      throw new Error("live_source_attestation_delivery_unavailable");
  };

  return Object.freeze({
    activate,
    nativePlayerInputObserved: (value: Readonly<{ sourceEventId: string }>) =>
      emit("native_player_input_observed", value.sourceEventId, null, null, null, null),
    nativeStopAllObserved: (value: Readonly<{ stopId: string; sourceEventId: string }>) =>
      emit("native_stop_all_observed", value.sourceEventId, null, value.stopId, null, null),
    piTurnAccepted: (
      value: Readonly<{ batchId: string; sourceEventId: string; disposition: Exclude<DeliveryDisposition, "hold"> }>,
    ) => emit("pi_turn_accepted", value.sourceEventId, value.batchId, null, null, value.disposition),
    piTurnSettled: (
      value: Readonly<{ batchId: string; sourceEventId: string; disposition: Exclude<DeliveryDisposition, "hold"> }>,
    ) => emit("pi_turn_settled", value.sourceEventId, value.batchId, null, null, value.disposition),
    stopSealed: (value: Readonly<{ stopId: string; sourceEventId: string; batchId: string | null; epoch: number }>) =>
      emit("stop_sealed", value.sourceEventId, value.batchId, value.stopId, value.epoch, null),
    stopSettled: (value: Readonly<{ stopId: string; sourceEventId: string; batchId: string | null; epoch: number }>) =>
      emit("stop_settled", value.sourceEventId, value.batchId, value.stopId, value.epoch, null),
    stopUncertain: (
      value: Readonly<{ stopId: string; sourceEventId: string; batchId: string | null; epoch: number }>,
    ) => emit("stop_uncertain", value.sourceEventId, value.batchId, value.stopId, value.epoch, null),
    oldEpochQuiet: (
      value: Readonly<{
        stopId: string;
        sourceEventId: string;
        batchId: string | null;
        epoch: number;
        observationRevision: number;
      }>,
    ) =>
      emit(
        "old_epoch_quiet",
        value.sourceEventId,
        value.batchId,
        value.stopId,
        value.epoch,
        null,
        value.observationRevision,
      ),
    bodySettled: (
      value: Readonly<{
        stopId: string;
        sourceEventId: string;
        batchId: string | null;
        epoch: number;
        observationRevision: number;
      }>,
    ) =>
      emit(
        "body_settled",
        value.sourceEventId,
        value.batchId,
        value.stopId,
        value.epoch,
        null,
        value.observationRevision,
      ),
  });
}

/** Strict parser used by direct tests and any future in-process verifier. */
export function parseLiveSourceAttestation(value: unknown): LiveSourceAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("invalid_live_source_attestation");
  const record = value as Record<string, unknown>;
  const keys = [
    "batchIdSha256",
    "disposition",
    "epoch",
    "evidenceClass",
    "kind",
    "launchBindingSha256",
    "observationRevision",
    "protocolVersion",
    "runtimeInstanceSha256",
    "schema",
    "sourceEventSha256",
    "stopIdSha256",
  ];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new Error("invalid_live_source_attestation");
  if (
    record.schema !== LIVE_SOURCE_ATTESTATION_SCHEMA ||
    record.protocolVersion !== 1 ||
    record.evidenceClass !== "production_live_source_attestation" ||
    typeof record.launchBindingSha256 !== "string" ||
    !SHA256.test(record.launchBindingSha256) ||
    typeof record.runtimeInstanceSha256 !== "string" ||
    !SHA256.test(record.runtimeInstanceSha256) ||
    typeof record.sourceEventSha256 !== "string" ||
    !SHA256.test(record.sourceEventSha256) ||
    typeof record.kind !== "string" ||
    ![
      "native_player_input_observed",
      "native_stop_all_observed",
      "pi_turn_accepted",
      "pi_turn_settled",
      "stop_sealed",
      "stop_settled",
      "stop_uncertain",
      "old_epoch_quiet",
      "body_settled",
    ].includes(record.kind)
  )
    throw new Error("invalid_live_source_attestation");
  const batchIdSha256 = record.batchIdSha256;
  const stopIdSha256 = record.stopIdSha256;
  const epoch = record.epoch;
  const disposition = record.disposition;
  const observationRevision = record.observationRevision;
  const observation = record.kind === "old_epoch_quiet" || record.kind === "body_settled";
  const pi = record.kind === "pi_turn_accepted" || record.kind === "pi_turn_settled";
  const nativeInput = record.kind === "native_player_input_observed";
  const nativeStop = record.kind === "native_stop_all_observed";
  const stop = !pi && !nativeInput && !nativeStop;
  if (
    (batchIdSha256 !== null && (typeof batchIdSha256 !== "string" || !SHA256.test(batchIdSha256))) ||
    (stopIdSha256 !== null && (typeof stopIdSha256 !== "string" || !SHA256.test(stopIdSha256))) ||
    (epoch !== null && (!Number.isSafeInteger(epoch) || (epoch as number) < 0)) ||
    (disposition !== null && disposition !== "steer" && disposition !== "follow_up") ||
    (observationRevision !== null &&
      (!Number.isSafeInteger(observationRevision) || (observationRevision as number) < 0)) ||
    (observation &&
      (stopIdSha256 === null || epoch === null || disposition !== null || observationRevision === null)) ||
    (!observation && observationRevision !== null) ||
    (pi && (batchIdSha256 === null || stopIdSha256 !== null || epoch !== null || disposition === null)) ||
    (nativeInput && (batchIdSha256 !== null || stopIdSha256 !== null || epoch !== null || disposition !== null)) ||
    (nativeStop && (batchIdSha256 !== null || stopIdSha256 === null || epoch !== null || disposition !== null)) ||
    (stop && (stopIdSha256 === null || epoch === null || disposition !== null))
  )
    throw new Error("invalid_live_source_attestation");
  return Object.freeze(record as unknown as LiveSourceAttestation);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
