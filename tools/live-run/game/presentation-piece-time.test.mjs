// One epoch for everything a run publishes about when the player saw something.
//
// WHY (measured 2026-11-17, round67): `AGENT_PRESENTATION_PIECE {"index":9,"elapsedMs":256503}` was printed at the same
// moment the run's own bridge diagnostic said `elapsedMs: 278984`. All ten of that run's pieces were 22.5 s early because
// the field measured from `turnStartedAtMs` while everything else measures from the run's base. round23's audit had
// already recorded the same class of defect (`pieceAtMs` off by 12.4 minutes), which is why the moment is now derived in
// one place instead of at the call site.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { describePresentationPiece } from "./presentation-piece-time.mjs";

/** round67's own numbers: the run's base, the turn's start, and the piece that was published 22.5 s early. */
const ROUND67 = Object.freeze({
  runStartedAtMs: 1794942550211,
  turnStartedAtMs: 1794942550211 + 22481,
  committedAtMs: 1794942550211 + 278984,
  loggedElapsedMs: 256503,
});

test("round67's piece is placed on the run's clock, not the turn's", () => {
  const { line, piece } = describePresentationPiece({ index: 9, chars: 53, ...ROUND67 });
  assert.equal(line.elapsedMs, 278_984, "the run's own base, the same one BRIDGE_DIAGNOSTIC printed at that instant");
  assert.equal(
    line.sinceTurnStartMs,
    256_503,
    "and the field that used to be called elapsedMs, named for what it measures",
  );
  assert.equal(line.atMs, ROUND67.committedAtMs, "the absolute moment reaches the log, not only the bundle");
  assert.equal(piece.atMs, ROUND67.committedAtMs, "and the bundle record, which carried no absolute clock at all");
  assert.equal(piece.sinceTurnStartMs, 256_503);
});

test("the falsifier: the old formula is exactly the turn's offset early, which is what the audit measured", () => {
  const turnOffsetMs = ROUND67.turnStartedAtMs - ROUND67.runStartedAtMs;
  assert.equal(turnOffsetMs, 22_481, "round67's turn opened 22.481 s into the run");
  // The old reading, reproduced: same instant, measured from the turn's start.
  const oldElapsedMs = ROUND67.committedAtMs - ROUND67.turnStartedAtMs;
  assert.equal(oldElapsedMs, ROUND67.loggedElapsedMs, "the log line this gate exists for, reproduced from the numbers");
  const { line } = describePresentationPiece({ index: 9, chars: 53, ...ROUND67 });
  assert.equal(
    oldElapsedMs,
    line.elapsedMs - turnOffsetMs,
    "so a reader joining pieces to the run clock was off by exactly the turn's own offset",
  );
});

test("a piece that cannot be placed is refused rather than placed wrongly", () => {
  assert.throws(
    () => describePresentationPiece({ index: 0, chars: 3, committedAtMs: 5, runStartedAtMs: undefined }),
    /base clock/u,
  );
  assert.throws(
    () => describePresentationPiece({ index: 0, chars: 3, committedAtMs: null, runStartedAtMs: 1 }),
    /committed/u,
  );
});

test("a piece presented before any turn started is not given an invented turn offset", () => {
  const { line, piece } = describePresentationPiece({
    index: 0,
    chars: 12,
    committedAtMs: 1_000,
    runStartedAtMs: 900,
    turnStartedAtMs: null,
  });
  assert.equal(line.elapsedMs, 100);
  assert.equal(line.sinceTurnStartMs, null, "null is 'no turn was open', never a zero that reads as instant");
  assert.equal(piece.sinceTurnStartMs, null);
});

test("the runner publishes the derived pair, on the run's base, and keeps no second epoch", () => {
  const source = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url))), "run-stardew-native-local-agent-ab-live.mjs"),
    "utf8",
  );
  // The base is the same constant `BRIDGE_DIAGNOSTIC` and the result's own `startedAtMs` use, so a piece can be joined to
  // them. Naming it here is what makes a future call site with a different base fail.
  assert.match(source, /runStartedAtMs: phaseTimings\.runStartedAtMs,/u);
  assert.match(
    source,
    /JSON\.stringify\(pieceTime\.line\)/u,
    "the log line is the derived one, not an object rebuilt beside it",
  );
  assert.match(
    source,
    /firstPieceTtfbMs: presentationPieces\.length > 0 \? presentationPieces\[0\]\.sinceTurnStartMs/u,
  );
  assert.doesNotMatch(
    source,
    /elapsedMs: turnStartedAtMs === null \? null : Date\.now\(\) - turnStartedAtMs/u,
    "the turn-relative formula must not come back: it is the defect this file measures",
  );
});
