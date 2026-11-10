/**
 * One execution slot: tasks run in the order they were pushed, one at a time, and a task that throws
 * cannot stop the queue.
 *
 * The shell's event stream is the reason this exists. Every frame it accepted was appended to a promise
 * chain (`work = work.then(...)`), which drains a burst slower than the socket fills it - the coalescing
 * `reconcile` pass is what makes the last frame win. But `then` chains one behaviour the code did not
 * state: a link that REJECTS stays rejected, so every later `then` is skipped. The socket keeps
 * delivering, `streamLiveRef` stays true, and the fallback poll - which exists for a turn the stream is
 * not delivering - is suspended because the stream looks live. A stream that looks live and delivers
 * nothing is the one shape nothing on the surface can report.
 *
 * So the queue owns that rule instead of a promise's semantics: a task's rejection is reported to
 * `onFailed` and the NEXT task still runs. `onFailed` throwing is not allowed to stop the drain either,
 * for the same reason one line up.
 */
export type SerialDrain = Readonly<{
  /** Queue one task behind everything already pushed. */
  push(task: () => Promise<void>): void;
  /** Resolves when everything pushed so far has finished, for tests and shutdown. */
  drained(): Promise<void>;
}>;

export function createSerialDrain(onFailed: () => void): SerialDrain {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(task) {
      tail = tail
        .then(task)
        // The rejection is the failure `onFailed` exists to answer; swallowing it here is what keeps the
        // queue a queue. The second `catch` is the same rule applied to `onFailed` itself.
        .catch(() => onFailed())
        .catch(() => undefined);
    },
    async drained() {
      // A task may push another (`recover` schedules its own retry), so "drained" is the tail it can no
      // longer overtake - not the promise that happened to be the tail when the question was asked.
      let current = tail;
      await current;
      while (current !== tail) {
        current = tail;
        await current;
      }
    },
  };
}
