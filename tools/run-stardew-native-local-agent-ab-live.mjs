import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";
import { LocalVoiceGatewayClient } from "../host/dist-test/voice-gateway-client.js";
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
// Ladder selector: "0" = A→B (inspect→load, Keg inside FarmHouse), "1" =
// walk→look→do (navigate out of FarmHouse to the door-side Keg, then inspect
// and load), "2" = ladder 1 + live voice: when the Mod returns the terminal
// machine_coffee_loaded receipt, the Host streams a companion voice line
// through the real Voice Gateway (MiMo TTS) and waits for its terminal
// playback observation. The runner is a single evolving live carrier; later
// ladders add their own acceptance on top instead of new runners.
const LADDER = process.env.GAMEBUDDY_AGENT_LADDER ?? "1";
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
const scope = Object.freeze({ integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId });
const runContinuityId = `native-agent-${Date.now()}`;
const identity = Object.freeze({ playerId: config.PlayerId, companionId: config.CompanionId, continuityId: runContinuityId, saveId: config.SaveId, worldId: config.WorldId });
const deadline = Date.now() + 600_000;
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken, STARDEW_GAME_INTEGRATION_ADAPTER, undefined, "1.6.15");
const factLog = [];
// Ladder 2: when the Mod returns the terminal machine_coffee_loaded receipt,
// stream a companion voice line through the real Voice Gateway (MiMo TTS)
// and wait for its terminal playback observation. Voice stays a one-shot
// ladder-2 enhancement: it never changes game actions or receipts.
let voice = null;
let voiceChild = null;
let voiceObservation = null;
let voiceStarted = false;
const voiceObservationPromise = new Promise((resolvePromise) => {
  voice = resolvePromise;
});
client.onFact((fact) => {
  if (fact.type === "execution_receipt" || fact.type === "semantic_event" || fact.type === "error" || fact.type === "lifecycle") {
    factLog.push({ type: fact.type, reasonCode: fact.payload?.reasonCode, requestId: fact.payload?.requestId, executionId: fact.payload?.executionId });
    console.error("BRIDGE_FACT", JSON.stringify(factLog.at(-1)));
  }
  if (LADDER === "2" && fact.type === "execution_receipt" && fact.payload?.reasonCode === "machine_coffee_loaded" && !voiceStarted) {
    voiceStarted = true;
    void (async () => {
      try {
        const { promiseVoiceObservation } = await startLadder2Voice();
        voiceObservation = await promiseVoiceObservation;
        voice?.();
      } catch (error) {
        console.error("VOICE_ERROR", String(error instanceof Error ? error.message : error));
        voiceObservation = { terminalStatus: "failed_before_side_effect", error: String(error instanceof Error ? error.message : error) };
        voice?.();
      }
    })();
  }
});

/**
 * ladder 2: start the real Voice Gateway child on a fresh loopback port/token,
 * connect the Host v2 client, stream one companion line for the completed
 * coffee load, and resolve with the terminal playback observation. Env: the
 * runner reads MIMO_API_KEY from .env.local like the existing voice gates;
 * GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION=desktop-consent-v1 is the operator
 * consent contract the gateway checks before cloud TTS.
 */
function voiceGatewayCandidates() {
  const explicit = Number(process.env.GAMEBUDDY_VOICE_PORT ?? 0);
  return explicit > 0
    ? [explicit]
    : [49_731, 49_732, 49_733, 49_734, 49_735];
}
/** Probe one loopback port by opening and closing a listener; rejects if used. */
function tryBindProbe(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    void import("node:net").then((net) => {
      const server = net.createServer();
      server.once("error", rejectPromise);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolvePromise());
      });
    }, rejectPromise);
  });
}
/**
 * Spawn the Voice Gateway child with the exact minimal env contract, collect
 * its stdout/stderr for the "listening on" readiness signal, and return the
 * child handle.
 */
function startVoiceGatewayChild(node, gatewayPath, port, token, mimoKey) {
  const child = spawn(node, ["--use-env-proxy", gatewayPath], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MIMO_API_KEY: mimoKey,
      GAMEBUDDY_VOICE_PORT: String(port),
      GAMEBUDDY_VOICE_TOKEN: token,
      GAMEBUDDY_WINDOWS_OUTPUT_DEVICE: process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE ?? "default",
      GAMEBUDDY_MIMO_VOICE: process.env.GAMEBUDDY_MIMO_VOICE ?? "冰糖",
      GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION: "desktop-consent-v1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const startedOk = new Promise((resolvePromise) => {
    const deadline = Date.now() + 20_000;
    const poll = () => {
      if (stdout.includes("listening on")) return resolvePromise(true);
      if (stderr.length > 0) return resolvePromise(true);
      if (Date.now() > deadline) return resolvePromise(true);
      setTimeout(poll, 50);
    };
    poll();
  });
  return Object.freeze({ child, startedOk, readStderr: () => stderr });
}

async function startLadder2Voice() {
  const node = process.execPath;
  const gatewayPath = new URL("../voice-gateway/dist/main.js", import.meta.url).pathname.replace(/^\//, process.platform === "win32" ? "" : "/");
  const token = process.env.GAMEBUDDY_VOICE_TOKEN ?? randomToken();
  let mimoKey = process.env.MIMO_API_KEY;
  const envPath = new URL("../.env.local", import.meta.url);
  try {
    const localEnv = await (await import("node:fs/promises")).readFile(envPath, "utf8");
    for (const line of localEnv.split(/\r?\n/)) {
      const match = /^MIMO_API_KEY=(.+)$/.exec(line.trim());
      if (match) mimoKey = match[1];
    }
  } catch {}
  if (typeof mimoKey !== "string" || mimoKey.length < 16)
    throw new Error("MIMO_API_KEY_required_for_ladder2_voice");

  // Voice Gateway listens on a documented fixed port by default; an explicit
  // env overrides it. Candidates avoid Windows reserved exclusion ranges and
  // are probed until one is free.
  let started = null;
  let lastError = null;
  for (const port of voiceGatewayCandidates()) {
    try {
      await tryBindProbe(port);
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      started = startVoiceGatewayChild(node, gatewayPath, port, token, mimoKey);
      voiceChild = started.child;
      const ok = await started.startedOk;
      if (!ok) throw new Error("voice_gateway_start_timeout");
      const stderrText = started.readStderr();
      if (stderrText.length > 0) throw new Error(`voice_gateway_start_failed: ${stderrText.slice(0, 300)}`);
      const voiceClient = await LocalVoiceGatewayClient.connect({ port, token });
      // connect() only authenticates; capabilities are populated by an explicit
      // health revalidation (the same boundary Chat mounting uses). Without it
      // streamSpeechChunk fails with voice_gateway_unavailable.
      const health = await voiceClient.health("companion.default");
      if (!health.ready) {
        voiceClient.close();
        throw new Error("voice_gateway_not_ready");
      }
      const waitReady = new Promise((resolvePromise) => {
        const pollReady = () => {
          if (voiceClient.capabilities?.ready === true) return resolvePromise(true);
          if (!voiceClient.connected) return resolvePromise(false);
          setTimeout(pollReady, 100);
        };
        pollReady();
      });
      if (!(await waitReady)) {
        voiceClient.close();
        throw new Error("voice_gateway_not_ready");
      }
      const termination = new Promise((resolvePromise) => {
        voiceClient.onPlaybackObservation((observation) => {
          if (observation?.type === "playback_observation" && observation?.terminalStatus !== undefined)
            resolvePromise(observation);
        });
      });
      const sessionId = `ladder2_${Date.now()}_session`;
      const speechJobId = `ladder2_${Date.now()}_${randomToken(12)}`;
      const speaker = "咖啡豆已经放进桶里啦，大概两小时后酿好！";
      await voiceClient.streamSpeechChunk(sessionId, speechJobId, 0, speaker, true, Date.now() + 60_000, "companion.default");
      const observation = await Promise.race([termination, new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 45_000))]);
      voiceClient.close();
      if (observation === null) throw new Error("voice_playback_observation_timeout");
      return { promiseVoiceObservation: Promise.resolve(observation) };
    } catch (error) {
      lastError = error;
      if (voiceChild !== null) { voiceChild.kill("SIGTERM"); voiceChild = null; }
      continue;
    }
  }
  throw lastError ?? new Error("voice_gateway_start_failed");
}
function randomToken(len = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
// Trace every ordinary-action execution request the Agent sends so a
// rejected coordinate is attributable to the actual submitted args.
const originalExecute = client.execute.bind(client);
client.execute = async (request) => {
  const receipt = await originalExecute(request);
  console.error("AGENT_EXECUTE", JSON.stringify({ action: request?.action, args: request?.args, state: receipt?.state, reasonCode: receipt?.reasonCode }));
  return receipt;
};
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
  const prompt = process.env.GAMEBUDDY_AGENT_PROMPT ?? (LADDER === "3"
    ? "今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她说需要一颗新鲜花椰菜做菜，请求你给她带一颗。你刚从农舍醒来：背包里有锄头、装满了水的浇水壶和 2 颗花椰菜种子，屋外的农田还是春天没有耕过的土地。请自主完成这件农场工作：仔细观察你拥有的资源和环境，决定需要哪些步骤让花椰菜真正种下去并浇上水，然后逐步执行（你可以在 observe 返回的真实 soilTiles/seedTargets/cropTargets 中选择合适的目标）。不要只回答文字，要用游戏工具真实完成。完成后用一句话总结你为乔迪做了哪些准备。"
    : LADDER === "1" || LADDER === "2"
    ? "你现在是星露谷里的 AI 伴侣，站在农舍（FarmHouse）里。任务：屋外的公交站（Bus Stop）门口有一台空的木桶机器（Keg），你的背包里有 5 颗咖啡豆。请严格按以下顺序完成：(1) 先用 find_destination 查询目的地（例如 query=\"bus\"），拿到它的 canonical label 或 dr1_ ref，然后调用 navigate_to_destination 导航到公交站；(2) 导航完成（receipt 成功）后，**必须立即调用 observe**，从最新返回结果的 machineTargets 数组中精确复制该 Keg 的 x、y、expectedTargetId（以及 loadInputSlot）；**绝不允许猜测或从旧位置复制坐标**；(3) 用这些精确坐标调用 machine_inspect 检查机器，确认 receipt 为 machine_inspected；(4) 再用同一 machineTargets 条目的 loadInputSlot/expectedQualifiedItemId/(O)433 和精确 x/y/expectedTargetId 调用 machine_load 把咖啡豆装进木桶。每一步都等 receipt 成功再继续，不要只回答文字。完成后用一句话总结结果。"
    : "你现在是星露谷里的 AI 伴侣。任务：你所在农场屋（FarmHouse）里有一台空的木桶机器（Keg）和 5 颗咖啡豆（Coffee Beans）。请完成两步操作：(1) 先检查（inspect）这台机器，确认它的位置与目标 ID；(2) 然后把咖啡豆装进木桶（load）开始酿造。你必须使用游戏工具（先观察 observe，再调用机器检查与装载工具），根据工具返回的真实结果执行，不要只回答文字。完成后用一句话总结结果。");
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
  // Ladder 2 additionally waits for the voice gateway's terminal playback
  // observation for the companion line streamed on machine_coffee_loaded.
  // The gateway child needs up to ~20s to boot and MiMo probe-ready before the
  // job can stream, so ladder 2 budgets 90s overall; without a terminal
  // completed observation the ladder stays blocked.
  let voiceResult = null;
  if (LADDER === "2") {
    if (voiceStarted && voiceObservation === null) {
      await Promise.race([voiceObservationPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 90_000))]);
    }
    if (voiceObservation !== null && voiceObservation.terminalStatus === "completed")
      voiceResult = Object.freeze({ state: "completed", terminalStatus: voiceObservation.terminalStatus });
    else
      voiceResult = Object.freeze({ state: "blocked", detail: voiceObservation ?? "voice_not_streamed" });
  }
  // Ladder acceptance: the carrier verifies the walk→look→do receipts actually
  // landed over the live bridge, not merely that a program reached a terminal.
  // ladder 0 accepts inspect→load; ladder 1 requires a real navigation receipt
  // first (the door-side Keg makes targetId discoverable only after the walk).
  // The Agent may satisfy look→do either through one submitted Body Program or
  // through ordinary actions it chose autonomously; the receipts are the
  // acceptance evidence either way.
  const receipts = factLog.filter((fact) => fact.type === "execution_receipt");
  const walkReceipt = receipts.find((receipt) => receipt.reasonCode === "navigation_completed");
  const inspectReceipt = receipts.find((receipt) => receipt.reasonCode === "machine_inspected");
  const loadReceipt = receipts.find((receipt) => receipt.reasonCode === "machine_coffee_loaded");
  // Ladder 3 (Jodi's Request): the Agent planned the farming chain itself, so
  // accept the three real farming receipts in any order — no fixed DAG.
  const tillReceipt = receipts.find((receipt) => receipt.reasonCode === "soil_tilled");
  const plantReceipt = receipts.find((receipt) => receipt.reasonCode === "seed_planted");
  const waterReceipt = receipts.find((receipt) => receipt.reasonCode === "crop_watered");
  const programSucceeded = status?.snapshot?.state === "succeeded";
  const ladderOnePassed = LADDER === "1" ? walkReceipt !== undefined && inspectReceipt !== undefined && loadReceipt !== undefined : true;
  const ladderZeroPassed = LADDER === "0" ? inspectReceipt !== undefined && loadReceipt !== undefined && programSucceeded : true;
  const ladderTwoPassed = LADDER === "2" ? walkReceipt !== undefined && inspectReceipt !== undefined && loadReceipt !== undefined && voiceResult?.state === "completed" : true;
  const ladderThreePassed = LADDER === "3" ? tillReceipt !== undefined && plantReceipt !== undefined && waterReceipt !== undefined : true;
  console.log(JSON.stringify({
    state: ladderOnePassed && ladderZeroPassed && ladderTwoPassed && ladderThreePassed ? "passed" : "blocked",
    ladder: LADDER,
    programStatus: status,
    walkReceipt: walkReceipt ?? null,
    inspectReceipt: inspectReceipt ?? null,
    loadReceipt: loadReceipt ?? null,
    tillReceipt: tillReceipt ?? null,
    plantReceipt: plantReceipt ?? null,
    waterReceipt: waterReceipt ?? null,
    voiceResult,
    agentTurn: turn,
    bridgeFacts: factLog,
    authenticated: client.state.authenticated,
    revision: client.state.snapshot?.revision,
  }, null, 2));
} finally {
  if (voiceChild !== null) { voiceChild.kill("SIGTERM"); await Promise.race([once(voiceChild, "close"), new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))]); if (!voiceChild.killed) voiceChild.kill("SIGKILL"); }
  await runtime?.close().catch(() => {});
  await binding.close().catch(() => {});
  client.close("agent_ab_complete");
}
