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
import { assessCompanionInteraction } from "./lib/companion-interaction-gate.mjs";
import { summarizeSystemFindings } from "./lib/system-findings.mjs";
import { buildPresenceProjection } from "./lib/stardew-companion-presence-projection.mjs";
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
// playback observation. "3" = Jodi's Request farming (the Agent plans
// till→plant→water itself) plus the spoken closing line. "4" = Jodi's Request
// close-out: one real mature cauliflower is already in the ground (12 growth
// days are the fixture's Given, not the Agent's wait), and the Agent harvests
// it, walks to Jodi and offers it. The runner is a single evolving live carrier;
// later ladders add their own acceptance on top instead of new runners.
const LADDER = process.env.GAMEBUDDY_AGENT_LADDER ?? "1";
/**
 * Scenario vocabulary for the presence projection (design
 * architecture/stardew-companion-presence-audit-dimensions.md §3.2): maps the
 * Mod-owned action ids the ladder scenarios exercise to the Chinese phrases a
 * companion utterance would use. The parser still applies the first-person
 * subject/mood guardrail, so a bare noun or a player-directed line does not
 * count. This is runner scenario data, not product authority.
 */
const PRESENCE_ACTION_VOCABULARY = Object.freeze({
  harvest_crop: ["收获", "收菜", "收走", "摘下来", "收割"],
  interact_npc_with_item: ["送给", "交给", "递给", "送礼", "送过去"],
  water_crop: ["浇水", "浇了水", "汲水"],
  till_soil: ["锄地", "翻地", "耕地", "松土"],
  plant_seed: ["种下", "播种", "种了", "种菜"],
  machine_load: ["放进桶里", "放进机器", "装进桶", "倒入"],
  machine_inspect: ["检查一下机器", "看看机器", "查看机器"],
  equip_tool: ["拿起", "装备", "换上工具", "换上"],
  pickup_item: ["捡起", "拾取", "捡到"],
  move_to_tile: ["走过去", "走到", "过去看看"],
  travel: ["前往", "出发去", "去镇上"],
});
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
/** Exact serialized bridge entries already printed, so a contract-legal
 * redelivery of the same transition does not read as a second action. */
const loggedFactLines = new Set();
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
// Presence-mechanism instrumentation (design stardew-companion-presence-mechanisms §1.5 / §2.4).
// `presentationPieces` records every companion_text commit EXACTLY as the
// presentation port saw it, in arrival order — the raw evidence for chunked /
// incremental presentation. `turnStartedAtMs` is the wall-clock moment the
// agent turn was accepted, so the first piece's time-to-first-bubble is
// measurable instead of inferred.
const presentationPieces = [];
let turnStartedAtMs = null;
/**
 * Presence-mechanism evidence for the run result (design
 * stardew-companion-presence-mechanisms §1.5): the committed companion_text
 * pieces in arrival order plus the headline TTFB of the first bubble. Used by
 * both the success and failure result paths so a blocked run still reports what
 * the presentation layer actually did.
 */
function summarizePresentationEvidence() {
  return Object.freeze({
    pieces: Object.freeze([...presentationPieces]),
    pieceCount: presentationPieces.length,
    firstPieceTtfbMs: presentationPieces.length > 0 ? presentationPieces[0].elapsedMs : null,
    // A turn that arrived as one wall at the end vs several pieces over time.
    chunked: presentationPieces.length > 1,
  });
}
/** Exact configuration answer for voice in this run; `enabled:false` carries the reason. */
let voiceConfiguration = null;
const voiceObservationPromise = new Promise((resolvePromise) => {
  voice = resolvePromise;
});
// Ladder-3 presentation hook: called by the Host presentation port after a
// companion text successfully landed in the game; forwards the exact text to
// the voice lane. No game/presentation authority is touched here.
const onCompanionTextPresented = (text, locale) => {
  if (LADDER !== "3" && LADDER !== "4") return;
  if (typeof text !== "string" || text.trim().length === 0) return;
  // Record EVERY committed piece before any single-shot voice logic runs: the
  // chunked-presentation evidence must not depend on voice being enabled or on
  // whether the piece happened to be the first one.
  const elapsedMs = turnStartedAtMs === null ? null : Date.now() - turnStartedAtMs;
  presentationPieces.push(Object.freeze({ index: presentationPieces.length, text, locale, elapsedMs }));
  console.error("AGENT_PRESENTATION_PIECE", JSON.stringify({ index: presentationPieces.length - 1, elapsedMs, chars: text.length }));
  // Dee-hydrate model scaffolding: the chat box and the voice line must both
  // speak the same clean dialogue — never read out `**` / `---` / emoji.
  const speakable = dehydrateCompanionSpeech(text);
  if (speakable.length === 0) return;
  // Accumulate every piece into the turn's spoken text: under incremental
  // presentation the final sentence may arrive as its own piece, so the
  // interaction gate must assess the whole turn, not only its first bubble.
  presentedSummary = presentedSummary === null ? speakable : `${presentedSummary}${speakable}`;
  console.error("AGENT_SUMMARY", JSON.stringify({ text: presentedSummary, locale }));
  if (voiceStarted) return;
  const spokenSoFar = presentedSummary;
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
      const { promiseVoiceObservation } = await startLadder2Voice(spokenSoFar);
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
    const entry = { type: fact.type, reasonCode: fact.payload?.reasonCode, requestId: fact.payload?.requestId, executionId: fact.payload?.executionId, evidence: fact.payload?.evidence ?? null };
    // The Mod legitimately delivers one bridge transition over two routes: the
    // fact route and the execute-response path, and the second delivery is an
    // idempotent no-op by contract (action-execution-coordinator.internal.test.ts:
    // "...are the same bridge transition"). A redelivery is byte-identical, so
    // deduplicate the console line on the exact serialized entry — distinct
    // progress events (e.g. per-tile `tile_advanced`) differ and still log. Every
    // entry still reaches factLog verbatim; only the log line is deduplicated, so
    // a redelivered receipt cannot read as a second action.
    const serialized = JSON.stringify(entry);
    factLog.push(entry);
    if (!loggedFactLines.has(serialized)) {
      loggedFactLines.add(serialized);
      console.error("BRIDGE_FACT", serialized);
    } else {
      console.error("BRIDGE_FACT_REDELIVERED", JSON.stringify({ type: entry.type, reasonCode: entry.reasonCode, executionId: entry.executionId }));
    }
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
// rejected coordinate is attributable to the actual submitted args. A thrown
// rejection (stale_snapshot, replay rejection, bridge_rejected:*) never returns
// a receipt, so the catch records the rejection instead of skipping the entry —
// otherwise the run's own health report sees zero rejections while the session
// shows real ones.
const actionTrace = [];
const originalExecute = client.execute.bind(client);
client.execute = async (request) => {
  try {
    const receipt = await originalExecute(request);
    const entry = { action: request?.action, args: request?.args, state: receipt?.state, reasonCode: receipt?.reasonCode };
    actionTrace.push(entry);
    console.error("AGENT_EXECUTE", JSON.stringify(entry));
    return receipt;
  } catch (error) {
    const reasonCode = String(error?.message ?? error).replace(/^bridge_rejected:/, "");
    const entry = { action: request?.action, args: request?.args, state: "rejected", reasonCode };
    actionTrace.push(entry);
    console.error("AGENT_EXECUTE", JSON.stringify(entry));
    throw error;
  }
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
// Declared before the try so the failure path can report the same facts instead
// of losing them when a later stage throws.
let agentTurnResult = null;
let voiceResult = null;
try {
  runtime = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => {
    const permit = Object.freeze({ principal: execution.principal, operationId: `op-${Date.now()}`, requestId: `req-${Date.now()}`, kind: "enter", gameSessionId, world: execution.world, bindingDigest: execution.bindingFacts.bindingDigest, owner: execution.bindingFacts.owner, deadlineAtMs: deadline, expected: Object.freeze({ partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }), payloadDigest: "a".repeat(64), fenceToken: `fence-${Date.now()}`, prepared: Object.freeze({ partitionRevision: 2, gameRevision: 0, leaseRevision: 1, fenceEpoch: 2 }) });
    return createHostGameRuntimeMaterializer({
      gameOperationalGateNonceSha256: "a".repeat(64),
      companionLocale: COMPANION_LOCALE,
      ...(LADDER === "3" || LADDER === "4" ? { onCompanionTextPresented } : {}),
    }).materializeEnter(reserveGameRuntimeMaterialization(execution), permit);
  }));
  if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");
  const tools = runtime.connected.host;
  const prompt = process.env.GAMEBUDDY_AGENT_PROMPT ?? (COMPANION_LOCALE === "zh-CN"
    ? (LADDER === "4"
      ? "今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她需要一颗新鲜花椰菜做菜，希望你能给她带一颗。你农场的地里正好种着一颗已经长好的花椰菜，她今天就在农场附近。（台词之外可以用括号写角色的情绪或内心，例如（轻声）（开心）（有点得意）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——行动起来之后不要每一步都插一句旁白；事情做完后，也不要列项目清单式地汇报你做了什么，用一两句简短的话和玩家聊一下。**"
      : LADDER === "3"
      ? "今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她需要一颗新鲜花椰菜做菜，希望你能给她带一颗。你刚从农舍醒来：背包里有锄头、装满了水的浇水壶和 2 颗花椰菜种子，屋外的农田还是春天没有耕过的土地。（台词之外可以用括号写角色的情绪或内心，例如（轻声）（苦笑）（有点犹豫）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——行动起来之后不要每一步都插一句旁白；事情做完后，也不要列项目清单式地汇报你做了什么，用一两句简短的话和玩家聊一下。**"
      : LADDER === "1" || LADDER === "2"
      ? "你现在是星露谷里的 AI 伴侣，站在农舍（FarmHouse）里。屋外的公交站（Bus Stop）门口有一台空的木桶机器（Keg），你的背包里有 5 颗咖啡豆。不要只回答文字，自己用游戏工具根据每一步的真实结果完成，完成后用一句话总结。"
      : "你现在是星露谷里的 AI 伴侣。你所在农场屋（FarmHouse）里有一台空的木桶机器（Keg）和 5 颗咖啡豆（Coffee Beans）。不要只回答文字，自己用游戏工具根据每一步的真实结果完成，完成后用一句话总结。")
    : (LADDER === "4"
      ? "Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. There happens to be a fully grown cauliflower in your farm soil, and she is nearby on the farm today. (besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (softly) / (delighted) / (a bit proud) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions). **How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step, and when the work is done do NOT recite a checklist; instead say a line or two as a companion.**"
      : LADDER === "3"
      ? "Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. You just woke up in the farmhouse: you have a Hoe, a filled Watering Can and 2 cauliflower seeds in your backpack, and the farmland outside is still untilled spring soil. (besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (softly) / (bitter smile) / (hesitating) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions). **How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step you take while working, and when the work is done do NOT recite a checklist; instead say a line or two as a companion.**"
      : LADDER === "1" || LADDER === "2"
      ? "You are the AI companion in Stardew Valley, standing inside the FarmHouse. An empty Keg machine is on the Bus Stop doorstep outside, and your backpack has 5 Coffee Beans. Do not just reply with text — use the game tools yourself and check each real result before moving on. Summarize in one sentence when done."
      : "You are the AI companion in Stardew Valley. There is an empty Keg machine in your farmhouse with 5 Coffee Beans in your backpack. Do not just reply with text — use the game tools yourself based on real tool results. Summarize in one sentence when done."));
  // Time origin for chunked-presentation TTFB: the moment the agent turn is
  // admitted, so the first companion bubble's elapsed time is measured from the
  // real turn boundary, not from process start.
  turnStartedAtMs = Date.now();
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
  agentTurnResult = turn;
  // Ladder 2 additionally waits for the voice gateway's terminal playback
  // observation for the companion line streamed on machine_coffee_loaded.
  // The gateway child needs up to ~20s to boot and MiMo probe-ready before the
  // job can stream, so ladder 2 budgets 90s overall; without a terminal
  // completed observation the ladder stays blocked.
  if (LADDER === "2" || LADDER === "3" || LADDER === "4") {
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
  // Ladder 4: the Agent must harvest the real mature crop and then offer it to
  // the villager. Either an ordinary recorded gift or a native quest delivery is
  // an accepted terminal for the offer — the point under test is the physical
  // harvest→carry→offer chain, not which native branch consumed the item.
  const harvestReceipt = receipts.find((receipt) => receipt.reasonCode === "crop_harvested");
  const offerReceipt = receipts.find((receipt) => receipt.reasonCode === "gift_given" || receipt.reasonCode === "quest_item_delivered");
  const ladderFourPassed = LADDER === "4" ? harvestReceipt !== undefined && offerReceipt !== undefined && (voiceStarted ? voiceResult?.state === "completed" : true) : true;
  const contextPassed = contextAssembled && worldBookAssembled;
  // Companion-quality gate (ladder-3/4): the spoken closing line must be
  // game-appropriate — short and to the player, not a step-by-step recital of
  // what the companion just did, and not a claim about a world reaction the
  // receipts never recorded. The offer receipt carries showed_response, so an
  // NPC reaction is only "observed" when the game actually showed it.
  const observedEvents = [];
  if (offerReceipt?.evidence !== null && typeof offerReceipt?.evidence === "object" && offerReceipt.evidence.showed_response === true) {
    observedEvents.push("npc_dialogue");
  }
  const interactionAssessment =
    (LADDER === "3" || LADDER === "4") && typeof presentedSummary === "string" && presentedSummary.trim().length > 0
      ? assessCompanionInteraction(presentedSummary, observedEvents)
      : null;
  const interactionPassed = interactionAssessment === null || interactionAssessment.passed;
  // System-level diagnostics: aggregate every rejected action into a small set
  // of system findings (component attribution + count + sample), so each live
  // run yields a "system health report" instead of just pass/blocked. A finding
  // such as one reasonCode dominating or the same coordinates retried points at
  // the observation/contract layer, not at the model. Compare two runs with
  // tools/compare-live-run-findings.mjs to judge whether a fix helped.
  const systemFindings = summarizeSystemFindings(actionTrace);
  // Presence mechanisms (design stardew-companion-presence-mechanisms §1.5/§2.4),
  // computed from facts this run already holds — no new product producer:
  //  - chunking: every committed companion_text piece in arrival order, with
  //    each piece's elapsed time; `firstPieceTtfbMs` is the headline TTFB the
  //    incremental-presentation work targets (≤1s ideal).
  //  - claims: the deterministic presence projection compares spoken promises
  //    against the same-turn receipts and the run's visible capability face.
  const presentation = summarizePresentationEvidence();
  const turnStartedMs = turnStartedAtMs;
  // Same-turn receipts for the claim projection come from the execution trace
  // (which carries both the Mod action id and its terminal state), never from
  // the raw fact log (which has no actionId).
  const executedReceipts = actionTrace.map((entry) => ({
    turnId: "turn-1",
    actionId: entry.action ?? "unknown",
    terminalState: entry.state ?? "failed",
  }));
  const visibleActionIds = Array.isArray(client.state.snapshot?.capabilities)
    ? client.state.snapshot.capabilities
    : [];
  const presenceProjection = presentationPieces.length > 0
    ? buildPresenceProjection({
        turnTexts: [{ turnId: "turn-1", text: presentedSummary ?? "" }],
        actionVocabulary: PRESENCE_ACTION_VOCABULARY,
        visibleActionIds,
        executedReceipts,
      })
    : null;
  void turnStartedMs;
  const result = {
    state: ladderOnePassed && ladderZeroPassed && ladderTwoPassed && ladderThreePassed && ladderFourPassed && contextPassed && interactionPassed ? "passed" : "blocked",
    ladder: LADDER,
    presentation,
    presenceProjection,
    programStatus: status,
    walkReceipt: walkReceipt ?? null,
    inspectReceipt: inspectReceipt ?? null,
    loadReceipt: loadReceipt ?? null,
    tillReceipt: tillReceipt ?? null,
    plantReceipt: plantReceipt ?? null,
    waterReceipt: waterReceipt ?? null,
    harvestReceipt: harvestReceipt ?? null,
    offerReceipt: offerReceipt ?? null,
    personaWorldBook,
    contextAssembled,
    worldBookAssembled,
    interactionAssessment,
    systemFindings,
    presentedSummary: presentedSummary ?? null,
    voiceResult,
    agentTurn: agentTurnResult,
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
  // A failure before the agent turn (connection, binding, materialization)
  // must still produce a readable result. The turn/voice facts live in the try
  // block's scope, so they are read through the same optional paths with
  // explicit fallbacks instead of assuming they were initialized.
  const partialResult = {
    state: "blocked",
    ladder: LADDER,
    error: String(error instanceof Error ? error.message : error),
    presentation: summarizePresentationEvidence(),
    tillReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "soil_tilled") ?? null,
    plantReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "seed_planted") ?? null,
    waterReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "crop_watered") ?? null,
    harvestReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "crop_harvested") ?? null,
    offerReceipt: factLog.find((fact) => fact.type === "execution_receipt" && (fact.reasonCode === "gift_given" || fact.reasonCode === "quest_item_delivered")) ?? null,
    presentedSummary: presentedSummary ?? null,
    interactionAssessment:
      LADDER === "3" && typeof presentedSummary === "string" && presentedSummary.trim().length > 0
        ? assessCompanionInteraction(presentedSummary)
        : null,
    voiceResult,
    agentTurn: agentTurnResult,
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