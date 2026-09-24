import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";
import { dehydrateCompanionSpeech } from "../host/dist-test/companion-speech-dehydration.js";
import { LocalVoiceGatewayClient } from "../host/dist-test/voice-gateway-client.js";
import {
  launchVoiceGatewayChild,
  pickVoiceGatewayPort,
  resolveVoiceConfiguration,
} from "./lib/voice-gateway-launch.mjs";
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
// Single language configuration point: this env mirrors the frontend-set
// language preference (Tavern settings/language). Everything that needs a
// locale — Agent session language, materializer companionLocale, fixture
// ModConfig.PresentationLocale, and the live prompt — derives from it.
const COMPANION_LOCALE = process.env.GAMEBUDDY_COMPANION_LOCALE === "en-US" ? "en-US" : "zh-CN";
// The runtime root is a product configuration value, not a script invention:
// the Game materializer assembles the companion persona and world book from the
// same identity-profile/worldbook files the Chat surface consumes under this
// root. GAMEBUDDY_RUNTIME_ROOT therefore points at the product data root; only
// when an operator explicitly opts into a disposable root does the runner
// create a temporary one (which then legitimately has no assembled persona).
const configuredRuntimeRoot = process.env.GAMEBUDDY_RUNTIME_ROOT;
// Ladder selector: "0" = A→B (inspect→load, Keg inside FarmHouse), "1" =
// walk→look→do (navigate out of FarmHouse to the door-side Keg, then inspect
// and load), "2" = ladder 1 + live voice: when the Mod returns the terminal
// machine_coffee_loaded receipt, the Host streams a companion voice line
// through the real Voice Gateway (MiMo TTS) and waits for its terminal
// playback observation. The runner is a single evolving live carrier; later
// ladders add their own acceptance on top instead of new runners.
const LADDER = process.env.GAMEBUDDY_AGENT_LADDER ?? "1";
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
const config = JSON.parse(await readFile(configPath, "utf8"));
const scope = Object.freeze({ integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId });
// The continuity identity is product configuration too: GAMEBUDDY_COMPANION_CONTINUITY_ID
// joins the companion's existing (Chat-provisioned) continuity so the same
// identity-profile/worldbook are assembled; absent falls back to a run-scoped id
// for disposable-root runs that intentionally own no persisted persona.
const runContinuityId = process.env.GAMEBUDDY_COMPANION_CONTINUITY_ID ?? `native-agent-${Date.now()}`;
const identity = Object.freeze({ playerId: config.PlayerId, companionId: config.CompanionId, continuityId: runContinuityId, saveId: config.SaveId, worldId: config.WorldId });
const deadline = Date.now() + 600_000;
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken, STARDEW_GAME_INTEGRATION_ADAPTER, undefined, "1.6.15");
const factLog = [];
// Ladder 2: when the Mod returns the terminal machine_coffee_loaded receipt,
// stream a companion voice line through the real Voice Gateway (MiMo TTS)
// and wait for its terminal playback observation. Voice stays a one-shot
// ladder-2 enhancement: it never changes game actions or receipts.
// Ladder 3 reuses the same voice lane: the Agent's final companion summary
// (presented to the game via the Mod presentation bridge) is streamed to TTS
// so the completion report is actually spoken. Voice is fire-and-forget in
// both cases — a voice failure never fails the game presentation or action.
let voice = null;
let voiceChild = null;
let voiceObservation = null;
let voiceStarted = false;
let presentedSummary = null;
/** Exact configuration answer for voice in this run; `enabled:false` carries the reason. */
let voiceConfiguration = null;
const voiceObservationPromise = new Promise((resolvePromise) => {
  voice = resolvePromise;
});
// Ladder-3 presentation hook: called by the Host presentation port after a
// companion text successfully landed in the game; forwards the exact text to
// the voice lane. No game/presentation authority is touched here.
const onCompanionTextPresented = (text, locale) => {
  if (LADDER !== "3" || voiceStarted || typeof text !== "string" || text.trim().length === 0) return;
  // Dee-hydate model scaffolding before TTS: the chat box and the voice line
  // must both speak the same clean dialogue — never read out `**` / `---` / emoji.
  const speakable = dehydrateCompanionSpeech(text);
  if (speakable.length === 0) return;
  presentedSummary = speakable;
  console.error("AGENT_SUMMARY", JSON.stringify({ text: presentedSummary, locale }));
  void (async () => {
    try {
      // Voice enablement is configuration. When the stored preference (or the
      // product-injected gateway) says voice is off, the run records that answer
      // and leaves the presentation/action evidence untouched — a disabled TTS
      // configuration is not a gameplay failure.
      const configuration = voiceConfiguration ?? await resolveVoiceConfiguration({ runtimeRoot, locale: COMPANION_LOCALE });
      voiceConfiguration = configuration;
      if (!configuration.enabled) {
        console.error("VOICE_DISABLED", JSON.stringify({ reason: configuration.disabledReason }));
        voice?.();
        return;
      }
      voiceStarted = true;
      // Voice lane receives the dehydrated dialogue verbatim: MiMo performs
      // bracketed audio tags natively, emoji do not stall synthesis (probe:
      // short emoji text completes), and the frozen Voice contract is zero
      // intermediate processing (voice-gateway-streaming-submodule §2.5).
      const { promiseVoiceObservation } = await startLadder2Voice(speakable);
      voiceObservation = await promiseVoiceObservation;
      voice?.();
    } catch (error) {
      console.error("VOICE_ERROR", String(error instanceof Error ? error.message : error));
      voiceObservation = { terminalStatus: "failed_before_side_effect", error: String(error instanceof Error ? error.message : error) };
      voice?.();
    }
  })();
};
client.onFact((fact) => {
  if (fact.type === "execution_receipt" || fact.type === "semantic_event" || fact.type === "error" || fact.type === "lifecycle") {
    factLog.push({ type: fact.type, reasonCode: fact.payload?.reasonCode, requestId: fact.payload?.requestId, executionId: fact.payload?.executionId });
    console.error("BRIDGE_FACT", JSON.stringify(factLog.at(-1)));
  }
  if (LADDER === "2" && fact.type === "execution_receipt" && fact.payload?.reasonCode === "machine_coffee_loaded" && !voiceStarted) {
    void (async () => {
      try {
        const configuration = voiceConfiguration ?? await resolveVoiceConfiguration({ runtimeRoot, locale: COMPANION_LOCALE });
        voiceConfiguration = configuration;
        if (!configuration.enabled) {
          console.error("VOICE_DISABLED", JSON.stringify({ reason: configuration.disabledReason }));
          voice?.();
          return;
        }
        voiceStarted = true;
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
 * ladder 2/3: stream one companion line through the configured Voice Gateway
 * and resolve with its terminal playback observation. Voice enablement is
 * configuration, not script content: the shared launcher attaches to a
 * product-injected gateway or reads the stored player voice preference and
 * reports the exact disabled reason. When voice is intentionally off the ladder
 * still records that fact; it never invents a gateway configuration.
 */
async function startLadder2Voice(speakerText = "咖啡豆已经放进桶里啦，大概两小时后酿好！") {
  // Voice is configuration-enabled, never hand-written here: the shared
  // launcher reads the product-injected gateway (GAMEBUDDY_VOICE_PORT/TOKEN) or
  // the stored player preference, and reports the exact disabled reason when
  // voice is genuinely off. The runner only streams the line it was asked to.
  const configuration = voiceConfiguration ?? await resolveVoiceConfiguration({ runtimeRoot, locale: COMPANION_LOCALE });
  voiceConfiguration = configuration;
  if (!configuration.enabled) throw new Error(`voice_disabled:${configuration.disabledReason}`);
  const token = configuration.mode === "attached" ? configuration.token : randomToken();
  const port = configuration.mode === "attached" ? configuration.port : await pickVoiceGatewayPort();
  const started = configuration.mode === "attached"
    ? null
    : await launchVoiceGatewayChild(configuration, { port, token });
  if (started !== null) voiceChild = started.child;
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
  // Real streaming: split the full line at sentence boundaries and push each
  // chunk with an increasing chunkIndex; the final chunk marks isFinal.
  // The gateway synthesizes incrementally (DELTA_TEXT_LIMIT=4000/chunk) so
  // long summaries no longer hit a single-chunk synthesis stall.
  const chunks = splitSpeakableSentenceChunks(speakerText);
  const deadlineMs = Date.now() + 180_000;
  for (let index = 0; index < chunks.length; index += 1) {
    await voiceClient.streamSpeechChunk(sessionId, speechJobId, index, chunks[index], index === chunks.length - 1, deadlineMs, "companion.default");
  }
  const observation = await Promise.race([termination, new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 170_000))]);
  voiceClient.close();
  if (observation === null) throw new Error("voice_playback_observation_timeout");
  return { promiseVoiceObservation: Promise.resolve(observation) };
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
// The runtime root comes from product configuration when supplied; a disposable
// temporary root is the explicit operator opt-in (GAMEBUDDY_DISPOSABLE_RUNTIME_ROOT=1).
const usesDisposableRoot = configuredRuntimeRoot === undefined || configuredRuntimeRoot.length === 0;
const root = usesDisposableRoot ? await mkdtemp(join(tmpdir(), "gamebuddy-agent-ab-")) : configuredRuntimeRoot;
const runtimeRoot = usesDisposableRoot ? join(root, "runtime") : root;
await mkdir(join(runtimeRoot, "settings"), { recursive: true });
// The model profile is configuration, not a script constant: an existing
// product profile is reused as-is; only a disposable root gets the local
// development profile so the Agent turn can run at all.
if (usesDisposableRoot)
  await writeFile(join(runtimeRoot, "settings", "model-profiles.json"), JSON.stringify({ schemaVersion: 1, chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" }, game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" } }));
const manifestPath = join(root, "manifest.json");
// The Game principal is product configuration: with a configured runtime root the
// runner joins the companion's existing continuity (so the persona/world book
// assembled under that identity are the ones under test). Only a disposable root
// falls back to a run-scoped continuity id.
await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot, principal: { continuityId: identity.continuityId, companionId: identity.companionId, playerId: identity.playerId }, bootstrapOperationId: `agent-ab-${Date.now()}`, authorityGeneration: 1 }), "utf8");
const runtimePaths = resolveRuntimePaths(identity, runtimeRoot);
await mkdir(runtimePaths.agentDir, { recursive: true });
if (!process.env.CPA_OAI_API_KEY) throw new Error("CPA_OAI_API_KEY_missing");
await writeFile(join(runtimePaths.agentDir, "auth.json"), JSON.stringify({ "cpa-oai": { type: "api_key", key: process.env.CPA_OAI_API_KEY } }), "utf8");
// One Game activation id for this run: it is the surface session id the runtime
// uses for its durable run manifest, so the context-evidence read below resolves
// the same file the runtime wrote.
const gameSessionId = `game-${Date.now()}`;
const gameSessionPaths = resolveRuntimePaths(identity, runtimeRoot, gameSessionId);
const binding = await createGameRuntimeBindingFromReceiptBackedLaunch({ manifest: await loadHostDeploymentManifest(manifestPath), launcher: STARDEW_INTEGRATION_LAUNCHER, launch, expectedWorld: Object.freeze({ saveId: config.SaveId, worldId: config.WorldId }) });
let runtime;
try {
  runtime = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => {
    const permit = Object.freeze({ principal: execution.principal, operationId: `op-${Date.now()}`, requestId: `req-${Date.now()}`, kind: "enter", gameSessionId, world: execution.world, bindingDigest: execution.bindingFacts.bindingDigest, owner: execution.bindingFacts.owner, deadlineAtMs: deadline, expected: Object.freeze({ partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }), payloadDigest: "a".repeat(64), fenceToken: `fence-${Date.now()}`, prepared: Object.freeze({ partitionRevision: 2, gameRevision: 0, leaseRevision: 1, fenceEpoch: 2 }) });
    return createHostGameRuntimeMaterializer({
      gameOperationalGateNonceSha256: "a".repeat(64),
      companionLocale: COMPANION_LOCALE,
      ...(LADDER === "3" ? { onCompanionTextPresented } : {}),
    }).materializeEnter(reserveGameRuntimeMaterialization(execution), permit);
  }));
  if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");
  const tools = runtime.connected.host;
  const prompt = process.env.GAMEBUDDY_AGENT_PROMPT ?? (COMPANION_LOCALE === "zh-CN"
    ? (LADDER === "3"
      ? "今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她说需要一颗新鲜花椰菜做菜，请求你给她带一颗。你刚从农舍醒来：背包里有锄头、装满了水的浇水壶和 2 颗花椰菜种子，屋外的农田还是春天没有耕过的土地。请自主完成这件农场工作：仔细观察你拥有的资源和环境，决定需要哪些步骤让花椰菜真正种下去并浇上水，然后逐步执行（你可以在 observe 返回的真实 soilTiles/seedTargets/cropTargets 中选择合适的目标）。不要只回答文字，要用游戏工具真实完成（台词之外可以用括号写角色的情绪或内心，例如（轻声）（苦笑）（有点犹豫）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。完成后用一句话总结你为乔迪做了哪些准备。"
      : LADDER === "1" || LADDER === "2"
      ? "你现在是星露谷里的 AI 伴侣，站在农舍（FarmHouse）里。任务：屋外的公交站（Bus Stop）门口有一台空的木桶机器（Keg），你的背包里有 5 颗咖啡豆。请严格按以下顺序完成：(1) 先用 find_destination 查询目的地（例如 query=\"bus\"），拿到它的 canonical label 或 dr1_ ref，然后调用 navigate_to_destination 导航到公交站；(2) 导航完成（receipt 成功）后，**必须立即调用 observe**，从最新返回结果的 machineTargets 数组中精确复制该 Keg 的 x、y、expectedTargetId（以及 loadInputSlot）；**绝不允许猜测或从旧位置复制坐标**；(3) 用这些精确坐标调用 machine_inspect 检查机器，确认 receipt 为 machine_inspected；(4) 再用同一 machineTargets 条目的 loadInputSlot/expectedQualifiedItemId/(O)433 和精确 x/y/expectedTargetId 调用 machine_load 把咖啡豆装进木桶。每一步都等 receipt 成功再继续，不要只回答文字。完成后用一句话总结结果。"
      : "你现在是星露谷里的 AI 伴侣。任务：你所在农场屋（FarmHouse）里有一台空的木桶机器（Keg）和 5 颗咖啡豆（Coffee Beans）。请完成两步操作：(1) 先检查（inspect）这台机器，确认它的位置与目标 ID；(2) 然后把咖啡豆装进木桶（load）开始酿造。你必须使用游戏工具（先观察 observe，再调用机器检查与装载工具），根据工具返回的真实结果执行，不要只回答文字。完成后用一句话总结结果。")
    : (LADDER === "3"
      ? "Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. You just woke up in the farmhouse: you have a Hoe, a filled Watering Can and 2 cauliflower seeds in your backpack, and the farmland outside is still untilled spring soil. Complete this farming task on your own: carefully inspect what you own and your surroundings, decide which steps are needed to actually plant the cauliflower and water it, then carry them out step by step (choose targets from the real soilTiles/seedTargets/cropTargets in observe results). Do not just reply with text — actually use the game tools; besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (softly) / (bitter smile) / (hesitating) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions. When done, summarize in one sentence what you prepared for Jodi."
      : LADDER === "1" || LADDER === "2"
      ? "You are the AI companion in Stardew Valley, standing inside the FarmHouse. Task: right outside the farmhouse door at Bus Stop there is an empty Keg machine and your backpack has 5 Coffee Beans. Complete in this order: (1) first use find_destination (e.g. query=\"bus\") to get its canonical label or dr1_ ref, then call navigate_to_destination to reach Bus Stop; (2) after navigation succeeds (receipt ok), **immediately call observe** and copy exactly the Keg's x, y, expectedTargetId (and loadInputSlot) from the machineTargets array in the fresh result; **never guess or reuse old-location coordinates**; (3) call machine_inspect with those exact coordinates and confirm the receipt is machine_inspected; (4) then call machine_load with the same machineTargets entry's loadInputSlot/expectedQualifiedItemId/(O)433 and exact x/y/expectedTargetId to load the beans. Wait for each receipt before continuing; do not just reply with text. Summarize in one sentence when done."
      : "You are the AI companion in Stardew Valley. Task: there is an empty Keg machine in your farmhouse with 5 Coffee Beans in your backpack. Complete two steps: (1) inspect the machine first to confirm its location and target ID; (2) then load the coffee beans into the Keg to start brewing. You must use game tools (observe first, then machine inspect/load) based on real tool results; do not just reply with text. Summarize in one sentence when done."));
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
  if (LADDER === "2" || LADDER === "3") {
    if (voiceStarted && voiceObservation === null) {
      await Promise.race([voiceObservationPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 200_000))]);
    }
    if (voiceObservation !== null && voiceObservation.terminalStatus === "completed")
      voiceResult = Object.freeze({ state: "completed", terminalStatus: voiceObservation.terminalStatus });
    else if (voiceStarted)
      voiceResult = Object.freeze({ state: "blocked", detail: voiceObservation ?? "voice_not_streamed" });
    else
      // Voice never started: report the configuration answer verbatim instead
      // of a vague streaming failure, so the gate says why TTS is off.
      voiceResult = Object.freeze({
        state: "disabled",
        disabledReason:
          voiceConfiguration !== null && voiceConfiguration.enabled === false
            ? voiceConfiguration.disabledReason
            : (voiceObservation?.error ?? "voice_not_requested"),
      });
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
  // System-assembly evidence: the runtime's own run manifest records the
  // identity profile and world book it actually mounted. Compare that against
  // the canonical files the product placed under this runtime root, so the gate
  // proves the persona/world book reached the Game surface rather than trusting
  // a script-side claim. A disposable root legitimately has neither file.
  const personaWorldBook = await readAssembledContextEvidence(gameSessionPaths);
  const contextAssembled = personaWorldBook.expectedProfile === null
    ? true
    : personaWorldBook.mountedProfileId === personaWorldBook.expectedProfile.profileId
      && personaWorldBook.mountedProfileRevision === personaWorldBook.expectedProfile.revision;
  const worldBookAssembled = personaWorldBook.expectedWorldBook === null
    ? true
    : personaWorldBook.mountedWorldBookId === personaWorldBook.expectedWorldBook.worldBookId;
  const ladderOnePassed = LADDER === "1" ? walkReceipt !== undefined && inspectReceipt !== undefined && loadReceipt !== undefined : true;
  const ladderZeroPassed = LADDER === "0" ? inspectReceipt !== undefined && loadReceipt !== undefined && programSucceeded : true;
  const ladderTwoPassed = LADDER === "2" ? walkReceipt !== undefined && inspectReceipt !== undefined && loadReceipt !== undefined && (voiceResult?.state === "completed" || voiceResult?.state === "disabled") : true;
  const ladderThreePassed = LADDER === "3" ? tillReceipt !== undefined && plantReceipt !== undefined && waterReceipt !== undefined && (voiceStarted ? voiceResult?.state === "completed" : true) : true;
  const contextPassed = contextAssembled && worldBookAssembled;
  const result = {
    state: ladderOnePassed && ladderZeroPassed && ladderTwoPassed && ladderThreePassed && contextPassed ? "passed" : "blocked",
    ladder: LADDER,
    programStatus: status,
    walkReceipt: walkReceipt ?? null,
    inspectReceipt: inspectReceipt ?? null,
    loadReceipt: loadReceipt ?? null,
    tillReceipt: tillReceipt ?? null,
    plantReceipt: plantReceipt ?? null,
    waterReceipt: waterReceipt ?? null,
    personaWorldBook,
    contextAssembled,
    worldBookAssembled,
    presentedSummary,
    voiceResult,
    agentTurn: turn,
    bridgeFacts: factLog,
    authenticated: client.state.authenticated,
    revision: client.state.snapshot?.revision,
  };
  // Write the machine-readable result to a dedicated file so stdout logs (e.g.
  // native chat ingress traces) can never corrupt JSON parsing of the result.
  const resultFile = process.env.GAMEBUDDY_RESULT_FILE ?? join("tools", `_ladder${LADDER}-${Date.now()}.result.json`);
  await writeFile(resultFile, JSON.stringify(result, null, 2), "utf8").catch(() => {});
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // A turn-completion race (e.g. the runtime refresher asserting the bridge
  // is no longer live after the final presentation) must never lose the
  // already-collected evidence. Emit a blocked result with the partial state
  // and the error, then fall through to cleanup.
  const partialResult = {
    state: "blocked",
    ladder: LADDER,
    error: String(error instanceof Error ? error.message : error),
    tillReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "soil_tilled") ?? null,
    plantReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "seed_planted") ?? null,
    waterReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "crop_watered") ?? null,
    presentedSummary,
    voiceResult,
    agentTurn: turn,
    bridgeFacts: factLog,
    authenticated: client.state.authenticated,
    revision: client.state.snapshot?.revision,
  };
  const resultFile = process.env.GAMEBUDDY_RESULT_FILE ?? join("tools", `_ladder${LADDER}-${Date.now()}.result.json`);
  await writeFile(resultFile, JSON.stringify(partialResult, null, 2), "utf8").catch(() => {});
  console.error("RUNNER_CRASH", JSON.stringify({ error: partialResult.error }));
  console.log(JSON.stringify(partialResult, null, 2));
} finally {
  if (voiceChild !== null) { voiceChild.kill("SIGTERM"); await Promise.race([once(voiceChild, "close"), new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))]); if (!voiceChild.killed) voiceChild.kill("SIGKILL"); }
  await runtime?.close().catch(() => {});
  await binding.close().catch(() => {});
  client.close("agent_ab_complete");
}
/**
 * Reads what the runtime actually mounted versus what the product placed for
 * this identity, using only authoritative files: the runtime's own run manifest
 * (what the session mounted) and the canonical identity-profile/worldbook under
 * the runtime root (what was available). A disposable root has neither, and the
 * caller treats that as "nothing to assert" rather than a failure.
 */
async function readAssembledContextEvidence(runtimePaths) {
  const readJson = async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  };
  const manifest = await readJson(runtimePaths.runManifestPath);
  const canonicalProfile = await readJson(runtimePaths.identityProfilePath);
  const canonicalWorldBook = await readJson(join(runtimePaths.runtimeCwd, "worldbook.json"));
  const mountedProfile = manifest?.identityProfile ?? null;
  const mountedWorldBook = manifest?.worldBook ?? null;
  return Object.freeze({
    // What was available for this identity (absent on a disposable root).
    expectedProfile:
      canonicalProfile === null
        ? null
        : Object.freeze({
            profileId: canonicalProfile.profileId ?? null,
            revision: canonicalProfile.revision ?? null,
            canonicalHash: canonicalProfile.canonicalHash ?? null,
          }),
    expectedWorldBook:
      canonicalWorldBook === null
        ? null
        : Object.freeze({
            worldBookId: canonicalWorldBook.worldBookId ?? null,
            revision: canonicalWorldBook.revision ?? null,
          }),
    // What the runtime session actually mounted (from its own run manifest).
    mountedProfileId: mountedProfile?.profileId ?? null,
    mountedProfileRevision: mountedProfile?.revision ?? null,
    mountedProfileHash: mountedProfile?.canonicalHash ?? null,
    mountedWorldBookId: mountedWorldBook?.worldBookId ?? null,
    mountedWorldBookRevision: mountedWorldBook?.revision ?? null,
    manifestPresent: manifest !== null,
  });
}

// Split a companion line at sentence boundaries so voice can stream chunks as
// the gateway synthesizes incrementally. Favors 。！？.!? followed by any
// whitespace/end; keeps each chunk under the 4000-char delta limit while
// preferring whole sentences. Fallback: hard split on a safety max length.
function splitSpeakableSentenceChunks(text) {
  // Local constant: the module runs top-level awaits before this declaration
  // in source order, so a hoisted function could execute before the top-level
  // const initializes (TDZ). Local scope makes the split self-contained.
  const VOICE_SENTENCE_SPLIT_MAX = 512;
  const normalized = String(text).trim();
  if (normalized.length === 0) return [];
  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const isBoundary = char === "。" || char === "！" || char === "？" || char === "." || char === "!" || char === "?" || char === "；" || char === ";";
    if (isBoundary && index - cursor + 1 >= 12) {
      chunks.push(normalized.slice(cursor, index + 1));
      cursor = index + 1;
    } else if (index - cursor + 1 >= VOICE_SENTENCE_SPLIT_MAX) {
      // No sentence boundary within the safety window: cut a hard chunk so no
      // single delta ever exceeds the gateway limit.
      chunks.push(normalized.slice(cursor, index + 1));
      cursor = index + 1;
    }
  }
  if (cursor < normalized.length) chunks.push(normalized.slice(cursor));
  return chunks;
}