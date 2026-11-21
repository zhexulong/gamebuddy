import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CompanionEventPump,
  FACT_PRODUCER,
  HELD_WORLD_DECLARATIONS,
  type HeldWorldDeclaration,
  NOT_OWED,
  type PendingBatch,
  type WorldFact,
} from "./event-pump.js";
import { HELD_WORLD_ZH } from "./fact-brief.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * `a_world_that_is_performing_holds_its_own_wake:<kind>:<declaration>` - the wake a native performance must not buy.
 *
 * <p>
 * MEASURED 2026-11-20 (`round84`, the cutscene at day 4 12:20, `.live-runs/game-ladder/2026-11-20T13-52-51-386Z-multiday_routine`).
 * Eleven `modal_presented (DialogueBox, isQuestion:false, blocksTimePass:true)` facts arrived between `13:57:58` and
 * `13:59:33`, one every 1-4 s, each declaring the world held and each carrying no presentation source. Every one opened a
 * turn: the run's own account counted `turns opened 82`, `turn_closed_without_action 26`, and
 * `lost 21 {no_presentation_lease: 21}` of 91 produced messages, while every prompt in that window said
 * `身体: 忙 · 持有: event · 可由指令接管: 否 · 下一步: 下一回合`. A wake with neither speech nor action available is not
 * a turn - ten-odd of them in one cutscene, and the navigation the player was watching got shredded.
 * </p>
 *
 * <p>
 * THE PROPERTY IS TWO-SIDED, over a population read from the protocol rather than typed here: the wire's closed
 * `$defs/snapshot.properties.actorDispositionKind` enum × `HELD_WORLD_DECLARATIONS`.
 * </p>
 *
 * <ul>
 *   <li>Under `event` - the Mod's own kind for a native performance absorbing the actor (`WorldModel.Classify`: `eventUp`,
 *       or a mounted minigame, both "no tool can shorten it"), and the one kind `game-world-vocabulary.ts` gives no way
 *       forward but the world's next turn - a fact whose ONLY claim to a turn is a hold it cannot show opens NO turn. It is
 *       answered `world_locked`: carried, named, and delivered by the turn the performance's end opens.</li>
 *   <li>Under EVERY OTHER member the held-world turn is unchanged, and `modal` is the measured case that must stay that
 *       way: `round76`'s `DialogueBox` at a door asked a question, stopped the clock for 610 s, and the answer to it was an
 *       action (`answer_dialogue`, `dismiss_modal`) rather than a line - so the surface question never applied to it. This
 *       half of the gate is the zero-behaviour-change claim, read from the same run of the same cases.</li>
 * </ul>
 *
 * <p>
 * AND THE RULE IS NARROW IN BOTH DIRECTIONS THAT WOULD MAKE IT A SILENCER: a fact that CAN present still opens (a lease
 * kind is not this rule's population), and the player's own word never passes through the fact path at all.
 * </p>
 */

type Sink = Readonly<{ batches: PendingBatch[]; deliver(batch: PendingBatch): Promise<void> }>;

function recorder(): Sink {
  const batches: PendingBatch[] = [];
  return {
    batches,
    async deliver(batch) {
      batches.push(batch);
    },
  };
}

const WIRE: unknown = JSON.parse(readFileSync(join(ROOT, "protocol/bridge-v1.schema.json"), "utf8"));

/** The wire's closed `actorDispositionKind` set: the kind a reading can say the body is held by. */
function wireDispositionKinds(): readonly string[] {
  const defs = (WIRE as { $defs?: Record<string, unknown> }).$defs ?? {};
  const snapshot = defs.snapshot as
    | { properties?: { actorDispositionKind?: { enum?: unknown } } }
    | undefined;
  const kinds = snapshot?.properties?.actorDispositionKind?.enum;
  if (!Array.isArray(kinds) || kinds.length === 0)
    throw new Error("the wire declares no `actorDispositionKind` union: this gate read nothing");
  return kinds.map((kind) => {
    if (typeof kind !== "string" || kind === "") throw new Error("a wire disposition kind is not a name");
    return kind;
  });
}

const PERFORMING = "event";

/** One reading of the world, held by the kind the case is about: the Mod's snapshot shape, and nothing else. */
function heldBy(kind: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    correlationId: `snapshot_${kind}`,
    revision: 7,
    occurredAtMs: 1,
    observedTick: 1,
    gameTime: "1220",
    payload: Object.freeze({
      revision: 7,
      location: "Town",
      gameTime: "1220",
      actionable: kind !== "idle",
      actorDispositionKind: kind,
      actorDispositionDetail: kind === "modal" ? "DialogueBox" : null,
      actorDispositionActionOwned: false,
    }),
  });
}

/**
 * A `modal_presented` declaring exactly one hold, with no presentation source.
 *
 * The words are the cutscene's own (`round84`: "这里曾经是这个镇子的骄傲。"), because the direction that a held fact
 * still opens has to prove the block reaches the prompt in the fact's own words.
 */
function boxDeclaring(declaration: HeldWorldDeclaration, index: number): WorldFact {
  const payload: Record<string, unknown> = {
    kind: "modal_presented",
    modalType: "DialogueBox",
    text: "这里曾经是这个镇子的骄傲。",
    textFrom: "modal",
    isQuestion: false,
    blocksTimePass: false,
    responseKeys: [],
  };
  payload[declaration] = true;
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `modal_shown_${String(index)}`,
    sourceEventId: `modal_shown_${String(index)}`,
    correlationId: `modal_shown_${String(index)}`,
    revision: 7,
    occurredAtMs: 1,
    gameTime: "1220",
    semanticKind: "modal_presented",
    payload: Object.freeze(payload),
  });
}

/** The Mod's five clock marks a day: presentable, so a turn opened on it reaches the player. */
function milestone(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "time_milestone_cutscene_1200",
    sourceEventId: "time_milestone_cutscene_1200",
    correlationId: "time_milestone_cutscene_1200",
    revision: 7,
    occurredAtMs: 1,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: "1200" }),
  });
}

test("a_world_that_is_performing_holds_its_own_wake: a hold that cannot be shown waits while the world performs, and opens its turn otherwise", async () => {
  const kinds = wireDispositionKinds();
  const cases = kinds.flatMap((kind) =>
    HELD_WORLD_DECLARATIONS.map((declaration) => Object.freeze({ kind, declaration })),
  );
  assert.ok(
    cases.length === kinds.length * HELD_WORLD_DECLARATIONS.length && cases.length > 0,
    `cases ${String(cases.length)}: the derivation read nothing`,
  );

  const held: string[] = [];
  const opened: string[] = [];
  const findings: string[] = [];

  for (const { kind, declaration } of cases) {
    const label = `${kind}:${declaration}`;
    const pump = new CompanionEventPump(undefined, () => 1_000);
    const turns = recorder();
    pump.enqueueFact(heldBy(kind), FACT_PRODUCER.adapterIngress);
    pump.enqueueFact(boxDeclaring(declaration, 1), FACT_PRODUCER.adapterIngress);
    const outcome = await pump.flush(turns);

    if (kind === PERFORMING) {
      held.push(label);
      if (outcome.kind !== "not_owed") {
        findings.push(`${label}: a world that is performing woke her (${outcome.kind})`);
        continue;
      }
      if (outcome.reason !== NOT_OWED.worldLocked)
        findings.push(`${label}: answered \`${outcome.reason}\` rather than naming the performance`);
      if (turns.batches.length !== 0) findings.push(`${label}: a batch was delivered into a performance`);
      // NOTHING IS LOST: the fact is ticketed, waiting in its window, for the turn the performance's end opens.
      const carried = pump.turnAccount.carry;
      if (carried.held !== 1 || carried.carried !== 1)
        findings.push(`${label}: the held fact was dropped rather than carried (${JSON.stringify(carried)})`);
      continue;
    }

    // THE ZERO-BEHAVIOUR-CHANGE CLAIM, read from this run's own cases: every other disposition keeps the held-world turn,
    // and the turn states the block in the words the prompt has for it.
    if (outcome.kind !== "opened") {
      findings.push(`${label}: the held-world turn is unchanged for \`${kind}\`, and it opened nothing (${outcome.kind})`);
      continue;
    }
    opened.push(label);
    const text = turns.batches[0]?.text ?? "";
    if (!text.includes(HELD_WORLD_ZH[declaration]))
      findings.push(`${label}: the turn's text does not state the block (${declaration})`);
  }

  const tally =
    `kinds ${String(kinds.length)} · declarations ${String(HELD_WORLD_DECLARATIONS.length)} · ` +
    `cases ${String(cases.length)} · held-by-a-performance ${String(held.length)} · opens-turn ${String(opened.length)}`;
  console.log(`a_world_that_is_performing_holds_its_own_wake: ${tally}`);
  assert.equal(
    opened.length + held.length,
    cases.length,
    `${tally}: every declared hold was driven under every wire disposition`,
  );
  assert.equal(
    held.length,
    HELD_WORLD_DECLARATIONS.length,
    `${tally}: exactly the performing member holds the wake, and it holds it for every declaration`,
  );
  assert.equal(
    opened.length,
    HELD_WORLD_DECLARATIONS.length * (kinds.length - 1),
    `${tally}: every other member of the wire's closed set keeps the held-world turn`,
  );
  assert.deepEqual(findings, [], `${tally}: ${findings.join("; ")}`);
});

/**
 * THE OTHER DIRECTION OF THE SAME MOMENT: the performance ends, and the held fact is the batch that states it - once.
 *
 * The wake the rule removed is not deleted news. `world_locked` is a `not_owed` answer, so the fact is carried with a
 * ticket; the reading that says the actor is free again is what the next flush decides, and the whole cutscene's boxes travel
 * in ONE turn rather than one turn each.
 */
test("a_world_that_is_performing_holds_its_own_wake: the performance ends, and the held boxes ride one turn", async () => {
  const pump = new CompanionEventPump(undefined, () => 1_000);
  const turns = recorder();
  pump.enqueueFact(heldBy(PERFORMING), FACT_PRODUCER.adapterIngress);
  const boxes = [1, 2, 3].map((index) => boxDeclaring("blocksTimePass", index));
  for (const box of boxes) pump.enqueueFact(box, FACT_PRODUCER.adapterIngress);
  const during = await pump.flush(turns);
  assert.equal(during.kind, "not_owed", `nothing opens while the performance plays (${during.kind})`);
  assert.equal(turns.batches.length, 0, "and no batch is delivered");

  const free = heldBy("idle");
  pump.enqueueFact(free, FACT_PRODUCER.adapterIngress);
  const after = await pump.flush(turns);
  assert.equal(after.kind, "opened", `the world's own next reading opens the turn the performance held (${after.kind})`);
  assert.equal(turns.batches.length, 1, "exactly one wake: three boxes are one batch, not three turns");
  const text = turns.batches[0]?.text ?? "";
  assert.ok(text.includes("这里曾经是这个镇子的骄傲。"), "and that turn states what the boxes said");
  assert.equal(pump.turnAccount.carry.held, 0, "the carried facts were consumed by it, not left waiting");
});

/**
 * THE FALSIFIER THAT KEEPS THE RULE FROM BECOMING A SILENCER: a person who speaks during a performance is still answered.
 *
 * `#opening` answers a player's word before it reads any fact, and this asserts it from the same constructed state the cases
 * above use - a cutscene reading, and a box that declares it holds the world.
 */
test("a_world_that_is_performing_holds_its_own_wake: a person who speaks during the performance is still answered", async () => {
  const pump = new CompanionEventPump(undefined, () => 1_000);
  const turns = recorder();
  pump.enqueueFact(heldBy(PERFORMING), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(boxDeclaring("isQuestion", 1), FACT_PRODUCER.adapterIngress);
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_during_cutscene",
    eventId: "player_source_cutscene",
    text: "你在看什么？",
    locale: "zh-CN",
    timestampMs: 1_000,
  });
  const outcome = await pump.flush(turns);
  assert.equal(outcome.kind, "opened", `a person's word is never held by the lock (${outcome.kind})`);
  if (outcome.kind !== "opened") return;
  assert.equal(outcome.opener, "player_input", "and the opener says who it was");
  assert.ok((turns.batches[0]?.text ?? "").includes("你在看什么？"), "their words reach the batch");
});

/**
 * AND THE SAME FALSIFIER FOR THE SURFACE: a fact the player's surface CAN show is not this rule's population.
 *
 * A clock mark is presentable (`presentation-lease.ts`), so a turn opened on it reaches the player - and holding it would be
 * the rule silencing the one thing it is not about.
 */
test("a_world_that_is_performing_holds_its_own_wake: a fact that can be shown still opens its turn", async () => {
  const pump = new CompanionEventPump(undefined, () => 1_000);
  const turns = recorder();
  pump.enqueueFact(heldBy(PERFORMING), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(milestone(), FACT_PRODUCER.adapterIngress);
  const outcome = await pump.flush(turns);
  assert.equal(outcome.kind, "opened", `a presentable fact keeps its turn during a performance (${outcome.kind})`);
  assert.equal(turns.batches.length, 1, "and it is delivered");
});
