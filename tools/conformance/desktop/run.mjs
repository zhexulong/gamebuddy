#!/usr/bin/env node
/**
 * The language-neutral conformance suite for the installed Desktop launcher.
 *
 * WHAT IT PROVES. The launcher is a process that publishes a wire: a named pipe for the
 * authenticated Host session, a named pipe for the one presentation entry, an inherited
 * controller channel, a declared environment block, records under its operational root, and one
 * bounded code on standard error. Every case here drives the REAL executable as a Host peer and
 * asserts on those facts. Nothing reads the C# sources, imports a product type or sets a test
 * hook, so "is the rewrite equivalent" is answered by pointing `--binary` at the rewrite.
 *
 * WHY THE MEDIA IS THE HARNESS'S. The generation the launcher admits is install media, not
 * product behaviour: the suite installs it (or takes one a publisher already installed, through
 * the same door the product's own desktop tests use), replaces the generation's bootstrap entry
 * with its own Host peer, and rewrites the two digests that name that entry. The launcher's own
 * admission is what validates the result, so a media layout that drifts from the product's
 * contract fails here by name instead of passing quietly.
 *
 * THREE VERDICTS, NOT TWO, and the third is named rather than folded into a pass: a case whose
 * subject the product does not offer is `skipped`, printed with the code that says why, counted
 * separately, and never allowed to make this run green. A run that measured nothing at all is a
 * refusal (exit 2), because a suite with no population agrees with itself.
 *
 * USAGE
 *   node tools/conformance/desktop/run.mjs                  # every case
 *   node tools/conformance/desktop/run.mjs --case frame-cap # one case, by id
 *   node tools/conformance/desktop/run.mjs --binary <exe>   # another launcher (the rewrite)
 *   node tools/conformance/desktop/run.mjs --keep           # leave the world for inspection
 *   node tools/conformance/desktop/run.mjs --list           # the suite list, and nothing else
 *
 * EXIT STATUS
 *   0  every case passed
 *   1  a case failed, was skipped, or a process this suite started survived it - the finding names which
 *   2  nothing was measured: a prerequisite is absent, named, and the suite refuses to pass
 *
 * ENVIRONMENT
 *   GAMEBUDDY_DESKTOP_TEST_GENERATION_ROOT        a published generation to install (CI's door)
 *   GAMEBUDDY_DESKTOP_CONFORMANCE_BINARY          the launcher executable to drive
 *   GAMEBUDDY_DESKTOP_CONFORMANCE_TEMP            where the publish and the world live
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { cases } from "./cases.mjs";
import { Blocked, isRunning, killExactProcess, prepareWorld, startedProcessLedger } from "./world.mjs";

const TEMP_ROOT = process.env.GAMEBUDDY_DESKTOP_CONFORMANCE_TEMP ?? "D:\\gamebuddy-conformance";

function parseArguments(argv) {
  const options = { caseIds: [], binary: null, keep: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--case") options.caseIds.push(argv[++index]);
    else if (argument === "--binary") options.binary = argv[++index];
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--list") options.list = true;
    else throw new Error(`desktop_conformance_unknown_argument:${argument}`);
  }
  return options;
}

function suiteList(selected) {
  return selected.map((entry) => entry.id).join(", ");
}

async function main(argv) {
  const options = parseArguments(argv);
  const selected = options.caseIds.length === 0 ? cases : cases.filter((entry) => options.caseIds.includes(entry.id));
  if (selected.length === 0) {
    process.stdout.write(
      `desktop_conformance_no_cases_selected: ${JSON.stringify(options.caseIds)} of ${suiteList(cases)}\n`,
    );
    return 2;
  }
  // The population, printed before anything runs: a case that never reports still appears here,
  // and a suite whose list is empty cannot be mistaken for one that measured nothing.
  process.stdout.write(`suite: ${selected.length} · ${suiteList(selected)}\n`);
  if (options.list) return 0;

  mkdirSync(TEMP_ROOT, { recursive: true });
  rmSync(join(TEMP_ROOT, "world"), { recursive: true, force: true });
  let world = null;
  try {
    world = prepareWorld({ tempRoot: TEMP_ROOT, explicitBinary: options.binary });
  } catch (error) {
    if (error instanceof Blocked) {
      process.stdout.write(`desktop_conformance_blocked: ${error.code}: ${error.detail}\n`);
      process.stdout.write(
        "desktop conformance: cases 0 · passed 0 · failed 0 · skipped 0 - nothing was measured, which is never a pass\n",
      );
      return 2;
    }
    throw error;
  }

  process.stdout.write(`launcher: ${world.binary}\n`);
  process.stdout.write(`media: ${world.media}\n`);
  process.stdout.write(`generation: ${world.generation.generationId}\n`);
  process.stdout.write(`layout: ${world.layout.operationalRoot}\n`);

  const results = [];
  let survived = 0;
  try {
    for (const entry of selected) {
      const started = Date.now();
      let outcome;
      try {
        const produced = await entry.run({ world });
        outcome = {
          id: entry.id,
          title: entry.title,
          assertions: produced.assertions,
          readings: produced.readings ?? [],
          defects: produced.defects ?? [],
          skipped: produced.skipped ?? null,
          notes: produced.notes ?? [],
        };
      } catch (error) {
        // A case that threw has no reading at all, and that is a failure with the throw in it - it
        // is never a case that quietly did not run.
        outcome = {
          id: entry.id,
          title: entry.title,
          assertions: [{ name: "case-ran", ok: false, detail: String(error?.stack ?? error) }],
          readings: [],
          defects: [],
          skipped: null,
          notes: [],
        };
      }
      outcome.elapsedMs = Date.now() - started;
      results.push(outcome);
      process.stdout.write(`${describe(outcome)}\n`);
    }
  } finally {
    // Every process this suite started, by pid AND by the instant it started: a pid alone is not a
    // process, so the ledger is what the claim "nothing was left behind" is made about. One that is
    // still running here was left by the product or by a case, and it is stopped by its exact pid.
    const leftovers = [];
    for (const entry of startedProcessLedger()) {
      if (!isRunning(entry.pid)) continue;
      const ended = killExactProcess(entry.pid);
      if (!ended) survived += 1;
      leftovers.push({ ...entry, ended });
    }
    const started = startedProcessLedger().length;
    process.stdout.write(
      `processes: ${started} started · ${started - leftovers.length} confirmed gone${leftovers.length === 0 ? "" : ` · ${leftovers.length} still running, stopped here by pid: ${JSON.stringify(leftovers)}`}${survived === 0 ? "" : ` · ${survived} SURVIVED and must be cleaned by hand`}\n`,
    );
    if (!options.keep && world !== null) world.dispose();
    else if (world !== null) process.stdout.write(`world kept at ${world.layout.programRoot}\n`);
  }

  const passed = results.filter((result) => verdict(result) === "passed").length;
  const failed = results.filter((result) => verdict(result) === "failed").length;
  const skippedResults = results.filter((result) => verdict(result) === "skipped");
  process.stdout.write(
    `desktop conformance: cases ${results.length} · passed ${passed} · failed ${failed} · skipped ${skippedResults.length}\n`,
  );
  for (const result of skippedResults) {
    process.stdout.write(`skipped ${result.id}: ${result.skipped.code}: ${result.skipped.detail}\n`);
  }
  if (survived > 0) process.stdout.write(`desktop_conformance_process_survived: ${survived}\n`);
  if (results.length === 0) {
    process.stdout.write("desktop_conformance_no_population: nothing was measured, which is never a pass\n");
    return 2;
  }
  return failed === 0 && skippedResults.length === 0 && survived === 0 ? 0 : 1;
}

function verdict(outcome) {
  if (outcome.skipped !== null) return "skipped";
  return outcome.assertions.every((assertion) => assertion.ok) ? "passed" : "failed";
}

function describe(outcome) {
  const lines = [`case ${outcome.id}: ${verdict(outcome)} (${outcome.elapsedMs} ms) - ${outcome.title}`];
  for (const assertion of outcome.assertions) {
    lines.push(`  assertion ${assertion.name}: ${assertion.ok ? "passed" : "FAILED"} - ${assertion.detail}`);
  }
  for (const reading of outcome.readings) lines.push(`  reading ${reading.name}: ${reading.detail}`);
  for (const defect of outcome.defects) lines.push(`  defect ${defect.id}: ${defect.detail}`);
  for (const note of outcome.notes) lines.push(`  note: ${note}`);
  if (outcome.skipped !== null) lines.push(`  skipped ${outcome.skipped.code}: ${outcome.skipped.detail}`);
  return lines.join("\n");
}

process.exitCode = await main(process.argv.slice(2));
