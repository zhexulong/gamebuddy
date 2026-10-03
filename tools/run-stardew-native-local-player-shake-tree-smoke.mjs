import { assertRequiredCapabilities, connectNativeLocalClient, executeFresh, observeFresh, readNativeClientConfig, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

export async function runShakeTreeSmoke(client, receipts, { terminalTimeoutMs = 5_000 } = {}) {
  let snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, ["inspect_self", "shake_tree"]);
  const target = chooseAdjacent(snapshot, "shakeTreeTargets");
  const requestId = `native_local_shake_tree_${Date.now()}`;
  const accepted = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: "shake_tree", args: { x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, timeoutMs: 30_000 });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.executionId !== accepted.executionId || terminal.state !== "succeeded" || terminal.reasonCode !== "tree_shaken") throw new Error(`shake_tree_failed:${terminal.reasonCode}`);
  snapshot = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
  if ((snapshot.shakeTreeTargets ?? []).some(entry => entry.targetId === target.targetId)) throw new Error("shake_tree_target_still_advertised");
  return { state: "passed", action: "shake_tree", target, revision: snapshot.revision, receipt: terminal };
}
function chooseAdjacent(snapshot, field) {
  const target = (snapshot[field] ?? []).find(entry => Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
  if (!target) throw new Error(`${field}_no_adjacent_target`);
  return target;
}
if (import.meta.main) {
  const config = await readNativeClientConfig(); const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runShakeTreeSmoke(session.client, session.receipts); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  catch (error) { console.log(JSON.stringify({ state: "blocked", reasonCode: String(error) })); process.exitCode = 2; }
  finally { session.close(); }
}
