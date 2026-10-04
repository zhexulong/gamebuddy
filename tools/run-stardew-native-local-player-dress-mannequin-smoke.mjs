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

const ACTION = "dress_mannequin";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

export async function runDressMannequinSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    let snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseAdjacent(snapshot.mannequinTargets, snapshot, "mannequin");
    const slot = chooseHeldClothingSlot(snapshot);
    const requestId = `native_local_dress_mannequin_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId, idempotencyKey: `${requestId}_idem`, action: ACTION,
      args: { slot, x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, slot, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    assertTerminal(terminal, accepted, requestId, "mannequin_dressed");
    snapshot = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
    const evidenceDetail = typeof terminal.evidence?.detail === "string" ? terminal.evidence.detail : "";
    const stored = /stored=true/.test(evidenceDetail);
    const passed = stored;
    return { state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "mannequin_dressed" : "mannequin_target_postcondition_mismatch", target: target.targetId, slot, receipt: summarizeReceipt(terminal), trace };
  } catch (error) {
    return { state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state?.latestReceipt), trace };
  }
}

function chooseAdjacent(rows, snapshot, name) {
  const target = (rows ?? []).find((entry) => entry?.targetId && Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
  if (!target) throw new Error(`${name}_no_adjacent_target`);
  return target;
}
function chooseHeldClothingSlot(snapshot) {
  const slots = snapshot.inventoryItemFacts ?? [];
  const target = slots.find((entry) => Number.isInteger(entry.slot) && (entry.qualifiedItemId.startsWith("(H)") || entry.qualifiedItemId.startsWith("(Clothing)") || entry.qualifiedItemId.startsWith("(B)")));
  if (!target) throw new Error("mannequin_no_clothing_slot");
  return target.slot;
}
function assertTerminal(terminal, accepted, requestId, reason) {
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId) throw new Error("mannequin_terminal_identity_mismatch");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== reason) throw new Error(`mannequin_failed:${terminal.reasonCode}`);
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runDressMannequinSmoke(session.client, session.receipts, config); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  finally { session.close(); }
}
