import type { WorldFact } from "./event-pump.js";
import type { IntegrationEventSource } from "./integration-launcher.js";
import type { IntegrationExecutionReceipt, GameIntegrationModule, IntegrationStateView } from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";

/** Strict, content-free source-owned IPC contract for the operational Game gate. */
export const GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA = "gamebuddy-game-operational-gate-evidence/v1";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_RECEIPT_STATES = new Set([
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
]);

export type GameOperationalGateEvidence = Readonly<{
  schema: typeof GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA;
  nonceSha256: string;
  piSessionId: string;
  surface: "game";
  snapshotRevision: number;
  capabilityRevision: number;
  capabilityCount: number;
  terminalReceipt: Readonly<{
    state: string;
    revision: number;
    postconditionObserved: true;
  }>;
}>;

export type GameOperationalGateEvidenceProjection = Readonly<{
  /** Resolves only after a Mod-originated terminal receipt correlates to live connection state. */
  next(): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>;
  close(): void;
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
      "snapshotRevision",
      "capabilityRevision",
      "capabilityCount",
      "terminalReceipt",
    ])
  )
    return null;
  if (
    value.schema !== GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA ||
    !sha256(value.nonceSha256) ||
    !identifier(value.piSessionId) ||
    value.surface !== "game" ||
    !revision(value.snapshotRevision) ||
    !revision(value.capabilityRevision) ||
    !count(value.capabilityCount) ||
    !exactRecord(value.terminalReceipt, ["state", "revision", "postconditionObserved"]) ||
    typeof value.terminalReceipt.state !== "string" ||
    !TERMINAL_RECEIPT_STATES.has(value.terminalReceipt.state) ||
    !revision(value.terminalReceipt.revision) ||
    value.terminalReceipt.postconditionObserved !== true
  )
    return null;
  return Object.freeze({
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    nonceSha256: value.nonceSha256,
    piSessionId: value.piSessionId,
    surface: "game",
    snapshotRevision: value.snapshotRevision,
    capabilityRevision: value.capabilityRevision,
    capabilityCount: value.capabilityCount,
    terminalReceipt: Object.freeze({
      state: value.terminalReceipt.state,
      revision: value.terminalReceipt.revision,
      postconditionObserved: true as const,
    }),
  });
}

/**
 * Construction-owned reduction of the real IntegrationConnection and launch
 * event stream. It observes no model output and never exposes raw receipt or
 * evidence payloads. A terminal event is accepted only when its exact receipt
 * identity and revision are also current in the adapter's live state.
 */
export function createGameOperationalGateEvidenceProjection(
  module: GameIntegrationModule,
  connection: IntegrationConnection,
  events: IntegrationEventSource,
): GameOperationalGateEvidenceProjection {
  let closed = false;
  let resolveNext: ((value: Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">) => void) | undefined;
  let rejectNext: ((reason: Error) => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const settle = (fact: WorldFact): void => {
    if (closed || resolveNext === undefined || fact.kind !== "execution_receipt") return;
    const evidence = evidenceFromCorrelatedTerminal(module, connection, fact);
    if (evidence === null) return;
    const resolve = resolveNext;
    clearWaiter();
    resolve(evidence);
  };
  const clearWaiter = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
    resolveNext = undefined;
    rejectNext = undefined;
  };
  const next = (): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">> => {
    if (closed || resolveNext !== undefined)
      return Promise.reject(new Error("game_operational_gate_evidence_unavailable"));
    return new Promise((resolve, reject) => {
      resolveNext = resolve;
      rejectNext = reject;
      unsubscribe = events.onFact(settle);
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

function evidenceFromCorrelatedTerminal(
  module: GameIntegrationModule,
  connection: IntegrationConnection,
  fact: WorldFact,
): Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId"> | null {
  let state: IntegrationStateView;
  try {
    state = module.readState(connection);
  } catch {
    return null;
  }
  const receipt = state.latestReceipt;
  if (
    !validState(state) ||
    receipt === null ||
    !terminalReceipt(receipt) ||
    receipt.executionId !== fact.executionId ||
    receipt.requestId !== fact.requestId ||
    receipt.revision !== fact.revision ||
    state.snapshotRevision < receipt.revision
  )
    return null;

  /*
   * IntegrationStateView exposes only a snapshot revision, not a distinct
   * Mod-originated capability revision. IntegrationExecutionReceipt likewise
   * has no action identity and there is no receipt-to-action ledger available
   * at this composition boundary. Neither fact may be inferred from the
   * snapshot, visible actions, or catalog completion checks. Consequently an
   * exact action-specific postcondition and the required independent revision
   * cannot currently be proved, so this projection deliberately emits no
   * evidence until those source-owned fields are added.
   */
  return null;
}

function terminalReceipt(value: IntegrationExecutionReceipt): boolean {
  return (
    typeof value.requestId === "string" &&
    identifier(value.requestId) &&
    typeof value.executionId === "string" &&
    identifier(value.executionId) &&
    typeof value.state === "string" &&
    TERMINAL_RECEIPT_STATES.has(value.state) &&
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
