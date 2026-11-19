/**
 * GATE `a_prompt_states_an_older_world_than_it_knows:<site>`.
 *
 * <p>
 * HER PROMPT WENT BACKWARDS IN TIME, and the audit has the revision numbers. Measured 2026-11-18 (`round76`, her own
 * session): `15:02:20.870` her `stardew_observe` answered `revision 325` at `(3,11)` inside the farmhouse, and
 * `15:02:20.872` - two milliseconds later, in the same turn - a steer handed her `revision 321` at `(63,15)` out on the
 * farm, `本轮无新观察`. She then reasoned about a floor she had already walked onto.
 * </p>
 *
 * <p>
 * THEN `round77` SHOWED THE OTHER HALF, and it is the half a moved reading does not survive: the same inversion with the
 * steer's reading labelled `刚刚更新`, twice, in the pairs recorded at `C:\Users\long\AppData\Local\GameBuddy\contexts\
 * 71b6fbe7...\surface-sessions\game-1795063635460\sessions\2026-11-19T04-47-16-259Z_....jsonl`:
 * </p>
 * <pre>
 *   #54 toolResult stardew_observe 04:48:43.002  revision 110  (08:00, 山间小路 14,39)
 *   #58 toolResult stardew_observe 04:48:48.689  revision 111  (08:10, 山间小路 14,39)
 *   #59 user       steer           04:48:48.691  revision 110  (08:00, 山间小路 14,39)  刚刚更新
 *   #66 toolResult stardew_observe 04:49:00.469  revision 112  (08:20, 山间小路 14,39)
 *   #67 user       steer           04:49:00.472  revision 111  (08:10, 山间小路 14,39)  刚刚更新
 * </pre>
 * <p>
 * Both steers were composed from the newest reading the pump held (`04:48:46.391` and `04:48:58.034`) and appended to the
 * conversation only after the running turn's own tool calls answered a NEWER one - so a comparison the pump makes at
 * composition is equal in both pairs, and the rule `bdbfd955` kept ("a moved reading is news") is exactly the case that
 * fired. Hence the fix this file now measures: a steer states no world at all, and the reading is stated by the next turn.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE COMPOSER SITES, read from the production sources rather than listed here: a fourth place that
 * composes a world-state block for a prompt fails this file until it is measured. Each site is NAMED by its enclosing
 * method and driven for real - `takeBatch` through `flush`, `takeSteerableOnly` through `steer`, and
 * `composeObservationBody` through the observation tool itself - and `older` counts the deliveries whose stated revision
 * was below the newest reading held at that moment.
 * </p>
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CompanionEventPump,
  FACT_PRODUCER,
  type PendingBatch,
  type WorldFact,
  readingClockOrdinal,
  readingIsOlderThan,
} from "./event-pump.js";
import { composeFactBrief } from "./fact-brief.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import type { Scope, Snapshot } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

const SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_round77",
  worldId: "world_round77",
  playerId: "farmhand_01",
  companionId: "companion_01",
});

/** The world of `round77`'s session: the mountain path at `(14,39)`, day 5, one reading per clock mark. */
function mountainPath(revision: number, timeOfDay: number, day = 5): Snapshot {
  return {
    revision,
    location: "Backwoods",
    tile: { x: 14, y: 39 },
    stamina: 254.20001,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay,
    dayOfMonth: day,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Axe",
    currentToolSlot: 0,
    toolSlots: [{ slot: 0, label: "(T)Axe", category: "axe", upgradeLevel: 0 }],
    inventoryItemFacts: [],
  } as unknown as Snapshot;
}

function snapshotFact(snapshot: Snapshot, eventId: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId,
    correlationId: eventId,
    revision: snapshot.revision,
    payload: snapshot as never,
  });
}

/** The Mod's own clock mark: presentable, and the one opener that is not a receipt. */
function clockMark(timeOfDay: number, day = 5): WorldFact {
  const eventId = `time_milestone_${String(day)}_${String(timeOfDay)}`;
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 1,
    observedTick: timeOfDay,
    semanticKind: "time_milestone",
    payload: Object.freeze({ kind: "time_milestone", milestone: timeOfDay }),
  });
}

/** A receipt the pump classifies as preempting: terminal and unproved, so a steer carries it into the running turn. */
function refusalReceipt(executionId: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    eventId: executionId,
    correlationId: executionId,
    revision: 111,
    executionId,
    requestId: `request_${executionId}`,
    payload: Object.freeze({
      executionId,
      requestId: `request_${executionId}`,
      action: "navigate_to_destination",
      state: "failed",
      reasonCode: "destination_unreachable",
      evidence: null,
      revision: 111,
    }),
  }) as WorldFact;
}

/** The block a delivery's text carries, or `undefined` when it carries none. */
function worldStateOf(text: string): string | undefined {
  return /<world-state>\n([\s\S]*?)\n<\/world-state>/u.exec(text)?.[1];
}

/** The revision a text states, or `undefined` for a delivery that states no world at all. */
function statedRevisionOf(text: string): number | undefined {
  const block = worldStateOf(text);
  if (block === undefined) return undefined;
  const matched = /世界（revision (\d+)/u.exec(block);
  assert.ok(matched !== null, `a world block always names its reading: ${block}`);
  return Number(matched[1]);
}

/** One delivery, as the gate compares it: what the text stated, and the newest reading the Host had already put in
 * front of the model at that instant. */
type SiteDelivery = Readonly<{
  site: string;
  stated: number | undefined;
  newest: number | undefined;
  text: string;
}>;

/** Every production file under `host/src`, which is the population the composer sites are read from. */
function productionSources(): readonly string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .filter((entry) => !entry.startsWith("test-support") && !entry.startsWith("test-fixtures"))
    .map((entry) => entry.split(path.sep).join("/"));
}

/** A named function, or a class method whose `private`/`public` modifier puts it two spaces in. */
const DECLARATION =
  /^\s{0,2}(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^\s{2}(?:private|public|protected)\s+(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\(/gmu;

/** The method a composer call sits in, read from the source above it. */
function enclosingMethod(text: string, at: number): string {
  let name = "?";
  for (const match of text.slice(0, at).matchAll(DECLARATION)) name = match[1] ?? match[2] ?? name;
  return name;
}

/**
 * Every place that composes a world-state block for a prompt, named by the method that composes it.
 *
 * A file can hold two of them, and `round77`'s defect lived in the one that is not the turn's - which is why the name is
 * the method rather than the file.
 */
function composerSites(): readonly string[] {
  const sites: string[] = [];
  for (const file of productionSources()) {
    if (file === "fact-brief.ts") continue;
    const text = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    for (const composer of ["composeFactBrief(", "composeWorldState("])
      for (let at = text.indexOf(composer); at >= 0; at = text.indexOf(composer, at + 1))
        sites.push(`${file}:${enclosingMethod(text, at)}`);
  }
  return Object.freeze(sites.sort());
}

/**
 * The turn `round77` recorded, delivered in the order the model READ it, through all three composer sites.
 *
 * <p>
 * The order is the whole point and it is the session's: a turn opens on the pump's held reading (`takeBatch`), the
 * turn's own `stardew_observe` answers a NEWER one while the steer is already queued (`composeObservationBody`), and then
 * the steer is read (`takeSteerableOnly`) - composed 2.3 s earlier from what the pump still held. That is why the
 * comparison for a steer cannot be against the pump's own slot: at composition the two are equal, and the newest reading
 * the model had was the observation's.
 * </p>
 */
async function round77Sequence(): Promise<readonly SiteDelivery[]> {
  const deliveries: SiteDelivery[] = [];
  const record = (site: string, text: string): void => {
    deliveries.push({ site, stated: statedRevisionOf(text), newest: undefined, text });
  };
  const pump = new CompanionEventPump();

  // The bridge's live revision, which only the observation tool reads: the pump learns it a push later.
  const state = {
    connected: true,
    sessionId: "session_round77",
    capabilities: [] as readonly string[],
    catalogRegistrations: [],
    catalogRevision: 3,
    enabledActionIds: [] as readonly string[],
    snapshot: mountainPath(110, 480) as Snapshot | null,
    latestReceipt: null,
    latestReasonCode: null,
  };
  const connection: StardewBridgeConnection = {
    scope: SCOPE,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return state;
    },
  };
  const [observe] = createStardewObservationTools(connection);
  assert.ok(observe !== undefined, "the observation tool must be mounted, or its composer cannot be measured");
  const observeNow = async (snapshot: Snapshot): Promise<void> => {
    state.snapshot = snapshot;
    const answer = await observe.execute("gate", {}, new AbortController().signal, () => {}, {} as never);
    record("game-tools.ts:composeObservationBody", answer.content[0]?.type === "text" ? answer.content[0].text : "");
  };

  // PAIR 1. The turn opens on 110; the observation answers 111; the steer is composed from the 110 the pump holds.
  pump.enqueueFact(snapshotFact(mountainPath(110, 480), "reading_110"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(clockMark(480), FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver(batch: PendingBatch) {
      record("event-pump.ts:takeBatch", batch.text);
    },
  });
  await observeNow(mountainPath(111, 490));
  pump.enqueueFact(refusalReceipt("exec_refused_110"), FACT_PRODUCER.adapterIngress);
  await pump.steer({
    async deliver(batch: PendingBatch) {
      record("event-pump.ts:takeSteerableOnly", batch.text);
    },
  });

  // PAIR 2, the same shape one clock mark on: the pump has caught up to 111, and the observation answers 112.
  pump.enqueueFact(snapshotFact(mountainPath(111, 490), "reading_111"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(clockMark(490), FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver(batch: PendingBatch) {
      record("event-pump.ts:takeBatch", batch.text);
    },
  });
  await observeNow(mountainPath(112, 500));
  pump.enqueueFact(refusalReceipt("exec_refused_111"), FACT_PRODUCER.adapterIngress);
  await pump.steer({
    async deliver(batch: PendingBatch) {
      record("event-pump.ts:takeSteerableOnly", batch.text);
    },
  });

  // THE HIGH-WATER MARK, threaded in the order the model read them: the newest revision the Host had already put in front
  // of the model (`stated`) or held at that moment.
  let newest: number | undefined;
  return Object.freeze(
    deliveries.map((delivery) => {
      const row = Object.freeze({ ...delivery, newest });
      newest = delivery.stated === undefined ? newest : Math.max(newest ?? delivery.stated, delivery.stated);
      return row;
    }),
  );
}

test("a_prompt_states_an_older_world_than_it_knows: the reading's own clock decides which picture is older", async () => {
  // THE FALSIFIER FOR THE GUARD THIS REPLACES: the Mod's counter is EQUAL for both readings, so the shipped expression
  // could not tell them apart and the older one won the slot.
  const laterSameCounter = snapshotFact(mountainPath(46, 720), "later"); // day 5, 07:20 - the clock walked on
  const earlierSameCounter = snapshotFact(mountainPath(46, 710), "earlier"); // day 5, 07:10, the SAME counter
  assert.equal(
    earlierSameCounter.revision < laterSameCounter.revision,
    false,
    "the counter is the same number for two observations an hour apart: it cannot order them",
  );
  assert.equal(readingIsOlderThan(earlierSameCounter, laterSameCounter), true, "the older picture must lose the slot");
  assert.equal(readingIsOlderThan(laterSameCounter, earlierSameCounter), false, "and the newer one must win it");

  // A DAY ONLY EVER ADVANCES, even though the clock restarts: 25:00 on day 4 is before 06:00 on day 5.
  const lateNight = snapshotFact(mountainPath(46, 2500, 4), "late");
  const nextMorning = snapshotFact(mountainPath(47, 600, 5), "morning");
  assert.equal(readingIsOlderThan(nextMorning, lateNight), false, "a day boundary is forward, whatever the clock says");
  assert.equal(readingIsOlderThan(lateNight, nextMorning), true, "and the night before it is behind");

  // NO CLAIM, NO REFUSAL: a world-not-ready payload publishes zeroes, and a currency that read 0 as "older than
  // everything" would refuse the reading that says the world is gone.
  assert.equal(readingClockOrdinal({ timeOfDay: 0, dayOfMonth: 0, seasonIndex: 0, year: 0 }), undefined);
  const notReady = snapshotFact({ revision: 48, location: "Farm", tile: { x: 0, y: 0 }, payload: {} } as never, "nr");
  assert.equal(readingIsOlderThan(notReady, nextMorning), false, "a reading with no clock falls back to the counter");

  // AND THE SLOT ITSELF: an equal-counter, older-clock reading that arrives later must not replace what is held.
  const pump = new CompanionEventPump();
  pump.enqueueFact(laterSameCounter, FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(earlierSameCounter, FACT_PRODUCER.adapterIngress);
  assert.equal(pump.worldStateDelivery.newest, 46, "the held revision");
  pump.enqueueFact(clockMark(720), FACT_PRODUCER.adapterIngress);
  let held: PendingBatch | undefined;
  await pump.flush({
    async deliver(batch: PendingBatch) {
      held = batch;
    },
  });
  assert.equal(statedRevisionOf(held?.text ?? ""), 46);
  assert.match(worldStateOf(held?.text ?? "") ?? "", /07:20/u, "the block must state the NEWER picture");
});

/**
 * THE FALSIFIER IS THE REAL THING: both pairs of `round77`, replayed from the message bodies the session recorded.
 *
 * <p>
 * The pump is given exactly what it held when each steer was composed - the reading the steer itself states, which the
 * transcript labels `刚刚更新` - and each pair's newer reading is the one the running turn's own `stardew_observe`
 * answered after the steer had already been handed over. That reading never reaches the pump, so this replay asserts the
 * pump's own knowledge is not the thing that could have caught it, and the steer's text is what the model reads.
 * </p>
 */
test("a_prompt_states_an_older_world_than_it_knows: round77's two pairs, before and after", async () => {
  const pairs = [
    { steer: 110, clock: 480, observedAfterwards: 111, observedClock: 490 },
    { steer: 111, clock: 490, observedAfterwards: 112, observedClock: 500 },
  ];

  for (const pair of pairs) {
    const pump = new CompanionEventPump();
    const reading = mountainPath(pair.steer, pair.clock);
    pump.enqueueFact(snapshotFact(reading, `reading_${String(pair.steer)}`), FACT_PRODUCER.adapterIngress);
    pump.enqueueFact(clockMark(pair.clock), FACT_PRODUCER.adapterIngress);
    await pump.flush({ async deliver() {} });

    // WHAT THE PRE-FIX STEER SAID: the same composer, the same reading, the same `刚刚更新` the session recorded. This is
    // the block that landed two milliseconds AFTER the observation of the newer revision.
    const preFix = composeFactBrief({
      inputs: [],
      snapshot: { snapshot: reading, revision: pair.steer, ageTurns: 0, ageMs: 0, contentAgeMs: 0 },
      events: [],
      locale: "zh-CN",
    });
    assert.equal(statedRevisionOf(preFix), pair.steer, `the pre-fix steer re-stated the older reading: ${preFix}`);
    assert.match(preFix, /刚刚更新/u, "and labelled it current, which is the claim about currency that was false");

    // THE PUMP'S OWN KNOWLEDGE CANNOT DECIDE THIS: at composition the steer's reading IS the newest it holds, so a
    // comparison inside the pump is equal in both pairs. The newer reading exists only in the turn's tool result.
    assert.equal(pump.worldStateDelivery.newest, pair.steer, "the steer's reading is what the pump holds");
    assert.ok(pair.observedAfterwards > pump.worldStateDelivery.newest, "and the turn had already read a newer one");

    pump.enqueueFact(refusalReceipt(`exec_refused_${String(pair.steer)}`), FACT_PRODUCER.adapterIngress);
    let steered: PendingBatch | undefined;
    const took = await pump.steer({
      async deliver(batch: PendingBatch) {
        steered = batch;
      },
    });
    assert.equal(took, true, "the refusal is steerable, or this replay never reaches the steer");

    // AFTER: the steer states no world, so it cannot state an older one - and the obstruction itself still reaches her.
    assert.equal(statedRevisionOf(steered?.text ?? ""), undefined, `the steer states no world: ${steered?.text ?? ""}`);
    assert.equal((steered?.text ?? "").includes("刚刚更新"), false, "and never claims currency it cannot have");
    assert.match(steered?.text ?? "", /destination_unreachable/u, "the Mod's own reason still arrives verbatim");
    assert.equal(pump.worldStateDelivery.withheld.older.count, 1, "the withheld block is counted by name");
    assert.equal(
      pump.worldStateDelivery.withheld.older.held,
      pair.steer,
      "and the reading it withheld is named (`world_state_withheld:older:<held>`)",
    );

    // THE READING IS NOT LOST: it is standing state, and the next turn states it - a moved reading opens that turn.
    pump.enqueueFact(clockMark(pair.observedClock), FACT_PRODUCER.adapterIngress);
    let next: PendingBatch | undefined;
    await pump.flush({
      async deliver(batch: PendingBatch) {
        next = batch;
      },
    });
    assert.equal(statedRevisionOf(next?.text ?? ""), pair.steer, "the turn that follows states the world instead");
  }
});

/**
 * THE GATE ITSELF: every composer site, driven, and every delivery's stated revision read against the newest revision
 * the Host had already put in front of the model at that instant.
 *
 * `older` is a stated revision below that high-water mark - the exact inversion the audit found, and the only comparison
 * that sees it: at the steer's COMPOSITION the pump's own slot equals what it states (both pairs of `round77` were equal),
 * so a gate measured against the pump's slot alone would have stayed green through both of them. A delivery that states
 * NOTHING is `current`: it makes no claim to be wrong about.
 */
test("a_prompt_states_an_older_world_than_it_knows: every composer site states the newest reading it holds", async () => {
  const sites = composerSites();
  const deliveries = await round77Sequence();
  const examined = new Set(deliveries.map((delivery) => delivery.site)).size;
  const older = deliveries.filter(
    (delivery) => delivery.stated !== undefined && delivery.newest !== undefined && delivery.stated < delivery.newest,
  );
  console.log(
    `a_prompt_states_an_older_world_than_it_knows · sites examined ${String(examined)} · current ${String(
      deliveries.length - older.length,
    )} · older ${String(older.length)}`,
  );

  assert.deepEqual(
    sites,
    ["event-pump.ts:takeBatch", "event-pump.ts:takeSteerableOnly", "game-tools.ts:composeObservationBody"],
    "a NEW place composes a world-state block for a prompt; measure it here before it ships",
  );
  assert.ok(examined > 0, "zero sites is blocked, never green: the population is the sources' own composers");
  assert.deepEqual(
    [...new Set(deliveries.map((delivery) => delivery.site))].sort(),
    sites,
    "every composer site must be DRIVEN here, not merely listed",
  );
  assert.deepEqual(
    older.map(
      (delivery) =>
        `${delivery.site} stated revision ${String(delivery.stated)} where ${String(delivery.newest)} had already been delivered`,
    ),
    [],
    "a prompt stated a world older than the newest reading the Host had already shown",
  );

  // THE STEER IS THE SITE THAT CANNOT BE FIXED BY A COMPARISON, so it is asserted on the text rather than on numbers:
  // no block and no `刚刚更新`, whatever the reading was.
  const steers = deliveries.filter((delivery) => delivery.site === "event-pump.ts:takeSteerableOnly");
  assert.deepEqual(
    steers.map((delivery) => delivery.text.includes("<world-state>")),
    steers.map(() => false),
    "a steer states no world block at all",
  );
  assert.deepEqual(
    steers.map((delivery) => delivery.text.includes("刚刚更新")),
    steers.map(() => false),
    "and never prints the word that claims its reading is current",
  );
  // THE OTHER TWO STATE A WORLD, so the rule above is a narrow one and not a blanket silence.
  assert.deepEqual(
    deliveries
      .filter((delivery) => delivery.site !== "event-pump.ts:takeSteerableOnly")
      .map((delivery) => delivery.stated),
    [110, 111, 111, 112],
    "the turn and the observation both state the reading they hold",
  );
  // AND THE HIGH-WATER MARK IS READ BACK, so `older 0` is not a green that agrees with itself.
  assert.deepEqual(
    deliveries.map((delivery) => delivery.newest),
    [undefined, 110, 111, 111, 111, 112],
    "the sequence the model read them in, with the newest revision it had at each point",
  );
});
