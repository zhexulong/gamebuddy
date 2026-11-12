/**
 * GATE `snapshot_publication_stops_without_a_fact`.
 *
 * <p>
 * MEASURED 2026-11-10 (`round45`, session `2026-11-10T22-13-26-690Z`, bundle
 * `tools/_multiday_routine-round45.result.json`): the world reading the companion was re-stated froze at `revision
 * 352` at 22:25:51 and stayed there for the rest of the run - 50 further turns, 30 minutes - while the world moved
 * on. The last turn's own user message says both things in one breath:
 * </p>
 *
 * <pre>
 * &lt;world-state&gt;  世界（revision 352，本轮无新观察）（这是 50 轮之前看到的…）；06:00（清晨）；1年第6天…位置: 农舍
 * &lt;world-facts&gt;  - world_unavailable：saving
 *                - connected：day_started
 *                - 06:00 新的一天：第 7 天
 * </pre>
 *
 * <p>
 * The block claimed day 6 at 06:00 while the block beneath it announced day 7. She passed out twice in between
 * (in-game 02:00, `night_ended_pass_out` at 22:40:48 and 22:55:33), dispatched nothing for the last 30 minutes, and
 * the only trace of the whole thing in the model's input was a parenthetical.
 * </p>
 *
 * <p>
 * WHY NOBODY NOTICED, at the owning layer: the snapshot is never pushed. The Mod answers `snapshot` only to a
 * solicited `observe_request` (`integrations/stardew/BridgeSession.cs:301`), and the Host's one snapshot slot is
 * written only by an admitted `snapshot` fact (`local-stardew-bridge.ts:1016-1022`). Every other fact the Mod
 * publishes carries the ACTION-TRANSACTION revision, which the Mod mints per receipt, not per world frame
 * (`local-stardew-bridge.ts:1095-1116`) - so `revision 400` was reached at 22:28:10 and then stayed put for the rest
 * of the run while the clock, the day, the location and the inventory all changed. Nothing in the product stated the
 * difference between "the world did not change" and "nobody looked", which is the defect this gate exists for.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE PUBLISHER'S OWN BUMP SITES, not a hand-written list: every write to the bridge's admitted
 * snapshot is found in `local-stardew-bridge.ts` and must be accounted for here. A new site fails the gate by name.
 * </p>
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CompanionEventPump, type PendingBatch, type WorldFact } from "./event-pump.js";
import { WORLD_STATE_STALE_TURNS, worldStateStaleThreshold } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The world as the Mod admitted it at `revision 352`, which is the reading the frozen window re-stated 50 times. */
const STUCK_READING = {
  revision: 352,
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
  inventoryItemFacts: [{ slot: 0, qualifiedItemId: "(O)390", displayName: "石头", stack: 25 }],
  cropTargets: [],
  harvestTargets: [],
} as unknown as Snapshot;

function snapshotFact(revision: number, reading: Snapshot = STUCK_READING): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `snapshot_${String(revision)}`,
    correlationId: `observe_${String(revision)}`,
    revision,
    payload: reading as never,
  });
}

/** One world fact, in the shape `tools/_multiday_routine-round45.result.json` recorded it. */
function worldFact(semanticKind: string, gameTime: string, index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `${semanticKind}_${String(index)}`,
    correlationId: `${semanticKind}_${String(index)}`,
    revision: 400,
    observedTick: index,
    gameTime,
    semanticKind,
    payload: Object.freeze({ kind: semanticKind, revision: 400 }) as Readonly<Record<string, unknown>>,
  });
}

/**
 * The Mod's own statement that the world changed: a `semantic_event` whose kind is `snapshot_changed`
 * (`ModEntry.cs:1787`), carrying the revision the action transaction had reached when it fired.
 *
 * <p>
 * MEASURED 2026-11-10 (`round45`): `enter_exit_completed` revision 364 and this fact at revision 364 at 22:26:19, the
 * moment she walked out of the farmhouse. The block the model was handed stayed at `revision 352` for the next fifty
 * turns - so the world had stated it was at 364 and nothing linked that statement to the picture.
 * </p>
 */
function warpFact(revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "semantic_event" as const,
    eventId: `warp_${String(revision)}`,
    correlationId: `warp_${String(revision)}`,
    revision,
    payload: Object.freeze({
      kind: "snapshot_changed",
      revision,
      reasonCode: "warped",
      activeExecution: null,
    }) as Readonly<Record<string, unknown>>,
  });
}

/** One body trace: where her body actually is, which the reading may disagree with. */
function bodyTrace(location: string, x: number, y: number, index: number): WorldFact {
  const revision = 400 + index;
  return Object.freeze({
    source: "stardew_mod",
    kind: "semantic_event" as const,
    eventId: `trace_${String(index)}`,
    correlationId: `trace_transport_${String(index)}`,
    executionId: "exec_route",
    revision,
    payload: Object.freeze({
      kind: "route_progress",
      revision,
      reasonCode: "body_trace",
      bodyTrace: { category: "route_progress", executionId: "exec_route", location, tile: { x, y } },
    }) as Readonly<Record<string, unknown>>,
  });
}

/**
 * The facts the Mod published after the reading froze, in the order the bundle recorded them (22:26:19 - 22:55:40).
 *
 * The first two ARE the measured freeze: the warp out of the farmhouse and her body then standing on the Farm at
 * `(39,15)` while the block said `农舍 (9,9)`. After that the clock walks 12:00 -> 18:00 -> 22:00 -> 24:00 -> 26:00 (a
 * pass-out), then a new day, then the same again: two pass-outs and two day starts on a block still saying day 6.
 */
const FROZEN_WINDOW: readonly WorldFact[] = Object.freeze([
  warpFact(364),
  bodyTrace("Farm", 39, 15, 1),
  worldFact("time_milestone", "1200", 2),
  worldFact("time_milestone", "1800", 3),
  worldFact("time_milestone", "2200", 4),
  worldFact("time_milestone", "2400", 5),
  worldFact("night_ended_pass_out", "2600", 6),
  worldFact("day_started", "0600", 7),
  worldFact("time_milestone", "1200", 8),
  worldFact("night_ended_pass_out", "2600", 9),
  worldFact("day_started", "0600", 10),
]);

/**
 * One delivered turn, admitted in the order the Host admits it: the adapter's fact, the world-stale fact the pump
 * makes due (`takeWorldStateStaleFact`), then the turn (`HostService.acceptIntegrationFact` -> `#flushSoon`,
 * asserted below so this helper cannot drift from it).
 */
async function deliverTurn(pump: CompanionEventPump, fact: WorldFact): Promise<PendingBatch | undefined> {
  pump.enqueueFact(fact);
  const stale = pump.takeWorldStateStaleFact();
  if (stale !== undefined) pump.enqueueFact(stale);
  const batches: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  return batches.at(0);
}

function staleFactsOf(batch: PendingBatch | undefined): readonly WorldFact[] {
  return (batch?.facts ?? []).filter((fact) => fact.semanticKind === "world_state_stale");
}

test("the frozen window publishes a named stale-world fact instead of narrating from a day-old reading", async () => {
  const pump = new CompanionEventPump();
  await deliverTurn(pump, snapshotFact(352));
  const seen: WorldFact[] = [];
  for (const fact of FROZEN_WINDOW) {
    const batch = await deliverTurn(pump, fact);
    seen.push(...staleFactsOf(batch));
  }
  assert.ok(
    seen.length > 0,
    "replayed the frozen window's own facts: the world moved 26 hours and two days ahead of the reading, and no fact said so",
  );
  for (const fact of seen) {
    assert.equal(fact.kind, "world_fact", "a stale world is a world fact, on the same window every other fact uses");
    assert.equal(fact.semanticKind, "world_state_stale");
    assert.equal(
      fact.revision,
      352,
      "the fact must name the revision it is warning about, or a reader cannot tell which reading to replace",
    );
    assert.match(String(fact.payload.code), /^world_state_stale:\d+;352;\d+$/u);
    assert.ok(
      Number(fact.payload.worldChanges) > 0,
      "the fact must say how many times the world contradicted the reading, or it reads as an alarm about silence",
    );
    assert.equal(typeof fact.payload.lastWorldChange, "string");
  }
  // The reading is the SECOND turn old before anything is said: one turn brought it, and the first world fact after that
  // is one turn of narration from it. Below the bound this is still a parenthetical (`fact-brief.ts`), not a fact.
  assert.equal(
    Number(seen[0]?.payload.turns),
    WORLD_STATE_STALE_TURNS,
    "the first stale fact is due at the declared bound, not on the first turn that re-states it",
  );
});

test("a long freeze is a handful of facts, not one per turn", async () => {
  const pump = new CompanionEventPump();
  await deliverTurn(pump, snapshotFact(352));
  const published: number[] = [];
  // Fifty turns: the measured length of the freeze (age 1 through 50 in the session's own words).
  for (let turn = 1; turn <= 50; turn++) {
    const batch = await deliverTurn(pump, worldFact("time_milestone", "1200", turn));
    for (const fact of staleFactsOf(batch)) published.push(Number(fact.payload.turns));
  }
  const expected = [0, 1, 2].map((index) => worldStateStaleThreshold(index));
  assert.deepEqual(
    published,
    expected,
    "the bound re-arms: one fact at the bound, then one per re-arm multiple, never one per turn",
  );
  assert.ok(published.length < 50 / 10, "fifty turns of one frozen reading is at most a handful of facts");
});

test("a fresh observation is the end of the staleness, not a second warning about the old one", async () => {
  const pump = new CompanionEventPump();
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 1; turn++)
    await deliverTurn(pump, worldFact("time_milestone", "1200", turn));
  // The world is observed again, and that observation is itself a member of the closed list: it opens the very turn
  // that delivers it (`TURN_OPENING.observation`), so the age of the reading is measured from here.
  await deliverTurn(pump, snapshotFact(400, { ...STUCK_READING, revision: 400 } as Snapshot));
  const after: WorldFact[] = [];
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS - 1; turn++) {
    const batch = await deliverTurn(pump, worldFact("time_milestone", "1300", 100 + turn));
    after.push(...staleFactsOf(batch));
  }
  assert.deepEqual(after, [], "the reading was one turn old again, so there is nothing stale to name");
  // The observation re-armed the fact instead of silencing it: the turn after the last quiet one is the one that is due,
  // which is the boundary those quiet turns stop exactly one short of.
  const dueAgain = staleFactsOf(await deliverTurn(pump, worldFact("time_milestone", "1300", 199)));
  assert.equal(
    dueAgain.length,
    1,
    "a fresh observation resets the age, and the declared bound is due again from there",
  );
  assert.equal(Number(dueAgain[0]?.payload.turns), WORLD_STATE_STALE_TURNS);
});

test("the world saying it moved is the other half of the claim: a warp alone makes the reading stale", async () => {
  // The measured freeze itself, with the clocks removed: the warp out of the farmhouse at revision 364, and her body
  // standing on the Farm, against a block that says the farmhouse.
  const pump = new CompanionEventPump();
  await deliverTurn(pump, snapshotFact(352));
  const seen: WorldFact[] = [];
  // The warp is the Mod's own statement and starts the turn that carries it. The body traces that follow are PROGRESS
  // facts, which never start a turn of their own (that is the pump's contract), so the turn cadence is the player
  // checking in - and each of those turns carries one more proof that her body is on the Farm.
  seen.push(...staleFactsOf(await deliverTurn(pump, warpFact(364))));
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS; turn++) {
    pump.enqueueFact(bodyTrace("Farm", 39, 15, turn));
    pump.enqueuePlayerInput({
      source: "player_text",
      inputId: `input_${String(turn)}`,
      text: "接着做。",
      locale: "zh-CN",
      timestampMs: 1_790_000_000_000 + turn,
    });
    const stale = pump.takeWorldStateStaleFact();
    if (stale !== undefined) seen.push(stale);
    await pump.flush({
      async deliver() {},
    });
  }
  assert.equal(seen.length, 1, "one warp and a body on another map is a world that moved away from the reading");
  assert.equal(seen[0]?.payload.lastWorldChange, "location:Farm", "the newest contradiction is where the body is");
  assert.equal(seen[0]?.revision, 352, "the fact names the reading it is warning about, never the newest revision");
});

test("a world that never contradicts the reading publishes no stale fact at all", async () => {
  // The other side of the same conjunction: age alone is not evidence. Nothing here says the world moved, so the
  // parenthetical stays a parenthetical - an alarm about silence would be a claim this pump cannot make.
  const pump = new CompanionEventPump();
  await deliverTurn(pump, snapshotFact(352));
  const seen: WorldFact[] = [];
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS * 3; turn++) {
    pump.enqueuePlayerInput({
      source: "player_text",
      inputId: `input_${String(turn)}`,
      text: "接着做。",
      locale: "zh-CN",
      timestampMs: 1_790_000_000_000 + turn,
    });
    const before = pump.takeWorldStateStaleFact();
    if (before !== undefined) seen.push(before);
    await pump.flush({
      async deliver() {},
    });
  }
  assert.deepEqual(seen, [], "an unchanged world that says nothing is not a frozen reading");
});

test("every path that bumps the publisher's snapshot is accounted for, and the silent one is named", () => {
  const source = readFileSync(resolve(hostRoot, "src", "local-stardew-bridge.ts"), "utf8");
  /** Every write to the admitted snapshot in the publisher, keyed by a signature it must contain, with what makes the
   * revision move loud. Population, not a list to trust: a new write site fails the gate by name. */
  const ACCOUNTED: Readonly<Record<string, string>> = Object.freeze({
    "this.#snapshot = null;": "a reader of nothing: the generation is gone, so no reading is claimed",
    "...currentSnapshot":
      "SILENT: a receipt advances the revision and publishes no fact - the stale fact is what makes this one loud",
    "...snapshot": "the admitted observe: the snapshot frame itself reaches the pump as a fact",
  });
  const sites = [...source.matchAll(/^ *this\.#snapshot =[\s\S]*?;$/gmu)].map((match) => match[0].trim());
  assert.ok(sites.length > 0, "examined 0 snapshot writes - a check whose population is empty agrees with itself");
  for (const site of sites) {
    const accounted = Object.entries(ACCOUNTED).find(([signature]) => site.includes(signature));
    assert.ok(accounted !== undefined, `snapshot_revision_site_unaccounted:${site.split("\n")[0] ?? site}`);
    console.log(`snapshot site accounted: ${accounted[1]}`);
  }
  const silent = Object.entries(ACCOUNTED).filter(([, reason]) => reason.startsWith("SILENT"));
  assert.equal(silent.length, 1, "exactly one bump site advances the revision without publishing a fact");
  console.log(
    `snapshot gate: examined ${String(sites.length)} snapshot write site(s); ${String(silent.length)} silent advancement`,
  );
});

test("the Host admits the stale fact on the same path the stall fact uses", () => {
  const source = readFileSync(resolve(hostRoot, "src", "host-service.ts"), "utf8");
  const admitAt = source.indexOf("this.loop.pump.takeWorldStateStaleFact");
  assert.ok(admitAt > 0, "the Host must ask the pump for the stale fact, or the fact is never published");
  assert.ok(
    source.indexOf("this.acceptHostMintedFact(fact)", admitAt) > admitAt,
    "the stale fact must travel the one path every Host-minted fact uses",
  );
  assert.match(
    source.slice(admitAt, admitAt + 600),
    /WORLD_STATE_STALE /u,
    "the fact is published where a run can read it back, the same channel EXECUTION_STALL uses",
  );
});
