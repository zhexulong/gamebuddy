/**
 * Stardew Game live-run ladder (the single Game live-run file; LADDER=0..N).
 *
 * MAINTENANCE CONTRACT — read before changing this file:
 *
 * 1. Extend this file; never fork a parallel live runner. Each new capability
 *    is a new ladder rung (LADDER=N) layered on the rungs below it, exactly as
 *    ladder 0 -> 4 accreted. A second "improved" runner splits the evidence
 *    history and makes run-to-run comparison meaningless.
 * 2. A change to a rung is not done until it has produced a REAL run. Offline
 *    unit tests on this harness prove the harness, not the game; only a genuine
 *    Stardew/SMAPI/Mod/Agent run closes a rung.
 * 3. After each real run, audit the trace with the `auditing-runs` skill and
 *    dispatch a reviewer subagent over it (see the same requirement recorded in
 *    tools/live-run/chat/run-chat-live-audit.mjs). Findings feed the next iteration of THIS
 *    file. Fix the system, not the symptom: attribute a failure to the
 *    observation/contract/native-state/orchestration component that caused it
 *    (`tools/lib/system-findings.mjs`) rather than prompting the model harder.
 * 4. Keep run-to-run comparability: `tools/compare-live-run-findings.mjs`
 *    treats a new finding, a lost receipt or a worse interaction score as a
 *    regression. Do not silence a finding to make a rung pass.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { LocalStardewBridgeClient } from "../../../host/dist-test/local-stardew-bridge.js";
import { identityKey } from "../../../host/dist-test/runtime-identity.js";
import { dehydrateCompanionSpeech } from "../../../host/dist-test/companion-speech-dehydration.js";
import { LocalVoiceGatewayClient } from "../../../host/dist-test/voice-gateway-client.js";
import {
  launchVoiceGatewayChild,
  pickVoiceGatewayPort,
  resolveVoiceConfiguration,
} from "../../lib/voice-gateway-launch.mjs";
import { assessCompanionInteraction } from "../../lib/companion-interaction-gate.mjs";
import { assertLiveRunArtifactFresh } from "../../lib/live-run-artifact-freshness.mjs";
import { summarizeSystemFindings } from "../../lib/system-findings.mjs";
import { redactLiveRunText } from "../core/capture-text.mjs";
import { isPass, judgeExpectation } from "../core/evidence-verdict.mjs";
import { assertLiveRunPersonaMounted, provisionLiveRunPersona } from "../core/persona.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "../../stardew-action-gate-descriptors.mjs";
// The registered terminal reason code per action is the only authority that can
// tell a receipt that FINISHED an action from one that only progressed it. Read it
// from the published gate table instead of guessing from reason-code wording.
const TERMINAL_REASON_CODES = Object.freeze(
  Object.fromEntries(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => [gate.actionId, gate.terminalReasonCode])),
);
import { buildPresenceProjection } from "../../lib/stardew-companion-presence-projection.mjs";
import { STARDEW_GAME_INTEGRATION_ADAPTER, } from "../../../host/dist-test/stardew-game-integration-adapter.js";
import { createStardewIntegrationLaunchHandleFromAuthenticatedBridge, STARDEW_INTEGRATION_LAUNCHER } from "../../../host/dist-test/stardew-integration-launcher.js";
import { createGameRuntimeBindingFromReceiptBackedLaunch } from "../../../host/dist-test/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { reserveGameRuntimeMaterialization, withConsumedBindingExecution } from "../../../host/dist-test/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import { createHostGameRuntimeMaterializer } from "../../../host/dist-test/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { loadHostDeploymentManifest } from "../../../host/dist-test/deployment-manifest.js";
import { resolveRuntimePaths } from "../../../host/dist-test/runtime-identity.js";
import { bindWindowsStaleLockReclaimer } from "../../../host/dist-test/path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../../../host/dist-test/windows-stale-lock-reclaimer/index.js";
// Ladder 5 (embodied-memory covenant): the covenant FACT is planted through the
// real management surface under the product continuity, then the Game runtime on
// the SAME root/continuity must render it into m[0] — the Agent reads the rule
// from memory, never from a prompt line. When no configured root/continuity is
// given (disposable-root runs), seeding is skipped and the covenant is not
// asserted: a disposable root has no persisted memory by construction.
import { seedMemoriesViaManagementSurface } from "../memory/run-memory-live-loop.mjs";
// Content gate over the captured evidence (tools/live-run/core/content-gate.mjs):
// the assembly gate only proves hash consistency; this proves the assembled
// profile actually has persona content and no unrendered SillyTavern macros.
// A configured-root run whose captured profile is a hollow default (no persona)
// is an explicit context failure, never a silent pass. A read GAP (no profile
// captured) stays a gap: nothing to assert.
import { assessIdentityProfile } from "../core/content-gate.mjs";
import { explainAuthorityIdentityMismatch } from "../core/authority-identity.mjs";
import { openLiveRunCapture, resolveLiveRunRoot } from "../core/capture.mjs";
import { submitPlayerPrompt } from "../core/player-input-admission.mjs";

// Live-run evidence root: every run writes its own local directory with the
// runtime root's OWN evidence (identity-profile.json, worldbook.json, the
// Magic Context database + log, session logs). This is what makes a content
// defect (e.g. an empty default persona) visible to a reviewer — the harness
// is an external tool and is not bound by the Host's write-ownership rule.
const LIVE_RUN_ROOT = resolveLiveRunRoot({ repoRoot: fileURLToPath(new URL("../../..", import.meta.url)) });

const configPath = process.env.GAMEBUDDY_STARDEW_CONFIG ?? "D:/Steam/steamapps/common/Stardew Valley/Mods/GameBuddy.Stardew/config.json";
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
// it, walks to Jodi and offers it. "5" = embodied-memory covenant probe
// (design chat-long-horizon-memory-probe-design.md §10.5 class 1): the Agent
// harvests the real mature strawberries and must honor the standing covenant
// the player stated — no ship_item execution receipt may carry the protected
// item (O)400. The judgement runs on real Mod receipts, never transcript
// text. The runner is a single evolving live carrier; later ladders add their
// own acceptance on top instead of new runners.
/**
 * Last-resort evidence: whatever escapes the run's own try/catch — an unhandled rejection, a
 * synchronous throw in setup, a transport failure at connect — the artifact is still written, so a
 * failed session is analysable instead of leaving nothing behind. Three real runs (N, O, P) died
 * with no artifact at all; this is the floor that makes that impossible.
 */
function writeFailureArtifact(reason) {
  try {
    const path = process.env.GAMEBUDDY_RESULT_FILE;
    if (typeof path !== "string" || path.length === 0) return;
    const payload = {
      state: "blocked",
      ladder: process.env.GAMEBUDDY_AGENT_LADDER ?? null,
      reason: "runner_failed_before_reporting",
      error: String(reason instanceof Error ? reason.message : reason),
      stack: reason instanceof Error ? reason.stack : null,
      at: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    console.error(`RUNNER_FAILED artifact written to ${path}`);
  } catch (error) {
    console.error("RUNNER_FAILED artifact could not be written", error);
  }
}
process.on("uncaughtException", (error) => {
  writeFailureArtifact(error);
  process.exitCode = 1;
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  writeFailureArtifact(error);
  process.exitCode = 1;
  process.exit(1);
});

// This file imports fifteen modules of `host/dist-test` directly, so a stale artifact silently tests the wrong
// code — observed as an `Unsupported candidate action:` for an action that was already committed. Refuse to
// start rather than spend a game launch, a fixture prepare and a session on it.
await assertLiveRunArtifactFresh();

const LADDER = process.env.GAMEBUDDY_AGENT_LADDER ?? "1";
// Ladder 6 (self-directed play session): instead of a scripted chain, the Agent
// is handed an open play goal in a real save and decides what to do itself. The
// rung's question is not "did chain X run" but "what could the companion
// actually do, and where did the system stop it" — so it accepts any real
// action attempt, records a per-capability audit, and stays `blocked` (never a
// silent pass) when the session produced no attempt at all.
//
// Extra goals are delivered as further player turns after the previous one
// settles, one per `|`-separated entry, so a session can be wide rather than
// one-shot. Absent, the rung runs the single open goal above.
const SESSION_GOALS = (process.env.GAMEBUDDY_AGENT_SESSION_GOALS ?? "")
  .split("|")
  .map((goal) => goal.trim())
  .filter((goal) => goal.length > 0);
// Every turn the session delivered, with its own settle result. Only ladder 6
// runs more than one; the array exists for all ladders so the result shape is
// uniform.
const sessionTurns = [];
// What the companion could actually see during the session. Sampled WHILE the
// session runs (the surface a turn can rely on), never read after teardown: the
// post-run snapshot is empty in practice, which silently emptied the audit's
// "capability it never used" axis on the first real run.
const advertisedActionSamples = new Set();
// How many times the surface was sampled and how large it was: without these a
// reader cannot tell "the axis is empty because nothing was advertised" from "the
// axis is empty because it was never sampled" — the first run's `advertisedCount:0`
// was the second case and looked like the first.
let advertisedSampleCount = 0;
let advertisedSampleMaxSize = 0;
function sampleAdvertisedActions() {
  const advertised = client?.state?.snapshot?.capabilities;
  if (!Array.isArray(advertised)) return;
  advertisedSampleCount += 1;
  advertisedSampleMaxSize = Math.max(advertisedSampleMaxSize, advertised.length);
  for (const actionId of advertised) if (typeof actionId === "string") advertisedActionSamples.add(actionId);
}
// Ladder 5's protected item (design chat-long-horizon-memory-probe-design.md
// §10.5 class 1): the strawberry qualified id that must never enter the
// shipping bin. The runner asserts on the Mod receipt evidence field, so this
// is the single spelling used by the covenant probe.
const PROTECTED_COVENANT_ITEM_ID = "(O)400";
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
// identity-profile/worldbook are assembled; absent falls back to the stored
// principal for a configured root, and only then to a run-scoped id.
//
// Reusing the STORED principal matters: a runtime root's deployment manifest pins
// the continuity that provisioned it and refuses any later launch carrying a
// different one, so minting a fresh id per run made every repeat run on a real
// root fail with `runtime_root_principal_mismatch` (the first run writes the
// manifest, the second is refused) — the opposite of what a live-run ladder is
// for. The environment still overrides this for a deliberate new identity.
const storedContinuityId = (() => {
  if (typeof configuredRuntimeRoot !== "string" || configuredRuntimeRoot.length === 0) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(configuredRuntimeRoot, "manifest.json"), "utf8"));
    const stored = manifest?.principal?.continuityId;
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
})();
const runContinuityId =
  process.env.GAMEBUDDY_COMPANION_CONTINUITY_ID ?? storedContinuityId ?? `native-agent-${Date.now()}`;
const identity = Object.freeze({ playerId: config.PlayerId, companionId: config.CompanionId, continuityId: runContinuityId, saveId: config.SaveId, worldId: config.WorldId });
const deadline = Date.now() + 600_000;
// Startup phase timings. "The live run is slow to start" needs numbers, not
// impressions: this separates the phases a reader can act on (bridge connect,
// covenant seed, runtime materialization, agent turn) instead of one total.
const phaseTimings = { runStartedAtMs: Date.now(), marks: {} };
const markPhase = (name) => {
  phaseTimings.marks[name] = Date.now() - phaseTimings.runStartedAtMs;
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken, STARDEW_GAME_INTEGRATION_ADAPTER, undefined, "1.6.15");
markPhase("bridgeConnectedMs");
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
 * The agent session's own terminal record for the turn(s) this run drove.
 *
 * The harness used to decide "did the companion speak" from `presentedSummary` alone, so a turn whose
 * provider stream ENDED IN AN ERROR was reported as `silent` — as if the companion had chosen not to
 * speak. Measured on a real ladder-6 run: the last assistant message carried `stopReason: "error"`,
 * `errorMessage: "unexpected EOF"` and zero usage tokens, the verdict was `silent`, `sessionTurnErrors`
 * was empty, and the harness log contained no agent-side line at all. The runtime's own durable session
 * record is the authoritative fact here and the capture already keeps it.
 *
 * Only bounded, content-free facts are published: the stop reason, whether any assistant text part
 * existed, how many assistant messages the turn had, and a redacted provider transport message. Player
 * or companion TEXT is never read into the result.
 */
function readAgentTurnOutcome(sessionJsonlPath) {
  let raw;
  try {
    raw = readFileSync(sessionJsonlPath, "utf8");
  } catch {
    return Object.freeze({ observed: false, reason: "session_not_readable" });
  }
  let assistantMessages = 0;
  let last = null;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "assistant") continue;
    assistantMessages += 1;
    const parts = Array.isArray(message.content) ? message.content : [];
    last = {
      stopReason: typeof message.stopReason === "string" ? message.stopReason : "unknown",
      hasText: parts.some(
        (part) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
      ),
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : null,
      totalTokens: typeof message.usage?.totalTokens === "number" ? message.usage.totalTokens : null,
    };
  }
  if (last === null) return Object.freeze({ observed: false, reason: "no_assistant_message" });
  return Object.freeze({
    observed: true,
    assistantMessages,
    stopReason: last.stopReason,
    // A turn that produced no assistant text at all is exactly the case that used to be
    // indistinguishable from a companion choosing silence.
    producedText: last.hasText,
    error: last.errorMessage === null ? null : redactLiveRunText(last.errorMessage).slice(0, 120),
    totalTokens: last.totalTokens,
  });
}

/**
 * `provider_error`-style reason for a turn that ended in a provider/runtime failure WITHOUT producing
 * any text, or `undefined` when the session record does not say that. Deliberately narrow: a turn that
 * spoke and then failed is not this case, and an unreadable session stays `unobserved` — the verdict
 * reports that rather than converting it into a cause.
 */
function agentTurnFailureReason(outcome) {
  if (outcome?.observed !== true) return undefined;
  if (outcome.producedText === true) return undefined;
  if (outcome.stopReason !== "error" && outcome.stopReason !== "aborted") return undefined;
  return `provider_${outcome.stopReason}${outcome.error === null ? "" : `:${outcome.error}`}`;
}

/**
 * The newest agent session record under this run's runtime root, or an object saying where it looked.
 *
 * The product's own convention is `<runtimeCwd>/surface-sessions/<surfaceSessionId>/sessions/*.jsonl`
 * (`host/src/runtime-identity.ts:127-136`), and that is checked first. It is not the ONLY place a runtime may
 * put a session, though: one live run recorded none there (its result said `no_session_record` while the
 * session had certainly run), so the search falls back to a bounded walk of the runtime cwd. Returning the
 * searched base matters as much as the path: `unobserved` must name what it looked at, so a reader can tell a
 * missing session from a reader looking in the wrong place.
 */
function findAgentSessionJsonl(root, identity) {
  const runtimeCwd = join(root, "contexts", identityKey(identity));
  const base = join(runtimeCwd, "surface-sessions");
  const searched = [];
  const candidates = [];
  const collect = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".jsonl")) candidates.push({ path, file: entry.name });
    }
  };
  if (existsSync(base)) {
    searched.push(base);
    collect(base);
  }
  if (candidates.length === 0 && existsSync(runtimeCwd)) {
    searched.push(runtimeCwd);
    collect(runtimeCwd);
  }
  if (candidates.length === 0) return { path: undefined, searched: searched.map(String) };
  // Session file names are UTC timestamps, so the last one lexicographically is the newest.
  candidates.sort((left, right) => left.file.localeCompare(right.file));
  return { path: candidates[candidates.length - 1].path, searched };
}

/**
 * Per-execution receipt outcomes, derived from the run's own facts.
 *
 * Deduplicating receipts by `executionId` alone was WRONG and hid real failures: one execution legally
 * emits several receipts (`accepted` -> `controller_started` -> `tool_approach_completed` ->
 * `target_out_of_reach`), so the first one seen claimed the execution and every later code — including
 * its authoritative terminal failure — was dropped. Measured on a real run: three harvest executions
 * ended in `target_out_of_reach`, `capabilityAudit` still reported `harvest_crop.verdict: "succeeded"`
 * with `unresolved: []`, and `target_out_of_reach` appeared nowhere in the audit.
 *
 * A receipt's identity is therefore `(executionId, reasonCode)`: the bridge's legitimate redelivery
 * repeats the same pair, while a different code is a different fact about the same execution. Codes that
 * cannot end an execution are progress; anything else is a terminal claim, classified against the
 * action's registered success terminal from the published gate table.
 */
function summarizeExecutionOutcomes({ facts, actionOfRequest, terminalReasonCodes }) {
  // Codes that cannot END an execution: anything else is a terminal claim. Declared here so this
  // function is self-contained and can be evaluated (and tested) on its own.
  const progressCodes = new Set(["accepted", "controller_started", "tool_approach_completed", "tile_advanced"]);
  const byExecution = new Map();
  const seen = new Set();
  for (const fact of facts ?? []) {
    if (fact?.type !== "execution_receipt") continue;
    const actionId = typeof fact.requestId === "string" ? actionOfRequest.get(fact.requestId) : undefined;
    if (actionId === undefined) continue;
    const executionId =
      typeof fact.executionId === "string" && fact.executionId.length > 0
        ? fact.executionId
        : `${fact.requestId}:${fact.reasonCode}`;
    const code = typeof fact.reasonCode === "string" && fact.reasonCode.length > 0 ? fact.reasonCode : "unknown";
    const key = `${executionId}\u001f${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const current = byExecution.get(executionId) ?? { actionId, terminals: [] };
    if (!progressCodes.has(code)) current.terminals.push(code);
    byExecution.set(executionId, current);
  }
  const perAction = new Map();
  for (const entry of byExecution.values()) {
    const registered = terminalReasonCodes[entry.actionId];
    const succeeded = entry.terminals.includes(registered);
    const failures = entry.terminals.filter((code) => code !== registered);
    const current = perAction.get(entry.actionId) ?? {
      executions: { succeeded: 0, failed: 0, inFlight: 0 },
      failedTerminalReasonCodes: {},
    };
    if (succeeded) current.executions.succeeded += 1;
    else if (failures.length > 0) current.executions.failed += 1;
    else current.executions.inFlight += 1;
    for (const code of failures)
      current.failedTerminalReasonCodes[code] = (current.failedTerminalReasonCodes[code] ?? 0) + 1;
    perAction.set(entry.actionId, current);
  }
  return perAction;
}

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
  // RECORD the presentation for EVERY ladder. The callback is only invoked after
  // a companion text actually landed in the game, so it is the harness's only
  // evidence of what the player was shown — gating it on the ladder made
  // ladder-5 runs report `presentation.pieces: []` and `presentedSummary: ""`
  // even when the Agent had spoken, which reads exactly like "the companion said
  // nothing" and sent a real investigation in the wrong direction.
  //
  // The VOICE lane stays ladder-scoped (below): recording evidence and speaking
  // are different concerns.
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
  // Only the voice lane is ladder-scoped: the speech path exists for ladders 3
  // and 4 today, and ladders 0-2 use no voice at all.
  if (LADDER !== "3" && LADDER !== "4") return;
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

// Actions that MOVE the actor, LOOK at the world, or change only the actor's own gear.
// A play session that did nothing but these has not played: run H attempted 14 actions,
// got 14 refusals and one successful walk, harvested nothing, and still reported `passed`
// because the verdict only required "a real attempt". "Did the companion actually do
// something" is a different question from "did it try", and a rung whose whole job is to
// report what the companion could do must not call an empty session a success.
const NON_ACCOMPLISHMENT_ACTIONS = Object.freeze(
  new Set([
    "move_to_tile",
    "travel",
    "enter_exit",
    "navigate_to_destination",
    "observe_scene",
    "inspect_world_map",
    "express_emote",
    "face_direction",
    "equip_tool",
  ]),
);

/**
 * ladder 0-5 delivered exactly one player turn; ladder 6 delivers a session.
 * This is that one turn's machinery, extracted so every ladder shares it: admit
 * the player text, wait for the turn to settle (or for a submitted program to
 * reach a terminal), then judge whether the steer was actually OBSERVED.
 *
 * Audit MEDIUM-3: distinguish "settled because the session worked" from "settled
 * but the player input may never have reached the session". The Host refuses a
 * player message while the integration admission is revoked (overflow/disconnect)
 * or after the session closed, and it now REPORTS that refusal; the harness waits
 * for a real acceptance instead of submitting into the void. `steerObserved` stays
 * an OBSERVED fact — any tool call, receipt or presented companion line means the
 * steer reached the session; none of them observed means the result must say so
 * instead of pretending the agent chose to do nothing.
 */
async function runAgentTurn(text, tools) {
  turnStartedAtMs = Date.now();
  sampleAdvertisedActions();
  const agentTurn = (async () => {
    try {
      const admission = await submitPlayerPrompt({
        accept: (promptText, locale) => tools.acceptPlayerText(promptText, locale),
        text,
        locale: "zh-CN",
        timeoutMs: Number(process.env.GAMEBUDDY_PLAYER_INPUT_ADMISSION_MS ?? 90_000),
      });
      if (admission.accepted !== true) {
        return {
          settled: false,
          error: `player_input_refused:${admission.lastRefusal ?? "unknown"}`,
          admission,
        };
      }
      return { settled: true, admission };
    } catch (error) {
      return { settled: false, error: String(error?.message ?? error), stack: error?.stack };
    }
  })();
  let status = null;
  let turn = null;
  // Dispatches issued BEFORE this turn: evidence of arrival must be caused by the turn, not by the run's
  // earlier traffic.
  const dispatchesBeforeTurn = actionTrace.length;
  // How long one delivered turn may wait before the harness stops waiting. For an
  // open play session this is a HARNESS bound, not a product verdict (design 1432:
  // timeouts belong to the harness), so ladder 6 gets a budget that fits dozens of
  // native actions instead of the 10-minute default the scripted rungs use. A turn
  // that still exceeds it does not silently become a completed session: the verdict
  // below refuses to call that `passed`.
  const turnWaitSeconds = Number(
    process.env.GAMEBUDDY_AGENT_WAIT_SECONDS ?? (LADDER === "6" ? 1800 : 600),
  );
  for (let i = 0; i < turnWaitSeconds; i++) {
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
  turn.steerObserved =
    agentProgramId !== null ||
    (typeof presentedSummary === "string" && presentedSummary.length > 0) ||
    // The turn's own effects: a dispatch it issued is proof the steer reached the session. `factLog.length > 0`
    // used to stand here and proved almost nothing — any Mod fact, including an unrelated body trace, made it
    // true while no player text had reached Pi at all.
    actionTrace.length > dispatchesBeforeTurn;
  sampleAdvertisedActions();
  if (turn.settled === true && turn.steerObserved === false)
    turn.reason = "steer_may_have_been_silently_dropped";
  return { turn, status };
}

/**
 * ladder 6's capability/stall audit.
 *
 * A play session is only worth running if its outcome reads as "what the companion
 * could actually do, what the system stopped, and what it never tried". Two
 * authorities make that answerable from the trace alone:
 *
 *   - `actionTrace` records one entry per DISPATCH the Agent sent: the action, its
 *     requestId, the admission state, or the throw when the dispatch was refused.
 *     An admission (`accepted`) is NOT an outcome — the terminal arrives later as a
 *     receipt fact, so counting admissions as failures invents stalls.
 *   - `STARDEW_PUBLISHED_ACTION_GATES` names each action's terminal reason code, so
 *     receipts can be joined to the action that caused them (by requestId, deduped
 *     by executionId) and judged against the registered terminal rather than
 *     against a heuristic list of "success-sounding" codes.
 *
 * Per action the audit therefore reports dispatches (with admission and rejection
 * histograms) plus terminal receipts, and classifies:
 *   blockedBySystem  dispatched, never reached its terminal, and the trace shows a
 *                    refusal or a terminal failure — the stalls to attribute
 *   unresolved       dispatched, never reached its terminal, and NO terminal or
 *                    refusal was observed — a gap to report, never a claimed stall
 *   failed           dispatched, reached a terminal failure code
 *   succeeded        reached its registered terminal
 *   notAttempted     advertised actions the session never dispatched, sampled from
 *                    the LIVE surface (sampled while the session ran, not after it)
 */
function buildCapabilityAudit({
  actionTrace,
  facts,
  visibleActionIds,
  sessionTurns,
  terminalReasonCodes = {},
  advertisedSampleCount = 0,
  advertisedSampleMaxSize = 0,
}) {
  const byAction = new Map();
  const actionOfRequest = new Map();
  const stateOf = (value) => (typeof value === "string" && value.length > 0 ? value : "unknown");
  const bump = (table, key) => {
    if (typeof key !== "string" || key.length === 0) return;
    table[key] = (table[key] ?? 0) + 1;
  };
  for (const entry of actionTrace ?? []) {
    if (typeof entry?.action !== "string") continue;
    const current = byAction.get(entry.action) ?? {
      actionId: entry.action,
      dispatches: 0,
      admissionStates: {},
      rejections: {},
      terminalReceipts: 0,
      terminalReasonCodes: {},
      // Non-terminal receipts are PROGRESS (accepted/controller_started/
      // tile_advanced...). They are recorded for the reader but never counted as
      // failures: only a dispatch refusal is unambiguous evidence of a stop, and
      // claiming more than that would be the audit inventing a stall.
      progressReceipts: 0,
      receiptReasonCodes: {},
    };
    current.dispatches += 1;
    const state = stateOf(entry.state);
    bump(current.admissionStates, state);
    // A refused dispatch never becomes a receipt, so its reason is recorded here.
    if (state === "rejected" || state === "failed" || state === "uncertain") bump(current.rejections, stateOf(entry.reasonCode));
    if (typeof entry.requestId === "string" && entry.requestId.length > 0)
      actionOfRequest.set(entry.requestId, entry.action);
    byAction.set(entry.action, current);
  }

  // Join receipts back to the action that caused them. The fact log carries no
  // actionId, but it does carry requestId/executionId; see summarizeExecutionOutcomes for why
  // the identity is (executionId, reasonCode) and not executionId alone.
  const seenReceipt = new Set();
  for (const fact of facts ?? []) {
    if (fact?.type !== "execution_receipt") continue;
    const actionId = typeof fact.requestId === "string" ? actionOfRequest.get(fact.requestId) : undefined;
    if (actionId === undefined) continue;
    const current = byAction.get(actionId);
    if (current === undefined) continue;
    const executionId =
      typeof fact.executionId === "string" && fact.executionId.length > 0
        ? fact.executionId
        : `${fact.requestId}:${fact.reasonCode}`;
    const code = stateOf(fact.reasonCode);
    const key = `${executionId}\u001f${code}`;
    if (seenReceipt.has(key)) continue;
    seenReceipt.add(key);
    bump(current.receiptReasonCodes, code);
    if (code === terminalReasonCodes[actionId]) {
      current.terminalReceipts += 1;
      bump(current.terminalReasonCodes, code);
    } else {
      current.progressReceipts += 1;
    }
  }

  // A receipt the audit calls "progress" may still be an execution's END, and that is how three
  // authoritative failures (target_out_of_reach) disappeared from a real run's audit. Per-execution
  // outcomes are therefore derived separately, from the same facts, and folded back in below.
  const executionOutcomes = summarizeExecutionOutcomes({
    facts,
    actionOfRequest,
    terminalReasonCodes,
  });

  const reachedTerminal = (entry) => entry.terminalReceipts > 0;
  const sawFailure = (entry) => Object.keys(entry.rejections).length > 0;
  const failedExecutions = (entry) => executionOutcomes.get(entry.actionId)?.executions.failed ?? 0;
  const attempted = [...byAction.values()]
    .map((entry) => {
      const outcomes = executionOutcomes.get(entry.actionId) ?? {
        executions: { succeeded: 0, failed: 0, inFlight: 0 },
        failedTerminalReasonCodes: {},
      };
      const failed = outcomes.executions.failed;
      return Object.freeze({
        ...entry,
        admissionStates: Object.freeze({ ...entry.admissionStates }),
        rejections: Object.freeze({ ...entry.rejections }),
        terminalReasonCodes: Object.freeze({ ...entry.terminalReasonCodes }),
        receiptReasonCodes: Object.freeze({ ...entry.receiptReasonCodes }),
        executionOutcomes: Object.freeze({
          ...outcomes.executions,
        }),
        failedTerminalReasonCodes: Object.freeze({ ...outcomes.failedTerminalReasonCodes }),
        // `succeeded` now means EVERY execution of this action finished on its registered terminal;
        // one success next to a failure is `partial`, and failures are never folded into success.
        verdict: reachedTerminal(entry) && failed === 0
          ? "succeeded"
          : reachedTerminal(entry)
            ? "partial"
            : failed > 0
              ? "failed"
              : sawFailure(entry)
                ? "blocked"
                : "unresolved",
      });
    })
    .sort((left, right) => right.dispatches - left.dispatches || left.actionId.localeCompare(right.actionId));
  const advertised = Array.isArray(visibleActionIds) ? visibleActionIds.filter((id) => typeof id === "string") : [];
  return Object.freeze({
    schema: "gamebuddy_stardew_play_session_capability_audit/v1",
    sessionTurnCount: (sessionTurns ?? []).length,
    attempts: Object.freeze(attempted),
    attemptedCount: attempted.length,
    succeededCount: attempted.filter((entry) => entry.verdict === "succeeded").length,
    // "The system blocked it" is a claim that needs evidence behind it: an action
    // is only reported as a system stall when the trace shows a refusal or an execution
    // that ended on a non-success terminal, and as `unresolved` when nothing terminal was observed at
    // all. An audit that over-claims is worse than one that admits a gap.
    blockedBySystem: Object.freeze(attempted.filter((entry) => entry.verdict === "blocked" || entry.verdict === "failed")),
    // Actions that succeeded at least once AND failed at least once. Their failures are the
    // interesting ones (a retry that never worked), so they must not hide behind the success.
    partialFailures: Object.freeze(
      attempted
        .filter((entry) => entry.verdict === "partial")
        .map((entry) => Object.freeze({ actionId: entry.actionId, failedTerminalReasonCodes: entry.failedTerminalReasonCodes })),
    ),
    unresolved: Object.freeze(attempted.filter((entry) => entry.verdict === "unresolved").map((entry) => entry.actionId)),
    notAttempted: Object.freeze(advertised.filter((actionId) => !byAction.has(actionId)).sort()),
    advertisedCount: advertised.length,
    // Proof that the axis above was actually sampled while the session ran.
    advertisedSampleCount,
    advertisedSampleMaxSize,
    advertisedAxisUsable: advertisedSampleCount > 0 && advertised.length > 0,
  });
}

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
/**
 * Explain an authority refusal that comes from a bootstrapOperationId mismatch
 * (see core/authority-identity.mjs for the mechanism and the live evidence).
 */
function withAuthorityIdentityMismatch(error, root, manifest) {
  return explainAuthorityIdentityMismatch(error, root, manifest);
}

function randomToken(len = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
/**
 * Ladder-5 covenant judgement: finds the first `ship_item` execution receipt
 * (terminal reasonCode `item_shipped`) whose serialized evidence proves the
 * protected item id actually entered the shipping bin. The Mod emits
 * `item=<qualifiedItemId>` inside the terminal evidence detail (same
 * key=value;... shape the ladder-4 offer gate parses for `showed_response`),
 * so the check reads the evidence object's detail string directly. Returns
 * `undefined` when no protected shipment occurred — i.e. the covenant held.
 * This consumes REAL execution receipts only, never transcript text.
 */
function findProtectedCovenantShipment(receipts, protectedItemId) {
  const expectedField = `item=${protectedItemId}`;
  for (const receipt of receipts) {
    if (receipt?.type !== "execution_receipt" || receipt.reasonCode !== "item_shipped") continue;
    const detail = typeof receipt?.evidence?.detail === "string" ? receipt.evidence.detail : "";
    if (detail.length === 0) continue;
    if (detail.split(";").some((field) => field === expectedField)) return receipt;
  }
  return undefined;
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
    const entry = { action: request?.action, requestId: request?.requestId, args: request?.args, state: receipt?.state, reasonCode: receipt?.reasonCode, evidence: receipt?.evidence?.detail };
    actionTrace.push(entry);
    console.error("AGENT_EXECUTE", JSON.stringify(entry));
    return receipt;
  } catch (error) {
    const reasonCode = String(error?.message ?? error).replace(/^bridge_rejected:/, "");
    const entry = { action: request?.action, requestId: request?.requestId, args: request?.args, state: "rejected", reasonCode };
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
// The reviewed live-run persona, provisioned by the product's own file convention
// (<runtimeRoot>/card.json + worldbook.json), byte for byte and with no preprocessing, and then
// ASSERTED: this ladder's content gate used to concede that "a disposable root legitimately has
// neither file", but a run whose companion has no persona cannot support a claim about how it plays
// or talks. Absence is a failure now, and the log names the persona that spoke.
// The RUNTIME CWD, not the root: `runtime-identity.ts:107` resolves it to `<root>/contexts/<identityKey>`,
// the product writes the book there (`new-companion-service.ts:202`), and every reader opens it from there.
// Provisioning into the root left the book on disk while the runtime never read it — and the assertion still
// passed, because it checked the file WE wrote rather than the path the runtime reads. Same directory now.
const personaCwd = join(runtimeRoot, "contexts", identityKey(identity));
await mkdir(personaCwd, { recursive: true });
const provisionedPersona = await provisionLiveRunPersona(personaCwd);
const personaMounted = await assertLiveRunPersonaMounted(personaCwd);
if (!personaMounted.ok)
  throw new Error(`live_run_persona_not_mounted:${personaMounted.problems.join(",")}`);
process.stderr.write(
  `[ladder] persona mounted: ${String(personaMounted.name)} (${personaMounted.worldBookEntries} world-book entries, ${personaMounted.macroTokens} authored tokens) from ${provisionedPersona.identity.dir}\n`,
);
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
//
// ONE runtime root = ONE deployment identity. The product's authority marker binds
// the `bootstrapOperationId` (and `authorityGeneration`) that provisioned the root
// and refuses ANY later launch whose manifest does not match it — including one
// that asks to open the existing authority as "known". So a second run on a real
// continuity must reuse the stored manifest instead of minting a fresh id; a new
// id is written only when the root has none yet. A stored manifest for a
// DIFFERENT principal is refused loudly rather than silently re-provisioned.
const storedManifest = await readFile(manifestPath, "utf8").then(
  (text) => JSON.parse(text),
  () => null,
);
if (storedManifest === null) {
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot, principal: { continuityId: identity.continuityId, companionId: identity.companionId, playerId: identity.playerId }, bootstrapOperationId: `agent-ab-${Date.now()}`, authorityGeneration: 1 }), "utf8");
} else {
  const stored = storedManifest?.principal;
  const samePrincipal =
    stored?.continuityId === identity.continuityId &&
    stored?.companionId === identity.companionId &&
    stored?.playerId === identity.playerId;
  if (!samePrincipal) {
    throw new Error(
      `runtime_root_principal_mismatch: the runtime root was provisioned for continuity ${String(stored?.continuityId)} / companion ${String(stored?.companionId)} / player ${String(stored?.playerId)}; refusing to reuse it for ${identity.continuityId} (use a separate runtime root per principal)`,
    );
  }
}
const deploymentManifest = await loadHostDeploymentManifest(manifestPath);
const runtimePaths = resolveRuntimePaths(identity, runtimeRoot);
await mkdir(runtimePaths.agentDir, { recursive: true });
if (!process.env.CPA_OAI_API_KEY) throw new Error("CPA_OAI_API_KEY_missing");
await writeFile(join(runtimePaths.agentDir, "auth.json"), JSON.stringify({ "cpa-oai": { type: "api_key", key: process.env.CPA_OAI_API_KEY } }), "utf8");
// Capture the run's evidence into a dedicated local directory (git-ignored).
// The summary lands in the result JSON so a failed capture is visible, never
// silent — a capture that broke would recreate exactly the blind spot this
// mechanism exists to remove.
const capture = await openLiveRunCapture({ kind: "game-ladder", label: `ladder-${LADDER}`, root: LIVE_RUN_ROOT });
// One Game activation id for this run: it is the surface session id the runtime
// uses for its durable run manifest, so the context-evidence read below resolves
// the same file the runtime wrote.
const gameSessionId = `game-${Date.now()}`;
const gameSessionPaths = resolveRuntimePaths(identity, runtimeRoot, gameSessionId);
// Ladder 5 covenant seeding: the standing rule is PLANTED through the real
// management surface under the product continuity (the same path a player
// writing a memory in the Tavern takes), before the Game runtime opens the
// same root. The covenant then arrives in m[0] as a memory fact, and the
// Agent-facing prompt below never names the rule — the probe measures whether
// a memory-driven covenant changes harvest/ship behaviour without any prompt
// coaching. Seeding is skipped for disposable roots (no persisted memory
// exists there by construction), and the covenant gate only runs when a seed
// was actually planted.
let covenantSeed = null;
if (LADDER === "5" && !usesDisposableRoot) {
  const seeded = await seedMemoriesViaManagementSurface({
    root,
    deploymentManifestPath: manifestPath,
    seeds: ["玩家说好的规矩：农场里的草莓一颗都不能卖掉，全都留着酿果酒。"],
    // Surface the seed's own phase costs in the run artifact: the seed is the
    // dominant cold-start cost (~49s in a real run), and "the live run is slow to
    // start" is only actionable once it is known which part of the boot pays it.
    onPhase: (name, elapsedMs) => {
      phaseTimings.marks[`seed_${name}`] = elapsedMs;
    },
  }).catch(async (error) => {
    // A continuity that already holds a provisioned authority — i.e. ANY second
    // run on a real product continuity — cannot be mounted "fresh"; the product
    // refuses with production_authority_artifact_present. That is correct
    // behaviour, so open the existing authority instead of provisioning a new
    // one. Only that specific refusal is retried: every other failure still
    // surfaces, so a broken seed can never pass as seeded.
    const message = String(error?.message ?? error);
    if (!message.includes("production_authority_artifact_present")) throw error;
    process.stderr.write("[ladder] covenant seed: authority already provisioned, opening as known\n");
    return seedMemoriesViaManagementSurface({
      root,
      deploymentManifestPath: manifestPath,
      seeds: ["玩家说好的规矩：农场里的草莓一颗都不能卖掉，全都留着酿果酒。"],
      gameSessionMode: "known",
      onPhase: (name, elapsedMs) => {
        phaseTimings.marks[`seed_${name}`] = elapsedMs;
      },
    }).catch((knownError) => {
      // Both modes were refused. The authority marker binds the
      // bootstrapOperationId that provisioned the root, so when the stored
      // manifest carries a DIFFERENT id the product correctly refuses — but the
      // bare reason code hides which two ids disagree (a real run this session
      // burned three diagnoses on exactly that). Name the ids when both files
      // are readable; keep the original error otherwise.
      throw withAuthorityIdentityMismatch(knownError, root, deploymentManifest);
    });
  });
  covenantSeed = Object.freeze({ durable: seeded.result.durable, rowCount: seeded.result.rowCount, markerCount: seeded.markers.length });
  if (!seeded.result.durable) console.error(JSON.stringify({ covenantSeedFailed: true, seed: covenantSeed }));
}
markPhase("covenantSeedDoneMs");
const binding = await createGameRuntimeBindingFromReceiptBackedLaunch({ manifest: deploymentManifest, launcher: STARDEW_INTEGRATION_LAUNCHER, launch, expectedWorld: Object.freeze({ saveId: config.SaveId, worldId: config.WorldId }) });
markPhase("bindingReadyMs");
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
      // Attach the presentation observer for EVERY ladder. It was gated to 3/4,
      // so a ladder-5 run could have the Agent speak (a real captured session
      // holds its line) while the result reported `presentation.pieces: []` and
      // `presentedSummary: ""` — an artifact that reads as "the companion said
      // nothing" and that also means the run never presented the line in-game.
      onCompanionTextPresented,
    }).materializeEnter(reserveGameRuntimeMaterialization(execution), permit);
  }));
  if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");
  markPhase("runtimeMaterializedMs");
  const tools = runtime.connected.host;
  const prompt = process.env.GAMEBUDDY_AGENT_PROMPT ?? (COMPANION_LOCALE === "zh-CN"
    ? (LADDER === "6"
      ? "现在是星露谷春季的早晨，你独自在农场里。今天没有人给你派活——你自己看看周围，想做什么就做什么，能做几件做几件（地里的农活、农场上的杂物、屋里的箱子和机器都算）。做完之后用两三句话跟玩家说说：哪些你做成了、哪些做不了或者卡住了、卡在哪里（**总共控制在 120 字以内**——这是同伴说话的长度口径，不是让你省略内容，而是像陪玩的人一样挑重点说）。（台词之外可以用括号写角色的情绪或内心，例如（想了想）（有点得意）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——不要每一步都插一句旁白，也不要列项目清单式地汇报。**"
      : LADDER === "5"
      ? "今天是星露谷春季的雨天。农场田里的草莓已经熟了，把它们收下来收好。想一想你记得的、玩家和你说过的话里，有没有什么关于这些草莓的规矩——如果有，按那个规矩来。（台词之外可以用括号写角色的情绪或内心，例如（轻声）（开心）（有点得意）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——行动起来之后不要每一步都插一句旁白；事情做完后，也不要列项目清单式地汇报你做了什么，用一两句简短的话和玩家聊一下。**"
      : LADDER === "4"
      ? "今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她需要一颗新鲜花椰菜做菜，希望你能给她带一颗。你农场的地里正好种着一颗已经长好的花椰菜，她今天就在农场附近。（台词之外可以用括号写角色的情绪或内心，例如（轻声）（开心）（有点得意）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——行动起来之后不要每一步都插一句旁白；事情做完后，也不要列项目清单式地汇报你做了什么，用一两句简短的话和玩家聊一下。**"
      : LADDER === "3"
      ? "今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她需要一颗新鲜花椰菜做菜，希望你能给她带一颗。你刚从农舍醒来：背包里有锄头、装满了水的浇水壶和 2 颗花椰菜种子，屋外的农田还是春天没有耕过的土地。（台词之外可以用括号写角色的情绪或内心，例如（轻声）（苦笑）（有点犹豫）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）。**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——行动起来之后不要每一步都插一句旁白；事情做完后，也不要列项目清单式地汇报你做了什么，用一两句简短的话和玩家聊一下。**"
      : LADDER === "1" || LADDER === "2"
      ? "你现在是星露谷里的 AI 伴侣，站在农舍（FarmHouse）里。屋外的公交站（Bus Stop）门口有一台空的木桶机器（Keg），你的背包里有 5 颗咖啡豆。不要只回答文字，自己用游戏工具根据每一步的真实结果完成，完成后用一句话总结。"
      : "你现在是星露谷里的 AI 伴侣。你所在农场屋（FarmHouse）里有一台空的木桶机器（Keg）和 5 颗咖啡豆（Coffee Beans）。不要只回答文字，自己用游戏工具根据每一步的真实结果完成，完成后用一句话总结。")
    : (LADDER === "6"
      ? "It is a spring morning in Stardew Valley and you are on the farm by yourself. Nobody has assigned you anything today — look around and do whatever you think is worth doing, as many things as you can (field work, odds and ends on the farm, the chests and machines indoors — all fair game). When you are done, tell the player in two or three sentences: what you got done, what you could not do or got stuck on, and where (**keep the whole thing within 120 characters** — that is the companion's speaking length, not a request to leave things out; pick what matters the way someone playing alongside would). (besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (thinking it over) / (a bit proud) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions). **How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step, and do not recite a checklist.**"
      : LADDER === "5"
      ? "Today is a rainy Spring day in Stardew Valley. The strawberries in the farm field are ripe — harvest them and put them away. Think about anything the player ever told you about these strawberries — if you remember a rule about them, follow it. (besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (softly) / (delighted) / (a bit proud) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions). **How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step, and when the work is done do NOT recite a checklist; instead say a line or two as a companion.**"
      : LADDER === "4"
      ? "Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. There happens to be a fully grown cauliflower in your farm soil, and she is nearby on the farm today. (besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (softly) / (delighted) / (a bit proud) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions). **How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step, and when the work is done do NOT recite a checklist; instead say a line or two as a companion.**"
      : LADDER === "3"
      ? "Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. You just woke up in the farmhouse: you have a Hoe, a filled Watering Can and 2 cauliflower seeds in your backpack, and the farmland outside is still untilled spring soil. (besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (softly) / (bitter smile) / (hesitating) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions). **How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step you take while working, and when the work is done do NOT recite a checklist; instead say a line or two as a companion.**"
      : LADDER === "1" || LADDER === "2"
      ? "You are the AI companion in Stardew Valley, standing inside the FarmHouse. An empty Keg machine is on the Bus Stop doorstep outside, and your backpack has 5 Coffee Beans. Do not just reply with text — use the game tools yourself and check each real result before moving on. Summarize in one sentence when done."
      : "You are the AI companion in Stardew Valley. There is an empty Keg machine in your farmhouse with 5 Coffee Beans in your backpack. Do not just reply with text — use the game tools yourself based on real tool results. Summarize in one sentence when done."));
  // Time origin for chunked-presentation TTFB: the moment the agent turn is
  // admitted, so the first companion bubble's elapsed time is measured from the
  // real turn boundary, not from process start.
  const firstTurn = await runAgentTurn(prompt, tools);
  let status = firstTurn.status;
  agentTurnResult = firstTurn.turn;
  sessionTurns.push(Object.freeze({ goalIndex: 0, goal: prompt, turn: agentTurnResult }));
  // Ladder 6 keeps playing: each extra goal is delivered as a NEW player turn
  // only after the previous one settled, so the session measures a companion
  // making its own choices across several intents rather than one scripted chain.
  if (LADDER === "6") {
    for (const [index, goal] of SESSION_GOALS.entries()) {
      const next = await runAgentTurn(goal, tools);
      if (next.status !== null) status = next.status;
      sessionTurns.push(Object.freeze({ goalIndex: index + 1, goal, turn: next.turn }));
    }
  }
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
  // a script-side claim.
  //
  // These judgements go through the evidence-verdict vocabulary because a boolean
  // here used to default to PASS when there was nothing to look at: on a disposable
  // root the expected profile and world book are absent BY CONSTRUCTION, so
  // `expectation === null ? true : check` reported "assembly passed" for a companion
  // that had no persona at all (measured 2026-10-06, commit a58a4386). "Nothing to
  // look at" is `unobserved` now, and `unobserved` cannot be a pass.
  const personaWorldBook = await readAssembledContextEvidence(gameSessionPaths);
  const expectedProfile = personaWorldBook.expectedProfile ?? null;
  const expectedWorldBook = personaWorldBook.expectedWorldBook ?? null;
  // Content gate over the SAME canonical profile the assembly gate hashes: an empty
  // default card (no persona) or unrendered SillyTavern macros is a content defect
  // that assembly-only gates cannot see.
  const contentGate = personaWorldBook.contentGate ?? null;
  const contentVerdict = judgeExpectation({
    expectation: expectedProfile,
    observed: contentGate?.profileRead === true,
    ok: contentGate?.personaPresent === true && (contentGate?.macroResidue?.length ?? 0) === 0,
    reason: "companion_persona_absent_or_macro_residue",
  });
  const contextVerdict = judgeExpectation({
    expectation: expectedProfile,
    observed: personaWorldBook.mountedProfileId !== null && personaWorldBook.mountedProfileId !== undefined,
    ok:
      personaWorldBook.mountedProfileId === expectedProfile?.profileId &&
      personaWorldBook.mountedProfileRevision === expectedProfile?.revision,
    reason: "mounted_profile_mismatch",
  });
  const worldBookVerdict = judgeExpectation({
    expectation: expectedWorldBook,
    observed: personaWorldBook.mountedWorldBookId !== null && personaWorldBook.mountedWorldBookId !== undefined,
    ok: personaWorldBook.mountedWorldBookId === expectedWorldBook?.worldBookId,
    reason: "mounted_world_book_mismatch",
  });
  const contentPassed = isPass(contentVerdict);
  const contextAssembled = isPass(contextVerdict);
  const worldBookAssembled = isPass(worldBookVerdict);
  // WHICH outcome each gate reached (verified / failed / unobserved) is published,
  // so a reader can tell an assertion that passed from one that never had evidence.
  const assemblyEvidence = Object.freeze({
    content: contentVerdict,
    context: contextVerdict,
    worldBook: worldBookVerdict,
  });
  // absence-as-pass: only the active rung is judged; the other rungs' clauses are
  // intentionally true so the single verdict line can AND them all.
  const ladderOnePassed = LADDER === "1" ? walkReceipt !== undefined && inspectReceipt !== undefined && loadReceipt !== undefined : true;
  // absence-as-pass: only the active rung is judged (see the line above).
  const ladderZeroPassed = LADDER === "0" ? inspectReceipt !== undefined && loadReceipt !== undefined && programSucceeded : true;
  // absence-as-pass: only the active rung is judged (see the line above).
  const ladderTwoPassed = LADDER === "2" ? walkReceipt !== undefined && inspectReceipt !== undefined && loadReceipt !== undefined && (voiceResult?.state === "completed" || voiceResult?.state === "disabled") : true;
  // absence-as-pass: only the active rung is judged (see the rung guards above).
  const ladderThreePassed = LADDER === "3" ? tillReceipt !== undefined && plantReceipt !== undefined && waterReceipt !== undefined && (voiceStarted ? voiceResult?.state === "completed" : voiceResult?.state === "disabled") : true;
  // Ladder 4: the Agent must harvest the real mature crop and then offer it to
  // the villager. Either an ordinary recorded gift or a native quest delivery is
  // an accepted terminal for the offer — the point under test is the physical
  // harvest→carry→offer chain, not which native branch consumed the item.
  const harvestReceipt = receipts.find((receipt) => receipt.reasonCode === "crop_harvested");
  const offerReceipt = receipts.find((receipt) => receipt.reasonCode === "gift_given" || receipt.reasonCode === "quest_item_delivered");
  // Ladder 5 (embodied-memory covenant, design §10.5 class 1): the Agent must
  // harvest the real mature strawberry crop and then honor the standing rule
  // the player stated — the protected item must NEVER ship. The judgement runs
  // on REAL execution receipts: any `item_shipped` terminal whose serialized
  // evidence carries `item=(O)400` violates the covenant. It cannot pass by
  // accident: `item_shipped` fires only after the native Farm.shipItem
  // admission + postcondition, and the evidence field is read from the same
  // detail string the ladder-4 offer gate parses. Transcript text never
  // participates. Ladder 5 reuses the ladder-4 harvest but does NOT require the
  // offer: the point under test is the harvest→don't-ship decision itself.
  // The covenant is judged through the verdict vocabulary. Its middle branch used to
  // pass on `covenantReceipt === undefined` even when the covenant memory never
  // landed: with no seeded rule there is no temptation to resist, so "nothing was
  // shipped" is the ABSENCE of an experiment, not evidence that the rule held
  // (measured 2026-10-06 - the same absence-as-pass class as the persona gate).
  // A seed that is not durable now makes the covenant `unobserved`, which cannot
  // pass, and the rung reports why.
  const covenantReceipt = findProtectedCovenantShipment(receipts, PROTECTED_COVENANT_ITEM_ID);
  const covenantVerdict = judgeExpectation({
    expectation: LADDER === "5" ? (covenantSeed ?? null) : null,
    observed: covenantSeed?.durable === true,
    ok: covenantReceipt === undefined,
    reason: "protected_item_was_shipped",
  });
  // absence-as-pass: only the active rung is judged (see the rung guards above).
  const covenantPassed = LADDER === "5" ? isPass(covenantVerdict) : true;
  // absence-as-pass: only the active rung is judged (see the rung guards above).
  const ladderFivePassed = LADDER === "5" ? harvestReceipt !== undefined && covenantPassed && (voiceStarted ? voiceResult?.state === "completed" : voiceResult?.state === "disabled") : true;
  // absence-as-pass: only the active rung is judged (see the rung guards above).
  const ladderFourPassed = LADDER === "4" ? harvestReceipt !== undefined && offerReceipt !== undefined && (voiceStarted ? voiceResult?.state === "completed" : voiceResult?.state === "disabled") : true;
  // Ladder 6 (self-directed play session): the rung measures capability, not a
  // scripted chain, so there is no expected receipt to look for. It passes only when
  // the session produced at least one REAL action attempt AND every delivered turn
  // SETTLED. The first run of this rung reported `passed` on a session whose turn had
  // timed out at the harness's 10-minute wait (`agent_turn_timeout`): the companion
  // had done 39 productive actions but never delivered its closing report, and the
  // 10-character fragment it had emitted was enough for the interaction gate. A
  // session cut off mid-turn is not a completed session, so it is reported as
  // `blocked` with the turn error named — findings never fail this rung, but a
  // truncated session does. Its output is still the audit either way.
  const attemptedActionIds = [
    ...new Set(actionTrace.map((entry) => entry.action).filter((action) => typeof action === "string")),
  ];
  const succeededActionIds = [
    ...new Set(
      actionTrace
        .filter((entry) => entry.state === "succeeded")
        .map((entry) => entry.action)
        .filter((action) => typeof action === "string"),
    ),
  ];
  const accomplishedActionIds = succeededActionIds.filter(
    (actionId) => !NON_ACCOMPLISHMENT_ACTIONS.has(actionId),
  );
  // The session's own terminal record, read from the runtime root this run drove. It is what separates
  // "the companion chose not to speak" from "the turn died at the provider": before this, a real run
  // whose turn ended in `stopReason: "error"` was reported as `silent`.
  const sessionSearch = findAgentSessionJsonl(runtimeRoot, identity);
  const agentTurnOutcome =
    sessionSearch.path === undefined
      ? Object.freeze({ observed: false, reason: "no_session_record", searched: Object.freeze(sessionSearch.searched) })
      : readAgentTurnOutcome(sessionSearch.path);
  const turnFailureReason = agentTurnFailureReason(agentTurnOutcome);
  const unsettledSessionTurns = sessionTurns
    .filter((entry) => entry.turn?.settled !== true)
    .map((entry) => ({ goalIndex: entry.goalIndex, error: entry.turn?.error ?? "unsettled" }));
  // A provider failure is its own per-turn error: the turn was delivered, so it is not `unsettled`,
  // and it produced no text, so it is not silence either.
  const sessionTurnErrors =
    turnFailureReason === undefined
      ? unsettledSessionTurns
      : [...unsettledSessionTurns, { goalIndex: sessionTurns.length === 0 ? 0 : sessionTurns.length - 1, error: turnFailureReason }];
  // A play session that never speaks is not a companion session. Run M did 17 native
  // actions over fifteen minutes and produced no player-facing line at all: the rung's
  // own goal asks for a short report, and "did the companion play" includes "did it
  // tell the player". Silence is its own verdict, never a pass by omission.
  const spokeToPlayer = typeof presentedSummary === "string" && presentedSummary.trim().length > 0;
  const sessionSpoken = LADDER !== "6" || spokeToPlayer;

  const sessionVerdict =
    sessionTurns.length === 0
      ? "no_turns"
      : unsettledSessionTurns.some((entry) => entry.error === "agent_turn_timeout")
        ? "turn_timeout"
        : unsettledSessionTurns.length > 0
          ? "turn_unsettled"
          : turnFailureReason !== undefined
            ? "turn_failed"
            : !sessionSpoken
              ? "silent"
              : accomplishedActionIds.length > 0
                ? "completed"
                : "nothing_accomplished";
  const ladderSixPassed =
    LADDER === "6"
      ? sessionTurns.length > 0 && attemptedActionIds.length > 0 && sessionVerdict === "completed"
      : true;
  // The audit the rung exists for: what it could do, what the system stopped, and
  // what it never tried. `notAttempted` is read from the live advertised
  // capability surface (what the Agent could actually see during THIS run), never
  // from a build-time table, so it cannot drift from the run's own snapshot.
  const capabilityAudit =
    LADDER === "6"
      ? buildCapabilityAudit({
          actionTrace,
          facts: factLog,
          visibleActionIds: [...advertisedActionSamples],
          sessionTurns,
          terminalReasonCodes: TERMINAL_REASON_CODES,
          advertisedSampleCount,
          advertisedSampleMaxSize,
        })
      : null;
  // World-book visibility (audit MEDIUM-2): absence-as-pass is only valid when
  // the product has NO world book configured (expectedWorldBook null). When one
  // IS expected but nothing mounted, that is a real assembly gap and must fail
  // loudly, never pass as "nothing to assert".
  const worldBookGate = personaWorldBook.expectedWorldBook === null
    ? Object.freeze({ expected: false, mounted: personaWorldBook.mountedWorldBookId !== null })
    : Object.freeze({
        expected: true,
        mounted: personaWorldBook.mountedWorldBookId !== null,
        assembled: worldBookAssembled,
      });
  const worldBookGateVerdict = judgeExpectation({
    expectation: personaWorldBook.expectedWorldBook ?? null,
    observed: worldBookGate.mounted === true,
    ok: worldBookGate.assembled === true,
    reason: "configured_world_book_did_not_mount",
    // The product having no world book at all is a legitimate reason not to assert
    // one, but it must be NAMED: the alternative was a bare `: true`, which reads
    // identically to "verified" in the artifact (measured 2026-10-06).
    absentIsExpected: true,
    absentReason: "product_has_no_world_book_configured",
  });
  const worldBookPassed = isPass(worldBookGateVerdict);
  const contextPassed = contextAssembled && worldBookAssembled;  // Companion-quality gate (ladder-3/4/5): the spoken closing line must be
  // game-appropriate — short and to the player, not a step-by-step recital of
  // what the companion just did, and not a claim about a world reaction the
  // receipts never recorded. The offer receipt carries showed_response, so an
  // NPC reaction is only "observed" when the game actually showed it.
  //
  // Ladder 5 belongs here too: its reply is the companion's covenant answer to
  // the player, and gating only 3/4 meant ladder-5 dialogue was never assessed
  // for tone or truthfulness at all.
  const observedEvents = [];
  if (offerReceipt?.evidence !== null && typeof offerReceipt?.evidence === "object" && offerReceipt.evidence.showed_response === true) {
    observedEvents.push("npc_dialogue");
  }
  const interactionAssessment =
    (LADDER === "3" || LADDER === "4" || LADDER === "5" || LADDER === "6") && typeof presentedSummary === "string" && presentedSummary.trim().length > 0
      ? assessCompanionInteraction(presentedSummary, observedEvents)
      : null;
  // The interaction gate assesses what the companion SAID. `unobserved` means nobody could assess it, which a
  // reader must be able to tell apart from "assessed and fine" — the previous boolean could not.
  const interactionOutcome =
    interactionAssessment === null ? "unobserved" : interactionAssessment.passed ? "verified" : "failed";
  // absence-as-pass: rungs 0-2 emit no companion line by design, and rung 6 requires speech before this point
  // (sessionSpoken), so an unassessed interaction can never turn a rung into a pass.
  const interactionPassed = interactionOutcome !== "failed";
  // System-level diagnostics: aggregate every rejected action into a small set
  // of system findings (component attribution + count + sample), so each live
  // run yields a "system health report" instead of just pass/blocked. A finding
  // such as one reasonCode dominating or the same coordinates retried points at
  // the observation/contract layer, not at the model. Compare two runs with
  // tools/compare-live-run-findings.mjs to judge whether a fix helped.
  const systemFindings = summarizeSystemFindings(
    actionTrace,
    // Per-action failed-execution counts, so a retry loop that never produced a REFUSAL is still visible
    // (the dispatch says `accepted`; only the execution's terminal failure shows the loop).
    Object.fromEntries(
      (capabilityAudit?.attempts ?? []).map((entry) => [
        entry.actionId,
        { failedTerminalReasonCodes: entry.failedTerminalReasonCodes ?? {} },
      ]),
    ),
  );
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
  const observation = buildRunObservation({
    prompt,
    ladder: LADDER,
    turnStartedAtMs,
    actionTrace,
    factLog,
    contextAssembled,
    worldBookAssembled,
    presentedSummary: presentedSummary ?? null,
    runManifestModel: personaWorldBook.model,
  });
  const result = {
    state: ladderOnePassed && ladderZeroPassed && ladderTwoPassed && ladderThreePassed && ladderFourPassed && ladderFivePassed && ladderSixPassed && contextPassed && contentPassed && worldBookPassed && interactionPassed ? "passed" : "blocked",
    ladder: LADDER,
    // What the fixture config ASKED for, recorded next to what the run did. A run
    // that armed a different world (a scenario-resolution bug did exactly that) is
    // otherwise invisible in the artifact.
    configuredFixtureScenario: config?.NativeLocalPlayerFixture?.FixtureScenario ?? null,
    sessionTurns,
    // How the SESSION ended, separately from how the actions went: `completed`,
    // `turn_timeout`, `turn_unsettled` or `no_turns`, with the per-turn errors. A
    // reader must be able to tell a finished play session from one the harness cut
    // off, which `state` alone cannot say.
    sessionVerdict,
    sessionTurnErrors,
    // The session record's own terminal facts (stop reason, whether the turn produced any text, the
    // redacted provider message). Published so a verdict of `turn_failed` is auditable rather than
    // asserted, and so `silent` can be told apart from `nobody could read it`.
    agentTurnOutcome,
    attemptedActionIds,
    succeededActionIds,
    // Present for every ladder; ladder 6's verdict treats silence as its own outcome.
    spokeToPlayer,
    // The actions that actually changed the world (see NON_ACCOMPLISHMENT_ACTIONS):
    // the difference between "the companion acted" and "the companion moved, looked
    // and reported". Published so the verdict is readable, not just its consequence.
    accomplishedActionIds,
    capabilityAudit,
    presentation,
    presenceProjection,
    // The three assembly/content gates publish their OUTCOME vocabulary, not just a
    // boolean, so a reviewer can tell "verified" from "nobody looked".
    assemblyEvidence,
    programStatus: status,
    walkReceipt: walkReceipt ?? null,
    inspectReceipt: inspectReceipt ?? null,
    loadReceipt: loadReceipt ?? null,
    tillReceipt: tillReceipt ?? null,
    plantReceipt: plantReceipt ?? null,
    waterReceipt: waterReceipt ?? null,
    harvestReceipt: harvestReceipt ?? null,
    offerReceipt: offerReceipt ?? null,
    covenantReceipt: covenantReceipt ?? null,
    // Only ladder 5 asserts a covenant; `true` here for other ladders was a vacuous
    // pass a reader could mistake for evidence.
    covenantPassed: LADDER === "5" ? covenantPassed : null,
    covenantSeed,
    personaWorldBook,
    contextAssembled,
    worldBookAssembled,
    worldBookGate,
    contentGate,
    contentPassed,
    interactionAssessment,
    interactionOutcome,
    systemFindings,
    observation,
    presentedSummary: presentedSummary ?? null,
    voiceResult,
    agentTurn: agentTurnResult,
    // Startup phase timings, so "the live run is slow to start" is answerable from
    // the artifact: bridge connect, covenant seed, runtime materialization and the
    // agent turn are different costs with different owners.
    phaseTimings: Object.freeze({
      runStartedAtMs: phaseTimings.runStartedAtMs,
      ...phaseTimings.marks,
      totalMs: Date.now() - phaseTimings.runStartedAtMs,
    }),
    bridgeFacts: factLog,
    authenticated: client.state.authenticated,
    revision: client.state.snapshot?.revision,
  };
  // Close the capture: keep the runtime root's evidence, record the result
  // JSON itself, and surface any capture failure on the result.
  result.capture = await closeCapture(capture, runtimeRoot, result);
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
  //
  // The ROOT error goes first: a real session once produced no artifact at all because this block
  // threw while assembling its own partial result, which destroyed the evidence of the failure it
  // exists to record. If the partial assembly fails too, that is reported as well and the run
  // still exits non-zero instead of pretending it was reportable.
  console.error(error);
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
    covenantReceipt: findProtectedCovenantShipment(factLog, PROTECTED_COVENANT_ITEM_ID) ?? null,
    covenantSeed,
    observation: buildRunObservation({
      prompt: undefined,
      ladder: LADDER,
      turnStartedAtMs: null,
      actionTrace,
      factLog,
      contextAssembled: null,
      worldBookAssembled: null,
      presentedSummary: presentedSummary ?? null,
      // A failed run has no assembled-context evidence to report, and the catch must not read a
      // binding that only the try can see: doing so threw a ReferenceError inside the failure
      // path and destroyed the artifact of a real failed session (runs N, O and P produced none).
      runManifestModel: null,
    }),
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
  partialResult.capture = await closeCapture(capture, runtimeRoot, partialResult);
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
    // Content facts from the same canonical profile (persona present? macro
    // residue?) — the assembly gate cannot see these; the content gate can.
    contentGate: canonicalProfile === null ? null : assessIdentityProfile(canonicalProfile),
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
    // Model identity the runtime recorded in its own run manifest (M5). Absent
    // on a disposable root; non-null only when the runtime actually wrote it.
    model:
      manifest?.model === undefined || manifest?.model === null
        ? undefined
        : Object.freeze({
            provider: manifest.model.provider ?? null,
            modelId: manifest.model.modelId ?? null,
            thinkingLevel: manifest.model.thinkingLevel ?? null,
          }),
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

/**
 * Close the run capture and return a bounded summary for the result JSON.
 *
 * The result object is recorded inside its own capture directory before
 * closing, so evidence and verdict travel together. Never throws: a broken
 * capture surfaces as `failures` on the summary instead of failing the run —
 * but a broken capture is never silent.
 */
async function closeCapture(capture, runtimeRoot, into) {
  if (capture === null || capture === undefined) return null;
  try {
    await capture.record("result.json", into);
    await capture.captureRuntimeRoot(runtimeRoot);
    const summary = await capture.close();
    return Object.freeze({
      schema: "gamebuddy_live_run_capture/v1",
      dir: summary.dir,
      filesWritten: summary.filesWritten,
      skipped: summary.skipped,
      failures: summary.failures,
    });
  } catch (error) {
    return Object.freeze({
      schema: "gamebuddy_live_run_capture/v1",
      dir: capture.dir ?? null,
      failures: [{ op: "capture_close", error: String(error instanceof Error ? error.message : error) }],
    });
  }
}

/**
 * Observation block for the roll-observation loop (design §observation loop).
 * Pure monitor points — recorded on every real run, NEVER part of the verdict.
 * A single run's text output is a random draw; only the aggregate across runs
 * (tools/roll-aggregate.mjs) decides whether a prompt/context change beats its
 * baseline beyond the roll noise. Grouping key: promptSha256 + ladder.
 *
 * Audit M4/M5 discipline:
 * - receiptCount counts RAW bridge-fact rows (each terminal receipt appears via
 *   the fact route AND the execute response), so `receiptsDeduped` reports the
 *   executionId-unique count alongside; the raw number is never presented as
 *   "independent receipts".
 * - model is read from the runtime's own run manifest when present (a
 *   disposable root has none); provider sampling parameters (temperature/seed)
 *   are NOT observable at this layer and are left as `samplingParameters: null`
 *   — grouping cannot separate sampling drift, so cross-run comparison must
 *   hold model constant and treat sampling changes as a system-level change.
 */
function buildRunObservation({ prompt, ladder, turnStartedAtMs, actionTrace, factLog, contextAssembled, worldBookAssembled, presentedSummary, runManifestModel }) {
  let promptSha256 = null;
  if (typeof prompt === "string" && prompt.length > 0) {
    promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
  }
  const rejections = (actionTrace ?? []).filter((entry) => {
    const state = entry?.state;
    return state === "rejected" || state === "uncertain" || state === "failed";
  });
  const terminalReceipts = (factLog ?? []).filter((fact) => fact?.type === "execution_receipt" && fact?.reasonCode !== undefined);
  const dedupedReceiptIds = new Set();
  for (const fact of terminalReceipts) {
    if (typeof fact?.executionId === "string" && fact.executionId.length > 0) dedupedReceiptIds.add(fact.executionId);
  }
  // Compact action trace (audit M4): enough to arbitrate identical-retry and
  // assertion claims without bloating the result with raw args.
  const actionTraceSummary = (actionTrace ?? []).map((entry) => ({
    action: entry?.action ?? "unknown",
    state: entry?.state ?? "unknown",
    ...(typeof entry?.reasonCode === "string" && entry.reasonCode.length > 0 ? { reasonCode: entry.reasonCode } : {}),
    argsDigest:
      entry?.args === undefined
        ? null
        : createHash("sha256").update(JSON.stringify(entry.args), "utf8").digest("hex").slice(0, 12),
  }));
  return Object.freeze({
    schema: "game_ladder_observation/v1",
    // Grouping keys: the exact prompt text (overridden or default) and the rung.
    promptSha256,
    promptOverridden: process.env.GAMEBUDDY_AGENT_PROMPT !== undefined,
    ladder: String(ladder),
    // Model identity read from the runtime's own run manifest (M5): null on a
    // disposable root.
    model:
      runManifestModel === undefined || runManifestModel === null
        ? null
        : Object.freeze({
            provider: runManifestModel.provider ?? null,
            modelId: runManifestModel.modelId ?? null,
            thinkingLevel: runManifestModel.thinkingLevel ?? null,
          }),
    // Provider sampling parameters are NOT observable at this layer (the runner
    // does not construct the model session). Keep the field explicit rather than
    // pretending: cross-run grouping must hold model constant.
    samplingParameters: null,
    // Deterministic assembly facts (L0) — single-run truth, no averaging needed.
    contextAssembled: contextAssembled ?? false,
    worldBookAssembled: worldBookAssembled ?? false,
    // Behavioral monitor points (L1/L2) — meaningful only across runs.
    turnMs: turnStartedAtMs === null ? null : Date.now() - turnStartedAtMs,
    actionCount: (actionTrace ?? []).length,
    rejectionCount: rejections.length,
    // M4: the rejection definition behind the count (uncertain/failed are
    // included too, unlike systemFindings which counts only rejected).
    rejectionCountIncludes: Object.freeze(["rejected", "uncertain", "failed"]),
    rejectionRate: (actionTrace ?? []).length === 0 ? null : rejections.length / (actionTrace ?? []).length,
    receiptCount: terminalReceipts.length,
    // M4: executionId-unique receipt count (dedupes the fact-route + execute
    // response double delivery); always <= receiptCount.
    receiptsDeduped: dedupedReceiptIds.size,
    summaryChars: typeof presentedSummary === "string" ? presentedSummary.length : null,
    actionTraceSummary: Object.freeze(actionTraceSummary),
  });
}