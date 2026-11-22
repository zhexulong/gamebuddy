#!/usr/bin/env node
/**
 * WHICH CATALOG ACTIONS HAVE A LIVE GATE, AND WHICH HAVE NONE.
 *
 * WHY. `tools/lib/stardew-action-gate-route.mjs` answers, for any action id, the one artifact its live gate lives in: a
 * `tools/<runner>` shared-harness runner, or a `contracts/smoke/<actionId>.json` contract run by
 * `tools/run-native-action-slice.mjs`. Two other gates read the same tables and both check AGREEMENT, never COVERAGE:
 * `check-stardew-action-promotion.mjs` checks that a row's runner exists ON DISK (published rows only) and
 * `check-stardew-promotion-parity.mjs` checks that the four promotion places agree - which it can do while an action has
 * no gate at all, because a runner entry is legal-but-not-required for an experimental action.
 *
 * Measured 2026-11-14 on this tree: `put_item_in_fish_tank` and `place_item_on_pedestal` are registered executable with
 * no gate row, no runner entry and no contract, so the route resolver refuses both with
 * `stardew_action_gate_route_absent` and `live-action` refuses the action. Both gates above are green about it because a
 * missing gate is not what either of them reads. Those two are the findings this gate has always reported; everything
 * else is now routed.
 *
 * THE POPULATION comes from the Mod catalog, never from a list here: every registration `parseModRegistrations` finds -
 * the same parser `check-stardew-promotion-parity.mjs` uses, so the gates cannot disagree about what an action is. That
 * helper matches `E(...)`, which the catalog declares for `FarmhandOperationKind.Execution`; the read-only `R(...)`
 * registrations are counted separately and printed as excluded, because a read-only action has no execution to drive and
 * a gate for one would be evidence of nothing. The catalog's own registration-level calls are attributed to a helper
 * first, and a helper this gate does not know is a finding rather than a silent narrowing of the population: `E` and `R`
 * are the two the catalogue uses, and a third would otherwise drop out of coverage without a word.
 *
 * THE AUTHORITY for "where does this action's gate live" is `resolveStardewActionGateRoute` - the launcher's and the
 * gate suites' own answer - so this gate cannot invent a route, and a table edit moves every reader at once. A gate row
 * that is the action's CONTRACT is covered here: it is a live gate that outlives the runner that first proved it, and the
 * route says how it runs. Counting only runners is what made six contract rows read as unrouted (`null` was reported as
 * `runner_name_is_not_a_runner:<action>:null`), which is a measurement that names the wrong fact.
 *
 * THE GATE ARTIFACT MUST BE IN THE INDEX, not merely on disk. `tools/lib/indexed-sources.mjs` states the rule and the
 * reason: a file that is not in the index is not yet anyone's, and an untracked artifact is another lane's work in
 * flight. It is also the honest reading of "has a live gate": a gate that is not committed cannot be re-run by the next
 * reader, which is the same standard `check-stardew-action-promotion.mjs` applies when it refuses to read untracked dumps
 * as evidence. The census line publishes the files this reading dropped, so a green line and a stale lane cannot be
 * confused: `untracked not counted 1: tools/run-...-sweep-scythe-smoke.mjs`. A file that is untracked today is a
 * one-commit-away route, and the finding names the commit that would close it, not a defect in the mapping.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN. No catalog read, an empty registration list, a catalog smaller than the
 * recorded floor, or a runner-file census git refuses to answer all print `not_measured:<why>` and exit 2.
 *
 * THE DUPLICATION CENSUS is informational and NEVER sets the exit code. It exists because the next decision - whether a
 * shared runner harness is worth building - needs a number instead of an impression. For each of the three steps every
 * runner performs in its own words (resolving the fixture/save it runs against, building the request envelope, shaping
 * the evidence bundle it prints) it counts how many distinct spellings the tree carries and names the two largest
 * groups. Its readings are structural, so they are a CEILING on distinctness, not a floor: a step built through a
 * variable or a spread is read as the same spelling as another that does the same, and the count cannot see a
 * difference in behaviour that leaves these markers alone. It reads RUNNER sources only: a contract route already has
 * no code to duplicate.
 *
 * WHAT THIS GATE DOES NOT SEE, said out loud so a green run is not read as more than it is:
 *   - whether the gate drives THAT action, or asserts as much as the runner it replaced. A route that resolves is a
 *     route, not a proof; the live run and its receipt are the proof, and `check-stardew-action-promotion.mjs` owns the
 *     receipt question.
 *   - whether the gate is still runnable (a broken import, a stale fixture scenario, a contract the slice driver cannot
 *     derive). `node --check` owns syntax and the run itself owns the rest.
 *   - the evidence direction. A `live_verified` action with no succeeded receipt in either durable store is NOT a
 *     finding here: measured 2026-11-14, 70 of the 94 live_verified/published actions have none, and the promotion gate
 *     reads evidence only for the opposite lag (`experimental_action_has_live_evidence`). That gap is real and is
 *     reported, not closed, by this file.
 *
 * VERDICT. `actions examined N · with a live gate G · runner M · contract K · without J`, then the J by name, then the
 * artifact census, then one line per finding. Every examined action is counted once: `M + K === G` and `G + J === N`.
 * Exit 0 covered, 1 an action with no live gate, 2 blocked.
 *
 * red-proof: inject  a catalog registration with no route anywhere -> `action_without_a_live_gate:<action>`
 *   (tools/check-stardew-live-runner-coverage.test.mjs)
 * red-proof: inject  one action removed from the route resolver's tables -> `action_without_a_live_gate:use_mine_ladder`
 *   (tools/check-stardew-live-runner-coverage.test.mjs)
 * red-proof: inject  an index that does not carry a resolved runner file ->
 *   `runner_file_missing:sweep_scythe:run-stardew-native-local-player-sweep-scythe-smoke.mjs`
 *   (tools/check-stardew-live-runner-coverage.test.mjs)
 * red-proof: inject  an index that does not carry a contract-route action's contract ->
 *   `contract_file_missing:harvest_bush:contracts/smoke/harvest_bush.json`
 *   (tools/check-stardew-live-runner-coverage.test.mjs)
 * red-proof: inject  an empty catalog -> `not_measured:catalog_unreadable`, exit 2
 *   (tools/check-stardew-live-runner-coverage.test.mjs)
 *
 * USAGE
 *   node tools/check-stardew-live-runner-coverage.mjs
 */

export const gateDeclaration = {
  id: "check-stardew-live-runner-coverage",
  domain: "stardew",
  tier: "l0",
  kind: "totality",
};

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describeUntracked, untrackedSources } from "../../tools/lib/indexed-sources.mjs";
import {
  CONTRACT_ROUTE,
  RUNNER_ROUTE,
  SMOKE_CONTRACT_DIRECTORY,
  resolveStardewActionGateRoute,
} from "../../tools/lib/stardew-action-gate-route.mjs";
import { parseModRegistrations } from "../../tools/promote-stardew-action.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const TOOLS_DIRECTORY = "tools";

export const CATALOG_PATH = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";

/** The one name shape a runner the launcher can import has. A runner route naming anything else is its own finding. */
export const RUNNER_FILE_PATTERN = /^run-stardew-native-local-player-[a-z0-9-]+-smoke\.mjs$/u;

/** A scan that found less than this measured nothing, and must not read as covered. */
export const MINIMUM_CATALOG_ACTIONS = 90;

/** The catalog's registration-level helpers, each with the operation kind it declares. */
export const REGISTRATION_HELPERS = Object.freeze({ E: "execution", R: "read_only" });
const REGISTRATIONS_BODY = /\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/u;
const REGISTRATION_CALL = /(?:^|[\s;{])([A-Z])\(\s*"([a-z][a-z0-9_]*)"\s*,\s*"([a-z][a-z0-9_]*)"/gu;

/**
 * Every registration-level call in the catalog's own array, attributed to its helper.
 *
 * A helper this gate does not know is returned rather than dropped: the population is "every action the catalog
 * declares", so a third helper is a population this gate cannot read, not a member it may ignore.
 */
export function readCatalogRegistrationCalls(catalogSource) {
  const body = REGISTRATIONS_BODY.exec(String(catalogSource ?? ""))?.[1];
  if (body === undefined) return null;
  const calls = [];
  for (const match of body.matchAll(REGISTRATION_CALL))
    calls.push({ helper: match[1], actionId: match[2], familyId: match[3] });
  return calls;
}

export function runnerFilesInIndex({ root = ROOT, toolsDirectory = "tools" } = {}) {
  const onDisk = readdirSync(resolve(root, toolsDirectory))
    .filter((name) => RUNNER_FILE_PATTERN.test(name))
    .sort();
  const untracked = untrackedSources({ root, roots: [toolsDirectory] });
  const names = new Set(untracked);
  const untrackedRunners = onDisk.filter((name) => names.has(`${toolsDirectory}/${name}`));
  const indexed = onDisk.filter((name) => !names.has(`${toolsDirectory}/${name}`));
  return { indexed, untracked: untrackedRunners, onDisk };
}

/**
 * The GATE ARTIFACTS this tree carries, split by whether the index holds them: the runner files and the smoke contracts.
 *
 * Both shapes are one population because a route may name either, and a census that counted only runners would report a
 * contract-routed action as missing the artifact it does not have. The directory scan is the population and the index
 * subtracts from it, which is `indexed-sources.mjs`'s reading: the untracked names are published rather than swallowed,
 * because a gate another lane has not staged is exactly the case a green census would otherwise hide.
 */
export function gateArtifactsInIndex({
  root = ROOT,
  toolsDirectory = TOOLS_DIRECTORY,
  contractDirectory = SMOKE_CONTRACT_DIRECTORY,
} = {}) {
  const runnersOnDisk = readdirSync(resolve(root, toolsDirectory))
    .filter((name) => RUNNER_FILE_PATTERN.test(name))
    .sort();
  const contractsOnDisk = readdirSync(resolve(root, contractDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${contractDirectory}/${name}`);
  const untracked = untrackedSources({ root, roots: [toolsDirectory, contractDirectory] });
  const runnerPaths = runnersOnDisk.map((name) => `${toolsDirectory}/${name}`);
  return {
    runners: runnersOnDisk.filter((name) => !untracked.has(`${toolsDirectory}/${name}`)),
    contracts: contractsOnDisk.filter((path) => !untracked.has(path)),
    untracked: [...runnerPaths, ...contractsOnDisk].filter((path) => untracked.has(path)),
    onDisk: { runners: runnersOnDisk, contracts: contractsOnDisk },
  };
}

/**
 * The coverage verdict: one row per executable catalog registration, and the findings that say which has no live gate.
 *
 * `resolveRoute` is injected so a falsifier can delete one route without editing the launcher's tables; its default is
 * the one resolver the launcher and the gate suites also read, so the real run cannot disagree with them. `artifacts`
 * is what the index carries, in the two shapes a route can name.
 */
export function checkLiveRunnerCoverage({
  catalogSource,
  artifacts,
  resolveRoute = resolveStardewActionGateRoute,
  minimumActions = MINIMUM_CATALOG_ACTIONS,
}) {
  const calls = readCatalogRegistrationCalls(catalogSource);
  if (calls === null) return blocked("catalog_unreadable");
  const unknownHelpers = [...new Set(calls.map((call) => call.helper))].filter(
    (helper) => !Object.hasOwn(REGISTRATION_HELPERS, helper),
  );
  if (unknownHelpers.length > 0)
    return blocked(`catalog_registration_helper_unknown:${unknownHelpers.sort().join(",")}`);

  const executable = calls.filter((call) => REGISTRATION_HELPERS[call.helper] === "execution");
  const readOnly = calls.filter((call) => REGISTRATION_HELPERS[call.helper] === "read_only");
  const registrations = parseModRegistrations(String(catalogSource));
  if (registrations.length === 0) return blocked("catalog_population_empty");
  if (registrations.length !== executable.length)
    return blocked(`catalog_population_incomplete:${registrations.length}/${executable.length}`);
  if (registrations.length < minimumActions)
    return blocked(`catalog_population_too_small:${registrations.length}<${minimumActions}`);

  const indexedRunners = new Set(artifacts.runners);
  const indexedContracts = new Set(artifacts.contracts);
  const findings = [];
  const rows = [];
  for (const registration of registrations) {
    const actionId = registration.actionId;
    const route = resolveRoute(actionId);
    if (route.route === null) {
      findings.push(`action_without_a_live_gate:${actionId}`);
      rows.push({ actionId, route: null, gate: null, finding: "no_route" });
      continue;
    }
    if (route.problem !== null) {
      // The route exists in the table and its artifact cannot be used: the contract is absent or unreadable, or the row
      // disagrees with it. The resolver names the action, the code and the path, so this finding names all three.
      findings.push(
        `gate_route_refused:${actionId}:${route.problem.code}${
          route.problem.detail === null ? "" : ` ${route.problem.detail}`
        }`,
      );
      rows.push({ actionId, route: route.route, gate: route.gate, finding: "route_refused" });
      continue;
    }
    if (route.route === CONTRACT_ROUTE) {
      if (!indexedContracts.has(route.gate)) {
        findings.push(`contract_file_missing:${actionId}:${route.gate}`);
        rows.push({ actionId, route: CONTRACT_ROUTE, gate: route.gate, finding: "contract_file_missing" });
        continue;
      }
      rows.push({ actionId, route: CONTRACT_ROUTE, gate: route.gate, finding: null });
      continue;
    }
    const runner = route.gate.startsWith(`${TOOLS_DIRECTORY}/`)
      ? route.gate.slice(TOOLS_DIRECTORY.length + 1)
      : route.gate;
    if (!RUNNER_FILE_PATTERN.test(runner)) {
      findings.push(`gate_is_not_a_runner:${actionId}:${String(route.gate)}`);
      rows.push({ actionId, route: RUNNER_ROUTE, gate: route.gate, finding: "not_a_runner_name" });
      continue;
    }
    if (!indexedRunners.has(runner)) {
      findings.push(`runner_file_missing:${actionId}:${runner}`);
      rows.push({ actionId, route: RUNNER_ROUTE, gate: route.gate, finding: "runner_file_missing" });
      continue;
    }
    rows.push({ actionId, route: RUNNER_ROUTE, gate: route.gate, finding: null });
  }

  const routed = rows.filter((row) => row.finding === null);
  const unrouted = rows.filter((row) => row.finding !== null);
  const runnerRouted = routed.filter((row) => row.route === RUNNER_ROUTE);
  const contractRouted = routed.filter((row) => row.route === CONTRACT_ROUTE);
  const routedRunnerFiles = new Set(runnerRouted.map((row) => row.gate.slice(`${TOOLS_DIRECTORY}/`.length)));
  const orphanRunners = [...indexedRunners].filter((file) => !routedRunnerFiles.has(file)).sort();
  return Object.freeze({
    schema: "gamebuddy-stardew-live-runner-coverage/v2",
    blocked: null,
    examined: rows.length,
    routed: routed.length,
    runnerRouted: runnerRouted.length,
    contractRouted: contractRouted.length,
    without: unrouted.length,
    readOnlyExcluded: readOnly.length,
    indexedRunners: indexedRunners.size,
    indexedContracts: indexedContracts.size,
    orphanRunners,
    unrouted: Object.freeze(
      unrouted.map((row) => Object.freeze({ actionId: row.actionId, gate: row.gate, finding: row.finding })),
    ),
    findings: Object.freeze(findings),
    ok: findings.length === 0,
  });
}

/** A reading that could not be made. Blocked, exit 2, with the reason - not an empty population that agrees with itself. */
export function blocked(reason) {
  return Object.freeze({
    schema: "gamebuddy-stardew-live-runner-coverage/v2",
    blocked: reason,
    examined: 0,
    routed: 0,
    runnerRouted: 0,
    contractRouted: 0,
    without: 0,
    readOnlyExcluded: 0,
    indexedRunners: 0,
    indexedContracts: 0,
    orphanRunners: Object.freeze([]),
    unrouted: Object.freeze([]),
    findings: Object.freeze([]),
    ok: false,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The duplication census. Three steps, each read structurally; see the header for what the readings cannot see.
// ---------------------------------------------------------------------------------------------------------------

const FIXTURE_FACTS = Object.freeze([
  "FixtureScenario",
  "LogicalSaveName",
  "ObservedSaveSlot",
  "Bootstrap",
  "validateNativeLocalFixturePolicy",
]);

const CONFIG_READERS = Object.freeze(["connectNativeLocalClient", "readNativeClientConfig"]);

/**
 * The top-level keys and spread sources of the object literal whose `{` is at `open`.
 *
 * Shorthand properties count as keys (`{ requestId, idempotencyKey, timeoutMs }` names three), so a value sitting in
 * key position and a key written without a colon are not read as the same thing: `inValue` is what tells them apart.
 */
function objectLiteralShape(source, open) {
  let depth = 0;
  let inValue = false;
  const keys = [];
  const spreads = [];
  let token = "";
  const flush = () => {
    const trimmed = token.trim();
    if (trimmed.startsWith("...") && /^\.\.\.[A-Za-z_$][\w$]*$/u.test(trimmed)) spreads.push(trimmed.slice(3));
    else if (!inValue && /^[A-Za-z_$][\w$]*$/u.test(trimmed)) keys.push(trimmed);
    token = "";
  };
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      token = "";
      inValue = false;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth -= 1;
      if (depth === 0) {
        flush();
        break;
      }
      token = "";
      inValue = false;
      continue;
    }
    if (depth !== 1) continue;
    if (character === ",") {
      flush();
      inValue = false;
      continue;
    }
    if (character === ":") {
      const name = token.trim().replace(/^["']|["']$/gu, "");
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) keys.push(name);
      token = "";
      inValue = true;
      continue;
    }
    if (/[\w$"'.$?]/u.test(character) || /\s/u.test(character)) token += character;
    else token = "";
  }
  return { keys, spreads };
}

/** A request-id / idempotency-key expression with everything that varies per action normalised away. */
export function normalizeExpression(text) {
  if (typeof text !== "string") return null;
  return text
    .replace(/\$\{[^}]*\}/gu, "${}")
    .replace(/String\(\$\{\}\)/gu, "${}")
    .replace(/native_local_[a-z0-9_-]+_/gu, "native_local_<action>_")
    .replace(/\s+/gu, "")
    .replace(/^`|`$/gu, "");
}

function readFixtureStep(source) {
  const imported = [...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']\.\/lib\//gu)]
    .flatMap((match) => match[1].split(",").map((name) => name.trim()))
    .filter(Boolean);
  const readers = CONFIG_READERS.filter((name) => imported.includes(name)).sort();
  const localCheck = /function\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]{0,4000}?FixtureScenario\b/u.exec(source)?.[1] ?? null;
  const facts = FIXTURE_FACTS.filter((fact) => source.includes(fact)).sort();
  return {
    readers: readers.join("+"),
    localCheck,
    facts: facts.join("+"),
    label: `reads ${readers.join("+") || "no lib config reader"} · local check ${localCheck ?? "none"} · fixture facts ${facts.length}/${FIXTURE_FACTS.length}`,
  };
}

function readEnvelopeStep(source) {
  const fields = new Set();
  const spreads = new Set();
  for (const match of source.matchAll(/(?:executeFresh|executeFreshAfterReobserve)\(\s*[\w.]+\s*,\s*\{/gu)) {
    const shape = objectLiteralShape(source, match.index + match[0].length - 1);
    for (const key of shape.keys) fields.add(key);
    for (const spread of shape.spreads) spreads.add(spread);
  }
  if (fields.size === 0) {
    for (const match of source.matchAll(/(?:executeFresh|executeFreshAfterReobserve)\(/gu)) {
      const rest = source.slice(match.index, match.index + 160);
      const passed = /(?:executeFresh|executeFreshAfterReobserve)\(\s*[\w.]+\s*,\s*([A-Za-z_$][\w$]*)/u.exec(rest);
      if (passed !== null) spreads.add(`passthrough:${passed[1]}`);
    }
  }
  const requestId =
    normalizeExpression(/requestId\s*[:=]\s*(`[^`]*`)/u.exec(source)?.[1] ?? null) ??
    normalizeExpression(/requestId:\s*(`[^`]*`)/u.exec(source)?.[1] ?? null);
  const idempotencyKey = normalizeExpression(
    /idempotencyKey\s*:\s*(`[^`]*`|requestId\b[^,\n}]*)/u.exec(source)?.[1] ?? null,
  );
  const fieldList = [...fields].sort().join(",");
  const spreadList = [...spreads].sort().join(",");
  return {
    fields: fieldList,
    requestId,
    idempotencyKey,
    spread: spreadList,
    label: `fields ${fieldList || "none"}${spreadList ? ` + spread ${spreadList}` : ""} · requestId ${requestId ?? "none"} · idempotencyKey ${idempotencyKey ?? "none"}`,
  };
}

function readEvidenceStep(source) {
  const shapes = [];
  for (const match of source.matchAll(/return\s*\{/gu)) {
    const shape = objectLiteralShape(source, match.index + match[0].length - 1);
    if (!shape.keys.includes("state")) continue;
    shapes.push(shape.keys.sort().join(","));
  }
  const spelling = [...new Set(shapes)].sort().join(" | ") || "no result literal this reader can see";
  return { spelling, label: spelling };
}

/** Group runners by one step's spelling, largest first: the number the harness decision needs. */
export function groupBySpelling({ runners, read }) {
  const groups = new Map();
  for (const runner of runners) {
    const step = read(runner.source);
    const key = JSON.stringify([
      step.readers ?? null,
      step.localCheck ?? null,
      step.facts ?? null,
      step.fields ?? null,
      step.spread ?? null,
      step.requestId ?? null,
      step.idempotencyKey ?? null,
      step.spelling ?? null,
    ]);
    if (!groups.has(key)) groups.set(key, { label: step.label, members: [] });
    groups.get(key).members.push(runner.name);
  }
  return [...groups.values()].sort(
    (left, right) => right.members.length - left.members.length || (left.label < right.label ? -1 : 1),
  );
}

export function measureRunnerDuplication({ runners }) {
  const steps = {
    fixture: groupBySpelling({ runners, read: (source) => readFixtureStep(source) }),
    envelope: groupBySpelling({ runners, read: (source) => readEnvelopeStep(source) }),
    evidence: groupBySpelling({ runners, read: (source) => readEvidenceStep(source) }),
  };
  return Object.freeze({
    runners: runners.length,
    steps: Object.freeze(
      Object.fromEntries(
        Object.entries(steps).map(([step, groups]) => [
          step,
          Object.freeze({
            distinct: groups.length,
            largest: Object.freeze(
              groups.slice(0, 2).map((group) => Object.freeze({ count: group.members.length, label: group.label })),
            ),
          }),
        ]),
      ),
    ),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------------------------------------------

const STEP_TITLES = Object.freeze({
  fixture: "(a) resolving the fixture/save",
  envelope: "(b) building the request envelope",
  evidence: "(c) shaping the evidence bundle",
});

export function renderCoverage({ report, duplication = null, census = null }) {
  const lines = [];
  if (report.blocked !== null) {
    lines.push(`not_measured:${report.blocked}`);
    return lines;
  }
  lines.push(
    `actions examined ${report.examined} · with a live gate ${report.routed} · runner ${report.runnerRouted} · ` +
      `contract ${report.contractRouted} · without ${report.without}` +
      (report.readOnlyExcluded > 0 ? ` · read-only excluded ${report.readOnlyExcluded}` : ""),
  );
  if (report.unrouted.length > 0) {
    lines.push(
      `  without: ${report.unrouted
        .map((entry) => `${entry.actionId} (${entry.gate === null ? "no route" : entry.finding})`)
        .join(", ")}`,
    );
  }
  if (census !== null) {
    lines.push(
      `gate artifacts: ${census.onDisk.runners.length} runners on disk · ${census.runners.length} in the index · ` +
        `${census.onDisk.contracts.length} contracts on disk · ${census.contracts.length} in the index` +
        (census.untracked.length > 0 ? ` · untracked not counted ${describeUntracked(census.untracked)}` : ""),
    );
    lines.push(`  indexed runners no catalog action resolves to: ${report.orphanRunners.length}`);
  }
  if (duplication !== null) {
    lines.push(`duplication census over ${duplication.runners} runners (informational, never sets the exit code):`);
    for (const [step, title] of Object.entries(STEP_TITLES)) {
      const reading = duplication.steps[step];
      lines.push(`  ${title}: ${reading.distinct} distinct spelling(s)`);
      for (const group of reading.largest) lines.push(`      ${group.count} x ${group.label}`);
    }
  }
  for (const finding of report.findings) lines.push(finding);
  lines.push(
    report.ok
      ? "  green: every executable catalog action resolves to a live gate the index carries"
      : `  ${report.findings.length} action(s) without a live gate`,
  );
  return lines;
}

/**
 * The whole run, pure over what it was handed, so a falsifier drives the real verdict and the real exit code.
 *
 * `census` is where the gate artifacts come from; it throws when git cannot answer, and that is blocked rather than an
 * empty census that reads as covered.
 */
export function runCoverage({
  catalogSource,
  census: censusOf,
  resolveRoute = resolveStardewActionGateRoute,
  runners = null,
  withDuplication = true,
}) {
  let census;
  try {
    census = censusOf();
  } catch (error) {
    return { exitCode: 2, lines: [`not_measured:gate_artifact_index_unreadable:${String(error?.message ?? error)}`] };
  }
  const report = checkLiveRunnerCoverage({ catalogSource, artifacts: census, resolveRoute });
  const duplication = withDuplication && runners !== null ? measureRunnerDuplication({ runners }) : null;
  const lines = renderCoverage({ report, duplication, census });
  if (report.blocked !== null) return { exitCode: 2, lines };
  return { exitCode: report.ok ? 0 : 1, lines };
}

function readRunnerSources({ root = ROOT, names }) {
  return names.map((name) => ({ name: `tools/${name}`, source: readFileSync(resolve(root, "tools", name), "utf8") }));
}

async function main() {
  let catalogSource;
  try {
    catalogSource = readFileSync(resolve(ROOT, CATALOG_PATH), "utf8");
  } catch (error) {
    process.stdout.write(`not_measured:catalog_unreadable:${CATALOG_PATH}:${error?.code ?? error}\n`);
    process.exitCode = 2;
    return;
  }
  let census;
  try {
    census = gateArtifactsInIndex({ root: ROOT });
  } catch (error) {
    process.stdout.write(`not_measured:gate_artifact_index_unreadable:${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
    return;
  }
  const report = checkLiveRunnerCoverage({ catalogSource, artifacts: census });
  const duplication = measureRunnerDuplication({ runners: readRunnerSources({ names: census.runners }) });
  for (const line of renderCoverage({ report, duplication, census })) process.stdout.write(`${line}\n`);
  process.exitCode = report.blocked !== null ? 2 : Number(!report.ok);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
