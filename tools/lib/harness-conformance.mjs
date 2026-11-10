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
  "check-build-artifact-producers.mjs",
  // Both print a one-entry `checks[]` verdict in their default run since 2026-11-09: they asserted a rule all along
  // (every declared operation reaches a surface; every declared pair meets its minimum) and printed a table the harness
  // could not tell apart from a report. Naming the rule is what makes the check read the gate instead of its prose.
  "check-configuration-surfaces.mjs",
  // Prints `examined N frontend route literal(s) and M host route(s)` plus a one-entry `checks[]` verdict, so its
  // default run is the report this suite reads. Its falsifier is tools/check-frontend-reads-have-producers.test.mjs,
  // which plants a read with no producer (named with the route and the file:line it is read from), a route whose only
  // other mention is a Playwright stub (still a violation, `stub_only`), a route registered only inside a Host
  // `*.test.ts` (still a violation), a route written only in a comment (not a read), an empty `dialogue-web/src`
  // (`frontend_route_population_empty`, exit 1), a Host side with no registration position and one with no source at
  // all (`not_measured`, never passed), and a closed union whose third member has no producer (named on its own).
  "check-frontend-reads-have-producers.mjs",
  "check-contrast-tokens.mjs",
  "check-credential-export-isolation.mjs",
  "check-evidence-bundle.mjs",
  "check-fail-closed-forward-path.mjs",
  "check-game-context-pressure.mjs",
  "check-game-historian-rubric.mjs",
  "check-live-run-failure-dump.mjs",
  "check-live-run-multiday-baseline.mjs",
  // Its default run prints `{gate:"presentation-delivery-account", status, examined, checks[]}` and reads whatever
  // bundle it is pointed at, so the report is the gate's own verdict rather than prose. Its falsifier is
  // tools/lib/presentation-delivery-account.test.mjs: 59 pieces against an account of 46 parts is reconciled as 46 text
  // parts and 13 pieces emitted ahead, 15 pieces against 2 named ones is blocked with the two numbers named, a bundle
  // that predates `presentation.deliveryAccount` is blocked rather than passed, a hand-written sum that does not hold is
  // refused even when its own `blocked` field is null, and pieces with no records at all are `delivery_account_absent`.
  // Red on real history: round41's own bundle, which carried `pieceCount: 59` and thirteen records, exits 1 here.
  "check-presentation-delivery-account.mjs",
  "check-live-run-silence.mjs",
  // Prints `plan_legal_fixpoint examined N pairs (Y=…, X=…) · accepted … · repaired … · dead ends …` plus a `checks[]`
  // verdict (pair fixpoint, modal-target declaration), which is the report this suite reads. Its falsifier is
  // tools/check-plan-legal-fixpoint.test.mjs: the round42 pair replayed from PRE_FIX_REVISION is a dead end, an `ok`
  // answer that dropped a step is a dead end, a plan-level refusal with a workable remedy is repaired, a refusal naming
  // no remedy is a dead end even when one exists by hand, and an empty or unpublished population is `blocked`.
  "check-plan-legal-fixpoint.mjs",
  // Prints `observation tools examined N · named M · with a reason K`, one line per tool, and a `checks[]` verdict
  // enumerating its seven rules (the surface still mounts the class it reads, the population is non-empty, the guidance
  // was found, every tool is named or reasoned, the reason table is not stale, its classes are closed, it reads the
  // declaration). Its falsifier is tools/check-planner-guidance-observation-tools.test.mjs: the guidance as it read
  // before the rectangle sentence is red on `stardew_inspect_tiles` beside `stardew_look_up` and `stardew_observe`, one
  // tool's name removed is red on that tool alone, a tenth `defineTool` arrives red by being added, a mention living only
  // in a comment is not a mention, a reason the text has overtaken and a reason for a tool the producer no longer mounts
  // are red, an empty producer is blocked, and an unwired adapter is `observation_chain_unanchored`.
  "check-planner-guidance-observation-tools.mjs",
  // Prints `preset_macros examined N macros violations M status ...` on every run, which is the report the conformance
  // suite reads; its falsifier is tools/check-preset-macros.test.mjs, which injects a module-level variable table (the
  // two-calls-share-state violation) and a preset carrying an unimplemented macro.
  "check-preset-macros.mjs",
  // Prints a per-reading verdict (`import_to_export`, `export_to_reimport`, `source_to_reexport`) plus the population
  // it examined, so its default run is the report the conformance suite reads.
  "check-preset-round-trip.mjs",
  "check-stardew-fixture-action-coverage.mjs",
  // Prints `invented-gates: constants examined N · engine-cited M · debt K · invented D` plus a `checks[]` verdict
  // enumerating its six rules (the decompiled tree is readable, the population comes from the request paths, every bound
  // resolves, every bound is the engine's number, one constant measures one subject, every debt entry expires). Its
  // falsifier is tools/check-stardew-invented-gates.test.mjs: a constant citing `Utility.cs:20` - the predicate, whose
  // radius is a parameter - is `engine=unstated` beside the subject it names, one constant measured against two tiles
  // names both, an inline literal that disagrees with the cited authority is invented, a re-valued debt entry expires,
  // and a source set with no request path blocks rather than passes.
  "check-stardew-invented-gates.mjs",
  "check-stardew-native-notice-coverage.mjs",
  "check-stardew-postcondition-delta.mjs",
  // Prints a per-reading verdict, each naming the state it read - `applies-to-working-tree` (state=worktree),
  // `applies-to-pinned-commit` (state=pin:<sha>, the commit the parent repository records) and `extension-point` -
  // plus a per-rule `checks[]` verdict (patch header vs diff, patched file parses, extension point absent without
  // the patch), so its default run is the report the conformance suite reads. Its falsifier is
  // tools/check-vendor-patches-apply.test.mjs, which injects a changed context line into the shipped patch (both
  // apply readings red), ONE dirty line in the working-tree copy while the pin stays clean (only the working-tree
  // reading red), the same drift on the pin side (only the pinned reading red), the four ways the pin cannot be
  // read (`not_measured`, never passed), a declared extension point its diff never adds, an extension point the
  // submodule already has, and a patch that only parses until it is applied.
  "check-vendor-patches-apply.mjs",
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
  // `not_measured` is a gate saying it printed a report and could not measure part of it - the honest third answer
  // beside passed and failed, so a report carrying it is still a report.
  const OUTCOME = new Set(["passed", "failed", "blocked", "not_measured"]);
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
    gate: "check-action-coverage.mjs",
    reason:
      "a report, not a gate: it exits 0 unconditionally unless --fail-under <n> is passed, and no script, workflow or list in this repository passes one (`git grep -n fail-under` finds the flag only in its own header and its own argument parser), so nobody has defined what well-covered means and its default run has no threshold to fail against",
  },
  {
    gate: "check-ci-coverage.mjs",
    reason:
      "compares two inventories (gate scripts vs workflow invocation). Its falsifier exists - " +
      "tools/check-ci-coverage.test.mjs, 21 cases that drive real subprocess gates in a temporary workspace and " +
      "carry four red-proof markers - so the earlier 'needs synthetic inventories, real work not done yet' reason " +
      "had stopped being true and was replaced by this one rather than kept as a comfortable excuse",
  },
  {
    gate: "check-head-self-contained.mjs",
    reason:
      "reads the commit's own module graph (`git ls-tree HEAD` + `git cat-file --batch`, not the index); its " +
      "falsifier is tools/check-head-self-contained.test.mjs, which builds six throwaway `git init` repositories " +
      "and plants a staged-but-uncommitted module, a never-written target and a gitignored build output, and the " +
      "gate's own red-proof marker names them",
  },
  {
    gate: "check-child-output-parsing.mjs",
    reason:
      "finds hand-parsed child-process output by following the value from the subprocess call to the split; its " +
      "falsifier is tools/check-child-output-parsing.test.mjs, which hands the real 2026-11-05 capture to the old " +
      "reader (0 lines) and to the shared one (6 lines) and plants a tainted split",
  },
  {
    gate: "check-derived-population.mjs",
    reason:
      "reads test files as syntax trees so a literal population assertion (`list.length === 15`) is found in code " +
      "and not in prose; its falsifier is tools/check-derived-population.test.mjs, eight injections including the " +
      "member-diff format that replaces a bare pair of counts",
  },
  {
    gate: "check-vendor-build-artifacts.mjs",
    reason:
      "reads the workspace's `file:` dependencies and the `exports` their packages declare, then asks whether every " +
      "promised file exists; its falsifier is tools/check-vendor-build-artifacts.test.mjs, which builds throwaway " +
      "workspace trees with a built subpath missing, an `exports` written as a bare string (the shape that made the " +
      "gate read a string's characters as fifteen files), an export escaping its own package, no `exports` at all, " +
      "and no `file:` dependency to examine",
  },
  {
    gate: "check-vendored-bundle-leaks.mjs",
    reason:
      "reads a built bundle for the build machine's own paths (`bun build` inlined `E:\\\\projects\\\\…` into " +
      "`__dirname`/`__filename` for its CommonJS dependencies); its falsifier is " +
      "tools/check-vendored-bundle-leaks.test.mjs, whose case 'a build-machine path written with doubled " +
      "separators is blocking' hands it the exact line that build produced and requires " +
      "`result.blocking.length === 1`, with the sibling cases proving a regex literal, a template hole and a " +
      "path outside the repository are NOT reported so the matcher is not simply matching slashes",
  },
  {
    gate: "check-workflow-expressions.mjs",
    reason:
      "reads every workflow's `${{ }}` expressions against the contexts GitHub allows in that position; its " +
      "falsifier is tools/check-workflow-expressions.test.mjs, whose case 'a key re-exporting itself through " +
      "the env context is blocking, because it can only be empty' plants the always-empty shape and requires " +
      "it to be reported, alongside a clean workflow that must report nothing - so neither the blocking nor " +
      "the silent branch is untested",
  },
  {
    gate: "check-ci-dead-conditions.mjs",
    reason:
      "reads every workflow's `if:` expressions against every writer of the variables they name; its falsifier is " +
      "tools/check-ci-dead-conditions.test.mjs, which plants a `if: env.NEVER_SET != ''` in a throwaway workflow and " +
      "then proves the five sanctioned writer shapes silence it",
  },
  { gate: "check-chat-conversational-quality-gate.mjs", reason: "requires --transcript/--db run input" },
  {
    gate: "check-class-name-declarations.mjs",
    reason:
      "static source gate over dialogue-web's own tsx and css, read through the workspace's TypeScript compiler; " +
      "its falsifier is tools/check-class-name-declarations.test.mjs, which plants an undeclared className, an " +
      "unreadable expression, an unearned exemption and the real pre-fix commit, and the gate's own red-proof " +
      "markers name both",
  },
  {
    gate: "check-live-run-isolation.mjs",
    reason:
      "builds lanes from %LOCALAPPDATA%/GameBuddy/stardew-profiles/native-local-stable and the Steam install; on a checkout it exits 1 before printing a report, which is why it is not a gate whose default run self-verifies",
  },
  { gate: "check-commit-staging.mjs", reason: "reads the git index; no offline rule set" },
  {
    gate: "check-csharp-compile.mjs",
    reason:
      "builds every tracked csproj, so its default run is 29 dotnet builds rather than a rule list to print; the falsifier in check-csharp-compile.test.mjs runs the gate's own entry over a scratch repository whose one project has a type error and requires it to name that project",
  },
  { gate: "check-crab-pot-output-fixture-contract.mjs", reason: "requires --contract input" },
  { gate: "check-dependency-risk.mjs", reason: "static report; falsifier in check-dependency-risk.test.mjs" },
  {
    gate: "check-dependency-audit.mjs",
    reason: "judges a live `pnpm audit` against the assessment file; falsifier in check-dependency-audit.test.mjs",
  },
  { gate: "check-diff.mjs", reason: "runs git diff --check; no offline rule set" },
  {
    gate: "check-draft-declaration-coverage.mjs",
    reason:
      "drives the mounted zone in Chromium (`dialogue-web` test:mounted), so its default run needs an installed " +
      "browser and the dev-server port rather than an offline rule set; its falsifier is the journey it runs - " +
      "dialogue-web/tests/draft-declaration-coverage.spec.ts - which the gate's own `red-proof:` marker names, " +
      "together with the declaration whose removal was seen to turn it red",
  },
  { gate: "check-dist-runtime-exports.mjs", reason: "reads the built dist; no offline rule set" },
  { gate: "check-duplicated-authority.mjs", reason: "static source gate; no offline rule set" },
  {
    gate: "check-catalog-fact-ownership.mjs",
    reason:
      "static source gate; its falsifier suite (tools/lib/catalog-fact-ownership.test.mjs) drives a wrong price and " +
      "a renamed owner through a synthetic tree, and its own red-proof marker names both",
  },
  { gate: "check-error-identity-classification.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-failure-reason-codes.mjs", reason: "static source gate; falsifier in its test" },
  {
    gate: "check-parser-agreement.mjs",
    reason:
      "static source gate; its falsifier suite (tools/lib/parser-agreement.test.mjs) rebuilds one reader's pattern on a " +
      "copy of the file and requires the disagreement to be named, and the gate's own red-proof marker names the token",
  },
  { gate: "check-gameplay-capability-catalog.mjs", reason: "static catalog gate; falsifier in its test" },
  {
    gate: "check-harness-conformance.mjs",
    reason: "this suite's CLI; falsifiers in tools/lib/harness-conformance.test.mjs",
  },
  { gate: "check-head-typecheck.mjs", reason: "runs tsc over the worktree; no offline rule set" },
  {
    gate: "check-release-live-evidence.mjs",
    reason:
      "reads the committed evidence under tools/fixtures/live-evidence and asks git whether each pin is an ancestor of HEAD; its falsifier is tools/check-release-live-evidence.test.mjs, which plants a side-branch pin, a pin git has never seen, a capture date 60 days before and 60 days after the pin, an empty declaration, a failed verdict that a reading contradicts, a file copied from the other surface and a duplicated reading id in throwaway `git init` repositories, and the gate's own red-proof markers name them",
  },
  {
    gate: "check-release-generation-self-contained.mjs",
    reason:
      "reads the published generation's own inventory and the current production-artifact.config.json, so its " +
      "default run needs `host/dist` - absent in CI, where it reports `not_measured` and exits 0 rather than " +
      "passing; its falsifier is tools/check-release-generation-self-contained.test.mjs, which plants a module " +
      "the source declares and the generation lacks, a module deleted from the generation, a computed dynamic " +
      "argument and an anchored path composition, and the gate's own red-proof markers name them",
  },
  { gate: "check-host-diagnostic-output.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-host-game-physical-seam.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-host-production-import-boundary.mjs", reason: "full source scan; falsifier in its test" },
  { gate: "check-host-windows-test-preflight.mjs", reason: "reads the Windows environment; falsifier in its test" },
  { gate: "check-live-run-verdict-guards.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-production-pack-load.mjs", reason: "loads the built production pack; falsifier in its test" },
  { gate: "check-publint.mjs", reason: "runs publint against the vendor baseline" },
  { gate: "check-scope-references.mjs", reason: "static source gate; falsifier in its test" },
  {
    gate: "check-spec-reachability.mjs",
    reason:
      "static wiring gate; its falsifier (tools/check-spec-reachability.test.mjs) drives a synthetic checkout through a\n" +
      "       suite no reachable command names, a spec the config's testIgnore excludes, a deleted mounted step and a missing\n" +
      "       config, and requires each to be named",
  },
  {
    gate: "check-surface-journeys.mjs",
    reason:
      "static source gate over the panel union and the specs; its falsifier\n" +
      "       (tools/check-surface-journeys.test.mjs) adds a surface no journey asserts on, a journey that only clicks its\n" +
      "       control, a panel the shell never renders, and a test id two surfaces render alike",
  },
  {
    gate: "check-assertion-substance.mjs",
    reason:
      "static source gate over the specs; its falsifier (tools/check-assertion-substance.test.mjs)\n" +
      "       injects a journey whose only assertion is `toBeVisible()`, one with none at all, and the\n" +
      "       `toHaveCount(1)` shape the defect is named after, and requires each to be named",
  },
  {
    gate: "check-stub-subject-collision.mjs",
    reason:
      "a report, not a gate: it lists heuristic title-against-stub collisions and always exits 0 by design.\n" +
      "       Its falsifier (tools/check-stub-subject-collision.test.mjs) drives a synthetic tree through a title that names\n" +
      "       the resource it stubs and its control, a route stubbed by an imported helper, a route named by a constant, an\n" +
      "       unresolvable route name and a probe-mounted spec, and asserts the report exits 0 with a collision on it",
  },
  { gate: "check-stardew-action-promotion.mjs", reason: "static table gate; falsifier in its test" },
  {
    gate: "check-stardew-promotion-parity.mjs",
    reason:
      "compares the catalog, the published gate table, the experimental runner map and the fixture scenario; its " +
      "falsifier (tools/check-stardew-promotion-parity.test.mjs) injects each half-write into the real sources - a " +
      "deleted gate row, a runner left in the experimental map, a scenario the Mod does not declare, an unstated " +
      "catalog default - and reads the exact promotion_places_disagree line, so the default run prints population " +
      "counts rather than a self-verification report",
  },
  { gate: "check-stardew-actor-admissibility.mjs", reason: "requires a live-run artifact" },
  { gate: "check-stardew-companion-production-admission.mjs", reason: "requires a production-admission artifact" },
  { gate: "check-stardew-dialogue-autonomy.mjs", reason: "requires a ladder-result json" },
  { gate: "check-stardew-dialogue-stream.mjs", reason: "requires a result json" },
  {
    gate: "check-stardew-discovery-collection-coverage.mjs",
    reason:
      "static source gate over the Mod tree; its falsifier (tools/check-stardew-discovery-collection-coverage.test.mjs) " +
      "asserts the gate's own REPORT - findings[].code/collection and rows[], the same judgements the CLI prints - on a " +
      "discovery that reads the wrong collection, one that names its collection only in a comment, a delegation claim " +
      "with no call behind it, a scan that found nothing and a ratchet entry that outlived its fix, with the real Mod " +
      "tree beside them as the accepting sample; two of its cases read collectionsRead/parseDiscoveries directly rather " +
      "than the report; the gate's own red-proof marker names the injected deletion",
  },
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
  {
    gate: "check-stardew-observation-consumers.mjs",
    reason:
      "static source gate; its falsifier is tools/check-stardew-observation-consumers.test.mjs, which plants a " +
      "target-bearing action no channel answers, removes a look_up subject's case, widens a HUD line, and plants a stale, " +
      "a duplicated and an unreasoned baseline entry",
  },
  { gate: "check-stardew-receipt-attribution.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-snapshot-family-bounds.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-tool-family-stamina-evidence.mjs", reason: "static source gate; falsifier in its test" },
  { gate: "check-stardew-wia-agent-loop.mjs", reason: "requires a ladder-result json" },
  { gate: "check-tavern-release-prerequisites.mjs", reason: "reads the live environment; no offline rule set" },
  { gate: "check-test-store-teardown.mjs", reason: "static source gate; falsifier in its test" },
  {
    gate: "check-unreported-catch.mjs",
    reason:
      "static source gate over dialogue-web's catch clauses, read through the workspace's TypeScript compiler; " +
      "its falsifier is tools/check-unreported-catch.test.mjs, which plants a re-read-only catch, a log-only " +
      "catch, an undefined answer and the real pre-fix commit, and the gate's own red-proof markers name both",
  },
  { gate: "check-text-hygiene.mjs", reason: "scans the tree; falsifier in its test" },
  // Added 2026-10-23/24. Each one's falsifier lives in the matching test file, which
  // the suite runs; this entry exists so the conformance gate sees them at all.
  { gate: "check-silent-failure.mjs", reason: "static source scan; falsifiers in tools/lib/silent-failure.test.mjs" },
  { gate: "check-perf-budget.mjs", reason: "re-measures budgets; falsifier needs a slower implementation" },
  {
    gate: "check-perf-scaling.mjs",
    reason:
      "re-measures the bench suite as size pairs in child processes, which needs a built `host/dist-test`; its " +
      "falsifier is tools/check-perf-scaling.test.mjs, which drives the band decider over every rejected reading " +
      "shape and measures a linear closure against an injected quadratic one on the same axis",
  },
  { gate: "check-refusal-informativeness.mjs", reason: "static source scan; falsifier in its test" },
  { gate: "check-stardew-mod-folder-name.mjs", reason: "static three-file scan; falsifier in its test" },
  { gate: "check-stardew-task-action-coverage.mjs", reason: "static artifact scan; falsifier in its test" },
  {
    gate: "check-stardew-execution-terminal-uniqueness.mjs",
    reason:
      "reads a caller-supplied run reading rather than the tree, so its falsifier supplies the run: " +
      "tools/check-stardew-execution-terminal-uniqueness.test.mjs builds one artifact per defect - one request answered " +
      "twice (duplicate_answer), the same terminal reaching the fact listeners twice (duplicate_fact, the measured " +
      "2026-11-09 double), a legitimate replayed answer that must stay clean, a fact-stream artifact that records no " +
      "answer channel, and a zero-frame artifact that must read not_measured instead of green",
  },
  {
    gate: "check-prelive-gate-registry.mjs",
    reason:
      "the register itself; its falsifier is tools/check-prelive-gate-registry.test.mjs, which plants a forgotten gate, a " +
      "stale exemption, a dangling runsIn and a wired-but-absent gate and asserts each is named by file, and which " +
      "also builds a throwaway repository whose worktree package.json has lost a script its commit declares, so a " +
      "script only HEAD has is not reported as unknown (measured 2026-11-09: exempt_runs_in_unknown_script on a gate " +
      "that runs), and which asserts a missing runsIn is the named finding exempt_runs_in_missing and exit 1 rather " +
      "than a TypeError from the elsewhere assertion",
  },
  {
    gate: "check-action-deadline-agreement.mjs",
    reason:
      "its falsifier is tools/check-action-deadline-agreement.test.mjs, which drives the gate's own derivation over a " +
      "synthetic surface and the producer's export: a runner writing 120 s against a 60 s window is red and names both " +
      "numbers (the measured 2026-11-10 `fish_here` refusal), a runner that names no window agrees by construction, a " +
      "longer LOCAL wait is not a wider request, an action with no gate runner is counted, an empty population and an " +
      "unreadable export are blocked rather than green, a runner file that cannot be read is blocked and named, and an " +
      "action the export never names is blocked instead of silently agreed",
  },
  {
    gate: "check-stardew-observation-gap.mjs",
    reason:
      "drives three analyzer CLIs over the decompiled tree; its falsifier is " +
      "tools/check-stardew-observation-gap.test.mjs, which forces the skip, the failing step, a chain that exits 0 " +
      "without the observation summary, and asserts the --fail-on-ungranted arming itself",
  },
  {
    gate: "check-stardew-crop-row-derivation.mjs",
    reason:
      "its falsifier is tools/check-stardew-crop-row-derivation.test.mjs, which drives the checker's own overrides against" +
      " the real sources: a shared field removed from the Mod's crop row is named (`not_reachable:isRaised`), a Host layer" +
      " naming a field the Mod does not publish is red, a schema that forgot a published field is red, a map-only" +
      " passability answer is named, an exemption that has been overtaken is red, and a worker population of zero is" +
      " blocked rather than green",
  },
  {
    gate: "check-stardew-discovery-exclusions.mjs",
    reason:
      "its falsifier is tools/check-stardew-discovery-exclusions.test.mjs, which drives the gate's own measure() with a" +
      " synthetic population: an unexplained state filter is named with the member it filtered on, a filed filter is" +
      " named with its disposition instead of being silent, a filed state that now has a token is red, a stale entry is" +
      " red, and zero population is exit 2",
  },
  {
    gate: "check-persona-prose.mjs",
    reason:
      "its falsifier is tools/check-persona-prose.test.mjs, which drives the gate's own binary over real `git init` " +
      "repositories: a commit that rewrites `data.system_prompt` 20 -> 8 characters with no marker is red and names " +
      "that field, the same commit with `[persona]` and a PERSONA-REVISION.md line is green, marker-alone and " +
      "record-alone are each red naming only the half that is missing, a sampler-only change prints a measured zero, " +
      "the working-tree rewrite and the staged rewrite are each caught by their own mode, and a repository with no " +
      "presets, a document that is not JSON and a range of no commits are blocked (exit 2) rather than green. It " +
      "prints a population line and findings, not a `checks[]` report, so it is declared here rather than read by " +
      "checkGateFalsifiers",
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
  if (gateNames.length === 0)
    findings.push(finding("gate_population_empty", "no tools/check-*.mjs gate was enumerated, so no report was read"));
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

/**
 * Which of the three places each enumerated gate stands in: run for its report, declared without one, or neither.
 *
 * The third bucket is the debt this count exists for. A gate in it has never had its default run executed here, so
 * nothing in this suite can say what it would print - the state is decided by a hand list, and the number is printed
 * beside the verdict instead of being rounded away. A non-zero count is already red (`gate_without_falsifier`); this is
 * what a reader needs in order to see WHICH gate is not being checked.
 */
export function gateFalsifierCensus({
  gateNames,
  withFalsifier = GATES_WITH_FALSIFIER,
  withoutFalsifier = GATES_WITHOUT_FALSIFIER,
} = {}) {
  const withSet = new Set(withFalsifier);
  const declared = new Set(withoutFalsifier.map((entry) => entry.gate));
  return {
    examined: gateNames.length,
    withReport: gateNames.filter((name) => withSet.has(name)).length,
    without: gateNames.filter((name) => !withSet.has(name) && declared.has(name)).length,
    unexamined: gateNames.filter((name) => !withSet.has(name) && !declared.has(name)),
  };
}

/** The census as the one line the CLI prints beside the verdict. */
export function describeGateFalsifierCensus(census) {
  return (
    `gates examined ${census.examined} · declared with a report ${census.withReport} · ` +
    `declared without ${census.without} · unlisted-and-unexamined ${census.unexamined.length}` +
    (census.unexamined.length === 0 ? "" : ` (${census.unexamined.join(", ")})`)
  );
}

/**
 * The declarations themselves, checked against the tree: an entry naming a gate that is not there exempts nothing.
 *
 * `gains a report` is the half this cannot measure - an unlisted gate's default run never happens, so a report it would
 * print is unknowable here; that is why the census above prints the count rather than a promise. `loses a report` is
 * measurable and is what this checks: an exempted gate deleted from `tools/` leaves its reason behind and would
 * otherwise keep excusing a gate that no longer exists.
 */
export function checkGateRegistry({
  gateNames,
  withFalsifier = GATES_WITH_FALSIFIER,
  withoutFalsifier = GATES_WITHOUT_FALSIFIER,
} = {}) {
  const present = new Set(gateNames);
  const findings = [];
  for (const name of withFalsifier) {
    if (!present.has(name))
      findings.push(
        finding("falsifier_entry_stale", `${name}: declared to print a report, but no such gate is in tools/`),
      );
  }
  for (const entry of withoutFalsifier) {
    if (!present.has(entry.gate))
      findings.push(
        finding("falsifier_entry_stale", `${entry.gate}: declared without a report, but no such gate is in tools/`),
      );
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

/** Run the five checks against a real checkout and return `{ id, findings }` for each, plus any count a check prints. */
export function runHarnessConformance({ toolsDir, repoRoot }) {
  const gateNames = harnessGateNames(toolsDir);
  return [
    { id: "preflight_synthetic_trees", findings: checkLiveRunPreflight({}) },
    {
      id: "scenario_mod_acceptance",
      findings: checkScenarioAcceptance({ modSources: readModFixtureSources(repoRoot) }),
    },
    { id: "runner_resolution", findings: checkRunnerResolution({ toolsDir }) },
    { id: "experimental_runner_inventory", findings: checkExperimentalRunners({ toolsDir }) },
    {
      id: "gate_falsifiers",
      // The population the verdict rests on, printed beside it: `0 findings` means nothing without `examined N`, and
      // the third bucket is the set whose default run never happens.
      note: describeGateFalsifierCensus(gateFalsifierCensus({ gateNames })),
      findings: [...checkGateFalsifiers({ gateNames, toolsDir }), ...checkGateRegistry({ gateNames })],
    },
  ];
}
