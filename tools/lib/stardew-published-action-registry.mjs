import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function fail(code) {
  throw new Error(`stardew_published_action_registry_${code}`);
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
  registrationsPath = resolve(
    root,
    "integrations",
    "stardew",
    "src",
    "Core",
    "Policy",
    "FarmhandActionDefinitions.cs",
  ),
  /**
   * Whether to also verify the exemption list against this source. The
   * exemptions name actions in the real Mod registry, so they are only
   * meaningful when reading that registry; a synthetic source passed to
   * exercise the parser carries no exemption obligations.
   */
  enforceGateExemptions = registrationsPath === resolve(
    root,
    "integrations",
    "stardew",
    "src",
    "Core",
    "Policy",
    "FarmhandActionDefinitions.cs",
  ),
} = {}) {
  const source = await readFile(registrationsPath, "utf8");
  const body = source.match(
    /\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/,
  )?.[1];
  if (!body) fail("missing_mod_registrations");

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
    const stale = GATE_EXEMPT_PUBLISHED_ACTIONS.map((entry) => entry.actionId).filter(
      (id) => !exempted.includes(id),
    );
    if (stale.length > 0) fail(`stale_gate_exemptions:${stale.join(",")}`);
  }

  if (publishedIds.length === 0 || new Set(publishedIds).size !== publishedIds.length)
    fail("invalid_published_set");
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
 * The Mod registrations whose lifecycle is exactly `Experimental`.
 *
 * This is the only thing a fixture may name in `ExperimentalActions`: a policy
 * that lists a registration the catalog already promoted is rejected by
 * `ActionPolicyEngine.ValidateActionPolicy`, which fails the whole Mod config.
 * Reading the catalog keeps the list from going stale the way the hand-written
 * one did (all 17 of its entries had been promoted before anyone noticed).
 */
export async function readExperimentalStardewActionIds({
  registrationsPath = resolve(
    root,
    "integrations",
    "stardew",
    "src",
    "Core",
    "Policy",
    "FarmhandActionDefinitions.cs",
  ),
} = {}) {
  const source = await readFile(registrationsPath, "utf8");
  const body = source.match(
    /\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/,
  )?.[1];
  if (!body) fail("missing_mod_registrations");

  const ids = [];
  for (const entry of body.split(/(?=\b(?:E|R|Registration)\()/)) {
    const match = entry.match(/\b(?:E|Registration)\(\s*"([a-z][a-z0-9_]{1,127})"/);
    if (!match) continue;
    if (!entry.includes("FarmhandActionLifecycle.Experimental")) continue;
    ids.push(match[1]);
  }
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail("invalid_experimental_set");
  return Object.freeze(ids);
}
