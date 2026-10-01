import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixture-scenario wiring parity across the Mod's three hand-written lists.
 *
 * To be runnable a scenario must be named in three places:
 *   1. ModConfig.KnownFixtureScenarios     -- the config gate; anything else is
 *                                             rejected when the config loads.
 *   2. ModEntry's pre-attachment allowlist -- `FixtureScenario is not (...)`;
 *                                             absent scenarios are refused with
 *                                             "rejected an unsupported or
 *                                             unavailable pre-attachment scenario"
 *                                             before their own block can run.
 *   3. ModEntry's dispatcher               -- the block that builds the actual
 *                                             precondition, written either as
 *                                             `FixtureScenario == "X"` or as a
 *                                             `FixtureScenario is "X"` pattern.
 *
 * The lists are separate concerns, which is exactly why they drift, and both
 * directions are silent:
 *   - gate + dispatcher but not allowlist -> accepted, then refused before arming
 *     (native_clear_debris_resource_clump_v1 and native_refill_watering_can_v1
 *     had runners and dispatcher blocks yet could never arm)
 *   - gate but no dispatcher -> arms and provisions nothing
 *     (native_tree_first_hit_v1)
 *
 * A scenario handled by an earlier `if` that returns never reaches the allowlist
 * (navigation_mutation_v1, navigation_read_only_v1, native_express_emote_v1), so
 * absence from it is legitimate for those; the checker detects that by looking for
 * a pre-allowlist block naming the scenario.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const MOD_ENTRY = path.join(repositoryRoot, "integrations/stardew/ModEntry.cs");
const MOD_CONFIG = path.join(repositoryRoot, "integrations/stardew/ModConfig.cs");

/** Double-quoted string literals of a source slice. */
function quoted(source) {
  return [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
}

/**
 * The `FixtureScenario is not (...)` group, closed at the first `)` that is not
 * inside a string literal. A plain indexOf(")") would cut inside a literal and
 * silently truncate the list.
 */
export function extractPreAttachmentAllowlist(entry) {
  const marker = "FixtureScenario is not (";
  const start = entry.indexOf(marker);
  if (start < 0) return null;
  const rest = entry.slice(start + marker.length);
  let inString = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"' && rest[i - 1] !== "\\") inString = !inString;
    if (!inString && ch === ")") return { start, end: start + marker.length + i, body: rest.slice(0, i) };
  }
  return null;
}

export function checkStardewFixtureScenarioWiring({ modEntrySource, modConfigSource } = {}) {
  const entry = modEntrySource ?? fs.readFileSync(MOD_ENTRY, "utf8");
  const config = modConfigSource ?? fs.readFileSync(MOD_CONFIG, "utf8");

  const knownStart = config.indexOf("KnownFixtureScenarios = new[]");
  if (knownStart < 0) return { state: "failed", violations: [{ issue: "known_scenarios_block_missing" }] };
  const knownEnd = config.indexOf("};", knownStart);
  const known = new Set(quoted(config.slice(knownStart, knownEnd)).filter((name) => name.length > 0));

  const group = extractPreAttachmentAllowlist(entry);
  if (group === null) return { state: "failed", violations: [{ issue: "allowlist_missing" }] };
  const allowlist = new Set(quoted(group.body));

  const preAllowlist = entry.slice(0, group.start);
  // Both spellings the dispatcher uses.
  const dispatcher = new Set([
    ...[...entry.matchAll(/FixtureScenario == "([^"]+)"/g)].map((m) => m[1]),
    ...[...entry.matchAll(/FixtureScenario is "([^"]+)"/g)].map((m) => m[1]),
  ]);

  const violations = [];
  const add = (issue, scenario, detail) => violations.push({ issue, scenario, detail });

  for (const scenario of known) {
    const handledEarlier = preAllowlist.includes(`FixtureScenario == "${scenario}"`);
    if (!allowlist.has(scenario) && !handledEarlier) {
      add(
        "accepted_by_config_but_refused_before_arming",
        scenario,
        "in KnownFixtureScenarios but neither in the pre-attachment allowlist nor handled by an earlier returning block",
      );
    }
    if (!dispatcher.has(scenario)) {
      add("armed_without_a_recipe", scenario, "in KnownFixtureScenarios but ModEntry has no dispatch block for it");
    }
  }

  for (const scenario of allowlist) {
    if (!known.has(scenario)) {
      add("allowlisted_but_config_rejects", scenario, "in the allowlist but missing from KnownFixtureScenarios, so config rejects it first");
    }
  }

  for (const scenario of dispatcher) {
    if (!known.has(scenario)) {
      add("dispatched_but_config_rejects", scenario, "ModEntry dispatches it but KnownFixtureScenarios omits it, so config rejects it first");
    }
  }

  return {
    state: violations.length === 0 ? "passed" : "failed",
    counts: { known: known.size, allowlist: allowlist.size, dispatcher: dispatcher.size },
    violations,
  };
}

if (import.meta.main) {
  const report = checkStardewFixtureScenarioWiring();
  console.log(JSON.stringify(report, null, 2));
  if (report.state !== "passed") process.exitCode = 1;
}
