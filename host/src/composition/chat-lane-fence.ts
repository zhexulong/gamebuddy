/**
 * The in-flight use count of exactly one mounted Chat lane.
 *
 * A turn-level Chat switch replaces the whole lane - the state facade, the Chat pipeline service and
 * every management domain - because each of those services is built over one mounted lease. The
 * services are therefore closed while the shell's stable facades still resolve them, and a request
 * that resolved the lane before the switch is inside a store the switch is closing. Measured: the
 * read resumes on a closed connection and the route answers 500 instead of the Chat list.
 *
 * The lane owns one of these. `use` admits a request on the lane it resolved, `close` seals the lane
 * (no further admissions), waits for the last admitted use, and only then runs the lane's own close.
 * `close` never closes a store a use is inside, and it never silently proceeds past a use that will
 * not finish: the wait is bounded and a lane that does not drain is named with every use still open.
 */
export type ChatLaneFence = Readonly<{
  /**
   * Admits one use of the lane for as long as `read` runs. Admission happens in the caller's own tick,
   * so a request cannot slip between resolving the lane and being counted. Refuses with
   * `chat_lane_closed` once the lane has stopped admitting.
   */
  use<T>(label: string, read: () => Promise<T>): Promise<T>;
  /** Seals the lane, waits for every admitted use, then closes the lane's services. */
  close(): Promise<void>;
}>;

/**
 * Sized against the lane's own stores rather than against a guess: their connections carry a 5 s
 * `busy_timeout`, so a use still open after 30 s is not a read making slow progress - it is a lane
 * that will not drain. The close does not run in that case; the error names every use still inside.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** A lane that did not reach zero admitted uses: nothing was closed and every open use is named. */
export class ChatLaneDrainTimeoutError extends Error {
  readonly code = "chat_lane_drain_timeout" as const;
  readonly inFlight: readonly string[];
  readonly drainTimeoutMs: number;
  constructor(inFlight: readonly string[], drainTimeoutMs: number) {
    super(`chat_lane_drain_timeout:${inFlight.length}_in_flight_after_${drainTimeoutMs}ms:${inFlight.join(",")}`);
    this.name = "ChatLaneDrainTimeoutError";
    this.inFlight = Object.freeze([...inFlight]);
    this.drainTimeoutMs = drainTimeoutMs;
  }
}

/**
 * One lane's fence over `closeLane`, the lane's own reverse-order close. The fence holds that close,
 * so a lane cannot be closed without passing the barrier: the lane type exposes no other handle.
 */
export function createChatLaneFence(
  closeLane: () => Promise<void>,
  options: Readonly<{ drainTimeoutMs?: number }> = {},
): ChatLaneFence {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const inFlight = new Map<number, string>();
  let nextUseId = 0;
  let sealed = false;
  let drained: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  const release = (useId: number): void => {
    inFlight.delete(useId);
    if (inFlight.size !== 0) return;
    const resolve = drained;
    drained = undefined;
    resolve?.();
  };

  const waitForIdle = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        drained = undefined;
        reject(new ChatLaneDrainTimeoutError([...inFlight.values()], drainTimeoutMs));
      }, drainTimeoutMs);
      timer.unref?.();
      drained = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  return Object.freeze({
    async use<T>(label: string, read: () => Promise<T>): Promise<T> {
      if (sealed) throw new Error("chat_lane_closed");
      const useId = nextUseId++;
      inFlight.set(useId, label);
      try {
        return await read();
      } finally {
        release(useId);
      }
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      sealed = true;
      const attempt = (async () => {
        if (inFlight.size !== 0) await waitForIdle();
        await closeLane();
      })();
      closing = attempt;
      // A lane that timed out stays open and stays closeable: the services were never closed, so the
      // next attempt waits again instead of reporting a close that did not happen.
      void attempt.catch(() => {
        closing = undefined;
      });
      return attempt;
    },
  });
}
