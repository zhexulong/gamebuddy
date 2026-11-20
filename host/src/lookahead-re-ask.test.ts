import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { composeWorldState, type WorldStateReading } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * `a_lookahead_plan_does_not_ask_for_work_already_in_flight:<tile>`.
 *
 * <p>
 * THE POPULATION IS A REAL RUN. `round82`'s own `result.json` records 103 programme spans, 102 switches between them and
 * four submissions that arrived while the previous programme still had un-settled nodes - the four lookahead compositions
 * that run actually made. The fixture is that run's `programSubmissions` and `programOutcomes` excerpted verbatim, so the
 * gate re-derives the pairs here instead of being told which ones to look at: a run with five overlaps is five cases.
 * </p>
 * <p>
 * WHAT IT MEASURES. For each pair, the tiles the previous programme had NOT got through when the next plan was submitted
 * (the journal's own node settlement, against the next submission's first execution) are the work already queued. The next
 * plan's own node tiles are what it asked for. A composed tile that is also a queued tile is a RE-ASK: the same work,
 * planned twice, paid for twice.
 * </p>
 * <p>
 * THE MECHANISM UNDER TEST IS THE STATE BLOCK. `composeWorldState` is driven with the pair's queued tiles as the journal's
 * in-flight reading (`TargetFreshness.inFlight`), and the assertion is that the block no longer offers them - because the
 * plan is composed from that block and nowhere else.
 * </p>
 * <p>
 * SUBTRACTED BY TILE, NOT BY TARGET. The journal publishes the tile a node addressed (`BodyProgramNodeStatus.x`/`y`) and
 * no opaque target id, so a subtraction removes EVERY row standing on a queued tile - weaker than target identity, and the
 * safe direction: a row that is not offered cannot be worked twice.
 * </p>
 */

type RecordedNode = Readonly<{
  nodeId: string;
  actionId: string;
  tile?: string;
  targetId?: string;
  settledAtMs?: number;
}>;

type RecordedProgramme = Readonly<{ programId: string; firstAtMs: number; nodes: readonly RecordedNode[] }>;

type Round82 = Readonly<{
  source: string;
  spans: readonly Readonly<{ programId: string; firstAtMs: number; lastSettledMs: number }>[];
  pairs: readonly Readonly<{ queuedIn: string; composedAs: string }>[];
  programmes: readonly RecordedProgramme[];
}>;

const ROUND82: Round82 = JSON.parse(
  readFileSync(join(ROOT, "host/src/test-fixtures/lookahead-re-ask-round82.json"), "utf8"),
) as Round82;

/** The reading the block prints: one fixture revision, no age, so a tile's absence cannot be an age effect. */
const readingOver = (tiles: readonly string[]): WorldStateReading => {
  const rows = tiles.map((tile) => {
    const [x, y] = tile.split(":").map(Number);
    return { x: x ?? 0, y: y ?? 0, targetId: `rock_source_${String(x ?? 0)}_${String(y ?? 0)}`, health: 1 };
  });
  const snapshot = {
    revision: 7,
    location: "Farm",
    tile: { x: 40, y: 10 },
    stamina: 254,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 900,
    dayOfMonth: 5,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    toolSlots: [],
    inventoryItemFacts: [],
    rockSourceTargets: rows,
  } as unknown as Snapshot;
  return { snapshot, revision: 7, ageTurns: 0, ageMs: 0, contentAgeMs: 0 };
};

/** The `<world-state>` body of one delivery, so a tile assertion cannot be satisfied by a fact rendered elsewhere. */
function worldStateBody(text: string): string {
  const open = text.indexOf("<world-state>");
  const close = text.indexOf("</world-state>");
  return open < 0 || close < 0 ? "" : text.slice(open, close);
}

/** The block with nothing queued: what the old rule handed the model, and the falsifier's other arm. */
const offeredWith = (tiles: readonly string[], queued: readonly string[]): string =>
  worldStateBody(composeWorldState(readingOver(tiles), undefined, undefined, new Set(queued)));

/** The tiles a programme's nodes named, in node order, de-duplicated. */
function tilesOf(nodes: readonly RecordedNode[]): readonly string[] {
  const tiles: string[] = [];
  for (const node of nodes) if (node.tile !== undefined && !tiles.includes(node.tile)) tiles.push(node.tile);
  return tiles;
}

/** One lookahead composition, re-derived from the run's own records rather than read out of the fixture's pair list. */
type Lookahead = Readonly<{
  queuedIn: string;
  composedAs: string;
  queuedTiles: readonly string[];
  composedTiles: readonly string[];
}>;

/**
 * Every submission `round82` made while another programme still had a node to run, with the tiles on both sides.
 *
 * The queued side is `settledAtMs > composed.firstAtMs`: nodes the journal had not got through when the next plan arrived.
 * A node that settled BEFORE the composition is not queued work, and charging the gate for it would make every later plan
 * a re-ask.
 */
function lookaheads(run: Round82): readonly Lookahead[] {
  const byId = new Map(run.programmes.map((programme) => [programme.programId, programme]));
  const found: Lookahead[] = [];
  for (const pair of run.pairs) {
    const queued = byId.get(pair.queuedIn);
    const composed = byId.get(pair.composedAs);
    if (queued === undefined || composed === undefined) continue;
    const queuedTiles = tilesOf(
      queued.nodes.filter((node) => node.settledAtMs === undefined || node.settledAtMs > composed.firstAtMs),
    );
    found.push({
      queuedIn: pair.queuedIn,
      composedAs: pair.composedAs,
      queuedTiles,
      composedTiles: tilesOf(composed.nodes),
    });
  }
  return found;
}

/**
 * The run's own three numbers, recomputed from the spans it recorded.
 *
 * This is the PRE-P0 BASELINE and it is the only one that exists: 4 overlaps of 102 switches and 992.3 s between programmes
 * out of 1,626 s of wall clock. It is printed here, beside the gate, so the population the gate reasons about and the
 * number the change is supposed to move cannot drift apart. `round84` is what will measure the change - a speed-up claimed
 * without a second run in the same tree is not a measurement.
 */
test("a_lookahead_plan_does_not_ask_for_work_already_in_flight: round82's own overlap and wait", () => {
  let switches = 0;
  let overlaps = 0;
  let waitMs = 0;
  for (let index = 1; index < ROUND82.spans.length; index += 1) {
    const previous = ROUND82.spans[index - 1];
    const current = ROUND82.spans[index];
    assert.ok(previous !== undefined && current !== undefined, "the spans are a dense array");
    switches += 1;
    if (current.firstAtMs < previous.lastSettledMs) overlaps += 1;
    else waitMs += current.firstAtMs - previous.lastSettledMs;
  }
  assert.ok(switches > 0, "an empty span list agrees with itself: the fixture did not load");
  assert.equal(overlaps, ROUND82.pairs.length, `every overlap in the spans is one pair in the fixture: ${overlaps}`);
  console.log(
    `a_lookahead_plan_does_not_ask_for_work_already_in_flight: source ${ROUND82.source} · switches ${String(switches)} · ` +
      `overlap ${String(overlaps)} of ${String(switches)} · program-to-program wait ${(waitMs / 1000).toFixed(1)} s`,
  );
});

/**
 * The gate. `plans P · clean C · re-asked R`, and `R > 0` fails naming the tile and the programme it was queued in.
 *
 * The falsifier is the run's own history: with the subtraction REMOVED, `plan_895` re-asks `plan_894`'s `enter_exit` at
 * `90:15` - a composition that really happened, not one injected here. The other arm is the pair whose tiles are genuinely
 * different (`plan_17` at `25:25` against `plan_14`'s `40:9`), which must stay green or the gate would only be saying
 * "a subtraction happened somewhere".
 */
test("a_lookahead_plan_does_not_ask_for_work_already_in_flight", () => {
  const plans = lookaheads(ROUND82);
  assert.ok(plans.length > 0, "no lookahead composition in the population: the gate would pass over nothing");

  let clean = 0;
  let reAsked = 0;
  const offenders: string[] = [];
  for (const plan of plans) {
    // The block this composition read: the rows its own nodes stood on, minus the tiles the journal said were queued.
    const block = offeredWith(plan.composedTiles, plan.queuedTiles);
    const stillOffered = plan.composedTiles.filter(
      (tile) => plan.queuedTiles.includes(tile) && block.includes(`(${tile.split(":").join(",")})`),
    );
    if (stillOffered.length === 0) {
      clean += 1;
      continue;
    }
    reAsked += 1;
    offenders.push(`${stillOffered.join(",")}:already queued in ${plan.queuedIn}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `a lookahead plan asks for work already in flight: ${offenders.join("; ")} - the block still offers a tile the ` +
      `journal says a queued node is working`,
  );
  assert.equal(clean + reAsked, plans.length, "every composition is counted once");
  console.log(
    `a_lookahead_plan_does_not_ask_for_work_already_in_flight: plans ${String(plans.length)} · clean ${String(clean)} · ` +
      `re-asked ${String(reAsked)} · subtracted by tile, not by target · pairs ${String(ROUND82.pairs.length)} · ` +
      "residual: a movement leg with no sceneTarget is caught by this tile subtraction, not by lookahead eligibility",
  );
});

/**
 * The two falsifiers, on the run's own pairs.
 *
 * <p>
 * FIRST ARM: without the subtraction the gate reds, and it reds on a tile that was really queued twice - `plan_894`'s
 * `enter_exit` at `90:15` still standing in `plan_895`'s block. SECOND ARM: a composition whose tiles nothing had queued
 * stays green, so the gate is not satisfied by "nothing is ever offered".
 * </p>
 */
test("a_lookahead_plan_does_not_ask_for_work_already_in_flight: both directions on real history", () => {
  const plans = lookaheads(ROUND82);
  const reAskedInTheRecord: string[] = [];
  for (const plan of plans)
    for (const tile of plan.composedTiles)
      if (plan.queuedTiles.includes(tile) && !reAskedInTheRecord.includes(`${tile}:${plan.queuedIn}`))
        reAskedInTheRecord.push(`${tile}:${plan.queuedIn}`);

  assert.deepEqual(
    reAskedInTheRecord,
    ["90:15:plan_894_fa2e098ee1b61dd0"],
    "the record must contain the re-ask this gate is written against, or the gate is watching a pair that never " +
      `disagreed: ${reAskedInTheRecord.join(", ")}`,
  );

  // FIRST ARM: the block with the queued tiles NOT subtracted offers the re-asked tile again.
  const withoutSubtraction = offeredWith(["90:15", "90:16"], []);
  assert.match(
    withoutSubtraction,
    /\(90,15\)/u,
    `the un-subtracted block still offers the queued tile: ${withoutSubtraction}`,
  );

  // SECOND ARM: a composition for a tile nothing queued is still composed, so the subtraction is not "offer nothing".
  const differentTargets = offeredWith(["25:25"], ["40:9"]);
  assert.match(
    differentTargets,
    /\(25,25\)/u,
    `a plan for a genuinely different tile is still composable: ${differentTargets}`,
  );
  console.log(
    `a_lookahead_plan_does_not_ask_for_work_already_in_flight: red-on ${reAskedInTheRecord.join(", ")} · ` +
      "green-on 25:25 (queued 40:9)",
  );
});
