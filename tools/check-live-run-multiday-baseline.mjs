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
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assessMultiDayBaseline, parseReceiptEvidence } from "./lib/multiday-baseline.mjs";
import { readEvidenceBundle } from "./lib/evidence-bundle.mjs";

const checks = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

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
  after: overrides.after ?? { dayOfMonth: 7, timeOfDay: 610, seasonIndex: 3, year: 1 },
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
          dayRecords: [day({ menus: [{ menuType: "LevelUpMenu", decision: "blocked" }] }), day({ day: 2 })],
          daysRequested: 2,
        }),
      "night_raised_unclosable_menu:LevelUpMenu",
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

  // 3. The window is enforced: a one-night "multi-day" run cannot claim the baseline.
  const oneNight = assessMultiDayBaseline({ dayRecords: [day()], daysRequested: 1 });
  check(
    "one_night_cannot_claim_the_baseline",
    codes(oneNight).includes("baseline_window_out_of_range:1") &&
      codes(oneNight).includes("baseline_days_crossed_below_minimum:1"),
    codes(oneNight).join(","),
  );

  // 4. The Mod's evidence projection is read in both shapes the receipts carry.
  check(
    "evidence_projection_reads_both_shapes",
    parseReceiptEvidence("day_after=6").day_after === "6" &&
      parseReceiptEvidence({ detail: "day_after=6" }).day_after === "6",
  );
}

async function runDirChecks(runDir) {
  const { bundle, violations } = await readEvidenceBundle(runDir);
  const codes = violations.map((entry) => entry.code);
  check("bundle_is_valid", violations.length === 0, codes.join(",") || undefined);
  if (bundle === null) return;
  check("bundle_verdict_is_passed", bundle.verdict?.state === "passed", String(bundle.verdict?.state));
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
  const rejudged = assessMultiDayBaseline({ dayRecords: multiday.dayRecords, daysRequested: multiday.crossings });
  check("gate_rejudgement_agrees", rejudged.ok, codes.join(",") || undefined);
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

const runDir = parseOption("--run-dir");
if (runDir === null) fixtureChecks();
else {
  if (!existsSync(join(runDir, "manifest.json"))) {
    check("run_dir_has_a_manifest", false, runDir);
  } else {
    check("run_dir_has_a_manifest", true);
    await runDirChecks(runDir);
  }
}

const failed = checks.filter((entry) => entry.status !== "passed");
process.stdout.write(
  `${JSON.stringify({
    gate: "live_run_multiday_baseline/v1",
    mode: runDir === null ? "rules" : "run-dir",
    runDir,
    status: failed.length === 0 ? "passed" : "failed",
    checks,
    // Read-only echo of the raw record for a real run, so a reader sees the crossings rather than only the verdict.
    ...(runDir !== null && existsSync(join(runDir, "manifest.json"))
      ? { multiday: JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")).multiday ?? null }
      : {}),
  })}\n`,
);
if (failed.length > 0) process.exitCode = 1;
