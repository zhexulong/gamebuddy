// Stardew-local `remove_fence` smoke.
//
// One placed wood fence taken down with the axe the request names, through the fence's own
// `Fence.performToolAction`. This runner's job is to prove the four facts a receipt cannot
// supply on its own:
//
//   1. the terminal is the action's own `succeeded/fence_removed`;
//   2. the WORLD agrees afterwards, read from a FRESH snapshot and never from the receipt's
//      claim: the fence is GONE from the tile, and no row stands there any more;
//   3. the receipt's own fence facts agree with the row that was acted on - same opaque target
//      id, same item, `is_gate=false`, and a fence health the swing actually consumed;
//   4. the fence was reachable by the tool in the NAMED slot, which is the projection's
//      `removable_object` kind: the Mod published it as removable only after asking the
//      fence's own `IsValidRemovalTool`, so a row of that kind is the world agreeing with the
//      tool before anything swings.
//
// The engine's `performToolAction` returns false on every branch, including the one that
// destroyed the fence, so "the fence is gone" can only come from the world - which is why the
// postcondition is a fresh snapshot and not the receipt's `removed` field.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "remove_fence";
/** The action's own success word: minted only when the fence left the collection. */
const SUCCESS_CODE = "fence_removed";

/** The Given this slice arms: one wood fence, one standable tile, one equipped axe. */
const FIXTURE_SCENARIO = "native_remove_fence_v1";

/** The Mod's own `worldObjectTargets` kind for an object the equipped axe can remove. */
const REMOVABLE_KIND = "removable_object";

const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

export async function runRemoveFenceSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 30_000, postconditionTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateConfig(config);
    // The fixture warps the actor beside the fence and that warp is ASYNC, so an immediate
    // observation can read `can_move=False`: a warp in flight is not a world that cannot act.
    const before = await waitForActionable(client, await observeFresh(client), 30_000);
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    trace.push({
      phase: "observed",
      revision: before.revision,
      location: before.location,
      tile: before.tile ?? null,
      actionable: before.actionable,
      removable: describeRemovable(before),
    });

    const fence = chooseFence(before);
    trace.push({ phase: "chosen", fence });

    const requestId = `native_local_remove_fence_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: fence.x, y: fence.y, slot: fence.slot, expectedTargetId: fence.targetId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({
      phase: "remove_fence",
      action: ACTION,
      args: { x: fence.x, y: fence.y, slot: fence.slot, expectedTargetId: fence.targetId },
      receipt: summarizeReceipt(accepted),
    });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("remove_fence_terminal_identity_mismatch");
    const evidence = parseEvidence(terminal.evidence);
    trace.push({ phase: "terminal", state: terminal.state, reasonCode: terminal.reasonCode, evidence });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== SUCCESS_CODE)
      throw new Error(
        `remove_fence_terminal_mismatch:state=${terminal.state};reason=${terminal.reasonCode}` +
          `;evidence=${terminal.evidence?.detail ?? "(none)"}`,
      );

    assertEvidence(evidence, "target", fence.targetId);
    assertEvidence(evidence, "tile", `${fence.x},${fence.y}`);
    assertEvidence(evidence, "item", fence.qualifiedItemId);
    assertEvidence(evidence, "is_gate", "false");
    assertEvidence(evidence, "removed", "true");
    assertEvidence(evidence, "tile_object_after", "none");
    assertEvidence(evidence, "slot", String(fence.slot));
    const healthBefore = Number(evidence.health_before);
    if (!Number.isFinite(healthBefore) || healthBefore <= 0)
      throw new Error(
        `remove_fence_evidence_health_before:${evidence.health_before ?? "missing"};target=${fence.targetId}`,
      );
    const swings = Number(evidence.swings);
    if (!Number.isSafeInteger(swings) || swings < 1 || swings > 2)
      throw new Error(`remove_fence_evidence_swings:${evidence.swings ?? "missing"};target=${fence.targetId}`);
    if (!Number.isSafeInteger(Number(evidence.drop_count)))
      throw new Error(`remove_fence_evidence_drop_count:${evidence.drop_count ?? "missing"};target=${fence.targetId}`);
    const staminaBefore = Number(evidence.stamina_before);
    const staminaAfter = Number(evidence.stamina_after);
    if (!Number.isFinite(staminaBefore) || !Number.isFinite(staminaAfter) || staminaAfter > staminaBefore)
      throw new Error(
        `remove_fence_evidence_stamina:${evidence.stamina_before ?? "missing"}->${evidence.stamina_after ?? "missing"}` +
          `;target=${fence.targetId}`,
      );

    // The world's own answer, after the terminal: the fence is gone from the tile.
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    if (after.location !== before.location)
      throw new Error(`remove_fence_location_changed:${before.location}->${after.location}`);
    const survivor = rowAt(after, fence.x, fence.y);
    if (survivor !== null)
      throw new Error(`remove_fence_world_unchanged:${survivor.kind}:${survivor.targetId};tile=${fence.x},${fence.y}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: SUCCESS_CODE,
      target: {
        targetId: fence.targetId,
        kind: REMOVABLE_KIND,
        location: fence.location,
        x: fence.x,
        y: fence.y,
        qualifiedItemId: fence.qualifiedItemId,
        displayName: fence.displayName,
        slot: fence.slot,
      },
      swings,
      // The world's own answer, published explicitly: no row survives on that tile. `freshRow` is the
      // verbatim row when one DOES survive (a failure), `freshRowAbsent` is the pass.
      freshTile: { x: fence.x, y: fence.y },
      freshRow: survivor,
      freshRowAbsent: survivor === null,
      drops: evidence.drops === "none" ? [] : String(evidence.drops).split("|"),
      evidence,
      receipt: summarizeReceipt(terminal),
      observations: {
        before: { revision: before.revision, location: before.location, tile: before.tile ?? null },
        after: { revision: after.revision, location: after.location, tile: after.tile ?? null },
      },
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 512),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The one published row a fence removal can name: the projection's `removable_object` kind,
 * which the Mod publishes only after asking the fence's own removal predicate about the
 * equipped tool. "Exactly one" is the fixture's contract - a second removable object would
 * make "the fence is gone" ambiguous, and the ambiguity would be in the world, not the action.
 */
function chooseFence(snapshot) {
  const rows = removableRows(snapshot);
  if (rows.length !== 1)
    throw new Error(
      `remove_fence_removable_count_expected_1_got_${rows.length}:` + (describeRemovable(snapshot) || "none"),
    );
  const row = rows[0];
  if (!Number.isSafeInteger(row.slot) || row.slot < 0)
    throw new Error(`remove_fence_row_has_no_tool_slot:target=${row.targetId};slot=${String(row.slot)}`);
  return row;
}

function removableRows(snapshot) {
  const entries = snapshot?.worldObjectTargets;
  if (!Array.isArray(entries))
    throw new Error(`remove_fence_no_world_object_projection:location=${snapshot?.location ?? "unknown"}`);
  return entries
    .filter(
      (entry) =>
        entry != null &&
        entry.kind === REMOVABLE_KIND &&
        typeof entry.targetId === "string" &&
        entry.targetId.length > 0 &&
        Number.isSafeInteger(entry.x) &&
        Number.isSafeInteger(entry.y) &&
        typeof entry.qualifiedItemId === "string",
    )
    .map((entry) => ({
      targetId: entry.targetId,
      kind: entry.kind,
      location: entry.location,
      x: entry.x,
      y: entry.y,
      slot: entry.slot,
      qualifiedItemId: entry.qualifiedItemId,
      displayName: entry.displayName ?? entry.qualifiedItemId,
    }));
}

function rowAt(snapshot, x, y) {
  const entries = snapshot?.worldObjectTargets;
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry?.x === x && entry?.y === y) ?? null;
}

function describeRemovable(snapshot) {
  const entries = snapshot?.worldObjectTargets;
  if (!Array.isArray(entries)) return "";
  return entries
    .filter((entry) => entry?.kind === REMOVABLE_KIND)
    .map((entry) => `${entry.targetId}@${entry.x},${entry.y}=${entry.qualifiedItemId};slot=${entry.slot}`)
    .join("|");
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`remove_fence_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== FIXTURE_SCENARIO)
    throw new Error("native_local_remove_fence_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_remove_fence_action_policy_invalid");
  validateNativeLocalFixturePolicy(value, {
    requiredActions: [ACTION],
    experimentalActions: [ACTION],
  });
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runRemoveFenceSmoke(session.client, session.receipts, config);
    if (result.state === "passed") console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
