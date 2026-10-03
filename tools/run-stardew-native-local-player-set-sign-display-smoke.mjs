import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "set_sign_display";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

export async function runSetSignDisplaySmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = (snapshot.signTargets ?? []).find((entry) => entry?.targetId && Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
    if (!target) throw new Error("sign_no_adjacent_target");
    const slot = (snapshot.inventoryItemFacts ?? []).find((entry) => Number.isInteger(entry.slot))?.slot;
    if (!Number.isInteger(slot)) throw new Error("sign_no_display_item_slot");
    const requestId = `native_local_set_sign_display_${Date.now()}`;
    const accepted = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: ACTION, args: { slot, x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, timeoutMs: 30_000 });
    trace.push({ action: ACTION, target: target.targetId, slot, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId) throw new Error("sign_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "sign_display_set") throw new Error(`sign_display_failed:${terminal.reasonCode}`);
    return { state: "passed", topology: "native_local_player_fixture", reasonCode: terminal.reasonCode, target: target.targetId, slot, receipt: summarizeReceipt(terminal), trace };
  } catch (error) {
    return { state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state?.latestReceipt), trace };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runSetSignDisplaySmoke(session.client, session.receipts, config); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  finally { session.close(); }
}
