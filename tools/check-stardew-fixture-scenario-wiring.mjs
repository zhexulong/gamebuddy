import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixture-scenario wiring parity across the Mod's three hand-written lists AND
 * the tools-side declaration of which scenario a run will arm.
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
 *
 * THE FOURTH DIRECTION, and the one that hid a real gap: the tools side decides
 * which scenario id a run asks for (`fixtureScenario` in
 * tools/lib/stardew-native-local-player-fixture.mjs), and nothing checked that
 * the Mod had ever heard of that id. `native_open_geode_v1` was returned by the
 * tools function, shipped in a runner and in the action-gate descriptor, and was
 * absent from all three Mod lists - so the Mod rejected its own configuration at
 * launch and the fixture ticked forever with no bridge. The three Mod-side loops
 * below cannot see that, because they only ever iterate Mod-side sets. The
 * population for this direction is DERIVED from the tools function's own
 * `return` literals: a hand-written copy of the scenario names here would be a
 * second authority that drifts from the function that actually decides.
 *
 * red-proof: inject  one `native_*_v1` id renamed in `ModConfig.KnownFixtureScenarios` ->
 *                    `"state":"failed"` with `{"issue":"accepted_by_config_but_refused_before_arming",
 *                    "scenario":"native_removed_for_the_proof_v1"}` and `armed_without_a_recipe` for the same id,
 *                    exit 1; the unmodified tree reports `"state":"passed"` with `"known":119` and no violations,
 *                    exit 0 (tools/check-stardew-fixture-scenario-wiring.mjs)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const MOD_CONFIG = path.join(repositoryRoot, "integrations/stardew/ModConfig.cs");
/**
 * ModEntry is a partial class: the pre-attachment allowlist and the dispatcher
 * live in ModEntry.Fixtures.cs (and the per-slot WIA fixtures in further
 * ModEntry.Fixtures.*.cs files), not in ModEntry.cs. Reading only ModEntry.cs
 * made this checker report `allowlist_missing` forever, so the gate was noise
 * instead of signal. Read every partial and concatenate.
 */
const MOD_ENTRY_PARTIALS = fs
  .readdirSync(path.join(repositoryRoot, "integrations/stardew"))
  .filter((name) => /^ModEntry(\..+)?\.cs$/.test(name))
  .sort()
  .map((name) => path.join(repositoryRoot, "integrations/stardew", name));
/**
 * The tools-side authority for "which scenario will this run arm".
 */
const FIXTURE_LIBRARY = path.join(repositoryRoot, "tools/lib/stardew-native-local-player-fixture.mjs");

function readModEntryPartials() {
  return MOD_ENTRY_PARTIALS.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

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

/**
 * Every scenario id the tools side can ask for: the `return` literals of
 * `fixtureScenario`. `""` is the deliberate "this action needs no fixture world"
 * answer, not a scenario, so it is dropped.
 *
 * The slice ends at the first `\n}` - the function's own closing brace at column
 * zero. Its body is the only part of the module with no column-zero brace inside
 * it, and a missing function returns `null` so the caller fails loudly instead of
 * checking an empty population.
 */
export function extractFixtureScenarioIds(librarySource) {
  const start = librarySource.indexOf("export function fixtureScenario(");
  if (start < 0) return null;
  const end = librarySource.indexOf("\n}", start);
  if (end < 0) return null;
  return new Set(
    [...librarySource.slice(start, end).matchAll(/return\s+"([^"]*)"/g)]
      .map((match) => match[1])
      .filter((name) => name.length > 0),
  );
}

export function checkStardewFixtureScenarioWiring({ modEntrySource, modConfigSource, fixtureLibrarySource } = {}) {
  const entry = modEntrySource ?? readModEntryPartials();
  const config = modConfigSource ?? fs.readFileSync(MOD_CONFIG, "utf8");
  const library = fixtureLibrarySource ?? fs.readFileSync(FIXTURE_LIBRARY, "utf8");

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
      add(
        "allowlisted_but_config_rejects",
        scenario,
        "in the allowlist but missing from KnownFixtureScenarios, so config rejects it first",
      );
    }
  }

  for (const scenario of dispatcher) {
    if (!known.has(scenario)) {
      add(
        "dispatched_but_config_rejects",
        scenario,
        "ModEntry dispatches it but KnownFixtureScenarios omits it, so config rejects it first",
      );
    }
  }

  // The tools -> Mod direction. A scenario the tools side can return but the Mod
  // has never heard of is not a missing test: it is a run that arms nothing and
  // ticks forever, because the Mod rejects its own configuration before the
  // bridge opens. Both Mod-side facts are named separately, because each one is a
  // different fix and a reader needs to know which is missing.
  const toolsScenarios = extractFixtureScenarioIds(library);
  if (toolsScenarios === null) {
    add(
      "tools_fixture_scenario_function_missing",
      null,
      "fixtureScenario was not found in the tools fixture library, so the tools -> Mod direction checked nothing",
    );
  } else {
    for (const scenario of toolsScenarios) {
      if (!known.has(scenario)) {
        add(
          "armed_by_the_tools_side_but_config_rejects",
          scenario,
          "fixtureScenario returns it but KnownFixtureScenarios omits it, so the Mod rejects its own configuration at launch and never opens the bridge",
        );
      }
      if (!dispatcher.has(scenario)) {
        add(
          "armed_by_the_tools_side_but_no_recipe",
          scenario,
          "fixtureScenario returns it but ModEntry has no dispatch block for it, so it arms and provisions nothing",
        );
      }
    }
  }

  return {
    state: violations.length === 0 ? "passed" : "failed",
    counts: {
      known: known.size,
      allowlist: allowlist.size,
      dispatcher: dispatcher.size,
      tools: toolsScenarios?.size ?? 0,
    },
    violations,
  };
}

if (import.meta.main) {
  const report = checkStardewFixtureScenarioWiring();
  console.log(JSON.stringify(report, null, 2));
  if (report.state !== "passed") process.exitCode = 1;
}
