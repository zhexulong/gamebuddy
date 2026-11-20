import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CARRY_HOLD_BOUND_MS,
  CompanionEventPump,
  FACT_PRODUCER,
  HELD_WORLD_DECLARATIONS,
  type HeldWorldDeclaration,
  NOT_OWED,
  type PendingBatch,
  factShapeName,
  factTurnConsequence,
  heldWorldOf,
  type WorldFact,
} from "./event-pump.js";
import { HELD_WORLD_ZH } from "./fact-brief.js";
import { presentationSourceOf } from "./presentation-lease.js";
import type { InFlightProgrammeReading } from "./program-status-wait.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * THE GATE: `a_blocked_world_is_not_a_missing_surface:<kind>`.
 *
 * <p>
 * MEASURED 2026-11-18 (`round76`, ten minutes): she warped into town, a `DialogueBox` mounted at a door with
 * `{"isQuestion":true,"blocksTimePass":true,"responseKeys":["Yes","No"]}`, and the only facts for **610 seconds** were three
 * clock marks. The account's own last line is the defect written out:
 * `not owed 121 {… no_surface_for: 95 {receipt:succeeded: 44, world_fact:modal_presented: 37,
 * world_fact:npc_dialogue_presented: 9, world_fact:modal_dismissed: 5}, plan_still_running: 14}` and
 * `carried 132 · consumed 80 · lost 52 {world_fact:modal_presented: 16, world_fact:npc_dialogue_presented: 16,
 * world_fact:modal_dismissed: 16, semantic:snapshot_changed: 2, world_fact:time_milestone: 2}`. The world said it was
 * blocked, the pump answered "no surface can show her reply", and the carry bound then threw the statement away by name.
 * </p>
 *
 * <p>
 * THE PROPERTY IS TWO-DIRECTIONAL, and both directions are driven from the same derived population:
 * </p>
 *
 * <ul>
 *   <li>A KIND THAT DECLARES A HOLD OPENS ITS TURN - with nothing in flight, and again while her own plan still has nodes,
 *       because a stopped clock is the one answer a running plan cannot produce (`#waitsForThePlanToAnswer`). The batch's
 *       model-facing text states the block in that fact's own words.</li>
 *   <li>A KIND THAT DECLARES NOTHING IS NOT LOST SILENTLY. It either opens (a lease kind, a wake) or it is answered
 *       `no_surface_for` and, past `CARRY_HOLD_BOUND_MS`, counted in `carried`'s `lost` braces under a name that carries
 *       the kind. `lost 52` with no name would be the loss this gate exists to prevent.</li>
 * </ul>
 *
 * <p>
 * THE POPULATION IS THE WIRE AND THE MOD'S OWN RECORDS, never a list written here: the wire's closed
 * `$defs/semanticEvent.kind` union (`protocol/bridge-v1.schema.json`) and every `*Payload` record under
 * `integrations/stardew/src/Core/Models` that declares a `Kind` constant - with the fields THAT record declares, which is
 * where a hold is stated. A fact kind added to either appears here without this file changing, and the failure names it.
 * </p>
 *
 * <p>
 * THE FALSIFIER IS THE SAME KIND WITH THE DECLARATION TURNED OFF: a `modal_presented` whose payload says
 * `blocksTimePass: false, isQuestion: false` opens no turn and is lost under its own name. A pump that special-cased the
 * two kind NAMES instead of reading what the fact declares would open a turn for it and fail here by name - which is the
 * rule this unit was asked to land on.
 * </p>
 */

type ModKind = Readonly<{
  /** The pump's own shape spelling for this kind (`factShapeName`), which is also how a loss is named. */
  label: string;
  fact: WorldFact;
  /** Every declaration this kind's payload record states, in `HELD_WORLD_DECLARATIONS`' order. */
  declared: readonly HeldWorldDeclaration[];
}>;

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

/** A plan with nodes left: the journal's own reading while it is running (`InFlightProgramme.remaining`). */
const RUNNING: InFlightProgrammeReading = Object.freeze({
  programmes: Object.freeze([
    Object.freeze({
      programId: "plan_door",
      total: 3,
      settled: 0,
      remaining: 3,
      readAgeMs: 400,
      nodes: Object.freeze([]),
      omitted: 0,
      unsettledTiles: Object.freeze([]),
    }),
  ]),
  omittedProgrammes: 0,
});

const ANSWERED: InFlightProgrammeReading = Object.freeze({
  programmes: Object.freeze([]),
  omittedProgrammes: 0,
});

const WIRE: unknown = JSON.parse(readFileSync(join(ROOT, "protocol/bridge-v1.schema.json"), "utf8"));

/** The wire's closed `semanticEvent.kind` union: the trace/semantic half of what the Mod can mint. */
function wireSemanticKinds(): readonly string[] {
  const defs = (WIRE as { $defs?: Record<string, unknown> }).$defs ?? {};
  const event = defs.semanticEvent as { properties?: { kind?: { enum?: unknown } } } | undefined;
  const kinds = event?.properties?.kind?.enum;
  if (!Array.isArray(kinds) || kinds.length === 0)
    throw new Error("the wire declares no `semanticEvent.kind` union: this gate read nothing");
  return kinds.map((kind) => {
    if (typeof kind !== "string" || kind === "") throw new Error("a wire semantic kind is not a name");
    return kind;
  });
}

/**
 * Every `*Payload` record the Mod declares a `Kind` for, with the fields THAT record declares.
 *
 * <p>
 * SPLIT PER RECORD, not per file: `ModalPresentedPayload.cs` declares two records - the mount and the dismissal - and one
 * kind's fields attributed to the other would mark a `modal_dismissed` as holding the world. The split is on the
 * declaration keyword, which is the boundary C# itself gives.
 * </p>
 */
function modWorldFactKinds(): readonly Readonly<{ kind: string; fields: readonly string[] }>[] {
  const directory = join(ROOT, "integrations/stardew/src/Core/Models");
  const records: Readonly<{ kind: string; fields: readonly string[] }>[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".cs"))) {
    const source = readFileSync(join(directory, name), "utf8");
    for (const block of source.split(/(?=public sealed record )/u)) {
      if (!block.startsWith("public sealed record ")) continue;
      const kind = /public const string Kind = "([a-z_]+)";/u.exec(block);
      if (kind === null) continue;
      const fields = [...block.matchAll(/JsonPropertyName\("(\w+)"\)/gu)].map((match) => match[1] ?? "");
      records.push(Object.freeze({ kind: kind[1] ?? "", fields: Object.freeze(fields) }));
    }
  }
  if (records.length === 0) throw new Error("the Mod declares no world-fact payload kind: this gate read nothing");
  return records;
}

/** One world fact as the Mod's own record says it: the fields that record declares, and nothing else. */
function modFact(kind: string, fields: readonly string[]): WorldFact {
  const payload: Record<string, unknown> = { kind };
  for (const field of fields) {
    if ((HELD_WORLD_DECLARATIONS as readonly string[]).includes(field)) payload[field] = true;
    else if (field === "modalType") payload[field] = "DialogueBox";
    else if (field === "text") payload[field] = "门口有人在等，这条路走不过去";
    else if (field === "responseKeys") payload[field] = ["Yes", "No"];
    else if (field === "pages") payload[field] = ["早上好。"];
    else if (field === "speaker") payload[field] = "Linus";
    else if (field === "choices") payload[field] = [{ key: "Yes", text: "好" }];
  }
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `${kind}_1`,
    sourceEventId: `${kind}_1`,
    correlationId: `${kind}_1`,
    revision: 1,
    occurredAtMs: 1,
    gameTime: "1840",
    semanticKind: kind,
    payload: Object.freeze(payload),
  });
}

/** One semantic event as the wire declares it: a trace, never a payload with a declaration in it. */
function wireFact(kind: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `semantic_${kind}`,
    correlationId: `semantic_${kind}`,
    revision: 1,
    occurredAtMs: 1,
    payload: Object.freeze({ kind, revision: 1, reasonCode: "body_trace" }),
  });
}

/** Every kind the Mod can mint, from its two declarations, with the hold each one states. */
function population(): readonly ModKind[] {
  const kinds: ModKind[] = [];
  for (const record of modWorldFactKinds()) {
    const fact = modFact(record.kind, record.fields);
    kinds.push(Object.freeze({ label: factShapeName(fact), fact, declared: heldWorldOf(fact) }));
  }
  for (const kind of wireSemanticKinds()) {
    const fact = wireFact(kind);
    kinds.push(Object.freeze({ label: factShapeName(fact), fact, declared: heldWorldOf(fact) }));
  }
  return Object.freeze(kinds);
}

test("a_blocked_world_is_not_a_missing_surface: a kind that holds the world opens a turn, and a kind that cannot be shown is lost by name", async () => {
  const cases = population();
  assert.ok(cases.length >= 2, `kinds examined ${String(cases.length)}: the derivation read nothing`);

  const held: string[] = [];
  const opened: string[] = [];
  const openedWhileRunning: string[] = [];
  const lostWithReason: string[] = [];
  const findings: string[] = [];
  let clock = 0;
  const now = (): number => clock;

  for (const { label, fact, declared } of cases) {
    // ── A KIND THAT DECLARES A HOLD ────────────────────────────────────────────────────────────────────────────────
    if (declared.length > 0) {
      held.push(label);
      const pump = new CompanionEventPump(() => ANSWERED, now);
      const turns = recorder();
      pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
      const outcome = await pump.flush(turns);
      if (outcome.kind !== "opened") {
        findings.push(`${label}: declared ${declared.join("+")} and opened no turn (${outcome.kind})`);
        continue;
      }
      opened.push(label);
      const account = pump.turnAccount;
      if (account.heldWorld.byDeclaration[declared[0] as HeldWorldDeclaration] !== 1)
        findings.push(
          `${label}: the turn is not counted under its own declaration ` +
            `(${JSON.stringify(account.heldWorld.byDeclaration)})`,
        );
      if (account.noSurface[label] !== undefined)
        findings.push(`${label}: a held world was filed as \`no_surface_for\`, which is the defect this gate is for`);
      const text = turns.batches[0]?.text ?? "";
      // IN THE FACT'S OWN WORDS: whatever the Mod published as prose or as the engine's own type name has to reach the
      // model, or the turn exists and nobody knows what is blocking.
      for (const field of ["modalType", "text"] as const) {
        const value = fact.payload?.[field];
        if (typeof value !== "string" || value === "") continue;
        if (!text.includes(value))
          findings.push(`${label}: the turn's text does not carry its own ${field} (${value})`);
      }
      for (const declaration of declared)
        if (!text.includes(HELD_WORLD_ZH[declaration]))
          findings.push(
            `${label}: the text does not say the block (${declaration}) in the words the prompt has for it`,
          );

      // ── AND WHILE HER OWN PLAN STILL HAS NODES, which is the deadlock `round76` sat in: a stopped clock cannot settle
      // the plan whose answer the pump was waiting for, so waiting for it is a wait with no forward path.
      const working = new CompanionEventPump(() => RUNNING, now);
      const workingTurns = recorder();
      working.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
      const whileRunning = await working.flush(workingTurns);
      if (whileRunning.kind !== "opened")
        findings.push(`${label}: a held world waited for a plan it is itself blocking (${whileRunning.kind})`);
      else openedWhileRunning.push(label);
      continue;
    }

    // ── A KIND THAT DECLARES NOTHING ───────────────────────────────────────────────────────────────────────────────
    const pump = new CompanionEventPump(() => ANSWERED, now);
    const turns = recorder();
    pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
    const outcome = await pump.flush(turns);
    if (outcome.kind === "opened") {
      // It opened. That is allowed only where a surface or a wake bought the turn - a fact that can present is not this
      // direction's population, and a fact that cannot present and is not held has bought a turn for text nobody sees.
      if (presentationSourceOf(fact) === undefined)
        findings.push(`${label}: opened a turn with no surface and no declaration to justify it`);
      continue;
    }
    assert.equal(outcome.kind, "not_owed", `${label}: a fact either opens a turn or is answered not-owed`);
    if (outcome.kind !== "not_owed") continue;
    if (factTurnConsequence(fact) !== "decision") {
      // A PROGRESS fact is standing state inside work already answered: it opens no turn, it is not lost news, and its
      // answer is its own class rather than the surface. This direction of the gate is about DECISIONS that could not be
      // shown, so a declared trace is counted and passed over by name (`progress`).
      assert.notEqual(
        outcome.reason,
        NOT_OWED.noSurface,
        `${label}: a declared ${factTurnConsequence(fact)} fact is not a surface refusal`,
      );
      continue;
    }
    assert.equal(
      outcome.reason,
      NOT_OWED.noSurface,
      `${label}: the refusal must name the surface rather than a re-statement (${outcome.reason})`,
    );
    // THE LOSS HAS TO NAME SOMETHING AN OPERATOR CAN ACT ON. Past the bound the fact leaves its window, and the account's
    // `lost` braces are the only place a run records that it went away.
    clock += CARRY_HOLD_BOUND_MS + 1;
    const account = pump.turnAccount;
    const named = account.carry.lost[factShapeName(fact)];
    if (named !== 1) findings.push(`${label}: lost without a name (${JSON.stringify(account.carry.lost)})`);
    else lostWithReason.push(label);
    clock = 0;
  }

  const tally =
    `kinds examined ${String(cases.length)} · held-world ${String(held.length)} · opens-turn ${String(opened.length)} · ` +
    `opens-while-planning ${String(openedWhileRunning.length)} · lost-with-reason ${String(lostWithReason.length)}`;
  assert.ok(held.length > 0, `${tally}: no kind declared a hold, so the held half of this gate proves nothing`);
  assert.ok(
    lostWithReason.length > 0,
    `${tally}: no kind was lost by name, so the lost half of this gate proves nothing`,
  );
  assert.deepEqual(findings, [], `${tally}: ${findings.join("; ")}`);
  console.log(`a_blocked_world_is_not_a_missing_surface: ${tally}`);
});

/**
 * THE FALSIFIER, in-suite: the same kind with its declaration turned off.
 *
 * <p>
 * `modal_presented` is the kind `round76` lost sixteen of, and everything this gate asserts about it comes from what its
 * PAYLOAD says. So a menu that neither stops the clock nor asks a question is not a blocked world: it opens no turn, it is
 * answered `no_surface_for`, and its loss is named. A pump that recognised the two kind names instead would open a turn
 * here - the shape `dismiss_modal` exists for but a ShippingMenu settlement is not.
 * </p>
 */
test("a_blocked_world_is_not_a_missing_surface: the falsifier - the same kind declaring nothing opens nothing", async () => {
  let clock = 0;
  const quiet: WorldFact = Object.freeze({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "modal_shown_quiet",
    sourceEventId: "modal_shown_quiet",
    correlationId: "modal_shown_quiet",
    revision: 9,
    occurredAtMs: 9,
    semanticKind: "modal_presented",
    payload: Object.freeze({
      kind: "modal_presented",
      modalType: "ShippingMenu",
      isQuestion: false,
      blocksTimePass: false,
    }),
  });
  assert.deepEqual(heldWorldOf(quiet), [], "a menu that declares nothing does not hold the world");

  const pump = new CompanionEventPump(
    () => ANSWERED,
    () => clock,
  );
  const turns = recorder();
  pump.enqueueFact(quiet, FACT_PRODUCER.adapterIngress);
  const outcome = await pump.flush(turns);
  assert.equal(outcome.kind, "not_owed", `a declaration-free modal opens no turn (${outcome.kind})`);
  assert.deepEqual(turns.batches, [], "and nothing is delivered");
  assert.equal(pump.turnAccount.heldWorld.opened, 0, "and the held-world reading stays at zero");
  clock += CARRY_HOLD_BOUND_MS + 1;
  assert.deepEqual(
    pump.turnAccount.carry.lost,
    { "world_fact:modal_presented": 1 },
    "and its loss names the kind, which is the only thing a later reader can act on",
  );

  // AND THE SAME KIND DECLARING A HOLD IS THE OPPOSITE ANSWER: one field is the whole difference, so the gate is reading
  // the declaration rather than anything this file also wrote.
  const blocked: WorldFact = Object.freeze({
    ...quiet,
    payload: Object.freeze({
      kind: "modal_presented",
      modalType: "DialogueBox",
      isQuestion: false,
      blocksTimePass: true,
    }),
  });
  assert.deepEqual(heldWorldOf(blocked), ["blocksTimePass"], "the stopped clock is a declaration");
  const blockedPump = new CompanionEventPump(
    () => ANSWERED,
    () => clock,
  );
  const blockedTurns = recorder();
  blockedPump.enqueueFact(blocked, FACT_PRODUCER.adapterIngress);
  const turned = await blockedPump.flush(blockedTurns);
  assert.equal(turned.kind, "opened", `the same kind, holding the world, opens its turn (${turned.kind})`);
  assert.equal(
    blockedPump.turnAccount.heldWorld.byDeclaration.blocksTimePass,
    1,
    "and the account says which declaration bought it",
  );
});
