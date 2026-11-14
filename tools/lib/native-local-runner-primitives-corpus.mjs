import { validFixtureSlotRelationship } from "./native-local-runner-primitives.mjs";
import { classifyTopology, validateNativeLocalFixturePolicy } from "./stardew-native-smoke-harness-v1.mjs";

/**
 * THE PROBE CORPUS for L1's fixture-config refusal: the inputs, the branch each covers, and the verdict it must get.
 *
 * WHY THIS FILE EXISTS. `validateNativeLocalFixtureConfig` was spelled privately in 51 runners, under names including
 * `validateConfig`, `validateFixtureConfig`, `validateNativeLocalConfig` and `assertNativeLocalFixtureConfig`, and under
 * three refusal vocabularies. The migration that deletes those copies could not be driven, because there was nothing to
 * drive it with: the tool that replaces a private copy with an import refuses a copy it cannot compare, and
 * `primitive_copy_no_probe_corpus` was the reason 51 copies sat still while 42 runners imported the module. Every other
 * L1 primitive had a corpus - `EVIDENCE_PROBES`, `TILE_PROBES`, `SLOT_PROBES` - and this one, the largest group, had
 * none, because its input is a whole config object rather than a string or a pair of tiles.
 *
 * WHICH ANSWER IS RIGHT, and how it was decided. The corpus is not a vote among the 51: the expected verdicts below are
 * the ONE implementation's (`native-local-runner-primitives.mjs`), written down so that a change to it is a deliberate
 * diff here rather than a silent drift in fifty runners. What the 51 disagreed about, and the answer taken:
 *
 *   the refusal WORD      three vocabularies (`native_local_fixture_not_enabled` /
 *                         `native_local_fixture_config_invalid` / `native_local_<action>_fixture_config_invalid`) and, for
 *                         the topology refusal, five spellings (`native_local_fixture_topology_not_isolated`,
 *                         `..._topology_not_isolated:<json>`, `native_local_<action>_topology_invalid`,
 *                         `native_local_<action>_action_policy_invalid`, `native_local_fixture_action_policy_invalid`).
 *                         ANSWER: one action-scoped vocabulary - `native_local_<action>_fixture_config_invalid`,
 *                         `native_local_<action>_fixture_scenario_mismatch:<found|missing>` and
 *                         `native_local_<action>_action_policy_invalid`. The action prefix is what the template's own
 *                         runners already spoke, and a refusal that does not name the action cannot be told apart from
 *                         the forty others in one run's log.
 *   the SCENARIO check   12 copies read `FixtureScenario`, 39 did not. ANSWER: an option (`fixtureScenario: null`), because
 *                         a runner that arms no scenario of its own is not refusing a config that works today.
 *   the SLOT check       6 copies read the logical-save/slot relationship, 45 did not. ANSWER: the same, `slotRelationship`.
 *   the ORDER            16 copies asserted the fixture policy BEFORE the topology, 35 after. ANSWER: one order -
 *                         shape, scenario, topology, policy - see `FIXTURE_CONFIG_ORDER` below. The two orders answer
 *                         differently only for a config broken in two ways at once, and both refuse it.
 *   the BOOTSTRAP check  8 copies never looked at `NativeLocalPlayerFixture.Bootstrap`. ANSWER: every caller checks it;
 *                         the fixture's observed-phase config never carries the key (`configureNativeLocalPlayer`
 *                         replaces the section wholesale), so the check refuses a config no real run produces.
 *
 * WHAT THE CORPUS CANNOT SEE, said out loud: it says nothing about a copy that refuses a config this corpus does not
 * build. That is why an unexpressible copy is named in the gate's reading by the probe it differs on, rather than
 * dropped: a corpus that answers "different" and stops would be as silent as no corpus at all.
 */

/** The client fields a native-local config carries outside the fixture section, as the fixture writes them. */
const CLIENT_FIELDS = Object.freeze({
  SaveId: "SaveIdA",
  WorldId: "WorldIdA",
  PlayerId: "PlayerIdA",
  CompanionId: "CompanionIdA",
  PipeName: "gamebuddy-native-local-fixture",
  BridgeToken: "0f".repeat(24),
});

/** The policy a valid fixture writes: deny-by-exception, with nothing denied and nothing opted in. */
const POLICY = Object.freeze({ DeniedActions: [], DeniedActionFamilies: [], ExperimentalActions: [] });

/** The one scenario and action the probe inputs are written against; a copy's own values are substituted by the caller. */
export const PROBE_SCENARIO = "native_probe_v1";
export const PROBE_ACTION = "probe_action";

/**
 * The inputs, each with the branch it covers.
 *
 * The first block is the shape axis (what makes a fixture section valid), the second the scenario axis, the third the
 * slot relationship, the fourth the shared-topology axis, the fifth the policy axis, and the last the two configs that
 * are broken in more than one way - the only inputs on which the copies' two orderings disagreed.
 */ export function fixtureConfigProbes({ scenario = PROBE_SCENARIO, action = PROBE_ACTION } = {}) {
  /** The fixture section a valid config carries, armed for the scenario this copy asserts. */
  const own = {
    Enable: true,
    FixtureScenario: scenario,
    LogicalSaveName: "GameBuddyFixtureProbe",
    ObservedSaveSlot: "GameBuddyFixtureProbe_1",
    TimeoutSeconds: 90,
  };
  const fixture = (overrides = {}) => ({ ...own, ...overrides });
  /** A config the fixture itself could have written: this scenario, an empty policy, and the client fields. */
  const base = { ...CLIENT_FIELDS, ...POLICY, NativeLocalPlayerFixture: own };
  const config = (overrides = {}) => ({ ...base, ...overrides });
  const withFixture = (overrides) => ({ ...base, NativeLocalPlayerFixture: fixture(overrides) });
  return [
    { name: "valid", branch: "the config the fixture writes, which every vocabulary accepts", config: base },
    { name: "empty_object", branch: "no fixture at all", config: {} },
    { name: "null", branch: "not a config", config: null },
    { name: "undefined", branch: "no argument", config: undefined },
    { name: "not_an_object", branch: "a string is not a config", config: "config" },
    { name: "fixture_absent", branch: "the fixture section is missing", config: { ...CLIENT_FIELDS, ...POLICY } },
    {
      name: "fixture_null",
      branch: "the fixture section is null",
      config: { ...CLIENT_FIELDS, ...POLICY, NativeLocalPlayerFixture: null },
    },
    { name: "enable_absent", branch: "Enable is missing", config: withFixture({ Enable: undefined }) },
    { name: "enable_false", branch: "Enable is false", config: withFixture({ Enable: false }) },
    {
      name: "enable_wrong_type",
      branch: 'Enable is the string "true", which is not true',
      config: withFixture({ Enable: "true" }),
    },
    {
      name: "bootstrap_enabled",
      branch: "the title-screen bootstrap phase's own config, which no observed run may accept",
      config: withFixture({ Bootstrap: { Enable: true, SaveName: "GameBuddy" } }),
    },
    {
      name: "bootstrap_present_off",
      branch: "a Bootstrap section that is off",
      config: withFixture({ Bootstrap: { Enable: false } }),
    },
    {
      name: "bootstrap_present_bare",
      branch: "a Bootstrap section with no Enable key at all",
      config: withFixture({ Bootstrap: {} }),
    },
    {
      name: "scenario_other",
      branch: "a config armed for another world",
      config: withFixture({ FixtureScenario: "native_other_v1" }),
    },
    { name: "scenario_absent", branch: "no scenario armed", config: withFixture({ FixtureScenario: undefined }) },
    {
      name: "save_name_prefix",
      branch: "a logical save the fixture does not own",
      config: withFixture({ LogicalSaveName: "Probe" }),
    },
    {
      name: "save_name_absent",
      branch: "the logical save name is not a string",
      config: withFixture({ LogicalSaveName: 7 }),
    },
    {
      name: "slot_other_save",
      branch: "the observed slot names another logical save",
      config: withFixture({ ObservedSaveSlot: "GameBuddyFixtureOther_1" }),
    },
    {
      name: "slot_not_a_number",
      branch: "the observed slot carries no slot number",
      config: withFixture({ ObservedSaveSlot: "GameBuddyFixtureProbe_x" }),
    },
    { name: "topology_portfolio", branch: "the portfolio is on", config: config({ Portfolio: { Enable: true } }) },
    {
      name: "topology_host_automation",
      branch: "host automation is on",
      config: config({ HostAutomation: { Enable: true } }),
    },
    {
      name: "topology_host_farmhand",
      branch: "host farmhand provisioning is on",
      config: config({ HostFarmhandProvisioning: { Enable: true } }),
    },
    {
      name: "topology_farmhand_provisioner",
      branch: "the farmhand provisioner is on",
      config: config({ FarmhandProvisioner: { Enable: true } }),
    },
    {
      name: "topology_present_off",
      branch: "a shared topology section that is not enabled, which is the fixture's own default",
      config: config({ Portfolio: { Enable: false }, HostAutomation: { Enable: false } }),
    },
    {
      name: "shared_world_host_automation",
      branch: "a shared-world farmhand config: host automation on and no native-local fixture at all",
      config: { ...CLIENT_FIELDS, ...POLICY, HostAutomation: { Enable: true } },
    },
    {
      name: "client_field_absent",
      branch: "the fixture is valid and the client transport fields are missing, which this refusal does not read",
      config: { ...POLICY, NativeLocalPlayerFixture: own },
    },
    {
      name: "shared_world_accepting",
      branch: "the OTHER supported topology: the farmhand provisioner is on and no native-local fixture exists",
      config: { ...CLIENT_FIELDS, ...POLICY, FarmhandProvisioner: { Enable: true } },
    },
    {
      name: "policy_absent",
      branch: "no DeniedActions/DeniedActionFamilies/ExperimentalActions at all",
      config: { ...CLIENT_FIELDS, NativeLocalPlayerFixture: own },
    },
    {
      name: "policy_denies_the_action",
      branch: "the derived policy denies the action under test",
      config: config({ DeniedActions: [action] }),
    },
    {
      name: "policy_illegal_opt_in",
      branch: "an experimental action the caller did not declare",
      config: config({ ExperimentalActions: ["other_action"] }),
    },
    {
      name: "policy_declared_opt_in",
      branch: "the action under test opted in, which a caller that declares no opt-in must refuse",
      config: config({ ExperimentalActions: [action] }),
    },
    {
      name: "shape_before_topology",
      branch: "the fixture section is missing AND a shared topology feature is on",
      config: { ...CLIENT_FIELDS, ...POLICY, Portfolio: { Enable: true } },
    },
    {
      name: "scenario_before_topology",
      branch: "the scenario is another AND a shared topology feature is on",
      config: config({
        NativeLocalPlayerFixture: fixture({ FixtureScenario: "native_other_v1" }),
        Portfolio: { Enable: true },
      }),
    },
    {
      name: "policy_before_topology",
      branch: "the policy denies the action AND a shared topology feature is on",
      config: config({ Portfolio: { Enable: true }, DeniedActions: [action] }),
    },
    {
      name: "bootstrap_and_scenario",
      branch: "the bootstrap is on AND the scenario is another",
      config: withFixture({ Bootstrap: { Enable: true }, FixtureScenario: "native_other_v1" }),
    },
    {
      name: "slot_and_scenario",
      branch: "the slot is broken AND the scenario is another",
      config: withFixture({ ObservedSaveSlot: "GameBuddyFixtureProbe_x", FixtureScenario: "native_other_v1" }),
    },
  ].map((probe) => ({ ...probe, scenario, action }));
}

/**
 * The two option sets every probe is answered under, and why these two.
 *
 * `minimal` is the options a runner that arms no scenario of its own gives: the shape and the topology, nothing else.
 * `maximal` arms the scenario, reads the slot relationship, asserts the policy and declares nothing experimental. Every
 * option the primitive has is exercised by one of them, so no option can be added without a probe disagreeing.
 */
export const FIXTURE_CONFIG_OPTION_SETS = Object.freeze({
  minimal: Object.freeze({ action: PROBE_ACTION }),
  maximal: Object.freeze({
    action: PROBE_ACTION,
    fixtureScenario: PROBE_SCENARIO,
    slotRelationship: true,
    requiredActions: Object.freeze([PROBE_ACTION]),
    experimentalActions: Object.freeze([]),
  }),
});

/**
 * THE PROBES ON WHICH THE PRIMITIVE IS DELIBERATELY DIFFERENT FROM SOME COPIES IT REPLACES, and why.
 *
 * A copy that differs from the primitive only on these still migrates, and the migration ADOPTS the primitive's answer
 * rather than preserving the copy's. Each is an input the fixture never writes, so adopting it changes no run:
 *
 *   bootstrap_enabled        eight copies never looked at `Bootstrap`, and the primitive refuses `Enable === true` because
 *                            that is the title-screen bootstrap phase's own config, the phase in which no bridge is open.
 *                            `configureNativeLocalPlayer` replaces the whole fixture section without the key, so an observed
 *                            config cannot carry it.
 *   bootstrap_and_scenario   the same config with a wrong scenario too: both refuse it, and the shape answers first.
 *   bootstrap_present_bare   `fertilize-tile` read `Bootstrap != null && Enable !== false`, which refuses `{}`; the
 *                            primitive accepts it (`?.Enable !== true`). Neither shape is one the fixture writes.
 */
export const ADOPTED_FIXTURE_PROBES = Object.freeze({
  bootstrap_enabled: "the title-screen bootstrap phase's own config, which no observed run may accept",
  bootstrap_and_scenario: "the same config refused by the shape before the scenario is read",
  bootstrap_present_bare: "a Bootstrap section with no Enable key, which the fixture never writes",
});

/**
 * One verdict: `ok` when the config is accepted, `refused:<word>` when it is not, `unreadable:<why>` when the candidate
 * could not be run at all. The third is not a refusal - a copy that throws `ReferenceError` is a copy this corpus cannot
 * read, and reporting it as a refusal would let a broken candidate look like a stricter primitive.
 *
 * The accepted answer carries no VALUE: what a fixture-config refusal returns is not part of its contract (the copies
 * answer `undefined`; `machine-inspect`'s also returns the topology it classified), and a comparison that read the value
 * would report a difference where the two refuse and accept the same configs.
 */
export function fixtureConfigVerdict(run, config) {
  try {
    run(config);
    return "ok";
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error instanceof ReferenceError) return `unreadable:${message}`;
    return `refused:${message}`;
  }
}

/** Every probe's verdict for one candidate under one option set. */
export function fixtureConfigVerdicts(run, { scenario = PROBE_SCENARIO } = {}) {
  return fixtureConfigProbes({ scenario }).map((probe) => ({
    name: probe.name,
    verdict: fixtureConfigVerdict(run, probe.config),
  }));
}

/**
 * Does `run` answer exactly as `expected` on every probe? The first disagreement, named by probe, is the answer.
 *
 * This is the only question the migration asks: not "is this function called validateConfig", but "does this body accept
 * and refuse exactly the configs the primitive does". A copy that differs on one probe is refused BY THAT PROBE, so the
 * next reader knows what to look at instead of being told two functions differ.
 */
export function fixtureConfigDifference(run, expected, { scenario } = {}) {
  const actual = fixtureConfigVerdicts(run, { scenario });
  for (const [at, entry] of actual.entries()) {
    if (entry.verdict !== expected[at]) return { probe: entry.name, expected: expected[at], actual: entry.verdict };
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------------------------
 * READING A PRIVATE COPY
 *
 * A copy is a function whose body names things the runner declares elsewhere: `SCENARIO`, `ACTION`, `EXPECTED_ACTIONS`,
 * and the three helpers the refusal is built out of. To RUN a copy - which is the only way to learn what it accepts -
 * those names have to be bound to the values the runner gives them, and to find those values this module reads the
 * runner's own source. A name it cannot resolve is a copy it cannot read, and that is reported as such rather than
 * guessed: a guessed binding would make a copy look different for a reason that is about this reader, not the copy.
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * A PRIVATE COPY, MADE RUNNABLE.
 *
 * A copy is a function whose body names what its runner declares elsewhere: `SCENARIO`, `ACTION`, `EXPECTED_ACTIONS`,
 * the harness's policy validator, and sometimes a helper of its own (`validFixtureBinding`). To RUN a copy - the only way
 * to learn what it accepts - those names have to be bound to the values that runner gives them, so this reader takes the
 * runner's source as well as the copy's body and resolves each name from it. A name it cannot resolve is reported
 * (`unreadable:<name>`), never guessed: a guessed binding would make the copy look different for a reason that is about
 * this reader rather than about the copy.
 */
/** The helpers this module can answer for a copy, when the runner does not declare its own. */
export const SHARED_FIXTURE_HELPERS = Object.freeze({
  validateNativeLocalFixturePolicy,
  validFixtureSlotRelationship,
  validFixtureBinding: validFixtureSlotRelationship,
  classifyTopology,
});

/** The constants a copy body reads, and how each is spelled in the runner. */
const RUNNER_CONSTANTS = Object.freeze([
  "SCENARIO",
  "FIXTURE_SCENARIO",
  "ACTION",
  "EXPECTED_ACTIONS",
  "_EXPECTED_ACTIONS",
]);

/** The text of a `[`/`{`/`(` starting at `start`, by matching brackets over the raw source. */
function balanced(text, start) {
  const open = text[start];
  const close = { "[": "]", "{": "}", "(": ")" }[open];
  if (close === undefined) return null;
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index++;
      while (index < text.length && text[index] !== char) index += text[index] === "\\" ? 2 : 1;
      index++;
      continue;
    }
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
    index++;
  }
  return null;
}

/** A `[...]` of string literals and already-resolved names, or null when any element is neither. */
function readStringList(text, resolved) {
  if (text === null || !(text.trim().startsWith("[") && text.trim().endsWith("]"))) return null;
  const inner = text.trim().slice(1, -1).trim();
  if (inner.length === 0) return [];
  const values = [];
  for (const piece of inner.split(",")) {
    const entry = piece.trim();
    if (entry.length === 0) return null;
    const literal = /^(["'`])([^"'`]*)\1$/u.exec(entry);
    if (literal !== null) {
      values.push(literal[2]);
      continue;
    }
    if (!Object.hasOwn(resolved, entry)) return null;
    const value = resolved[entry];
    if (Array.isArray(value)) values.push(...value);
    else if (typeof value === "string") values.push(value);
    else return null;
  }
  return values;
}

/** The TEXT of a policy option inside the copy's body: `requiredActions: EXPECTED_ACTIONS` -> `EXPECTED_ACTIONS`. */
function policyText(body, key) {
  const at = new RegExp(`\\b${key}\\s*:\\s*(\\[[^\\]]*\\]|[A-Za-z_$][\\w$]*)`, "u").exec(body);
  return at === null ? null : at[1];
}

/** The value of a policy option inside the copy's body: `requiredActions: <expr>` or `experimentalActions: <expr>`. */
function policyList(body, key, resolved) {
  const at = new RegExp(`\\b${key}\\s*:\\s*(\\[[^\\]]*\\]|[A-Za-z_$][\\w$]*)`, "u").exec(body);
  if (at === null) return undefined;
  if (at[1].startsWith("[")) return readStringList(at[1], resolved);
  const named = resolved[at[1]];
  return Array.isArray(named) ? named : null;
}

/**
 * The copy, bound and runnable, plus the values the refusal compares against.
 *
 * `source` is the whole runner (for its constants and its own helper declarations), `body` is the copy's declaration.
 * `localFunctions` is the gate's function scanner, handed in so this module does not need a second one.
 */
export function fixtureCopyRunner({ source, body, name, localFunctions, params = 1 }) {
  const resolved = {};
  for (const constant of RUNNER_CONSTANTS) {
    const declared = new RegExp(`const\\s+${constant}\\s*=\\s*(\\[[^\\]]*\\]|["'\`][^"'\`]*["'\`])\\s*;`, "u").exec(
      source,
    );
    if (declared === null) continue;
    if (declared[1].startsWith("[")) {
      const list = readStringList(declared[1], resolved);
      if (list !== null) resolved[constant] = list;
      continue;
    }
    resolved[constant] = declared[1].slice(1, -1);
  }
  // The world this copy asserts, in the order of authority the copies themselves used: the comparison against
  // `FixtureScenario`, then the runner's own scenario constant, then any scenario-shaped literal in the body (a copy that
  // reads the section into a local and compares it there spells no comparison this reader can see, and
  // `native_ride_bus_v1` was armed for the wrong world until this third reading existed).
  const comparison = /FixtureScenario\s*!==?\s*(["'])([^"']*)\1/u.exec(body);
  const shaped = /(["'])(native_[a-z0-9_]+_v[0-9]+)\1/u.exec(body);
  const declaredScenario =
    typeof resolved.SCENARIO === "string"
      ? resolved.SCENARIO
      : typeof resolved.FIXTURE_SCENARIO === "string"
        ? resolved.FIXTURE_SCENARIO
        : null;
  const scenario =
    comparison !== null ? comparison[2] : (declaredScenario ?? (shaped !== null ? shaped[2] : PROBE_SCENARIO));
  const action = typeof resolved.ACTION === "string" ? resolved.ACTION : null;
  const requiredActions = policyList(body, "requiredActions", resolved);
  const experimentalActions = policyList(body, "experimentalActions", resolved);
  // The TEXTS the migration writes: a runner that names its action set `EXPECTED_ACTIONS` keeps that name in the call,
  // so the constant stays the one place its list is written rather than being copied into an options object.
  const texts = {
    action: typeof resolved.ACTION === "string" ? "ACTION" : null,
    scenario:
      comparison !== null
        ? comparison[0].replace(/^FixtureScenario\s*!==?\s*/u, "")
        : typeof resolved.SCENARIO === "string"
          ? "SCENARIO"
          : typeof resolved.FIXTURE_SCENARIO === "string"
            ? "FIXTURE_SCENARIO"
            : shaped !== null
              ? shaped[0]
              : null,
    requiredActions: policyText(body, "requiredActions"),
    experimentalActions: policyText(body, "experimentalActions"),
  };

  // The names the body reads that the runner's constants do not answer: its own helpers, compiled from their declaration.
  const bindings = { ...resolved };
  for (const entry of localFunctions(source)) {
    if (entry.name === name || Object.hasOwn(bindings, entry.name)) continue;
    if (!new RegExp(`(?<![\\w$.])${entry.name}(?![\\w$])`, "u").test(body)) continue;
    const compiled = new Function(`${entry.body.replace(/^\s*export\s+/u, "")}\nreturn ${entry.name};`)();
    bindings[entry.name] = compiled;
  }
  const names = [...new Set([...Object.keys(bindings), ...Object.keys(SHARED_FIXTURE_HELPERS)])].filter((binding) =>
    new RegExp(`(?<![\\w$.])${binding}(?![\\w$])`, "u").test(body),
  );
  const missing = names.filter(
    (binding) => !Object.hasOwn(bindings, binding) && !Object.hasOwn(SHARED_FIXTURE_HELPERS, binding),
  );
  if (missing.length > 0) return { ok: false, why: `unbound:${missing.join(",")}` };
  let fn;
  try {
    const declared = body.replace(/^\s*export\s+/u, "");
    fn = new Function(...names, `${declared}\nreturn ${name};`)(
      ...names.map((binding) =>
        Object.hasOwn(bindings, binding) ? bindings[binding] : SHARED_FIXTURE_HELPERS[binding],
      ),
    );
  } catch (error) {
    return { ok: false, why: `unparsable:${String(error?.message ?? error)}` };
  }
  // A copy declared with a second parameter takes the scenario it expects from its caller, so it is called the way its
  // own call site calls it; probing it with one argument would leave that parameter undefined and read as a copy that
  // accepts every world.
  const callable = params > 1 ? (value) => fn(value, scenario) : fn;
  return { ok: true, fn: callable, raw: fn, params, scenario, action, requiredActions, experimentalActions, texts };
}

/**
 * The parameterisations a copy could be a call to, from what its runner declares.
 *
 * The lists are the copy's OWN (`requiredActions: EXPECTED_ACTIONS` resolves to the runner's list), not the action
 * under test alone: a migration that wrote `requiredActions: [action]` would drop every other action the copy refused
 * to run without, and the corpus's deny probes would not notice unless they denied one of those.
 */
export function fixtureCopyParameterisations(scope) {
  const base = { action: scope.action };
  const sets = [
    ["fixture_shape", { ...base }],
    ["fixture_shape_scenario", { ...base, fixtureScenario: scope.scenario }],
    ["fixture_shape_slot", { ...base, slotRelationship: true }],
    ["fixture_shape_scenario_slot", { ...base, fixtureScenario: scope.scenario, slotRelationship: true }],
  ];
  if (scope.requiredActions !== null && scope.requiredActions !== undefined) {
    const required = { ...base, requiredActions: scope.requiredActions };
    sets.push(["fixture_policy", required]);
    sets.push(["fixture_policy_scenario", { ...required, fixtureScenario: scope.scenario }]);
    sets.push([
      "fixture_policy_scenario_slot",
      { ...required, fixtureScenario: scope.scenario, slotRelationship: true },
    ]);
    if (scope.experimentalActions !== null && scope.experimentalActions !== undefined)
      sets.push([
        "fixture_policy_scenario_experimental",
        { ...required, fixtureScenario: scope.scenario, experimentalActions: scope.experimentalActions },
      ]);
  }
  return sets.map(([id, options]) => ({ id, options }));
}
