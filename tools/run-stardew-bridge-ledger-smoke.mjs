import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
if (typeof config.SaveId !== "string" || typeof config.WorldId !== "string" || typeof config.PlayerId !== "string" || typeof config.CompanionId !== "string" || typeof config.PipeName !== "string" || typeof config.BridgeToken !== "string") throw new Error("invalid_client_config");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const failures = [];
try {
  const initial = await client.observe();
  if (!client.state.capabilities.includes("equip_tool") || !initial.capabilities.includes("equip_tool")) throw new Error("equip_tool_capability_missing");

  try {
    await client.execute({ requestId: "ledger_stale_01", idempotencyKey: "ledger_stale_idem_01", action: "equip_tool", args: { slot: 0 }, expectedRevision: Math.max(0, initial.revision - 1), deadlineMs: Date.now() + 30_000 });
    failures.push("stale_request_accepted");
  } catch (error) {
    if (!String(error).includes("bridge_rejected:stale_snapshot")) failures.push(`unexpected_stale_error:${String(error)}`);
  }

  const beforeValid = await client.observe();
  const first = await client.execute({ requestId: "ledger_conflict_01", idempotencyKey: "ledger_conflict_idem_01", action: "equip_tool", args: { slot: 0 }, expectedRevision: beforeValid.revision, deadlineMs: Date.now() + 30_000 });
  if (first.state !== "succeeded" || first.reasonCode !== "tool_selected") failures.push("first_idempotent_request_not_succeeded");

  const beforeConflict = await client.observe();
  try {
    await client.execute({ requestId: "ledger_conflict_02", idempotencyKey: "ledger_conflict_idem_01", action: "equip_tool", args: { slot: 3 }, expectedRevision: beforeConflict.revision, deadlineMs: Date.now() + 30_000 });
    failures.push("idempotency_conflict_accepted");
  } catch (error) {
    if (!String(error).includes("bridge_rejected:idempotency_key_conflict")) failures.push(`unexpected_conflict_error:${String(error)}`);
  }

  const beforeRestore = await client.observe();
  const restored = await client.execute({ requestId: "ledger_restore_01", idempotencyKey: "ledger_restore_idem_01", action: "equip_tool", args: { slot: 3 }, expectedRevision: beforeRestore.revision, deadlineMs: Date.now() + 30_000 });
  if (restored.state !== "succeeded" || restored.reasonCode !== "tool_selected") failures.push("restore_not_succeeded");

  console.log(JSON.stringify({
    state: failures.length === 0 ? "passed" : "failed",
    initialRevision: initial.revision,
    firstReceipt: { state: first.state, reasonCode: first.reasonCode, evidence: first.evidence },
    restoredReceipt: { state: restored.state, reasonCode: restored.reasonCode, evidence: restored.evidence },
    failures,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}
