#!/usr/bin/env node
/**
 * A promotion has ONE path: the four places it touches must already agree.
 *
 * WHY. `tools/promote-stardew-action.mjs` moves an action up the lifecycle ladder in one refusal-first pass, and that
 * pass writes four places at once:
 *
 *   1. the Mod catalog's lifecycle (`FarmhandActionDefinitions.cs`) - the authority;
 *   2. the published gate table (`STARDEW_PUBLISHED_ACTION_GATES`), which gains the `gate(...)` row;
 *   3. the experimental runner map (`STARDEW_EXPERIMENTAL_ACTION_RUNNERS`), which must lose the same id;
 *   4. the fixture scenario the row records, which is the fixture library's own answer for that action.
 *
 * Hand-editing two of the four is the failure this gate exists for: the action reaches `live_verified` with its runner
 * still in the experimental map, or with no gate row at all, and the red that follows names a symptom three gates away
 * (`gate_descriptor_not_published`, a duplicate key in the resolver suite, a scenario the run never arms) rather than the
 * half-write that caused it. The tool said so in its own header - "a hand-written promotion row is not a row" - and this
 * is the gate that enforces it instead of trusting the tool to be the only writer.
 *
 * THE POPULATION comes from the catalog, never from a hand list: every registration `parseModRegistrations` finds in the
 * Mod's `Registrations` array. Drafting a new action into the catalog puts it under this gate by existing; deleting one
 * removes it. The parsers themselves are the promotion tool's own, imported here, so the gate and the tool cannot
 * disagree about what a row, an entry or a registration looks like.
 *
 * THE RULE, per action. `catalog` is the authority and is printed on every finding; the other places are compared
 * against it:
 *
 *   catalog=experimental     -> no gate row (a row is a live-run claim), runner entry allowed
 *   catalog=live_verified    -> a gate row with the catalog's identityVersion, no runner entry
 *   catalog=published (the E helper's own default, read from its declaration) -> the same
 *
 * The fixture place is the table row's own `fixtureScenario`: it must be a scenario the Mod declares
 * (`ModConfig.KnownFixtureScenarios`, read through `tools/prelive.mjs`) and, where the fixture library models the action
 * at all, it must be the library's own answer (`fixtureScenario(fixtureActions(id), id)`). `none` is a legal value -
 * `move_placed_furniture` deliberately runs in the ordinary world - so the disagreement is a row that says `none` where
 * the library supplies a scenario, or the reverse.
 *
 * `GATE_EXEMPT_PUBLISHED_ACTIONS` is the one declared carve-out: an action published without an ordinary-pipeline
 * descriptor projection names the runner that covers it instead, so its missing row is not a finding.
 *
 * red-proof: inject  deleting use_mine_ladder's gate row from the published gate table ->
 *   `promotion_places_disagree:use_mine_ladder:catalog=live_verified;gate=absent`
 *   (tools/check-stardew-promotion-parity.test.mjs)
 * red-proof: inject  adding use_mine_ladder back into the experimental runner map while the catalog stays
 *   `live_verified` -> `promotion_places_disagree:use_mine_ladder:catalog=live_verified;`
 *   `experimental=present:run-stardew-native-local-player-use-mine-ladder-smoke.mjs`
 *   (tools/check-stardew-promotion-parity.test.mjs)
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fixtureActions, fixtureScenario } from "./lib/stardew-native-local-player-fixture.mjs";
import { GATE_EXEMPT_PUBLISHED_ACTIONS } from "./lib/stardew-published-action-registry.mjs";
import { parseKnownFixtureScenarios } from "./prelive.mjs";
import {
  parseExperimentalEntries,
  parseModRegistrations,
  parsePublishedGates,
  PROMOTION_PATHS,
} from "./promote-stardew-action.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Mod's declared scenario enumeration, which is what makes a row's scenario a real world. */
export const KNOWN_SCENARIOS_PATH = "integrations/stardew/ModConfig.cs";

/** A scan that found less than this measured nothing, and must not read as green. */
export const MINIMUM_CATALOG_ACTIONS = 90;

/**
 * The lifecycle the catalog's own `E(...)` helper applies when a registration omits one, as the wire token the rest of
 * this tree uses. Read from the helper's declaration rather than assumed: `published` is correct today because the
 * helper says so, and a gate that hard-coded it would keep saying so after the default changed.
 */
export function catalogDefaultLifecycle(catalogSource) {
  const declarations = [
    ...String(catalogSource).matchAll(
      /FarmhandActionLifecycle\s+lifecycle\s*=\s*FarmhandActionLifecycle\.(Published|LiveVerified|Experimental)\b/gu,
    ),
  ];
  if (declarations.length !== 1) return null;
  return declarations[0][1].toLowerCase().replace("liveverified", "live_verified");
}

/**
 * The fixture library's own answer for one action: whether it models the action at all, and the scenario it selects.
 * `invalid_native_local_fixture_action` is the library saying "this action is not a fixture key", which is a different
 * fact from "the scenario is empty" - the first leaves the row unconstrained, the second requires `none`.
 */
export function fixtureScenarioFor(actionId) {
  try {
    const scenario = fixtureScenario(fixtureActions(actionId), actionId);
    return { modelled: true, scenario: typeof scenario === "string" && scenario.length > 0 ? scenario : null };
  } catch {
    return { modelled: false, scenario: null };
  }
}

/**
 * What one action's gate row, runner entry and fixture scenario say that the catalog's rung does not.
 *
 * The catalog is the authority, so the returned tokens are the places that disagree with it and the value each of
 * them carries - `gate=absent`, `experimental=present:<runner>`, `fixture=none` - because the reader has to know which
 * of the four places to open, and what it currently holds.
 */
function placeDisagreements({ lifecycle, identityVersion, row, runner, knownScenarios, library, exempt }) {
  const places = [];
  const expectedRow = lifecycle !== "experimental" && !exempt;
  if (expectedRow && row === undefined) places.push("gate=absent");
  if (!expectedRow && row !== undefined) places.push(`gate=present:${row.terminalReasonCode}`);
  if (row !== undefined && row.identityVersion !== identityVersion) places.push(`gate_identity=${row.identityVersion}`);
  if (runner !== undefined && lifecycle !== "experimental") places.push(`experimental=present:${runner.runner}`);
  if (row === undefined) return places;
  const rowScenario = row.fixtureScenario ?? null;
  // A scenario the Mod does not declare can never arm, so it is a disagreement on its own, whatever the library says.
  if (rowScenario !== null && !knownScenarios.has(rowScenario)) {
    places.push(`fixture=${rowScenario}`);
    return places;
  }
  if (!library.modelled || rowScenario === library.scenario) return places;
  places.push(`fixture=${rowScenario ?? "none"}`);
  places.push(`fixture_library=${library.scenario ?? "none"}`);
  return places;
}

/**
 * The gate itself: pure over the two sources, the declared scenario set and the fixture's answers, so the falsifier
 * suite injects a half-promotion into the real sources instead of editing the Mod.
 */
export function checkPromotionPlaces({
  catalogSource,
  gateDescriptorSource,
  knownScenarios,
  fixtureScenarioFor: resolveFixtureScenario = fixtureScenarioFor,
  gateExemptions = GATE_EXEMPT_PUBLISHED_ACTIONS,
  minimumActions = MINIMUM_CATALOG_ACTIONS,
} = {}) {
  const findings = [];
  const audit = [];
  const defaultLifecycle = catalogDefaultLifecycle(catalogSource);
  if (defaultLifecycle === null) findings.push("catalog_default_lifecycle_unreadable");
  const registrations = parseModRegistrations(String(catalogSource ?? ""));
  const published = parsePublishedGates(String(gateDescriptorSource ?? ""));
  if (published === null) findings.push("gate_descriptor_table_unreadable");
  const experimental = parseExperimentalEntries(String(gateDescriptorSource ?? ""));
  if (experimental === null) findings.push("experimental_runner_map_unreadable");
  const rows = new Map((published?.rows ?? []).map((row) => [row.actionId, row]));
  const runners = new Map((experimental ?? []).map((entry) => [entry.actionId, entry]));
  const exempt = new Set(gateExemptions.map((entry) => entry.actionId));

  let checked = 0;
  for (const registration of registrations) {
    const actionId = registration.actionId;
    const lifecycle = registration.lifecycle ?? defaultLifecycle;
    if (lifecycle === null) {
      findings.push(`promotion_places_disagree:${actionId}:catalog=unstated`);
      continue;
    }
    checked += 1;
    const row = rows.get(actionId);
    const runner = runners.get(actionId);
    const places = placeDisagreements({
      lifecycle,
      identityVersion: registration.identityVersion,
      row,
      runner,
      knownScenarios,
      library: resolveFixtureScenario(actionId),
      exempt: exempt.has(actionId),
    });
    audit.push({ actionId, lifecycle, gate: row?.actionId ?? null, experimental: runner?.runner ?? null });
    if (places.length > 0)
      findings.push(`promotion_places_disagree:${actionId}:catalog=${lifecycle};${places.join(";")}`);
  }

  // A gate row for an action the catalog does not register is the same half-write from the other side: the table
  // claims a run that the authority does not admit.
  for (const [actionId, row] of rows)
    if (!registrations.some((registration) => registration.actionId === actionId))
      findings.push(`promotion_places_disagree:${actionId}:catalog=absent;gate=present:${row.terminalReasonCode}`);

  const total = registrations.length;
  if (total === 0) findings.push("promotion_parity_population_empty");
  else if (checked !== total) findings.push(`promotion_parity_population_incomplete:${checked}/${total}`);
  else if (total < minimumActions) findings.push(`promotion_parity_population_too_small:${total}<${minimumActions}`);

  return Object.freeze({
    schema: "gamebuddy-stardew-promotion-parity/v1",
    checked,
    total,
    gateRows: rows.size,
    experimentalEntries: runners.size,
    audit,
    findings,
    ok: findings.length === 0,
  });
}

/** The real tree, read the way the CLI reads it. */
export async function auditPromotionPlaces({ root = ROOT } = {}) {
  const catalogSource = await readFile(resolve(root, PROMOTION_PATHS.modCatalog), "utf8");
  const gateDescriptorSource = await readFile(resolve(root, PROMOTION_PATHS.gateDescriptors), "utf8");
  const knownScenarios = parseKnownFixtureScenarios(await readFile(resolve(root, KNOWN_SCENARIOS_PATH), "utf8"));
  return checkPromotionPlaces({ catalogSource, gateDescriptorSource, knownScenarios });
}

function main() {
  return auditPromotionPlaces().then((report) => {
    process.stdout.write(
      `promotion places: checked ${report.checked} of ${report.total} catalog actions` +
        ` (gate rows ${report.gateRows}, experimental entries ${report.experimentalEntries})\n`,
    );
    for (const finding of report.findings) process.stderr.write(`${finding}\n`);
    process.stdout.write(
      report.ok
        ? "  green: every promotion's catalog rung, gate row, runner entry and fixture scenario agree\n"
        : `  ${report.findings.length} finding(s)\n`,
    );
    process.exitCode = report.ok ? 0 : 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
