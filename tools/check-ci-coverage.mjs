#!/usr/bin/env node
/**
 * CI coverage gate: a gate script either runs in a workflow, runs in the `gates` job derived here,
 * or is registered below with a reason.
 *
 * The gate set is read from package.json by name - `check:*`, `audit:*`, `report:*`, `lint*`,
 * `typecheck*`, `format:check`, `dependency-audit` - so a new gate is a candidate by being named
 * like one, and no second list has to be kept in step with it. `test:*` scripts are not this gate's
 * business: `tools/run-tool-test-corpus.mjs` derives those from the same file.
 *
 * Coverage is a workflow file, never an aggregate script: `quality:check` names gates that no job
 * runs, which is the drift this gate exists to stop (design/research/system-reflection-build.md,
 * finding 2). A step covers a script when it names the script or names the file its command runs.
 * YAML comments are stripped first, so a step discussed in prose does not read as a step.
 *
 * The derived set is what the workflows do not already run. It is install-free by construction -
 * the job that runs it installs nothing - so a gate needing the installed workspace, the game, the
 * decompiled tree, the `design/` mount or a built generation is registered with that reason
 * instead of being silently absent.
 *
 * A GATE THAT MEASURED NOTHING IS NOT A GATE THAT PASSED, and an exit code cannot tell the two
 * apart: a gate whose measurement was unavailable on this machine exits 0 on purpose -
 * `check-perf-budget` on a box that did not record the baseline prints `perf_budget_skipped: ...`
 * and passes, because a per-op cost describes the machine as much as the code. Counting that as a
 * pass is how a gate that has never compared anything reads as green. So the run reads the marker
 * the gate already prints: a gate that exits 0 with a `*_skipped:` line on its stdout is counted
 * `not_measured` and named in the summary, beside `passed` and `failed`. The rule is the marker,
 * not a list of gate names - a gate that starts or stops skipping moves between the counts without
 * being edited in here. Only the counts change: a skip still exits 0, because an unavailable
 * measurement is not a failure. A gate that prints the marker and then fails is a failure - the
 * marker excuses a comparison, never an exit status.
 *
 * The second shape of the same reading is a gate that PRINTS ITS OWN REPORT and examined zero objects.
 * `check:draft-declaration-coverage` printed `{"gate":"draft-declaration-coverage","status":"passed",
 * "mode":"mounted","fields":0,"declared":0}` on 2026-11-05 - a green reading with an empty population - and
 * `70d4dad8` found the same hole in a capture phase that printed `DONE-CAPTURE failed=0 of 20 (skipped=0)`
 * above evidence from two days earlier. So the last report a gate prints is judged by
 * `tools/lib/assert-non-vacuous.mjs`: a zero under `population`, `fields` or `cases`, beside the gate id that
 * makes the line a report, is `measured_nothing` - named `gate_measured_nothing:<gate>:<field>` - and fails
 * the run. A report that states `allowEmpty: "<why zero is healthy>"` is counted `not_measured` instead: an
 * empty population is still not a comparison, whatever the reason for it.
 *
 * The order these are read in is the rule: exit status first, then the skip marker, then the population. A
 * marker excuses a comparison and never an exit status, and a population never renames a failure.
 *
 *   node tools/check-ci-coverage.mjs          # the verdict; exit 1 on a stale or unreasoned entry
 *   node tools/check-ci-coverage.mjs --list   # the derived set, one script name per line
 *   node tools/check-ci-coverage.mjs --run    # run that set, one named line per gate
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNonVacuous } from "./lib/assert-non-vacuous.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const GATE_TIMEOUT_MS = 10 * 60_000;

const GATE_NAME = /^(?:check[:-]|audit:|report:|format:check$|dependency-audit$|lint(?::|$)|typecheck(?::|$))/u;
const SCRIPT_PATH = /[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|cjs|js|ts|ps1)/gu;

/**
 * How a gate says it measured nothing: a whole line whose marker ends in `_skipped`, as in
 * `perf_budget_skipped: baseline recorded on <recorded>, measured on <current>`. The convention is
 * the marker and its position, not who prints it, so this set is whatever the gates report and no
 * name has to be kept in step with it.
 */
const SKIP_MARKER = /^[a-z][a-z0-9_]*_skipped:/mu;

/**
 * What a terminal reporter uses to rewrite its own progress line: cursor up, erase line, colour. `trim()`
 * strips whitespace, not control sequences, so a line that arrived as `ESC[1A ESC[2Kperf_budget_skipped:`
 * would be read as neither a marker nor a report (2026-11-05, `3005803c`).
 */
const OUTPUT_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/gu;

/** Why a gate that exists does not run on a fresh checkout. */
const REASONS = new Map([
  ["arguments", "reads caller-supplied inputs and refuses to run without them, so it is a verifier, not a job step"],
  [
    "environment",
    "needs an input a hosted checkout has not got: the licensed game, the decompiled tree, the design/ mount, run artifacts or a built generation",
  ],
  ["installed", "needs the installed workspace (a devDependency binary or a TypeScript import the install provides)"],
  ["debt", "a standalone gate that is red at HEAD: adopting it needs the fix, not the wiring"],
  ["superseded", "the same checks run through another script or job"],
]);

const REGISTER = Object.freeze([
  {
    script: "check:architecture",
    reason: "superseded",
    detail:
      "every member also runs on its own ci.yml step (check:publint, report:clones, check:knip, check:host-module-graph, check:host-production-import-boundary); this script only repeats them locally",
  },
  {
    script: "typecheck:voice-protocol",
    reason: "superseded",
    detail: "the voice-gateway job already runs pi-koe's own `pnpm run typecheck`, which covers the protocol package",
  },
  {
    script: "check:gameplay-capability-catalog",
    reason: "environment",
    detail: "reads design/gameplay-capability-catalog.json from the design/ mount",
  },
  {
    script: "check:tavern-references",
    reason: "environment",
    detail: "reads design/references/tavern/st-semantic-references-v1.json; measured ENOENT on a checkout",
  },
  {
    script: "check:stardew-loop-closure",
    reason: "environment",
    detail: "measured stardew_decompile_root_missing: ref/external/StardewValleyDecompiled is gitignored",
  },
  {
    script: "check:stardew-native-notice-coverage",
    reason: "environment",
    detail: "counts call sites in the gitignored decompiled tree; a checkout reports 0 files and fails",
  },
  {
    script: "check:live-run-isolation",
    reason: "environment",
    detail:
      "builds lanes from %LOCALAPPDATA%/GameBuddy/stardew-profiles/native-local-stable and the Steam install at D:/Steam/...; a checkout has neither, so it exits 1 with live_run_isolation_source_profile_config_missing, measured native_local_fixture_path_missing when the release build is absent too",
  },
  {
    script: "check:stardew-native-multiplayer-sensitivity",
    reason: "environment",
    detail: "reads the gitignored decompiled tree; it also reports 2 seam-call mismatches where the tree exists",
  },
  {
    script: "check:live-run-artifact-freshness",
    reason: "environment",
    detail: "compares live-run outputs against source age; there is no run to judge on a push",
  },
  {
    script: "check:production-pack-load",
    reason: "environment",
    detail: "measured pointer_missing: host/dist/current.json, a generation only the release lane assembles",
  },
  {
    script: "check:tavern-release-prerequisites",
    reason: "environment",
    detail: "needs live provider turns and an assembled generation; exits 2 (blocked) without them",
  },
  {
    script: "audit:chat-live-run",
    reason: "arguments",
    detail: "requires --audit <path> to an existing chat live-run directory",
  },
  { script: "audit:stardew-action-seam-terminals", reason: "arguments", detail: "requires --candidates" },
  { script: "report:stardew-remaining-actions", reason: "arguments", detail: "requires --candidates" },
  {
    script: "check:live-run-preflight",
    reason: "arguments",
    detail: "requires --mods-path (measured preflight_missing_argument:--mods-path)",
  },
  {
    script: "check:stardew-companion-production-admission",
    reason: "arguments",
    detail: "reports admission_cli_required_flag_missing without a caller's evidence paths",
  },
  {
    script: "check:stardew-gameplay-completeness",
    reason: "arguments",
    detail: "requires --report <direct-inspector-report.json>",
  },
  {
    script: "check:stardew-execution-terminal-uniqueness",
    reason: "arguments",
    detail:
      "requires --artifact <path> to one finished run's receipt reading (the frames its fact listeners emitted and the answers its caller received), so there is nothing to compare before a run exists",
  },
  {
    script: "check:stardew-native-mechanism-review-register",
    reason: "arguments",
    detail: "requires --mechanism-report, --register and --source-root",
  },
  {
    script: "check:stardew-native-normal-player-ingress-register",
    reason: "arguments",
    detail: "requires --register, --mechanism-report and --source-root",
  },
  {
    script: "check:stardew-native-router-exit-classifier",
    reason: "arguments",
    detail: "requires --inventory and --classifier",
  },
  {
    script: "check:stardew-native-source-closure",
    reason: "arguments",
    detail: "requires a certificate, universe, boundary model, source root, assembly and content manifest",
  },
  {
    script: "check:stardew-native-transition-ledger",
    reason: "arguments",
    detail: "requires a ledger, mechanism report, review register, scope manifest and source root",
  },
  {
    script: "check:text-hygiene",
    reason: "debt",
    detail: "measured red at HEAD: committed C# files under desktop/ are missing a final newline",
  },
  {
    script: "check:tools-boundaries",
    reason: "debt",
    detail: "measured 37 dependency violations (25 errors) over tools/ at HEAD",
  },
  {
    script: "check:scope-references",
    reason: "debt",
    detail: "measured 4 findings (3 out_of_scope_reference, 1 read_before_declaration) over 731 files at HEAD",
  },
  { script: "lint:eslint", reason: "debt", detail: "measured 11 errors in dialogue-web/src at HEAD" },
  {
    script: "check:sandbox-acceptance",
    reason: "arguments",
    detail:
      "needs `--setup <path>` pointing at an assembled GameBuddy.Setup.exe (447 MB, built by build:player-distribution); a fresh checkout has no such artifact, so it exits 1 with setup_path_required",
  },
]);

function readScripts(root) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
}

/** A `#` comment is a YAML comment only at line start or after whitespace. */
function stripYamlComments(text) {
  return text
    .split("\n")
    .map((line) => (/^\s*#/u.test(line) ? "" : line.replace(/\s#.*$/u, "")))
    .join("\n");
}

function workflowText(root) {
  const dir = resolve(root, WORKFLOW_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => readFileSync(resolve(dir, name), "utf8"))
    .join("\n");
}

function workflowTokens(text) {
  return new Set(
    stripYamlComments(text)
      .split(/[^A-Za-z0-9_.@:/-]+/u)
      .filter((token) => token !== ""),
  );
}

function entryFiles(command) {
  return command.match(SCRIPT_PATH) ?? [];
}

/**
 * Split the gate scripts into what a workflow runs, what the derived job must run, and what is
 * registered, and report every register entry that no longer earns its place.
 */
export function deriveCiCoverage({ scripts, workflowText: text, register = REGISTER }) {
  const tokens = workflowTokens(text);
  const gateScripts = Object.keys(scripts)
    .filter((name) => GATE_NAME.test(name))
    .sort();
  const runsInWorkflow = (name) => tokens.has(name) || entryFiles(scripts[name] ?? "").some((path) => tokens.has(path));
  const registered = new Map(register.map((entry) => [entry.script, entry]));
  const workflow = [];
  const derived = [];
  for (const name of gateScripts) {
    if (registered.has(name)) continue;
    (runsInWorkflow(name) ? workflow : derived).push(name);
  }
  const problems = [];
  // A register that names one script twice reports one gate more than it registers: `registered` collapses the pair,
  // so the printed count and the derived set disagree and neither of them says so. Measured 2026-11-13:
  // `check:live-run-isolation` was listed at :124 and at :140, and `registered=29` described 28 gates.
  const listed = new Set();
  for (const entry of register) {
    if (listed.has(entry.script)) problems.push({ code: "register_duplicated", script: entry.script });
    listed.add(entry.script);
  }
  for (const entry of register) {
    const known = gateScripts.includes(entry.script);
    if (!known) problems.push({ code: "register_stale", script: entry.script });
    else if (runsInWorkflow(entry.script)) problems.push({ code: "register_redundant", script: entry.script });
    else if (!REASONS.has(entry.reason))
      problems.push({ code: "register_unreasoned", script: entry.script, detail: entry.reason });
    else if (typeof entry.detail !== "string" || entry.detail.trim() === "") {
      problems.push({ code: "register_undetailed", script: entry.script });
    }
  }
  // The derived half only exists if a workflow runs it; without that step every script in it runs
  // nowhere, which is exactly the state this gate is meant to make impossible.
  const runnerWired = tokens.has("--run") && tokens.has("tools/check-ci-coverage.mjs");
  if (!runnerWired) problems.push({ code: "runner_unwired", script: "tools/check-ci-coverage.mjs --run" });
  return { gateScripts, workflow, derived, register, problems, runnerWired };
}

function report(coverage) {
  const byReason = [...REASONS.keys()]
    .map((reason) => [reason, coverage.register.filter((entry) => entry.reason === reason).length])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  process.stdout.write(
    `ci_coverage gate_scripts=${coverage.gateScripts.length} workflow=${coverage.workflow.length} ` +
      `gates_job=${coverage.derived.length} registered=${coverage.register.length}` +
      `${byReason === "" ? "" : ` (${byReason})`}\n`,
  );
  for (const problem of coverage.problems) {
    switch (problem.code) {
      case "register_stale":
        process.stderr.write(`ci_coverage_register_stale:${problem.script} is not a gate script; delete the entry\n`);
        break;
      case "register_redundant":
        process.stderr.write(
          `ci_coverage_register_redundant:${problem.script} runs in a workflow now; delete the entry\n`,
        );
        break;
      case "register_unreasoned":
        process.stderr.write(
          `ci_coverage_register_unreasoned:${problem.script}:${problem.detail} must name one of ${[...REASONS.keys()].join("|")}\n`,
        );
        break;
      case "register_undetailed":
        process.stderr.write(`ci_coverage_register_undetailed:${problem.script} must say why, with the measurement\n`);
        break;
      case "register_duplicated":
        process.stderr.write(
          `ci_coverage_register_duplicated:${problem.script} is listed twice, so registered= counts a gate that is not there\n`,
        );
        break;
      default:
        process.stderr.write(
          `ci_coverage_runner_unwired:no workflow step runs \`node tools/check-ci-coverage.mjs --run\`, so ${coverage.derived.length} gates run nowhere\n`,
        );
    }
  }
  return coverage.problems.length === 0 ? 0 : 1;
}

/** A gate's output as lines, through the reporter's escapes and its carriage returns. */
function gateLines(stdout) {
  return String(stdout)
    .replace(OUTPUT_ESCAPE, "")
    .split(/\r\n|\r|\n/u);
}

/**
 * The last line a gate printed as a JSON object naming its own id: the gate's report, when it printed one.
 * `gate` is what makes a line a report rather than a number some other JSON line happened to carry.
 */
function gateReport(stdout) {
  let report = null;
  for (const line of gateLines(stdout)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed?.gate === "string") report = parsed;
  }
  return report;
}

/**
 * How one gate's run counts, with its evidence: `failed` for any non-zero exit or a timeout, `not_measured`
 * for a clean exit whose output says the measurement did not happen - by the skip marker or by a report that
 * allowed its own empty population - `measured_nothing` for a clean exit whose report measured zero objects,
 * `passed` otherwise. The skip marker is read after the exit status, so a gate that names a skip and then
 * fails is a failure; the population is read last, so it can neither excuse a failure nor rename one. A
 * `passed` gate whose report was read says what it examined, which is the number the verdict rests on.
 */
function gateOutcome({ status, timedOut, stdout }) {
  if (timedOut || status !== 0) return { outcome: "failed", detail: `failed:${timedOut ? "timeout" : String(status)}` };
  if (gateLines(stdout).some((line) => SKIP_MARKER.test(line)))
    return { outcome: "not_measured", detail: "not_measured" };
  const verdict = assertNonVacuous(gateReport(stdout));
  if (verdict === null) return { outcome: "passed", detail: "passed" };
  if (verdict.status === "blocked") return { outcome: "measured_nothing", detail: verdict.detail };
  if (verdict.status === "not_measured") return { outcome: "not_measured", detail: verdict.detail };
  return { outcome: "passed", detail: `passed ${verdict.detail}` };
}

/** One gate, with its stdout tee'd to `out`: the aggregate has to read what the gate printed. */
function spawnGate(command, out) {
  return new Promise((settle) => {
    const child = spawn(command, { cwd: ROOT, shell: true, stdio: ["inherit", "pipe", "inherit"] });
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      out.write(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GATE_TIMEOUT_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      settle({ status, timedOut, stdout });
    });
  });
}

export async function runGates(names, scripts, out = process.stdout) {
  const passed = [];
  const failed = [];
  const notMeasured = [];
  const measuredNothing = [];
  const started = Date.now();
  for (const name of names) {
    out.write(`ci_gate:${name}:start\n`);
    const began = Date.now();
    const result = await spawnGate(scripts[name], out);
    const seconds = Math.round((Date.now() - began) / 1000);
    const { outcome, detail } = gateOutcome(result);
    if (outcome === "passed") passed.push(name);
    if (outcome === "not_measured") notMeasured.push(name);
    if (outcome === "failed") failed.push(name);
    if (outcome === "measured_nothing") measuredNothing.push(name);
    out.write(`ci_gate:${name}:${detail}:${seconds}s\n`);
  }
  out.write(
    `ci_gates_run total=${names.length} passed=${passed.length} failed=${failed.length} ` +
      `not_measured=${notMeasured.length} measured_nothing=${measuredNothing.length} ` +
      `${Math.round((Date.now() - started) / 1000)}s` +
      `${failed.length === 0 ? "" : ` failing=${failed.join(",")}`}` +
      `${notMeasured.length === 0 ? "" : ` not_measured_gates=${notMeasured.join(",")}`}` +
      `${measuredNothing.length === 0 ? "" : ` measured_nothing_gates=${measuredNothing.join(",")}`}\n`,
  );
  return failed.length === 0 && measuredNothing.length === 0 ? 0 : 1;
}

async function main(argv) {
  const scripts = readScripts(ROOT);
  const coverage = deriveCiCoverage({ scripts, workflowText: workflowText(ROOT) });
  if (argv.includes("--list")) {
    for (const name of coverage.derived) process.stdout.write(`${name}\n`);
    return 0;
  }
  if (argv.includes("--run")) return runGates(coverage.derived, scripts);
  return report(coverage);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
