import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionLoop,
  NO_PRESENTATION_LEASE,
  NO_SPEECH_SURFACE_BLOCK,
  PRESENTATION_LEASE_KINDS,
} from "./companion-loop.js";
import { FACT_PRODUCER, FACT_TURN_CONSEQUENCE, type WorldFact } from "./event-pump.js";
import { EXECUTION_STATES } from "./protocol.js";

/**
 * THE GATE: a turn that cannot present its text must not invite it anyway.
 *
 * <p>
 * MEASURED 2026-11-17 (`round65`, ten minutes): 26 turns opened, EVERY ONE answered with text, 17 bubbles delivered and 10
 * lost to `no_presentation_lease`. The loss was named and the cause was not: `lost 10 {no_presentation_lease: 10}` says a
 * bubble was withheld and nothing about what the turn was. The delivered turns were not the ones the surface had admitted
 * on purpose - a receipt-opened turn presented only when the Mod's HUD happened to draw a line (`native_notice`) that rode
 * the same batch - so the same body action spoke in one batch and vanished in the next.
 * </p>
 * <p>
 * The property is a BICONDITIONAL on the turn itself, because either direction is a defect: text on a turn the surface
 * cannot show is a decision the player never sees (the members this run lost), and a silence order on a turn the surface
 * DOES admit is a bubble she was told not to speak into. Both are asserted, so neither can be fixed by moving the defect.
 * </p>
 * <p>
 * THE POPULATION IS DERIVED. The admitted half is `PRESENTATION_LEASE_KINDS` - the loop's own declaration, not a copy - and
 * the unadmitted half is every receipt state whose consequence the pump's own table calls `decision`, i.e. every receipt
 * shape that can open a turn. A kind added to either authority appears here without this file changing; the failure names
 * the member that drifted.
 * </p>
 */

type SessionEvent = { type: string; message?: unknown; assistantMessageEvent?: unknown };

const SPOKEN = "我把这块地收拾了。";

/** The receipt states that can open a turn: the pump's own classification, asked rather than guessed. */
function decisionReceiptStates(): readonly string[] {
  return Object.entries(FACT_TURN_CONSEQUENCE)
    .filter(([shape, consequence]) => shape.startsWith("receipt:") && consequence === "decision")
    .map(([shape]) => shape.slice("receipt:".length));
}

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

/** One turn: what the model read, what the surface was allowed to show, and the loop's own delivery record. */
type TurnReading = Readonly<{
  kind: string;
  text: string;
  admitted: boolean;
  toldCannotSpeak: boolean;
  bubbles: number;
  withheld: string | undefined;
  carried: readonly string[];
}>;

async function turnOf(fact: WorldFact | undefined, playerSource: string | undefined): Promise<TurnReading> {
  const received: string[] = [];
  const presented: unknown[] = [];
  const loop = new CompanionLoop(speakingSession(received) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content);
    },
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
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `every turn that produced text must print its delivery record; stderr: ${printed}`);
  const record = JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)) as {
    bubbles: number;
    withheld?: string;
    lease: { admitted: boolean };
    carried: readonly string[];
  };
  const text = received[0] ?? "";
  assert.equal(received.length, 1, `the turn must have reached the model exactly once, got ${String(received.length)}`);
  return Object.freeze({
    kind: fact === undefined ? String(playerSource) : factKindOf(fact),
    text,
    admitted: record.lease.admitted,
    toldCannotSpeak: text.includes(`<${NO_SPEECH_SURFACE_BLOCK}>`),
    bubbles: record.bubbles,
    withheld: record.withheld,
    carried: record.carried,
  });
}

function factKindOf(fact: WorldFact): string {
  if (fact.kind === "world_fact") return String(fact.semanticKind);
  if (fact.kind === "execution_receipt") return `receipt:${String(fact.payload.state)}`;
  return String(fact.kind);
}

function worldFactOf(kind: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `fact_${kind}`,
    sourceEventId: `fact_${kind}`,
    correlationId: `fact_${kind}`,
    revision: 1,
    occurredAtMs: 5,
    semanticKind: kind,
    payload: { kind },
  };
}

function receiptOf(state: string, reasonCode = "crop_harvested"): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `receipt_${state}`,
    correlationId: `receipt_${state}`,
    revision: 1,
    occurredAtMs: 5,
    executionId: `exec_${state}`,
    payload: { state, reasonCode, executionId: `exec_${state}`, revision: 1, evidence: null },
  };
}

test("a_turn_that_cannot_present_its_text_invites_it_anyway", async () => {
  const readings: TurnReading[] = [];
  // THE ADMITTED HALF, from the loop's own declaration.
  for (const kind of PRESENTATION_LEASE_KINDS) readings.push(await turnOf(worldFactOf(kind), undefined));
  // The player's own words are the other admission, and they are not a fact kind at all.
  readings.push(await turnOf(undefined, "player_source_gate"));
  // THE UNADMITTED HALF, from the pump's own consequence table.
  for (const state of decisionReceiptStates()) readings.push(await turnOf(receiptOf(state), undefined));

  const admitted = readings.filter((reading) => reading.admitted);
  const spokeUnadmitted = readings.filter((reading) => !(reading.admitted || reading.toldCannotSpeak));
  const silencedButAdmitted = readings.filter((reading) => reading.admitted && reading.toldCannotSpeak);

  const tally = `turns examined ${String(readings.length)} · invited-and-admitted ${String(admitted.length)} · spoke-unadmitted ${String(spokeUnadmitted.length)}`;
  assert.deepEqual(
    spokeUnadmitted.map((reading) => reading.kind),
    [],
    `${tally}: these turns produced text on a surface that would not show it, so the model was asked to speak into a void (carried: ${spokeUnadmitted.map((reading) => JSON.stringify(reading.carried)).join(", ")})`,
  );
  assert.deepEqual(
    silencedButAdmitted.map((reading) => reading.kind),
    [],
    `${tally}: these turns WERE admitted and were told their words would not be shown, which suppresses a bubble the player owed`,
  );

  // The admission is the surface's, and the record says so in the same word the run's account prints.
  for (const reading of readings) {
    const lost = reading.bubbles === 0;
    assert.equal(
      reading.withheld ?? null,
      reading.admitted ? null : NO_PRESENTATION_LEASE,
      `${reading.kind}: the record's withholding must agree with its own admission (carried ${JSON.stringify(reading.carried)})`,
    );
    assert.equal(
      lost,
      !reading.admitted,
      `${reading.kind}: an unadmitted turn loses its bubble and an admitted one delivers it (bubbles ${String(reading.bubbles)})`,
    );
  }
});

/**
 * THE FALSIFIER: the same guard, red on purpose.
 *
 * <p>
 * The admitted half of the population is a world fact; the unadmitted half is a receipt. A receipt batch that ALSO carries a
 * fact the game drew for the player (`native_notice` - the HUD line the Mod attaches to the receipt that put it on screen)
 * is admitted, because the thing being answered is something the player can read. Swapping the two loops below makes the
 * gate above fire on the members it names, which is what proves the gate reads the turn's own admission rather than a
 * constant this file also wrote.
 * </p>
 */
test("the gate's two halves are what they say: an outcome alone cannot present, and one that carries the game's own line can", async () => {
  const outcomeAlone = await turnOf(receiptOf("succeeded"), undefined);
  assert.equal(outcomeAlone.admitted, false, "a receipt with nothing else in the batch is not a presentation source");
  assert.equal(outcomeAlone.toldCannotSpeak, true, "and the model is told so, in the turn it reads");
  assert.deepEqual(outcomeAlone.carried, ["execution_receipt"]);

  // The Mod's own HUD line rides the receipt (`native-notice-fact.ts`), and it is what the bubble answers.
  const received: string[] = [];
  const presented: string[] = [];
  const loop = new CompanionLoop(speakingSession(received) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push((content as { text: string }).text);
    },
  });
  loop.pump.enqueueFact(worldFactOf("native_notice"), FACT_PRODUCER.nativeNotice);
  loop.pump.enqueueFact(receiptOf("succeeded"), FACT_PRODUCER.adapterIngress);
  await loop.flush();

  assert.equal(presented.length, 1, "the game's own line is what the player reads, so her answer to it is shown");
  assert.ok(
    !(received[0] ?? "").includes(`<${NO_SPEECH_SURFACE_BLOCK}>`),
    "and an admitted turn is never told it cannot speak",
  );
  assert.equal(outcomeAlone.bubbles, 0, "the unadmitted turn committed no bubble");
});

test("EXECUTION_STATES is the population this gate reads", () => {
  // Zero population is blocked, never green: if the derived population were empty the gate would agree with itself.
  const states = decisionReceiptStates();
  const declared = EXECUTION_STATES.filter((state) => FACT_TURN_CONSEQUENCE[`receipt:${state}`] === "decision");
  assert.ok(
    states.length > 0 && declared.length > 0,
    `turns examined 0: the receipt population is empty (${String(states.length)})`,
  );
  assert.deepEqual(states, [...declared], "every receipt state the pump calls a decision is in this gate's population");
  assert.ok(
    PRESENTATION_LEASE_KINDS.length > 0,
    "turns examined 0: the lease population is empty, so the admitted half of this gate checks nothing",
  );
});
