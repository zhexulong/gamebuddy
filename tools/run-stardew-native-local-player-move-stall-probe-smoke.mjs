import {
  assertRequiredCapabilities,
  assertPostTerminalRevision,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const REQUIRED_CAPABILITIES = ["inspect_self", "cancel_active_execution", "move_to_tile"];

/**
 * The Pet projection is gated on `pet_animal`, so the pet scenario advertises
 * that capability purely to make the blocker observable. `pet_animal` is never
 * invoked; the assertion is separate from REQUIRED_CAPABILITIES so the npc
 * scenario (which has no Pet projection) does not require it.
 */
const PET_OBSERVABILITY_CAPABILITY = "pet_animal";

/**
 * Read the blocker's published position back out of a snapshot.
 *
 * The Pet projection is gated on the `pet_animal` capability, so the runner
 * asks for that capability purely to make the blocker OBSERVABLE; it never
 * invokes the action. A parked Horse has no equivalent projection, so the npc
 * scenario reports null here and relies on the actor tile plus the retry phase
 * instead.
 */
function readBlockerProjection(snapshot, blockerKind) {
  if (blockerKind !== "pet") return null;
  const list = snapshot?.petTargets;
  if (!Array.isArray(list) || list.length === 0) return null;
  const entry = list.find((candidate) => Number.isInteger(candidate?.x) && Number.isInteger(candidate?.y));
  if (entry === undefined) return null;
  return { x: entry.x, y: entry.y, targetId: entry.targetId ?? null, stationary: entry.stationary ?? null };
}

/**
 * The move-stall probe measures the native answer to a static blocker standing
 * on a move_to_tile route, and then measures whether the ANSWER a competent
 * agent would try next -- re-observe and re-issue the same move -- actually
 * works.
 *
 * The fixture (native_move_stall_probe_pet_v1 / native_move_stall_probe_npc_v1)
 * stands the actor at A, a blocker at A+(0,1), and the probe target at A+(0,2).
 * A* plans straight through the middle tile because pathfinding skips character
 * collision (GameLocation.isCollidingPosition gates the whole character loop on
 * `!pathfinding`), so the route necessarily collides at execution time. That is
 * what makes this a genuine L2 (runtime blocker) rather than an L3 (planning
 * dead end).
 *
 * Two phases, because the interesting question is not "did it work" but "what
 * does the native game do, and what should the Mod do about it":
 *
 *   phase 1 -- one honest move_to_tile, exactly as an action would issue it.
 *   phase 2 -- ONLY if phase 1 failed: wait for the blocker's own walk timer to
 *              elapse, re-observe, and re-issue the same move. That is the
 *              recovery an agent would perform from its own failure receipt
 *              (ADR-006: the Mod does not retry; the agent composes recovery).
 *
 * Reading the outcome (the probe MEASURES; it does not pass or fail the action):
 *   native_self_resolved  -- the native pushing/pass-through resolved the block and
 *                           phase 1 reached the target, so this blocker kind
 *                           produced no L2 at all.
 *   retry_resolved        -- phase 1 failed with `native_path_ended`, but phase 2
 *                           reached it. Direct evidence that re-observe + re-issue
 *                           works, i.e. that the 5.3 increment has a real job.
 *   blocker_survived      -- the block outlived both attempts. Re-issuing the same
 *                           move is NOT the answer and 5.3 must not be built on it.
 *   unexpected_terminal   -- the move ended some other way; the measurement is not
 *                           valid for this probe's question.
 */
export async function runMoveStallProbe(client, receipts, config) {
  if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");

  const scenario = config.NativeLocalPlayerFixture?.FixtureScenario;
  if (scenario !== "native_move_stall_probe_pet_v1" && scenario !== "native_move_stall_probe_npc_v1")
    throw new Error(`native_local_fixture_invalid_scenario:${scenario}`);
  const blockerKind = scenario === "native_move_stall_probe_pet_v1" ? "pet" : "npc";
  const startedAt = Date.now();

  const before = await waitForActionable(client, await observeFresh(client), 15_000);
  assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
  if (blockerKind === "pet") assertRequiredCapabilities(before, [PET_OBSERVABILITY_CAPABILITY]);
  if (!Number.isInteger(before.tile?.x) || !Number.isInteger(before.tile?.y))
    throw new Error("native_local_fixture_invalid_actor_tile");

  // Fixture geometry: actor at A, blocker at A+(0,1), target at A+(0,2).
  const target = { x: before.tile.x, y: before.tile.y + 2 };

  const attempt = async (label) => {
    const snapshot = await waitForActionable(client, await observeFresh(client), 15_000);
    const requestId = `native_local_move_stall_${label}_${Date.now()}`;
    const phaseStartedAt = Date.now();
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "move_to_tile",
      args: target,
      snapshot,
      timeoutMs: 25_000,
    });
    const terminal = await waitForTerminal(receipts, accepted, 30_000);
    const after = await observeFresh(client);
    assertPostTerminalRevision(after, terminal);
    const reached =
      terminal.state === "succeeded" &&
      terminal.reasonCode === "target_reached" &&
      Number.isInteger(after.tile?.x) &&
      Number.isInteger(after.tile?.y) &&
      after.tile.x === target.x &&
      after.tile.y === target.y;
    return {
      label,
      elapsedMs: Date.now() - phaseStartedAt,
      accepted: summarizeReceipt(accepted),
      terminal: summarizeReceipt(terminal),
      reached,
      finalTile: after.tile ?? null,
      blockerAtEnd: readBlockerProjection(after, blockerKind),
    };
  };

  const phase1 = await attempt("probe1");
  let phase2 = null;
  if (!phase1.reached) {
    // The blocker's own recovery timer has to be given a chance: a pushed Pet
    // walks for ~250ms and then continues its behaviour, so re-issuing
    // immediately would just re-collide on the same tile.
    await delay(2_000);
    phase2 = await attempt("probe2");
  }

  const nativeSelfResolved = phase1.reached;
  const retryResolved = phase2?.reached === true;
  const elapsedMs = Date.now() - startedAt;
  // A move that ACTUALLY MOVED (the actor's final tile differs from its start
  // tile) but did not reach the target is measured as a blocker finding whatever
  // terminal it took: if the native controller died with native_path_ended OR
  // the authoritative deadline was consumed while the actor stood on the
  // blocker's tile, both mean "the block outlasted the attempt". Only a failure
  // with the actor still on the start tile is not attributable to the blocker.
  const moved = phase1.finalTile !== null && (phase1.finalTile.x !== before.tile.x || phase1.finalTile.y !== before.tile.y);
  const measurementValid =
    nativeSelfResolved ||
    ((phase1.terminal?.reasonCode === "native_path_ended" || phase1.terminal?.reasonCode === "deadline_expired") && moved);

  const conclusion = nativeSelfResolved
    ? "native_self_resolved"
    : !measurementValid
      ? `unexpected_terminal:${phase1.terminal?.state}/${phase1.terminal?.reasonCode}`
      : retryResolved
        ? "retry_resolved"
        : "blocker_survived";

  return {
    // `measured` means the probe answered its question; it is NOT a claim that
    // the action is healthy. `retry_resolved` and `blocker_survived` are both
    // successfully measured findings about the game.
    state: measurementValid ? "measured" : "invalid",
    conclusion,
    topology: "native_local_player_fixture",
    scenario,
    blockerKind,
    geometry: { actor: before.tile, blocker: { x: before.tile.x, y: before.tile.y + 1 }, target },
    nativeSelfResolved,
    retryResolved,
    moved,
    blockerStillOnRoute: phase2 === null ? null : phase2.blockerAtEnd !== null && phase2.blockerAtEnd.y === before.tile.y + 1,
    elapsedMs,
    phase1,
    phase2,
    before: summarizeSnapshot(before),
    trace: receipts.map((r) => summarizeReceipt(r)),
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  // The published action's wire shape exists in production, but this local
  // environment has no selected immutable production generation (building one
  // needs the release-CI bundled runtime), so the probe loads the compiled test
  // artifact. A loader only: it grants no capability and changes no lifecycle.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runMoveStallProbe(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    // Exit nonzero only when the probe could not measure its question. A
    // measured finding (including "the blocker survived") is a valid result and
    // must not be reported as a gate failure.
    if (result.state !== "measured") process.exitCode = 2;
  } finally {
    session.close();
  }
}