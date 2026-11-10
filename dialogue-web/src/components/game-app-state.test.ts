import assert from "node:assert/strict";
import test from "node:test";
import type { GameOperationFailure } from "../composed-problem-view";
import {
  busyOperationOf,
  GAME_ATTACHMENT_ATTACHED,
  gameAttachmentRows,
  type GameAttachmentEvent,
  type GameAttachmentOperation,
  type GameAttachmentState,
  reduceGameAttachment,
} from "./game-app-state";

/**
 * The Game surface's attachment state, driven through its own reducer.
 *
 * Three questions, in the order the module's doc answers them: which edges are legal (a table), what the
 * surface used to do with the same events (the interleaving cases, read from a model of the three
 * independent cells this replaces), and whether every phase the union can hold is a phase this reducer
 * and its readers have an answer for.
 */

const REFUSED: GameOperationFailure = Object.freeze({ kind: "refused", sentence: "The game could not be stopped." });
const UNSETTLED: GameOperationFailure = Object.freeze({ kind: "unsettled" });

const at = (phase: GameAttachmentState["phase"], extra = {}): GameAttachmentState =>
  Object.freeze({ phase, ...extra }) as GameAttachmentState;

const OPERATIONS: readonly GameAttachmentOperation[] = ["launch", "stop", "disconnect"];
const BUSY_PHASE: Record<GameAttachmentOperation, GameAttachmentState["phase"]> = {
  launch: "connecting",
  stop: "stopping",
  disconnect: "disconnecting",
};

/** Every state the union can hold, derived from its own phase record so a new phase is a compile error. */
const PHASES: Record<GameAttachmentState["phase"], GameAttachmentState> = {
  attached: GAME_ATTACHMENT_ATTACHED,
  connecting: at("connecting"),
  stopping: at("stopping"),
  disconnecting: at("disconnecting"),
  not_staged: at("not_staged"),
  failed: at("failed", { operation: "stop", failure: REFUSED }),
};

/** The legal edges: the state's phase, the event, and the phase it must produce (or `null` for "unchanged"). */
const EDGES: readonly (readonly [
  GameAttachmentState["phase"],
  GameAttachmentEvent,
  GameAttachmentState["phase"] | null,
])[] = [
  ...OPERATIONS.map((operation) => ["attached", { type: "started", operation }, BUSY_PHASE[operation]] as const),
  // A settled attempt supersedes the sentence it left.
  ...OPERATIONS.map((operation) => ["failed", { type: "started", operation }, BUSY_PHASE[operation]] as const),
  ["not_staged", { type: "started", operation: "launch" }, "connecting"] as const,
  ["not_staged", { type: "started", operation: "stop" }, "stopping"] as const,
  // Each busy phase ends where it started.
  ["connecting", { type: "finished" }, "attached"] as const,
  ["stopping", { type: "finished" }, "attached"] as const,
  ["disconnecting", { type: "finished" }, "attached"] as const,
  // A refusal belongs to the attempt that is standing.
  ["connecting", { type: "refused", operation: "launch", failure: REFUSED }, "failed"] as const,
  ["stopping", { type: "refused", operation: "stop", failure: UNSETTLED }, "failed"] as const,
  ["disconnecting", { type: "refused", operation: "disconnect", failure: REFUSED }, "failed"] as const,
  ["connecting", { type: "not_staged" }, "not_staged"] as const,
  // Illegal, and each returns the SAME value rather than a copy of it.
  ["attached", { type: "finished" }, null] as const,
  ["attached", { type: "not_staged" }, null] as const,
  ["attached", { type: "refused", operation: "stop", failure: REFUSED }, null] as const,
  ["stopping", { type: "started", operation: "launch" }, null] as const,
  ["stopping", { type: "started", operation: "stop" }, null] as const,
  ["disconnecting", { type: "started", operation: "disconnect" }, null] as const,
  ["failed", { type: "finished" }, null] as const,
  ["failed", { type: "refused", operation: "stop", failure: REFUSED }, null] as const,
  // A refusal for the operation that is NOT in flight is a message about an attempt that ended.
  ["stopping", { type: "refused", operation: "disconnect", failure: REFUSED }, null] as const,
  ["connecting", { type: "refused", operation: "stop", failure: REFUSED }, null] as const,
  ["stopping", { type: "not_staged" }, null] as const,
];

test("the legal edges, and the illegal ones that must not move the state", () => {
  for (const [phase, event, expected] of EDGES) {
    const state = PHASES[phase];
    const next = reduceGameAttachment(state, event);
    const label = `${phase} + ${event.type}${"operation" in event ? `(${event.operation})` : ""}`;
    if (expected === null) {
      assert.equal(next, state, `${label}: an illegal event must return the same value`);
      continue;
    }
    assert.equal(next.phase, expected, `${label} -> ${next.phase}`);
  }
});

/**
 * The three independent cells the surface held per operation, as the handlers and the panel read them.
 *
 * This is the code under replacement, modelled in the terms it was written in: `press` is the two
 * `setState`s a handler ran before its await, `settle`/`refuse` are the two a `finally`/`catch` ran after
 * it, and `active` is what each control's own `disabled` read.
 */
function legacyCells() {
  const active: Record<GameAttachmentOperation, boolean> = { launch: false, stop: false, disconnect: false };
  const failure: Record<GameAttachmentOperation, GameOperationFailure | null> = {
    launch: null,
    stop: null,
    disconnect: null,
  };
  return {
    press(operation: GameAttachmentOperation): void {
      active[operation] = true;
      failure[operation] = null;
    },
    settle(operation: GameAttachmentOperation): void {
      active[operation] = false;
    },
    refuse(operation: GameAttachmentOperation, refused: GameOperationFailure): void {
      failure[operation] = refused;
    },
    reading: () => ({ active: { ...active }, failure: { ...failure } }),
  };
}

test("before: two presses admit two commands and two spinners; after: the second is refused", () => {
  const legacy = legacyCells();
  legacy.press("stop");
  legacy.press("disconnect");
  const before = legacy.reading();
  // Both controls were enabled - each was disabled only by its own flag - and both commands went out
  // against the same attachment generation.
  assert.equal(before.active.stop && before.active.disconnect, true);

  const started = reduceGameAttachment(GAME_ATTACHMENT_ATTACHED, { type: "started", operation: "stop" });
  const stopped = reduceGameAttachment(started, { type: "started", operation: "disconnect" });
  assert.equal(stopped, started, "the second press must not move the state");
  const rows = gameAttachmentRows(stopped);
  assert.deepEqual(
    { stop: rows.stop.active, disconnect: rows.disconnect.active, blocked: rows.disconnect.blocked },
    { stop: true, disconnect: false, blocked: true },
  );
});

test("before: a refusal outlives its attempt; after: the next attempt supersedes it", () => {
  const legacy = legacyCells();
  legacy.press("stop");
  legacy.refuse("stop", REFUSED);
  legacy.settle("stop");
  legacy.press("launch");
  const before = legacy.reading();
  // The surface reports a failed Stop while a Launch is in flight - the sentence describes a session
  // the launch is replacing.
  assert.equal(before.failure.stop, REFUSED);
  assert.equal(before.active.launch, true);

  const refused = reduceGameAttachment(
    reduceGameAttachment(GAME_ATTACHMENT_ATTACHED, { type: "started", operation: "stop" }),
    { type: "refused", operation: "stop", failure: REFUSED },
  );
  const relaunched = reduceGameAttachment(reduceGameAttachment(refused, { type: "finished" }), {
    type: "started",
    operation: "launch",
  });
  const rows = gameAttachmentRows(relaunched);
  assert.equal(rows.launch.active, true);
  assert.equal(rows.stop.failure, null);
});

test("before: a late refusal paints a sentence after the attempt ended; after: it is dropped", () => {
  const legacy = legacyCells();
  legacy.press("disconnect");
  legacy.settle("disconnect");
  legacy.refuse("disconnect", REFUSED);
  assert.equal(legacy.reading().failure.disconnect, REFUSED);

  const settled = reduceGameAttachment(
    reduceGameAttachment(GAME_ATTACHMENT_ATTACHED, { type: "started", operation: "disconnect" }),
    { type: "finished" },
  );
  const late = reduceGameAttachment(settled, { type: "refused", operation: "disconnect", failure: REFUSED });
  assert.equal(late, settled);
  assert.equal(gameAttachmentRows(late).disconnect.failure, null);
});

test("every phase of the union has a busy answer and a row, so a new phase cannot read as idle", () => {
  const documented: Record<GameAttachmentState["phase"], GameAttachmentOperation | null> = {
    attached: null,
    connecting: "launch",
    stopping: "stop",
    disconnecting: "disconnect",
    not_staged: null,
    failed: null,
  };
  const phases = Object.keys(PHASES) as readonly GameAttachmentState["phase"][];
  for (const phase of phases) {
    const state = PHASES[phase];
    assert.equal(busyOperationOf(state), documented[phase], `${phase}: busy answer`);
    const rows = gameAttachmentRows(state);
    const active = OPERATIONS.filter((operation) => rows[operation].active);
    const expected = documented[phase];
    assert.deepEqual(active, expected === null ? [] : [expected], `${phase}: active rows`);
  }
  // `not_staged` is the launch row's own fact and nobody's refusal.
  const notStaged = gameAttachmentRows(at("not_staged"));
  assert.deepEqual(
    { launch: notStaged.launch.notStaged, stop: notStaged.stop.notStaged, blocked: notStaged.launch.blocked },
    { launch: true, stop: false, blocked: false },
  );
});
