import assert from "node:assert/strict";
import test from "node:test";
import { CompanionLoop, NO_SPEECH_SURFACE_BLOCK } from "./companion-loop.js";
import { FACT_PRODUCER, FACT_TURN_CONSEQUENCE, NOT_OWED, type WorldFact } from "./event-pump.js";
import { PRESENTATION_LEASE_KINDS, presentationSourceOf } from "./presentation-lease.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND } from "./program-settlement-digest.js";

/**
 * THE DELIVERY-SEAM HALF OF THE SURFACE GATE: a turn reaches the provider only when the player's surface can show its
 * answer, and the record says so.
 *
 * <p>
 * MEASURED 2026-11-17 (`round66`, final account): `turns opened 40 · bubbles delivered 30 · lost 12
 * {no_presentation_lease: 12}`. The old reading of this file was a biconditional on the turn - "text on a turn the surface
 * cannot show" and "a silence order on a turn it does admit" - and it could be satisfied by the statement alone, which is
 * what `round66` then did: every one of the twelve unadmitted turns was TOLD its words would not be shown, and it wrote them
 * anyway. A rule that says "you may not speak" is not a delivery; the answer had to move upstream, to whether the turn is
 * invited at all.
 * </p>
 * <p>
 * So the property is now stated where the run measured it: for every decision shape the classification declares, the turn is
 * EITHER delivered and admitted (the bubble the player reads) OR not delivered at all (carried into the next turn that can
 * present, proved by `event-pump.turn-surface.test.ts`). There is no third state in which the provider is asked for words
 * nobody will see.
 * </p>
 * <p>
 * THE POPULATION IS DERIVED. The decision half is `FACT_TURN_CONSEQUENCE` (built from `EXECUTION_STATES`, the held and wake
 * tables and `SETTLED_PROGRAM_OUTCOMES`), and the admitted half is `PRESENTATION_LEASE_KINDS` - both the pump's and the
 * loop's own declarations, not copies.
 * </p>
 */

type SessionEvent = { type: string; message?: unknown; assistantMessageEvent?: unknown };

const SPOKEN = "我把这块地收拾了。";

/** A Pi session that keeps the batch it was handed and answers it with one text part. */
function speakingSession(received: string[]) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(batch: string) {
      received.push(batch);
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
      // The shape Pi's own stream has: the assistant message starts, its text arrives as a delta, and the final content
      // lands at `message_end`. The projection reads the COMMITTED text, so a session that only emitted the end event
      // would answer `nothing_to_say` and this gate would be measuring the fixture instead of the product.
      const snapshot = { id: "assistant_turn", role: "assistant", content: [], stopReason: "pending" };
      emit({ type: "message_start", message: snapshot });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
      });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: SPOKEN, partial: snapshot },
      });
      emit({
        type: "message_end",
        message: {
          id: "assistant_turn",
          role: "assistant",
          content: [{ type: "text", text: SPOKEN }],
          stopReason: "stop",
        },
      });
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
}

/**
 * One flush of the real loop: what the model read, and the loop's own delivery record when a turn was delivered at all.
 *
 * `delivered: false` is a STATE, not a failure: the pump answered `not_owed` and the fact waits for a turn that can present.
 */
type FlushReading = Readonly<{
  delivered: boolean;
  text: string;
  admitted: boolean;
  toldCannotSpeak: boolean;
  bubbles: number;
  withheld: string | undefined;
  carried: readonly string[];
  noSurfaceShapes: Readonly<Record<string, number>>;
}>;

async function flushOf(fact: WorldFact | undefined, playerSource: string | undefined): Promise<FlushReading> {
  const received: string[] = [];
  const loop = new CompanionLoop(speakingSession(received) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent() {},
  });
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    if (playerSource !== undefined) {
      loop.pump.enqueuePlayerInput({
        source: "player_text",
        inputId: "input_gate",
        eventId: playerSource,
        text: "去把菜收了",
        locale: "zh-CN",
        timestampMs: 1,
      });
    } else if (fact !== undefined) {
      loop.pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
    }
    await loop.flush();
  } finally {
    process.stderr.write = stderrWrite;
  }
  const noSurfaceShapes = { ...loop.pump.turnAccount.noSurface };
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  if (line === undefined) {
    assert.deepEqual(
      received,
      [],
      `a turn that printed no delivery record must not have reached the model: ${printed}`,
    );
    return Object.freeze({
      delivered: false,
      text: "",
      admitted: false,
      toldCannotSpeak: false,
      bubbles: 0,
      withheld: undefined,
      carried: [],
      noSurfaceShapes,
    });
  }
  const record = JSON.parse(line.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)) as {
    bubbles: number;
    withheld?: string;
    lease: { admitted: boolean };
    carried: readonly string[];
  };
  assert.equal(received.length, 1, `a delivered turn reaches the model exactly once, got ${String(received.length)}`);
  const text = received[0] ?? "";
  return Object.freeze({
    delivered: true,
    text,
    admitted: record.lease.admitted,
    toldCannotSpeak: text.includes(`<${NO_SPEECH_SURFACE_BLOCK}>`),
    bubbles: record.bubbles,
    withheld: record.withheld,
    carried: record.carried,
    noSurfaceShapes,
  });
}

function worldFactOf(kind: string, sourceEventId = `fact_${kind}`): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `event_${kind}`,
    sourceEventId,
    correlationId: `fact_${kind}`,
    revision: 1,
    occurredAtMs: 5,
    semanticKind: kind,
    payload: { kind },
  };
}

function receiptOf(state: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `receipt_${state}`,
    correlationId: `receipt_${state}`,
    revision: 1,
    occurredAtMs: 5,
    executionId: `exec_${state}`,
    requestId: `request_${state}`,
    payload: {
      actionId: "harvest_crop",
      state,
      reasonCode: "crop_harvested",
      revision: 1,
      evidence: null,
      origin: { kind: "programme", programId: "plan_1", nodeId: "n001" },
    },
  };
}

function semanticEventOf(kind: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `semantic_${kind}`,
    correlationId: `semantic_${kind}`,
    revision: 1,
    occurredAtMs: 5,
    payload: { kind, revision: 1, reasonCode: "body_trace" },
  };
}

function settlementOf(outcome: string): WorldFact {
  const won = outcome === "succeeded";
  return {
    source: "host_game_session",
    kind: "world_fact",
    eventId: "program_settled_plan_1",
    sourceEventId: "program_settled_plan_1",
    correlationId: "program_settled_plan_1",
    revision: 0,
    occurredAtMs: 5,
    semanticKind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
    payload: {
      kind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
      programId: "plan_1",
      settledAtMs: 4,
      total: 1,
      counts: won ? { succeeded: 1 } : { rejected: 1 },
      ok: won,
      reason: won ? null : "#0 harvest_crop:rejected",
      summary: won ? "1/1 完成" : "0/1 完成",
      nodes: [],
      omitted: 0,
    },
  };
}

function lifecycleFact(): WorldFact {
  return {
    source: "host_transport",
    kind: "lifecycle",
    eventId: "lifecycle_adapter_offline",
    correlationId: "lifecycle_adapter_offline",
    revision: 1,
    occurredAtMs: 5,
    payload: { kind: "disconnected" },
  };
}

function factOfShape(shape: string): WorldFact {
  if (shape.startsWith("receipt:")) return receiptOf(shape.slice("receipt:".length));
  if (shape.startsWith("semantic:")) return semanticEventOf(shape.slice("semantic:".length));
  if (shape.startsWith("settled:")) return settlementOf(shape.slice("settled:".length));
  if (shape === "lifecycle") return lifecycleFact();
  return worldFactOf("modal_presented");
}

/** One case per decision shape, plus the presentable end of the plain `world_fact` shape (see the pump-side gate). */
function decisionCases(): readonly Readonly<{ label: string; fact: WorldFact }>[] {
  const shapes = Object.entries(FACT_TURN_CONSEQUENCE)
    .filter(([, consequence]) => consequence === "decision")
    .map(([shape]) => shape);
  const cases = shapes.map((shape) => Object.freeze({ label: shape, fact: factOfShape(shape) }));
  for (const kind of PRESENTATION_LEASE_KINDS)
    if (kind !== PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND)
      cases.push(Object.freeze({ label: `world_fact:${kind}`, fact: worldFactOf(kind) }));
  return Object.freeze(cases);
}

test("a_turn_is_delivered_only_where_its_text_can_be_shown", async () => {
  const cases = decisionCases();
  assert.ok(cases.length > 0, "turns examined 0: the classification declares no decision shape");
  assert.ok(PRESENTATION_LEASE_KINDS.length > 0, "turns examined 0: the lease list is empty");

  const delivered: string[] = [];
  const carried: string[] = [];
  const violations: string[] = [];

  // The player's own words are the other admission, and they are not a fact kind at all: their lease comes from the ingress
  // (`HostService.acceptPlayerInput` refuses a non-opaque `sourceEventId`).
  for (const { label, fact } of [
    ...cases,
    Object.freeze({ label: "player_input", fact: undefined as WorldFact | undefined }),
  ]) {
    const reading = await flushOf(fact, fact === undefined ? "player_source_gate" : undefined);
    if (!reading.delivered) {
      const shapes = Object.keys(reading.noSurfaceShapes);
      if (!reading.admitted && fact !== undefined) carried.push(`${label} {${shapes.join(", ")}}`);
      else violations.push(`${label}: no turn, and nothing was accounted for`);
      continue;
    }
    delivered.push(label);
    if (!reading.admitted)
      violations.push(`${label}: delivered with no lease (carried ${JSON.stringify(reading.carried)})`);
    if (reading.toldCannotSpeak) violations.push(`${label}: told its words would not be shown`);
    if (reading.bubbles !== 1) violations.push(`${label}: committed ${String(reading.bubbles)} bubbles`);
    if (reading.withheld !== undefined) violations.push(`${label}: withheld ${reading.withheld}`);
  }

  const tally = `turns examined ${String(cases.length + 1)} · delivered-and-admitted ${String(delivered.length)} · carried ${String(carried.length)} · violations ${String(violations.length)}`;
  assert.ok(delivered.length > 0, `${tally}: no case reached the model, so the admitted half proves nothing`);
  assert.ok(carried.length > 0, `${tally}: no case was carried, so the refused half proves nothing`);
  assert.deepEqual(
    violations,
    [],
    `${tally}: these turns asked the provider for words the player's surface cannot show`,
  );
});

/**
 * THE HONEST STATEMENT IS KEPT, and this is the shape that still needs it: a turn with no lease at all still exists for the
 * one ingress that bypasses the pump's surface rule - a player input enqueued without an opaque `eventId`, which no
 * production path does (`HostService.acceptPlayerInput` refuses it) but a direct caller can.
 *
 * `speechSurfaceStatement` stays for exactly that turn: the model is told the truth about its own surface instead of being
 * left to narrate into a void. It is not the fix for `round66` - the fix is that such a turn is almost never created - and
 * removing the statement would make an unadmitted turn SILENT about its own condition.
 */
test("the_statement_is_kept_for_the_turn_that_still_has_no_surface", async () => {
  const received: string[] = [];
  const loop = new CompanionLoop(speakingSession(received) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent() {},
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_without_source",
    text: "你在做什么？",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.equal(
    received.length,
    1,
    "a person's word still opens a turn: it is not a fact and no surface rule holds it back",
  );
  assert.ok(
    (received[0] ?? "").includes(`<${NO_SPEECH_SURFACE_BLOCK}>`),
    "and the turn is told the truth about its own surface",
  );
});

/**
 * THE FALSIFIER: the same case with the surface able to present. One opaque identity is the whole difference, so the gate
 * above is reading the surface rather than a constant this file also wrote.
 */
test("the_same_fact_with_an_opaque_identity_is_delivered_and_admitted", async () => {
  const reading = await flushOf(worldFactOf("time_milestone"), undefined);
  assert.equal(reading.delivered, true, "a lease kind with an opaque `sourceEventId` opens its turn as today");
  assert.equal(reading.admitted, true, "and the surface admits it, so her bubble reaches the player");
  assert.equal(reading.toldCannotSpeak, false, "and it is never told to be quiet");
  assert.deepEqual(reading.noSurfaceShapes, {}, "and nothing was refused for want of a surface");

  const refused = await flushOf(receiptOf("succeeded"), undefined);
  assert.equal(refused.delivered, false, "the same pump, a fact whose shape has no surface, opens no turn");
  assert.deepEqual(refused.noSurfaceShapes, { "receipt:succeeded": 1 }, "and the account says which shape and why");
  assert.equal(presentationSourceOf(receiptOf("succeeded")), undefined, "a receipt has no identity to present under");
  assert.equal(NOT_OWED.noSurface, "no_surface_for", "the reason this test reads is the one the account prints");
});
