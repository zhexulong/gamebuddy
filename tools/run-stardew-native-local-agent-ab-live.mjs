import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER, } from "../host/dist-test/stardew-game-integration-adapter.js";
import { createStardewIntegrationLaunchHandleFromAuthenticatedBridge, STARDEW_INTEGRATION_LAUNCHER } from "../host/dist-test/stardew-integration-launcher.js";
import { createGameRuntimeBindingFromReceiptBackedLaunch } from "../host/dist-test/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { reserveGameRuntimeMaterialization, withConsumedBindingExecution } from "../host/dist-test/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import { createHostGameRuntimeMaterializer } from "../host/dist-test/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { loadHostDeploymentManifest } from "../host/dist-test/deployment-manifest.js";
import { resolveRuntimePaths } from "../host/dist-test/runtime-identity.js";
import { bindWindowsStaleLockReclaimer } from "../host/dist-test/path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../host/dist-test/windows-stale-lock-reclaimer/index.js";

const configPath = process.env.GAMEBUDDY_STARDew_CONFIG ?? "D:/Steam/steamapps/common/Stardew Valley/Mods/GameBuddy.Stardew/config.json";
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
const scope = Object.freeze({ integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId });
const runContinuityId = `native-agent-${Date.now()}`;
const identity = Object.freeze({ playerId: config.PlayerId, companionId: config.CompanionId, continuityId: runContinuityId, saveId: config.SaveId, worldId: config.WorldId });
const deadline = Date.now() + 600_000;
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken, STARDEW_GAME_INTEGRATION_ADAPTER, undefined, "1.6.15");
const factLog = [];
client.onFact((fact) => { if (fact.type === "execution_receipt" || fact.type === "semantic_event" || fact.type === "error" || fact.type === "lifecycle") { factLog.push({ type: fact.type, reasonCode: fact.payload?.reasonCode, requestId: fact.payload?.requestId, executionId: fact.payload?.executionId }); console.error("BRIDGE_FACT", JSON.stringify(factLog.at(-1))); } });
// Capture the Agent-authored program id from any submit the runtime tools send
// over this connection; the Agent chooses the id autonomously, so a fixed
// programId probe can never observe it.
let agentProgramId = null;
const originalProgramSubmit = client.programSubmit.bind(client);
client.programSubmit = async (program) => {
  if (program?.programId !== undefined) agentProgramId = program.programId;
  const submit = await originalProgramSubmit(program);
  if (submit?.snapshot?.programId !== undefined) agentProgramId = submit.snapshot.programId;
  console.error("AGENT_PROGRAM_SUBMIT", JSON.stringify({ programId: agentProgramId, code: submit?.code }));
  return submit;
};
const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, identity, { module: STARDEW_GAME_INTEGRATION_ADAPTER });
const root = await mkdtemp(join(tmpdir(), "gamebuddy-agent-ab-"));
const runtimeRoot = join(root, "runtime");
await mkdir(join(runtimeRoot, "settings"), { recursive: true });
await writeFile(join(runtimeRoot, "settings", "model-profiles.json"), JSON.stringify({ schemaVersion: 1, chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" }, game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" } }));
const manifestPath = join(root, "manifest.json");
await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot, principal: { continuityId: identity.continuityId, companionId: identity.companionId, playerId: identity.playerId }, bootstrapOperationId: `agent-ab-${Date.now()}`, authorityGeneration: 1 }), "utf8");
const runtimePaths = resolveRuntimePaths(identity, runtimeRoot);
await mkdir(runtimePaths.agentDir, { recursive: true });
if (!process.env.CPA_OAI_API_KEY) throw new Error("CPA_OAI_API_KEY_missing");
await writeFile(join(runtimePaths.agentDir, "auth.json"), JSON.stringify({ "cpa-oai": { type: "api_key", key: process.env.CPA_OAI_API_KEY } }), "utf8");
const binding = await createGameRuntimeBindingFromReceiptBackedLaunch({ manifest: await loadHostDeploymentManifest(manifestPath), launcher: STARDEW_INTEGRATION_LAUNCHER, launch, expectedWorld: Object.freeze({ saveId: config.SaveId, worldId: config.WorldId }) });
let runtime;
try {
  runtime = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => {
    const permit = Object.freeze({ principal: execution.principal, operationId: `op-${Date.now()}`, requestId: `req-${Date.now()}`, kind: "enter", gameSessionId: `game-${Date.now()}`, world: execution.world, bindingDigest: execution.bindingFacts.bindingDigest, owner: execution.bindingFacts.owner, deadlineAtMs: deadline, expected: Object.freeze({ partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }), payloadDigest: "a".repeat(64), fenceToken: `fence-${Date.now()}`, prepared: Object.freeze({ partitionRevision: 2, gameRevision: 0, leaseRevision: 1, fenceEpoch: 2 }) });
    return createHostGameRuntimeMaterializer({ gameOperationalGateNonceSha256: "a".repeat(64) }).materializeEnter(reserveGameRuntimeMaterialization(execution), permit);
  }));
  if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");
  const tools = runtime.connected.host;
  const prompt = process.env.GAMEBUDDY_AGENT_PROMPT ?? "请只回答 OK。";
  const agentTurn = tools.acceptPlayerText(prompt, "zh-CN").then(() => ({ settled: true })).catch((error) => ({ settled: false, error: String(error?.message ?? error) }));
  let status = null;
  let turn = null;
  for (let i = 0; i < Number(process.env.GAMEBUDDY_AGENT_WAIT_SECONDS ?? 600); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if (agentProgramId !== null) status = await client.programStatus({ programId: agentProgramId });
    } catch {}
    if (status?.code === "found" && ["succeeded", "failed", "recovery_required", "cancelled"].includes(status.snapshot?.state)) break;
    if (i % 10 === 0) console.error(JSON.stringify({ seconds: i, programStatus: status, agentProgramId, revision: client.state.snapshot?.revision }));
    const quick = await Promise.race([agentTurn, Promise.resolve(null)]);
    if (quick !== null) { turn = quick; break; }
  }
  if (turn === null) turn = await Promise.race([agentTurn, new Promise((resolve) => setTimeout(() => resolve({ settled: false, error: "agent_turn_timeout" }), 5000))]);
  console.log(JSON.stringify({ state: "completed", programStatus: status, agentTurn: turn, bridgeFacts: factLog, authenticated: client.state.authenticated, revision: client.state.snapshot?.revision }, null, 2));
} finally {
  await runtime?.close().catch(() => {});
  await binding.close().catch(() => {});
  client.close("agent_ab_complete");
}
