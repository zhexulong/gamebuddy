/**
 * GATE `environment_facts_record_written`: the line the model actually read is written down, by the layer that delivers
 * the turn.
 *
 * <p>
 * MEASURED 2026-11-21 (`round95`): `round-verdict.mjs` rows 2 and 5 (`2 unwatered false zero`, `5 villager coordinates`)
 * came back `NOT EXERCISED` - "this run has no environment-facts.jsonl: it predates the record" - on a run that was
 * supposed to write one. The recorder existed and nothing called it: the Game mount had stopped registering the
 * environment provider the record hung off (the facts reach the turn once, in `<world-state>`), so the file lost its
 * producer and the verdict blamed the run for not having a record it never wrote.
 * </p>
 *
 * <p>
 * So the producer moved to the turn: the pump hands each delivery's render to the recorder, and this file asserts three
 * things the file's absence could not - the recorded text IS the paragraph's, the revision is the reading the turn stated,
 * and a steer (whose block is withheld) records nothing. Deleting the attach reds this file by name.
 * </p>
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEnvironmentFactsRecord, type EnvironmentFactsRenderRecord } from "./environment-facts-record.js";
import { CompanionEventPump, FACT_PRODUCER, type PendingBatch, type WorldFact } from "./event-pump.js";
import { formatGameEnvironmentFacts } from "./game-world-vocabulary.js";
import type { GameConnection } from "./game-connection.js";
import type { Snapshot } from "./protocol.js";
import { createGameCompanionLoop } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";

/**
 * A world with the two facts rows 2 and 5 are about: 24 unwatered crops on her map, and a villager she could walk to.
 *
 * Both are rendered from the reading the TURN states, so a line recorded here is what the prompt carried - and the two
 * patterns the verdict reads are asserted against it below rather than assumed.
 */
function reading(revision: number): Snapshot {
  return {
    revision,
    location: "Farm",
    tile: { x: 60, y: 20 },
    timeOfDay: 600,
    dayOfMonth: 6,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    stamina: 270,
    exhausted: false,
    presentationLocale: "zh-CN",
    villagerWhereabouts: [
      {
        targetId: "npc_relationship_Shane",
        npcName: "Shane",
        displayName: "谢恩",
        location: "Farm",
        x: 72,
        y: 18,
        inCurrentLocation: true,
      },
    ],
    wateringWhereabouts: [{ location: "Farm", needsWaterCount: 24, nearestX: 18, nearestY: 16 }],
  } as unknown as Snapshot;
}

function snapshotFact(revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `snapshot_${String(revision)}`,
    correlationId: `observe_${String(revision)}`,
    revision,
    payload: reading(revision) as never,
  });
}

/** One turn the person opened, and the text the sink was handed. A reading alone opens nothing (`TURN_OPENING`). */
async function deliverSaying(pump: CompanionEventPump, revision: number, words: string): Promise<string> {
  pump.enqueueFact(snapshotFact(revision), FACT_PRODUCER.worldStateRefreshRefused);
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: `player_input_${String(revision)}`,
    text: words,
    locale: "zh-CN",
    timestampMs: 1_790_000_000_000,
  });
  const delivered: string[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch.text);
      return undefined;
    },
  });
  assert.equal(delivered.length, 1, `one turn per delivery: ${String(delivered.length)} batches for revision ${String(revision)}`);
  return delivered[0] as string;
}

function readRecords(recordPath: string): EnvironmentFactsRenderRecord[] {
  // A record nobody wrote is an empty population, not a crash: the assertion that follows is the reading.
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EnvironmentFactsRenderRecord);
}

test("every delivered turn records the environment line it stated, verbatim and with its own revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-pump-environment-facts-"));
  const recordPath = join(dir, "environment-facts.jsonl");
  try {
    const pump = new CompanionEventPump();
    pump.attachEnvironmentFactsRecord(createEnvironmentFactsRecord(recordPath));
    assert.equal(pump.environmentFactsRecord.attached, true, "the attach is a reading, not a call nobody can see");

    const firstText = await deliverSaying(pump, 4123, "去浇水吧。");
    const secondText = await deliverSaying(pump, 4124, "现在呢？");

    const records = readRecords(recordPath);
    assert.deepEqual(
      records.map((record) => record.revision),
      [4123, 4124],
      "one line per delivered turn, each naming the reading it stated",
    );
    const [first, second] = records as [EnvironmentFactsRenderRecord, EnvironmentFactsRenderRecord];

    // THE PROOF THE ROW NEEDS: the recorded bytes are the delivered bytes. A record that re-rendered the world for itself
    // could describe a paragraph no turn ever carried, which is the defect the old connection-reading provider had.
    assert.equal(first.text, formatGameEnvironmentFacts(reading(4123), true));
    assert.ok(
      firstText.includes(first.text),
      `the recorded line is not inside the delivered turn, so it is not what the model read:\n${firstText}`,
    );
    assert.ok(secondText.includes(second.text), secondText);
    assert.equal(first.bytes, Buffer.byteLength(first.text, "utf8"));
    assert.equal(first.overCap, false);
    assert.equal(first.dropped, undefined, "nothing was dropped here, so the key is absent");

    // WHAT ROWS 2 AND 5 CAN NOW ANSWER, on the very line that was delivered: the verdict's own patterns, not a claim that
    // they would match.
    assert.match(first.text, /待浇水作物: 24/u, "row 2 reads a non-zero unwatered count off this line");
    assert.match(first.text, /本图可去: [^、]*\(\d+,\d+\)/u, "row 5 reads a villager destination with its tile off it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The Mod's own clock mark: the one steerable fact that is not a receipt (`PRESENTATION_LEASE_KINDS`), and the shape a
 * steer carries while a turn is running.
 */
function timeMilestone(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "time_milestone_600",
    sourceEventId: "time_milestone_600",
    correlationId: "time_milestone_600",
    revision: 1,
    observedTick: 1000,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: 600 }),
  });
}

test("a steer records nothing: its block is withheld, so no environment line was read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-pump-environment-facts-steer-"));
  const recordPath = join(dir, "environment-facts.jsonl");
  try {
    const pump = new CompanionEventPump();
    pump.attachEnvironmentFactsRecord(createEnvironmentFactsRecord(recordPath));
    await deliverSaying(pump, 4123, "去浇水吧。");
    assert.equal(readRecords(recordPath).length, 1, "the delivered turn is recorded");

    // A steer lands INSIDE a running turn, so its `<world-state>` is withheld (`takeSteerableOnly`): the fact it carries
    // is delivered, the world line is not - and a record that counted it would claim the model read a block it never got.
    pump.enqueueFact(timeMilestone(), FACT_PRODUCER.worldStateRefreshRefused);
    const steered: PendingBatch[] = [];
    const handed = await pump.steer({
      async deliver(batch) {
        steered.push(batch);
      },
    });
    assert.equal(handed, true, "the fixture steers: a clock mark is the one opener a steer carries");
    assert.equal(steered.length, 1);
    assert.doesNotMatch(steered[0]?.text ?? "", /<world-state>/u, "the steer states no world");
    assert.equal(readRecords(recordPath).length, 1, "a withheld block writes no line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop the Game composition builds comes with a recorder, so no mount can skip the record", () => {
  const loop = createGameCompanionLoop({
    session: {} as never,
    connection: {} as GameConnection,
    publish: () => {},
    environmentFactsRecord: () => {},
  });
  assert.equal(
    loop.pump.environmentFactsRecord.attached,
    true,
    "environment_facts_record_not_attached: the mount was handed a recorder and the pump did not receive it, so every " +
      "turn of that run read a paragraph nobody wrote down (`round95`) -",
  );
});

test("a pump with no recorder writes nothing and says so, rather than throwing on every turn", async () => {
  const pump = new CompanionEventPump();
  assert.equal(pump.environmentFactsRecord.attached, false);
  await deliverSaying(pump, 4123, "去浇水吧。");
  assert.equal(pump.environmentFactsRecord.attached, false, "delivering does not silently attach one");
});
