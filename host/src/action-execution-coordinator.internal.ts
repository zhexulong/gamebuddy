import { randomUUID } from "node:crypto";
import { type CompanionInterruption, createCompanionInterruption } from "./companion-interruption.js";
import {
  ExecutionCorrelationLedger,
  type ExecutionDispatch,
  type RecoverableExecutionDispatch,
} from "./execution-correlation-ledger.js";
import type { ExecutionWake, ExecutionWakeSource } from "./integration-launcher.js";
import type { IntegrationDispatchAdmission } from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";
import type { ExecutionReceipt } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";
import {
  type HostAdmissionGrant,
  type HostNodeAdmissionRecord,
  type NodeAdmissionChallenge,
  type StardewLogicalActionRecoveryJournal,
} from "./stardew-logical-action-recovery-journal.js";

/**
 * Private, single-internal-owner action execution coordinator. It merges the
 * orthogonal concerns that previously lived split across the runtime dispatch
 * controller, the correlation ledger, the orphaned receipt-order audit, and
 * launcher wake normalization:
 *
 * - admission minting (owner + observer + exact/pending cancel),
 * - request -> execution correlation through `ExecutionCorrelationLedger`,
 * - deterministic receipt-order audit through `ReceiptReplayLedger` as the
 *   single receipt-admission path before the correlation ledger,
 * - epoch close + exact-once epoch cancellation for Host STOP,
 * - one shared fail-closed wake normalization for every action route.
 *
 * It is deliberately action-agnostic: it never receives `{action, payload}`,
 * never switches on `action`, and never validates or interprets a postcondition.
 * Per-action argument validation stays in protocol.ts and per-action
 * completion evidence stays in the module action catalog.
 */

export type ActionExecutionAdmission = IntegrationDispatchAdmission &
  Readonly<{
    cancelPending(reasonCode: string): void;
  }>;

/**
 * Controller-named node admission is deliberately separate from execute
 * dispatch. This private Host seam has no graph, fact, resource, or STOP
 * mutator; its validator can only veto or grant the supplied exact challenge.
 */
export type HostNodeAdmissionDecision =
  | Readonly<{ result: "granted"; attachmentGeneration: string; policyRevision: string; catalogRevision: string }>
  | Readonly<{ result: "rejected"; code: string }>
  | Readonly<{ result: "unavailable" }>;

export type HostNodeAdmissionValidator = (challenge: NodeAdmissionChallenge) =>
  | HostNodeAdmissionDecision
  | Promise<HostNodeAdmissionDecision>;

export type HostNodeAdmissionResult =
  | Readonly<{ result: "granted"; grant: HostAdmissionGrant }>
  | Readonly<{ result: "rejected"; code: string }>
  | Readonly<{ result: "unavailable" }>;

export class HostNodeAdmissionService {
  public constructor(
    private readonly journal: StardewLogicalActionRecoveryJournal,
    private readonly validateFresh: HostNodeAdmissionValidator,
  ) {}

  public async admit(challenge: NodeAdmissionChallenge): Promise<HostNodeAdmissionResult> {
    let existing: HostNodeAdmissionRecord | null;
    try {
      existing = this.journal.admissionRecord(challenge);
    } catch (error) {
      if (error instanceof Error && error.message === "node_admission_challenge_mismatch")
        return Object.freeze({ result: "rejected", code: "policy_identity_mismatch" });
      throw error;
    }
    if (existing?.state === "grant_issued") return Object.freeze({ result: "granted", grant: existing.grant! });
    if (existing?.state === "admission_rejected") return Object.freeze({ result: "rejected", code: existing.rejectionCode! });
    if (challenge.deadlineMs <= Date.now()) return this.#reject(challenge, "deadline_expired");
    let decision: HostNodeAdmissionDecision;
    try {
      decision = await this.validateFresh(challenge);
    } catch {
      return Object.freeze({ result: "unavailable" });
    }
    if (decision.result === "unavailable") return Object.freeze({ result: "unavailable" });
    if (decision.result === "rejected") return this.#reject(challenge, decision.code);
    if (decision.catalogRevision !== challenge.catalogRevision) return this.#reject(challenge, "catalog_revision_mismatch");
    const grant = Object.freeze({
      grantId: `grant_${randomUUID()}`,
      challenge,
      attachmentGeneration: decision.attachmentGeneration,
      policyRevision: decision.policyRevision,
      // The Mod mints this opaque identity. Host only echoes the exact challenge value.
      policyIdentity: challenge.policyIdentity,
      catalogRevision: decision.catalogRevision,
    });
    try {
      const saved = await this.journal.recordAdmission(Object.freeze({ challenge, state: "grant_issued", grant }));
      return Object.freeze({ result: "granted", grant: saved.grant! });
    } catch {
      // A grant is never returned unless its exact tuple was durably journaled.
      return Object.freeze({ result: "unavailable" });
    }
  }

  async #reject(challenge: NodeAdmissionChallenge, code: string): Promise<HostNodeAdmissionResult> {
    try {
      await this.journal.recordAdmission(Object.freeze({ challenge, state: "admission_rejected", rejectionCode: code }));
      return Object.freeze({ result: "rejected", code });
    } catch {
      return Object.freeze({ result: "unavailable" });
    }
  }
}

export type ActionExecutionCoordinator = Readonly<{
  interruption: CompanionInterruption;
  createAdmission(): ActionExecutionAdmission;
  /**
   * Single receipt-admission path. The replay audit rejects impossible order
   * (terminal rewrite, non-monotonic revision, success without evidence) and
   * the correlation ledger binds the receipt to its pre-write registration.
   */
  receiveReceipt(receipt: ExecutionReceipt): void | Promise<void>;
  markRecoveryRequired(dispatch: RecoverableExecutionDispatch): Promise<void>;
  /** Shared fail-closed wake normalization for task waiters and launcher wake routes. */
  receiveWake(wake: unknown): ExecutionWake | null;
  /** Exact original tuples retained only after a possibly-written dispatch loses its receipt. */
  uncertainDispatches(): readonly RecoverableExecutionDispatch[];
  cancelEpoch(epoch: number, reasonCode: string): Promise<void>;
  interrupt(reasonCode: string): Promise<void>;
}>;

/**
 * Compose every action surface with a runtime-local interruption epoch, one
 * correlation ledger, and one receipt-order audit. The module's adapter cancel
 * method is reachable only as the ledger's exact sender; neither Agent surface
 * receives it directly.
 */
export type ActionExecutionCoordinatorOptions = Readonly<{
  /** Pre-opened, stable-scope-bound Host journal. */
  recoveryJournal?: StardewLogicalActionRecoveryJournal;
  /** Immutable authenticated Stardew facts recorded with every normal dispatch. */
  recoveryBinding?: Readonly<{
    scope: Readonly<Record<string, unknown>>;
    bindingIdentity: Readonly<Record<string, unknown>>;
  }>;
}>;

export function createActionExecutionCoordinator(
  connection: GameConnection,
  options: ActionExecutionCoordinatorOptions = {},
): ActionExecutionCoordinator {
  const interruption = createCompanionInterruption();
  const ledger = new ExecutionCorrelationLedger(
    async (requestId, executionId, reasonCode) =>
      (await Promise.resolve(
        connection.module.cancelExecution(connection, requestId, executionId, reasonCode),
      )) as never,
    { recoveryJournal: options.recoveryJournal },
  );
  if (options.recoveryJournal !== undefined)
    ledger.rehydrate(options.recoveryJournal.recoverableRecords());
  const replay = new ReceiptReplayLedger();

  const receiveReceipt = (receipt: ExecutionReceipt): void | Promise<void> => {
    // The bridge resolves an execution_request with the same receipt that its
    // fact route already delivered synchronously. That byte-identical
    // transition is an idempotent re-delivery, not an order violation; the
    // correlation ledger recomposition is a safe no-op (it is already bound or
    // already retired). Any different receipt for a known execution must
    // satisfy the deterministic order audit or admission fails closed.
    const previous = replay.receipt(receipt.executionId);
    if (previous !== null && identicalReceipt(previous, receipt))
      return ledger.bindReceipt(receipt);
    const fault = replay.apply(receipt);
    if (fault !== null) throw new Error(`execution_receipt_replay_rejected:${fault}`);
    return ledger.bindReceipt(receipt);
  };

  const createAdmission = (): ActionExecutionAdmission => {
    const snapshot = interruption.capture();
    const owner = Object.freeze({
      ownerId: `runtime_${randomUUID()}`,
      epoch: snapshot.epoch,
    });
    return Object.freeze({
      owner,
      observer: Object.freeze({
        beforeWrite: (dispatch: ExecutionDispatch) => {
          interruption.assertCurrent(snapshot);
          // Always defer the post-admission STOP fence through a promise. Even
          // a synchronous ledger admission is awaited by the tool wrapper, so a
          // STOP queued in the same turn must close the epoch before native
          // execution can resume from that await continuation.
          const recoveryMaterial = dispatch.recoveryMaterial;
          const durableDispatch =
            recoveryMaterial === undefined || options.recoveryBinding === undefined
              ? dispatch
              : {
                  ...dispatch,
                  recoveryMaterial: {
                    ...recoveryMaterial,
                    scope: options.recoveryBinding.scope,
                    bindingIdentity: options.recoveryBinding.bindingIdentity,
                  },
                };
          return Promise.resolve(ledger.beforeWrite(durableDispatch)).then(() => interruption.assertCurrent(snapshot));
        },
        bindReceipt: (receipt: ExecutionReceipt) => receiveReceipt(receipt),
        markUncertain: (dispatch: ExecutionDispatch) => ledger.markUncertain(dispatch),
      }),
      cancelExact: (requestId, executionId, reasonCode) =>
        ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
      cancelPending: (reasonCode) => {
        void ledger.requestCancelOwner(owner, reasonCode);
      },
    });
  };

  return Object.freeze({
    interruption,
    createAdmission,
    receiveReceipt,
    receiveWake: (wake: unknown): ExecutionWake | null => normalizeExecutionWake(wake),
    uncertainDispatches: () => ledger.uncertainDispatches(),
    markRecoveryRequired: (dispatch) => ledger.markRecoveryRequired(dispatch),
    cancelEpoch: async (epoch: number, reasonCode: string) => {
      await Promise.all(ledger.requestCancelEpoch(epoch, reasonCode));
    },
    interrupt: async (reasonCode: string) => {
      const snapshot = interruption.capture();
      interruption.close(reasonCode);
      await Promise.all(ledger.requestCancelEpoch(snapshot.epoch, reasonCode));
    },
  });
}

/**
 * Two executions of the same bridge transition are identical only when every
 * observable receipt field matches. Evidence is compared canonically so key
 * order cannot turn one adapter message into a fake order violation.
 */
function identicalReceipt(left: ExecutionReceipt, right: ExecutionReceipt): boolean {
  return (
    left.executionId === right.executionId &&
    left.requestId === right.requestId &&
    left.actionId === right.actionId &&
    left.state === right.state &&
    left.reasonCode === right.reasonCode &&
    left.revision === right.revision &&
    canonicalStableJson(left.evidence) === canonicalStableJson(right.evidence)
  );
}

function canonicalStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Adapter-owned optional capability lookup; absent adapters keep polling. */
export function executionWakeSourceFor(connection: unknown): ExecutionWakeSource | undefined {
  if (!isRecord(connection) || !isRecord(connection.executionWakeSource)) return undefined;
  const source = connection.executionWakeSource;
  return typeof source.onExecutionWake === "function" ? (source as ExecutionWakeSource) : undefined;
}

/** Reject malformed adapter values before they can wake a task-owned waiter. */
export function normalizeExecutionWake(value: unknown): ExecutionWake | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.reasonCode !== "string" ||
    value.reasonCode.length === 0
  )
    return null;
  if (value.kind === "invalidated" || value.kind === "disconnected")
    return Object.freeze({ kind: value.kind, reasonCode: value.reasonCode });
  if (
    value.kind !== "terminal" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.executionId !== "string" ||
    value.executionId.length === 0 ||
    typeof value.state !== "string" ||
    value.state.length === 0
  )
    return null;
  return Object.freeze({
    kind: "terminal",
    requestId: value.requestId,
    executionId: value.executionId,
    state: value.state,
    reasonCode: value.reasonCode,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
