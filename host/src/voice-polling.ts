export type VoicePollingPort = Readonly<{
  pollEvents: () => Promise<void>;
}>;

export type VoicePollingErrorCode =
  | "voice_gateway_disconnected"
  | "voice_gateway_response_timeout"
  | "voice_gateway_socket_error"
  | "voice_gateway_closed"
  | "voice_event_cursor_expired"
  | "invalid_voice_gateway_events"
  | "voice_session_required"
  | "voice_gateway_protocol_error"
  | "voice_poll_failed";

export type VoicePollingStatus = "running" | "stopped" | "closed";

export type VoicePollingErrorState = Readonly<{
  code: VoicePollingErrorCode;
  timestampMs: number;
  count: number;
}>;

/**
 * Deliberately redacted, Host-local health state for the voice event poller.
 * This state contains no transport objects, error values, or event payloads.
 */
export type VoicePollingState = Readonly<{
  status: VoicePollingStatus;
  pollCount: number;
  successCount: number;
  failureCount: number;
  lastSuccessAtMs: number | null;
  lastError: VoicePollingErrorState | null;
}>;

type TimerHandle = ReturnType<typeof setInterval>;
type SetInterval = (callback: () => void, delayMs: number) => TimerHandle;
type ClearInterval = (handle: TimerHandle) => void;

export type VoicePollingSupervisorOptions = Readonly<{
  intervalMs?: number;
  now?: () => number;
  setInterval?: SetInterval;
  clearInterval?: ClearInterval;
}>;

const ALLOWED_ERROR_CODES = new Set<string>([
  "voice_gateway_disconnected",
  "voice_gateway_response_timeout",
  "voice_gateway_socket_error",
  "voice_gateway_closed",
  "voice_event_cursor_expired",
  "invalid_voice_gateway_events",
  "voice_session_required",
  "voice_gateway_protocol_error",
]);

function redactedErrorCode(error: unknown): VoicePollingErrorCode {
  // Only an exact, allowlisted string can cross into the diagnostic state. In
  // particular, never retain Error objects, messages, or their stack traces.
  const candidate =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
  return typeof candidate === "string" && ALLOWED_ERROR_CODES.has(candidate)
    ? (candidate as VoicePollingErrorCode)
    : "voice_poll_failed";
}

function initialState(): VoicePollingState {
  return {
    status: "stopped",
    pollCount: 0,
    successCount: 0,
    failureCount: 0,
    lastSuccessAtMs: null,
    lastError: null,
  };
}

/**
 * Owns the Host voice-event polling timer. Poll requests are serialized, and
 * the first transport/protocol/cursor failure terminally stops this poller.
 * There is intentionally no reconnect or cursor reset policy here.
 */
export class VoicePollingSupervisor {
  readonly #port: VoicePollingPort;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #setInterval: SetInterval;
  readonly #clearInterval: ClearInterval;
  #timer: TimerHandle | undefined;
  #pollInFlight: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #state: VoicePollingState = initialState();

  public constructor(port: VoicePollingPort, options: VoicePollingSupervisorOptions = {}) {
    this.#port = port;
    this.#intervalMs = options.intervalMs ?? 200;
    this.#now = options.now ?? Date.now;
    this.#setInterval = options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.#clearInterval = options.clearInterval ?? ((timer) => clearInterval(timer));
    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) throw new Error("invalid_voice_poll_interval");
  }

  public get state(): VoicePollingState {
    const error = this.#state.lastError;
    return {
      ...this.#state,
      ...(error === null ? { lastError: null } : { lastError: { ...error } }),
    };
  }

  public start(): void {
    if (this.#timer !== undefined || this.#state.status !== "stopped") return;
    this.#state = { ...this.#state, status: "running" };
    this.#timer = this.#setInterval(() => {
      void this.pollNow();
    }, this.#intervalMs);
  }

  /** Run one poll barrier immediately; useful for deterministic callers/tests. */
  public pollNow(): Promise<void> {
    if (this.#state.status !== "running") return Promise.resolve();
    if (this.#pollInFlight !== undefined) return this.#pollInFlight;
    let request: Promise<void>;
    try {
      request = this.#port.pollEvents();
    } catch (error) {
      request = Promise.reject(error);
    }
    const poll = request
      .then(
        () => {
          this.#state = {
            ...this.#state,
            successCount: this.#state.successCount + 1,
            pollCount: this.#state.pollCount + 1,
            lastSuccessAtMs: this.#now(),
          };
        },
        (error: unknown) => {
          const failureCount = this.#state.failureCount + 1;
          this.#state = {
            ...this.#state,
            status: this.#state.status === "closed" ? "closed" : "stopped",
            pollCount: this.#state.pollCount + 1,
            failureCount,
            lastError: {
              code: redactedErrorCode(error),
              timestampMs: this.#now(),
              count: failureCount,
            },
          };
          this.#disposeTimer();
        },
      )
      .finally(() => {
        this.#pollInFlight = undefined;
      });
    this.#pollInFlight = poll;
    return poll;
  }

  /** Stop scheduling and wait for an already-started request to drain. */
  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = { ...this.#state, status: "closed" };
    this.#disposeTimer();
    this.#closePromise = (this.#pollInFlight ?? Promise.resolve()).then(() => undefined);
    return this.#closePromise;
  }

  #disposeTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export function createVoicePollingSupervisor(
  port: VoicePollingPort,
  options?: VoicePollingSupervisorOptions,
): VoicePollingSupervisor {
  return new VoicePollingSupervisor(port, options);
}

type ShutdownOperation = () => void | Promise<void>;

type HostShutdownLifecycleOptions = Readonly<{
  stopPolling?: ShutdownOperation;
  detachVoice?: ShutdownOperation;
  closeVoice?: ShutdownOperation;
  closeConnected: ShutdownOperation;
}>;

/**
 * Orders Host shutdown around the continuity return boundary. Each resource
 * operation is invoked at most once, while every operation is still attempted
 * when another operation fails. Errors are returned for the caller to classify
 * as cleanup errors; they never prevent the remaining teardown operations.
 */
export type HostShutdownLifecycle = Readonly<{
  prepareForReturn: () => Promise<readonly unknown[]>;
  cleanup: () => Promise<readonly unknown[]>;
}>;

export function createHostShutdownLifecycle(options: HostShutdownLifecycleOptions): HostShutdownLifecycle {
  const operations: ShutdownOperation[] = [
    options.stopPolling ?? (() => undefined),
    options.detachVoice ?? (() => undefined),
    options.closeVoice ?? (() => undefined),
    options.closeConnected,
  ];
  const promises: Array<Promise<void> | undefined> = [];
  const runOnce = (index: number): Promise<void> => {
    const existing = promises[index];
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(() => operations[index]());
    promises[index] = operation;
    return operation;
  };
  let preparation: Promise<readonly unknown[]> | undefined;
  let cleanup: Promise<readonly unknown[]> | undefined;
  const attempt = async (index: number, errors: unknown[]): Promise<void> => {
    try {
      await runOnce(index);
    } catch (error) {
      errors.push(error);
    }
  };
  const prepareForReturn = (): Promise<readonly unknown[]> => {
    if (preparation !== undefined) return preparation;
    preparation = (async () => {
      const errors: unknown[] = [];
      // Polling must be stopped and an in-flight poll drained before the voice
      // source is detached, and both must finish before returnToChat starts.
      await attempt(0, errors);
      await attempt(1, errors);
      return errors;
    })();
    return preparation;
  };
  const cleanupResources = (): Promise<readonly unknown[]> => {
    if (cleanup !== undefined) return cleanup;
    cleanup = (async () => {
      const errors: unknown[] = [];
      await prepareForReturn();
      await attempt(2, errors);
      await attempt(3, errors);
      return errors;
    })();
    return cleanup;
  };
  return Object.freeze({ prepareForReturn, cleanup: cleanupResources });
}
