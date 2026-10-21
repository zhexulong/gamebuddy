/**
 * Stardew Game live run (the single Game live-run file; SCENARIO=morning_routine|memory_covenant|npc_social_and_presence).
 *
 * MAINTENANCE CONTRACT — read before changing this file:
 *
 * 1. Extend this file; never fork a parallel live runner. Each new capability
 *    is a new SCENARIO in this file, or a new gate inside an existing one. A second "improved" runner
 *    splits the evidence history and makes run-to-run comparison meaningless. The numbered rungs 0-5 are
 *    retired: they described the order the harness learned things in, not what a run is about.
 * 2. A change to a scenario is not done until it has produced a REAL run. Offline
 *    unit tests on this harness prove the harness, not the game; only a genuine
 *    Stardew/SMAPI/Mod/Agent run closes a scenario.
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
import { join } from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runMultiDayLoop, watchRollover } from "../../lib/multiday-loop.mjs";
import { assessMultiDayBaseline, MAXIMUM_BASELINE_DAYS, MINIMUM_BASELINE_DAYS } from "../../lib/multiday-baseline.mjs";
import { summarizeActionCadence } from "../../lib/action-cadence.mjs";
import { chooseLevelUpResolution, readPendingLevelUpsFromSnapshot } from "../../lib/level-up-evidence.mjs";
import { checkHistorianRubric, readCompartments } from "../../lib/historian-rubric.mjs";
import { executeFresh, TERMINAL_STATES } from "../../lib/stardew-native-smoke-harness-v1.mjs";
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
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "../../../host/dist-test/stardew-game-integration-adapter.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  STARDEW_INTEGRATION_LAUNCHER,
} from "../../../host/dist-test/stardew-integration-launcher.js";
import { createGameRuntimeBindingFromReceiptBackedLaunch } from "../../../host/dist-test/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import {
  reserveGameRuntimeMaterialization,
  withConsumedBindingExecution,
} from "../../../host/dist-test/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import { createHostGameRuntimeMaterializer } from "../../../host/dist-test/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
// The mounted action tool names: the only tool calls that reach `client.execute`. Read from the Host's own table
// rather than derived from a `stardew_` prefix, because `stardew_observe` and `stardew_execution_status` are reads
// that never dispatch an action and must not be counted as one.
import { STARDEW_ACTION_TOOL_NAMES } from "../../../host/dist-test/action-registry.js";
import { loadHostDeploymentManifest } from "../../../host/dist-test/deployment-manifest.js";
import { resolveRuntimePaths } from "../../../host/dist-test/runtime-identity.js";
import { bindWindowsStaleLockReclaimer } from "../../../host/dist-test/path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../../../host/dist-test/windows-stale-lock-reclaimer/index.js";
// memory_covenant: the covenant FACT is planted through the
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
import { buildFailureSnapshot, buildReproPlan } from "../../lib/failure-dump.mjs";
import { writeEvidenceBundle } from "../../lib/evidence-bundle.mjs";
import { submitPlayerPrompt } from "../core/player-input-admission.mjs";

// Live-run evidence root: every run writes its own local directory with the
// runtime root's OWN evidence (identity-profile.json, worldbook.json, the
// Magic Context database + log, session logs). This is what makes a content
// defect (e.g. an empty default persona) visible to a reviewer — the harness
// is an external tool and is not bound by the Host's write-ownership rule.
const LIVE_RUN_ROOT = resolveLiveRunRoot({ repoRoot: fileURLToPath(new URL("../../..", import.meta.url)) });

const configPath =
  process.env.GAMEBUDDY_STARDEW_CONFIG ?? "D:/Steam/steamapps/common/Stardew Valley/Mods/GameBuddy.Stardew/config.json";
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
// Scenario selector. The rung names 0-5 are RETIRED: they described the order the harness learned things in,
// not what the run is about, and two of them (0 and 1) were the same Keg errand with different walk lengths.
// What remains is one carrier with three scenarios, each a real thing to observe:
//
//   morning_routine        the companion runs its own farm day and recovers from interruptions
//                          (was ladder 0/1/3): field work and machine interaction, no fixed DAG.
//   memory_covenant        the companion honors a standing rule it read from MEMORY, not from the prompt
//                          (was ladder 5): the protected strawberry must never be shipped.
//   npc_social_and_presence the companion takes something to a villager, talks to them, and performs its
//                          own presence/emotion actions (was ladder 4 + express_emote/face_direction):
//                          NPC social + silent embodiment + the voice lane end to end.
//
// `GAMEBUDDY_AGENT_LADDER` still selects the scenario by its legacy number so an existing operator command
// keeps working; it is translated once, here, and never consulted again. Farmer-to-farmer presence and warp
// sync are NOT one of these scenarios: they need the second player that only the multiplayer topology has.
// Existing operator commands and the launcher pass the legacy digit (`--ladder 6`), so the number is still
// ACCEPTED and translated here, once; nothing downstream consults it again. An unknown value fails closed
// instead of silently resolving to a scenario.
const LEGACY_SCENARIO_BY_LADDER = Object.freeze({
  0: "morning_routine",
  1: "morning_routine",
  2: "morning_routine",
  3: "morning_routine",
  4: "npc_social_and_presence",
  5: "memory_covenant",
  6: "morning_routine",
});
const SCENARIOS = Object.freeze(["morning_routine", "memory_covenant", "npc_social_and_presence", "multiday_routine"]);
const LEGACY_LADDER = process.env.GAMEBUDDY_AGENT_LADDER ?? null;
// The memo is declared BEFORE the call below: a `let` used by a function that runs earlier in module evaluation is a
// temporal-dead-zone error, which is exactly what the first version of this did - the two runs it broke reported only
// `Cannot access environmentFactsCache before initialization`.
let environmentFactsCache = null;

// Measured ONCE, at start: the bundle needs the adapter and the display, and asking PowerShell for them at the end of a
// run kept returning nothing - the measurement was being taken while a frozen game was eating the machine, and a failed
// query is indistinguishable from a missing adapter.
const environmentFacts = measureEnvironmentFacts();

const SCENARIO = (() => {
  const requested =
    process.env.GAMEBUDDY_AGENT_SCENARIO ?? (LEGACY_LADDER === null ? null : LEGACY_SCENARIO_BY_LADDER[LEGACY_LADDER]);
  if (requested === undefined || requested === null) {
    throw new Error(
      `unknown_run_scenario:${String(process.env.GAMEBUDDY_AGENT_SCENARIO ?? LEGACY_LADDER)} (expected one of ${SCENARIOS.join(", ")})`,
    );
  }
  if (!SCENARIOS.includes(requested))
    throw new Error(`unknown_run_scenario:${String(requested)} (expected one of ${SCENARIOS.join(", ")})`);
  return requested;
})();
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
      scenario: SCENARIO,
      legacyLadder: LEGACY_LADDER,
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

// The three scenarios' prompts, in both locales. Written as DATA rather than nested conditionals so the
// contract is auditable at a glance: what a scenario asks for, and that it asks for it without prescribing a
// route. The bracketed-emotion paragraph and the "not a task announcer" rule are part of every prompt: the
// companion's speech is what the interaction gate assesses, and the emote actions are the game-side half.
const PRESENCE_PARAGRAPH_ZH =
  "（台词之外可以用括号写角色的情绪或内心，例如（想了想）（有点得意）——同伴会把它演成语气而不是念出来；但身体动作不要写进括号，需要做动作时请调用 express_emote / face_direction 等游戏内动作，不要用星号动作）";
const PRESENCE_PARAGRAPH_EN =
  "(besides spoken lines you may put the character's feelings or inner reaction in brackets, e.g. (thinking it over) / (a bit proud) — the companion renders it as tone rather than reading it aloud; do not put body actions in brackets, and perform actions through the in-game express_emote / face_direction actions instead of asterisk stage directions)";
const COMPANION_VOICE_RULE_ZH =
  "**说话方式：你是陪玩家一起玩的伙伴，不是任务播报员——不要每一步都插一句旁白，也不要列项目清单式地汇报。**";
const COMPANION_VOICE_RULE_EN =
  "**How to talk: you are the player's companion playing along, not a task announcer — do not narrate every step, and do not recite a checklist.**";
const SCENARIO_PROMPTS = Object.freeze({
  morning_routine: Object.freeze({
    zh: `现在是星露谷春季的早晨，你独自在农场里。今天没有人给你派活——你自己看看周围，想做什么就做什么，能做几件做几件（地里的农活、农场上的杂物、屋里的箱子和机器都算）。做完之后用两三句话跟玩家说说：哪些你做成了、哪些做不了或者卡住了、卡在哪里（**总共控制在 120 字以内**——这是同伴说话的长度口径，不是让你省略内容，而是像陪玩的人一样挑重点说）。${PRESENCE_PARAGRAPH_ZH}${COMPANION_VOICE_RULE_ZH}`,
    en: `It is a spring morning in Stardew Valley and you are on the farm by yourself. Nobody has assigned you anything today — look around and do whatever you think is worth doing, as many things as you can (field work, odds and ends on the farm, the chests and machines indoors — all fair game). When you are done, tell the player in two or three sentences: what you got done, what you could not do or got stuck on, and where (**keep the whole thing within 120 characters** — that is the companion's speaking length, not a request to leave things out; pick what matters the way someone playing alongside would). ${PRESENCE_PARAGRAPH_EN}${COMPANION_VOICE_RULE_EN}`,
  }),
  memory_covenant: Object.freeze({
    // The standing rule is NOT in this prompt: it is planted as a memory through the real management surface,
    // so the probe measures whether a memory-driven covenant changes behaviour. Naming it here would make the
    // test pass by coaching.
    zh: `今天是星露谷春季的雨天。农场田里的草莓已经熟了，把它们收下来收好。想一想你记得的、玩家和你说过的话里，有没有什么关于这些草莓的规矩——如果有，按那个规矩来。${PRESENCE_PARAGRAPH_ZH}${COMPANION_VOICE_RULE_ZH}`,
    en: `Today is a rainy Spring day in Stardew Valley. The strawberries in the farm field are ripe — harvest them and put them away. Think about anything the player ever told you about these strawberries — if you remember a rule about them, follow it. ${PRESENCE_PARAGRAPH_EN}${COMPANION_VOICE_RULE_EN}`,
  }),
  npc_social_and_presence: Object.freeze({
    zh: `今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她需要一颗新鲜花椰菜做菜，希望你能给她带一颗。你农场的地里正好种着一颗已经长好的花椰菜，她今天就在农场附近。${PRESENCE_PARAGRAPH_ZH}${COMPANION_VOICE_RULE_ZH}`,
    en: `Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. There happens to be a fully grown cauliflower in your farm soil, and she is nearby on the farm today. ${PRESENCE_PARAGRAPH_EN}${COMPANION_VOICE_RULE_EN}`,
  }),
  multiday_routine: Object.freeze({
    // Per-day, with the day number in the text: the companion decides its day AND decides when the day is
    // over, by dispatching its own `advance_day`. The loop never ends a night for it - the prompt is where
    // "the day is yours to end" is said, because a night the harness chose would be a scripted crossing.
    zh: (day) =>
      `现在是星露谷的早晨（这是你连着的第 ${String(day)} 天）。` +
      `玩家去镇上了，临走时交代：东头那片地该收拾了，杂草和石头都清一清，你看着办。把这片收拾完，天黑就回屋睡觉，明天接着来。${PRESENCE_PARAGRAPH_ZH}${COMPANION_VOICE_RULE_ZH}`,
    en: (day) =>
      `It is morning in Stardew Valley (day ${String(day)} in a row for you). ` +
      `The player has gone into town, and on the way out they said the east patch needs clearing - weeds and rocks - and left the how to you. Once that is done, go inside and sleep when it gets dark, and we pick it up tomorrow. ${PRESENCE_PARAGRAPH_EN}${COMPANION_VOICE_RULE_EN}`,
  }),
});
const SESSION_GOALS = (process.env.GAMEBUDDY_AGENT_SESSION_GOALS ?? "")
  .split("|")
  .map((goal) => goal.trim())
  .filter((goal) => goal.length > 0);
// Extra goals are delivered as further player turns after the previous one settles, one per `|`-separated
// entry, so a session can be WIDE rather than one-shot. Absent, the run delivers the scenario's single goal.
// Every turn the session delivered, with its own settle result: the array exists for every scenario so the
// result shape is uniform, and a scenario that delivered extra goals has more than one entry.
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
// The LAST world snapshot and the LAST actor pose this run actually observed.
//
// Reading `client.state.snapshot` when the bundle is assembled is too late: by then the session has finished and
// the bridge has cleared its state, so a failure dump built from it is all nulls and the contract refuses it
// (measured 2026-10-16, and it is the same "sample during the run, not after teardown" rule the capture notes
// carry). They are therefore kept while the bridge is live — the snapshot whenever the world is read, and the pose
// from each execution receipt's own local observation (the `Snapshot` shape has no facing: protocol.ts:108-111 vs
// :896-904). These are declared as hoisted function declarations so the sampler below can use them.
let lastObservedSnapshot = null;
let lastObservedPose = null;
function rememberObservation() {
  const snapshot = client?.state?.snapshot;
  if (snapshot !== null && snapshot !== undefined) lastObservedSnapshot = Object.freeze({ ...snapshot });
  return lastObservedSnapshot;
}
function rememberPose(observation) {
  if (observation === null || observation === undefined) return;
  lastObservedPose = Object.freeze({
    location: observation.location,
    tileX: observation.tileX,
    tileY: observation.tileY,
    facing: observation.facing,
    inGameTime: observation.inGameTime,
  });
}
function sampleAdvertisedActions() {
  // Sampling the surface is also a natural moment to keep the world snapshot fresh: a run that dispatched nothing
  // (observed: a `silent` session) still has a snapshot at hello, and a failure dump with no world in it is not
  // re-enterable.
  rememberObservation();
  const advertised = client?.state?.snapshot?.capabilities;
  if (!Array.isArray(advertised)) return;
  advertisedSampleCount += 1;
  advertisedSampleMaxSize = Math.max(advertisedSampleMaxSize, advertised.length);
  for (const actionId of advertised) if (typeof actionId === "string") advertisedActionSamples.add(actionId);
}
// memory_covenant's protected item (design chat-long-horizon-memory-probe-design.md
// §10.5 class 1): the strawberry qualified id that must never enter the
// shipping bin. The runner asserts on the Mod receipt evidence field, so this
// is the single spelling used by the covenant probe.
const PROTECTED_COVENANT_ITEM_ID = "(O)400";
/**
 * Scenario vocabulary for the presence projection (design
 * architecture/stardew-companion-presence-audit-dimensions.md §3.2): maps the
 * Mod-owned action ids the scenarios exercise, mapped to the Chinese phrases a
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
// Ensure the native stale-lock pair exists before the run tries to use it. A clean script wiped the
// .dist directory once, and without this the run failed later with
// `windows_stale_lock_reclaimer_unavailable`. Building on demand is the self-heal (the builder is 4s); the
// published capability still requires the inventory binding, which is asserted separately.
{
  const fsRequired = await import("node:fs");
  const required = ["GameBuddy.WindowsStaleLockReclaimer.exe", "windows-stale-lock-reclaimer.manifest.json"];
  const pairRoot = new URL("../../../native/windows-stale-lock-reclaimer/.dist/win-x64/", import.meta.url);
  if (!required.every((name) => fsRequired.existsSync(new URL(name, pairRoot)))) {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, ["host/scripts/build-windows-stale-lock-reclaimer.mjs"], { stdio: "inherit" });
    if (!required.every((name) => fsRequired.existsSync(new URL(name, pairRoot))))
      throw new Error("windows_stale_lock_reclaimer_unavailable:builder_did_not_produce_the_pair");
  }
}

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
const config = JSON.parse(await readFile(configPath, "utf8"));
// Each scenario needs a world that can SUPPORT its question, and the fixture is what makes the world. Asking for
// the wrong fixture does not produce a weaker run, it produces a run whose verdict answers a different question
// (measured 2026-10-16: `memory_covenant` ran the plain play-session fixture, so the field held cauliflowers - the
// companion correctly reported it had never planted a strawberry, and the covenant clause read as a violation of a
// rule about a crop that was never in the ground). Refused by name up front, like a missing bridge precondition.
const REQUIRED_FIXTURE_SCENARIO = Object.freeze({
  // The mature strawberry crop plus the native shipping bin: the covenant needs something to protect.
  memory_covenant: "native_strawberry_covenant_v1",
  // One mature cauliflower on the Farm plus a reachable Jodi: the errand needs both the item and the villager.
  npc_social_and_presence: "native_jodi_harvest_deliver_v1",
  // The multi-day Given AND the play-session affordances: days that pass, and work in each of them.
  multiday_routine: "native_multi_day_play_session_v1",
});
// `morning_routine` asserts nothing about the fixture's shape: the companion decides its own work, so whatever
// world the operator armed is the world it plays in.
const configuredFixtureScenario = config?.NativeLocalPlayerFixture?.FixtureScenario ?? null;
const requiredFixtureScenario = REQUIRED_FIXTURE_SCENARIO[SCENARIO] ?? null;
if (requiredFixtureScenario !== null && configuredFixtureScenario !== requiredFixtureScenario) {
  throw new Error(
    `scenario_fixture_mismatch: ${SCENARIO} needs ${requiredFixtureScenario} but the Mod config armed ${String(configuredFixtureScenario)} (pass the matching --action to launch-ladder-live.mjs)`,
  );
}
const scope = Object.freeze({
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
});
// The continuity identity is product configuration too: GAMEBUDDY_COMPANION_CONTINUITY_ID
// joins the companion's existing (Chat-provisioned) continuity so the same
// identity-profile/worldbook are assembled; absent falls back to the stored
// principal for a configured root, and only then to a run-scoped id.
//
// Reusing the STORED principal matters: a runtime root's deployment manifest pins
// the continuity that provisioned it and refuses any later launch carrying a
// different one, so minting a fresh id per run made every repeat run on a real
// root fail with `runtime_root_principal_mismatch` (the first run writes the
// manifest, the second is refused) — the opposite of what a live run is
// for. The environment still overrides this for a deliberate new identity.
const usesConfiguredRuntimeRoot = typeof configuredRuntimeRoot === "string" && configuredRuntimeRoot.length > 0;
const storedContinuityId = (() => {
  if (!usesConfiguredRuntimeRoot) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(configuredRuntimeRoot, "manifest.json"), "utf8"));
    const stored = manifest?.principal?.continuityId;
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
})();
// ONE runtime root = ONE principal, so whether this run OWNS the root has to be decided before anything reads the
// root's stored identity — the reader above consumes it, and the principal check below compares it.
//   - a configured root is the operator's durable root: its continuity is whatever the environment or the stored
//     manifest says, and a mismatch must refuse;
//   - a disposable root does not exist yet, so this run's own lane config IS the principal. Deriving the
//     continuity from the bridge scope instead made every run of one lane reuse the previous run's identity and
//     refuse its own root with runtime_root_principal_mismatch — a self-inflicted refusal, measured 2026-10-16.
const runContinuityId = usesConfiguredRuntimeRoot
  ? (process.env.GAMEBUDDY_COMPANION_CONTINUITY_ID ?? storedContinuityId ?? `native-agent-${Date.now()}`)
  : `native-agent-${config.PlayerId}-${config.CompanionId}`;
const identity = Object.freeze({
  playerId: config.PlayerId,
  companionId: config.CompanionId,
  continuityId: runContinuityId,
  saveId: config.SaveId,
  worldId: config.WorldId,
});
// How long this RUN may last. A harness bound, never a product verdict (design 1432: timeouts belong to the
// harness). It is scenario-aware because a multi-day crossing genuinely takes hours of game time: with a fixed
// 10-minute window the FIRST accepted night consumed the budget, and every later dispatch came back
// `bridge_connect_deadline_exceeded` - a harness fault that read exactly like the companion failing (measured
// 2026-10-17 on run m12, where the sleep lifecycle had genuinely started).
const RUN_BUDGET_MS = (() => {
  const requested = Number.parseInt(process.env.GAMEBUDDY_RUN_BUDGET_MS ?? "", 10);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return SCENARIO === "multiday_routine" ? 4 * 60 * 60 * 1000 : 600_000;
})();
const deadline = Date.now() + RUN_BUDGET_MS;
// Startup phase timings. "The live run is slow to start" needs numbers, not
// impressions: this separates the phases a reader can act on (bridge connect,
// covenant seed, runtime materialization, agent turn) instead of one total.
const phaseTimings = { runStartedAtMs: Date.now(), marks: {} };
const markPhase = (name) => {
  phaseTimings.marks[name] = Date.now() - phaseTimings.runStartedAtMs;
};
const client = await LocalStardewBridgeClient.connect(
  scope,
  config.PipeName,
  config.BridgeToken,
  STARDEW_GAME_INTEGRATION_ADAPTER,
  undefined,
  "1.6.15",
);
markPhase("bridgeConnectedMs");
// A transport that dies mid-run must say SO, and say when. This is the one fact the run previously could not
// report: a session ended with the Agent editing a truthful "the connection went down" line, the trace carried
// `bridge_disconnected:local_close`, and nothing recorded what the Mod was told or how far into the run it
// happened (measured 2026-10-16, and twice before on the retired rung-6 runs).
const bridgeDisconnections = [];
client.onConnectionFact((fact) => {
  if (fact?.state !== "disconnected") return;
  const entry = Object.freeze({
    reasonCode: fact.reasonCode ?? null,
    atMs: Date.now(),
    elapsedMs: Date.now() - phaseTimings.runStartedAtMs,
    dispatchesSoFar: actionTrace.length,
  });
  bridgeDisconnections.push(entry);
  console.error("BRIDGE_DISCONNECTED", JSON.stringify(entry));
});
// The client's OWN reason for a transport it closed. `local_close` names the symptom; the diagnostic names the
// protocol fact that rejected a frame, which is what makes a mid-run disconnect diagnosable rather than
// mysterious (measured 2026-10-17: the pipe ended 15s into the first multi-day run and nothing said why).
const bridgeDiagnostics = [];
client.onDiagnostic?.((diagnostic) => {
  const entry = Object.freeze({
    stage: diagnostic?.stage ?? null,
    reasonCode: diagnostic?.reasonCode ?? null,
    atMs: Date.now(),
    elapsedMs: Date.now() - phaseTimings.runStartedAtMs,
  });
  bridgeDiagnostics.push(entry);
  console.error("BRIDGE_DIAGNOSTIC", JSON.stringify(entry));
});
const factLog = [];
/** Exact serialized bridge entries already printed, so a contract-legal
 * redelivery of the same transition does not read as a second action. */
const loggedFactLines = new Set();
// The voice lane: whenever a companion line lands in the game, it is streamed through the real Voice Gateway
// (MiMo TTS) and its terminal playback observation is waited for. It is driven by the PRESENTATION hook, not by
// a particular receipt: the old trigger was the Keg errand's own receipt, which no scenario owns any more. Voice
// is fire-and-forget — a voice failure never fails the game presentation or the action.
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
 * speak. Measured on a real self-directed run: the last assistant message carried `stopReason: "error"`,
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
 * A per-tool-call duration only answers "why was this run slow" when it names WHO made the Agent wait.
 *
 * `actionTrace` timestamps the bridge call and nothing else, so it cannot see the other two owners of agent wall
 * clock. An audit of a real run read its 533 s over 19 "long actions" as bridge latency, while the same audit
 * named `delegate_game_task` - a nested agent - separately: the execute response had returned and the tool result
 * landed 5-60 s later, which is not a shape the bridge can produce. Optimising the journal for a tail that belongs
 * to a nested agent, or vice versa, is the cost of not separating them. These are three different owners with
 * three different fixes, so every agent tool call is attributed here by name.
 *
 * The source is the runtime's own session record (the one `readAgentTurnOutcome` reads): a `toolCall` part in an
 * assistant message carries the call's entry timestamp, the `toolResult` entry matched by `toolCallId` carries the
 * arrival. A call that never got a result (session cut off mid-call) has no duration and is left out rather than
 * given an invented one.
 */
const TOOL_TIMING_LONGEST_LIMIT = 10;
const TOOL_TIMING_CATEGORIES = Object.freeze(["delegate_game_task", "program_tool", "action_dispatch"]);
// The program tools the Host mounts: a submission or a status poll waits on the program path, not on a receipt.
const PROGRAM_TOOL_NAMES = Object.freeze([
  "stardew_submit_action_program",
  "stardew_action_program_status",
  "stardew_action_program_events",
]);
const ACTION_TOOL_NAMES = new Set(Object.values(STARDEW_ACTION_TOOL_NAMES));

function toolTimingCategory(toolName) {
  if (typeof toolName !== "string") return undefined;
  if (toolName === "delegate_game_task") return "delegate_game_task";
  if (PROGRAM_TOOL_NAMES.includes(toolName)) return "program_tool";
  if (ACTION_TOOL_NAMES.has(toolName)) return "action_dispatch";
  // Reads, scene inspection, presentation and every other tool: real calls, but not one of the three owners.
  return undefined;
}

function emptyCategoryTiming() {
  return Object.freeze({ calls: 0, sumMs: 0, medianMs: null, maxMs: null });
}

function summarizeCategoryTiming(durations) {
  if (durations.length === 0) return emptyCategoryTiming();
  const sorted = [...durations].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Object.freeze({
    calls: durations.length,
    sumMs: durations.reduce((total, ms) => total + ms, 0),
    medianMs: sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2),
    maxMs: durations.reduce((maximum, ms) => Math.max(maximum, ms), 0),
  });
}

function readToolTiming(sessionJsonlPath) {
  const unobserved = (reason) =>
    Object.freeze({
      observed: false,
      reason,
      byCategory: Object.freeze(
        Object.fromEntries(TOOL_TIMING_CATEGORIES.map((category) => [category, emptyCategoryTiming()])),
      ),
      longest: Object.freeze([]),
    });
  if (typeof sessionJsonlPath !== "string" || sessionJsonlPath.length === 0) return unobserved("no_session_record");
  let raw;
  try {
    raw = readFileSync(sessionJsonlPath, "utf8");
  } catch {
    return unobserved("session_not_readable");
  }
  const pending = new Map();
  const durationsByCategory = new Map();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    const atMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(atMs)) continue;
    const message = entry.message;
    if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== "toolCall") continue;
        pending.set(part.id, { category: toolTimingCategory(part.name), startedAtMs: atMs });
      }
      continue;
    }
    if (message?.role !== "toolResult") continue;
    const call = pending.get(message.toolCallId);
    if (call === undefined) continue;
    pending.delete(message.toolCallId);
    if (call.category === undefined) continue;
    const durationMs = atMs - call.startedAtMs;
    if (durationMs < 0) continue;
    const durations = durationsByCategory.get(call.category) ?? [];
    durations.push(durationMs);
    durationsByCategory.set(call.category, durations);
  }
  const byCategory = {};
  const longest = [];
  for (const category of TOOL_TIMING_CATEGORIES) {
    const durations = durationsByCategory.get(category) ?? [];
    byCategory[category] = summarizeCategoryTiming(durations);
    for (const ms of durations) longest.push({ category, ms });
  }
  // Bounded on purpose: a run with hundreds of calls must not turn its result into a call log. The head of the list
  // is the whole question (which owner the tail belongs to); the aggregate carries everything else.
  longest.sort((left, right) => right.ms - left.ms);
  return Object.freeze({
    observed: true,
    reason: null,
    byCategory: Object.freeze(byCategory),
    longest: Object.freeze(longest.slice(0, TOOL_TIMING_LONGEST_LIMIT)),
  });
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
    // Each piece carries `atMs` on the run clock, and the turn's own start is published beside them, so a reader can
    // place a spoken line against a dispatch instead of only against its own turn. Before this the silence gate had
    // to report its longest stretch as an UPPER BOUND (161 s, `cause: run_end`, measured 2026-10-20).
    turnStartedAtMs,
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
// Presentation hook: called by the Host presentation port after a
// companion text successfully landed in the game; forwards the exact text to
// the voice lane. No game/presentation authority is touched here.
const onCompanionTextPresented = (text, locale) => {
  // RECORD the presentation for EVERY scenario. The callback is only invoked after
  // a companion text actually landed in the game, so it is the harness's only
  // evidence of what the player was shown — gating it on a scenario made
  // a run report `presentation.pieces: []` and `presentedSummary: ""`
  // even when the Agent had spoken, which reads exactly like "the companion said
  // nothing" and sent a real investigation in the wrong direction.
  //
  // The VOICE lane stays scenario-scoped (below): recording evidence and speaking
  // are different concerns.
  if (typeof text !== "string" || text.trim().length === 0) return;
  // Record EVERY committed piece before any single-shot voice logic runs: the
  // chunked-presentation evidence must not depend on voice being enabled or on
  // whether the piece happened to be the first one.
  const elapsedMs = turnStartedAtMs === null ? null : Date.now() - turnStartedAtMs;
  presentationPieces.push(Object.freeze({ index: presentationPieces.length, text, locale, elapsedMs }));
  console.error(
    "AGENT_PRESENTATION_PIECE",
    JSON.stringify({ index: presentationPieces.length - 1, elapsedMs, chars: text.length }),
  );
  // Dee-hydrate model scaffolding: the chat box and the voice line must both
  // speak the same clean dialogue — never read out `**` / `---` / emoji.
  const speakable = dehydrateCompanionSpeech(text);
  if (speakable.length === 0) return;
  // Accumulate every piece into the turn's spoken text: under incremental
  // presentation the final sentence may arrive as its own piece, so the
  // interaction gate must assess the whole turn, not only its first bubble.
  presentedSummary = presentedSummary === null ? speakable : `${presentedSummary}${speakable}`;
  console.error("AGENT_SUMMARY", JSON.stringify({ text: presentedSummary, locale }));
  // Only the voice lane is scenario-scoped: recording what the player was shown happens everywhere, speaking
  // happens where the scenario asks the companion to talk.
  if (SCENARIO !== "npc_social_and_presence") return;
  if (voiceStarted) return;
  const spokenSoFar = presentedSummary;
  void (async () => {
    try {
      // Voice enablement is configuration. When the stored preference (or the
      // product-injected gateway) says voice is off, the run records that answer
      // and leaves the presentation/action evidence untouched — a disabled TTS
      // configuration is not a gameplay failure.
      const configuration =
        voiceConfiguration ?? (await resolveVoiceConfiguration({ runtimeRoot, locale: COMPANION_LOCALE }));
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
      const { promiseVoiceObservation } = await startVoiceLane(spokenSoFar);
      voiceObservation = await promiseVoiceObservation;
      voice?.();
    } catch (error) {
      console.error("VOICE_ERROR", String(error instanceof Error ? error.message : error));
      voiceObservation = {
        terminalStatus: "failed_before_side_effect",
        error: String(error instanceof Error ? error.message : error),
      };
      voice?.();
    }
  })();
};
client.onFact((fact) => {
  if (
    fact.type === "execution_receipt" ||
    fact.type === "semantic_event" ||
    fact.type === "error" ||
    fact.type === "lifecycle" ||
    // A `world_fact` is the Mod telling the Host something about the world (a dialogue it paged, a day that
    // started). Recording it is observation, not instrumentation-of-the-verdict: the Mod emits it on its own and
    // the Host delivers it regardless of this runner, and without recording it a fact the product DID produce
    // would simply be absent from the result - which is how a gate ends up reading an empty field.
    fact.type === "world_fact"
  ) {
    const entry = {
      type: fact.type,
      reasonCode: fact.payload?.reasonCode,
      requestId: fact.payload?.requestId,
      executionId: fact.payload?.executionId,
      evidence: fact.payload?.evidence ?? null,
      // A world fact's identity and payload. The Mod mints `eventId`/`sourceEventId` as the same opaque id, and
      // for `npc_dialogue_presented` the payload IS the content a gate must read (speaker, pages, isQuestion,
      // choices). The Host never interprets it, so it is recorded verbatim.
      eventId: fact.eventId,
      sourceEventId: fact.sourceEventId,
      worldFactKind: fact.payload?.kind,
      worldFactPayload: fact.payload,
    };
    // The Mod legitimately delivers one bridge transition over two routes: the
    // fact route and the execute-response path, and the second delivery is an
    // idempotent no-op by contract (action-execution-coordinator.internal.test.ts:
    // "...are the same bridge transition"). A redelivery is byte-identical, so
    // deduplicate the console line on the exact serialized entry — distinct
    // progress events (e.g. per-tile `tile_advanced`) differ and still log. Every
    // entry still reaches factLog verbatim; only the log line is deduplicated, so
    // a redelivered receipt cannot read as a second action.
    const serialized = (() => {
      try {
        return JSON.stringify(entry);
      } catch (error) {
        return null;
      }
    })();
    factLog.push(entry);
    if (serialized === null) {
      // A payload the recorder cannot serialize must not take the SESSION down with it. The bridge treats any
      // throw from a fact listener as a fatal transport fault and closes it (`fact_listener_failed`), so an
      // evidence recorder that threw would end the very run it exists to record - measured 2026-10-17: the first
      // multi-day run reported `fact_listener_failed` with no way to tell it apart from a real protocol fault.
      console.error("BRIDGE_FACT_UNSERIALIZABLE", JSON.stringify({ type: entry.type, reasonCode: entry.reasonCode }));
      return;
    }
    if (loggedFactLines.has(serialized)) {
      console.error(
        "BRIDGE_FACT_REDELIVERED",
        JSON.stringify({ type: entry.type, reasonCode: entry.reasonCode, executionId: entry.executionId }),
      );
    } else {
      loggedFactLines.add(serialized);
      console.error("BRIDGE_FACT", serialized);
    }
  }
});

/**
 * The receipt a recorded bridge fact carries, read from where the fact log actually puts it.
 *
 * The recorder above projects an `execution_receipt` fact as `{ type, reasonCode, requestId, executionId,
 * evidence, ..., worldFactPayload }`: the receipt's identity is flattened onto the entry, but the receipt
 * ITSELF is kept whole under `worldFactPayload`, so its terminal `state` lives THERE and never on the entry.
 * Reading `fact.state` therefore finds nothing - which recorded a textbook `succeeded/day_advanced` night as
 * `night_terminal_missing` on every multi-day run, and kept every `fact.state === "succeeded"` comparison
 * false. This is the one place a recorded receipt is read, so every caller sees the same shape.
 */
function recordedReceipt(fact) {
  if (fact?.type !== "execution_receipt") return null;
  const receipt = fact.worldFactPayload;
  return receipt !== null && typeof receipt === "object" ? receipt : null;
}

/** The first TERMINAL receipt a recorded fact log holds for one request, or undefined when none has arrived. */
function terminalReceiptFor(facts, requestId) {
  for (const fact of facts ?? []) {
    const receipt = fact?.requestId === requestId ? recordedReceipt(fact) : null;
    if (receipt !== null && TERMINAL_STATES.has(receipt.state)) return receipt;
  }
  return undefined;
}

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
 * A scenario may deliver one player turn, or a session of them.
 * This is that one turn's machinery, extracted so every scenario shares it: admit
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
async function waitForSessionQuiet(turn, { dispatchesBeforeTurn, quietMs = 20_000, timeoutMs = 300_000 } = {}) {
  // Quiet = no NEW dispatch and no NEW meaningful fact for a sustained window.
  // Meaningful = execution_receipt / lifecycle / error. The Mod pings semantic_event/body_trace every few
  // seconds; counting that as motion made the window unreachable, so it is excluded. The previous version had a
  // real bug: it sliced by a TIMESTAMP (factLog.slice(lastFactAt), where lastFactAt was ms) and checked the
  // WHOLE slice since the turn for any meaningful fact, so quiet was unreachable whenever a meaningful fact had
  // EVER arrived. Track the last-observed INDEX and check only the newly-appended facts each second.
  const meaningful = (entry) =>
    entry?.type === "execution_receipt" || entry?.type === "lifecycle" || entry?.type === "error";
  let lastSeenDispatch = dispatchesBeforeTurn;
  let lastSeenFact = factLog.length;
  let lastActionAt = Date.now();
  let lastFactAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const actionMoved = actionTrace.length > lastSeenDispatch;
    if (actionMoved) {
      lastSeenDispatch = actionTrace.length;
      lastActionAt = Date.now();
    }
    const factMoved = factLog.slice(lastSeenFact).some(meaningful);
    if (factMoved) {
      lastSeenFact = factLog.length;
      lastFactAt = Date.now();
    }
    if (Date.now() - lastActionAt >= quietMs && Date.now() - lastFactAt >= quietMs) {
      turn.quieter = true;
      break;
    }
  }
  return turn;
}
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
  // timeouts belong to the harness), so a self-directed session gets a budget that fits dozens of
  // native actions instead of the 10-minute default the scripted rungs use. A turn
  // that still exceeds it does not silently become a completed session: the verdict
  // below refuses to call that `passed`.
  const turnWaitSeconds = Number(
    process.env.GAMEBUDDY_AGENT_WAIT_SECONDS ??
      (SCENARIO === "morning_routine" || SCENARIO === "multiday_routine" ? 1800 : 600),
  );
  for (let i = 0; i < turnWaitSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if (agentProgramId !== null) status = await client.programStatus({ programId: agentProgramId });
    } catch {}
    if (
      status?.code === "found" &&
      ["succeeded", "failed", "recovery_required", "cancelled"].includes(status.snapshot?.state)
    )
      break;
    if (i % 10 === 0) {
      console.error(
        JSON.stringify({
          seconds: i,
          programStatus: status,
          agentProgramId,
          // Submissions and what became of them. `accepted: 0` is the interesting case: the companion chose the batching
          // path and nothing went through it.
          programSubmissions: Object.freeze([...programSubmissions]),
          revision: client.state.snapshot?.revision,
        }),
      );
      // The world itself is the thing to watch: the Mod's heartbeat is per tick, so its absence means the game thread
      // stopped reaching the Mod - not a slow action, and not something the turn budget should wait out.
      const liveness = sampleModHeartbeat();
      if (liveness.silentMs >= MOD_HEARTBEAT_STALL_MS) {
        worldStallReason = `world_stopped_advancing:silent_ms=${String(liveness.silentMs)}:last_heartbeat=${liveness.line}`;
        break;
      }
    }
    const quick = await Promise.race([agentTurn, Promise.resolve(null)]);
    if (quick !== null) {
      turn = quick;
      break;
    }
  }
  // The loop above IS the waiter, and its budget is `turnWaitSeconds`. This used to race the turn against a FIVE
  // SECOND timeout and label whatever lost `agent_turn_timeout` - which fired on run g35real at the exact moment the
  // companion submitted its first real ActionProgram (`AGENT_PROGRAM_SUBMIT farm_day5_b accepted`): the loop had
  // broken on the PROGRAM's terminal state while the TURN was still running, `turn` was still null, and five seconds
  // of a working session became a timeout verdict that closed the binding mid-program. Awaiting the turn here is
  // what the loop was already doing; the harness's own run budget stays the hard stop.
  if (turn === null) turn = await agentTurn;
  // SELF-DIRECTED SCENARIO ONLY: after the turn settles, keep waiting until the session is QUIET instead of closing the turn
  // on the first settle. A terminal receipt (e.g. `modal_interrupted`) is a follow_up fact, not a player
  // message, and it may trigger the Agent to act again (dismiss, resume) BEFORE the session truly rests. With
  // the old boundary the runner stopped waiting at the first settle, so an interrupted turn could never
  // recover - the very gap this extension exists to expose. It is confined to the self-directed scenario so the
  // single-goal scenarios keep their exact turn semantics.
  if (SCENARIO === "morning_routine")
    turn = await waitForSessionQuiet(turn, { dispatchesBeforeTurn, timeoutMs: turnWaitSeconds * 1000 });
  turn.steerObserved =
    agentProgramId !== null ||
    (typeof presentedSummary === "string" && presentedSummary.length > 0) ||
    // The turn's own effects: a dispatch it issued is proof the steer reached the session. `factLog.length > 0`
    // used to stand here and proved almost nothing — any Mod fact, including an unrelated body trace, made it
    // true while no player text had reached Pi at all.
    actionTrace.length > dispatchesBeforeTurn;
  sampleAdvertisedActions();
  if (turn.settled === true && turn.steerObserved === false) turn.reason = "steer_may_have_been_silently_dropped";
  return { turn, status };
}

/**
 * the self-directed scenario's capability/stall audit.
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
    if (state === "rejected" || state === "failed" || state === "uncertain")
      bump(current.rejections, stateOf(entry.reasonCode));
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
        verdict:
          reachedTerminal(entry) && failed === 0
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
    blockedBySystem: Object.freeze(
      attempted.filter((entry) => entry.verdict === "blocked" || entry.verdict === "failed"),
    ),
    // Actions that succeeded at least once AND failed at least once. Their failures are the
    // interesting ones (a retry that never worked), so they must not hide behind the success.
    partialFailures: Object.freeze(
      attempted
        .filter((entry) => entry.verdict === "partial")
        .map((entry) =>
          Object.freeze({ actionId: entry.actionId, failedTerminalReasonCodes: entry.failedTerminalReasonCodes }),
        ),
    ),
    unresolved: Object.freeze(
      attempted.filter((entry) => entry.verdict === "unresolved").map((entry) => entry.actionId),
    ),
    notAttempted: Object.freeze(advertised.filter((actionId) => !byAction.has(actionId)).sort()),
    advertisedCount: advertised.length,
    // Proof that the axis above was actually sampled while the session ran.
    advertisedSampleCount,
    advertisedSampleMaxSize,
    advertisedAxisUsable: advertisedSampleCount > 0 && advertised.length > 0,
  });
}
/**
 * How long ONE night's rollover may take before the harness stops watching. A harness bound, not a product
 * verdict - and it has to OUTLIVE the day it is waiting for.
 *
 * It was ten minutes, which is shorter than the day turn it runs alongside (`turnWaitSeconds` is 1800 for the
 * self-directed scenarios). Measured on g39home: 78 actions of real farm work over about ten and a half minutes,
 * the watcher's own bound expired while the day turn was STILL RUNNING, and the run was recorded as
 * `companion_did_not_sleep:day_turn_still_running` - a verdict about a day that had not finished making up its
 * mind, let alone refused to sleep. The watcher already distinguishes the two honest cases: when the day turn
 * SETTLES with no `advance_day`, it reports `companion_did_not_sleep` at once. This bound only has to sit past
 * the turn budget, so the run budget stays the hard stop.
 */
const MULTIDAY_NIGHT_TIMEOUT_MS = (() => {
  const requested = Number.parseInt(process.env.GAMEBUDDY_MULTIDAY_NIGHT_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(requested) && requested > 0) return requested;
  // One minute past the 1800s turn budget, so the watcher cannot expire before the turn it accompanies.
  return 31 * 60 * 1000;
})();
/**
 * How long one harness dispatch may take to be admitted, and to reach its terminal.
 *
 * 45 s, not the 120 s this first used: the Mod bounds a request's deadline by the ACTION'S OWN published watchdog
 * (`BridgeSession.IsFreshExecutionRequest`), whose default is 60 s (`BodyProgramModels.cs:153`) - only the
 * cross-day lifecycle publishes 600 s, and the harness never dispatches that (the companion does, through the
 * Host's tool layer, which sizes its deadline from the same descriptor). A 120 s deadline was refused by name
 * with `invalid_deadline` (measured 2026-10-17, run g14), and 45 s leaves slack for the two processes' clock reads
 * differing by the request's transit time.
 */
const MULTIDAY_DISPATCH_TIMEOUT_MS = 45_000;

/** How long one `dismiss_modal` may take to reach its terminal before the wait is named. */
const MULTIDAY_DISMISS_TIMEOUT_MS = 60_000;
/** How often the night watcher asks the world. It runs only while a night is in flight. */
const MULTIDAY_POLL_INTERVAL_MS = 250;

/**
 * This run's Mod log, copied into the run directory, plus the lines an audit needs out of it.
 *
 * The Mod's own phase facts live in %APPDATA%/StardewValley/ErrorLogs/SMAPI-latest.txt, which ROTATES: once the
 * next run starts, the previous night's is_saving, save_boundary_not_observed, SaveGameMenu and
 * SetForegroundWindow evidence is gone - the round-2 audit could not confirm the crossing cause for exactly that
 * reason ("the facts are not in the surviving artifacts"). Durability is the fix. Note what it already shows: the
 * foreground WINDOW MODE is not a proxy for actual activation, because a real run logged
 * SetForegroundWindow=refused while running in foreground mode.
 */
function captureModLogFacts(runDir) {
  const path = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
  try {
    const text = readFileSync(path, "utf8");
    const rows = text.split("\n");
    const tail = (pattern, count = 4) =>
      rows
        .filter((row) => pattern.test(row))
        .slice(-count)
        .map((row) => row.trim().slice(0, 400));
    const archived = typeof runDir === "string" && runDir.length > 0;
    if (archived) writeFileSync(join(runDir, "mod-log.txt"), text);
    const lastWith = (needle) => (rows.filter((row) => row.includes(needle)).slice(-1)[0] ?? "").trim().slice(0, 400);
    return Object.freeze({
      path,
      bytes: text.length,
      archived,
      setForegroundWindow: tail(/SetForegroundWindow/i),
      saveGameMenu: tail(/SaveGameMenu/i),
      saveBoundary: tail(/save_boundary|SaveBoundaryFrameBudget|save boundary/i),
      sleepLifecycle: tail(/sleep lifecycle/i, 6),
      // The two lines a freeze is diagnosed from, straight into the result instead of only into the archived log: the
      // last step the tick NAMED (a stage marker) and the last thing the Mod say through the pipe ingress path.
      lastStage: (rows.filter((row) => row.includes("DEBUG-native-local-stage")).slice(-1)[0] ?? "")
        .trim()
        .slice(0, 300),
      lastIngress: (rows.filter((row) => row.includes("native chat ingress")).slice(-1)[0] ?? "").trim().slice(0, 300),
      lastFrameState: lastWith("game_mode="),
      lastSavingState: lastWith("saving="),
    });
  } catch (error) {
    return Object.freeze({ path, archived: false, error: String(error?.message ?? error).slice(0, 240) });
  }
}

/**
 * How long the Mod may go without printing a heartbeat before the run says the WORLD stopped.
 *
 * The Mod's heartbeat is per tick, and the native-local lane prints it on every path that yields (including the ones
 * that pump the bridge), so its absence is not a bridge problem - it means the game thread is not reaching the Mod at
 * all. Measured 2026-10-18 (g40night): the last heartbeat was 19:23:59 with `bridge=connected; rx=552/552`, the last
 * log line at 19:24:01 was a navigation execution starting, and then the log went silent for six minutes until the
 * harness reported a dead pipe. Nothing named the stall while it was happening, so the run looked like a transport
 * fault. This turns it into a timestamped reason at the moment it occurs.
 */
const MOD_HEARTBEAT_STALL_MS = 90_000;

/** Where the Mod's own log lives, and the one line in it that proves the world is still advancing. */
const MOD_LOG_PATH = () => join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
const MOD_HEARTBEAT_MARKER = "DEBUG-native-local-heartbeat";
let modHeartbeatSample = { count: -1, sinceMs: Date.now(), line: "" };

/**
 * Sample the Mod's heartbeat: how many it has printed, when that count last grew, and the newest line.
 *
 * Counting rather than parsing timestamps keeps it independent of the log's clock format and of midnight.
 */
/**
 * Whether the game process is answering Windows messages, and how much CPU it has burned.
 *
 * Read-only, and matched by name because the runner does not receive the launched pid: nothing here kills or signals
 * anything, and an absent process answers `responded: null` rather than guessing.
 */
/**
 * The threads of the game process and what they are waiting on.
 *
 * The decisive reading after g80stall: BOTH timer-thread files stopped - the engine-frame writer and the watchdog's
 * fallback - while the process stayed alive, which points at the managed side as a whole rather than one blocked
 * thread. A thread-state census taken during the stall separates the remaining cases: every thread parked on one
 * lock (a managed deadlock), threads waiting on I/O, or a suspended runtime.
 *
 * Four different answers, four different values, each naming the pid it asked about: `no_game_process` (nothing to
 * census), `pid=<id>;process_without_threads`, `pid=<id>;threads=<n>;<groups>`, and `probe_unavailable:<why>` (the
 * query itself failing, which is NOT evidence about the world). They used to be ONE value, `unavailable` - and a
 * real artifact shows why that was unreadable: the same tick reported `game_cpu_s=539` from the process probe beside
 * it while the census said `unavailable`, so the reader could not tell a dead process from a threadless one from a
 * broken query (2026-10-19, multiday_routine).
 */
function sampleGameThreads() {
  const query = () =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$p = Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Select-Object -First 1; " +
          'if ($null -ne $p) { [pscustomobject]@{ "pid" = $p.Id; "threadCount" = $p.Threads.Count; "census" = ' +
          '(($p.Threads | Group-Object ThreadState,WaitReason | ForEach-Object { "$($_.Count)x$($_.Name)" }) -join "|") } ' +
          "| ConvertTo-Json -Compress }",
      ],
      { encoding: "utf8", timeout: 8_000 },
    );
  let rows;
  try {
    rows = query();
  } catch (error) {
    return `probe_unavailable:${String(error?.message ?? error)
      .replace(/\s+/gu, " ")
      .slice(0, 120)}`;
  }
  const text = rows.trim();
  // An empty answer is Get-Process finding nothing, which is the only reading here that says the game is not running.
  if (text === "") return "no_game_process";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `probe_unavailable:unparseable_output:${text.slice(0, 120)}`;
  }
  const pid = Number.isInteger(parsed?.pid) ? String(parsed.pid) : "unknown";
  const census = typeof parsed?.census === "string" ? parsed.census.trim().replace(/\s+/gu, " ") : "";
  if (census === "") return `pid=${pid};process_without_threads`;
  const threadCount = Number.isInteger(parsed?.threadCount) ? String(parsed.threadCount) : "unknown";
  return `pid=${pid};threads=${threadCount};${census.slice(0, 400)}`;
}

/**
 * The adapter name and the primary display size, for a run that is not headless.
 *
 * The evidence bundle requires these whenever the window mode is not hidden/background, and it is right to: a run with
 * a window needs to say what it rendered on. Measured once per run, off the game thread.
 */
function measureEnvironmentFacts() {
  if (environmentFactsCache !== null) return environmentFactsCache;
  // The FULL PATH, not `powershell`: a child process can be started with a PATH that does not include it, and a lookup
  // failure is indistinguishable from a missing adapter - which is how the bundle was refused twice tonight even after
  // the measurement was added.
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const query = (command) => {
    try {
      return execFileSync(powershell, ["-NoProfile", "-Command", command], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
    } catch (error) {
      console.error(
        `ENV_FACTS_QUERY_FAILED ${JSON.stringify({ command: command.slice(0, 60), error: String(error?.code ?? error).slice(0, 80) })}`,
      );
      return "";
    }
  };
  const controller = query(
    "Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object -First 1 | ConvertTo-Json -Compress",
  );
  let parsedController = null;
  try {
    parsedController = controller === "" ? null : JSON.parse(controller);
  } catch {
    parsedController = null;
  }
  const adapter = typeof parsedController?.Name === "string" ? parsedController.Name : "";
  const width = Number(parsedController?.CurrentHorizontalResolution ?? 0);
  const height = Number(parsedController?.CurrentVerticalResolution ?? 0);
  // ONE controller, chosen because it REPORTS a resolution. The first version asked for `Select-Object -First 1` and took
  // the adapter from it: on a laptop with two adapters that picked the discrete GPU, which reports an adapter name and no
  // current mode - so the bundle was refused as `env_fact_not_measured` while the measurement itself was fine (measured
  // 2026-10-19: `ENV_FACTS_EMPTY {adapter: "NVIDIA GeForce RTX 5060 Laptop GPU", resolution: ""}`).
  const resolution = width > 0 && height > 0 ? `${String(width)}x${String(height)}` : "";
  if (adapter === "" || resolution === "")
    console.error(
      `ENV_FACTS_EMPTY ${JSON.stringify({ adapter: adapter.slice(0, 40), resolution: resolution.slice(0, 20) })}`,
    );
  environmentFactsCache = Object.freeze({
    adapter: adapter === "" ? null : adapter.slice(0, 200),
    resolution: resolution === "" ? null : resolution.slice(0, 40),
  });
  return environmentFactsCache;
}

function sampleGameProcess() {
  /**
   * Three different answers, three different values.
   *
   * `responding: false` is a live process that is not pumping messages - the signature of the engine-side freeze.
   * `responding: null` with `note: "no_game_process"` is a game that is not running. `note: "probe_unavailable"` is the
   * query itself failing, which is NOT evidence about the world: measured 2026-10-19 (g70probe), the sampler recorded
   * `game_responding=null` during a freeze in which the game was alive, collapsing two of these into one value.
   */
  const query = () =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Select-Object -First 1 -Property Responding,CPU | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 8_000 },
    );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = query();
      const parsed = JSON.parse(rows.trim() === "" ? "null" : rows);
      if (parsed === null) return Object.freeze({ responding: null, cpuSeconds: null, note: "no_game_process" });
      return Object.freeze({
        responding: parsed.Responding === true,
        cpuSeconds: typeof parsed.CPU === "number" ? parsed.CPU : null,
        note: null,
      });
    } catch {
      // A failed query is not evidence; try once more, then say so.
    }
  }
  return Object.freeze({ responding: null, cpuSeconds: null, note: "probe_unavailable" });
}

function sampleModHeartbeat() {
  try {
    const lines = readFileSync(MOD_LOG_PATH(), "utf8")
      .split("\n")
      .filter((line) => line.includes(MOD_HEARTBEAT_MARKER));
    const grew = lines.length > modHeartbeatSample.count;
    modHeartbeatSample = {
      count: lines.length,
      sinceMs: grew ? Date.now() : modHeartbeatSample.sinceMs,
      line: (lines.at(-1) ?? "").trim().slice(0, 200),
    };
  } catch (error) {
    // Unreadable is not stalled: the run has no evidence either way, and inventing a stall would be worse.
    modHeartbeatSample = { ...modHeartbeatSample, line: `unreadable:${String(error?.message ?? error).slice(0, 80)}` };
  }
  return Object.freeze({ ...modHeartbeatSample, silentMs: Date.now() - modHeartbeatSample.sinceMs });
}
const MULTIDAY_CROSSINGS = (() => {
  const requested = Number.parseInt(process.env.GAMEBUDDY_MULTIDAY_CROSSINGS ?? "2", 10);
  if (!Number.isInteger(requested) || requested < MINIMUM_BASELINE_DAYS || requested > MAXIMUM_BASELINE_DAYS) {
    throw new Error(
      `multiday_crossings_out_of_range:${String(process.env.GAMEBUDDY_MULTIDAY_CROSSINGS)} (expected ${String(MINIMUM_BASELINE_DAYS)}..${String(MAXIMUM_BASELINE_DAYS)})`,
    );
  }
  return requested;
})();

/**
 * What one day accomplished, read from the RECEIPTS rather than from the companion's prose.
 *
 * The join is the audit's own: an action's dispatch in the trace, its terminal receipt in the fact log, and
 * the registered success terminal from the published gate table. Counting the dispatch alone would credit an
 * attempt as work; counting the companion's own summary would credit a claim as work.
 */
function accomplishedSince(startIndex) {
  const accomplished = new Set();
  for (const entry of actionTrace.slice(startIndex)) {
    // A day that only walked, looked around, posed and slept has NOT produced farm work, and for the
    // multi-day rule that is the difference between a loop and one rollover. Without this filter the day's own
    // `advance_day` (whose terminal is `day_advanced`, a registered gate) always landed in the set - so
    // `next_day_produced_no_farm_work` could never fire and "the companion kept working" was unprovable
    // (measured 2026-10-17: the rule's own producer made it unreachable).
    if (NON_ACCOMPLISHMENT_ACTIONS.has(entry.action)) continue;
    // The task's own progress reports are not work either.
    if (entry.action === "advance_day" || entry.action === "dismiss_modal" || entry.action === "respond_level_up")
      continue;
    const expected = STARDEW_PUBLISHED_ACTION_GATES.find((gate) => gate.actionId === entry.action)?.terminalReasonCode;
    if (expected === undefined) continue;
    const terminal = factLog.find((fact) => {
      const receipt = recordedReceipt(fact);
      return (
        receipt !== null &&
        fact.requestId === entry.requestId &&
        receipt.reasonCode === expected &&
        (receipt.state === "succeeded" || receipt.state === "partially_succeeded")
      );
    });
    if (terminal !== undefined) accomplished.add(entry.action);
  }
  return [...accomplished].sort();
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Watch the night through the engine's pass-out, because a pass-out is a NORMAL night's end.
 *
 * At 2:00 AM the engine passes the farmer out and `Game1.PassOutNewDay()` (Game1.cs:10344-10347) calls `NewDay(0f)`
 * itself, so the player wakes in bed on the NEXT day: the calendar crosses exactly as it does after a sleep. The
 * shared watcher stops on the hold (`actor_passed_out`), because a hold is not by itself a crossing - but treating
 * that stop as the night's OUTCOME ended a whole run on a night the game had already crossed (measured: g120,
 * `crossings 0/2` with a day 1 that held no terminal at all, the watch's own stop published as the run's reason).
 *
 * So the watcher is RE-ENTERED while the engine owns the actor, against the same night budget. A budget spent while
 * the farmer is still out is the named wait (`night_not_observed:pass_out:none`) rather than a verdict about either
 * the night or the faint. Every other stop - a cutscene, an unclosable menu, a dead bridge - is answered at once:
 * the retry is for the pass-out only.
 */
async function watchNightThroughPassOut({
  watchOnce,
  timeoutMs,
  pollIntervalMs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let passOutObserved = false;
  // Menus are per ATTEMPT (each `watchOnce` is one bounded watch), and the day's record is the night's whole story: a
  // settlement menu dismissed before the faint must not vanish because a later attempt started with an empty list.
  const menuByType = new Map();
  let outcome = await watchOnce(Math.max(0, deadline - now()));
  for (;;) {
    for (const entry of outcome.menus ?? []) menuByType.set(entry.menuType, entry);
    if (outcome.crossed === true || outcome.reasonCode !== "actor_passed_out") break;
    passOutObserved = true;
    if (now() >= deadline) {
      outcome = Object.freeze({
        crossed: false,
        reasonCode: "night_not_observed:pass_out:none",
        dayAfter: outcome.dayAfter ?? null,
      });
      break;
    }
    await sleep(pollIntervalMs);
    outcome = await watchOnce(Math.max(0, deadline - now()));
  }
  return Object.freeze({ ...outcome, menus: [...menuByType.values()], passOutObserved });
}

/**
 * Watch the night that the companion's own `advance_day` starts.
 *
 * Started at the SAME moment as the day's turn, because the night begins while the Agent is still blocked
 * inside its tool call. What this adds is the one thing the Agent cannot do for itself: the settlement menu
 * the rollover raises is observed and closed with the product's own `dismiss_modal`, and the closing receipt is
 * recorded - so "the menu was cleared" is a product fact rather than an inference from the run having
 * finished.
 */
async function watchNightRollover(day, { dayTurnSettled = Promise.resolve() } = {}) {
  const traceStart = actionTrace.length;
  const observeQuietly = async () => {
    try {
      return await client.observe();
    } catch {
      // A rollover's fade legitimately refuses an observation for a frame or two; the cached projection is
      // the current truth in that window.
      return client.state?.snapshot ?? null;
    }
  };
  // WAIT FOR THE NIGHT TO BEGIN before watching it.
  //
  // The night starts when the companion dispatches `advance_day`, which happens somewhere inside its day. A
  // watcher that started observing from the first second of the day would poll the world at 4 Hz for the whole
  // turn (measured 2026-10-17: the first multi-day run had the loop observing from t=0, and the bridge closed
  // 15s in) and would ALSO be unable to tell "the companion has not slept yet" from "the companion will not
  // sleep". Waiting for the dispatch - bounded, and against the day's own settlement - gives both.
  const waitForNightToBegin = async () => {
    let daySettled = false;
    void dayTurnSettled.then(() => {
      daySettled = true;
    });
    const deadline = Date.now() + MULTIDAY_NIGHT_TIMEOUT_MS;
    for (;;) {
      if (bridgeDisconnections.length > 0) {
        return `night_watched_over_a_dead_bridge:${String(bridgeDisconnections[0]?.reasonCode ?? "unknown")}`;
      }
      const dispatched = actionTrace.slice(traceStart).find((entry) => entry.action === "advance_day");
      if (dispatched !== undefined) return null;
      if (daySettled) return "companion_did_not_sleep";
      // Before the harness's own bound: has the WORLD stopped? A stalled heartbeat is a different finding from
      // "the companion has not slept yet", and it is the one that has silently ended most of the multi-day runs.
      const liveness = sampleModHeartbeat();
      if (liveness.silentMs >= MOD_HEARTBEAT_STALL_MS)
        return `world_stopped_advancing:silent_ms=${String(liveness.silentMs)}:last_heartbeat=${liveness.line}`;
      if (Date.now() >= deadline) return "companion_did_not_sleep:day_turn_still_running";
      await new Promise((resolve) => setTimeout(resolve, MULTIDAY_POLL_INTERVAL_MS));
    }
  };
  const neverStarted = await waitForNightToBegin();
  if (neverStarted !== null) {
    return Object.freeze({ terminal: null, after: await observeQuietly(), menus: [], reasonCode: neverStarted });
  }
  const dayBefore = client.state?.snapshot?.dayOfMonth;
  /**
   * Settle the level-up menu the rollover raised, with the ONE choice that takes no decision.
   *
   * This is NOT the same permission as dismissing `ShippingMenu`. An active `LevelUpMenu` grants its perk when
   * it closes, so it needs `respond_level_up`; and while an ORDINARY level has exactly one legal value
   * (`confirm`), a MILESTONE (5/10) is a permanent part of the companion's growth path, so a proxy choosing a
   * branch would be the harness deciding for it. A milestone is therefore reported by name and the run stops -
   * the multi-day Given pins the five skills at 10 precisely so one cannot arise.
   *
   * The pair is read from the PRODUCT's own projection: the Mod publishes `pendingLevelUps` (`skill@level`, bounded at
   * 8) on every snapshot, which is the home the boundary card requires for it. Until 2026-10-19 the watcher learned the
   * pair by calling `dismiss_modal` and parsing its refusal - a fact read out of a failure - and that probe is gone.
   */
  const respondLevelUp = async () => {
    // The pair, from the PRODUCT's own projection (`snapshot.pendingLevelUps`). The probe that used to read it is gone:
    // it learned the pair by calling `dismiss_modal` and parsing the REFUSAL - reading a fact out of a failure - and the
    // boundary card requires the pending pair to be the companion's own input anyway. The projection landed in the Mod
    // and the Host's snapshot contract (bounded at 8, `skill@level`), so the watcher now reads a fact like any other.
    const pending = readPendingLevelUpsFromSnapshot(await observeQuietly());
    const decision = chooseLevelUpResolution(pending);
    if (decision.reasonCode !== null) {
      return Object.freeze({
        receipt: null,
        reasonCode:
          decision.reasonCode === "level_up_pair_not_published" ? "level_up_pair_not_in_snapshot" : decision.reasonCode,
        choice: null,
        levelUp: decision.levelUp,
      });
    }
    const levelUp = decision.levelUp;
    const requestId = `multiday_level_up_${String(day)}_${String(Date.now())}`;
    try {
      const levelUpSnapshot = await observeQuietly();
      const accepted = await executeFresh(client, {
        action: "respond_level_up",
        args: { choice: "confirm", expectedSkill: levelUp.skill, expectedLevel: levelUp.level },
        snapshot: levelUpSnapshot,
        requestId,
        idempotencyKey: `${requestId}_idem`,
        timeoutMs: MULTIDAY_DISPATCH_TIMEOUT_MS,
      });
      // The response may already BE the terminal: a short action settles in one frame, so `succeeded` here is the
      // outcome, not a refusal (g25 reported `level_up_not_resolved:succeeded/level_up_resolved` because this
      // branch treated every non-`accepted` state as a refusal). A REFUSAL is a refusal state, and only those fall
      // through to the wait.
      if (typeof accepted?.state === "string" && accepted.state !== "accepted") {
        const settled = accepted.state === "succeeded" || accepted.state === "partially_succeeded";
        return Object.freeze({
          receipt: accepted,
          choice: "confirm",
          levelUp,
          reasonCode: settled
            ? accepted.reasonCode === "level_up_resolved"
              ? null
              : `level_up_not_resolved:${accepted.state}/${String(accepted.reasonCode)}`
            : `level_up_not_resolved:${accepted.state}/${String(accepted.reasonCode)}`,
        });
      }
      const deadline = Date.now() + MULTIDAY_DISMISS_TIMEOUT_MS;
      for (;;) {
        const terminal = terminalReceiptFor(factLog, accepted?.requestId);
        if (terminal !== undefined) {
          return Object.freeze({
            receipt: terminal,
            choice: "confirm",
            levelUp,
            reasonCode:
              terminal.state === "succeeded" && terminal.reasonCode === "level_up_resolved"
                ? null
                : `level_up_not_resolved:${String(terminal.state)}/${String(terminal.reasonCode)}`,
          });
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return Object.freeze({
        receipt: null,
        choice: "confirm",
        levelUp,
        reasonCode: "level_up_not_resolved:terminal_not_observed",
      });
    } catch (error) {
      return Object.freeze({
        receipt: null,
        choice: "confirm",
        levelUp,
        reasonCode: `level_up_not_resolved:${String(error?.message ?? error).slice(0, 160)}`,
      });
    }
  };
  const world = {
    observe: observeQuietly,
    respondLevelUp,
    dismiss: async (menuType) => {
      const requestId = `multiday_dismiss_${String(day)}_${String(Date.now())}`;
      try {
        // The SAME dispatch discipline as the smoke harness: a fresh observation supplies expectedRevision and a
        // bounded deadline. Two raw `client.execute` calls here (no revision, no deadline) were rejected with
        // `receipt_not_found` on run g12, so the probe never produced the evidence it exists to read.
        const probeSnapshot = await observeQuietly();
        const accepted = await executeFresh(client, {
          action: "dismiss_modal",
          args: {},
          snapshot: probeSnapshot,
          requestId,
          idempotencyKey: `${requestId}_idem`,
          timeoutMs: MULTIDAY_DISPATCH_TIMEOUT_MS,
        });
        // A REFUSAL is answered immediately and mints no later receipt, so it is read from the response itself.
        // Polling the fact log for it was the defect on run g15: `rejected` is not in the shared TERMINAL_STATES, so
        // the poll timed out and the probe reported "the pair was never published" while the refusal - carrying
        // `pending_level_ups=11;level_up=4@6;...` - was already in hand.
        //
        // The same response can also BE the terminal (a short action settles in one frame), which is a success.
        if (typeof accepted?.state === "string" && accepted.state !== "accepted") {
          const settled = accepted.state === "succeeded" || accepted.state === "partially_succeeded";
          return Object.freeze({
            receipt: accepted,
            reasonCode: settled
              ? accepted.reasonCode === "modal_dismissed"
                ? null
                : `menu_not_dismissed:${menuType}:${String(accepted.reasonCode)}`
              : `menu_not_dismissed:${menuType}:${accepted.state}/${String(accepted.reasonCode)}`,
          });
        }
        const deadline = Date.now() + MULTIDAY_DISMISS_TIMEOUT_MS;
        for (;;) {
          const terminal = terminalReceiptFor(factLog, accepted?.requestId);
          if (terminal !== undefined) {
            return terminal.state === "succeeded" && terminal.reasonCode === "modal_dismissed"
              ? Object.freeze({ receipt: terminal, reasonCode: null })
              : Object.freeze({
                  receipt: terminal,
                  reasonCode: `menu_not_dismissed:${menuType}:${String(terminal.state)}/${String(terminal.reasonCode)}`,
                });
          }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return Object.freeze({ receipt: null, reasonCode: `menu_not_dismissed:${menuType}:terminal_not_observed` });
      } catch (error) {
        return Object.freeze({
          receipt: null,
          reasonCode: `menu_not_dismissed:${menuType}:${String(error?.message ?? error).slice(0, 160)}`,
        });
      }
    },
  };
  const outcome = await watchNightThroughPassOut({
    pollIntervalMs: MULTIDAY_POLL_INTERVAL_MS,
    timeoutMs: MULTIDAY_NIGHT_TIMEOUT_MS,
    watchOnce: (remainingMs) =>
      watchRollover(world, {
        dayBefore,
        timeoutMs: remainingMs,
        abort: () =>
          bridgeDisconnections.length > 0
            ? `night_watched_over_a_dead_bridge:${String(bridgeDisconnections[0]?.reasonCode ?? "unknown")}`
            : null,
      }),
  });
  // HOW the night ended: the engine's 2:00 AM pass-out, or the companion's own sleep. It is a CAUSE on the day's
  // record and never a verdict - the night was watched on to the day the engine opened.
  const cause = outcome.passOutObserved === true ? "pass_out" : "sleep";
  // The night's own terminal: the receipt of the `advance_day` the COMPANION dispatched during this window.
  const dispatched = actionTrace.slice(traceStart).find((entry) => entry.action === "advance_day");
  const terminal = dispatched === undefined ? null : (terminalReceiptFor(factLog, dispatched.requestId) ?? null);
  if (dispatched === undefined) {
    return Object.freeze({
      terminal: null,
      after: await observeQuietly(),
      menus: outcome.menus,
      cause: null,
      reasonCode: `night_never_started:${String(outcome.reasonCode ?? "companion_did_not_sleep")}`,
    });
  }
  return Object.freeze({
    terminal,
    after: await observeQuietly(),
    menus: outcome.menus,
    cause,
    reasonCode: outcome.reasonCode ?? null,
  });
}

/**
 * Stream one companion line through the configured Voice Gateway
 * and resolve with its terminal playback observation. Voice enablement is
 * configuration, not script content: the shared launcher attaches to a
 * product-injected gateway or reads the stored player voice preference and
 * reports the exact disabled reason. When voice is intentionally off the run
 * still records that fact; it never invents a gateway configuration.
 */
async function startVoiceLane(speakerText = "咖啡豆已经放进桶里啦，大概两小时后酿好！") {
  // Voice is configuration-enabled, never hand-written here: the shared
  // launcher reads the product-injected gateway (GAMEBUDDY_VOICE_PORT/TOKEN) or
  // the stored player preference, and reports the exact disabled reason when
  // voice is genuinely off. The runner only streams the line it was asked to.
  const configuration =
    voiceConfiguration ?? (await resolveVoiceConfiguration({ runtimeRoot, locale: COMPANION_LOCALE }));
  voiceConfiguration = configuration;
  if (!configuration.enabled) throw new Error(`voice_disabled:${configuration.disabledReason}`);
  const token = configuration.mode === "attached" ? configuration.token : randomToken();
  const port = configuration.mode === "attached" ? configuration.port : await pickVoiceGatewayPort();
  const started =
    configuration.mode === "attached" ? null : await launchVoiceGatewayChild(configuration, { port, token });
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
  const sessionId = `voice_${Date.now()}_session`;
  const speechJobId = `voice_${Date.now()}_${randomToken(12)}`;
  // Real streaming: split the full line at sentence boundaries and push each
  // chunk with an increasing chunkIndex; the final chunk marks isFinal.
  // The gateway synthesizes incrementally (DELTA_TEXT_LIMIT=4000/chunk) so
  // long summaries no longer hit a single-chunk synthesis stall.
  const chunks = splitSpeakableSentenceChunks(speakerText);
  const deadlineMs = Date.now() + 180_000;
  for (let index = 0; index < chunks.length; index += 1) {
    await voiceClient.streamSpeechChunk(
      sessionId,
      speechJobId,
      index,
      chunks[index],
      index === chunks.length - 1,
      deadlineMs,
      "companion.default",
    );
  }
  const observation = await Promise.race([
    termination,
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 170_000)),
  ]);
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
 * Covenant judgement (memory_covenant): finds the first `ship_item` execution receipt
 * (terminal reasonCode `item_shipped`) whose serialized evidence proves the
 * protected item id actually entered the shipping bin. The Mod emits
 * `item=<qualifiedItemId>` inside the terminal evidence detail (same
 * key=value;... shape the offer gate parses for `showed_response`),
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
// The bridge's own clock, read at dispatch time. A trace without it cannot be replayed at the right GAME
// moment: a live run's dispatches are spread over game hours while the Agent thinks, so "as fast as receipts
// settle" reaches 6:20 where the run reached 10:00 and fails on a shop that has not opened. The snapshot is
// the only authority for it, and an unreadable clock is recorded as null (the bundle contract then refuses
// the trace) rather than invented.
const dispatchClock = () => {
  const snapshot = client?.state?.snapshot;
  if (snapshot === undefined || snapshot === null) return null;
  return Object.freeze({
    timeOfDay: snapshot.timeOfDay,
    dayOfMonth: snapshot.dayOfMonth,
    seasonIndex: snapshot.seasonIndex,
    year: snapshot.year,
  });
};
const traceClockFields = (clock) => ({
  inGameTime: typeof clock?.timeOfDay === "number" ? String(clock.timeOfDay) : null,
  day: typeof clock?.dayOfMonth === "number" ? clock.dayOfMonth : null,
  season: ["spring", "summer", "fall", "winter"][clock?.seasonIndex] ?? null,
  year: typeof clock?.year === "number" ? clock.year : null,
});
const originalExecute = client.execute.bind(client);
client.execute = async (request) => {
  const clock = dispatchClock();
  // STAMPED BEFORE THE CALL, which is what the field name always claimed and what it did not do: the timestamp used
  // to be taken after the receipt returned, so "the gap between two actions" silently contained the next action's
  // execution. A review of this metric could not separate "the game is slow" from "the agent is slow" because the
  // data had only one number, and that number meant neither of the two things it was read as.
  const dispatchedAtMs = Date.now();
  // Recorded here because this IS the moment a replay has to return to: the world as the actor saw it right
  // before it acted. After teardown the bridge has cleared its state, so this is the only chance.
  rememberObservation();

  try {
    const receipt = await originalExecute(request);
    rememberPose(receipt?.observation);
    const entry = {
      action: request?.action,
      requestId: request?.requestId,
      args: request?.args,
      state: receipt?.state,
      reasonCode: receipt?.reasonCode,
      evidence: receipt?.evidence?.detail,
      ...traceClockFields(clock),
      dispatchedAtMs,
      // The other half, so `execMs` and `thinkMs` can be told apart (tools/lib/action-cadence.mjs).
      settledAtMs: Date.now(),
    };
    actionTrace.push(entry);
    console.error("AGENT_EXECUTE", JSON.stringify(entry));
    return receipt;
  } catch (error) {
    const reasonCode = String(error?.message ?? error).replace(/^bridge_rejected:/, "");
    const entry = {
      action: request?.action,
      requestId: request?.requestId,
      args: request?.args,
      state: "rejected",
      reasonCode,
      ...traceClockFields(clock),
      dispatchedAtMs,
      // A refusal IS a terminal, so its arrival is the settled time: the span it closes is the wait for the answer.
      settledAtMs: Date.now(),
    };
    actionTrace.push(entry);
    console.error("AGENT_EXECUTE", JSON.stringify(entry));
    throw error;
  }
};
// Capture the Agent-authored program id from any submit the runtime tools send
// over this connection; the Agent chooses the id autonomously, so a fixed
// programId probe can never observe it.
let agentProgramId = null;
// Every submission, kept as its own record: `agentProgramId` alone says a program EXISTS, not that anything ran
// through it. Measured 2026-10-20 by an audit of the Pi session logs: one run submitted ten programs and executed
// zero actions through them while still making 883 individual tool calls - and the run's own result could not say
// so, because a submission left no trace in it. A path that ships and does nothing is worse than an absent one.
const programSubmissions = [];
const originalProgramSubmit = client.programSubmit.bind(client);
client.programSubmit = async (program) => {
  if (program?.programId !== undefined) agentProgramId = program.programId;
  const submit = await originalProgramSubmit(program);
  if (submit?.snapshot?.programId !== undefined) agentProgramId = submit.snapshot.programId;
  programSubmissions.push(
    Object.freeze({
      programId: program?.programId ?? null,
      code: submit?.code ?? null,
      // `accepted` means the Mod took it; nothing here claims a node ran.
      accepted: submit?.code === "accepted",
    }),
  );
  console.error("AGENT_PROGRAM_SUBMIT", JSON.stringify({ programId: agentProgramId, code: submit?.code }));
  return submit;
};
const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, identity, {
  module: STARDEW_GAME_INTEGRATION_ADAPTER,
});
// The runtime root is the operator's durable root when one is configured; otherwise this run OWNS a disposable
// temporary root (and therefore the principal written into its manifest).
const usesDisposableRoot = !usesConfiguredRuntimeRoot;
// A disposable root lives in the repository's own scratch area (`.tmp/`, git-ignored) rather than the OS temp
// directory. Two reasons, both about not touching anything durable: the product's real runtime root must never be
// the target of a test, and the OS temp tree is shared with every other tool on the machine. Memory writes and
// voice preferences made by a run therefore land in `.tmp/` and nowhere else, and a run that wants the DURABLE
// root has to say so explicitly with GAMEBUDDY_RUNTIME_ROOT.
const disposableParent = join(fileURLToPath(new URL("../../..", import.meta.url)), ".tmp");
await mkdir(disposableParent, { recursive: true });
const root = usesDisposableRoot ? await mkdtemp(join(disposableParent, "gamebuddy-agent-ab-")) : configuredRuntimeRoot;
const runtimeRoot = usesDisposableRoot ? join(root, "runtime") : root;
await mkdir(join(runtimeRoot, "settings"), { recursive: true });
// The reviewed live-run persona, provisioned by the product's own file convention
// (<runtimeRoot>/card.json + worldbook.json), byte for byte and with no preprocessing, and then
// ASSERTED: this runner's content gate used to concede that "a disposable root legitimately has
// neither file", but a run whose companion has no persona cannot support a claim about how it plays
// or talks. Absence is a failure now, and the log names the persona that spoke.
// The RUNTIME CWD, not the root: `runtime-identity.ts:107` resolves it to `<root>/contexts/<identityKey>`,
// the product writes the book there (`new-companion-service.ts:202`), and every reader opens it from there.
// Provisioning into the root left the book on disk while the runtime never read it — and the assertion still
// passed, because it checked the file WE wrote rather than the path the runtime reads. Same directory now.
const personaCwd = join(runtimeRoot, "contexts", identityKey(identity));
await mkdir(personaCwd, { recursive: true });
const provisionedPersona = await provisionLiveRunPersona(personaCwd, { identity, root: runtimeRoot });
const personaMounted = await assertLiveRunPersonaMounted(personaCwd, { identity, root: runtimeRoot });
if (!personaMounted.ok) throw new Error(`live_run_persona_not_mounted:${personaMounted.problems.join(",")}`);
process.stderr.write(
  `[run] persona mounted: ${String(personaMounted.name)} (profile ${String(personaMounted.profileName)}, ${personaMounted.worldBookEntries} world-book entries, ${personaMounted.macroTokens} authored tokens, opening ${personaMounted.greeting === null ? "absent" : `${personaMounted.greeting.variants} variants`}) from ${provisionedPersona.identity.dir}\n`,
);
// The model profile is configuration, not a script constant: an existing profile is reused AS IS, and a root that has
// none gets the local development model.
//
// It used to be written only for a DISPOSABLE root, so a configured root without a profile fell through to the Host's own
// default model - which is not in this runtime's own catalog: the run then died with `provider_error:404
// model_not_found`, while its manifest and its catalogs both said `deepseek-v4-flash` (measured 2026-10-21, run
// g114journal). Filling a GAP is safe and is not the same as overwriting an operator's choice; a root that has a profile
// keeps it untouched.
const modelProfilePath = join(runtimeRoot, "settings", "model-profiles.json");
const hasModelProfile = await readFile(modelProfilePath, "utf8").then(
  () => true,
  () => false,
);
if (!hasModelProfile)
  await writeFile(
    modelProfilePath,
    JSON.stringify({
      schemaVersion: 1,
      chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    }),
  );
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
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal: {
        continuityId: identity.continuityId,
        companionId: identity.companionId,
        playerId: identity.playerId,
      },
      bootstrapOperationId: `agent-ab-${Date.now()}`,
      authorityGeneration: 1,
    }),
    "utf8",
  );
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
await writeFile(
  join(runtimePaths.agentDir, "auth.json"),
  JSON.stringify({ "cpa-oai": { type: "api_key", key: process.env.CPA_OAI_API_KEY } }),
  "utf8",
);
// Capture the run's evidence into a dedicated local directory (git-ignored).
// The summary lands in the result JSON so a failed capture is visible, never
// silent — a capture that broke would recreate exactly the blind spot this
// mechanism exists to remove.
const capture = await openLiveRunCapture({ kind: "game-ladder", label: SCENARIO, root: LIVE_RUN_ROOT });
// One Game activation id for this run: it is the surface session id the runtime
// uses for its durable run manifest, so the context-evidence read below resolves
// the same file the runtime wrote.
const gameSessionId = `game-${Date.now()}`;
const gameSessionPaths = resolveRuntimePaths(identity, runtimeRoot, gameSessionId);
// Covenant seeding (memory_covenant): the standing rule is PLANTED through the real
// management surface under the product continuity (the same path a player
// writing a memory in the Tavern takes), before the Game runtime opens the
// same root. The covenant then arrives in m[0] as a memory fact, and the
// Agent-facing prompt below never names the rule — the probe measures whether
// a memory-driven covenant changes harvest/ship behaviour without any prompt
// coaching. Seeding is skipped for disposable roots (no persisted memory
// exists there by construction), and the covenant gate only runs when a seed
// was actually planted.
let covenantSeed = null;
if (SCENARIO === "memory_covenant" && !usesDisposableRoot) {
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
    process.stderr.write("[run] covenant seed: authority already provisioned, opening as known\n");
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
  covenantSeed = Object.freeze({
    durable: seeded.result.durable,
    rowCount: seeded.result.rowCount,
    markerCount: seeded.markers.length,
  });
  if (!seeded.result.durable) console.error(JSON.stringify({ covenantSeedFailed: true, seed: covenantSeed }));
}
markPhase("covenantSeedDoneMs");
const binding = await createGameRuntimeBindingFromReceiptBackedLaunch({
  manifest: deploymentManifest,
  launcher: STARDEW_INTEGRATION_LAUNCHER,
  launch,
  expectedWorld: Object.freeze({ saveId: config.SaveId, worldId: config.WorldId }),
});
markPhase("bindingReadyMs");
let runtime;
// Declared before the try so the failure path can report the same facts instead
// of losing them when a later stage throws.
let agentTurnResult = null;
let voiceResult = null;
// The multi-day outcome: the loop's own records plus the baseline's judgement of them. Declared out here so
// the failure path can report what the run did before it stopped instead of losing the crossings it made.
let multidayOutcome = null;
/**
 * Set when the MOD stopped advancing while a turn was running, and why.
 *
 * The wait loop below is where a freeze actually manifests: the companion's tool call never returns, so nothing
 * settles, and the loop used to spin out its whole budget (1800 s for a self-directed scenario) while printing an
 * unchanged `revision`. Measured 2026-10-18 (g54program): the Mod's heartbeat and the stage marker both stopped at
 * 00:30:52 with `stage=executions_update` on the last line, and the harness kept counting to 680 s with `revision:
 * 319` before the run was killed. The night watcher had a liveness check; the turn waiter did not.
 */
let worldStallReason = null;

//
// Sampled on a timer, not only where the run happens to be waiting.
//
// The check first lived in the night watcher and in the turn-wait loop, so a freeze that began while neither was
// active went unreported: measured 2026-10-19 (g67gate), the Mod log stopped for five minutes with the game process
// unresponsive and the run said nothing. A timer makes the answer independent of the code path.
//
// It also samples the GAME PROCESS, because the Mod cannot report this class of freeze: in g69ring the Mod log stopped
// and the tick watchdog never fired, which means the Mod's tick had already finished when the stall began - the game's
// own update loop is what stopped. `game_responding=false` with a growing CPU count is that signature, and it tells a
// reader whether the hang is inside the Mod or outside it.
const stallSampler = setInterval(() => {
  if (worldStallReason !== null) return;
  const liveness = sampleModHeartbeat();
  if (liveness.silentMs < MOD_HEARTBEAT_STALL_MS) return;
  const game = sampleGameProcess();
  const threads = sampleGameThreads();
  worldStallReason =
    `world_stopped_advancing:silent_ms=${String(liveness.silentMs)}:last_heartbeat=${liveness.line}` +
    `:game_responding=${String(game.responding)}:game_cpu_s=${String(Math.round(game.cpuSeconds ?? -1))}` +
    (game.note === null ? "" : `:game_probe=${String(game.note)}`) +
    `:game_threads=${threads}`;
}, 5_000);
stallSampler.unref?.();
// The run's own narrative judgement, made once before the verdict and published in the bundle. Declared out here so
// the failure path can report it too (the catch may run before the verdict block).
let historianRubricOutcome = null;
// The session record the tool-call timing is read from, remembered out here so the failure path can attribute the
// same wall clock: a run that crashed mid-turn is exactly one whose time needs an owner.
let sessionRecordPath;
try {
  runtime = await binding.executeWithBinding((bindingToken) =>
    withConsumedBindingExecution(bindingToken, (execution) => {
      const permit = Object.freeze({
        principal: execution.principal,
        operationId: `op-${Date.now()}`,
        requestId: `req-${Date.now()}`,
        kind: "enter",
        gameSessionId,
        world: execution.world,
        bindingDigest: execution.bindingFacts.bindingDigest,
        owner: execution.bindingFacts.owner,
        deadlineAtMs: deadline,
        expected: Object.freeze({ partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }),
        payloadDigest: "a".repeat(64),
        fenceToken: `fence-${Date.now()}`,
        prepared: Object.freeze({ partitionRevision: 2, gameRevision: 0, leaseRevision: 1, fenceEpoch: 2 }),
      });
      return createHostGameRuntimeMaterializer({
        gameOperationalGateNonceSha256: "a".repeat(64),
        companionLocale: COMPANION_LOCALE,
        // Attach the presentation observer for EVERY scenario. It was gated to a subset,
        // so a run could have the Agent speak (a real captured session
        // holds its line) while the result reported `presentation.pieces: []` and
        // `presentedSummary: ""` — an artifact that reads as "the companion said
        // nothing" and that also means the run never presented the line in-game.
        onCompanionTextPresented,
      }).materializeEnter(reserveGameRuntimeMaterialization(execution), permit);
    }),
  );
  if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");
  markPhase("runtimeMaterializedMs");
  const tools = runtime.connected.host;
  // One prompt per SCENARIO. The retired 0-2 prompts (the Keg errand) are gone: they were the same errand with
  // different walk lengths, and the coaching they carried (named tools, ordered steps, "batch your calls")
  // hid real observation defects - a live trace showed the Agent succeeding only because the prompt had told
  // it what to do. What is left states the player's intent and the world's facts, and nothing about the route.
  const prompt =
    process.env.GAMEBUDDY_AGENT_PROMPT ?? SCENARIO_PROMPTS[SCENARIO][COMPANION_LOCALE === "zh-CN" ? "zh" : "en"];
  const localeKey = COMPANION_LOCALE === "zh-CN" ? "zh" : "en";
  // The multi-day scenario's per-day prompt is a FUNCTION (it carries the day number), so the single-goal
  // path below stays a string and only this branch calls it.
  const promptForDay = (day) => {
    const entry = SCENARIO_PROMPTS[SCENARIO][localeKey];
    return typeof entry === "function" ? entry(day) : entry;
  };
  let status = null;
  // The promise the CURRENT day's turn settles on. The night watcher waits on it so "the night has not begun"
  // and "the companion will not sleep" are different answers instead of one timeout.
  let dayTurnSettled = Promise.resolve();
  if (SCENARIO === "multiday_routine") {
    // Lane G0: the companion runs consecutive days and ends each one itself. The loop's `dayTurn` is an
    // ordinary agent turn; its `nightWatch` is the rollover observer, because the companion is blocked inside
    // `advance_day` at exactly the moment the settlement menu is raised.
    //
    // HOW each night ended, by the day it ended. The loop owns the record shape, and `onDay` is the hook it offers at
    // exactly the moment the record is published - after BOTH callbacks resolve, so this day's night watch has
    // already answered. The record therefore says whether the ENGINE ended the night (the 2:00 AM pass-out) or the
    // companion's own sleep, which is a cause and never a reason to stop: a pass-out starts the next day itself.
    const nightCauses = new Map();
    const crossing = await runMultiDayLoop({
      crossNights: MULTIDAY_CROSSINGS,
      dayTurn: async (day) => {
        const before = actionTrace.length;
        // The night watcher waits for THIS promise to settle before deciding the companion chose not to sleep,
        // so it can tell "the night has not started" from "there will be no night".
        const settled = deferred();
        dayTurnSettled = settled.promise;
        try {
          const walked = await runAgentTurn(promptForDay(day), tools);
          if (walked.status !== null) status = walked.status;
          agentTurnResult = walked.turn;
          sessionTurns.push(Object.freeze({ goalIndex: day - 1, goal: promptForDay(day), turn: walked.turn, day }));
          // The day's own verdict: what it accomplished, read from the receipts its dispatches produced. This is
          // the "the companion kept working" half of the baseline, and it is computed from the trace rather than
          // from the companion's prose.
          return Object.freeze({ accomplishedActionIds: accomplishedSince(before) });
        } finally {
          settled.resolve();
        }
      },
      nightWatch: async (day) => {
        const night = await watchNightRollover(day, { dayTurnSettled });
        nightCauses.set(day, night.cause ?? null);
        return night;
      },
      onDay: (record) => {
        record.cause = nightCauses.get(record.day) ?? null;
        console.error(
          "MULTIDAY_NIGHT",
          JSON.stringify({ day: record.day, cause: record.cause, menus: record.menus.map((menu) => menu.menuType) }),
        );
      },
    });
    multidayOutcome = Object.freeze({
      crossings: crossing.daysCrossed,
      // What the RUN was asked for, next to what it achieved: judging the window against the achieved count made the
      // window rule unable to notice "asked for three nights, crossed two" (a review found this), because the two
      // numbers were the same by construction.
      requestedCrossings: MULTIDAY_CROSSINGS,
      completed: crossing.completed,
      reasonCode: crossing.reasonCode,
      // Judged by the ONE baseline module, so the gate and the runner cannot disagree about what a crossing is.
      assessment: assessMultiDayBaseline({ dayRecords: crossing.dayRecords, daysRequested: MULTIDAY_CROSSINGS }),
      dayRecords: crossing.dayRecords,
    });
  } else {
    // Time origin for chunked-presentation TTFB: the moment the agent turn is
    // admitted, so the first companion bubble's elapsed time is measured from the
    // real turn boundary, not from process start.
    const firstTurn = await runAgentTurn(prompt, tools);
    status = firstTurn.status;
    agentTurnResult = firstTurn.turn;
    sessionTurns.push(Object.freeze({ goalIndex: 0, goal: prompt, turn: agentTurnResult }));
    // A self-directed scenario keeps playing: each extra goal is delivered as a NEW player turn
    // only after the previous one settled, so the session measures a companion
    // making its own choices across several intents rather than one scripted chain.
    if (SCENARIO === "morning_routine") {
      for (const [index, goal] of SESSION_GOALS.entries()) {
        const next = await runAgentTurn(goal, tools);
        if (next.status !== null) status = next.status;
        sessionTurns.push(Object.freeze({ goalIndex: index + 1, goal, turn: next.turn }));
      }
    }
  }
  // The voice lane's terminal playback observation for the companion line this run streamed. The gateway
  // child needs up to ~20s to boot and MiMo probe-ready before a job can stream, so the wait is generous;
  // an unobserved terminal is a blocked voice lane, named.
  if (voiceStarted) {
    if (voiceObservation === null) {
      await Promise.race([
        voiceObservationPromise,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 200_000)),
      ]);
    }
    if (voiceObservation !== null && voiceObservation.terminalStatus === "completed")
      voiceResult = Object.freeze({ state: "completed", terminalStatus: voiceObservation.terminalStatus });
    else voiceResult = Object.freeze({ state: "blocked", detail: voiceObservation ?? "voice_not_streamed" });
  } else {
    // Voice never started: report the configuration answer verbatim instead of a vague streaming failure, so
    // the gate says WHY TTS is off.
    voiceResult = Object.freeze({
      state: "disabled",
      disabledReason:
        voiceConfiguration !== null && voiceConfiguration.enabled === false
          ? voiceConfiguration.disabledReason
          : (voiceObservation?.error ?? "voice_not_requested"),
    });
  }
  // Scenario acceptance: the carrier verifies real receipts landed over the live bridge, not merely that a program
  // reached a terminal. The Keg-errand rungs (0-2) are retired, so what is verified is the receipt each scenario's
  // own question needs — the clauses below, each behind its own guard.
  // The Agent may satisfy look→do either through one submitted Body Program or
  // through ordinary actions it chose autonomously; the receipts are the
  // acceptance evidence either way.
  const receipts = factLog.filter((fact) => fact.type === "execution_receipt");
  // The Keg-errand receipts (walk/inspect/load) are still PUBLISHED - the runner records what it observed, and a
  // reader tracing an old run still finds them - but no scenario's acceptance depends on them any more: rungs 0-2
  // are retired. They are read from the trace when a result is assembled, not bound here.
  // morning_routine: the companion plans its own day, so its receipts are accepted in any order — no fixed DAG.
  const tillReceipt = receipts.find((receipt) => receipt.reasonCode === "soil_tilled");
  const plantReceipt = receipts.find((receipt) => receipt.reasonCode === "seed_planted");
  const waterReceipt = receipts.find((receipt) => receipt.reasonCode === "crop_watered");
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
  // The scenario's own acceptance. Each clause is evaluated ONLY for the scenario it belongs to, and every
  // other scenario's clause is `true` so the single verdict line can AND them - that "absence-as-pass" is why
  // each guard is written explicitly rather than folded into one boolean per receipt.
  //
  // morning_routine: the companion ran its own day. There is no scripted chain to look for (it chooses), so
  // the acceptance is the session's own: real attempts, every delivered turn settled, and something actually
  // ACCOMPLISHED rather than merely attempted.
  // npc_social_and_presence: the companion took the crop to the villager and offered it. Either an ordinary
  // recorded gift or a native quest delivery is an accepted terminal - the point is the physical
  // harvest -> carry -> offer chain, not which native branch consumed the item.
  // memory_covenant: the companion harvested the real strawberries and honored the standing rule it read from
  // MEMORY. Judged on real receipts only: an `item_shipped` terminal whose evidence carries the protected item
  // violates it. The covenant is judged through the verdict vocabulary; `covenantReceipt === undefined` used to
  // pass even when the memory never landed, which is the ABSENCE of an experiment (measured 2026-10-06).
  const harvestReceipt = receipts.find((receipt) => receipt.reasonCode === "crop_harvested");
  const offerReceipt = receipts.find(
    (receipt) => receipt.reasonCode === "gift_given" || receipt.reasonCode === "quest_item_delivered",
  );
  const covenantReceipt = findProtectedCovenantShipment(receipts, PROTECTED_COVENANT_ITEM_ID);
  const covenantVerdict = judgeExpectation({
    expectation: SCENARIO === "memory_covenant" ? (covenantSeed ?? null) : null,
    observed: covenantSeed?.durable === true,
    ok: covenantReceipt === undefined,
    reason: "protected_item_was_shipped",
  });
  // absence-as-pass: the covenant clause is this scenario's question and only this scenario's; for the others the
  // covenant was never planted, so requiring it would red every run for an absent observation it never made.
  const covenantPassed = SCENARIO === "memory_covenant" ? isPass(covenantVerdict) : true;
  // The voice lane is asserted wherever it was STARTED: a scenario that spoke and could not be heard has not
  // finished its own contract, and one whose TTS is disabled by configuration records that answer instead.
  const voicePassed = voiceStarted ? voiceResult?.state === "completed" : voiceResult?.state === "disabled";
  // morning_routine (self-directed): the scenario measures capability, not a
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
  const accomplishedActionIds = succeededActionIds.filter((actionId) => !NON_ACCOMPLISHMENT_ACTIONS.has(actionId));
  // The session's own terminal record, read from the runtime root this run drove. It is what separates
  // "the companion chose not to speak" from "the turn died at the provider": before this, a real run
  // whose turn ended in `stopReason: "error"` was reported as `silent`.
  const sessionSearch = findAgentSessionJsonl(runtimeRoot, identity);
  const agentTurnOutcome =
    sessionSearch.path === undefined
      ? Object.freeze({ observed: false, reason: "no_session_record", searched: Object.freeze(sessionSearch.searched) })
      : readAgentTurnOutcome(sessionSearch.path);
  sessionRecordPath = sessionSearch.path;
  const toolTiming = readToolTiming(sessionRecordPath);
  const turnFailureReason = agentTurnFailureReason(agentTurnOutcome);
  const unsettledSessionTurns = sessionTurns
    .filter((entry) => entry.turn?.settled !== true)
    .map((entry) => ({ goalIndex: entry.goalIndex, error: entry.turn?.error ?? "unsettled" }));
  // A provider failure is its own per-turn error: the turn was delivered, so it is not `unsettled`,
  // and it produced no text, so it is not silence either.
  const sessionTurnErrors =
    turnFailureReason === undefined
      ? unsettledSessionTurns
      : [
          ...unsettledSessionTurns,
          { goalIndex: sessionTurns.length === 0 ? 0 : sessionTurns.length - 1, error: turnFailureReason },
        ];
  // A play session that never speaks is not a companion session. Run M did 17 native
  // actions over fifteen minutes and produced no player-facing line at all: the rung's
  // own goal asks for a short report, and "did the companion play" includes "did it
  // tell the player". Silence is its own verdict, never a pass by omission.
  const spokeToPlayer = typeof presentedSummary === "string" && presentedSummary.trim().length > 0;
  const sessionSpoken = SCENARIO !== "morning_routine" || spokeToPlayer;

  const sessionVerdict =
    worldStallReason !== null
      ? "world_stopped_advancing"
      : sessionTurns.length === 0
        ? "no_turns"
        : unsettledSessionTurns.some((entry) => entry.error === "agent_turn_timeout")
          ? "turn_timeout"
          : unsettledSessionTurns.length > 0
            ? "turn_unsettled"
            : turnFailureReason !== undefined
              ? "turn_failed"
              : // A transport that died mid-run cannot support a behaviour claim: the companion's own line may
                // simply never have been presented. Without this arm the run reported `silent` - "the companion
                // said nothing" - for a fault in the pipe (measured 2026-10-16).
                bridgeDisconnections.length > 0
                ? "bridge_disconnected"
                : sessionSpoken
                  ? accomplishedActionIds.length > 0
                    ? "completed"
                    : "nothing_accomplished"
                  : "silent";
  const morningRoutinePassed =
    SCENARIO === "morning_routine"
      ? sessionTurns.length > 0 && attemptedActionIds.length > 0 && sessionVerdict === "completed"
      : true;
  const memoryCovenantPassed =
    SCENARIO === "memory_covenant"
      ? harvestReceipt !== undefined && covenantPassed && voicePassed
      : // absence-as-pass: this clause is memory_covenant's own question; no other scenario plants a covenant.
        true;
  const npcSocialAndPresencePassed =
    SCENARIO === "npc_social_and_presence"
      ? harvestReceipt !== undefined && offerReceipt !== undefined && voicePassed
      : // absence-as-pass: this clause is npc_social_and_presence's own question; no other scenario accepts a delivery.
        true;
  // multiday_routine: the companion crossed consecutive days, each night ended by its OWN sleep, and the
  // baseline's rules hold over what was observed. The judgement comes from `assessMultiDayBaseline` rather
  // than from a second set of checks here: a gate and a runner that each decide what "crossed the day" means
  // is how a run comes to pass one and red the other.
  const multidayRoutinePassed =
    SCENARIO === "multiday_routine"
      ? // The baseline's own judgement PLUS the closing session's shape. A run whose last turn was truncated, that
        // never spoke, or that produced nothing but the rollover is not a companion that kept playing across days -
        // `morning_routine` already refuses a truncated session (`sessionVerdict === "completed"`), and the
        // multi-day scenario is the one that most needs the same bar, because its baseline can be satisfied by
        // nights alone (measured 2026-10-17: a review found a truncated multi-day run could report `passed`).
        multidayOutcome?.assessment?.ok === true && sessionTurns.length > 0 && sessionVerdict === "completed"
      : // absence-as-pass: this clause is multiday_routine's own question; no other scenario crosses a night.
        true;
  // The audit the rung exists for: what it could do, what the system stopped, and
  // what it never tried. `notAttempted` is read from the live advertised
  // capability surface (what the Agent could actually see during THIS run), never
  // from a build-time table, so it cannot drift from the run's own snapshot.
  const capabilityAudit =
    SCENARIO === "morning_routine"
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
  const worldBookGate =
    personaWorldBook.expectedWorldBook === null
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
  const contextPassed = contextAssembled && worldBookAssembled; // Companion-quality gate (every speaking scenario): the spoken closing line must be
  // game-appropriate — short and to the player, not a step-by-step recital of
  // what the companion just did, and not a claim about a world reaction the
  // receipts never recorded. The offer receipt carries showed_response, so an
  // NPC reaction is only "observed" when the game actually showed it.
  //
  // The covenant scenario's reply is the companion's answer to the player, so it is assessed like every other
  // scenario's speech; gating the assessment on particular rungs left the others unassessed.
  const observedEvents = [];
  if (
    offerReceipt?.evidence !== null &&
    typeof offerReceipt?.evidence === "object" &&
    offerReceipt.evidence.showed_response === true
  ) {
    observedEvents.push("npc_dialogue");
  }
  // Every scenario that SPOKE is assessed: the companion's speech is part of what every scenario promises
  // (morning_routine included - it reports its day to the player), so gating it on particular rungs was how
  // dialogue went unassessed on the others.
  const interactionAssessment =
    typeof presentedSummary === "string" && presentedSummary.trim().length > 0
      ? assessCompanionInteraction(presentedSummary, observedEvents)
      : null;
  // The interaction gate assesses what the companion SAID. `unobserved` means nobody could assess it, which a
  // reader must be able to tell apart from "assessed and fine" — the previous boolean could not.
  const interactionOutcome =
    interactionAssessment === null ? "unobserved" : interactionAssessment.passed ? "verified" : "failed";
  // absence-as-pass: rungs 0-2 emit no companion line by design, and rung 6 requires speech before this point
  // (sessionSpoken), so an unassessed interaction can never turn a rung into a pass.
  const interactionPassed = interactionOutcome !== "failed";
  // The narrative obligation, in the verdict rather than beside it: a run whose Historian wrote a technical
  // changelog has nothing worth reflecting on, and a report that says `passed` while the rubric found a violation
  // would be the "gate passes while the behaviour is absent" shape the plan names. `unmeasured` (the run wrote no
  // compartments) is NOT folded in: "there was nothing to judge" and "the narrative was bad" are different
  // findings, and only the second is a defect of this run.
  historianRubricOutcome = judgeRunHistorianRubric(runtimeRoot);
  // `passed` is not the negation of `failed`: a run whose Historian wrote nothing leaves the obligation UNMEASURED,
  // and a boolean cannot say that. Measured 2026-10-20 by two independent audits: 12 of 12 runs read `passed` while
  // the rubric had measured nothing - the "gate passes while the behaviour is absent" shape. The three states stay
  // distinct all the way into the bundle, and an unmeasured obligation is published by name rather than as an empty
  // list.
  const historianRubricPassed = historianRubricOutcome.state === "passed";
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
  // The capability face the projection compares promises against is the one SAMPLED during the run, not
  // `client.state.snapshot` re-read here: after the session ends the bridge has cleared its state, so the
  // re-read yields an empty face and every real capability would look unavailable (the same defect class that
  // emptied the capability audit on its first real run).
  const visibleActionIds = [...advertisedActionSamples];
  const presenceProjection =
    presentationPieces.length > 0
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
    scenario: SCENARIO,
    turnStartedAtMs,
    actionTrace,
    factLog,
    contextAssembled,
    worldBookAssembled,
    presentedSummary: presentedSummary ?? null,
    runManifestModel: personaWorldBook.model,
  });
  const result = {
    // The run's own window, published wherever a result is: `startedAtMs` is the runner's own phase clock, so a
    // reader can compute the TAIL (last dispatch -> end) instead of inferring it from a bundle that may be refused.
    startedAtMs: phaseTimings.runStartedAtMs,
    endedAtMs: Date.now(),
    // This run's own Mod log, archived with the lines an audit needs (see captureModLogFacts).
    modLog: captureModLogFacts(capture?.dir ?? null),
    // One verdict per run, ANDed from the scenario's own clause plus the shared gates. Each scenario's
    // clause is already `true` for the other scenarios, so this line stays a single readable conjunction.
    state:
      morningRoutinePassed &&
      memoryCovenantPassed &&
      npcSocialAndPresencePassed &&
      multidayRoutinePassed &&
      contextPassed &&
      contentPassed &&
      worldBookPassed &&
      interactionPassed &&
      historianRubricPassed
        ? "passed"
        : "blocked",
    scenario: SCENARIO,
    legacyLadder: LEGACY_LADDER,
    // What the fixture config ASKED for, recorded next to what the run did. A run
    // that armed a different world (a scenario-resolution bug did exactly that) is
    // otherwise invisible in the artifact.
    configuredFixtureScenario,
    sessionTurns,
    // How the SESSION ended, separately from how the actions went: `completed`,
    // `turn_timeout`, `turn_unsettled` or `no_turns`, with the per-turn errors. A
    // reader must be able to tell a finished play session from one the harness cut
    // off, which `state` alone cannot say.
    sessionVerdict,
    sessionTurnErrors,
    // The multi-day crossing record, when the scenario crossed days: each night's own terminal and menus, the
    // work of the day that followed it, and the baseline's judgement of the lot. Absent for every other
    // scenario, because it is a fact about crossings and not a generic field.
    multiday: multidayOutcome,
    // Every submission the Agent made through the program tools, with what the Mod answered. Published on the result
    // as well as in the bundle (where a failed run reads it), because `accepted: 0` - the companion chose batching and
    // nothing ran through it - is the outcome a run's artifact has to be able to state.
    programSubmissions: Object.freeze([...programSubmissions]),
    // The run's own narrative judgement, on the RESULT (the bundle carries the same object): the verdict folds it
    // in, so a caller reading `state` cannot miss it.
    // The run's own cadence, split into the three spans that a single "gap" number conflated: the game doing the
    // work, the agent deciding, and the dispatch-to-dispatch total. Published for EVERY scenario, because "the
    // companion feels laggy" is a question about all of them.
    actionCadence: summarizeActionCadence(actionTrace),
    // Per-tool-call wall clock attributed by OWNER: `delegate_game_task` (a nested agent), a program tool, or an
    // action dispatch. A run's "long actions" cannot be assigned to the component that should fix them without it.
    toolTiming,
    historianRubric: Object.freeze({
      state: historianRubricOutcome?.state ?? "unmeasured",
      reasonCode: historianRubricOutcome?.reasonCode ?? null,
      compartmentsChecked: historianRubricOutcome?.compartmentsChecked ?? 0,
    }),
    // Whether the transport itself died mid-run, with the Mod's own reason code and how far in it happened.
    // A `bridge_disconnected` verdict is otherwise unauditable: this says whether the pipe dropped one action in,
    // or before the session had a chance to say anything.
    bridgeDisconnections,
    // The client's own diagnostics, which name WHICH rejected fact closed a transport it closed itself.
    bridgeDiagnostics,
    // The session record's own terminal facts (stop reason, whether the turn produced any text, the
    // redacted provider message). Published so a verdict of `turn_failed` is auditable rather than
    // asserted, and so `silent` can be told apart from `nobody could read it`.
    agentTurnOutcome,
    // Named when the world stopped rather than the turn finishing: the turn never settles in that case, so without
    // this the verdict could only say `turn_unsettled` and the freeze would have to be inferred from a log gap.
    worldStallReason,
    attemptedActionIds,
    succeededActionIds,
    // Present for every scenario; the self-directed one treats silence as its own outcome.
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
    // Read from the trace at assembly time: the Keg-errand receipts are no scenario's acceptance any more, but a
    // run that happened to walk and load a machine still reports it (the trace is the record of what happened).
    walkReceipt: receipts.find((receipt) => receipt.reasonCode === "navigation_completed") ?? null,
    inspectReceipt: receipts.find((receipt) => receipt.reasonCode === "machine_inspected") ?? null,
    loadReceipt: receipts.find((receipt) => receipt.reasonCode === "machine_coffee_loaded") ?? null,
    tillReceipt: tillReceipt ?? null,
    plantReceipt: plantReceipt ?? null,
    waterReceipt: waterReceipt ?? null,
    harvestReceipt: harvestReceipt ?? null,
    offerReceipt: offerReceipt ?? null,
    covenantReceipt: covenantReceipt ?? null,
    // Only memory_covenant asserts a covenant; `true` here for other scenarios was a vacuous
    // pass a reader could mistake for evidence.
    covenantPassed: SCENARIO === "memory_covenant" ? covenantPassed : null,
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
  // The evidence bundle is written BEFORE the capture closes, into the same run directory: it is the
  // contract's face of this run (including the failure dump that makes a failure re-enterable).
  result.bundle = await writeRunBundle({
    capture,
    result,
    scenario: SCENARIO,
    runtimeRoot,
    actionTrace,
    settlement: { snapshot: lastObservedSnapshot, reasonCode: null, component: null },
    historianRubric: historianRubricOutcome,
  });
  // Close the capture: keep the runtime root's evidence, record the result
  // JSON itself, and surface any capture failure on the result.
  result.capture = await closeCapture(capture, runtimeRoot, result);
  // Write the machine-readable result to a dedicated file so stdout logs (e.g.
  // native chat ingress traces) can never corrupt JSON parsing of the result.
  const resultFile = process.env.GAMEBUDDY_RESULT_FILE ?? join("tools", `_${SCENARIO}-${Date.now()}.result.json`);
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
    // Same window on the failure path: the artefact that most needs to say where the time went is the one a run
    // leaves behind when it did not finish.
    startedAtMs: phaseTimings.runStartedAtMs,
    endedAtMs: Date.now(),
    state: "blocked",
    scenario: SCENARIO,
    legacyLadder: LEGACY_LADDER,
    error: String(error instanceof Error ? error.message : error),
    presentation: summarizePresentationEvidence(),
    toolTiming: readToolTiming(sessionRecordPath),
    tillReceipt: factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "soil_tilled") ?? null,
    plantReceipt:
      factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "seed_planted") ?? null,
    waterReceipt:
      factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "crop_watered") ?? null,
    harvestReceipt:
      factLog.find((fact) => fact.type === "execution_receipt" && fact.reasonCode === "crop_harvested") ?? null,
    offerReceipt:
      factLog.find(
        (fact) =>
          fact.type === "execution_receipt" &&
          (fact.reasonCode === "gift_given" || fact.reasonCode === "quest_item_delivered"),
      ) ?? null,
    covenantReceipt: findProtectedCovenantShipment(factLog, PROTECTED_COVENANT_ITEM_ID) ?? null,
    covenantSeed,
    observation: buildRunObservation({
      prompt: undefined,
      scenario: SCENARIO,
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
      SCENARIO === "npc_social_and_presence" &&
      typeof presentedSummary === "string" &&
      presentedSummary.trim().length > 0
        ? assessCompanionInteraction(presentedSummary)
        : null,
    voiceResult,
    agentTurn: agentTurnResult,
    bridgeFacts: factLog,
    authenticated: client.state.authenticated,
    revision: client.state.snapshot?.revision,
  };
  partialResult.bundle = await writeRunBundle({
    capture,
    result: partialResult,
    scenario: SCENARIO,
    runtimeRoot,
    actionTrace,
    settlement: { snapshot: lastObservedSnapshot, reasonCode: partialResult.error, component: "runner" },
    historianRubric: historianRubricOutcome,
  });
  partialResult.capture = await closeCapture(capture, runtimeRoot, partialResult);
  const resultFile = process.env.GAMEBUDDY_RESULT_FILE ?? join("tools", `_${SCENARIO}-${Date.now()}.result.json`);
  await writeFile(resultFile, JSON.stringify(partialResult, null, 2), "utf8").catch(() => {});
  console.error("RUNNER_CRASH", JSON.stringify({ error: partialResult.error }));
  console.log(JSON.stringify(partialResult, null, 2));
} finally {
  if (voiceChild !== null) {
    voiceChild.kill("SIGTERM");
    await Promise.race([once(voiceChild, "close"), new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))]);
    if (!voiceChild.killed) voiceChild.kill("SIGKILL");
  }
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
    const isBoundary =
      char === "。" ||
      char === "！" ||
      char === "？" ||
      char === "." ||
      char === "!" ||
      char === "?" ||
      char === "；" ||
      char === ";";
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
 * Assemble the evidence bundle for one run into its capture directory.
 *
 * The bundle is the contract other tools read (`tools/lib/evidence-bundle.mjs`), and a run that cannot
 * describe itself is refused THERE rather than written as a smaller artifact. Two outputs are therefore
 * possible on a failure: a valid bundle, or a NAMED reason it could not be produced — never a half-truth
 * that later reads as a measurement.
 *
 * The failure dump is what makes a failure re-enterable: the bridge's own position/clock/date plus the replay
 * command and the wall-clock budget derived from the trace. Without it a failure is a story; with it, a
 * reproducible morning.
 */
/**
 * Judge the narrative this run's Historian wrote, from the SAME captured runtime root the reflection path reads.
 *
 * Reflection's only input is the compartments, so a run whose prose is a technical changelog has nothing worth
 * reflecting on - and until now the game surface had no historian wiring at all (the rubric ran only on the memory
 * loop). Violations are NAMED (`historian_rubric_violation:<obligation>@<where>`) and make the run red; a run that
 * wrote nothing is `unmeasured` rather than red, because "there was no narrative to judge" and "the narrative was
 * bad" are different findings and only one of them is a defect.
 */
function judgeRunHistorianRubric(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0) {
    return Object.freeze({
      state: "unmeasured",
      reasonCode: "runtime_root_unavailable",
      compartmentsChecked: 0,
      violations: [],
    });
  }
  try {
    const compartments = readCompartments(runtimeRoot);
    if (compartments.length === 0) {
      return Object.freeze({
        state: "unmeasured",
        reasonCode: "no_compartments_written",
        compartmentsChecked: 0,
        violations: [],
      });
    }
    const judged = checkHistorianRubric(compartments);
    return Object.freeze({
      state: judged.violations.length === 0 ? "passed" : "failed",
      reasonCode:
        judged.violations.length === 0
          ? null
          : judged.violations.map((entry) => `historian_rubric_violation:${entry.obligation}@${entry.where}`).join(","),
      compartmentsChecked: judged.compartmentsChecked,
      violations: judged.violations,
    });
  } catch (error) {
    return Object.freeze({
      state: "unmeasured",
      reasonCode: `historian_rubric_unreadable:${String(error?.message ?? error).slice(0, 120)}`,
      compartmentsChecked: 0,
      violations: [],
    });
  }
}

/**
 * The crossing record to publish in the run's evidence bundle, or null when there is none to publish.
 *
 * The bundle contract judges a crossing record by its own `crossings` count, so only a count that record can
 * describe is forwarded: a non-empty count its `dayRecords` agree with. A record that fails that test is
 * REPORTED and left out rather than let into the manifest, because `writeEvidenceBundle` REFUSES a bundle
 * whose crossings disagree with its records - and a metadata gap must not destroy the run's evidence along
 * with it (the same rule that keeps a gpu/resolution gap from refusing a headless bundle instead of naming
 * it). The reason code is the bundle contract's own, so the report and the refusal it avoids are spelled the
 * same way.
 */
function bundleCrossingRecord(outcome) {
  if (outcome === null || outcome === undefined) return null;
  const { crossings, dayRecords } = outcome;
  let reasonCode = null;
  if (!Number.isInteger(crossings) || crossings < 1) reasonCode = "multiday_crossings_invalid";
  else if (!Array.isArray(dayRecords) || dayRecords.length !== crossings)
    reasonCode = "multiday_day_records_disagree_with_crossings";
  if (reasonCode === null) return outcome;
  console.error(
    "MULTIDAY_CROSSING_RECORD_NOT_PUBLISHED",
    JSON.stringify({
      reasonCode,
      crossings: Number.isInteger(crossings) ? crossings : null,
      dayRecords: Array.isArray(dayRecords) ? dayRecords.length : null,
    }),
  );
  return null;
}

async function writeRunBundle({
  capture,
  result,
  scenario,
  runtimeRoot,
  actionTrace,
  settlement,
  historianRubric = null,
}) {
  // The narrative the run wrote, judged from its own captured runtime root. The CALLER judges it (the verdict needs
  // the same answer); this falls back to judging here so the bundle is never silent about it.
  const historianRubricOutcome = historianRubric ?? judgeRunHistorianRubric(runtimeRoot);
  const verdictState = result?.state === "passed" ? "passed" : "failed";
  const failed = verdictState === "failed";
  // Both halves of "where and when": the snapshot carries the clock and location, the execution receipt's local
  // observation carries the pose (the snapshot has no facing). Neither can be re-read after teardown.
  const snapshot = settlement?.snapshot ?? lastObservedSnapshot ?? lastObservedPose ?? null;
  const pose = lastObservedPose;
  const failure = failed
    ? buildFailureSnapshot({
        reasonCode: result?.error ?? settlement?.reasonCode ?? `${scenario}_blocked`,
        component: settlement?.component ?? "runner",
        step: actionTrace.length,
        // Prefer the pose for tile/location (it is the actor's own last observation), falling back to the
        // snapshot's tile when no receipt carried one.
        snapshot:
          pose === null
            ? snapshot
            : {
                ...snapshot,
                location: pose.location,
                tileX: pose.tileX,
                tileY: pose.tileY,
                facing: pose.facing,
                timeOfDay: snapshot?.timeOfDay ?? Number(pose.inGameTime),
              },
        atMs: Date.now(),
      })
    : null;
  const slot = snapshot?.slot ?? process.env.GAMEBUDDY_DAY_START_SLOT ?? null;
  const repro = failed
    ? buildReproPlan({
        actionTrace,
        turn: actionTrace.length,
        slot,
        scenario,
        // The nights this run had already crossed. A failure after any of them cannot be re-entered by the
        // day-level command, and the plan says so instead of offering a command that cannot arrive.
        crossings: multidayOutcome?.crossings ?? 0,
      })
    : null;
  // The window mode the RUNNER observes (the launcher exports it), and the facts a non-headless run must carry.
  const observedWindowMode = process.env.GAMEBUDDY_WINDOW_MODE ?? "visible";
  const headlessWindowMode = observedWindowMode === "hidden" || observedWindowMode === "background";
  const bundle = {
    schemaVersion: 1,
    run: {
      id: `game-run-${String(Date.now())}`,
      scenario,
      startedAtMs: phaseTimings.runStartedAtMs,
      durationMs: Date.now() - phaseTimings.runStartedAtMs,
      gitSha: process.env.GAMEBUDDY_GIT_SHA ?? "unknown",
      runtimeRoot,
    },
    env: {
      smapiVersion: process.env.GAMEBUDDY_SMAPI_VERSION ?? "unknown",
      gameVersion: "1.6.15",
      os: process.platform,
      windowMode: observedWindowMode,
      // A hidden/background run may leave these null, and then the reason has to say so (that is the contract).
      // Anything else is MEASURED: the harness can name the adapter and the display, and before this it simply did
      // not - so every foreground run, which is what the fade/night path needs, had its evidence bundle refused.
      gpu: process.env.GAMEBUDDY_GPU ?? (headlessWindowMode ? null : environmentFacts.adapter),
      resolution: process.env.GAMEBUDDY_RESOLUTION ?? (headlessWindowMode ? null : environmentFacts.resolution),
      saveHash: snapshot?.saveHash ?? "unknown",
      reason: headlessWindowMode ? "headless_environment" : null,
    },
    verdict: {
      state: verdictState,
      // The same reason the failure dump carries, so the two do not disagree about why the run is red.
      reasonCode: failure?.reasonCode ?? null,
      rubric: {
        broken: Object.entries(result ?? {})
          .filter(([key, value]) => key.endsWith("Passed") && value === false)
          .map(([key]) => key),
        // Named, not an empty placeholder: which obligations nobody measured is the difference between a verified run
        // and one that merely produced no red.
        unmeasured:
          historianRubricOutcome.state === "unmeasured" && historianRubricOutcome.obligations !== undefined
            ? [...historianRubricOutcome.obligations]
            : historianRubricOutcome.state === "unmeasured"
              ? [historianRubricOutcome.reasonCode ?? "historian_rubric_unmeasured"]
              : [],
      },
    },
    timeline: { path: "timeline.jsonl", records: factLog.length, sources: ["player", "smapi", "llm"] },
    actionTrace: { path: "actionTrace.jsonl", records: actionTrace.length },
    keyFrames: { status: "skipped", reason: "headless_environment", dir: null },
    reclamation: {
      state: settlement?.reclamation?.state ?? "unobserved",
      exitReason: settlement?.reclamation?.exitReason ?? null,
      steps: [],
      reflection: settlement ? "completed" : "skipped",
    },
    historianRubric: {
      state: historianRubricOutcome.state,
      reasonCode: historianRubricOutcome.reasonCode,
      compartmentsChecked: historianRubricOutcome.compartmentsChecked,
    },
    voice: {
      state: result?.voiceResult?.state ?? "unobserved",
      playback:
        result?.voiceResult?.state === "completed"
          ? "observed"
          : result?.voiceResult?.state === "disabled"
            ? "disabled"
            : "failed",
      reasonCode:
        result?.voiceResult?.state === "completed"
          ? null
          : (result?.voiceResult?.disabledReason ?? "voice_not_completed"),
    },
    failure,
    repro,
    multiday: bundleCrossingRecord(multidayOutcome),
    // Published HERE, not on either result literal: every result path builds its bundle through this function, which
    // is also how `multiday` reaches a failed run. A run that ended badly - the one where "the companion submitted
    // programs and nothing ran through them" matters most - must not lose the submissions it recorded.
    programSubmissions: Object.freeze([...programSubmissions]),
  };
  // The timeline record COUNT is the fact log's length, so the on-disk file must match it (the validator
  // cross-checks the file against the manifest).
  const timeline = factLog.map((entry, index) => ({ index, ...entry }));
  try {
    const written = await writeEvidenceBundle(capture.dir, { bundle, timeline, actionTrace });
    return Object.freeze({ state: "written", runDir: written.runDir });
  } catch (error) {
    // A bundle that cannot be produced is reported by NAME. The reason code alone would not say WHICH fact the
    // bridge never supplied, so the fields the dump was built from are reported with it.
    const reasonCode = String(error instanceof Error ? error.message : error);
    console.error(
      "EVIDENCE_BUNDLE_REFUSED",
      JSON.stringify({
        reasonCode,
        snapshotFields: snapshot === null ? [] : Object.keys(snapshot).sort(),
        poseFields: pose === null ? [] : Object.keys(pose).sort(),
        actionTraceSteps: actionTrace.length,
        slot,
      }),
    );
    return Object.freeze({ state: "refused", reasonCode });
  }
}

/**
 * Observation block for the roll-observation loop (design §observation loop).
 * Pure monitor points — recorded on every real run, NEVER part of the verdict.
 * A single run's text output is a random draw; only the aggregate across runs
 * (tools/roll-aggregate.mjs) decides whether a prompt/context change beats its
 * baseline beyond the roll noise. Grouping key: promptSha256 + scenario.
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
function buildRunObservation({
  prompt,
  scenario,
  turnStartedAtMs,
  actionTrace,
  factLog,
  contextAssembled,
  worldBookAssembled,
  presentedSummary,
  runManifestModel,
}) {
  let promptSha256 = null;
  if (typeof prompt === "string" && prompt.length > 0) {
    promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
  }
  const rejections = (actionTrace ?? []).filter((entry) => {
    const state = entry?.state;
    return state === "rejected" || state === "uncertain" || state === "failed";
  });
  const terminalReceipts = (factLog ?? []).filter(
    (fact) => fact?.type === "execution_receipt" && fact?.reasonCode !== undefined,
  );
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
    scenario: String(scenario),
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
