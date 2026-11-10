import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_ACTIVITY_LINE,
  COMPANION_ACTIVITY_STATES,
  type CompanionActivityPoint,
  type CompanionActivityState,
} from "./companion-activity.js";
import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import { CompanionLoop } from "./companion-loop.js";

/**
 * THE SCRIPTED TURN, and what the player could have been shown while it ran.
 *
 * <p>
 * The shape is the measured life of a turn (`round39`): a wake creates it, the request goes out, her first words arrive,
 * a tool is dispatched, a native execution she started is still in flight after the tool returns, her words resume, and
 * the turn ends. Two turns are scripted rather than one because `idle` is a claim about the PUMP, and it can only be
 * true once the execution's terminal receipt has been delivered - which is what wakes the second turn. A single turn
 * ending in `idle` while its own execution was still running would be the defect this channel exists to make visible.
 * </p>
 */
type SessionEvent = Readonly<{
  type: string;
  message?: unknown;
  assistantMessageEvent?: unknown;
  toolCallId?: string;
  toolName?: string;
}>;

type ScriptedRun = Readonly<{
  /** The states the loop published, in order, from its own log lines. */
  states: readonly CompanionActivityState[];
  points: readonly CompanionActivityPoint[];
  /** Every serialized batch handed to Pi - the prompt assembly the model actually receives. */
  batches: readonly string[];
  /** Every piece the presentation port committed, in arrival order. */
  presented: readonly string[];
  /** Every line the channel wrote, verbatim, so a leak can be asserted against what was really published. */
  lines: readonly string[];
  startedAtMs: number;
}>;

const assistantSnapshot = (id: string) => ({ id, role: "assistant", content: [], stopReason: "pending" });

const textStart = (id: string) => ({
  type: "message_update",
  message: assistantSnapshot(id),
  assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistantSnapshot(id) },
});

/** A text part announced by `text_start`, then the delta: the projection accepts a delta only for an announced part. */
const textDelta = (id: string, value: string) => ({
  type: "message_update",
  message: assistantSnapshot(id),
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: value, partial: assistantSnapshot(id) },
});

function assistantMessage(id: string, parts: readonly string[], stopReason: string) {
  return {
    id,
    role: "assistant",
    content: [
      ...parts.map((value) => ({ type: "text", text: value })),
      ...(stopReason === "stop" ? [] : [{ type: "toolCall", id: "tool_1", name: "stardew_plan_work", arguments: {} }]),
    ],
    stopReason,
  };
}

function receipt(state: string, executionId: string, revision: number) {
  return {
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    eventId: `receipt_${state}_${String(revision)}`,
    correlationId: executionId,
    revision,
    executionId,
    payload: { state, actionId: "water_crop", revision },
  };
}

async function runScriptedTurns(): Promise<ScriptedRun> {
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const batches: string[] = [];
  const presented: string[] = [];
  const commentaries: string[] = [];
  let turnIndex = 0;
  let loop: CompanionLoop;
  const session = {
    async sendUserMessage(text: string) {
      batches.push(text);
      turnIndex += 1;
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      if (turnIndex === 1) {
        emit({ type: "message_start", message: assistantSnapshot("a1") });
        emit(textStart("a1"));
        emit(textDelta("a1", "先出门去农场。"));
        emit({ type: "message_end", message: assistantMessage("a1", ["先出门去农场。"], "toolUse") });
        emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "stardew_plan_work" });
        // A native execution has begun: the pump has never been handed its terminal receipt, so `busy` is the pump's
        // own answer at the end of the tool call and at the end of the turn.
        loop.pump.enqueueFact(receipt("running", "execution_water", 1));
        emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "stardew_plan_work" });
        emit({ type: "message_start", message: assistantSnapshot("a2") });
        emit(textStart("a2"));
        emit(textDelta("a2", "水浇好了。"));
        emit({ type: "message_end", message: assistantMessage("a2", ["水浇好了。"], "stop") });
      } else {
        emit({ type: "message_start", message: assistantSnapshot("a3") });
        emit(textStart("a3"));
        emit(textDelta("a3", "还有三块地。"));
        emit({ type: "message_end", message: assistantMessage("a3", ["还有三块地。"], "stop") });
      }
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: SessionEvent) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
  loop = new CompanionLoop(session as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push((content as { text: string }).text);
    },
  });
  // The commentary channel is captured before the first turn, so a reader of this test can see the exact sequence the
  // indicator published rather than a summary of it.
  const stderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    commentaries.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const startedAtMs = Date.now();
  try {
    loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "input_first",
      eventId: "player_source_first",
      text: "去把菜浇了",
      locale: "zh-CN",
      timestampMs: 1,
    });
    await loop.flush();
    // The execution settles. Its terminal receipt is a fact a turn is owed, which is the only way `idle` becomes true:
    // the second turn delivers it, and its end finds the pump empty.
    loop.pump.enqueueFact(receipt("succeeded", "execution_water", 2));
    await loop.flush();
  } finally {
    process.stderr.write = stderrWrite;
  }
  const lines = commentaries.join("").split("\n");
  const points: CompanionActivityPoint[] = [];
  for (const line of lines) {
    if (!line.startsWith(`${COMPANION_ACTIVITY_LINE} `)) continue;
    points.push(JSON.parse(line.slice(COMPANION_ACTIVITY_LINE.length + 1)) as CompanionActivityPoint);
  }
  return Object.freeze({
    states: points.map((point) => point.state),
    points: Object.freeze(points),
    batches: Object.freeze(batches),
    presented: Object.freeze(presented),
    lines: Object.freeze(lines.filter((line) => line.startsWith(`${COMPANION_ACTIVITY_LINE} `))),
    startedAtMs,
  });
}

/**
 * The exact order the two scripted turns produce, one entry per published transition.
 *
 * Every row of the machine appears, and the two repeats are deliberate rather than noise: `thinking` twice because the
 * turn's own creation and the request going out are different facts, `busy` twice because the tool's end and the turn's
 * end both read a pump that still holds an unsettled execution, and `speaking` twice because the turn speaks before a
 * tool call and again after it.
 */
const SCRIPTED_SEQUENCE: readonly CompanionActivityState[] = [
  "thinking", // turn created
  "thinking", // provider waiting: Pi consumed the batch, nothing back yet
  "speaking", // her first words
  "working", // a tool call is executing
  "busy", // the tool returned; her execution is still in flight
  "speaking", // her words resume
  "busy", // the turn ended with that execution unsettled
  "thinking", // the terminal receipt woke a second turn
  "thinking", // provider waiting
  "speaking", // her answer
  "idle", // the turn ended with nothing pending and nothing in flight
];

test("a scripted turn publishes every activity transition, in order, on one monotonic clock", async () => {
  const run = await runScriptedTurns();
  // Named, not counted: a missing transition has to say WHICH one, and a reordered one which position drifted. A bare
  // deepEqual on two short arrays costs the next reader a manual diff of the state names.
  assert.equal(
    run.states.length,
    SCRIPTED_SEQUENCE.length,
    `the run published ${String(run.states.length)} transitions, expected ${String(SCRIPTED_SEQUENCE.length)} - got ${run.states.join(" → ")}`,
  );
  const drifting = SCRIPTED_SEQUENCE.findIndex((state, index) => run.states[index] !== state);
  assert.equal(
    drifting,
    -1,
    `the first state that drifted is #${String(drifting)}: expected ${String(SCRIPTED_SEQUENCE[drifting])}, got ${String(run.states[drifting])} - got ${run.states.join(" → ")}`,
  );
  assert.equal(
    (run.points[0]?.atMs ?? Number.NaN) >= run.startedAtMs,
    true,
    "the first point lands on the run's own wall clock",
  );
  for (const [index, point] of run.points.entries()) {
    assert.equal(Number.isSafeInteger(point.atMs), true, `point ${String(index)} carries a wall-clock millisecond`);
    if (index > 0)
      assert.equal(
        point.atMs >= run.points[index - 1]!.atMs,
        true,
        `the clock never runs backwards: ${String(point.atMs)} after ${String(run.points[index - 1]!.atMs)}`,
      );
  }
});

test("no published state reaches the prompt Pi receives or the text the player is shown", async () => {
  const run = await runScriptedTurns();
  assert.equal(run.batches.length, 2, "the script ran two turns, so both prompts are the real assembly");
  for (const batch of run.batches)
    for (const line of run.lines)
      assert.equal(batch.includes(line), false, `the prompt carried an activity line: ${line}`);
  // The honest surface-level check on top of the exact lines: the channel never appears in the batch at all, under any
  // spelling, so a later refactor that renamed points could not slip one in as a JSON fragment.
  for (const batch of run.batches)
    assert.equal(batch.includes(COMPANION_ACTIVITY_LINE), false, "the prompt carries no activity channel");
  // The presented path: every piece is either this turn's registered reaction sound or one of her own two paragraphs.
  // A state that reached the bubble would be a piece nobody wrote, which is what rule "never in her voice" forbids.
  const sound = selectReactionSound("player_source_first", "zh-CN", GAME_DELIVERY_PACING.reaction!);
  const herWords = ["先出门去农场。", "水浇好了。", "还有三块地。"];
  assert.equal(
    run.presented.length > 0,
    true,
    "the scripted turn did present her text, so this assertion has a population",
  );
  for (const piece of run.presented)
    assert.equal(
      piece === sound || herWords.includes(piece),
      true,
      `a piece the companion never said was presented: ${JSON.stringify(piece)}`,
    );
  for (const piece of run.presented)
    assert.equal(
      (COMPANION_ACTIVITY_STATES as readonly string[]).includes(piece),
      false,
      `a bare state token reached the player as text: ${piece}`,
    );
});
