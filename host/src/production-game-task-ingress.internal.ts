/**
 * Private launch-owned Game task ingress. The launcher is the only producer of
 * dispatch records; this module is the child-side consumer and owns the
 * readiness/send-callback barrier. It deliberately has no public product API.
 */

export const PRODUCTION_GAME_TASK_INGRESS_SCHEMA = "gamebuddy-production-game-task-ingress/v1" as const;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type ProductionGameTaskReadyV1 = Readonly<{
  schema: typeof PRODUCTION_GAME_TASK_INGRESS_SCHEMA;
  kind: "ready";
  surface: "game";
  nonceSha256: string;
  gameSessionId: string;
  piSessionId: string;
}>;

export type ProductionGameTaskDispatchV1 = Readonly<{
  schema: typeof PRODUCTION_GAME_TASK_INGRESS_SCHEMA;
  kind: "dispatch_task";
  surface: "game";
  nonceSha256: string;
  gameSessionId: string;
  piSessionId: string;
  task: string;
}>;

export type ProductionGameTaskIngressTransport = Readonly<{
  sendReady(
    message: ProductionGameTaskReadyV1,
    callback: (error: Error | null) => void,
  ): boolean;
  onMessage(listener: (message: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}>;

export type ProductionGameTaskIngressController = Readonly<{
  /** Publishes ready and resolves only after the Node IPC callback succeeds. */
  start(): Promise<void>;
  /** Resolves after the one consumed Task 9A dispatch settles successfully. */
  task: Promise<void>;
  /** Rejects on any fatal ingress/protocol/worker failure. */
  fatal: Promise<never>;
  /** Seals the controller for ordinary reverse teardown without manufacturing a result. */
  close(): void;
  /** Seals the controller with a fatal error and no retry/acknowledgement. */
  abort(error: unknown): void;
  state(): ProductionGameTaskIngressState;
}>;

export type ProductionGameTaskIngressState = "sealed" | "ready" | "consumed" | "closing";

type ControllerOptions = Readonly<{
  nonceSha256: string;
  gameSessionId: string;
  piSessionId: string;
  dispatchTask(task: string): Promise<void>;
  transport?: ProductionGameTaskIngressTransport;
}>;

const READY_KEYS = ["gameSessionId", "kind", "nonceSha256", "piSessionId", "schema", "surface"] as const;
const DISPATCH_KEYS = [
  "gameSessionId",
  "kind",
  "nonceSha256",
  "piSessionId",
  "schema",
  "surface",
  "task",
] as const;

/** Returns a parsed immutable readiness record, or null for every protocol error. */
export function parseProductionGameTaskReady(value: unknown): ProductionGameTaskReadyV1 | null {
  if (!exactRecord(value, READY_KEYS)) return null;
  if (
    value.schema !== PRODUCTION_GAME_TASK_INGRESS_SCHEMA ||
    value.kind !== "ready" ||
    value.surface !== "game" ||
    !sha256(value.nonceSha256) ||
    !identifier(value.gameSessionId) ||
    !identifier(value.piSessionId)
  )
    return null;
  return Object.freeze({
    schema: PRODUCTION_GAME_TASK_INGRESS_SCHEMA,
    kind: "ready",
    surface: "game",
    nonceSha256: value.nonceSha256,
    gameSessionId: value.gameSessionId,
    piSessionId: value.piSessionId,
  });
}

/** Returns a parsed immutable dispatch record, or null for every protocol error. */
export function parseProductionGameTaskDispatch(value: unknown): ProductionGameTaskDispatchV1 | null {
  if (!exactRecord(value, DISPATCH_KEYS)) return null;
  if (
    value.schema !== PRODUCTION_GAME_TASK_INGRESS_SCHEMA ||
    value.kind !== "dispatch_task" ||
    value.surface !== "game" ||
    !sha256(value.nonceSha256) ||
    !identifier(value.gameSessionId) ||
    !identifier(value.piSessionId) ||
    !canonicalTask(value.task)
  )
    return null;
  return Object.freeze({
    schema: PRODUCTION_GAME_TASK_INGRESS_SCHEMA,
    kind: "dispatch_task",
    surface: "game",
    nonceSha256: value.nonceSha256,
    gameSessionId: value.gameSessionId,
    piSessionId: value.piSessionId,
    task: value.task,
  });
}

/**
 * Constructs the child-side one-shot consumer. The state transition to
 * `consumed` happens before calling the async facade seam, so a rejected worker
 * call and an ambiguous delivery can never be replayed.
 */
export function createProductionGameTaskIngressController(
  options: ControllerOptions,
): ProductionGameTaskIngressController {
  if (!sha256(options.nonceSha256)) throw new Error("game_task_ingress_nonce_invalid");
  if (!identifier(options.gameSessionId) || !identifier(options.piSessionId))
    throw new Error("game_task_ingress_session_invalid");
  if (typeof options.dispatchTask !== "function") throw new Error("game_task_ingress_dispatch_unavailable");

  const transport = options.transport ?? createProcessTransport();
  let currentState: ProductionGameTaskIngressState = "sealed";
  let removeMessageListener: (() => void) | undefined;
  let removeDisconnectListener: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let taskReject: ((error: Error) => void) | undefined;
  let taskResolve: (() => void) | undefined;
  let fatalReject: ((error: Error) => void) | undefined;
  let failed: Error | undefined;
  let taskConsumed = false;
  let startPromise: Promise<void> | undefined;
  let taskSettled = false;
  let fatalSettled = false;

  const task = new Promise<void>((resolve, reject) => {
    taskResolve = resolve;
    taskReject = reject;
  });
  // A fatal promise is intentionally observed by the main composition, but a
  // controller unit test or a close-only caller must not create an unhandled
  // rejection while reverse teardown is already sealing the child.
  const fatal = new Promise<never>((_resolve, reject) => {
    fatalReject = reject;
  });
  fatal.catch(() => undefined);

  const removeListeners = (): void => {
    const removeMessage = removeMessageListener;
    removeMessageListener = undefined;
    removeMessage?.();
    const removeDisconnect = removeDisconnectListener;
    removeDisconnectListener = undefined;
    removeDisconnect?.();
  };

  const rejectTask = (error: Error): void => {
    if (taskSettled) return;
    taskSettled = true;
    taskReject?.(error);
  };

  const resolveTask = (): void => {
    if (taskSettled) return;
    taskSettled = true;
    taskResolve?.();
  };

  const fail = (reason: unknown, fallback = "game_task_ingress_protocol_failure"): Error => {
    const error = asError(reason, fallback);
    if (currentState === "closing") return failed ?? error;
    failed = error;
    currentState = "closing";
    removeListeners();
    readyReject?.(error);
    readyReject = undefined;
    if (taskConsumed) rejectTask(error);
    if (!fatalSettled) {
      fatalSettled = true;
      fatalReject?.(error);
    }
    return error;
  };

  const onMessage = (message: unknown): void => {
    if (currentState !== "ready") {
      fail(new Error(currentState === "sealed" ? "game_task_ingress_before_ready" : "game_task_ingress_duplicate"));
      return;
    }
    const dispatch = parseProductionGameTaskDispatch(message);
    if (dispatch === null) {
      fail(new Error("game_task_ingress_dispatch_invalid"));
      return;
    }
    if (
      dispatch.nonceSha256 !== options.nonceSha256 ||
      dispatch.gameSessionId !== options.gameSessionId ||
      dispatch.piSessionId !== options.piSessionId
    ) {
      fail(new Error("game_task_ingress_dispatch_correlation_mismatch"));
      return;
    }

    // This is the child-side exactly-once linearization point. Do not move it
    // below Promise.resolve(), worker invocation, or any other async boundary.
    taskConsumed = true;
    currentState = "consumed";
    let dispatched: Promise<void>;
    try {
      dispatched = options.dispatchTask(dispatch.task);
    } catch (error) {
      fail(error, "game_task_ingress_dispatch_failed");
      return;
    }
    Promise.resolve(dispatched).then(
      () => resolveTask(),
      (error: unknown) => {
        fail(error, "game_task_ingress_dispatch_failed");
      },
    );
  };

  const onDisconnect = (): void => {
    fail(new Error("game_task_ingress_disconnect"));
  };

  const start = (): Promise<void> => {
    if (startPromise !== undefined) return startPromise;
    if (currentState !== "sealed") return Promise.reject(new Error("game_task_ingress_unavailable"));
    startPromise = new Promise<void>((resolve, reject) => {
      readyReject = reject;
      try {
        removeMessageListener = transport.onMessage(onMessage);
        removeDisconnectListener = transport.onDisconnect(onDisconnect);
        const ready = Object.freeze({
          schema: PRODUCTION_GAME_TASK_INGRESS_SCHEMA,
          kind: "ready" as const,
          surface: "game" as const,
          nonceSha256: options.nonceSha256,
          gameSessionId: options.gameSessionId,
          piSessionId: options.piSessionId,
        });
        let callbackSettled = false;
        const callback = (error: Error | null): void => {
          if (callbackSettled) return;
          callbackSettled = true;
          if (error !== null) {
            fail(error, "game_task_ingress_ready_delivery_failed");
            return;
          }
          if (currentState !== "sealed") return;
          currentState = "ready";
          readyReject = undefined;
          resolve();
        };
        if (!transport.sendReady(ready, callback)) {
          fail(new Error("game_task_ingress_ready_delivery_unavailable"));
        }
      } catch (error) {
        fail(error, "game_task_ingress_ready_delivery_failed");
      }
    });
    return startPromise;
  };

  const close = (): void => {
    if (currentState === "closing") return;
    currentState = "closing";
    removeListeners();
    const error = new Error("game_task_ingress_closed");
    readyReject?.(error);
    readyReject = undefined;
    if (taskConsumed) rejectTask(error);
  };

  return Object.freeze({
    start,
    task,
    fatal,
    close,
    abort: (error: unknown) => {
      fail(error, "game_task_ingress_aborted");
    },
    state: () => currentState,
  });
}

function createProcessTransport(): ProductionGameTaskIngressTransport {
  if (typeof process.send !== "function" || process.connected !== true)
    throw new Error("game_task_ingress_ipc_unavailable");
  return Object.freeze({
    sendReady: (message, callback) => process.send!(message, undefined, undefined, callback),
    onMessage: (listener) => {
      process.on("message", listener);
      return () => process.off("message", listener);
    },
    onDisconnect: (listener) => {
      process.on("disconnect", listener);
      return () => process.off("disconnect", listener);
    },
  });
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return false;
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function canonicalTask(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let scalarValues = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
    scalarValues += 1;
    if (scalarValues > 2_000) return false;
  }
  return scalarValues >= 1;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
