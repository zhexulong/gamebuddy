import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";
import {
  assertExactCapabilities,
  assertPostTerminalRevision,
  createNativeScope,
  executeFresh,
  observeFresh,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const EXPECTED_CAPABILITIES = ["inspect_self", "cancel_active_execution", "move_to_tile"];

/** Execute the move contract against an already-connected bridge client. */
export async function runMoveSmoke(client, config) {
  if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const receipts = [];
  const unsubscribe = client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  try {
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
  } finally {
    unsubscribe();
  }
}

if (import.meta.main) {
  const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
  const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");
  const scope = createNativeScope(config);
  const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
  try {
    const result = await runMoveSmoke(client, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    client.close();
  }
}

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
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
