import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  PORTFOLIO_MAX_MESSAGE_BYTES,
  PORTFOLIO_SLEEP_DAY_PHASES,
  PORTFOLIO_MINE_ELEVATOR_PHASES,
  PORTFOLIO_TOPOLOGY,
  type PortfolioMessage,
  type PortfolioScope,
  type PortfolioSnapshot,
  type PortfolioSleepDayEvidenceIdentity,
  type PortfolioSleepDayPhase,
  type PortfolioSleepDayReceipt,
  type PortfolioSleepDayRequest,
  newPortfolioEnvelope,
  serializePortfolioBounded,
  validatePortfolioMessage,
  validatePortfolioSnapshot,
  validatePortfolioSleepDayRequest,
  validatePortfolioSleepDayCancelRequest,
  materializePortfolioSleepDayReceipt,
  materializePortfolioMineElevatorReceipt,
  validatePortfolioMineElevatorRequest,
  materializePortfolioMineElevatorProbe,
  materializePortfolioMineElevatorFreshFloor,
  validatePortfolioMineElevatorFreshFloorRequest,
  validatePortfolioMineElevatorCancelRequest,
  type PortfolioMineElevatorRequest,
  type PortfolioMineElevatorProbe,
  type PortfolioMineElevatorFreshFloorRequest,
  type PortfolioMineElevatorFreshFloor,
  type PortfolioMineElevatorCancelRequest,
  type PortfolioMineElevatorPhase,
  type PortfolioMineElevatorReceipt,
} from "./portfolio-protocol.js";

function samePortfolioEvidenceIdentity(
  actual: PortfolioSleepDayEvidenceIdentity,
  expected: PortfolioScope,
): boolean {
  return actual.integrationId === expected.integrationId &&
    actual.topology === expected.topology &&
    actual.saveId === expected.saveId &&
    actual.worldId === expected.worldId &&
    actual.localPlayerId === expected.localPlayerId &&
    actual.companionId === expected.companionId &&
    actual.bindingGeneration === expected.bindingGeneration &&
    actual.bindingHash === expected.bindingHash;
}

function phaseTraceIncludesObserved(
  observed: readonly { requestId: string; traceId: string; executionId: string; phase: string; revision: number; reasonCode: string }[],
  receipt: readonly { requestId: string; traceId: string; executionId: string; phase: string; revision: number; reasonCode: string }[],
): boolean {
  return observed.every((phase) => receipt.some((candidate) =>
    candidate.requestId === phase.requestId && candidate.traceId === phase.traceId &&
    candidate.executionId === phase.executionId && candidate.phase === phase.phase &&
    candidate.revision === phase.revision && candidate.reasonCode === phase.reasonCode));
}
function samePhaseTrace(
  actual: readonly { requestId: string; traceId: string; executionId: string; phase: string; revision: number; reasonCode: string }[],
  expected: readonly { requestId: string; traceId: string; executionId: string; phase: string; revision: number; reasonCode: string }[],
): boolean {
  return actual.length === expected.length && actual.every((phase, index) => {
    const other = expected[index];
    return other !== undefined && phase.requestId === other.requestId && phase.traceId === other.traceId &&
      phase.executionId === other.executionId && phase.phase === other.phase && phase.revision === other.revision &&
      phase.reasonCode === other.reasonCode;
  });
}

export type PortfolioBridgeState = Readonly<{
  connected: boolean;
  authenticated: boolean;
  snapshot: PortfolioSnapshot | null;
  latestReasonCode: string | null;
}>;

type Pending = {
  resolve: (message: PortfolioMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  request?: PortfolioSleepDayRequest | PortfolioMineElevatorRequest;
  executionId?: string;
  mineAcceptedResolve?: (phase: PortfolioMineElevatorPhase) => void;
  mineTerminalPromise?: Promise<PortfolioMineElevatorReceipt>;
  mineTerminalResolve?: (receipt: PortfolioMineElevatorReceipt) => void;
  mineTerminalReject?: (error: Error) => void;
  traceId?: string;
  cancellationToken?: string;
  cancellationRequest?: boolean;
  terminalSettled?: boolean;
  phases: Array<PortfolioSleepDayPhase | PortfolioMineElevatorPhase>;
  phaseIndex: number;
  mineElevator?: boolean;
};

export type PortfolioMineElevatorStart = Readonly<{
  request: PortfolioMineElevatorRequest;
  executionId: string;
  terminal: Promise<PortfolioMineElevatorReceipt>;
}>;

/** Host adapter for the independent, topology-isolated Portfolio protocol. */
export class PortfolioStardewBridgeClient {
  readonly #pending = new Map<string, Pending>();
  readonly #events = new EventEmitter();
  #buffer = Buffer.alloc(0);
  #lastRevision = -1;
  #closed = false;
  #authenticated = false;
  #snapshot: PortfolioSnapshot | null = null;
  #latestReasonCode: string | null = null;
  #socket: Socket;

  private constructor(
    readonly scope: PortfolioScope,
    socket: Socket,
    readonly token: string,
  ) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.close("pipe_closed"));
    socket.on("error", (error: NodeJS.ErrnoException) => this.close(`pipe_error:${error.code ?? "unknown"}`));
  }

  public static async connect(
    scope: PortfolioScope,
    pipeName: string,
    token: string,
  ): Promise<PortfolioStardewBridgeClient> {
    if (
      scope.topology !== PORTFOLIO_TOPOLOGY ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(pipeName) ||
      !/^gamebuddy-stardew-portfolio[A-Za-z0-9_-]{0,96}$/.test(pipeName) ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(token)
    )
      throw new Error("invalid_portfolio_bridge_config");
    const socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new PortfolioStardewBridgeClient(scope, socket, token);
    await client.hello();
    return client;
  }

  public get state(): PortfolioBridgeState {
    return {
      connected: !this.#closed && !this.#socket.destroyed,
      authenticated: this.#authenticated,
      snapshot: this.#snapshot,
      latestReasonCode: this.#latestReasonCode,
    };
  }

  public async observe(): Promise<PortfolioSnapshot> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const response = await this.request("observe_request", {});
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "snapshot" || validatePortfolioSnapshot(response.payload) !== null)
      throw new Error("invalid_portfolio_snapshot");
    this.#snapshot = response.payload;
    return response.payload;
  }

  public async probeMineElevator(request: PortfolioMineElevatorRequest): Promise<PortfolioMineElevatorProbe> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineElevatorRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (this.#snapshot === null || this.#snapshot.state !== "ready" || this.#snapshot.revision !== request.expectedRevision)
      throw new Error("portfolio_mine_elevator_revision_not_fresh");
    const response = await this.request("mine_elevator_probe_request", request, request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "mine_elevator_probe") {
      this.close("portfolio_mine_elevator_probe_required");
      throw new Error("portfolio_mine_elevator_probe_required");
    }
    return materializePortfolioMineElevatorProbe(response.payload, request, this.scope);
  }

  /** Sends one bounded coordination request; the Mod remains the execution owner. */
  public async readMineElevatorFreshFloor(request: PortfolioMineElevatorFreshFloorRequest): Promise<PortfolioMineElevatorFreshFloor> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineElevatorFreshFloorRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const response = await this.request("mine_elevator_fresh_floor_request", request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "mine_elevator_fresh_floor") {
      this.close("portfolio_mine_elevator_fresh_floor_required");
      throw new Error("portfolio_mine_elevator_fresh_floor_required");
    }
    return materializePortfolioMineElevatorFreshFloor(response.payload, request, this.scope);
  }

  public async startMineElevator(request: PortfolioMineElevatorRequest): Promise<PortfolioMineElevatorStart> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineElevatorRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (this.#snapshot === null || this.#snapshot.state !== "ready" || this.#snapshot.revision !== request.expectedRevision)
      throw new Error("portfolio_mine_elevator_revision_not_fresh");
    const correlationId = randomUUID();
    const envelope = newPortfolioEnvelope("mine_elevator_request", this.scope, request, correlationId);
    let acceptResolve!: (phase: PortfolioMineElevatorPhase) => void;
    let acceptReject!: (error: Error) => void;
    let terminalResolve!: (receipt: PortfolioMineElevatorReceipt) => void;
    let terminalReject!: (error: Error) => void;
    const accepted = new Promise<PortfolioMineElevatorPhase>((resolve, reject) => { acceptResolve = resolve; acceptReject = reject; });
    const terminal = new Promise<PortfolioMineElevatorReceipt>((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
    // A terminal can fail closed before the start acceptance is awaited. Attach
    // a rejection observer now so that path remains deterministic rather than
    // becoming an unhandled-rejection process failure; callers still receive
    // the original terminal Promise and its rejection when they retain it.
    void terminal.catch(() => undefined);
    const timer = setTimeout(() => {
      this.#pending.delete(correlationId);
      const error = new Error("portfolio_mine_elevator_deadline_expired");
      acceptReject(error); terminalReject(error);
    }, Math.max(0, request.deadlineMs - Date.now()));
    this.#pending.set(correlationId, {
      resolve: () => undefined, reject: acceptReject, timer, request,
      phases: [], phaseIndex: -1, mineElevator: true,
      mineAcceptedResolve: acceptResolve, mineTerminalPromise: terminal, mineTerminalResolve: terminalResolve, mineTerminalReject: terminalReject,
    } as Pending & { mineAcceptedResolve: (phase: PortfolioMineElevatorPhase) => void; mineTerminalResolve: (receipt: PortfolioMineElevatorReceipt) => void; mineTerminalReject: (error: Error) => void });
    try {
      const json = serializePortfolioBounded(envelope);
      const bytes = Buffer.from(json, "utf8"); const header = Buffer.allocUnsafe(4); header.writeInt32LE(bytes.byteLength, 0);
      this.#socket.write(Buffer.concat([header, bytes]));
    } catch (error) {
      clearTimeout(timer); this.#pending.delete(correlationId); acceptReject(error as Error); terminalReject(error as Error);
    }
    const phase = await accepted;
    const pending = this.#pending.get(correlationId);
    if (pending !== undefined) pending.mineTerminalPromise = terminal;
    return { request, executionId: phase.executionId, terminal };
  }

  public async sleepAndAdvanceDay(request: PortfolioSleepDayRequest): Promise<PortfolioSleepDayReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSleepDayRequest(request);
    if (fault !== null) throw new Error(fault);
    if (this.#snapshot === null || this.#snapshot.state !== "ready" || this.#snapshot.revision !== request.expectedRevision)
      throw new Error("portfolio_sleep_day_revision_not_fresh");
    const response = await this.request("sleep_day_request", request, request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "sleep_day_receipt") throw new Error("portfolio_sleep_day_receipt_required");
    return materializePortfolioSleepDayReceipt(response.payload, request, this.scope);
  }

  public async cancelMineElevator(request: PortfolioMineElevatorCancelRequest): Promise<PortfolioMineElevatorReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineElevatorCancelRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const pending = [...this.#pending.values()].find((candidate) => candidate.mineElevator && candidate.request?.requestId === request.requestId);
    if (pending?.request === undefined || pending.executionId === undefined || pending.request.traceId !== request.traceId ||
        pending.executionId !== request.executionId || pending.request.cancellationToken !== request.cancellationToken ||
        !samePortfolioEvidenceIdentity(request.scope, this.scope)) throw new Error("portfolio_mine_elevator_cancel_not_pending");
    const response = await this.request("mine_elevator_cancel_request", request, pending.request, pending);
    if (response.type !== "mine_elevator_receipt") { this.close("portfolio_mine_elevator_cancel_receipt_required"); throw new Error("portfolio_mine_elevator_cancel_receipt_required"); }
    return materializePortfolioMineElevatorReceipt(response.payload, pending.request, this.scope);
  }

  public async cancelSleepAndAdvanceDay(request: Extract<PortfolioMessage, { type: "sleep_day_cancel_request" }>['payload']): Promise<PortfolioSleepDayReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSleepDayCancelRequest(request);
    if (fault !== null) throw new Error(fault);
    const pending = [...this.#pending.values()].find((candidate) => candidate.request?.requestId === request.requestId);
    if (pending?.request === undefined || pending.executionId === undefined ||
        pending.request.traceId !== request.traceId || pending.executionId !== request.executionId ||
        pending.request.cancellationToken !== request.cancellationToken) {
      throw new Error("portfolio_sleep_day_cancel_not_pending");
    }
    const response = await this.request("sleep_day_cancel_request", request, pending.request, pending);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "sleep_day_receipt")
      throw new Error("portfolio_sleep_day_cancel_receipt_required");
    if (response.payload.executionId !== request.executionId || response.payload.requestId !== request.requestId || response.payload.traceId !== request.traceId) {
      this.close("portfolio_sleep_day_cancel_correlation_mismatch");
      throw new Error("portfolio_sleep_day_cancel_correlation_mismatch");
    }
    const receipt = materializePortfolioSleepDayReceipt(response.payload, pending.request, this.scope);
    for (const [correlationId, candidate] of this.#pending) {
      if (candidate.request?.requestId === request.requestId) this.#pending.delete(correlationId);
    }
    return receipt;
  }

  public onSnapshot(listener: (snapshot: PortfolioSnapshot) => void): () => void {
    this.#events.on("snapshot", listener);
    return () => this.#events.off("snapshot", listener);
  }
  public onClose(listener: (reasonCode: string) => void): () => void {
    this.#events.on("close", listener);
    return () => this.#events.off("close", listener);
  }
  public close(reasonCode = "local_close"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#authenticated = false;
    this.#snapshot = this.#snapshot?.state === "invalidated" ? this.#snapshot : null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error(`portfolio_bridge_closed:${reasonCode}`);
      pending.reject(error);
      pending.mineTerminalReject?.(error);
    }
    this.#pending.clear();
    this.#socket.destroy();
    this.#events.emit("close", reasonCode);
  }

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.token });
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_portfolio_hello_response");
    this.#authenticated = true;
  }

  private request(
    type: "hello" | "observe_request" | "sleep_day_request" | "sleep_day_cancel_request" | "mine_elevator_probe_request" | "mine_elevator_fresh_floor_request" | "mine_elevator_cancel_request",
    payload: Record<string, unknown>,
    sleepRequest?: PortfolioSleepDayRequest | PortfolioMineElevatorRequest,
    cancelOf?: Pending,
  ): Promise<PortfolioMessage> {
    if (this.#closed || this.#socket.destroyed) return Promise.reject(new Error("portfolio_pipe_disconnected"));
    const correlationId = randomUUID();
    const message = newPortfolioEnvelope(type, this.scope, payload, correlationId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new Error("portfolio_bridge_response_timeout"));
      }, 5_000);
      this.#pending.set(correlationId, {
        resolve,
        reject,
        timer,
        request: sleepRequest,
        executionId: cancelOf?.executionId,
        traceId: sleepRequest?.traceId,
        cancellationToken: sleepRequest?.cancellationToken,
        cancellationRequest: cancelOf !== undefined,
        mineElevator: cancelOf?.mineElevator,
        phases: [],
        phaseIndex: -1,
      });
      try {
        const json = serializePortfolioBounded(message);
        const payloadBytes = Buffer.from(json, "utf8");
        const header = Buffer.allocUnsafe(4);
        header.writeInt32LE(payloadBytes.byteLength, 0);
        this.#socket.write(Buffer.concat([header, payloadBytes]));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(correlationId);
        reject(error);
      }
    });
  }

  private receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readInt32LE(0);
      if (length <= 0 || length > PORTFOLIO_MAX_MESSAGE_BYTES) {
        this.close("portfolio_frame_length_invalid");
        return;
      }
      if (this.#buffer.byteLength < length + 4) return;
      const json = this.#buffer.subarray(4, length + 4).toString("utf8");
      this.#buffer = this.#buffer.subarray(length + 4);
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        this.close("portfolio_invalid_json");
        return;
      }
      const message = value as PortfolioMessage;
      const fault = validatePortfolioMessage(message, this.scope);
      if (fault !== null || message.type === "hello" || message.type === "observe_request") {
        this.close(fault ?? "portfolio_unexpected_inbound_request");
        return;
      }
      const pending = this.#pending.get(message.correlationId);
      if ((message.type === "mine_elevator_phase" || message.type === "mine_elevator_receipt") && pending === undefined) {
        // A terminal/phase frame without a live correlation is never allowed to
        // create a new lifecycle (including after cancellation or duplicate
        // delivery). Fail closed rather than treating it as a fresh result.
        this.close("portfolio_mine_elevator_unknown_correlation");
        return;
      }
      if (pending?.request !== undefined) {
        if (message.type === "mine_elevator_phase") {
          if (!pending.mineElevator || pending.cancellationRequest || message.payload.requestId !== pending.request?.requestId || message.payload.traceId !== pending.request.traceId ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              (pending.phases.length === 0 && (message.payload.phase !== "accepted" || message.payload.reasonCode !== "accepted")) ||
              (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)) {
            this.close("portfolio_mine_elevator_correlation_mismatch"); return;
          }
          const phaseIndex = PORTFOLIO_MINE_ELEVATOR_PHASES.indexOf(message.payload.phase);
          if (phaseIndex <= pending.phaseIndex) { this.close("portfolio_mine_elevator_phase_regressed"); return; }
          pending.phaseIndex = phaseIndex; pending.executionId = message.payload.executionId; pending.phases.push(message.payload);
          if (message.payload.phase === "accepted") pending.mineAcceptedResolve?.(message.payload);
          continue;
        }
        if (message.type === "sleep_day_phase") {
          if (message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.traceId ||
              (pending.phases.length === 0 && message.payload.phase !== "fresh_observed") ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)) {
            this.close("portfolio_sleep_day_correlation_mismatch");
            return;
          }
          const phaseIndex = PORTFOLIO_SLEEP_DAY_PHASES.indexOf(message.payload.phase);
          if (phaseIndex <= pending.phaseIndex) {
            this.close("portfolio_sleep_day_phase_regressed");
            return;
          }
          pending.phaseIndex = phaseIndex;
          pending.executionId = message.payload.executionId;
          pending.phases.push(message.payload);
          continue;
        }
        if (message.type === "mine_elevator_receipt") {
          if (!pending.mineElevator || pending.request === undefined || message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.request.traceId || (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              !samePortfolioEvidenceIdentity(message.payload.evidence.scope, this.scope)) {
            this.close("portfolio_mine_elevator_correlation_mismatch"); return;
          }
          // A terminal M8 receipt cannot establish start acceptance. This also
          // rejects a forged short success and an out-of-order terminal frame.
          const original = pending.cancellationRequest
            ? [...this.#pending.values()].find((candidate) => candidate !== pending && candidate.mineElevator &&
                candidate.request?.requestId === pending.request?.requestId && !candidate.cancellationRequest)
            : pending;
          if (original === undefined || original.phases.length === 0 || original.phases.at(-1)?.phase !== "accepted" ||
              !phaseTraceIncludesObserved(original.phases as readonly PortfolioMineElevatorPhase[], message.payload.evidence.phaseTrace as readonly PortfolioMineElevatorPhase[])) {
            this.close("portfolio_mine_elevator_receipt_before_acceptance"); return;
          }
          try {
            const receipt = materializePortfolioMineElevatorReceipt(message.payload, original.request as PortfolioMineElevatorRequest, this.scope);
            if (original.terminalSettled) {
              this.close("portfolio_mine_elevator_duplicate_terminal"); return;
            }
            original.terminalSettled = true;
            this.#pending.delete(message.correlationId);
            clearTimeout(pending.timer);
            if (pending !== original) {
              this.#pending.delete([...this.#pending.entries()].find(([, candidate]) => candidate === original)?.[0] ?? "");
              clearTimeout(original.timer);
            }
            original.mineTerminalResolve?.(receipt);
            pending.resolve(message);
          } catch (error) { this.close("portfolio_mine_elevator_receipt_invalid"); return; }
          continue;
        }
        if (message.type === "sleep_day_receipt") {
          if (pending.request === undefined || message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.traceId ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              !samePortfolioEvidenceIdentity(message.payload.evidence.identity, this.scope) ||
              (!pending.cancellationRequest && pending.phases.length > 0 && !samePhaseTrace(pending.phases, message.payload.evidence.phaseTrace))) {
            this.close("portfolio_sleep_day_correlation_mismatch");
            return;
          }
          // A terminal receipt may be the first response for a fail-closed
          // request, so bind the execution identity when no phase preceded it.
          pending.executionId = message.payload.executionId;
        }
      }
      if (message.type === "error") {
        this.#latestReasonCode = message.payload.reasonCode;
        const error = new Error(`portfolio_bridge_rejected:${message.payload.reasonCode}`);
        // M8 has two independently correlated promises after acceptance. An
        // error on either the start or cancel request invalidates the whole
        // lifecycle; never leave the original terminal pending or let an
        // error frame masquerade as an accepted response.
        if (pending?.mineElevator) {
          const original = pending.cancellationRequest
            ? [...this.#pending.values()].find((candidate) => candidate !== pending && candidate.mineElevator &&
                candidate.request?.requestId === pending.request?.requestId && !candidate.cancellationRequest)
            : pending;
          pending.reject(error);
          original?.mineTerminalReject?.(error);
          if (original !== undefined && original !== pending) original.reject(error);
        }
        this.close(`portfolio_bridge_rejected:${message.payload.reasonCode}`);
        return;
      }
      if (message.type === "snapshot") {
        if (message.payload.revision < this.#lastRevision) {
          this.close("portfolio_snapshot_revision_regressed");
          return;
        }
        this.#lastRevision = message.payload.revision;
        this.#snapshot = message.payload;
        this.#events.emit("snapshot", message.payload);
        if (message.payload.state === "invalidated") {
          this.#latestReasonCode = message.payload.reasonCode;
          this.close(`native_invalidation:${message.payload.reasonCode}`);
          return;
        }
      }
      const resolvedPending = this.#pending.get(message.correlationId);
      if (resolvedPending !== undefined) {
        const keepSleepLifecycle = message.type === "sleep_day_receipt" &&
          message.payload.state === "uncertain" && message.payload.reasonCode === "execution_armed" &&
          resolvedPending.request !== undefined;
        if (!keepSleepLifecycle) this.#pending.delete(message.correlationId);
        clearTimeout(resolvedPending.timer);
        resolvedPending.resolve(message);
      }
    }
  }
}
