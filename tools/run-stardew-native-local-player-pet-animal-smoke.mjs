import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

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
  validateNativeLocalConfig(config);
  try {
    const before = await observeActionable(client);
    requireExactCapabilities(before);
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
    requireExactCapabilities(after);
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
      topology: "native_local_player_fixture",
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
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
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

async function observeActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
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

function requireExactCapabilities(snapshot) {
  if (JSON.stringify([...snapshot.capabilities].sort()) !== JSON.stringify([...EXPECTED_CAPABILITIES].sort()))
    throw new Error(`native_local_pet_animal_capability_not_isolated:${snapshot.capabilities.join(",")}`);
}

function validTargets(snapshot) {
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
      target.pettedToday === false &&
      adjacent(snapshot.tile, target),
  );
}

function chooseOnlyPetTarget(snapshot) {
  const targets = validTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_unpetted_pet_target" : "ambiguous_fresh_unpetted_pet_target");
  return targets[0];
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
