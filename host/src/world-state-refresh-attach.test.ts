/**
 * GATE `world_state_refresh_port_attached`: the pump the Game composition builds can refresh a stale reading, and what it
 * asks for is the integration's own observation route.
 *
 * <p>
 * MEASURED 2026-11-10 (`round45`): the world reading froze at `revision 352` for the run's last fifty turns while the clock
 * walked through two pass-outs, and nothing acted on it - being told the picture was old WAS the entire repair, because in
 * a narration loop that is what she does not act on. The pump's own behaviour is pinned in `world-state-refresh.test.ts`
 * with a stub port; what that file cannot read is whether the COMPOSITION installs one, and the pump belongs to the loop
 * `createHostGameRuntimeMaterializer` builds, which nothing the materialized runtime returns carries.
 * </p>
 *
 * <p>
 * So the reading is taken through the one constructor that composition uses (`createGameCompanionLoop`): the loop it
 * returns already holds the pump, and `worldStateRefresh.attached` is the pump's own answer rather than a second spelling
 * of the wiring. Deleting the port from that constructor reds this file by name
 * (`world_state_refresh_port_not_attached`), which is the assertion a source text cannot give.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type CompanionEventPump,
  WORLD_STATE_REFRESH_ATTEMPTS,
  WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND,
  type WorldFact,
} from "./event-pump.js";
import { createGameCompanionLoop } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { worldStateStaleThreshold } from "./fact-brief.js";
import type { GameConnection } from "./game-connection.js";
import type { Snapshot } from "./protocol.js";

/** The world as the Mod admitted it, at `revision`: one frozen reading is the population every crossing is crossed on. */
function reading(revision: number): Snapshot {
  return {
    revision,
    location: "FarmHouse",
    tile: { x: 9, y: 9 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 600,
    dayOfMonth: 6,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Axe",
    currentToolSlot: 0,
    toolSlots: [],
    inventoryItemFacts: [],
    cropTargets: [],
    harvestTargets: [],
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

/** A fact the world really published: the clock moving is what says the held reading is no longer the world. */
function movedFact(revision: number, index: number): WorldFact {
  const kind = "time_milestone";
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `${kind}_${String(revision)}_${String(index)}`,
    correlationId: `${kind}_${String(revision)}_${String(index)}`,
    revision: revision + 500,
    observedTick: index,
    gameTime: "1200",
    semanticKind: kind,
    payload: Object.freeze({ kind, revision: revision + 500 }) as Readonly<Record<string, unknown>>,
  });
}

/** One delivered turn: the fact, then whatever the pump minted for it, in the batch the delivery carries. */
async function deliverTurn(pump: CompanionEventPump, fact: WorldFact): Promise<void> {
  pump.enqueueFact(fact);
  const stale = pump.takeWorldStateStaleFact();
  if (stale !== undefined) pump.enqueueFact(stale);
  await pump.flush({
    async deliver() {
      return undefined;
    },
  });
}

/**
 * The turn on which a held reading first outlives its bound, and the turn that reaches the last of the
 * `WORLD_STATE_REFRESH_ATTEMPTS` thresholds.
 *
 * Both derived from the thresholds the block itself uses (`worldStateStaleThreshold`), so a bound that gains or loses a
 * probe does not have to be found here. The `+ 1` is the turn in which the age is read: a delivery's `ageTurns` counts the
 * deliveries BEFORE the turn that reads it.
 */
const FIRST_STALE_TURN = worldStateStaleThreshold(0) + 1;
const LAST_PROBE_TURN = worldStateStaleThreshold(WORLD_STATE_REFRESH_ATTEMPTS - 1) + 1;

/** A refusal is published from a promise continuation, so it lands after the turn that produced it. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the pump the composition builds reports its stale-refresh port attached, and asks the integration's own route", async () => {
  const asked: unknown[] = [];
  const published: WorldFact[] = [];
  const connection = {
    observe(): Promise<unknown> {
      asked.push(this);
      return Promise.resolve(Object.freeze({}));
    },
  };
  const loop = createGameCompanionLoop({
    session: {} as never,
    connection: connection as unknown as GameConnection,
    publish: (fact) => {
      published.push(fact);
    },
  });
  assert.equal(
    loop.pump.worldStateRefresh.attached,
    true,
    "world_state_refresh_port_not_attached: the loop the Game composition drives came without a port, so every stale " +
      "reading it states is answered by silence - the 601 s of `round45`",
  );
  assert.equal(
    loop.pump.worldStateRefresh.probes,
    0,
    "attaching asks nothing: the first question belongs to a reading that outlived its bound",
  );

  // One crossed reading, read at its first stale turn: the held observation, then the clock walking past its bound.
  await deliverTurn(loop.pump, snapshotFact(352));
  for (let turn = 1; turn <= FIRST_STALE_TURN; turn += 1) await deliverTurn(loop.pump, movedFact(352, turn));
  await drained();

  assert.equal(asked.length, 1, "one crossing is one question, however many turns it lasts");
  assert.equal(
    asked[0],
    connection,
    "the observation must be the connection's OWN route - the one `stardew_observe` calls - not a copy of it",
  );
  assert.deepEqual(published, [], "an observation the integration served is its own answer: nothing is reported here");
});

test("a connection with no observation route is refused by name rather than answered with silence", async () => {
  // The composition runs over whatever `execution.connection` it was given, and a connection that is not the Stardew
  // bridge has no `observe`. That is a route the pump cannot use, which must be SAID rather than skipped.
  const published: WorldFact[] = [];
  const loop = createGameCompanionLoop({
    session: {} as never,
    connection: {} as GameConnection,
    publish: (fact) => {
      published.push(fact);
    },
  });
  await deliverTurn(loop.pump, snapshotFact(352));
  for (let turn = 1; turn <= LAST_PROBE_TURN; turn += 1) await deliverTurn(loop.pump, movedFact(352, turn));
  await drained();

  assert.equal(published.length, 1, "one crossing, one statement");
  assert.equal(published[0]?.semanticKind, WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND);
  assert.equal(
    published[0]?.payload.code,
    "world_state_refresh_refused:world_state_observation_route_unavailable",
    "the reason names the missing route, so a dead bridge and a mis-wired composition are different readings",
  );
});

test("one crossed reading spends its bounded probes and is refused once; the next crossing re-arms", async () => {
  // The bound the run depends on. A bridge that refuses every observation cannot be turned into a spin by a world that
  // never moves: the probe is re-armed by the READING, so each crossing spends `WORLD_STATE_REFRESH_ATTEMPTS` and says one
  // refusal naming the revision it could not replace.
  const refusals: WorldFact[] = [];
  const loop = createGameCompanionLoop({
    session: {} as never,
    connection: {
      observe(): Promise<unknown> {
        return Promise.reject(new Error("bridge_not_authenticated"));
      },
    } as unknown as GameConnection,
    publish: (fact) => {
      refusals.push(fact);
    },
  });
  const readings = [352, 400, 448];
  for (const [index, revision] of readings.entries()) {
    await deliverTurn(loop.pump, snapshotFact(revision));
    for (let turn = 1; turn <= LAST_PROBE_TURN; turn += 1)
      await deliverTurn(loop.pump, movedFact(revision, index * 100 + turn));
    await drained();
  }

  assert.equal(
    refusals.length,
    readings.length,
    `one refusal per crossed reading: ${String(readings.length)} crossings of a bridge that never answers are ` +
      `${String(readings.length)} statements, not one per probe`,
  );
  assert.deepEqual(
    refusals.map((fact) => fact.revision),
    readings,
    "a refusal names the reading it could not replace, and a new reading is a new question",
  );
  for (const fact of refusals)
    assert.equal(
      fact.payload.code,
      "world_state_refresh_refused:bridge_not_authenticated",
      "the reason is the route's own words, not a Host paraphrase of them",
    );
  assert.equal(
    loop.pump.worldStateRefresh.probes,
    readings.length * WORLD_STATE_REFRESH_ATTEMPTS,
    `each crossed reading spends its own ${String(WORLD_STATE_REFRESH_ATTEMPTS)} probes: the bound re-arms on the ` +
      "revision, not on the turn",
  );
  assert.equal(
    loop.pump.worldStateRefresh.refusals,
    readings.length,
    "and one refusal per crossed reading, so a world that never moves cannot become a stream of them",
  );
});
