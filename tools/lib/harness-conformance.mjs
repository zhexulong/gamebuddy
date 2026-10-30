/**
 * Harness conformance: the static wiring facts that ended live runs before a game process existed,
 * checked from the file system in seconds.
 *
 * Every failure this covers was already knowable offline - the same class the run preflight,
 * `tools/lib/live-run-preflight.mjs`, reads from a tree. This module does not touch a game, a live run,
 * or the network: it imports the real preflight, the real fixture library, the real runner resolver and
 * the real descriptor tables, and checks them against synthetic trees and the repository's own sources.
 *
 * Five checks, each returning a list of findings (empty = conformant):
 *
 *   1. `checkLiveRunPreflight`      - `preflightLiveRun` passes a GOOD synthetic tree and fails with the
 *                                     RIGHT code on each BAD tree it must catch.
 *   2. `checkScenarioAcceptance`    - every harness action's world is a scenario name the Mod's own
 *                                     fixture switch accepts, read from every `ModEntry.Fixtures*.cs`.
 *   3. `checkRunnerResolution`      - every action's resolved runner exists and imports without starting a session.
 *   4. `checkExperimentalRunners`   - every `STARDEW_EXPERIMENTAL_ACTION_RUNNERS` runner exists on disk.
 *   5. `checkGateFalsifiers`        - every `tools/check-*.mjs` gate either prints a self-verification report in its
 *                                     own default run or is declared in `GATES_WITHOUT_FALSIFIER` with a reason.
 *
 * Checks 3 and 5 ask questions about what code DOES, so they run it and read the result: check 3 imports the runner,
 * check 5 runs the gate and reads the report it prints. Reading the source text for the words `import.meta.main` or
 * `checks` answers a different question - a comment satisfies either one - which is why neither is matched here.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { resolveStardewActionGateRunner } from "../resolve-stardew-action-gate-runner.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "../stardew-action-gate-descriptors.mjs";
import { importsWithoutStarting, preflightLiveRun } from "./live-run-preflight.mjs";
import { fixtureActions, fixtureScenario } from "./stardew-native-local-player-fixture.mjs";
import { STARDEW_MOD_FOLDER } from "./stardew-mod-folder.mjs";

const finding = (code, detail) => ({ code, detail });

/** Actions whose scenario/runner wiring decides whether a harness run can start at all. */
const HARNESS_ACTIONS = Object.freeze([
  "respond_level_up",
  "respond_level_up_branch",
  "hold_absorption",
  "till_soil",
  "multi_day",
]);

/** A scenario name the Mod's fixture code names literally, e.g. `native_till_soil_v1`. */
const NATIVE_SCENARIO = /"(native_[a-z0-9_]+_v\d+)"/u;

/**
 * Every `native_*_vN` string the Mod's fixture code names, as `name -> <file>:<line>`.
 *
 * `ModEntry` is a partial class, so the fixture switch is spread over all `ModEntry.Fixtures*.cs` files: one
 * `FixtureScenario is not (...)` pre-attachment allowlist plus the `FixtureScenario == "..."` / `is "..."`
 * dispatch blocks that build each world. A scenario named by neither is refused before it can arm, which is the
 * silent failure this check exists to catch. Composed names are not a thing here: the switch compares literals.
 */
function scenariosAcceptedByMod(modSources) {
  const accepted = new Map();
  for (const { file, source } of modSources) {
    source.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(new RegExp(NATIVE_SCENARIO.source, "gu"))) {
        if (!accepted.has(match[1])) accepted.set(match[1], `${file}:${index + 1}`);
      }
    });
  }
  return accepted;
}

/** The world each published gate arms, keyed by action id: the run plan's own record of its fixture scenario. */
const PUBLISHED_FIXTURE_SCENARIOS = new Map(
  STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario !== null).map((gate) => [
    gate.actionId,
    gate.fixtureScenario,
  ]),
);

// ---------------------------------------------------------------------------------------------------
// Check 1: the run preflight catches each failure on a synthetic tree, and passes a good one.
// ---------------------------------------------------------------------------------------------------

const SECONDS = 1000;
const T_INPUT = new Date(Date.now() - 20 * SECONDS);
const T_OUTPUT = new Date(Date.now() - 10 * SECONDS);
const T_STALE = new Date(Date.now() - 60 * SECONDS);

const touch = (path, mtime) => utimesSync(path, mtime, mtime);
const write = (path, contents, mtime) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  if (mtime !== undefined) touch(path, mtime);
};

/**
 * Materialize one synthetic run tree and return the `preflightLiveRun` options for it.
 *
 * Each variant is the GOOD tree plus exactly one defect, so the preflight's FIRST failure names the defect.
 */
function materializePreflightTree(baseDir, variant) {
  const hostRoot = join(baseDir, "host");
  const modRoot = join(baseDir, "mod");
  const modsPath = join(baseDir, "mods");
  const releaseDir = join(baseDir, "release");
  const fixtureRoot = join(baseDir, "fixtures");
  const saveName = "GameBuddyFixtureHarness";

  write(join(hostRoot, "src", "main.ts"), "// input\n", T_INPUT);
  write(join(hostRoot, "dist-test", "main.js"), "// artifact\n", T_OUTPUT);
  write(join(modRoot, "ModEntry.cs"), "// c# input\n", T_INPUT);
  write(join(releaseDir, "GameBuddy.Stardew.dll"), "dll", variant === "stale_mod_bundle" ? T_STALE : T_OUTPUT);
  write(join(modsPath, STARDEW_MOD_FOLDER, "config.json"), JSON.stringify({ PipeName: "GameBuddyHarnessConformance" }));
  if (variant === "two_mod_folders") mkdirSync(join(modsPath, "GameBuddy.NativeLocalPlayer"), { recursive: true });

  if (variant !== "missing_fixture_template") {
    mkdirSync(join(fixtureRoot, "templates", saveName), { recursive: true });
  }
  if (variant === "held_fixture_lock") {
    write(join(fixtureRoot, ".stardew-native-local-player-fixture.lock"), "held\n");
  }
  if (variant === "orphaned_fixture_entry") {
    write(join(fixtureRoot, "GameBuddyFixtureHarness.orphaned-1234"), "backup\n");
  }

  return { modsPath, releaseDir, fixtureRoot, saveName, hostRoot, modRoot };
}

/**
 * Run `preflightLiveRun` over a GOOD tree and each BAD tree, and require the FIRST failure to name the
 * defect. A preflight that misses a tree (or names the wrong code) is the finding.
 */
export function checkLiveRunPreflight({ preflight = preflightLiveRun, baseDir } = {}) {
  const root = baseDir ?? mkdtempSync(join(tmpdir(), "harness-conformance-"));
  const trees = [
    { variant: "good", expect: null },
    { variant: "two_mod_folders", expect: "mods_path_exactly_one_gamebuddy" },
    { variant: "stale_mod_bundle", expect: "mod_bundle_fresh" },
    { variant: "missing_fixture_template", expect: "fixture_template_present" },
    { variant: "held_fixture_lock", expect: "fixture_lock_free" },
    { variant: "orphaned_fixture_entry", expect: "fixture_root_has_no_orphan_backups" },
  ];
  const findings = [];
  try {
    for (const { variant, expect } of trees) {
      const options = materializePreflightTree(join(root, variant), variant);
      const result = preflight(options);
      const first = result.firstFailure ?? null;
      if (expect === null) {
        if (!result.ok || first !== null) {
          findings.push(finding("preflight_rejected_a_good_tree", `${variant}: ${first?.code ?? "not ok"}`));
        }
      } else if (result.ok) {
        findings.push(finding("preflight_missed_a_bad_tree", `${variant}: expected ${expect}, preflight passed`));
      } else if (first?.code !== expect) {
        findings.push(finding("preflight_named_the_wrong_code", `${variant}: expected ${expect}, got ${first?.code}`));
      }
    }
  } finally {
    if (baseDir === undefined) rmSync(root, { recursive: true, force: true });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------
// Check 2: the scenario every harness action maps to is one the Mod's fixture switch accepts.
// ---------------------------------------------------------------------------------------------------

/**
 * Require every harness action's world to be one the Mod's fixture switch accepts.
 *
 * The authority is the fixture library's own mapping, `fixtureScenario(fixtureActions(id), id)` - what
 * `prepare-stardew-native-local-player-fixture.mjs` writes into the Mod config for that fixture key. That name
 * must be one the switch accepts; nothing substitutes for it.
 *
 * The published action's run-plan record, `STARDEW_PUBLISHED_ACTION_GATES[].fixtureScenario`, is a SECOND
 * authority for the same fact: it names the world a gate is launched against (`launch-ladder-live.mjs --action
 * play_session_multi_day` for `multiday_routine`, whose required scenario is `native_multi_day_play_session_v1`).
 * A second authority cannot rescue the first: where the run plan records a different, accepted world while the
 * derive path names one the switch does not, that disagreement is the finding - not a passing substitute. The run
 * plan's value is only ever reported beside the fixture library's own mapping, never used in its place.
 */
export function checkScenarioAcceptance({
  modSources,
  fixture = { actions: fixtureActions, scenario: fixtureScenario },
  publishedScenarios = PUBLISHED_FIXTURE_SCENARIOS,
  actionIds = HARNESS_ACTIONS,
} = {}) {
  const accepted = scenariosAcceptedByMod(modSources);
  const findings = [];
  for (const actionId of actionIds) {
    let armed;
    try {
      armed = fixture.scenario(fixture.actions(actionId), actionId);
    } catch (error) {
      findings.push(finding("scenario_unresolved", `${actionId}: ${String(error?.message ?? error)}`));
      continue;
    }
    if (typeof armed !== "string" || armed.length === 0) {
      findings.push(finding("scenario_unresolved", `${actionId}: empty scenario`));
      continue;
    }
    if (accepted.has(armed)) continue;
    const planned = publishedScenarios.get(actionId) ?? null;
    const disagreement =
      planned !== null && planned !== armed
        ? `; the run plan records ${planned}, a second authority for the same fact that disagrees and cannot ` +
          "substitute for it"
        : "";
    findings.push(
      finding(
        "scenario_not_accepted_by_mod",
        `${actionId}: the fixture derive path names ${armed}, which is not among the ${String(accepted.size)} ` +
          `scenarios named under integrations/stardew/ModEntry.Fixtures*.cs${disagreement}`,
      ),
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------
// Check 3: each action resolves to an existing runner that refuses to start on import.
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// Check 3: each action resolves to an existing runner that starts nothing when it is imported.
// ---------------------------------------------------------------------------------------------------

export function checkRunnerResolution({
  actionIds = HARNESS_ACTIONS,
  resolve = resolveStardewActionGateRunner,
  toolsDir,
  exists = existsSync,
  probe = importsWithoutStarting,
} = {}) {
  const findings = [];
  for (const actionId of actionIds) {
    let runner;
    try {
      runner = resolve(actionId);
    } catch (error) {
      findings.push(finding("runner_unresolved", `${actionId}: ${String(error?.message ?? error)}`));
      continue;
    }
    const path = join(toolsDir, runner);
    if (!exists(path)) {
      findings.push(finding("runner_not_found", `${actionId} -> ${runner}`));
      continue;
    }
    const imported = probe(path);
    if (!imported.ok)
      findings.push(
        finding(
          // The probe imports the runner for real, so its failure modes are not one thing. A missing test
          // artifact and a missing dependency both surface here, and reporting either as a missing CLI sends
          // whoever reads it to the wrong file: the artifact is a build step, the CLI is an install step.
          /artifact_missing|artifact_older_than_inputs|live_run_artifact_stale/u.test(String(imported.detail))
            ? "runner_artifact_not_built"
            : /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/u.test(String(imported.detail))
              ? "runner_missing_cli"
              : "runner_import_failed",
          `${actionId} -> ${runner}: ${imported.detail}`,
        ),
      );
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------
// Check 4: every experimental runner the descriptor table names exists on disk.
// ---------------------------------------------------------------------------------------------------

export function checkExperimentalRunners({
  runners = STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  toolsDir,
  exists = existsSync,
} = {}) {
  const findings = [];
  for (const [actionId, runner] of Object.entries(runners)) {
    if (!exists(join(toolsDir, runner)))
      findings.push(finding("experimental_runner_missing", `${actionId} -> ${runner}`));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------
// Check 5: every gate prints a self-verification report in its own default run, or is declared below.
// ---------------------------------------------------------------------------------------------------

/**
 * Gates whose default (offline) run emits a self-verification report - a JSON object carrying a per-check
 * or per-rule outcome list - i.e. it enumerates the rules it can report red. Found by running every gate on
 * 2026-10-20; `checkGateFalsifiers` runs each of them again and reads the report it prints.
 */
const GATES_WITH_FALSIFIER = Object.freeze([
  "check-evidence-bundle.mjs",
  "check-game-context-pressure.mjs",
  "check-game-historian-rubric.mjs",
  "check-live-run-failure-dump.mjs",
  "check-live-run-multiday-baseline.mjs",
  "check-live-run-silence.mjs",
  "check-stardew-fixture-action-coverage.mjs",
  "check-stardew-native-notice-coverage.mjs",
]);

/** How long a gate's default run may take before it is reported as having printed nothing. */
const GATE_RUN_TIMEOUT_MS = 120_000;

/**
 * Run a gate the way an operator does - its own default, no-argument, offline invocation - and return what it
 * printed. The report on stdout is the artifact this suite reads; a gate's source text is not.
 */
function runGateDefault(path, { spawn = spawnSync, timeoutMs = GATE_RUN_TIMEOUT_MS } = {}) {
  const result = spawn(process.execPath, [path], { cwd: dirname(path), encoding: "utf8", timeout: timeoutMs });
  return {
    timedOut: result.error?.code === "ETIMEDOUT",
    status: result.status ?? null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/**
 * The self-verification report a gate printed, or null when it printed none.
 *
 * A report is a JSON object carrying the gate's own id and status plus the outcomes of the rules it enumerates:
 * a non-empty `checks` list, or an explicit offline `mode` for a gate whose one judgement is the whole run. A
 * gate that prints a human sentence, or nothing, has no report - whatever its source happens to mention.
 */
function selfVerificationReport(stdout) {
  const OUTCOME = new Set(["passed", "failed", "blocked"]);
  for (const line of String(stdout).split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed?.gate !== "string" || !OUTCOME.has(parsed.status)) continue;
    if (Array.isArray(parsed.checks)) {
      const outcomes = parsed.checks.filter((entry) => typeof entry?.id === "string" && OUTCOME.has(entry.status));
      if (outcomes.length > 0) return { gate: parsed.gate, status: parsed.status, rules: outcomes.length };
      continue;
    }
    if (typeof parsed.mode === "string" && parsed.mode.length > 0)
      return { gate: parsed.gate, status: parsed.status, rules: 0 };
  }
  return null;
}

/** One line naming how a gate's default run ended, for a finding about a missing report. */
function describeRun(result) {
  const cause = String(result.stderr ?? "")
    .trim()
    .split("\n")
    .find((line) => line.trim().length > 0);
  const how = result.timedOut ? "timed out" : `exit ${String(result.status)}`;
  return cause === undefined ? how : `${how}: ${cause.trim().slice(0, 200)}`;
}

/**
 * Gates that do NOT print a self-verification report in their default run. Each names why; a gate whose falsifier
 * lives in its own `check-*.test.mjs` is excused because the project rule is "the falsifier is part of the gate's own
 * test" (design/research/live-run-throughput.md, Tier 5 item 11), and the suite's own run confirms it.
 */
const GATES_WITHOUT_FALSIFIER = Object.freeze([
  {
    gate: "check-ci-coverage.mjs",
    reason:
      "compares two inventories (gate scripts vs workflow invocation); its falsifier needs synthetic inventories, which is real work rather than a flag - recorded here so the gap is visible instead of silent",
  },
  { gate: "check-chat-conversational-quality-gate.mjs", reason: "requires --transcript/--db run input" },
  {
    gate: "check-live-run-isolation.mjs",
    reason:
      "builds lanes from %LOCALAPPDATA%/GameBuddy/stardew-profiles/native-local-stable and the Steam install; on a checkout it exits 1 before printing a report, which is why it is not a gate whose default run self-verifies",
  },
  { gate: "check-commit-staging.mjs", reason: "reads the git index; no offline rule set" },
  { gate: "check-crab-pot-output-fixture-contract.mjs", reason: "requires --contract input" },
  { gate: "check-dependency-risk.mjs", reason: "static report; falsifier in check-dependency-risk.test.mjs" },
  { gate: "check-diff.mjs", reason: "runs git diff --check; no offline rule set" },
  { gate: "check-dist-runtime-exports.mjs", reason: "reads the built dist; no offline rule set" },
  { gate: "check-duplicated-authority.mjs", reason: "static source gate; no offline rule set" },
  { gate: "check-error-identity-classification.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-gameplay-capability-catalog.mjs", reason: "static catalog gate; falsifier in its test" },
  {
    gate: "check-harness-conformance.mjs",
    reason: "this suite's CLI; falsifiers in tools/lib/harness-conformance.test.mjs",
  },
  { gate: "check-head-typecheck.mjs", reason: "runs tsc over the worktree; no offline rule set" },
  { gate: "check-host-diagnostic-output.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-host-game-physical-seam.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-host-production-import-boundary.mjs", reason: "full source scan; falsifier in its test" },
  { gate: "check-host-windows-test-preflight.mjs", reason: "reads the Windows environment; falsifier in its test" },
  { gate: "check-live-run-verdict-guards.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-production-pack-load.mjs", reason: "loads the built production pack; falsifier in its test" },
  { gate: "check-publint.mjs", reason: "runs publint against the vendor baseline" },
  { gate: "check-scope-references.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-action-promotion.mjs", reason: "static table gate; falsifier in its test" },
  { gate: "check-stardew-actor-admissibility.mjs", reason: "requires a live-run artifact" },
  { gate: "check-stardew-companion-production-admission.mjs", reason: "requires a production-admission artifact" },
  { gate: "check-stardew-dialogue-autonomy.mjs", reason: "requires a ladder-result json" },
  { gate: "check-stardew-dialogue-stream.mjs", reason: "requires a result json" },
  {
    gate: "check-stardew-execution-receipt-field-parity.mjs",
    reason: "static field-parity gate; falsifier in its test",
  },
  { gate: "check-stardew-fixture-scenario-wiring.mjs", reason: "static wiring gate; falsifier in its test" },
  { gate: "check-stardew-gameplay-completeness.mjs", reason: "requires --report input" },
  { gate: "check-stardew-hold-sufficiency.mjs", reason: "requires a live-run artifact" },
  { gate: "check-stardew-loop-closure.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-native-mechanism-review-register.mjs", reason: "requires a mechanism report and register" },
  { gate: "check-stardew-native-multiplayer-sensitivity.mjs", reason: "requires --register/--source-root inputs" },
  {
    gate: "check-stardew-native-normal-player-ingress-register.mjs",
    reason: "requires a register and mechanism report",
  },
  { gate: "check-stardew-native-pathfinder-source.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-native-router-exit-classifier.mjs", reason: "requires an inventory and classifier input" },
  { gate: "check-stardew-native-source-closure.mjs", reason: "requires a certificate and decompile root" },
  { gate: "check-stardew-native-transition-ledger.mjs", reason: "requires a ledger and source root" },
  { gate: "check-stardew-receipt-attribution.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-tool-family-stamina-evidence.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-wia-agent-loop.mjs", reason: "requires a ladder-result json" },
  { gate: "check-tavern-release-prerequisites.mjs", reason: "reads the live environment; no offline rule set" },
  { gate: "check-test-store-teardown.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-text-hygiene.mjs", reason: "scans the tree; falsifier in its test" },
  // Added 2026-10-23/24. Each one's falsifier lives in the matching test file, which
  // the suite runs; this entry exists so the conformance gate sees them at all.
  { gate: "check-silent-failure.mjs", reason: "static source scan; falsifiers in tools/lib/silent-failure.test.mjs" },
  { gate: "check-perf-budget.mjs", reason: "re-measures budgets; falsifier needs a slower implementation" },
  { gate: "check-refusal-informativeness.mjs", reason: "static source scan; falsifier in its test" },
  { gate: "check-stardew-mod-folder-name.mjs", reason: "static three-file scan; falsifier in its test" },
  {
    gate: "check-post-history-instructions-live.mjs",
    reason: "requires a live-run artifact and a mounted card; no offline rule set",
  },
]);

/** Every gate file the suite recognises: `tools/check-*.mjs`, minus tests and mutation scripts. */
export function harnessGateNames(toolsDir) {
  return readdirSync(toolsDir)
    .filter((name) => /^check-.*\.mjs$/u.test(name) && !name.endsWith(".test.mjs") && !name.endsWith(".mutation.mjs"))
    .sort();
}

/**
 * Require every enumerated gate to be either a `GATES_WITH_FALSIFIER` gate (whose own default run prints a
 * self-verification report) or a declared `GATES_WITHOUT_FALSIFIER` exception. A gate in neither - a new gate that
 * forgot both - is the finding.
 */
export function checkGateFalsifiers({
  gateNames,
  withFalsifier = GATES_WITH_FALSIFIER,
  withoutFalsifier = GATES_WITHOUT_FALSIFIER,
  toolsDir,
  run = runGateDefault,
} = {}) {
  const declared = new Set(withoutFalsifier.map((entry) => entry.gate));
  const withSet = new Set(withFalsifier);
  const findings = [];
  for (const name of gateNames) {
    const selfReports = withSet.has(name);
    const declaredExcept = declared.has(name);
    if (selfReports && declaredExcept) {
      findings.push(finding("gate_classified_twice", name));
      continue;
    }
    if (selfReports) {
      const result = run(join(toolsDir, name));
      if (selfVerificationReport(result.stdout) === null) {
        findings.push(
          finding(
            "falsifier_signature_missing",
            `${name}: the default run printed no self-verification report (${describeRun(result)})`,
          ),
        );
      }
      continue;
    }
    if (!declaredExcept) findings.push(finding("gate_without_falsifier", name));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------
// The suite: run all five checks, in order.
// ---------------------------------------------------------------------------------------------------

/** The `ModEntry.Fixtures*.cs` partials, each with its repo-relative path, so a finding can cite file+line. */
export function readModFixtureSources(repoRoot) {
  const modDir = join(repoRoot, "integrations", "stardew");
  return readdirSync(modDir)
    .filter((name) => /^ModEntry\.Fixtures.*\.cs$/u.test(name))
    .sort()
    .map((name) => ({ file: `integrations/stardew/${name}`, source: readFileSync(join(modDir, name), "utf8") }));
}

/** Run the five checks against a real checkout and return `{ id, findings }` for each. */
export function runHarnessConformance({ toolsDir, repoRoot }) {
  return [
    { id: "preflight_synthetic_trees", findings: checkLiveRunPreflight({}) },
    {
      id: "scenario_mod_acceptance",
      findings: checkScenarioAcceptance({ modSources: readModFixtureSources(repoRoot) }),
    },
    { id: "runner_resolution", findings: checkRunnerResolution({ toolsDir }) },
    { id: "experimental_runner_inventory", findings: checkExperimentalRunners({ toolsDir }) },
    { id: "gate_falsifiers", findings: checkGateFalsifiers({ gateNames: harnessGateNames(toolsDir), toolsDir }) },
  ];
}
