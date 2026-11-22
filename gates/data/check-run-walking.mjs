#!/usr/bin/env node
/**
 * A RUN'S WALKING, as a reading: how many tiles it walked, over how many positioned events, at what cost per action,
 * with its longest single errand - and what those four are compared to.
 *
 * WHY (measured 2026-11-17, `round66`). The run's own account prints `turns opened 40 · bubbles delivered 30 · lost 12`
 * and `receipts with provenance`, and nothing about distance, so the packer that exists to cut walking had to argue from
 * a docblock ("Walking is 93.6% of a node's time", `host/src/body-program-packing.ts`). The hand count this tool
 * replaces read `37 positioned events · 647 tiles walked (Manhattan) · 1230 s · 17 world-changing actions = 38
 * tiles/action`, and three crops visited `(60,10) → (58,14) → (60,9)` cost 13 tiles where 8 would do.
 *
 * WHY THIS IS A `tools/` READER AND NOT A FIELD IN THE PUMP'S ACCOUNT. Two reasons, and the second is the deciding one.
 * The pump's account is assembled per delivered batch inside a live session (`host/src/event-pump.ts`), so a walk total
 * there would need cross-turn position state inside the product - state that nothing else in the pump keeps. And the
 * reading is wanted over history: `round66`'s receipts were written before this tool existed, and a product change
 * cannot re-derive them. A reader over a log measures the runs that already happened, needs no product change, and is
 * the same code path for the next run's log.
 *
 * WHAT IT PRINTS, and the three it prints separately so the first has something to be compared to:
 *
 *   walking:            walked W tiles · positioned events P · tiles per action R · longest walk L tiles
 *   walking bound:      straight-line B tiles (Manhattan spanning tree over the same P positions) · excess E tiles
 *   walking placement:  examined N facts · counted N (bucket, ...) · omitted 0 · restated R of the P
 *
 * THE TWO GATES, each naming its member.
 *
 *   `a_run_does_not_report_its_walking:<field>`   the account this tool prints is checked against `WALKING_READINGS`,
 *       the declaration in `tools/lib/walking.mjs`: a reading declared there and missing from the printed account fails
 *       by its id. What it cannot see: a reading nobody declared - and it says so rather than implying otherwise.
 *   `walking_is_measured_not_abbreviated:<log>`   every examined `BRIDGE_FACT` lands in exactly one named bucket, so
 *       `unplaced 0` can only be printed when every fact stated a body position. A log with no body position is
 *       BLOCKED, never `walked 0`.
 *
 * THE THREE ZEROES. A missing log file is BLOCKED by name (exit 2) when the caller named one; with no argument at all the
 * run prints `run_walking_log_skipped: <what it did not read>` and exits 0, because this is a post-run reading and a
 * commit cannot be failed for a log that does not exist yet - CI reads that marker as `not_measured`, never as a pass.
 *
 * Usage:
 *   node tools/check-run-walking.mjs                        # the skip marker
 *   node tools/check-run-walking.mjs --log <path>           # the walking reading of one run's log
 *   node tools/check-run-walking.mjs --log <path> --expect walked=647,positioned=37,longest=81,perAction=38
 *                                                           # assert the known answer for a real run (a history pin)
 *
 * red-proof: history  `--log tools/fixtures/declared-deleted/round66-facts.runner-log` -> `walked 647 tiles · positioned
 *                     events 37 · tiles per action 38 (17 world-changing actions) · longest walk 81` and `straight-line
 *                     bound 163` (`tools/check-run-walking.test.mjs`, against the hand count: the three crops walk 13 and
 *                     their tree is 8).
 * red-proof: inject   a fact stream whose body positions are stripped -> `walking_nothing_to_place` BLOCKED, exit 2; the
 *                     same stream with one `target_reached` restored is measured.
 * red-proof: inject   a renderer that drops `longest walk` -> `a_run_does_not_report_its_walking:longest`, by name.
 */

export const gateDeclaration = {
  id: "check-run-walking",
  domain: "data",
  tier: "l0",
  kind: "contract",
};

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WALKING_READINGS,
  auditWalkingAccount,
  auditWalkingMeasurement,
  readWalking,
  renderWalking,
} from "../../tools/lib/walking.mjs";

const SKIP_MARKER = "run_walking_log_skipped";

function argumentsOf(argv) {
  const options = { log: null, expect: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--log") options.log = argv[(index += 1)] ?? null;
    else if (name === "--expect") options.expect = argv[(index += 1)] ?? null;
    else throw new Error(`unknown argument ${name}`);
  }
  return options;
}

/** `<id>=<number>` pairs, keyed by the stable reading id, so a pin names a reading and not a printed label. */
function pinsFrom(text) {
  const pins = new Map();
  for (const part of String(text).split(",")) {
    const [id, value] = part.split("=");
    if (id === undefined || value === undefined || !Number.isFinite(Number(value))) {
      throw new Error(`--expect takes id=number pairs, got ${part}`);
    }
    const declared = WALKING_READINGS.find((reading) => reading.id === id);
    if (declared === undefined) {
      throw new Error(`--expect ${id} is not a declared reading: ${WALKING_READINGS.map((r) => r.id).join(", ")}`);
    }
    pins.set(declared.id, Number(value));
  }
  return pins;
}

/** The number a pin is compared to: `tiles per action` is a quotient and is printed rounded, so it is pinned rounded. */
function valueOf(record, id) {
  if (id === "perAction") return record.perAction === null ? null : Math.round(record.perAction);
  return record[id];
}

function main(argv) {
  const options = argumentsOf(argv);
  if (options.log === null) {
    process.stdout.write(`${SKIP_MARKER}: no --log given, so no run's walking was read\n`);
    return 0;
  }
  const path = resolve(options.log);
  if (!existsSync(path) || statSync(path).isDirectory()) {
    process.stdout.write(`✖ walking_not_measured:${options.log} · the path is not a readable log\nverdict: BLOCKED\n`);
    return 2;
  }
  const record = readWalking(readFileSync(path, "utf8"), { source: options.log });
  const measurement = auditWalkingMeasurement(record, options.log);
  if (measurement.verdict === "blocked") {
    for (const finding of measurement.findings) process.stdout.write(`✖ ${finding.code} · ${finding.detail}\n`);
    process.stdout.write(`verdict: BLOCKED · ${measurement.code}\n`);
    return 2;
  }
  const rendered = renderWalking(record);
  process.stdout.write(`${rendered}\n`);

  const findings = [...auditWalkingAccount(rendered), ...measurement.findings];

  if (options.expect !== null) {
    for (const [id, expected] of pinsFrom(options.expect)) {
      const actual = valueOf(record, id);
      if (actual !== expected) {
        const field = WALKING_READINGS.find((reading) => reading.id === id).field;
        findings.push({
          code: `run_walking_reading_disagrees:${id}`,
          detail: `the log reads \`${field} ${String(actual)}\` and the pin says ${String(expected)}`,
        });
      }
    }
  }

  for (const finding of findings) process.stdout.write(`✖ ${finding.code} · ${finding.detail}\n`);

  if (findings.length > 0) {
    process.stdout.write("verdict: FINDING\n");
    return 1;
  }
  process.stdout.write(
    `verdict: measured · ${String(record.examined)} facts examined · ${String(record.positions.length)} positions\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`✖ run_walking_usage:${error.message}\nverdict: BLOCKED\n`);
    process.exitCode = 2;
  }
}

export { main };
