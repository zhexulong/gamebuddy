// red-proof: in judgeCatch, `require("pull_outcome", "not_verified")` deleted
//  -> `✖ the pull's own outcome is demanded, and a receipt that claims it was watched fails`
//     (+ fish_here_evidence_pull_outcome:verified:not_verified, 1 !== 2 violations), exit 1
// red-proof: in judgeParity, `outside: outside.length` replaced by `outside: 0`
//  -> `✖ a caught species the reader did not publish is the disagreement this half exists for` (0 !== 1), exit 1
// red-proof: in publishedCatchable, the `catchableOmitted` refusal deleted
//  -> `✖ a capped species list is refused by name, not read as a disagreement` (the truncated set passed), exit 1
import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveWaterTargetId,
  judgeCatch,
  judgeDryTileRefusal,
  judgeParity,
  parityNotMeasuredIsStructural,
  paritySampleCount,
  publishedCatchable,
  readReaderCensus,
} from "./run-stardew-native-local-player-fish-here-smoke.mjs";

/**
 * The fish_here live judgement, tested DIRECTLY.
 *
 * The judgement is pure - evidence text in, named violations out - so no transport is faked here: every case below is a
 * shape the LIVE run could lie in, not a mock's idea of the wire. The one wire shape that IS copied (the `LocationFish`
 * row) is copied from a recorded answer of the real Mod, and the address it is paired with is the one that same run
 * published.
 */

const TARGET_ID = "water_254b7a3116211750";
const TILE = "72,30";

/** The evidence of the first live cast ever recorded for this action (2026-11-14, Farm, spring 1 Y1, 06:00). */
const EVIDENCE = {
  location: "Farm",
  target: TARGET_ID,
  tile: TILE,
  caught_qualified_item_id: "(O)145",
  display_name: "太阳鱼",
  fish_size: "6",
  quality: "0",
  pull_outcome: "not_verified",
  pull_unobserved_field: "BobberBar.distanceFromCatching",
  bite_observed: "isNibbling",
  cast_to_credit_ms: "8817",
  rod_durability_left: "-1",
  bait_before: "20",
  bait_left: "19",
  bait_consumed: "1",
  stamina_before: "270",
  stamina_after: "262",
  stamina_delta: "-8",
  inventory_before: "0",
  inventory_after: "1",
  fish_caught_before: "0",
  fish_caught_after: "1",
  fish_caught_delta: "1",
};

const judge = (evidence) => judgeCatch(evidence, { targetId: TARGET_ID, tile: TILE });

test("the recorded live catch passes every check", () => {
  assert.deepEqual(judge(EVIDENCE), []);
});

test("a catch the engine never booked fails on the credit, not on a wording", () => {
  assert.deepEqual(judge({ ...EVIDENCE, fish_caught_after: "0", fish_caught_delta: "0" }), [
    "fish_here_catch_not_credited:before=0;after=0;fish=(O)145",
  ]);
});

test("a bait stack that did not shrink fails: the cost is a fact, not a label", () => {
  assert.deepEqual(judge({ ...EVIDENCE, bait_left: "20", bait_consumed: "0" }), [
    "fish_here_bait_not_consumed:before=20;left=20",
  ]);
});

test("the pull's own outcome is demanded, and a receipt that claims it was watched fails", () => {
  // The action cannot play `BobberBar`, so `not_verified` is the only honest answer here. This is the assertion that
  // replaces `was_perfect=true`, which the Mod stopped publishing in `4e40b8ca` - and the reason the action's first
  // live receipt was reported as blocked while the catch itself was real.
  assert.deepEqual(judge({ ...EVIDENCE, pull_outcome: "verified" }), [
    "fish_here_evidence_pull_outcome:verified:not_verified",
  ]);
});

test("naming the unobserved field is part of the claim, not decoration", () => {
  assert.deepEqual(judge({ ...EVIDENCE, pull_unobserved_field: "" }), ["fish_here_pull_unobserved_field_missing"]);
});

test("a receipt that reverts to `was_perfect` is a violation, never a pass", () => {
  const reverted = { ...EVIDENCE, was_perfect: "true", was_perfect_basis: "declared_by_action" };
  delete reverted.pull_outcome;
  assert.deepEqual(judge(reverted), ["fish_here_evidence_pull_outcome:missing:not_verified"]);
});

test("the credited fish is also the fish that reached the pack", () => {
  assert.deepEqual(judge({ ...EVIDENCE, inventory_after: "0" }), [
    "fish_here_fish_not_in_pack:before=0;after=0;fish=(O)145",
  ]);
});

test("a dry tile is refused by name, at that tile", () => {
  assert.deepEqual(
    judgeDryTileRefusal(
      {
        state: "rejected",
        reasonCode: "water_not_fishable:not_water",
        evidence: { detail: `location=Farm;tile=${TILE}` },
      },
      { tile: TILE },
    ),
    [],
  );
});

test("a tile no walk can reach is refused by the wall it is behind, and the case accepts that answer", () => {
  // The live world produced this one: the actor is boxed in by water, so a tile the map does not contain answers
  // `no_cuttable_blocker:water` before any geometry is asked. It is the same claim - no water to fish here - and the
  // refusal names the blocker instead of a tile, which is why the tile check does not apply to it.
  assert.deepEqual(
    judgeDryTileRefusal(
      {
        state: "rejected",
        reasonCode: "no_cuttable_blocker:water",
        evidence: { detail: "blocked_by=no_cuttable_blocker:water" },
      },
      { tile: TILE },
    ),
    [],
  );
});

test("a cast at a dry tile fails even when it succeeded", () => {
  assert.deepEqual(
    judgeDryTileRefusal(
      { state: "succeeded", reasonCode: "fish_caught", evidence: { detail: `location=Farm;tile=${TILE}` } },
      { tile: TILE },
    ),
    ["fish_here_dry_tile_not_refused:succeeded/fish_caught"],
  );
});

test("a refusal that is not about the water is not this refusal", () => {
  assert.deepEqual(
    judgeDryTileRefusal(
      { state: "rejected", reasonCode: "transient_busy", evidence: { detail: `location=Farm;tile=${TILE}` } },
      { tile: TILE },
    ),
    ["fish_here_dry_tile_refused_for_another_reason:transient_busy"],
  );
});

test("a refusal that names a different tile is a violation", () => {
  assert.deepEqual(
    judgeDryTileRefusal(
      {
        state: "rejected",
        reasonCode: "water_not_fishable:not_water",
        evidence: { detail: "location=Farm;tile=1,1" },
      },
      { tile: TILE },
    ),
    [`fish_here_dry_tile_refusal_names_another_tile:1,1:${TILE}`],
  );
});

test("a dry-tile refusal that spent stamina was a cast in disguise", () => {
  assert.deepEqual(
    judgeDryTileRefusal(
      {
        state: "rejected",
        reasonCode: "water_not_fishable:not_water",
        evidence: { detail: `location=Farm;tile=${TILE};stamina_delta=-8` },
      },
      { tile: TILE },
    ),
    ["fish_here_dry_tile_refusal_spent_stamina:-8"],
  );
});

const ROW = (fields) => ({ status: "row", table: "LocationFish", row: { id: "here", fields } });

const FIELDS = {
  status: "measured",
  reason: "",
  timeOfDay: 600,
  examined: 12,
  catchableCount: 2,
  catchableOmitted: 0,
  catchable: [
    "(O)145 太阳鱼 difficulty=30 level=0 window=600 1900 weather=sunny",
    "(O)132 鲷鱼 difficulty=35 level=0 window=1800 2600 weather=sunny",
  ],
  blocked: [],
};

test("the reader's answer becomes the set the engine's draws are held against", () => {
  const published = publishedCatchable(ROW(FIELDS));
  assert.equal(published.status, "measured");
  assert.deepEqual([...published.species], ["(O)145", "(O)132"]);
  assert.equal(published.timeOfDay, 600);
  assert.equal(published.examined, 12);
});

test("not_measured is its own answer: a reader that could not look is not agreement", () => {
  const answer = publishedCatchable(
    ROW({ ...FIELDS, status: "not_measured", reason: "location_overrides_get_fish:Farm" }),
  );
  assert.deepEqual(answer, { status: "not_measured", reason: "location_overrides_get_fish:Farm" });
});

test("only the structural reason is accepted; a reader that failed is not a quiet pass", () => {
  assert.equal(parityNotMeasuredIsStructural("location_overrides_get_fish:Farm"), true);
  assert.equal(parityNotMeasuredIsStructural("fishing_data_unreadable:NullReferenceException"), false);
  assert.equal(parityNotMeasuredIsStructural("world_not_ready"), false);
  assert.equal(parityNotMeasuredIsStructural(""), false);
  assert.equal(parityNotMeasuredIsStructural(undefined), false);
});

test("every exit the engine takes before the table is structural; nothing else is", () => {
  // The closed list is the engine's own four exits (GameLocation.cs:13851-13874, Farm.cs:1109-1133). The farm's map
  // redirect is the one that can actually happen in this world, and it must be an ABSENT claim rather than a pass.
  for (const reason of [
    "location_overrides_get_fish:MineShaft",
    "farm_fish_redirect:Forest:0.5",
    "fish_pond_under_bobber:72,30",
    "fish_frenzy_at_bobber:(O)128",
    "fish_frenzy_active:bobber_tile_unknown",
  ])
    assert.equal(parityNotMeasuredIsStructural(reason), true, reason);
  // Anything that is a reader FAILURE - or a near-miss spelling of an exit - stays a failure to look.
  for (const reason of [
    "location_not_loaded:Forest",
    "locations_default_row_missing",
    "farm_fish_redirect:",
    "fish_pond_under_bobber:over there",
    "fish_frenzy_at_bobber:",
    "location_overrides_get_fish:",
  ])
    assert.equal(parityNotMeasuredIsStructural(reason), false, reason);
});

test("a capped species list is refused by name, not read as a disagreement", () => {
  // The wire truncates at fifteen lines plus an omission count. A caught species could then be "outside" a set that
  // does contain it, and reporting that as a disagreement would be a false accusation of the reader.
  assert.throws(() => publishedCatchable(ROW({ ...FIELDS, catchableOmitted: 3 })), /fish_here_parity_set_truncated:3/u);
});

test("a measured answer with no species is refused: zero population is never green", () => {
  assert.throws(
    () => publishedCatchable(ROW({ ...FIELDS, catchable: [], catchableCount: 0 })),
    /fish_here_parity_published_set_empty/u,
  );
});

const SAMPLE = (index, species, outside, time = 600) => ({
  index,
  species,
  outside,
  publishedTimeOfDay: time,
  publishedCount: 2,
});

test("every sampled species inside the published set is the pass, and it prints its own N", () => {
  const judged = judgeParity([SAMPLE(0, "(O)145", false), SAMPLE(1, "(O)145", false), SAMPLE(2, "(O)132", false)]);
  assert.deepEqual(
    { sampled: judged.sampled, distinct: judged.distinct, outside: judged.outside },
    {
      sampled: 3,
      distinct: 2,
      outside: 0,
    },
  );
  assert.deepEqual(judged.violations, []);
  // N is not decoration: it is what the claim is bounded by, and the line states it beside the answer.
  assert.equal(judged.line, "sampled 3 · distinct 2 · outside our set 0");
});

test("a caught species the reader did not publish is the disagreement this half exists for", () => {
  const judged = judgeParity([SAMPLE(0, "(O)145", false), SAMPLE(1, "(O)167", true, 610)]);
  assert.equal(judged.outside, 1);
  assert.deepEqual(judged.violations, [
    "fish_here_parity_species_outside_published_set:(O)167:index=1:time=610:published=2",
  ]);
});

test("zero samples is an absent reading, not a clean one", () => {
  assert.throws(() => judgeParity([]), /fish_here_parity_absent:samples=0/u);
});

test("the runner's address derivation reproduces the address the Mod published", () => {
  // Two independent implementations of one name: the Mod's C# `BuildWaterTargetId` produced `TARGET_ID` for this tile
  // in the run this file's evidence came from, and this JavaScript has to produce the same string for the dry-tile
  // case to address a tile the Mod will recognise.
  assert.equal(deriveWaterTargetId("Farm", 72, 30), TARGET_ID);
  assert.notEqual(deriveWaterTargetId("Farm", 72, 31), TARGET_ID);
  assert.notEqual(deriveWaterTargetId("FarmHouse", 72, 30), TARGET_ID);
});

/**
 * The census asks the reader about every location `Data/Locations` declares, and it is built from the SAME wire shape
 * the live run produces (`data_query_result` index, then one `row` per key). The transport is the boundary faked here;
 * the projection under test - which keys count as loaded, which rows are measured - is not.
 */
/**
 * The census' wire, as the protocol declares it (`host/src/protocol.ts:1375`): a request is `{ table, key }` - `key`
 * PRESENT and `null` for the table's index. Omitting it is refused by the Mod with
 * `bridge_rejected:invalid_data_query_request`, which is what the first live census run got (measured 2026-11-14), so
 * this fake refuses it the same way instead of answering a request the wire never accepts.
 */
const censusClient = (index, rows, requests = []) => ({
  async dataQuery(request) {
    requests.push(request);
    if (request?.key === undefined) throw new Error("bridge_rejected:invalid_data_query_request");
    const { key } = request;
    if (key === null) return index;
    return (
      rows[key] ?? {
        status: "absent_row",
        table: "LocationFish",
        population: 3,
        ids: null,
        row: null,
        detail: "no such row",
      }
    );
  },
});

test("the census asks for the index with a null key, the only shape the wire accepts", async () => {
  const requests = [];
  await readReaderCensus(censusClient(INDEX, { here: ROW(FIELDS) }, requests));
  assert.deepEqual(requests[0], { table: "LocationFish", key: null });
  assert.deepEqual(
    requests.slice(1).map((request) => request.key),
    ["here", "Farm", "Forest"],
    "every declared key is asked for, once",
  );
});

const INDEX = {
  status: "index",
  table: "LocationFish",
  population: 3,
  ids: ["here", "Farm", "Forest"],
  row: null,
  reason: null,
};

test("the census reports what the reader published for every declared location", async () => {
  const census = await readReaderCensus(
    censusClient(INDEX, {
      // The fixture world: measured once the farm's own map declares no redirect (FishingCatchableQuery).
      here: ROW({ ...FIELDS, location: "Farm", catchableCount: 2 }),
      Farm: ROW({ ...FIELDS, location: "Farm", catchableCount: 2 }),
      Forest: {
        status: "row",
        table: "LocationFish",
        population: 3,
        rows: null,
        row: { id: "Forest", fields: { status: "not_measured", reason: "location_not_loaded:Forest" } },
      },
    }),
  );
  assert.deepEqual(census.summary, { asked: 3, loaded: 2, measured: 2, refused: 0 });
  assert.equal(census.answers.find((entry) => entry.key === "here").species, 2);
  // A location this process does not have loaded is NEITHER a published set NOR a reader failure, so it is named as
  // neither: it must not be counted as a refusal, which would read as the engine's exits having been taken.
  const forest = census.answers.find((entry) => entry.key === "Forest");
  assert.deepEqual([forest.loaded, forest.species, forest.reason], [false, null, "location_not_loaded:Forest"]);
});

test("a loaded location the reader refused is counted as a refusal, with the reason it named", async () => {
  const census = await readReaderCensus(
    censusClient(INDEX, {
      here: ROW({ ...FIELDS, status: "not_measured", reason: "farm_fish_redirect:Forest:0.5" }),
      Farm: ROW({ ...FIELDS, status: "not_measured", reason: "farm_fish_redirect:Forest:0.5" }),
      Forest: ROW({ ...FIELDS, location: "Forest" }),
    }),
  );
  assert.deepEqual(census.summary, { asked: 3, loaded: 3, measured: 1, refused: 2 });
  assert.equal(census.answers.find((entry) => entry.key === "Farm").reason, "farm_fish_redirect:Forest:0.5");
});

test("an empty census is refused: a population of zero cannot agree with anything", async () => {
  await assert.rejects(
    () => readReaderCensus(censusClient({ ...INDEX, ids: [] }, {})),
    /fish_here_census_index_empty/u,
  );
  await assert.rejects(
    () => readReaderCensus(censusClient({ status: "row", table: "LocationFish", row: null, ids: null }, {})),
    /fish_here_census_index_absent:row/u,
  );
});

/** A client with no reader at all is a named refusal, not an empty census. */
test("a session with no content-data reader says so", async () => {
  await assert.rejects(() => readReaderCensus({}), /fish_here_census_data_query_unavailable/u);
});

test("the sample width is askable through the path every invoker takes", () => {
  // `tools/live-action.mjs` calls this module's `run*Smoke` in-process with no options object, so the width has to be
  // readable from the process environment rather than from an argument the live path never passes.
  assert.equal(paritySampleCount({}), 6);
  assert.equal(paritySampleCount({ GAMEBUDDY_FISH_PARITY_SAMPLES: "90" }), 90);
  assert.equal(paritySampleCount({ GAMEBUDDY_FISH_PARITY_SAMPLES: "0" }), 6);
  assert.equal(paritySampleCount({ GAMEBUDDY_FISH_PARITY_SAMPLES: "lots" }), 6);
});
