import { randomBytes } from "node:crypto";

export const PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA = "gamebuddy-player-memory-next-round-marker/v1" as const;

export type PlayerMemoryNextRoundEvidence = Readonly<{ operationCorrelation: string }>;
export type PlayerMemoryNextRoundCommitReceipt = Readonly<{
  operationCorrelation: string;
  committedMemoryMutationId: number;
}>;
export type PlayerMemoryNextRoundMarkerDecision =
  | "accepted"
  | "invalid"
  | "unbound"
  | "binding_mismatch"
  | "stale_round";
export type PlayerMemoryNextRoundMarker = Readonly<{
  schema: typeof PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA;
  sessionId: string;
  nonceSha256: string;
  surface: "chat";
  operationCorrelation: string;
  committedMemoryMutationId: number;
  materializedM1MaxMemoryMutationId: number;
  providerRoundGeneration: number;
  covered: boolean;
  oneShot: true;
}>;

type Pending =
  | Readonly<{
      state: "admitting";
      operationCorrelation: string;
      ready: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    }>
  | Readonly<{ state: "active"; receipt: PlayerMemoryNextRoundCommitReceipt; timeout: NodeJS.Timeout }>;

/** Host-owned, one-session admission and IPC boundary for player-memory evidence. */
export class PlayerMemoryNextRoundEvidenceCoordinator {
  #pending: Pending | undefined;
  #closed = false;
  #activePromptAdmissions = 0;
  #lastProviderRoundGeneration = 0;

  public constructor(
    private readonly binding: Readonly<{ sessionId: string; nonceSha256: string }>,
    private readonly timeoutMs: number = 60_000,
  ) {}

  /**
   * Claims the mutation boundary before minting an opaque correlation. The
   * controller predicate covers an already-running/draining Chat turn, while
   * prompt admissions below close the check-to-prompt-start race.
   */
  public beginMutation(chatTurnActive: () => boolean = () => false): PlayerMemoryNextRoundEvidence {
    this.#assertOpen();
    if (chatTurnActive() || this.#activePromptAdmissions !== 0)
      throw new Error("memory_next_round_evidence_chat_active");
    if (this.#pending !== undefined) throw new Error("memory_next_round_evidence_pending");
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      resolve = resolveReady;
      reject = rejectReady;
    });
    void ready.catch(() => undefined);
    const operationCorrelation = randomBytes(32).toString("base64url");
    this.#pending = Object.freeze({ state: "admitting", operationCorrelation, ready, resolve, reject });
    return Object.freeze({ operationCorrelation });
  }

  public commitMutation(receipt: PlayerMemoryNextRoundCommitReceipt): void {
    const pending = this.#pending;
    if (
      this.#closed ||
      !pending ||
      pending.state !== "admitting" ||
      receipt.operationCorrelation !== pending.operationCorrelation ||
      !Number.isSafeInteger(receipt.committedMemoryMutationId) ||
      receipt.committedMemoryMutationId <= 0
    ) {
      throw new Error("memory_next_round_evidence_admission_invalid");
    }
    const timeout = setTimeout(() => this.#timeout(receipt.operationCorrelation), this.timeoutMs);
    timeout.unref();
    this.#pending = Object.freeze({ state: "active", receipt: Object.freeze({ ...receipt }), timeout });
    pending.resolve();
  }

  public rejectMutation(error: Error): void {
    const pending = this.#pending;
    if (!pending || pending.state !== "admitting") return;
    this.#pending = undefined;
    pending.reject(error);
  }

  /** A submitted message waits until a mutation has durably activated. */
  public async admitMessage(): Promise<void> {
    await this.#waitForActivation();
  }

  /**
   * The controller holds this permit from immediately before `session.prompt`
   * through prompt settlement. It prevents a mutation from slipping between a
   * queued message's earlier admission check and its actual provider start.
   */
  public async admitPrompt(): Promise<() => void> {
    await this.#waitForActivation();
    this.#activePromptAdmissions++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activePromptAdmissions--;
    };
  }

  /** Source-local marker decision. The returned category contains no marker facts. */
  public collectMarkerDecision(value: unknown): PlayerMemoryNextRoundMarkerDecision {
    if (!isMarker(value)) return "invalid";
    const pending = this.#pending;
    if (!pending || pending.state !== "active") return "unbound";
    const marker = value;
    if (
      marker.sessionId !== this.binding.sessionId ||
      marker.nonceSha256 !== this.binding.nonceSha256 ||
      marker.surface !== "chat" ||
      marker.operationCorrelation !== pending.receipt.operationCorrelation ||
      marker.committedMemoryMutationId !== pending.receipt.committedMemoryMutationId
    )
      return "binding_mismatch";
    // `covered` is source-owned exact selected-entry provenance. The Host has
    // no selected-entry identity and must not infer it from the aggregate m[1]
    // cursor: trimming/cache can make either value relationship valid. Accept
    // the source boolean only after all public binding checks above succeed.
    // A session has one monotonically advancing provider-round sequence. Do
    // not consume the pending expectation on a stale or replayed terminal IPC.
    if (marker.providerRoundGeneration <= this.#lastProviderRoundGeneration) return "stale_round";
    if (!marker.covered) return "binding_mismatch";
    this.#lastProviderRoundGeneration = marker.providerRoundGeneration;
    clearTimeout(pending.timeout);
    this.#pending = undefined;
    return "accepted";
  }

  /** Compatibility boolean for internal callers and focused tests. */
  public collectMarker(value: unknown): boolean {
    return this.collectMarkerDecision(value) === "accepted";
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending?.state === "admitting") pending.reject(new Error("memory_next_round_evidence_closed"));
    if (pending?.state === "active") clearTimeout(pending.timeout);
  }

  async #waitForActivation(): Promise<void> {
    this.#assertOpen();
    const pending = this.#pending;
    if (pending?.state === "admitting") await pending.ready;
    this.#assertOpen();
  }

  #timeout(correlation: string): void {
    const pending = this.#pending;
    if (pending?.state === "active" && pending.receipt.operationCorrelation === correlation) this.#pending = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("memory_next_round_evidence_closed");
  }
}

function isMarker(value: unknown): value is PlayerMemoryNextRoundMarker {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 10 ||
    value.schema !== PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA ||
    typeof value.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.sessionId) ||
    typeof value.nonceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.nonceSha256) ||
    value.surface !== "chat" ||
    typeof value.operationCorrelation !== "string" ||
    !/^[A-Za-z0-9_-]{22,256}$/.test(value.operationCorrelation) ||
    !positive(value.committedMemoryMutationId) ||
    !nonnegative(value.materializedM1MaxMemoryMutationId) ||
    !positive(value.providerRoundGeneration) ||
    typeof value.covered !== "boolean" ||
    value.oneShot !== true
  )
    return false;
  return true;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
