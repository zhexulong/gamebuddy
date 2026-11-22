import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, FACT_PRODUCER, type PendingBatch, type WorldFact } from "./event-pump.js";
import type { Snapshot } from "./protocol.js";

/**
 * A CARRIED FACT STATES THE WORLD IT BELONGS TO.
 *
 * <p>
 * MEASURED 2026-11-20 (`round91`), from the run's own journal
 * (`tools/_multiday_routine-round91-live-runner.log`): `plan_423_7dc8b76a0af7c94a` node `n03` answered
 * `rejected/door_out_of_range` at `revision 473` - `source=3,12;door=3,12;actor=9,9;distance=6;target=Farm:64,15` -
 * inside the FarmHouse, with no presentation lease, so the pump carried it. 130 ms before it was handed over the warp
 * landed (`snapshot_changed/warped`, `revision 481`, the Farm at `64,15`), and the message the model read
 * (`atMs 1795331562252`) was exactly this, with NO `<world-state>` at all - a steer states no reading (`round77`):
 * </p>
 * <pre>
 *   &lt;world-facts&gt;
 *   - enter_exit 没做成。She is too far from the door or warp that leads there (6 tiles)... at (3,12)...
 *   可指代的字段：enter_exit reasonCode=door_out_of_range；source=3,12;...
 *   &lt;/world-facts&gt;
 * </pre>
 * <p>
 * Her own thinking, quoted from the session: "the earlier plan said enter_exit succeeded to Farm 64,15, but then this new
 * fact says she is at 9,9 near door 3,12... Confusing hybrid" - and she submitted a plan to walk back to a door in a room
 * she had left.
 * </p>
 *
 * <p>
 * THE DEFECT IS THAT A FACT MADE A WORLD CLAIM NOTHING QUALIFIED. A fact's revision is part of what makes it true, so
 * every line under `<world-facts>` now states which world it belongs to: the world it reads beside (`current`), or its own
 * revision together with the newer world that superseded it (`at_revision=&lt;r&gt;;stale_because=revision &lt;W&gt;`).
 * </p>
 *
 * <p>
 * THE POPULATION IS THE BLOCK'S OWN LINES, read out of the delivery the model was handed rather than listed here, so a
 * fact kind that renders a line tomorrow is measured without an edit - and a delivery with no `<world-state>` cannot pass
 * by stating nothing, which is the shape `round91` arrived in.
 * </p>
 */

const FARHOUSE = "FarmHouse";
const FARM = "Farm";

/** `round91`'s FarmHouse refusal: revision 473, the player at `(9,9)`, the door at `(3,12)`. */
const REFUSAL_REVISION = 473;
/** The warp it lost to: `snapshot_changed/warped` at revision 481, the Farm at `(64,15)`. */
const WARP_REVISION = 481;
const REFUSAL_EVIDENCE = "source=3,12;door=3,12;actor=9,9;distance=6;target=Farm:64,15;blocked_by=range:adjacent:6;held_ms=376";

/** One reading of the world, in the shape `composeWorldState` states it. */
function readingSnapshot(revision: number, location: string, x: number, y: number, timeOfDay: number): Snapshot {
  return {
    revision,
    location,
    tile: { x, y },
    stamina: 254.20001,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay,
    dayOfMonth: 7,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Pickaxe",
    currentToolSlot: 3,
    toolSlots: [{ slot: 3, label: "(T)Pickaxe", category: "pickaxe", upgradeLevel: 0 }],
    inventoryItemFacts: [],
  } as unknown as Snapshot;
}

function readingFact(snapshot: Snapshot): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `reading_${String(snapshot.revision)}_${String(snapshot.location)}`,
    correlationId: `reading_${String(snapshot.revision)}_${String(snapshot.location)}`,
    revision: snapshot.revision,
    payload: snapshot as never,
  });
}

/** A refused step, minted in the world it ran against - the Mod's own receipt shape. */
function refusal(revision: number, actionId: string, reasonCode: string, detail: string): WorldFact {
  const executionId = `exec_${actionId}_${String(revision)}`;
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    eventId: executionId,
    correlationId: executionId,
    revision,
    executionId,
    requestId: `request_${executionId}`,
    payload: Object.freeze({
      executionId,
      requestId: `request_${executionId}`,
      actionId,
      state: "rejected",
      reasonCode,
      evidence: Object.freeze({ detail }),
      revision,
    }),
  }) as WorldFact;
}

/** The Mod's own clock mark: presentable, so it is the fact that opens a turn here. */
function clockMark(timeOfDay: number, revision: number): WorldFact {
  const eventId = `time_milestone_${String(timeOfDay)}`;
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision,
    observedTick: timeOfDay,
    semanticKind: "time_milestone",
    payload: Object.freeze({ kind: "time_milestone", milestone: timeOfDay }),
  });
}

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

/** The block a delivery's text carries, or `undefined` when it carries none. */
function worldStateOf(text: string): string | undefined {
  return /<world-state>\n([\s\S]*?)\n<\/world-state>/u.exec(text)?.[1];
}

/** The revision a delivery states as its world, or `undefined` for a delivery that states no world at all. */
function statedRevision(text: string): number | undefined {
  const block = worldStateOf(text);
  if (block === undefined) return undefined;
  const matched = /世界（revision (\d+)/u.exec(block);
  assert.ok(matched !== null, `a world block always names its reading: ${block}`);
  return Number(matched[1]);
}

/** Every fact line the block handed the model, oldest first. */
function factLines(text: string): readonly string[] {
  const block = /<world-facts>\n([\s\S]*?)\n<\/world-facts>/u.exec(text)?.[1];
  if (block === undefined) return [];
  return block.split("\n").filter((line) => line.startsWith("- "));
}

/** The one fact line about an action. */
function lineAbout(text: string, actionId: string): string {
  const found = factLines(text).filter((line) => line.includes(actionId));
  assert.equal(found.length, 1, `exactly one line must state ${actionId} in: ${text}`);
  return found[0] ?? "";
}

/**
 * THE GATE ON EVERY LINE: no fact line is bare.
 *
 * A line either says it belongs to the world it reads beside (`current`) or names the world it belongs to and the newer
 * one that superseded it (`at_revision=<r>;stale_because=revision <W>`). A line that claims `current` while naming an older
 * revision is the defect this property exists to prevent, and a stale line that names a world nobody in the delivery states
 * is that same defect one step later.
 */
function assertEveryFactLineStatesItsWorld(text: string): void {
  const lines = factLines(text);
  assert.ok(lines.length > 0, `a delivery must state at least one fact line: ${text}`);
  const world = statedRevision(text);
  for (const line of lines) {
    const stale = /at_revision=(\d+);stale_because=revision (\d+)/u.exec(line);
    if (stale !== null) {
      const at = Number(stale[1]);
      const supersededBy = Number(stale[2]);
      assert.ok(at < supersededBy, `a stale line must name the newer world that superseded it: ${line}`);
      if (world !== undefined)
        assert.equal(
          supersededBy,
          world,
          `the newer world a stale line names must be the world the delivery states: ${line} / ${String(world)}`,
        );
      continue;
    }
    assert.match(line, /·current$/u, `a fact line that is not late must say so: ${line}`);
  }
}

test("a_carried_fact_states_the_world_it_belongs_to: round91's pair, in a batch and in a steer", async () => {
  const pump = new CompanionEventPump();
  const sink = recorder();

  // THE WORLD THE REFUSAL HAPPENED IN: revision 473, the FarmHouse at (9,9).
  pump.enqueueFact(readingFact(readingSnapshot(REFUSAL_REVISION, FARHOUSE, 9, 9, 700)), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    refusal(REFUSAL_REVISION, "enter_exit", "door_out_of_range", REFUSAL_EVIDENCE),
    FACT_PRODUCER.adapterIngress,
  );
  // A receipt cannot present, and a reading is standing state, so this flush owes no turn: the refusal is CARRIED.
  await pump.flush(sink);
  assert.equal(sink.batches.length, 0, "a refusal with no surface owes no turn of its own - it waits for one");

  // THE WARP: `snapshot_changed/warped` at revision 481, and a clock mark opens the turn the refusal rides.
  pump.enqueueFact(readingFact(readingSnapshot(WARP_REVISION, FARM, 64, 15, 720)), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(clockMark(720, WARP_REVISION), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  const besideNewerWorld = sink.batches.at(-1)?.text ?? "";
  assert.equal(statedRevision(besideNewerWorld), WARP_REVISION, `the batch states the world it reads beside: ${besideNewerWorld}`);
  const carriedInTheBatch = lineAbout(besideNewerWorld, "enter_exit");
  assert.match(carriedInTheBatch, /at_revision=473;stale_because=revision 481/u);
  assert.equal(carriedInTheBatch.includes("current"), false, "a fact from a world she has left is not current");
  assert.match(carriedInTheBatch, /enter_exit 没做成/u, "and the refusal itself still reads as one");
  assertEveryFactLineStatesItsWorld(besideNewerWorld);

  // THE MESSAGE `round91` MEASURED: the same carried world, in a steer - a delivery that states NO world block at all.
  pump.enqueueFact(
    refusal(REFUSAL_REVISION, "enter_exit", "door_out_of_range", REFUSAL_EVIDENCE),
    FACT_PRODUCER.adapterIngress,
  );
  const steered = await new Promise<PendingBatch | undefined>((resolve) => {
    void pump
      .steer({
        async deliver(batch) {
          resolve(batch);
        },
      })
      .then((taken) => {
        if (!taken) resolve(undefined);
      });
  });
  const steerText = steered?.text ?? "";
  assert.equal(steered === undefined, false, "the refusal is steerable, or this replay never reaches round91's message");
  assert.equal(worldStateOf(steerText), undefined, `a steer states no world: ${steerText}`);
  const carriedInTheSteer = lineAbout(steerText, "enter_exit");
  assert.match(
    carriedInTheSteer,
    /at_revision=473;stale_because=revision 481/u,
    `a fact with no world block beside it must not look current: ${steerText}`,
  );
  assertEveryFactLineStatesItsWorld(steerText);
});

test("a_carried_fact_states_the_world_it_belongs_to: a fact at the world it reads beside says current", async () => {
  const pump = new CompanionEventPump();
  const sink = recorder();
  pump.enqueueFact(readingFact(readingSnapshot(WARP_REVISION, FARM, 64, 15, 720)), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    refusal(WARP_REVISION, "enter_exit", "door_out_of_range", "source=64,15;door=64,14;actor=64,15;distance=1"),
    FACT_PRODUCER.adapterIngress,
  );
  pump.enqueueFact(clockMark(720, WARP_REVISION), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);

  const text = sink.batches.at(-1)?.text ?? "";
  const line = lineAbout(text, "enter_exit");
  assert.match(line, /·current$/u, `a fact at the world beside it is stated as that world: ${line}`);
  assert.equal(line.includes("at_revision="), false, "and carries no revision it was not late against");
  assert.equal(line.includes("stale_because="), false);
  assertEveryFactLineStatesItsWorld(text);
});

test("a_carried_fact_states_the_world_it_belongs_to: a fact minted after the reading is not called late", async () => {
  const pump = new CompanionEventPump();
  const sink = recorder();
  pump.enqueueFact(readingFact(readingSnapshot(WARP_REVISION, FARM, 64, 15, 720)), FACT_PRODUCER.adapterIngress);
  // The receipt settled after the last snapshot the pump holds: newer than the world beside it, and late against nothing.
  pump.enqueueFact(
    refusal(WARP_REVISION + 9, "enter_exit", "door_out_of_range", "source=64,15;door=64,14;actor=64,15;distance=1"),
    FACT_PRODUCER.adapterIngress,
  );
  pump.enqueueFact(clockMark(720, WARP_REVISION), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);

  const text = sink.batches.at(-1)?.text ?? "";
  assert.equal(statedRevision(text), WARP_REVISION);
  const line = lineAbout(text, "enter_exit");
  assert.match(line, /·current$/u, `a world that moved past the reading is not a world she has left: ${line}`);
  assert.equal(line.includes("stale_because="), false);
  assertEveryFactLineStatesItsWorld(text);
});
