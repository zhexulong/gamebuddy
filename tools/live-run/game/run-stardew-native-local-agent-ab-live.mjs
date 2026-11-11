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
import { freemem as freeMemory } from "node:os";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { turnSettled } from "../../lib/turn-settled.mjs";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  decideDayWake,
  QUIET_BOUND_MS,
  runMultiDayLoop,
  WAKE_REASON,
  WAKE_REASONS,
  WAKE_SUPPRESSION_REASONS,
  watchRollover,
} from "../../lib/multiday-loop.mjs";
import {
  assessMultiDayBaseline,
  MAXIMUM_BASELINE_DAYS,
  MINIMUM_BASELINE_DAYS,
  NIGHT_CAUSE_PASS_OUT,
  nightCause,
  parseReceiptEvidence,
  worldDayStartsFromFacts,
  worldNightEndingsFromFacts,
} from "../../lib/multiday-baseline.mjs";
import { dayScopeFrom, nightCrossedInScope } from "../../lib/multiday-day-scope.mjs";
import { judgeUncrossedNight, sleepReceiptOf, sleepVerdictCase, summarizeCrossings } from "./night-verdict.mjs";
import {
  countPriorMultidayRuns,
  dailyTaskFor,
  overriddenFirstDayTask,
  runOffsetFor,
  overriddenTaskForDay,
  sweepTaskPrompts,
} from "../../lib/multiday-daily-tasks.mjs";
import { judgeTaskPurpose } from "../../lib/task-purpose.mjs";
import { dayPromptWithFact, seedShortageFact } from "../../lib/seed-shortage.mjs";
import { summarizeActionCadence } from "../../lib/action-cadence.mjs";
import { createLedger, ledgerSpans, ledgerSummary } from "./run-ledger.mjs";
import { chooseLevelUpResolution, readPendingLevelUpsFromSnapshot } from "../../lib/level-up-evidence.mjs";
import { checkHistorianRubric, readCompartments } from "../../lib/historian-rubric.mjs";
import { collectContextSummary } from "../../lib/context-db-summary.mjs";
import { assessMorningLiveness } from "../../lib/morning-liveness.mjs";
import { SCHEDULED_DIALOGUE_GATES, assessDialogueGates, planGateDeliveries } from "../dialogue-gates.mjs";
import { assessInteractionValue } from "../interaction-value-gate.mjs";
import { executeFresh, TERMINAL_STATES } from "../../lib/stardew-native-smoke-harness-v1.mjs";
import { OPERATOR_GATEWAY_PROVIDER_ID } from "../../lib/operator-gateway.mjs";
import { LocalStardewBridgeClient } from "../../../host/dist-test/local-stardew-bridge.js";
import { identityKey } from "../../../host/dist-test/runtime-identity.js";
import { dehydrateCompanionSpeech } from "../../../host/dist-test/companion-speech-dehydration.js";
import { LocalVoiceGatewayClient } from "../../../host/dist-test/voice-gateway-client.js";
import {
  launchVoiceGatewayChild,
  pickVoiceGatewayPort,
  resolveVoiceConfiguration,
} from "../../lib/voice-gateway-launch.mjs";
import { assessCompanionInteraction, assessSpokenUtterances } from "../../lib/companion-interaction-gate.mjs";
import {
  deliveryAccountClause,
  describeDeliveryAccount,
  readStallWatch,
  readTurnDeliveryRecords,
  readWorldStateStaleFacts,
  summarizeDeliveryAccount,
} from "../../lib/presentation-delivery-account.mjs";
import { readActivityPoints, summarizeActivity } from "../../lib/companion-activity.mjs";
import { describeRunCost, summarizeRunCost } from "../../lib/run-cost-account.mjs";
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
import { buildFailureSnapshot, buildReproPlan, classifyFailure } from "../../lib/failure-dump.mjs";
import {
  actionBreadthClause,
  addSnapshotToCensus,
  buildSnapshotCensus,
  measureActionBreadth,
  readActionBreadthSurface,
} from "../../lib/action-breadth.mjs";
import { EVIDENCE_BUNDLE_FILES, writeEvidenceBundle } from "../../lib/evidence-bundle.mjs";
import { appendTurnMemory, summarizeHostMemory, turnMemoryPoint } from "../../lib/live-run-memory.mjs";
import {
  installLiveRunInterrupt,
  killedReasonCode,
  reclamationRecord,
  reclamationStep,
  stampReclamation,
} from "../../lib/live-run-teardown.mjs";
// Program executions are a second kind of execution, written beside the request frames and merged back at read time.
// The module's own header states the invariant these two files have to satisfy together.
import {
  executedActionIds,
  executionTraceInvariant,
  FLAT_EXECUTION_VIA,
  PROGRAM_TRACE_FILE,
  programExecutionRows,
  writeProgramExecutionTrace,
} from "./execution-trace.mjs";
// The one projection of a node's outcome: the Host's own `planBatchAnswer`, which the settlement digest answers with.
import { programNodeOutcomes } from "./program-node-outcomes.mjs";
import { shouldAbandonTurnForTransport } from "./transport-loss.mjs";
// The Mod's own durable Body Program journal: the fallback that answers when the game - and with it the bridge - dies
// mid-run, which is exactly when a program's evidence matters most.
import {
  createBodyProgramJournalFallback,
  executionsFromJournalEvents,
  stardewDataPath,
} from "../../lib/stardew-body-program-journal.mjs";
import { submitPlayerPrompt } from "../core/player-input-admission.mjs";
// Whether the provider answers at all, resolved from the same files the runtime reads (the Game model profile, Pi's
// `models.json`, the credential beside it) and asked BEFORE the first model turn: two runs spent their whole budget on
// `503 auth_unavailable` with zero tokens. One probe module serves this runner and `tools/preflight-live-run.mjs`.
import { probeProviderReadiness, providerReadinessRefusal } from "../../lib/live-run-preflight.mjs";

// Live-run evidence root: every run writes its own local directory with the
// runtime root's OWN evidence (identity-profile.json, worldbook.json, the
// Magic Context database + log, session logs). This is what makes a content
// defect (e.g. an empty default persona) visible to a reviewer — the harness
// is an external tool and is not bound by the Host's write-ownership rule.

// Declared at module scope on purpose: the failure dump runs from an EXIT hook, which can fire before `main()` has
// executed a single statement - a run that dies at the startup freshness check does exactly that. A `let` inside the
// run function is then still in its temporal dead zone, so reading it from the hook threw
// `ReferenceError: Cannot access "capture" before initialization` and DESTROYED the artifact of the run it was supposed
// to explain (measured 2026-11-03, round29: `live_run_artifact_stale` was replaced by a stack trace). Module scope is
// initialised before any of that can run.
let capture = null;

// The run's session directory name, and the FOURTH value to fall into this trap.
//
// `capture`, `runtimeRoot` and `lastObservedSnapshot` each destroyed a run's artifact the same way: a startup failure ran
// the dump before their `let` had been reached, and the ReferenceError replaced the artifact that would have explained the
// run. This one is read by `writeRunBundle`, which the SAME failure path calls - so `round31` reported
// "Cannot access 'gameSessionId' before initialization" and wrote an unassembled artifact, one line after the real
// failure (`invalid_snapshot:worldObjectTargets`) had been reported by the bridge.
//
// Declared here and ASSIGNED where it used to be declared, so the ordinary path is unchanged and the failure path gets a
// name instead of an exception.
let gameSessionId = null;
let runtimeRoot = null;
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
// The provider readiness this run established (`{ ok, provider, model, reason }`), or null while nobody has asked.
// Declared before the failure dump reads it: a refusal has to publish WHY it never reached a turn, and null is the
// fact that says "never checked" instead of "ready".
let providerReadiness = null;

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
// WHERE THIS RUN'S RESULT GOES, declared once. The assembly writes it, the escaped-error floor writes it, and the teardown
// account is stamped into it AFTER the unwind - a third derivation of the name would let the account land in a file
// nobody reads, which is the defect this whole seam exists to close (measured 2026-11-09, `round40`).
const RESULT_FILE = process.env.GAMEBUDDY_RESULT_FILE ?? join("tools", `_${SCENARIO}-${Date.now()}.result.json`);

/**
 * The last-resort dump: whatever escapes the run's own try/catch — an unhandled rejection, a synchronous throw in
 * setup, a failure while the run was assembling itself — still publishes the run.
 *
 * Measured 2026-10-22 (`g149tool`): 184 s of real work — accepted programs, route progress, successful and refused
 * receipts — was recorded as it happened and then lost, because this path wrote a seven-field stub in place of the
 * run's result. A run whose work cannot be examined is worth nothing to an audit, so an escaped error is assembled
 * through `buildRunResult`, the ONE builder every other exit uses: the shape cannot drift, and the error that ended
 * the run is its named reason. Only a failure BEFORE the run's record exists (see the declarations above `actionTrace`)
 * has nothing to assemble, and that case names itself rather than posing as a result.
 */
async function writeFailureDump(reason) {
  const thrown = classifyFailure(reason);
  console.error("RUNNER_FAILED", thrown.reasonCode, thrown.errorMessage, thrown.errorFrame ?? "no_frame_published");
  return writeRunDump({ state: "blocked", reasonCode: thrown.reasonCode, thrown });
}
/**
 * The same dump for a run that was ended FROM OUTSIDE — a timeout's SIGTERM, an operator's Ctrl+C.
 *
 * Measured 2026-11-06: a run killed at 19:37 left its run directory holding `launch.json` and nothing else, its fixture
 * transaction unreleased, and 184 s of accumulated work unreadable — because the process simply stopped mid-await. The
 * only difference between this exit and the escaped-error one is WHY it happened: nothing about the product was
 * measured, so the run is `killed` (its own state, see `tools/lib/evidence-bundle.mjs`) and its accumulated day records
 * and counters travel with it rather than dying in memory. The reason is a code and names the signal, never the shape
 * of an absent field.
 */
async function writeKilledDump(signal) {
  const reasonCode = killedReasonCode(signal);
  // Only the code is logged here; the accumulated day records and counters are reported by `writeRunDump` once the
  // assembly has actually read them, so the log line cannot disagree with the artifact.
  console.error("RUNNER_KILLED", reasonCode);
  return writeRunDump({ state: "killed", reasonCode, thrown: null });
}
/**
 * The ONE assembly behind the two exits above, so a run's result cannot depend on how it ended.
 */
async function writeRunDump({ state, reasonCode, thrown }) {
  try {
    // The evidence is BEST-EFFORT, and this is the one place a guard is the right answer rather than a way of hiding a bug.
    //
    // `failureDumpEvidence` reads module-scope bindings, and a run that dies at the startup freshness check dies DURING
    // module evaluation - so some of them are still in their temporal dead zone. Three attempts to repair that by moving
    // declarations only changed which name threw first:
    //
    //   attempt 1   Cannot access 'capture' before initialization
    //   attempt 2   Cannot access 'runtimeRoot' before initialization
    //   attempt 3   Cannot access 'lastObservedSnapshot' before initialization
    //
    // and each time the stack trace REPLACED the artifact that would have named `live_run_artifact_stale`. The ordering is
    // not repairable from here - the throw happens partway through the module body, so everything after it is unreachable
    // by construction - but the artifact is. "This run never started" is a complete, truthful statement of a startup
    // failure, so the death keeps its name.
    let evidence;
    try {
      evidence = failureDumpEvidence({ reasonCode });
    } catch (error) {
      evidence = Object.freeze({
        settlement: Object.freeze({ reasonCode, component: "runner" }),
        evidenceUnavailable: classifyFailure(error),
      });
    }
    const result = await buildRunResult({
      state,
      error: thrown === null ? null : thrown.reasonCode,
      reasonCode,
      errorDetail: thrown,
      ...evidence,
    });
    console.error(
      `${state === "killed" ? "RUNNER_KILLED" : "RUNNER_FAILED"} dump published`,
      JSON.stringify({
        error: result.error,
        reasonCode: result.reasonCode ?? null,
        errorFrame: result.failure?.errorFrame ?? null,
        attemptedActionIds: result.attemptedActionIds,
        executionTrace: result.executionTrace,
        dayRecords: result.multiday?.dayRecords?.length ?? 0,
        bundle: result.bundle?.state ?? null,
      }),
    );
    return result;
  } catch (assemblyError) {
    writeUnassembledFailure({ state, thrown: thrown ?? { reasonCode }, assemblyError });
    return null;
  }
}
/**
 * The floor under the floor: the dump's own assembly failed, which can only mean the run threw before its record
 * existed (every binding the assembly reads is declared before the first thing it can describe). Written by name, with
 * the root error beside the assembly error, so the run is still analysable — and this record can never be mistaken for
 * the run's result, which is what the stub it replaces got wrong.
 */
function writeUnassembledFailure({ state, thrown, assemblyError }) {
  const assembly = classifyFailure(assemblyError);
  console.error("RUNNER_FAILED assembly failed", assembly.reasonCode, assembly.errorMessage, assembly.errorFrame);
  try {
    const path = process.env.GAMEBUDDY_RESULT_FILE;
    if (typeof path !== "string" || path.length === 0) return;
    const payload = {
      state,
      scenario: SCENARIO,
      legacyLadder: LEGACY_LADDER,
      reason: "failure_dump_assembly_failed",
      // The SAME record the assembled path publishes: this floor must not be the one path that loses the site.
      ...thrown,
      assemblyError: assembly,
      providerReadiness,
      at: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    console.error(`RUNNER_FAILED unassembled artifact written to ${path}`);
  } catch (error) {
    console.error("RUNNER_FAILED artifact could not be written", error);
  }
}
/**
 * What a run that never reached its verdict can still say about itself, from the trace, the bridge log and the session
 * record the run already holds. ONE list, read by the crashed exit and by the escaped-error dump: two paths describing
 * one failed run may not disagree about what a failed run reports.
 *
 * Deliberately no assembled-context evidence: a run that died has none, and reading a binding that only the try
 * block's own scope owns threw inside this path once and destroyed the artifact of a real failed session
 * (runs N, O and P produced none).
 */
function failureDumpEvidence(thrown) {
  const receiptWith = (reasonCodes) =>
    factLog.find((fact) => fact.type === "execution_receipt" && reasonCodes.includes(fact.reasonCode)) ?? null;
  return {
    capture,
    runtimeRoot,
    providerReadiness,
    settlement: { snapshot: lastObservedSnapshot, reasonCode: thrown.reasonCode, component: "runner" },
    tillReceipt: receiptWith(["soil_tilled"]),
    plantReceipt: receiptWith(["seed_planted"]),
    waterReceipt: receiptWith(["crop_watered"]),
    harvestReceipt: receiptWith(["crop_harvested"]),
    offerReceipt: receiptWith(["gift_given", "quest_item_delivered"]),
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
}
// `once`, not `on`: a throw inside the dump must not re-enter the dump, and both handlers must still terminate the
// process with the run's failure once the artifact is on disk.
const exitAfterDump = (error) => {
  process.exitCode = 1;
  writeFailureDump(error).then(
    () => process.exit(1),
    () => process.exit(1),
  );
};
process.once("uncaughtException", exitAfterDump);
process.once("unhandledRejection", exitAfterDump);
/**
 * An EXTERNAL stop is its own exit, not a crash and not a failure.
 *
 * Measured 2026-11-06: a run killed at 19:37:14 left its run directory holding `launch.json` and nothing else, so the
 * session's day records and counters existed only in the memory of a process that was gone. A timeout's SIGTERM and an
 * operator's Ctrl+C therefore walk the same assembly the escaped-error exit walks, named by their signal.
 *
 * The trap is the launcher's too (`tools/lib/live-run-teardown.mjs`): Ctrl+C reaches every process on a Windows console,
 * so both halves see the same signal, and the first one to arrive owns the unwind while a second exits immediately.
 */
installLiveRunInterrupt({ onInterrupt: writeKilledDump });

// This file imports fifteen modules of `host/dist-test` directly, so a stale artifact silently tests the wrong
// code — observed as an `Unsupported candidate action:` for an action that was already committed. Refuse to
// start rather than spend a game launch, a fixture prepare and a session on it.
await assertLiveRunArtifactFresh();

// The three scenarios' prompts, in both locales. Written as DATA rather than nested conditionals so the
// contract is auditable at a glance: what a scenario asks for, and that it asks for it without prescribing a
// route. The opening task's unit is ONE piece of work carried out in a single pass, not a list of chores: a
// measured session that answered it chore-by-chore paid a full model round-trip between steps (settle -> dispatch
// p50 3.3 s, p90 37 s, none of 28 gaps under 500 ms), while a submitted plan's own node-to-node step is ~10 ms.
// The runner states the TASK and the world's state. It does not state how the companion talks: that is the system
// prompt's job (identity-profile + the character card), and it already says it at length - no bracketed stage
// direction, no walkie-talkie dispatch, no step-by-step inventory. Two authorities for one rule is how a rule starts
// disagreeing with itself, and every live run since paid for the duplication in prompt bytes and in a voice that read
// like a progress log. Measured 2026-11-03 (round26): the injected rules sat beside a system prompt that already
// forbidden the same behaviours, and the companion still spoke as "已完成 A，正在执行 B".
/**
 * What the player asks for on a given day, one entry per rotation id.
 *
 * The task is a SENTENCE, not an action list: which actions serve it is the companion's decision, and naming
 * them here would turn the run into a script. `DAILY_TASK_ACTION_HINTS` exists for the audit, not for the
 * prompt.
 */
const DAILY_TASK_PROMPT_ZH = Object.freeze({
  clear_east_patch: "东头那片地该收拾了，杂草和石头都清一清。",
  water_and_harvest: "地里长好的都收下来，收完再把空地种上。",
  forage_and_trees: "林子和树那边看看，能捡的捡了，能摇的摇了。",
  craft_and_place_machine: "自己做一台机器放下去，再用起来。",
  // `town_errand` was the key here and it is no species of task: the rotation asks for `town_market` and
  // `town_visit`, so both days were handed the literal string "undefined" instead of a task. The prompt table is
  // read by key, so its keys ARE the population it must cover.
  town_market: "去一趟镇上买点东西，回来把信箱里的信取出来。",
  town_visit: "去一趟镇上，找个人说说话。",
  mine_delve: "下一趟矿，敲点矿石，看到箱子就打开，累了就坐矿车或电梯上去。",
  // The size is deliberately the companion's call: a number picked here would be a quota, and the point of the
  // task is to observe how it decides where a clearing should be and how much is enough.
  clear_and_cultivate: "林子东边太挤了，清一片空地出来，顺手种点东西浇上水。多大你自己定。",
  home_and_hearth: "屋里太空了，收拾一下、摆点东西，让它像个家。",
  home_upgrade: "房子有点挤了，去木匠那儿问问扩建的事。",
  store_and_sort: "把背包里的东西归置到箱子里，用时再拿回来。",
  till_and_sow: "把空地翻一翻，种上种子，浇上水。",
  // ONE sentence, and the size is the point of the sentence: a plot twenty tiles long cannot fit in the 13x13 window
  // one snapshot sees, so the far end is only ever in her head after the first walk. No crop is named - choosing it is
  // hers - and no instruction about how to plan it is appended, because the shape is the task.
  clear_and_plant_long_patch: "门前横着开一条长地，三格宽、二十格长，清出来种上。",
  // No number of fish and no destination: `waterTargets` is the world's own answer to "where is water I can fish",
  // and picking a spot here would be a second one.
  a_fish_from_the_water: "找片水，钓条鱼回来。",
  tidy_and_repair: "把地里和院子里残留的杂物清一清，没用的东西收掉。",
  tend_the_animals: "去看看牲口，该摸的摸，该喂的喂，有东西就收。",
  dress_and_display: "给自己换身衣裳，把屋里摆出点样子来。",
  // Three ways the same world can be under-used, each with an action that had no task behind it.
  mine_ladder_to_depth: "下矿去看看，往深处走走，回来的时候自己找梯子上来。",
  furnish_and_arrange: "屋里东西摆得别扭。把家具挪一挪、换换颜色，重新归置一下。",
  run_the_machines: "把机器都用起来：装料、等它出东西、收回来。",
  // The sweep tasks' sentences are owned by the task definitions, not by this table: they are derived from the
  // published surface, and a second list of the same ids here would go stale the moment a group changed.
  ...sweepTaskPrompts().zh,
});
const DAILY_TASK_PROMPT_EN = Object.freeze({
  home_and_hearth: "the house feels bare - tidy it up and put a few things out so it feels lived in.",
  home_upgrade: "the house is cramped - go ask the carpenter about extending it.",
  clear_east_patch: "the east patch wants clearing - weeds and rocks. ",
  water_and_harvest: "bring in what is ripe, then plant the empty ground. ",
  forage_and_trees: "check the woods and the trees - pick up what is there, shake what can be shaken. ",
  craft_and_place_machine: "make a machine yourself, put it down, and put it to use. ",
  town_market: "go into town, buy something at a shop, and bring the post in. ",
  town_visit: "go into town and talk to somebody there. ",
  mine_delve: "go down the mine and come back with some ore. ",
  clear_and_cultivate:
    "the woods on the east side are too thick - clear a patch of open ground, then plant and water something in it. Size is your call.",
  store_and_sort: "sort what you are carrying into a chest, and take it back out when you need it. ",
  till_and_sow: "turn the bare ground, put seeds in it, and water them. ",
  clear_and_plant_long_patch:
    "open up a long strip out front - three tiles wide, twenty long - clear it and plant it. ",
  a_fish_from_the_water: "find some water and bring a fish back from it. ",
  tidy_and_repair: "clear what is left lying around the field and the yard, and put away what is not needed. ",
  tend_the_animals: "look in on the animals - pet what wants petting, feed what wants feeding, collect what is there. ",
  dress_and_display: "put on something else, and make the house look like somebody lives in it. ",
  mine_ladder_to_depth: "go down the mine and work deeper, then find the ladder back up yourself. ",
  furnish_and_arrange:
    "the furniture in the house is in the wrong places - move it about, change a colour, put it right.",
  run_the_machines: "put the machines to work: load them, wait for the output, collect it. ",
  ...sweepTaskPrompts().en,
});

const SCENARIO_PROMPTS = Object.freeze({
  morning_routine: Object.freeze({
    zh: `现在是星露谷春季的早晨，你独自在农场里。今天没有人给你派活，你自己看看周围，把今天这一摊活当成一整件事（地里的农活、农场上的杂物、屋里的箱子和机器都算）：先说清楚整件事要做成什么样，其余怎么排开由系统来。做完之后用两三句话跟对方说说：整件活做到哪儿了、哪一段做不了或者卡住了、卡在哪里（控制在 120 字以内，挑重点说，不用把每道工序都报一遍）。`,
    en: `It is a spring morning in Stardew Valley and you are on the farm by yourself. Nobody has assigned you anything today — look around and take today's work as one whole job (field work, odds and ends on the farm, the chests and machines indoors — all fair game): say what the whole job should end up as; how it gets laid out is up to the system. When you are done, tell your partner in two or three sentences: how far the whole job got, what you could not do or got stuck on, and where (**keep the whole thing within 120 characters** — that is the companion's speaking length, not a request to leave things out; pick what matters the way someone playing alongside would). `,
  }),
  memory_covenant: Object.freeze({
    // The standing rule is NOT in this prompt: it is planted as a memory through the real management surface,
    // so the probe measures whether a memory-driven covenant changes behaviour. Naming it here would make the
    // test pass by coaching.
    zh: `今天是星露谷春季的雨天。农场田里的草莓已经熟了，把它们收下来收好。想一想你记得的、对方和你说过的话里，有没有什么关于这些草莓的规矩，如果有，按那个规矩来。别的事按你平时在这院子里的习惯安排。`,
    en: `Today is a rainy Spring day in Stardew Valley. The strawberries in the farm field are ripe — harvest them and put them away. Think about anything your partner ever told you about these strawberries — if you remember a rule about them, follow it. `,
  }),
  npc_social_and_presence: Object.freeze({
    zh: `今天是星露谷春季的第 19 天。你收到乔迪（Jodi）的来信：她需要一颗新鲜花椰菜做菜，希望你能给她带一颗。你农场的地里正好种着一颗已经长好的花椰菜，她今天就在农场附近。`,
    en: `Today is Spring day 19 in Stardew Valley. You received a letter from Jodi: she needs a fresh cauliflower for a recipe and asks you to bring her one. There happens to be a fully grown cauliflower in your farm soil, and she is nearby on the farm today. `,
  }),
  multiday_routine: Object.freeze({
    // Per-day, with the day number in the text: the companion decides its day AND decides when the day is
    // over, by dispatching its own `sleep`. The loop never ends a night for it - the prompt is where
    // "the day is yours to end" is said, because a night the harness chose would be a scripted crossing.
    //
    // The last clause exists because the previous wording named a CLOCK ("when it gets dark") and left the
    // authority implicit. Measured 2026-10-26: two runs had the companion at the bedside reasoning "Advancing
    // day is a big action... it may be the player's prerogative... I'll ask nothing, just state" - it announced
    // going to bed and dispatched nothing, then passed out at 02:00. The reluctance was not a bug in the model:
    // ending a shared world's day IS normally the player's call, and nothing here had said it was not.
    // The TASK changes per day, so one run covers several capabilities and the night crossing doubles as a
    // task switch. The invariant clauses - the player is away, ending the day is yours - are the same every
    // day, because they are what this scenario exists to observe and a task change must not rewrite them.
    zh: (day, task) =>
      `现在是星露谷的早晨（连续第 ${String(day)} 天）。` +
      `桌上留着便签：“我今天去镇上办事，${DAILY_TASK_PROMPT_ZH[task]}你看着办，天黑累了就回屋歇着不用等我，明天还有别的。”` +
      `活干完了或者天黑累了就回床上睡，这一天才真正过去。只在嘴里说“我睡了”而身体没躺下，天不会自己过去。`,
    en: (day, task) =>
      `It is morning in Stardew Valley (day ${String(day)} in a row for you). ` +
      `There is a note on the table from your partner: "I'm heading into town today to run errands. ${DAILY_TASK_PROMPT_EN[task]}That is yours to handle; when it gets dark and you're tired, head inside and rest, no need to wait up for me. There will be other things tomorrow." ` +
      `When the work is done or when it is dark and you are tired, go to bed and sleep so the night passes. Announcing it without lying down does not end the day. `,
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
// What each multi-day turn was ASKED for, and whether its own purpose was achieved (see `task-purpose.mjs`). One
// entry per day the run actually delivered, built where the day's receipts are still addressable; the session
// verdict reads it, and the result publishes it, so a run cannot be green on an unachieved task and cannot hide one.
const taskPurposes = [];
// What the run TOLD the companion about a seed shortage, per day, in the words it was handed (see
// `seed-shortage.mjs`). One entry per day whose task declared a patch, computed once on that day's first turn from the
// world as it stood then. It is recorded because "she was handed the supply and still did not go" and "nothing ever
// told her" are different findings, and only this list tells them apart.
const seedFacts = [];
// EVERY PROMPT THE HARNESS ISSUED, BY WHY IT WAS ISSUED, and every settlement it deliberately did not turn into one.
//
// These two counts cannot be reconstructed from a session: a prompt that was never sent leaves no record there, and the
// difference between "the harness waited" and "the harness was never asked" is exactly what `round44` could not say
// while it spent 94% of its wall clock on model turns. `wakeAccount` is the run's own statement of both.
const wakeAccount = { issued: Object.create(null), suppressed: Object.create(null) };
const recordWake = (reason) => {
  wakeAccount.issued[reason] = (wakeAccount.issued[reason] ?? 0) + 1;
};
const recordWakeSuppression = (reason) => {
  wakeAccount.suppressed[reason] = (wakeAccount.suppressed[reason] ?? 0) + 1;
};
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
// The families this run's OWN snapshots published, with the largest row count seen for each, and how many snapshots
// that census rests on. Kept while the run is live for the same reason the last snapshot is: after teardown the bridge
// has cleared its state, and a family that was empty cannot be told from one nobody looked at.
//
// This is the denominator of the run's `action_breadth` clause. A target-bound action is only constructible while its
// `*Targets` family has a row in the snapshot, and one `FixtureScenario` string arms one world - so dividing attempted
// actions by the 95 published ones charged the companion for the fixture's world (measured: `round39` attempted 15 of
// the 40 its own observations made addressable, and the gate called that 15 of 95).
const snapshotFamilyRows = new Map();
let snapshotCensusSamples = 0;
function rememberObservation() {
  const snapshot = client?.state?.snapshot;
  if (snapshot !== null && snapshot !== undefined) {
    lastObservedSnapshot = Object.freeze({ ...snapshot });
    snapshotCensusSamples += 1;
    addSnapshotToCensus(snapshotFamilyRows, snapshot);
  }
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
const ledger = createLedger({ now: () => Date.now() });

// Free physical memory, sampled cheaply and continuously, because three runs ended with the process simply gone and no
// log said why.
//
// Measured 2026-11-03 (`round28`): the Mod's own heartbeat showed a managed heap growing 32 -> 180 MB in 2.5 minutes and
// a working set of 1.0 -> 1.25 GB, on a machine holding **2.3 GB free of 31** at the same moment. That is a real number
// and an ambiguous one - Windows counts file cache as used and reclaims it on demand - so the honest response is to
// record what free memory was doing when a run dies, beside the reason code, rather than argue about it later.
//
// `minFreeMb` over the whole run is the useful statistic: a death under sustained single-digit-hundred free megabytes
// is a different finding from a death with gigabytes available, and only one of them is our bug.
const hostMemory = {
  samples: 0,
  minFreeMb: null,
  maxHostRssMb: null,
  startRssMb: null,
  minRssMb: null,
  series: [],
  // One point per turn, bounded (`HOST_MEMORY_TURN_CAP`), because the question a death leaves open is the SHAPE across
  // turns and the artifact could not answer it at all (see `../../lib/live-run-memory.mjs`).
  turns: [],
  turnsOmitted: 0,
};
let lastHostMemorySampleAtMs = 0;
const sampleHostMemory = (atMs = Date.now()) => {
  const freeMb = Math.round(freeMemory() / (1024 * 1024));
  const usage = process.memoryUsage();
  const rssMb = Math.round(usage.rss / (1024 * 1024));
  hostMemory.samples += 1;
  hostMemory.minFreeMb = hostMemory.minFreeMb === null ? freeMb : Math.min(hostMemory.minFreeMb, freeMb);
  hostMemory.maxHostRssMb = hostMemory.maxHostRssMb === null ? rssMb : Math.max(hostMemory.maxHostRssMb, rssMb);
  hostMemory.startRssMb ??= rssMb;
  hostMemory.minRssMb = hostMemory.minRssMb === null ? rssMb : Math.min(hostMemory.minRssMb, rssMb);
  // A series, not just extremes: `maxHostRssMb` alone cannot tell a one-off allocation spread (the first provider
  // request, the first fold child) from a leak that grows with turns, and those two have opposite fixes. Measured
  // 2026-11-09: one run reached 866 MB in 2.97 minutes with 3 GB free, another sat at 374 MB after 1.41 minutes - a
  // 300 MB spread with the same work, which is why the answer needs the shape and not the peak. `external` and
  // `arrayBuffers` separate native allocation (SQLite, spawned children) from the V8 heap.
  if (atMs - lastHostMemorySampleAtMs >= 60_000) {
    lastHostMemorySampleAtMs = atMs;
    hostMemory.series.push({
      atMs,
      rssMb,
      heapUsedMb: Math.round(usage.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(usage.heapTotal / (1024 * 1024)),
      externalMb: Math.round(usage.external / (1024 * 1024)),
      arrayBuffersMb: Math.round(usage.arrayBuffers / (1024 * 1024)),
      freeMb,
    });
  }
  return { rssMb, freeMb, heapUsedMb: Math.round(usage.heapUsed / (1024 * 1024)) };
};
sampleHostMemory();
const hostMemoryTimer = setInterval(sampleHostMemory, 5_000);
hostMemoryTimer.unref?.();

ledger.record("run.start");
// The program half of "how far had this run got", updated as the journal reports it. A disconnect that says
// only the flat count reads as "nothing had happened" on a run whose work all went through programs.
let lastKnownProgramDispatches = 0;
client.onConnectionFact((fact) => {
  if (fact?.state !== "disconnected") return;
  const entry = Object.freeze({
    reasonCode: fact.reasonCode ?? null,
    atMs: Date.now(),
    elapsedMs: Date.now() - phaseTimings.runStartedAtMs,
    // FLAT rows only - the half the flat trace knows about. Named for what it counts: the field used to be
    // called `dispatchesSoFar` and published 0 on a run with thirteen program dispatches, because it measured
    // one of two halves and called itself the total.
    flatDispatchesSoFar: actionTrace.length,
    // The total this run dispatched, whichever path carried it. A program-path run legitimately has
    // `flatDispatchesSoFar: 0` beside a large total; that is the truth rather than a contradiction.
    dispatchesSoFar: actionTrace.length + (lastKnownProgramDispatches ?? 0),
    // What the machine looked like when this happened, so "the process vanished" can be read as memory pressure or not.
    minFreeMb: hostMemory.minFreeMb,
    hostRssMb: hostMemory.maxHostRssMb,
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
/**
 * Everything this process has written to stderr, so the Host's own artifact lines can be read back.
 *
 * The Host publishes ONE `NATIVE_COMPANION_TURN_DELIVERY` line per turn that had anything to deliver
 * (`host/dist-test/companion-loop.js`, over the same channel as `BODY_PROGRAM_MOUNT`), and that line is the only place
 * the run states which parts a turn produced and which pieces it committed. The bundle has to reconcile those against
 * the pieces this harness's own presentation port counted (`presentation.pieceCount`), and the line exists exactly
 * once - in the log - so it is kept as it is written rather than re-derived from a different population.
 *
 * MEASURED 2026-11-09 (round41): 59 pieces presented, and the thirteen delivery records in the log accounted 46 parts
 * with `unaccounted: 0`. Both numbers were right (11 reaction sounds, 46 paragraphs, 2 extra pieces from a paragraph the
 * length budget split) and the bundle could not say so, so a reader reported thirteen pieces - a whole turn - with no
 * record. See `tools/lib/presentation-delivery-account.mjs`.
 */
const hostLogChunks = [];
{
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    hostLogChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return write(chunk, encoding, callback);
  };
}
// What the companion said to each scripted player line, keyed by gate id. A gate with no entry is `not_exercised` -
// the run never reached that moment - which is a different finding from a bad answer.
const dialogueReplies = new Map();
// How each scripted player line reached the session - or why it never did. Keyed by gate id and written at the moment
// the gate is claimed, so `result.json` cannot read "delivered and unanswered" the same way as "never delivered".
// A claimed entry carries `state: "delivered"` with the moment, the refusal it was spoken against and what the admission
// path answered (`accepted`, or `refused:<code>`).
const dialogueDelivery = new Map();
// The night that ended each day, as this run's own night watch observed it: `bedTime` is the latest clock it saw while
// that day was still current, `passedOut` is the ENGINE taking the night at its own 26:00. The honesty gate asks about
// yesterday, and this process has no other record of yesterday to answer with.
const nightRecordsByDay = new Map();
const presentationPieceAtMs = [];
let turnStartedAtMs = null;
let agentTurnCount = 0;
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
 * The reason one unsettled turn is recorded with, or a NAMED absence when the record has none.
 *
 * The verdict used to print the literal word `unsettled` for a turn carrying no error, which is how a round46 run ended
 * with a cause nobody could act on while the reason itself was in the envelope: `unsettled` was doing two jobs - the
 * class of the answer (`turn_unsettled`) and the whole sentence. The class stays on the verdict; the sentence is the
 * turn's own named cause, and a missing one says WHERE it is missing rather than defaulting to a plausible word.
 */
function unsettledTurnError(turn) {
  const recorded = typeof turn?.error === "string" ? turn.error.trim() : "";
  return recorded.length > 0 ? recorded : "abandon_cause_absent:session_turn_record";
}

/**
 * THIS run's own session record: the files under the surface session directory this run materialized, or an object
 * saying why there is none.
 *
 * The product's convention is `<runtimeCwd>/surface-sessions/<surfaceSessionId>/sessions/*.jsonl`
 * (`host/src/runtime-identity.ts:127-136`), and the Game runtime is materialized with this run's own
 * `gameSessionId` - so that directory IS the binding, and it is the only place this reader looks. It used to walk the
 * runtime root and take the newest file it found, which is how two runs launched 38 minutes apart published the SAME
 * foreign record (`calls=45`, `sumMs=47189`, `frames=0` - 2026-10-22 audit) as each run's own measurement, and the
 * pair was quoted afterwards. A record this run cannot bind is not this run's record: the answer is "none" with the
 * reason and the directory searched, never a neighbour's numbers. `searched` stays in the answer because a reader has
 * to tell a missing session from a reader looking in the wrong place.
 */
/**
 * The session id the Magic Context store keys on, read from the session record's own name.
 *
 * `<timestamp>_<sessionId>.jsonl` is the shape `findRunSessionJsonl` already selects by, and `context.db`'s
 * `tags.session_id` holds exactly that second field - verified against the 2026-10-29 run, whose record
 * `2026-10-29T18-01-38-566Z_01a188d3-1a06-7103-bff6-bb3975370191.jsonl` matches 29 compartments and 191 tags.
 *
 * Returns undefined rather than a guess when the name does not have that shape: a wrong id would report another
 * session's totals as this run's.
 */
function sessionIdFromSessionRecord(path) {
  if (typeof path !== "string") return undefined;
  const name = path.split(/[\\/]/u).at(-1) ?? "";
  return /_(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(name)?.groups?.id;
}

function findRunSessionJsonl(sessionDir) {
  const searched = Object.freeze([String(sessionDir)]);
  const unbound = Object.freeze({
    path: undefined,
    reason: "no_session_record_for_run_surface_session",
    searched,
  });
  let entries;
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return unbound;
  }
  // Session file names are UTC timestamps, so the last one lexicographically is the newest - of THIS run's session,
  // which is what makes it this run's record. A resumed or compacted run may leave several here; all of them belong to
  // the same surface session, unlike the files of another run under a sibling directory.
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) return unbound;
  return Object.freeze({ path: join(sessionDir, files[files.length - 1]), reason: null, searched });
}

/**
 * A per-tool-call duration only answers "why was this run slow" when it names WHO made the Agent wait.
 *
 * `actionTrace` timestamps the bridge call and nothing else, so it cannot see the other owners of agent wall clock. An
 * audit of a real run read its 533 s over 19 "long actions" as bridge latency, while the same audit named
 * `delegate_game_task` - a nested agent - separately: the execute response had returned and the tool result landed
 * 5-60 s later, which is not a shape the bridge can produce. Optimising the journal for a tail that belongs to a nested
 * agent, or vice versa, is the cost of not separating them. These are different owners with different fixes, so every
 * agent tool call is attributed here by the NAME OF THE TOOL ACTUALLY CALLED.
 *
 * One category per real thing, never a pattern. `stardew_plan_work` compiles a script into a submitted plan and
 * `stardew_plan_shape` reads what a plan step must supply; neither dispatches an action, and a `stardew_`-prefix rule
 * would have folded them into dispatch latency. The categories are the mounted surface's tools, spelled one by one, so
 * a new tool has to be classified on purpose instead of landing in whichever bucket its name resembles.
 *
 * Nothing is published unless it is a MEASUREMENT OF THIS RUN: `sessionJsonlPath` is the record bound to this run's own
 * surface session, and `unboundReason` is what the binding reported when there was none. When the counts disagree with
 * the frames the run sent, the categories come back `null` and the violation is the only number published.
 *
 * The source is the runtime's own session record (the one `readAgentTurnOutcome` reads): a `toolCall` part in an
 * assistant message carries the call's entry timestamp, the `toolResult` entry matched by `toolCallId` carries the
 * arrival. A call that never got a result (session cut off mid-call) has no duration and is left out rather than being
 * given an invented one.
 */
const TOOL_TIMING_LONGEST_LIMIT = 10;
const TOOL_TIMING_INVARIANT_VIOLATED = "TOOL_TIMING_INVARIANT_VIOLATED";
const TOOL_TIMING_CATEGORIES = Object.freeze([
  "delegate",
  "plan_shape",
  "plan_compile",
  "program_submit",
  "program_status",
  "flat_dispatch",
]);
const DELEGATE_TOOL_NAME = "delegate_game_task";
// The planning tools: one answers what a step must supply, one compiles a written script and submits the result.
const PLAN_SHAPE_TOOL_NAMES = Object.freeze(["stardew_plan_shape"]);
const PLAN_COMPILE_TOOL_NAMES = Object.freeze(["stardew_plan_work"]);
// The program tools: a submission waits on the compile + native accept, a status/event read waits on the journal.
const PROGRAM_SUBMIT_TOOL_NAMES = Object.freeze(["stardew_submit_action_program"]);
const PROGRAM_STATUS_TOOL_NAMES = Object.freeze(["stardew_action_program_status", "stardew_action_program_events"]);
const ACTION_TOOL_NAMES = new Set(Object.values(STARDEW_ACTION_TOOL_NAMES));
// The plan tools whose call counts the run's cost account reads, by name: `program_status` alone is the poll, and the
// category above deliberately folds it together with the event log because both are bridge reads of one journal.
const PLAN_TOOL_NAMES = new Set([
  ...PLAN_SHAPE_TOOL_NAMES,
  ...PLAN_COMPILE_TOOL_NAMES,
  ...PROGRAM_SUBMIT_TOOL_NAMES,
  ...PROGRAM_STATUS_TOOL_NAMES,
]);

function toolTimingCategory(toolName) {
  if (typeof toolName !== "string") return undefined;
  if (toolName === DELEGATE_TOOL_NAME) return "delegate";
  if (PLAN_SHAPE_TOOL_NAMES.includes(toolName)) return "plan_shape";
  if (PLAN_COMPILE_TOOL_NAMES.includes(toolName)) return "plan_compile";
  if (PROGRAM_SUBMIT_TOOL_NAMES.includes(toolName)) return "program_submit";
  if (PROGRAM_STATUS_TOOL_NAMES.includes(toolName)) return "program_status";
  if (ACTION_TOOL_NAMES.has(toolName)) return "flat_dispatch";
  // Reads, scene inspection, presentation and every other tool: real calls, but not one of these owners.
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

/**
 * The two counts that describe the same executions, checked against each other.
 *
 * `byCategory.flat_dispatch.calls` counts per-action tool calls in the Pi session record; `executionTrace.flat` counts
 * the request frames the runner actually sent over the bridge. A flat dispatch IS a frame, so the tool-call count can
 * never exceed the frames: a run claiming more dispatches than it sent is reporting work it did not do. Measured
 * 2026-10-22 (run `g143closed`): `executionTrace.flat: 0`, no per-action tool mounted, `flat_dispatch.calls: 45` - the
 * session record read was a PREVIOUS run's, and an auditor concluded from 45 that the flat surface was still mounted.
 * That over-count is what this invariant forbids by name.
 *
 * The other direction is a real fact, not a defect: the runner dispatches a few frames of its own (covenant seeds,
 * probes), so frames can exceed tool calls. Those are published as `framesWithoutToolCall` rather than folded into a
 * category or silently tolerated - an unequal pair a reader can see is worth more than an equality nobody measured.
 */
function toolTimingInvariant({ calls, frames }) {
  if (!Number.isInteger(calls) || !Number.isInteger(frames)) {
    return Object.freeze({
      checked: false,
      ok: null,
      calls: calls ?? null,
      frames: frames ?? null,
      framesWithoutToolCall: null,
    });
  }
  return Object.freeze({
    checked: true,
    ok: calls <= frames,
    equal: calls === frames,
    calls,
    frames,
    framesWithoutToolCall: Math.max(0, frames - calls),
  });
}

/**
 * How many status reads the session record published, or `null` when that read published none.
 *
 * `null` is not `0`: an unbound session record is a population nobody measured, and a run that genuinely never polled is
 * the good outcome this account exists to reward. `planCalls` present but without the key IS `0` - a measured session
 * that made none of those calls.
 */
function planPollCount(toolTiming) {
  const calls = toolTiming?.planCalls;
  if (calls === null || calls === undefined) return null;
  return calls.stardew_action_program_status ?? 0;
}

function readToolTiming(
  sessionJsonlPath,
  { executionTraceFlat, unboundReason = "no_session_record" } = {},
  ledger = null,
) {
  const frames = Number.isInteger(executionTraceFlat) ? executionTraceFlat : null;
  // ONE shape for "no timing published": `byCategory` and `longest` are null, not empty categories, because an empty
  // category reads as a measured zero and a zero is a number a reader quotes. `reason` is the only thing to read.
  const noTiming = (reason, record, invariant = toolTimingInvariant({ calls: null, frames })) =>
    Object.freeze({
      observed: false,
      reason,
      record,
      byCategory: null,
      longest: null,
      modelTurns: null,
      planCalls: null,
      invariant,
    });
  if (typeof sessionJsonlPath !== "string" || sessionJsonlPath.length === 0) return noTiming(unboundReason, null);
  // WHICH record the counts came from, by file name: the lie was a record from another run, and no count can show
  // that on its own. A reader comparing the run's launch with this stamp can see the record is not this run's.
  const record = sessionJsonlPath.split(/[\\/]/u).pop() ?? null;
  let raw;
  try {
    raw = readFileSync(sessionJsonlPath, "utf8");
  } catch {
    return noTiming("session_not_readable", record);
  }
  const pending = new Map();
  const durationsByCategory = new Map();
  // The run's model round trips and the plan tools it spent them on: the cost account's numerator. Counted here because
  // this loop already reads every message in the record, and a second reader of the same file is a second spelling.
  let modelTurns = 0;
  const planCalls = {};
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
      modelTurns += 1;
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== "toolCall") continue;
        if (PLAN_TOOL_NAMES.has(part.name)) planCalls[part.name] = (planCalls[part.name] ?? 0) + 1;
        pending.set(part.id, { category: toolTimingCategory(part.name), startedAtMs: atMs });
        ledger?.record("tool.start", { tool: part.name ?? null, category: toolTimingCategory(part.name) });
      }
      continue;
    }
    if (message?.role !== "toolResult") continue;
    const call = pending.get(message.toolCallId);
    if (call === undefined) continue;
    pending.delete(message.toolCallId);
    ledger?.record("tool.settled", { tool: call.category });
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
  const invariant = toolTimingInvariant({ calls: byCategory.flat_dispatch.calls, frames });
  // WITHHELD, not published-with-a-warning: a count that disagrees with the frames this run sent is not this run's
  // measurement, so the timings are dropped and only the measured disagreement is published. Measured 2026-10-22:
  // two runs with different launch times both carried one foreign record's `calls=45, sumMs=47189` under a red
  // invariant, and the numbers were quoted as each run's own latency anyway. A caveat gets quoted with the number;
  // an absent number cannot be.
  if (invariant.ok === false) return noTiming("tool_timing_invariant_violated", record, invariant);
  return Object.freeze({
    observed: true,
    reason: null,
    record,
    byCategory: Object.freeze(byCategory),
    longest: Object.freeze(longest.slice(0, TOOL_TIMING_LONGEST_LIMIT)),
    // The model turns this record holds, and the plan tools it called by name: the two populations the run cost account
    // divides. `null` when the record could not be bound - never `0`, which is a measured run that made no call.
    modelTurns,
    planCalls: Object.freeze(planCalls),
    invariant,
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
  // The run does not get to decide whether its own account adds up: the pieces are counted where they were committed
  // (the port above) and the account is read back out of the Host's own lines, so the two cannot be the same
  // derivation. `DELIVERY_ACCOUNT` is printed once per run, in words, so the answer is in the log as well as the bundle.
  const hostLog = hostLogChunks.join("");
  const delivery = readTurnDeliveryRecords(hostLog);
  const deliveryAccount = summarizeDeliveryAccount({
    records: delivery.records,
    unparsable: delivery.unparsable,
    piecesProduced: presentationPieces.length,
  });
  console.error("DELIVERY_ACCOUNT", describeDeliveryAccount(deliveryAccount));
  // What she was doing BETWEEN the pieces, off the same log the delivery account is read from. Bounded, and
  // `not_measured` rather than an empty array when the channel published nothing, so "nobody woke her" is never
  // spelled the same way as "the field is empty".
  const activity = summarizeActivity(readActivityPoints(hostLog));
  // Executions that stopped making progress, off the same log and in the same shape: the Host prints one stall fact per
  // arming (`host-service.ts` `#publishStallFact`), and until this field nothing in the bundle could say a body was
  // stuck. The parser owns the cap and the count of what it dropped. NOT read by `round-verdict.mjs` yet - the verdict
  // bucket for this field is another lane's follow-up, so the bundle publishes it and no rung claims it.
  const stallWatch = readStallWatch(hostLog);
  // The age of the world reading the Host was re-stating, when it outlived its bound (`#publishWorldStateStaleFact`).
  // Published beside the stall facts for the same reason: "the block said 06:00 for fifty turns" is the answer to "why
  // did nothing happen", and until this field no bundle carried it.
  const worldStateStale = readWorldStateStaleFacts(hostLog);
  return Object.freeze({
    // Each piece carries `atMs` on the run clock, and the turn's own start is published beside them, so a reader can
    // place a spoken line against a dispatch instead of only against its own turn. Before this the silence gate had
    // to report its longest stretch as an UPPER BOUND (161 s, `cause: run_end`, measured 2026-10-20).
    turnStartedAtMs,
    pieces: Object.freeze([...presentationPieces]),
    pieceAtMs: Object.freeze([...presentationPieceAtMs]),
    pieceCount: presentationPieces.length,
    firstPieceTtfbMs: presentationPieces.length > 0 ? presentationPieces[0].elapsedMs : null,
    // A turn that arrived as one wall at the end vs several pieces over time.
    chunked: presentationPieces.length > 1,
    // Every committed piece accounted for, in the unit it was committed in: the presented paragraphs, the pieces a
    // paced surface emitted ahead of them, and whatever is left over. A non-zero remainder is a blocked run (the
    // `delivery_account` clause), not a number a reader has to notice.
    deliveryAccount,
    activity,
    stallWatch,
    worldStateStale,
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
  const committedAtMs = Date.now();
  presentationPieces.push(Object.freeze({ index: presentationPieces.length, text, locale, elapsedMs }));
  ledger.record("present.visible", { index: presentationPieces.length - 1 });
  // The absolute commit moment, kept in a SIDE array on purpose: `pieces` keeps its published shape (several tests pin
  // it), while a reader still gets the moment each piece landed on the run clock. Without it the silence audit can only
  // answer `not established`, which is what it had to do for every run before this.
  presentationPieceAtMs.push(committedAtMs);
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
      // WHEN, on the run's own clock. Without it the timeline is an ordered list of events with no durations, and the
      // question "how long did walking take" has no answer from any artifact - measured 2026-10-30: 3,348 timeline
      // entries, **not one** carrying a timestamp, while a 32-minute run reported 950 `move_to_tile`, 1,145
      // `tile_advanced` and 1,624 `body_trace` entries. A stall was invisible unless something else happened to
      // record it.
      atMs: Date.now(),
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
      } catch {
        return null;
      }
    })();
    factLog.push(entry);
    // The same listener that records the fact also stamps the ledger: a receipt is one boundary on the run's
    // own clock, so the wait it ends is a subtraction rather than an inference.
    // The identity is what makes a settle attributable to a dispatch. Without it the ledger recorded 294
    // receipts against 26 dispatches with no way to pair them - a count of waits that could not say whose.
    if (entry.type === "execution_receipt") {
      ledger.record("world.settled", {
        reasonCode: entry.reasonCode ?? null,
        requestId: entry.requestId ?? null,
        executionId: entry.executionId ?? null,
      });
    }
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

/**
 * How long the world has published nothing that means it moved.
 *
 * `null` is "cannot be read" and never zero: a quiet nobody measured must not license a wake. The sources are the ones
 * `waitForSessionQuiet` already watches - a receipt, lifecycle or error fact, and a flat dispatch's own settlement -
 * plus the moment the last turn began, because a turn during which the world published nothing at all is a measured
 * quiet rather than an unmeasured one. Without that third source a run whose first turns produced no receipts would
 * suppress its own day forever, which is the failure this bound exists to avoid in the other direction.
 */
function quietMsNow() {
  let lastFactAtMs = null;
  for (let at = factLog.length - 1; at >= 0; at -= 1) {
    if (!meaningfulFact(factLog[at])) continue;
    lastFactAtMs = factLog[at].atMs ?? null;
    break;
  }
  const lastDispatchAtMs = actionTrace.at(-1)?.settledAtMs ?? null;
  const readable = [lastFactAtMs, lastDispatchAtMs, turnStartedAtMs].filter((value) => Number.isFinite(value));
  if (readable.length === 0) return null;
  return Date.now() - Math.max(...readable);
}

/**
 * Whether the Mod holds a pass it can still continue.
 *
 * Two facts, and the second is the one a turn boundary hides: a dispatch answers `accepted` while its terminal arrives
 * later as a receipt fact, so a turn can settle with the work still in the body's hands. `activeExecution` is the
 * snapshot's projection of the same thing, kept beside it because a program whose admission never reached a receipt is
 * visible in neither window alone.
 */
function bodyWorkNow() {
  const admitted = new Set();
  const settled = new Set();
  for (const entry of factLog) {
    const receipt = recordedReceipt(entry);
    const requestId = entry?.requestId;
    if (receipt === null || typeof requestId !== "string") continue;
    if (TERMINAL_STATES.has(receipt.state)) settled.add(requestId);
    else admitted.add(requestId);
  }
  for (const requestId of settled) admitted.delete(requestId);
  return Object.freeze({
    programRunning: (client.state?.snapshot?.activeExecution ?? null) !== null || admitted.size > 0,
    admissionPending: admitted.size > 0,
  });
}

/**
 * The Host's own stall facts that have arrived since the last look.
 *
 * The pump owns the bound and the re-arm (`EXECUTION_STALL_BOUND_MS`, `EXECUTION_STALL_REARM_MULTIPLE`); the runner reads
 * only what it published, through the parser the bundle already uses for the same lines - one reading of a stall, not
 * two. The cursor is a chunk index plus the partial line that straddled the last read: the log is appended to and never
 * rewritten, so nothing already read is read again.
 */
const stallReadCursor = { chunk: 0, carry: "" };
function newStallFacts() {
  if (stallReadCursor.chunk >= hostLogChunks.length) return [];
  const text = stallReadCursor.carry + hostLogChunks.slice(stallReadCursor.chunk).join("");
  stallReadCursor.chunk = hostLogChunks.length;
  const lines = text.split("\n");
  stallReadCursor.carry = lines.pop() ?? "";
  return readStallWatch(lines.join("\n")).facts;
}

/**
 * The Host's world-stale facts that have arrived since the last look.
 *
 * Same cursor, same channel, same parser shape as `newStallFacts`, because it is the same defect family: the pump owns
 * the bound (`WORLD_STATE_STALE_TURNS`), the Host publishes one line per arming, and the loop only reads whether one
 * arrived. MEASURED 2026-11-10 (`round45`): the world block froze at `revision 352` for fifty turns, every turn was
 * issued as `continuation`, and nothing in the loop could have known - so she carried on from a day-old picture and
 * dispatched nothing for the last thirty minutes.
 */
const worldStateStaleReadCursor = { chunk: 0, carry: "" };
function newWorldStateStaleFacts() {
  if (worldStateStaleReadCursor.chunk >= hostLogChunks.length) return [];
  const text = worldStateStaleReadCursor.carry + hostLogChunks.slice(worldStateStaleReadCursor.chunk).join("");
  worldStateStaleReadCursor.chunk = hostLogChunks.length;
  const lines = text.split("\n");
  worldStateStaleReadCursor.carry = lines.pop() ?? "";
  return readWorldStateStaleFacts(lines.join("\n")).facts;
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
 * What the run tried (`attempted`), succeeded at (`succeeded`), and changed (`accomplished`).
 *
 * Both CHANNELS of an execution are read, each from its own source (`execution-trace.mjs`): the flat request frames the
 * runner sent, and the nodes the Mod ran natively in a Body Program. An action id is counted once however many times it
 * was dispatched, so a run that batched everything through programs is no longer summarised as having done nothing -
 * measured 2026-10-22, when every action went through a program, `actionTrace` held zero rows and a session that tilled,
 * planted and harvested was reported `nothing_accomplished`.
 *
 * The verdict reads attempted and accomplished (moving, looking and re-equipping is not playing); the result publishes
 * the same three lists under its own names. One derivation, so the verdict and the artifact cannot disagree about what
 * the run did.
 */
function summarizeDispatchedActions(actionTrace, programOutcomes, programSubmissions) {
  const { attempted, succeeded } = executedActionIds({ actionTrace, programOutcomes, programSubmissions });
  return Object.freeze({
    attempted,
    succeeded,
    accomplished: succeeded.filter((actionId) => !NON_ACCOMPLISHMENT_ACTIONS.has(actionId)),
  });
}

/**
 * The task's own verdict, from the purposes the day loop judged (`task-purpose.mjs`). One spelling, because the session
 * verdict and the rung clause both report it.
 *
 * THREE ANSWERS, and `null` is the only pass:
 *   - `task_not_achieved` when a purpose's receipts are COMPLETE evidence that it did not hold;
 *   - `task_unproven:<taskId>:<reasonCode>,...` when a purpose could not be decided at all - the criterion needs a fact
 *     nothing publishes, or the receipts that would decide it carried no postcondition of their own. It names the
 *     criterion AND the reason, so "we could not prove it" is a finding a reader can act on rather than silence;
 *   - `null` when every purpose was achieved.
 *
 * UNPROVEN IS NOT A PASS. Measured 2026-11-07 (`round39`): three days of `clear_and_plant_long_patch` came out
 * `unproven` - no admitted receipt carried a tile, so the 3x20 strip could be neither confirmed nor denied - and the
 * verdict named none of it, because the arm read only `not_achieved`. An unprovable criterion is a fact about our own
 * reporting, and a run that cannot say whether the task happened has not been verified as one that did.
 */
function taskPurposeVerdict(taskPurposes) {
  const purposes = Array.isArray(taskPurposes) ? taskPurposes : [];
  if (purposes.some((purpose) => purpose.state === "not_achieved")) return "task_not_achieved";
  const unproven = purposes.filter((purpose) => purpose.state === "unproven");
  if (unproven.length === 0) return null;
  return `task_unproven:${unproven
    .map((purpose) => `${String(purpose.taskId ?? purpose.task)}:${String(purpose.reasonCode)}`)
    .join(",")}`;
}

/**
 * The session's one verdict, decided by a single control flow whose residual IS `completed`.
 *
 * `completed` cannot be computed beside the evidence and then published next to it: measured 2026-10-21 on three
 * multi-day runs, `sessionVerdict: "completed"` was published while `multiday.completed` was false and the assessment
 * said `blocked`. One run cannot both have completed and have been blocked, so the multi-day assessment is an arm of
 * the derivation itself - while it is not `passed`, `completed` is unreachable rather than merely contradicted.
 *
 * Each arm names the fault it reports, so the assessment cannot mask a turn, a transport or a world that already said
 * what went wrong; the scenario clauses then read this verdict instead of re-deciding part of it.
 */
function deriveSessionVerdict({
  worldStallReason,
  sessionTurns,
  unsettledTurns,
  turnFailureReason,
  bridgeDisconnections,
  sessionSpoken,
  accomplishedActionIds,
  taskPurposes,
  multidayAssessment,
  // The whole session's last model answer, because the wall is a fact about the MODEL and not about the pipe. Only
  // `stopReason` is read here; the outcome object carries much more and none of it belongs in a verdict.
  agentTurnOutcome,
  morningLiveness,
}) {
  if (worldStallReason !== null) return "world_stopped_advancing";
  if (sessionTurns.length === 0) return "no_turns";
  // A session cut off mid-turn is not a completed session, and the timeout is its own answer: run H passed a 609s
  // `agent_turn_timeout` because nothing here distinguished it from a settled turn.
  if (unsettledTurns.some((entry) => entry.error === "agent_turn_timeout")) return "turn_timeout";
  if (unsettledTurns.length > 0) return "turn_unsettled";
  if (turnFailureReason !== undefined) return "turn_failed";
  // A turn that ended at the context wall did not merely time out or lose its pipe: the model was cut off mid-thought
  // and every later turn inherited the same full window. `bridge_disconnected` is what a run LOOKS like when this
  // happens - the pipe closes because nothing more is sent - so naming the pipe first reports a symptom and hides the
  // cause. Measured 2026-10-29 (`round7`): 178 assistant turns, `stopReason: "length"` at 139,899 tokens, one-token
  // outputs, then `pipe_closed` and a `night_watched_over_a_dead_bridge` verdict that named neither.
  if (agentTurnOutcome?.stopReason === "length") return "context_exhausted";
  // A transport that died mid-run cannot support a behaviour claim: the companion's own line may simply never have
  // been presented, so silence would be reported for a fault in the pipe.
  if (bridgeDisconnections.length > 0) return "bridge_disconnected";
  // The run's own multi-day judgement, in the verdict rather than beside it. `null` means this run never made one
  // (every scenario but `multiday_routine`), which is not a judgement either way.
  if (multidayAssessment !== null && multidayAssessment.state !== "passed") return "multiday_routine_blocked";
  // A morning whose clock never moved is the deadlock itself, and it is checked HERE - before the multi-day judgement
  // above would report it as a generic block - because it is not a preference about how a day went: the engine opened a
  // day and then held it. Four commits have fixed the standing settlement sheet by path (`1b70f08e`, `541775c2`,
  // `4357a95b`, `76c51da4`) and on 2026-10-31 it recurred with `menu=ShippingMenu` and the clock at 600 for the rest of
  // the run. Naming the OUTCOME is what makes the fifth occurrence impossible to report as anything else.
  if ((morningLiveness?.violations?.length ?? 0) > 0) return "morning_clock_frozen";
  if (!sessionSpoken) return "silent";
  if (accomplishedActionIds.length === 0) return "nothing_accomplished";
  // A session that changed the world has still not necessarily done the TASK it was given. The task's own criterion
  // decides that (`task-purpose.mjs`), and the two answers are different: a rock broken on the surface is real
  // accomplished work and not a mine delved. These arms sit AFTER "did the companion play at all" - a session that
  // did nothing is already its own verdict - and BEFORE `completed`, so a day whose purpose is unproven or unmet can
  // never be reported as a completed one. A scenario that names no task passes an empty list and is judged on the
  // session alone, which is the truth about that scenario rather than a default about a task.
  // THE TASK'S OWN VERDICT, and it does not stop at `not_achieved`.
  //
  // A criterion can be missing because a FACT we publish is missing - seven rotation tasks are in exactly that state,
  // each naming the fact (see `task-purpose.mjs`). Judging the run as a FAILURE on one turns our own reporting gap into
  // a product failure. But `completed` is the other lie: a purpose nobody could decide was not verified, and a session
  // that says `completed` beside it claims the task happened. The arms above are about whether the session ran at all;
  // this one is about whether it did the thing it was asked to do, and `unproven` answers "nobody can say".
  //
  // `not_achieved` decides first, because there the receipts are complete evidence that the purpose did NOT hold.
  const taskVerdict = taskPurposeVerdict(taskPurposes);
  if (taskVerdict !== null) return taskVerdict;
  return "completed";
}

/**
 * The rung's verdict, and the ONE code that says why it is not a pass.
 *
 * A blocked run used to publish the SCENARIO it ran in as its reason (`${SCENARIO}_blocked` was the fallback in
 * `buildRunResult`), which is not a diagnosis: it names the rung, and the rung is not what failed. Measured
 * 2026-11-06 on `round38` - `state: "blocked"`, `failure.reasonCode: "multiday_routine_blocked"`, while the
 * multi-day assessment said `passed`, the session verdict said `completed` and the historian rubric said `passed`.
 * The only thing the run had actually failed was its companion-interaction gate (`summary_too_long`, 124 characters),
 * and nothing in the artifact said so; the launcher's own summary printed `reason (none)`.
 *
 * So the clauses are named, in the order a reader should be told about them, and the FIRST one that fails is the
 * reason. `passed` is the residual - a run is passed when no clause objects - and every clause carries a code, so a
 * blocked run can never publish an empty or borrowed reason.
 */
function deriveRungVerdict(clauses) {
  const all = Array.isArray(clauses) ? clauses : [];
  // EVERY clause that failed, not only the first: the reason a run is not passed is the first failing clause, but a
  // reader must not have to infer that a second, independent clause also failed. Measured 2026-11-07 (`round39`): the
  // rung's reason was `multiday_routine_blocked`, and the run's own task purposes were ALL `unproven` - a second finding
  // that existed in the evidence and in no verdict field, so the bundle read as if the task had never been asked.
  const failed = all.filter((clause) => clause?.passed !== true);
  const failedClauses = Object.freeze(
    failed.map((clause) => Object.freeze({ id: clause?.id ?? null, reasonCode: clause?.reasonCode ?? null })),
  );
  for (const clause of all) {
    if (clause?.passed !== true)
      return Object.freeze({
        state: "blocked",
        reasonCode: clause?.reasonCode ?? null,
        failedClause: clause?.id ?? null,
        failedClauses,
      });
  }
  return Object.freeze({ state: "passed", reasonCode: null, failedClause: null, failedClauses });
}

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
/** Facts that mean the world moved. Per-tile chatter (`body_trace`, route progress) is not motion. */
const meaningfulFact = (entry) =>
  entry?.type === "execution_receipt" || entry?.type === "lifecycle" || entry?.type === "error";

async function waitForSessionQuiet(turn, { dispatchesBeforeTurn, quietMs = QUIET_BOUND_MS, timeoutMs = 300_000 } = {}) {
  // Quiet = no NEW dispatch and no NEW meaningful fact for a sustained window. The window itself is `QUIET_BOUND_MS`,
  // which is also what the day loop's wake decision reads, so a wake and the turn it starts cannot disagree about what
  // "quiet" means. The previous version had a real bug: it sliced by a TIMESTAMP (factLog.slice(lastFactAt), where
  // lastFactAt was ms) and checked the WHOLE slice since the turn for any meaningful fact, so quiet was unreachable
  // whenever a meaningful fact had EVER arrived. Track the last-observed INDEX and check only the newly-appended facts.
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
    const factMoved = factLog.slice(lastSeenFact).some(meaningfulFact);
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
/**
 * How long after a scripted player line its reply is read out of the presentation stream.
 *
 * A steer is queued behind the assistant turn already in flight, so the answer cannot be read immediately; it also
 * cannot be read "when the turn ends", because that is the dependency this path exists to remove. 45 s is long enough
 * for one steering message to be picked up and answered.
 */
const DIALOGUE_REPLY_WINDOW_MS = Number(process.env.GAMEBUDDY_DIALOGUE_REPLY_WINDOW_MS ?? 45_000);

/**
 * The ground truth a scheduled gate is judged against, per gate.
 *
 * `yesterday` is the night record of the day BEFORE the morning the gate speaks on - `gate.trigger.day - 1`, derived
 * from the gate itself so the record and the question cannot disagree about which night is meant. The night watch
 * observes that record: `bedTime` is the latest clock it saw while the day was still current and `passedOut` is the
 * engine taking the night at its own 26:00. Nothing in this process stores a bed time anywhere else, so it is an
 * observation rather than a constant.
 *
 * `refusal` travels with the DELIVERY rather than with the assessment: it is the evidence that was in hand at the
 * moment the player line was claimed, so a gate can never be handed a refusal that arrived after it spoke.
 */
function dialogueGateContext(gate) {
  const triggerDay = gate.trigger.day;
  const delivery = dialogueDelivery.get(gate.id);
  return Object.freeze({
    yesterday: Number.isInteger(triggerDay) && triggerDay > 1 ? (nightRecordsByDay.get(triggerDay - 1) ?? null) : null,
    refusal: delivery?.state === "delivered" ? (delivery.refusal ?? null) : null,
  });
}

/**
 * Submit the gates due at this delivery boundary, without waiting for that day's turn to settle.
 *
 * Delivery and capture are separated on purpose: delivery goes through the same admission path a player uses, so it is a
 * real player turn and steers into the running work; capture reads the presentation pieces produced during the reply
 * window, sliced by index so one gate's answer cannot be attributed to another's turn.
 *
 * WHICH gates are due is decided by `planGateDeliveries`, from the schedule the gate module owns - including the
 * refusal-triggered obstacle gate, which was skipped here by kind and therefore could never be spoken at all. Every
 * decision, spoken or not, is recorded with the fact behind it, so an untriggered gate stops reading like an unwired one.
 */
async function deliverDialogueGatesForDay(day, tools) {
  // A refusal is the obstacle gate's only ground truth, and the boundary is where that gate is decided on: re-read it
  // here so the age judged is the age now, not the age at the last in-turn sample.
  sampleRefusalEvidence();
  const plans = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day,
    lastRefusalAtMs: refusalSample.atMs,
    refusalReadError: refusalSample.readError,
    receiptMarkers: refusalSample.markers,
    deliveredIds: new Set([...dialogueDelivery].filter(([, entry]) => entry.state === "delivered").map(([id]) => id)),
    nowMs: Date.now(),
  });
  for (const plan of plans) {
    const gate = plan.gate;
    if (plan.deliver !== true) {
      if (plan.reason !== "already_delivered")
        dialogueDelivery.set(
          gate.id,
          Object.freeze({ state: "not_delivered", day, atMs: Date.now(), reason: plan.reason }),
        );
      continue;
    }
    // Re-checked per gate: a concurrent invocation may have claimed a LATER gate while this one waited out an earlier
    // gate's reply window, and the plan it worked from is by then stale.
    if (dialogueDelivery.get(gate.id)?.state === "delivered") continue;
    // Claimed BEFORE the first await: two turns can reach this function at once, and a gate claimed twice is the same
    // player asking the same question twice.
    const claimed = Object.freeze({
      state: "delivered",
      day,
      atMs: Date.now(),
      // The refusal is evidence only for the gate that is triggered by one; it is the sample, plus how old it was when
      // the player spoke, so the answer can be traced back to the refusal it answers.
      refusal:
        gate.trigger.kind === "recent_refusal"
          ? Object.freeze({
              atMs: refusalSample.atMs,
              ageMs: Date.now() - refusalSample.atMs,
              code: refusalSample.code,
              requestId: refusalSample.requestId,
            })
          : null,
      admission: null,
    });
    dialogueDelivery.set(gate.id, claimed);
    const piecesBefore = presentationPieces.length;
    const admission = await submitPlayerPrompt({
      accept: (promptText, locale) => tools.acceptPlayerText(promptText, locale),
      text: gate.prompt,
      locale: "zh-CN",
      timeoutMs: Number(process.env.GAMEBUDDY_PLAYER_INPUT_ADMISSION_MS ?? 90_000),
    }).catch((error) => ({ accepted: false, lastRefusal: String(error?.message ?? error) }));
    if (admission.accepted !== true) {
      // A refused line is recorded as an absent answer WITH its reason: an admission that never happened must not read
      // as silence from the companion, and it must not read as a gate nobody wired either.
      dialogueDelivery.set(
        gate.id,
        Object.freeze({ ...claimed, admission: `refused:${admission.lastRefusal ?? "unknown"}` }),
      );
      dialogueReplies.set(gate.id, "");
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, DIALOGUE_REPLY_WINDOW_MS));
    const spoken = presentationPieces
      .slice(piecesBefore)
      .map((piece) => (typeof piece === "string" ? piece : (piece?.text ?? "")))
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
    dialogueDelivery.set(gate.id, Object.freeze({ ...claimed, admission: "accepted" }));
    dialogueReplies.set(gate.id, spoken);
  }
}

/**
 * Why a turn abandoned for transport loss says so, in one sentence with the fields that discriminate.
 *
 * The transport's own code alone is not enough to act on: `turn_ended_by_transport_loss:invalid_body_program_result`
 * names a validator verdict but not the frame that earned it, and no minute of the turn it happened at. Both are already
 * on hand when the abandon is decided - the disconnection carries `atMs`, and the bridge publishes
 * `bridge_frame_refused:<kind>:<validatorCode>` before it closes - so the sentence joins them here instead of making the
 * next reader reconstruct them from three artifacts (round46).
 *
 * `at_turn_ms` is the loss measured from THIS turn's own start, which is the only origin the turn's record has.
 */
function transportAbandonCause(reasonCode, disconnection, diagnostics, startedAtMs) {
  const atTurnMs =
    Number.isFinite(startedAtMs) && Number.isFinite(disconnection?.atMs)
      ? String(Math.max(0, disconnection.atMs - startedAtMs))
      : "unmeasured";
  const refused = diagnostics.findLast((entry) => entry?.stage === "bridge_frame_refused")?.reasonCode ?? "none";
  return `${reasonCode};at_turn_ms=${atTurnMs};refused=${refused}`;
}

async function runAgentTurn(text, tools, wake) {
  // EVERY prompt states why the model is being woken, and the reason is a closed set (`WAKE_REASONS`). A prompt issued
  // because something settled, with no reason it can name, is the defect this harness was paying 94% of its wall clock
  // for (round44: 109 prompt turns for four days, 73 of them dispatching nothing).
  const wakeReason = wake?.reason;
  if (!WAKE_REASONS.includes(wakeReason)) throw new Error(`prompt_without_a_declared_reason:${String(wakeReason)}`);
  turnStartedAtMs = Date.now();
  // One line per turn, because the only question a memory death leaves open is its SHAPE: flat after the first
  // allocation spread, or growing with turns. `sessionBytes` is the retained-transcript proxy (Pi holds the session
  // twice in RAM) and costs one stat; `diagnostics` is the runner's own unbounded array.
  const rss = sampleHostMemory(turnStartedAtMs);
  let sessionBytes = null;
  try {
    sessionBytes = statSync(runSessionRecord.path).size;
  } catch {
    sessionBytes = null;
  }
  // The same reading, kept in the series the bundle publishes instead of only in a terminal log (measured 2026-11-09,
  // `round40`: 46 of these lines and no memory field in the artifact at all).
  const turnMemory = appendTurnMemory({
    series: hostMemory.turns,
    point: turnMemoryPoint({ turn: agentTurnCount, rssMb: rss.rssMb, heapUsedMb: rss.heapUsedMb, sessionBytes }),
    omitted: hostMemory.turnsOmitted,
  });
  hostMemory.turns = turnMemory.turns;
  hostMemory.turnsOmitted = turnMemory.omitted;
  console.error(
    `HOST_MEMORY_TURN ${JSON.stringify({ turn: agentTurnCount, rssMb: rss.rssMb, freeMb: rss.freeMb, sessionBytes, diagnostics: bridgeDiagnostics.length, facts: factLog.length })}`,
  );
  agentTurnCount += 1;
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
  // The program THIS turn submitted, read the same way: `programSubmissions` is the run's cumulative history, so the
  // turn's own submissions are the ones past this cursor. It was a run-long binding (`agentProgramId`) mutated by the
  // submit wrapper, and turn 2 therefore polled turn 1's terminal program, broke at second zero, and never reached the
  // heartbeat sample below - one turn's result answering another turn's question.
  const submissionsBeforeTurn = programSubmissions.length;
  const turnProgramId = () =>
    programSubmissions.length > submissionsBeforeTurn
      ? (programSubmissions[programSubmissions.length - 1]?.programId ?? null)
      : null;
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
    // A dead transport is not a turn to wait for. Measured 2026-10-25: the pipe closed at in-game 22:00, in the same
    // second the companion was deciding to go to bed; the harness waited out the rest of the evening while the world ran
    // on to a 2:00 AM pass-out, and the run reported `companion_did_not_sleep` - the CONSEQUENCES of the transport loss,
    // attributed to her behaviour.
    const transportLoss = shouldAbandonTurnForTransport(bridgeDisconnections);
    if (transportLoss.abandon) {
      // The cause the abandon was decided on MUST leave with the turn. It used to leave only on the envelope
      // (`{ turn: null, error }`), which every caller is free to ignore - and the multi-day loop did, so a round46
      // run ended with the verdict word `unsettled` while the reason sat in the envelope the whole time.
      const cause = transportAbandonCause(
        transportLoss.reasonCode,
        bridgeDisconnections[0],
        bridgeDiagnostics,
        turnStartedAtMs,
      );
      return { status: "failed", turn: { settled: false, error: cause }, error: cause };
    }
    const programId = turnProgramId();
    try {
      if (programId !== null) status = await client.programStatus({ programId });
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
          programId,
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
      // The refusal this run's own game recorded, kept current WHILE the turn runs. A refusal timestamped at the next
      // delivery boundary would date a twenty-minute-old refusal to the moment the player asked about it, and the
      // obstacle gate's whole premise is that the player is asking about something that just happened.
      if (SCENARIO === "multiday_routine") sampleRefusalEvidence();
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
  // Self-directed scenarios keep listening after the first settle, because a settle is not the end of the play.
  //
  // Measured 2026-10-25 (`night1`): at in-game 22:00 the companion received the milestone, thought "Time is 2200 …
  // Should I sleep?", and answered with a LINE of text. Its turn then settled - `stopReason: "stop"`, no errors - and
  // because this gate named only `morning_routine`, nothing in the harness could ever deliver another turn. It had the
  // action available (`sleep` was in all 97 advertised capabilities and it simply never called it), the world
  // ran on to the 2:00 AM pass-out, and the run recorded `companion_did_not_sleep`.
  //
  // A scripted single-goal rung is different: there, one settle IS the end of what it was asked to do, so those keep
  // their exact semantics.
  if (SCENARIO === "morning_routine" || SCENARIO === "multiday_routine")
    turn = await waitForSessionQuiet(turn, { dispatchesBeforeTurn, timeoutMs: turnWaitSeconds * 1000 });
  turn.steerObserved =
    turnProgramId() !== null ||
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
 * SETTLES with no `sleep`, it reports `companion_did_not_sleep` at once. This bound only has to sit past
 * the turn budget, so the run budget stays the hard stop.
 */
// The engine's own pass-out hour: at 26:00 the actor collapses and the day rolls over by itself
// (`Game1.cs:6452-6460`, `timeOfDay >= 2600 || player.stamina <= -15f`). This is the LAST moment a night can
// still be the companion's own; anything earlier is a judged value rather than a native fact.
//
// `readWorldClock().spent` used to compare against 22:00 and the night watcher answered `companion_did_not_sleep`
// the moment a settled turn found the clock past it. Measured 2026-10-26: the companion reached 22:00, said
// "Time to sleep ... let me observe first then sleep", and the watcher had already called it a refusal - a
// verdict about the harness's hour, reported as a verdict about her behaviour, arriving before the dispatch it had
// announced. The sleep hour is therefore the engine's, not the scenario's.
const PASS_OUT_MINUTES = 26 * 60;

// When the harness stops offering the generic "carry on" and names the clock instead. Not a sleep order: the
// engine's own evening has visibly arrived (`Game1` switches to the night sky at 19:00), so a companion still
// working needs to be told what time it is, not told what to do.
const LATE_DAY_MINUTES = 19 * 60;

// A day contains turns; this bounds how many, for the harness only. It is not a limit on the day.
const MAX_TURNS_PER_DAY = Number(process.env.GAMEBUDDY_MULTIDAY_MAX_TURNS_PER_DAY ?? 40);

/**
 * How often a day loop that may NOT wake her re-asks the world whether it now may.
 *
 * A poll rather than a timer per condition: the facts that decide a wake arrive on four different channels (a
 * programme's terminal receipt, the in-game clock, the Host's stall fact, the day's own purpose), and one cadence over
 * all of them cannot miss one. One second is below the resolution of anything it reads and far above the cost of asking.
 */
const WAKE_POLL_MS = 1_000;
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
  // EVERY source, not one of them, and the archive says which files supplied it.
  //
  // This used to read a single path, and that path was the one the liveness meter read - which turned out to be the lane's
  // CONSOLE capture while the Mod writes its markers into the SMAPI log FILE. A run whose observation layer reads the wrong
  // stream does not merely lose a heartbeat: it loses the receipts, refusals and save-boundary facts this function exists to
  // make durable, and the artifact then says "no evidence" about things that were logged.
  try {
    const sources = MOD_LOG_PATHS().filter((candidate) => {
      try {
        return readFileSync(candidate, "utf8").length > 0;
      } catch {
        return false;
      }
    });
    const text = sources.map((candidate) => readFileSync(candidate, "utf8")).join("\n");
    const rows = text.split("\n");
    const tail = (pattern, count = 4) =>
      rows
        .filter((row) => pattern.test(row))
        .slice(-count)
        .map((row) => row.trim().slice(0, 400));
    const archived = typeof runDir === "string" && runDir.length > 0;
    if (archived) {
      writeFileSync(join(runDir, "mod-log.txt"), text);
      writeFileSync(join(runDir, "mod-log-sources.json"), JSON.stringify(sources, null, 2));
    }
    const lastWith = (needle) => (rows.filter((row) => row.includes(needle)).slice(-1)[0] ?? "").trim().slice(0, 400);
    return Object.freeze({
      // `sources` rather than a `path`: there is more than one source now, and the list is archived beside the text
      // (`mod-log-sources.json`). Measured 2026-11-05: this read a bare `path` that no enclosing scope declared, so
      // EVERY call threw `ReferenceError: path is not defined` - and the catch threw the same one, which ended the run
      // at the very line that assembles its result.
      sources,
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
      // The frames the outbound queue REFUSED, by frame kind: a terminal receipt dropped there is a state the Host waits
      // for and never receives, and until the bridge named it the run read as a companion that simply stopped answering.
      // The bridge bounds it to one line per second, so this tail is the whole population of a bounded fact.
      bridgeFrameRefused: tail(/bridge_frame_refused:/, 8),
      lastFrameState: lastWith("game_mode="),
      lastSavingState: lastWith("saving="),
    });
  } catch (error) {
    return Object.freeze({ archived: false, error: String(error?.message ?? error).slice(0, 240) });
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
//
// A lane that declared its own log (`GAMEBUDDY_STARDEW_LANE_LOG_PATH`, set by the launcher that piped this run's SMAPI
// console into it) reads THAT: the machine-global `SMAPI-latest*.txt` is numbered by player index inside the game, so
// under two concurrent lanes the unsuffixed file describes whichever instance SMAPI numbered first - reading it means
// auditing the other lane. The global path stays the default for a single-lane invocation that declares none.
//
// EVERY file that can carry the marker, because one of them demonstrably does and the other demonstrably does not.
//
// Measured 2026-11-04: for a run whose lane log held zero heartbeat lines, `%APPDATA%/StardewValley/ErrorLogs/SMAPI-latest.txt`
// held 50-89 of them for that same run - SMAPI writes the marker to its log FILE, while the lane log is the CONSOLE capture.
// The liveness meter therefore read an empty file and declared `world_stopped_advancing:silent_ms=90000:last_heartbeat=`
// while the bridge was carrying dispatches (round32: 5-15 submissions, all observed, zero disconnections).
//
// So the meter reads the marker wherever it is written and reports WHICH file it came from, instead of inferring "the world
// stopped" from "the file this code happens to prefer is quiet". The lane log stays in the list: under two concurrent lanes
// it is the only per-lane source, and the global file is shared, so neither can be dropped.
const readModLogText = () =>
  MOD_LOG_PATHS()
    .map((candidate) => {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

const MOD_LOG_PATHS = () => {
  const paths = [];
  const laneLog = process.env.GAMEBUDDY_STARDEW_LANE_LOG_PATH;
  if (laneLog) paths.push(laneLog);
  const errorLogs = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs");
  try {
    for (const name of readdirSync(errorLogs)) {
      if (name.startsWith("SMAPI-latest") && name.endsWith(".txt")) paths.push(join(errorLogs, name));
    }
  } catch {
    // An unreadable directory is not evidence of a stall; the other source may still answer.
  }
  return paths;
};
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
        "Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Select-Object -First 1 -Property Responding,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress",
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
        // The game's own working set. Without it a run that dies of memory exhaustion cannot say whose: the harness
        // records system-wide free memory and the Host's RSS, and never the process that owns most of the machine.
        // Measured 2026-11-09: `minFreeMb: 97` beside `hostRssMb: 934` on a machine whose rest state is 4.2 GB free of
        // 31 - a 934 MB process cannot account for that, so the attribute had no owner in any artifact.
        workingSetMb: typeof parsed.WorkingSet64 === "number" ? Math.round(parsed.WorkingSet64 / (1024 * 1024)) : null,
        privateMb:
          typeof parsed.PrivateMemorySize64 === "number"
            ? Math.round(parsed.PrivateMemorySize64 / (1024 * 1024))
            : null,
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
    // The source with the most marker lines wins: a file that cannot carry the marker must not be able to report silence.
    let best = { count: 0, line: "", path: null };
    let readable = false;
    for (const candidate of MOD_LOG_PATHS()) {
      let lines;
      try {
        lines = readFileSync(candidate, "utf8")
          .split("\n")
          .filter((line) => line.includes(MOD_HEARTBEAT_MARKER));
      } catch {
        continue;
      }
      readable = true;
      if (lines.length > best.count)
        best = { count: lines.length, line: (lines.at(-1) ?? "").trim().slice(0, 200), path: candidate };
    }
    if (!readable) throw new Error("no heartbeat source readable");
    const grew = best.count > modHeartbeatSample.count;
    modHeartbeatSample = {
      count: best.count,
      sinceMs: grew ? Date.now() : modHeartbeatSample.sinceMs,
      line: best.line,
      source: best.path,
    };
  } catch (error) {
    // Unreadable is not stalled: the run has no evidence either way, and inventing a stall would be worse.
    modHeartbeatSample = { ...modHeartbeatSample, line: `unreadable:${String(error?.message ?? error).slice(0, 80)}` };
  }
  return Object.freeze({ ...modHeartbeatSample, silentMs: Date.now() - modHeartbeatSample.sinceMs });
}
/**
 * The Mod's own line for a published receipt - the one this run reads a refusal out of.
 *
 * `ModTrace.ReceiptPublishLogLine` prints it for EVERY receipt the Mod publishes, and `state=Rejected` is the Mod's own
 * name for an action it refused to perform (an unreachable target, a blocked tile, an actor held by a menu). Every
 * receipt passes through that one funnel (`FarmhandExecutionController.AddTrace`), so the population is all refusals
 * this game recorded - not a sample of the ones somebody remembered to log.
 */
const MOD_RECEIPT_MARKER = "[receipt-publish-marker]";
let refusalSample = Object.freeze({
  markers: null,
  count: null,
  atMs: null,
  code: null,
  requestId: null,
  readError: null,
});
/**
 * Refresh this run's newest refusal from its own Mod log.
 *
 * Counting, not timestamp-parsing, and `Date.now()` is taken when the count GREW: the log's clock is written by another
 * process in another format and midnight makes it ambiguous, so the sample's own arrival is the time this run can
 * defend. The first sample is the BASELINE - lines already in the log belong to an earlier run of this lane, and
 * counting them would let last night's refusal answer a question about "just now". An unreadable log records its
 * reason and keeps whatever refusal was already known: losing the source does not un-refuse the action.
 *
 * Sampled from the running turn (so a refusal is timestamped when it happens, not when the turn ends) and again at each
 * delivery boundary (so the last few seconds before the player speaks are not lost).
 */
function sampleRefusalEvidence() {
  let markers;
  let rejected;
  try {
    const rows = readModLogText()
      .split("\n")
      .filter((line) => line.includes(MOD_RECEIPT_MARKER));
    markers = rows.length;
    rejected = rows.filter((line) => line.includes("state=Rejected"));
  } catch (error) {
    refusalSample = Object.freeze({ ...refusalSample, readError: String(error?.message ?? error).slice(0, 120) });
    return refusalSample;
  }
  const grew = refusalSample.count !== null && rejected.length > refusalSample.count;
  const newest = grew ? (rejected.at(-1) ?? "") : null;
  refusalSample = Object.freeze({
    // How many receipt lines the log carries AT ALL. Zero is not "no refusal happened": it is this lane's log not
    // carrying the marker, and a reader must be able to tell that from a run whose game refused nothing.
    markers,
    count: rejected.length,
    atMs: grew ? Date.now() : refusalSample.atMs,
    code: grew ? (newest.match(/reason=([^;]+)/u)?.[1] ?? null) : refusalSample.code,
    requestId: grew ? (newest.match(/request=([^;]+)/u)?.[1] ?? null) : refusalSample.requestId,
    readError: null,
  });
  return refusalSample;
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
 * The receipts recorded from `startFactIndex` on, in the shape a reader sees.
 *
 * The recorder flattens a receipt's identity onto the entry, but the receipt ITSELF - and with it the terminal
 * `state` - stays whole under `worldFactPayload` (see `recordedReceipt`), so this is the one place a run's
 * receipts are taken out of the fact log. Everything that asks a question of what the companion DID reads this.
 */
function receiptsSince(startFactIndex) {
  return factLog
    .slice(startFactIndex)
    .map(recordedReceipt)
    .filter((receipt) => receipt !== null);
}

/**
 * What one day accomplished, read from the RECEIPTS its dispatches produced on EITHER channel.
 *
 * A fact proves one thing about one action: it reached its DECLARED terminal, in a success state. Both halves are
 * required and neither is an attempt. A receipt's `actionId` is stamped by the Mod from the router's own dispatch
 * binding (`ExecutionManager.AddTrace`), which is the same binding a Body Program node goes through, so a program
 * node's terminal arrives in this log naming its action - `weeds_cut`, `rock_source_broken` - exactly as a flat
 * dispatch's does. That is why the log, not the trace, is the source here; see `execution-trace.mjs` for why the two
 * dispatch CHANNELS are two files, and `executedActionIds` for the weaker question (attempt and node state) it answers.
 *
 * Measured 2026-10-29 (`round7`): this walked `actionTrace`, whose file was 0 bytes for a run that ran all 251 physical
 * actions through 53 `stardew_plan_work` batches, so a day that cut 86 weeds and broke 48 rocks was reported
 * `next_day_produced_no_farm_work`. Counting a dispatch alone would have credited those 251 attempts as work; counting
 * the receipt credits only the actions whose own registered terminal came back.
 */
function accomplishedSince(startFactIndex) {
  const accomplished = new Set();
  for (const receipt of receiptsSince(startFactIndex)) {
    const actionId = receipt.actionId;
    // A day that only walked, looked around, posed and slept has NOT produced farm work, and for the
    // multi-day rule that is the difference between a loop and one rollover. Without this filter the day's own
    // `sleep` (whose terminal is `day_advanced`, a registered gate) always landed in the set - so
    // `next_day_produced_no_farm_work` could never fire and "the companion kept working" was unprovable
    // (measured 2026-10-17: the rule's own producer made it unreachable).
    if (NON_ACCOMPLISHMENT_ACTIONS.has(actionId)) continue;
    // The task's own progress reports are not work either.
    if (actionId === "sleep" || actionId === "dismiss_modal" || actionId === "respond_level_up") continue;
    // The registered terminal is the only code that can tell an action that FINISHED from one that only progressed;
    // an action with no published gate declares no terminal, so no receipt can prove it finished.
    const expected = STARDEW_PUBLISHED_ACTION_GATES.find((gate) => gate.actionId === actionId)?.terminalReasonCode;
    if (expected === undefined) continue;
    if (receipt.reasonCode !== expected) continue;
    if (receipt.state !== "succeeded" && receipt.state !== "partially_succeeded") continue;
    accomplished.add(actionId);
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
    // The hold is read BEFORE either exit, because it is a fact about the NIGHT and not about which way the watch
    // stopped. Testing `crossed === true` first meant a night that passed the actor out AND had already opened the next
    // day was recorded as the companion's own sleep: the two are not alternatives, and only the break order made them
    // look like it.
    if (outcome.reasonCode === "actor_passed_out") passOutObserved = true;
    if (outcome.crossed === true || outcome.reasonCode !== "actor_passed_out") break;
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
 * Watch the night that the companion's own `sleep` starts.
 *
 * Started at the SAME moment as the day's turn, because the night begins while the Agent is still blocked
 * inside its tool call. What this adds is the one thing the Agent cannot do for itself: the settlement menu
 * the rollover raises is observed and closed with the product's own `dismiss_modal`, and the closing receipt is
 * recorded - so "the menu was cleared" is a product fact rather than an inference from the run having
 * finished.
 */
// WAIT FOR THE NIGHT TO BEGIN before watching it.
//
// The night starts when the companion dispatches `sleep`, which happens somewhere inside its day. A
// watcher that started observing from the first second of the day would poll the world at 4 Hz for the whole
// turn (measured 2026-10-17: the first multi-day run had the loop observing from t=0, and the bridge closed
// 15s in) and would ALSO be unable to tell "the companion has not slept yet" from "the companion will not
// sleep". Waiting for the dispatch - bounded, and against the day's own settlement - gives both.
// `waitForNightToBegin` uses this to tell "the day is spent" from "the turn ended while the day is still running".
//
// The evidence is the Mod's own readiness line, which now publishes `game_time` and `clock_rate_ms`: the engine's
// clock, not the harness's clock, and not a guess about what a model meant. Without that line the answer is
// `unknown`, and `unknown` is reported as itself rather than being rounded into a verdict about the companion.
const readWorldClock = () => {
  // The snapshot first, the log only as a fallback.
  //
  // This used to read `DEBUG-native-local-readiness` lines exclusively, and that line is printed only when the Mod finds
  // the actor blocked in a way worth reporting: a run where the companion is free from start to finish emits none.
  // Measured 2026-10-26 (`adm4`): zero `game_time=` lines in the whole SMAPI log, so the watcher answered
  // `day_turn_settled_before_night:clock_unknown` and could not tell "the day ran out of turns" from "the day ran out
  // of daylight". The snapshot is the Mod's own publish of the same fact and it arrives on every observation.
  const snapshotTime = client.state?.snapshot?.timeOfDay;
  if (Number.isInteger(snapshotTime) && snapshotTime > 0) {
    const minutes = Math.floor(snapshotTime / 100) * 60 + (snapshotTime % 100);
    return Object.freeze({
      spent: minutes >= PASS_OUT_MINUTES,
      minutes,
      unknown: false,
      timeOfDay: snapshotTime,
      source: "snapshot",
    });
  }
  try {
    const lines = readModLogText()
      .split("\n")
      .filter((line) => line.includes("DEBUG-native-local-readiness"));
    const last = lines.at(-1) ?? "";
    const time = last.match(/game_time=(\d{3,4})/);
    if (time === null)
      return Object.freeze({ spent: false, minutes: null, unknown: true, timeOfDay: null, source: "none" });
    const timeOfDay = Number(time[1]);
    const minutes = Math.floor(timeOfDay / 100) * 60 + (timeOfDay % 100);
    return Object.freeze({
      spent: minutes >= PASS_OUT_MINUTES,
      minutes,
      unknown: false,
      timeOfDay,
      source: "readiness",
    });
  } catch (error) {
    return Object.freeze({
      spent: false,
      unknown: true,
      timeOfDay: null,
      source: "none",
      reason: String(error?.message ?? error),
    });
  }
};

async function watchNightRollover(day, { dayTurnSettled = Promise.resolve() } = {}) {
  const traceStart = actionTrace.length;
  // Where the RECEIPT log stood when this watch began, for the same reason as `traceStart`: a receipt that was
  // already there belongs to an earlier night (or to the day still being played), so it cannot be this night's
  // terminal. Measured 2026-10-31 (`round18`): both nights crossed with `entered_via=native_sleep_prompt` on the
  // Mod's own receipt, and both records still carried `terminal: null` because the watcher only ever looked at
  // `actionTrace` - which held ZERO rows, because every dispatch in that run went through Body Program.
  const factStart = factLog.length;
  // The calendar this watch began on. A crossing is `dayOfMonth` becoming a DIFFERENT value, which is true
  // whatever path dispatched the night and whatever the clock reads afterwards.
  //
  // This is the same second clause `nightCrossedInScope` has (`tools/lib/multiday-day-scope.mjs:70`), and it is
  // here because this watcher did not have it. Measured 2026-10-28 (`round4`): the world crossed TWO nights -
  // `day_advanced` succeeded at 17:36:07 and 17:46:21, SMAPI logged "starting spring 6 Y1" - and this function
  // reported `companion_did_not_sleep:day_turn_still_running` after a 31-minute timeout, because
  //
  //   - it looked for `sleep` in `actionTrace`, which records only FLAT dispatches, and all 276 of that
  //     run's dispatches went through Body Program;
  //   - and even had it found one, `readWorldClock().spent` is false the moment a new morning starts (a fresh
  //     day is `timeOfDay: 600`), so it would have waited for a night that had already ended.
  //
  // Judging by the calendar makes the watcher independent of WHICH path dispatched the night - flat, program, or
  // a native event - which is the fact it was always trying to observe. The calendar answers WHETHER a night passed
  // and can never answer HOW; the dispatch below is read from BOTH channels so the receipt that does answer it is
  // not lost to the channel the night happened to travel.
  const startDay = client.state?.snapshot?.dayOfMonth ?? null;
  const calendarMovedPastStartDay = () => {
    const now = client.state?.snapshot?.dayOfMonth;
    return Number.isInteger(startDay) && Number.isInteger(now) && now !== startDay;
  };
  /**
   * The companion's own `sleep` dispatches inside this watch window, from EITHER channel.
   *
   * `sleep` is the only thing that starts a `SleepAndAdvanceDayLifecycle`, so this is the dispatch the whole
   * watcher is built to follow. It reaches the game over TWO channels (see `execution-trace.mjs`), and the watcher
   * used to read only the first one:
   *   - FLAT: a request frame this runner sent itself, recorded in `actionTrace`;
   *   - PROGRAM: a node the Mod ran natively inside a Body Program. There is no request frame, so `actionTrace`
   *     holds nothing at all for it - but the receipt the Mod mints for the node names its action, because the
   *     receipt's `actionId` is stamped from the router's own dispatch binding (`ExecutionManager.AddTrace`), the
   *     same binding a flat dispatch goes through. `accomplishedSince` already reads the log for exactly this reason;
   *     this is the same fact, read for the night instead of for the day's work.
   *
   * Measured 2026-10-31 (`round18`): `actionTrace.jsonl` was 1 byte. The Mod logged `sleep lifecycle finished:
   * state=passed; reason=day_advanced` at 03:38:25 and its receipt `state=Succeeded;reason=day_advanced;
   * revision=1559` (request `3982f1bc...`, `actionId=sleep`) arrived at that same moment - inside this
   * window, which had begun around 03:36:26 - and the watcher still answered `terminal: null`, so both nights were
   * recorded `cause: "engine"` with the crossing witnessed only by the calendar. The receipt was in hand; the
   * watcher never looked.
   */
  const sleepRequestsSinceStart = () => {
    const requests = [];
    const add = (requestId) => {
      if (typeof requestId !== "string" || requestId.length === 0) return;
      if (!requests.includes(requestId)) requests.push(requestId);
    };
    for (const entry of actionTrace.slice(traceStart)) if (entry?.action === "sleep") add(entry.requestId);
    for (const entry of factLog.slice(factStart)) {
      const receipt = recordedReceipt(entry);
      if (receipt === null || receipt.actionId !== "sleep") continue;
      add(entry.requestId ?? receipt.requestId);
    }
    return requests;
  };
  /**
   * The terminal each of those dispatches minted, in dispatch order, skipping any that is still in flight.
   *
   * The SAME read a flat dispatch gets (`terminalReceiptFor` on the request the dispatch named), applied to the
   * request found in whichever channel carried it.
   */
  const sleepTerminals = () => {
    const terminals = [];
    for (const requestId of sleepRequestsSinceStart()) {
      const terminal = terminalReceiptFor(factLog, requestId);
      if (terminal !== undefined) terminals.push(terminal);
    }
    return terminals;
  };
  /**
   * Each of those dispatches WITH the receipts that carry it, which is what the night's verdict is decided from.
   *
   * Two receipts per dispatch, because they answer different questions: the ACCEPTED one declares what the action
   * was reaching for (`target=own_bed`), and the terminal says what came of it. `judgeUncrossedNight` reads both,
   * so the separation between "she never went to bed" and "she went to bed and the host player did not" is made
   * from the receipts rather than from the reason's spelling.
   */
  const sleepWitnesses = () =>
    sleepRequestsSinceStart().map((requestId) => {
      const accepted = factLog
        .slice(factStart)
        .map(recordedReceipt)
        .find((receipt) => receipt !== null && receipt.requestId === requestId && receipt.state === "accepted");
      return Object.freeze({
        requestId,
        accepted: accepted ?? null,
        terminal: terminalReceiptFor(factLog, requestId) ?? null,
      });
    });
  /** The reason an uncrossed night is reported under, from the receipts above. */
  const uncrossedReason = (byTimeout) => {
    const verdict = judgeUncrossedNight({ witnesses: sleepWitnesses() });
    // The suffix is the harness's own fact - the day turn had not settled - and it is appended to whichever case
    // applies, so a bound this run set is never mistaken for something she did or did not do.
    return byTimeout ? `${verdict.reasonCode}:day_turn_still_running` : verdict.reasonCode;
  };
  /**
   * The night's own CROSSING receipt - a `succeeded/day_advanced` terminal - or null when no dispatch in this window
   * produced one.
   *
   * Only a crossing counts as the night's terminal. A `rejected` `sleep` is a fact about the DISPATCH (the Mod
   * requires an indoor, standing, unheld actor), and handing it back as the night's terminal would make
   * `classifyNight` answer `night_not_advanced` about a night the calendar says was crossed - the opposite of what
   * this record is for. So a refused attempt stays out of `terminal` and the night keeps whatever attribution its
   * other witnesses support.
   */
  const crossingTerminal = () =>
    sleepTerminals().find((entry) => entry.state === "succeeded" && entry.reasonCode === "day_advanced") ?? null;
  /**
   * Has a dispatch appeared that can still become this night?
   *
   * A dispatch alone is not enough, because `sleep` can be REFUSED and a refusal mints a terminal too. Watching
   * a refused night would spend the whole night budget on one nothing started - and the day loop keeps offering turns
   * until the day is crossed, so a later turn may sleep for real. While every dispatch already ended in a
   * non-crossing terminal the wait therefore keeps waiting, which is what it did when the only channel it read was
   * the flat one.
   */
  const nightBegan = () => {
    const requests = sleepRequestsSinceStart();
    if (requests.length === 0) return false;
    if (crossingTerminal() !== null) return true;
    return sleepTerminals().length < requests.length;
  };
  // The hour the farmer actually went to bed, as this watch's own observations say it: the latest `timeOfDay` the
  // engine reported while the PRE-CROSSING day was still current. The night record carries no bed time, so this is
  // where the honesty gate's ground truth comes from - and it is an observation, not a constant: a companion who slept
  // at 22:10 and one the engine passed out at 26:00 are different nights and different tests.
  //
  // A maximum, not the last reading: the game clock only advances within a day, so the latest value seen is the hour
  // the night took the actor even if a later poll during the rollover fade returned the cached projection. A watch that
  // never observed the clock leaves it null, and the gate then says what it is missing instead of guessing.
  let bedTimeBeforeCrossing = null;
  // The hour SHE went to bed, as the engine's clock read it at the first poll that saw her `sleep`.
  //
  // Not the night's maximum: a companion who goes to bed at 22:10 and waits for the host player is still in bed
  // when the clock runs on to 26:00, so the maximum reports the pass-out hour for a night she slept through. The
  // first sighting is the observation this asks for, and it comes from the snapshot the watcher already polls.
  let bedTimeWhenSheCommitted = null;
  const observeQuietly = async () => {
    let snapshot;
    try {
      snapshot = await client.observe();
    } catch {
      // A rollover's fade legitimately refuses an observation for a frame or two; the cached projection is
      // the current truth in that window.
      snapshot = client.state?.snapshot ?? null;
    }
    if (Number.isInteger(startDay) && snapshot?.dayOfMonth === startDay && Number.isInteger(snapshot?.timeOfDay))
      bedTimeBeforeCrossing = Math.max(bedTimeBeforeCrossing ?? 0, snapshot.timeOfDay);
    return snapshot;
  };
  const waitForNightToBegin = async () => {
    let daySettled = false;
    void dayTurnSettled.then(() => {
      daySettled = true;
    });
    const deadline = Date.now() + MULTIDAY_NIGHT_TIMEOUT_MS;
    for (;;) {
      if (bridgeDisconnections.length > 0) {
        // Name what actually happened. A closed pipe before any `sleep` dispatch is the game process going away,
        // not a night we watched: measured 2026-11-06, a `STATUS_STACK_OVERFLOW` crash inside the game surfaced as
        // `night_watched_over_a_dead_bridge:pipe_closed` on a run that had recorded one day and never slept once.
        const disconnection = String(bridgeDisconnections[0]?.reasonCode ?? "unknown");
        return bedTimeWhenSheCommitted === null
          ? `game_process_exited_before_the_night:${disconnection}`
          : `night_watched_over_a_dead_bridge:${disconnection}`;
      }
      // The night BEGINS when the companion dispatches `sleep`, read from EITHER channel. Reading only the
      // flat one made round18's watcher poll a whole night for a dispatch that had already happened at 03:36:26 and
      // notice the night only once the calendar had moved - i.e. once it was over.
      if (bedTimeWhenSheCommitted === null && sleepRequestsSinceStart().length > 0)
        bedTimeWhenSheCommitted = readWorldClock().timeOfDay;
      if (nightBegan()) return null;
      // The engine crossed the night whatever dispatched it (the 02:00 pass-out calls `NewDay` itself), so a moved
      // calendar is also a night under way.
      if (calendarMovedPastStartDay()) return null;
      // A settled day turn is NOT a companion who refused to sleep, and calling it that was the oldest mistake in this
      // watcher. Measured 2026-10-25: the turn settled after 468 s with the world at 15:00 and the companion saying
      // \"太阳落山前要是还不行，我先把碎石和土块收拾利索\" - she intended to keep working, and a turn ends when the model
      // believes its reply is finished, not when the day is. The run then reported `companion_did_not_sleep`, which
      // reads as a judgement about her behaviour and was a fact about the turn boundary.
      //
      // So the settle keeps the watch waiting while the WORLD still has a day to run. It only concludes when the world
      // itself says the day is spent - past the sleep hour with no crossing, or no longer running at all - which
      // is the fact this watcher was always trying to observe.
      //
      // WHAT that spent night means is not decided here: `uncrossedReason` asks `judgeUncrossedNight` to read the
      // night's own receipts, because "she never went to bed", "she went to bed and the host player never did" and
      // "her sleep was refused" are three different findings and this one arm used to publish the first of them
      // for all three. Measured 2026-11-05 (`2026-11-05T11-37-35-764Z-multiday_routine`): `crossings 0 of 2` with
      // one reason code, which read as a judgement about her and said nothing about what the night actually held.
      if (daySettled) {
        const worldClock = readWorldClock();
        if (worldClock.spent) return uncrossedReason(false);
        if (worldClock.unknown) return "day_turn_settled_before_night:clock_unknown";
      }
      // Before the harness's own bound: has the WORLD stopped? A stalled heartbeat is a different finding from
      // "the companion has not slept yet", and it is the one that has silently ended most of the multi-day runs.
      const liveness = sampleModHeartbeat();
      if (liveness.silentMs >= MOD_HEARTBEAT_STALL_MS)
        return `world_stopped_advancing:silent_ms=${String(liveness.silentMs)}:last_heartbeat=${liveness.line}`;
      if (Date.now() >= deadline) return uncrossedReason(true);
      await new Promise((resolve) => setTimeout(resolve, MULTIDAY_POLL_INTERVAL_MS));
    }
  };
  const neverStarted = await waitForNightToBegin();
  if (neverStarted !== null) {
    const verdict = judgeUncrossedNight({ witnesses: sleepWitnesses() });
    return Object.freeze({
      terminal: null,
      after: await observeQuietly(),
      menus: [],
      // A night that never began has no crossing hour to report; the field is published as null rather than omitted,
      // so a reader never has to tell "not observed" apart from "not a field on this shape". When she DID go to bed
      // this is the hour she went, which is the clock the wait is judged against.
      bedTime: bedTimeWhenSheCommitted ?? bedTimeBeforeCrossing,
      reasonCode: neverStarted,
      // WHY that reason, from the receipts the wait was decided on - and only when the reason IS a sleep verdict: a
      // watch that ended on a dead bridge or a stalled world has no finding about her dispatch, and dressing one up
      // would attribute the harness's own stop to her. `multiday.reasonCode` and this record carry one spelling.
      nightVerdict:
        sleepVerdictCase(neverStarted) === null
          ? null
          : Object.freeze({ ...verdict, reasonCode: neverStarted, bedTime: bedTimeWhenSheCommitted }),
    });
  }
  // The day this watch began on - which is NOT the day the world is on once the wait above is over.
  //
  // This used to be re-read HERE, after `waitForNightToBegin` had already returned, and that made "the day before the
  // night" mean "the day after it" on every night the engine took by its own pass-out. Measured 2026-10-28
  // (`round6`): the watch began on spring 5, the 02:00 pass-out crossed to spring 6 at 02:12:43, the wait noticed the
  // moved calendar at 02:12:44 and returned, and `dayBefore` was read as 6 - so the night's own crossing check at the
  // end compared 6 against 6 and could only ever answer "not advanced". `startDay` is the same fact read before the
  // wait, and on a night the companion sleeps it is the identical value the late read produced, so this is the same
  // number wherever the late read was right.
  const dayBefore = Number.isInteger(startDay) ? startDay : (client.state?.snapshot?.dayOfMonth ?? null);
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
        // The code stays closed; the exception's own text travels in `thrown`, where a reader can see it without a
        // consumer of `reasonCode` having to parse it.
        reasonCode: "level_up_not_resolved:dispatch_threw",
        thrown: classifyFailure(error),
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
          reasonCode: `menu_not_dismissed:${menuType}:dispatch_threw`,
          thrown: classifyFailure(error),
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
  // The companion's own `sleep` for THIS night - on whichever channel it was dispatched - and the terminal
  // receipt its lifecycle minted. Read here rather than after the crossing check because it is one of the witnesses
  // that decides the cause, and a cause read from a receipt that has not been looked up yet is the hole the
  // two-valued ternary hid.
  const dispatched = sleepRequestsSinceStart();
  const terminal = crossingTerminal();
  // HOW the night ended, from the witnesses that can answer it. It is a CAUSE on the day's record and never a verdict -
  // the night was watched on to the day the engine opened.
  //
  // THREE values, because `sleep` is a claim only one witness can support. `sleep` is the only thing that starts
  // a `SleepAndAdvanceDayLifecycle`, so `entered_via=native_sleep_prompt` on its receipt is the one proof that the
  // COMPANION crossed the night. Nothing the harness observes can stand in for it - least of all the absence of a
  // pass-out, which is a fact about a 250 ms poll and not about the night.
  //
  // MEASURED 2026-10-30 (`round8`): ZERO `sleep` dispatches in the entire run - attempted, program and flat
  // traces alike - because the companion refused in so many words ("Risky—player may want to do something. Better to
  // not end day on my own."). Both nights reached 26:00 (`game_time=2600`) and the engine ran `NewDay` + `SaveGame.Save()`
  // + "after save, starting spring 6/7 Y1": the 2:00 AM pass-out, on the farmhouse floor and then in the middle of Town.
  // Both were recorded `cause: "sleep"`, which was the false branch of a two-valued ternary and meant only that the
  // watch had not seen the hold. A night the engine takes is not a sleep, and calling it one is not a weak attribution -
  // it is a statement about the companion that no artifact supports.
  //
  // `engine` is the third answer, and it is not `null`: the crossing IS witnessed (the calendar moved) and only the
  // attribution is not. A reader must be able to distrust the attribution without doubting the night.
  // The Mod's own pass-out event, which is the witness the watch loop cannot see.
  //
  // `outcome.passOutObserved` is set only while the watch is still POLLING a hold (`reasonCode === "actor_passed_out"`).
  // A night the engine takes while the watch is waiting for the calendar returns `crossed: true` on the first attempt,
  // so that flag never sets - and the night lands on `cause: "engine"`, which `multiday-baseline` correctly refuses to
  // call a pass and reports as `night_mechanism_unobserved`.
  //
  // Measured 2026-11-03 (`round28`): night 1 was an ordinary 02:00 pass-out (`game_time=2600`, forced NewDay) and the
  // Mod PUBLISHED `night_ended_pass_out` for it (`StardewSalientEventHooks.cs:88`), yet the record said
  // `cause: "engine"` with `passOutNights: 0` - the verdict could not count the very thing it was being blamed for.
  // The night's mechanism was observed; the runner never read the observation.
  const passOutFactThisNight = worldNightEndingsFromFacts(factLog.slice(factStart)).some(
    (ending) => ending.cause === NIGHT_CAUSE_PASS_OUT,
  );
  /**
   * HER OWN LIFECYCLE RECEIPT, whether or not it is the crossing.
   *
   * `crossingTerminal` above keeps only a `succeeded/day_advanced` terminal, because a refusal is not the night's
   * terminal. But a night her own sleep ended can reach the calendar WITHOUT that receipt carrying the crossing, and
   * then the record used to say `cause: "engine"` - "the day moved and nobody saw how" - while the receipt naming
   * `entered_via=native_sleep_prompt` sat in the log. Measured 2026-11-05
   * (`2026-11-05T15-02-34-974Z-multiday_routine`), day 1: `sleep` accepted at 23:14:37 with `target=own_bed`, the
   * lifecycle walked to bed and answered the native Sleep prompt, the day crossed 5 -> 6 at 23:15:49 while it waited
   * for a `day_started` it never observed, and its terminal arrived `blocked/lifecycle_deadline_exceeded` with
   * `entered_via=native_sleep_prompt`. The record said `engine` with `passOutNights: 0`, and the baseline answered
   * `night_mechanism_unobserved` for the one night of the run that ended exactly as intended.
   *
   * The shape is `night-verdict.mjs`'s own (`sleepReceiptOf`): the artifact already publishes her sleep witness that
   * way for a night that never crossed, and this is the same receipt for a night that did.
   */
  const sleepReceipt = (() => {
    const entered = sleepWitnesses().find(
      (witness) => typeof parseReceiptEvidence(witness.terminal?.evidence).entered_via === "string",
    );
    return entered === undefined ? null : sleepReceiptOf(entered);
  })();
  const cause = nightCause({
    enteredVia: parseReceiptEvidence(terminal?.evidence).entered_via ?? null,
    // The night's OWN sleep receipt, read only when it is not the crossing above - which `nightCause` decides from the
    // two values together rather than from either alone.
    sleepEnteredVia: parseReceiptEvidence(sleepReceipt?.evidence).entered_via ?? null,
    passOutObserved: outcome.passOutObserved === true || passOutFactThisNight,
  });
  // Did the night actually pass? The calendar is the witness that no dispatch path can hide, and it is read even
  // when a receipt exists - `classifyNight` cross-checks the two against each other rather than trusting either.
  //
  // `actionTrace` records only FLAT dispatches. Measured 2026-10-28 (`round5`): all 42 of that run's dispatches went
  // through Body Program, so `sleep` - which the Mod DID execute, `dismiss_modal` succeeding at 00:27:59 and
  // SMAPI logging "after save, starting spring 6 Y1" at 00:28:04 - was invisible here. The run was reported as
  // `night_never_started:actor_held_by_cutscene` while the world had in fact rolled over.
  //
  // So the calendar is the fact the watcher was always trying to observe: `dayBefore` is the day this watch began on,
  // and a different `dayOfMonth` afterwards means the engine opened a new day whatever dispatched it. What it cannot
  // say is HOW. That used to cost the night its receipt as well - the crossing branch below fired on EVERY night and
  // returned `terminal: null` - which is why round18's two `native_sleep_prompt` nights were recorded `engine`.
  const afterNight = await observeQuietly();
  const dayAdvanced = (() => {
    const now = afterNight?.dayOfMonth;
    return Number.isInteger(dayBefore) && Number.isInteger(now) && now !== dayBefore;
  })();
  if (dayAdvanced && terminal === null) {
    // The calendar is the crossing's witness here: no `succeeded/day_advanced` receipt arrived in this window on either
    // channel, so `release` says what actually closed the day. `cause` is NOT forced to `engine` - the night's own
    // sleep receipt (read above) is published beside it, and when that receipt exists with
    // `entered_via=native_sleep_prompt` the cause is `sleep_unsettled` rather than an unattributed crossing.
    return Object.freeze({
      terminal: null,
      after: Object.freeze({ ...afterNight, dayBefore }),
      menus: outcome.menus,
      cause,
      release: "calendar_advanced",
      // The hour the night took the actor, as this watch saw the clock. A night the calendar alone witnessed still has
      // an hour: the observations kept coming while the day was current.
      bedTime: bedTimeBeforeCrossing,
      // Her own lifecycle receipt, so the day record can be judged without the process's memory of this watch.
      sleepReceipt,
      reasonCode: null,
    });
  }
  // The night's own terminal, already read above because it is one of the cause's witnesses. A window in which
  // nothing dispatched a `sleep` and no calendar moved held no night to attribute; a dispatch that neither
  // crossed nor produced a terminal keeps the watch's own reason at the bottom instead.
  if (dispatched.length === 0 && terminal === null) {
    // `night_never_started:` stays the prefix because that IS the finding - no `sleep` ever started a night. The
    // suffix is the watch's own reason, and since `rollover_menu_deadlock` exists it says WHICH kind of night never
    // started: one nothing was closing, or one that was merely slow. Flattening the two back into one word here would
    // throw away the distinction the loop just took the trouble to observe.
    return Object.freeze({
      terminal: null,
      after: afterNight,
      menus: outcome.menus,
      cause: null,
      bedTime: bedTimeBeforeCrossing,
      sleepReceipt,
      reasonCode: `night_never_started:${String(outcome.reasonCode ?? "companion_did_not_sleep")}`,
    });
  }
  return Object.freeze({
    terminal,
    after: await observeQuietly(),
    menus: outcome.menus,
    cause,
    bedTime: bedTimeBeforeCrossing,
    sleepReceipt,
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
// The run's record, declared where the run's record begins instead of where each field first happens to be needed.
//
// The failure dump reads exactly these bindings, and a binding declared further down is a ReferenceError for a run that
// threw above it — a dump that throws leaves nothing behind, which is how a failed run's evidence was lost (measured
// 2026-10-22 on `g149tool`: 184 s of real work and no consumable result). Everything here is either a container the run
// fills or an outcome a later stage assigns; none of it is derived, so declaring it early changes no behaviour, and a
// throw after this point can always describe what the run had done.
//
// Trace every ordinary-action execution request the Agent sends so a
// rejected coordinate is attributable to the actual submitted args. A thrown
// rejection (stale_snapshot, replay rejection, bridge_rejected:*) never returns
// a receipt, so the catch records the rejection instead of skipping the entry —
// otherwise the run's own health report sees zero rejections while the session
// shows real ones.
const actionTrace = [];
// Every submission, kept as its own record: a program id alone says a program EXISTS, not that anything ran
// through it. Measured 2026-10-20 by an audit of the Pi session logs: one run submitted ten programs and executed
// zero actions through them while still making 883 individual tool calls - and the run's own result could not say
// so, because a submission left no trace in it. A path that ships and does nothing is worse than an absent one.
const programSubmissions = [];
/** The per-program execution records, filled at assembly time so every result path publishes the same answer. */
let programOutcomes = Object.freeze([]);
// Filled before teardown, so the builder publishes what the programs did rather than when the harness asked.
let programOutcomesAtTeardown = null;
// How many submissions existed when the journal was read. A program submitted later did not fail to be observed -
// it arrived after the harness looked, and that is a different fact from "the Mod did not know it".
let programOutcomesReadAtSubmissionCount = null;
// Where and when the run stood, and the two facts a later stage assigns (the runtime root it materialized and the
// capture directory it opened): null until then, so a failure at either step still publishes what came before it.
// The covenant planted for `memory_covenant`, the agent turn's own terminal facts, the multi-day record, the
// narrative judgement and this run's own session record: each is assigned by a later stage and each is published by a
// failed run too.
let covenantSeed = null;
let agentTurnResult = null;
let voiceResult = null;
let multidayOutcome = null;
let historianRubricOutcome = null;
let runSessionRecord = Object.freeze({
  path: undefined,
  reason: "session_record_binding_not_established",
  searched: Object.freeze([]),
});
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
/**
 * The program lineage a receipt ACTUALLY carries, or null when it carries none.
 *
 * This is the conditional half of the attach. The Mod mints the program binding internally and its receipts do not yet
 * name the program, so this is EMPTY today by construction. It must never synthesise a programId: a lineage the runner
 * invented would make every execution look attributed and hide the very gap the per-program counts exist to expose. The
 * only two accepted shapes are the receipt's own `programId`/`nodeId` fields and a `program_id=`/`node_id=` marker in
 * `evidence.detail`; a receipt with neither stays unattributed, not guessed.
 */
function traceLineage(receipt) {
  if (receipt === null || typeof receipt !== "object") return null;
  let programId = typeof receipt.programId === "string" && receipt.programId.length > 0 ? receipt.programId : null;
  let nodeId = typeof receipt.nodeId === "string" && receipt.nodeId.length > 0 ? receipt.nodeId : null;
  const detail = typeof receipt.evidence?.detail === "string" ? receipt.evidence.detail : "";
  for (const pair of detail.split(";")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (key === "program_id" && programId === null && value.length > 0) programId = value;
    if (key === "node_id" && nodeId === null && value.length > 0) nodeId = value;
  }
  const lineage = {};
  if (programId !== null) lineage.programId = programId;
  if (nodeId !== null) lineage.nodeId = nodeId;
  return Object.keys(lineage).length === 0 ? null : Object.freeze(lineage);
}
const originalExecute = client.execute.bind(client);
client.execute = async (request) => {
  const clock = dispatchClock();
  // STAMPED BEFORE THE CALL, which is what the field name always claimed and what it did not do: the timestamp used
  // to be taken after the receipt returned, so "the gap between two actions" silently contained the next action's
  // execution. A review of this metric could not separate "the game is slow" from "the agent is slow" because the
  // data had only one number, and that number meant neither of the two things it was read as.
  const dispatchedAtMs = Date.now();
  // The same boundary the ledger needs, stamped where the run already measures its own dispatch. Without this the
  // ledger saw thirteen receipts and two dispatches, so the wait it could compute covered two of thirteen actions.
  ledger.record("world.dispatch", { via: "flat", action: request?.action ?? null });
  // Recorded here because this IS the moment a replay has to return to: the world as the actor saw it right
  // before it acted. After teardown the bridge has cleared its state, so this is the only chance.
  rememberObservation();

  try {
    const receipt = await originalExecute(request);
    rememberPose(receipt?.observation);
    const entry = {
      // How this execution was dispatched. A flat frame is the runner's own request; a program node has no frame and is
      // recorded in `programTrace.jsonl` (execution-trace.mjs), so a filter on this field separates the two.
      via: FLAT_EXECUTION_VIA,
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
      // Present ONLY when the receipt itself carries the lineage: a receipt with none stays unattributed rather than
      // claimed, so a program's dispatches cannot be padded with executions nobody attributed to it.
      ...(traceLineage(receipt) ?? {}),
    };
    actionTrace.push(entry);
    console.error("AGENT_EXECUTE", JSON.stringify(entry));
    return receipt;
  } catch (error) {
    const reasonCode = String(error?.message ?? error).replace(/^bridge_rejected:/, "");
    const entry = {
      via: FLAT_EXECUTION_VIA,
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
// Every submission and the per-program records: declared with the run's record above `actionTrace`.
/** Page size for the journal read: the wire caps an events page at 32 (validateBodyProgramEventsResult). */
const PROGRAM_EVENTS_PAGE_SIZE = 32;
/**
 * One submission's execution record, read from the Mod's own journal.
 *
 * `accepted` is an ingress fact and only an ingress fact: eight of ten audited runs published accepted batches and no
 * artifact could say whether a node ran. `dispatched` is the count of the Mod's own `native_dispatch` events - exactly
 * "the executions the program produced" - and `executions` is those same events as rows, so each execution has a place
 * in the run's trace (`programTrace.jsonl`, execution-trace.mjs) instead of existing only as a number. `nodeOutcomes`
 * are the per-node outcomes: the state the Mod reports, the action the Host submitted for that node, the Mod's own
 * reason when it recorded one, and the tile when the node names one (`program-node-outcomes.mjs`), so a program that
 * lost thirty-one nodes to recovery is a set of researchable rows rather than a number. A journal query that fails is
 * `observed: false` with `dispatched: null`,
 * NEVER `dispatched: 0`: an unobserved program and a program that dispatched nothing are different facts and collapsing
 * them would turn a read failure into a measured zero. A `programId` the Mod never minted (a rejected submit) reads
 * `not_found` and is likewise `observed: false`, with `accepted: false` saying why.
 *
 * The bridge is the PRIMARY source and stays so: it is the Mod's answer for the run that is happening, and a bridge that
 * answers - even `not_found` - is never second-guessed by a file. But the bridge is also the evidence that disappears
 * first: measured 2026-10-27, the game exited during a `pickup_item` dispatch, every status query threw
 * `bridge_not_authenticated`, and six accepted programs whose work was already durable were published as
 * `observed: 0 of 6` - a run that did real work scored as a run that did nothing. So a bridge read that THROWS falls
 * back to the Mod's own durable journal (`stardew-body-program-journal.mjs`), and every record says which source
 * answered: `source: "bridge"` or `source: "journal"`. The two are not the same strength of evidence and a reader must
 * be able to tell them apart. A journal that proves nothing about the program leaves the record exactly as it was.
 */
async function readProgramOutcomes({ submissions, statusQuery, eventsQuery, journal = null }) {
  const records = [];
  for (const submission of submissions) {
    const programId = typeof submission?.programId === "string" ? submission.programId : null;
    const accepted = submission?.accepted === true;
    // One shape per REASON, because the reasons are not the same fact. `dispatched: null` keeps meaning "not
    // measured" and never zero, and `observation` says which of the three happened - so a reader does not have to
    // search the Mod log by hand to find out. Measured 2026-10-25: eleven accepted-but-unobserved programs, and
    // the only way to argue about any of them was exactly that.
    const unobserved = (observation) =>
      Object.freeze({
        programId,
        accepted,
        observed: false,
        observation,
        dispatched: null,
        executions: [],
        nodeOutcomes: [],
      });
    if (programId === null) {
      records.push(unobserved("no_program_id"));
      continue;
    }
    try {
      const status = await statusQuery(programId);
      if (status?.code !== "found" || status.snapshot === null) {
        records.push(unobserved(accepted ? "accepted_but_unknown_to_mod" : "rejected_by_mod"));
        continue;
      }
      const events = [];
      let cursor = 0;
      // The wire caps a page at 32 and a found page advances the cursor; an empty or non-advancing page ends the read.
      for (let page = 0; page < 128; page += 1) {
        const result = await eventsQuery(programId, cursor);
        if (result?.code !== "found") break;
        const batch = Array.isArray(result.events) ? result.events : [];
        events.push(...batch);
        if (batch.length === 0 || result.nextCursor <= cursor) break;
        cursor = result.nextCursor;
      }
      // The journal's own identity for each execution: `cursor` is the event's page position, so the same event read on
      // two pages is one execution, while a retried node is a new `nodeAttempt` and therefore a second one. The same
      // derivation the durable-journal fallback uses, so a bridge read and a post-restart file read agree about both the
      // execution's identity and its two moments (`atMs` dispatched, `settledAtMs` settled).
      const executions = executionsFromJournalEvents(events);
      records.push(
        Object.freeze({
          programId,
          accepted,
          observed: true,
          source: "bridge",
          dispatched: executions.length,
          executions: Object.freeze(executions),
          nodeOutcomes: programNodeOutcomes(submission?.nodes ?? [], status.snapshot.nodes ?? []),
        }),
      );
    } catch (error) {
      const reason = `read_failed:${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`;
      // The bridge is gone; the Mod's own durable journal may still prove what this program did. Only a program the
      // journal actually holds is answered from it - absence is not a zero, and `dispatched: null` stays null.
      const fromJournal = journal === null ? null : journal.outcomeFor(programId);
      if (fromJournal === null) {
        records.push(unobserved(reason));
        continue;
      }
      records.push(
        Object.freeze({
          programId,
          accepted,
          observed: true,
          source: "journal",
          // The bridge failure that forced this read travels with the record, so a reader knows why the weaker
          // source answered instead of having to search the Mod log for it.
          observation: reason,
          dispatched: fromJournal.dispatched,
          executions: fromJournal.executions,
          nodeOutcomes: programNodeOutcomes(submission?.nodes ?? [], fromJournal.journalNodes),
        }),
      );
    }
  }
  return Object.freeze(records);
}

/**
 * The Mod's durable Body Program journal for THIS run's scope, read only if the bridge stops answering.
 *
 * Derived from the same ids the Mod config declares and the documented Stardew data root - the folder that contains
 * `Saves` - because that is the exact path `WindowsBodyProgramJournalStore` writes.
 */
const bodyProgramJournal = createBodyProgramJournalFallback({ dataPath: stardewDataPath(), scope });

/** Reads the journal for every submission over the live bridge, falling back to the durable journal. Once per run. */
async function sampleProgramOutcomes() {
  return readProgramOutcomes({
    submissions: programSubmissions,
    statusQuery: (programId) => client.programStatus({ programId }),
    eventsQuery: (programId, cursor) => client.programEvents({ programId, cursor, pageSize: PROGRAM_EVENTS_PAGE_SIZE }),
    journal: bodyProgramJournal,
  });
}
const originalProgramSubmit = client.programSubmit.bind(client);
client.programSubmit = async (program) => {
  // The Agent chooses the id autonomously, so a fixed probe can never observe it: the request's own id is the one the
  // bridge validates the answer against (`local-stardew-bridge.ts`, `snapshot.programId !== request.programId`).
  const programId = program?.programId ?? null;
  // Stamped BEFORE the await: the wait the ledger measures is the Mod's, not the transport's.
  ledger.record("world.dispatch", { via: "program", programId });
  const submit = await originalProgramSubmit(program);
  programSubmissions.push(
    Object.freeze({
      programId,
      code: submit?.code ?? null,
      // `accepted` means the Mod took it; nothing here claims a node ran.
      accepted: submit?.code === "accepted",
      // The nodes as they were SUBMITTED, with the action and the arguments each one names. This is the only record of
      // that join: the journal's `native_dispatch` event carries program/node/attempt/cursor and no action id, and the
      // Mod's node rows carry the state and the reason but never the action, so `(programId, nodeId)` against these
      // entries is how a program execution is attributed to an action. The `arguments` are here for the same reason: a
      // tile (`x`/`y`) is what makes "node 3 failed at 61,18" sayable, and the Host's own compiled arguments are the
      // only place it exists (`planNodeTile`). Without this a run whose work all went through programs reports that it
      // did nothing, and a node that needed recovery cannot be found.
      nodes: Object.freeze(
        (program?.nodes ?? []).map((node) =>
          Object.freeze({
            nodeId: node?.nodeId ?? null,
            actionId: node?.actionId ?? null,
            arguments: node?.arguments ?? {},
          }),
        ),
      ),
    }),
  );
  console.error("AGENT_PROGRAM_SUBMIT", JSON.stringify({ programId, code: submit?.code }));
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
runtimeRoot = usesDisposableRoot ? join(root, "runtime") : root;
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
// FILL A GAP, never overwrite an operator's choice - and `providerId` is a gap the old filler could not see.
//
// This used to write the file only when it was ABSENT, and the file it wrote carried `modelId` with no `providerId`.
// `resolveSurfaceModelSelection` uses a surface's own provider/model only when BOTH are present (model-selection.ts:81),
// so that file fell through to the product's active connection, which a disposable root does not have - `no_model`,
// `modelConfig: undefined`, and then `gameplay_subagent_requires_model_and_integration` with nothing naming a model.
//
// A root that ALREADY has both is left byte-for-byte alone: that is the operator's choice, and the comment above has
// always promised not to touch it. A root written by the OLD filler has a `modelId` and no provider, which is exactly
// the gap this closes.
const existingProfile = await readFile(modelProfilePath, "utf8").then(
  (text) => JSON.parse(text),
  () => null,
);
const PROVIDER = OPERATOR_GATEWAY_PROVIDER_ID;
const MODEL = "deepseek-v4.1-flash";
const needsProvider = (surface) =>
  existingProfile === null ||
  existingProfile[surface]?.providerId === undefined ||
  existingProfile[surface]?.modelId === undefined;
if (needsProvider("chat") || needsProvider("game"))
  await writeFile(
    modelProfilePath,
    JSON.stringify({
      schemaVersion: 1,
      // The provider is the same `cpa-oai` the credential above is filed under in `auth.json`, so the pair cannot
      // disagree. `thinkingLevel` is preserved from a profile that already had one.
      chat: {
        revision: existingProfile?.chat?.revision ?? 0,
        providerId: existingProfile?.chat?.providerId ?? PROVIDER,
        modelId: existingProfile?.chat?.modelId ?? MODEL,
        thinkingLevel: existingProfile?.chat?.thinkingLevel ?? "low",
      },
      game: {
        revision: existingProfile?.game?.revision ?? 0,
        providerId: existingProfile?.game?.providerId ?? PROVIDER,
        modelId: existingProfile?.game?.modelId ?? MODEL,
        thinkingLevel: existingProfile?.game?.thinkingLevel ?? "low",
      },
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
  JSON.stringify({ [OPERATOR_GATEWAY_PROVIDER_ID]: { type: "api_key", key: process.env.CPA_OAI_API_KEY } }),
  "utf8",
);
// Readiness, asked before any runtime exists to be built: a root that has run before already carries the provider
// catalog and the credential its runtime wrote, so a profile naming a model that catalog does not list - or a provider
// that cannot answer - is refused here, by name, with no session behind it. A disposable root has no catalog until its
// runtime writes one, so that case asks the same probe right after materialization (see below).
if (existsSync(join(runtimePaths.agentDir, "models.json"))) {
  providerReadiness = await probeProviderReadiness({ runtimeRoot, agentDir: runtimePaths.agentDir });
  if (!providerReadiness.ok) throw new Error(providerReadinessRefusal(providerReadiness));
  markPhase("providerReadyMs");
}
// Capture the run's evidence into a dedicated local directory (git-ignored).
// The summary lands in the result JSON so a failed capture is visible, never
// silent — a capture that broke would recreate exactly the blind spot this
// mechanism exists to remove.
capture = await openLiveRunCapture({ kind: "game-ladder", label: SCENARIO, root: LIVE_RUN_ROOT });
// One Game activation id for this run: it is the surface session id the runtime
// uses for its durable run manifest, so the context-evidence read below resolves
// the same file the runtime wrote.
gameSessionId = `game-${Date.now()}`;
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
if (SCENARIO === "memory_covenant" && !usesDisposableRoot) {
  const seeded = await seedMemoriesViaManagementSurface({
    root,
    deploymentManifestPath: manifestPath,
    seeds: ["之前商量好的：农场里的草莓一颗都不能卖掉，全都留着酿果酒。"],
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
      seeds: ["之前商量好的：农场里的草莓一颗都不能卖掉，全都留着酿果酒。"],
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
    `:heartbeat_source=${String(liveness.source ?? "none")}` +
    `:game_responding=${String(game.responding)}:game_cpu_s=${String(Math.round(game.cpuSeconds ?? -1))}` +
    (game.note === null ? "" : `:game_probe=${String(game.note)}`) +
    `:game_threads=${threads}`;
}, 5_000);
stallSampler.unref?.();
// THIS run's own session record - its path, or the reason it could not be bound. The binding is established below,
// from this run's own surface session directory, and until then it is unbound rather than "the newest file we could
// find"; the declaration itself sits with the run's record so the failure dump reads it instead of a ReferenceError.
runSessionRecord = Object.freeze({
  path: undefined,
  reason: "session_record_binding_not_established",
  searched: Object.freeze([]),
});
try {
  runtime = await binding.executeWithBinding((bindingToken) =>
    withConsumedBindingExecution(bindingToken, (execution) => {
      const permit = Object.freeze({
        principal: execution.principal,
        operationId: `op-${Date.now()}`,
        requestId: `req-${Date.now()}`,
        kind: "enter",
        gameSessionId: gameSessionId ?? "unassembled",
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
  // A disposable root's catalog arrives with its runtime, so readiness is asked here instead - still before the first
  // turn, and a provider that cannot answer costs one probe instead of the turn's whole budget.
  if (providerReadiness === null) {
    providerReadiness = await probeProviderReadiness({ runtimeRoot, agentDir: runtimePaths.agentDir });
    if (!providerReadiness.ok) throw new Error(providerReadinessRefusal(providerReadiness));
    markPhase("providerReadyMs");
  }
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
  // Whether the in-game DAY is spent, answered by the engine and never by a turn boundary.
  //
  // Two facts make it true: the clock is past the sleep hour, or `sleep` settled - the only thing that actually
  // crosses a night. An unreadable clock is NOT spent: "we could not tell" is not "the day is over".
  // Whether the in-game DAY is spent, answered by the engine and never by a turn boundary.
  //
  // readWorldClock is the one place that decides what the world clock is, so this asks it rather than repeating it.
  // An unreadable clock is NOT spent: "we could not tell" is not "the day is over".
  // Whether the NIGHT has been crossed — asked about THIS DAY, not about the run.
  //
  // Reaching 22:00 is not it (measured 2026-10-26: a turn ended at 22:00 announcing "Time to sleep ... let me
  // sleep" and the loop stopped a round short). Nor is a dispatch from an EARLIER day: `actionTrace` holds
  // the whole run, so the previous predicate answered "already crossed" on day 2 before it had done anything —
  // which is why `nextDayAccomplishedActionIds` came back empty and the baseline named
  // `next_day_produced_no_farm_work`. Nor is a fresh 06:00 (the multi-day fixture resets the clock to 600 every
  // morning, and an absolute `<= 620` read that as a rollover).
  //
  // The rule now lives in `multiday-day-scope.mjs`, scoped by a value captured when the day starts, and it is
  // falsified there against this exact shape.
  const nightCrossedIn = (scope) => {
    const clock = readWorldClock();
    return nightCrossedInScope({
      scope,
      trace: actionTrace,
      clock,
      dayOfMonth: client.state?.snapshot?.dayOfMonth ?? null,
    });
  };
  // Which task this run's days rotate through. Derived from the runs already on disk rather than stored, so
  // the rotation cannot drift from the artifacts that record what actually happened.
  const dailyRunOffset =
    SCENARIO === "multiday_routine"
      ? runOffsetFor(
          countPriorMultidayRuns(
            join(fileURLToPath(new URL("../../..", import.meta.url)), ".live-runs", "game-ladder"),
          ),
        )
      : 0;
  // One run sometimes has to see a task from day one rather than on the day the rotation reaches it.
  // `GAMEBUDDY_FIRST_DAY_TASK` names it; every later day keeps the rotation, so the override cannot
  // silently change what a series of runs covers.
  const firstDayTask = overriddenFirstDayTask(process.env.GAMEBUDDY_FIRST_DAY_TASK);
  // A task pinned to a named day, for the capabilities whose own day a three-day run cannot otherwise reach. The pin is
  // checked against the rotation by the reader, so an unknown id fails the launch instead of measuring another task.
  const pinnedTaskForDay = overriddenTaskForDay(process.env.GAMEBUDDY_TASK_FOR_DAY);
  // Which task a day was ASKED for. Named once, because two readers need the same answer: the prompt that states the
  // task, and the criterion that decides whether it was accomplished. Two call sites would let the run be judged
  // against a task it was never asked to do.
  const taskForDay = (day) =>
    pinnedTaskForDay?.(day) ??
    (day === 1 && firstDayTask !== undefined ? firstDayTask : dailyTaskFor(dailyRunOffset, day));
  const promptForDay = (day) => {
    const entry = SCENARIO_PROMPTS[SCENARIO][localeKey];
    if (typeof entry !== "function") return entry;
    if (SCENARIO !== "multiday_routine") return entry(day);
    return entry(day, taskForDay(day));
  };

  // What the harness says when it offers the same day again. Deliberately carries no instruction: anything
  // stronger ("do not stop until you sleep") would ask the model to opt into a structural guarantee, which is the
  // mistake this change undoes.
  const promptForDayContinuation = (day) =>
    localeKey === "zh"
      ? `（第 ${String(day)} 天还在继续。接着做。）`
      : `(Day ${String(day)} is still going. Carry on.)`;
  // Offered when the world clock says this day's work hours are over but the night has NOT been crossed.
  // Measured 2026-10-26: a turn ended at 22:00 with the companion saying "Time to sleep ... let me observe first
  // then sleep"; the next turn it was given was the generic "carry on", which reads as "keep farming".
  // The harness still takes no decision: it states the clock and the one action that ends a day, and leaves
  // whether to take it to the companion.
  const promptForLateDay = (day) =>
    localeKey === "zh"
      ? `（第 ${String(day)} 天，天已经黑了。该收工就收工：想睡就回床上躺下，这一天才算过去；还想接着干也行。）`
      : `(Day ${String(day)}, and it is late - the sky is dark. If you are done, go to bed and sleep and the day ends; if you want to keep working, that is yours to choose.)`;
  /**
   * What the harness says when the Host says her body has stopped making progress.
   *
   * A FACT and no instruction: which execution, how long it has been silent, what it last said, and what would release
   * it. Whether to stop it, resume it or work around it is hers, which is the same division of labour every other
   * prompt here keeps - the harness is the one that noticed, not the one that decides.
   */
  const promptForStall = (stall) => {
    const executionId = String(stall?.executionId ?? "an execution");
    const silentSeconds = String(Math.round((stall?.elapsedMs ?? 0) / 1000));
    const lastFact = String(stall?.lastFactKind ?? "unknown");
    const owner = typeof stall?.owner === "string" && stall.owner.length > 0 ? stall.owner : null;
    return localeKey === "zh"
      ? `（${executionId} 已经 ${silentSeconds} 秒没有任何进展，最后一条事实是 ${lastFact}${owner === null ? "" : `，身体被 ${owner} 占着`}。接下来怎么办由你决定。）`
      : `(${executionId} has made no progress for ${silentSeconds}s; its last fact was ${lastFact}${owner === null ? "" : `, and the body is held by ${owner}`}. What happens next is yours to decide.)`;
  };
  /**
   * What the harness says when the Host says the world she is being handed is older than its bound.
   *
   * A FACT and one move, no instruction: the revision it is stuck on, how many turns and seconds old it is, and that
   * looking is what replaces it. Whether to look now, or to finish what she is doing first, stays hers - the same
   * division of labour `promptForStall` keeps.
   */
  const promptForStaleWorld = (stale) => {
    const turns = String(stale?.turns ?? "?");
    const revision = String(stale?.revision ?? "?");
    const seconds = String(Math.round((stale?.ageMs ?? 0) / 1000));
    return localeKey === "zh"
      ? `（你手上的世界还停在 revision ${revision}，已经 ${turns} 轮、${seconds} 秒没有重新看过了 - 这段时间里世界变了不少。先看一眼现在的世界，再决定接下来的事。）`
      : `(The world you are holding is still revision ${revision}, ${turns} turns and ${seconds}s since it was last observed - the world has moved on. Look at the world as it is now before deciding what comes next.)`;
  };
  /**
   * The day's prompt with the world's own shortage fact appended, or the prompt alone - the composition lives in
   * `seed-shortage.mjs` so its once-per-day property is testable rather than asserted here.
   *
   * A FACT, not an instruction: it states the task's tile count, the seeds she holds, the shortfall, and where the
   * missing seed is sold with the shop's own hours - and stops. Whether to walk to town is hers, because her deciding
   * her own day is the property the character card grants her. The defect this answers was not a missing order but a
   * missing fact: measured 2026-11-09, two seed stacks against a sixty-tile strip, four tiles planted, "种子就这些了，想
   * 铺满二十格还得再买种" - and asked afterwards, "没有想过买种子".
   *
   * ONCE PER DAY, on the first turn. The shortage does not move while the supply does (a shop closes at 18:00), and a
   * fact repeated every turn would become the instruction by repetition that this deliberately is not.
   */
  const withDayFact = (prompt, fact) => dayPromptWithFact(prompt, fact, localeKey);
  let status = null;
  // The promise the CURRENT day's turn settles on. The night watcher waits on it so "the night has not begun"
  // and "the companion will not sleep" are different answers instead of one timeout.
  let dayTurnSettled = Promise.resolve();
  // Set when a day's scope had to be captured before the world finished arriving - published rather than swallowed,
  // because a scope captured mid-transition is exactly the shape that produced round40's `crossings 0 of 2`.
  let dayScopeCaptureProblem = null;
  /**
   * Wait for the world to say it is ready for a day, bounded.
   *
   * A new day arrives in pieces: the calendar moves first, then the fade, then the actor becomes actionable. A day
   * scope captured in the middle is a statement about two different worlds, and `nightCrossedInScope` then answers
   * "the night is over" for a day that has not begun - measured 2026-11-09 on round40.
   */
  const waitForSettledWorld = async ({ timeoutMs = 30_000, pollMs = 250 } = {}) => {
    const startedAt = Date.now();
    for (;;) {
      const snapshot = client.state?.snapshot ?? null;
      if (snapshot?.actionable === true && snapshot?.activeExecution == null && Number.isInteger(snapshot?.dayOfMonth))
        return { settled: true, waitedMs: Date.now() - startedAt };
      if (Date.now() - startedAt >= timeoutMs) return { settled: false, waitedMs: Date.now() - startedAt };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  if (SCENARIO === "multiday_routine") {
    // Lane G0: the companion runs consecutive days and ends each one itself. The loop's `dayTurn` is an
    // ordinary agent turn; its `nightWatch` is the rollover observer, because the companion is blocked inside
    // `sleep` at exactly the moment the settlement menu is raised.
    //
    // HOW each night ended, by the day it ended. The loop owns the record shape, and `onDay` is the hook it offers at
    // exactly the moment the record is published - after BOTH callbacks resolve, so this day's night watch has
    // already answered. The record therefore says whether the ENGINE ended the night (the 2:00 AM pass-out) or the
    // companion's own sleep, which is a cause and never a reason to stop: a pass-out starts the next day itself.
    //
    // The observation itself is kept in `nightRecordsByDay`, which is also what the honesty gate reads: one record per
    // night, so the artifact and the gate cannot describe the same night differently.
    // The baseline for the refusal sample, taken BEFORE the first turn: lines already in this lane's log belong to an
    // earlier run, and counting them would let an old refusal answer a question about "just now".
    sampleRefusalEvidence();
    const crossing = await runMultiDayLoop({
      crossNights: MULTIDAY_CROSSINGS,
      dayTurn: async (day) => {
        // The day's work starts HERE, and both windows this turn needs are opened at the same moment: the day scope
        // asks the trace where it began, and the accomplishment counter asks the FACT LOG where it began - the log is
        // where a terminal receipt lands, whichever channel dispatched it.
        const factsBefore = factLog.length;
        // The night watcher waits for THIS promise to settle before deciding the companion chose not to sleep,
        // so it can tell "the night has not started" from "there will be no night".
        const settled = deferred();
        dayTurnSettled = settled.promise;
        try {
          // A day contains turns, not one turn. The loop asks the ENGINE whether the day is spent - never the turn
          // boundary - and keeps offering turns while the clock still has day left in it. It does not end a turn for the
          // companion, and it never tells it to sleep: the companion's own dispatch of `sleep` is the only thing that
          // crosses the night, which is the behaviour this scenario exists to observe.
          let turns = 0;
          // THE DAY SCOPE IS CAPTURED FROM A WORLD THAT HAS FINISHED ARRIVING.
          //
          // Measured 2026-11-09 (round40): day 1's scope was taken while the new-day transition was still in flight, so
          // `dayOfMonth` was one day stale; `nightCrossedInScope` compares the captured day to the world's day with
          // `!==`, so the correct value that arrived two seconds later read as "this day's night is already over". The
          // loop then ran ZERO turns for day 2, its night watcher sampled the same fade and answered
          // `actor_held_by_cutscene`, and a run that had crossed its first night stopped with `crossings 0 of 2`.
          //
          // Waiting for the world to be actionable is what makes the scope a fact about the day she wakes up in rather
          // than about the frame the previous day ended on. It is bounded, and a world that never settles is named.
          const settledWorld = await waitForSettledWorld();
          if (!settledWorld.settled) {
            dayScopeCaptureProblem = `day_scope_captured_while_transitioning:waited_ms=${String(settledWorld.waitedMs)}`;
          }
          const dayScope = dayScopeFrom({
            clock: readWorldClock(),
            dayOfMonth: client.state?.snapshot?.dayOfMonth ?? null,
            traceIndex: actionTrace.length,
          });
          // WHICH TASK THIS DAY WAS ASKED FOR, named once: the wake decision asks whether its purpose is achieved, and
          // the day's own verdict asks the same question of the same task. Two calls would let the run be woken for a
          // task it was not asked to do.
          const dayTask = taskForDay(day);
          // Whether this day's day-end offer has been made. ONE per day: an offer repeated until answered is the ping
          // this change exists to remove.
          let dayEndOffered = false;
          while (!nightCrossedIn(dayScope)) {
            const clock = readWorldClock();
            // Whether the model is woken at all is decided BEFORE anything is asked of her, from facts and never from
            // the fact that a turn just settled. A settlement only says that what the harness was waiting for stopped;
            // the facts below say whether that stop left her anything to decide.
            const body = bodyWorkNow();
            const stallFacts = newStallFacts();
            const wake = decideDayWake({
              turnIndex: turns,
              objectiveMet: judgeTaskPurpose(dayTask, receiptsSince(factsBefore)).state === "achieved",
              programRunning: body.programRunning,
              admissionPending: body.admissionPending,
              quietMs: quietMsNow(),
              lateDay: clock.unknown === false && clock.minutes !== null && clock.minutes >= LATE_DAY_MINUTES,
              dayEndOffered,
              stalled: stallFacts.length > 0,
            });
            if (wake.wake !== true) {
              // The Mod's own pass continues, or nothing has moved for long enough to call it stopped. Either way the
              // next move is not hers yet, so the harness waits and asks again rather than paying a model turn to find
              // out that it had nothing to say.
              recordWakeSuppression(wake.reason);
              await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
              continue;
            }
            turns += 1;
            recordWake(wake.reason);
            if (wake.reason === WAKE_REASON.dayEndOffer) dayEndOffered = true;
            // The day's shortage fact, read from the world as it stands at the FIRST turn of the day: what the task
            // asks for, what she holds, and where the missing seed is sold. Null when there is nothing to say (the task
            // declares no patch, or the pack already covers it), and then the prompt is untouched.
            const dayFact =
              turns === 1
                ? seedShortageFact({
                    taskId: taskForDay(day),
                    snapshot: client.state?.snapshot ?? null,
                    locale: localeKey,
                  })
                : null;
            if (dayFact !== null) seedFacts.push(Object.freeze({ day, ...dayFact }));
            const prompt =
              turns === 1
                ? withDayFact(promptForDay(day), dayFact)
                : wake.reason === WAKE_REASON.dayEndOffer
                  ? promptForLateDay(day)
                  : wake.reason === WAKE_REASON.stallWake
                    ? promptForStall(stallFacts.at(-1) ?? null)
                    : wake.reason === WAKE_REASON.staleWorld
                      ? promptForStaleWorld(staleFacts.at(-1) ?? null)
                      : clock.unknown === false && clock.minutes !== null && clock.minutes >= LATE_DAY_MINUTES
                        ? promptForLateDay(day)
                        : promptForDayContinuation(day);
            const spokenBefore = presentationPieces.length;
            const walked = await runAgentTurn(prompt, tools, { reason: wake.reason });
            if (walked.status !== null) status = walked.status;
            agentTurnResult = walked.turn;
            // What THIS turn said, sliced by index so a line cannot be attributed to another turn.
            const spokenThisTurn = presentationPieces
              .slice(spokenBefore)
              .map((piece) => (typeof piece === "string" ? piece : (piece?.text ?? "")).trim())
              .filter((text) => text.length > 0);
            sessionTurns.push(
              Object.freeze({
                goalIndex: day - 1,
                goal: promptForDay(day),
                turn: walked.turn,
                day,
                // The turn's lines, kept APART: joining them was how a turn of fifteen short bubbles became one
                // 120-code-point "utterance" the gate then failed.
                spokenLines: Object.freeze(spokenThisTurn),
              }),
            );
            // A turn that never settled will not settle differently for the next one; the reason is already recorded.
            //
            // `settled` lives on the TURN, not on the `{ turn, status }` envelope `runAgentTurn` returns. Read the
            // envelope's own field and the test is `undefined !== true`: every day broke after its first turn, which
            // is what made day 2 look idle (`next_day_produced_no_farm_work`) and left the scheduled player lines
            // unreachable (`no_reply_recorded` on all four). One accessor, so the shape is asserted in one place.
            if (!turnSettled(walked)) break;
            // The player drops in - and this must NOT wait for the turn to end.
            //
            // Written the other way first, and it never fired: `round28` ran seventeen minutes with 119 assistant
            // messages and 17 fact batches, and all four gate prompts appear ZERO times in its session - because the
            // gate was submitted after `await runAgentTurn(...)`, and that call does not return until the turn settles.
            // A turn lasting the whole day therefore silences the player for the whole day, which is the very
            // complaint the gates exist to answer.
            //
            // Player text already has the right transport: `acceptPlayerInput` hands it to the pump, the pump's
            // disposition is `steer` whenever a batch carries player input, and `steer` enters after the current
            // assistant turn and its tool calls without pre-empting a token stream. So the only thing needed is to
            // submit it WHILE the turn runs and read the reply afterwards, instead of sequencing it behind the turn.
            //
            // Scheduled by DAY rather than by game clock: the runner cannot pre-empt a turn mid-action, so a gate that
            // fired at exactly 12:00 would often be admitted after she had moved on. "Somewhere in day 1" is the
            // interval the runner can honour; the gate's own `atGameTime` stays in the record as intent.
            // The catch records WHY, because a silent one made three different failures look the same: a gate whose day had
            // not arrived, a gate whose admission was refused, and a gate whose scheduler threw. Measured 2026-11-04: a
            // seventeen-minute run crossed a night and its session contained ZERO of the four prompts, with nothing anywhere
            // saying which of the three it was.
            void deliverDialogueGatesForDay(day, tools).catch((error) => {
              dialogueDelivery.set(
                "schedule",
                Object.freeze({
                  state: "not_delivered",
                  day,
                  atMs: Date.now(),
                  reason: `delivery_threw:${String(error?.message ?? error).slice(0, 160)}`,
                }),
              );
            });
            if (turns >= MAX_TURNS_PER_DAY) {
              process.stderr.write(`[multiday] day ${String(day)}: turn budget reached (${String(turns)})\n`);
              break;
            }
          }
          // The day's own verdict: what it accomplished, read from the receipts its dispatches produced. This is
          // the "the companion kept working" half of the baseline, and it is computed from the receipts rather than
          // from the companion's prose or from either dispatch channel's file.
          //
          // ACCOMPLISHED WORK IS NOT AN ACCOMPLISHED TASK, and the two are recorded separately. `accomplishedSince`
          // answers "did anything in the world change"; `judgeTaskPurpose` answers "was THIS day's purpose
          // achieved", from the task's own criterion (`task-purpose.mjs`). Measured: a `go_mining` day declared
          // `[travel, enter_mine, break_rock]` broke rocks on the surface, and the second question was never asked.
          taskPurposes.push(
            Object.freeze({ day, task: dayTask, ...judgeTaskPurpose(dayTask, receiptsSince(factsBefore)) }),
          );
          return Object.freeze({ accomplishedActionIds: accomplishedSince(factsBefore) });
        } finally {
          settled.resolve();
        }
      },
      nightWatch: async (day) => {
        const night = await watchNightRollover(day, { dayTurnSettled });
        // The same night, kept as the record a later PLAYER question is judged against: the honesty gate asks on the
        // morning after and needs the hour she went to bed and whether the engine took the night. `passedOut` is
        // `cause === "pass_out"` - an unattributed crossing (`engine`) is NOT evidence that she was up late, and this
        // record does not round it into one.
        nightRecordsByDay.set(
          day,
          Object.freeze({
            day,
            bedTime: night.bedTime ?? null,
            passedOut: night.cause === NIGHT_CAUSE_PASS_OUT,
            cause: night.cause ?? null,
            // Which of the three uncrossed-night findings this was, when there was one - carried through to the day
            // record so the artifact states WHY a night is missing instead of only that it is.
            nightVerdict: night.nightVerdict ?? null,
            // Her own `sleep` receipt for this night, crossing or not: the evidence the baseline attributes a night
            // her sleep ended from when the CALENDAR carried the crossing (`NIGHT_CAUSE_SLEEP_UNSETTLED`).
            sleepReceipt: night.sleepReceipt ?? null,
          }),
        );
        return night;
      },
      onDay: (record) => {
        // The night's own observation travels on the day record, so the ground truth the honesty gate is judged
        // against is visible in the artifact rather than only in this process's memory.
        const night = nightRecordsByDay.get(record.day) ?? null;
        record.cause = night?.cause ?? null;
        record.bedTime = night?.bedTime ?? null;
        record.passedOut = night?.passedOut ?? null;
        record.nightVerdict = night?.nightVerdict ?? null;
        record.sleepReceipt = night?.sleepReceipt ?? null;
        console.error(
          "MULTIDAY_NIGHT",
          JSON.stringify({
            day: record.day,
            cause: record.cause,
            bedTime: record.bedTime,
            menus: record.menus.map((menu) => menu.menuType),
          }),
        );
      },
    });
    // The crossings, in ONE line, published beside the count it explains and printed once so an operator reading the
    // run's log does not have to join `crossings 0` to a night record to learn whose night it was.
    const crossingSummary = summarizeCrossings({
      crossings: crossing.daysCrossed,
      requestedCrossings: MULTIDAY_CROSSINGS,
      nights: crossing.dayRecords,
    });
    console.error("MULTIDAY_CROSSINGS", crossingSummary);
    // THE WAKE ACCOUNT, in one line, because it is the run's answer to "why did the harness think 109 times for four
    // days": what it issued and by which reason, and every settlement it deliberately did not turn into a prompt.
    const wakeByReason = Object.fromEntries(WAKE_REASONS.map((reason) => [reason, wakeAccount.issued[reason] ?? 0]));
    const wakeSuppressedByReason = Object.fromEntries(
      WAKE_SUPPRESSION_REASONS.map((reason) => [reason, wakeAccount.suppressed[reason] ?? 0]),
    );
    const wakesIssued = Object.values(wakeByReason).reduce((total, count) => total + count, 0);
    const wakesSuppressed = Object.values(wakeSuppressedByReason).reduce((total, count) => total + count, 0);
    console.error(
      "MULTIDAY_WAKES",
      JSON.stringify({
        issued: wakesIssued,
        byReason: wakeByReason,
        suppressed: wakesSuppressed,
        suppressedByReason: wakeSuppressedByReason,
        quietBoundMs: QUIET_BOUND_MS,
      }),
    );
    multidayOutcome = Object.freeze({
      crossings: crossing.daysCrossed,
      // A day scope captured while the world was still arriving makes every later reading of that day suspect, so it
      // travels with the crossings instead of staying in this process.
      dayScopeCaptureProblem,
      // What the RUN was asked for, next to what it achieved: judging the window against the achieved count made the
      // window rule unable to notice "asked for three nights, crossed two" (a review found this), because the two
      // numbers were the same by construction.
      requestedCrossings: MULTIDAY_CROSSINGS,
      completed: crossing.completed,
      reasonCode: crossing.reasonCode,
      crossingSummary,
      // Why the model was woken at all, by reason, and every settlement that deliberately did not become a prompt. The
      // verdict reads this for `continuation_prompts_issued`/`_suppressed`; neither can be reconstructed from a session,
      // because a prompt that was never issued leaves no record there.
      wakes: Object.freeze({
        total: wakesIssued,
        byReason: Object.freeze(wakeByReason),
        continuationPromptsIssued: wakeByReason[WAKE_REASON.continuation] ?? 0,
        dayEndOffers: wakeByReason[WAKE_REASON.dayEndOffer] ?? 0,
        stallWakes: wakeByReason[WAKE_REASON.stallWake] ?? 0,
        staleWorldWakes: wakeByReason[WAKE_REASON.staleWorld] ?? 0,
        continuationPromptsSuppressed: wakesSuppressed,
        suppressedByReason: Object.freeze(wakeSuppressedByReason),
        // The bound the decision waited out, published so a reader can tell "nothing moved" from "nothing moved for
        // long enough": the same number `waitForSessionQuiet` uses, stated once.
        quietBoundMs: QUIET_BOUND_MS,
      }),
      // Judged by the ONE baseline module, so the gate and the runner cannot disagree about what a crossing is.
      // The day COUNT is reconciled against the world's own `day_started` facts, not against the loop's own iterations:
      // measured 2026-11-06 (`round38`), two watched nights sat beside five world day starts and the assessment read a
      // clean `crossings: 2`.
      assessment: assessMultiDayBaseline({
        dayRecords: crossing.dayRecords,
        daysRequested: MULTIDAY_CROSSINGS,
        worldDayStarts: worldDayStartsFromFacts(factLog),
        // The world's own night endings, from the same fact log: `night_ended_pass_out` is the only witness that can
        // say the ENGINE took a night, and a night it took is attributed from here rather than from the loop's records.
        worldNightEndings: worldNightEndingsFromFacts(factLog),
      }),
      dayRecords: crossing.dayRecords,
    });
  } else {
    // Time origin for chunked-presentation TTFB: the moment the agent turn is
    // admitted, so the first companion bubble's elapsed time is measured from the
    // real turn boundary, not from process start.
    const firstSpokenBefore = presentationPieces.length;
    const firstTurn = await runAgentTurn(prompt, tools, { reason: WAKE_REASON.dayStart });
    status = firstTurn.status;
    agentTurnResult = firstTurn.turn;
    sessionTurns.push(
      Object.freeze({
        goalIndex: 0,
        goal: prompt,
        turn: agentTurnResult,
        spokenLines: Object.freeze(
          presentationPieces
            .slice(firstSpokenBefore)
            .map((piece) => (typeof piece === "string" ? piece : (piece?.text ?? "")).trim())
            .filter((text) => text.length > 0),
        ),
      }),
    );
    // A self-directed scenario keeps playing: each extra goal is delivered as a NEW player turn
    // only after the previous one settled, so the session measures a companion
    // making its own choices across several intents rather than one scripted chain.
    if (SCENARIO === "morning_routine") {
      for (const [index, goal] of SESSION_GOALS.entries()) {
        const spokenBefore = presentationPieces.length;
        const next = await runAgentTurn(goal, tools, { reason: WAKE_REASON.playerInput });
        if (next.status !== null) status = next.status;
        sessionTurns.push(
          Object.freeze({
            goalIndex: index + 1,
            goal,
            turn: next.turn,
            spokenLines: Object.freeze(
              presentationPieces
                .slice(spokenBefore)
                .map((piece) => (typeof piece === "string" ? piece : (piece?.text ?? "")).trim())
                .filter((text) => text.length > 0),
            ),
          }),
        );
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
  // The Mod's own record is read HERE, once, before the summary that decides the verdict below: this is the last point
  // that is true for both the pass and the fail path, and it is before the single `runtime.close()` in the finally.
  // Reading it in the finally handed both assembly sites `null`, and the builder then fell back to asking a bridge that
  // was already shut - `read_failed:bridge_not_authenticated` for sixteen programs whose receipts had settled all night.
  // A summary that saw only the flat trace answered `nothing_accomplished` for a run whose work all went through Body
  // Programs (measured 2026-10-22: every action batched, `actionTrace` empty, the till/plant/harvest all performed).
  try {
    programOutcomesAtTeardown = await sampleProgramOutcomes();
    programOutcomesReadAtSubmissionCount = programSubmissions.length;
  } catch (error) {
    process.stderr.write(
      `[program-outcomes] pre-teardown read failed: ${String(error?.message ?? error).slice(0, 160)}\n`,
    );
  }
  // Both CHANNELS of an execution, each from its own source: the flat request frames the runner sent, and the nodes a
  // program ran natively (joined to their action ids through the submissions).
  const sessionDispatch = summarizeDispatchedActions(actionTrace, programOutcomesAtTeardown ?? [], programSubmissions);
  const { attempted: attemptedActionIds, accomplished: accomplishedActionIds } = sessionDispatch;
  // The session's own terminal record, read from THIS run's surface session directory - the one the Game runtime was
  // materialized with `gameSessionId` under - and nowhere else. It is what separates "the companion chose not to
  // speak" from "the turn died at the provider": before this, a real run whose turn ended in `stopReason: "error"`
  // was reported as `silent`. A record that cannot be bound there is reported absent, with the directory searched.
  const sessionSearch = findRunSessionJsonl(gameSessionPaths.sessionDir);
  runSessionRecord = Object.freeze({
    path: sessionSearch.path,
    reason: sessionSearch.path === undefined ? sessionSearch.reason : null,
    searched: sessionSearch.searched,
  });
  const agentTurnOutcome =
    sessionSearch.path === undefined
      ? Object.freeze({ observed: false, reason: sessionSearch.reason, searched: sessionSearch.searched })
      : readAgentTurnOutcome(sessionSearch.path);
  const turnFailureReason = agentTurnFailureReason(agentTurnOutcome);
  // The Magic Context store's own account of this run.
  //
  // The store has always been written into the run directory and nothing read it, so a whole layer of a live run was
  // invisible: no fold boundary, no record of whether a tool result was ever reclaimed. That is how the 2026-10-29 run
  // could end `stopReason: "length"` at 139,899 tokens with 78 MB of evidence sitting unopened beside it.
  //
  // The session id is the one the store keys on: the tail of this run's own session record name
  // (`<timestamp>_<sessionId>.jsonl`), NOT the surface session id the runner minted. Read where the record is read, so
  // the two can never describe different sessions.
  const contextSummary = collectContextSummary({
    // The SOURCE root, not `capture.dir`: the store is copied into the capture directory by `closeCapture`, which runs
    // AFTER this read. Pointing at `capture.dir` here is why the first run with this reader published
    // `context_db_not_found` about a store that was on disk the whole time - measured 2026-10-30, whose context.db held
    // 52,563 active tokens and 24 compartments while the result said the file did not exist.
    runDir: runtimeRoot,
    // `collectContextSummary` joins `runtime-root/contexts/...` under the run directory, which is the layout of a
    // CAPTURE. A live runtime root has `contexts/...` directly, so this call passes the path shape it actually holds.
    contextsRoot: join(runtimeRoot, "contexts"),
    sessionId: sessionIdFromSessionRecord(sessionSearch.path),
  });
  const morningLiveness = assessMorningLiveness({ facts: factLog, endedAtMs: Date.now() });
  // The Magic Context store's own account of this run.
  //
  // The store has always been written into the run directory, and nothing read it, so a whole layer of a live run was
  // invisible: no `tokensBefore`, no fold boundary, no record of whether a tool result was ever reclaimed. That is how
  // the 2026-10-29 run could end `stopReason: "length"` at 139,899 tokens with this file - 78 MB of evidence - sitting
  // unopened beside it.
  //
  // The session id is the one the store keys on, which is the tail of this run's own session record name
  // (`<timestamp>_<sessionId>.jsonl`), not the surface session id the runner minted.
  const unsettledSessionTurns = sessionTurns
    .filter((entry) => entry.turn?.settled !== true)
    .map((entry) => ({ goalIndex: entry.goalIndex, error: unsettledTurnError(entry.turn) }));
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
  //
  // The dialogue verdict, judged by the gate module rather than by reading the transcript. Each gate is handed the
  // ground truth IT needs (`dialogueGateContext`): yesterday's night record for the gate that speaks on the morning
  // after, and the refusal the run had in hand when the obstacle gate spoke. A fact the run could not observe makes
  // that gate `not_judgeable` with the missing fact named - never a pass, and never a charge against her.
  const dialogueGates = assessDialogueGates({
    replies: Object.fromEntries(dialogueReplies),
    context: dialogueGateContext,
  });
  // Whether the run reads as a companion or as a screensaver, from the same artifacts this result describes: the fact
  // log in memory (the timeline is written from it) and the one session record bound to THIS run's surface session. The
  // gate is published beside the mechanical verdict rather than folded into it - a run whose actions are all green and
  // whose companion said four lines in twenty-five minutes has to be able to say both things at once, and it must not be
  // able to read as a success either. A record that could not be bound is reported with its reason, never substituted
  // with a neighbour's numbers.
  const interactionValue = assessInteractionValue({
    timelineFacts: factLog,
    sessionPath: sessionSearch.path ?? null,
    sessionUnboundReason: sessionSearch.reason ?? null,
    runStartedAtMs: phaseTimings.runStartedAtMs,
  });
  // What happened to each scheduled line, from the same population the judgement walks: delivered (with the moment,
  // the admission answer and the refusal it was spoken against) or not delivered with the fact that stopped it. Without
  // this, a gate the run never reached and a gate that was delivered and went unanswered publish identically.
  const dialogueGateDelivery = Object.freeze(
    SCHEDULED_DIALOGUE_GATES.map((gate) =>
      Object.freeze({
        id: gate.id,
        ...(dialogueDelivery.get(gate.id) ?? {
          state: "not_delivered",
          reason: "no_delivery_boundary_reached",
        }),
      }),
    ),
  );
  const spokeToPlayer = typeof presentedSummary === "string" && presentedSummary.trim().length > 0;
  const sessionSpoken = SCENARIO !== "morning_routine" || spokeToPlayer;

  const sessionVerdict = deriveSessionVerdict({
    worldStallReason,
    sessionTurns,
    unsettledTurns: unsettledSessionTurns,
    turnFailureReason,
    bridgeDisconnections,
    hostMemory,
    sessionSpoken,
    accomplishedActionIds,
    taskPurposes,
    // Present only for the multi-day scenario, where it is the run's own baseline judgement.
    multidayAssessment: multidayOutcome?.assessment ?? null,
    agentTurnOutcome,
    morningLiveness,
    dialogueGates,
  });
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
      ? // The verdict already carries the baseline's judgement (a blocked assessment cannot reach `completed`) as
        // well as the closing session's shape - a truncated turn, silence, or nothing but the rollover is not a
        // companion that kept playing across days. Re-deciding the assessment here would be the second decision
        // that let a completed session publish beside a blocked baseline.
        sessionVerdict === "completed"
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
  //
  // Judged PER UTTERANCE, over the population the run can PROVE it said: the lines in its own session record, which is
  // the same population `interactionValue` counts above. The two earlier spellings of this were both wrong the same
  // way - one string per SESSION (a three-day run produced a 285-character "summary" out of nine short lines), then one
  // string per TURN (measured 2026-11-06: 207 spoken lines across 14 turns were judged as 14 concatenations, the other
  // 193 lines never looked at, and the run blocked by `summary_too_long` on a join of short bubbles). A concatenation
  // is a summary, and this gate's limits are per utterance.
  //
  // When the session record cannot be bound the population is UNKNOWN: the in-memory pieces are still judged, the
  // answer says how many, and the verdict is `partial` - a sample is never a pass.
  const spokenRecordLines =
    interactionValue.verdict === "not_established"
      ? null
      : interactionValue.measurements.lines.map((line) => line.text);
  const interactionAssessment =
    spokenRecordLines === null
      ? assessSpokenUtterances({
          utterances: presentationPieces.map((piece) => (typeof piece === "string" ? piece : (piece?.text ?? ""))),
          population: null,
          omittedReason: `session_record_unbound:${interactionValue.unestablishedReason ?? "no_session_record"}`,
          observedEvents,
        })
      : assessSpokenUtterances({
          utterances: spokenRecordLines,
          population: interactionValue.measurements.spokenLines.count,
          observedEvents,
        });
  // The interaction gate assesses what the companion SAID. `unobserved` means there was nothing to assess, which a
  // reader must be able to tell apart from "assessed and fine" — the previous boolean could not. `partial` (a verdict
  // about a sample) and `not_established` (a population nobody could measure) are neither.
  const interactionOutcome = interactionAssessment.verdict === "passed" ? "verified" : interactionAssessment.verdict;
  // absence-as-pass: rungs 0-2 emit no companion line by design, and rung 6 requires speech before this point
  // (sessionSpoken), so a run with nothing to judge is not failed for it. A sample is not that case: `partial` and
  // `not_established` never pass.
  const interactionPassed = interactionOutcome === "verified" || interactionOutcome === "unobserved";
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
  // Presence mechanisms (design stardew-companion-presence-mechanisms §1.5/§2.4), computed from facts this run
  // already holds — no new product producer. `presentation` (the chunking evidence) is published by buildRunResult;
  // this half is the CLAIMS projection: it compares spoken promises against the same-turn receipts and the run's
  // visible capability face.
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
  // The execution record, derived ONCE from the journal read taken before teardown, and handed to both the
  // observation block below and the result assembly: the two are then the same object rather than two derivations
  // that a reader has to reconcile. `null` when the run never got a journal read (the builder then asks the live
  // bridge, which is the one path that can still answer).
  const carriedExecutionTrace =
    programOutcomesAtTeardown === null
      ? null
      : executionTraceInvariant({
          actionTrace,
          programOutcomes: programOutcomesAtTeardown,
          programRows: programExecutionRows(programOutcomesAtTeardown),
        });
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
    executionTrace: carriedExecutionTrace,
  });
  // One assembly for EVERY exit path (see buildRunResult): what this path observed goes in as evidence, and the
  // builder owns what the result publishes.
  // The rung's CLAUSES, each with the code that names it when it fails. The builder ANDs them into `state` and takes
  // the first failing one as `failure.reasonCode` (see `deriveRungVerdict`), so the verdict and the reason cannot be
  // decided in two places - and a blocked run cannot publish a code that names something that passed.
  //
  // Each code is derived from the assessment that decides the clause where that assessment has its own vocabulary
  // (`summary_too_long`, `configured_world_book_did_not_mount`, the session verdict); only the two delivery clauses,
  // which are conjunctions of receipts, are named here.
  const rungClauses = Object.freeze([
    // This scenario's session must have run and finished; another scenario's clause never fails.
    Object.freeze({
      id: "morning_routine",
      passed: morningRoutinePassed,
      reasonCode: sessionVerdict === "completed" ? "morning_routine_without_work" : sessionVerdict,
    }),
    Object.freeze({
      id: "memory_covenant",
      passed: memoryCovenantPassed,
      reasonCode: covenantVerdict.reason ?? "covenant_not_honoured",
    }),
    Object.freeze({
      id: "npc_social_and_presence",
      passed: npcSocialAndPresencePassed,
      reasonCode: "harvest_and_offer_not_delivered",
    }),
    // The multi-day clause IS the session verdict (see `multidayRoutinePassed`), so its code is the verdict's own.
    Object.freeze({ id: "multiday_routine", passed: multidayRoutinePassed, reasonCode: sessionVerdict }),
    // THE TASK'S OWN QUESTION, beside the session's shape rather than inside it. A run whose day purpose was
    // `unproven` has not been shown to have done what it was asked, and the clause states it in its own right so the
    // artifact names it even when a more structural clause fails first (see `deriveRungVerdict`'s `failedClauses`).
    Object.freeze({
      id: "task_purpose",
      passed: taskPurposeVerdict(taskPurposes) === null,
      reasonCode: taskPurposeVerdict(taskPurposes) ?? "task_purposes_achieved",
    }),
    Object.freeze({
      id: "context",
      passed: contextPassed,
      reasonCode: contextAssembled ? worldBookVerdict.reason : contextVerdict.reason,
    }),
    Object.freeze({ id: "content", passed: contentPassed, reasonCode: contentVerdict.reason }),
    Object.freeze({ id: "world_book", passed: worldBookPassed, reasonCode: worldBookGateVerdict.reason }),
    // The gate's OWN reasons, never a paraphrase: a `summary_too_long` run and a `machine_token_leak` run are
    // different findings about the companion and the reader has to be able to tell them apart. A verdict that is not
    // about the companion at all - a sample (`partial`) or a population nobody could measure (`not_established`) -
    // names the fact that stopped it, from the same assessment.
    Object.freeze({
      id: "companion_interaction",
      passed: interactionPassed,
      reasonCode: interactionAssessment.reason ?? "companion_interaction_not_assessed",
    }),
    Object.freeze({
      id: "historian_rubric",
      passed: historianRubricPassed,
      reasonCode:
        historianRubricOutcome?.reasonCode ??
        `historian_rubric_${String(historianRubricOutcome?.state ?? "unmeasured")}`,
    }),
  ]);
  const result = await buildRunResult({
    rungClauses,
    carriedExecutionTrace,
    capture,
    runtimeRoot,
    providerReadiness,
    settlement: { snapshot: lastObservedSnapshot, reasonCode: null, component: null },
    // This run's own Mod log, archived with the lines an audit needs (see captureModLogFacts).
    modLog: captureModLogFacts(capture?.dir ?? null),
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
    // The run's own narrative judgement, on the RESULT (the bundle carries the same object): the verdict folds it
    // in, so a caller reading `state` cannot miss it.
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
    // What the store recorded about this same session: active vs reclaimed tokens, the tools that held them, and where
    // the fold boundary stood. Published for every scenario, because a context wall is not a multi-day fact.
    contextSummary,
    // Whether every morning this run opened became PLAYABLE.
    //
    // Four commits have fixed the standing settlement sheet - `1b70f08e`, `541775c2`, `4357a95b`, `76c51da4` - each for a
    // different arrival path, and on 2026-10-31 it happened again: the clock read 600, `menu=ShippingMenu`, and it never
    // moved. Every one of those fixes asserted something about a PATH. This asserts the OUTCOME, which is why it is here
    // and not in the Mod: after the engine opens a day, the clock must move, and a clock held by a standing menu emits no
    // `time_milestone` at all. A frozen morning therefore fails the run by name instead of being noticed by a human half
    // an hour later.
    morningLiveness,
    // Named when the world stopped rather than the turn finishing: the turn never settles in that case, so without
    // this the verdict could only say `turn_unsettled` and the freeze would have to be inferred from a log gap.
    worldStallReason,
    // Present for every scenario; the self-directed one treats silence as its own outcome.
    spokeToPlayer,
    // The actions that actually changed the world (see NON_ACCOMPLISHMENT_ACTIONS):
    // the difference between "the companion acted" and "the companion moved, looked
    // and reported". Published so the verdict is readable, not just its consequence.
    accomplishedActionIds,
    // What each multi-day turn was asked for and whether its own purpose was achieved, next to the work it did.
    // Published because the verdict above is decided from it: a reader must be able to check the judgement instead
    // of trusting it, and a gap has to travel with the run that hit it (`missingFact`).
    taskPurposes,
    // What the run TOLD the companion about a seed shortage, in the words it was handed, per day. Published beside the
    // task verdicts because "she was handed the supply and did not go" and "nothing ever told her" are different
    // findings about the same run, and a reader must be able to tell which one it is looking at.
    seedFacts,
    // The scheduled player lines, judged by the gate module, and what happened to each of them: a gate that was never
    // delivered is a different finding from one that was delivered and answered badly, and both are different from a
    // gate that reported a pass without ground truth (which the module cannot do: it reports `not_judgeable`).
    dialogueGates,
    dialogueGateDelivery,
    // The 30-minute interaction-value gate, clause by clause, from this run's own session record and timeline.
    interactionValue,
    capabilityAudit,
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
    // The journal read taken before the bridge closed; without it this path asks a shut door.
    programOutcomesAtTeardown,
  });
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
  const errorMessage = String(error instanceof Error ? error.message : error);
  // The SAME assembly the passed path uses: a crashed run publishes the same contract, so the field a reader needs
  // most - what was attempted, what was submitted, how the days went - cannot depend on how the run ended. The
  // evidence a crash can observe is the same list the escaped-error dump publishes (`failureDumpEvidence`), so the two
  // failed paths cannot describe one run differently.
  const result = await buildRunResult({
    state: "blocked",
    error: errorMessage,
    ...failureDumpEvidence(errorMessage),
    // The journal read taken before the bridge closed; without it this path asks a shut door.
    programOutcomesAtTeardown,
  });
  console.error("RUNNER_CRASH", JSON.stringify({ error: result.error }));
  console.log(JSON.stringify(result, null, 2));
} finally {
  // THE UNWIND, AND ITS ACCOUNT. Every step is recorded by the process that performs it - this one owns the voice child,
  // the runtime, the binding and the bridge; the launcher owns the game tree and the fixture transaction, and adds its
  // own steps afterwards. The record is written into the artifacts that already exist, so what the teardown DID is
  // readable from the artifact rather than only from a terminal (measured 2026-11-09, `round40`: a complete unwind and a
  // bundle that published `steps: []`).
  const unwindSteps = [];
  if (voiceChild !== null) {
    voiceChild.kill("SIGTERM");
    await Promise.race([once(voiceChild, "close"), new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))]);
    if (!voiceChild.killed) voiceChild.kill("SIGKILL");
    const stopped = voiceChild.exitCode !== null || voiceChild.signalCode !== null;
    unwindSteps.push(
      reclamationStep({
        step: "voice_child_stopped",
        ok: stopped,
        detail: stopped ? null : "voice_child_reported_no_exit",
      }),
    );
  }
  // Teardown must not decide whether the run's own evidence exists, but a silent teardown decides it by
  // accident: `flushRunTrace` is the last step of `close()`, and an empty catch here meant the trace file
  // was never written in 2425 runs while every one of them produced a manifest beside it. Nothing failed
  // loudly enough to notice.
  //
  // The failure is recorded rather than thrown: a run whose teardown could not write its trace is still a
  // run whose other evidence is worth keeping, and the refusal belongs in the artifact, not in a crash.
  let teardownFailure = null;
  if (runtime === undefined) {
    // Nothing was booted to close: the step is not owed, and saying so is not the same as claiming it succeeded.
    unwindSteps.push(reclamationStep({ step: "runtime_close", ok: true, detail: "not_owed:runtime_never_booted" }));
  } else {
    await runtime.close().catch((error) => {
      teardownFailure = error instanceof Error ? error.message : String(error);
    });
    unwindSteps.push(reclamationStep({ step: "runtime_close", ok: teardownFailure === null, detail: teardownFailure }));
  }
  let bindingFailure = null;
  await binding.close().catch((error) => {
    bindingFailure = error instanceof Error ? error.message : String(error);
  });
  unwindSteps.push(reclamationStep({ step: "binding_close", ok: bindingFailure === null, detail: bindingFailure }));
  let detachFailure = null;
  try {
    client.close("agent_ab_complete");
  } catch (error) {
    detachFailure = error instanceof Error ? error.message : String(error);
  }
  unwindSteps.push(reclamationStep({ step: "bridge_detach", ok: detachFailure === null, detail: detachFailure }));
  ledger.record("run.end");
  if (teardownFailure !== null) {
    process.stderr.write(`[teardown] runtime close reported: ${teardownFailure.slice(0, 200)}\n`);
  }
  // The account lands in the result AND the bundle's manifest, from one call: two artifacts of one run may not disagree
  // about what its teardown did. A run that published none says so by name instead of failing silently here.
  try {
    const stamped = stampReclamation({
      paths: [RESULT_FILE, capture === null ? null : join(capture.dir, EVIDENCE_BUNDLE_FILES.manifest)],
      steps: unwindSteps,
    });
    if (stamped.written.length === 0) {
      console.error(
        "RECLAMATION_NOT_STAMPED",
        JSON.stringify({
          reasonCode: "run_reclamation_not_stamped:no_result_artifact",
          steps: unwindSteps.map((entry) => entry.step),
        }),
      );
    }
  } catch (error) {
    // The code names the fault; the thrown text is the DETAIL beside it, never the reason itself.
    console.error(
      "RECLAMATION_NOT_STAMPED",
      JSON.stringify({
        reasonCode: "run_reclamation_not_stamped:artifact_unwritable",
        detail: String(error?.message ?? error).slice(0, 300),
      }),
    );
  }
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
      reasonCode: "historian_rubric_unreadable:read_threw",
      thrown: classifyFailure(error),
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

/**
 * The run's ONE result: the passed, blocked and crashed exit paths all publish through this function.
 *
 * Each exit used to carry its own object literal, so a field added to one was silently absent from the others:
 * `multiday`, then `programSubmissions`, and then `attempted`, which read EMPTY on a run whose trace held 131
 * dispatches because that run ended on the path whose literal never named it. What is published here is the run's
 * contract; `evidence` is what the calling path could observe, spread in first so it can never override it.
 */
async function buildRunResult({
  // The state a NON-rung exit publishes: only the escaped-error and killed paths pass one. The main path passes
  // `rungClauses` instead, so the state and the reason a run is not passed are decided by ONE derivation below.
  state,
  // The rung's clauses, in the order a reader should be told about them (see `deriveRungVerdict`).
  rungClauses = null,
  // The execution record the caller already derived from its pre-teardown journal read, so the observation block and
  // this result publish the same numbers. `null` means the caller had no read; the live query below answers instead.
  carriedExecutionTrace = null,
  error = null,
  // The run's NAMED outcome when nothing was thrown: a killed run publishes `run_killed_by_signal:<signal>` here,
  // beside `state: "killed"`, so the reason is a code the artifact can be matched on instead of the shape of an
  // absent field.
  reasonCode = null,
  // The classified throw when the run CRASHED (`classifyFailure`), so the failure record names the class, the message
  // and the first frame. A run that was refused rather than crashed passes none and publishes `null` in those fields.
  errorDetail = null,
  capture,
  runtimeRoot,
  settlement,
  providerReadiness = null,
  ...evidence
}) {
  // Both halves of "where and when": the snapshot carries the clock and location, the execution receipt's local
  // observation carries the pose (the snapshot has no facing). Neither can be re-read after teardown.
  const snapshot = settlement?.snapshot ?? lastObservedSnapshot ?? lastObservedPose ?? null;
  const pose = lastObservedPose;
  // The trace is read BEFORE the verdict because the verdict reads it: an execution record that could not be read to
  // the end is absent evidence, and a run cannot be `passed` on evidence it failed to read. `carriedExecutionTrace`
  // is the caller's derivation from the pre-teardown read, so the observation block published the same object.
  const carried = evidence.programOutcomesAtTeardown;
  programOutcomes = carried ?? (await sampleProgramOutcomes());
  const programRows = programExecutionRows(programOutcomes);
  const executionTrace =
    carriedExecutionTrace ?? executionTraceInvariant({ actionTrace, programOutcomes, programRows });
  // What the run tried and what it achieved, read from BOTH channels once the program record is in hand. Derived
  // HERE, above the verdict, because `action_breadth` is a clause: the breadth a run publishes and the breadth its
  // verdict is decided on are then one object instead of two derivations that can disagree - and the crashed path,
  // which has no rung clauses at all, still publishes the reading it has.
  const dispatched = summarizeDispatchedActions(actionTrace, programOutcomes, programSubmissions);
  // Coverage is not the same question as volume. Measured 2026-11-07 (`round39`): 124 executions, `ok: true` trace,
  // and 15 distinct actions attempted with a quarter of the executions cutting weeds - a run whose execution count read
  // as a working companion while the surface it was given went mostly untouched. The denominator is what this run COULD
  // address: the families its own snapshots published (`snapshotCensus`, built from `snapshotFamilyRows`), joined to
  // actions through `lib/action-breadth.mjs`; the catalog is published beside it as context only. The ratchet is
  // `tools/action-breadth-baseline.json`, and the verdict names what is missing rather than counting what was done.
  const breadthSurface = await readActionBreadthSurface();
  const snapshotCensus = buildSnapshotCensus({
    surface: breadthSurface,
    rows: snapshotFamilyRows,
    snapshots: snapshotCensusSamples,
  });
  const actionBreadth = await measureActionBreadth({
    scenario: SCENARIO,
    attempted: dispatched.attempted,
    succeeded: dispatched.succeeded,
    executions: executionTrace.rows,
    // The flat half of the trace, in hand: without it the flat dispatches could not be attributed to any action and
    // the concentration would be reported as unmeasurable rather than measured on the program half alone.
    actionRows: actionTrace,
    // The program half, from `programExecutionRows` - the module that owns what one execution IS - so a redelivered
    // journal event cannot be counted twice here while the manifest counts it once.
    programRows,
    programSubmissions,
    // The world this run was given, as the run itself read it. Absent samples (a run that ended before its first
    // observation) make the reading `not_measured:no_snapshot_census`, never a fall back to the catalog.
    census: snapshotCensus,
    surface: breadthSurface,
  });
  if (String(actionBreadth.verdict).startsWith("narrow:"))
    console.error(
      "ACTION_BREADTH_NARROW",
      JSON.stringify({
        verdict: actionBreadth.verdict,
        attempted: actionBreadth.attempted,
        addressable: actionBreadth.addressable,
        published: actionBreadth.published,
        families: actionBreadth.families,
      }),
    );
  // The LAST clause, because it qualifies everything above rather than competing with it: a run that would otherwise
  // pass is blocked when its own execution record is incomplete (`ok` is false when a program's journal could not be
  // read, or when the rows disagree with what the programs reported). Published as a bare flag until 2026-11-06, when
  // round38 published `executionTrace.ok: false` with nine unobserved programs and `state: "blocked"` for an unrelated
  // reason - a red flag nothing consumed is decoration, so it is a clause now and `state` cannot outrun it.
  // `action_breadth` sits just before it: it is a claim about WHICH actions the executions were, so it belongs after
  // every claim about whether the run worked at all and before the clause that says whether the record can be trusted.
  // ONE derivation of what the presentation layer did, made BEFORE the verdict because the verdict reads it: a run
  // whose own commitment count disagrees with its account cannot be a passed run, and the bundle publishes the same
  // object the clause was decided on.
  const presentationEvidence = summarizePresentationEvidence();
  const rung =
    rungClauses === null
      ? null
      : deriveRungVerdict([
          ...rungClauses,
          actionBreadthClause(actionBreadth),
          // The run's own delivery account, beside the ledger's: `presentation.pieceCount` pieces were committed and
          // every one of them has to be either a presented paragraph, a piece emitted ahead of one, or a named
          // remainder. Round41 published 59 pieces and thirteen records accounting 46 parts with nothing said about
          // the difference, and a reader reported a whole turn missing. Publishing the account without deciding
          // anything on it is what let that read as fine.
          deliveryAccountClause(presentationEvidence.deliveryAccount),
          Object.freeze({
            id: "execution_trace",
            passed: executionTrace.ok === true,
            reasonCode: "execution_trace_incomplete",
          }),
        ]);
  const runState = rung === null ? state : rung.state;
  // ONE derivation for the reason a run is not passed, so a code that came from a crash, a code the rung failed on
  // and a code a caller decided cannot all be written. A refused run names its own code; a crashed run is named by
  // its classified throw; a rung names the clause that failed. `${SCENARIO}_blocked` is the last resort for a blocked
  // run that produced no clause at all, and it is never reached on the rung path.
  const publishReasonCode =
    errorDetail?.reasonCode ?? error ?? settlement?.reasonCode ?? rung?.reasonCode ?? reasonCode ?? null;
  const failureReasonCode = publishReasonCode ?? `${SCENARIO}_blocked`;
  // A killed run has NO failure moment: nothing the product did ended it, so there is no block to locate and no dump
  // a replay could re-enter - and every aggregate that counts `failure` would otherwise count an external interrupt as
  // a product defect.
  const failure =
    runState === "passed" || runState === "killed"
      ? null
      : buildFailureSnapshot({
          reasonCode: failureReasonCode,
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
          thrown: errorDetail,
        });
  // Read the Mod's own journal NOW, once per run: this is assembly time, so the per-program execution facts are
  // committed to the result and the bundle together and neither can disagree with the other. Assigned to the module
  // binding `writeRunBundle` reads, so both result paths publish the same read without a second query. The read
  // itself happened above, because the verdict needs it.
  // The disconnect record reads this, and it is only knowable here: a run whose work all went through programs has
  // `flat: 0` and a large program count, so a disconnect that reported the flat half alone said "nothing had
  // happened" beside its own dispatches.
  lastKnownProgramDispatches = executionTrace.programDispatches;
  if (!executionTrace.ok) console.error("EXECUTION_TRACE_INVARIANT_VIOLATED", JSON.stringify(executionTrace));
  // The same discipline for the other side of the same executions: the tool-call counts and the frames the runner sent
  // must not disagree about how many flat dispatches this run made. Read here, not inside the result literal, so the
  // violation is logged by name before anything is published - and read before the run cost account below, which divides
  // these counts and prints beside the delivery account. The record is the one bound to THIS run's surface session; when
  // it could not be bound, its reason is published instead of another run's numbers, and when the invariant fails the
  // reader withholds the timings rather than qualifying them.
  const toolTiming = readToolTiming(runSessionRecord.path, {
    executionTraceFlat: executionTrace.flat,
    unboundReason: runSessionRecord.reason ?? "no_session_record",
  });
  if (toolTiming.invariant.ok === false)
    console.error(TOOL_TIMING_INVARIANT_VIOLATED, JSON.stringify(toolTiming.invariant));
  // WHAT THE RUN SPENT ITS MODEL TURNS ON, printed beside the delivery account and published on the result and the
  // bundle. The population is this run's own: the session record's model turns and plan-tool calls, the programmes the
  // Mod accepted, and the executions that reached a terminal state. `round43` spent 29 of 96 turns polling with nothing
  // anywhere in the artifact that said so - this is that number, every run.
  const runCost = summarizeRunCost({
    planPolls: planPollCount(toolTiming),
    programmes: programSubmissions.filter((submission) => submission.accepted === true).length,
    modelTurns: toolTiming.modelTurns ?? null,
    // An execution record that could not be read is an unmeasured denominator, never a smaller one.
    completedActions:
      executionTrace.ok === true
        ? actionTrace.length + programRows.filter((row) => Number.isFinite(row.settledAtMs)).length
        : null,
  });
  console.error("RUN_COST_ACCOUNT", describeRunCost(runCost), JSON.stringify(runCost));
  // The run's memory, projected ONCE: the result and the bundle both publish this object, so a reader holding either one
  // sees the same series and the same extremes. A run with no turn sample says so by name (`not_measured:...`) rather
  // than by an absent field, which is the reading the old artifact forced an auditor to guess.
  const hostMemoryRecord = summarizeHostMemory({
    samples: hostMemory.samples,
    startRssMb: hostMemory.startRssMb,
    minRssMb: hostMemory.minRssMb,
    maxRssMb: hostMemory.maxHostRssMb,
    minFreeMb: hostMemory.minFreeMb,
    turns: hostMemory.turns,
    omitted: hostMemory.turnsOmitted,
  });
  const result = {
    ...evidence,
    // The run's own window: `startedAtMs` is the runner's own phase clock, so a reader can compute the TAIL (last
    // dispatch -> end) instead of inferring it from a bundle that may be refused.
    startedAtMs: phaseTimings.runStartedAtMs,
    endedAtMs: Date.now(),
    state: runState,
    ...(error === null ? {} : { error }),
    // The SAME code the failure record carries (see `publishReasonCode`): a reader that looks at the result's own
    // `reasonCode` and one that opens `failure.json` are told the same thing, because there is one derivation.
    ...(publishReasonCode === null ? {} : { reasonCode: publishReasonCode }),
    // WHICH clause that code came from, by id. `deriveRungVerdict` has always known it and the result threw it away,
    // so a blocked run named a code without naming the obligation it failed; `null` is a passed run (or one that never
    // reached a rung), never a clause that quietly passed.
    failedClause: rung?.failedClause ?? null,
    // EVERY clause that failed, beside the one code that names the run's reason. The reason is the FIRST failing
    // clause by design; this list says whether anything else also failed, so a second, independent finding cannot
    // live only in the evidence while the verdict reads as if it had never been asked (see `deriveRungVerdict`).
    failedClauses: rung?.failedClauses ?? null,
    scenario: SCENARIO,
    legacyLadder: LEGACY_LADDER,
    // The multi-day crossing record, when the scenario crossed days: each night's own terminal and menus, the
    // work of the day that followed it, and the baseline's judgement of the lot. Absent for every other
    // scenario, because it is a fact about crossings and not a generic field.
    multiday: multidayOutcome,
    // Every submission the Agent made through the program tools, with what the Mod answered. Published on the result
    // as well as in the bundle (where a failed run reads it), because `accepted: 0` - the companion chose batching and
    // nothing ran through it - is the outcome a run's artifact has to be able to state.
    programSubmissions: Object.freeze([...programSubmissions]),
    // The per-program execution record, read from the Mod's journal at assembly time. `dispatched` is the count of the
    // Mod's own `native_dispatch` events - the executions the program produced - and `observed: false` (with
    // `dispatched: null`) is an unobserved program, which a program that ran nothing must never be confused with.
    programOutcomes,
    // How many executions the run has, and where they were recorded: `flat` request frames in `actionTrace.jsonl`,
    // `program` journal executions in `programTrace.jsonl`, `rows` = their sum. `ok` is the invariant above, measured.
    executionTrace,
    // The run's own cadence, split into the three spans that a single "gap" number conflated: the game doing the
    // work, the agent deciding, and the dispatch-to-dispatch total. Published for EVERY scenario, because "the
    // companion feels laggy" is a question about all of them.
    actionCadence: summarizeActionCadence(actionTrace, programRows),
    // What the run tried and what it achieved, read from its own dispatch trace. A crashed run reads the same
    // trace, so "it did nothing" and "the artifact forgot" can never be the same answer.
    attemptedActionIds: dispatched.attempted,
    succeededActionIds: dispatched.succeeded,
    // HOW MUCH OF THE SURFACE THOSE EXECUTIONS COVERED: attempted/succeeded against the actions this run could
    // address, the families they fell in, and the concentration the largest single action held. `round39` published
    // 124 executions and a completed session while addressing a small part of the world it was given, and nothing in
    // its artifact could say so; a narrow run is now visible in its own bundle rather than in a report nobody opened.
    actionBreadth,
    // The world the reading above was measured against: the families this run's own snapshots published, one entry per
    // target family in the catalog - `rows: 0` included, so an empty family and an unobserved one stay different
    // answers. Published rather than kept inside the reading, because it is the run's account of its own surface and a
    // reader has to be able to check the denominator without this process.
    snapshotCensus,
    // Per-tool-call wall clock attributed by OWNER: `delegate` (a nested agent), the planning tools, a program
    // submission, a program read, or a flat dispatch - one category per tool actually called. `invariant` is the
    // agreement between `flat_dispatch.calls` and `executionTrace.flat`, and it is the ONLY thing published when that
    // agreement fails: the categories are then null and `reason` says why, because a number with a caveat gets quoted.
    // `record` names the session file the counts came from, and `reason` is a binding reason when none could be bound.
    toolTiming,
    // Whether the provider was asked before the first model turn, and what it answered: `{ ok, provider, model,
    // reason }`. A later `503 auth_unavailable` in this result is then a provider that went down mid-run, not a run
    // nobody checked - and `null` says nobody checked at all.
    providerReadiness,
    // What the presentation layer did: every committed companion_text piece in arrival order with its elapsed time,
    // so `firstPieceTtfbMs` (the headline TTFB target) survives however the run ended.
    presentation: presentationEvidence,
    // WHAT THE RUN SPENT, in the unit the cost is paid in: model round trips. Printed beside the delivery account (see
    // `RUN_COST_ACCOUNT` below), carried here so a reader of the artifact - not only of the log - can ask whether a third
    // of this run's turns went to asking a question whose answer was already on its way.
    runCost,
    // The run's own memory, as the bundle publishes it and as the auditor reads it. The sampler has measured this all
    // along; until now it reached a terminal log and nothing else, so a memory question had to be answered from a log
    // that is not the artifact (measured 2026-11-09, `round40`: 46 samples, no field).
    hostMemory: hostMemoryRecord,
    // What the Magic Context store recorded about THIS run's own session: how many tokens are still active, how many
    // were reclaimed and by which drop mode, which tools held them, and where the fold boundary stood. Read from the
    // store rather than inferred, because a run that ends at `stopReason: "length"` is a question about this layer and
    // this layer used to publish nothing at all.
    context: evidence.contextSummary ?? Object.freeze({ observed: false, reasonCode: "context_summary_not_read" }),
    // The failure dump, built from the same facts the bundle publishes, so the verdict and the dump cannot disagree
    // about why the run is red.
    failure,
  };
  // The evidence bundle is written BEFORE the capture closes, into the same run directory: it is the contract's face
  // of this run (including the failure dump that makes a failure re-enterable).
  result.bundle = await writeRunBundle({
    capture,
    result,
    scenario: SCENARIO,
    runtimeRoot,
    actionTrace,
    // The program half of the same trace, derived above from the journal read, so the two files and the manifest are
    // written from one derivation and cannot disagree about how many executions the run had.
    programRows,
    hostMemory: hostMemoryRecord,
    settlement,
    snapshot,
    pose,
    failure,
    historianRubric: historianRubricOutcome,
  });
  // Close the capture: keep the runtime root's evidence, record the result JSON itself, and surface any capture
  // failure on the result.
  result.capture = await closeCapture(capture, runtimeRoot, result);
  // Write the machine-readable result to a dedicated file so stdout logs (e.g. native chat ingress traces) can never
  // corrupt JSON parsing of the result. The path is module scope because the TEARDOWN account is stamped into this same
  // file after the unwind, and a second derivation of the name is how the two writers would come to disagree.
  await writeFile(RESULT_FILE, JSON.stringify(result, null, 2), "utf8").catch(() => {});
  return result;
}

async function writeRunBundle({
  capture,
  result,
  scenario,
  runtimeRoot,
  actionTrace,
  programRows,
  hostMemory,
  settlement,
  // Where and when this run last stood, and the failure dump built from it: derived ONCE in buildRunResult, so the
  // bundle cannot judge a run whose `failure` block says something else.
  snapshot,
  pose,
  failure,
  historianRubric = null,
}) {
  // The narrative the run wrote, judged from its own captured runtime root. The CALLER judges it (the verdict needs
  // the same answer); this falls back to judging here so the bundle is never silent about it.
  const historianRubricOutcome = historianRubric ?? judgeRunHistorianRubric(runtimeRoot);
  // Three outcomes, not two: a killed run is neither a pass nor a failure, and collapsing it into `failed` is exactly
  // how an external interrupt becomes a product verdict.
  const verdictState = result?.state === "passed" ? "passed" : result?.state === "killed" ? "killed" : "failed";
  const failed = verdictState === "failed";
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
  // The product writes its own span trace at
  // `<runtimeRoot>/contexts/<identityKey>/surface-sessions/<gameSessionId>/run-trace.json`, during teardown
  // (`flushRunTrace`, the last step of `close()`). Recorded so a reader can open it without knowing that layout,
  // and so its ABSENCE is a stated fact: before the silent-catch fix it was missing in all 2425 runs and nothing
  // could tell that apart from a trace that was merely empty.
  const runTracePath = join(
    runtimeRoot,
    "contexts",
    identityKey(identity),
    "surface-sessions",
    gameSessionId,
    "run-trace.json",
  );
  // Presence is decided at the moment the package is WRITTEN, not here: `flushRunTrace` is the last step of
  // `close()`, so a check made while this object is being built answers a question about the past - which is why a run
  // whose trace exists on disk (35 KB at the time it was reported) published `product_did_not_flush_run_trace`.
  const runTraceRecordAtAssembly = () => {
    const present = existsSync(runTracePath);
    return Object.freeze({
      path: runTracePath,
      present,
      reason: present ? null : "product_did_not_flush_run_trace",
    });
  };

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
      // The same reason the failure dump carries, so the two do not disagree about why the run is red. A killed run has
      // no failure dump; its reason is the one the signal trap named.
      reasonCode: failure?.reasonCode ?? result?.reasonCode ?? null,
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
    // The run's memory: one projection, carried here so the contract's own face of the run can answer the question an
    // auditor asks of it. `not_measured:no_turn_samples` is a legitimate answer; a missing field never was.
    hostMemory,
    // The teardown account starts here as an EXPLICIT "nothing has been measured yet" and is stamped with the steps the
    // unwind performs once it has run (`stampReclamation`, in this process's `finally`). The literal below used to read
    // `reflection: settlement ? "completed" : "skipped"` over an empty `steps` list, so every run published a completed
    // teardown it had never measured (measured 2026-11-09, `round40`).
    reclamation: reclamationRecord({}),
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
    // The per-program execution record, read from the Mod's journal by `buildRunResult` before this bundle is written,
    // so the failed run - the one where "the batch ran nothing" matters most - reads the same `dispatched`/`observed`
    // facts as a passed one.
    programOutcomes,
    // The submission count the journal read covered. Anything above it was submitted after the read - a fact about
    // timing, not about the program.
    programOutcomesReadAtSubmissionCount,
    // THE INVARIANT, published where the trace is written: a run's execution rows are `executionTrace.flat` request
    // frames in `actionTrace.jsonl` PLUS `executionTrace.program` journal executions in `programTrace.jsonl`, and the
    // program half is the sum of the observed programs' `dispatched` counts. `executionTrace.ok` is that identity
    // measured; a `false` here means the trace is missing executions the Mod reported, which is the failure that made a
    // run doing real work read as if nothing happened.
    executionTrace: result.executionTrace,
    // The same breadth reading the result carries, in the bundle: which actions those executions WERE, against the
    // surface this run could address, so a run that repeated three safe actions cannot read as a varied day from its
    // evidence package alone. Copied from `result.actionBreadth` rather than measured again here - one derivation per
    // run - and its denominator travels beside it, so a reader can check the addressable number without the process
    // that produced it.
    actionBreadth: result.actionBreadth,
    snapshotCensus: result.snapshotCensus,
    // The run's own cost, in the same place the contract's face of the run carries every other reading: the delivery
    // account is inside `presentation`, and this is its numerator - model turns, plan polls, and what they were spent on.
    runCost: result.runCost,
    // Two files, one record: a reader merges them (execution-trace.mjs) instead of reading the flat file alone and
    // concluding the run dispatched nothing.
    runTrace: runTraceRecordAtAssembly(),
    programTrace: { path: PROGRAM_TRACE_FILE, records: (programRows ?? []).length },
    // Three waits a reader can act on, each from the same clock: the provider's own latency, the game's own work,
    // and the gap between them. An unfinished pair is reported as `open` rather than as a zero.
    // The provider's own three boundaries are NOT recorded, and that is stated rather than left as a zero: the runner
    // has no provider callback (`after_provider_response` never fires - the vendor expects a numeric status this Pi
    // does not send), so `provider.request`/`first_token`/`done` have no observation point here. A reader sees an
    // empty ledger for them and knows why, instead of reading zeroes as "the provider was instant".
    unavailable: Object.freeze(["provider.request", "provider.first_token", "provider.done"]),
    waits: Object.freeze({
      provider: ledgerSummary(ledgerSpans(ledger.entries(), "provider.request", "provider.first_token")),
      world: ledgerSummary(ledgerSpans(ledger.entries(), "world.dispatch", "world.settled")),
      tool: ledgerSummary(ledgerSpans(ledger.entries(), "tool.start", "tool.settled")),
    }),
    ledger: ledger.snapshot(),
  };
  // The timeline record COUNT is the fact log's length, so the on-disk file must match it (the validator
  // cross-checks the file against the manifest).
  const timeline = factLog.map((entry, index) => ({ index, ...entry }));
  try {
    // The program half of the trace is written FIRST and into the same run directory: it is evidence in its own right,
    // and it must not depend on the manifest being accepted.
    await writeProgramExecutionTrace(capture.dir, programRows);
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
        // The program half too: a refused manifest must not be the only thing the run says about work the Mod did.
        programTraceSteps: (programRows ?? []).length,
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
  // The run's merged execution record (both channels), or `null` when no journal read was taken. Without it the only
  // thing this block can see is the flat half, and `actionCount: 0` then means "no request frame was sent" - which is
  // what a run that batched everything through program tools publishes while it executes hundreds of actions.
  executionTrace = null,
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
  // WHAT COUNTS AS AN EXECUTION, and why this is not `actionTrace.length`. Measured 2026-11-06 on round38: the run
  // executed 379 nodes through Body Programs and the block published `actionCount: 0, rejectionCount: 0` - a zero that
  // means "this connection sent no request frame" reading exactly like "this run did nothing". The merged record is the
  // authority (`execution-trace.mjs`), so the count is taken from it and each channel is published beside it.
  const flatExecutions = executionTrace === null ? (actionTrace ?? []).length : executionTrace.flat;
  const programExecutions = executionTrace === null ? null : executionTrace.program;
  // Rejections are read from the request frame, which names the action and its refusal. Program executions record their
  // state in the journal instead: when every execution went that way there is no rejection count here to publish, and
  // `null` with the missing input named is the only honest answer.
  const rejectionsMeasured = flatExecutions > 0 || programExecutions === 0;
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
    // Every execution the run has, from both channels, plus the split so a reader can tell a run that dispatched flat
    // from one that batched. `null` is NOT a zero: it is "no journal was read", named in the field below.
    actionCount: executionTrace === null ? null : executionTrace.rows,
    executionChannels:
      executionTrace === null ? null : Object.freeze({ flat: executionTrace.flat, program: executionTrace.program }),
    actionCountNotMeasured:
      executionTrace === null
        ? "no_program_journal_read: the flat request frames are the only executions this block can see, and counting them alone reported zero for a run whose work all went through programs"
        : null,
    rejectionCount: rejectionsMeasured ? rejections.length : null,
    // M4: the rejection definition behind the count (uncertain/failed are
    // included too, unlike systemFindings which counts only rejected).
    rejectionCountIncludes: Object.freeze(["rejected", "uncertain", "failed"]),
    rejectionRate: rejectionsMeasured && flatExecutions > 0 ? rejections.length / flatExecutions : null,
    rejectionNotMeasured: rejectionsMeasured
      ? null
      : "flat_request_frames_only: every execution of this run went through a program, and a program node's terminal state is published in the Mod journal rather than in a request frame",
    receiptCount: terminalReceipts.length,
    // M4: executionId-unique receipt count (dedupes the fact-route + execute
    // response double delivery); always <= receiptCount.
    receiptsDeduped: dedupedReceiptIds.size,
    summaryChars: typeof presentedSummary === "string" ? presentedSummary.length : null,
    actionTraceSummary: Object.freeze(actionTraceSummary),
  });
}
