import { strict as assert } from "node:assert";
import test from "node:test";

import {
  PROMOTE_MS,
  PttKeyStateMachine,
  TAIL_MS,
  TYPING_COOLDOWN_MS,
} from "./ptt-key-state-machine.js";

test("PTT: a short tap in warmup is discarded and never reaches ASR", () => {
  const ptt = new PttKeyStateMachine();
  assert.deepEqual(ptt.keyDown(0), { kind: "preRollStart" });
  assert.equal(ptt.state, "warmup");
  assert.deepEqual(ptt.keyUp(PROMOTE_MS - 1), { kind: "tapDiscarded" });
  assert.equal(ptt.state, "idle");
  assert.equal(ptt.tick(PROMOTE_MS + TAIL_MS), undefined); // nothing to finalize
});

test("PTT: holding past the promote threshold promotes the pre-roll seamlessly", () => {
  const ptt = new PttKeyStateMachine();
  ptt.keyDown(0);
  assert.equal(ptt.state, "warmup");
  // Long hold: crossing the promote threshold without releasing keeps the
  // capture armed; the pre-roll is seamless (warmup never discards).
  ptt.keyUp(PROMOTE_MS + 10);
  assert.equal(ptt.state, "tail");
  assert.deepEqual(ptt.keyUp(PROMOTE_MS + 10), { kind: "tailRejected" });
});

test("PTT: release during capture starts the tail; re-press inside the window merges", () => {
  const ptt = new PttKeyStateMachine();
  ptt.keyDown(0);
  ptt.keyUp(PROMOTE_MS + 10); // -> tail
  assert.deepEqual(ptt.tick(PROMOTE_MS + 10 + TAIL_MS - 1), undefined);
  // Re-press inside the tail window merges into the same utterance.
  assert.deepEqual(ptt.keyDown(PROMOTE_MS + 10 + 100), { kind: "merged" });
  assert.equal(ptt.state, "capturing");
  ptt.keyUp(PROMOTE_MS + 10 + 200);
  assert.equal(ptt.state, "tail");
  assert.deepEqual(ptt.tick(PROMOTE_MS + 10 + 200 + TAIL_MS), { kind: "finalize" });
  assert.equal(ptt.state, "idle");
});

test("PTT: tail window finalizes exactly once after TAIL_MS", () => {
  const ptt = new PttKeyStateMachine();
  ptt.keyDown(0);
  ptt.keyUp(PROMOTE_MS + 10);
  assert.deepEqual(ptt.tick(PROMOTE_MS + 10 + TAIL_MS - 1), undefined);
  assert.deepEqual(ptt.tick(PROMOTE_MS + 10 + TAIL_MS), { kind: "finalize" });
  // Subsequent ticks are inert.
  assert.equal(ptt.tick(PROMOTE_MS + 10 + TAIL_MS + 1), undefined);
});

test("PTT: fast typing inside the cooldown window is ignored (spacebar suppress)", () => {
  const ptt = new PttKeyStateMachine();
  ptt.typing(0); // user is typing
  assert.deepEqual(ptt.keyDown(100), { kind: "cooldownIgnored" });
  assert.equal(ptt.state, "idle");
  assert.deepEqual(ptt.keyUp(100), { kind: "tailRejected" });
  // After the cooldown the key works again.
  assert.deepEqual(ptt.keyDown(TYPING_COOLDOWN_MS + 1), { kind: "preRollStart" });
  assert.equal(ptt.state, "warmup");
});

test("PTT: idle release never arms anything", () => {
  const ptt = new PttKeyStateMachine();
  assert.deepEqual(ptt.keyUp(50), { kind: "tailRejected" });
  assert.equal(ptt.state, "idle");
});

test("PTT: reset clears state, cooldown and tail window", () => {
  const ptt = new PttKeyStateMachine();
  ptt.typing(0);
  ptt.keyDown(10); // ignored by cooldown
  ptt.keyDown(TYPING_COOLDOWN_MS + 1);
  ptt.keyUp(TYPING_COOLDOWN_MS + 1 + PROMOTE_MS + 5);
  assert.equal(ptt.state, "tail");
  ptt.reset();
  assert.equal(ptt.state, "idle");
  assert.deepEqual(ptt.keyUp(1_000), { kind: "tailRejected" }); // no lingering tail
});