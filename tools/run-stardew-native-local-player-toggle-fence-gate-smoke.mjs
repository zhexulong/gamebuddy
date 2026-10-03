import { assertRequiredCapabilities, connectNativeLocalClient, executeFresh, observeFresh, readNativeClientConfig, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

export async function runToggleFenceGateSmoke(client, receipts, { terminalTimeoutMs = 5_000 } = {}) {
  let snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, ["inspect_self", "toggle_fence_gate"]);
  const target = chooseAdjacent(snapshot, "fenceGateTargets");
  const requestId = `native_local_toggle_fence_gate_${Date.now()}`;
  const accepted = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: "toggle_fence_gate", args: { x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, timeoutMs: 30_000 });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.executionId !== accepted.executionId || terminal.state !== "succeeded" || terminal.reasonCode !== "fence_gate_toggled") throw new Error(`toggle_fence_gate_failed:${terminal.reasonCode}`);
  snapshot = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
  const after = (snapshot.fenceGateTargets ?? []).find(entry => entry.x === target.x && entry.y === target.y);
  if (!after || after.isOpen === target.isOpen) throw new Error("fence_gate_state_did_not_toggle");
  return { state: "passed", action: "toggle_fence_gate", target, isOpenAfter: after.isOpen, revision: snapshot.revision, receipt: terminal };
}
function chooseAdjacent(snapshot, field) {
  const target = (snapshot[field] ?? []).find(entry => Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
  if (!target) throw new Error(`${field}_no_adjacent_target`);
  return target;
}
if (import.meta.main) {
  const config = await readNativeClientConfig(); const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runToggleFenceGateSmoke(session.client, session.receipts); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  catch (error) { console.log(JSON.stringify({ state: "blocked", reasonCode: String(error) })); process.exitCode = 2; }
  finally { session.close(); }
}
