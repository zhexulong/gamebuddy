import type { WorldFact } from "./event-pump.js";
import type { IntegrationEventSource } from "./integration-launcher.js";
import type {
  GameIntegrationAdapter,
  IntegrationExecutionReceipt,
  IntegrationStateView,
} from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";

/** Strict, content-free source-owned IPC contract for the operational Game gate. */
export const GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA = "gamebuddy-game-operational-gate-evidence/v2";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export type GameOperationalGateEvidence = Readonly<{
  schema: typeof GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA;
  nonceSha256: string;
  piSessionId: string;
  surface: "game";
  capabilityRevision: number;
  capabilityCount: number;
  transitions: Readonly<{
    count: 2;
    distinctActionCount: number;
    freshObservationCount: 2;
    allPostconditionsObserved: true;
  }>;
  terminalState: "completed";
  stopSettled: true;
}>;

/** A read-only observer of the existing Host STOP settlement authority. */
export type GameStopSettlementSource = Readonly<{
  onStopSettled(listener: (payload: unknown) => void): () => void;
}>;

export type GameOperationalGateEvidenceProjection = Readonly<{
  /** Resolves once two exact Mod transitions and an existing STOP settlement are observed. */
  next(): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>;
  close(): void;
}>;

type AcceptedTransition = Readonly<{
  lineage: string;
  actionId: string;
  receiptRevision: number;
  capabilityRevision: number;
}>;

/**
 * Validates a deliberately small IPC payload. No source may extend it with
 * receipt evidence, IDs, paths, prompt text, credentials, or other content
 * without a new reviewed schema revision.
 */
export function validateGameOperationalGateEvidence(value: unknown): GameOperationalGateEvidence | null {
  if (
    !exactRecord(value, [
      "schema",
      "nonceSha256",
      "piSessionId",
      "surface",
      "capabilityRevision",
      "capabilityCount",
      "transitions",
      "terminalState",
      "stopSettled",
    ])
  )
    return null;
  if (
    value.schema !== GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA ||
    !sha256(value.nonceSha256) ||
    !identifier(value.piSessionId) ||
    value.surface !== "game" ||
    !revision(value.capabilityRevision) ||
    !count(value.capabilityCount) ||
    !exactRecord(value.transitions, [
      "count",
      "distinctActionCount",
      "freshObservationCount",
      "allPostconditionsObserved",
    ]) ||
    value.transitions.count !== 2 ||
    !distinctActionCount(value.transitions.distinctActionCount) ||
    value.transitions.freshObservationCount !== 2 ||
    value.transitions.allPostconditionsObserved !== true ||
    value.terminalState !== "completed" ||
    value.stopSettled !== true
  )
    return null;
  return Object.freeze({
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    nonceSha256: value.nonceSha256,
    piSessionId: value.piSessionId,
    surface: "game",
    capabilityRevision: value.capabilityRevision,
    capabilityCount: value.capabilityCount,
    transitions: Object.freeze({
      count: 2 as const,
      distinctActionCount: value.transitions.distinctActionCount,
      freshObservationCount: 2 as const,
      allPostconditionsObserved: true as const,
    }),
    terminalState: "completed" as const,
    stopSettled: true as const,
  });
}

/**
 * Construction-owned reduction of the real GameConnection, launch facts,
 * and existing Host STOP settlement. It observes no model output and never
 * exposes receipt evidence or private correlation identity. It can only emit
 * after two distinct, exact Mod-success transitions have fresh postconditions
 * and a subsequently observed existing STOP settlement.
 */
export function createGameOperationalGateEvidenceProjection(
  module: GameIntegrationAdapter,
  connection: GameConnection,
  events: IntegrationEventSource,
  stopSource?: GameStopSettlementSource,
): GameOperationalGateEvidenceProjection {
  let closed = false;
  let resolveNext: ((value: Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">) => void) | undefined;
  let rejectNext: ((reason: Error) => void) | undefined;
  let unsubscribeFacts: (() => void) | undefined;
  let unsubscribeStop: (() => void) | undefined;
  let stopSettled = false;
  let transitions = new Map<string, AcceptedTransition>();

  const clearWaiter = (): void => {
    unsubscribeFacts?.();
    unsubscribeFacts = undefined;
    resolveNext = undefined;
    rejectNext = undefined;
    unsubscribeStop?.();
    unsubscribeStop = undefined;
    transitions = new Map();
    stopSettled = false;
  };

  const tryResolveAfterStop = (): void => {
    if (closed || resolveNext === undefined || !stopSettled || transitions.size !== 2) return;
    const evidence = evidenceFromFinalState(module, connection, [...transitions.values()]);
    if (evidence === null) return;
    const resolve = resolveNext;
    clearWaiter();
    resolve(evidence);
  };

  const acceptFact = (fact: WorldFact): void => {
    if (closed || resolveNext === undefined || transitions.size >= 2 || fact.kind !== "execution_receipt") return;
    const transition = transitionFromCorrelatedTerminal(module, connection, fact);
    if (transition === null || transitions.has(transition.lineage)) return;
    transitions.set(transition.lineage, transition);
    tryResolveAfterStop();
  };

  const acceptStopSettlement = (): void => {
    // The existing Host settlement is a one-shot barrier. Remembering it only
    // for this waiter lets a late second transition complete the same proof,
    // while clearWaiter prevents reuse or replay.
    if (closed || resolveNext === undefined || stopSettled) return;
    stopSettled = true;
    tryResolveAfterStop();
  };

  const next = (): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">> => {
    if (closed || resolveNext !== undefined)
      return Promise.reject(new Error("game_operational_gate_evidence_unavailable"));
    return new Promise((resolve, reject) => {
      resolveNext = resolve;
      rejectNext = reject;
      unsubscribeFacts = events.onFact(acceptFact);
      unsubscribeStop = stopSource?.onStopSettled(acceptStopSettlement);
    });
  };

  return Object.freeze({
    next,
    close: () => {
      if (closed) return;
      closed = true;
      const reject = rejectNext;
      clearWaiter();
      reject?.(new Error("game_operational_gate_evidence_unavailable"));
    },
  });
}

function transitionFromCorrelatedTerminal(
  module: GameIntegrationAdapter,
  connection: GameConnection,
  fact: WorldFact,
): AcceptedTransition | null {
  let state: IntegrationStateView;
  try {
    state = module.readState(connection);
  } catch {
    return null;
  }
  const receipt = state.latestReceipt;
  if (
    fact.source !== "stardew_mod" ||
    !validState(state) ||
    receipt === null ||
    !succeededReceipt(receipt) ||
    !identifier(receipt.actionId) ||
    !revision(state.capabilityRevision) ||
    receipt.executionId !== fact.executionId ||
    receipt.requestId !== fact.requestId ||
    receipt.revision !== fact.revision ||
    state.snapshotRevision < receipt.revision
  )
    return null;

  try {
    if (
      !module.actionCatalog.hasCompletionEvidence(receipt.actionId, {
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        evidence: receipt.evidence,
      })
    )
      return null;
  } catch {
    return null;
  }

  // A request/execution pair is one source lineage even if a later publication
  // changes receipt revision or action metadata; it cannot count twice.
  return Object.freeze({
    lineage: `${receipt.executionId}\u0000${receipt.requestId}`,
    actionId: receipt.actionId,
    receiptRevision: receipt.revision,
    capabilityRevision: state.capabilityRevision,
  });
}

function evidenceFromFinalState(
  module: GameIntegrationAdapter,
  connection: GameConnection,
  transitions: readonly AcceptedTransition[],
): Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId"> | null {
  let state: IntegrationStateView;
  try {
    state = module.readState(connection);
  } catch {
    return null;
  }
  if (!validState(state) || !revision(state.capabilityRevision)) return null;
  const maxReceiptRevision = Math.max(...transitions.map((transition) => transition.receiptRevision));
  const maxCapabilityRevision = Math.max(...transitions.map((transition) => transition.capabilityRevision));
  if (state.snapshotRevision < maxReceiptRevision || state.capabilityRevision < maxCapabilityRevision) return null;
  const actionIds = new Set(transitions.map((transition) => transition.actionId));
  if (actionIds.size !== 2) return null;
  return Object.freeze({
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    surface: "game",
    capabilityRevision: maxCapabilityRevision,
    capabilityCount: state.capabilities.length,
    transitions: Object.freeze({
      count: 2 as const,
      distinctActionCount: actionIds.size,
      freshObservationCount: 2 as const,
      allPostconditionsObserved: true as const,
    }),
    terminalState: "completed" as const,
    stopSettled: true as const,
  });
}

function succeededReceipt(value: IntegrationExecutionReceipt): value is IntegrationExecutionReceipt & { revision: number } {
  return (
    typeof value.requestId === "string" &&
    identifier(value.requestId) &&
    typeof value.executionId === "string" &&
    identifier(value.executionId) &&
    value.state === "succeeded" &&
    typeof value.reasonCode === "string" &&
    value.reasonCode.length > 0 &&
    revision(value.revision) &&
    value.evidence !== null &&
    exactNonEmptyRecord(value.evidence)
  );
}

function validState(value: IntegrationStateView): value is IntegrationStateView & { snapshotRevision: number } {
  return (
    value.connected &&
    revision(value.snapshotRevision) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 512 &&
    value.capabilities.every(identifier)
  );
}
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function exactNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 64;
}
function isRecord(value: unknown): value is Record<string, any> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}
function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function count(value: unknown): value is number {
  return revision(value) && value <= 512;
}
function distinctActionCount(value: unknown): value is 2 {
  return value === 2;
}
