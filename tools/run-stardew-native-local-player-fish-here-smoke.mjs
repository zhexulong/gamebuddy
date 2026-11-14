// fish_here live contract: production native client, bounded scope, revision-bound requests,
// exact receipt identity, terminal wait, and owned teardown come from the shared harness.
// Action-specific logic (which water the engine offers, and what its receipt must prove about
// the catch) stays in this runner.
//
// THE RECEIPT IS NOT THE PROOF, and neither is `succeeded`. Three independent facts are read
// here, each from the ENGINE's own objects rather than from the action's word for it:
//
//   1. the tile was castable because `GameLocation.canFishHere` + `isTileFishable` said so - the
//      published row this runner dispatches is the Mod's `waterTargets`, and the target id it
//      carries is the address the handler recomputes for that tile before it casts;
//   2. the catch was CREDITED by the engine's own win path, which is `farmer.fishCaught` growing
//      (`pullFishFromWater` -> `playerCaughtFishEndFunction` -> `farmer.caughtFish`) and the fish
//      landing in the pack (`doneHoldingFish`). A receipt that reports a fish but a flat
//      `fishCaught` means the action narrated a catch the engine never booked;
//   3. the cast COST what a cast costs, from the engine's own mutations: bait out of the rod,
//      stamina off the bar, and the rod's own durability answer.
//
// The negative half is deliberate: a request whose `expectedTargetId` names a different tile is
// refused by name and moves nothing, so a green run cannot come from a handler that accepts
// whatever it is handed. A second negative asks for a tile the engine says is NOT water, and a
// cast there must be a named refusal rather than a wasted minute.
//
// AND THE READER IS HELD AGAINST THE ENGINE, one draw at a time. The engine's own sampler picks
// the fish (`location.getFish`, reached through `FishingRod.DoFunction` at the bite), and the
// reader publishes what MAY be caught here NOW (`DataQuery`/`LocationFish`, the same derivation
// the admission guard refuses on). Every caught species must appear in the set the reader
// published immediately before that cast; a species the engine returned and the reader did not
// publish is the disagreement this half exists to find. The reverse direction - a species the
// reader publishes and the engine never returns - cannot be established by sampling, and this
// runner does not claim it. The sample prints `sampled N · distinct M · outside our set J`, and N is
// reported BESIDE the number requested: the world, not the runner, bounds it (one bait per cast,
// eight stamina per cast), so a short sample says so instead of reading as a wide one.
//
// AND THE READER IS READ ACROSS EVERY LOCATION THE ENGINE DECLARES. `LocationFish` answers one row per
// `Data/Locations` key; the census asks all of them once, before any cast, so a reader that refuses to
// publish where the engine's own sampler IS the table (or publishes where the location's class can return
// a species the two tables do not name) is visible in the run's own evidence rather than argued from source.

import { createHash } from "node:crypto";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "fish_here";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/**
 * How many engine draws the parity step takes. Each cast is ONE `location.getFish` sample, so this is a sample size and
 * never a promise: a set this small proves nothing about the species the conditions exclude, and the reading prints its
 * own N beside the answer so no reader can mistake it for the population.
 */
const PARITY_SAMPLES = 6;
/**
 * The world's own limits on how many casts one run can make: one bait leaves the rod per cast and a cast spends
 * eight stamina, so the fixture's twenty bait bound a sample at nineteen draws. A refusal with one of these codes is
 * the world saying so, and is a STOP rather than a failure - a runner that reported it as a failed sample would be
 * reporting the fixture's arithmetic as a product defect.
 */
const WORLD_SAMPLE_LIMITS = Object.freeze(["no_bait_available", "out_of_stamina"]);
/** The Mod's own address for one water tile (`BuildWaterTargetId`), reproduced here only to be CHECKED against a published row. */
const WATER_TARGET_PREFIX = "water_";

/** Cast at the nearest water the engine published and prove the engine credited the catch. */
export async function runFishHereSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 60_000, paritySamples = PARITY_SAMPLES } = {},
) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const water = chooseWaterTarget(snapshot);
    // The reader's own answer for EVERY location the engine declares, read before the first cast spends anything.
    const census = await readReaderCensus(client);
    trace.push({ step: "reader_census", ...census.summary });

    const requestId = `native_local_fish_here_${Date.now()}`;
    // No deadline of this runner's own: the cast is bounded by the window `fish_here` publishes on `hello_ack`, which
    // is the same number the Mod admits a request with. A runner-written window is how this action's first live slice
    // was refused `bridge_rejected:invalid_deadline` - 120 s written against a 60 s window.
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: water.x, y: water.y, expectedTargetId: water.targetId },
      snapshot,
    });
    trace.push({
      step: "cast",
      action: ACTION,
      water: `${water.x},${water.y}`,
      targetId: water.targetId,
      receipt: summarizeReceipt(submitted),
    });

    // The cast is asynchronous by construction (the engine's own bite timer decides when), so the
    // terminal is the only verdict this contract accepts.
    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error(`fish_here_terminal_identity_mismatch:${terminal.requestId}:${terminal.executionId}`);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "fish_caught")
      throw new Error(
        `fish_here_failed:${terminal.state}/${terminal.reasonCode};${summarizeEvidence(terminal.evidence)}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    const violations = judgeCatch(evidence, { targetId: water.targetId, tile: `${water.x},${water.y}` });
    if (violations.length > 0) throw new Error(violations[0]);

    // The world is re-read after the terminal: the catch must not have taken the water with it,
    // and the snapshot must not be older than the receipt.
    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`fish_here_stale_reread:${after.revision}:${terminal.revision}`);
    if (waterTargetAt(after, water.x, water.y) == null)
      throw new Error(`fish_here_water_consumed_by_catch:tile=${water.x},${water.y}`);

    // Negative case. The same tile, addressed with ANOTHER tile's id: the binding is recomputed
    // before the rig is touched, so this must be refused by name and spend nothing. A handler
    // that casts anyway would make the positive half meaningless.
    const other = (after.waterTargets ?? []).find(
      (entry) =>
        Number.isInteger(entry?.x) && Number.isInteger(entry?.y) && (entry.x !== water.x || entry.y !== water.y),
    );
    const mismatchedTargetId = other?.targetId ?? `${water.targetId}_not_this_tile`;
    const negativeRequestId = `native_local_fish_here_binding_${Date.now()}`;
    const negativeSubmitted = await executeFresh(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { x: water.x, y: water.y, expectedTargetId: mismatchedTargetId },
      snapshot: after,
    });
    trace.push({
      step: "mismatched_binding",
      action: ACTION,
      water: `${water.x},${water.y}`,
      targetId: mismatchedTargetId,
      receipt: summarizeReceipt(negativeSubmitted),
    });
    const negativeTerminal = await waitForTerminal(receipts, negativeSubmitted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected")
      throw new Error(
        `fish_here_mismatched_binding_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`,
      );
    assertEvidence(parseEvidence(negativeTerminal.evidence), "tile", `${water.x},${water.y}`);
    const negativeEvidence = parseEvidence(negativeTerminal.evidence);
    if (negativeEvidence.fish_caught_after != null)
      throw new Error(`fish_here_refusal_booked_a_catch:${negativeEvidence.fish_caught_after}`);

    // A tile with no water. Two candidate rules were tried against the real world and both are recorded here.
    //
    // The actor's own tile is the obvious one, and it is WRONG: measured 2026-11-14, the fixture's Given stands her on
    // `Farm` (73,30), the engine answers `isWaterTile(73,30)` true and `isTileFishable(73,30)` true, and the cast this
    // case made there was admitted and bitten - so "she is standing, therefore it is land" is not a fact. A tile inside
    // the map cannot be named as land from the wire at all: the only tiles the Mod publishes are the ones it considers
    // water (`waterTargets`), so its complement is not addressable.
    //
    // What IS addressable is a tile the map does not contain: no water, no shore, no ambiguity, and the handler must
    // still answer by name rather than by casting. It exercises the same branch (`!isWaterTile`) an in-map land tile
    // would, and it costs nothing - the refusal precedes the rig, the walk and the engine. The coordinate is the
    // bridge's own admitted maximum (`FarmhandExecutionAcceptance.MaximumTileCoordinate`), because a negative one never
    // reaches the action at all: measured 2026-11-14, `(-1,-1)` was refused `bridge_rejected:invalid_execution_request`
    // by the argument range before any handler ran.
    const beforeDry = await observeFresh(client);
    const landTile = { x: 1000, y: 1000 };
    if (deriveWaterTargetId(beforeDry.location, water.x, water.y) !== water.targetId)
      throw new Error(`fish_here_target_id_derivation_disagrees:${beforeDry.location}:${water.targetId}`);
    const landTargetId = deriveWaterTargetId(beforeDry.location, landTile.x, landTile.y);
    const landRequestId = `native_local_fish_here_dry_tile_${Date.now()}`;
    const landSubmitted = await executeFresh(client, {
      requestId: landRequestId,
      idempotencyKey: `${landRequestId}_idem`,
      action: ACTION,
      args: { x: landTile.x, y: landTile.y, expectedTargetId: landTargetId },
      snapshot: beforeDry,
    });
    trace.push({
      step: "dry_tile",
      action: ACTION,
      tile: `${landTile.x},${landTile.y}`,
      targetId: landTargetId,
      receipt: summarizeReceipt(landSubmitted),
    });
    const landTerminal = await waitForTerminal(receipts, landSubmitted, terminalTimeoutMs);
    const landViolations = judgeDryTileRefusal(landTerminal, { tile: `${landTile.x},${landTile.y}` });
    if (landViolations.length > 0) throw new Error(landViolations[0]);

    // The reader against the engine, one draw per cast.
    const parity = await sampleParity(client, receipts, water, { samples: paritySamples, terminalTimeoutMs, trace });

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "fish_caught",
      water,
      evidence,
      negative: { reasonCode: negativeTerminal.reasonCode },
      dryTile: { tile: `${landTile.x},${landTile.y}`, reasonCode: landTerminal.reasonCode },
      census,
      parity,
      receipt: summarizeReceipt(terminal),
      trace,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

/**
 * The nearest water the engine published, or the named reason there is none.
 *
 * The Mod orders `waterTargets` nearest-first and caps the list, so the first row IS the closest
 * castable tile. A location that publishes none is the actor standing where no rod may be cast -
 * a world fact, not a failure of the request.
 */
function chooseWaterTarget(snapshot) {
  const targets = snapshot.waterTargets;
  if (targets == null || !Array.isArray(targets) || targets.length === 0)
    throw new Error(`fish_here_no_water_target:location=${snapshot.location}`);
  const water = targets.find(
    (entry) => typeof entry?.targetId === "string" && Number.isInteger(entry?.x) && Number.isInteger(entry?.y),
  );
  if (water == null) throw new Error(`fish_here_water_target_projection_incomplete:${JSON.stringify(targets)}`);
  return water;
}

/** The published water row at this tile, or null. Absent array and absent member both mean "not published". */
function waterTargetAt(snapshot, x, y) {
  const targets = snapshot.waterTargets;
  if (targets == null || !Array.isArray(targets)) return null;
  return targets.find((entry) => entry?.x === x && entry?.y === y) ?? null;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`fish_here_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function summarizeEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return detail.length > 0 ? detail : "no_evidence";
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

/**
 * Every fact the cast's own evidence must prove, as named violations. An empty list is the pass.
 *
 * THE THREE INDEPENDENT FACTS the header names, each read from the engine's own objects rather than from the action's
 * word for it: the binding this cast was admitted under, the CREDIT (`Farmer.fishCaught`, written only by the engine's
 * win path, plus the pack the settle fills), and the COST (bait out of the rod, stamina off the bar, a durability
 * answer that is present even when there is no tackle to wear out).
 *
 * THE PULL'S OWN OUTCOME IS THE ONE THING THE ACTION REFUSES TO CLAIM. It cannot play `BobberBar` (`update` reads the
 * player's buttons), so it reports `pull_outcome=not_verified` and NAMES the field it could not watch. A receipt that
 * said `verified` would be narration, and this judgement is what makes the difference visible: an earlier version of
 * this file demanded `was_perfect=true`, a field the Mod stopped publishing when it stopped claiming the fish was held
 * (`4e40b8ca`), so the whole action read as blocked on a detail of its own wording.
 */
export function judgeCatch(evidence, { targetId, tile }) {
  const violations = [];
  const require = (key, expected) => {
    if (evidence?.[key] !== expected)
      violations.push(`fish_here_evidence_${key}:${evidence?.[key] ?? "missing"}:${expected}`);
  };
  require("target", targetId);
  require("tile", tile);
  const fish = evidence?.caught_qualified_item_id;
  if (typeof fish !== "string" || !fish.startsWith("("))
    violations.push(`fish_here_evidence_fish_missing:${fish ?? "none"}`);
  if (typeof evidence?.display_name !== "string" || evidence.display_name.length === 0)
    violations.push("fish_here_evidence_display_name_missing");
  require("pull_outcome", "not_verified");
  if (typeof evidence?.pull_unobserved_field !== "string" || evidence.pull_unobserved_field.length === 0)
    violations.push("fish_here_pull_unobserved_field_missing");
  const caughtBefore = Number(evidence?.fish_caught_before);
  const caughtAfter = Number(evidence?.fish_caught_after);
  if (!(caughtAfter > caughtBefore))
    violations.push(
      `fish_here_catch_not_credited:before=${evidence?.fish_caught_before};after=${evidence?.fish_caught_after};fish=${fish}`,
    );
  const inventoryBefore = Number(evidence?.inventory_before);
  const inventoryAfter = Number(evidence?.inventory_after);
  if (!(inventoryAfter > inventoryBefore))
    violations.push(
      `fish_here_fish_not_in_pack:before=${evidence?.inventory_before};after=${evidence?.inventory_after};fish=${fish}`,
    );
  const baitBefore = Number(evidence?.bait_before);
  const baitLeft = Number(evidence?.bait_left);
  if (!(baitBefore > 0)) violations.push(`fish_here_cast_without_bait:bait_before=${evidence?.bait_before}`);
  if (!(baitLeft < baitBefore))
    violations.push(`fish_here_bait_not_consumed:before=${evidence?.bait_before};left=${evidence?.bait_left}`);
  const staminaDelta = Number(evidence?.stamina_delta);
  if (!(staminaDelta < 0)) violations.push(`fish_here_stamina_not_spent:delta=${evidence?.stamina_delta}`);
  if (evidence?.rod_durability_left === undefined || Number.isNaN(Number(evidence.rod_durability_left)))
    violations.push("fish_here_evidence_rod_durability_missing");
  if (Number.isNaN(Number(evidence?.fish_size)) || Number.isNaN(Number(evidence?.quality)))
    violations.push(`fish_here_engine_fish_facts_missing:size=${evidence?.fish_size};quality=${evidence?.quality}`);
  return violations;
}

/**
 * The refusals a request for a tile with NO water may end in, and what each one means.
 *
 * MEASURED 2026-11-14 on `Farm`. The action's own `water_not_fishable:not_water` answer is reached only for a tile
 * within one step of the actor, because a farther one begins an approach first (that is the action's design, not this
 * runner's). In the `native_fish_here_v1` world the actor is boxed in by water on all four sides - the fixture stands
 * her inside the pond - so no adjacent tile can produce that answer, and the tile this case can actually name is one the
 * map does not contain. What the action answers for that is `no_cuttable_blocker:water`: the walk's own word for a wall
 * no published action removes (`PocketFrontierTests`).
 *
 * Both are the SAME claim about the world - there is no water to fish here - and the closed list is what keeps the case
 * from accepting `transient_busy`, a deadline or any other refusal that would say nothing about the tile.
 */
export const DRY_TILE_REFUSALS = Object.freeze([
  "water_not_fishable:not_water",
  "water_not_fishable:tile_not_fishable",
  "water_not_fishable:location_cannot_fish",
  "no_cuttable_blocker:water",
]);

/**
 * A cast at a tile the engine has no water for must be a NAMED REFUSAL of the right kind, and must spend nothing.
 *
 * The pair is what matters: `state: rejected` alone would accept any refusal at all - a deadline, a busy body, a rod
 * this pack does not hold - and none of those is the answer this case exists to see.
 */
export function judgeDryTileRefusal(receipt, { tile }) {
  const violations = [];
  if (receipt?.state !== "rejected") {
    violations.push(`fish_here_dry_tile_not_refused:${receipt?.state}/${receipt?.reasonCode}`);
    return violations;
  }
  if (!DRY_TILE_REFUSALS.includes(receipt.reasonCode))
    violations.push(`fish_here_dry_tile_refused_for_another_reason:${receipt.reasonCode}`);
  const evidence = receipt.evidence == null ? {} : parseEvidence(receipt.evidence);
  // A refusal that names a tile must name THIS one; the codes that name a blocker instead say so in their own word.
  if (receipt.reasonCode.startsWith("water_not_fishable:") && evidence.tile !== tile)
    violations.push(`fish_here_dry_tile_refusal_names_another_tile:${evidence.tile ?? "none"}:${tile}`);
  if (evidence.fish_caught_after != null)
    violations.push(`fish_here_dry_tile_refusal_booked_a_catch:${evidence.fish_caught_after}`);
  if (evidence.stamina_delta != null)
    violations.push(`fish_here_dry_tile_refusal_spent_stamina:${evidence.stamina_delta}`);
  return violations;
}

/**
 * The address the Mod binds one water tile with, reproduced from its own formula (`BuildWaterTargetId`).
 *
 * This is a SECOND COPY of a fact the Mod owns, which the tree normally refuses - and it is here because the dry-tile
 * case cannot name a tile the Mod never published without one. The copy is therefore never trusted on its own: every
 * run proves it against a row the Mod DID publish before using it on a tile it did not (see the cast for
 * `fish_here_target_id_derivation_disagrees`).
 */
export function deriveWaterTargetId(location, x, y) {
  const raw = `${location}:${x},${y}:water`;
  return WATER_TARGET_PREFIX + createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex").slice(0, 16);
}

/**
 * The species the READER publishes for the place the actor is standing in, from the `LocationFish` answer.
 *
 * A MEASURED answer with no species, and a CAPPED one, both fail closed here: the first is a reader that answered
 * "nothing" and the second is a list whose tail is missing, so a caught species could be "outside" a set that does
 * contain it. A `not_measured` answer is neither - it is a fact about the reader - and it is returned as such rather
 * than folded into an empty set, because those two must never be the same answer.
 */
export function publishedCatchable(answer) {
  if (answer?.status !== "row" || answer?.row == null)
    throw new Error(`fish_here_parity_row_absent:${answer?.status ?? "no_answer"}`);
  const fields = answer.row.fields ?? {};
  if (fields.status !== "measured") return { status: "not_measured", reason: String(fields.reason ?? "unspecified") };
  const omitted = Number(fields.catchableOmitted ?? 0);
  if (!(omitted === 0)) throw new Error(`fish_here_parity_set_truncated:${fields.catchableOmitted}`);
  const lines = Array.isArray(fields.catchable) ? fields.catchable : [];
  const species = new Set();
  for (const line of lines) {
    const token = String(line).split(" ")[0];
    if (token.length > 0) species.add(token);
  }
  if (species.size === 0) throw new Error("fish_here_parity_published_set_empty");
  return {
    status: "measured",
    species,
    count: Number(fields.catchableCount),
    timeOfDay: Number(fields.timeOfDay),
    examined: Number(fields.examined),
  };
}

/**
 * Which `not_measured` reasons this contract accepts, and which are a failure to look.
 *
 * THE CLOSED LIST IS THE ENGINE'S OWN EXITS FROM THE TABLE, nothing else (`GameLocation.cs:13851-13874`,
 * `Farm.cs:1109-1133`): a location-name redirect, a class whose own sampler answers (and the farm's map redirect), a
 * fish pond under the bobber, an active fish frenzy. Each is STRUCTURAL - the engine can return a species the two tables
 * do not name, so the reader refuses and the guard admits, and the parity claim is therefore ABSENT, not satisfied.
 * Any other reason (`fishing_data_unreadable:…`, `world_not_ready`) is a reader that failed, and a run that treated that
 * as "no disagreement" would pass on nothing.
 *
 * Measured 2026-11-14: `fish_here`'s fixture world IS the Farm, so `location_overrides_get_fish:Farm` was the answer
 * every run of this action got - and the parity claim was absent for the whole life of the action.
 */
export function parityNotMeasuredIsStructural(reason) {
  const text = String(reason ?? "");
  return (
    /^location_overrides_get_fish:[A-Za-z0-9_]{1,64}$/u.test(text) ||
    /^farm_fish_redirect:[A-Za-z0-9_]{0,64}:[0-9.]+$/u.test(text) ||
    /^fish_pond_under_bobber:-?\d{1,6},-?\d{1,6}$/u.test(text) ||
    /^fish_frenzy_(?:at_bobber:[A-Za-z0-9_()]{1,32}|active:bobber_tile_unknown)$/u.test(text)
  );
}

/**
 * `sampled N · distinct M · outside J`, with the violations that make J > 0 a failure.
 *
 * ONE DIRECTION ONLY. A species the engine returned and the reader did not publish is a disagreement, and that is what
 * J counts. The reverse - a species the reader publishes that the engine never returns - cannot be established by
 * sampling: the engine rolls, so "never in M draws" is not "never". This function therefore says nothing about it.
 */
export function judgeParity(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("fish_here_parity_absent:samples=0");
  const outside = samples.filter((sample) => sample.outside === true);
  const distinct = new Set(samples.map((sample) => sample.species)).size;
  return {
    sampled: samples.length,
    distinct,
    outside: outside.length,
    line: `sampled ${samples.length} · distinct ${distinct} · outside our set ${outside.length}`,
    violations: outside.map(
      (sample) =>
        `fish_here_parity_species_outside_published_set:${sample.species}:index=${sample.index}:time=${sample.publishedTimeOfDay}:published=${sample.publishedCount}`,
    ),
  };
}

/**
 * The reader's answer for every location the engine declares, asked once before any cast.
 *
 * WHY A CENSUS AND NOT ONE ANSWER. The `LocationFish` row for `here` is the one the guard and the cast use, and it is
 * the one a single run can falsify. The rows for the OTHER locations are what makes the reader's rule visible: a
 * location whose class inherits the engine's own sampler must be `measured` (the two tables ARE its answer) and one
 * whose class answers `getFish` itself must not be. An answer that says otherwise is the disagreement between our
 * projection and the engine, readable from one run instead of inferred from source.
 *
 * A location the process does not have loaded answers `location_not_loaded:<name>`: it is neither a published set nor
 * a reader failure, so it is counted and named rather than reported as either.
 */
export async function readReaderCensus(client) {
  if (typeof client?.dataQuery !== "function") throw new Error("fish_here_census_data_query_unavailable");
  const index = await client.dataQuery({ table: "LocationFish" });
  if (index?.status !== "index") throw new Error(`fish_here_census_index_absent:${index?.status ?? "no_answer"}`);
  const keys = Array.isArray(index.rows) ? index.rows.filter((key) => typeof key === "string") : [];
  if (keys.length === 0) throw new Error("fish_here_census_index_empty");
  const answers = [];
  for (const key of keys) {
    const answer = await client.dataQuery({ table: "LocationFish", key });
    const fields = answer?.row?.fields ?? {};
    const reason = String(fields.reason ?? "");
    const loaded = !reason.startsWith("location_not_loaded:");
    answers.push({
      key,
      loaded,
      status: String(fields.status ?? "absent"),
      reason,
      species: fields.status === "measured" ? Number(fields.catchableCount ?? 0) : null,
    });
  }
  const loaded = answers.filter((entry) => entry.loaded);
  const measured = loaded.filter((entry) => entry.status === "measured");
  return {
    summary: {
      asked: answers.length,
      loaded: loaded.length,
      measured: measured.length,
      refused: loaded.length - measured.length,
    },
    answers,
  };
}

/**
 * Cast `samples` times and hold every engine draw against the reader's answer for the same conditions.
 *
 * The reader is asked IMMEDIATELY BEFORE each cast, because the answer is a function of the moment: season, hour,
 * weather and level all move while the run is live, and a set read once at the start would be compared against a cast
 * made in a different hour. The reading also keeps the time it was taken at, so a disagreement can be read as either a
 * real one or a window the cast crossed - the run fails either way, but it fails saying which.
 */
async function sampleParity(client, receipts, water, { samples, terminalTimeoutMs, trace }) {
  if (typeof client?.dataQuery !== "function") throw new Error("fish_here_parity_data_query_unavailable");
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`fish_here_parity_samples_invalid:${samples}`);
  const first = publishedCatchable(await client.dataQuery({ table: "LocationFish", key: "here" }));
  if (first.status === "not_measured") {
    if (!parityNotMeasuredIsStructural(first.reason)) throw new Error(`fish_here_parity_not_measured:${first.reason}`);
    // No cast is made: there is nothing to hold the engine's draws against, and spending a minute of them to prove that
    // would be buying a reading nobody can read.
    return { status: "not_measured", reason: first.reason, sampled: 0, distinct: 0, outside: 0 };
  }
  const readings = [];
  let stoppedBy = null;
  for (let index = 0; index < samples; index++) {
    const snapshot = await observeFresh(client, { actionable: true });
    const target = waterTargetAt(snapshot, water.x, water.y) ?? chooseWaterTarget(snapshot);
    const published = publishedCatchable(await client.dataQuery({ table: "LocationFish", key: "here" }));
    if (published.status !== "measured") throw new Error(`fish_here_parity_conditions_changed:${published.reason}`);
    const requestId = `native_local_fish_here_parity_${Date.now()}_${index}`;
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
    });
    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "fish_caught") {
      // The world's own arithmetic can end a sample early - one bait leaves the rod per cast and a cast spends eight
      // stamina - and that is a STOP with a name, not a failed sample and not a clean full one.
      if (WORLD_SAMPLE_LIMITS.includes(String(terminal.reasonCode))) {
        stoppedBy = String(terminal.reasonCode);
        break;
      }
      throw new Error(
        `fish_here_parity_sample_failed:${index}:${terminal.state}/${terminal.reasonCode};${summarizeEvidence(terminal.evidence)}`,
      );
    }
    const evidence = parseEvidence(terminal.evidence);
    const species = evidence.caught_qualified_item_id;
    readings.push({
      index,
      species,
      publishedTimeOfDay: published.timeOfDay,
      publishedCount: published.count,
      outside: !published.species.has(species),
    });
    trace.push({
      step: "parity_sample",
      index,
      species,
      tile: `${target.x},${target.y}`,
      outside: !published.species.has(species),
    });
  }
  const judged = judgeParity(readings);
  if (judged.violations.length > 0) throw new Error(judged.violations[0]);
  trace.push({ step: "parity", requested: samples, line: judged.line, stoppedBy });
  return {
    status: "measured",
    requested: samples,
    stoppedBy,
    line: judged.line,
    sampled: judged.sampled,
    distinct: judged.distinct,
    outside: judged.outside,
    species: readings.map((reading) => reading.species),
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    // HOW WIDE THE SAMPLE IS ASKED FOR, not promised: the world bounds it (see `WORLD_SAMPLE_LIMITS`) and the result
    // reports both numbers. The gate's own default stays small; a deep reading is `GAMEBUDDY_FISH_PARITY_SAMPLES=90 node`.
    const paritySamples = Number(process.env.GAMEBUDDY_FISH_PARITY_SAMPLES ?? PARITY_SAMPLES);
    const result = await runFishHereSmoke(session.client, session.receipts, config, { paritySamples });
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
