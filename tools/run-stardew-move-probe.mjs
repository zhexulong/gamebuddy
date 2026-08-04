import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const terminalStates = new Set(["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"]);
const facts = [];
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") facts.push(fact.payload);
});
const startedAt = Date.now();
try {
  if (!client.state.capabilities.includes("move_to_tile")) throw new Error("move_capability_missing");
  const initial = await client.observe();
  const candidates = process.argv.includes("--target")
    ? [parseTile(option("--target"))]
    : [
        [5, 5], [6, 5], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5], [12, 5],
        [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6],
        [5, 7], [6, 7], [7, 7], [8, 7], [9, 7], [10, 7], [11, 7], [12, 7],
        [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [10, 8], [11, 8], [12, 8],
        [5, 9], [6, 9], [7, 9], [8, 9], [9, 9], [10, 9], [11, 9], [12, 9],
      ].map(([x, y]) => ({ x, y }));
  const attempts = [];
  let success = null;
  for (const target of candidates) {
    const before = await client.observe();
    const requestId = `move_probe_${Date.now()}`;
    const accepted = await client.execute({
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "move_to_tile",
      args: target,
      expectedRevision: before.revision,
      deadlineMs: Date.now() + 45_000,
    });
    const terminal = await waitForTerminal(facts, accepted.executionId, 55_000);
    const after = await client.observe();
    const attempt = {
      target,
      accepted: summarize(accepted),
      terminal: summarize(terminal),
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
    };
    attempts.push(attempt);
    if (terminal.state === "succeeded" && terminal.reasonCode === "target_reached") {
      success = attempt;
      break;
    }
  }
  const passed = success !== null;
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    durationMs: Date.now() - startedAt,
    initial: summarizeSnapshot(initial),
    success,
    attempts,
  }));
  if (!passed) process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function parseTile(value) {
  const match = /^(\d+),(\d+)$/.exec(value);
  if (!match) throw new Error("invalid_target");
  return { x: Number(match[1]), y: Number(match[2]) };
}
function summarize(value) {
  return { executionId: value.executionId, requestId: value.requestId, state: value.state, reasonCode: value.reasonCode, revision: value.revision, evidence: value.evidence };
}
function summarizeSnapshot(value) {
  return { revision: value.revision, location: value.location, tile: value.tile, activeExecution: value.activeExecution == null ? null : { executionId: value.activeExecution.executionId, requestId: value.activeExecution.requestId, state: value.activeExecution.state, reasonCode: value.activeExecution.reasonCode } };
}
async function waitForTerminal(receipts, executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = receipts.find((receipt) => receipt.executionId === executionId && terminalStates.has(receipt.state) && receipt.state !== "accepted");
    if (terminal !== undefined) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`move_terminal_timeout:${executionId}`);
}
