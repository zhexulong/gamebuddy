#!/usr/bin/env node
/**
 * The static half of the pre-live ladder: every reason a live run can die that is visible in the tree, in seconds,
 * naming the drifting member.
 *
 * WHY: five live runs died in one day from causes that were detectable before a single model token was spent - an
 * action whose runner exists but whose fixture scenario the Mod cannot arm, a mod bundle deployed into the Steam
 * install, and a runner that treated a warp in flight as a world that cannot be acted on. Each of those is a
 * cross-file linkage, so no single gate owned it. This one does, and it fails loudly here instead of in the game.
 *
 * RUNGS (each stops the ladder on red, so the first line of a failure is the cause):
 *   L0  contract triad      - runs the existing gates as child processes and reports each exit code by name
 *   L1  linkage closure     - action ids x runner map x tools-side scenario x Mod-side scenario, DERIVED not listed
 *   L1b deploy isolation    - the launcher's resolved deploy root must not be inside the game installation
 *   L3  runner shape        - a one-shot `observeFresh({actionable:true})` may not be the basis of an assertion
 *   L2  action preflight    - only with `--action <id> --game`; delegates to `tools/preflight-live-run.mjs`
 *
 * USAGE:
 *   node tools/prelive.mjs --no-game                       # L0 + L1 + L1b + L3
 *   node tools/prelive.mjs --action <id>                    # the same, then `l2_skipped: needs --game`
 *   node tools/prelive.mjs --action <id> --game             # the same, then L2 for that action
 *
 * No game, no network, no model. Exit 1 on the first red rung.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";
import { resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { fixtureActions, fixtureScenario } from "./lib/stardew-native-local-player-fixture.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TOOLS = path.join(REPO, "tools");

/** The launcher's default game installation (`tools/live-run/game/launch-ladder-live.mjs`). */
export const DEFAULT_GAME_INSTALL = "D:/Steam/steamapps/common/Stardew Valley";

/**
 * L0: the contract triad, delegated to the gates that already exist. Reimplementing any of them here would give the
 * same fact two spellings, and the copy would be the one that goes stale.
 */
export const CONTRACT_TRIAD = Object.freeze([
  "tools/check-catalog-fact-ownership.mjs",
  "tools/audit-stardew-discovery-channels.mjs",
  "tools/check-stardew-fixture-action-coverage.mjs",
  "tools/check-harness-conformance.mjs",
]);

const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const MOD_CONFIG = "integrations/stardew/ModConfig.cs";
const HARNESS_LIB = "tools/lib/stardew-native-smoke-harness-v1.mjs";
const BASELINE = "tools/prelive-l3-baseline.json";

/**
 * L1 rule (e): a runner key that legitimately resolves to NO fixture scenario, with the reason. Silence is not
 * allowed - an empty scenario is indistinguishable from a missing branch, so every empty has to be argued here.
 */
export const NO_SCENARIO_REASON = Object.freeze({
  move_placed_furniture:
    "the fixture returns the ordinary world on purpose: the bed it lifts is the game's own starter furniture, and a " +
    "fixture Given would move it (tools/lib/stardew-native-local-player-fixture.mjs, `fixtureScenario`)",
  scene_reachable_probe:
    "its only action is read-only `observe_scene`; the probe measures reachability of the ordinary world from the " +
    "actor's own start tile and provisions no fixture fact",
});

/** Fields a snapshot carries that no actionability fence can falsify: asserting only these is not the defect. */
const ACTIONABILITY_INDEPENDENT_FIELDS = Object.freeze(["capabilities"]);

const RULE_LABELS = Object.freeze({
  "a:no_scenario_undeclared": "rule a - runner has no tools-side scenario and no declared noScenarioReason",
  "b:scenario_not_in_KnownFixtureScenarios": "rule b - scenario is absent from ModConfig.KnownFixtureScenarios",
  "c:no_mod_dispatch_block": 'rule c - no `FixtureScenario == "<id>"` dispatch block in ModEntry.Fixtures*.cs',
  "d:runner_file_missing": "rule d - the runner file named by the map does not exist",
});

//
// L0 - contract triad
//

/**
 * The command to run for one gate. A gate that has moved is discovered from `package.json` scripts starting with
 * `check:`/`audit:` and covering the same topic, and the DISCOVERED command is printed, so a missing gate can never
 * read as a pass.
 */
export function resolveGateCommand(gatePath, { exists = fs.existsSync, scripts = readScripts() } = {}) {
  if (exists(path.join(REPO, gatePath))) return { command: `node ${gatePath}`, discovered: false };
  const topic = /^(?:check|audit)(?:-stardew)?-([a-z0-9]+)/.exec(path.basename(gatePath))?.[1] ?? null;
  const candidates = Object.entries(scripts)
    .filter(([name, value]) => (name.startsWith("check:") || name.startsWith("audit:")) && typeof value === "string")
    .filter(([, value]) => topic !== null && value.includes(topic))
    .map(([, value]) => value.trim())
    .filter((value) => value.startsWith("node tools/"));
  const found = candidates[0] ?? null;
  return found === null ? { command: null, discovered: true, topic } : { command: found, discovered: true, topic };
}

function readScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * Run every L0 gate and report each exit code by name with its own wall time. All of them run (a gate that is red
 * must not hide the three that are also red), and the rung verdict is red when any is.
 */
export function runContractTriad({
  gates = CONTRACT_TRIAD,
  resolveCommand = resolveGateCommand,
  run = (command) => spawnSync(process.execPath, [command.replace(/^node\s+/, "")], { cwd: REPO, encoding: "utf8" }),
} = {}) {
  const results = gates.map((gate) => {
    const resolved = resolveCommand(gate);
    if (resolved.command === null) {
      return { gate, command: null, exitCode: null, missing: true, ms: 0, discovered: resolved.discovered };
    }
    const startedAt = Date.now();
    const outcome = run(resolved.command);
    return {
      gate,
      command: resolved.command,
      exitCode: typeof outcome.status === "number" ? outcome.status : 1,
      missing: false,
      discovered: resolved.discovered,
      ms: Date.now() - startedAt,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
    };
  });
  const red = results.filter((entry) => entry.missing || entry.exitCode !== 0);
  return { id: "l0", status: red.length === 0 ? "passed" : "failed", gates: results, red };
}

//
// L1 - linkage closure
//

/**
 * The four authorities, cross-checked. Every rule reports the ACTION by name plus the scenario, so a reader knows
 * which member drifted without opening the file.
 *
 * `resolveScenario(action)` is the tools-side authority (`fixtureScenario(fixtureActions(action), action)` in
 * production), so the test can drive a fabricated mapping through the same rules.
 */
export function checkLinkageClosure({
  runnerMap,
  resolveScenario,
  knownScenarios,
  dispatchScenarios,
  noScenarioReason = NO_SCENARIO_REASON,
  fileExists,
}) {
  const violations = [];
  const actions = Object.keys(runnerMap).sort();
  let linked = 0;
  for (const action of actions) {
    const runner = runnerMap[action];
    const scenario = resolveScenario(action);
    const failed = [];
    if (scenario === "" || scenario === undefined || scenario === null) {
      if (typeof noScenarioReason[action] !== "string" || noScenarioReason[action].trim() === "") {
        failed.push("a:no_scenario_undeclared");
      }
    } else {
      if (!knownScenarios.has(scenario)) failed.push("b:scenario_not_in_KnownFixtureScenarios");
      if (!dispatchScenarios.has(scenario)) failed.push("c:no_mod_dispatch_block");
    }
    if (!fileExists(runner)) failed.push("d:runner_file_missing");
    if (failed.length === 0) linked++;
    else violations.push({ action, scenario: scenario ?? "", runner, failed });
  }
  // A reason for an action that needs none is the same drift from the other side: it silently excuses a scenario
  // that has since appeared, and it would excuse the next one written for the same key.
  const staleReasons = Object.keys(noScenarioReason).filter((action) => {
    if (!(action in runnerMap)) return true;
    const scenario = resolveScenario(action);
    return scenario !== "" && scenario !== undefined && scenario !== null;
  });
  return {
    id: "l1",
    status: violations.length === 0 && staleReasons.length === 0 ? "passed" : "failed",
    total: actions.length,
    linked,
    violations,
    staleReasons,
  };
}

/** The Mod-side dispatch blocks: both spellings the dispatcher uses, across the `ModEntry.Fixtures*.cs` partials. */
export function parseModDispatchScenarios(source) {
  const scenarios = new Set();
  for (const match of source.matchAll(/FixtureScenario (?:==|is) "([^"]+)"/g)) scenarios.add(match[1]);
  return scenarios;
}

/**
 * `ModConfig.KnownFixtureScenarios` as a set. The initializer is brace-matched, and comments are blanked first: the
 * list is documented inline, and a quoted word inside a comment otherwise parses as a scenario name.
 */
export function parseKnownFixtureScenarios(source) {
  const start = source.indexOf("KnownFixtureScenarios = new[]");
  if (start < 0) throw new Error("known_fixture_scenarios_block_missing");
  const open = source.indexOf("{", start);
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '"' && source[index - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error("known_fixture_scenarios_block_unterminated");
  const scenarios = new Set();
  for (const match of blankComments(source.slice(open, end)).matchAll(/"([^"]*)"/g)) {
    if (match[1].length > 0) scenarios.add(match[1]);
  }
  return scenarios;
}

//
// L1b - deploy isolation
//

/**
 * Is `deployRoot` inside `gameInstall`? Case-insensitive and separator-normalised, because this is Windows and both
 * spellings of the same directory appear in the tree.
 */
export function isInside(deployRoot, gameInstall) {
  const normalise = (value) => path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const deploy = normalise(deployRoot);
  const game = normalise(gameInstall);
  return deploy === game || deploy.startsWith(`${game}/`);
}

/**
 * The deploy root must not be inside the Steam install. This family breached twice in one day (0ee9b288, da2902d4 -
 * both wrote the mod bundle into the install), and Steam reports the install as modified when we do it.
 */
export function checkDeployIsolation({ deployRoot, gameInstall, allowGameMods = false }) {
  const inside = isInside(deployRoot, gameInstall);
  return {
    id: "l1b",
    status: inside && !allowGameMods ? "failed" : "passed",
    deployRoot: path.resolve(deployRoot),
    gameInstall: path.resolve(gameInstall),
    insideGameInstall: inside,
    allowGameMods,
    message: inside
      ? `${path.resolve(deployRoot)} is inside the game installation ${path.resolve(gameInstall)}`
      : `${path.resolve(deployRoot)} is outside the game installation ${path.resolve(gameInstall)}`,
  };
}

//
// L3 - runner shape
//

/** Blank comments out while preserving every offset and newline, so a line number stays true. */
export function blankComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index++;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      out += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        out += source[index] === "\n" ? "\n" : " ";
        index++;
      }
      out += "  ";
      index += 2;
      continue;
    }
    out += source[index];
    index++;
  }
  return out;
}

/** Every `<name>(` call site, with its paren-balanced argument text and its 1-based line. */
export function callSites(source, name) {
  const sites = [];
  const needle = `${name}(`;
  let index = source.indexOf(needle);
  while (index >= 0) {
    let depth = 0;
    let end = -1;
    for (let cursor = index + needle.length - 1; cursor < source.length; cursor++) {
      if (source[cursor] === "(") depth++;
      else if (source[cursor] === ")") {
        depth--;
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    sites.push({
      start: index,
      end,
      args: source.slice(index + needle.length, end - 1),
      line: source.slice(0, index).split("\n").length,
    });
    index = source.indexOf(needle, end);
  }
  return sites;
}

/** The statement that follows a call site, collapsed to one line. Empty when the call ends a block. */
export function nextStatement(source, end) {
  let cursor = end;
  while (cursor < source.length && /[\s;]/.test(source[cursor])) cursor++;
  if (cursor >= source.length || source[cursor] === "}" || source[cursor] === ")") return "";
  let depth = 0;
  let out = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "(" || character === "{" || character === "[") depth++;
    else if (character === ")" || character === "}" || character === "]") depth--;
    if (character === ";" && depth <= 0) break;
    out += character;
    cursor++;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The body of `function <name>(...) { ... }` in one source, or null. */
export function functionBody(source, name) {
  const head = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`, "u").exec(source);
  if (head === null) return null;
  const paramsStart = head.index + head[0].length;
  let depth = 1;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")") {
      depth--;
      if (depth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  if (paramsEnd < 0) return null;
  const brace = source.indexOf("{", paramsEnd);
  if (brace < 0) return null;
  depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return { params: source.slice(paramsStart, paramsEnd), body: source.slice(brace, index + 1) };
    }
  }
  return null;
}

function memberFields(text, binding) {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`\\b${escaped}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, "gu"))].map(
    (match) => match[1],
  );
}

/**
 * What one assertion statement READS. This is the whole exemption and it is deliberately not a name test: a call
 * site is exempt only when every field it can touch is actionability-independent (`snapshot.capabilities`, which no
 * warp can falsify). An unresolved callee is treated as reading the whole snapshot, so reusing
 * `assertRequiredCapabilities` for a world assertion cannot smuggle itself through.
 */
export function snapshotReadClassification({ statement, binding, lookup }) {
  const fields = [];
  const wholeSnapshots = [];
  for (const match of statement.matchAll(/([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = match[1];
    if (["if", "for", "while", "switch", "catch", "return", "function", "typeof", "new"].includes(name)) continue;
    const args = callSites(statement, name)[0]?.args ?? "";
    if (!new RegExp(`(^|[^\\w$.])${binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*($|[,)])`, "u").test(args))
      continue;
    const resolved = lookup(name);
    if (resolved === null) {
      wholeSnapshots.push(name);
      continue;
    }
    fields.push(...memberFields(resolved.body, firstParamName(resolved)));
  }
  fields.push(...memberFields(statement, binding));
  return { fields: [...new Set(fields)], wholeSnapshots };
}

function firstParamName(body) {
  return (/([A-Za-z_$][\w$]*)/.exec(body.params ?? "") ?? [null, null])[1];
}

/**
 * L3 rules (a) and (b).
 *
 * (a) A runner may not base an assertion on ONE-SHOT `observeFresh({ actionable: true })`. A warp in flight is not a
 *     world that cannot be acted on, and treating it as one cost a live run. The wait helper (`waitForActionable`)
 *     is what distinguishes "not yet" from "not possible".
 * (b) The runner must be reachable from the descriptor map, or carry an inline opt-out stating why it is auxiliary.
 *
 * A violation is (file, line, fact) where `fact` is the world fact the assertion reads. Rule (a) sites are listed
 * in `tools/prelive-l3-baseline.json`; that baseline is a ratchet - an unlisted site is red, and a listed site that no
 * longer violates is red too, so the number can only go down. The baseline records HOW each site was classified, so
 * the classification can be checked rather than trusted.
 */
export function checkRunnerShape({ runners, harnessSource, baseline, reachableRunners = new Set() }) {
  const violations = [];
  const known = [];
  const baselineSites = baseline?.knownSites ?? [];
  const checked = runners.length;
  const knownRunners = new Set();
  for (const runner of runners) {
    const source = blankComments(runner.source);
    const optOuts = optOutRules(runner.source);
    const shapeViolations = runnerShapeViolations({
      file: runner.file,
      source,
      harnessSource,
      reachable: reachableRunners.size === 0 || reachableRunners.has(runner.file),
    });
    const emitted = shapeViolations.filter((entry) => !optOuts.has(entry.rule.slice(0, 1)));
    for (const entry of emitted) {
      const site = baselineSites.find((candidate) => candidate.file === entry.file && candidate.fact === entry.fact);
      if (site === undefined) violations.push({ ...entry, baselined: false });
      else {
        site.seen = (site.seen ?? 0) + 1;
        known.push(entry);
        knownRunners.add(entry.file);
        if ((site.seen ?? 0) > (site.count ?? 1)) violations.push({ ...entry, baselined: true });
      }
    }
  }
  for (const site of baselineSites) {
    if ((site.seen ?? 0) === 0 || (site.seen ?? 0) < (site.count ?? 1))
      violations.push({ rule: "baseline_stale", file: site.file, fact: site.fact, line: 0, baselined: true });
  }
  return {
    id: "l3",
    status: violations.length === 0 ? "passed" : "failed",
    checked,
    knownRunners: knownRunners.size,
    knownSites: known.length,
    violations,
  };
}

/**
 * The per-file opt-out: `// prelive-l3-opt-out <a|b>: <reason>`. A marker with no reason is not an opt-out - the
 * reason is the whole point - so it is ignored and the violation stands.
 */
export function optOutRules(source) {
  const reasons = new Map();
  for (const match of source.matchAll(/prelive-l3-opt-out\s+([ab])\s*:\s*(\S[^\n]*)/gu))
    reasons.set(match[1], match[2].trim());
  return reasons;
}

/** The variable an `observeFresh(...)` call is bound to, whether by declaration or by plain assignment. */
export function observationBinding(source, callStart) {
  const lineStart = source.lastIndexOf("\n", callStart) + 1;
  return /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/u.exec(
    source.slice(lineStart, callStart),
  )?.[1];
}

function runnerShapeViolations({ file, source, harnessSource, reachable }) {
  const violations = [];
  if (!reachable) violations.push({ rule: "b:unreachable_runner", file, line: 0, fact: "not in the descriptor map" });
  if (/waitForActionable\s*\(/.test(source)) return violations;
  for (const site of callSites(source, "observeFresh")) {
    if (!/actionable\s*:\s*true/.test(site.args)) continue;
    const statement = nextStatement(source, site.end);
    if (statement === "" || !/throw|(^|[^.\w])(assert|require|expect)[\w$]*\s*\(/u.test(statement)) continue;
    const binding = observationBinding(source, site.start);
    if (binding === undefined) {
      violations.push({
        rule: "a:inline_observation",
        file,
        line: site.line,
        fact: "inline observation cannot be classified",
      });
      continue;
    }
    const lookup = (name) => functionBody(source, name) ?? functionBody(harnessSource, name);
    const { fields, wholeSnapshots } = snapshotReadClassification({ statement, binding, lookup });
    const worldFields = fields.filter((field) => !ACTIONABILITY_INDEPENDENT_FIELDS.includes(field));
    if (wholeSnapshots.length > 0) {
      violations.push({
        rule: "a:whole_snapshot_assertion",
        file,
        line: site.line,
        fact: `whole_snapshot:${wholeSnapshots[0]}`,
      });
      continue;
    }
    if (worldFields.length === 0) continue;
    violations.push({ rule: "a:one_shot_actionable_assertion", file, line: site.line, fact: worldFields[0] });
  }
  return violations;
}

//
// CLI
//

const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");

function runnerFiles(directory = TOOLS) {
  return fs
    .readdirSync(directory)
    .filter((name) => /^run-stardew-native-local-player-.*-smoke\.mjs$/u.test(name))
    .sort();
}

function reachableRunnerNames() {
  const names = new Set(Object.values(STARDEW_EXPERIMENTAL_ACTION_RUNNERS));
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES) if (gate?.runner) names.add(gate.runner);
  return names;
}

export function linkageRung() {
  const surface = JSON.parse(read(SURFACE));
  const known = parseKnownFixtureScenarios(read(MOD_CONFIG));
  const dispatch = parseModDispatchScenarios(
    fs
      .readdirSync(path.join(REPO, "integrations/stardew"))
      .filter((name) => /^ModEntry\.Fixtures.*\.cs$/u.test(name))
      .map((name) => read(`integrations/stardew/${name}`))
      .join("\n"),
  );
  const report = checkLinkageClosure({
    runnerMap: STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
    resolveScenario: (action) => fixtureScenario(fixtureActions(action) ?? [], action),
    knownScenarios: known,
    dispatchScenarios: dispatch,
    fileExists: (runner) => fs.existsSync(path.join(TOOLS, runner)),
  });
  return {
    ...report,
    surfaceActions: surface.actions.length,
    knownScenarios: known.size,
    dispatchScenarios: dispatch.size,
  };
}

export function deployRung({ env = process.env, modsPath = null, gameInstall = null, allowGameMods = false } = {}) {
  const roots = resolveStardewFixtureRoots({ env });
  const deployRoot = path.resolve(
    modsPath ?? nonEmpty(env.GAMEBUDDY_STARDEW_MODS_DIR) ?? path.join(roots.fixturesRoot, "mods"),
  );
  const gameRoot = path.resolve(gameInstall ?? nonEmpty(env.GAMEBUDDY_STARDEW_GAME_DIR) ?? DEFAULT_GAME_INSTALL);
  return checkDeployIsolation({ deployRoot, gameInstall: gameRoot, allowGameMods });
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function shapeRung({ directory = TOOLS } = {}) {
  const files = runnerFiles(directory);
  const baselinePath = path.join(REPO, BASELINE);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { knownSites: [] };
  return checkRunnerShape({
    runners: files.map((file) => ({ file, source: fs.readFileSync(path.join(directory, file), "utf8") })),
    harnessSource: read(HARNESS_LIB),
    baseline,
    reachableRunners: reachableRunnerNames(),
  });
}

/**
 * L2: the action's own live preflight, DELEGATED - `tools/preflight-live-run.mjs` already owns every reason a live run
 * fails before it starts. The ladder's job is to reach it for one named action, not to restate its checks.
 */
export function actionRung({ action, deployRoot, run = defaultRun }) {
  const command = `node tools/preflight-live-run.mjs --mods-path ${deployRoot} --action ${action}`;
  const outcome = run(command);
  return { id: "l2", status: outcome.status === 0 ? "passed" : "failed", command, exitCode: outcome.status };
}

function defaultRun(command) {
  const [executable, ...rest] = command.split(" ");
  return spawnSync(executable === "node" ? process.execPath : executable, rest, { cwd: REPO, encoding: "utf8" });
}

export function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
  };
  return {
    noGame: argv.includes("--no-game"),
    game: argv.includes("--game"),
    action: value("--action"),
    modsPath: value("--mods-path"),
    gameInstall: value("--game-install"),
    allowGameMods: argv.includes("--allow-game-mods"),
  };
}

/**
 * The ladder as data: rungs run in order and the first red stops it, so a failure is never a later consequence of
 * an earlier one.
 */
export function runLadder({ rungs, stopOnFirstRed = true }) {
  const ran = [];
  for (const rung of rungs) {
    const report = rung();
    ran.push(report);
    if (stopOnFirstRed && report.status !== "passed") break;
  }
  const firstRed = ran.find((report) => report.status !== "passed") ?? null;
  return { status: firstRed === null ? "passed" : "failed", rungs: ran, firstRed };
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.noGame && options.action === null) {
    process.stderr.write("usage: node tools/prelive.mjs --no-game | --action <id> [--game]\n");
    process.exitCode = 2;
    return;
  }
  const startedAt = Date.now();
  // The action is an ARGUMENT, not a rung: an action that no authority publishes is refused before anything runs, so
  // `--action open_geode` names its own gap instead of disappearing behind an unrelated red rung.
  if (options.action !== null && !knownAction(options.action)) {
    process.stderr.write(`unknown_action:${options.action} (neither a published action id nor a runner-map key)\n`);
    process.exitCode = 2;
    return;
  }
  const deploy = deployRung(options);
  const ladder = runLadder({
    rungs: [
      () => runContractTriad(),
      () => linkageRung(),
      () => deploy,
      () => shapeRung(),
      ...(options.action === null || !options.game
        ? []
        : [() => actionRung({ action: options.action, deployRoot: deploy.deployRoot })]),
    ],
  });
  const notice = options.action !== null && !options.game ? "l2_skipped: needs --game" : null;
  process.stdout.write(format(ladder, { elapsedMs: Date.now() - startedAt, options, notice }));
  if (ladder.status !== "passed") process.exitCode = 1;
}

/** Is this action id published by the surface, or a runner-map key (a lane key such as `fridge_store`)? */
function knownAction(action) {
  const published = JSON.parse(read(SURFACE)).actions.some((entry) => entry.actionId === action);
  return published || action in STARDEW_EXPERIMENTAL_ACTION_RUNNERS;
}

/** The report, as text: every rung's counts plus the member each violation names. */
export function format(ladder, { elapsedMs, options, notice }) {
  const lines = [`prelive: static ladder${options.noGame ? " (--no-game)" : ""}`];
  for (const rung of ladder.rungs) {
    if (rung.id === "l0") {
      for (const gate of rung.gates) {
        const where = gate.discovered ? " (discovered, not at the expected path)" : "";
        const outcome = gate.missing ? "missing" : `exit=${gate.exitCode}`;
        lines.push(`  l0 ${path.basename(gate.gate)} ${outcome} ${gate.ms}ms${where}`);
        lines.push(`     command: ${gate.command ?? "(none found)"}`);
      }
      lines.push(`  l0: ${rung.status} (${rung.gates.length} gates, ${rung.red.length} red)`);
      for (const gate of rung.red) {
        lines.push(`    red: ${gate.gate} exit=${gate.exitCode ?? "missing"}`);
        // The gate's own words, not a summary: the member it names is the whole point of running it here.
        for (const line of `${gate.stdout ?? ""}${gate.stderr ?? ""}`
          .split("\n")
          .filter((entry) => entry.trim() !== "")
          .slice(0, 20))
          lines.push(`      | ${line.trimEnd()}`);
      }
    } else if (rung.id === "l1") {
      const counts =
        rung.surfaceActions === undefined
          ? ""
          : ` (surface=${rung.surfaceActions} actions, KnownFixtureScenarios=${rung.knownScenarios}, mod_dispatch=${rung.dispatchScenarios})`;
      lines.push(`  l1: linked ${rung.linked} of ${rung.total}${counts}`);
      for (const entry of rung.violations)
        lines.push(
          `    ${entry.action} scenario=${entry.scenario || "(none)"} failed ${entry.failed.join(",")} :: ${entry.failed.map((code) => RULE_LABELS[code] ?? code).join(" | ")}`,
        );
      for (const action of rung.staleReasons)
        lines.push(`    noScenarioReason is stale: ${action} now resolves to a scenario; remove the entry`);
      lines.push(`  l1: ${rung.status}`);
    } else if (rung.id === "l1b") {
      lines.push(`  l1b: deployRoot=${rung.deployRoot}`);
      lines.push(`  l1b: gameInstall=${rung.gameInstall}`);
      lines.push(`  l1b: ${rung.status} - ${rung.message}`);
    } else if (rung.id === "l3") {
      lines.push(`  l3: shape checked ${rung.checked} runners; known ${rung.knownRunners} of ${rung.checked}`);
      for (const entry of rung.violations)
        lines.push(
          `    ${entry.file}:${entry.line} ${entry.rule} asserts ${entry.fact}${entry.baselined ? " (listed in the baseline but no longer matches it)" : ""}`,
        );
      lines.push(`  l3: ${rung.status}`);
    } else if (rung.id === "l2") {
      lines.push(`  l2: ${rung.status} (exit=${rung.exitCode}) command: ${rung.command}`);
    }
  }
  // An invocation fact, not a rung outcome: it is printed even when an earlier rung is red, because it says what this
  // run did NOT check.
  if (notice !== null) lines.push(`  ${notice}`);
  lines.push(
    `prelive: ${ladder.status}${ladder.firstRed === null ? "" : ` (stopped at ${ladder.firstRed.id})`} in ${elapsedMs}ms`,
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) main(process.argv.slice(2));
