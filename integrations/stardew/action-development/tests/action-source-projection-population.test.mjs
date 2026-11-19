// The two populations this projection publishes are owned by declarations, not by lists kept in the producer: the gate
// table decides which actions have a runner, and the Host's `STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS` decides which tools
// are mounted from the Mod's descriptor. Each test below is one of the ways those two used to narrow without a finding -
// ten runners that drive the harness through the shared layer were reported as having lost it, and forty-eight mounts
// that spell no action id had vanished from the route surface.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY,
  deriveActionSourceProjection,
  loadSources,
} from "../src/action-source-projection-producer.mjs";

const repositoryRoot = path.resolve(ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY, "../../../..");
const sources = await loadSources(repositoryRoot);
const projection = deriveActionSourceProjection(sources);
const runnerSources = JSON.parse(sources.runner_sources);

const SHARED_HARNESS = "lib/stardew-native-smoke-harness-v1.mjs";
const DECLARATION = /export const STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS = Object\.freeze\(\[([\s\S]*?)\] as const\);/u;
const declaredDescriptorDerived = [...sources.host_registry.match(DECLARATION)?.[1].matchAll(/"([a-z0-9_]+)"/gu) ?? []]
  .map((match) => match[1]);
const declaredAction = (actionId) => projection.runnerFixtureParity.actions.find((entry) => entry.actionId === actionId);

test("every action the gate table declares is examined, and the census accounts for each one", () => {
  const { actions, sharing, sharedHarnessModule } = projection.runnerFixtureParity;
  assert.equal(sharedHarnessModule, SHARED_HARNESS);
  assert.equal(actions.length, sharing.examined);
  assert.ok(sharing.examined > 0, "the census must examine a population, not zero");
  // A = S + R + C: nothing is examined without landing in one of the three buckets.
  assert.equal(sharing.sharesHarness + sharing.missing + sharing.contractRoute, sharing.examined);
  assert.equal(actions.filter((entry) => entry.runner === null).length, sharing.contractRoute);
  assert.equal(actions.filter((entry) => entry.runner !== null).length, sharing.runnerFound);
  assert.equal(sharing.missing, 0, "every runner in the table reaches the shared harness");
});

test("a runner whose only harness edge is the shared layer still shares the harness", () => {
  // The regression `prelive` reported at L0: `machine_load` imports the lifecycle from the scaffold, the scaffold imports
  // the harness, and a reader that looks for the import line in the RUNNER's own bytes sees a runner that lost it.
  const machineLoad = declaredAction("machine_load");
  assert.ok(machineLoad.runner !== null, "machine_load's gate must be a runner");
  assert.equal(
    runnerSources.files[machineLoad.runner].includes(SHARED_HARNESS),
    false,
    "this runner must NOT name the harness itself, or the test proves nothing",
  );
  assert.ok(
    runnerSources.shared["lib/native-local-runner-scaffold.mjs"].includes('"./stardew-native-smoke-harness-v1.mjs"'),
    "the scaffold is the runner's harness edge",
  );
});

test("a runner with no harness reach and a runner that is absent are different findings", () => {
  const equipTool = declaredAction("equip_tool");
  assert.ok(equipTool.runner !== null);

  const stranded = structuredClone(runnerSources);
  stranded.files[equipTool.runner] = stranded.files[equipTool.runner].replace(
    '"./lib/stardew-native-smoke-harness-v1.mjs"',
    '"./lib/stardew-native-smoke-harness-v1-renamed.mjs"',
  );
  const strandedMessage = (() => {
    try {
      deriveActionSourceProjection({ ...sources, runner_sources: JSON.stringify(stranded) });
      return null;
    } catch (error) {
      return error.message;
    }
  })();
  assert.ok(strandedMessage.includes(`a_runner_shares_the_harness:${equipTool.actionId}`), strandedMessage);

  const absent = structuredClone(runnerSources);
  delete absent.files[equipTool.runner];
  const absentMessage = (() => {
    try {
      deriveActionSourceProjection({ ...sources, runner_sources: JSON.stringify(absent) });
      return null;
    } catch (error) {
      return error.message;
    }
  })();
  assert.ok(absentMessage.includes(`a_runner_missing:${equipTool.actionId}`), absentMessage);
  assert.equal(absentMessage.includes("a_runner_shares_the_harness"), false, "a missing runner is not a lost import");
});

test("a contract-route action is counted by route, never reported as a runner that lost the harness", () => {
  const contractActions = projection.runnerFixtureParity.actions.filter((entry) => entry.runner === null);
  assert.ok(contractActions.length > 0, "the table must still declare contract-route actions");
  assert.equal(contractActions.length, projection.runnerFixtureParity.sharing.contractRoute);
});

test("the route surface is the Host's declaration plus the mounts that name their action", () => {
  const { toolRouteActionIds, toolRouteProvenance } = projection.host;
  assert.ok(declaredDescriptorDerived.length > 0, "the mount declaration must name actions");
  assert.equal(
    toolRouteProvenance.namedMounts + toolRouteProvenance.descriptorDerived,
    toolRouteActionIds.length,
    "the two published halves must add up to the routes they describe",
  );
  assert.equal(toolRouteProvenance.descriptorDerived, declaredDescriptorDerived.length);
  for (const actionId of declaredDescriptorDerived) assert.ok(toolRouteActionIds.includes(actionId), actionId);
  // Every tool NAME has a mount: a name no mount claims is an action the Agent cannot reach.
  for (const actionId of projection.host.toolActionIds) assert.ok(toolRouteActionIds.includes(actionId), actionId);
});

test("an id that leaves the mount declaration is reported as the narrower route set it is", () => {
  const dropped = declaredDescriptorDerived[0];
  const registry = sources.host_registry.replace(new RegExp(`\\n  "${dropped}",`, "u"), "");
  assert.notEqual(registry, sources.host_registry, "the declaration anchor must match");
  const narrowed = deriveActionSourceProjection({ ...sources, host_registry: registry });
  // A route the Host stops building is a FACT, not a reader failure: the projection reports one route fewer and one fewer
  // executable action, and the surface parity gate is what names the action that lost its route. What it must never do is
  // report a route that is still mounted as gone - that is the blindness the declaration read exists to end.
  assert.equal(narrowed.host.toolRouteProvenance.descriptorDerived, projection.host.toolRouteProvenance.descriptorDerived - 1);
  assert.equal(narrowed.host.toolRouteActionIds.length, projection.host.toolRouteActionIds.length - 1);
  assert.equal(narrowed.host.toolRouteActionIds.includes(dropped), false);
  assert.ok(!narrowed.mod.executableActionIds.includes(dropped));
  assert.equal(narrowed.host.toolRouteProvenance.namedMounts, projection.host.toolRouteProvenance.namedMounts);
});

test("a descriptor-derived id with no tool name is refused by name", () => {
  const dropped = declaredDescriptorDerived[0];
  const registry = sources.host_registry.replace(
    new RegExp(`\\n  ${dropped}: "stardew_${dropped}",`, "u"),
    "",
  );
  assert.notEqual(registry, sources.host_registry, "the tool-name anchor must match");
  assert.throws(
    () => deriveActionSourceProjection({ ...sources, host_registry: registry }),
    (error) => error instanceof Error && error.message.includes(`descriptor_derived_id_not_projected:${dropped}`),
    `a declared mount with no tool name must be refused by name`,
  );
});
