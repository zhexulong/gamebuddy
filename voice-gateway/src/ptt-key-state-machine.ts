/**
 * Phase 2 Slice 3 — dual-track PTT key state machine (pre-recording warmup,
 * seamless promote, tail recording, typing cooldown).
 *
 * Pure in-memory state machine with an injected clock: deterministic and
 * fully testable without hardware. It owns no device, ASR or queue — it only
 * decides *when* capture should be (a) discarded as a keypress, (b) promoted
 * to a real utterance, or (c) finalized after a release tail.
 *
 * States:
 *   idle        — no PTT activity.
 *   warmup      — key held < PROMOTE_MS; audio may be pre-buffered but a short
 *                 tap discards it (never reaches ASR).
 *   capturing   — key held >= PROMOTE_MS; the pre-roll promotes seamlessly so
 *                 the first syllable is not swallowed by cold-start.
 *   tail        — key released: recording continues up to TAIL_MS to absorb
 *                 trailing syllables; a re-press inside the window merges back
 *                 into capturing (single utterance segment).
 *
 * Typing cooldown: a keyDown within TYPING_COOLDOWN_MS after a typing event is
 * ignored entirely (spacebar during coding must not trigger voice capture).
 *
 * Clock contract: every method takes `nowMs` so behavior is deterministic in
 * tests; the machine never reads Date.now() itself.
 */
export const TYPING_COOLDOWN_MS = 400;
export const PROMOTE_MS = 700;
export const TAIL_MS = 1_200;

export type PttKeyHook =
  | Readonly<{ kind: "preRollStart" }> // enter warmup; device may pre-buffer
  | Readonly<{ kind: "promote" }> // warmup -> capturing; seamless ASR start
  | Readonly<{ kind: "tapDiscarded" }> // warmup released early; drop pre-roll
  | Readonly<{ kind: "tailStart" }> // release while capturing; keep recording
  | Readonly<{ kind: "tailRejected" }> // release while not capturing (no-op)
  | Readonly<{ kind: "merged" }> // re-press inside tail; same utterance
  | Readonly<{ kind: "finalize" }> // tail window elapsed; emit final text
  | Readonly<{ kind: "cooldownIgnored" }>; // keyDown suppressed by typing cooldown

export class PttKeyStateMachine {
  #state: "idle" | "warmup" | "capturing" | "tail" = "idle";
  #lastTypingAtMs: number | undefined;
  #lastKeyDownAtMs: number | undefined;
  #lastReleaseAtMs: number | undefined;

  public get state(): "idle" | "warmup" | "capturing" | "tail" {
    return this.#state;
  }

  public reset(): void {
    this.#state = "idle";
    this.#lastTypingAtMs = undefined;
    this.#lastKeyDownAtMs = undefined;
    this.#lastReleaseAtMs = undefined;
  }

  /** A keyboard input was detected; suppress PTT for the cooldown window. */
  public typing(nowMs: number): void {
    this.#lastTypingAtMs = nowMs;
  }

  public keyDown(nowMs: number): PttKeyHook {
    // Typing cooldown: ignore the press entirely.
    if (
      this.#lastTypingAtMs !== undefined &&
      nowMs - this.#lastTypingAtMs < TYPING_COOLDOWN_MS
    )
      return Object.freeze({ kind: "cooldownIgnored" });

    if (this.#state === "tail" && this.#lastReleaseAtMs !== undefined && nowMs - this.#lastReleaseAtMs < TAIL_MS) {
      this.#state = "capturing";
      this.#lastKeyDownAtMs = nowMs;
      return Object.freeze({ kind: "merged" });
    }

    this.#state = "warmup";
    this.#lastKeyDownAtMs = nowMs;
    return Object.freeze({ kind: "preRollStart" });
  }

  public keyUp(nowMs: number): PttKeyHook {
    if (this.#state === "warmup") {
      if (this.#lastKeyDownAtMs === undefined || nowMs - this.#lastKeyDownAtMs < PROMOTE_MS) {
        this.#state = "idle";
        return Object.freeze({ kind: "tapDiscarded" });
      }
      this.#state = "tail";
      this.#lastReleaseAtMs = nowMs;
      return Object.freeze({ kind: "tailStart" });
    }
    if (this.#state === "capturing") {
      this.#state = "tail";
      this.#lastReleaseAtMs = nowMs;
      return Object.freeze({ kind: "tailStart" });
    }
    if (this.#state === "tail") {
      // Repeated release without a press is a no-op.
      return Object.freeze({ kind: "tailRejected" });
    }
    // idle release: no capture was ever armed.
    return Object.freeze({ kind: "tailRejected" });
  }

  /**
   * Advance the machine's clocks. Caller drives this from its own event loop;
   * returns the single terminal transition when the tail window elapses.
   */
  public tick(nowMs: number): PttKeyHook | undefined {
    if (this.#state !== "tail") return undefined;
    if (this.#lastReleaseAtMs === undefined) return undefined;
    if (nowMs - this.#lastReleaseAtMs < TAIL_MS) return undefined;
    this.#state = "idle";
    return Object.freeze({ kind: "finalize" });
  }
}