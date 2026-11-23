import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clearedKinds,
  constantsIn,
  declaredKinds,
  SOURCES,
} from "../../gates/stardew/audit-stardew-clearing-vocabulary.mjs";
import { readHostCompletionContracts } from "../../gates/stardew/check-stardew-postcondition-delta.mjs";
import { modConstants } from "../../gates/stardew/check-stardew-snapshot-family-bounds.mjs";
import { taskPurposeVerdict } from "../live-run/game/run-verdicts.mjs";
import { MAXIMUM_BASELINE_DAYS, MINIMUM_BASELINE_DAYS } from "./multiday-baseline.mjs";
import { DAILY_TASK_ACTION_HINTS, DAILY_TASK_ROTATION, dayTaskSchedule } from "./multiday-daily-tasks.mjs";
import {
  readAllPublishedExecutionStardewActionIds,
  readExperimentalStardewActionIds,
} from "./stardew-published-action-registry.mjs";
import {
  CARRIED_ITEM_ACTIONS,
  CARRIED_ITEM_SPEND_ACTIONS,
  judgesAPublishedFact,
  judgeTaskPurpose,
  MOVEMENT_ACTIONS_WITHOUT_ARRIVAL,
  purposeReceipts,
  readScheduledJudgement,
  TASK_PURPOSE_CRITERIA,
} from "./task-purpose.mjs";

/**
 * The task-purpose gate.
 *
 * It exists for one defect class: a TASK being called accomplished because an ACTION succeeded. Measured on a
 * `go_mining` day declared `[travel, enter_mine, break_rock]` - the companion broke rocks on the surface, the
 * `break_rock` receipt was real (`succeeded/rock_source_broken`), and the day was counted as having mined.
 *
 * The population is derived, never listed: the rotation from `multiday-daily-tasks.mjs`, the declared actions from
 * its hint table, and the published action set from the Mod's own catalog. A task added tomorrow is covered by
 * existing, and the failure names it.
 *
 * red-proof: inject  restoring `mine_delve` to "a rock or container was broken" (one action, no mine) turns two
 *            falsifiers red - `a rock broken with no mine entered is not a mine delved` (got `achieved`) and
 *            `a criterion of one step can be satisfied by a single action's success`;
 *            dropping a `because` from an ordered row turns `a_criterion_requires_an_order_the_world_does_not` red,
 *            naming that row;
 *            asking for a fact nobody publishes - a gap without its `unpublishedFact`, or a tile field the Host's
 *            contract does not carry - turns `a_criterion_asks_for_a_fact_the_product_does_not_publish` red, naming the
 *            criterion and the fact; and answering a gap entry `unproven` turns
 *            `a_day_task_whose_criterion_decides_nothing_is_not_reported_either_way` red, naming the day and its
 *            missing fact; restoring `water_and_harvest` to `[harvest_crop, plant_seed]` turns `round89 day 2` red
 *            (`not_achieved`), because that day's harvest happened in a day of its own and no receipt set handed to a
 *            day's verdict can see it (tools/lib/task-purpose.test.mjs)
 */

const ROTATION = [...DAILY_TASK_ROTATION];

/** A receipt in the shape the run's fact log yields: action, terminal state, and the Mod's evidence block. */
const receipt = (actionId, { reasonCode = "some_terminal", evidence = { detail: "target=opaque_1" } } = {}) =>
  Object.freeze({ actionId, state: "succeeded", reasonCode, evidence });

/** The Mod's own success shapes, taken from the adapter's completion rules (`stardew-game-integration-adapter.test.ts`). */
const BROKE_ROCK = receipt("break_rock", {
  reasonCode: "rock_source_broken",
  evidence: {
    detail:
      "target=rock_source_1234;tool=pickaxe;tool_selected=pickaxe;slot=4;tool_before=axe;slot_before=0;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
  },
});
const ENTERED_MINE = receipt("enter_mine", {
  reasonCode: "mine_entered",
  evidence: { detail: "level=11;tile=6,6;from_level=10" },
});
// The mine's OWN exit ladder: `use_mine_ladder`'s `mine_left` terminal, in the two shapes the Host's rule admits - the
// five-key synchronous one (the question the level asked, the answer given, the ladder tile and where she came out) and
// the four-key asynchronous one, where the engine's own warp settles it and the receipt carries the decision beside the
// `expected`/`actual` pair. Here the synchronous one.
const LEFT_BY_LADDER = receipt("use_mine_ladder", {
  reasonCode: "mine_left",
  evidence: { detail: "from=mine_shaft_11;question=ExitMine;response=Leave;ladder=6,7;actual=Farm:64,15" },
});
/**
 * The KEY LIST a receipt of `actionId` must carry, read out of the file that declares it.
 *
 * This file used to spell `till_soil`'s evidence by hand, and the hand spelling drifted: `5a068fa9` gave the action
 * `charge_requested`, `charge_applied`, `window`, `tiles_changed`, `changed` and the three tool-selection keys, the
 * fixture here carried none of them, and because the Host's rule is `required ⊆ emitted ⊆ required ∪ optional` every
 * tilled tile became a REFUSED receipt - so eight criteria in this file read a patch day as work the run could not
 * describe. A key list written beside the contract is a second spelling of the contract, which is the same defect as a
 * recorded count written beside its producer.
 *
 * The parser is `readHostCompletionContracts`, the one `tools/check-stardew-postcondition-delta.mjs` owns and
 * `tools/check-stardew-task-gap-reasons.mjs` already reuses: it resolves a predicate's inline array AND a module
 * constant such as `TILL_SOIL_EVIDENCE_KEYS`, so the keys are read from the declaration the adapter folds over.
 */
const HOST_COMPLETION_CONTRACT = new URL("../../host/src/stardew-completion-contracts.ts", import.meta.url);

function declaredEvidenceKeys(actionId) {
  const { contracts, findings } = readHostCompletionContracts(readFileSync(HOST_COMPLETION_CONTRACT, "utf8"));
  const contract = contracts.get(actionId);
  if (contract === undefined || contract.keys.length === 0)
    throw new Error(
      `blocked: the Host's completion contract declares no evidence keys for ${actionId}, so this file's ${actionId} ` +
        `fixture would be built from nothing and no receipt it minted would prove a tile ` +
        `(parser findings: ${findings.join(" | ") || "none"})`,
    );
  return contract.keys;
}

/**
 * One receipt's evidence: the contract's keys, filled with the values the Mod prints for ONE single-tile use.
 *
 * The values cannot be derived from anything - they ARE what the handler measured (`Farm`, `HoeDirt`, the stamina the
 * swing cost) - and `stardew-game-integration-adapter.test.ts` carries the same shape for `till_soil`. What must not be
 * written a second time is the KEY SET, and a key the contract grows that this table does not fill fails here NAMING
 * that key, rather than quietly leaving the receipt refused.
 */
function contractEvidence(actionId, values) {
  const keys = declaredEvidenceKeys(actionId);
  const missing = keys.filter((key) => !(key in values));
  if (missing.length > 0)
    throw new Error(
      `blocked: the ${actionId} contract requires ${missing.join(", ")} and this fixture states no value for it; take ` +
        `the value from the Mod's handler instead of dropping the key from the receipt`,
    );
  return keys.map((key) => `${key}=${String(values[key])}`).join(";");
}

// The tile-bearing terminals. A patch day's evidence IS a coordinate: each of these actions names the tile it changed as
// part of its own postcondition, and the keys come from that postcondition rather than from this comment.
const TILLED = (x, y, location = "Farm") =>
  receipt("till_soil", {
    reasonCode: "soil_tilled",
    evidence: {
      detail: contractEvidence("till_soil", {
        location,
        target: `${String(x)},${String(y)}`,
        tool_selected: "hoe",
        slot: "3",
        tool_before: "none",
        slot_before: "0",
        before: "none",
        after: "HoeDirt",
        // An uncharged tap, and the box ONE native use scanned. The contract refuses a `changed` tile outside it.
        charge_requested: "0",
        charge_applied: "0",
        window: `${String(x - 5)},${String(y - 5)}:${String(x + 5)},${String(y + 5)}`,
        tiles_changed: "1",
        changed: `${String(x)}:${String(y)}`,
        stamina_before: "100",
        stamina_after: "98",
        stamina_delta: "-2",
        expected_stamina_cost: "2",
        tool_restored: "none",
      }),
    },
  });
const PLANTED = (x, y, location = "Farm") =>
  receipt("plant_seed", {
    reasonCode: "seed_planted",
    evidence: {
      detail: contractEvidence("plant_seed", {
        location,
        target: "soil_01",
        tile: `${String(x)},${String(y)}`,
        item: "(O)472",
        crop: "Parsnip",
        inventory_before: "2",
        inventory_after: "1",
      }),
    },
  });

const WATERED = (x, y, location = "Farm") =>
  receipt("water_crop", {
    reasonCode: "crop_watered",
    evidence: {
      detail: contractEvidence("water_crop", {
        location,
        target: `crop_${String(x)}_${String(y)}`,
        tile: `${String(x)},${String(y)}`,
        tool_selected: "watering_can",
        slot: "2",
        tool_before: "watering_can",
        slot_before: "2",
        before_watered: "false",
        after_watered: "true",
        // The engine spends `power + 1` water per use, so an uncharged tap drops the can by exactly one.
        water_before: "40",
        water_after: "39",
        water_consumed: "true",
        water_expected_cost: "1",
        charge_requested: "0",
        charge_applied: "0",
        window: `${String(x - 5)},${String(y - 5)}:${String(x + 5)},${String(y + 5)}`,
        tiles_changed: "1",
        changed: `${String(x)}:${String(y)}`,
        stamina_before: "254",
        stamina_after: "252",
        stamina_delta: "-2",
        expected_stamina_cost: "2",
        tool_restored: "watering_can",
      }),
    },
  });

/**
 * `round87b`'s OWN WIRE TEXT for a tile that already carried HoeDirt: the tile, its soil and the warrant, and no map.
 *
 * This is the shape that made a day of tilling read as none. The producer answered thirty of these on day 1
 * (`soil_already_tilled`, `settled_by=engine_flag:hoedirt=present`), the Host admitted every one, and the criterion
 * below could not place one on a map: `62,18` is a tile on the Farm and on the Mountain.
 */
const round87bSettlement = (x, y) =>
  `target=${String(x)},${String(y)};before=HoeDirt;settled_by=engine_flag:hoedirt=present`;

/**
 * The same settlement with the `location` the producer now writes, in the field every other tile-bearing `till_soil`
 * receipt carries.
 *
 * The keys are the SETTLEMENT's own - its contract names `location`, `target`, `before` and `settled_by` - so they are
 * not derived here from `declaredEvidenceKeys("till_soil")`, whose list is the eighteen keys of the swing.
 */
const TILLED_ALREADY = (x, y, location = "Farm") =>
  receipt("till_soil", {
    reasonCode: "soil_already_tilled",
    evidence: { detail: `location=${location};${round87bSettlement(x, y)}` },
  });

/** `round87b`'s settlement verbatim, kept as the shape a tile without a map is refused in. */
const TILLED_ALREADY_WITHOUT_MAP = (x, y) =>
  receipt("till_soil", { reasonCode: "soil_already_tilled", evidence: { detail: round87bSettlement(x, y) } });

/**
 * The fixtures above, as `[actionId, build]` pairs: the population the admission check below walks.
 *
 * `till_soil` appears twice because it has TWO terminals that carry a tile - the swing (`before=none;after=HoeDirt`)
 * and the settlement (`before=HoeDirt;settled_by=...`). A population keyed by action would admit the swing while the
 * other shape went unread, which is how thirty settled tiles reached a criterion that could not place them.
 */
const TILE_FIXTURES = Object.freeze([
  ["till_soil", TILLED],
  ["till_soil", TILLED_ALREADY],
  ["plant_seed", PLANTED],
  ["water_crop", WATERED],
]);
const CUT_WEEDS = receipt("cut_weeds", {
  reasonCode: "weeds_cut",
  evidence: {
    detail:
      "target=weed_01;type=weed;tool=scythe;tool_selected=scythe;slot=1;tool_before=axe;slot_before=0;qualified_item_id=(O)313;health_before=2;health_after=removed;swings=2;removed=true;stamina_before=100;stamina_after=100;stamina_delta=0;expected_stamina_cost=0;tool_restored=axe",
  },
});

/** A rectangle of tiles, as `[x, y]` pairs. */
const rectangle = (width, height, originX = 12, originY = 4) => {
  const points = [];
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) points.push([originX + x, originY + y]);
  }
  return points;
};

/** The receipts a patch day's own history would leave: every tile tilled, then a seed put in it. */
const patchReceipts = (points) => points.flatMap(([x, y]) => [TILLED(x, y), PLANTED(x, y)]);

test("every tile-bearing fixture is a receipt its own contract admits, and one key short is refused", () => {
  // A fixture the contract REFUSES tests nothing but this file: every criterion below would read a patch day as
  // "the receipts proved nothing" and the red would name the criterion rather than the fixture. `5a068fa9` is exactly
  // that incident - eight tests went red for four days with the contract's change four files away.
  const findings = [];
  for (const [actionId, build] of TILE_FIXTURES) {
    const admitted = purposeReceipts([build(12, 4)]);
    if (admitted.refused.length > 0)
      findings.push(
        `${actionId}: the fixture is refused as ${admitted.refused.map((entry) => entry.reasonCode).join(", ")}`,
      );
  }
  assert.deepEqual(
    findings,
    [],
    "a tile-bearing fixture in this file no longer satisfies the completion contract it derives its keys from, so " +
      "every criterion that reads it is measuring a refusal: fill the key the contract requires from the Mod's handler",
  );
  // The falsifier: the SAME reader, told to drop one declared key, must move that receipt to refused. Without it, the
  // check above would be green on a `purposeReceipts` that admitted everything.
  const complete = TILLED(12, 4).evidence.detail;
  const omitted = declaredEvidenceKeys("till_soil")[0];
  const oneShort = complete
    .split(";")
    .filter((field) => !field.startsWith(`${String(omitted)}=`))
    .join(";");
  assert.equal(
    purposeReceipts([Object.freeze({ ...TILLED(12, 4), evidence: { detail: oneShort } })]).refused.length,
    1,
    `removing the contract's own \`${String(omitted)}\` key from the fixture left the receipt ADMITTED, so nothing here ` +
      "can tell a complete receipt from a key short one",
  );
});

test("every rotation task declares a purpose or names the fact that is missing", () => {
  const undeclared = ROTATION.filter((task) => TASK_PURPOSE_CRITERIA[task] === undefined);
  assert.deepEqual(
    undeclared,
    [],
    `these tasks have no declared purpose, so a run cannot say whether they were accomplished: ${undeclared.join(", ")}`,
  );
});

test("no purpose is declared for a task the rotation never asks for", () => {
  const orphans = Object.keys(TASK_PURPOSE_CRITERIA).filter((task) => !ROTATION.includes(task));
  assert.deepEqual(orphans, [], `these criteria describe tasks no run asks for: ${orphans.join(", ")}`);
});

/**
 * THE GATE: `a_day_task_whose_criterion_decides_nothing_is_not_reported_either_way:<task>`.
 *
 * <p>
 * A DAY TASK IS A DAY THE RUN IS JUDGED ON, and a criterion that asks for a fact nothing publishes can only ever answer
 * `unjudged`. Reporting that as a failure is a red that names a defect which does not exist - the mirror image of a gate
 * that cannot fail. Measured 2026-11-20 (`round81`): day 3 was `sweep_yard_and_work` - a task whose purpose is "the
 * GROUP of the farm was worked", and no receipt names a group - so the run published
 * `task_unproven:...,sweep_yard_and_work:task_purpose_needs_an_unpublished_fact` and was blocked for a day nobody could
 * have passed. Six of the rotation's twenty entries have been in that state since before that run, which is why the gate
 * is written over the whole rotation rather than over the three sweep days it was noticed on.
 * </p>
 * <p>
 * POPULATION: every rotation task (the days a run is judged on), crossed with its `TASK_PURPOSE_CRITERIA` entry. Empty
 * receipts are the day with nothing to show: the only receipt set a gap day can answer differently for, and the shape of
 * a day whose work never reached its purpose. TWO DEFECTS, TWO NAMES - a gap day that blocked, and a decidable day that
 * did not - because they are opposite lies about the same run, and one sentence for both would leave a reader unable to
 * tell which way the state broke.
 * </p>
 * <p>
 * red-proof: inject  a gap entry answered `unproven` in `judgeTaskPurpose` -> `a_gap_day_blocked_the_run:<task>` goes red
 *                   naming that day and its missing fact; and an `unproven` day let through by `taskPurposeVerdict` ->
 *                   `a_non_gap_day_did_not_block_the_run:<task>` goes red naming it
 *                   (tools/lib/task-purpose.test.mjs)
 * </p>
 */
const GAP_DAY_GATE = "a_day_task_whose_criterion_decides_nothing_is_not_reported_either_way";

/**
 * The other day a run needs for ONE day's verdict to be readable: a day the evidence decided.
 *
 * A run whose every day is a gap day is judged by nothing, and `task_purposes_nothing_judged` says so - which is the
 * rail `a run whose every day was a gap day is judged by nothing` owns below. Reading one day's verdict out of a
 * one-day run would let that rail answer instead of the day, so every per-day reading here is taken over a run that
 * also had a day the evidence decided: the witness stands for that day, and this gate is about the day beside it.
 */
const DECIDED_WITNESS = Object.freeze({
  day: 0,
  task: "the_witness",
  state: "achieved",
  reasonCode: "task_purpose_achieved",
});

test(GAP_DAY_GATE, (t) => {
  const days = ROTATION.map((task) => {
    const judged = judgeTaskPurpose(task, []);
    return Object.freeze({
      task,
      gap: !judgesAPublishedFact(task),
      state: judged.state,
      reasonCode: judged.reasonCode,
      // The fact is the diagnosis, and it travels on the day itself: which capability this day could not be scored on.
      fact: judged.unpublishedFact?.name ?? judged.missingFact ?? null,
      verdict: taskPurposeVerdict([Object.freeze({ day: 1, task, ...judged }), DECIDED_WITNESS]),
    });
  });
  const gaps = days.filter((day) => day.gap);
  const decidable = days.filter((day) => !day.gap);
  const findings = [];
  for (const day of gaps) {
    if (day.state !== "unjudged")
      findings.push(
        `${GAP_DAY_GATE}:${day.task} - the criterion asks for a fact nothing publishes and answered \`${String(day.state)}\`, so the day was decided by something else (missing fact: ${String(day.fact)})`,
      );
    if (day.verdict !== null)
      findings.push(
        `a_gap_day_blocked_the_run:${day.task} - \`${String(day.state)}\` was reported as \`${String(day.verdict)}\`, so a day nobody could pass is a failed day (missing fact: ${String(day.fact)})`,
      );
  }
  for (const day of decidable) {
    if (day.state === "unjudged")
      findings.push(
        `${GAP_DAY_GATE}:${day.task} - the criterion is decidable and answered \`unjudged\`, so a day that can be judged is excused instead`,
      );
    // Nothing proved it and nothing said so: an undecided day that reaches the session verdict as a pass.
    if (day.state !== "achieved" && day.verdict === null)
      findings.push(
        `a_non_gap_day_did_not_block_the_run:${day.task} - the criterion answered \`${String(day.state)}\` and the run was not told, so an undecided day reads as a pass (reason: ${String(day.reasonCode)})`,
      );
  }
  const blockedGaps = gaps.filter((day) => day.verdict !== null).length;
  const unblockedDecidable = decidable.filter((day) => day.state !== "achieved" && day.verdict === null).length;
  const reading =
    `days ${String(days.length)} · judged ${String(decidable.length)} · unjudged ${String(gaps.length)} · ` +
    `a gap day that blocked ${String(blockedGaps)} · a non-gap day that did not ${String(unblockedDecidable)}`;
  t.diagnostic(reading);
  // Zero is not green: a rotation of nothing but gaps, or one with none, would agree with itself about one of the two
  // halves of this rule.
  assert.ok(
    decidable.length > 0 && gaps.length > 0,
    `${reading} - one half of this rule examined nothing, so it cannot fail`,
  );
  assert.deepEqual(findings, [], `${reading}\n${findings.join("\n")}`);
});

/**
 * THE RAIL THE STATE NEEDS: a run whose every day was a gap day has been judged by nothing.
 *
 * <p>
 * `unjudged` had to be able to pass a day, which makes it able to pass a RUN. A run assembled entirely from gap days -
 * every day pinned to one - could otherwise report `completed` with nothing judged at all, and that is the hole every
 * exemption opens if the zero is not told apart from the low count.
 * </p>
 */
test("a run whose every day was a gap day is judged by nothing, and that is blocked rather than passed", () => {
  const gapDays = ROTATION.filter((task) => !judgesAPublishedFact(task));
  assert.ok(gapDays.length > 0, "the rotation is expected to hold the days whose criterion cannot be decided");
  const purposes = gapDays.map((task, index) => Object.freeze({ day: index + 1, task, ...judgeTaskPurpose(task, []) }));
  assert.equal(
    taskPurposeVerdict(purposes),
    `task_purposes_nothing_judged:${String(gapDays.length)}of${String(gapDays.length)}`,
    "every day unjudged is a run nobody judged: it must not reach `completed`",
  );
  // ONE decided day is enough for the run to have been judged, and an unjudged day beside it is not a failure.
  assert.equal(
    taskPurposeVerdict([...purposes, Object.freeze({ day: 99, task: "mine_delve", state: "achieved" })]),
    null,
    "a run with a day the evidence decided was judged, so its gap days are not an exemption from the whole verdict",
  );
  // And a scenario that names no task at all is judged on its session alone - that is not a run nobody judged.
  assert.equal(taskPurposeVerdict([]), null);
});

/**
 * THE GATE: `a_run_is_never_scheduled_on_days_nothing_can_judge`.
 *
 * <p>
 * A RUN THAT WAS SCHEDULED ON NOTHING JUDGEABLE CANNOT SAY WHETHER ANYTHING WAS ACHIEVED, and that is a property of the
 * rotation rather than of the days she lived. Measured on `round84`: `state: blocked`, `reason
 * task_purposes_nothing_judged:3of3` - day 1 `sweep_animals_and_company`, day 2 `sweep_carried_things`, day 3
 * `clear_east_patch` - while `violations 0`, `crossings 2 of 2` and every night's lifecycle agreed with the world. Three
 * rotation entries in a row were criteria whose facts nothing publishes, so the run did everything right and could not
 * say so.
 * </p>
 * <p>
 * POPULATION: every run the rotation can be configured into - the day counts a run can have, from the baseline's own
 * window (`crossNights` nights end `crossNights + 1` days), crossed with every offset `runOffsetFor` can produce. The
 * days are read through `dayTaskSchedule`, which is the one scheduling path, so a pin, an override or a later rule lands
 * in this reading by construction instead of in a second copy of it. The reading prints what it scheduled and how much
 * of it the evidence can judge (`days N · judgedable J · gap G`, naming the gap days), and `J === 0` is the failure.
 * </p>
 * <p>
 * BOTH FALSIFIERS ARE IN THIS TEST, because a gate over a rotation that is already correct can only ever pass: a pool
 * whose every day is unjudgeable must fail by naming the days it chose, and the same pool with ONE day the evidence
 * decides among them must pass.
 * </p>
 * <p>
 * red-proof: inject  a pool whose every day is a gap into `scheduledRunReadings` -> this gate reds, naming the three
 *                   days it scheduled; removing the rule from `dayTaskSchedule` (scheduling the plain rotation) reds it
 *                   on `round84`'s own three entries
 *                   (tools/lib/task-purpose.test.mjs)
 * </p>
 */
const RUN_WINDOW_GATE = "a_run_is_never_scheduled_on_days_nothing_can_judge";

/** The day counts a run can have: N nights end N+1 days (`multiday-loop.mjs`), for N inside the baseline's window. */
const RUN_DAY_COUNTS = Object.freeze(
  Array.from(
    { length: MAXIMUM_BASELINE_DAYS - MINIMUM_BASELINE_DAYS + 1 },
    (_, index) => MINIMUM_BASELINE_DAYS + index + 1,
  ),
);

/** Every run one pool can be configured into, and what each one scheduled, in the schedule's own line. */
function scheduledRunReadings({ rotation = ROTATION, judges = judgesAPublishedFact } = {}) {
  const readings = [];
  for (const days of RUN_DAY_COUNTS) {
    for (let runOffset = 0; runOffset < rotation.length; runOffset += 1) {
      const taskForDay = dayTaskSchedule({ runOffset, judgesAPublishedFact: judges, rotation });
      const scheduled = Array.from({ length: days }, (_, index) => ({ day: index + 1, task: taskForDay(index + 1) }));
      readings.push(Object.freeze({ runOffset, ...readScheduledJudgement(scheduled) }));
    }
  }
  return readings;
}

test(RUN_WINDOW_GATE, (t) => {
  const gapDay = (task) => !judgesAPublishedFact(task);
  const readings = scheduledRunReadings();
  const findings = readings
    .filter((run) => run.judgeable === 0)
    .map((run) => `${RUN_WINDOW_GATE}:offset_${String(run.runOffset)}:${String(run.days)}days - ${run.reading}`);
  // What the rule had to move, so a rotation that happens to need no move says so rather than reading as coverage.
  const adjacentPairs = ROTATION.map((task, index) =>
    Object.freeze({ task, next: ROTATION[(index + 1) % ROTATION.length] }),
  )
    .filter((pair) => gapDay(pair.task) && gapDay(pair.next))
    .map((pair) => `${pair.task}->${pair.next}`);
  // The run that can be judged least, printed with the population it was taken over: zero population agrees with itself.
  const fewest = readings.reduce((lowest, run) => (run.judgeable < lowest.judgeable ? run : lowest), readings[0]);
  const reading =
    `runs ${String(readings.length)} (${RUN_DAY_COUNTS.join("/")} days x ${String(ROTATION.length)} offsets) · ` +
    `fewest judgedable ${String(fewest?.judgeable ?? "not_measured")} · ${String(fewest?.reading ?? "not_measured")} · ` +
    `adjacent unjudgeable pairs ${String(adjacentPairs.length)}${adjacentPairs.length === 0 ? "" : `: ${adjacentPairs.join(", ")}`}`;
  t.diagnostic(reading);
  assert.ok(readings.length > 0, `${reading} - no run was examined, so the gate cannot fail`);
  assert.deepEqual(findings, [], `${reading}\n${findings.join("\n")}`);

  // RED: a pool whose every day is a gap. The schedule has nothing to choose, and the gate has to name the days it
  // chose instead of only counting them - `round84`'s three, by name, are what would have made the run readable.
  const gapPool = ROTATION.filter((task) => gapDay(task)).slice(0, 3);
  const red = scheduledRunReadings({ rotation: gapPool }).filter((run) => run.judgeable === 0);
  assert.ok(red.length > 0, `a pool of ${gapPool.join(", ")} must fail this gate, and it passed`);
  assert.match(
    red[0].reading,
    new RegExp(`^days ${String(gapPool.length)} · judgedable 0 · gap ${String(gapPool.length)} \\(day1=`, "u"),
    `the reading has to state the counts a reader acts on, gap days included; got ${red[0].reading}`,
  );
  assert.deepEqual(
    [...new Set(red[0].gapDays.map((entry) => entry.task))],
    gapPool,
    `the failure has to name the days it chose; got ${red[0].reading}`,
  );

  // GREEN: the same three days with ONE the evidence decides among them is enough to tell whether anything was achieved.
  const decidedTask = ROTATION.find((task) => judgesAPublishedFact(task));
  const withOneJudgedable = [gapPool[0], decidedTask, gapPool[2]];
  assert.deepEqual(
    scheduledRunReadings({ rotation: withOneJudgedable })
      .filter((run) => run.judgeable === 0)
      .map((run) => run.reading),
    [],
    `one day the evidence decides among ${withOneJudgedable.join(", ")} must be enough for every run to be judged`,
  );
});

/**
 * A gap's declaration, checked where it is read: a gap names the fact AND the producer that would have to publish it.
 *
 * Separate from the loop so that the third kind of criterion does not push one function past the complexity ceiling by
 * growing two assertions - the rule has its own name either way.
 */
function assertGapDeclaresItsFact(task, entry) {
  // The sentence and the fact are ONE declaration with two spellings, and the second is the one a gate can read: what
  // the fact IS, and who would have to publish it (`null` when nothing in this tree is even the right place).
  assert.ok(
    typeof entry.unpublishedFact?.name === "string" && entry.unpublishedFact.name.trim().length > 0,
    `${task}: a gap has to NAME the fact it needs, not only describe it in a sentence`,
  );
  const producer = entry.unpublishedFact.producer;
  assert.ok(
    producer === null ||
      (typeof producer?.path === "string" && typeof producer?.anchor === "string" && producer.anchor.length > 0),
    `${task}: a gap declares either the producer that would have to publish its fact, or \`null\` when no file in this tree is the right place - never neither`,
  );
}

test("a purpose is either a criterion of more than one fact, a declared shape, or a named gap", () => {
  for (const [task, entry] of Object.entries(TASK_PURPOSE_CRITERIA)) {
    if (entry.missingFact !== undefined) {
      assert.ok(
        typeof entry.missingFact === "string" && entry.missingFact.trim().length > 40,
        `${task}: a gap has to name the fact that is missing, not merely decline to answer`,
      );
      assert.equal(
        entry.steps,
        undefined,
        `${task}: a task with a missing fact must not also carry a criterion - one of the two is wrong`,
      );
      assert.ok(
        typeof entry.purpose === "string" && entry.purpose.length > 0,
        `${task}: a gap states the purpose it cannot decide`,
      );
      assertGapDeclaresItsFact(task, entry);
      continue;
    }
    // A SHAPE is the third kind, and it declares the rectangle rather than a step list: the criterion is not "these
    // actions happened" but "the tiles they changed form this rectangle". It must still name what proves a tile,
    // because a shape nothing can fill is a purpose nothing can decide.
    if (entry.patch !== undefined) {
      assert.equal(entry.steps, undefined, `${task}: a declared shape is not a step list`);
      for (const dimension of ["width", "height"])
        assert.ok(
          Number.isInteger(entry.patch[dimension]) && entry.patch[dimension] > 1,
          `${task}: a declared patch needs an integer ${dimension} of more than one tile`,
        );
      assert.ok(
        typeof entry.purpose === "string" && entry.purpose.trim().length > 0,
        `${task}: a shape criterion states its purpose`,
      );
      for (const kind of ["tilledBy", "croppedBy"])
        assert.ok(
          Array.isArray(entry[kind]) && entry[kind].length > 0,
          `${task}: a declared patch must say which actions prove a tile is ${kind === "tilledBy" ? "tilled" : "crop-bearing"}`,
        );
      for (const proof of [...entry.tilledBy, ...entry.croppedBy])
        assert.ok(
          typeof proof.actionId === "string" && typeof proof.tileField === "string",
          `${task}: every tile proof names an action and the evidence field that carries the tile`,
        );
      continue;
    }
    // A PLOT is the fourth kind: a count of tiles with no rectangle around them. It must name the count and the actions
    // that prove each half, because a count nothing proves is a purpose nothing can decide - and its tile proofs are
    // held to the same rule as a patch's, one field name per tile.
    if (entry.plot !== undefined) {
      assert.equal(entry.steps, undefined, `${task}: a count of tiles is not a step list`);
      assert.equal(entry.patch, undefined, `${task}: a plot declares no rectangle, so it declares no shape`);
      assert.ok(
        Number.isInteger(entry.plot.tiles) && entry.plot.tiles > 1,
        `${task}: a plot needs an integer count of more than one tile`,
      );
      assert.ok(
        typeof entry.purpose === "string" && entry.purpose.trim().length > 0,
        `${task}: a plot criterion states its purpose`,
      );
      for (const kind of ["tilledBy", "sownBy", "wateredBy"])
        assert.ok(
          Array.isArray(entry[kind]) && entry[kind].length > 0,
          `${task}: a plot must say which actions prove a tile is ${kind === "tilledBy" ? "tilled" : kind === "sownBy" ? "sown" : "watered"}`,
        );
      for (const proof of [...entry.tilledBy, ...entry.sownBy, ...entry.wateredBy])
        assert.ok(
          typeof proof.actionId === "string" && typeof proof.tileField === "string",
          `${task}: every tile proof names an action and the evidence field that carries the tile`,
        );
      // The purchase half is an action and not a tile: a counter names a stack, never ground.
      assert.ok(
        Array.isArray(entry.boughtBy) && entry.boughtBy.length > 0,
        `${task}: a plot called \`expand\` has to name the actions that bought the seed`,
      );
      for (const actionId of entry.boughtBy)
        assert.equal(typeof actionId, "string", `${task}: \`boughtBy\` names action ids, not tile proofs`);
      continue;
    }
    assert.ok(
      typeof entry.purpose === "string" && entry.purpose.trim().length > 0,
      `${task}: a criterion states its purpose`,
    );
    assert.ok(Array.isArray(entry.steps), `${task}: a criterion without steps decides nothing`);
    // A one-step criterion IS the old defect: one action's success would be the whole purpose.
    assert.ok(
      entry.steps.length >= 2,
      `${task}: a criterion of one step can be satisfied by a single action's success, which is the defect this table exists to prevent`,
    );
    for (const candidate of entry.steps) {
      assert.ok(
        typeof candidate.actionId === "string" || Array.isArray(candidate.anyOf),
        `${task}: every step names an action id or a set of them`,
      );
    }
  }
});

/**
 * THE ORDER GATE: `a_criterion_requires_an_order_the_world_does_not:<task>`.
 *
 * A criterion that reads its steps forward through the receipt log asserts that each earlier fact is a PRECONDITION of
 * the next, and that is a claim about the WORLD: the farm has to be unable to offer the work in the other order. The
 * gate cannot decide causality - a sentence is a sentence - so it decides the two things that ARE readable: an ordered
 * row names both ends of the order it claims (its `because` mentions at least two of its own steps' actions, derived
 * from the row), and a row that declares itself unordered does not also claim a cause. The rest is left to the reader
 * the reason exists for.
 *
 * Measured 2026-11-18 (`round76`): a criterion of four kinds of farm work was ONE row, ordered by the default, and its
 * order was a route rather than a cause - a day that cleared, sowed, watered and tilled answered `not_achieved`. This
 * gate is what keeps the next such row from being a sequence nobody had to justify.
 *
 * red-proof: inject  `{ ordered: true }` (dropping the `because`) onto a row, or adding a `because` to
 *                   `forage_and_trees` - both turn this test red, naming the row
 *                   (tools/lib/task-purpose.test.mjs)
 */
test("a_criterion_requires_an_order_the_world_does_not", (t) => {
  const table = Object.entries(TASK_PURPOSE_CRITERIA);
  const violations = [];
  let ordered = 0;
  let reasoned = 0;
  for (const [task, entry] of table) {
    // A gap names a fact nothing publishes and a declared shape names a rectangle: neither states an order.
    if (entry.steps === undefined) continue;
    const code = `a_criterion_requires_an_order_the_world_does_not:${task}`;
    if (entry.ordered === false) {
      if (entry.because !== undefined)
        violations.push(`${code} - the row is unordered and still carries a because, so it is neither`);
      continue;
    }
    ordered += 1;
    const actionIds = new Set(
      entry.steps.flatMap((candidate) =>
        candidate.actionId === undefined ? [...candidate.anyOf] : [candidate.actionId],
      ),
    );
    // Tokens rather than substring matches: an id found inside a longer word is not a name for the fact.
    const tokens = new Set((entry.because ?? "").split(/[^A-Za-z0-9_-]+/u));
    const named = [...actionIds].filter((actionId) => tokens.has(actionId));
    if (named.length < 2) {
      violations.push(
        `${code} - its because names ${named.length === 0 ? "none of its steps" : `only ${named.join(", ")}`} ` +
          `(${[...actionIds].sort().join(", ")}). A causal link has two ends: name them in \`because\`, or declare the ` +
          "row `ordered: false` - the farm may do the work in another order, and then the order is not the purpose",
      );
      continue;
    }
    reasoned += 1;
  }
  const reading = `criteria examined ${String(table.length)} · ordered ${String(ordered)} · ordered-with-a-reason ${String(reasoned)}`;
  t.diagnostic(reading);
  // Zero is not green: an order gate with no ordered row examined agrees with itself.
  assert.ok(
    table.length > 0 && ordered > 0,
    `${reading} - this table holds no ordered criterion, so nothing here was examined and the gate cannot fail`,
  );
  assert.deepEqual(violations, [], `${reading}\n${violations.join("\n")}`);
});

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOST_CONTRACT_PATH = relative(REPO_ROOT, fileURLToPath(HOST_COMPLETION_CONTRACT)).replaceAll("\\", "/");

/** The producer files this gate has read, so one file is read once however many facts cite it. */
const producerSources = new Map();
function producerSource(path) {
  const cached = producerSources.get(path);
  if (cached !== undefined) return cached;
  let text = null;
  try {
    text = readFileSync(resolve(REPO_ROOT, path), "utf8");
  } catch {
    text = null;
  }
  producerSources.set(path, text);
  return text;
}

/**
 * The line a producer's anchor sits on TODAY, or null when the file no longer holds it.
 *
 * This is what lets a declaration name an IDENTIFIER instead of a line: `tools/check-stardew-task-gap-reasons.mjs`
 * refuses a `file.cs:270` in a reason because the line outlived its claim (`mine_ladder_to_depth`), and the answer is
 * not to stop citing the producer - it is to cite a token the producer writes and let the gate print the line.
 */
function producerLineOf(producer) {
  const text = producerSource(producer.path);
  if (text === null) return null;
  const index = text.split(/\r?\n/u).findIndex((line) => line.includes(producer.anchor));
  return index < 0 ? null : index + 1;
}

/** The producer line as the reading prints it, or the reason it could not be printed. */
function producerReading(producer) {
  const line = producerLineOf(producer);
  return line === null ? `${producer.path} no longer holds \`${producer.anchor}\`` : `${producer.path}:${String(line)}`;
}

/**
 * The facts a receipt-reading criterion requires, each with the producer that publishes it.
 *
 * Derived from the entry's own shape rather than listed here: a step list reads one action's postcondition per step (one
 * per alternative), and a declared shape reads a tile field AND the map it is on out of each tile proof's receipt. The
 * name is what a failure prints, so it says WHICH fact and not merely that one is missing.
 */
function receiptFactsOf(entry) {
  const facts = [];
  for (const candidate of entry.steps ?? []) {
    for (const actionId of candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId]) {
      facts.push({
        name: `\`${actionId}\`'s own postcondition`,
        producer: { path: HOST_CONTRACT_PATH, anchor: `${actionId}: (claim) =>` },
      });
    }
  }
  // A plot's purchase is a receipt the criterion reads, so it needs its own producer exactly as a step does.
  for (const actionId of entry.boughtBy ?? [])
    facts.push({
      name: `\`${actionId}\`'s own postcondition`,
      producer: { path: HOST_CONTRACT_PATH, anchor: `${actionId}: (claim) =>` },
    });
  for (const proof of [
    ...(entry.tilledBy ?? []),
    ...(entry.croppedBy ?? []),
    ...(entry.sownBy ?? []),
    ...(entry.wateredBy ?? []),
  ]) {
    // The keys come from the row the Host folds over (`declaredEvidenceKeys`), so "the receipt cannot carry this" is
    // read from the declaration instead of remembered.
    const keys = declaredEvidenceKeys(proof.actionId);
    const missing = [proof.tileField, "location"].filter((key) => !keys.includes(key));
    facts.push({
      name:
        missing.length === 0
          ? `\`${proof.actionId}\`'s \`${proof.tileField}\` tile, and the \`location\` it is on`
          : `\`${proof.actionId}\`'s \`${missing.join("` and `")}\`, which its own completion contract does not carry`,
      producer: missing.length === 0 ? { path: HOST_CONTRACT_PATH, anchor: `${proof.actionId}: (claim) =>` } : null,
    });
  }
  return facts;
}

/** The gate's own name, written once: the test is named with it and so is every failure line. */
const GATE = "a_criterion_asks_for_a_fact_the_product_does_not_publish";

/**
 * A gap's reading: the line it prints, or the fact it fails on.
 *
 * A gap declares the fact unjudgeable; its `producer` is the place that would have to publish it (`null` when no file in
 * this tree is even the right place). Both halves are the declaration - neither is the fact being there, which is why a
 * gap never counts as `satisfied-by-a-producer`.
 */
function gapFactReadingOf(entry) {
  const declared = entry.unpublishedFact;
  const reason = typeof entry.missingFact === "string" ? entry.missingFact.trim() : "";
  if (declared === undefined || typeof declared.name !== "string" || declared.name.trim().length === 0)
    return { fact: `what its purpose \`${entry.purpose}\` needs`, producer: "undeclared" };
  const producer = declared.producer === null ? "none" : producerReading(declared.producer);
  if (declared.producer !== null && producerLineOf(declared.producer) === null)
    return { fact: declared.name, producer };
  if (reason.length <= 40) return { fact: declared.name, producer: `${producer}, and no reason is declared for it` };
  return { line: `missing fact: ${declared.name} · expected producer: ${producer}` };
}

/** A criterion that reads receipts: no fact may be one the product fails to publish. */
function receiptFactsReading(entry) {
  const facts = receiptFactsOf(entry);
  const unpublished = facts
    .filter((fact) => fact.producer === null || producerLineOf(fact.producer) === null)
    .map((fact) => ({
      fact: fact.name,
      producer: fact.producer === null ? "none" : producerReading(fact.producer),
    }));
  if (facts.length === 0) unpublished.push({ fact: "not one fact: this criterion reads nothing", producer: "none" });
  if (unpublished.length === 0) return {};
  return {
    fact: [...new Set(unpublished.map((entry) => entry.fact))].join(", "),
    producer: [...new Set(unpublished.map((entry) => entry.producer))].join(", "),
  };
}

/**
 * THE FACT GATE: `a_criterion_asks_for_a_fact_the_product_does_not_publish:<task>`.
 *
 * A criterion is a statement about the world, and this judge reads facts the product PUBLISHES. Two of round77's three
 * days (2026-11-19) answered `task_purpose_needs_an_unpublished_fact` while the gameplay itself was healthy - 500
 * actions, two nights, `violations []` - which is a judge asking for a fact nobody writes down. The table declared those
 * gaps, but nothing stopped the next criterion from being written against a fact nobody publishes, and nothing re-read
 * the declaration.
 *
 * POPULATION: every entry of `TASK_PURPOSE_CRITERIA`, never a list here; the facts each requires are derived from the
 * entry's own shape, so a gap added tomorrow is covered by existing. PROPERTY: every required fact is either published
 * by a named producer - a file whose own ANCHOR this gate resolves today, so the reading carries a `file:line` that is
 * derived rather than typed - or declared "the criterion cannot be judged from the product's facts" with the reason it
 * cannot. A fact with neither is `asks-the-unpublishable`, and the failure names the criterion and the fact.
 *
 * The declared gaps are PRINTED, one `missing fact: ... · expected producer: ...` line each, because that sentence is
 * the answer a reader came for: which fact, and who would have to publish it.
 *
 * red-proof: inject  dropping `unpublishedFact` from `furnish_and_arrange`, or declaring a patch tile field the Host's
 *                   contract does not carry (`tileProof("till_soil", "hoe_dirt_after")`), turns this red naming that
 *                   criterion and the fact; and renaming a step action's contract row breaks the producer's anchor
 *                   (tools/lib/task-purpose.test.mjs)
 */
test(GATE, (t) => {
  const table = Object.entries(TASK_PURPOSE_CRITERIA);
  const violations = [];
  const declaredFacts = [];
  let satisfied = 0;
  for (const [task, entry] of table) {
    // A gap DECLARES its fact unjudgeable; a criterion that reads receipts must have a producer for every fact.
    const reading = entry.missingFact === undefined ? receiptFactsReading(entry) : gapFactReadingOf(entry);
    if (reading.line !== undefined) declaredFacts.push(reading.line);
    else if (reading.fact === undefined) satisfied += 1;
    else violations.push(`${GATE}:${task} - missing fact: ${reading.fact} · expected producer: ${reading.producer}`);
  }
  const reading = `criteria examined ${String(table.length)} · satisfied-by-a-producer ${String(satisfied)} · asks-the-unpublishable ${String(violations.length)}`;
  t.diagnostic(reading);
  for (const line of declaredFacts) t.diagnostic(line);
  // Zero is not green: a gate that examined no criterion, or found no fact a producer publishes, agrees with itself.
  assert.ok(
    table.length > 0 && satisfied > 0,
    `${reading} - nothing in this table was satisfied by a producer, so the reading cannot fail and measures nothing`,
  );
  assert.deepEqual(violations, [], `${reading}\n${violations.join("\n")}`);
});

test("every action a criterion reads is published by the Mod", async () => {
  const published = new Set(await readAllPublishedExecutionStardewActionIds());
  const experimental = new Set(await readExperimentalStardewActionIds());
  const drifting = [];
  for (const [task, entry] of Object.entries(TASK_PURPOSE_CRITERIA)) {
    for (const candidate of entry.steps ?? []) {
      for (const actionId of candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId]) {
        if (published.has(actionId)) continue;
        drifting.push(
          experimental.has(actionId)
            ? `${task} reads ${actionId}, which the Mod registers Experimental - no run can dispatch it`
            : `${task} reads ${actionId}, which the Mod does not publish`,
        );
      }
    }
    // A shape or a plot criterion reads its tile proofs instead of steps, and the same rule governs them.
    for (const proof of [
      ...(entry.tilledBy ?? []),
      ...(entry.croppedBy ?? []),
      ...(entry.sownBy ?? []),
      ...(entry.wateredBy ?? []),
    ]) {
      if (published.has(proof.actionId)) continue;
      drifting.push(
        experimental.has(proof.actionId)
          ? `${task} reads ${proof.actionId}, which the Mod registers Experimental - no run can dispatch it`
          : `${task} reads ${proof.actionId}, which the Mod does not publish`,
      );
    }
    // And a purchase a plot criterion reads is an action like any other.
    for (const actionId of entry.boughtBy ?? []) {
      if (published.has(actionId)) continue;
      drifting.push(`${task} reads ${actionId}, which the Mod does not publish`);
    }
  }
  assert.deepEqual(drifting, [], drifting.join("; "));
});

test("hitting a task's declared actions with a bare succeeded receipt accomplishes nothing", () => {
  // The reported shape of the old path: the declaration says which actions serve the task, every one of them comes
  // back succeeded, and the day is counted. `succeeded` alone is not a postcondition, so none of these may reach
  // `achieved` - and the assertion is per ACTION, so a single success is covered as well as the whole set.
  const drifting = [];
  for (const task of ROTATION) {
    const declared = new Set(DAILY_TASK_ACTION_HINTS[task] ?? []);
    for (const candidate of TASK_PURPOSE_CRITERIA[task]?.steps ?? []) {
      for (const actionId of candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId])
        declared.add(actionId);
    }
    for (const actionId of declared) {
      const judged = judgeTaskPurpose(task, [receipt(actionId, { evidence: { detail: "result=ok" } })]);
      if (judged.state === "achieved") drifting.push(`${task} <- ${actionId}`);
    }
    // And the first step on its own is not the purpose either, whatever else the run did.
    const first = TASK_PURPOSE_CRITERIA[task]?.steps?.[0];
    if (first !== undefined) {
      const actionId = first.actionId === undefined ? first.anyOf[0] : first.actionId;
      if (judgeTaskPurpose(task, [receipt(actionId)]).state === "achieved")
        drifting.push(`${task} <- its first step only`);
    }
  }
  assert.deepEqual(
    drifting,
    [],
    `a task was accomplished by an action succeeding instead of by its own criterion: ${drifting.join(", ")}`,
  );
});

test("a succeeded receipt that carries no postcondition of its own is refused, and proves nothing", () => {
  const drifting = [];
  let examined = 0;
  // The actions a criterion reads, from whichever shape it declares - steps, or the several actions a plot names. A plot
  // left out of this population would be the one criterion nobody checked the admission rule against.
  const readActionIdsOf = (entry) => {
    if (Array.isArray(entry?.steps))
      return entry.steps.map((candidate) => (candidate.actionId === undefined ? candidate.anyOf[0] : candidate.actionId));
    if (entry?.plot === undefined) return null;
    return [
      ...new Set([
        ...entry.boughtBy,
        ...[...entry.tilledBy, ...entry.sownBy, ...entry.wateredBy].map((proof) => proof.actionId),
      ]),
    ];
  };
  for (const task of ROTATION) {
    const actionIds = readActionIdsOf(TASK_PURPOSE_CRITERIA[task]);
    if (actionIds === null || actionIds.length === 0) continue;
    examined += 1;
    const steps = actionIds.map((actionId) => receipt(actionId, { evidence: null }));
    const judged = judgeTaskPurpose(task, steps);
    if (judged.state === "achieved") drifting.push(`${task}: a succeeded receipt with no evidence accomplished it`);
    assert.deepEqual(
      judged.refusedReceipts.map((refused) => refused.actionId).sort(),
      actionIds.slice().sort(),
      `${task}: every evidence-less success must be reported as refused`,
    );
  }
  assert.ok(examined > 0, "blocked: no criterion reads a receipt, so nothing here was examined");
  assert.deepEqual(drifting, [], drifting.join("; "));
});

test("a succeeded receipt whose detail is another terminal's is refused", () => {
  // The same real `break_rock` detail under a reason code that is not that action's terminal proves no completion -
  // the evidence is the Mod's `rock_source_damaged` progress shape, which is a real `succeeded` dispatch.
  const damaged = Object.freeze({ ...BROKE_ROCK, reasonCode: "rock_source_damaged" });
  const { admitted, refused } = purposeReceipts([damaged]);
  assert.deepEqual(admitted, [], "a progress terminal is not a completion");
  assert.deepEqual(
    refused.map((entry) => entry.actionId),
    ["break_rock"],
  );
  assert.equal(judgeTaskPurpose("mine_delve", [damaged]).state, "unproven");
});

test("mine_delve: the surface rock that started this gate does not accomplish the task", () => {
  // THE MEASURED DEFECT. A day declared `[travel, enter_mine, break_rock]` and broke rocks on the farm: the rock's
  // own postcondition is real, so the old path counted the task. The purpose is order-sensitive, and the rock came
  // before any mine was entered.
  const surface = judgeTaskPurpose("mine_delve", [BROKE_ROCK]);
  assert.equal(surface.state, "not_achieved", "a rock broken with no mine entered is not a mine delved");
  assert.deepEqual(
    surface.admittedActionIds,
    ["break_rock"],
    "the rock's postcondition IS admitted - it just is not the purpose",
  );

  const wrongOrder = judgeTaskPurpose("mine_delve", [BROKE_ROCK, ENTERED_MINE]);
  assert.equal(wrongOrder.state, "not_achieved", "a rock broken BEFORE the mine was entered is still the surface");

  const delved = judgeTaskPurpose("mine_delve", [ENTERED_MINE, BROKE_ROCK]);
  assert.equal(delved.state, "achieved", "entering a mine and then breaking something is the purpose");
  assert.match(delved.purpose ?? "", /mine level was entered/);
});

test("mine_ladder_to_depth: the level's own exit ladder is a proven fact, so the named gap is gone", () => {
  // THE EXPIRED GAP, and the reason this suite has a date on it. The entry read: `use_mine_ladder` "is
  // `FarmhandActionLifecycle.Experimental` (`FarmhandActionDefinitions.cs:270`): the action is not published, so no run
  // can dispatch it and no receipt can prove a ladder was taken". The action was promoted to `LiveVerified` - live gate
  // runner, gate row, fixture, promotion parity - and the cited line came to hold a different declaration, so the entry
  // went on answering "this purpose cannot be decided" while both halves were published facts.
  assert.equal(
    TASK_PURPOSE_CRITERIA.mine_ladder_to_depth.missingFact,
    undefined,
    "the exit half is dispatchable and carries its own postcondition, so this purpose has a criterion, not a gap",
  );

  // Below that, the criterion behaves as the purpose is written: the ladder alone is NOT a level worked, and the order
  // the world saw the two facts in is part of the statement.
  const ladderOnly = judgeTaskPurpose("mine_ladder_to_depth", [LEFT_BY_LADDER]);
  assert.equal(ladderOnly.state, "not_achieved", "a ladder taken with no mine entered is not a level worked");
  assert.deepEqual(
    ladderOnly.admittedActionIds,
    ["use_mine_ladder"],
    "its postcondition IS admitted - it is not the purpose",
  );

  const wrongOrder = judgeTaskPurpose("mine_ladder_to_depth", [LEFT_BY_LADDER, ENTERED_MINE]);
  assert.equal(wrongOrder.state, "not_achieved", "leaving before entering is not the order the world saw");

  const left = judgeTaskPurpose("mine_ladder_to_depth", [ENTERED_MINE, LEFT_BY_LADDER]);
  assert.equal(left.state, "achieved", "entering a level and then leaving by its own ladder is the purpose");
  assert.match(left.purpose ?? "", /worked deeper/);
});

/**
 * THE DECLARATION GATE: `a_new_action_that_proves_a_pack_count_is_declared:<actionId>`.
 *
 * <p>
 * `sweep_carried_things` stopped being a gap because its purpose is two receipts, and the USING half of it is the
 * population `CARRIED_ITEM_USE_ACTIONS`. A list written inside that criterion would be the fourth hand-maintained table
 * in this file and the first to drift silently: a new action that spends what she carries would simply be invisible to
 * the day. So the population is derived from the two authorities that already answer it - the published execution
 * surface (`action-surface.v1.json`) crossed with the Host's completion contract (`stardew-completion-contracts.ts`),
 * which is where "this receipt can carry a pack count" is DECLARED - and every member has to have a row.
 * </p>
 * <p>
 * red-proof: inject  drop a row (`plant_seed`) and the gate fails naming it; declare an unpublished action and it fails naming
 * that; declare an action outside the population as one that ADDS to the pack and it fails, because no artifact proves
 * a direction for it (tools/lib/task-purpose.test.mjs)
 * </p>
 */
test("a_new_action_that_proves_a_pack_count_is_declared", async (t) => {
  const published = new Set(await readAllPublishedExecutionStardewActionIds());
  const { contracts } = readHostCompletionContracts(readFileSync(HOST_COMPLETION_CONTRACT, "utf8"));
  // The authority's own statement of "this action's receipt can say what the pack held": either the count of the item it
  // acted on, or the pack-wide occupied-slot / unit counts two actions publish instead.
  const provesAPackCount = [...published]
    .filter((actionId) => {
      const contract = contracts.get(actionId);
      if (contract === undefined || contract.keys.length === 0) return false;
      const keys = new Set(contract.keys);
      if (keys.has("inventory_before") && keys.has("inventory_after")) return true;
      return [...keys].some((key) => key.startsWith("inventory_slots") || key.startsWith("inventory_units"));
    })
    .sort();
  const declared = Object.keys(CARRIED_ITEM_ACTIONS).sort();
  const findings = [];
  for (const actionId of provesAPackCount)
    if (!(actionId in CARRIED_ITEM_ACTIONS))
      findings.push(
        `undeclared:${actionId} - its receipt can carry a pack count and no row in CARRIED_ITEM_ACTIONS says which way it moves`,
      );
  for (const actionId of declared) {
    if (!published.has(actionId)) findings.push(`not_published:${actionId} - no run can dispatch it`);
    const row = CARRIED_ITEM_ACTIONS[actionId];
    if (typeof row.because !== "string" || row.because.trim().length < 20)
      findings.push(`no_reason:${actionId} - a row has to say what the action does to the pack`);
    if (typeof row.spends !== "boolean") findings.push(`no_direction:${actionId}`);
    // A row outside the population claims a direction no artifact can check. Only `spends` is admissible there: an
    // action whose evidence names a slot and no before/after pair can prove it SPENT what it named, never that it added.
    if (!provesAPackCount.includes(actionId) && row.spends !== true)
      findings.push(
        `unprovable_direction:${actionId} - its contract publishes no pack count, so it cannot be declared as adding to the pack`,
      );
  }
  const reading =
    `proves a pack count ${String(provesAPackCount.length)} · declared ${String(declared.length)} · ` +
    `spend ${String(CARRIED_ITEM_SPEND_ACTIONS.length)} · findings ${String(findings.length)}`;
  t.diagnostic(reading);
  t.diagnostic(`spends: ${CARRIED_ITEM_SPEND_ACTIONS.join(", ")}`);
  // Zero is not green: a population the contract reader could not resolve would agree with itself.
  assert.ok(
    provesAPackCount.length > 0 && declared.length > 0,
    `${reading} - nothing was measured, so this gate cannot fail`,
  );
  assert.deepEqual(findings, [], `${reading}\n${findings.join("\n")}`);
});

/**
 * `round85`'s day 1, replayed through the criterion that now decides it.
 *
 * <p>
 * THE DAY, VERBATIM: `sweep_carried_things`, whose receipts held `ship_item`, `plant_seed`, `till_soil`, `water_crop`,
 * `harvest_crop`, `pickup_item`, `chest_retrieve` and `equip_tool`, and answered `unjudged` with
 * `task_purpose_needs_an_unpublished_fact` - "nothing publishes what the backpack held before or after". The pack IS
 * published (`inventoryItemFacts`), on the OBSERVATION, and this judge reads receipts. So the day was undecidable by
 * construction, and the two receipts it already held are the two acts its prompt asks for: a carried seed went into the
 * ground, and a carried item went into the shipping bin.
 * </p>
 * <p>
 * WHAT THIS PINS: the day is JUDGED rather than excused, and it is judged by two receipts - one shipment is a day that
 * sold something and used nothing, and two shipments are two sales, which is why the sale is not also in the using
 * population (tools/lib/task-purpose.test.mjs)
 * </p>
 */
const ROUND85_SHIPPED = (item, slot) =>
  receipt("ship_item", {
    reasonCode: "item_shipped",
    evidence: {
      detail: contractEvidence("ship_item", {
        location: "Farm",
        target: "shipping_bin_01",
        bin: "56,15",
        tile: "56,15",
        item,
        slot: String(slot),
        stack: "1",
        inventory_before: "1",
        inventory_after: "0",
        bin_before: "0",
        bin_after: "1",
        last_item_shipped_matched: "true",
        native_menu_opened: "false",
      }),
    },
  });

test("sweep_carried_things: round85's own day 1 is judged, and one receipt is not the day", () => {
  assert.equal(
    judgesAPublishedFact("sweep_carried_things"),
    true,
    "the purpose is two receipts the product publishes, so this day is judged rather than excused",
  );
  assert.equal(
    TASK_PURPOSE_CRITERIA.sweep_carried_things.missingFact,
    undefined,
    "and it must not also carry the gap sentence the pack's publication refuted",
  );

  // The day as it happened: a seed out of the pack, and an item into the bin.
  const day = judgeTaskPurpose("sweep_carried_things", [PLANTED(69, 20), ROUND85_SHIPPED("(O)388", 12)]);
  assert.equal(day.state, "achieved", "using something carried and selling something carried is the purpose");
  assert.deepEqual(day.admittedActionIds, ["plant_seed", "ship_item"], "and it is those two receipts that say so");
  assert.match(day.purpose ?? "", /used up, and something she was carrying was sold/);

  // One act is not the day, whichever act it is.
  assert.equal(
    judgeTaskPurpose("sweep_carried_things", [ROUND85_SHIPPED("(O)388", 12)]).state,
    "not_achieved",
    "a day that only sold something used nothing up",
  );
  assert.equal(
    judgeTaskPurpose("sweep_carried_things", [PLANTED(69, 20)]).state,
    "not_achieved",
    "a day that only used something up sold nothing",
  );
  // And the sale cannot answer the using half twice: two shipments are two sales.
  assert.equal(
    judgeTaskPurpose("sweep_carried_things", [ROUND85_SHIPPED("(O)388", 12), ROUND85_SHIPPED("(O)390", 13)]).state,
    "not_achieved",
    "two shipments are two sales, not a use and a sale",
  );
});

test("town_market: round92's day 3 is judged by its own purchase and its own letter", () => {
  // ROUND92'S TWO PURCHASES AND ONE LETTER, from
  // `.live-runs/game-ladder/2026-11-22T09-12-45-412Z-multiday_routine/timeline.jsonl` (indices 277, 442 and 386). The
  // day answered `unjudged · task_purpose_needs_an_unpublished_fact` while both purchases had succeeded: the buying half
  // named `shop=SeedShop;owner_tile=4,17` - an id and a coordinate - and never the map it happened on, so no receipt
  // said where the purchase was. The producer now writes `location` and the Host's row requires it, which is the fact
  // this entry used to ask for.
  const PURCHASED = (moneyBefore, moneyAfter, purchased) =>
    receipt("shop_purchase", {
      reasonCode: "item_purchased",
      evidence: {
        detail: `shop=SeedShop;location=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=${String(purchased)};purchased=${String(purchased)};unit_price=20;money_before=${String(moneyBefore)};money_after=${String(moneyAfter)};owned_before=0;owned_after=${String(purchased)};gained=${String(purchased)};stock_before=unlimited;stock_after=unlimited;owner_tile=4,17;menu_closed=true;clicks=${String(purchased)}[click${String(purchased - 1)}:row=0|cursor=0|held_after=(O)472];drops=${String(purchased)}[drop${String(purchased - 1)}:slot=10|held=(O)472->none]`,
      },
    });
  const LETTER = receipt("claim_mail_attachment", {
    reasonCode: "mail_claimed",
    evidence: {
      detail:
        "target=mailbox_392f1c17e7121df2;tile=68,16;location=Farm;mail_id=spring_2_1;mail_content_known=true;" +
        "mail_has_attachment=true;mail_attachment_commands=1;mail_recorded_natively=true;pending_before=1;" +
        "pending_after=0;mail_removed=true;mail_recorded=true;letter_opened=true;letter_closed=true;" +
        "collection_overflow_pending=false;mail_salvage_inventory_units=0;mail_salvage_debris_units=0;" +
        "inventory_slots_before=15;inventory_slots_after=15;inventory_units_before=48;inventory_units_after=48",
    },
  });

  assert.equal(
    judgesAPublishedFact("town_market"),
    true,
    "the purpose is two receipts the product publishes, so this day is judged rather than excused",
  );
  assert.equal(
    TASK_PURPOSE_CRITERIA.town_market.missingFact,
    undefined,
    "and it must not also carry the gap sentence the purchase receipt's own map refuted",
  );

  const day = judgeTaskPurpose("town_market", [PURCHASED(820, 420, 20), LETTER, PURCHASED(420, 220, 10)]);
  assert.equal(day.state, "achieved", "a purchase and the post are the errand the day was given");
  assert.deepEqual(day.admittedActionIds, ["claim_mail_attachment", "shop_purchase"]);
  assert.deepEqual(day.refusedReceipts, [], "nothing the day did was refused");

  // ONE ACT IS NOT THE ERRAND, whichever act it is.
  assert.equal(
    judgeTaskPurpose("town_market", [PURCHASED(820, 420, 20)]).state,
    "not_achieved",
    "a day that only bought something brought no post in",
  );
  assert.equal(
    judgeTaskPurpose("town_market", [LETTER]).state,
    "not_achieved",
    "a day that only read the post bought nothing",
  );

  // AND A PURCHASE THAT DOES NOT SAY WHERE IS NOT A PURCHASE THIS HOST READS: the map is not decoration on the receipt,
  // it is the clause, so a day carrying only the shape round92 shipped answers `unproven` - the run cannot tell, rather
  // than the purchase being silently counted.
  const withoutMap = receipt("shop_purchase", {
    reasonCode: "item_purchased",
    evidence: { detail: PURCHASED(820, 420, 20).evidence.detail.replace(";location=SeedShop", "") },
  });
  const noMap = judgeTaskPurpose("town_market", [withoutMap, LETTER]);
  assert.equal(noMap.state, "unproven", "a purchase receipt with no map is evidence that proves nothing about where");
  assert.deepEqual(noMap.refusedReceipts, [
    { actionId: "shop_purchase", reasonCode: "succeeded_receipt_without_its_own_postcondition" },
  ]);
});

test("a task with a named gap answers `unjudged` for every receipt set, however complete", () => {
  const gaps = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.missingFact !== undefined);
  assert.ok(gaps.length > 0, "the registry is expected to declare the purposes it cannot decide");
  for (const [task, entry] of gaps) {
    // Every declared action of that task, each with evidence-shaped detail: the strongest set a run could produce.
    const complete = (DAILY_TASK_ACTION_HINTS[task] ?? []).map((actionId) => receipt(actionId));
    const judged = judgeTaskPurpose(task, complete);
    // `unjudged`, not `unproven`: the two say different things about the run. `unproven` is "this run's evidence proved
    // nothing", which a day can be blamed for; `unjudged` is "this criterion asks for a fact nothing publishes", which
    // no receipt set could ever settle - and a day nobody could judge must not be reported as a day that failed.
    assert.equal(judged.state, "unjudged", `${task}: a purpose with no decidable fact is nobody's failure`);
    assert.equal(judged.missingFact, entry.missingFact, `${task}: the gap has to travel with the verdict`);
    // And so does the FACT, as data: the run's artifact then names the fact and the producer that does not publish it
    // rather than only describing the absence in a sentence.
    assert.deepEqual(judged.unpublishedFact, entry.unpublishedFact, `${task}: the verdict must carry the named fact`);
  }
});

test("an unregistered task is unproven and names itself", () => {
  const judged = judgeTaskPurpose("not_a_rotation_task", [BROKE_ROCK]);
  assert.equal(judged.state, "unproven");
  assert.match(judged.missingFact ?? "", /not_a_rotation_task/);
});

/**
 * The shape criterion, and the four outcomes it must never confuse.
 *
 * red-proof: inject  `judgePatch` returning `achieved` whenever any tile was proved (drop the window count) ->
 *                    `37 of the sixty tiles is a patch that is not finished` and
 *                    `sixty tiles in another shape are named as another shape` both go red, because 37 tiles and a
 *                    10x6 block would be reported as a finished 3x20 strip;
 *                    and returning `not_achieved` for a set with no coordinates at all ->
 *                    `a patch day whose receipts carry no tile is our gap, not her failure`
 *                    (tools/lib/task-purpose.test.mjs)
 */
test("a declared patch is longer than the window one snapshot sees", () => {
  // THE PREMISE OF THE TASK, not a size preference: target discovery is Chebyshev radius 6, so one snapshot is a
  // 13x13 window. A declared patch that fits inside it would be provable from a single observation, so the day would
  // measure nothing an errand of one tile does not already measure. The radius is read from the Mod itself, so a
  // change there either keeps the premise true or fails here.
  const constants = modConstants([
    {
      file: "integrations/stardew/farmhandexecutioncontroller.cs",
      text: readFileSync(new URL("../../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url), "utf8"),
    },
  ]);
  const radius = constants.get("TargetDiscoveryRadius");
  assert.ok(
    Number.isInteger(radius),
    "the Mod's discovery radius is not readable, so the premise a long patch rests on cannot be checked",
  );
  const window = radius * 2 + 1;
  const declared = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.patch !== undefined);
  assert.ok(declared.length > 0, "no task declares a shape, so nothing asks for a plot longer than one view");
  for (const [task, entry] of declared)
    assert.ok(
      Math.max(entry.patch.width, entry.patch.height) > window,
      `${task}: a ${String(entry.patch.width)}x${String(entry.patch.height)} patch fits inside the ${String(window)}x${String(window)} window one snapshot sees, so a single observation already answers it`,
    );
});

test("a long strip proved tile by tile is the declared patch", () => {
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(3, 20)));
  assert.equal(judged.state, "achieved");
  assert.equal(judged.patchWindow?.count, 60, "all sixty tiles of the strip must be proved, tile by tile");
  assert.equal(judged.location, "Farm");
});

test("the same strip laid the other way is the same work", () => {
  // The player asked for a strip three wide and twenty long. A companion that laid it twenty wide and three deep did
  // the same clearing, tilling and sowing, and a criterion that failed it would be grading the drawing.
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(20, 3)));
  assert.equal(judged.state, "achieved");
});

test("37 of the sixty tiles is a patch that is not finished, and the count says so", () => {
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(3, 20).slice(0, 37)));
  assert.equal(judged.state, "not_achieved");
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");
  assert.equal(judged.patchTiles, 37, "the verdict names how many of the sixty it got");
  assert.match(judged.detail ?? "", /37\/60 tiles tilled and sown/u);
});

test("sixty tiles in another shape are named as another shape, not as a short patch", () => {
  // Both are sixty tiles and neither is the patch - but "planted 37 of a 60-tile strip" and "planted sixty tiles that
  // are not a strip" are different defects, and one sentence for both is how the second goes unnoticed.
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(10, 6)));
  assert.equal(judged.state, "not_achieved");
  assert.equal(judged.reasonCode, "tiles_do_not_form_the_declared_patch");
  assert.deepEqual(judged.largestRectangle, { x: 12, y: 4, width: 10, height: 6, area: 60 });
  assert.match(judged.detail ?? "", /largest rectangle found is 10x6 \(60 tiles\), not the declared 3x20/u);
  const short = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(3, 20).slice(0, 37)));
  assert.notEqual(
    short.reasonCode,
    judged.reasonCode,
    "a strip that is not finished and a patch of the wrong shape must not read the same",
  );
});

test("a patch day whose receipts carry no tile is our gap, not her failure", () => {
  // `cut_weeds` is a real completion with a real postcondition and no coordinate at all: a day of clearing proves work
  // and proves nothing about where it happened. Answering `not_achieved` there would report a plot that was never
  // tilled as a plot she failed, and the coordinate is what this run did not record.
  for (const receipts of [[], [CUT_WEEDS]]) {
    const judged = judgeTaskPurpose("clear_and_plant_long_patch", receipts);
    assert.equal(judged.state, "unproven");
    assert.equal(judged.reasonCode, "task_purpose_has_no_tile_coordinates");
    assert.match(judged.missingFact ?? "", /no receipt of this run carried a tile/u);
  }
});

/**
 * `round87b`'s day 1, tile for tile: THIRTY `soil_already_tilled` receipts over these FIFTEEN tiles.
 *
 * The run dispatched each tile twice - the log holds `62,18 x2` through `79,18 x2`, all on `y=18` between x 62 and 79 -
 * so the receipt count and the tile count are different numbers and the criterion reports the TILES. Quoted rather than
 * read at test time: the run's log is a 7 MB artifact outside the tree, and a gate that cannot run without it is a gate
 * nobody runs.
 */
const ROUND87B_SETTLED_TILES = Object.freeze([
  [62, 18],
  [63, 18],
  [64, 18],
  [65, 18],
  [66, 18],
  [67, 18],
  [68, 18],
  [70, 18],
  [72, 18],
  [73, 18],
  [74, 18],
  [75, 18],
  [76, 18],
  [77, 18],
  [79, 18],
]);

/**
 * `a_settled_tile_counts_as_tilled_only_with_the_map_it_is_on:clear_and_plant_long_patch`.
 *
 * <p>
 * THE DEFECT. Measured 2026-11-21 (`round87b`, day 1): the day's verdict was
 * `0/36 tiles tilled and sown (sown 27, tilled 0)` for a day whose Mod answered THIRTY `soil_already_tilled`
 * settlements, every one `state: succeeded` and every one admitted by the Host. The receipt named
 * `target=62,18;before=HoeDirt;settled_by=engine_flag:hoedirt=present` - the state the request asked for, and no map -
 * and `patchTileFacts` requires a `location` for EVERY tile family (a tile coordinate without a map is not a tile:
 * `62,18` exists on the Farm and on the Mountain). So the producer was the odd one out, not the criterion: the swing's
 * own receipt carries `location`, and this was the one `till_soil` shape that did not.
 * </p>
 * <p>
 * THE FALSIFIER is the day itself: the same fifteen tiles, dispatched twice each in the wire text this defect was
 * measured in, must read `tilled 0` again - and the reason is named, because the row now REFUSES a settlement that
 * does not say where the tile is rather than letting a locationless coordinate be counted on a guessed map.
 * </p>
 * <p>
 * The day was the `2x18` market bed this table has since cut, so the fixture is judged against the one patch criterion
 * that remains: the tile facts it exercises (`patchTileFacts`, `refusedTileProofs`) are the same reader either way, and
 * the counts asserted are the fifteen tiles the run settled, not the declared area.
 * </p>
 */
test("a settled tile counts as tilled only with the map it is on", () => {
  const day = ROUND87B_SETTLED_TILES.flatMap(([x, y]) => [TILLED_ALREADY(x, y), TILLED_ALREADY(x, y), PLANTED(x, y)]);
  assert.deepEqual(
    day.filter((entry) => entry.reasonCode === "soil_already_tilled"),
    ROUND87B_SETTLED_TILES.flatMap(([x, y]) => [TILLED_ALREADY(x, y), TILLED_ALREADY(x, y)]),
    "`round87b` dispatched each of these fifteen tiles twice, so the fixture is the run only if its tilled receipts are exactly the doubled tiles",
  );

  const judged = judgeTaskPurpose("clear_and_plant_long_patch", day);
  assert.deepEqual(
    judged.refusedReceipts,
    [],
    "the settled tile is a success the Host reads, so nothing here is refused",
  );
  assert.equal(
    judged.patchTilledTiles,
    ROUND87B_SETTLED_TILES.length,
    "a settlement that names its tile is that tile tilled; the count reports TILES, so the two dispatches of one tile " +
      "are one tilled tile and not two",
  );
  assert.equal(judged.patchSownTiles, ROUND87B_SETTLED_TILES.length);
  assert.equal(
    judged.patchTiles,
    ROUND87B_SETTLED_TILES.length,
    "a settled tile that was sown is both halves of the patch",
  );

  // THE FALSIFIER, on the exact wire text `round87b` published. Reverting either half - the producer's `location` or the
  // contract's requirement for it - must take this count back to the `tilled 0` the day actually reported.
  const withoutMap = ROUND87B_SETTLED_TILES.flatMap(([x, y]) => [
    TILLED_ALREADY_WITHOUT_MAP(x, y),
    TILLED_ALREADY_WITHOUT_MAP(x, y),
    PLANTED(x, y),
  ]);
  assert.equal(
    purposeReceipts(withoutMap).refused.length,
    30,
    "a settlement that names the tile and not the map it is on is not the settled tile, so the Host refuses it whole",
  );
  const blind = judgeTaskPurpose("clear_and_plant_long_patch", withoutMap);
  assert.equal(blind.patchTilledTiles, 0, "which is `round87b`'s own reading: `tilled 0` for a day that tilled");
  assert.equal(
    blind.state,
    "unproven",
    "and the day cannot be called finished either: the tiles that would decide it are in hand",
  );
});

/**
 * `a_task_that_asks_for_n_tiles_reports_how_many_it_got:<task>`
 *
 * THE DEFECT. Measured 2026-11-20 (`round81`, `clear_and_plant_long_patch`, "three tiles wide, twenty long"): the
 * day's verdict was `unproven/task_purpose_evidence_without_postcondition` and carried no number at all. Thirty-one
 * `till_soil` receipts had been refused (the ground was already tilled, so the Mod answered `soil_already_tilled`), and
 * the judge returned before it placed anything on a map - so a reader could not tell "she planted two" from "she
 * planted fifty-nine" from "she planted none". That run had planted two, and both plantings' own receipts said so
 * (`inventory_before=2` then `1`): `sown 2 (seeds available 2)`.
 *
 * THE GATE. Its population is every criterion that counts tiles, read from `TASK_PURPOSE_CRITERIA`'s own `patch`
 * declarations - never a list here, so a task that starts counting tiles tomorrow is covered by existing. For each
 * one it judges the readings a real day produces - every tile, one short, round81's two sowings, none - and asserts
 * that the verdict names the count it reached. A verdict that reports a state without a number fails here, naming
 * the criterion, the count it declared and the count it reported.
 *
 * AND THE LIMITING FACTOR, because the number alone is the same defect one layer down: "sown 2 and the pack was
 * empty" and "sown 2 of 60 and 58 tile proofs were refused" are different days that both read `2/60`.
 *
 * red-proof: inject  dropping the count block from `judgePatch`'s refused branch -> round81's reading reports
 *                   `whose verdict names the count undefined` and this gate is red naming
 *                   `clear_and_plant_long_patch · that name a count 60`
 *                   (tools/lib/task-purpose.test.mjs)
 */

/** `round81`'s two `seed_planted` receipts, verbatim: two cauliflower seeds, and the pack empty after the second. */
const ROUND81_SOWINGS = Object.freeze([
  receipt("plant_seed", {
    reasonCode: "seed_planted",
    evidence: {
      detail: contractEvidence("plant_seed", {
        location: "Farm",
        target: "seed_b158f2cf25582a64",
        tile: "63,19",
        item: "(O)474",
        crop: "474",
        inventory_before: "2",
        inventory_after: "1",
      }),
    },
  }),
  receipt("plant_seed", {
    reasonCode: "seed_planted",
    evidence: {
      detail: contractEvidence("plant_seed", {
        location: "Farm",
        target: "seed_2d9cdc97acabfff4",
        tile: "62,18",
        item: "(O)474",
        crop: "474",
        inventory_before: "1",
        inventory_after: "0",
      }),
    },
  }),
]);

/** The thirty-one `till_soil` receipts that run could not read: succeeded, and not their own postcondition. */
const ROUND81_REFUSED_TILLS = Object.freeze(
  Array.from({ length: 31 }, () =>
    receipt("till_soil", { reasonCode: "soil_tilled", evidence: { detail: "target=62,18" } }),
  ),
);

test("a_task_that_asks_for_n_tiles_reports_how_many_it_got", (t) => {
  const patchCriteria = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.patch !== undefined);
  // The fixture for round81 is only that run if its thirty-one tillings ARE refused: a fixture quietly admitted
  // would test the `not_achieved` branch instead of the one the defect lived in.
  assert.equal(
    purposeReceipts([...ROUND81_SOWINGS, ...ROUND81_REFUSED_TILLS]).refused.length,
    ROUND81_REFUSED_TILLS.length,
    "round81's thirty-one tillings must be refused here too, and its two sowings admitted",
  );
  const violations = [];
  let examined = 0;
  for (const [task, entry] of patchCriteria) {
    const declared = entry.patch.width * entry.patch.height;
    const strip = rectangle(entry.patch.width, entry.patch.height);
    const readings = [
      { label: "every tile proved", receipts: patchReceipts(strip), qualified: declared, sown: declared },
      { label: "one tile short", receipts: patchReceipts(strip.slice(0, declared - 1)), qualified: declared - 1 },
      // A patch of two tiles or fewer cannot be short by two, so there is no round81 reading to take for it.
      ...(declared > 2
        ? [
            {
              label: "round81's two sowings",
              receipts: [...ROUND81_SOWINGS, ...ROUND81_REFUSED_TILLS],
              qualified: 0,
              sown: 2,
            },
          ]
        : []),
      { label: "nothing proved", receipts: [], qualified: 0 },
    ];
    for (const reading of readings) {
      examined += 1;
      const judged = judgeTaskPurpose(task, reading.receipts);
      const code =
        `a_task_that_asks_for_n_tiles_reports_how_many_it_got:${task}: criteria 1 · that name a count ` +
        `${String(declared)} · whose verdict names the count ${String(judged.patchTiles)} (${reading.label})`;
      t.diagnostic(code);
      if (!Number.isInteger(judged.patchTiles)) {
        violations.push(
          `${code} - the verdict reports ${String(judged.state)}/${String(judged.reasonCode)} and no count at all, ` +
            `so two tiles and fifty-nine read the same`,
        );
        continue;
      }
      const fraction = `${String(judged.patchTiles)}/${String(declared)}`;
      if (!String(judged.detail ?? "").includes(fraction))
        violations.push(
          `${code} - its detail never states ${fraction}: ${JSON.stringify(String(judged.detail ?? ""))}`,
        );
      if (reading.qualified < declared && judged.state === "achieved")
        violations.push(`${code} - a patch short of its own count was reported achieved`);
      if (!Array.isArray(judged.limitingFactors))
        violations.push(`${code} - nothing in the verdict says whether seed, refusals or the day itself stopped it`);
      // The falsifier: round81's own two sowings, and the limiting factor that told this day apart from a day that
      // refused fifty-eight of sixty.
      if (reading.sown !== undefined && judged.patchSownTiles !== reading.sown)
        violations.push(
          `${code} - it sowed ${String(reading.sown)} and the verdict reports ${String(judged.patchSownTiles)} sown`,
        );
      if (reading.label === "round81's two sowings") {
        for (const fragment of [
          "sown 2",
          "seed_ledger:(O)474:2->0",
          `tile_proof_refused:${String(ROUND81_REFUSED_TILLS.length)}`,
        ])
          if (!String(judged.detail ?? "").includes(fragment))
            violations.push(`${code} - its detail never states "${fragment}": ${String(judged.detail ?? "")}`);
        if (!judged.limitingFactors.includes("seed_ledger:(O)474:2->0"))
          violations.push(`${code} - the seeds it spent are not among its limits: ${String(judged.limitingFactors)}`);
      }
    }
  }
  const summary = `criteria ${String(patchCriteria.length)} · readings ${String(examined)}`;
  t.diagnostic(summary);
  // Zero is not green: a gate over a population of no tile-counting criterion agrees with itself.
  assert.ok(
    patchCriteria.length > 0 && examined > 0,
    `blocked: ${summary} - no criterion in TASK_PURPOSE_CRITERIA counts tiles, so nothing here was examined`,
  );
  assert.deepEqual(violations, [], `${summary}\n${violations.join("\n")}`);
});

test("what the run saw counts beside what it proved, and only as each row describes itself", () => {
  const strip = rectangle(3, 20);
  // The receipts prove the tilling; the crops were observed rather than dispatched. The union is the plot, so this is
  // the same strip - and it is the only way the observation half can contribute at all, because `cropTargets` is a
  // radius-6 list that cannot hold twenty tiles in a row by itself. The receipts are the memory.
  const union = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => TILLED(x, y)),
    { location: "Farm", cropTargets: strip.map(([x, y]) => ({ x, y, cropId: "24" })) },
  );
  assert.equal(union.state, "achieved");
  // `soilTiles` is the Mod's `till_soil` TARGET list: `DiscoverSoilTiles` skips every tile that already has HoeDirt, so
  // a row without the flag describes ground that is NOT tilled. Counting it as tilled would report untilled ground as
  // a finished plot - the one thing a tile-counting criterion must never do.
  const untilled = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => PLANTED(x, y)),
    { location: "Farm", soilTiles: strip.map(([x, y]) => ({ x, y, hoeDirt: false })) },
  );
  assert.equal(untilled.state, "not_achieved");
  assert.match(untilled.detail ?? "", /0\/60/u);
  // A row that DOES say hoeDirt is tilled ground, and it counts.
  const tilled = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => PLANTED(x, y)),
    { location: "Farm", soilTiles: strip.map(([x, y]) => ({ x, y, hoeDirt: true })) },
  );
  assert.equal(tilled.state, "achieved");
});

test("two maps' tiles never add up to one strip", () => {
  // Stardew's coordinates restart at (0, 0) in every location, so half a strip on the farm and half in the greenhouse
  // name the same coordinates as the whole strip. An ungrouped union would report a plot that exists on no map.
  const strip = rectangle(3, 20);
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", [
    ...patchReceipts(strip.slice(0, 30)),
    ...strip.slice(30).flatMap(([x, y]) => [TILLED(x, y, "Greenhouse"), PLANTED(x, y, "Greenhouse")]),
  ]);
  assert.notEqual(judged.state, "achieved", "thirty tiles on one map and thirty on another is not a strip");
});

test("a strip is the strip whether it is one tile short or one tile over", () => {
  const strip = rectangle(3, 20);
  // One tile short: the count says so rather than rounding up into the shape it nearly is.
  const short = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(strip.slice(0, 59)));
  assert.equal(short.state, "not_achieved");
  assert.match(short.detail ?? "", /59\/60/u);
  // One tile beyond the strip: the strip itself is there tile for tile, so this is not a failure. The criterion asks
  // whether a full 3x20 is among the tiles proved, and it is.
  const over = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts([...strip, [40, 40]]));
  assert.equal(over.state, "achieved");
});

/**
 * ROUND38'S OWN DAY, RE-JUDGED. Measured 2026-11-06 on `_multiday_routine-round38.result.json`, day 1.
 *
 * The day declared `clear_and_plant_long_patch`. It tilled twenty tiles scattered over a 9x8 box (x 61..69, y 18..25),
 * planted thirteen across eighteen columns (x 62..79, y 16..20), and the criterion answered
 * `unproven / task_purpose_evidence_without_postcondition` - because nine OTHER receipts were refused:
 * `move_to_tile`, `shop_purchase`, `harvest_crop`, `dismiss_modal`. Not one of those actions publishes a coordinate
 * this criterion reads, and yet their refusal replaced the answer with "the run cannot tell", so the artifact could
 * say neither "achieved" nor "3/60". A patch criterion that cannot answer a patch day is the whole finding.
 *
 * The tiles and the evidence strings below are the run's own, taken from its `bridgeFacts`.
 */
const ROUND38_TILLED = Object.freeze([
  [61, 18],
  [62, 19],
  [62, 21],
  [63, 20],
  [64, 20],
  [64, 21],
  [64, 22],
  [64, 23],
  [64, 24],
  [65, 22],
  [65, 23],
  [65, 24],
  [65, 25],
  [66, 21],
  [66, 22],
  [66, 23],
  [66, 24],
  [67, 19],
  [68, 20],
  [69, 18],
]);
const ROUND38_PLANTED = Object.freeze([
  [62, 20],
  [63, 20],
  [64, 20],
  [75, 18],
  [75, 19],
  [75, 20],
  [76, 18],
  [77, 18],
  [79, 18],
  [69, 18],
  [70, 18],
  [71, 16],
  [71, 17],
]);
/** The run's own refused receipts, in the fact log's shape: succeeded, and not their own postcondition. */
const ROUND38_REFUSED = Object.freeze([
  Object.freeze({
    actionId: "harvest_crop",
    state: "succeeded",
    reasonCode: "crop_harvested",
    evidence: {
      detail:
        "location=Farm;target=crop_5481d34df6f60c18;tile=58,14;crop=474;item=(O)190;native_path_return=true;native_accepted=true;regrows=false;phase_before=5;phase_after=none;day_of_phase_before=0;day_of_phase_after=none;regrow_advanced=false;inventory_before=0;inventory_after=1;inventory_gained=true;crop_present_after=false;harvest_quality=0;quality_counts_before=;quality_counts_after=0:1",
    },
  }),
]);

test("round38's patch day is 3/60 of the declared strip, not `unproven`", () => {
  const receipts = [
    ...ROUND38_TILLED.map(([x, y]) => TILLED(x, y)),
    ...ROUND38_PLANTED.map(([x, y]) => PLANTED(x, y)),
    ...ROUND38_REFUSED,
  ];
  // The fixture is only the measured run if that receipt IS refused: a fixture that was quietly admitted would test
  // nothing about the branch this guards.
  assert.equal(purposeReceipts(receipts).refused.length, 1, "the run's refused receipt must be refused here too");
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", receipts);
  assert.equal(
    judged.state,
    "not_achieved",
    "twenty tiles tilled in a 9x8 box and thirteen planted across eighteen columns is not a 3x20 strip, and the criterion has to be able to say so",
  );
  // THE BRANCH MOVED, AND THE COUNT WITH IT. The day's thirteen sowings ARE ground the day held - `plant_seed` only
  // succeeds on tilled soil, so the ten tiles she sowed into without turning them herself are tilled ground too - so the
  // plot it left is thirteen tiles, and thirteen tiles spread over eighteen columns fit inside no 3x20 window. The old
  // reading stopped at the three tiles she both tilled and sowed THAT day and called them "inside the best 20x3 window",
  // which is the same verb-counting defect `round96`'s day 3 exposed: the strip was judged by her swings.
  assert.equal(judged.reasonCode, "tiles_do_not_form_the_declared_patch");
  assert.equal(judged.missingFact, null, "nothing is missing: the tiles are all in the receipts");
  assert.equal(judged.patchTiles, 13, "thirteen tiles carry a crop on ground the day held");
  assert.equal(judged.patchSownTiles, 13);
  assert.equal(
    judged.patchTilledTiles,
    20,
    "twenty tiles the Hoe named, and no more: the ten she sowed into were never counted as swings she made",
  );
  assert.match(
    judged.detail ?? "",
    /^13\/60 tiles tilled and sown \(sown 13, tilled 20\)/u,
    `the count and its components, in the day's own numbers; got ${String(judged.detail)}`,
  );
});

test("a refused receipt of an action that proves a TILE still leaves the patch unproven", () => {
  // The exemption above is scoped to the actions that publish no coordinate. The moment the refused receipt is one the
  // criterion reads, the run genuinely cannot tell, and answering a fraction from the remaining receipts would report
  // a plot the evidence did not describe.
  const receipts = [
    ...ROUND38_TILLED.map(([x, y]) => TILLED(x, y)),
    Object.freeze({
      actionId: "plant_seed",
      state: "succeeded",
      reasonCode: "seed_planted",
      evidence: { detail: "target=soil_02" },
    }),
  ];
  assert.equal(purposeReceipts(receipts).refused.length, 1, "the malformed planting must be refused");
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", receipts);
  assert.equal(judged.state, "unproven");
  assert.equal(judged.reasonCode, "task_purpose_evidence_without_postcondition");
});

/**
 * ROUND77'S THREE DAYS, AND THE TWO WAYS THE JUDGE SAID "I CANNOT TELL" WHEN IT COULD.
 *
 * Measured 2026-11-19 on `tools/_multiday_routine-round77.result.json` and re-read from the same run's
 * `timeline.jsonl` (`.live-runs/game-ladder/2026-11-19T04-46-54-502Z-multiday_routine/`, whose `index` is the fact log's
 * index). The run did 500 real actions over three days and two nights with `violations []` - the gameplay was healthy -
 * and all three days came back `unproven`:
 *
 *   day 1 `home_upgrade`          `task_purpose_needs_an_unpublished_fact`        admitted 11, refused 7
 *   day 2 `mine_ladder_to_depth`  `task_purpose_evidence_without_postcondition`   admitted 13, refused 8
 *   day 3 `furnish_and_arrange`   `task_purpose_needs_an_unpublished_fact`        admitted 15, refused 3
 *
 * The day windows are the slices the runner took (`factsBefore` at each day's start): [0,264), [275,469), [469,612). The
 * receipts between 264 and 275 arrived during the FIRST night, after day 1's verdict had been taken, which is why day 1
 * ends at the level-up menus and not at day 2's `day_started`.
 *
 * Days 1 and 3 want a fact no producer writes. They now SAY which fact and who would have to publish it - the entry's
 * `unpublishedFact`, printed by `a_criterion_asks_for_a_fact_the_product_does_not_publish` and carried by the verdict.
 * Day 2 is a different defect, and this is its test: its eight refused receipts are `move_to_tile`'s adjacency arrival
 * (seven of them) and one `dismiss_modal` that said `modal=none`, and `mine_ladder_to_depth` reads NEITHER action - so
 * the run was complete evidence that no mine was entered, and the judge answered "cannot tell" instead.
 *
 * red-proof: inject  `if (refused.length > 0)` in place of the scoped test in `judgeTaskPurpose` -> the first test below
 *                   reads `unproven` for a day that never went underground
 *                   (tools/lib/task-purpose.test.mjs)
 */

/** The Mod's `target_reached` in its ADJACENT shape: a substituted approach, not the requested tile. */
const ROUND77_MOVE_ARRIVED_ADJACENT = receipt("move_to_tile", {
  reasonCode: "target_reached",
  evidence: { detail: "reached=adjacent;requested=3,12;actor=3,11;within_range_of_request=true" },
});
/** A `dismiss_modal` that found nothing to dismiss: a success whose postcondition is that NO modal left. */
const ROUND77_NOTHING_TO_DISMISS = receipt("dismiss_modal", {
  reasonCode: "nothing_to_dismiss",
  evidence: { detail: "modal=none" },
});

test("round77 day 2: a refusal of an action the criterion does not read is not `the run cannot tell`", () => {
  const receipts = [ROUND77_MOVE_ARRIVED_ADJACENT, ROUND77_NOTHING_TO_DISMISS];
  // The premise, read from the criterion rather than asserted about round77: neither refused action is one of its steps.
  const steps = new Set(
    TASK_PURPOSE_CRITERIA.mine_ladder_to_depth.steps.flatMap((candidate) =>
      candidate.actionId === undefined ? [...candidate.anyOf] : [candidate.actionId],
    ),
  );
  for (const refused of receipts)
    assert.ok(
      !steps.has(refused.actionId),
      `${refused.actionId} IS a step of mine_ladder_to_depth, so this fixture no longer describes round77's day 2`,
    );
  // `dismiss_modal` is refused by the Host and is right to be: `modal=none` is nothing dismissed. **The `move_to_tile` fixture is no
  // longer a refusal** - `6b1a6f9f` made an adjacent arrival a real arrival (`arrival=warp_adjacent;reached=adjacent`), because the
  // action's own declaration says the honest walk is the tile beside the subject and `approach_out_of_reach` is what refuses an
  // out-of-radius substitution. So one of round77's two shapes became a success, and this test now says so rather than pinning the
  // old verdict: the property it protects - a refusal of an action the criterion does not read is not `the run cannot tell` - is
  // carried by `dismiss_modal` alone.
  assert.deepEqual(
    purposeReceipts(receipts)
      .refused.map((entry) => entry.actionId)
      .sort(),
    ["dismiss_modal"],
  );
  assert.deepEqual(
    purposeReceipts([ROUND77_MOVE_ARRIVED_ADJACENT]).refused.map((entry) => entry.actionId),
    [],
    "an adjacent arrival is an arrival since 6b1a6f9f - if this reds, the contract narrowed and round77's fixture is a refusal again",
  );
  const judged = judgeTaskPurpose("mine_ladder_to_depth", receipts);
  assert.equal(
    judged.state,
    "not_achieved",
    "the day dispatched neither enter_mine nor use_mine_ladder, so the receipts are complete evidence that no level was worked - `unproven` told the player the opposite",
  );
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");
});

test("round77 day 2: a refusal of an action the criterion DOES read still leaves the purpose unreadable", () => {
  // The boundary of the exemption. `enter_mine` came back succeeded and carried no postcondition of its own, so the run
  // cannot say whether a mine was entered - and it must not say the purpose did not hold either.
  const judged = judgeTaskPurpose("mine_ladder_to_depth", [
    Object.freeze({ ...ENTERED_MINE, evidence: null }),
    ROUND77_MOVE_ARRIVED_ADJACENT,
  ]);
  assert.equal(judged.state, "unproven");
  assert.equal(judged.reasonCode, "task_purpose_evidence_without_postcondition");
});

/**
 * THE FISHING WAYPOINT: the purpose is being at water and fishing, never the seam that carried her there.
 *
 * Measured 2026-11-21 (`round88`, day 1, `a_fish_from_the_water`): three smallmouth bass came back - three `fish_here`
 * receipts, `fish_caught`, `location=Forest`, `tile=46,25` - and the day was reported `not_achieved`, because the
 * waypoint half named `navigate_to_destination` and `travel` and that day's two navigations were both abandoned on a
 * large bush (`Bush@49,10`). She walked there herself: `move_to_tile` to `40,64`, then `enter_exit` into
 * `Forest:68,0`. The row graded the route instead of the day.
 *
 * The population is the Mod's own handler group (`handlerGroup: "movement"` in `action-handler-groups.v1.json`), read
 * here from that artifact rather than from the criterion, so a movement action the Mod adds tomorrow is covered by
 * existing and one it retires fails naming itself. Two members' receipts name no arrival and are declared with that
 * reason in `MOVEMENT_ACTIONS_WITHOUT_ARRIVAL`; the staleness assertion below makes that exemption expire.
 *
 * red-proof: inject  `[anyOf("navigate_to_destination", "travel"), step("fish_here")]` back into
 *                   `a_fish_from_the_water` and this gate and `round88 day 1` both red - the measured defect;
 *                   exempt an action the surface does not group as movement and the staleness assertion reds naming it
 *                   (tools/lib/task-purpose.test.mjs). What this gate does NOT read is whether an exempted receipt names
 *                   an arrival at all - `MOVEMENT_ACTIONS_WITHOUT_ARRIVAL` says why no key-name rule can.
 */
const HANDLER_GROUPS_ARTIFACT = new URL(
  "../../integrations/stardew/action-development/contracts/generated/action-handler-groups.v1.json",
  import.meta.url,
);

/** The Mod's movement population, read from the artifact the Mod generates. */
function surfaceMovementActions() {
  const artifact = JSON.parse(readFileSync(HANDLER_GROUPS_ARTIFACT, "utf8"));
  return (artifact.actions ?? [])
    .filter((row) => row.handlerGroup === "movement")
    .map((row) => row.actionId)
    .sort();
}

test("the_fish_waypoint_is_the_movements_the_surface_declares", (t) => {
  const declared = surfaceMovementActions();
  const exempted = Object.keys(MOVEMENT_ACTIONS_WITHOUT_ARRIVAL);
  const criterion = TASK_PURPOSE_CRITERIA.a_fish_from_the_water;
  const waypoint =
    criterion.steps[0].actionId === undefined ? [...criterion.steps[0].anyOf] : [criterion.steps[0].actionId];
  const expected = declared.filter((actionId) => !exempted.includes(actionId));
  t.diagnostic(
    `movement group: ${String(declared.length)} in ${HANDLER_GROUPS_ARTIFACT.pathname.split("/").pop()} · waypoint reads ` +
      `${String(expected.length)} · exempt ${exempted.join(", ")} · ${declared.join(" ")}`,
  );
  assert.deepEqual(
    [...waypoint].sort(),
    [...expected].sort(),
    "the waypoint half no longer reads the movements the Mod declares, so a fishing day is judged by its route again",
  );
  assert.deepEqual(criterion.steps[1], { actionId: "fish_here" }, "the catch is the other half, and it is one receipt");
  assert.deepEqual(
    exempted.filter((actionId) => !declared.includes(actionId)),
    [],
    `MOVEMENT_ACTIONS_WITHOUT_ARRIVAL exempts an action the surface no longer groups as movement: ${exempted.join(", ")}`,
  );
  for (const [actionId, reason] of Object.entries(MOVEMENT_ACTIONS_WITHOUT_ARRIVAL))
    assert.ok(
      typeof reason === "string" && reason.trim().length > 20,
      `${actionId} is kept out of the waypoint half with no reason a reader can check`,
    );
});

/** `round88`'s two `navigate_to_destination` dispatches, verbatim: one rejected on reachability, one uncertain. */
const ROUND88_ABANDONED_NAVIGATIONS = Object.freeze([
  Object.freeze({
    actionId: "navigate_to_destination",
    state: "rejected",
    reasonCode: "no_native_path",
    evidence: {
      detail:
        "from=37,48;to=40,0;location=Farm;native=not_attempted;probe=cardinal_flood;route_exists_cardinal=false;target_enclosed=true;component_tiles=1862;gate=reachability_flood;approaches=north:off_map,east:unreachable,south:unreachable,west:buildings_tile:blocked@39,0;target_standable=true;target_walkable=true;blocked_by=none;progress=none;clear_to_reach=weed@40,9;clear_tiles=1;clear_cost=5;clear_step=weed@40,9;stand_at=40,10;remaining_clears=1;blocker_occupant=weed@40,9;clears_with=cut_weeds(stamina:0,tool:scythe,turns:1);blocker_target=unpublished:weedTargets;next_steps=move_to_tile@40,10>publishes:weedTargets>cut_weeds@40,9>move_to_tile@40,0;reachable=34,6;detour_steps=none;walk_limit_steps=75",
    },
  }),
  Object.freeze({
    actionId: "navigate_to_destination",
    state: "uncertain",
    reasonCode: "navigation_approach_unavailable",
    evidence: {
      detail:
        "phase=multi_hop;approach=unavailable;never_retry=true;approaches=north:off_map,east:off_map,south:off_map,west:large:Bush@49,10;approach_blocked_by=large:Bush@49,10;entry=49,10;entry_blocked_by=large:Bush@49,10;next_step=clear_the_approach_or_choose_another_target;steps=1;folded=accepted@navigation=accepted,phase=approaching",
    },
  }),
]);

/** The walk she made instead: `move_to_tile` to the Farm's `40,64`, then `enter_exit` into the Forest at `68,0`. */
const ROUND88_WALK = Object.freeze([
  Object.freeze({
    actionId: "move_to_tile",
    state: "succeeded",
    reasonCode: "target_reached",
    evidence: {
      detail:
        "tile=40,64;target=40,64;arrival=exact;path=stardew_native;steps=1;folded=accepted@route_revision=41,target=40,64,requested=41,65,approach=substituted",
    },
  }),
  Object.freeze({
    actionId: "enter_exit",
    state: "succeeded",
    reasonCode: "enter_exit_completed",
    evidence: {
      detail:
        "expected=Forest:68,0;actual=Forest:68,0;steps=1;folded=accepted@source=Farm:41,65,target=Forest:68,0,entry=none",
    },
  }),
]);

/** `round88`'s three catches, verbatim: the same water, the same fish, and a `fishCaught` count that rises each time. */
const ROUND88_CATCHES = Object.freeze([
  Object.freeze({
    actionId: "fish_here",
    state: "succeeded",
    reasonCode: "fish_caught",
    evidence: {
      detail:
        "location=Forest;target=water_360abce006039168;tile=46,25;caught_qualified_item_id=(O)137;display_name=小嘴鲈鱼;fish_size=13;quality=0;pull_outcome=not_verified;pull_unobserved_field=BobberBar.distanceFromCatching;bite_observed=true;cast_to_credit_ms=4108;rod_durability_left=-1;bait_before=0;bait_left=0;bait_consumed=0;stamina_before=270;stamina_after=262;stamina_delta=-8;inventory_before=0;inventory_after=1;fish_caught_before=0;fish_caught_after=1;fish_caught_delta=1;credit=fishCaught:0->1;steps=3;folded=accepted@location=Forest,target=water_360abce006039168,tile=46,25,distance=25,reach=1,approach=adjacent,stand_at=47,26|tool_approach_completed@tile=47,26,target=47,26,arrival=exact,path=stardew_native|accepted@location=Forest,target=water_360abce006039168,tile=46,25,rod=(T)BambooPole,rod_slot=5,stamina_before=270,bait_before=0,phase=waiting_for_bite",
    },
  }),
  Object.freeze({
    actionId: "fish_here",
    state: "succeeded",
    reasonCode: "fish_caught",
    evidence: {
      detail:
        "location=Forest;target=water_360abce006039168;tile=46,25;caught_qualified_item_id=(O)137;display_name=小嘴鲈鱼;fish_size=13;quality=0;pull_outcome=not_verified;pull_unobserved_field=BobberBar.distanceFromCatching;bite_observed=true;cast_to_credit_ms=10938;rod_durability_left=-1;bait_before=0;bait_left=0;bait_consumed=0;stamina_before=262;stamina_after=254;stamina_delta=-8;inventory_before=1;inventory_after=2;fish_caught_before=1;fish_caught_after=2;fish_caught_delta=1;credit=fishCaught:1->2;steps=1;folded=accepted@location=Forest,target=water_360abce006039168,tile=46,25,rod=(T)BambooPole,rod_slot=5,stamina_before=262,bait_before=0,phase=waiting_for_bite",
    },
  }),
  Object.freeze({
    actionId: "fish_here",
    state: "succeeded",
    reasonCode: "fish_caught",
    evidence: {
      detail:
        "location=Forest;target=water_360abce006039168;tile=46,25;caught_qualified_item_id=(O)137;display_name=小嘴鲈鱼;fish_size=13;quality=0;pull_outcome=not_verified;pull_unobserved_field=BobberBar.distanceFromCatching;bite_observed=true;cast_to_credit_ms=4985;rod_durability_left=-1;bait_before=0;bait_left=0;bait_consumed=0;stamina_before=254;stamina_after=246;stamina_delta=-8;inventory_before=2;inventory_after=3;fish_caught_before=2;fish_caught_after=3;fish_caught_delta=1;credit=fishCaught:2->3;steps=1;folded=accepted@location=Forest,target=water_360abce006039168,tile=46,25,rod=(T)BambooPole,rod_slot=5,stamina_before=254,bait_before=0,phase=waiting_for_bite",
    },
  }),
]);

test("round88 day 1: three smallmouth bass after walking to the Forest are a fish from the water", () => {
  // The day in the order the world saw it: the two abandoned navigations, then the walk, then the catches.
  const judged = judgeTaskPurpose("a_fish_from_the_water", [
    ...ROUND88_ABANDONED_NAVIGATIONS,
    ...ROUND88_WALK,
    ...ROUND88_CATCHES,
  ]);
  assert.equal(
    judged.state,
    "achieved",
    "she walked to the Forest, caught three smallmouth bass and came back; the criterion answered the two abandoned " +
      "navigations instead of the day",
  );
  assert.equal(judged.reasonCode, "task_purpose_achieved");
  assert.deepEqual(
    judged.admittedActionIds.filter((actionId) => actionId !== "fish_here"),
    ["enter_exit", "move_to_tile"],
    "the walk's own two receipts are the waypoint half, and the abandoned navigations are not receipts at all",
  );
  assert.deepEqual(judged.refusedReceipts, [], "every receipt of this day carries its own postcondition");
});

test("a_fish_from_the_water: the catch alone is not the walk", () => {
  const judged = judgeTaskPurpose("a_fish_from_the_water", [...ROUND88_CATCHES]);
  assert.equal(judged.state, "not_achieved", "a fish that was never walked to is half the purpose, not the purpose");
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");
});

test("a_fish_from_the_water: a walk after the catch is not the water she fished", () => {
  const judged = judgeTaskPurpose("a_fish_from_the_water", [...ROUND88_CATCHES, ...ROUND88_WALK]);
  assert.equal(
    judged.state,
    "not_achieved",
    "`fish_here` casts where she stands, so the movement has to come first - arriving afterwards is another trip",
  );
});

/**
 * `round89`'s day 2, and the two halves a day after a HARVEST day still owes.
 *
 * <p>
 * MEASURED (`round89`, day 2, `water_and_harvest`, read out of the run's own
 * `.live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine/timeline.jsonl`): she bought
 * fifteen parsnip seeds at the SeedShop (`idx 152`, `requested=15;purchased=15;owned_before=0;owned_after=15;gained=15`,
 * 1060g -> 760g), a `plan_96_1583c2fe5f0be265` body sowed `n01`..`n15` into the plot the cauliflowers had left (pack
 * 15 -> 0), and she watered fifteen tiles (`idx 175`..`189`) - and the day answered `not_achieved`, because the criterion
 * read `[harvest_crop, plant_seed]` and nothing was ripe. She had brought in all three cauliflowers on DAY 1 (`idx 99`
 * ..`101`, then two `ship_item`), to pay for copper, so the harvest half had already happened one day early and the row
 * graded a step that day could not have owed.
 * </p>
 * <p>
 * THE WINDOW IS THE DAY, and that is what makes this a criterion fix rather than a run-window fix: `judgeTaskPurpose` is
 * handed the receipts a day's own dispatches minted (`receiptsSince(factsBefore)` - day 2 is `idx 118`..`214` here, and
 * holds 0 `harvest_crop`), so a harvest from yesterday is not a fact this verdict can see. Reading it from the run would
 * make `decideDayWake` (`objectiveMet: purpose.state === "achieved"`) end the day at her first watering, because the
 * harvest was already banked - a wake defect bought with one criterion.
 * </p>
 * <p>
 * THE 17-FOR-15 APPEARS IN THIS FILE AS A NUMBER, because it is the COMPOSER's count and not the criterion's: `n16` and
 * `n17` of the same body were answered `seed_not_owned_in_pack` (`item=(O)472;named_slot=6`, `state: rejected`), so the
 * excess starts at the sixteenth planting node and the pack it overshot held fifteen. The criterion is indifferent to
 * them by construction - `purposeReceipts` admits only a `succeeded` receipt carrying its own postcondition, so a
 * rejected node is neither a sowing nor a refusal - and a day whose body overshot the pack is still the day.
 * </p>
 * <p>
 * THE THREE HARVESTS BELOW ARE THE RUN'S OWN, verbatim from `idx 99`..`101`: the same tiles, the same opaque targets, and
 * a pack census rising `none` -> `0:1` -> `0:2` -> `0:3`. That census is part of `crop_harvested`'s postcondition, and
 * `quality_counts_before=` EMPTY is the shape that refuses itself (`ROUND38_REFUSED`), so the fixture writes the census
 * the producer actually writes.
 * </p>
 */

const HARVESTED = Object.freeze(
  [
    [
      "location=Farm",
      "target=crop_5481d34df6f60c18",
      "tile=58,14",
      "crop=474",
      "item=(O)190",
      "native_path_return=true",
      "native_accepted=true",
      "regrows=false",
      "phase_before=5",
      "phase_after=none",
      "day_of_phase_before=0",
      "day_of_phase_after=none",
      "regrow_advanced=false",
      "inventory_before=0",
      "inventory_after=1",
      "inventory_gained=true",
      "crop_present_after=false",
      "harvest_quality=0",
      "quality_counts_before=none",
      "quality_counts_after=0:1",
    ],
    [
      "location=Farm",
      "target=crop_a8695598a1975c1e",
      "tile=59,12",
      "crop=474",
      "item=(O)190",
      "native_path_return=true",
      "native_accepted=true",
      "regrows=false",
      "phase_before=5",
      "phase_after=none",
      "day_of_phase_before=0",
      "day_of_phase_after=none",
      "regrow_advanced=false",
      "inventory_before=1",
      "inventory_after=2",
      "inventory_gained=true",
      "crop_present_after=false",
      "harvest_quality=0",
      "quality_counts_before=0:1",
      "quality_counts_after=0:2",
    ],
    [
      "location=Farm",
      "target=crop_2a7e1fd59d0206a0",
      "tile=60,9",
      "crop=474",
      "item=(O)190",
      "native_path_return=true",
      "native_accepted=true",
      "regrows=false",
      "phase_before=5",
      "phase_after=none",
      "day_of_phase_before=0",
      "day_of_phase_after=none",
      "regrow_advanced=false",
      "inventory_before=2",
      "inventory_after=3",
      "inventory_gained=true",
      "crop_present_after=false",
      "harvest_quality=0",
      "quality_counts_before=0:2",
      "quality_counts_after=0:3",
    ],
  ].map((fields) => receipt("harvest_crop", { reasonCode: "crop_harvested", evidence: { detail: fields.join(";") } })),
);

/** The fifteen tiles `plan_96` sowed, in its node order - `n01` first, `n15` last. */
const ROUND89_SOWN_TILES = Object.freeze([
  [64, 18],
  [63, 18],
  [62, 18],
  [62, 20],
  [61, 20],
  [60, 18],
  [65, 18],
  [66, 18],
  [66, 19],
  [65, 19],
  [64, 19],
  [65, 20],
  [66, 20],
  [67, 20],
  [67, 18],
]);

/** The same fifteen tiles in the order she watered them, which is neither the sowing's order nor its reverse. */
const ROUND89_WATERED_TILES = Object.freeze([
  [66, 18],
  [65, 18],
  [64, 18],
  [63, 18],
  [62, 18],
  [60, 18],
  [61, 20],
  [62, 20],
  [64, 19],
  [65, 19],
  [66, 19],
  [67, 18],
  [67, 20],
  [66, 20],
  [65, 20],
]);

const ROUND89_SOWN = Object.freeze(ROUND89_SOWN_TILES.map(([x, y]) => PLANTED(x, y)));
const ROUND89_WATERED = Object.freeze(ROUND89_WATERED_TILES.map(([x, y]) => WATERED(x, y)));

/** `plan_96`'s last two planting nodes, verbatim: past the fifteen seeds the pack held, and REJECTED rather than failed. */
const ROUND89_OVER_THE_PACK = Object.freeze([
  Object.freeze({
    actionId: "plant_seed",
    state: "rejected",
    reasonCode: "seed_not_owned_in_pack",
    evidence: { detail: "item=(O)472;named_slot=6" },
  }),
  Object.freeze({
    actionId: "plant_seed",
    state: "rejected",
    reasonCode: "seed_not_owned_in_pack",
    evidence: { detail: "item=(O)472;named_slot=6" },
  }),
]);

test("round89 day 2: fifteen parsnips sown and watered are the day, and the harvest was yesterday", () => {
  const judged = judgeTaskPurpose("water_and_harvest", [...ROUND89_SOWN, ...ROUND89_OVER_THE_PACK, ...ROUND89_WATERED]);
  assert.equal(
    judged.state,
    "achieved",
    "she bought fifteen seeds, sowed every one into the plot the cauliflowers left and watered every one; a day that " +
      "brings nothing in because nothing was ripe is not a day that failed",
  );
  assert.equal(judged.reasonCode, "task_purpose_achieved");
  assert.deepEqual(
    judged.admittedActionIds,
    ["plant_seed", "water_crop"],
    "the two halves the day owes are the sowing and the watering; the harvest is not one of them",
  );
  assert.deepEqual(
    judged.refusedReceipts,
    [],
    "the two rejected planting nodes are evidence of nothing, so a body that overshot the pack leaves the day readable",
  );
});

test("water_and_harvest: the plot sown and left dry is half the day", () => {
  const judged = judgeTaskPurpose("water_and_harvest", [...ROUND89_SOWN]);
  assert.equal(
    judged.state,
    "not_achieved",
    "the watering is the half the day cannot skip: fifteen seeds in dry soil is not the plot brought back",
  );
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");
});

test("water_and_harvest: a crop brought in and no ground replanted is not the day", () => {
  // Day 1's own receipts: three cauliflowers, admitted, and no ground put back into use. The harvest is what emptied the
  // plot, not a half of this criterion - so a run that only brings in a crop has not replanted anything.
  const judged = judgeTaskPurpose("water_and_harvest", [...HARVESTED]);
  assert.deepEqual(
    judged.admittedActionIds,
    ["harvest_crop"],
    "the harvest receipts are real and admitted; the point is that admitting them decides nothing here",
  );
  assert.equal(
    judged.state,
    "not_achieved",
    "a crop brought in leaves the ground empty, and this day is about the ground being refilled and watered",
  );
});

test("water_and_harvest: a day with no watering and no harvest is not the day", () => {
  // The floor: an idle day's own movements decide nothing, so the row cannot be satisfied by having been present.
  const judged = judgeTaskPurpose("water_and_harvest", [ROUND88_WALK[0]]);
  assert.equal(judged.state, "not_achieved");
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");
});

/**
 * ROUND90'S MINE DAY: four swings that landed and did not finish, plus the exit ladder.
 *
 * `2026-11-22T06-04-54-555Z-multiday_routine`, day 1 `mine_delve`, published its `refusedReceipts` with five rows: four
 * `break_rock` and one `use_mine_ladder`, all `succeeded_receipt_without_its_own_postcondition`. Two different facts
 * were under one label.
 *
 * THE FOUR. `removed=false;durability_after=1` on a rock with `durability_before=2` is the Mod saying the swing landed
 * and the stone is still standing - one `Pickaxe.DoFunction` only subtracts durability and returns early while the
 * remainder is positive. The Host reads that warrant exactly and refuses the completion, which is right: reading it
 * would let "something was broken" be satisfied by a stone nobody broke. What was wrong is the label, and this asserts
 * the reading that replaces it.
 *
 * THE ONE. `expected=Mine:23,8;actual=Mine:23,8;question=ExitMine;response=Leave` is the asynchronous `mine_left` shape
 * the Host's row could not read, so the day's one real completion of the five was refused. It is admitted here, which is
 * the receipt-level half of the same fix.
 *
 * AND THE VERDICT DOES NOT BLOCK EITHER WAY. A swing that landed is not "this run cannot tell": the purpose wanted the
 * stone gone and the stone is still there, which is `not_achieved`.
 */
test("round90 day 1: a swing that landed without finishing is a reading, not an unreadable receipt", () => {
  const damaged = (target, staminaBefore) =>
    receipt("break_rock", {
      reasonCode: "rock_source_damaged",
      evidence: {
        detail: `target=${target};tool=pickaxe;tool_selected=pickaxe;slot=3;tool_before=pickaxe;slot_before=3;qualified_item_id=(O)668;durability_before=2;durability_after=1;removed=false;stamina_before=${staminaBefore};stamina_after=${staminaBefore - 2};stamina_delta=-2;expected_stamina_cost=2;tool_restored=pickaxe`,
      },
    });
  const day = [
    damaged("rock_source_106b777ed23d3048", 270),
    damaged("rock_source_3203471156868548", 266),
    damaged("rock_source_d04d702803fab9d2", 244),
    damaged("rock_source_d4a0eef106584bcd", 216),
    receipt("use_mine_ladder", {
      reasonCode: "mine_left",
      evidence: { detail: "expected=Mine:23,8;actual=Mine:23,8;question=ExitMine;response=Leave" },
    }),
  ];

  const judged = judgeTaskPurpose("mine_delve", day);
  assert.deepEqual(
    judged.refusedReceipts,
    [],
    "a receipt that names what one dispatch did is not a receipt nobody can read: `round90` filed four of these as if " +
      "the contract had failed to parse them",
  );
  assert.deepEqual(
    judged.unfinishedReceipts,
    day.slice(0, 4).map(() => ({
      actionId: "break_rock",
      reasonCode: "succeeded_before_its_postcondition",
      warrant: "rock_source_damaged",
    })),
    "the reading is `succeeded_before_its_postcondition:<actionId>:<warrant>`, one per swing, in the order the swings " +
      "went in",
  );
  assert.deepEqual(
    judged.admittedActionIds,
    ["use_mine_ladder"],
    "the exit ladder is the one completion of the five, and it is admitted",
  );
  assert.equal(
    judged.state,
    "not_achieved",
    "the stone the day wanted broken is still standing, so the purpose has not got there - which is a verdict, not a " +
      "refusal to judge",
  );
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");

  // THE FALSIFIER: take the warrant out of one of them and it is a receipt with no postcondition again, which is the
  // fact the old label was right about.
  const withoutWarrant = [
    ...day.slice(0, 3),
    receipt("break_rock", { reasonCode: "rock_source_damaged", evidence: null }),
    day[4],
  ];
  assert.deepEqual(
    judgeTaskPurpose("mine_delve", withoutWarrant).refusedReceipts,
    [{ actionId: "break_rock", reasonCode: "succeeded_receipt_without_its_own_postcondition" }],
    "a succeeded rock receipt carrying no evidence at all is still a receipt the contract cannot read",
  );
});

/**
 * `round96`'s OWN DAY-3 STRIP, tile for tile, and the two tiles two trees were standing on.
 *
 * <p>
 * Measured 2026-11-23 on `.live-runs/game-ladder/2026-11-23T09-52-51-255Z-multiday_routine` (day 3, facts 255..551,
 * replayed row for row from its `timeline.jsonl`): 58 `soil_tilled`, 58 `seed_planted` and 66 `crop_watered` inside the
 * 20x3 window at `(44,21)`, and exactly two `till_soil` refusals - `(60,22)` and `(62,23)`, both
 * `soil_not_diggable:occupied:tree` with `target=<tile>;diggable_tiles=..;diggable_nearest=..;search_radius=3`. The
 * criterion answered `not_achieved` with `58/60 tiles tilled and sown ... inside the best 20x3 window at 44,21`, and the
 * companion's own words that turn were 「就差两棵树占着的那两格。」
 * </p>
 * <p>
 * THE TILES ARE DERIVED FROM THE WINDOW THE RUN ITSELF PROVED, not quoted as sixty pairs: the artifact is 6 MB outside
 * the tree and a gate that cannot run without it is a gate nobody runs, but the shape of the day must be the run's - a
 * full 20x3 strip minus the two tiles the trees hold. `TREE_REFUSED` carries the wire text the Mod published.
 * </p>
 */
const ROUND96_WINDOW = Object.freeze({ x: 44, y: 21, width: 20, height: 3 });
const ROUND96_TREES = Object.freeze([
  [60, 22],
  [62, 23],
]);

/** One `till_soil` the ground refused because something stands there, in the Mod's own reason code and evidence. */
const TREE_REFUSED = (x, y, kind = "tree") =>
  Object.freeze({
    actionId: "till_soil",
    state: "rejected",
    reasonCode: `soil_not_diggable:occupied:${kind}`,
    evidence: { detail: `target=${String(x)},${String(y)};diggable_tiles=37;diggable_nearest=59,21;search_radius=3` },
  });

/** The window's own sixty tiles, in the order `rectangle` walks a strip. */
const round96Strip = () => {
  const points = [];
  for (let offsetY = 0; offsetY < ROUND96_WINDOW.height; offsetY += 1)
    for (let offsetX = 0; offsetX < ROUND96_WINDOW.width; offsetX += 1)
      points.push([ROUND96_WINDOW.x + offsetX, ROUND96_WINDOW.y + offsetY]);
  return points;
};

/** The run's fifty-eight worked tiles: the window less the two the trees hold. */
const ROUND96_WORKED = Object.freeze(
  round96Strip().filter(([x, y]) => !ROUND96_TREES.some(([treeX, treeY]) => treeX === x && treeY === y)),
);

const ROUND96_DAY = Object.freeze([
  ...patchReceipts(ROUND96_WORKED),
  ...ROUND96_TREES.map(([x, y]) => TREE_REFUSED(x, y)),
]);

/**
 * NAMED `round96`: the strip WAS laid, and the two tiles a tree stands on were never candidates.
 *
 * red-proof: inject  `patchExcludedTiles` returning `[]` (the criterion before this was measured), and this test goes
 *                   red with `not_achieved · 58/60 tiles tilled and sown (sown 58, tilled 58) · inside the best 20x3
 *                   window at 44,21` - which is what the run's own `result.json` published.
 */
test("round96's fifty-eight tiles inside a 20x3 strip are the whole strip, and the two a tree holds are named", () => {
  // The fixture is the run only if the two refusals are exactly what it minted: a refused receipt the Host ADMITS would
  // test a different branch, and no refusal at all would be a plain sixty-tile day.
  const admissions = purposeReceipts(ROUND96_DAY);
  assert.equal(admissions.admitted.length, ROUND96_WORKED.length * 2, "every worked tile is tilled and sown, and read");
  assert.deepEqual(
    admissions.refused,
    [],
    "a rejected tile is not a receipt nobody can read: it is the ground answering, and it must not turn the day unproven",
  );

  const judged = judgeTaskPurpose("clear_and_plant_long_patch", ROUND96_DAY);
  assert.equal(
    judged.state,
    "achieved",
    "fifty-eight worked tiles and two trees inside one 20x3 strip is the strip: the two were never candidates, so the " +
      "criterion must not file them as missing (round96, day 3)",
  );
  assert.equal(judged.patchTiles, 58);
  assert.deepEqual(judged.patchWindow, { x: 44, y: 21, width: 20, height: 3, count: 58 });
  assert.deepEqual(
    judged.patchExcludedTiles.map((entry) => `${entry.kind}@${entry.tile.x},${entry.tile.y}`),
    ["tree@60,22", "tree@62,23"],
    "the verdict names each excluded tile and its occupant, so a reader sees the two were excluded and not missed",
  );
  assert.equal(
    judged.detail,
    "58/60 tiles of a 20x3 strip at 44,21 are tilled and sown · excluded_by_occupant=tree@60,22,tree@62,23",
    "the count stays against the DECLARED sixty and carries the exclusions beside it: 58/60 alone would read as a short day",
  );
  assert.deepEqual(
    judged.limitingFactors,
    [],
    "nothing limited this day - the trees were not a limit on it, they are ground it was never asked to open",
  );
});

/**
 * THE GATE: `an_occupant_a_patch_day_cannot_clear_is_named_and_never_demanded:<task>:<kind>`.
 *
 * <p>
 * THE DEFECT CLASS. A criterion that asks for N tiles of ground asks for whatever happens to stand on them, and the
 * only thing that decides whether a tile is part of a patch is whether THIS day's own actions could make it ready. A
 * hand-written list of "trees do not count" would answer for `round96` and leave the next occupant - a stump, a bush, a
 * boulder the task's tools cannot break - exactly where the trees were. So the population is the Mod's own published
 * occupant vocabulary (`TileOccupantKind.cs`), crossed with the Mod's own `Clears(...)` declarations, and the expectation
 * is derived from the two: a kind some action of this task clears is a tile the day owes, and every other kind is a
 * tile it was never asked for.
 * </p>
 * <p>
 * WHAT IT PROVES, ONE KIND AT A TIME, on a strip that is otherwise complete: excluding the tile must turn `achieved`
 * into `not_achieved` for a kind the day can clear, and must name the tile for a kind it cannot. Both directions matter -
 * an exclusion rule that excused everything would call fifty-eight of sixty `achieved` for a weed too, which is the
 * grade-nothing criterion this table has been burned by before.
 * </p>
 *
 * red-proof: inject  excluding every occupant kind (dropping the `clearable.has(kind)` test) -> the `stone` row goes red
 *                   naming the kind the day CAN break; inject  excluding none (`patchExcludedTiles` returning `[]`) ->
 *                   every un-clearable row goes red naming the kind (tools/lib/task-purpose.test.mjs)
 */
test("an_occupant_a_patch_day_cannot_clear_is_named_and_never_demanded", (t) => {
  const vocabulary = readFileSync(
    new URL("../../integrations/stardew/src/Core/TileOccupantKind.cs", import.meta.url),
    "utf8",
  );
  const kinds = declaredKinds(vocabulary);
  assert.ok(
    Array.isArray(kinds) && kinds.length > 0,
    "blocked: the Mod's occupant vocabulary published no kinds, so this gate would examine nothing",
  );
  const clearers = clearedKinds(
    readFileSync(new URL(`../../${String(SOURCES.catalog)}`, import.meta.url), "utf8"),
    constantsIn(vocabulary),
  );
  assert.ok(clearers.size > 0, "blocked: the Mod's catalog declares no clearing action, so no kind could be owed");

  const patchTasks = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.patch !== undefined);
  assert.ok(patchTasks.length > 0, "blocked: no criterion asks for a shape, so nothing here was examined");

  const violations = [];
  let examined = 0;
  for (const [task, entry] of patchTasks) {
    const offered = new Set(DAILY_TASK_ACTION_HINTS[task]);
    const strip = rectangle(entry.patch.width, entry.patch.height);
    // The tile the occupant stands on: the strip's first, so the window is the declared one whichever way it is laid.
    const [heldX, heldY] = strip[0];
    const worked = strip.slice(1);
    for (const kind of kinds) {
      examined += 1;
      const code = `an_occupant_a_patch_day_cannot_clear_is_named_and_never_demanded:${task}:${kind}`;
      t.diagnostic(code);
      const judged = judgeTaskPurpose(task, [...patchReceipts(worked), TREE_REFUSED(heldX, heldY, kind)]);
      const owed = (clearers.get(kind) ?? []).some((actionId) => offered.has(actionId));
      const named = (judged.patchExcludedTiles ?? []).map(
        (excluded) => `${excluded.kind}@${excluded.tile.x},${excluded.tile.y}`,
      );
      if (owed) {
        if (judged.state === "achieved")
          violations.push(
            `${code} - a ${kind} this task's own actions clear (${String(clearers.get(kind))}) was excused, so a strip ` +
              `with one left standing reads finished`,
          );
        if (named.length > 0) violations.push(`${code} - a ${kind} the day can clear was reported excluded: ${named}`);
        continue;
      }
      if (judged.state !== "achieved")
        violations.push(
          `${code} - no action of ${task} clears a ${kind}, so that tile was never a candidate: the day reported ` +
            `${String(judged.state)} (${String(judged.reasonCode)}) for a strip it worked whole`,
        );
      if (named.length !== 1 || !named[0].startsWith(`${kind}@`))
        violations.push(`${code} - the verdict names ${JSON.stringify(named)} instead of that one excluded tile`);
    }
  }
  const summary = `kinds ${String(kinds.length)} · criteria ${String(patchTasks.length)} · examined ${String(examined)}`;
  t.diagnostic(summary);
  assert.ok(examined > 0, `blocked: ${summary} - nothing was examined`);
  assert.deepEqual(violations, [], `${summary}\n${violations.join("\n")}`);
});

/**
 * THE OTHER HALF OF `round96`: the run published as `tools/_multiday_routine-round96.result.json`, day for day.
 *
 * <p>
 * Two days, two members of ONE rule. Day 3 (`buy_seeds_and_expand_plot`) bought fifty parsnip seeds at Pierre's, sowed
 * twenty tiles, watered them, and turned FIVE of them with its own Hoe - and the criterion answered `till_soil 5/20`,
 * because it counted the swing instead of the ground. Day 2 (`clear_and_plant_long_patch`) tilled twenty tiles and then
 * could not sow one: she walked to the SeedShop and found 「店里摆的全是沙漠节那些摊子，连防风草种子都没上架」, came back with
 * nothing, and the criterion filed `0/60 ... nothing_sown` against her.
 * </p>
 * <p>
 * THE TILES ARE THE RUN'S OWN, from its `timeline.jsonl` (`.live-runs/game-ladder/2026-11-23T11-46-56-349Z-multiday_routine/`,
 * facts 134..233 for the sown day and 48..134 for the strip day). Only the receipt SHAPES are built here, from the same
 * contract-derived helpers the rest of this file uses, so the fixture fails if the wire changes and the artifact is 6 MB
 * outside the tree.
 * </p>
 */
/** Day 3's twenty sown tiles: the block at `(60,18)..(66,20)` less `(60,20)`, which the day tilled and never sowed. */
const ROUND96_SOWN_TILES = Object.freeze([
  [60, 18],
  [61, 18],
  [62, 18],
  [63, 18],
  [64, 18],
  [65, 18],
  [66, 18],
  [60, 19],
  [61, 19],
  [62, 19],
  [63, 19],
  [64, 19],
  [65, 19],
  [66, 19],
  [61, 20],
  [62, 20],
  [63, 20],
  [64, 20],
  [65, 20],
  [66, 20],
]);

/** The five tiles the day's own Hoe turned, in the order its receipts named them. */
const ROUND96_TURNED_TILES = Object.freeze([
  [66, 19],
  [65, 19],
  [60, 19],
  [61, 20],
  [61, 18],
]);

/** Day 2's twenty tilled tiles, which are exactly the ground day 3 went on to sow. */
const ROUND96_STRIP_TILLED = ROUND96_SOWN_TILES;

/** The purchase itself, verbatim from the run's own `item_purchased` terminal. */
const ROUND96_PURCHASE = receipt("shop_purchase", {
  reasonCode: "item_purchased",
  evidence: {
    detail:
      "shop=SeedShop;location=SeedShop;owner=Pierre;entry=npc_owner;distance_required=none;why=engine_has_no_gate_for_npc_counters;item=(O)472;requested=50;purchased=50;unit_price=20;money_before=1060;money_after=60;owned_before=0;owned_after=50;gained=50;stock_before=unlimited;stock_after=unlimited;owner_tile=4,17;menu_closed=true;clicks=50;drops=50",
  },
});

/**
 * The sown day's receipts: five turnings, twenty sowings, twenty-one waterings (the last one is a crop at `(29,17)` the
 * day also watered), and the purchase.
 */
const ROUND96_SOWN_DAY = Object.freeze([
  ...ROUND96_TURNED_TILES.map(([x, y]) => TILLED(x, y)),
  ...ROUND96_SOWN_TILES.map(([x, y]) => PLANTED(x, y)),
  ...ROUND96_SOWN_TILES.map(([x, y]) => WATERED(x, y)),
  WATERED(29, 17),
  ROUND96_PURCHASE,
]);

/**
 * NAMED `round96, day 3`: the plot was laid, and five swings were not twenty.
 *
 * red-proof: inject  restoring `buy_seeds_and_expand_plot` to its step list (`till_soil 20`) -> this test reads
 *                   `not_achieved · till_soil 5/20 · plant_seed 20/20 · water_crop 20/20`, which is what the run's own
 *                   `result.json` published (tools/lib/task-purpose.test.mjs)
 */
test("round96's sown day is the twenty tiles it left, whatever the Hoe did", () => {
  // The fixture is the run only if the wire admits every one of these: a refused receipt would make the day answer
  // `unproven` and this test would be measuring admission instead of the criterion.
  const admissions = purposeReceipts(ROUND96_SOWN_DAY);
  assert.deepEqual(admissions.refused, [], "every receipt of the sown day is its own postcondition");
  assert.equal(admissions.admitted.length, ROUND96_SOWN_DAY.length);

  const judged = judgeTaskPurpose("buy_seeds_and_expand_plot", ROUND96_SOWN_DAY);
  assert.equal(
    judged.state,
    "achieved",
    "twenty tiles sown and watered is a plot: the ground she sowed into was already tilled, which is what a farmhand " +
      "uses, and `round96`'s own day answered `till_soil 5/20` against it",
  );
  assert.equal(judged.plotTiles, 20);
  assert.equal(judged.plotSownTiles, 20);
  assert.equal(
    judged.plotWateredTiles,
    21,
    "twenty-one waterings and a plot of twenty, because one of them was a crop somewhere else",
  );
  assert.equal(judged.plotAlreadyTilled, 15, "fifteen of the twenty were ground the day did not open itself");
  assert.equal(judged.plotBoughtActions.length, 1, "the seed was bought, which is the half the task's name carries");
  assert.equal(
    judged.detail,
    "20/20 tiles sown and watered (sown 20, watered 21) · tiles_not_under_crop_before=20 · already_tilled=15 · " +
      "bought=shop_purchase · tiles 60,18 61,18 62,18 63,18 64,18 65,18 66,18 60,19 61,19 62,19 63,19 64,19 65,19 " +
      "66,19 61,20 62,20 63,20 64,20 65,20 66,20",
    "the reading names the plot tile by tile, and keeps the two numbers that make `expand` a measurement: the tiles that " +
      "were not under crop before, and the ones she had to open herself",
  );
  assert.deepEqual(judged.limitingFactors, [], "nothing limited a day that laid its plot");
});

/**
 * THE GATE: `a_plot_is_counted_in_tiles_and_never_in_receipts:<task>`.
 *
 * <p>
 * THE DEFECT CLASS. A criterion made of counted steps counts RECEIPTS, and a receipt names whatever tile it landed on:
 * twenty sowings on one tile read as twenty sown tiles. `round96` is the other direction of the same defect - twenty
 * receipts can also be the wrong twenty - and the whole reason `buy_seeds_and_expand_plot` stopped being a step list.
 * So the population is every criterion that declares a plot, read from `TASK_PURPOSE_CRITERIA`, and the property is the
 * one a step list cannot state: the count is of DISTINCT tiles, the sowings and the waterings are on the SAME tiles, and
 * the tiles are on one map.
 * </p>
 *
 * <p>
 * red-proof: inject  judging a plot by receipt counts (matching the count of admitted receipts) -> the one-tile row
 *                   goes red naming the task, and judging it without the same-tile rule -> the split-row goes red
 *                   (tools/lib/task-purpose.test.mjs)
 * </p>
 */
test("a_plot_is_counted_in_tiles_and_never_in_receipts", (t) => {
  const plotTasks = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.plot !== undefined);
  assert.ok(plotTasks.length > 0, "blocked: no criterion declares a plot, so nothing here was examined");
  const violations = [];
  let examined = 0;
  for (const [task, entry] of plotTasks) {
    const declared = entry.plot.tiles;
    const plots = [
      {
        label: "every receipt on ONE tile",
        receipts: [
          ...Array.from({ length: declared }, () => PLANTED(12, 4)),
          ...Array.from({ length: declared }, () => WATERED(12, 4)),
          ...entry.boughtBy.map((actionId) => (actionId === "shop_purchase" ? ROUND96_PURCHASE : receipt(actionId))),
        ],
        tiles: 1,
      },
      {
        label: "sown on one field and watered on another",
        receipts: [
          ...rectangle(declared, 1, 12, 4).map(([x, y]) => PLANTED(x, y)),
          ...rectangle(declared, 1, 12, 9).map(([x, y]) => WATERED(x, y)),
          ...entry.boughtBy.map((actionId) => (actionId === "shop_purchase" ? ROUND96_PURCHASE : receipt(actionId))),
        ],
        tiles: 0,
      },
      {
        label: "the declared tiles, sown and watered",
        receipts: [
          ...rectangle(declared, 1, 12, 4).map(([x, y]) => PLANTED(x, y)),
          ...rectangle(declared, 1, 12, 4).map(([x, y]) => WATERED(x, y)),
          ...entry.boughtBy.map((actionId) => (actionId === "shop_purchase" ? ROUND96_PURCHASE : receipt(actionId))),
        ],
        tiles: declared,
      },
      {
        label: "the declared tiles with no purchase",
        receipts: [
          ...rectangle(declared, 1, 12, 4).map(([x, y]) => PLANTED(x, y)),
          ...rectangle(declared, 1, 12, 4).map(([x, y]) => WATERED(x, y)),
        ],
        tiles: declared,
        bought: false,
      },
    ];
    for (const plot of plots) {
      examined += 1;
      const code = `a_plot_is_counted_in_tiles_and_never_in_receipts:${task}: ${plot.label}`;
      t.diagnostic(code);
      const judged = judgeTaskPurpose(task, plot.receipts);
      if (judged.plotTiles !== plot.tiles)
        violations.push(`${code} - the verdict counts ${String(judged.plotTiles)} tiles, not ${String(plot.tiles)}`);
      const shouldAchieve = plot.bought !== false && plot.tiles >= declared;
      if (shouldAchieve && judged.state !== "achieved")
        violations.push(`${code} - a finished plot answered ${String(judged.state)} (${String(judged.reasonCode)})`);
      if (!shouldAchieve && judged.state === "achieved")
        violations.push(`${code} - it answered achieved with ${String(judged.plotTiles)} plot tiles`);
    }
  }
  const summary = `plot criteria ${String(plotTasks.length)} · readings ${String(examined)}`;
  t.diagnostic(summary);
  assert.ok(examined > 0, `blocked: ${summary} - nothing was examined`);
  assert.deepEqual(violations, [], `${summary}\n${violations.join("\n")}`);
});

/**
 * THE SAME RULE, THE OTHER MEMBER: a strip a day SOWS is a strip the day laid.
 *
 * <p>
 * `clear_and_plant_long_patch` reads a rectangle rather than a count, and it inherited the identical defect: a tile
 * counted only when the day's own Hoe named it, so a family that lays its strip over ground tilled yesterday would be
 * filed `0/60` with sixty crops standing in it. A sowing proves the ground it went into, so the strip is the tiles that
 * carry a crop on ground the day HOLDS - and the one observation that can contradict a receipt, a `soilTiles` row whose
 * own state says the Hoe can turn that tile now, still wins.
 * </p>
 *
 * red-proof: inject  `patchReading` reading `facts.tilled` instead of `facts.ground` -> the sown strip answers
 *                   `not_achieved · 0/60` (tools/lib/task-purpose.test.mjs)
 */
test("a strip sown into ground an earlier day tilled is a strip this day laid", () => {
  const strip = rectangle(3, 20);
  const sownOnly = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => PLANTED(x, y)),
  );
  assert.equal(
    sownOnly.state,
    "achieved",
    "sixty sowings inside one 3x20 strip are the strip: `plant_seed` only succeeds on tilled soil, so the receipts " +
      "prove the ground they went into as well as the seed they spent",
  );
  assert.equal(sownOnly.patchTiles, 60);
  assert.equal(sownOnly.patchTilledTiles, 0, "the Hoe named no tile, and the verdict does not pretend it did");
  assert.match(sownOnly.detail ?? "", /^60\/60 tiles of a 3x20 strip at/u);

  // THE CONTRADICTION WINS. The same sixty sowings against an observation that says the Hoe can turn those tiles now is
  // not a strip laid: one receipt says the seed went in and the other says the ground is open, and a criterion that
  // picked the convenient one would report untilled ground as a finished plot.
  const contradicted = judgeTaskPurpose("clear_and_plant_long_patch", strip.map(([x, y]) => PLANTED(x, y)), {
    location: "Farm",
    soilTiles: strip.map(([x, y]) => ({ x, y, hoeDirt: false })),
  });
  assert.equal(contradicted.state, "not_achieved");
  assert.match(contradicted.detail ?? "", /0\/60/u);
});

/**
 * `round96`'s STRIP DAY, WHICH THIS CRITERION WAS RIGHT TO REFUSE.
 *
 * <p>
 * Day 2 tilled twenty tiles of the ground the sown day later used, could not buy a seed, and went to bed. The reading is
 * `0/60 ... tilled 20 ... nothing_sown` and it is TRUE: the day did not lay the strip. What was wrong was that the day
 * was scheduled at all - see `a_sowing_day_is_refused_on_the_world_that_holds_no_seed` in
 * `tools/live-run/game/task-pool-feasibility.test.mjs`, which is the half of this measurement the pool owns.
 * </p>
 */
test("round96's strip day left twenty tilled tiles and no plot, and the count says so", (t) => {
  const day = ROUND96_STRIP_TILLED.map(([x, y]) => TILLED(x, y));
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", day);
  t.diagnostic(`round96 day 2: ${String(judged.state)} · ${String(judged.detail)}`);
  assert.equal(judged.state, "not_achieved", "twenty tilled tiles are not a sown strip, and nothing here excuses it");
  assert.equal(judged.patchTiles, 0, "no tile carries a crop, so no tile is part of the plot");
  assert.equal(judged.patchTilledTiles, 20, "twenty tiles the Hoe named - that part of the day is in the reading");
  assert.equal(judged.patchSownTiles, 0);
  assert.ok(
    judged.limitingFactors.includes("nothing_sown"),
    `the limit is the missing seed, and it has to be named: ${String(judged.limitingFactors)}`,
  );
});
