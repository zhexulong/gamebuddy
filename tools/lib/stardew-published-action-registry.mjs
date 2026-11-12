import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * The Mod's own registration table: the ONE source every reading in this module parses.
 *
 * It was spelled out three times before, once per reader, so a reader pointed at a copy was one edit away from
 * measuring a different catalog than its siblings.
 */
const REGISTRATIONS_PATH = resolve(
  root,
  "integrations",
  "stardew",
  "src",
  "Core",
  "Policy",
  "FarmhandActionDefinitions.cs",
);

/**
 * The `Registrations` array body. Every reader in this module starts here, so "what the catalog is" has one
 * spelling (the declaration) rather than one per call site.
 */
const REGISTRATIONS_BODY = /\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/;

function fail(code) {
  throw new Error(`stardew_published_action_registry_${code}`);
}

function registrationsBody(source) {
  const body = source.match(REGISTRATIONS_BODY)?.[1];
  if (!body) fail("missing_mod_registrations");
  return body;
}

/**
 * Published execution actions that are deliberately kept out of the
 * published-action gate descriptor projection, each with the live entry point
 * that covers it instead.
 *
 * `navigate_to_destination` runs on the long-horizon navigation pipeline with
 * its own 10-minute watchdog and its own live entry point, not on the ordinary
 * action pipeline the descriptor gate covers. Its runner also uses scenario
 * `navigation_mutation_v1`, which the descriptor contract shape
 * (`^native_[a-z0-9_]+_v\d+$`) does not accept.
 *
 * This list exists so the carve-out is declared and carries evidence, rather
 * than being implied. Before it, the filter was an inline
 * `family !== "world_navigation"` with no comment, and the descriptor test
 * asserted its own projection equals that same filtered projection -- true by
 * construction. A second `world_navigation` published execution action would
 * therefore have dropped out of the gate set silently, with every test still
 * green.
 *
 * Adding an entry here is a deliberate act that needs the same justification
 * as above. It does not grant or withhold capability; it only states which
 * actions the ordinary-pipeline descriptor gate does not cover, and names the
 * runner that must exist in its place.
 */
export const GATE_EXEMPT_PUBLISHED_ACTIONS = Object.freeze([
  Object.freeze({
    actionId: "navigate_to_destination",
    runner: "run-stardew-native-local-player-navigation-mutation-smoke.mjs",
    terminalReasonCode: "navigation_completed",
  }),
]);

/**
 * Reads only the Mod-owned published registrations for non-authoritative live
 * gate descriptor coverage. It never publishes capabilities or affects routing.
 */
export async function readPublishedStardewActionIds({
  registrationsPath = REGISTRATIONS_PATH,
  /**
   * Whether to also verify the exemption list against this source. The
   * exemptions name actions in the real Mod registry, so they are only
   * meaningful when reading that registry; a synthetic source passed to
   * exercise the parser carries no exemption obligations.
   */
  enforceGateExemptions = registrationsPath === REGISTRATIONS_PATH,
} = {}) {
  const body = registrationsBody(await readFile(registrationsPath, "utf8"));

  const entries = body.split(/(?=\b(?:E|R|Registration)\()/);
  const publishedIds = [];
  const exempted = [];

  for (const entry of entries) {
    const match = entry.match(
      /\b(?:E|Registration)\(\s*"([a-z][a-z0-9_]{1,127})",\s*"([a-z][a-z0-9_]{1,127})",\s*(?:\d+,\s*)?FarmhandActionHandlerGroup\.[A-Za-z]+/,
    );
    if (!match) continue;
    const [, actionId] = match;
    const isExperimental = entry.includes("FarmhandActionLifecycle.Experimental");
    if (isExperimental) continue;
    if (GATE_EXEMPT_PUBLISHED_ACTIONS.some((exempt) => exempt.actionId === actionId)) exempted.push(actionId);
    else publishedIds.push(actionId);
  }

  // The exemption must match reality: an entry that no longer exists, or one
  // that has become experimental, is a stale carve-out and must be removed.
  if (enforceGateExemptions) {
    const stale = GATE_EXEMPT_PUBLISHED_ACTIONS.map((entry) => entry.actionId).filter((id) => !exempted.includes(id));
    if (stale.length > 0) fail(`stale_gate_exemptions:${stale.join(",")}`);
  }

  if (publishedIds.length === 0 || new Set(publishedIds).size !== publishedIds.length) fail("invalid_published_set");
  return Object.freeze(publishedIds);
}

/**
 * Every published, non-read-only Mod registration, with no gate exemption
 * applied.
 *
 * The descriptor gate covers a subset of these (see
 * `GATE_EXEMPT_PUBLISHED_ACTIONS`). Callers that only read
 * `readPublishedStardewActionIds` cannot see the difference between "this
 * action has no descriptor" and "this action is exempt from descriptors",
 * which is exactly how a published action used to fall out of gate coverage
 * unnoticed. Asserting against this set as well closes that gap.
 */
export async function readAllPublishedExecutionStardewActionIds(options) {
  const gated = await readPublishedStardewActionIds(options);
  return Object.freeze([...gated, ...GATE_EXEMPT_PUBLISHED_ACTIONS.map((entry) => entry.actionId)]);
}

/**
 * The action FAMILY each Mod registration declares, read from the registration table itself.
 *
 * The family is the second argument of every `E(...)` / `Registration(...)` row, so this is the Mod's own
 * vocabulary rather than a taxonomy a caller wrote down: `host/src/games/stardew/stardew-action-families.ts`
 * names the same table as the authority for the family names it offers a player, and this reads the same rows
 * for the action each one holds. A hand-written map here would be a second spelling of the catalog, and it
 * would go stale the way the hand-written experimental list did.
 *
 * SYNCHRONOUS on purpose: `tools/lib/multiday-daily-tasks.mjs` builds its sweep groups at module load, so an
 * async reader would force every importer (including `tools/check-stardew-task-action-coverage.mjs`'s
 * population reading) through a top-level await for a fact already on disk.
 *
 * EVERY registration is included, whatever its lifecycle: the map answers "which family does this action
 * belong to", which is true of an experimental action too. A caller that wants the published subset filters
 * its own population, as the sweep builder does.
 *
 * FAILS CLOSED. A body that does not parse, or one that declares not a single row carrying a family, is a
 * named refusal - never an empty map, which would read as "the catalog has no actions" and silently build no
 * sweep tasks at all.
 */
export function readStardewActionFamilies({ registrationsPath = REGISTRATIONS_PATH } = {}) {
  const body = registrationsBody(readFileSync(registrationsPath, "utf8"));
  const familyOf = new Map();
  for (const match of body.matchAll(
    /\b(?:E|Registration)\(\s*"([a-z][a-z0-9_]{1,127})",\s*"([a-z][a-z0-9_]{1,127})",\s*(?:\d+,\s*)?FarmhandActionHandlerGroup\./gu,
  )) {
    const [, actionId, family] = match;
    const claimed = familyOf.get(actionId);
    // Two rows for one action in ONE family is a duplicate, not a disagreement; two families is the catalog
    // telling a caller two different things about the same action, so it is refused rather than last-wins.
    if (claimed !== undefined && claimed !== family)
      fail(`action_declares_two_families:${actionId}:${claimed}:${family}`);
    familyOf.set(actionId, family);
  }
  if (familyOf.size === 0) fail("registrations_declare_no_action_family");
  return familyOf;
}

/**
 * The watchdog each registration declares, in milliseconds, read from the same registration table.
 *
 * The number is not a caller's opinion: `BridgeSession.IsFreshExecutionRequest` admits a deadline at most the
 * descriptor's own `WatchdogMs`, and the Host sizes a dispatch from that same number. Measured 2026-11-10,
 * `fish_here` publishes 60 s, its runner wrote 120 s, and the first live slice of that action came back
 * `bridge_rejected:invalid_deadline` - after a game launch, with nothing comparing the two numbers. So the value a
 * fake publishes has to be the one the catalog declares, and this is where it is read from.
 *
 * Only an ENFORCED row (`E` / `Registration`) publishes a window. A read-only row (`R`) is not dispatchable, so an
 * absence here is deliberate: `publishedActionWatchdogMs` refuses such an action by name instead of handing back the
 * ordinary default, which would let a runner dispatch something the Mod never bounds.
 *
 * SYNCHRONOUS for the same reason `readStardewActionFamilies` is: a smoke fake builds its client state at module load
al
 * inside a test body, and an async reader would force a top-level await into sixty suites to learn a fact already on
 * disk.
 *
 * FAILS CLOSED. No default constant, no enforced row, or one action declaring two windows is a named refusal - never
 * an empty or last-wins map, which would read as "every action has some window".
 */
export function readStardewActionWatchdogs({ definitionsPath = REGISTRATIONS_PATH } = {}) {
  const source = readFileSync(definitionsPath, "utf8");
  const constants = new Map(
    [...source.matchAll(/\bpublic const long (\w+) = ([\d_]+);/gu)].map((match) => [
      match[1],
      Number(match[2].replaceAll("_", "")),
    ]),
  );
  const defaultMs = constants.get("DefaultWatchdogMs");
  if (!Number.isSafeInteger(defaultMs) || defaultMs <= 0) fail("no_default_watchdog");
  const numberIn = (token) => {
    if (/^\d/u.test(token)) return Number(token.replaceAll("_", ""));
    return constants.get(token.split(".").pop());
  };
  // A descriptor FACTORY may declare the window itself (`Lifecycle()` ends in `with { WatchdogMs = ... }`), and the
  // row then names the factory rather than a number, so the factories are resolved before any row is read.
  const factoryMs = new Map();
  for (const match of source.matchAll(/static FarmhandActionDescriptor (\w+)\(\)\s*=>([\s\S]*?);\n/gu)) {
    const declared = /WatchdogMs\s*[:=]\s*([\w.]+)/u.exec(match[2]);
    if (declared === null) continue;
    const ms = numberIn(declared[1]);
    if (Number.isSafeInteger(ms) && ms > 0) factoryMs.set(match[1], ms);
  }
  const watchdogOf = new Map();
  for (const entry of registrationsBody(source).split(/(?=\b(?:E|R|Registration)\()/)) {
    const row = entry.match(/\b(E|Registration|R)\(\s*"([a-z][a-z0-9_]{1,127})"/u);
    if (row === null) continue;
    const [, spelling, actionId] = row;
    if (spelling === "R") continue;
    const named = /WatchdogMs\s*[:=]\s*([\w.]+)/u.exec(entry);
    const factory = [...factoryMs.keys()].find((name) => new RegExp(`\\b${name}\\(\\)`, "u").test(entry));
    const ms = named === null ? (factory === undefined ? defaultMs : factoryMs.get(factory)) : numberIn(named[1]);
    if (!Number.isSafeInteger(ms) || ms <= 0) fail(`unreadable_watchdog:${actionId}`);
    const claimed = watchdogOf.get(actionId);
    if (claimed !== undefined && claimed !== ms) fail(`action_declares_two_watchdogs:${actionId}:${claimed}:${ms}`);
    watchdogOf.set(actionId, ms);
  }
  if (watchdogOf.size === 0) fail("registrations_declare_no_watchdog");
  return watchdogOf;
}

/**
 * The Mod registrations whose lifecycle is exactly `Experimental`.
 *
 * This is the only thing a fixture may name in `ExperimentalActions`: a policy
 * that lists a registration the catalog already promoted is rejected by
 * `ActionPolicyEngine.ValidateActionPolicy`, which fails the whole Mod config.
 * Reading the catalog keeps the list from going stale the way the hand-written
 * one did (all 17 of its entries had been promoted before anyone noticed).
 */
export async function readExperimentalStardewActionIds({ registrationsPath = REGISTRATIONS_PATH } = {}) {
  const body = registrationsBody(await readFile(registrationsPath, "utf8"));

  const ids = [];
  for (const entry of body.split(/(?=\b(?:E|R|Registration)\()/)) {
    const match = entry.match(/\b(?:E|Registration)\(\s*"([a-z][a-z0-9_]{1,127})"/);
    if (!match) continue;
    if (!entry.includes("FarmhandActionLifecycle.Experimental")) continue;
    ids.push(match[1]);
  }
  // An empty experimental set is legal: it means the last experimental
  // registration moved up the ladder (e.g. ride_minecart -> live_verified) and
  // nothing currently sits on the experimental rung. This is a stable,
  // push-only policy: every promoted action removes itself here.
  if (new Set(ids).size !== ids.length) fail("invalid_experimental_set");
  return Object.freeze(ids);
}
