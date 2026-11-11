/**
 * The Lane G0 gate: a multi-day run must show days that were genuinely crossed, by the companion's own
 * sleep, in a world that still had work in it afterwards.
 *
 * Two modes, both offline:
 *
 *   default        the baseline's rules are exercised against fixtures, so each rule is proven able to
 *                  fail on its own. A rule that cannot red this gate is a rule nobody is enforcing.
 *   --run-dir DIR  a REAL run's bundle is read through the one contract
 *                  (`tools/lib/evidence-bundle.mjs`) and its crossing record is judged by the one baseline
 *                  (`tools/lib/multiday-baseline.mjs`). This is how a live run is closed.
 *
 * Usage:
 *   node tools/check-live-run-multiday-baseline.mjs
 *   node tools/check-live-run-multiday-baseline.mjs --run-dir .live-runs/game-ladder/<run>
 * red-proof: inject  --run-dir over a bundle recorded in window mode `hidden` ->
 * *                    `run_used_a_window_mode_the_engine_advances_a_day_in` failed with `windowMode=hidden`, exit 1
 * *                    (tools/check-live-run-multiday-baseline.mjs, the rule this marker names)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvidenceBundle } from "./lib/evidence-bundle.mjs";
import {
  assessMultiDayBaseline,
  BASELINE_SCOPE_NOTES,
  parseReceiptEvidence,
  worldDayStartsFromFacts,
  worldNightEndingsFromFacts,
} from "./lib/multiday-baseline.mjs";

const checks = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

/**
 * May a day boundary advance in this window mode?
 *
 * Only `foreground` may, and that is a fact about the engine rather than a preference: the fade the day boundary runs
 * inside advances only while the window is ACTIVE (SW_SHOW + SetForegroundWindow), while `hidden`/`background` and even
 * `visible` (SW_SHOWNOACTIVATE) leave it parked at the fade. Measured 2026-10-19: every run that crossed a night did so
 * in foreground mode, and hidden-mode runs froze at the fade instead. A multi-day PASS therefore means "multi-day works
 * in the one window mode where it can", which is why it is asserted rather than assumed.
 */
export function windowModeAllowsADayCrossing(mode) {
  return mode === "foreground";
}

const EVIDENCE = (overrides = {}) =>
  [
    "state=passed",
    "reason=day_advanced",
    "topology=single_player",
    "entered_via=native_sleep_prompt",
    `saving_observed=${overrides.savingObserved ?? "true"}`,
    `saved_observed=${overrides.savedObserved ?? "true"}`,
    `day_started_observed=${overrides.dayStartedObserved ?? "true"}`,
    `day_before=${String(overrides.dayBefore ?? 5)}`,
    `days_before=${String(overrides.daysBefore ?? 5)}`,
    `day_after=${String(overrides.dayAfter ?? 6)}`,
    `days_after=${String(overrides.daysAfter ?? 6)}`,
  ].join(";");

const day = (overrides = {}) => ({
  day: overrides.day ?? 1,
  terminal:
    overrides.terminal === null
      ? null
      : {
          state: overrides.state ?? "succeeded",
          reasonCode: overrides.reasonCode ?? "day_advanced",
          evidence: overrides.evidence ?? EVIDENCE(),
        },
  after: overrides.after ?? { dayOfMonth: 7, timeOfDay: 610, seasonIndex: 0, year: 1 },
  menus: overrides.menus ?? [
    {
      menuType: "ShippingMenu",
      decision: "dismiss",
      dismissReceipt: { state: "succeeded", reasonCode: "modal_dismissed" },
      dismissReasonCode: null,
    },
  ],
  nextDayAccomplishedActionIds: overrides.nextDayAccomplishedActionIds ?? ["harvest_crop"],
});

const codes = (result) => result.violations.map((entry) => entry.code);

function fixtureChecks() {
  // 1. A healthy two-night crossing passes.
  const healthy = assessMultiDayBaseline({ dayRecords: [day({ day: 1 }), day({ day: 2 })], daysRequested: 2 });
  check("healthy_crossing_passes", healthy.ok, codes(healthy).join(",") || undefined);

  // 2. Each rule is independently load-bearing.
  const rules = [
    [
      "night_not_crossed",
      () =>
        assessMultiDayBaseline({
          dayRecords: [day({ state: "blocked", reasonCode: "day_start_not_observed" }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "night_not_advanced",
    ],
    [
      "totals_must_advance",
      () =>
        assessMultiDayBaseline({
          dayRecords: [
            day({ evidence: EVIDENCE({ dayBefore: 5, dayAfter: 5, daysBefore: 5, daysAfter: 5 }) }),
            day({ day: 2 }),
          ],
          daysRequested: 2,
        }),
      "night_totals_did_not_advance",
    ],
    [
      "world_calendar_must_agree",
      () =>
        assessMultiDayBaseline({ dayRecords: [day({ after: { dayOfMonth: 5 } }), day({ day: 2 })], daysRequested: 2 }),
      "night_world_calendar_mismatch",
    ],
    [
      "saved_edge_required",
      () =>
        assessMultiDayBaseline({
          dayRecords: [day({ evidence: EVIDENCE({ savedObserved: "false" }) }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "night_saved_edge_not_observed",
    ],
    [
      "day_started_edge_required",
      () =>
        assessMultiDayBaseline({
          dayRecords: [day({ evidence: EVIDENCE({ dayStartedObserved: "false" }) }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "night_day_started_edge_not_observed",
    ],
    [
      "shipping_menu_must_be_closed",
      () => assessMultiDayBaseline({ dayRecords: [day({ menus: [] }), day({ day: 2, menus: [] })], daysRequested: 2 }),
      "first_night_shipping_menu_never_dismissed",
    ],
    [
      "unclosable_menu_stops_by_name",
      () =>
        assessMultiDayBaseline({
          dayRecords: [day({ menus: [{ menuType: "LetterViewerMenu", decision: "blocked" }] }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "night_raised_unclosable_menu:LetterViewerMenu",
    ],
    [
      // The level-up path: red without the product's own resolution, and red when the recorded choice is a
      // branch (a milestone is the companion's decision, so a harness that picked one decided for it).
      "level_up_menu_needs_the_products_own_resolution",
      () =>
        assessMultiDayBaseline({
          dayRecords: [day({ menus: [{ menuType: "LevelUpMenu", decision: "respond_level_up" }] }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "level_up_menu_not_resolved",
    ],
    [
      "next_day_needs_farm_work",
      () =>
        assessMultiDayBaseline({
          dayRecords: [day({ nextDayAccomplishedActionIds: [] }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "next_day_produced_no_farm_work",
    ],
  ];
  for (const [id, produce, expected] of rules) {
    // A named rule may carry its detail in the code (`night_not_advanced:blocked/day_start_not_observed`), so
    // the prefix is what is matched.
    const produced = codes(produce());
    check(
      id,
      produced.some((code) => code.startsWith(expected)),
      produced.join(","),
    );
  }

  // 2b. The SCOPE is enforced, not just documented: a night that leaves it is red rather than a broader pass.
  // The evidence totals and the world's calendar must AGREE for a night to be classified at all, so each case
  // carries both: the totals the Mod reported and the day the world showed afterwards.
  const outOfScopeNights = [
    [
      "season_boundary",
      "night_crossed_a_season_boundary",
      () =>
        day({
          evidence: EVIDENCE({ dayBefore: 27, daysBefore: 27, dayAfter: 28, daysAfter: 28 }),
          after: { dayOfMonth: 1, timeOfDay: 610, seasonIndex: 0 },
        }),
    ],
    [
      "festival",
      "night_landed_on_a_festival_day",
      () =>
        day({
          evidence: EVIDENCE({ dayBefore: 11, daysBefore: 11, dayAfter: 12, daysAfter: 12 }),
          after: { dayOfMonth: 13, timeOfDay: 610, seasonIndex: 0 },
        }),
    ],
  ];
  for (const [id, expected, produce] of outOfScopeNights) {
    const produced = assessMultiDayBaseline({
      dayRecords: [produce(), day({ day: 2 })],
      daysRequested: 2,
    }).violations.map((entry) => entry.code);
    check(
      `scope_${id}_is_out_of_scope`,
      produced.some((code) => code.startsWith(expected)),
      produced.join(","),
    );
  }

  // 2c. A night that saved AFTER the boundary window closed is not red, and this case is the real one: round19's own
  // receipt (`2026-11-01T04-56-14-966Z-multiday_routine`) carries `save_boundary_not_observed=true` beside
  // `saved_observed=true`, and the Mod log for that same night records `AwaitingSave` entered at 13:08:49, the budget
  // taken at 13:08:54, `SaveGame.Save() completed` at 13:09:50 and `after save, starting spring 6 Y1` at 13:09:52.
  // Both save facts are true, because the engine saves synchronously and a per-frame poll cannot see `IsSaving`. The
  // claim a receipt CAN make without evidence - a save with no witness - is still red (asserted here beside it, so the
  // removed rule's force is not quietly gone with it).
  const round19Receipt =
    "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;" +
    "saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=true;" +
    "shipping_summary_settled=committed;day_before=4;days_before=1;day_after=5;days_after=2";
  const savedAfterTheBoundary = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      day({ evidence: round19Receipt, after: { dayOfMonth: 6, timeOfDay: 610, seasonIndex: 0 } }),
      day({ day: 2 }),
    ],
  });
  check(
    "a_save_after_the_boundary_window_is_not_a_claim",
    !codes(savedAfterTheBoundary).includes("night_claims_a_save_without_entering_the_save_boundary"),
    codes(savedAfterTheBoundary).join(","),
  );
  const saveWithoutAWitness = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [day({ evidence: EVIDENCE({ savedObserved: "false" }) }), day({ day: 2 })],
  });
  check(
    "a_save_with_no_witness_is_still_red",
    codes(saveWithoutAWitness).includes("night_saved_edge_not_observed"),
    codes(saveWithoutAWitness).join(","),
  );

  // 3. The window is enforced: a one-night "multi-day" run cannot claim the baseline.
  const oneNight = assessMultiDayBaseline({ dayRecords: [day()], daysRequested: 1 });
  check(
    "one_night_cannot_claim_the_baseline",
    codes(oneNight).includes("baseline_window_out_of_range:1") &&
      codes(oneNight).includes("baseline_days_crossed_below_minimum:1"),
    codes(oneNight).join(","),
  );

  // 3b. THE DAY COUNT COMES FROM THE WORLD. Two watched nights beside five `day_started` facts is exactly the shape
  // measured on 2026-11-06 (`round38`), where the assessment read `crossings: 2` and `violations: []` while the world had
  // moved through days 5 to 9. The rule must be able to fire, or it is decoration.
  const fiveDayStarts = worldDayStartsFromFacts([
    { worldFactKind: "day_started", eventId: "day_started_day_5" },
    { worldFactKind: "day_started", eventId: "day_started_day_6" },
    { worldFactKind: "day_started", eventId: "day_started_day_7" },
    { worldFactKind: "day_started", eventId: "day_started_day_8" },
    { worldFactKind: "day_started", eventId: "day_started_day_9" },
  ]);
  const disagreeing = assessMultiDayBaseline({
    dayRecords: [day(), day({ day: 2 })],
    daysRequested: 2,
    worldDayStarts: fiveDayStarts,
  });
  check(
    "a_day_count_the_world_disagrees_with_is_named_red",
    codes(disagreeing).includes("day_count_disagrees_with_the_world:2 != 5"),
    codes(disagreeing).join(","),
  );
  const agreeing = assessMultiDayBaseline({
    dayRecords: [day(), day({ day: 2 })],
    daysRequested: 2,
    worldDayStarts: fiveDayStarts.slice(0, 2),
  });
  check(
    "an_agreeing_world_is_green_on_the_day_count",
    agreeing.dayCountWitness === "world" &&
      !codes(agreeing).some((code) => code.startsWith("day_count_disagrees_with_the_world")),
    `witness=${String(agreeing.dayCountWitness)}:${codes(agreeing).join(",")}`,
  );

  // 3c. THE WORLD'S NIGHT ENDINGS ARE AN AUTHORITY, and the assessor reads them without the records' help.
  //
  // round39's own facts, verbatim: two days opened (`day_started_day_5`/`_6`) and the world published
  // `night_ended_pass_out_day_6` at 26:00. The pass-out ended day 6, so it names the night that came AFTER the two the
  // records cover - the loop had already stopped - and until this rule existed the assessment answered
  // `passOutNights: 0` beside it while calling both recorded nights `night_mechanism_unobserved`.
  const round39Facts = [
    { worldFactKind: "day_started", eventId: "day_started_day_5" },
    { worldFactKind: "day_started", eventId: "day_started_day_6" },
    { worldFactKind: "night_ended_pass_out", eventId: "night_ended_pass_out_day_6" },
  ];
  const endings = worldNightEndingsFromFacts(round39Facts);
  check(
    "world_night_endings_read_the_mods_minted_shape",
    endings.length === 1 && endings[0].day === 6 && endings[0].cause === "pass_out",
    JSON.stringify(endings),
  );
  const round39 = assessMultiDayBaseline({
    dayRecords: [
      day({ day: 1, terminal: null, after: { dayOfMonth: 6, dayBefore: 5, seasonIndex: 0, year: 1 }, menus: [] }),
      day({ day: 2, terminal: null, after: { dayOfMonth: 7, dayBefore: 6, seasonIndex: 0, year: 1 }, menus: [] }),
    ],
    daysRequested: 2,
    worldDayStarts: worldDayStartsFromFacts(round39Facts),
    worldNightEndings: endings,
  });
  check(
    "a_world_pass_out_is_counted_and_the_night_it_names_is_named",
    round39.passOutNights === 1 &&
      round39.nightWitness === "world" &&
      codes(round39).includes("world_night_not_recorded:6:pass_out"),
    `passOut=${String(round39.passOutNights)}:${codes(round39).join(",")}`,
  );
  check(
    "a_pass_out_the_day_starts_missed_still_counts_as_a_crossing",
    // Two `day_started` facts and one pass-out that opened a third day: the records say two crossings and the world
    // says three, and the disagreement names both numbers.
    codes(round39).some((code) => code === "day_count_disagrees_with_the_world:2 != 3"),
    codes(round39).join(","),
  );
  check(
    "the_recorded_nights_the_world_says_nothing_about_stay_unobserved",
    // The pass-out is NOT transferred onto the night beside it: both recorded nights ended before it, and a verdict
    // that attributed them to the engine would be stating an event nothing witnessed.
    codes(round39).filter((code) => code === "night_mechanism_unobserved").length === 2,
    codes(round39).join(","),
  );
  // A record that CLAIMS her own sleep for a night the world says the engine took is a disagreement, and it is named
  // with both sides rather than resolved silently in either direction.
  const disagreeingCause = assessMultiDayBaseline({
    dayRecords: [day({ day: 1, after: { dayOfMonth: 7, dayBefore: 6, seasonIndex: 0, year: 1 } }), day({ day: 2 })],
    daysRequested: 2,
    worldNightEndings: [{ day: 5, cause: "pass_out" }],
  });
  check(
    "a_record_that_contradicts_the_world_is_named_red",
    codes(disagreeingCause).includes("night_cause_disagrees_with_the_world:sleep:pass_out"),
    codes(disagreeingCause).join(","),
  );
  // And the case the real bundle does not contain: a night whose ending NOBODY named - no receipt, no world fact - is
  // still red. `night_mechanism_unobserved` is for exactly this, and for nothing else.
  const nobodySaid = assessMultiDayBaseline({
    dayRecords: [day({ day: 1, terminal: null, after: { dayOfMonth: 6, dayBefore: 5, seasonIndex: 0, year: 1 } })],
    daysRequested: 2,
    worldNightEndings: [],
  });
  check(
    "a_night_nobody_attributed_is_still_unobserved",
    nobodySaid.nightWitness === "world" &&
      nobodySaid.passOutNights === 0 &&
      codes(nobodySaid).includes("night_mechanism_unobserved"),
    codes(nobodySaid).join(","),
  );

  // 4. The Mod's evidence projection is read in both shapes the receipts carry.
  check(
    "evidence_projection_reads_both_shapes",
    parseReceiptEvidence("day_after=6").day_after === "6" &&
      parseReceiptEvidence({ detail: "day_after=6" }).day_after === "6",
  );

  // 5. The window-mode precondition is falsifiable, so the rule above cannot be a constant: hidden and background (and
  // the merely-visible mode the launcher used to fall back to) all have to read as unable to cross a day.
  check(
    "only_foreground_can_cross_a_day",
    windowModeAllowsADayCrossing("foreground") &&
      !windowModeAllowsADayCrossing("hidden") &&
      !windowModeAllowsADayCrossing("background") &&
      !windowModeAllowsADayCrossing("visible") &&
      !windowModeAllowsADayCrossing(undefined),
  );
}

async function runDirChecks(runDir) {
  const { bundle, violations } = await readEvidenceBundle(runDir);
  const codes = violations.map((entry) => entry.code);
  check("bundle_is_valid", violations.length === 0, codes.join(",") || undefined);
  if (bundle === null) return;
  check("bundle_verdict_is_passed", bundle.verdict?.state === "passed", String(bundle.verdict?.state));
  check(
    "run_used_a_window_mode_the_engine_advances_a_day_in",
    windowModeAllowsADayCrossing(bundle.env?.windowMode),
    `windowMode=${String(bundle.env?.windowMode)}`,
  );
  const multiday = bundle.multiday ?? null;
  check(
    "run_reports_a_crossing",
    multiday !== null && Number.isInteger(multiday?.crossings) && multiday.crossings >= 2,
    JSON.stringify(multiday?.crossings ?? null),
  );
  if (multiday === null) return;
  check("crossing_is_a_real_day_advance", bundle.actionTrace?.records !== undefined && bundle.actionTrace.records > 0);
  check(
    "crossing_count_matches_its_records",
    Array.isArray(multiday.dayRecords) && multiday.dayRecords.length === multiday.crossings,
  );
  // Judged again HERE from the raw record, so a run that reported its own verdict cannot override the gate.
  // The world's own day count comes from the run's artifact, not from the runner's loop count.
  const worldDayStarts = readWorldDayStarts(runDir);
  const worldNightEndings = readWorldNightEndings(runDir);
  const requested = Number.isInteger(multiday.requestedCrossings) ? multiday.requestedCrossings : multiday.crossings;
  const rejudged = assessMultiDayBaseline({
    dayRecords: multiday.dayRecords,
    daysRequested: requested,
    worldDayStarts,
    worldNightEndings,
  });
  check("gate_rejudgement_agrees", rejudged.ok, rejudged.violations.map((entry) => entry.code).join(",") || undefined);
  // AND THE DAY COUNT IS THE WORLD'S, not the loop's. A run whose `day_started` facts cannot be read has not measured
  // its crossings, so it cannot pass on the assessor's own count either: `dayCountWitness` names which one answered.
  check(
    "the_day_count_is_the_worlds",
    rejudged.dayCountWitness === "world" &&
      !rejudged.violations.some((entry) => entry.code.startsWith("day_count_disagrees_with_the_world")),
    `witness=${String(rejudged.dayCountWitness)};assessor=${String(rejudged.daysCrossed)};world=${String(rejudged.worldDaysCrossed)}`,
  );
  // And every night's ATTRIBUTION comes from the world's own facts, not from the loop's records: `passOutNights` beside
  // a run whose timeline held a `night_ended_pass_out` is the measured shape this rule exists for (round39).
  check(
    "the_night_attribution_is_the_worlds",
    rejudged.nightWitness === "world",
    `nightWitness=${String(rejudged.nightWitness)};passOut=${String(rejudged.passOutNights)}`,
  );
  // A run that was asked for three nights and crossed two is red, and by name: the window rule could not see this
  // while the requested and achieved counts were the same number.
  check(
    "run_crossed_the_nights_it_was_asked_for",
    multiday.crossings === requested,
    `crossed=${String(multiday.crossings)} requested=${String(requested)}`,
  );
}

/**
 * The world's own `day_started` facts, read from the run's own timeline.
 *
 * The timeline is the bundle's declared record of every fact the run received (`timeline.records` is checked against it
 * by `readEvidenceBundle`), and a `day_started` entry carries `worldFactKind` plus the Mod's minted
 * `day_started_day_<n>` event id. `null` means the file is absent or unreadable - NOT zero day starts: a count nobody
 * could read must not be judged as a count of none.
 */
function readWorldDayStarts(runDir) {
  const facts = readTimeline(runDir);
  return facts === null ? null : worldDayStartsFromFacts(facts);
}

/**
 * The world's own `night_ended_*` facts, read from the same timeline.
 *
 * `null` is "could not read the timeline", an empty list is "the world named no ending" - and the gate must be able to
 * tell those apart, because only the second one is a fact about the run.
 */
function readWorldNightEndings(runDir) {
  const facts = readTimeline(runDir);
  return facts === null ? null : worldNightEndingsFromFacts(facts);
}

/** Every fact the run's own timeline holds, or `null` when the file is absent or unreadable. */
function readTimeline(runDir) {
  const timelinePath = join(runDir, "timeline.jsonl");
  if (!existsSync(timelinePath)) return null;
  const facts = [];
  for (const line of readFileSync(timelinePath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      facts.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return facts;
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

const runDir = parseOption("--run-dir");
if (runDir === null) fixtureChecks();
else {
  if (existsSync(join(runDir, "manifest.json"))) {
    check("run_dir_has_a_manifest", true);
    await runDirChecks(runDir);
  } else {
    check("run_dir_has_a_manifest", false, runDir);
  }
}

const failed = checks.filter((entry) => entry.status !== "passed");
process.stdout.write(
  `${JSON.stringify({
    gate: "live_run_multiday_baseline/v1",
    mode: runDir === null ? "rules" : "run-dir",
    runDir,
    status: failed.length === 0 ? "passed" : "failed",
    // WHAT THIS VERDICT COVERS, next to the verdict itself: a pass must not read as wider than the corpus.
    scope: BASELINE_SCOPE_NOTES,
    // The cases this run drove: one rule or one day-crossing reading per check.
    cases: checks.length,
    checks,
    // Read-only echo of the raw record for a real run, so a reader sees the crossings rather than only the verdict.
    ...(runDir !== null && existsSync(join(runDir, "manifest.json"))
      ? { multiday: JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")).multiday ?? null }
      : {}),
  })}\n`,
);
if (failed.length > 0) process.exitCode = 1;
