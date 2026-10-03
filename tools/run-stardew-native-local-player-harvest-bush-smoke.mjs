import { assertRequiredCapabilities, connectNativeLocalClient, executeFresh, observeFresh, readNativeClientConfig, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

export async function runHarvestBushSmoke(client, receipts, { terminalTimeoutMs = 5_000 } = {}) {
  let snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, ["inspect_self", "harvest_bush"]);
  const target = chooseAdjacent(snapshot, "bushTargets");
  const requestId = `native_local_harvest_bush_${Date.now()}`;
  const accepted = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: "harvest_bush", args: { x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, timeoutMs: 30_000 });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.executionId !== accepted.executionId || terminal.state !== "succeeded" || terminal.reasonCode !== "bush_harvested") throw new Error(`harvest_bush_failed:${terminal.reasonCode}`);
  snapshot = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
  return { state: "passed", action: "harvest_bush", target, revision: snapshot.revision, receipt: terminal };
}
function chooseAdjacent(snapshot, field) {
  const target = (snapshot[field] ?? []).find(entry => Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
  if (!target) throw new Error(`${field}_no_adjacent_target`);
  return target;
}
if (import.meta.main) {
  const config = await readNativeClientConfig(); const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runHarvestBushSmoke(session.client, session.receipts); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  catch (error) { console.log(JSON.stringify({ state: "blocked", reasonCode: String(error) })); process.exitCode = 2; }
  finally { session.close(); }
}
