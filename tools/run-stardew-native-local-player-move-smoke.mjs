import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
if (config.Portfolio?.Enable === true || config.HostAutomation?.Enable === true || config.HostFarmhandProvisioning?.Enable === true || config.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });
try {
  const before = await client.observe();
  if (!before.capabilities.includes("move_to_tile") || before.capabilities.length !== 3) throw new Error("native_local_move_capability_not_isolated");
  const attempts = [];
  let success = null;
  for (const target of adjacentCandidates(before.tile)) {
    const fresh = await client.observe();
    const requestId = `native_local_move_${Date.now()}_${target.x}_${target.y}`;
    const accepted = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action: "move_to_tile", args: target, expectedRevision: fresh.revision, deadlineMs: Date.now() + 15_000 });
    const terminal = await waitForTerminal(accepted.executionId, 20_000);
    const after = await client.observe();
    const attempt = { target, before: summary(fresh), accepted: receiptSummary(accepted), terminal: receiptSummary(terminal), after: summary(after) };
    attempts.push(attempt);
    if (terminal.state === "succeeded" && terminal.reasonCode === "target_reached" && after.tile.x === target.x && after.tile.y === target.y) { success = attempt; break; }
  }
  console.log(JSON.stringify({ state: success ? "passed" : "blocked", topology: "native_local_player_fixture", initial: summary(before), success, attempts }));
  if (!success) process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function adjacentCandidates(tile) {
  if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y) || tile.x < 0 || tile.y < 0) throw new Error("native_local_fixture_invalid_current_tile");
  return [[0, -1], [1, 0], [0, 1], [-1, 0]]
    .map(([dx, dy]) => ({ x: tile.x + dx, y: tile.y + dy }))
    .filter((candidate) => candidate.x >= 0 && candidate.y >= 0);
}
function summary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, capabilities: snapshot.capabilities, activeExecution: snapshot.activeExecution }; }
function receiptSummary(receipt) { return { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence }; }
async function waitForTerminal(executionId, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const receipt = receipts.find((item) => item.executionId === executionId && ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(item.state)); if (receipt) return receipt; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`move_terminal_timeout:${executionId}`); }
