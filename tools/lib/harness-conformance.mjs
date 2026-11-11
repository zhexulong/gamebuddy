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
 *   5. `checkGateFalsifiers`        - every gate in the ONE population (`tools/lib/gate-population.mjs`) either prints a
 *                                     self-verification report in its own default run or is declared in
 *                                     `GATES_WITHOUT_FALSIFIER` with a reason; a report that examined nothing, a report
 *                                     that names no population at all, and a gate the red-proof ledger neither proves nor
 *                                     records are all findings rather than a pass. A gate whose rule lives in another
 *                                     program is neither: the ledger marks it `external`, the census counts that as its
 *                                     own population, and a label whose runner command nothing invokes is a finding.
 *
 * Checks 3 and 5 ask questions about what code DOES, so they run it and read the result: check 3 imports the runner,
 * check 5 runs the gate and reads the report it prints. Reading the source text for the words `import.meta.main` or
 * `checks` answers a different question - a comment satisfies either one - which is why neither is matched here.
 *
 * THE POPULATION IS NOT THIS FILE'S (measured 2026-11-20): this suite used to scan `tools/check-*.mjs` for its own
 * count of gates (106) while `tools/audit-gate-red-proofs.mjs` derived its own (330), so "how many gates are there, and
 * how many have been seen red" had two answers and 203 gates without a red case were invisible here. Both tools now
 * read `tools/lib/gate-population.mjs`, this suite judges the members it can execute, and the census prints the bucket
 * it excluded, the reason, and the two numbers that make a pass honest: gates nobody declared, and gates whose report
 * cannot show that it measured anything.
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
import { auditGateRedProofs, describeGateCensus, evaluate, readBaseline } from "../audit-gate-red-proofs.mjs";
import { resolveStardewActionGateRunner } from "../resolve-stardew-action-gate-runner.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "../stardew-action-gate-descriptors.mjs";
import { assertNonVacuous, POPULATION_FIELDS } from "./assert-non-vacuous.mjs";
import { deriveGatePopulation, gateFileNames, gateMemberNames, isGateFile } from "./gate-population.mjs";
import { importsWithoutStarting, preflightLiveRun } from "./live-run-preflight.mjs";
import { STARDEW_MOD_FOLDER } from "./stardew-mod-folder.mjs";
import { fixtureActions, fixtureScenario } from "./stardew-native-local-player-fixture.mjs";

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
  // Prints `functions examined N · over the bound K · worst <name> @ <file>:<line> = <n>` per producer, the class
  // line and the class-size line, then a `checks[]` verdict enumerating its five rules (each language's function
  // bound, the class complexity bound, the class-size ceiling, and the ratchet over the baseline), so its default
  // run is the report this suite reads. Its falsifier is tools/check-cognitive-complexity.test.mjs: the S3776 cases
  // are hand-computed per rule (sequential branches 3, nesting 1+2+3, else-if 3, switch sections 4, catch without a
  // nesting increment 3, logical runs 1/2/3, a nested function restarting at 0), two partial declarations of one class
  // are one type with `parts: 2` and the summed value, an unrecorded over-bound member and a grown one and a gone one
  // are the three ratchet directions, a class sum names `<class>:<parts>:<n>`, a class size names
  // `<type>:<lines>:<ceiling>:<parts>`, and the CLI over a throwaway root is blocked on an empty population, names a
  // missing `biome.json`, and goes red -> `--update` -> green -> red as the function grows and then disappears.
  "check-cognitive-complexity.mjs",
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
  // Prints `examined N (closed unions X, open vocabularies Y, not a union Z)` plus a two-entry `checks[]` verdict, so
  // its default run is the report this suite reads. Its falsifier is tools/check-switch-exhaustiveness.test.mjs, which
  // builds a throwaway workspace per case: a union switch missing a member (named, `gamma`), the same switch complete
  // (passed), a switch covering every member whose `default` answers a value (`switch_default_does_not_assert_never`),
  // a `default` asserting a different union (not discharged), an open-vocabulary subject with no stated exemption
  // (`exemption_missing`), one that names nothing (`exemption_expired`), one whose declared count disagrees
  // (`exemption_count_mismatch`), and an empty population (`blocked`, exit 1).
  "check-switch-exhaustiveness.mjs",
  "check-contrast-tokens.mjs",
  "check-credential-export-isolation.mjs",
  // Prints `refusal_detail_states examined N · agree M · missing K` plus a `checks[]` verdict enumerating its three
  // rules (both declarations readable, every mapped token in the Host's own state table, the two sets equal), so its
  // default run is the report this suite reads. Its falsifier is tools/check-refusal-detail-state-parity.test.mjs, which
  // replays the tree of `15a3c57c` - the Mod's `MayCarryRefusalDetail` naming `PartiallySucceeded` while the Host set does
  // not - and requires `refusal_detail_state_set_drift:partially_succeeded:host`; it also drives the drift in the other
  // direction (`:mod`), a Host token the Mod's method never permits, a Mod state the wire has no token for, a declaration
  // that cannot be read, an empty set (exit 2, never green) and the CLI's own exit codes on a throwaway root.
  "check-refusal-detail-state-parity.mjs",
  // Prints `frames examined N · paired P · measured here M · owned elsewhere O · exempt E · unmeasured U` and
  // `fields examined M · accepted A · unaccepted K` plus a three-entry `checks[]` verdict enumerating its rules (both
  // declarations readable, every Host frame accounted for, every field accepted), so its default run is the report this
  // suite reads. Its falsifier is tools/check-cross-language-wire-parity.test.mjs: a field added to the real
  // `BridgeBodyProgramNodeStatus` and `"refusalDetail"` deleted from the real `isBodyProgramNodeStatus` key list are both
  // `wire_field_unaccepted:program_status_result:<field>:<C# type>`, a property added to the real Host `ExecutionRequest`
  // is `wire_field_unknown_to_mod:execution_request:<field>`, an exemption downgrades a crossing while one for a field
  // that does not drift is `stale_wire_exemption`, an exemption with no reason or owner is refused, a frame injected into
  // the Host's switch that nothing pairs is `frame_not_measured:<frame>` and BLOCKS the run (exit 2) instead of passing
  // over it, a frame whose paired declaration carries no fields and one whose declaration was moved out of the reader are
  // `frame_without_fields`, a frame exemption downgrades the block while one for a frame that now pairs is
  // `stale_wire_exemption:<frame>`, a missing naming policy, a policy the mapping cannot read, an armless
  // `validateBridgeMessage` and a Models directory with no wire type are all `blocked`, and the CLI's own exit codes are
  // asserted on a throwaway root.
  "check-cross-language-wire-parity.mjs",
  // Prints `snapshot fields examined N · rendered M · exempt K` plus a two-entry `checks[]` verdict, so its default
  // run is the report this suite reads. Its falsifier is tools/check-snapshot-field-rendering.test.mjs: the water line
  // deleted from a copy of `host/src/fact-brief.ts` is `snapshot_field_never_rendered:wateringCanFacts`, a field added
  // to `SNAPSHOT_KEYS` is named on arrival, an exemption for a field the prose renders now and one for a field the wire
  // dropped are the two directions of `stale_rendering_exemption`, a blank owner is refused, a mention inside a comment
  // is not a rendering, and a wire list with no keys is blocked (exit 2) rather than green.
  "check-snapshot-field-rendering.mjs",
  "check-evidence-bundle.mjs",
  "check-fail-closed-forward-path.mjs",
  "check-game-context-pressure.mjs",
  "check-game-historian-rubric.mjs",
  // Prints `conduct rules examined N · FLOOR … · CHANNEL … · FORM …` plus a `checks[]` verdict carrying one entry per
  // rule it can go red on (the population, a composed rule no module owns, a rule its owner's table does not reach, a
  // class that outlived its rule, a class outside the three kinds, a class with no reason, a FORM rule in the floor), so
  // its default run is the report this suite reads. Its falsifier is tools/check-game-surface-conduct-classes.test.mjs:
  // the deleted "Speak before you act" rule put back and classified FORM is
  // `floor_governs_form:speak_before_acting:host/src/game-surface-prompt-floor.ts` with that `checks[]` entry failed, a
  // rule appended with no class names its position and first words, a Stardew rule taken out of the floor while its
  // class stays is `stale_conduct_class:content_ids_in_words`, a class outside the three kinds is a finding rather than
  // a fourth kind, a class with no reason is named, a composed name no module declares is `conduct_rule_unowned`,
  // a renamed declaration is blocked (exit 2, never green) and a list no longer written one rule per line is blocked
  // because a reader that mis-parsed the floor and passed would be worse than no gate.
  "check-game-surface-conduct-classes.mjs",
  "check-live-run-failure-dump.mjs",
  "check-live-run-multiday-baseline.mjs",
  // Its default run prints `{gate:"terminal-commit-single-entry", status, examined, throughSeam, seamCalls, seamBody,
  // exempt, families, findings}` over the whole Mod tree, so the reading is a census and not a list. Its falsifiers are
  // tools/check-terminal-commit-single-entry.test.mjs: a hand-rolled `Remember` + `AddTrace` pair inside the converted
  // `busactions` family is `terminal_commit_bypasses_seam:<file>:<line>:<family>`, an exemption naming a member that
  // calls the seam is `stale_terminal_seam_exemption:<file>:<line>`, and a tree with no seam call at all is blocked
  // rather than green because a scan that measured nothing agrees with itself.
  "check-terminal-commit-single-entry.mjs",
  // Its default run prints `sites examined N · silent S (terminal T · marker M · unresolved U) · exempt E · families F`
  // plus a five-entry `checks[]` verdict (the finding itself, a state the site does not say, a stale exemption, an
  // unreadable state authority, and an empty population), so the reading is a census and not a list. Its falsifier is
  // tools/check-terminal-idle-publication.test.mjs: a terminal store-and-publish pair with no `PublishIdleAfterRelease`
  // is `terminal_without_idle_publication:<file>:<line>:<family>`, the same reading over the revision before the fix -
  // `ExecuteTillSoil` at HEAD - is red on the real tree rather than on a fixture, an exemption for a member that
  // announces the idle now is `stale_terminal_idle_exemption`, and a tree with no store-and-publish pair at all is
  // blocked rather than green. Its population is the sibling gate's pairs, so the two cannot disagree about a site.
  "check-terminal-idle-publication.mjs",
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
  // Prints `files examined N · clone groups M · new K · grown G · baselined B` and a one-entry `checks[]` verdict, so
  // its default run is the report read here. Its falsifier is tools/check-code-duplication.test.mjs, which drives the
  // gate's own reader over throwaway trees and jscpd's real report: three copies of the admission body are one group
  // named with every site (`clone_group:...tokens:3sites:`), a fourth copy against a three-site baseline entry is
  // `clone_group_grew`, two copies against a four-site entry are `stale_clone_baseline`, a config naming another
  // population is `jscpd_config_disagrees:<field>` for path, format, ignore and both thresholds, a tree with no source
  // file is blocked (`code_duplication_examined_no_files`) and a declared `typescript` format with no TypeScript file
  // is blocked naming the format - the two ways the C# tree and the whole scan could read as measured when they are not.
  "check-code-duplication.mjs",
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
  // These two decide the actionability algebra and the orphan-hold search over the decompiled tree, and both read
  // `integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json` - a contract no
  // commit has ever carried and nothing in this repository produces. Their default run is therefore `blocked`: it prints
  // its report, every check reads `blocked`, and `examined: 0` carries the stated reason the shared judge reads as
  // `not_measured`. That distinction is the whole point - a gate whose input does not exist must read as one that
  // measured nothing, never as one that found nothing wrong, and the suite now prints that list by name.
  "check-stardew-actor-admissibility.mjs",
  "check-stardew-hold-sufficiency.mjs",
  "check-stardew-fixture-action-coverage.mjs",
  // Prints `invented-gates: constants examined N · engine-cited M · debt K · invented D` plus a `checks[]` verdict
  // enumerating its six rules (the decompiled tree is readable, the population comes from the request paths, every bound
  // resolves, every bound is the engine's number, one constant measures one subject, every debt entry expires). Its
  // falsifier is tools/check-stardew-invented-gates.test.mjs: a constant citing `Utility.cs:20` - the predicate, whose
  // radius is a parameter - is `engine=unstated` beside the subject it names, one constant measured against two tiles
  // names both, an inline literal that disagrees with the cited authority is invented, a re-valued debt entry expires,
  // and a source set with no request path blocks rather than passes.
  "check-stardew-invented-gates.mjs",
  // Prints `multiday_task_families examined N task-family pair(s) · rotation … · declared … · advertised … · status …`
  // plus a `checks[]` verdict enumerating its nine checks (a rotation task's family is one the world publishes, every
  // task action has a family, every rotation task names one, a declared family is one the catalog carries, an
  // advertisement is whole, three population rules, and the guard that some rule claims every finding code it printed),
  // so its default run is the report read here. Its falsifier
  // is tools/lib/multiday-task-families.test.mjs: the shipped 2026-11-09 state - the coop Given declared but its call
  // gone - is `task_requires_absent_family:tend_the_animals:animals_pets`, a commented-out call is not an invocation,
  // `nameof(...)` in the declaration is not either, a half-written advertisement names the half that is missing, and an
  // empty rotation or an empty advertisement is blocked rather than green.
  "check-stardew-multiday-task-families.mjs",
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
 *
 * `population` is the report judged by `tools/lib/assert-non-vacuous.mjs`, the ONE rule for a gate that measured
 * nothing: a gate whose report states how many objects it examined has that number read here, so `passed` beside a
 * zero is not accepted as a measurement. The judge is shared with `tools/check-ci-coverage.mjs` rather than restated,
 * and a gate that already handles its empty population keeps its own answer - a stated `allowEmpty` reason stays
 * `not_measured`, and a report that names no population at all stays unjudged.
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
    const population = assertNonVacuous(parsed);
    if (Array.isArray(parsed.checks)) {
      const outcomes = parsed.checks.filter((entry) => typeof entry?.id === "string" && OUTCOME.has(entry.status));
      if (outcomes.length > 0) return { gate: parsed.gate, status: parsed.status, rules: outcomes.length, population };
      continue;
    }
    if (typeof parsed.mode === "string" && parsed.mode.length > 0)
      return { gate: parsed.gate, status: parsed.status, rules: 0, population };
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
  {
    gate: "check-stardew-companion-production-admission.mjs",
    reason: "requires a production-admission artifact",
  },
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

/** Every gate file this suite enumerates: the population's `tools/check-*.mjs` members, by file name. */
export function harnessGateNames(toolsDir) {
  return gateFileNames(deriveGatePopulation({ root: dirname(toolsDir) }));
}

/**
 * The red-proof ledger, read ONCE per run: what the other half of this population has declared about itself.
 *
 * `tools/audit-gate-red-proofs.mjs` owns that question - has this gate been seen red on a real injected violation - and
 * answers it with a proof marker or a recorded gap. This suite does not restate the reading: it consumes it, so both
 * tools publish the same `gates examined N` and `with a red proof M`, and `undeclared` here is exactly the set the audit
 * reports as a new gap (no proof, and no baseline record saying one is owed).
 */
export function gateRedProofLedger({ root }) {
  const reading = auditGateRedProofs({ root });
  const { findings, held } = evaluate({ reading, baseline: readBaseline(root) });
  return {
    reading,
    withRedProof: reading.proven.length,
    recorded: held,
    // A gate the ledger neither proves nor records. Restricted to the two codes that mean exactly that, so an
    // unreadable claim or an external label with no invoked runner is its own finding instead of an undeclared gate.
    undeclared: findings.filter((entry) => ["no_red_proof", "gate_unassessed"].includes(entry.code)),
    stale: findings.filter((entry) => entry.code === "baseline_entry_stale"),
    // The gates whose rule lives in another program - or whose every member's does - with the command a reader
    // would run to watch it fail. The count is this list's length in both tools, so the two censuses cannot disagree.
    external: reading.external.map((record) => ({
      gate: record.id,
      commands: record.external.map((runner) => ({ command: runner.command, howItFails: runner.howItFails })),
      inheritedFrom: record.external.length === 0 ? record.members : [],
    })),
    externalWithoutRunner: reading.externalWithoutRunner,
    // The gates whose default run prints a report that names no population the shared judge can read, so a zero in
    // them is indistinguishable from a measurement. Static, because this suite cannot execute 330 gates.
    zeroPopulationPass: reading.zeroPopulationPass.invisible.map((file) => file.replace(/^tools\//u, "")),
  };
}

const EMPTY_LEDGER = Object.freeze({
  withRedProof: 0,
  recorded: 0,
  undeclared: [],
  stale: [],
  external: [],
  externalWithoutRunner: [],
  zeroPopulationPass: [],
});

/**
 * Require every gate file this suite enumerates to be either a `GATES_WITH_FALSIFIER` gate (whose own default run prints
 * a self-verification report) or a declared `GATES_WITHOUT_FALSIFIER` exception. A gate in neither - a new gate that
 * forgot both - is the finding.
 *
 * Three findings are about the population rather than one gate, and they are what a passing run used to hide:
 *
 *   - `gate_undeclared`: a gate in the ONE population that the red-proof ledger neither proves nor records. Named one
 *     per gate, because "7 undeclared" sends a reader counting and "this one has no proof and no record" does not.
 *   - `gate_report_without_population`: a gate that prints a report and names no population field, so its `passed`
 *     next to nothing reads the same as a gate that measured nothing.
 *   - `gate_declaration_stale`: a recorded gate that is proven now, which means the ledger is holding a debt already
 *     paid - the ratchet only tightens.
 *
 * A report that a gate printed AND that examined nothing is the fourth: `0 findings` means nothing without `examined N`,
 * so a report whose population the shared judge reads as zero-with-no-reason is `blocked`, naming the gate.
 */
export function checkGateFalsifiers({
  gateNames,
  withFalsifier = GATES_WITH_FALSIFIER,
  withoutFalsifier = GATES_WITHOUT_FALSIFIER,
  zeroPopulation = [],
  undeclared = [],
  staleDeclarations = [],
  externalWithoutRunner = [],
  toolsDir,
  run = runGateDefault,
  // The gates whose own report says it could not measure, collected for the census line rather than for a verdict: a
  // gate whose prerequisite is absent is `not_measured`, which is neither a finding here nor a pass anywhere.
  notMeasured = [],
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
      const report = selfVerificationReport(result.stdout);
      if (report === null) {
        findings.push(
          finding(
            "falsifier_signature_missing",
            `${name}: the default run printed no self-verification report (${describeRun(result)})`,
          ),
        );
        continue;
      }
      if (report.population?.status === "blocked")
        findings.push(finding("gate_measured_nothing", `${name}: ${report.population.detail}`));
      else if (report.population?.status === "not_measured")
        notMeasured.push({ gate: name, detail: report.population.detail });
      continue;
    }
    if (!declaredExcept) findings.push(finding("gate_without_falsifier", name));
  }
  for (const entry of undeclared) findings.push(finding("gate_undeclared", `${entry.gate}: ${entry.detail}`));
  for (const entry of staleDeclarations)
    findings.push(finding("gate_declaration_stale", `${entry.gate}: ${entry.detail}`));
  // An `external` label is only as good as the runner behind it: a command no script and no workflow invokes names a
  // rule nothing in this repository checks, which is the silencer the label exists to make impossible.
  for (const entry of externalWithoutRunner)
    findings.push(
      finding(
        "external_runner_not_invoked",
        `${entry.gate}: claims \`external ${entry.command}\`, which no package.json script and no workflow invokes`,
      ),
    );
  for (const name of zeroPopulation)
    findings.push(
      finding(
        "gate_report_without_population",
        `${name}: prints a self-verification report and names no ` +
          `${POPULATION_FIELDS.join("/")} field, so a run that examined nothing reads exactly like one that did`,
      ),
    );
  return findings;
}

/**
 * The numbers the verdict rests on - the SAME population line the red-proof audit prints, plus the bucket this suite
 * excludes and why.
 *
 * The population is the union `tools/lib/gate-population.mjs` derives: every `package.json` gate script and every
 * `tools/check-*.mjs` file no script names. This suite can only judge the gate files (it runs each one's own default
 * invocation and reads the report), so the script-backed half is EXCLUDED and named as excluded - never silently
 * dropped, which is how 106 and 330 became two answers to one question. Every excluded member is still declared
 * somewhere: in the red-proof ledger, or in `undeclared` when no ledger covers it.
 *
 * `unlisted` is the debt inside the judged set: a gate file the registry names neither with a report nor without one.
 * It is always a finding (`gate_without_falsifier`), and it is counted here so a reader can see which gate it is without
 * reading 106 lines.
 */
export function gateFalsifierCensus({
  population = [],
  withFalsifier = GATES_WITH_FALSIFIER,
  withoutFalsifier = GATES_WITHOUT_FALSIFIER,
  ledger = EMPTY_LEDGER,
} = {}) {
  const members = population.map((member) => (typeof member === "string" ? { id: member, entryFiles: [] } : member));
  const namesOf = (member) => (member.entryFiles.length === 0 ? [member.id] : gateMemberNames(member));
  const withSet = new Set(withFalsifier);
  const declared = new Set(withoutFalsifier.map((entry) => entry.gate));
  const judged = members.filter((member) => isGateFile(member.entryFiles[0] ?? ""));
  const excluded = members.filter((member) => !judged.includes(member));
  const undeclaredNames = new Set(ledger.undeclared.map((entry) => entry.gate));
  return {
    examined: members.length,
    judged: judged.length,
    withReport: judged.filter((member) => namesOf(member).some((name) => withSet.has(name))).length,
    without: judged.filter((member) => namesOf(member).some((name) => declared.has(name))).length,
    unlisted: judged
      .filter((member) => !namesOf(member).some((name) => withSet.has(name) || declared.has(name)))
      .map((member) => member.id),
    excluded: excluded.map((member) => member.id),
    excludedUndeclared: excluded
      .filter((member) => namesOf(member).some((name) => undeclaredNames.has(name)))
      .map((member) => member.id),
    withRedProof: ledger.withRedProof,
    recorded: ledger.recorded,
    undeclared: [...undeclaredNames],
    external: [...ledger.external],
    zeroPopulationPass: [...ledger.zeroPopulationPass],
  };
}

/**
 * The census as the lines the CLI prints beside the verdict.
 *
 * Line one is the answer to "how much of this is measured", in the words both tools use: the population, the gates with
 * a red proof, the gates whose missing proof someone recorded, the gates nobody declared at all, and the gates whose
 * report cannot show whether it measured anything. Line two names the bucket this suite excluded and the reason.
 */
export function describeGateFalsifierCensus(census) {
  return [
    describeGateCensus({
      examined: census.examined,
      withRedProof: census.withRedProof,
      external: census.external.length,
      recorded: census.recorded,
      undeclared: census.undeclared.length,
      zeroPopulationPass: census.zeroPopulationPass.length,
    }) + (census.unlisted.length === 0 ? "" : ` · unlisted ${census.unlisted.length} (${census.unlisted.join(", ")})`),
    `judged here ${census.judged} (with a self-report ${census.withReport} · declared without a report ${census.without}) · ` +
      `excluded ${census.excluded.length} (a package.json gate script whose entry is not a tools/check-*.mjs gate file, ` +
      `so this suite has no default run to read): ` +
      `${census.excluded.length - census.excludedUndeclared.length} proven, external or recorded in the red-proof ledger` +
      (census.excludedUndeclared.length === 0
        ? ""
        : `, ${census.excludedUndeclared.length} undeclared and named below`),
    // The external rows carry their command: a label a reader cannot run is a label that cannot be checked.
    `external ${census.external.length} (rule lives in another program; run the command to watch it fail): ` +
      (census.external.length === 0
        ? "none"
        : census.external
            .map((entry) =>
              entry.inheritedFrom.length > 0
                ? `${entry.gate} = inherited from ${entry.inheritedFrom.join(", ")}`
                : `${entry.gate} = ${entry.commands.map((each) => `\`${each.command}\``).join(", ")}`,
            )
            .join(" · ")),
  ];
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

/**
 * The gates that ran and reported they could not measure, named rather than counted.
 *
 * `with a self-report N` says a gate printed a report; it cannot say whether that report measured anything. A gate whose
 * input this repository does not carry prints `blocked` with `examined: 0` and a stated reason, which the shared judge
 * reads as `not_measured` - never a pass, and not a finding either, because nothing is wrong with the gate. That leaves
 * the number of such gates invisible in a census built from declarations, so the line names them from the runs instead.
 */
function describeNotMeasuredGates(notMeasured) {
  if (notMeasured.length === 0) return [];
  return [
    `reported not measured ${notMeasured.length} (${notMeasured
      .map((entry) => `${entry.gate}: ${entry.detail}`)
      .join("; ")}), counted here and never among the gates that measured something`,
  ];
}

/** Run the five checks against a real checkout and return `{ id, findings }` for each, plus the numbers it prints. */
export function runHarnessConformance({ toolsDir, repoRoot }) {
  const population = deriveGatePopulation({ root: repoRoot });
  const ledger = gateRedProofLedger({ root: repoRoot });
  const gateNames = gateFileNames(population);
  // Run first, then describe: the not-measured set is a result of the runs, not of the declarations the census counts.
  const notMeasured = [];
  const gateFalsifierFindings = [
    ...checkGateFalsifiers({
      gateNames,
      toolsDir,
      zeroPopulation: ledger.zeroPopulationPass,
      undeclared: ledger.undeclared,
      staleDeclarations: ledger.stale,
      externalWithoutRunner: ledger.externalWithoutRunner,
      notMeasured,
    }),
    ...checkGateRegistry({ gateNames }),
  ];
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
      // the excluded half is a DECLARED exclusion (a script-backed gate this suite cannot run), not a scanner gap.
      notes: [
        ...describeGateFalsifierCensus(gateFalsifierCensus({ population: population.gates, ledger })),
        ...describeNotMeasuredGates(notMeasured),
      ],
      // A run that hides an undeclared gate or a report that cannot show its population is not a pass: it is blocked,
      // which is the honest third answer beside passed and failed.
      blocked: ledger.undeclared.length > 0 || ledger.zeroPopulationPass.length > 0,
      findings: gateFalsifierFindings,
    },
  ];
}
