import {
  assertTopologyCapabilities,
  classifyTopology,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  observeTopologySnapshot,
  readNativeClientConfig,
  summarizeReceipt,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const SCENARIO = "native_pet_animal_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "pet_animal"];

/** Execute the pet-animal contract against an already-connected bridge session. */
export async function runPetAnimalSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 10_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const startedAt = Date.now();
  const topology = validateTopologyConfig(config);
  try {
    const before = await observeActionable(client, topology);
    assertTopologyCapabilities(before, topology, EXPECTED_CAPABILITIES);
    const target = chooseOnlyPetTarget(before);
    if (target.friendship !== 0 || target.pettedToday !== false) throw new Error("pet_fixture_starting_state_mismatch");
    const requestId = `native_local_pet_animal_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "pet_animal",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    if (accepted.state !== "accepted") throw new Error(`pet_animal_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => Array.isArray(snapshot.petTargets),
    });
    assertTopologyCapabilities(after, topology, EXPECTED_CAPABILITIES);
    const evidence = parseEvidence(terminal.evidence);
    const targetGone = !validTargets(after).some((entry) => entry.targetId === target.targetId);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      terminal.state === "succeeded" &&
      terminal.reasonCode === "pet_completed" &&
      targetGone &&
      evidence.location === before.location &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.pet_day === String(evidence.pet_day) &&
      evidence.friendship_before === "0" &&
      evidence.friendship_after === "12" &&
      evidence.day_recorded === "true" &&
      evidence.friendship_callback === "true";
    return {
      state: passed ? "passed" : "blocked",
      topology,
      reasonCode: passed ? "pet_completed" : "pet_animal_postcondition_mismatch",
      target: targetSummary(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      freshPostcondition: { targetGone },
      after: snapshotSummary(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology,
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      // Include the observable facts that decide the outcome. Without these a
      // failure is indistinguishable between "no pet exists", "a pet exists but
      // is out of range", and "the actor is not where the driver left it".
      diagnostic: {
        location: client.state?.snapshot?.location ?? null,
        tile: client.state?.snapshot?.tile ?? null,
        actionable: client.state?.snapshot?.actionable ?? null,
        petTargetCount: Array.isArray(client.state?.snapshot?.petTargets) ? client.state.snapshot.petTargets.length : null,
        liveUnpettedCount: Array.isArray(client.state?.snapshot?.petTargets)
          ? liveUnpettedPetTargets(client.state.snapshot).length
          : null,
        validCount: Array.isArray(client.state?.snapshot?.petTargets)
          ? validTargets(client.state.snapshot).length
          : null,
        // The counts alone cannot distinguish "no pet", "pet out of range" and
        // "pet at an unexpected tile". Record where the discovered pet actually
        // is, and the Chebyshev distance from the actor.
        petTargets: Array.isArray(client.state?.snapshot?.petTargets)
          ? client.state.snapshot.petTargets.map((target) => ({
              targetId: target?.targetId ?? null,
              x: target?.x ?? null,
              y: target?.y ?? null,
              petType: target?.petType ?? null,
              friendship: target?.friendship ?? null,
              pettedToday: target?.pettedToday ?? null,
        // The native mobility fact this attempt was gated on. Without it a
        // `no_stationary_unpetted_pet_target` failure cannot be told apart from
        // a projection that never reports true at all.
        stationary: target?.stationary ?? null,
              distance:
                Number.isInteger(target?.x) && Number.isInteger(client.state?.snapshot?.tile?.x)
                  ? Math.max(
                      Math.abs(target.x - client.state.snapshot.tile.x),
                      Math.abs(target.y - client.state.snapshot.tile.y),
                    )
                  : null,
            }))
          : null,
      },
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runPetAnimalSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "blocked",
        reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      }),
    );
    process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function observeActionable(client, topology) {
  const snapshot = await observeTopologySnapshot(client, topology, { actionable: true });
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.capabilities) ||
    (snapshot.petTargets != null && !Array.isArray(snapshot.petTargets))
  )
    throw new Error("native_local_pet_animal_snapshot_invalid");
  if (snapshot.petTargets == null) snapshot.petTargets = [];
  return snapshot;
}

/** Live unpetted Pets the contract accepts, before the standing-tile requirement. */
function liveUnpettedPetTargets(snapshot) {
  return snapshot.petTargets.filter(
    (target) =>
      typeof target?.targetId === "string" &&
      /^pet_[a-f0-9]{16}$/.test(target.targetId) &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      typeof target.petType === "string" &&
      target.petType.length > 0 &&
      Number.isInteger(target.friendship) &&
      target.friendship >= 0 &&
      target.friendship <= 1000 &&
      target.pettedToday === false,
  );
}

/**
 * The live unpetted Pet that is also holding still, if exactly one qualifies.
 *
 * `stationary` is the Mod's projection of the native `WalkInDirection` flag for
 * the pet's current behaviour: a Pet in Walk/Sprint/LeapJump is moving and will
 * not be where it was by the time an action reaches it, while one in
 * SitDown/SitSide/Flop holds still. Callers use this to choose *when* to attempt;
 * it never widens what the contract will accept.
 *
 * Shaped like `chooseUnpettedPetTarget` -- one target, or a named failure --
 * because callers hand the result straight to a single-target helper. Returning a
 * collection here would make that helper's tile arithmetic NaN, which serializes
 * as null and is rejected as a malformed request rather than reported as a
 * positioning failure.
 */
export function chooseStationaryUnpettedPetTarget(snapshot) {
  const targets = chooseStationaryUnpettedPetTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(
      targets.length === 0 ? "no_stationary_unpetted_pet_target" : "ambiguous_stationary_unpetted_pet_target",
    );
  return targets[0];
}

/** Every live unpetted Pet target that is currently holding still. */
export function chooseStationaryUnpettedPetTargets(snapshot) {
  return liveUnpettedPetTargets(snapshot).filter((target) => target.stationary === true);
}

function validTargets(snapshot) {
  return liveUnpettedPetTargets(snapshot).filter((target) => adjacent(snapshot.tile, target));
}

/** The sole pet target the contract will admit from the actor's current tile. */
function chooseOnlyPetTarget(snapshot) {
  const targets = validTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_unpetted_pet_target" : "ambiguous_fresh_unpetted_pet_target");
  return targets[0];
}

/**
 * The sole live unpetted Pet target the contract will accept, without the
 * actor-adjacency requirement.
 *
 * Walking the actor into range is a locomotion concern, not a contract
 * concern: a driver must know where the Pet is in order to stand next to it,
 * and the Pet's own tile is the only source for that. The identity and
 * fixture-state checks above are shared with `chooseOnlyPetTarget`, so the
 * driver can never walk towards a Pet the contract would then refuse.
 */
export function chooseUnpettedPetTarget(snapshot) {
  const targets = liveUnpettedPetTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_unpetted_pet_target" : "ambiguous_fresh_unpetted_pet_target");
  return targets[0];
}

/**
 * Select the topology this contract is being executed under.
 *
 * The shared world is the real AI-Farmhand topology: an authenticated Farmhand
 * provisioner owns the bridge and the version-1 default-consent policy
 * publishes the consented surface. The scenario precondition belongs to the
 * Host-side fixture, so it is not asserted from the client config here. The
 * isolated native-local fixture keeps its strict config assertions.
 */
function validateTopologyConfig(value) {
  const topology = classifyTopology(value);
  if (topology === "shared_world_farmhand") {
    if (value.HostAutomation?.Enable === true || value.NativeLocalPlayerFixture?.Enable === true)
      throw new Error("native_local_fixture_topology_not_isolated");
    if (value.ActionPolicyVersion !== 1) throw new Error("shared_world_action_policy_invalid");
    return topology;
  }
  validateNativeLocalConfig(value);
  return topology;
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_pet_animal_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_pet_animal_evidence");
    result[key] = value;
  }
  const expected = [
    "day_recorded",
    "friendship_after",
    "friendship_before",
    "friendship_callback",
    "location",
    "pet_day",
    "target",
    "tile",
  ];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected))
    throw new Error("invalid_pet_animal_evidence");
  return result;
}

function validateNativeLocalConfig(value) {
  const fixture = value.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    typeof fixture.LogicalSaveName !== "string" ||
    !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(fixture.LogicalSaveName) ||
    typeof fixture.ObservedSaveSlot !== "string" ||
    !new RegExp(`^${fixture.LogicalSaveName}_[0-9]{1,32}$`).test(fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (
    value.ActionPolicyVersion !== 0 ||
    JSON.stringify(value.EnabledActions) !== JSON.stringify(["pet_animal"]) ||
    JSON.stringify(value.ExperimentalActions) !== JSON.stringify(["pet_animal"])
  )
    throw new Error("native_local_pet_animal_action_policy_invalid");
  if (
    ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    )
  )
    throw new Error("invalid_client_config");
}

function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}

function targetSummary(target) {
  return target
    ? {
        targetId: target.targetId,
        x: target.x,
        y: target.y,
        petType: target.petType,
        friendship: target.friendship,
        pettedToday: target.pettedToday,
      }
    : null;
}

function snapshotSummary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    petTargets: snapshot.petTargets?.map(targetSummary) ?? [],
    activeExecution: snapshot.activeExecution ?? null,
  };
}
