/**
 * Phase 2 Slice 4 — FrameProcessorQueue (Pipecat-style priority frame queue,
 * deterministic core).
 *
 * Pure in-memory scheduling structure. Three priorities:
 *   System  (1)  — CancelSpeech / CancelCapture / STOP_ALL / HardwareFault.
 *                  Never queued: it bypasses the data queue entirely so a
 *                  cancel acts on the very next tick (1ms-class latency is a
 *                  scheduling property the device layer must honor).
 *   Control (10) — SetVoiceProfile / ducking / flush.
 *   Data    (20) — AudioPCM chunks / TTS audio / assistant token deltas.
 *
 * reset() drains every queued Control/Data frame so an interruption never
 * plays audio already pronounced stale. Frames are immutable; the queue owns
 * no provider, mixer, Chat or Game state.
 */
export const FRAME_PRIORITY = Object.freeze({
  system: 1,
  control: 10,
  data: 20,
} as const);

export type FramePriority = 1 | 10 | 20;

export type VoiceFrame = Readonly<{
  priority: FramePriority;
  id: string;
  kind: string;
  seq: number;
}>;

/**
 * Strict weak ordering for the data queue: higher priority first, FIFO within
 * the same priority. System frames (priority 1) never enter the queue.
 */
export function frameComesBefore(left: VoiceFrame, right: VoiceFrame): boolean {
  if (left.priority !== right.priority) return left.priority < right.priority;
  return left.seq < right.seq;
}

export class FrameProcessorQueue {
  #frames: VoiceFrame[] = [];
  #maxQueued: number;
  #systemServed = 0;
  #totalServed = 0;

  public constructor(maxQueued = 256) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new Error("invalid_frame_queue_capacity");
    this.#maxQueued = maxQueued;
  }

  public get size(): number {
    return this.#frames.length;
  }
  public get systemFramesServed(): number {
    return this.#systemServed;
  }
  public get totalFramesServed(): number {
    return this.#totalServed;
  }

  /**
   * Returns `true` when the frame ran immediately (system priority), `false`
   * when it was queued. The caller owns `seq` (its monotonic issue order);
   * FIFO within a priority follows `seq`. Queuing beyond capacity drops the
   * *oldest* data frame (back-pressure safety: newest audio wins over
   * already-pronounced audio).
   */
  public push(frame: VoiceFrame): boolean {
    if (frame.priority === FRAME_PRIORITY.system) {
      this.#systemServed += 1;
      this.#totalServed += 1;
      return true;
    }
    if (this.#frames.length >= this.#maxQueued) {
      // Drop the head of the queue: it is the oldest queued audio with the
      // same/lowest priority; a cancel may already be on its way.
      this.#frames.shift();
    }
    this.#frames.push(frame);
    this.#frames.sort((left, right) => (frameComesBefore(left, right) ? -1 : frameComesBefore(right, left) ? 1 : 0));
    return false;
  }

  /** Pop the next queued frame under the given priority ceiling (exclusive). */
  public pop(priorityCeiling: FramePriority = FRAME_PRIORITY.data): VoiceFrame | undefined {
    if (this.#frames.length === 0) return undefined;
    // Only system frames are served below the data ceiling; control frames are
    // served at their own priority, still FIFO-ordered behind system frames.
    if (this.#frames[0]!.priority === FRAME_PRIORITY.system) {
      const frame = this.#frames.shift()!;
      this.#totalServed += 1;
      return frame;
    }
    const index = this.#frames.findIndex((candidate) => candidate.priority <= priorityCeiling);
    if (index < 0) return undefined;
    const [frame] = this.#frames.splice(index, 1);
    this.#totalServed += 1;
    return frame;
  }

  /** Drain every queued Control/Data frame; system frames are never queued. */
  public reset(): number {
    const count = this.#frames.length;
    this.#frames = [];
    return count;
  }
}