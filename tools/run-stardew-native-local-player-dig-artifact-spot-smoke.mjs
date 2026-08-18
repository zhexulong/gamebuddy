import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_dig_artifact_spot_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "dig_artifact_spot", "equip_tool", "inspect_self", "move_to_tile", "travel"];
// Evidence values are serialized with up to four decimal places; allow rounding plus binary floating-point noise.
const DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON = 0.011;

/** Execute the dig-artifact-spot contract against an already-connected bridge session. */
export async function runDigArtifactSpotSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);
    const initialSourceCount = before.artifactSpotFarmSourceCount;
    if (!Number.isInteger(initialSourceCount) || initialSourceCount < 1)
      throw new Error(`dig_artifact_spot_initial_farm_source_count:${initialSourceCount}`);
    const target = chooseTarget(before);
    const hoe = chooseHoe(before);
    const equipped = await execute(client, trace, "equip_hoe", "equip_tool", { slot: hoe.slot }, before);
    if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected")
      throw new Error(`hoe_equip_failed:${equipped.reasonCode}`);
    const fresh = await observeFresh(client, { actionable: true });
    const preCount = fresh.artifactSpotFarmSourceCount;
    if (!Number.isInteger(preCount) || preCount < 1 || preCount !== initialSourceCount)
      throw new Error(`dig_artifact_spot_fresh_farm_source_count:${preCount}`);
    const freshTarget = (fresh.artifactSpotTargets ?? []).find(
      (entry) =>
        entry?.targetId === target.targetId &&
        entry.x === target.x &&
        entry.y === target.y &&
        entry.qualifiedItemId === "(O)590",
    );
    if (!freshTarget) throw new Error("dig_artifact_spot_target_changed_after_equip");
    const accepted = await execute(
      client,
      trace,
      "dig_artifact_spot",
      "dig_artifact_spot",
      { slot: hoe.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId },
      fresh,
    );
    if (accepted.state !== "succeeded" || accepted.reasonCode !== "artifact_spot_dug")
      throw new Error(`dig_artifact_spot_failed:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.state !== "succeeded") throw new Error("dig_artifact_spot_terminal_receipt_missing");
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true });
    const resultTargets = after.artifactSpotResultTargets ?? [];
    const resultTarget = resultTargets.length === 1 ? resultTargets[0] : null;
    const passed =
      resultTarget?.location === target.location &&
      resultTarget.x === target.x &&
      resultTarget.y === target.y &&
      resultTarget.crop === false &&
      resultTarget.ground === true &&
      evidence.result_target === resultTarget.targetId &&
      evidence.target === target.targetId &&
      evidence.location === target.location &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.tool === "hoe" &&
      evidence.slot === String(hoe.slot) &&
      evidence.stamina_before !== undefined &&
      evidence.stamina_after !== undefined &&
      evidence.stamina_delta !== undefined &&
      evidence.expected_stamina_cost !== undefined &&
      Number.isFinite(parseFiniteDecimal(evidence.stamina_before)) &&
      Number.isFinite(parseFiniteDecimal(evidence.stamina_after)) &&
      Number.isFinite(parseFiniteDecimal(evidence.stamina_delta)) &&
      Number.isFinite(parseFiniteDecimal(evidence.expected_stamina_cost)) &&
      Math.abs(
        parseFiniteDecimal(evidence.stamina_after) -
          parseFiniteDecimal(evidence.stamina_before) -
          parseFiniteDecimal(evidence.stamina_delta),
      ) <= 0.001 &&
      Math.abs((-parseFiniteDecimal(evidence.stamina_delta)) - parseFiniteDecimal(evidence.expected_stamina_cost)) <= DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON &&
      parseFiniteDecimal(evidence.stamina_delta) <= 0 &&
      parseFiniteDecimal(evidence.expected_stamina_cost) >= 0 &&
      evidence.qualified_item_id === "(O)590" &&
      evidence.source_present_before === "true" &&
      evidence.source_present_after === "false" &&
      evidence.hoedirt_present_before === "false" &&
      evidence.hoedirt_present_after === "true" &&
      evidence.source_removed === "true" &&
      after.artifactSpotFarmSourceCount === preCount - 1 &&
      !(after.artifactSpotTargets ?? []).some((entry) => entry.targetId === target.targetId);
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "artifact_spot_dug" : "dig_artifact_spot_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
      before: summary(before),
      after: summary(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runDigArtifactSpotSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_dig_artifact_spot_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture?.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"])
  )
    throw new Error("native_local_dig_artifact_spot_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_dig_artifact_spot_topology_invalid");
}
function chooseTarget(snapshot) {
  const targets = (snapshot.artifactSpotTargets ?? [])
    .filter(
      (entry) =>
        entry?.targetId &&
        entry.location === "Farm" &&
        Number.isInteger(entry.x) &&
        Number.isInteger(entry.y) &&
        entry.qualifiedItemId === "(O)590",
    )
    .sort((left, right) => left.x - right.x || left.y - right.y || left.targetId.localeCompare(right.targetId));
  if (targets.length === 0) throw new Error("no_live_artifact_spot_target");
  return targets[0];
}
function chooseHoe(snapshot) {
  const tools = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Hoe");
  if (tools.length !== 1) throw new Error(tools.length ? "ambiguous_live_basic_hoe_slot" : "no_live_basic_hoe_slot");
  return tools[0];
}
function parseStrictEvidence(receiptEvidence) {
  const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : "";
  const expected = [
    "location",
    "target",
    "result_target",
    "tile",
    "tool",
    "slot",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "qualified_item_id",
    "source_present_before",
    "source_present_after",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "source_removed",
  ];
  const parts = detail.split(";");
  const result = {};
  for (const part of parts) {
    const i = part.indexOf("=");
    if (i <= 0 || i === part.length - 1) return {};
    const key = part.slice(0, i);
    if (Object.prototype.hasOwnProperty.call(result, key)) return {};
    result[key] = part.slice(i + 1);
  }
  return Object.keys(result).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(result, key)) &&
    ["stamina_before", "stamina_after", "stamina_delta", "expected_stamina_cost"].every(
      (key) => parseFiniteDecimal(result[key]) !== null,
    )
    ? result
    : {};
}
function parseFiniteDecimal(value) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function summary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    artifactSpotTargets: snapshot.artifactSpotTargets?.length ?? 0,
    artifactSpotResultTargets: snapshot.artifactSpotResultTargets?.length ?? 0,
    artifactSpotFarmSourceCount: snapshot.artifactSpotFarmSourceCount ?? null,
  };
}
