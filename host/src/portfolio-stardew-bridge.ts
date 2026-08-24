import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
  bootstrapScope,
  computePortfolioBindingHash,
  materializePortfolioMineElevatorFreshFloor,
  materializePortfolioMineElevatorProbe,
  materializePortfolioMineElevatorReceipt,
  materializePortfolioMineEntryFreshFloor,
  materializePortfolioMineEntryProbe,
  materializePortfolioMineEntryReceipt,
  materializePortfolioMineLadderFreshFloor,
  materializePortfolioMineLadderProbe,
  materializePortfolioMineLadderReceipt,
  materializePortfolioSkipEventProbe,
  materializePortfolioSkipEventReceipt,
  materializePortfolioSleepDayReceipt,
  newPortfolioEnvelope,
  PORTFOLIO_MAX_MESSAGE_BYTES,
  PORTFOLIO_MINE_ELEVATOR_PHASES,
  PORTFOLIO_MINE_ENTRY_PHASES,
  PORTFOLIO_MINE_LADDER_PHASES,
  PORTFOLIO_SKIP_EVENT_PHASES,
  PORTFOLIO_SLEEP_DAY_PHASES,
  PORTFOLIO_TOPOLOGY,
  type PortfolioBootstrapIdentity,
  type PortfolioMessage,
  type PortfolioMineElevatorCancelRequest,
  type PortfolioMineElevatorFreshFloor,
  type PortfolioMineElevatorFreshFloorRequest,
  type PortfolioMineElevatorPhase,
  type PortfolioMineElevatorProbe,
  type PortfolioMineElevatorReceipt,
  type PortfolioMineElevatorRequest,
  type PortfolioMineEntryCancelRequest,
  type PortfolioMineEntryFreshFloor,
  type PortfolioMineEntryFreshFloorRequest,
  type PortfolioMineEntryPhase,
  type PortfolioMineEntryProbe,
  type PortfolioMineEntryReceipt,
  type PortfolioMineEntryRequest,
  type PortfolioMineLadderCancelRequest,
  type PortfolioMineLadderFreshFloor,
  type PortfolioMineLadderFreshFloorRequest,
  type PortfolioMineLadderPhase,
  type PortfolioMineLadderProbe,
  type PortfolioMineLadderReceipt,
  type PortfolioMineLadderRequest,
  type PortfolioScope,
  type PortfolioSkipEventCancelRequest,
  type PortfolioSkipEventPhase,
  type PortfolioSkipEventProbe,
  type PortfolioSkipEventReceipt,
  type PortfolioSkipEventRequest,
  type PortfolioSleepDayEvidenceIdentity,
  type PortfolioSleepDayPhase,
  type PortfolioSleepDayReceipt,
  type PortfolioSleepDayRequest,
  type PortfolioSnapshot,
  serializePortfolioBounded,
  validatePortfolioMessage,
  validatePortfolioMineElevatorCancelRequest,
  validatePortfolioMineElevatorFreshFloorRequest,
  validatePortfolioMineElevatorRequest,
  validatePortfolioMineEntryCancelRequest,
  validatePortfolioMineEntryFreshFloorRequest,
  validatePortfolioMineEntryRequest,
  validatePortfolioMineLadderCancelRequest,
  validatePortfolioMineLadderFreshFloorRequest,
  validatePortfolioMineLadderRequest,
  validatePortfolioSkipEventCancelRequest,
  validatePortfolioSkipEventRequest,
  validatePortfolioSleepDayCancelRequest,
  validatePortfolioSleepDayRequest,
  validatePortfolioSnapshot,
} from "./portfolio-protocol.js";
import { type PortfolioFrameWriter, writePortfolioFrame } from "./portfolio-transport.js";

function samePortfolioEvidenceIdentity(actual: PortfolioSleepDayEvidenceIdentity, expected: PortfolioScope): boolean {
  return (
    actual.integrationId === expected.integrationId &&
    actual.topology === expected.topology &&
    actual.saveId === expected.saveId &&
    actual.worldId === expected.worldId &&
    actual.localPlayerId === expected.localPlayerId &&
    actual.companionId === expected.companionId &&
    actual.bindingGeneration === expected.bindingGeneration &&
    actual.bindingHash === expected.bindingHash
  );
}

function phaseTraceIncludesObserved(
  observed: readonly {
    requestId: string;
    traceId: string;
    executionId: string;
    phase: string;
    revision: number;
    reasonCode: string;
  }[],
  receipt: readonly {
    requestId: string;
    traceId: string;
    executionId: string;
    phase: string;
    revision: number;
    reasonCode: string;
  }[],
): boolean {
  return observed.every((phase) =>
    receipt.some(
      (candidate) =>
        candidate.requestId === phase.requestId &&
        candidate.traceId === phase.traceId &&
        candidate.executionId === phase.executionId &&
        candidate.phase === phase.phase &&
        candidate.revision === phase.revision &&
        candidate.reasonCode === phase.reasonCode,
    ),
  );
}
function samePhaseTrace(
  actual: readonly {
    requestId: string;
    traceId: string;
    executionId: string;
    phase: string;
    revision: number;
    reasonCode: string;
  }[],
  expected: readonly {
    requestId: string;
    traceId: string;
    executionId: string;
    phase: string;
    revision: number;
    reasonCode: string;
  }[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((phase, index) => {
      const other = expected[index];
      return (
        other !== undefined &&
        phase.requestId === other.requestId &&
        phase.traceId === other.traceId &&
        phase.executionId === other.executionId &&
        phase.phase === other.phase &&
        phase.revision === other.revision &&
        phase.reasonCode === other.reasonCode
      );
    })
  );
}

export type PortfolioBridgeState = Readonly<{
  connected: boolean;
  authenticated: boolean;
  snapshot: PortfolioSnapshot | null;
  latestReasonCode: string | null;
}>;

type PendingResolve = (message: PortfolioMessage) => void;
type PendingReject = (error: Error) => void;
type PendingTimer = ReturnType<typeof setTimeout>;

type PendingBase = {
  resolve: PendingResolve;
  reject: PendingReject;
  timer: PendingTimer;
};

/**
 * Plain request/response correlation (hello, observe, probe, fresh floor).
 * It carries no accepted/phase/resolver vocabulary and can never settle or
 * cancel a transition lifecycle.
 */
type PlainPending = PendingBase & {
  kind: "plain";
  request?:
    | PortfolioSleepDayRequest
    | PortfolioMineElevatorRequest
    | PortfolioMineLadderRequest
    | PortfolioMineEntryRequest
    | PortfolioSkipEventRequest;
  executionId?: string;
  traceId?: string;
  cancellationToken?: string;
  cancellationRequest: false;
  phases: never[];
  phaseIndex: -1;
};

type SleepDayPending = PendingBase & {
  kind: "sleep_day";
  request: PortfolioSleepDayRequest;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: false;
  phases: PortfolioSleepDayPhase[];
  phaseIndex: number;
};

type SleepDayCancelPending = PendingBase & {
  kind: "sleep_day_cancel";
  request: PortfolioSleepDayRequest;
  original: SleepDayPending;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: true;
  phases: PortfolioSleepDayPhase[];
  phaseIndex: number;
};

type MineElevatorPending = PendingBase & {
  kind: "mine_elevator";
  request: PortfolioMineElevatorRequest;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: false;
  terminalSettled?: boolean;
  phases: PortfolioMineElevatorPhase[];
  phaseIndex: number;
  mineAcceptedResolve: (phase: PortfolioMineElevatorPhase) => void;
  mineTerminalPromise: Promise<PortfolioMineElevatorReceipt>;
  mineTerminalResolve: (receipt: PortfolioMineElevatorReceipt) => void;
  mineTerminalReject: (error: Error) => void;
};

type MineElevatorCancelPending = PendingBase & {
  kind: "mine_elevator_cancel";
  request: PortfolioMineElevatorRequest;
  original: MineElevatorPending;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: true;
  phases: never[];
  phaseIndex: -1;
};

type MineLadderPending = PendingBase & {
  kind: "mine_ladder";
  request: PortfolioMineLadderRequest;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: false;
  terminalSettled?: boolean;
  phases: PortfolioMineLadderPhase[];
  phaseIndex: number;
  mineAcceptedResolve: (phase: PortfolioMineLadderPhase) => void;
  mineTerminalPromise: Promise<PortfolioMineLadderReceipt>;
  mineTerminalResolve: (receipt: PortfolioMineLadderReceipt) => void;
  mineTerminalReject: (error: Error) => void;
};

type MineLadderCancelPending = PendingBase & {
  kind: "mine_ladder_cancel";
  request: PortfolioMineLadderRequest;
  original: MineLadderPending;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: true;
  phases: never[];
  phaseIndex: -1;
};

type MineEntryPending = PendingBase & {
  kind: "mine_entry";
  request: PortfolioMineEntryRequest;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: false;
  terminalSettled?: boolean;
  phases: PortfolioMineEntryPhase[];
  phaseIndex: number;
  mineAcceptedResolve: (phase: PortfolioMineEntryPhase) => void;
  mineTerminalPromise: Promise<PortfolioMineEntryReceipt>;
  mineTerminalResolve: (receipt: PortfolioMineEntryReceipt) => void;
  mineTerminalReject: (error: Error) => void;
};

type MineEntryCancelPending = PendingBase & {
  kind: "mine_entry_cancel";
  request: PortfolioMineEntryRequest;
  original: MineEntryPending;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: true;
  phases: never[];
  phaseIndex: -1;
};

type SkipEventPending = PendingBase & {
  kind: "skip_event";
  request: PortfolioSkipEventRequest;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: false;
  terminalSettled?: boolean;
  phases: PortfolioSkipEventPhase[];
  phaseIndex: number;
  skipEventAcceptedResolve: (phase: PortfolioSkipEventPhase) => void;
  skipEventTerminalPromise: Promise<PortfolioSkipEventReceipt>;
  skipEventTerminalResolve: (receipt: PortfolioSkipEventReceipt) => void;
  skipEventTerminalReject: (error: Error) => void;
};

type SkipEventCancelPending = PendingBase & {
  kind: "skip_event_cancel";
  request: PortfolioSkipEventRequest;
  original: SkipEventPending;
  executionId?: string;
  traceId: string;
  cancellationToken: string;
  cancellationRequest: true;
  phases: never[];
  phaseIndex: -1;
};

/**
 * Private pending correlation model. Every request/phase/receipt/cancel frame
 * maps to exactly one variant; a lifecycle owns its typed request, phase
 * vocabulary, resolvers and cancellation link, so impossible combinations
 * (several mine kinds, a wrong request/resolver pair, or a lifecycle without
 * a typed vocabulary) cannot be represented.
 */
type PortfolioPending =
  | PlainPending
  | SleepDayPending
  | SleepDayCancelPending
  | MineElevatorPending
  | MineElevatorCancelPending
  | MineLadderPending
  | MineLadderCancelPending
  | MineEntryPending
  | MineEntryCancelPending
  | SkipEventPending
  | SkipEventCancelPending;

type MineReceiptPending =
  | MineElevatorPending
  | MineElevatorCancelPending
  | MineLadderPending
  | MineLadderCancelPending
  | MineEntryPending
  | MineEntryCancelPending
  | SkipEventPending
  | SkipEventCancelPending;

export type PortfolioMineEntryStart = Readonly<{
  request: PortfolioMineEntryRequest;
  executionId: string;
  terminal: Promise<PortfolioMineEntryReceipt>;
}>;

export type PortfolioSkipEventStart = Readonly<{
  request: PortfolioSkipEventRequest;
  executionId: string;
  terminal: Promise<PortfolioSkipEventReceipt>;
}>;

export type PortfolioMineLadderStart = Readonly<{
  request: PortfolioMineLadderRequest;
  executionId: string;
  terminal: Promise<PortfolioMineLadderReceipt>;
}>;

export type PortfolioMineElevatorStart = Readonly<{
  request: PortfolioMineElevatorRequest;
  executionId: string;
  terminal: Promise<PortfolioMineElevatorReceipt>;
}>;

type PortfolioRequestType =
  | "bootstrap_hello"
  | "hello"
  | "observe_request"
  | "sleep_day_request"
  | "sleep_day_cancel_request"
  | "mine_elevator_probe_request"
  | "mine_elevator_fresh_floor_request"
  | "mine_elevator_cancel_request"
  | "mine_ladder_probe_request"
  | "mine_ladder_fresh_floor_request"
  | "mine_ladder_cancel_request"
  | "enter_mine_probe_request"
  | "enter_mine_fresh_floor_request"
  | "enter_mine_cancel_request"
  | "skip_event_probe_request"
  | "skip_event_cancel_request";

type PortfolioSleepOrMineRequest =
  | PortfolioSleepDayRequest
  | PortfolioMineElevatorRequest
  | PortfolioMineLadderRequest
  | PortfolioMineEntryRequest
  | PortfolioSkipEventRequest;

/** Build the private pending variant owned by one outbound request frame. */
function buildRequestPending(
  type: PortfolioRequestType,
  sleepRequest: PortfolioSleepOrMineRequest | undefined,
  cancelOf: PortfolioPending | undefined,
  base: { resolve: PendingResolve; reject: PendingReject; timer: PendingTimer },
): PortfolioPending {
  if (cancelOf !== undefined) {
    switch (cancelOf.kind) {
      case "sleep_day":
      case "sleep_day_cancel":
        return {
          ...base,
          kind: "sleep_day_cancel",
          request: cancelOf.request,
          original: cancelOf.kind === "sleep_day" ? cancelOf : cancelOf.original,
          executionId: cancelOf.executionId,
          traceId: cancelOf.traceId,
          cancellationToken: cancelOf.cancellationToken,
          cancellationRequest: true,
          phases: [],
          phaseIndex: -1,
        };
      case "mine_elevator":
      case "mine_elevator_cancel":
        return {
          ...base,
          kind: "mine_elevator_cancel",
          request: cancelOf.request,
          original: cancelOf.kind === "mine_elevator" ? cancelOf : cancelOf.original,
          executionId: cancelOf.executionId,
          traceId: cancelOf.traceId,
          cancellationToken: cancelOf.cancellationToken,
          cancellationRequest: true,
          phases: [],
          phaseIndex: -1,
        };
      case "mine_ladder":
      case "mine_ladder_cancel":
        return {
          ...base,
          kind: "mine_ladder_cancel",
          request: cancelOf.request,
          original: cancelOf.kind === "mine_ladder" ? cancelOf : cancelOf.original,
          executionId: cancelOf.executionId,
          traceId: cancelOf.traceId,
          cancellationToken: cancelOf.cancellationToken,
          cancellationRequest: true,
          phases: [],
          phaseIndex: -1,
        };
      case "mine_entry":
      case "mine_entry_cancel":
        return {
          ...base,
          kind: "mine_entry_cancel",
          request: cancelOf.request,
          original: cancelOf.kind === "mine_entry" ? cancelOf : cancelOf.original,
          executionId: cancelOf.executionId,
          traceId: cancelOf.traceId,
          cancellationToken: cancelOf.cancellationToken,
          cancellationRequest: true,
          phases: [],
          phaseIndex: -1,
        };
      case "skip_event":
      case "skip_event_cancel":
        return {
          ...base,
          kind: "skip_event_cancel",
          request: cancelOf.request,
          original: cancelOf.kind === "skip_event" ? cancelOf : cancelOf.original,
          executionId: cancelOf.executionId,
          traceId: cancelOf.traceId,
          cancellationToken: cancelOf.cancellationToken,
          cancellationRequest: true,
          phases: [],
          phaseIndex: -1,
        };
      case "plain":
        // A plain correlation cannot own a cancellation link.
        throw new Error("portfolio_pending_cannot_cancel_plain");
    }
  }
  if (sleepRequest !== undefined) {
    if (type === "sleep_day_request") {
      return {
        ...base,
        kind: "sleep_day",
        request: sleepRequest as PortfolioSleepDayRequest,
        executionId: undefined,
        traceId: sleepRequest.traceId,
        cancellationToken: sleepRequest.cancellationToken,
        cancellationRequest: false,
        phases: [],
        phaseIndex: -1,
      };
    }
    // Probe and fresh-floor correlations retain the request facts only for
    // inbound fail-closed correlation; they own no lifecycle vocabulary.
    return {
      ...base,
      kind: "plain",
      request: sleepRequest,
      executionId: undefined,
      traceId: sleepRequest.traceId,
      cancellationToken: sleepRequest.cancellationToken,
      cancellationRequest: false,
      phases: [],
      phaseIndex: -1,
    };
  }
  return {
    ...base,
    kind: "plain",
    request: undefined,
    executionId: undefined,
    traceId: undefined,
    cancellationToken: undefined,
    cancellationRequest: false,
    phases: [],
    phaseIndex: -1,
  };
}

/** Host adapter for the independent, topology-isolated Portfolio protocol. */
const BOOTSTRAP_HANDOFF_SETTLE_MS = 100;
const PORTFOLIO_PIPE_CONNECT_TIMEOUT_MS = 15_000;
const PORTFOLIO_PIPE_WRITE_TIMEOUT_MS = 5_000;

export class PortfolioStardewBridgeClient {
  readonly #pending = new Map<string, PortfolioPending>();
  readonly #events = new EventEmitter();
  #buffer = Buffer.alloc(0);
  #lastRevision = -1;
  #closed = false;
  #authenticated = false;
  #snapshot: PortfolioSnapshot | null = null;
  #latestReasonCode: string | null = null;
  #socket: Socket;
  readonly #frameWriter: PortfolioFrameWriter;

  private constructor(
    readonly scope: PortfolioScope,
    socket: Socket,
    readonly token: string,
    frameWriter: PortfolioFrameWriter = socket,
  ) {
    this.#socket = socket;
    this.#frameWriter = frameWriter;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.close("pipe_closed"));
    socket.on("error", (error: NodeJS.ErrnoException) => this.close(`pipe_error:${error.code ?? "unknown"}`));
  }

  public static async connectBootstrap(
    identity: PortfolioBootstrapIdentity,
    pipeName: string,
    token: string,
  ): Promise<PortfolioStardewBridgeClient> {
    const sentinel = bootstrapScope(identity);
    const bootstrapClient = await PortfolioStardewBridgeClient.connectInternal(sentinel, pipeName, token);
    let actualScope: PortfolioScope;
    try {
      const response = await bootstrapClient.bootstrapHello();
      const actual = response.scope as PortfolioScope;
      if (
        actual.saveId !== identity.saveId ||
        actual.worldId !== identity.worldId ||
        actual.localPlayerId !== identity.localPlayerId ||
        actual.companionId !== identity.companionId ||
        actual.bindingGeneration <= 0 ||
        actual.bindingHash !== computePortfolioBindingHash(actual) ||
        response.payload.bindingGeneration !== actual.bindingGeneration ||
        response.payload.bindingHash !== actual.bindingHash
      )
        throw new Error("portfolio_bootstrap_scope_mismatch");
      actualScope = actual;
    } finally {
      bootstrapClient.close("bootstrap_connection_complete");
    }
    // The Mod's disconnect handoff is consumed on its game thread. Keep the
    // successor socket closed until the game-thread-owned handoff has had a
    // complete settlement window; this remains one strict successor, not a
    // reconnect loop.
    await new Promise<void>((resolve) => setTimeout(resolve, BOOTSTRAP_HANDOFF_SETTLE_MS));
    // The strict connection is intentionally new: bootstrap identity uplift
    // must never share a socket with ordinary full-scope traffic.
    return PortfolioStardewBridgeClient.connect(actualScope!, pipeName, token);
  }

  private static async connectInternal(
    scope: PortfolioScope | ReturnType<typeof bootstrapScope>,
    pipeName: string,
    token: string,
    frameWriterFactory?: (socket: Socket) => PortfolioFrameWriter,
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
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
        callback();
      };
      const onConnect = () => settle(resolve);
      const onError = (error: NodeJS.ErrnoException) =>
        settle(() =>
          reject(new Error(error.code === "ENOENT" ? "portfolio_pipe_not_published" : "portfolio_pipe_connect_failed")),
        );
      const onClose = () => settle(() => reject(new Error("portfolio_pipe_connect_closed")));
      const timer = setTimeout(() => {
        settle(() => {
          socket.destroy();
          reject(new Error("portfolio_pipe_connect_timeout"));
        });
      }, PORTFOLIO_PIPE_CONNECT_TIMEOUT_MS);
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    return new PortfolioStardewBridgeClient(scope as PortfolioScope, socket, token, frameWriterFactory?.(socket));
  }

  /** Test-only local transport writer seam; ordinary connect never injects a writer. */
  private static async connectForTest(
    scope: PortfolioScope,
    pipeName: string,
    token: string,
    frameWriterFactory: (socket: Socket) => PortfolioFrameWriter,
  ): Promise<PortfolioStardewBridgeClient> {
    const client = await PortfolioStardewBridgeClient.connectInternal(scope, pipeName, token, frameWriterFactory);
    await client.hello();
    return client;
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
    const client = await PortfolioStardewBridgeClient.connectInternal(scope, pipeName, token);
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
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
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
  public async readMineElevatorFreshFloor(
    request: PortfolioMineElevatorFreshFloorRequest,
  ): Promise<PortfolioMineElevatorFreshFloor> {
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
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_mine_elevator_revision_not_fresh");
    const correlationId = randomUUID();
    const envelope = newPortfolioEnvelope("mine_elevator_request", this.scope, request, correlationId);
    let acceptResolve!: (phase: PortfolioMineElevatorPhase) => void;
    let acceptReject!: (error: Error) => void;
    let terminalResolve!: (receipt: PortfolioMineElevatorReceipt) => void;
    let terminalReject!: (error: Error) => void;
    const accepted = new Promise<PortfolioMineElevatorPhase>((resolve, reject) => {
      acceptResolve = resolve;
      acceptReject = reject;
    });
    const terminal = new Promise<PortfolioMineElevatorReceipt>((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    // A terminal can fail closed before the start acceptance is awaited. Attach
    // a rejection observer now so that path remains deterministic rather than
    // becoming an unhandled-rejection process failure; callers still receive
    // the original terminal Promise and its rejection when they retain it.
    void terminal.catch(() => undefined);
    const timer = setTimeout(
      () => {
        this.#pending.delete(correlationId);
        const error = new Error("portfolio_mine_elevator_deadline_expired");
        acceptReject(error);
        terminalReject(error);
      },
      Math.max(0, request.deadlineMs - Date.now()),
    );
    this.#pending.set(correlationId, {
      kind: "mine_elevator",
      resolve: () => undefined,
      reject: acceptReject,
      timer,
      request,
      executionId: undefined,
      traceId: request.traceId,
      cancellationToken: request.cancellationToken,
      cancellationRequest: false,
      phases: [],
      phaseIndex: -1,
      mineAcceptedResolve: acceptResolve,
      mineTerminalPromise: terminal,
      mineTerminalResolve: terminalResolve,
      mineTerminalReject: terminalReject,
    });
    void accepted.catch(() => undefined);
    await this.#writeFrame(envelope);
    const phase = await accepted;
    return { request, executionId: phase.executionId, terminal };
  }

  public async probeMineLadder(request: PortfolioMineLadderRequest): Promise<PortfolioMineLadderProbe> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineLadderRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_mine_ladder_revision_not_fresh");
    const response = await this.request("mine_ladder_probe_request", request, request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "mine_ladder_probe") {
      this.close("portfolio_mine_ladder_probe_required");
      throw new Error("portfolio_mine_ladder_probe_required");
    }
    return materializePortfolioMineLadderProbe(response.payload, request, this.scope);
  }

  /** Sends one bounded coordination request; the Mod remains the execution owner. */
  public async readMineLadderFreshFloor(
    request: PortfolioMineLadderFreshFloorRequest,
  ): Promise<PortfolioMineLadderFreshFloor> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineLadderFreshFloorRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const response = await this.request("mine_ladder_fresh_floor_request", request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "mine_ladder_fresh_floor") {
      this.close("portfolio_mine_ladder_fresh_floor_required");
      throw new Error("portfolio_mine_ladder_fresh_floor_required");
    }
    return materializePortfolioMineLadderFreshFloor(response.payload, request, this.scope);
  }

  public async startMineLadder(request: PortfolioMineLadderRequest): Promise<PortfolioMineLadderStart> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineLadderRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_mine_ladder_revision_not_fresh");
    const correlationId = randomUUID();
    const envelope = newPortfolioEnvelope("mine_ladder_request", this.scope, request, correlationId);
    let acceptResolve!: (phase: PortfolioMineLadderPhase) => void;
    let acceptReject!: (error: Error) => void;
    let terminalResolve!: (receipt: PortfolioMineLadderReceipt) => void;
    let terminalReject!: (error: Error) => void;
    const accepted = new Promise<PortfolioMineLadderPhase>((resolve, reject) => {
      acceptResolve = resolve;
      acceptReject = reject;
    });
    const terminal = new Promise<PortfolioMineLadderReceipt>((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    // A terminal can fail closed before the start acceptance is awaited. Attach
    // a rejection observer now so that path remains deterministic rather than
    // becoming an unhandled-rejection process failure; callers still receive
    // the original terminal Promise and its rejection when they retain it.
    void terminal.catch(() => undefined);
    const timer = setTimeout(
      () => {
        this.#pending.delete(correlationId);
        const error = new Error("portfolio_mine_ladder_deadline_expired");
        acceptReject(error);
        terminalReject(error);
      },
      Math.max(0, request.deadlineMs - Date.now()),
    );
    this.#pending.set(correlationId, {
      kind: "mine_ladder",
      resolve: () => undefined,
      reject: acceptReject,
      timer,
      request,
      executionId: undefined,
      traceId: request.traceId,
      cancellationToken: request.cancellationToken,
      cancellationRequest: false,
      phases: [],
      phaseIndex: -1,
      mineAcceptedResolve: acceptResolve,
      mineTerminalPromise: terminal,
      mineTerminalResolve: terminalResolve,
      mineTerminalReject: terminalReject,
    });
    void accepted.catch(() => undefined);
    await this.#writeFrame(envelope);
    const phase = await accepted;
    return { request, executionId: phase.executionId, terminal };
  }

  public async probeMineEntry(request: PortfolioMineEntryRequest): Promise<PortfolioMineEntryProbe> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineEntryRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_enter_mine_revision_not_fresh");
    const response = await this.request("enter_mine_probe_request", request, request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "enter_mine_probe") {
      this.close("portfolio_enter_mine_probe_required");
      throw new Error("portfolio_enter_mine_probe_required");
    }
    return materializePortfolioMineEntryProbe(response.payload, request, this.scope);
  }

  /** Sends one bounded coordination request; the Mod remains the execution owner. */
  public async readMineEntryFreshFloor(
    request: PortfolioMineEntryFreshFloorRequest,
  ): Promise<PortfolioMineEntryFreshFloor> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineEntryFreshFloorRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const response = await this.request("enter_mine_fresh_floor_request", request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "enter_mine_fresh_floor") {
      this.close("portfolio_enter_mine_fresh_floor_required");
      throw new Error("portfolio_enter_mine_fresh_floor_required");
    }
    return materializePortfolioMineEntryFreshFloor(response.payload, request, this.scope);
  }

  public async startMineEntry(request: PortfolioMineEntryRequest): Promise<PortfolioMineEntryStart> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineEntryRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_enter_mine_revision_not_fresh");
    const correlationId = randomUUID();
    const envelope = newPortfolioEnvelope("enter_mine_request", this.scope, request, correlationId);
    let acceptResolve!: (phase: PortfolioMineEntryPhase) => void;
    let acceptReject!: (error: Error) => void;
    let terminalResolve!: (receipt: PortfolioMineEntryReceipt) => void;
    let terminalReject!: (error: Error) => void;
    const accepted = new Promise<PortfolioMineEntryPhase>((resolve, reject) => {
      acceptResolve = resolve;
      acceptReject = reject;
    });
    const terminal = new Promise<PortfolioMineEntryReceipt>((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    // A terminal can fail closed before the start acceptance is awaited. Attach
    // a rejection observer now so that path remains deterministic rather than
    // becoming an unhandled-rejection process failure; callers still receive
    // the original terminal Promise and its rejection when they retain it.
    void terminal.catch(() => undefined);
    const timer = setTimeout(
      () => {
        this.#pending.delete(correlationId);
        const error = new Error("portfolio_enter_mine_deadline_expired");
        acceptReject(error);
        terminalReject(error);
      },
      Math.max(0, request.deadlineMs - Date.now()),
    );
    this.#pending.set(correlationId, {
      kind: "mine_entry",
      resolve: () => undefined,
      reject: acceptReject,
      timer,
      request,
      executionId: undefined,
      traceId: request.traceId,
      cancellationToken: request.cancellationToken,
      cancellationRequest: false,
      phases: [],
      phaseIndex: -1,
      mineAcceptedResolve: acceptResolve,
      mineTerminalPromise: terminal,
      mineTerminalResolve: terminalResolve,
      mineTerminalReject: terminalReject,
    });
    void accepted.catch(() => undefined);
    await this.#writeFrame(envelope);
    const phase = await accepted;
    return { request, executionId: phase.executionId, terminal };
  }

  public async sleepAndAdvanceDay(request: PortfolioSleepDayRequest): Promise<PortfolioSleepDayReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSleepDayRequest(request);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
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
    const pending = [...this.#pending.values()].find((candidate) => candidate.request?.requestId === request.requestId);
    if (
      pending === undefined ||
      (pending.kind !== "mine_elevator" && pending.kind !== "mine_elevator_cancel") ||
      pending.executionId === undefined ||
      pending.request.traceId !== request.traceId ||
      pending.executionId !== request.executionId ||
      pending.request.cancellationToken !== request.cancellationToken ||
      !samePortfolioEvidenceIdentity(request.scope, this.scope)
    )
      throw new Error("portfolio_mine_elevator_cancel_not_pending");
    const response = await this.request("mine_elevator_cancel_request", request, pending.request, pending);
    if (response.type !== "mine_elevator_receipt") {
      this.close("portfolio_mine_elevator_cancel_receipt_required");
      throw new Error("portfolio_mine_elevator_cancel_receipt_required");
    }
    return materializePortfolioMineElevatorReceipt(response.payload, pending.request, this.scope);
  }

  public async cancelMineLadder(request: PortfolioMineLadderCancelRequest): Promise<PortfolioMineLadderReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineLadderCancelRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const pending = [...this.#pending.values()].find((candidate) => candidate.request?.requestId === request.requestId);
    if (
      pending === undefined ||
      (pending.kind !== "mine_ladder" && pending.kind !== "mine_ladder_cancel") ||
      pending.executionId === undefined ||
      pending.request.traceId !== request.traceId ||
      pending.executionId !== request.executionId ||
      pending.request.cancellationToken !== request.cancellationToken ||
      !samePortfolioEvidenceIdentity(request.scope, this.scope)
    )
      throw new Error("portfolio_mine_ladder_cancel_not_pending");
    const response = await this.request("mine_ladder_cancel_request", request, pending.request, pending);
    if (response.type !== "mine_ladder_receipt") {
      this.close("portfolio_mine_ladder_cancel_receipt_required");
      throw new Error("portfolio_mine_ladder_cancel_receipt_required");
    }
    return materializePortfolioMineLadderReceipt(response.payload, pending.request, this.scope);
  }

  public async cancelMineEntry(request: PortfolioMineEntryCancelRequest): Promise<PortfolioMineEntryReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioMineEntryCancelRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const pending = [...this.#pending.values()].find((candidate) => candidate.request?.requestId === request.requestId);
    if (
      pending === undefined ||
      (pending.kind !== "mine_entry" && pending.kind !== "mine_entry_cancel") ||
      pending.executionId === undefined ||
      pending.request.traceId !== request.traceId ||
      pending.executionId !== request.executionId ||
      pending.request.cancellationToken !== request.cancellationToken ||
      !samePortfolioEvidenceIdentity(request.scope, this.scope)
    )
      throw new Error("portfolio_enter_mine_cancel_not_pending");
    const response = await this.request("enter_mine_cancel_request", request, pending.request, pending);
    if (response.type !== "enter_mine_receipt") {
      this.close("portfolio_enter_mine_cancel_receipt_required");
      throw new Error("portfolio_enter_mine_cancel_receipt_required");
    }
    return materializePortfolioMineEntryReceipt(response.payload, pending.request, this.scope);
  }

  public async probeSkipEvent(request: PortfolioSkipEventRequest): Promise<PortfolioSkipEventProbe> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSkipEventRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_skip_event_revision_not_fresh");
    const response = await this.request("skip_event_probe_request", request, request);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "skip_event_probe") {
      this.close("portfolio_skip_event_probe_required");
      throw new Error("portfolio_skip_event_probe_required");
    }
    return materializePortfolioSkipEventProbe(response.payload, request, this.scope);
  }

  public async startSkipEvent(request: PortfolioSkipEventRequest): Promise<PortfolioSkipEventStart> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSkipEventRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    if (
      this.#snapshot === null ||
      this.#snapshot.state !== "ready" ||
      this.#snapshot.revision !== request.expectedRevision
    )
      throw new Error("portfolio_skip_event_revision_not_fresh");
    const correlationId = randomUUID();
    const envelope = newPortfolioEnvelope("skip_event_request", this.scope, request, correlationId);
    let acceptResolve!: (phase: PortfolioSkipEventPhase) => void;
    let acceptReject!: (error: Error) => void;
    let terminalResolve!: (receipt: PortfolioSkipEventReceipt) => void;
    let terminalReject!: (error: Error) => void;
    const accepted = new Promise<PortfolioSkipEventPhase>((resolve, reject) => {
      acceptResolve = resolve;
      acceptReject = reject;
    });
    const terminal = new Promise<PortfolioSkipEventReceipt>((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    // A terminal can fail closed before the start acceptance is awaited. Attach
    // a rejection observer now so that path remains deterministic rather than
    // becoming an unhandled-rejection process failure; callers still receive
    // the original terminal Promise and its rejection when they retain it.
    void terminal.catch(() => undefined);
    const timer = setTimeout(
      () => {
        this.#pending.delete(correlationId);
        const error = new Error("portfolio_skip_event_deadline_expired");
        acceptReject(error);
        terminalReject(error);
      },
      Math.max(0, request.deadlineMs - Date.now()),
    );
    this.#pending.set(correlationId, {
      kind: "skip_event",
      resolve: () => undefined,
      reject: acceptReject,
      timer,
      request,
      executionId: undefined,
      traceId: request.traceId,
      cancellationToken: request.cancellationToken,
      cancellationRequest: false,
      phases: [],
      phaseIndex: -1,
      skipEventAcceptedResolve: acceptResolve,
      skipEventTerminalPromise: terminal,
      skipEventTerminalResolve: terminalResolve,
      skipEventTerminalReject: terminalReject,
    });
    void accepted.catch(() => undefined);
    await this.#writeFrame(envelope);
    const phase = await accepted;
    return { request, executionId: phase.executionId, terminal };
  }

  public async cancelSkipEvent(request: PortfolioSkipEventCancelRequest): Promise<PortfolioSkipEventReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSkipEventCancelRequest(request, this.scope);
    if (fault !== null) throw new Error(fault);
    const pending = [...this.#pending.values()].find((candidate) => candidate.request?.requestId === request.requestId);
    if (
      pending === undefined ||
      (pending.kind !== "skip_event" && pending.kind !== "skip_event_cancel") ||
      pending.executionId === undefined ||
      pending.request.traceId !== request.traceId ||
      pending.executionId !== request.executionId ||
      pending.request.cancellationToken !== request.cancellationToken ||
      !samePortfolioEvidenceIdentity(request.scope, this.scope)
    )
      throw new Error("portfolio_skip_event_cancel_not_pending");
    const response = await this.request("skip_event_cancel_request", request, pending.request, pending);
    if (response.type !== "skip_event_receipt") {
      this.close("portfolio_skip_event_cancel_receipt_required");
      throw new Error("portfolio_skip_event_cancel_receipt_required");
    }
    return materializePortfolioSkipEventReceipt(response.payload, pending.request, this.scope);
  }

  public async cancelSleepAndAdvanceDay(
    request: Extract<PortfolioMessage, { type: "sleep_day_cancel_request" }>["payload"],
  ): Promise<PortfolioSleepDayReceipt> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const fault = validatePortfolioSleepDayCancelRequest(request);
    if (fault !== null) throw new Error(fault);
    const pending = [...this.#pending.values()].find((candidate) => candidate.request?.requestId === request.requestId);
    if (
      pending === undefined ||
      (pending.kind !== "sleep_day" && pending.kind !== "sleep_day_cancel") ||
      pending.executionId === undefined ||
      pending.request.traceId !== request.traceId ||
      pending.executionId !== request.executionId ||
      pending.request.cancellationToken !== request.cancellationToken
    ) {
      throw new Error("portfolio_sleep_day_cancel_not_pending");
    }
    const response = await this.request("sleep_day_cancel_request", request, pending.request, pending);
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "sleep_day_receipt") throw new Error("portfolio_sleep_day_cancel_receipt_required");
    if (
      response.payload.executionId !== request.executionId ||
      response.payload.requestId !== request.requestId ||
      response.payload.traceId !== request.traceId
    ) {
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
    this.#latestReasonCode = reasonCode;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error(`portfolio_bridge_closed:${reasonCode}`);
      pending.reject(error);
      if (pending.kind === "mine_elevator" || pending.kind === "mine_ladder" || pending.kind === "mine_entry") {
        pending.mineTerminalReject(error);
      }
      if (pending.kind === "skip_event") {
        pending.skipEventTerminalReject(error);
      }
    }
    this.#pending.clear();
    this.#socket.destroy();
    this.#events.emit("close", reasonCode);
  }

  private async bootstrapHello(): Promise<Extract<PortfolioMessage, { type: "bootstrap_hello_ack" }>> {
    const response = await this.request("bootstrap_hello", { token: this.token });
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "bootstrap_hello_ack") throw new Error("unexpected_portfolio_bootstrap_response");
    return response;
  }

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.token });
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_portfolio_hello_response");
    this.#authenticated = true;
  }

  private async request(
    type: PortfolioRequestType,
    payload: Record<string, unknown>,
    sleepRequest?: PortfolioSleepOrMineRequest,
    cancelOf?: PortfolioPending,
  ): Promise<PortfolioMessage> {
    if (this.#closed || this.#socket.destroyed) return Promise.reject(new Error("portfolio_pipe_disconnected"));
    const correlationId = randomUUID();
    const message = newPortfolioEnvelope(type, this.scope, payload, correlationId);
    const response = new Promise<PortfolioMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new Error("portfolio_bridge_response_timeout"));
      }, 5_000);
      this.#pending.set(correlationId, buildRequestPending(type, sleepRequest, cancelOf, { resolve, reject, timer }));
    });
    try {
      await this.#writeFrame(message as PortfolioMessage);
    } catch {
      // close() rejected the registered lifecycle work with the stable reason.
      return await response;
    }
    return await response;
  }

  async #writeFrame(message: PortfolioMessage): Promise<void> {
    const json = serializePortfolioBounded(message);
    const payloadBytes = Buffer.from(json, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeInt32LE(payloadBytes.byteLength, 0);
    try {
      await writePortfolioFrame(
        this.#frameWriter,
        Buffer.concat([header, payloadBytes]),
        PORTFOLIO_PIPE_WRITE_TIMEOUT_MS,
      );
    } catch (error) {
      const reasonCode =
        error instanceof Error && error.message === "portfolio_pipe_write_timeout"
          ? "pipe_write_timeout"
          : "pipe_write_error";
      if (!this.#closed) this.close(reasonCode);
      throw error;
    }
  }

  /**
   * Settle one M8 family receipt exactly once against the discriminated
   * lifecycle/cancel pending that owns it. Returns false when the frame was
   * rejected and the bridge closed (caller must stop processing).
   */
  private settleMineReceipt(
    pending: MineReceiptPending,
    message: Extract<
      PortfolioMessage,
      { type: "mine_elevator_receipt" | "mine_ladder_receipt" | "enter_mine_receipt" | "skip_event_receipt" }
    >,
  ): boolean {
    if (
      !(
        (message.type === "mine_elevator_receipt" &&
          (pending.kind === "mine_elevator" || pending.kind === "mine_elevator_cancel")) ||
        (message.type === "mine_ladder_receipt" &&
          (pending.kind === "mine_ladder" || pending.kind === "mine_ladder_cancel")) ||
        (message.type === "enter_mine_receipt" &&
          (pending.kind === "mine_entry" || pending.kind === "mine_entry_cancel")) ||
        (message.type === "skip_event_receipt" &&
          (pending.kind === "skip_event" || pending.kind === "skip_event_cancel"))
      ) ||
      message.payload.requestId !== pending.request.requestId ||
      message.payload.traceId !== pending.request.traceId ||
      (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
      !samePortfolioEvidenceIdentity(message.payload.evidence.scope, this.scope)
    ) {
      this.close(
        message.type === "skip_event_receipt"
          ? "portfolio_skip_event_correlation_mismatch"
          : "portfolio_mine_elevator_correlation_mismatch",
      );
      return false;
    }
    // A terminal M8 receipt cannot establish start acceptance. This also
    // rejects a forged short success and an out-of-order terminal frame.
    const original = pending.cancellationRequest ? pending.original : pending;
    if (
      original.phases.length === 0 ||
      original.phases.at(-1)?.phase !== "accepted" ||
      !phaseTraceIncludesObserved(original.phases, message.payload.evidence.phaseTrace)
    ) {
      this.close(
        message.type === "skip_event_receipt"
          ? "portfolio_skip_event_receipt_before_acceptance"
          : "portfolio_mine_elevator_receipt_before_acceptance",
      );
      return false;
    }
    let receipt:
      | PortfolioMineElevatorReceipt
      | PortfolioMineLadderReceipt
      | PortfolioMineEntryReceipt
      | PortfolioSkipEventReceipt;
    try {
      receipt =
        message.type === "skip_event_receipt"
          ? materializePortfolioSkipEventReceipt(
              message.payload,
              original.request as PortfolioSkipEventRequest,
              this.scope,
            )
          : message.type === "mine_ladder_receipt"
            ? materializePortfolioMineLadderReceipt(
                message.payload,
                original.request as PortfolioMineLadderRequest,
                this.scope,
              )
            : message.type === "enter_mine_receipt"
              ? materializePortfolioMineEntryReceipt(
                  message.payload,
                  original.request as PortfolioMineEntryRequest,
                  this.scope,
                )
              : materializePortfolioMineElevatorReceipt(
                  message.payload,
                  original.request as PortfolioMineElevatorRequest,
                  this.scope,
                );
    } catch {
      this.close(
        message.type === "skip_event_receipt"
          ? "portfolio_skip_event_receipt_invalid"
          : "portfolio_mine_elevator_receipt_invalid",
      );
      return false;
    }
    if (original.terminalSettled) {
      this.close(
        message.type === "skip_event_receipt"
          ? "portfolio_skip_event_duplicate_terminal"
          : "portfolio_mine_elevator_duplicate_terminal",
      );
      return false;
    }
    original.terminalSettled = true;
    this.#pending.delete(message.correlationId);
    clearTimeout(pending.timer);
    if (pending !== original) {
      this.#pending.delete([...this.#pending.entries()].find(([, candidate]) => candidate === original)?.[0] ?? "");
      clearTimeout(original.timer);
    }
    // Resolve exactly the family-exact terminal resolver of the settled
    // lifecycle; the family of the receipt and the lifecycle were matched above.
    if (message.type === "mine_elevator_receipt" && original.kind === "mine_elevator") {
      original.mineTerminalResolve(receipt as PortfolioMineElevatorReceipt);
    } else if (message.type === "mine_ladder_receipt" && original.kind === "mine_ladder") {
      original.mineTerminalResolve(receipt as PortfolioMineLadderReceipt);
    } else if (message.type === "enter_mine_receipt" && original.kind === "mine_entry") {
      original.mineTerminalResolve(receipt as PortfolioMineEntryReceipt);
    } else if (message.type === "skip_event_receipt" && original.kind === "skip_event") {
      original.skipEventTerminalResolve(receipt as PortfolioSkipEventReceipt);
    } else {
      this.close(
        message.type === "skip_event_receipt"
          ? "portfolio_skip_event_correlation_mismatch"
          : "portfolio_mine_elevator_correlation_mismatch",
      );
      return false;
    }
    pending.resolve(message);
    return true;
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
      if (
        fault !== null ||
        message.type === "bootstrap_hello" ||
        message.type === "hello" ||
        message.type === "observe_request"
      ) {
        this.close(fault ?? "portfolio_unexpected_inbound_request");
        return;
      }
      const pending = this.#pending.get(message.correlationId);
      if (
        (message.type === "mine_elevator_phase" ||
          message.type === "mine_elevator_receipt" ||
          message.type === "mine_ladder_phase" ||
          message.type === "mine_ladder_receipt" ||
          message.type === "enter_mine_phase" ||
          message.type === "enter_mine_receipt" ||
          message.type === "skip_event_phase" ||
          message.type === "skip_event_receipt") &&
        pending === undefined
      ) {
        // A terminal/phase frame without a live correlation is never allowed to
        // create a new lifecycle (including after cancellation or duplicate
        // delivery). Fail closed rather than treating it as a fresh result.
        this.close(
          message.type === "skip_event_phase" || message.type === "skip_event_receipt"
            ? "portfolio_skip_event_unknown_correlation"
            : "portfolio_mine_elevator_unknown_correlation",
        );
        return;
      }
      if (pending?.request !== undefined) {
        if (
          message.type === "mine_elevator_phase" ||
          message.type === "mine_ladder_phase" ||
          message.type === "enter_mine_phase" ||
          message.type === "skip_event_phase"
        ) {
          if (message.type === "mine_elevator_phase" && pending.kind === "mine_elevator") {
            if (
              message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.request.traceId ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              (pending.phases.length === 0 &&
                (message.payload.phase !== "accepted" || message.payload.reasonCode !== "accepted")) ||
              (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)
            ) {
              this.close("portfolio_mine_elevator_correlation_mismatch");
              return;
            }
            const phaseIndex = PORTFOLIO_MINE_ELEVATOR_PHASES.indexOf(message.payload.phase);
            if (phaseIndex <= pending.phaseIndex) {
              this.close("portfolio_mine_elevator_phase_regressed");
              return;
            }
            pending.phaseIndex = phaseIndex;
            pending.executionId = message.payload.executionId;
            pending.phases.push(message.payload);
            if (message.payload.phase === "accepted") pending.mineAcceptedResolve(message.payload);
            continue;
          }
          if (message.type === "mine_ladder_phase" && pending.kind === "mine_ladder") {
            if (
              message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.request.traceId ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              (pending.phases.length === 0 &&
                (message.payload.phase !== "accepted" || message.payload.reasonCode !== "accepted")) ||
              (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)
            ) {
              this.close("portfolio_mine_elevator_correlation_mismatch");
              return;
            }
            const phaseIndex = PORTFOLIO_MINE_LADDER_PHASES.indexOf(message.payload.phase);
            if (phaseIndex <= pending.phaseIndex) {
              this.close("portfolio_mine_elevator_phase_regressed");
              return;
            }
            pending.phaseIndex = phaseIndex;
            pending.executionId = message.payload.executionId;
            pending.phases.push(message.payload);
            if (message.payload.phase === "accepted") pending.mineAcceptedResolve(message.payload);
            continue;
          }
          if (message.type === "enter_mine_phase" && pending.kind === "mine_entry") {
            if (
              message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.request.traceId ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              (pending.phases.length === 0 &&
                (message.payload.phase !== "accepted" || message.payload.reasonCode !== "accepted")) ||
              (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)
            ) {
              this.close("portfolio_mine_elevator_correlation_mismatch");
              return;
            }
            const phaseIndex = PORTFOLIO_MINE_ENTRY_PHASES.indexOf(message.payload.phase);
            if (phaseIndex <= pending.phaseIndex) {
              this.close("portfolio_mine_elevator_phase_regressed");
              return;
            }
            pending.phaseIndex = phaseIndex;
            pending.executionId = message.payload.executionId;
            pending.phases.push(message.payload);
            if (message.payload.phase === "accepted") pending.mineAcceptedResolve(message.payload);
            continue;
          }
          if (message.type === "skip_event_phase" && pending.kind === "skip_event") {
            if (
              message.payload.requestId !== pending.request.requestId ||
              message.payload.traceId !== pending.request.traceId ||
              (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
              (pending.phases.length === 0 &&
                (message.payload.phase !== "accepted" || message.payload.reasonCode !== "accepted")) ||
              (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)
            ) {
              this.close("portfolio_skip_event_correlation_mismatch");
              return;
            }
            const phaseIndex = PORTFOLIO_SKIP_EVENT_PHASES.indexOf(message.payload.phase);
            if (phaseIndex <= pending.phaseIndex) {
              this.close("portfolio_skip_event_phase_regressed");
              return;
            }
            pending.phaseIndex = phaseIndex;
            pending.executionId = message.payload.executionId;
            pending.phases.push(message.payload);
            if (message.payload.phase === "accepted") pending.skipEventAcceptedResolve(message.payload);
            continue;
          }
          this.close(
            message.type === "skip_event_phase"
              ? "portfolio_skip_event_correlation_mismatch"
              : "portfolio_mine_elevator_correlation_mismatch",
          );
          return;
        }
        if (message.type === "sleep_day_phase") {
          if (pending.kind !== "sleep_day" && pending.kind !== "sleep_day_cancel") {
            this.close("portfolio_sleep_day_correlation_mismatch");
            return;
          }
          if (
            message.payload.requestId !== pending.request.requestId ||
            message.payload.traceId !== pending.traceId ||
            (pending.phases.length === 0 && message.payload.phase !== "fresh_observed") ||
            (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
            (pending.phases.length > 0 && message.payload.revision < pending.phases.at(-1)!.revision)
          ) {
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
        if (
          message.type === "mine_elevator_receipt" ||
          message.type === "mine_ladder_receipt" ||
          message.type === "enter_mine_receipt" ||
          message.type === "skip_event_receipt"
        ) {
          if (
            pending.kind === "mine_elevator" ||
            pending.kind === "mine_elevator_cancel" ||
            pending.kind === "mine_ladder" ||
            pending.kind === "mine_ladder_cancel" ||
            pending.kind === "mine_entry" ||
            pending.kind === "mine_entry_cancel" ||
            pending.kind === "skip_event" ||
            pending.kind === "skip_event_cancel"
          ) {
            if (!this.settleMineReceipt(pending, message)) return;
          } else {
            this.close(
              message.type === "skip_event_receipt"
                ? "portfolio_skip_event_correlation_mismatch"
                : "portfolio_mine_elevator_correlation_mismatch",
            );
            return;
          }
          continue;
        }
        if (message.type === "sleep_day_receipt") {
          if (pending.kind !== "sleep_day" && pending.kind !== "sleep_day_cancel") {
            this.close("portfolio_sleep_day_correlation_mismatch");
            return;
          }
          if (
            message.payload.requestId !== pending.request.requestId ||
            message.payload.traceId !== pending.traceId ||
            (pending.executionId !== undefined && message.payload.executionId !== pending.executionId) ||
            !samePortfolioEvidenceIdentity(message.payload.evidence.identity, this.scope) ||
            (!pending.cancellationRequest &&
              pending.phases.length > 0 &&
              !samePhaseTrace(pending.phases, message.payload.evidence.phaseTrace))
          ) {
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
        if (
          pending !== undefined &&
          (pending.kind === "mine_elevator" ||
            pending.kind === "mine_elevator_cancel" ||
            pending.kind === "mine_ladder" ||
            pending.kind === "mine_ladder_cancel" ||
            pending.kind === "mine_entry" ||
            pending.kind === "mine_entry_cancel")
        ) {
          const original = pending.cancellationRequest ? pending.original : pending;
          pending.reject(error);
          original.mineTerminalReject(error);
          if (original !== pending) original.reject(error);
        } else if (pending !== undefined && (pending.kind === "skip_event" || pending.kind === "skip_event_cancel")) {
          const original = pending.cancellationRequest ? pending.original : pending;
          pending.reject(error);
          original.skipEventTerminalReject(error);
          if (original !== pending) original.reject(error);
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
        const keepSleepLifecycle =
          message.type === "sleep_day_receipt" &&
          message.payload.state === "uncertain" &&
          message.payload.reasonCode === "execution_armed" &&
          resolvedPending.request !== undefined;
        if (!keepSleepLifecycle) this.#pending.delete(message.correlationId);
        clearTimeout(resolvedPending.timer);
        resolvedPending.resolve(message);
      }
    }
  }
}
