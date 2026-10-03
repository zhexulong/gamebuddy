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

const ACTION = "toggle_tool_light";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

export async function runToggleToolLightSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const lantern = (snapshot.lanternSlots ?? []).find((entry) => entry?.slot === snapshot.currentToolSlot);
    if (!lantern) throw new Error("lantern_not_currently_equipped");
    const requestId = `native_local_toggle_tool_light_${Date.now()}`;
    const accepted = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: ACTION, args: { slot: lantern.slot, x: snapshot.tile.x, y: snapshot.tile.y }, snapshot, timeoutMs: 30_000 });
    trace.push({ action: ACTION, slot: lantern.slot, wasOn: lantern.isOn, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId) throw new Error("lantern_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "tool_light_toggled") throw new Error(`lantern_toggle_failed:${terminal.reasonCode}`);
    const after = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
    const current = (after.lanternSlots ?? []).find((entry) => entry.slot === lantern.slot);
    const passed = current && current.isOn !== lantern.isOn;
    return { state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? terminal.reasonCode : "lantern_light_postcondition_mismatch", slot: lantern.slot, receipt: summarizeReceipt(terminal), trace };
  } catch (error) {
    return { state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state?.latestReceipt), trace };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runToggleToolLightSmoke(session.client, session.receipts, config); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  finally { session.close(); }
}
