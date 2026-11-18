/**
 * THE CORPUS'S OWN TESTS: what it must separate, and what the primitive must answer.
 *
 * WHY A PINNED TABLE. The corpus exists so the 51 private copies of the fixture-config refusal can be migrated by
 * BEHAVIOUR rather than by reading their bodies. That only works if the corpus's answers are a specification instead of a
 * description: a table computed from the implementation would agree with it forever, including after it drifted. So every
 * probe's answer is written out below, once, and the primitive has to reproduce it. A change to the primitive therefore
 * arrives here as a red test naming the probe and the branch it covers.
 *
 * red-proof: edit any pin below, or add an option to the primitive that changes an answer ->
 *   `probe "<name>" (<branch>) under the minimal options` with the expected and actual answers
 * red-proof: give `validateNativeLocalFixtureConfig` a defaulted `action` ->
 *   "the action is the refusal's subject" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixtureConfigProbes,
  fixtureConfigVerdict,
  fixtureConfigVerdicts,
  FIXTURE_CONFIG_OPTION_SETS,
  PROBE_ACTION,
} from "./native-local-runner-primitives-corpus.mjs";
import { validateNativeLocalFixtureConfig } from "./native-local-runner-primitives.mjs";

const withOptions = (options) => (value) => validateNativeLocalFixtureConfig(value, options);

/** Every probe's answer, under the options a runner that arms no scenario gives, then under the fullest option set. */
const SPECIFICATION = Object.freeze({
  valid: ["ok", "ok"],
  empty_object: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  null: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  undefined: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  not_an_object: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  fixture_absent: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  fixture_null: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  enable_absent: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  enable_false: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  enable_wrong_type: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  bootstrap_enabled: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  bootstrap_present_off: ["ok", "ok"],
  bootstrap_present_bare: ["ok", "ok"],
  scenario_other: ["ok", "refused:native_local_probe_action_fixture_scenario_mismatch:native_other_v1"],
  scenario_absent: ["ok", "refused:native_local_probe_action_fixture_scenario_mismatch:missing"],
  save_name_prefix: ["ok", "refused:native_local_probe_action_fixture_config_invalid"],
  save_name_absent: ["ok", "refused:native_local_probe_action_fixture_config_invalid"],
  slot_other_save: ["ok", "refused:native_local_probe_action_fixture_config_invalid"],
  slot_not_a_number: ["ok", "refused:native_local_probe_action_fixture_config_invalid"],
  topology_portfolio: [
    "refused:native_local_probe_action_action_policy_invalid",
    "refused:native_local_probe_action_action_policy_invalid",
  ],
  topology_host_automation: [
    "refused:native_local_probe_action_action_policy_invalid",
    "refused:native_local_probe_action_action_policy_invalid",
  ],
  topology_host_farmhand: [
    "refused:native_local_probe_action_action_policy_invalid",
    "refused:native_local_probe_action_action_policy_invalid",
  ],
  topology_farmhand_provisioner: [
    "refused:native_local_probe_action_action_policy_invalid",
    "refused:native_local_probe_action_action_policy_invalid",
  ],
  topology_present_off: ["ok", "ok"],
  shared_world_host_automation: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  client_field_absent: ["ok", "ok"],
  shared_world_accepting: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  policy_absent: ["ok", "refused:native_fixture_policy_invalid"],
  policy_denies_the_action: ["ok", "refused:native_fixture_policy_denies_required:probe_action"],
  policy_illegal_opt_in: ["ok", "refused:native_fixture_policy_illegal_opt_in:other_action"],
  policy_declared_opt_in: ["ok", "refused:native_fixture_policy_illegal_opt_in:probe_action"],
  shape_before_topology: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  scenario_before_topology: [
    "refused:native_local_probe_action_action_policy_invalid",
    "refused:native_local_probe_action_fixture_scenario_mismatch:native_other_v1",
  ],
  policy_before_topology: [
    "refused:native_local_probe_action_action_policy_invalid",
    "refused:native_local_probe_action_action_policy_invalid",
  ],
  bootstrap_and_scenario: [
    "refused:native_local_probe_action_fixture_config_invalid",
    "refused:native_local_probe_action_fixture_config_invalid",
  ],
  slot_and_scenario: ["ok", "refused:native_local_probe_action_fixture_config_invalid"],
});

test("the corpus pins one answer per probe, and the primitive gives exactly it", () => {
  const probes = fixtureConfigProbes();
  assert.deepEqual(
    probes.map((probe) => probe.name),
    Object.keys(SPECIFICATION),
    "a probe was added or renamed without its pinned answers: name it in SPECIFICATION and say which branch it covers",
  );
  for (const probe of probes) {
    assert.ok(
      probe.branch.length > 10,
      `probe "${probe.name}" must say which branch it covers, so a failure here is readable`,
    );
    for (const [column, label, options] of [
      [0, "minimal", FIXTURE_CONFIG_OPTION_SETS.minimal],
      [1, "maximal", FIXTURE_CONFIG_OPTION_SETS.maximal],
    ])
      assert.equal(
        fixtureConfigVerdict(withOptions(options), probe.config),
        SPECIFICATION[probe.name][column],
        `probe "${probe.name}" (${probe.branch}) under the ${label} options`,
      );
  }
});

test("the corpus separates the axes it exists to separate", () => {
  const minimal = fixtureConfigVerdicts(withOptions(FIXTURE_CONFIG_OPTION_SETS.minimal));
  const maximal = fixtureConfigVerdicts(withOptions(FIXTURE_CONFIG_OPTION_SETS.maximal));
  const decidedByAnOption = minimal
    .filter((entry, at) => entry.verdict !== maximal[at].verdict)
    .map((entry) => entry.name);
  // These, and only these, are what the scenario, slot and policy options change. A probe that starts answering
  // differently has found either a new axis or a bug in an old one.
  assert.deepEqual(decidedByAnOption, [
    "scenario_other",
    "scenario_absent",
    "save_name_prefix",
    "save_name_absent",
    "slot_other_save",
    "slot_not_a_number",
    "policy_absent",
    "policy_denies_the_action",
    "policy_illegal_opt_in",
    "policy_declared_opt_in",
    "scenario_before_topology",
    "slot_and_scenario",
  ]);
  // The topology axis is read either way: no option set may switch it off.
  for (const entry of maximal)
    if (entry.name.startsWith("topology_") && entry.name !== "topology_present_off")
      assert.equal(entry.verdict, `refused:native_local_${PROBE_ACTION}_action_policy_invalid`, entry.name);
});

test("a candidate that cannot run is unreadable, not stricter - a ReferenceError is not a refusal", () => {
  assert.equal(
    fixtureConfigVerdict(() => {
      throw new ReferenceError("SCENARIO is not defined");
    }, {}),
    "unreadable:SCENARIO is not defined",
  );
  assert.equal(
    fixtureConfigVerdict(() => {
      throw new Error("native_local_x_fixture_config_invalid");
    }, {}),
    "refused:native_local_x_fixture_config_invalid",
  );
});

test("the action is the refusal's subject: no default picks a word on every runner's behalf", () => {
  const fixture = { NativeLocalPlayerFixture: { Enable: true } };
  for (const action of [undefined, null, "", 7])
    assert.throws(() => validateNativeLocalFixtureConfig(fixture, { action }), {
      message: `native_local_fixture_config_action_missing:${String(action)}`,
    });
});
