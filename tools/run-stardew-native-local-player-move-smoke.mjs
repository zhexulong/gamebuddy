import {
  assertExactCapabilities,
  assertPostTerminalRevision,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const EXPECTED_CAPABILITIES = ["inspect_self", "cancel_active_execution", "move_to_tile"];

/** Execute the move contract against an already-connected bridge client. */
export async function runMoveSmoke(client, receipts, config) {
  if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const before = await observeFresh(client, { actionable: true });
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);
    const attempts = [];
    let success = null;
    for (const target of adjacentCandidates(before.tile)) {
      // The request is only legal from a newly observed, actionable state.
      const fresh = await observeFresh(client, { actionable: true });
      const requestId = `native_local_move_${Date.now()}_${target.x}_${target.y}`;
      const accepted = await executeFresh(client, {
        requestId,
        idempotencyKey: `${requestId}_idem`,
        action: "move_to_tile",
        args: target,
        snapshot: fresh,
        timeoutMs: 15_000,
      });
      const terminal = await waitForTerminal(receipts, accepted, 20_000);
      const after = await observeFresh(client);
      assertPostTerminalRevision(after, terminal);
      const attempt = {
        target,
        before: summarizeSnapshot(fresh),
        accepted: summarizeReceipt(accepted),
        terminal: summarizeReceipt(terminal),
        after: summarizeSnapshot(after),
      };
      attempts.push(attempt);
      if (
        terminal.state === "succeeded" &&
        terminal.reasonCode === "target_reached" &&
        after.tile.x === target.x &&
        after.tile.y === target.y
      ) {
        success = attempt;
        break;
      }
    }
  return {
    state: success ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    initial: summarizeSnapshot(before),
    success,
    attempts,
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runMoveSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function adjacentCandidates(tile) {
  if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y) || tile.x < 0 || tile.y < 0)
    throw new Error("native_local_fixture_invalid_current_tile");
  return [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ]
    .map(([dx, dy]) => ({ x: tile.x + dx, y: tile.y + dy }))
    .filter((candidate) => candidate.x >= 0 && candidate.y >= 0);
}
