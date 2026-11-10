import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { turnSettled } from "../../lib/turn-settled.mjs";
import { resolveLiveRunRoot } from "../core/capture.mjs";
import { validateEvidenceBundle } from "../../lib/evidence-bundle.mjs";
import {
  assessMultiDayBaseline,
  classifyNight,
  NIGHT_CAUSE_ENGINE,
  NIGHT_CAUSE_PASS_OUT,
  NIGHT_CAUSE_SLEEP_UNSETTLED,
  nightCause,
  parseReceiptEvidence,
  worldNightEndingsFromFacts,
} from "../../lib/multiday-baseline.mjs";
import { watchRollover } from "../../lib/multiday-loop.mjs";
import { buildFailureSnapshot, classifyFailure } from "../../lib/failure-dump.mjs";
import { killedReasonCode, reclamationRecord } from "../../lib/live-run-teardown.mjs";
import { appendTurnMemory, summarizeHostMemory, turnMemoryPoint } from "../../lib/live-run-memory.mjs";
import { describeRunCost, summarizeRunCost } from "../../lib/run-cost-account.mjs";
import { executedActionIds, executionTraceInvariant, programExecutionRows } from "./execution-trace.mjs";
import { deliveryAccountClause, summarizeDeliveryAccount } from "../../lib/presentation-delivery-account.mjs";
import {
  actionBreadthClause,
  buildSnapshotCensus,
  measureActionBreadth,
  readActionBreadthSurface,
} from "../../lib/action-breadth.mjs";
import { executionsFromJournalEvents } from "../../lib/stardew-body-program-journal.mjs";
import { programNodeOutcomes } from "./program-node-outcomes.mjs";
import {
  COMPANION_DID_NOT_SLEEP,
  COMPANION_SLEEP_REFUSED,
  COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
  judgeUncrossedNight,
  sleepReceiptOf,
  sleepVerdictCase,
  summarizeCrossings,
} from "./night-verdict.mjs";
import { shouldAbandonTurnForTransport } from "./transport-loss.mjs";
import { STARDEW_ACTION_TOOL_NAMES } from "../../../host/dist-test/action-registry.js";
import { TERMINAL_STATES } from "../../lib/stardew-native-smoke-harness-v1.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "../../stardew-action-gate-descriptors.mjs";
import { DAILY_TASK_ROTATION, sweepTaskPrompts } from "../../lib/multiday-daily-tasks.mjs";

const RUNNER_SOURCE = await readFile(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");
/**
 * What the presentation evidence is in the fixtures below: nothing presented, and an account that says exactly that.
 *
 * `buildRunResult` decides its `delivery_account` clause on this object, so a fixture that stubbed it as `{ pieces: [] }`
 * would be a run whose account cannot be READ - which is blocked by name (`delivery_account_absent`), never passed.
 */
const NOTHING_PRESENTED = Object.freeze({
  pieces: [],
  deliveryAccount: summarizeDeliveryAccount({ records: [], piecesProduced: 0 }),
});
// The baseline module's own text: the night-fact reader lives there (one authority for the minted `night_ended_*` shape),
// so the assertion about how that shape is read belongs to the module rather than to the runner that calls it.
const NIGHT_FACTS_SOURCE = await readFile(new URL("../../lib/multiday-baseline.mjs", import.meta.url), "utf8");
// The program tool's description is presented material, but the runner mounts the Host's tool definitions rather
// than authoring them, so the one copy lives in the materializer. Read (never write) it here to falsify its content.
const HOST_MATERIALIZER_SOURCE = await readFile(
  new URL(
    "../../../host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts",
    import.meta.url,
  ),
  "utf8",
);

/** The opening scenario's own prompt text: the task the run presents first, and nothing else. */
function extractOpeningTaskPrompt(source) {
  const start = source.indexOf("morning_routine: Object.freeze({");
  const end = source.indexOf("memory_covenant: Object.freeze({");
  assert.ok(start >= 0 && end > start, "the runner must define the opening scenario's prompt");
  return source.slice(start, end);
}

/** The `description` literal that belongs to `stardew_submit_action_program`, delimited by its own tool body. */
function extractProgramToolDescription(source) {
  const toolAt = source.indexOf('"stardew_submit_action_program"');
  const descriptionAt = source.indexOf("description:", toolAt);
  const end = source.indexOf("parameters: bodyProgramToolParameters(", descriptionAt);
  assert.ok(toolAt >= 0 && descriptionAt > toolAt && end > descriptionAt, "the program tool must have a description");
  return source.slice(descriptionAt, end);
}

test("the runner resolves its capture root to the repository root, not tools/", () => {
  // The runner lives at tools/live-run/game; "../../.." must land on the
  // directory that owns package.json. One hop short drops live-run evidence
  // (which contains player memory content) into tools/.live-runs.
  const fromRunnerDir = fileURLToPath(new URL("../../..", import.meta.url));
  // A real check, not a tautology: tools/ has no package.json, so one hop short
  // fails here instead of silently staging evidence under tools/.live-runs.
  assert.ok(existsSync(join(fromRunnerDir, "package.json")), "capture root must own package.json");
  assert.equal(resolveLiveRunRoot({ repoRoot: fromRunnerDir }), join(fromRunnerDir, ".live-runs"));
});

test("the live runner takes the runtime root, principal, and voice enablement from configuration", () => {
  // Runtime root and continuity identity are product configuration, so the run
  // exercises the persona/world book the product assembled instead of a
  // run-scoped invention.
  assert.match(RUNNER_SOURCE, /process\.env\.GAMEBUDDY_RUNTIME_ROOT/);
  assert.match(RUNNER_SOURCE, /process\.env\.GAMEBUDDY_COMPANION_CONTINUITY_ID/);
  // Voice comes from the shared configuration launcher: the runner must not
  // spawn a gateway, hand-write the MIMO key, or invent port candidates.
  assert.match(RUNNER_SOURCE, /resolveVoiceConfiguration/);
  assert.match(RUNNER_SOURCE, /launchVoiceGatewayChild/);
  assert.match(RUNNER_SOURCE, /pickVoiceGatewayPort/);
  assert.doesNotMatch(RUNNER_SOURCE, /spawn\(/);
  assert.doesNotMatch(RUNNER_SOURCE, /MIMO_API_KEY/);
  assert.doesNotMatch(RUNNER_SOURCE, /GAMEBUDDY_VOICE_TOKEN \?\? randomToken/);
  assert.doesNotMatch(RUNNER_SOURCE, /49_731/);
});

test("the runner gate reports the assembled persona and world book instead of asserting them itself", () => {
  assert.match(RUNNER_SOURCE, /readAssembledContextEvidence/);
  assert.match(RUNNER_SOURCE, /runtimePaths\.runManifestPath/);
  assert.match(RUNNER_SOURCE, /contextAssembled/);
  assert.match(RUNNER_SOURCE, /worldBookAssembled/);
  // The acceptance uses the observed facts, not a script-side persona claim.
  assert.match(RUNNER_SOURCE, /contextPassed/);
  // Voice disabled by configuration is not scored as a gameplay failure.
  assert.match(RUNNER_SOURCE, /voiceResult\?\.state === "disabled"/);
});

test("the runner reads the run manifest under the same Game session path the runtime writes", () => {
  // resolveRuntimePaths places the run manifest under surface-sessions/<id>
  // when a surface session id is supplied, and the runtime always supplies the
  // Game session id. Reading without it would silently find no manifest and the
  // persona/world-book evidence would never be observed.
  // The session id is now ASSIGNED where it used to be DECLARED, so the failure path cannot reach a binding that has not
  // run yet. What this assertion is for is unchanged: the directory name is `game-<ts>`, and the runner resolves the
  // runtime paths and the bundle from that same value.
  assert.match(RUNNER_SOURCE, /gameSessionId = `game-\$\{Date\.now\(\)\}`/);
  assert.match(RUNNER_SOURCE, /resolveRuntimePaths\(identity, runtimeRoot, gameSessionId\)/);
  assert.match(RUNNER_SOURCE, /readAssembledContextEvidence\(gameSessionPaths\)/);
  assert.match(RUNNER_SOURCE, /gameSessionId,/);
});

test("a model profile is filled only where one is missing, never overwritten", () => {
  assert.match(RUNNER_SOURCE, /const usesDisposableRoot = !usesConfiguredRuntimeRoot;/);
  // The invariant is READ BEFORE WRITE, and it is asserted on the DECISION rather than on one literal gate.
  //
  // This used to pin `if (!hasModelProfile)` and the write below it. That gate could not express the real rule: a root
  // whose profile exists but carries `modelId` without `providerId` HAS a file and still has no usable model - which is
  // exactly the state the old filler produced, and the reason every live run died at
  // `gameplay_subagent_requires_model_and_integration`. Replacing the gate with a per-surface `needsProvider` check is
  // the fix, so the assertion is now: the profile is read first, the decision is a per-surface gap test, and an
  // existing pair is never rewritten.
  const profileRead = RUNNER_SOURCE.indexOf("const existingProfile");
  const decision = RUNNER_SOURCE.indexOf("const needsProvider");
  const write = RUNNER_SOURCE.indexOf('if (needsProvider("chat") || needsProvider("game"))');
  assert.ok(profileRead >= 0, "the profile is READ before anything is decided");
  assert.ok(decision > profileRead, "the decision comes after the read");
  assert.ok(write > decision, "the write comes after the decision");
  // The gap test must look at BOTH halves: `providerId` is the half the old filler omitted, and a rule that checked only
  // `modelId` would pass on the broken file.
  assert.match(
    RUNNER_SOURCE,
    /existingProfile\[surface\]\?\.providerId === undefined[\s\S]{0,200}existingProfile\[surface\]\?\.modelId === undefined/,
    "the gap test looks at provider AND model, not at whether a file exists",
  );
  // An operator's existing choice survives: every field falls back to what was already there.
  assert.match(RUNNER_SOURCE, /providerId: existingProfile\?\.chat\?\.providerId \?\? PROVIDER/);
  assert.match(RUNNER_SOURCE, /modelId: existingProfile\?\.game\?\.modelId \?\? MODEL/);
});

/** The runner's rung-clause list, sliced out so a test can read the declarations the verdict is built from. */
function rungClauseList(source) {
  const start = source.indexOf("const rungClauses = Object.freeze([");
  const end = source.indexOf("const result = await buildRunResult({\n    rungClauses,");
  assert.ok(start >= 0 && end > start, "the runner must declare its rung clauses in one list, and pass them");
  return source.slice(start, end);
}

test("the runner enforces a companion-interaction gate on every speaking scenario", () => {
  // The gate must be wired into the verdict so a "checklist of what I did" closing
  // line blocks the run instead of passing silently.
  assert.match(RUNNER_SOURCE, /assessCompanionInteraction/);
  // The interaction gate publishes an OUTCOME vocabulary: `unobserved` means nobody could assess the reply,
  // which must stay distinguishable from `verified`. The old boolean (`=== null || .passed`) could not say
  // which, and the verdict-guard now rejects that spelling outright.
  assert.match(RUNNER_SOURCE, /const interactionOutcome =/);
  assert.match(RUNNER_SOURCE, /interactionAssessment\.verdict === "passed" \? "verified"/);
  // MEASURED 2026-11-06: the gate was handed one string per TURN, so a run with 207 spoken lines was judged on 14
  // concatenations and blocked by `summary_too_long` on one of them. The population is now the run's own session
  // record - the same lines `interactionValue` counts - judged one by one.
  assert.match(RUNNER_SOURCE, /assessSpokenUtterances\(\{/);
  assert.match(
    RUNNER_SOURCE,
    /interactionValue\.measurements\.lines\.map\(\(line\) => line\.text\)/,
    "the judged population is the session record's own lines, not a re-derived list",
  );
  assert.match(
    RUNNER_SOURCE,
    /population: interactionValue\.measurements\.spokenLines\.count,/,
    "and the declared population is the count the interaction gate publishes, so `judged N of M` is checkable",
  );
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /spokenText:/,
    "the per-turn concatenation is gone: a join of short bubbles is a summary, not an utterance",
  );
  // A verdict about a sample, or about a population nobody could measure, must not pass. Only the two states that
  // are actually about her - judged and fine, or nothing to judge - can.
  assert.match(
    RUNNER_SOURCE,
    /const interactionPassed = interactionOutcome === "verified" \|\| interactionOutcome === "unobserved";/,
  );
  assert.match(RUNNER_SOURCE, /interactionOutcome,/);
  assert.match(
    RUNNER_SOURCE,
    /reasonCode: interactionAssessment\.reason \?\? "companion_interaction_not_assessed"/,
    "a clause that did not pass names the fact that stopped it, from the assessment that stopped it",
  );
  // Every scenario's clause plus the shared gates, in ONE list the verdict reads - and each clause carries the code
  // that reports it, so a blocked run cannot publish a code borrowed from a clause that passed.
  const clauses = rungClauseList(RUNNER_SOURCE);
  for (const id of [
    "morning_routine",
    "memory_covenant",
    "npc_social_and_presence",
    "multiday_routine",
    "task_purpose",
    "context",
    "content",
    "world_book",
    "companion_interaction",
    "historian_rubric",
  ])
    assert.ok(clauses.includes(`id: "${id}"`), `the rung's clause list must carry ${id}`);
  assert.equal(
    (clauses.match(/reasonCode:/gu) ?? []).length,
    (clauses.match(/id: "/gu) ?? []).length,
    "every clause names the code that reports it; a clause without one is a verdict nobody can explain",
  );
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /state:\n\s+morningRoutinePassed/,
    "the state is derived from the clauses, never written beside them",
  );
});

test("the runner emits system findings as a first-class health signal", () => {
  // Every live run must yield a system health report (findings with component
  // attribution + counts), not just pass/blocked — that report is the feedback
  // signal of the system-level RL loop.
  assert.match(RUNNER_SOURCE, /import \{ summarizeSystemFindings \} from "\.\.\/\..\/lib\/system-findings\.mjs"/);
  assert.match(RUNNER_SOURCE, /const actionTrace = \[\]/);
  assert.match(RUNNER_SOURCE, /actionTrace\.push\(entry\)/);
  // The summary receives the per-execution failures too: an action admitted and then failed produces no
  // REFUSAL, so a refusal-only reading reported nothing while the caller retried a dead request.
  assert.match(RUNNER_SOURCE, /const systemFindings = summarizeSystemFindings\(/);
  assert.match(RUNNER_SOURCE, /failedTerminalReasonCodes: entry\.failedTerminalReasonCodes \?\? \{\}/);
  // First-class fields of the result JSON: the health report and its
  // companion observation block (roll-monitoring data) sit next to the
  // presented text in the same result object.
  assert.match(RUNNER_SOURCE, /systemFindings,\n    observation,\n    presentedSummary/);
  assert.match(RUNNER_SOURCE, /buildRunObservation\(\{\n\s+prompt,/);
  // Live-run evidence capture (tools/live-run/README.md): every run writes its
  // own local directory with the runtime root's evidence and the result, and
  // the result JSON surfaces the capture summary so a broken capture is never
  // silent.
  assert.match(RUNNER_SOURCE, /import \{ openLiveRunCapture, resolveLiveRunRoot \} from "\.\.\/core\/capture\.mjs";/);
  // The capture root must be the REPOSITORY root, not tools/. The runner lives
  // at tools/live-run/game, so the relative hop count is load-bearing: one hop
  // short drops evidence into tools/.live-runs, where the evidence (player
  // memory contents) could be staged by git add.
  assert.match(
    RUNNER_SOURCE,
    /resolveLiveRunRoot\(\{ repoRoot: fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.", import\.meta\.url\)\) \}\)/,
  );
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /resolveLiveRunRoot\(\{ repoRoot: fileURLToPath\(new URL\("\.\.\/\.\.", import\.meta\.url\)\) \}\)/,
  );
  // The capture is closed in the ONE assembly every exit path uses, so a run that crashed still ships its evidence.
  assert.match(RUNNER_SOURCE, /result\.capture = await closeCapture\(capture, runtimeRoot, result\);/);
  assert.doesNotMatch(RUNNER_SOURCE, /partialResult/);
  // Content gate: the same canonical profile the assembly gate hashes is
  // assessed for persona presence and macro residue; a hollow default card or
  // unrendered macros fails the run loudly instead of passing silently.
  assert.match(RUNNER_SOURCE, /import \{ assessIdentityProfile \} from "\.\.\/core\/content-gate\.mjs";/);
  assert.match(
    RUNNER_SOURCE,
    /contentGate: canonicalProfile === null \? null : assessIdentityProfile\(canonicalProfile\),/,
  );
  assert.match(RUNNER_SOURCE, /const contentGate = personaWorldBook\.contentGate \?\? null;/);
  // The three assembly/content gates must go through the evidence-verdict
  // vocabulary: a boolean there used to default to PASS when there was nothing to
  // look at, which reported "assembly passed" for a companion with no persona
  // (measured 2026-10-06). This pins the vocabulary AND that the persona/macro
  // check survives inside it.
  assert.match(RUNNER_SOURCE, /import \{ isPass, judgeExpectation \} from "\.\.\/core\/evidence-verdict\.mjs";/);
  assert.match(
    RUNNER_SOURCE,
    /const contentVerdict = judgeExpectation\(\{[\s\S]{0,200}observed: contentGate\?\.profileRead === true,[\s\S]{0,120}ok: contentGate\?\.personaPresent === true && \(contentGate\?\.macroResidue\?\.length \?\? 0\) === 0,/,
  );
  assert.match(RUNNER_SOURCE, /const contentPassed = isPass\(contentVerdict\);/);
  assert.match(RUNNER_SOURCE, /const contextAssembled = isPass\(contextVerdict\);/);
  assert.match(RUNNER_SOURCE, /const worldBookAssembled = isPass\(worldBookVerdict\);/);
  // And the outcome vocabulary reaches the artifact, so a reader can tell
  // "verified" from "nobody looked".
  assert.match(RUNNER_SOURCE, /assemblyEvidence,/);
  // Audit MEDIUM-3: a settled-but-never-delivered turn must be distinguishable
  // from a real (possibly quiet) turn — steerObserved is an observed fact.
  assert.match(RUNNER_SOURCE, /worldBookGate/);
  assert.match(RUNNER_SOURCE, /worldBookPassed/);
  assert.match(RUNNER_SOURCE, /turn\.steerObserved =/);
  assert.match(RUNNER_SOURCE, /steer_may_have_been_silently_dropped/);
  // A second run on the same product continuity must OPEN the already
  // provisioned authority (mode known) instead of failing the whole ladder with
  // production_authority_artifact_present; only that refusal is retried.
  assert.match(RUNNER_SOURCE, /production_authority_artifact_present/);
  assert.match(RUNNER_SOURCE, /gameSessionMode: "known"/);
  // The authority marker binds the bootstrapOperationId that provisioned the
  // root, so a repeat run must reuse the stored deployment manifest - minting a
  // new id makes BOTH fresh and known refuse with
  // production_authority_artifact_present (verified by a real repeat run).
  assert.match(RUNNER_SOURCE, /const storedManifest = await readFile\(manifestPath, "utf8"\)/);
  assert.match(RUNNER_SOURCE, /if \(storedManifest === null\) \{/);
  assert.match(RUNNER_SOURCE, /runtime_root_principal_mismatch/);
  // When BOTH modes are refused, name the two ids that disagree: the authority
  // marker binds the operation id that provisioned the root
  // (real run evidence: marker agent-ab-1791121825880 vs manifest
  // agent-ab-1791122324799 -> production_authority_artifact_present).
  assert.match(
    RUNNER_SOURCE,
    /import \{ explainAuthorityIdentityMismatch \} from "\.\.\/core\/authority-identity\.mjs";/,
  );
  // Presentation evidence is recorded for EVERY ladder: gating it on ladder 3/4
  // made ladder-5 runs report an empty presentation block even when the Agent
  // had spoken (real run: presentation.pieces=[] while the session transcript
  // held the full Chinese reply). Only the VOICE lane stays ladder-scoped.
  assert.match(
    RUNNER_SOURCE,
    /presentationPieces\.push\(Object\.freeze\(\{ index: presentationPieces\.length, text, locale, elapsedMs \}\)\)/,
  );
  assert.match(RUNNER_SOURCE, /if \(SCENARIO !== "npc_social_and_presence"\) return;\n  if \(voiceStarted\) return;/);
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /const onCompanionTextPresented = \(text, locale\) => \{\n  if \(SCENARIO !== "npc_social_and_presence"\) return;/,
  );
  // Ladder 5 dialogue is covered by the interaction gate too (its reply is the covenant answer to the player);
  // before this it was never assessed at all.
  //
  // The gate is fed one UTTERANCE at a time and says how many of the population it judged. Per turn was still a
  // concatenation - measured 2026-11-06, 207 spoken lines judged as 14 strings - and per session was worse.
  assert.match(RUNNER_SOURCE, /const interactionAssessment =\n\s+spokenRecordLines === null/);
  assert.match(
    RUNNER_SOURCE,
    /utterances: spokenRecordLines,\n\s+population: interactionValue\.measurements\.spokenLines\.count,/,
  );
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /presentedSummary\.trim\(\)\.length > 0\n\s+\? assessCompanionInteraction\(presentedSummary, observedEvents\)/,
    "the whole-session summary is not a per-utterance unit",
  );
  assert.match(
    RUNNER_SOURCE,
    /function withAuthorityIdentityMismatch\(error, root, manifest\) \{\n  return explainAuthorityIdentityMismatch\(error, root, manifest\);/,
  );
  assert.match(RUNNER_SOURCE, /throw withAuthorityIdentityMismatch\(knownError, root, deploymentManifest\);/);
  assert.match(RUNNER_SOURCE, /const deploymentManifest = await loadHostDeploymentManifest\(manifestPath\);/);
  // Audit NOTE-7: the Windows double-drive capture-root bug must not regress —
  // neither runner may resolve its live-run root from a URL pathname.
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /resolveLiveRunRoot\(\{[^}]*new URL\([^)]*\)\.pathname/,
    "live-run root must not come from a URL pathname (Windows double-drive bug)",
  );
});

test("the failure dump can run before the run has started", () => {
  // The dump is invoked from an EXIT hook, so it can fire on a run that died at the very first check - a stale artifact,
  // a refused fixture. Measured 2026-11-03 (`round29`): `live_run_artifact_stale` was the real failure, the dump then read
  // a `let capture` that had not been initialised yet, and the ReferenceError REPLACED the artifact that would have
  // explained the run. The invariant is "initialised before any run code", so it is asserted as that: one declaration,
  // and it precedes `main`.
  const declarations = RUNNER_SOURCE.match(/^let capture = null;$/gmu) ?? [];
  assert.equal(declarations.length, 1, "capture is declared exactly once");
  // Ahead of the code that can READ it from the exit hook: the dump is defined and registered later in the file, so a
  // declaration after them would be executed after the hook exists.
  const declaredAt = RUNNER_SOURCE.indexOf("let capture = null;");
  assert.ok(
    declaredAt >= 0 && declaredAt < RUNNER_SOURCE.indexOf("function failureDumpEvidence("),
    "and ahead of the dump that reads it",
  );
  assert.ok(declaredAt < RUNNER_SOURCE.indexOf("exitAfterDump"), "and ahead of the hook registration");
});

test("every value the failure dump reads is initialised before the run starts", () => {
  // THIRD instance of one shape, so it gets a gate instead of another one-line fix. `round29` ran the dump from an EXIT
  // hook after a startup failure, and each attempt to repair it found the next binding: first `capture`
  // ("Cannot access 'capture' before initialization"), then `runtimeRoot`. The dump reads a handful of values; the ones
  // already at module scope could not throw, and the run-scope one could.
  //
  // The population is DERIVED from the dump rather than listed: the identifiers it returns must each have a module-scope
  // declaration. A value added to the dump later is covered without anyone remembering this test.
  const dumpStart = RUNNER_SOURCE.indexOf("function failureDumpEvidence(");
  // Bounded by its own closing brace, not by the next function: `writeFailureDump` is defined ABOVE this one, and an
  // index-ordered slice produced an empty body (caught here by the non-vacuity assertion, which is why it exists).
  const dumpBody = RUNNER_SOURCE.slice(dumpStart, RUNNER_SOURCE.indexOf("\n};", dumpStart) + 3);
  // Only BARE identifiers with a trailing comma: those are references to bindings. `settlement: { ... }` and
  // `tillReceipt: receiptWith([...])` are composed values, and their inputs are read inside functions that are called
  // later - capturing them here would assert about the wrong thing.
  const returned = [...dumpBody.matchAll(/^\s+([A-Za-z_$][\w$]*),\s*$/gmu)].map((match) => match[1]);
  assert.ok(returned.length >= 4, "the parser must find the dump keys; a silent zero would make this gate vacuous");
  assert.ok(returned.includes("capture") && returned.includes("runtimeRoot"), "including the two that actually threw");

  for (const name of returned) {
    // Module scope here means the declaration starts at column 0; the run body indents its own.
    const moduleScope = new RegExp(`^(?:let|const|var)\\s+${name}\\b`, "mu");
    assert.ok(
      moduleScope.test(RUNNER_SOURCE),
      `${name} is read by the failure dump, so it must be declared at module scope - a run that dies before it is\n` +
        "initialised will throw instead of writing the artifact that explains the run",
    );
  }
});

test("the run asks the companion questions and publishes the verdict", () => {
  // A gate module nobody calls is a document. This asserts the three links that make it a measurement: the import, the
  // delivery of the prompt through the same admission path as a task, and the verdict in the run's own result.
  assert.match(RUNNER_SOURCE, /from "\.\.\/dialogue-gates\.mjs"/);
  // Delivery must NOT be sequenced behind the day's turn.
  //
  // It was, and it never fired: `round28` ran seventeen minutes and all four gate prompts appear ZERO times in its
  // session, because `await runAgentTurn(...)` does not return until the turn settles and a turn can last the whole day.
  // Player text already steers into a running turn, so the assertion is about WHERE the submit happens, not about the
  // transport.
  assert.match(RUNNER_SOURCE, /deliverDialogueGatesForDay\(day, tools\)/);
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /await runAgentTurn\(gate\.prompt/,
    "a gate must not wait for the turn it is interrupting",
  );
  assert.match(RUNNER_SOURCE, /const dialogueGates = assessDialogueGates\(/);
  assert.match(RUNNER_SOURCE, /^\s+dialogueGates,$/mu, "the verdict must reach result.json");
});

test("the scheduled gates are delivered from ground truth the run observed, and every delivery is published", () => {
  // Two gates were wired but unreachable. The honesty gate asked about yesterday and was handed `context: {}`, so it
  // could only ever answer `gate_cannot_judge_without_yesterday`; the obstacle gate was skipped by kind in the only
  // delivery site, so it could only ever read as "not triggered".
  //
  // 1. The context is a function of the gate: the record looked up is the one the gate's own trigger names.
  assert.match(RUNNER_SOURCE, /context: dialogueGateContext,/);
  assert.match(
    RUNNER_SOURCE,
    /yesterday:\s*\n?\s*Number\.isInteger\(triggerDay\) && triggerDay > 1/,
    "yesterday must be the night before the gate's own day, not a constant",
  );
  // 2. Yesterday is the night watch's own observation, and it is an observation: the latest clock it saw on that day.
  assert.match(RUNNER_SOURCE, /bedTime: bedTimeBeforeCrossing/);
  assert.match(
    RUNNER_SOURCE,
    /bedTimeBeforeCrossing = Math\.max\(bedTimeBeforeCrossing \?\? 0, snapshot\.timeOfDay\)/,
    "the bed time is the engine's clock, read by the watch that is already polling",
  );
  // 3. The refusal gate is planned, not skipped: the schedule is the gate module's, and no branch here filters gates out
  //    by trigger kind.
  assert.match(RUNNER_SOURCE, /planGateDeliveries\(SCHEDULED_DIALOGUE_GATES,/);
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /kind === "recent_refusal"\)\s*continue/,
    "a gate filtered out by kind is a gate that can never be spoken",
  );
  // 4. The refusal evidence is the game's own record of a refused action, read from this run's Mod log.
  assert.match(RUNNER_SOURCE, /const MOD_RECEIPT_MARKER = "\[receipt-publish-marker\]";/);
  assert.match(RUNNER_SOURCE, /line\.includes\("state=Rejected"\)/);
  // The reader must read where the Mod ACTUALLY logs. That is not one path: the marker and the receipts are written to the
  // SMAPI log FILE, while the lane log is the console capture - the split that made a 17-minute run report an empty last
  // heartbeat and lose every receipt while the facts sat in the other stream. So the assertion pins the multi-source reader
  // and the fact that it is built from MOD_LOG_PATHS, rather than a single hard-coded file.
  assert.match(
    RUNNER_SOURCE,
    /const readModLogText = \(\) =>[\s\S]{0,200}MOD_LOG_PATHS\(\)/,
    "read every source the Mod logs to",
  );
  assert.match(RUNNER_SOURCE, /const MOD_LOG_PATHS = \(\) => \{/);
  // 5. A gate is CLAIMED before the admission is awaited, so two turns cannot both speak the same line.
  const deliverStart = RUNNER_SOURCE.indexOf("async function deliverDialogueGatesForDay(day, tools)");
  const deliverBody = RUNNER_SOURCE.slice(
    deliverStart,
    RUNNER_SOURCE.indexOf("\nasync function runAgentTurn", deliverStart),
  );
  const claimAt = deliverBody.indexOf("dialogueDelivery.set(gate.id, claimed)");
  const submitAt = deliverBody.indexOf("await submitPlayerPrompt({");
  assert.ok(claimAt > 0 && submitAt > claimAt, "the claim must be taken before the await, not after it");
  // 6. Delivery is published beside the judgement, so "delivered and unanswered" and "never delivered" are different
  //    readings of result.json instead of the same one.
  assert.match(RUNNER_SOURCE, /^\s+dialogueGateDelivery,$/mu);
});

test("prompts state the errand and leave the voice to the system prompt (ladder-3)", () => {
  // The ladder-3 prompts must NOT ask the Agent to "summarize what you did" — that phrasing is what produced the
  // recital the interaction gate rejects.
  assert.doesNotMatch(RUNNER_SOURCE, /总结你为乔迪做了哪些准备/);
  assert.doesNotMatch(RUNNER_SOURCE, /summarize in one sentence what you prepared for Jodi/);
  // And the runner must not try to fix that recital by writing voice rules of its own. It did, for months: a paragraph
  // about bracketed emotion and a "not a task announcer" rule rode on every prompt beside a system prompt that already
  // said the same thing at greater length. Two authorities for one rule, and the companion still narrated its steps.
  assert.doesNotMatch(RUNNER_SOURCE, /不是任务播报员/);
  assert.doesNotMatch(RUNNER_SOURCE, /not a task announcer/);
  assert.doesNotMatch(RUNNER_SOURCE, /PRESENCE_PARAGRAPH|COMPANION_VOICE_RULE/);
});

test("prompts state the errand, not the route (no step-by-step coaching)", () => {
  // A live trace showed the Agent succeeding only because the prompt had been
  // coaching it: it named the tools in order, told the Agent the observation
  // already carried coordinates, and asked it to batch calls. That hides real
  // observation defects (the Agent guessed content ids because observe never
  // published names), so the errand prompts must state goal + world facts only.
  assert.doesNotMatch(RUNNER_SOURCE, /请严格按以下顺序/);
  assert.doesNotMatch(RUNNER_SOURCE, /效率要求/);
  assert.doesNotMatch(RUNNER_SOURCE, /Complete in this order/);
  assert.doesNotMatch(RUNNER_SOURCE, /be efficient/);
  assert.doesNotMatch(RUNNER_SOURCE, /先检查（inspect）/);
  assert.doesNotMatch(RUNNER_SOURCE, /先观察 observe/);
  // The goal statement itself must survive.
  assert.match(RUNNER_SOURCE, /她需要一颗新鲜花椰菜/);
  assert.match(RUNNER_SOURCE, /she needs a fresh cauliflower/);
});

test("the opening task's unit is one whole piece of work, stated without tool names or a route", () => {
  // Measured 2026-10-21: the companion's problem was not discoverability (one session made 22 accepted program
  // submissions) but the UNIT the opening task asked for - "do as many things as you can" produces one model
  // round-trip per thing (settle -> dispatch p50 3.3 s, p90 37 s, none of 28 gaps under 500 ms) where a plan's own
  // node-to-node step costs ~10 ms. So the text asks for one job carried through in a single pass, and it still
  // prescribes no tool and no ordered steps: the two halves are asserted together, because a prompt that bought
  // the unit by naming the route would hide the observation defects this scenario exists to expose.
  const openingTask = extractOpeningTaskPrompt(RUNNER_SOURCE);
  assert.match(openingTask, /把今天这一摊活当成一整件事/);
  assert.match(openingTask, /take today's work as one whole job/);
  assert.match(openingTask, /其余怎么排开由系统来/);
  assert.match(openingTask, /how it gets laid out is up to the system/);
  // The retired framing is the falsifier: "do as many things as you can" is what made every step its own turn.
  assert.doesNotMatch(openingTask, /能做几件做几件/);
  assert.doesNotMatch(openingTask, /as many things as you can/);
  for (const toolName of ["stardew_", "observe_scene", "move_to_tile", "submit_action_program", "programId"])
    assert.ok(!openingTask.includes(toolName), `the opening task must not name the tool surface: ${toolName}`);
  for (const routeWord of [
    "按顺序",
    "依次",
    "第一步",
    "第二步",
    "然后调用",
    "先检查",
    "先观察",
    "in this order",
    "step by step",
    "step 1",
    "first call",
    "then call",
  ])
    assert.ok(!openingTask.includes(routeWord), `the opening task must not prescribe the route: ${routeWord}`);
});

test("the program tool's description says it carries the moves and that the Mod advances them", () => {
  // Evidence: the description said what the tool was FOR, but not what it CARRIES. Runs therefore answered their
  // task step by step, paying a model round-trip between steps. The description is presented material, so it is
  // asserted where it is authored - and its load-bearing rules are pinned beside the new sentences so buying the
  // unit cannot cost the advertised-surface rule or the bounded-refusal contract.
  const description = extractProgramToolDescription(HOST_MATERIALIZER_SOURCE);
  // WHICH TOOL CARRIES THE UNIT, measured 2026-11-01 (`round18`): `plan_work` took 75 submissions and this tool took
  // ZERO. The three sentences that state the unit used to be here, and the two descriptions competed on the same scenario
  // until the example was removed - so the unit is now asserted on the tool the companion actually uses, and this one is
  // asserted to be what it is: a pre-compiled AST for a caller who already has one.
  assert.match(description, /pre-compiled action program/);
  assert.match(description, /stardew_plan_work/);
  assert.doesNotMatch(description, /the plan and the moves that carry it out travel together/);
  // The rules the OLD description carried, re-anchored to what the new one says instead of dropped. Each is a
  // constraint a caller can be refused by, so none of them may leave the presented surface:
  //   - the action set is the advertised one (a program naming anything else is refused);
  //   - a refused candidate has no side effects;
  //   - nodes carry no deadline, because the Mod derives each action's budget from its own watchdog.
  assert.match(description, /must be currently advertised/);
  assert.match(description, /refused candidate has no side effects/);
  assert.match(description, /Nodes carry no deadline/);
  assert.match(description, /watchdog/);
  // No embedded JSON tree: that example is what made this tool look like the answer to "walk somewhere then act",
  // and `round18` measured zero uses after it was removed. Pinned as an ABSENCE so it cannot be re-added casually.
  assert.doesNotMatch(description, /"programId":/);
});

test("the fact log keeps receipt evidence so observed events can be derived", () => {
  // The interaction gate decides whether the companion may narrate an NPC
  // reaction from what the receipts actually prove (showed_response). The fact
  // log used to keep only type/reason/request/execution, so that evidence was
  // unreachable and every NPC-reaction line was failed as unobserved. The first
  // live run after adding the gate proved it: gift_given had showed_response=false
  // recorded, yet the gate could not see it either way.
  assert.match(RUNNER_SOURCE, /evidence: fact\.payload\?\.evidence \?\? null/);
  assert.match(RUNNER_SOURCE, /offerReceipt\.evidence\.showed_response === true/);
});

test("the run records chunked-presentation evidence so the presence mechanism is measured", () => {
  // The mechanism-A design requires measurable TTFB and piece granularity, not
  // just a pass/blocked verdict: the runner records every committed
  // companion_text piece in arrival order and the first piece's elapsed time
  // from the real turn boundary.
  assert.match(RUNNER_SOURCE, /const presentationPieces = \[\]/);
  assert.match(RUNNER_SOURCE, /AGENT_PRESENTATION_PIECE/);
  assert.match(RUNNER_SOURCE, /turnStartedAtMs = Date\.now\(\)/);
  assert.match(RUNNER_SOURCE, /firstPieceTtfbMs/);
  // Computed in the ONE place a result is assembled (buildRunResult), so the crashed path reports it too: this used to
  // be a local of the success path, and the failure literal computed it a second time.
  // ONE derivation, made before the verdict because the verdict reads it: a run whose own piece count disagrees with
  // its account cannot be `passed`, and the bundle publishes the object the clause was decided on.
  assert.match(RUNNER_SOURCE, /const presentationEvidence = summarizePresentationEvidence\(\);/u);
  assert.match(RUNNER_SOURCE, /presentation: presentationEvidence,/u);
  assert.match(RUNNER_SOURCE, /deliveryAccountClause\(presentationEvidence\.deliveryAccount\)/u);
  assert.doesNotMatch(RUNNER_SOURCE, /presentation: summarizePresentationEvidence\(\),/u);
  // Stall facts are read off the SAME mirrored Host log, through the parser that owns the cap: until this field the
  // bundle carried no trace of an execution that stopped making progress (MEASURED 2026-11-09 round44: ten stall facts
  // existed in the Host's own log and `presentation` named none of them).
  assert.match(RUNNER_SOURCE, /readStallWatch,/u);
  assert.match(RUNNER_SOURCE, /const stallWatch = readStallWatch\(hostLog\);/u);
  assert.match(RUNNER_SOURCE, /stallWatch,/u);
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /EXECUTION_STALL /u,
    "the runner does not parse the line itself: the prefix and the cap live in tools/lib/presentation-delivery-account.mjs",
  );
  // Recorded before the single-shot voice gate: chunk evidence must not depend
  // on voice being enabled or on a piece being the first one.
  assert.doesNotMatch(RUNNER_SOURCE, /if \(voiceStarted \|\| typeof text/);
});

test("the run computes the deterministic claim-fulfillability presence projection", () => {
  // Mechanism-B / audit-dimension §3: spoken promises are compared against the
  // same-turn receipts and the live capability face. The vocabulary is scenario
  // data; the parser applies the first-person guardrail.
  assert.match(
    RUNNER_SOURCE,
    /import \{ buildPresenceProjection \} from "\.\.\/\..\/lib\/stardew-companion-presence-projection\.mjs"/,
  );
  assert.match(RUNNER_SOURCE, /PRESENCE_ACTION_VOCABULARY/);
  assert.match(RUNNER_SOURCE, /const presenceProjection =\n    presentationPieces\.length > 0/);
  assert.match(RUNNER_SOURCE, /visibleActionIds/);
  assert.match(RUNNER_SOURCE, /presenceProjection,/);
});
test("a run whose multi-day assessment is blocked cannot report a completed session", () => {
  // The falsifier, written before the change: runs of the 2026-10-21 corpus published
  // `sessionVerdict: "completed"` while `multiday.completed` was false and the assessment said `blocked`.
  // One run cannot both have completed and have been blocked, so the verdict is DERIVED from the
  // assessment (one control flow, `completed` as the residual) rather than computed beside it.
  const [, deriveSessionVerdict] = extractRunnerFunction(RUNNER_SOURCE, ["taskPurposeVerdict", "deriveSessionVerdict"]);
  const healthy = {
    worldStallReason: null,
    sessionTurns: [{}],
    unsettledTurns: [],
    turnFailureReason: undefined,
    bridgeDisconnections: [],
    sessionSpoken: true,
    accomplishedActionIds: ["harvest_crop"],
    taskPurposes: [],
    multidayAssessment: null,
  };
  assert.equal(deriveSessionVerdict(healthy), "completed");
  assert.equal(deriveSessionVerdict({ ...healthy, multidayAssessment: { state: "passed", ok: true } }), "completed");
  for (const assessment of [
    // The exact shape the blocked corpus runs carried: no night terminal, no farm work, one crossing.
    { ok: false, state: "blocked", violations: [{ code: "next_day_produced_no_farm_work", where: "dayRecords[0]" }] },
    { ok: false, state: "blocked", violations: [] },
    { ok: null, state: "unobserved" },
  ])
    assert.equal(
      deriveSessionVerdict({ ...healthy, multidayAssessment: assessment }),
      "multiday_routine_blocked",
      `a ${String(assessment.state)} assessment must not publish a completed session`,
    );
  // The arms that already named a fault still win, so the assessment never masks a cause that says itself.
  assert.equal(
    deriveSessionVerdict({
      ...healthy,
      turnFailureReason: "provider_error",
      multidayAssessment: { ok: false, state: "blocked" },
    }),
    "turn_failed",
  );
  assert.equal(
    deriveSessionVerdict({
      ...healthy,
      bridgeDisconnections: [{}],
      multidayAssessment: { ok: false, state: "blocked" },
    }),
    "bridge_disconnected",
  );
  // `completed` is minted in exactly one place, as the function's RESIDUAL: there is no second site
  // that could decide it beside the assessment.
  assert.equal((deriveSessionVerdict.source.match(/"completed"/gu) ?? []).length, 1);
  assert.match(deriveSessionVerdict.source, /return "completed";\n\}$/);
  assert.ok(
    deriveSessionVerdict.source.indexOf('"multiday_routine_blocked"') <
      deriveSessionVerdict.source.indexOf('"completed"'),
    "the assessment must be read before the residual verdict is reached",
  );
  // The published verdict is this one derivation's return, not a chain computed beside it.
  assert.match(RUNNER_SOURCE, /const sessionVerdict = deriveSessionVerdict\(\{/);
  // And the scenario's own clause reads that verdict instead of re-deciding the assessment beside it.
  const multidayClause = RUNNER_SOURCE.slice(
    RUNNER_SOURCE.indexOf("const multidayRoutinePassed ="),
    RUNNER_SOURCE.indexOf("const capabilityAudit ="),
  );
  assert.match(multidayClause, /sessionVerdict === "completed"/);
  assert.doesNotMatch(
    multidayClause,
    /multidayOutcome\?\.assessment/,
    "a second decision on the assessment is how a completed session published beside a blocked baseline",
  );
});

test("a session that did work cannot report `completed` for a task whose purpose was not achieved", () => {
  // The measured false positive: a `go_mining` day declared `[travel, enter_mine, break_rock]`, broke rocks on the
  // surface, and the run was counted as having done the task because the work list was non-empty. The task's own
  // criterion (`task-purpose.mjs`) now decides it, and the verdict is where that decision becomes the run's outcome.
  const [, deriveSessionVerdict] = extractRunnerFunction(RUNNER_SOURCE, ["taskPurposeVerdict", "deriveSessionVerdict"]);
  const worked = {
    worldStallReason: null,
    sessionTurns: [{}],
    unsettledTurns: [],
    turnFailureReason: undefined,
    bridgeDisconnections: [],
    sessionSpoken: true,
    accomplishedActionIds: ["break_rock"],
    taskPurposes: [],
    multidayAssessment: null,
  };
  // No named task (every scenario but the multi-day routine): the session is judged on itself, and says so.
  assert.equal(deriveSessionVerdict(worked), "completed");
  assert.equal(
    deriveSessionVerdict({
      ...worked,
      taskPurposes: [{ day: 1, task: "mine_delve", state: "achieved" }],
    }),
    "completed",
    "the purpose was achieved by its own criterion, so the session completed",
  );
  assert.equal(
    deriveSessionVerdict({
      ...worked,
      taskPurposes: [{ day: 1, task: "mine_delve", state: "not_achieved" }],
    }),
    "task_not_achieved",
    "break_rock succeeded and the rock was on the surface: real work, unmet purpose",
  );
  // UNPROVEN IS NOT A FAILED DAY, AND IT IS NOT A PASS EITHER.
  //
  // A task whose criterion is missing because a FACT we publish is missing is not a failure of the companion, so it is
  // not charged as `task_not_achieved` - but it is also not "exercised": nothing in this run established that the task
  // happened. Measured 2026-11-07 (`round39`): all three days of `clear_and_plant_long_patch` came out `unproven`, and
  // this arm answered `completed` for all three, so the artifact claimed a completed session on a task whose plot could
  // not be located. The code names the criterion and its own reason, which is what keeps our gap visible instead of
  // silent.
  assert.equal(
    deriveSessionVerdict({
      ...worked,
      taskPurposes: [
        {
          day: 1,
          task: "clear_east_patch",
          taskId: "clear_east_patch",
          state: "unproven",
          reasonCode: "task_purpose_needs_an_unpublished_fact",
          missingFact: "no farm-region fact",
        },
      ],
    }),
    "task_unproven:clear_east_patch:task_purpose_needs_an_unpublished_fact",
    "an undecidable criterion is a verdict that names the criterion and the missing fact's own code, never `completed`",
  );
  assert.equal(
    deriveSessionVerdict({
      ...worked,
      taskPurposes: [{ day: 1, task: "mine_delve", state: "not_achieved" }],
    }),
    "task_not_achieved",
    "while a purpose with evidence against it still decides the day",
  );
  // One unachieved day among several is enough: a run is not accomplished by the days that went well.
  assert.equal(
    deriveSessionVerdict({
      ...worked,
      taskPurposes: [
        { day: 1, task: "mine_delve", state: "achieved" },
        { day: 2, task: "store_and_sort", state: "not_achieved" },
      ],
    }),
    "task_not_achieved",
  );
  // And a session that did nothing is still `nothing_accomplished`: the purpose arms do not replace that answer.
  assert.equal(
    deriveSessionVerdict({
      ...worked,
      accomplishedActionIds: [],
      taskPurposes: [{ day: 1, task: "mine_delve", state: "not_achieved" }],
    }),
    "nothing_accomplished",
  );
  // The runner passes what it judged: a verdict that reads a list nobody fills would be green for ever.
  const verdictCall = RUNNER_SOURCE.slice(
    RUNNER_SOURCE.indexOf("const sessionVerdict = deriveSessionVerdict({"),
    RUNNER_SOURCE.indexOf("\n  );\n  const morningRoutinePassed"),
  );
  assert.match(verdictCall, /^    taskPurposes,$/m, "the verdict is handed the judged purposes");
  assert.match(
    RUNNER_SOURCE,
    /^    taskPurposes,$/m,
    "the judged purposes are published beside the work they were judged against",
  );
  assert.match(RUNNER_SOURCE, /taskPurposes\.push\(\n\s+Object\.freeze\(\{ day, task: dayTask,/);
});

test("every task the rotation asks for is a task the prompt table can state", () => {
  // The table is read BY KEY, so its keys are the population it must cover. Measured: the rotation asks for
  // `mine_delve`/`town_market`/`town_visit` while the English table carried `go_mining` and `town_errand`, so those
  // days were handed the literal string "undefined" and the run measured a task nobody had written. A criterion for a
  // task that was never stated decides nothing.
  const promptTableBody = (name) => {
    const start = RUNNER_SOURCE.indexOf(`const ${name} = Object.freeze({`);
    const end = RUNNER_SOURCE.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start, `${name} must be declared as one literal table`);
    return RUNNER_SOURCE.slice(start, end);
  };
  const keysOf = (body) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)].map((match) => match[1]);
  // The sweep tasks' sentences are owned by the task definitions, because they are derived from the published
  // surface. So the table's population is its own literal keys PLUS the locale the runner spreads in: reading only
  // the literals would report every sweep task as unstateable, and reading only the spread would stop noticing a
  // literal key that no run asks for. Both halves are checked, and the spread itself is asserted so a task cannot
  // be "stated" by the library while the runner quietly drops it from the note.
  const sweepPrompts = sweepTaskPrompts();
  const drifting = [];
  for (const [name, locale] of [
    ["DAILY_TASK_PROMPT_ZH", "zh"],
    ["DAILY_TASK_PROMPT_EN", "en"],
  ]) {
    const body = promptTableBody(name);
    assert.match(
      body,
      new RegExp(`\\.\\.\\.sweepTaskPrompts\\(\\)\\.${locale}`, "u"),
      `${name} must spread the sweep tasks' prompts in`,
    );
    const keys = new Set([...keysOf(body), ...Object.keys(sweepPrompts[locale])]);
    for (const task of DAILY_TASK_ROTATION) if (!keys.has(task)) drifting.push(`${name} cannot state ${task}`);
    for (const key of keys)
      if (!DAILY_TASK_ROTATION.includes(key)) drifting.push(`${name} names ${key}, which no run asks for`);
  }
  assert.deepEqual(drifting, [], drifting.join("; "));
});

test("morning_routine is a self-directed session whose output is a capability audit", () => {
  // The scenario's question is "what could the companion actually do, and where did
  // the system stop it" — so the prompt must be an OPEN goal (no tool list, no
  // coordinates, no call budget), the session must be able to span more than one
  // player turn, and the verdict must rest on a real attempt rather than on an
  // expected receipt.
  // The one derivation the assertions below read, extracted so they test its ORDER and not one spelling of it.
  const deriveSessionVerdictSource = extractRunnerFunction(RUNNER_SOURCE, "deriveSessionVerdict").source;
  assert.match(RUNNER_SOURCE, /morning_routine: Object\.freeze\(\{\n    zh: `现在是星露谷春季的早晨/);
  assert.match(RUNNER_SOURCE, /en: `It is a spring morning in Stardew Valley/);
  assert.match(RUNNER_SOURCE, /const SESSION_GOALS = \(process\.env\.GAMEBUDDY_AGENT_SESSION_GOALS \?\? ""\)/);
  assert.match(
    RUNNER_SOURCE,
    /if \(SCENARIO === "morning_routine"\) \{\n\s+for \(const \[index, goal\] of SESSION_GOALS\.entries\(\)\)/,
  );
  assert.match(
    RUNNER_SOURCE,
    /const morningRoutinePassed =\n    SCENARIO === "morning_routine"\n      \? sessionTurns\.length > 0 && attemptedActionIds\.length > 0 && sessionVerdict === "completed"\n      : true;/,
  );
  // The audit must read the run's OWN advertised surface, never a build-time
  // table that could drift from the snapshot the Agent actually saw.
  assert.match(RUNNER_SOURCE, /visibleActionIds: \[\.\.\.advertisedActionSamples\]/);
  // Sampled while the session runs: the post-run snapshot is empty in practice,
  // which silently emptied the "capability it never used" axis on the first run.
  assert.match(RUNNER_SOURCE, /function sampleAdvertisedActions\(\) \{/);
  assert.match(
    RUNNER_SOURCE,
    /SCENARIO === "morning_routine"\n      \? buildCapabilityAudit\(\{\n          actionTrace,/,
  );
  assert.match(RUNNER_SOURCE, /capabilityAudit,/);
  const clauseList = rungClauseList(RUNNER_SOURCE);
  for (const clause of [
    "passed: morningRoutinePassed",
    "passed: memoryCovenantPassed",
    "passed: npcSocialAndPresencePassed",
  ])
    assert.ok(clauseList.includes(clause), `the verdict must depend on the scenario's own clause (${clause})`);
  // A session cut off mid-turn must not be reported as a completed session: the first
  // real run of this rung passed on a 609s `agent_turn_timeout` while the companion had
  // emitted a 10-character fragment and never delivered its closing report.
  assert.match(RUNNER_SOURCE, /const sessionVerdict = deriveSessionVerdict\(\{/);
  assert.match(deriveSessionVerdictSource, /return "turn_timeout";/);
  assert.match(RUNNER_SOURCE, /sessionVerdict === "completed"/);
  // The per-turn errors are published, and a provider failure counts as one: the turn WAS
  // delivered (so it is not `unsettled`) and produced no text (so it is not silence). A real run
  // reported exactly such a failure as `silent` with an empty error list.
  assert.match(RUNNER_SOURCE, /^    sessionTurnErrors,$/m);
  assert.match(RUNNER_SOURCE, /agentTurnOutcome,/);
  // Run H attempted 14 actions, got 14 refusals and one successful walk, harvested
  // nothing, and still passed: a session that only moved/looked/equipped must not be
  // reported as a played session.
  assert.match(RUNNER_SOURCE, /const NON_ACCOMPLISHMENT_ACTIONS = Object\.freeze\(/);
  // One derivation of the three lists: the verdict and the builder both read it (summarizeDispatchedActions), and it
  // reads BOTH channels of an execution - the flat frames and the program journal - because a run whose work all went
  // through Body Programs has an empty `actionTrace` and used to be summarised as having done nothing.
  assert.match(
    RUNNER_SOURCE,
    /accomplished: succeeded\.filter\(\(actionId\) => !NON_ACCOMPLISHMENT_ACTIONS\.has\(actionId\)\),/,
  );
  assert.match(
    RUNNER_SOURCE,
    /const sessionDispatch = summarizeDispatchedActions\(actionTrace, programOutcomesAtTeardown \?\? \[\], programSubmissions\);/,
    "the session's own summary is read from the flat trace AND the program record, not the flat trace alone",
  );
  assert.match(RUNNER_SOURCE, /return "nothing_accomplished";/);
  // Run M did 17 native actions over fifteen minutes and never said a word to the player:
  // a play session that never speaks must not pass as a companion session.
  // The binding is `sessionSpoken` since a sibling commit renamed it (`ff938c3a`), and the verdict states silence as
  // the RESIDUAL arm of its one derivation rather than as a `?` branch. Both assertions keep their intent: the binding
  // is declared, it is read by the verdict, and a session that never spoke is its own outcome - so this stays a test of
  // the rule rather than of one spelling of it.
  assert.match(RUNNER_SOURCE, /const spokeToPlayer = typeof presentedSummary === "string"/);
  assert.match(deriveSessionVerdictSource, /return "silent";/);
  // The run reports BOTH: what the companion said, and whether that counts for this scenario's verdict.
  assert.match(RUNNER_SOURCE, /const sessionSpoken = SCENARIO !== "morning_routine" \|\| spokeToPlayer;/);
  assert.match(RUNNER_SOURCE, /spokeToPlayer,/);
  // The failure path must never be the thing that crashes: run N played twelve actions and wrote
  // NO artifact because the catch block read a try-scoped binding, losing both the artifact and
  // the root error. It must also never publish LESS than the run knows: `g149tool` did 184 s of work and left a
  // seven-field stub, so an escaped error is now assembled by the same builder every other exit uses.
  assert.match(RUNNER_SOURCE, /async function writeFailureDump\(reason\)/);
  assert.match(RUNNER_SOURCE, /process\.once\("uncaughtException"/);
  assert.match(RUNNER_SOURCE, /process\.once\("unhandledRejection"/);
  // The floor exists for a failure before the run's record exists, and it names itself instead of posing as a result.
  assert.match(RUNNER_SOURCE, /reason: "failure_dump_assembly_failed"/);
  assert.doesNotMatch(RUNNER_SOURCE, /reason: "runner_failed_before_reporting"/);
  assert.match(RUNNER_SOURCE, /console\.error\(error\);/);
  // The catch must not read a binding that only the try can see.
  // The catch used the OPTIONAL-CHAINED form (a try-scoped name); the try legitimately reports
  // personaWorldBook.model, so the assertion targets the optional-chained form precisely.
  assert.doesNotMatch(RUNNER_SOURCE, /runManifestModel: personaWorldBook\?\.model/);
  assert.match(RUNNER_SOURCE, /runManifestModel: null,/);
  // ORDER, not mere presence: `sessionSpoken`/`spokeToPlayer` are read by the verdict, so they must
  // be declared before it (they were read through a temporal dead zone, which also ended a run
  // before it could report).
  const positionOf = (needle) => {
    const at = RUNNER_SOURCE.indexOf(needle);
    assert.ok(at >= 0, `runner must contain: ${needle}`);
    return at;
  };
  // ORDER, and the order IS the fix: a failed turn is decided BEFORE silence, so a provider failure
  // can never again be reported as the companion choosing to stay quiet.
  assert.ok(
    deriveSessionVerdictSource.indexOf('return "turn_failed";') <
      deriveSessionVerdictSource.indexOf('return "silent";'),
    "turn_failed must be decided before silent",
  );
  assert.ok(
    positionOf("const spokeToPlayer = typeof presentedSummary") < positionOf("const sessionVerdict ="),
    "spokeToPlayer is read by the verdict, so it must be declared first",
  );
  assert.ok(
    positionOf('const sessionSpoken = SCENARIO !== "morning_routine"') < positionOf("const sessionVerdict ="),
    "sessionSpoken is read by the verdict, so it must be declared first",
  );
  assert.match(RUNNER_SOURCE, /accomplishedActionIds,/);
  for (const actionId of [
    "move_to_tile",
    "travel",
    "enter_exit",
    "navigate_to_destination",
    "observe_scene",
    "inspect_world_map",
    "express_emote",
    "face_direction",
    "equip_tool",
  ]) {
    assert.match(
      RUNNER_SOURCE,
      new RegExp(`NON_ACCOMPLISHMENT_ACTIONS = Object\\.freeze\\([^)]*"${actionId}"`),
      `${actionId} changes nothing in the world and must not count as accomplishment`,
    );
  }
  // A self-directed session gets a play-session budget (a harness bound, not a product verdict). A multi-day
  // run needs it for the same reason: its days are ordinary self-directed sessions.
  assert.match(
    RUNNER_SOURCE,
    /process\.env\.GAMEBUDDY_AGENT_WAIT_SECONDS \?\?\n?\s*\(SCENARIO === "morning_routine" \|\| SCENARIO === "multiday_routine" \? 1800 : 600\),/,
  );
  // An open goal must not smuggle a tool sequence back in. The retired rungs' prompts did exactly that (named
  // tools, ordered steps), so the check is over every scenario prompt.
  assert.doesNotMatch(RUNNER_SOURCE, /SCENARIO_PROMPTS[\s\S]{0,2000}先检查（inspect）/);
  assert.doesNotMatch(RUNNER_SOURCE, /SCENARIO_PROMPTS[\s\S]{0,2000}先观察 observe/);
  assert.doesNotMatch(RUNNER_SOURCE, /SCENARIO_PROMPTS[\s\S]{0,2000}equip_tool 然后/);
  assert.doesNotMatch(RUNNER_SOURCE, /请严格按以下顺序/);
  assert.doesNotMatch(RUNNER_SOURCE, /Complete in this order/);

  // Behavioural check of the audit itself: the REAL function is extracted and run
  // against a synthetic trace, so the projection is tested rather than described.
  // Order follows the array: the helper first (it is what the audit calls), the audit second.
  const [, buildCapabilityAudit] = extractRunnerFunction(RUNNER_SOURCE, [
    "summarizeExecutionOutcomes",
    "buildCapabilityAudit",
  ]);
  const audit = buildCapabilityAudit({
    actionTrace: [
      { action: "move_to_tile", requestId: "r-move", state: "accepted", reasonCode: "accepted" },
      { action: "cut_weeds", requestId: "r-weed", state: "rejected", reasonCode: "target_out_of_range" },
      { action: "cut_weeds", requestId: "r-weed", state: "rejected", reasonCode: "target_out_of_range" },
      { action: "observe_scene", requestId: "r-observe" },
      { requestId: "r-noaction", args: { x: 1 }, state: "accepted" },
    ],
    facts: [
      { type: "execution_receipt", requestId: "r-move", executionId: "e-move", reasonCode: "target_reached" },
      { type: "execution_receipt", requestId: "r-move", executionId: "e-move", reasonCode: "target_reached" },
      { type: "execution_receipt", requestId: "r-weed", executionId: "e-weed", reasonCode: "target_out_of_range" },
      { type: "execution_receipt", requestId: "r-nobody", executionId: "e-orphan", reasonCode: "target_reached" },
    ],
    visibleActionIds: ["move_to_tile", "cut_weeds", "harvest_crop", "ship_item"],
    sessionTurns: [{ goalIndex: 0 }, { goalIndex: 1 }],
    terminalReasonCodes: { move_to_tile: "target_reached", cut_weeds: "weeds_cut" },
  });
  assert.equal(audit.schema, "gamebuddy_stardew_play_session_capability_audit/v1");
  assert.equal(audit.sessionTurnCount, 2);
  assert.equal(audit.attemptedCount, 3, "entries without an action id are not attempts");
  assert.equal(audit.succeededCount, 1, "only the registered terminal counts as success");
  assert.deepEqual(
    audit.blockedBySystem.map((entry) => entry.actionId),
    ["cut_weeds"],
    "a refusal or terminal failure is the stall an audit reader must attribute",
  );
  assert.deepEqual(
    audit.unresolved,
    ["observe_scene"],
    "an action with no terminal and no refusal is a reported gap, never a claimed stall",
  );
  const move = audit.attempts.find((entry) => entry.actionId === "move_to_tile");
  assert.equal(move.verdict, "succeeded");
  assert.equal(move.terminalReceipts, 1, "a redelivered receipt is one terminal, not two");
  assert.equal(move.admissionStates.accepted, 1, "an admission is recorded, not counted as failure");
  const weeds = audit.attempts.find((entry) => entry.actionId === "cut_weeds");
  assert.deepEqual(weeds.rejections, { target_out_of_range: 2 });
  assert.deepEqual(
    weeds.receiptReasonCodes,
    { target_out_of_range: 1 },
    "a progress receipt is recorded but never counted as a refusal",
  );
  assert.equal(weeds.progressReceipts, 1);
  assert.deepEqual(
    audit.notAttempted,
    ["harvest_crop", "ship_item"],
    "available capability the session never touched must be named",
  );
  assert.equal(audit.advertisedCount, 4);
});

test("a repeat run joins the stored continuity instead of being refused by it", () => {
  // A runtime root's manifest pins the principal that provisioned it and REFUSES
  // any later launch with a different continuity id. Minting a fresh id per run
  // therefore made the second run on a real root fail with
  // `runtime_root_principal_mismatch` — the opposite of what a live run is for.
  assert.match(RUNNER_SOURCE, /const storedContinuityId = \(\(\) => \{/);
  assert.match(RUNNER_SOURCE, /manifest\?\.principal\?\.continuityId/);
  assert.match(
    RUNNER_SOURCE,
    /process\.env\.GAMEBUDDY_COMPANION_CONTINUITY_ID \?\? storedContinuityId \?\? `native-agent-\$\{Date\.now\(\)\}`/,
  );
  // The environment still wins, so a deliberate new identity stays possible.
  assert.match(RUNNER_SOURCE, /if \(!usesConfiguredRuntimeRoot\) return null;/);
});

test("a disposable root's identity belongs to its own run, so a lane can be run twice", () => {
  // Measured live 2026-10-16: the continuity was derived from the bridge scope alone, so every run of one lane
  // carried the SAME identity. The first run wrote a manifest with it; the second refused its OWN root with
  // `runtime_root_principal_mismatch`, naming the same continuity id on both sides of the comparison.
  // A disposable root does not exist until the run creates it, so the run owns the principal — and the identity
  // has to be derived from THAT fact, before the principal check reads it.
  const decision = RUNNER_SOURCE.indexOf("const usesConfiguredRuntimeRoot =");
  const identity = RUNNER_SOURCE.indexOf("const runContinuityId =");
  const identityUsed = RUNNER_SOURCE.indexOf("const identity = Object.freeze({");
  const principalCheck = RUNNER_SOURCE.indexOf("`runtime_root_principal_mismatch: the runtime root was provisioned");
  assert.ok(decision >= 0 && identity > decision, "the ownership decision must precede the identity");
  assert.ok(
    identityUsed > identity && principalCheck > identityUsed,
    "the principal check must read the derived identity",
  );
  assert.match(RUNNER_SOURCE, /: `native-agent-\$\{config\.PlayerId\}-\$\{config\.CompanionId\}`;/);
  // The scope must not decide the principal any more: that is what made two runs of one lane collide.
  assert.doesNotMatch(RUNNER_SOURCE, /const runContinuityId = usesConfiguredRuntimeRoot[\s\S]{0,200}config\.SaveId/);
});

/**
 * Extracts a named top-level function's exact source text from the runner, so
 * the structure test can run the REAL predicate instead of a paraphrase. The
 * runner module never loads here (top-level live side effects), so the function
 * text is evaluated in isolation; it must therefore be free of closures.
 */
function extractRunnerFunction(source, name, bindings = {}) {
  // An array of names compiles ALL of them into one scope, so a helper that a tested function calls is
  // evaluated with it. Without this, an extracted copy referenced a function that only existed in the
  // runner file and the behavioural test failed for a reason that had nothing to do with the behaviour.
  if (Array.isArray(name)) {
    const parts = name.map((one) => extractRunnerFunction(source, one).source);
    const names = Object.keys(bindings);
    const functions = new Function(...names, `${parts.join("\n")}\nreturn [${name.join(", ")}];`)(
      ...names.map((key) => bindings[key]),
    );
    // Carry each declaration's own text, so a test that reads `.source` of one of several composed functions gets THAT
    // function's declaration instead of `undefined`.
    name.forEach((one, index) =>
      Object.defineProperty(functions[index], "source", { value: parts[index], enumerable: false }),
    );
    return functions;
  }
  const marker = `function ${name}`;
  const declarationAt = source.indexOf(marker);
  assert.ok(declarationAt !== -1, `runner must define ${name}`);
  // The declaration's own `async` modifier is part of it: a slice that started at `function` would drop it, and the
  // body's `await` would no longer parse inside the wrapper.
  const start =
    source.slice(Math.max(0, declarationAt - 6), declarationAt) === "async " ? declarationAt - 6 : declarationAt;
  // The body opens at the first `{` OUTSIDE the parameter list: a destructured
  // parameter (`function f({ a, b })`) makes the obvious "first brace after the
  // name" land inside the signature and truncate the extraction before the body.
  let parenDepth = 0;
  let bodyOpen = -1;
  for (let index = declarationAt + marker.length; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "{" && parenDepth === 0) {
      bodyOpen = index;
      break;
    }
  }
  assert.ok(bodyOpen !== -1, `runner function ${name} must have a body`);
  let depth = 0;
  let end = bodyOpen;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  // Include the signature from the name through the body so the evaluated text is
  // a complete declaration.
  const body = source.slice(start, end);
  // A helper the extracted function calls from ANOTHER module (rather than from the runner file) is handed in as a
  // binding: the tested function then runs against the real implementation instead of throwing a ReferenceError into
  // its own catch block, which answers "the fallback was used" to a question nobody asked.
  const globals = Object.keys(bindings);
  const value = new Function(...globals, `${body}\nreturn ${name};`)(...globals.map((key) => bindings[key]));
  // Carry the declaration text so several declarations can be composed into one scope.
  Object.defineProperty(value, "source", { value: body, enumerable: false });
  return value;
}

test("memory_covenant is judged by receipts, not keywords", () => {
  // design 10.5 class 1 (preference/production covenant): the companion must
  // harvest the real mature strawberries and then honor the standing rule —
  // the protected item must never ship. The judgement must sit on REAL
  // execution receipts (item_shipped evidence carrying item=(O)400), never on
  // transcript text, and the top-level verdict must depend on it.
  assert.match(RUNNER_SOURCE, /memory_covenant: Object\.freeze\(\{\n    \/\/ The standing rule is NOT in this prompt/);
  assert.match(RUNNER_SOURCE, /zh: `今天是星露谷春季的雨天/);
  assert.match(RUNNER_SOURCE, /en: `Today is a rainy Spring day/);
  assert.match(RUNNER_SOURCE, /PROTECTED_COVENANT_ITEM_ID = "\(O\)400";/);
  assert.match(RUNNER_SOURCE, /function findProtectedCovenantShipment\(receipts, protectedItemId\)/);
  assert.match(RUNNER_SOURCE, /receipt\.reasonCode !== "item_shipped"/);
  assert.match(
    RUNNER_SOURCE,
    /const covenantReceipt = findProtectedCovenantShipment\(receipts, PROTECTED_COVENANT_ITEM_ID\);/,
  );
  assert.match(
    RUNNER_SOURCE,
    // Formatting-insensitive: the clause now carries the "absence as pass" marker the verdict-guards gate requires,
    // so its precise wrapping is not what this test is about.
    /const memoryCovenantPassed =[\s\S]{0,240}?covenantPassed && voicePassed[\s\S]{0,300}?true;/,
  );
  // The verdict must depend on the rung's gate; asserting the exact neighbouring
  // operand broke the check whenever another rung was added beside it, so this
  // asserts participation in the state expression instead.
  for (const gate of ["morningRoutinePassed", "memoryCovenantPassed", "npcSocialAndPresencePassed", "contextPassed"])
    assert.ok(RUNNER_SOURCE.includes(`${gate}`), `verdict must depend on ${gate}`);
  assert.match(RUNNER_SOURCE, /covenantReceipt: covenantReceipt \?\? null,/);
  assert.match(RUNNER_SOURCE, /covenantPassed: SCENARIO === "memory_covenant" \? covenantPassed : null,/);
  // ladder-5 prompts are intent-only: goal + the standing covenant, with no
  // tool sequence, no coordinates, and no call-count budgeting (the shared
  // prompt-gate test bans those phrasings from the whole runner, and this rung
  // must not smuggle them back in via its own prompt).
  assert.doesNotMatch(RUNNER_SOURCE, /memory_covenant[\s\S]{0,400}先检查（inspect）/);
  assert.doesNotMatch(RUNNER_SOURCE, /memory_covenant[\s\S]{0,400}先观察 observe/);
  // Ladder 5's standing rule now lives in MEMORY, not in the prompt: the
  // runner seeds the covenant through the management surface (same continuity
  // as the Game runtime), and the prompt only asks the Agent to recall a rule
  // about the strawberries instead of stating what it is.
  assert.match(
    RUNNER_SOURCE,
    /import \{ seedMemoriesViaManagementSurface \} from "\.\.\/memory\/run-memory-live-loop\.mjs";/,
  );
  assert.match(
    RUNNER_SOURCE,
    /if \(SCENARIO === "memory_covenant" && !usesDisposableRoot\) \{\n  const seeded = await seedMemoriesViaManagementSurface\(\{\n    root,\n    deploymentManifestPath: manifestPath,\n    seeds: \["之前商量好的：/,
  );
  assert.match(RUNNER_SOURCE, /covenantSeed = Object\.freeze\(\{\n    durable: seeded\.result\.durable/);
  assert.match(RUNNER_SOURCE, /有没有什么关于这些草莓的规矩/);
  // The prompt no longer states the rule: the seeded memory carries it.
  assert.doesNotMatch(RUNNER_SOURCE, /memory_covenant[\s\S]{0,400}一颗都不要卖掉/);
  assert.doesNotMatch(RUNNER_SOURCE, /memory_covenant[\s\S]{0,400}never sold or sent to the shipping bin/);
  assert.match(RUNNER_SOURCE, /covenantSeed,/);
});

test("the covenant gate fails on a protected ship_item receipt and passes otherwise", () => {
  // Run the runner's OWN predicate (extracted verbatim) against synthetic
  // receipts shaped exactly like the Mod's serialized evidence.
  const findProtectedCovenantShipment = extractRunnerFunction(RUNNER_SOURCE, "findProtectedCovenantShipment");
  const protectedShipment = {
    type: "execution_receipt",
    reasonCode: "item_shipped",
    requestId: "ship-reserved-1",
    executionId: "e-1",
    evidence: {
      detail:
        "location=Farm;target=shipping_bin_0123456789abcdef;bin=71,14;tile=71,14;item=(O)400;slot=2;stack=5;inventory_before=6;inventory_after=1;bin_before=0;bin_after=5;last_item_shipped_matched=true",
    },
  };
  const safeShipment = {
    type: "execution_receipt",
    reasonCode: "item_shipped",
    requestId: "ship-sellable-1",
    executionId: "e-2",
    evidence: {
      detail:
        "location=Farm;target=shipping_bin_0123456789abcdef;bin=71,14;tile=71,14;item=(O)16;slot=1;stack=3;inventory_before=3;inventory_after=0;bin_before=0;bin_after=3;last_item_shipped_matched=true",
    },
  };
  const harvest = {
    type: "execution_receipt",
    reasonCode: "crop_harvested",
    requestId: "harvest-1",
    executionId: "e-3",
    evidence: {
      detail:
        "location=Greenhouse;target=greenhouse_0123456789abcdef;tile=22,10;crop=strawberry;item=(O)400;inventory_before=0;inventory_after=5",
    },
  };
  // A ship_item terminal carrying the protected (O)400 stack is the violation.
  assert.equal(findProtectedCovenantShipment([protectedShipment], "(O)400"), protectedShipment);
  // The same predicate over a shipping-bin entry WITHOUT the protected item
  // (ladder-valid economy action) passes cleanly even when the very same
  // evidence shape carries another item id.
  assert.equal(findProtectedCovenantShipment([safeShipment], "(O)400"), undefined);
  // Harvesting the protected crop is NOT a violation: only the ship terminal
  // reasonCode participates, so the probe cannot be tripped by the evidence
  // item id alone.
  assert.equal(findProtectedCovenantShipment([harvest], "(O)400"), undefined);
  assert.equal(findProtectedCovenantShipment([harvest, safeShipment, protectedShipment], "(O)400"), protectedShipment);
});

test("the player prompt waits for a real admission, and the run reports startup phases", () => {
  // The Host refuses a player message while the integration admission is revoked
  // or the session is closed, and reports that refusal. Submitting once and
  // resolving anyway produced a real artifact that read like "the companion
  // chose to do nothing" (1s turn, revision 0, no receipt): the failure is now a
  // refused admission the harness WAITS out, not a silent no-op.
  assert.match(RUNNER_SOURCE, /import \{ submitPlayerPrompt \} from "\.\.\/core\/player-input-admission\.mjs";/);
  assert.match(RUNNER_SOURCE, /accept: \(promptText, locale\) => tools\.acceptPlayerText\(promptText, locale\)/);
  assert.match(RUNNER_SOURCE, /error: `player_input_refused:/);
  assert.match(RUNNER_SOURCE, /if \(admission\.accepted !== true\)/);
  // Startup phase timings answer "the live run is slow to start" with numbers.
  for (const phase of ["bridgeConnectedMs", "covenantSeedDoneMs", "bindingReadyMs", "runtimeMaterializedMs"]) {
    assert.match(RUNNER_SOURCE, new RegExp(`markPhase\\(\"${phase}\"\\)`), `missing phase mark ${phase}`);
  }
  assert.match(RUNNER_SOURCE, /phaseTimings: Object\.freeze\(\{/);
  // The seed is the dominant cold-start cost, so its own phases must reach the
  // artifact instead of only the total.
  assert.match(RUNNER_SOURCE, /onPhase: \(name, elapsedMs\) => \{/);
  assert.match(RUNNER_SOURCE, /phaseTimings\.marks\[\`seed_\$\{name\}\`\] = elapsedMs;/);
  // Presentation observation is attached for every ladder: gating it to 3/4 let a
  // ladder-5 run whose session DID contain the companion line report
  // presentation.pieces = [] and presentedSummary = "".
  assert.match(RUNNER_SOURCE, /onCompanionTextPresented,\n/);
  assert.doesNotMatch(RUNNER_SOURCE, /SCENARIO === "npc_social_and_presence" \? \{ onCompanionTextPresented \}/);
});

test("the capability audit keeps an execution's terminal failure and cannot read it as success", () => {
  // Regression for two real defects found by auditing a live run:
  //  1. receipts were deduped by executionId alone, so the first code seen (accepted) claimed the
  //     execution and its authoritative terminal failure was dropped — three harvest executions ended in
  //     `target_out_of_reach` while the audit still said `harvest_crop: succeeded` with `unresolved: []`;
  //  2. success was decided by "any terminal receipt", so one success hid the failures beside it.
  const [, buildCapabilityAudit] = extractRunnerFunction(RUNNER_SOURCE, [
    "summarizeExecutionOutcomes",
    "buildCapabilityAudit",
  ]);
  const receipt = (executionId, reasonCode) => ({
    type: "execution_receipt",
    requestId: "r-harvest",
    executionId,
    reasonCode,
  });
  const audit = buildCapabilityAudit({
    actionTrace: [{ action: "harvest_crop", requestId: "r-harvest", state: "accepted", reasonCode: "accepted" }],
    facts: [
      // One execution that failed, one that succeeded.
      receipt("exec-failed", "accepted"),
      receipt("exec-failed", "controller_started"),
      receipt("exec-failed", "target_out_of_reach"),
      // The bridge is allowed to redeliver the SAME pair: that must not count twice.
      receipt("exec-failed", "target_out_of_reach"),
      receipt("exec-ok", "accepted"),
      receipt("exec-ok", "crop_harvested"),
    ],
    visibleActionIds: ["harvest_crop"],
    sessionTurns: [{ goalIndex: 0 }],
    terminalReasonCodes: { harvest_crop: "crop_harvested" },
  });
  const entry = audit.attempts.find((attempt) => attempt.actionId === "harvest_crop");
  assert.equal(entry.executionOutcomes.succeeded, 1);
  assert.equal(entry.executionOutcomes.failed, 1);
  assert.deepEqual(entry.failedTerminalReasonCodes, { target_out_of_reach: 1 });
  // One success next to one failure is NOT success.
  assert.equal(entry.verdict, "partial");
  assert.deepEqual(audit.partialFailures, [
    { actionId: "harvest_crop", failedTerminalReasonCodes: { target_out_of_reach: 1 } },
  ]);
  assert.equal(audit.succeededCount, 0);

  // A failed-only action is a system stall, and its code is visible.
  const failedOnly = buildCapabilityAudit({
    actionTrace: [{ action: "harvest_crop", requestId: "r-harvest", state: "accepted", reasonCode: "accepted" }],
    facts: [receipt("exec-failed", "accepted"), receipt("exec-failed", "target_out_of_reach")],
    visibleActionIds: [],
    sessionTurns: [],
    terminalReasonCodes: { harvest_crop: "crop_harvested" },
  });
  assert.equal(failedOnly.attempts[0].verdict, "failed");
  assert.equal(failedOnly.blockedBySystem.length, 1);
  assert.deepEqual(failedOnly.unresolved, []);
});

test("a turn that ended in a provider failure is a failure, not silence", () => {
  const [agentTurnFailureReason, readAgentTurnOutcome] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["agentTurnFailureReason", "readAgentTurnOutcome"],
    { readFileSync, redactLiveRunText: (value) => value },
  );
  const write = (entries) => {
    const file = join(tmpdir(), `gb-ladder-turn-${randomUUID()}.jsonl`);
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
    return file;
  };
  const assistant = (content, extra) => ({ type: "message", message: { role: "assistant", content, ...extra } });
  // The measured shape: thinking only, then a provider error with zero usage.
  const failed = readAgentTurnOutcome(
    write([
      assistant([{ type: "thinking", thinking: "..." }], { stopReason: "toolUse" }),
      assistant([{ type: "thinking", thinking: "truncated" }], {
        stopReason: "error",
        errorMessage: "unexpected EOF",
        usage: { totalTokens: 0 },
      }),
    ]),
  );
  assert.equal(failed.observed, true);
  assert.equal(failed.producedText, false);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.error, "unexpected EOF");
  assert.equal(agentTurnFailureReason(failed), "provider_error:unexpected EOF");
  // A turn that DID speak and then errored is not this case.
  assert.equal(
    agentTurnFailureReason(
      readAgentTurnOutcome(write([assistant([{ type: "text", text: "我在这儿。" }], { stopReason: "error" })])),
    ),
    undefined,
  );
  // A clean turn is not a failure either.
  assert.equal(
    agentTurnFailureReason(
      readAgentTurnOutcome(write([assistant([{ type: "text", text: "好。" }], { stopReason: "stop" })])),
    ),
    undefined,
  );
  // An unreadable session is `unobserved`, never a fabricated cause.
  const unreadable = readAgentTurnOutcome(join(tmpdir(), "gb-ladder-missing-session.jsonl"));
  assert.deepEqual(unreadable, { observed: false, reason: "session_not_readable" });
  assert.equal(agentTurnFailureReason(unreadable), undefined);
});

/**
 * The tool-timing block - its constants and the functions that read them - evaluated on its own, so a categorization
 * can be tested against a real session record instead of against a regex. The runner module never loads here, so the
 * Host's tool-name table is supplied as a global.
 */
function loadToolTiming(source) {
  const constantsAt = source.indexOf("const TOOL_TIMING_LONGEST_LIMIT");
  const categorizerAt = source.indexOf("function toolTimingCategory", constantsAt);
  assert.ok(constantsAt > 0 && categorizerAt > constantsAt, "the tool-timing block must exist");
  const constants = source.slice(constantsAt, categorizerAt);
  const functions = [
    "toolTimingCategory",
    "emptyCategoryTiming",
    "summarizeCategoryTiming",
    "toolTimingInvariant",
    "readToolTiming",
  ]
    .map((name) => extractRunnerFunction(source, name).source)
    .join("\n");
  return new Function(
    "STARDEW_ACTION_TOOL_NAMES",
    "readFileSync",
    `${constants}\n${functions}\nreturn { TOOL_TIMING_CATEGORIES, toolTimingCategory, toolTimingInvariant, readToolTiming };`,
  )(STARDEW_ACTION_TOOL_NAMES, readFileSync);
}

function writeSessionRecord(names) {
  const file = join(tmpdir(), `gb-ladder-tool-timing-${randomUUID()}.jsonl`);
  const entries = [];
  let atMs = Date.parse("2026-10-22T10:00:00.000Z");
  for (const [index, name] of names.entries()) {
    const id = `call-${index}`;
    atMs += 10;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id, name }] },
    });
    atMs += 20;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "toolResult", toolCallId: id, content: "ok" },
    });
  }
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return file;
}

test("a run with no flat dispatch reports zero, and its plan calls are plan compiles", () => {
  // Measured 2026-10-22 (g143closed): `executionTrace.flat: 0`, no per-action tool on the mounted surface, and
  // `action_dispatch.calls: 45`. A pattern over tool names, or a session record from another run, is how a category
  // publishes work this run never did. The falsifier is the split: ten shape reads and four compiled plans are plan
  // numbers, the read is no category at all, and the flat count stays a measured zero.
  const { readToolTiming } = loadToolTiming(RUNNER_SOURCE);
  const record = writeSessionRecord([
    ...Array.from({ length: 10 }, () => "stardew_plan_shape"),
    ...Array.from({ length: 4 }, () => "stardew_plan_work"),
    "stardew_submit_action_program",
    "stardew_action_program_status",
    "stardew_action_program_events",
    "stardew_observe",
  ]);
  const timing = readToolTiming(record, { executionTraceFlat: 0 });
  assert.equal(timing.byCategory.flat_dispatch.calls, 0);
  assert.equal(timing.byCategory.plan_shape.calls, 10);
  assert.equal(timing.byCategory.plan_compile.calls, 4);
  assert.equal(timing.byCategory.program_submit.calls, 1);
  assert.equal(timing.byCategory.program_status.calls, 2);
  assert.equal(
    Object.values(timing.byCategory).reduce((total, entry) => total + entry.calls, 0),
    17,
    "the read tool is neither a category nor a dispatch",
  );
  assert.equal(timing.invariant.checked, true);
  assert.equal(timing.invariant.ok, true);
  assert.equal(timing.record, record.split(/[\\/]/u).pop(), "the counts name the record they came from");
});

test("a tool-call count above the frames the runner sent is a named violation", () => {
  // The violating direction is the one that lied: 45 dispatches, 0 frames. The other direction is real - the runner
  // dispatches frames of its own (seeds, probes) - and is named as `framesWithoutToolCall` instead of being folded
  // into a category or silently forgiven.
  const { toolTimingInvariant, readToolTiming } = loadToolTiming(RUNNER_SOURCE);
  const overCount = toolTimingInvariant({ calls: 45, frames: 0 });
  assert.equal(overCount.checked, true);
  assert.equal(overCount.ok, false);
  assert.equal(overCount.equal, false);
  assert.equal(overCount.framesWithoutToolCall, 0);
  const runnerFrames = toolTimingInvariant({ calls: 2, frames: 4 });
  assert.equal(runnerFrames.ok, true);
  assert.equal(runnerFrames.equal, false);
  assert.equal(runnerFrames.framesWithoutToolCall, 2);
  // Neither side measured is not a pass.
  assert.equal(toolTimingInvariant({ calls: null, frames: null }).checked, false);
  // The real reader withholds the timings instead of publishing them with a caveat: 1 dispatch against 0 frames is
  // the over-count, and the only numbers published are the disagreement itself.
  const timing = readToolTiming(writeSessionRecord(["stardew_move_to_tile"]), { executionTraceFlat: 0 });
  assert.equal(timing.observed, false);
  assert.equal(timing.reason, "tool_timing_invariant_violated");
  assert.equal(timing.byCategory, null, "a number with a caveat gets quoted; there is no number here");
  assert.equal(timing.longest, null);
  assert.equal(timing.invariant.ok, false);
  assert.equal(timing.invariant.calls, 1, "the disagreement itself is still published");
  assert.equal(timing.invariant.frames, 0);
  assert.ok(timing.record.endsWith(".jsonl"), "the record that disagreed is still named");
});

/** A session record file with `names.length` tool calls, written where the caller says: the binding is a path fact. */
function writeSessionRecordAt(path, names) {
  const entries = [];
  let atMs = Date.parse("2026-10-22T10:00:00.000Z");
  for (const [index, name] of names.entries()) {
    const id = `call-${index}`;
    atMs += 10;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id, name }] },
    });
    atMs += 20;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "toolResult", toolCallId: id, content: "ok" },
    });
  }
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return path;
}

/** The run-scoped session selection, evaluated with the fs readers it uses: its binding is a real directory layout. */
function loadRunSessionSelection(source) {
  const [findRunSessionJsonl] = extractRunnerFunction(source, ["findRunSessionJsonl"], { readdirSync, join });
  return findRunSessionJsonl;
}

/** Every `.jsonl` under a runtime root, newest file name last: what a root-wide "newest wins" reader would pick. */
function newestJsonlUnder(root) {
  const files = [];
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".jsonl")) files.push({ path, file: entry.name });
    }
  };
  collect(root);
  files.sort((left, right) => left.file.localeCompare(right.file));
  return files[files.length - 1];
}

test("a runtime root holding an older, larger session record still yields THIS run's own record", () => {
  // Measured 2026-10-22: two runs launched 38 minutes apart (startedAtMs 1792685338882 and 1792683042038) both
  // published `calls=45, sumMs=47189, frames=0` - one foreign session file chosen by "newest under the runtime
  // root" - and the pair was then quoted as each run's own latency. The falsifier is that same shape: a root whose
  // tempting record is both NEWER and LARGER than this run's, so any root-wide newest/largest rule picks the wrong
  // one, while the run's own surface session directory yields its own counts.
  const runtimeRoot = mkdtempSync(join(tmpdir(), "gb-ladder-session-binding-"));
  const foreignDir = join(runtimeRoot, "contexts", "identity", "surface-sessions", "game_1700000000000", "sessions");
  const ownSessionId = "game_1700005000000";
  const ownDir = join(runtimeRoot, "contexts", "identity", "surface-sessions", ownSessionId, "sessions");
  mkdirSync(foreignDir, { recursive: true });
  mkdirSync(ownDir, { recursive: true });
  const foreign = writeSessionRecordAt(
    join(foreignDir, "2026-11-15T01-44-13-944Z_01a16147-bd77-720f-9bd7-9ff68ebf5b74.jsonl"),
    Array.from({ length: 45 }, () => "stardew_move_to_tile"),
  );
  const own = writeSessionRecordAt(
    join(ownDir, "2026-11-14T22-13-19-944Z_01a16147-2222-720f-9bd7-9ff68ebf5b75.jsonl"),
    ["stardew_move_to_tile", "stardew_move_to_tile"],
  );
  assert.equal(
    newestJsonlUnder(runtimeRoot).path,
    foreign,
    "the fixture must be tempting: the foreign record is what a root-wide newest-wins reader would take",
  );
  const findRunSessionJsonl = loadRunSessionSelection(RUNNER_SOURCE);
  const bound = findRunSessionJsonl(ownDir);
  assert.equal(bound.path, own);
  assert.equal(bound.reason, null);
  const { readToolTiming } = loadToolTiming(RUNNER_SOURCE);
  const timing = readToolTiming(bound.path, {
    executionTraceFlat: 2,
    unboundReason: bound.reason ?? "no_session_record",
  });
  assert.equal(timing.record, own.split(/[\\/]/u).pop(), "the counts name this run's own record");
  assert.equal(timing.byCategory.flat_dispatch.calls, 2, "this run's own count, not the foreign record's 45");
  assert.equal(timing.byCategory.flat_dispatch.sumMs, 40);
  assert.equal(timing.invariant.ok, true, "2 dispatches against 2 frames agrees, so the numbers are publishable");
});

test("a run that cannot bind its own session record publishes no timings, naming the reason", () => {
  // The other half of the same falsifier: when this run's surface session directory is absent, the numbers of a
  // neighbouring run must not stand in. `record: null` and a reason, never another run's 45 calls.
  const runtimeRoot = mkdtempSync(join(tmpdir(), "gb-ladder-session-unbound-"));
  const foreignDir = join(runtimeRoot, "contexts", "identity", "surface-sessions", "game_1700000000000", "sessions");
  mkdirSync(foreignDir, { recursive: true });
  writeSessionRecordAt(
    join(foreignDir, "2026-11-15T01-44-13-944Z_01a16147-bd77-720f-9bd7-9ff68ebf5b74.jsonl"),
    Array.from({ length: 45 }, () => "stardew_move_to_tile"),
  );
  const findRunSessionJsonl = loadRunSessionSelection(RUNNER_SOURCE);
  const unboundDir = join(runtimeRoot, "contexts", "identity", "surface-sessions", "game_1700005000000", "sessions");
  const unbound = findRunSessionJsonl(unboundDir);
  assert.equal(unbound.path, undefined);
  assert.equal(unbound.reason, "no_session_record_for_run_surface_session");
  assert.deepEqual(unbound.searched, [unboundDir], "unobserved must name what it looked at");
  const { readToolTiming } = loadToolTiming(RUNNER_SOURCE);
  const timing = readToolTiming(unbound.path, { executionTraceFlat: 45, unboundReason: unbound.reason });
  assert.equal(timing.observed, false);
  assert.equal(timing.reason, "no_session_record_for_run_surface_session");
  assert.equal(timing.record, null, "no record is named, because none was bound");
  assert.equal(timing.byCategory, null, "another run's 45 calls must not stand in for this one");
  assert.equal(timing.longest, null);
});

/**
 * THE RUN'S COST, ON ITS OWN ROUND TRIPS, PRINTED AND PUBLISHED.
 *
 * Measured `round43`: 96 assistant turns, 29 of them `stardew_action_program_status`, and nothing in that run's artifact
 * said so. The two ratios are derived from populations the run already reads - the bound session record's model turns and
 * plan-tool calls, the programmes the Mod accepted, and the executions that reached a terminal state - so this asserts
 * the REAL reader and the REAL builder together rather than a fixture of the arithmetic.
 *
 * The second half is the zero that must be printed: a run that never polled is the outcome this account exists to
 * reward, and an absent field would read as "nobody looked".
 */
test("every run prints what its model turns were spent on, and a run that never polled prints zero", async () => {
  const { readToolTiming: realToolTiming } = loadToolTiming(RUNNER_SOURCE);
  // Three model turns, no status read: the run that did the thing the account exists to reward.
  const quiet = writeSessionRecord(["stardew_observe", "stardew_observe", "stardew_observe"]);
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    builderGlobals({
      readToolTiming: realToolTiming,
      runSessionRecord: Object.freeze({ path: quiet, reason: null }),
      actionTrace: [
        { action: "move_to_tile", state: "succeeded" },
        { action: "water_crop", state: "succeeded" },
        { action: "plant_seed", state: "rejected" },
      ],
      programSubmissions: [
        { programId: "p1", accepted: true, nodes: [] },
        { programId: "p2", accepted: true, nodes: [] },
        { programId: "p3", accepted: false, nodes: [] },
      ],
    }),
  );
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  let quietRun;
  try {
    quietRun = await buildRunResult({ rungClauses: [], settlement: null });
  } finally {
    console.error = original;
  }
  const line = logged.find(([code]) => code === "RUN_COST_ACCOUNT");
  assert.ok(line !== undefined, `no run cost account was printed; stderr held ${JSON.stringify(logged)}`);
  const printed = JSON.parse(line[2]);
  assert.equal(printed.plan_polls_per_programme, 0, "three observes and no status read is a measured zero");
  assert.equal(printed.plan_polls, 0);
  assert.equal(printed.programmes, 2, "only the accepted submissions are programmes");
  assert.equal(printed.model_turns, 3);
  assert.equal(printed.completed_actions, 3, "every flat dispatch reached a terminal state");
  assert.equal(printed.turns_per_completed_action, 1);
  assert.equal(quietRun.runCost.plan_polls_per_programme, 0, "and the result publishes the same object it printed");
  assert.equal(quietRun.runCost.turns_per_completed_action, 1);
});

test("the assembly logs a tool-timing disagreement by name", async () => {
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    {
      ...instrumentGlobals,
      executedActionIds,
      // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once
      // and hands it to its own clause, so a test of the builder supplies the real implementations.
      measureActionBreadth,
      actionBreadthClause,
      deliveryAccountClause,
      readActionBreadthSurface,
      buildSnapshotCensus,
      snapshotFamilyRows: new Map(),
      snapshotCensusSamples: 0,
      NON_ACCOMPLISHMENT_ACTIONS: new Set(),
      phaseTimings: { runStartedAtMs: 1, marks: {} },
      lastObservedSnapshot: null,
      lastObservedPose: null,
      actionTrace: [],
      programSubmissions: [],
      programOutcomes: [],
      sampleProgramOutcomes: async () => [],
      programExecutionRows,
      executionTraceInvariant,
      TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
      multidayOutcome: null,
      SCENARIO: "morning_routine",
      LEGACY_LADDER: null,
      historianRubricOutcome: null,
      runSessionRecord: Object.freeze({ path: "/tmp/session.jsonl", reason: null }),
      summarizeActionCadence: () => ({ spans: [] }),
      summarizePresentationEvidence: () => NOTHING_PRESENTED,
      // The reader's own answer for a violated invariant, verbatim: this test is about the assembly NAMING the violation
      // and publishing the withheld shape, not about re-reading a record.
      readToolTiming: () => ({
        observed: false,
        reason: "tool_timing_invariant_violated",
        record: "session.jsonl",
        byCategory: null,
        longest: null,
        invariant: { checked: true, ok: false, calls: 45, frames: 0 },
      }),
      summarizeRunCost,
      describeRunCost,
      buildFailureSnapshot: (input) => input,
      writeRunBundle: async () => ({ state: "written", runDir: "/run" }),
      closeCapture: async () => ({ state: "closed" }),
      writeFile: async () => {},
      join: (...parts) => parts.join("/"),
    },
  );
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  let result;
  try {
    result = await buildRunResult({
      state: "blocked",
      error: "agent_turn_timeout",
      settlement: { component: "runner" },
    });
  } finally {
    console.error = original;
  }
  assert.ok(
    logged.some(([code]) => code === "TOOL_TIMING_INVARIANT_VIOLATED"),
    "a category that over-counts is named where the trace invariant is named",
  );
  assert.equal(result.toolTiming.invariant.ok, false, "the result carries the same disagreement");
  assert.equal(
    result.toolTiming.byCategory,
    null,
    "the timings are withheld, not published with a caveat: a number beside a warning gets quoted",
  );
  assert.equal(result.toolTiming.reason, "tool_timing_invariant_violated");
});

test("waitForSessionQuiet reaches quiet when only body_trace pings follow a terminal", async () => {
  // The regression: the first implementation compared a TIMESTAMP against an array index and scanned the whole
  // slice since the turn for any meaningful fact, so 20s of quiet was unreachable whenever a terminal had ever
  // arrived - a live ladder-6 run burned 31 minutes without writing a result. This exercises the real function
  // with the real pattern: a body_trace ping every second plus ONE modal_interrupted, then nothing.
  const source = readFileSync(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function waitForSessionQuiet(");
  const end = source.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0, "the quiet wait must exist");
  const actionTrace = [];
  const factLog = [];
  const build = new Function(
    "actionTrace",
    "factLog",
    "LADDER",
    `return (async () => { ${source.slice(start, end)}; return waitForSessionQuiet; })();`,
  );
  const waitForSessionQuiet = await build(actionTrace, factLog, "6");
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    factLog.push({ type: "semantic_event", reasonCode: "body_trace", evidence: null });
    if (tick === 2)
      factLog.push({ type: "execution_receipt", reasonCode: "modal_interrupted", requestId: "r", executionId: "e" });
  }, 200);
  const turn = {};
  const settled = await waitForSessionQuiet(turn, { dispatchesBeforeTurn: 0, quietMs: 600, timeoutMs: 5_000 });
  clearInterval(timer);
  assert.equal(settled.quieter, true, "a ping-only tail must reach quiet rather than run to the deadline");
});

test("the turn waiter does not give up five seconds after a program finishes", () => {
  // Measured on run g35real: the companion submitted its first real ActionProgram
  // (`AGENT_PROGRAM_SUBMIT farm_day5_b accepted`), the wait loop broke on the PROGRAM's terminal state while the
  // TURN was still running, and the five-second race that used to sit after it declared `agent_turn_timeout` - so a
  // working session was recorded as a timeout, and the binding closed while the program was executing. The loop is
  // the waiter, and the run budget is the hard stop; nothing may turn five seconds of silence into a verdict.
  assert.match(RUNNER_SOURCE, /if \(turn === null\) turn = await agentTurn;/u);
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /error: "agent_turn_timeout"/u,
    "no path may invent a turn timeout from a short race",
  );
  // The verdict mapping still understands an unsettled turn, which is what makes a genuine one visible.
  assert.match(RUNNER_SOURCE, /entry\.error === "agent_turn_timeout"/u);
});

test("a second turn does not answer with the first turn's program", async () => {
  // The turn waiter polls `client.programStatus` for the program THE TURN submitted, and breaks when that program is
  // terminal. The id used to be one run-long module binding written by the submit wrapper and never reset, so turn 2
  // polled turn 1's already-`succeeded` program, broke at second zero - before the `i % 10` block - and the heartbeat
  // stall detector inside that block was blind for every turn after the first. The falsifier is behavioural, against
  // the real function: turn 1 submits and succeeds, turn 2 submits nothing, and the world is silent during turn 2.
  const declaredStallMs = Number(
    /const MOD_HEARTBEAT_STALL_MS = ([\d_]+);/u.exec(RUNNER_SOURCE)[1].replaceAll("_", ""),
  );
  const programSubmissions = [];
  const actionTrace = [];
  const factLog = [];
  const statusQueries = [];
  let heartbeatSilentMs = 0;
  let heartbeatSamples = 0;
  let turnsSubmitted = 0;
  const client = {
    programStatus: async ({ programId }) => {
      statusQueries.push(programId);
      return programId === "p_day1"
        ? { code: "found", snapshot: { programId, state: "succeeded", nodes: [] } }
        : { code: "not_found", snapshot: null };
    },
    state: { snapshot: { revision: 1 } },
  };
  const build = new Function(
    "actionTrace",
    "factLog",
    "programSubmissions",
    "client",
    "presentedSummary",
    "SCENARIO",
    "sampleAdvertisedActions",
    "submitPlayerPrompt",
    "shouldAbandonTurnForTransport",
    "sampleModHeartbeat",
    "MOD_HEARTBEAT_STALL_MS",
    "bridgeDisconnections",
    "waitForSessionQuiet",
    // The turn's own memory instrument: the sampler, the point it builds and the bounded series it appends to. Supplied
    // as real implementations - the turn records what the sampler measured, and a double here would assert the wiring
    // against a number no run produced. (Until they were bound, this eval could not even run the turn: `round40`'s
    // sampler commit referenced a name its own test scope never carried.)
    "sampleHostMemory",
    "appendTurnMemory",
    "turnMemoryPoint",
    `let worldStallReason = null;
let turnStartedAtMs = null;
let agentTurnCount = 0;
const bridgeDiagnostics = [];
const hostMemory = { turns: [], turnsOmitted: 0 };
const runSessionRecord = Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" });
${extractRunnerFunction(RUNNER_SOURCE, "runAgentTurn").source}
return { runAgentTurn, stall: () => worldStallReason, memory: () => hostMemory };`,
  );
  const { runAgentTurn, stall } = build(
    actionTrace,
    factLog,
    programSubmissions,
    client,
    "",
    "memory_covenant",
    () => {},
    // Turn 1 submits and is admitted; turn 2 submits nothing and is admitted. Neither admission waits on the stall
    // detector: a fixture whose completion depended on the very check under test could only ever hang, never fail.
    async () => {
      turnsSubmitted += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (turnsSubmitted === 1) {
        // AFTER the turn's own cursor was taken, because a real submission arrives mid-turn: the wait loop starts as
        // soon as the prompt is admitted and the companion submits only once it has decided what to do.
        programSubmissions.push(Object.freeze({ programId: "p_day1", code: "accepted", accepted: true }));
        return { accepted: true };
      }
      return { accepted: true };
    },
    shouldAbandonTurnForTransport,
    () => {
      heartbeatSamples += 1;
      return { count: 1, sinceMs: 0, line: "DEBUG-native-local-heartbeat", silentMs: heartbeatSilentMs };
    },
    declaredStallMs,
    Object.freeze([]),
    async (turn) => turn,
    // The real instrument, and a sampler whose readings the test can reason about: the turn's record is what is under
    // test here, not the operating system's free memory.
    () => ({ rssMb: 316, freeMb: 2048, heapUsedMb: 208 }),
    appendTurnMemory,
    turnMemoryPoint,
  );
  const previousWaitSeconds = process.env.GAMEBUDDY_AGENT_WAIT_SECONDS;
  process.env.GAMEBUDDY_AGENT_WAIT_SECONDS = "5";
  try {
    const firstTurn = await runAgentTurn("first turn", {});
    assert.deepEqual(statusQueries, ["p_day1"], "turn 1 polls the program turn 1 submitted");
    assert.equal(firstTurn.turn.steerObserved, true, "the fixture's turn 1 did reach the session");
    assert.equal(stall(), null, "a turn whose program succeeded is not a stall");

    heartbeatSilentMs = declaredStallMs + 30_000;
    statusQueries.length = 0;
    const samplesBefore = heartbeatSamples;
    const secondTurn = await runAgentTurn("second turn", {});

    assert.match(
      String(stall()),
      new RegExp(`^world_stopped_advancing:silent_ms=${String(declaredStallMs + 30_000)}:`, "u"),
      "the stall detector must still fire on a turn that submitted nothing",
    );
    assert.ok(heartbeatSamples > samplesBefore, "the detector was consulted during the second turn");
    assert.deepEqual(statusQueries, [], "turn 2 submitted nothing, so it must ask nothing about turn 1's program");
    assert.equal(
      secondTurn.turn.steerObserved,
      false,
      "arrival is judged by what THIS turn did, not by a program an earlier turn submitted",
    );
  } finally {
    if (previousWaitSeconds === undefined) delete process.env.GAMEBUDDY_AGENT_WAIT_SECONDS;
    else process.env.GAMEBUDDY_AGENT_WAIT_SECONDS = previousWaitSeconds;
  }
});

test("the night watcher outlives the day turn it accompanies", () => {
  // Measured on g39home: 78 actions of real farm work, and the watcher's own ten-minute bound expired while the day
  // turn was still running - so the run was recorded as `companion_did_not_sleep:day_turn_still_running`, a verdict
  // about a day that had not finished deciding. The bound must sit past the turn budget it runs alongside.
  assert.match(RUNNER_SOURCE, /const MULTIDAY_NIGHT_TIMEOUT_MS = \(\(\) => \{/u);
  assert.match(RUNNER_SOURCE, /return 31 \* 60 \* 1000;/u);
  assert.match(
    RUNNER_SOURCE,
    /One minute past the 1800s turn budget, so the watcher cannot expire before the turn it accompanies/u,
  );
  // And the honest pair of outcomes still exists: a settled day with no advance_day is named at once.
  assert.match(RUNNER_SOURCE, /companion_did_not_sleep/u);
});

test("a pass-out mid-night is not the night's outcome: the watch runs on to the new day", async () => {
  // Measured (g120): the night watch stopped on `actor_passed_out`, and the run reported `crossings 0/2` for a night
  // the game had already crossed - `Game1.PassOutNewDay()` calls `NewDay(0f)` itself, so the player wakes on the NEXT
  // day. The falsifier is behavioural, against the real function: a faint is not an outcome, a spent budget is.
  const [watchNightThroughPassOut] = extractRunnerFunction(RUNNER_SOURCE, ["watchNightThroughPassOut"]);
  const scripted = (outcomes) => {
    const calls = [];
    return {
      calls,
      watchOnce: async (timeoutMs) => {
        calls.push(timeoutMs);
        return outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      },
    };
  };
  const faint = {
    crossed: false,
    reasonCode: "actor_passed_out",
    menus: [
      {
        menuType: "ShippingMenu",
        decision: "dismiss",
        dismissReceipt: { state: "succeeded", reasonCode: "modal_dismissed" },
        dismissReasonCode: null,
      },
    ],
  };
  const crossed = { crossed: true, reasonCode: null, dayAfter: 7, menus: [] };
  const { calls, watchOnce } = scripted([faint, faint, crossed]);
  const outcome = await watchNightThroughPassOut({
    watchOnce,
    timeoutMs: 60_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(outcome.crossed, true, "the night the engine already crossed is a crossed night");
  assert.equal(outcome.dayAfter, 7);
  assert.equal(outcome.passOutObserved, true, "the record says HOW the night ended");
  assert.equal(calls.length, 3, "the watch was re-entered while the engine held the actor, not ended on the faint");
  // The settlement menu dismissed BEFORE the faint is part of the night's record: the baseline judges the night by it.
  assert.deepEqual(
    (outcome.menus ?? []).map((menu) => menu.menuType),
    ["ShippingMenu"],
    "a menu observed in an earlier attempt is not lost when a later one starts empty",
  );
  // A spent budget while the actor is still out is the named WAIT, never the faint reported as the night's outcome.
  const exhausted = scripted([faint]);
  let clock = 0;
  const spent = await watchNightThroughPassOut({
    watchOnce: exhausted.watchOnce,
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    now: () => clock,
    sleep: async () => {
      clock += 10_000;
    },
  });
  assert.equal(spent.crossed, false);
  assert.equal(spent.reasonCode, "night_not_observed:pass_out:none");
  assert.equal(spent.passOutObserved, true);
  // The retry is for the PASS-OUT only: a cutscene is still a hold, and it is still answered at once.
  const cutscene = scripted([{ crossed: false, reasonCode: "actor_held_by_cutscene", menus: [] }, crossed]);
  const held = await watchNightThroughPassOut({
    watchOnce: cutscene.watchOnce,
    timeoutMs: 60_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(held.reasonCode, "actor_held_by_cutscene");
  assert.equal(held.passOutObserved, false);
  assert.equal(cutscene.calls.length, 1, "a hold that is not the pass-out still stops the watch by name");
  // A single observation that is BOTH the hold and the crossing: `watchRollover` cannot currently produce one (it answers
  // the hold before it looks at the calendar), but the recorder must not depend on that. The hold is a fact about the
  // night, so it is read before either exit - reading it after the `crossed` test made a pass-out that surfaced with the
  // crossing report `sleep`, which is a claim about the companion that nothing measured (2026-10-30: two such nights,
  // both recorded `sleep`, both 02:00 pass-outs with zero `advance_day` dispatches in the entire run).
  const together = await watchNightThroughPassOut({
    watchOnce: scripted([{ crossed: true, reasonCode: "actor_passed_out", dayAfter: 7, menus: [] }]).watchOnce,
    timeoutMs: 60_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(together.crossed, true, "the crossing keeps its own semantics");
  assert.equal(together.passOutObserved, true, "a hold seen on the crossing observation is still a hold");
  // ...and the day's record carries a cause the WITNESSES decide, not a two-valued default.
  //
  // This used to pin the literal `passOutObserved ? "pass_out" : "sleep"`, and the literal is exactly what drifted: its
  // false branch meant "no pass-out was observed" and said "the companion slept". Measured 2026-10-30, both nights of a
  // run were the engine's 2:00 pass-out and both were recorded `sleep`. So the assertion is on the DECISION now - what
  // the record may claim, and from what - because that survives a rewrite of the expression while the defect does not.
  assert.match(RUNNER_SOURCE, /const cause = nightCause\(\{/u, "the cause is decided by the shared witness function");
  assert.match(
    RUNNER_SOURCE,
    /enteredVia: parseReceiptEvidence\(terminal\?\.evidence\)\.entered_via \?\? null,/u,
    "a sleep is claimed only from the lifecycle receipt that proves one",
  );
  // The pass-out witness has TWO sources, and the record must consult both: the watch's own hold while it is still
  // polling, and the Mod's `night_ended_pass_out` event. The second is the one that was missing - a night the engine takes
  // while the watch waits for the calendar returns `crossed: true` on the first attempt, so the poll flag never sets and
  // the night landed on `cause: "engine"` with `passOutNights: 0` (`round28`), which is a verdict blaming the companion
  // for an event it could not count.
  assert.match(
    RUNNER_SOURCE,
    /passOutObserved: outcome\.passOutObserved === true \|\| passOutFactThisNight,/u,
    "the record must count the Mod's pass-out event, not only its own poll",
  );
  // AND IT READS THAT EVENT THROUGH THE ONE READER, not through a second hand-written key test. Measured 2026-11-07
  // (`round39`): the predicate used here matched `entry.kind`/`entry.semanticKind`, while the fact the runner stores is
  // `{ type: "world_fact", worldFactKind: "night_ended_pass_out", worldFactPayload: { eventId: ... } }` - neither key
  // exists, so a night the Mod had published as a pass-out stayed `engine` and the assessment counted `passOutNights: 0`
  // beside the fact that said otherwise. The reader names the minted event id, so the runner and the assessor cannot
  // disagree about the shape.
  assert.match(
    RUNNER_SOURCE,
    /const passOutFactThisNight = worldNightEndingsFromFacts\(factLog\.slice\(factStart\)\)/u,
    "the record must read the Mod's night facts through the shared reader",
  );
  assert.match(NIGHT_FACTS_SOURCE, /\^night_ended_\(\[a-z_\]\+\)_day_\(\\d\+\)\$/u, "and the reader names that event");
  // The two-valued default must not come back: absence of a pass-out is a fact about the poll, not about the night.
  assert.doesNotMatch(RUNNER_SOURCE, /\? "pass_out"\s*:\s*"sleep"/u);
  assert.match(
    RUNNER_SOURCE,
    /record\.cause = night\?\.cause \?\? null;/u,
    "the day's record takes its cause from the night record, which is the one the dialogue gates also read",
  );
});

test("a stalled Mod heartbeat is named while it is happening, not six minutes later", () => {
  // Measured on g40night: the last heartbeat was 19:23:59 (`bridge=connected; rx=552/552`), the last log line at
  // 19:24:01 was a navigation execution starting, and the log then went silent for six minutes until the harness
  // reported a dead pipe. Per-tick heartbeats print on EVERY yielding path (including the ones that pump the bridge),
  // so their absence means the game thread is not reaching the Mod - a different finding from "the companion has not
  // slept", and the one that has silently ended most of the multi-day runs.
  assert.match(RUNNER_SOURCE, /const MOD_HEARTBEAT_STALL_MS = 90_000;/u);
  assert.match(RUNNER_SOURCE, /function sampleModHeartbeat\(\)/u);
  assert.match(RUNNER_SOURCE, /DEBUG-native-local-heartbeat/u);
  // It must be consulted BEFORE the harness's own bound, and say what it saw.
  assert.match(
    RUNNER_SOURCE,
    /if \(liveness\.silentMs >= MOD_HEARTBEAT_STALL_MS\)[\s\S]{0,120}world_stopped_advancing:silent_ms=/u,
  );
  // An unreadable log is not a stall: no evidence must not become a verdict.
  assert.match(RUNNER_SOURCE, /Unreadable is not stalled/u);
});

test("the thread census names which answer it got, and the pid it asked about", () => {
  // Measured on 2026-10-19 (multiday_routine), in that run's own result.json: one stall line carried `game_cpu_s=539`
  // - the process probe beside it had just found the LIVE game - and `game_threads=unavailable` next to it. Three
  // different answers produced that one word (no process, a process with no threads, the query itself failing), so
  // the artifact could not say which, and the reading that mattered - a live game the census could not read - was
  // spelled exactly like a dead one. The real function is driven here against each answer.
  let probe = () => "";
  // The array form is the one that injects globals: the runner's module never loads here, so the probe it calls is
  // supplied by the test.
  const [sampleGameThreads] = extractRunnerFunction(RUNNER_SOURCE, ["sampleGameThreads"], {
    execFileSync: (...args) => probe(...args),
  });
  assert.equal(sampleGameThreads(), "no_game_process", "a missing process is named, not folded into `unavailable`");
  probe = () =>
    JSON.stringify({
      pid: 3124,
      threadCount: 9,
      census: "6xRunning,None|2xWait,UserRequest|1xWait,Unknown",
    });
  assert.equal(sampleGameThreads(), "pid=3124;threads=9;6xRunning,None|2xWait,UserRequest|1xWait,Unknown");
  // A process that exists but has no threads is its own answer: it is NOT a dead game and NOT a failed query.
  probe = () => JSON.stringify({ pid: 3124, threadCount: 0, census: "" });
  assert.equal(sampleGameThreads(), "pid=3124;process_without_threads");
  // A failing query says so, with the reason, because it is no evidence about the world at all.
  probe = () => {
    throw new Error("spawn powershell ENOENT");
  };
  assert.match(sampleGameThreads(), /^probe_unavailable:spawn powershell ENOENT/u);
  probe = () => "no such process";
  assert.match(sampleGameThreads(), /^probe_unavailable:unparseable_output:no such process/u);
  // The runner still PUBLISHES the census in the stall line, so the four answers reach the artifact.
  assert.match(RUNNER_SOURCE, /:game_threads=\$\{threads\}/u);
});

test("a night's terminal is read from the receipt the fact log actually holds", () => {
  // The recorded shape, verbatim from a real run's timeline.jsonl: the entry flattens the receipt's identity
  // (`reasonCode`/`requestId`/`executionId`/`evidence`) and keeps the RECEIPT ITSELF under `worldFactPayload`,
  // where its terminal `state` lives. The readers used to look for `fact.state`, which the projection never
  // writes, so every multi-day night was recorded as `night_terminal_missing` however the Mod's own receipt
  // read. This exercises the runner's real reader against that real shape.
  const [, terminalReceiptFor] = extractRunnerFunction(RUNNER_SOURCE, ["recordedReceipt", "terminalReceiptFor"], {
    TERMINAL_STATES,
  });
  const ADVANCE_EVIDENCE =
    "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;" +
    "saving_observed=true;saved_observed=true;day_started_observed=true;" +
    "day_before=5;days_before=5;day_after=6;days_after=6";
  const advanceReceipt = {
    executionId: "e-advance",
    requestId: "r-advance",
    actionId: "sleep",
    state: "succeeded",
    reasonCode: "day_advanced",
    revision: 12,
    evidence: { detail: ADVANCE_EVIDENCE },
  };
  const recorded = {
    type: "execution_receipt",
    reasonCode: advanceReceipt.reasonCode,
    requestId: advanceReceipt.requestId,
    executionId: advanceReceipt.executionId,
    evidence: advanceReceipt.evidence,
    worldFactPayload: advanceReceipt,
  };
  // A night whose data carries the receipt shape crosses: the totals advance AND the world's calendar agrees.
  const crossed = classifyNight({
    terminal: terminalReceiptFor([recorded], recorded.requestId),
    after: { dayOfMonth: 7, seasonIndex: 0 },
  });
  assert.equal(crossed.advanced, true, `expected a crossed night, got ${String(crossed.reasonCode)}`);
  assert.equal(crossed.dayAfter, 6);
  // A night with NO receipt is named missing, which is the half that keeps the reader from being a constant.
  const missing = classifyNight({
    terminal: terminalReceiptFor([{ type: "semantic_event", requestId: recorded.requestId }], recorded.requestId),
    after: { dayOfMonth: 7, seasonIndex: 0 },
  });
  assert.equal(missing.advanced, false);
  assert.equal(missing.reasonCode, "night_terminal_missing");
  // A receipt that is still IN FLIGHT is not a terminal, and a request that never produced one stays
  // undefined rather than being fabricated.
  const accepted = {
    ...recorded,
    worldFactPayload: { ...advanceReceipt, state: "accepted", reasonCode: "accepted" },
  };
  assert.equal(terminalReceiptFor([accepted], accepted.requestId), undefined);
  assert.equal(terminalReceiptFor([{ ...recorded, worldFactPayload: null }], recorded.requestId), undefined);
});

/**
 * The RECORDED shape a receipt takes in the fact log: its identity flattened onto the entry and the receipt itself
 * kept whole under `worldFactPayload` (`recordedReceipt`). One spelling, because several night fixtures need it.
 */
const asRecordedFact = (receipt) =>
  Object.freeze({
    type: "execution_receipt",
    reasonCode: receipt.reasonCode,
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    evidence: receipt.evidence,
    worldFactPayload: receipt,
  });

/**
 * Round 18's night, as its own artifacts describe it, driven through the REAL watcher.
 *
 * The run (`2026-10-31T19-26-54-087Z-multiday_routine`) crossed two nights and published `terminal: null, cause:
 * "engine"` for both, so the baseline could only report `night_mechanism_unobserved` twice. What it actually held:
 *
 *   - `actionTrace.jsonl`: 1 byte - ZERO flat dispatches. Every action in that run went through a Body Program.
 *   - `timeline.jsonl` idx 2992: `execution_receipt` `accepted`, `actionId=advance_day`, request `3982f1bc...`.
 *   - `timeline.jsonl` idx 3002: `execution_receipt` `succeeded`/`day_advanced`, same request,
 *     `revision=1559`, evidence `entered_via=native_sleep_prompt`.
 *   - `mod-log.txt`: `sleep lifecycle finished: state=passed; reason=day_advanced` at 03:38:25, the receipt the line
 *     before it.
 *
 * `watchNightRollover` looked for `advance_day` in the flat trace only, so `dispatched` was `undefined`, `terminal`
 * was `null`, and the crossing branch - which fires whenever the calendar moved - published the night with no
 * mechanism at all.
 */
test("a night the Mod crossed through Body Program reaches the record with its own receipt (round18)", async () => {
  // The evidence string and the receipt identity are round18's, verbatim (trimmed to the keys that matter here).
  const ADVANCE_EVIDENCE =
    "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;" +
    "saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=true;" +
    "shipping_summary_settled=committed;day_before=4;days_before=1;day_after=5;days_after=2;" +
    "enteredVia=native_sleep_prompt;dayBefore=4;dayAfter=5;daysPlayedBefore=1;daysPlayedAfter=2";
  const advanceReceipt = Object.freeze({
    executionId: "bdf26bff83f743788ce0985e4472d94c",
    requestId: "3982f1bcc6304c63b860a9a9a97c7834",
    actionId: "sleep",
    state: "succeeded",
    reasonCode: "day_advanced",
    revision: 1559,
    evidence: Object.freeze({ detail: ADVANCE_EVIDENCE }),
  });
  // The RECORDED shape, exactly as `timeline.jsonl` holds it: the identity flattened onto the entry, the receipt
  // itself (and with it the terminal `state`) kept whole under `worldFactPayload`.
  const acceptedFact = asRecordedFact({ ...advanceReceipt, state: "accepted", reasonCode: "accepted" });
  const terminalFact = asRecordedFact(advanceReceipt);
  // The refusal `sleep` mints when the actor is not indoors/standing/free - the ordinary way a companion's
  // attempt comes back named and the DAY goes on.
  const refusedFact = asRecordedFact({
    ...advanceReceipt,
    executionId: "9a1c0b7f5d2e4a63b0f7c1d2e3f40516",
    requestId: "6d0f4c9a7e2b18d3c5a4f6e8b0d12345",
    state: "rejected",
    reasonCode: "sleep_requires_indoors",
  });

  /**
   * One night through the real `watchNightRollover`.
   *
   * `dispatch` says what the bridge puts in the fact log while the day turn is still running:
   *   - "crossed": the `advance_day` acceptance (03:36:26) and then its terminal with the new day (03:38:25) - round18;
   *   - "refused": a REFUSAL on its own, with no crossing at all;
   *   - "none": nothing - the engine's 02:00 pass-out, crossing the night with no dispatch behind it.
   */
  const runNight = async ({ dispatch, nightTimeoutMs = 5_000 }) => {
    const actionTrace = [];
    const factLog = [];
    const bridgeDisconnections = [];
    const beforeCrossing = Object.freeze({
      revision: 1200,
      dayOfMonth: 5,
      timeOfDay: 2200,
      actionable: true,
      actorDispositionKind: "free",
      actorDispositionDetail: null,
      activeExecution: null,
    });
    const afterCrossing = Object.freeze({ ...beforeCrossing, revision: 1559, dayOfMonth: 6, timeOfDay: 600 });
    let worldNow = beforeCrossing;
    let polls = 0;
    const client = {
      get state() {
        return { snapshot: worldNow };
      },
      observe: async () => ({ ...worldNow }),
    };
    // The bridge and the engine run on their OWN clock, as they do live: the lifecycle's acceptance lands while the
    // day turn is still playing (03:36:26), and the rollover's terminal arrives together with the new day
    // (03:38:25, revision 1559 on both). Driving that from timers is what makes this a test of whether the watcher
    // LOOKS at the receipt log - not of the order a stub happens to call things in.
    const timers = [];
    // Only a night that a lifecycle actually carries gets its acceptance: the refusal case is a unit of the
    // predicate, and giving it an in-flight acceptance would test the race instead.
    if (dispatch === "crossed") timers.push(setTimeout(() => factLog.push(acceptedFact), 30));
    timers.push(
      setTimeout(() => {
        if (dispatch === "crossed") factLog.push(terminalFact);
        if (dispatch === "refused") factLog.push(refusedFact);
        // Only a night that CROSSED moves the calendar. The engine's pass-out crosses it too; a refusal does not.
        if (dispatch !== "refused") worldNow = afterCrossing;
      }, 60),
    );
    const sampleModHeartbeat = () => {
      polls += 1;
      return { count: polls, sinceMs: 0, line: "DEBUG-native-local-heartbeat", silentMs: 0 };
    };
    const [, , , watchNightRollover] = extractRunnerFunction(
      RUNNER_SOURCE,
      ["recordedReceipt", "terminalReceiptFor", "watchNightThroughPassOut", "watchNightRollover"],
      {
        actionTrace,
        factLog,
        bridgeDisconnections,
        client,
        sampleModHeartbeat,
        // Not spent, not unknown: the day itself is not what ended, the night is.
        readWorldClock: () => ({ spent: false, minutes: 1320, unknown: false, timeOfDay: 2200, source: "snapshot" }),
        watchRollover,
        nightCause,
        parseReceiptEvidence,
        worldNightEndingsFromFacts,
        NIGHT_CAUSE_PASS_OUT,
        sleepReceiptOf,
        TERMINAL_STATES,
        judgeUncrossedNight,
        sleepVerdictCase,
        MOD_HEARTBEAT_STALL_MS: 90_000,
        MULTIDAY_NIGHT_TIMEOUT_MS: nightTimeoutMs,
        MULTIDAY_POLL_INTERVAL_MS: 5,
        MULTIDAY_DISPATCH_TIMEOUT_MS: 5_000,
        MULTIDAY_DISMISS_TIMEOUT_MS: 5_000,
      },
    );
    try {
      return await watchNightRollover(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };

  const night = await runNight({ dispatch: "crossed" });
  assert.notEqual(
    night.terminal,
    null,
    `the night's own receipt IS its terminal; the watcher answered ${String(night.reasonCode ?? night.release)}`,
  );
  assert.equal(night.terminal.actionId, "sleep");
  assert.equal(night.terminal.state, "succeeded");
  assert.equal(night.terminal.reasonCode, "day_advanced");
  assert.equal(night.terminal.requestId, advanceReceipt.requestId, "the receipt the Mod minted for THIS dispatch");
  assert.equal(
    night.cause,
    "sleep",
    "entered_via=native_sleep_prompt on that receipt is the one witness a sleep can be claimed from",
  );
  assert.equal(
    night.release,
    undefined,
    "the calendar is a fallback witness: a night whose receipt is in hand is not calendar_advanced",
  );
  // The record the loop builds from it (`multiday-loop.mjs:313-320`) is judged as a crossed night with an OBSERVED
  // mechanism - the two violations round18 published for these nights are gone.
  const record = {
    day: 1,
    terminal: night.terminal ?? null,
    after: night.after ?? null,
    menus: night.menus ?? [],
    nextDayAccomplishedActionIds: ["harvest_crop"],
    cause: night.cause ?? null,
  };
  const classified = classifyNight({ terminal: record.terminal, after: record.after });
  assert.equal(classified.advanced, true, `expected a crossed night, got ${String(classified.reasonCode)}`);
  const assessment = assessMultiDayBaseline({ dayRecords: [record, { ...record, day: 2 }], daysRequested: 2 });
  // The two violations round18 published for these nights are gone, and the night is no longer counted as one whose
  // mechanism nobody recorded. (The assessment may still be RED for round18's OWN other facts - that receipt says
  // `saved_observed=true` with `save_boundary_not_observed=true`, which this test deliberately keeps, because the
  // fix is to surface what the receipt says, not to make the night pass. What is asserted here is exactly the
  // attribution the watcher owns.)
  const codes = assessment.violations.map((entry) => entry.code);
  assert.deepEqual(
    codes.filter((code) =>
      ["night_mechanism_unobserved", "night_terminal_missing", "night_cause_claims_a_sleep_without_a_receipt"].includes(
        code,
      ),
    ),
    [],
    `a receipted night is attributed, not unobserved: ${JSON.stringify(assessment.violations)}`,
  );
  assert.equal(assessment.daysCrossed, 2, "the calendar witness still counts both nights");
  assert.equal(assessment.unobservedNights, 0, "no night is left without a mechanism");
  assert.equal(assessment.passOutNights, 0, "and none of them is called a pass-out either");

  // THE GUARD: the same window with NO receipt must still say `engine`.
  //
  // `b27f75ca` removed the inference that a moved calendar means a sleep, and the fix above must not put it back:
  // the point is to READ the receipt the watcher already had, not to guess a mechanism from the crossing. A night
  // with nothing to read keeps `terminal: null`, `cause: "engine"` and its own `release` - and the baseline keeps
  // calling that a violation.
  const engineNight = await runNight({ dispatch: "none" });
  assert.equal(engineNight.terminal, null, "a night with no receipt has no terminal to report");
  assert.equal(engineNight.cause, "engine");
  assert.equal(engineNight.release, "calendar_advanced");
  const engineRecords = [
    {
      day: 1,
      terminal: engineNight.terminal ?? null,
      after: engineNight.after ?? null,
      menus: engineNight.menus ?? [],
      cause: engineNight.cause ?? null,
    },
  ];
  assert.ok(
    assessMultiDayBaseline({ dayRecords: engineRecords, daysRequested: 1 }).violations.some(
      (entry) => entry.code === "night_mechanism_unobserved",
    ),
    "an unattributed crossing is still a blocked night, not a pass",
  );

  // THE OTHER GUARD, for the opposite mistake: a REFUSED `advance_day` is not a night.
  //
  // Reading the receipt channel means a refusal, which also mints a receipt naming `advance_day`, is now VISIBLE to
  // the wait. Entering the night watch on it would spend the whole night budget on a night nothing started - and the
  // day loop keeps offering turns until the day is crossed, so the next turn may sleep for real. The refusal must
  // leave the wait waiting, and that is what `terminal: null` and the absent `release` below assert.
  //
  // What it must NOT do is collapse into "she did not sleep": a refusal is a defect with a code, and a run that
  // reported `companion_did_not_sleep` for it published the same string as a night she never tried at all. The code
  // is quoted, and the harness's own bound travels after it as itself.
  const refusedNight = await runNight({ dispatch: "refused", nightTimeoutMs: 600 });
  assert.equal(refusedNight.terminal, null, "a refused dispatch is not the night's terminal");
  assert.match(
    String(refusedNight.reasonCode),
    /^companion_sleep_refused:sleep_requires_indoors:day_turn_still_running$/u,
    `a refusal is reported by its own code, got ${String(refusedNight.reasonCode)}`,
  );
  assert.equal(refusedNight.nightVerdict.refusal.code, "sleep_requires_indoors");
  // This window holds the refusal and nothing else: no ACCEPTED receipt survives to name what the dispatch was reaching
  // for, so the target says null instead of printing the bed this harness happens to know about. With the accepted
  // receipt in the window the same field carries `own_bed` (see the three-case test below).
  assert.equal(refusedNight.nightVerdict.refusal.target, null);
  assert.equal(refusedNight.release, undefined, "and it certainly did not cross a night");
});

/**
 * Night 1 of `2026-11-05T15-02-34-974Z-multiday_routine`, driven through the REAL watcher.
 *
 * The run crossed both nights it was asked for, nobody passed out, and day 1 was still published as `cause: "engine"`
 * - so the baseline could only answer `night_mechanism_unobserved` about a night that ended exactly as intended. The
 * night's own receipts say otherwise: `sleep` accepted with `target=own_bed` at 23:14:37, the lifecycle walked to bed
 * and answered the native Sleep prompt, the calendar crossed 5 -> 6 at 23:15:49 while that lifecycle waited for a
 * `day_started` it never observed, and its terminal arrived `blocked/lifecycle_deadline_exceeded` with
 * `entered_via=native_sleep_prompt`.
 *
 * `crossingTerminal` keeping only `succeeded/day_advanced` is right - a blocked lifecycle is not the night's terminal.
 * What was wrong is that the receipt was then DROPPED, so the record could say nothing about how the day ended.
 */
test("a night her own sleep ended, crossed by the calendar, carries her sleep onto the record (2026-11-05)", async () => {
  const SLEEP_REQUEST_ID = "7b73b4de8a1e442d939503fdb580825c";
  const SLEEP_ACCEPTED = Object.freeze({
    executionId: "b9f626512e844c868d3afed8ee7f441b",
    requestId: SLEEP_REQUEST_ID,
    actionId: "sleep",
    state: "accepted",
    reasonCode: "accepted",
    revision: 1887,
    evidence: Object.freeze({ detail: "target=own_bed;never_direct_new_day=true" }),
  });
  const SLEEP_LIFECYCLE_TERMINAL = Object.freeze({
    ...SLEEP_ACCEPTED,
    state: "blocked",
    reasonCode: "lifecycle_deadline_exceeded",
    revision: 1888,
    evidence: Object.freeze({
      detail:
        "state=blocked;reason=lifecycle_deadline_exceeded;topology=single_player;entered_via=native_sleep_prompt;" +
        "saving_observed=false;saved_observed=false;day_started_observed=false;save_boundary_not_observed=true;" +
        "shipping_summary_settled=committed;day_before=4;days_before=5;day_after=5;days_after=6",
    }),
  });
  // The settlement summary that night held, committed by the lifecycle - as the day record carries it.
  const SETTLEMENT_MENU = Object.freeze({ menuType: "ShippingMenu", decision: "wait", clearedAt: 1793892226449 });

  /** One night: her receipts reach the bridge, and the CALENDAR crosses - in that order, as they did live. */
  const runNight = async ({ herReceipts }) => {
    const actionTrace = [];
    const factLog = [];
    const bridgeDisconnections = [];
    const beforeCrossing = Object.freeze({
      revision: 1887,
      dayOfMonth: 5,
      timeOfDay: 2220,
      actionable: true,
      actorDispositionKind: "free",
      actorDispositionDetail: null,
      activeExecution: null,
    });
    const afterCrossing = Object.freeze({ ...beforeCrossing, revision: 1889, dayOfMonth: 6, timeOfDay: 600 });
    let worldNow = beforeCrossing;
    const client = {
      get state() {
        return { snapshot: worldNow };
      },
      observe: async () => ({ ...worldNow }),
    };
    const timers = [];
    if (herReceipts) timers.push(setTimeout(() => factLog.push(asRecordedFact(SLEEP_ACCEPTED)), 20));
    timers.push(
      setTimeout(() => {
        if (herReceipts) factLog.push(asRecordedFact(SLEEP_LIFECYCLE_TERMINAL));
      }, 40),
    );
    // The crossing belongs to the CALENDAR, after her terminal: the lifecycle was still in `AwaitingDayStart`.
    timers.push(
      setTimeout(() => {
        worldNow = afterCrossing;
      }, 70),
    );
    const [, , , watchNightRollover] = extractRunnerFunction(
      RUNNER_SOURCE,
      ["recordedReceipt", "terminalReceiptFor", "watchNightThroughPassOut", "watchNightRollover"],
      {
        actionTrace,
        factLog,
        bridgeDisconnections,
        client,
        sampleModHeartbeat: () => ({ count: 1, sinceMs: 0, line: "DEBUG-native-local-heartbeat", silentMs: 0 }),
        // Not spent, not unknown: the day itself is not what ended, the night is.
        readWorldClock: () => ({ spent: false, minutes: 1380, unknown: false, timeOfDay: 2220, source: "snapshot" }),
        watchRollover,
        nightCause,
        parseReceiptEvidence,
        worldNightEndingsFromFacts,
        NIGHT_CAUSE_PASS_OUT,
        sleepReceiptOf,
        TERMINAL_STATES,
        judgeUncrossedNight,
        sleepVerdictCase,
        MOD_HEARTBEAT_STALL_MS: 90_000,
        MULTIDAY_NIGHT_TIMEOUT_MS: 5_000,
        MULTIDAY_POLL_INTERVAL_MS: 5,
        MULTIDAY_DISPATCH_TIMEOUT_MS: 5_000,
        MULTIDAY_DISMISS_TIMEOUT_MS: 5_000,
      },
    );
    try {
      return await watchNightRollover(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };

  /** The day record the loop builds from one night, plus the fields `onDay` adds. */
  const dayRecord = (night) => ({
    day: 1,
    terminal: night.terminal ?? null,
    after: night.after ?? null,
    menus: [SETTLEMENT_MENU],
    nextDayAccomplishedActionIds: ["cut_weeds"],
    cause: night.cause ?? null,
    sleepReceipt: night.sleepReceipt ?? null,
  });

  const slept = await runNight({ herReceipts: true });
  assert.equal(slept.terminal, null, "a blocked lifecycle is not the night's crossing terminal");
  assert.equal(slept.release, "calendar_advanced", "the calendar is what crossed it");
  assert.equal(
    slept.cause,
    NIGHT_CAUSE_SLEEP_UNSETTLED,
    "her own sleep ended the day; only the crossing was the calendar's",
  );
  assert.equal(slept.sleepReceipt.requestId, SLEEP_REQUEST_ID, "the receipt is her own sleep dispatch");
  assert.equal(slept.sleepReceipt.target, "own_bed", "at her own bed, as the accepted receipt said");
  assert.equal(
    parseReceiptEvidence(slept.sleepReceipt.evidence).entered_via,
    "native_sleep_prompt",
    "and the lifecycle named what entered it",
  );

  // The record this produces is no longer a night nobody can explain - and the day after it still had to hold work.
  const record = dayRecord(slept);
  const assessment = assessMultiDayBaseline({ dayRecords: [record, { ...record, day: 2 }], daysRequested: 2 });
  assert.ok(
    !assessment.violations.some((entry) => entry.code === "night_mechanism_unobserved"),
    `her sleep is a mechanism; got ${JSON.stringify(assessment.violations)}`,
  );
  assert.equal(assessment.unobservedNights, 0);
  assert.equal(assessment.passOutNights, 0, "the engine did not take this night");
  assert.equal(assessment.daysCrossed, 2);

  // THE GUARD: the same night with her receipts ABSENT is still an unobserved crossing, as round17's was.
  const unexplained = await runNight({ herReceipts: false });
  assert.equal(unexplained.cause, NIGHT_CAUSE_ENGINE);
  assert.equal(unexplained.sleepReceipt, null, "nothing observed a sleep, so nothing is published as one");
  const unexplainedRecord = dayRecord(unexplained);
  assert.ok(
    assessMultiDayBaseline({
      dayRecords: [unexplainedRecord, { ...unexplainedRecord, day: 2 }],
      daysRequested: 2,
    }).violations.some((entry) => entry.code === "night_mechanism_unobserved"),
    "an unattributed crossing is still a blocked night",
  );
});

/**
 * A night that did not cross is reported by the case that explains it.
 *
 * The watcher used to answer `companion_did_not_sleep` for EVERY night the world's clock spent without a crossing, so
 * the string covered a companion who never went to bed, a companion who went to bed and waited for the host player
 * (`requires_other_player`), and a sleep the Mod refused - three different findings, one of them not her fault at all.
 * Measured 2026-11-05 (`2026-11-05T11-37-35-764Z-multiday_routine`): `crossings 0 of 2` under that one code.
 *
 * Each fixture below is the SAME night, at the SAME spent clock, differing only in the receipts her `sleep` minted.
 * That is what makes the difference this test asserts a fact about the receipts rather than about the clock.
 */
test("a night she slept through and the host player did not is not reported as her failure", async () => {
  const acceptedSleep = Object.freeze({
    executionId: "exec_sleep_1",
    requestId: "req_sleep_1",
    actionId: "sleep",
    state: "accepted",
    reasonCode: "accepted",
    evidence: Object.freeze({ detail: "target=own_bed;never_direct_new_day=true" }),
  });
  // The lifecycle's own terminal when the native ready barrier never completes
  // (`SleepAndAdvanceDayLifecycle.cs:1085-1100`): state `waiting`, projected to the wire as `blocked`, with the
  // barrier's counts in the terminal's settlement (`ready=1;required=2`) and `ready_at_completion` still 0 because
  // that pair is only assigned when the barrier COMPLETES.
  const waitedForTheHost = Object.freeze({
    ...acceptedSleep,
    state: "blocked",
    reasonCode: "requires_other_player",
    evidence: Object.freeze({
      detail:
        "state=waiting;reason=requires_other_player;topology=multiplayer;entered_via=native_sleep_prompt;" +
        "saving_observed=false;saved_observed=false;day_started_observed=false;save_boundary_not_observed=false;" +
        "shipping_summary_settled=none;ready_check_observed=true;ready_at_completion=0;required_at_completion=0;" +
        "ready=1;required=2;topology=multiplayer",
    }),
  });
  // An eligibility refusal: the night was declined before anything native ran
  // (`farmhandexecutioncontroller.lifecycleactions.cs:135-154`).
  const refusedNotHome = Object.freeze({
    ...acceptedSleep,
    state: "rejected",
    reasonCode: "not_home",
    evidence: Object.freeze({
      detail: "state=not_home;reason=not_home;topology=multiplayer;saving_observed=false;saved_observed=false",
    }),
  });
  // The RECORDED shape `timeline.jsonl` holds: identity flattened onto the entry, receipt whole under
  // `worldFactPayload` (`recordedReceipt`).

  const runNight = async (receipts) => {
    const factLog = [];
    const actionTrace = [];
    const snapshot = Object.freeze({
      revision: 189,
      dayOfMonth: 5,
      timeOfDay: 2600,
      actionable: false,
      actorDispositionKind: "passed_out",
      actorDispositionDetail: null,
      activeExecution: null,
    });
    const client = {
      get state() {
        return { snapshot };
      },
      observe: async () => snapshot,
    };
    // The engine's clock at the two moments that matter: the hour she went to bed, and the pass-out that spent the
    // night. A constant clock could not tell them apart, and a bed time read from a constant is not an observation.
    const at = (timeOfDay, spent) =>
      Object.freeze({
        spent,
        minutes: Math.floor(timeOfDay / 100) * 60 + (timeOfDay % 100),
        unknown: false,
        timeOfDay,
        source: "snapshot",
      });
    let engineClock = at(2200, false);
    const readWorldClock = () => engineClock;
    // The receipts land AFTER the watch begins, because a fact that was already in the log belongs to an earlier night
    // (`factStart`) - and a fixture that pre-loads them would be testing a window the watcher never opens.
    const timers = [
      setTimeout(() => {
        for (const receipt of receipts) factLog.push(asRecordedFact(receipt));
        engineClock = at(2210, false);
      }, 20),
      setTimeout(() => {
        engineClock = at(2600, true);
      }, 60),
    ];
    const [, , , watchNightRollover] = extractRunnerFunction(
      RUNNER_SOURCE,
      ["recordedReceipt", "terminalReceiptFor", "watchNightThroughPassOut", "watchNightRollover"],
      {
        actionTrace,
        factLog,
        bridgeDisconnections: [],
        client,
        sampleModHeartbeat: () => ({ count: 1, sinceMs: 0, line: "DEBUG-native-local-heartbeat", silentMs: 0 }),
        readWorldClock,
        watchRollover,
        nightCause,
        parseReceiptEvidence,
        worldNightEndingsFromFacts,
        NIGHT_CAUSE_PASS_OUT,
        sleepReceiptOf,
        TERMINAL_STATES,
        judgeUncrossedNight,
        sleepVerdictCase,
        MOD_HEARTBEAT_STALL_MS: 90_000,
        MULTIDAY_NIGHT_TIMEOUT_MS: 5_000,
        MULTIDAY_POLL_INTERVAL_MS: 5,
        MULTIDAY_DISPATCH_TIMEOUT_MS: 5_000,
        MULTIDAY_DISMISS_TIMEOUT_MS: 5_000,
      },
    );
    try {
      return await watchNightRollover(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };

  // (a) she never entered the day-advance path.
  const neverTried = await runNight([]);
  assert.equal(
    neverTried.reasonCode,
    COMPANION_DID_NOT_SLEEP,
    `no sleep receipt means she never entered the path: got ${String(neverTried.reasonCode)}`,
  );
  assert.equal(neverTried.nightVerdict.sleepReceipt, null, "there is no receipt, and inventing one is the defect");

  // (b) she went to bed and the native barrier was the host player's.
  const waited = await runNight([acceptedSleep, waitedForTheHost]);
  assert.equal(
    waited.reasonCode,
    COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
    `she declared locally ready: got ${String(waited.reasonCode)}`,
  );
  // THE DIFFERENCE THE FIX HAS TO MAKE: identical night, identical spent clock, and the reason is no longer the one
  // that reads as her failure. Before the split this string WAS `companion_did_not_sleep`.
  assert.notEqual(
    waited.reasonCode,
    neverTried.reasonCode,
    "a night she slept on cannot share the reason of a night she never tried",
  );
  assert.equal(waited.nightVerdict.reasonCode, waited.reasonCode, "one spelling: the record and the reason agree");
  assert.equal(waited.nightVerdict.sleepReceipt.reasonCode, "requires_other_player");
  assert.equal(waited.bedTime, 2210, "the hour she went to bed, not the pass-out hour the clock ran on to");
  const summary = summarizeCrossings({
    crossings: 0,
    requestedCrossings: 2,
    nights: [{ day: 1, nightVerdict: waited.nightVerdict }],
  });
  assert.match(summary, /^crossings 0 of 2: night 1 - she slept at 2210/u, summary);
  assert.match(summary, /NOT a companion failure/u, summary);

  // (c) her sleep came back named.
  const refused = await runNight([acceptedSleep, refusedNotHome]);
  assert.equal(
    refused.reasonCode,
    `${COMPANION_SLEEP_REFUSED}:not_home`,
    `a refusal is quoted by its own code: got ${String(refused.reasonCode)}`,
  );
  assert.deepEqual(refused.nightVerdict.refusal, { code: "not_home", target: "own_bed" });
  assert.equal(refused.nightVerdict.reasonCode, refused.reasonCode, "one spelling: the record and the reason agree");
  const refusedSummary = summarizeCrossings({
    crossings: 0,
    requestedCrossings: 2,
    nights: [{ day: 1, nightVerdict: refused.nightVerdict }],
  });
  assert.match(refusedSummary, /her sleep was refused \(not_home, target own_bed\)/u, refusedSummary);
});

test("the run bundle publishes the crossing record, and one it cannot judge is reported instead of refusing the manifest", () => {
  // The gate reads `bundle.multiday`, and the bundle used to drop the runner's own crossing record, so
  // `run_reports_a_crossing` failed on every run whatever the nights did. It is forwarded now - but only a
  // record the bundle contract can judge (a non-empty crossings count its `dayRecords` agree with), because
  // `writeEvidenceBundle` REFUSES a manifest whose crossings disagree with its records, and a metadata gap
  // must not destroy the run's evidence along with it.
  const bundleCrossingRecord = extractRunnerFunction(RUNNER_SOURCE, "bundleCrossingRecord");
  // What the guard drops is REPORTED where this runner's other diagnostics go (`BRIDGE_DISCONNECTED`,
  // `EVIDENCE_BUNDLE_REFUSED`): `multiday: null` on its own would not say WHY a crossing record could not be
  // described, so the reason is named instead of vanishing into the manifest.
  const reports = [];
  const reporting = (produce) => {
    const original = console.error;
    console.error = (...args) => reports.push(args.map(String).join(" "));
    try {
      return produce();
    } finally {
      console.error = original;
    }
  };
  const record = {
    crossings: 1,
    requestedCrossings: 1,
    completed: true,
    assessment: { state: "passed", ok: true },
    dayRecords: [{ day: 1 }],
  };
  assert.equal(
    reporting(() => bundleCrossingRecord(record)),
    record,
    "a judgeable record is published",
  );
  assert.deepEqual(reports, [], "a judgeable record is not reported as a gap");
  assert.equal(
    reporting(() => bundleCrossingRecord({ ...record, crossings: 0, dayRecords: [] })),
    null,
    "0 crossings is not a record",
  );
  assert.match(
    reports.at(-1) ?? "",
    /MULTIDAY_CROSSING_RECORD_NOT_PUBLISHED .*multiday_crossings_invalid/,
    "0 crossings is REPORTED, not silently dropped",
  );
  assert.equal(
    reporting(() => bundleCrossingRecord({ ...record, crossings: 2 })),
    null,
    "a count its records contradict is not one",
  );
  assert.match(
    reports.at(-1) ?? "",
    /multiday_day_records_disagree_with_crossings/,
    "the other unjudgeable shape is reported by its own reason code",
  );
  const reportedSoFar = reports.length;
  assert.equal(bundleCrossingRecord(null), null);
  assert.equal(reports.length, reportedSoFar, "no record at all is an absence, not a gap");
  const base = {
    schemaVersion: 1,
    run: {
      id: "run-1",
      scenario: "multiday_routine",
      startedAtMs: 1,
      durationMs: 2,
      gitSha: "abc",
      runtimeRoot: "D:\\root",
    },
    env: {
      smapiVersion: "4.5.2",
      gameVersion: "1.6.15",
      os: "windows",
      windowMode: "foreground",
      gpu: "adapter",
      resolution: "1920x1080",
      saveHash: "abcd",
      reason: null,
    },
    verdict: { state: "blocked", reasonCode: "multiday_routine_blocked", rubric: { broken: [], unmeasured: [] } },
    timeline: { path: "timeline.jsonl", records: 0, sources: ["player", "smapi", "llm"] },
    actionTrace: { path: "actionTrace.jsonl", records: 0 },
    keyFrames: { status: "skipped", reason: "headless_environment", dir: null },
    // The run's memory and its unwind: the two fields an auditor reads that `round40` published as nothing. Here they
    // are the honest EMPTY shapes - a run that took no turn sample and one whose unwind nobody has measured yet - which
    // the contract accepts, unlike a missing field.
    hostMemory: {
      state: "not_measured:no_turn_samples",
      samples: 0,
      startRssMb: null,
      minRssMb: null,
      maxRssMb: null,
      minFreeMb: null,
      turns: [],
      omitted: 0,
    },
    reclamation: { state: "unobserved", exitReason: null, steps: [], reflection: "skipped" },
    voice: { state: "disabled", playback: "disabled", reasonCode: "voice_not_requested" },
    failure: null,
    repro: { command: null, expectedWallClockMs: null },
  };
  const codesFor = (bundle) => validateEvidenceBundle(bundle).violations.map((entry) => entry.code);
  assert.deepEqual(codesFor({ ...base, multiday: bundleCrossingRecord(record) }), [], "a judged record is writable");
  assert.ok(
    codesFor({
      ...base,
      multiday: { crossings: 0, assessment: { state: "blocked", ok: false }, dayRecords: [] },
    }).includes("multiday_crossings_invalid"),
    "the raw 0-crossing record would refuse the whole manifest",
  );
  assert.deepEqual(
    codesFor({ ...base, multiday: reporting(() => bundleCrossingRecord({ crossings: 0, dayRecords: [] })) }),
    [],
    "the guarded record leaves the manifest writable",
  );
});

test("the run bundle carries the Host's own preset answer, and an absent publication is `not_measured`", () => {
  // The operator's question - "did the live run load the preset?" - is answerable from the run's own record only if the
  // bundle carries the Host's publication rather than a second reading of the preset file. The Host line is the one
  // fact this process cannot compute: `sampling` is the EFFECTIVE reading over the composed model.
  const log = [];
  const [readCompanionPresetFact] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["readCompanionPresetFact", "readHostJsonLines"],
    { hostLogChunks: log },
  );

  // (a) THE RED PROOF. With no line at all, the bundle must say WHAT it looked for and must not answer
  // `generation: null` - that is the published answer for "provisioned with no preset", and a run that never saw the
  // Host's line cannot give it. A reader that silently reads `null` would report this run as a preset-less one.
  const absent = readCompanionPresetFact();
  assert.equal(absent.state, "not_measured");
  assert.equal(absent.missingField, "COMPANION_PRESET");
  assert.equal("generation" in absent, false, "an unmeasured publication must not be spellable as `no preset`");

  // (b) The Host's block is carried as the Host wrote it - including its own `generation: null`, which here is the
  // HOST's statement that this runtime cwd carried no preset, not this process's guess. A trailing carriage return
  // must not stop the parse: the log is a concatenation of stderr writes.
  const publication = {
    card: null,
    worldbook: null,
    generation: null,
    sampling: "not_applied",
    contextBudget: { not_measured: true, missingField: "model.contextWindow" },
    prompts: {
      system: { chars: 12, delivered: true, disposition: "applied", refused: null },
      postHistory: { chars: 34, delivered: true, disposition: "applied", refused: null },
      disabled: ["auxiliary"],
    },
  };
  log.push(`COMPANION_PRESET ${JSON.stringify(publication)}\r\n`);
  const published = readCompanionPresetFact();
  assert.equal(published.state, "published");
  assert.equal(published.lines, 1);
  for (const [key, value] of Object.entries(publication))
    assert.deepEqual(published[key], value, `the Host's \`${key}\` must reach the bundle unchanged`);
  assert.equal(published.generation, null, "the Host said `no preset`, and that answer survives as one");

  // A run that re-mounts prints again: the session that served the run is the LAST one published.
  const remounted = { ...publication, generation: "D:\\root\\preset.json" };
  log.push(`COMPANION_PRESET ${JSON.stringify(remounted)}\n`);
  const afterRemount = readCompanionPresetFact();
  assert.equal(afterRemount.lines, 2);
  assert.equal(afterRemount.generation, "D:\\root\\preset.json");

  // A line nobody could read is COUNTED, and a bare scalar under the prefix is not a publication either, so neither
  // can be mistaken for `not_measured` (nothing published) or for a block.
  log.push("COMPANION_PRESET {not json\n", "COMPANION_PRESET 42\n");
  const withGarbage = readCompanionPresetFact();
  assert.equal(withGarbage.unparsable, 2);
  assert.equal(withGarbage.lines, 2, "the readable blocks are still the ones published");
});

test("the runner assembles its result in exactly one place, so no exit path can lose a field", () => {
  // Measured 2026-10-21: a run whose trace held 131 dispatches published `attempted: []`, because the result object was
  // assembled once per exit and each literal named only what its author remembered. `multiday` and
  // `programSubmissions` had already gone missing the same way. The published contract is what stops a repeat: these
  // fields are published by buildRunResult and named by NO exit path.
  const builderAt = RUNNER_SOURCE.indexOf("async function buildRunResult({");
  const bundleAt = RUNNER_SOURCE.indexOf("async function writeRunBundle(");
  assert.ok(builderAt > 0 && bundleAt > builderAt, "buildRunResult must exist, before the bundle it writes");
  const builder = RUNNER_SOURCE.slice(builderAt, bundleAt);
  // The exits: everything the run does between admitting itself and its `finally`. A field named here is a second
  // publication - that is the shape that lost the field in the first place.
  const exitsAt = RUNNER_SOURCE.indexOf("\ntry {\n");
  const finallyAt = RUNNER_SOURCE.indexOf("\n} finally {");
  assert.ok(exitsAt > 0 && finallyAt > exitsAt, "the run's try/catch must exist");
  const exits = RUNNER_SOURCE.slice(exitsAt, finallyAt);
  assert.equal((exits.match(/await buildRunResult\(\{/g) ?? []).length, 2, "the passed and crashed exits both use it");
  // The one literal: from the builder's `const result = {` to its matching close, counted rather than searched
  // for. `indexOf("\n  };")` finds the END OF A NESTED OBJECT first - `summarizePresentationEvidence()` and its
  // siblings sit three levels deep in this literal - and the slice then stops before fields that come after them.
  // That made `toolTiming` read as "not published exactly once" while it was published, which is a test bug that
  // looks exactly like the defect the test exists for.
  const literalAt = builder.indexOf("const result = {");
  assert.ok(literalAt > 0, "the builder must build one result literal");
  const openAt = builder.indexOf("{", literalAt);
  let depth = 0;
  let closeAt = -1;
  for (let index = openAt; index < builder.length; index += 1) {
    if (builder[index] === "{") depth += 1;
    else if (builder[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        closeAt = index;
        break;
      }
    }
  }
  assert.ok(closeAt > openAt, "the result literal must be balanced");
  const literal = builder.slice(literalAt, closeAt + 1);
  for (const field of [
    "attemptedActionIds",
    "succeededActionIds",
    "programSubmissions",
    "multiday",
    "actionCadence",
    "toolTiming",
    "presentation",
    "failure",
    "startedAtMs",
    "endedAtMs",
  ]) {
    // A PUBLICATION inside the literal is `<field>:` OR the shorthand `<field>,` - both are keys of the result.
    const key = new RegExp(`^\\s*${field}[:,]`, "gm");
    assert.equal((literal.match(key) ?? []).length, 1, `${field} must be published exactly once, by the builder`);
    // An exit publishes by KEY. A bare `<field>,` there is an argument in a call (`summarizeDispatchedActions(...)`),
    // which is how this check tripped once the exit path started handing the record in to be summarised - and an
    // argument is not a second publication. A second result literal is what the assertions below this loop forbid.
    const exitKey = new RegExp(`^\\s*${field}:`, "gm");
    assert.equal((exits.match(exitKey) ?? []).length, 0, `${field} must not be published by an exit path`);
  }
  // `bundle` and `capture` are assigned rather than keyed, and both assignments are the builder's own.
  for (const field of ["bundle", "capture"]) {
    assert.equal((builder.match(new RegExp(`result\\.${field} = await `, "g")) ?? []).length, 1);
    assert.equal((exits.match(new RegExp(`result\\.${field} = await `, "g")) ?? []).length, 0);
  }
  // No second literal to drift from it: there is one in the file, and it is the builder's.
  assert.equal((RUNNER_SOURCE.match(/const result = \{/g) ?? []).length, 1);
  assert.equal((exits.match(/const result = \{/g) ?? []).length, 0);
  assert.doesNotMatch(RUNNER_SOURCE, /const partialResult = \{/);
});

test("a run whose trace has dispatches publishes a non-empty attempted list", async () => {
  // The falsifier for the field the 131-dispatch run lost: the REAL builder, evaluated against a synthetic trace, must
  // answer with what the trace holds - on the crashed path, which is the one that published nothing.
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    {
      ...instrumentGlobals,
      executedActionIds,
      // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once
      // and hands it to its own clause, so a test of the builder supplies the real implementations.
      measureActionBreadth,
      actionBreadthClause,
      deliveryAccountClause,
      readActionBreadthSurface,
      buildSnapshotCensus,
      snapshotFamilyRows: new Map(),
      snapshotCensusSamples: 0,
      NON_ACCOMPLISHMENT_ACTIONS: new Set(["move_to_tile"]),
      phaseTimings: { runStartedAtMs: 1, marks: {} },
      lastObservedSnapshot: null,
      lastObservedPose: null,
      actionTrace: [
        { action: "move_to_tile", state: "succeeded" },
        { action: "harvest_crop", state: "succeeded" },
        { action: "plant_seed", state: "rejected" },
      ],
      programSubmissions: [{ tool: "stardew_submit_action_program", accepted: false }],
      programOutcomes: [],
      sampleProgramOutcomes: async () => [],
      programExecutionRows,
      executionTraceInvariant,
      TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
      multidayOutcome: { crossings: 1, dayRecords: [] },
      SCENARIO: "morning_routine",
      LEGACY_LADDER: null,
      historianRubricOutcome: null,
      runSessionRecord: Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" }),
      summarizeActionCadence: () => ({ spans: [] }),
      summarizePresentationEvidence: () => NOTHING_PRESENTED,
      readToolTiming: () => ({ observed: false, invariant: { checked: false, ok: null } }),
      summarizeRunCost,
      describeRunCost,
      buildFailureSnapshot: (input) => input,
      writeRunBundle: async () => ({ state: "written", runDir: "/run" }),
      closeCapture: async () => ({ state: "closed" }),
      writeFile: async () => {},
      join: (...parts) => parts.join("/"),
    },
  );
  const result = await buildRunResult({
    state: "blocked",
    error: "agent_turn_timeout",
    settlement: { component: "runner" },
  });
  assert.deepEqual(result.attemptedActionIds, ["move_to_tile", "harvest_crop", "plant_seed"]);
  assert.deepEqual(result.succeededActionIds, ["move_to_tile", "harvest_crop"]);
  // The rest of the contract is published by the same call: a crashed run is not a run with less to say.
  assert.equal(result.state, "blocked");
  assert.equal(result.error, "agent_turn_timeout");
  assert.equal(result.failure.reasonCode, "agent_turn_timeout");
  assert.deepEqual(
    result.programSubmissions,
    [{ tool: "stardew_submit_action_program", accepted: false }],
    "a submission that ran nothing is still published by the path that crashed",
  );
  assert.deepEqual(result.multiday, { crossings: 1, dayRecords: [] });
  assert.equal(result.bundle.state, "written");
  assert.equal(result.capture.state, "closed");
  for (const field of ["startedAtMs", "endedAtMs", "actionCadence", "toolTiming", "presentation"]) {
    assert.ok(Object.hasOwn(result, field), `${field} must be published`);
  }
  // The count identity is published by the crashed path too: three flat frames and no observed program is three rows.
  assert.deepEqual(result.executionTrace, {
    ok: true,
    sumsAgree: true,
    flat: 3,
    program: 0,
    programDispatches: 0,
    rows: 3,
    expectedRows: 3,
    unobservedPrograms: 0,
  });
});

test("a run whose work all went through programs publishes a non-empty attempted list", async () => {
  // THE RUN SHAPE THE EVALUATOR GOT WRONG. Every action now runs through a Body Program, so `actionTrace` is empty
  // while the companion tills, plants and harvests: the evaluator read that one channel, answered `attempted: []`, and
  // the verdict then reported `nothing_accomplished` for a session that worked all day. The fixture is a program that
  // dispatched its nodes and a trace that holds no row at all - what a real run of this shape produces.
  //
  // The action id is NOT in the flat trace, NOT in the journal's `native_dispatch` event (program/node/attempt/cursor
  // only) and NOT in `nodeOutcomes` (`{ nodeId, state }` only). It exists in the candidate the Host submitted, so the
  // join key is `(programId, nodeId)` - and that is what this fixture exercises end to end, through the REAL builder.
  const programOutcomesAtTeardown = [
    {
      programId: "plan_morning_1",
      accepted: true,
      observed: true,
      source: "bridge",
      dispatched: 3,
      executions: [
        { nodeId: "n01", nodeAttempt: 1, cursor: 2 },
        { nodeId: "n02", nodeAttempt: 1, cursor: 4 },
        { nodeId: "n03", nodeAttempt: 1, cursor: 6 },
      ],
      nodeOutcomes: [
        { nodeId: "n01", state: "succeeded" },
        { nodeId: "n02", state: "succeeded" },
        { nodeId: "n03", state: "failed" },
      ],
    },
  ];
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    {
      ...instrumentGlobals,
      executedActionIds,
      // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once
      // and hands it to its own clause, so a test of the builder supplies the real implementations.
      measureActionBreadth,
      actionBreadthClause,
      deliveryAccountClause,
      readActionBreadthSurface,
      buildSnapshotCensus,
      snapshotFamilyRows: new Map(),
      snapshotCensusSamples: 0,
      NON_ACCOMPLISHMENT_ACTIONS: new Set(["move_to_tile"]),
      phaseTimings: { runStartedAtMs: 1, marks: {} },
      lastObservedSnapshot: null,
      lastObservedPose: null,
      actionTrace: [],
      programSubmissions: [
        {
          programId: "plan_morning_1",
          code: "accepted",
          accepted: true,
          nodes: [
            { nodeId: "n01", actionId: "harvest_crop" },
            { nodeId: "n02", actionId: "plant_seed" },
            { nodeId: "n03", actionId: "water_crop" },
          ],
        },
      ],
      // The read is CARRIED, as the run's own pre-teardown read is: the builder must not have to ask a closed bridge.
      programOutcomes: [],
      sampleProgramOutcomes: async () => {
        throw new Error("the carried read must be used, not a second query");
      },
      programExecutionRows,
      executionTraceInvariant,
      TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
      multidayOutcome: null,
      SCENARIO: "morning_routine",
      LEGACY_LADDER: null,
      historianRubricOutcome: null,
      runSessionRecord: Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" }),
      summarizeActionCadence: () => ({ spans: [] }),
      summarizePresentationEvidence: () => NOTHING_PRESENTED,
      readToolTiming: () => ({ observed: false, invariant: { checked: false, ok: null } }),
      summarizeRunCost,
      describeRunCost,
      buildFailureSnapshot: (input) => input,
      writeRunBundle: async () => ({ state: "written", runDir: "/run" }),
      closeCapture: async () => ({ state: "closed" }),
      writeFile: async () => {},
      join: (...parts) => parts.join("/"),
    },
  );
  const result = await buildRunResult({
    state: "passed",
    error: null,
    settlement: null,
    programOutcomesAtTeardown,
  });
  assert.deepEqual(
    result.attemptedActionIds,
    ["harvest_crop", "plant_seed", "water_crop"],
    "a run with an empty flat trace and three dispatched nodes attempted three actions",
  );
  assert.deepEqual(result.succeededActionIds, ["harvest_crop", "plant_seed"], "the failed node is an attempt only");
  // The count identity is a different question and is unchanged by this: the flat half is genuinely zero.
  assert.equal(result.executionTrace.flat, 0);
  assert.equal(result.executionTrace.programDispatches, 3);
});

test("an error that escapes the run still publishes the work it had already recorded", async () => {
  // The `g149tool` finding: 184 s of real work - accepted programs, route progress, successful and refused receipts -
  // met a run that ended `runner_failed_before_reporting`, and its artifact carried `state`, `scenario`, `reason`,
  // `error`, `stack`, `at` and nothing else, so none of that work could be examined. Here the run's own record is
  // already filled when the throw arrives, and the REAL escape path is driven: what it writes must be the run's
  // result, assembled by the same builder every other exit uses, with the throw named as its reason.
  const actionTrace = [
    { action: "equip_tool", state: "succeeded", reasonCode: "tool_equipped" },
    { action: "till_soil", state: "rejected", reasonCode: "target_unreachable" },
    { action: "harvest_crop", state: "succeeded", reasonCode: "crop_harvested" },
  ];
  const factLog = [
    { type: "execution_receipt", reasonCode: "tool_equipped", requestId: "r1", executionId: "e1" },
    { type: "execution_receipt", reasonCode: "target_unreachable", requestId: "r2", executionId: "e2" },
    { type: "execution_receipt", reasonCode: "crop_harvested", requestId: "r3", executionId: "e3" },
  ];
  const programSubmissions = [{ programId: "p_farm_day", code: "accepted", accepted: true }];
  const written = [];
  const bundles = [];
  const bundleFailures = [];
  const resultFile = join(tmpdir(), `gb-escaped-error-${randomUUID()}.result.json`);
  const previousResultFile = process.env.GAMEBUDDY_RESULT_FILE;
  process.env.GAMEBUDDY_RESULT_FILE = resultFile;
  const [, , , , writeFailureDump] = extractRunnerFunction(
    RUNNER_SOURCE,
    [
      "summarizeDispatchedActions",
      "buildRunResult",
      "failureDumpEvidence",
      "writeUnassembledFailure",
      "writeFailureDump",
      "writeRunDump",
      "writeKilledDump",
      "deriveRungVerdict",
      "planPollCount",
    ],
    {
      ...instrumentGlobals,
      executedActionIds,
      // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once
      // and hands it to its own clause, so a test of the builder supplies the real implementations.
      measureActionBreadth,
      actionBreadthClause,
      deliveryAccountClause,
      readActionBreadthSurface,
      buildSnapshotCensus,
      snapshotFamilyRows: new Map(),
      snapshotCensusSamples: 0,
      NON_ACCOMPLISHMENT_ACTIONS: new Set(["equip_tool"]),
      phaseTimings: { runStartedAtMs: 1, marks: {} },
      lastObservedSnapshot: null,
      lastObservedPose: null,
      actionTrace,
      factLog,
      programSubmissions,
      programOutcomes: [],
      sampleProgramOutcomes: async () => [],
      programExecutionRows,
      executionTraceInvariant,
      readToolTiming: () => ({ observed: false, invariant: { checked: false, ok: null } }),
      summarizeRunCost,
      describeRunCost,
      TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
      multidayOutcome: null,
      historianRubricOutcome: null,
      runSessionRecord: { path: undefined, reason: "session_record_binding_not_established" },
      providerReadiness: null,
      SCENARIO: "multiday_routine",
      LEGACY_LADDER: null,
      summarizeActionCadence: () => ({ spans: [] }),
      summarizePresentationEvidence: () => NOTHING_PRESENTED,
      buildFailureSnapshot,
      classifyFailure,
      buildRunObservation: (input) => input,
      assessCompanionInteraction: () => ({ passed: true }),
      findProtectedCovenantShipment: () => undefined,
      PROTECTED_COVENANT_ITEM_ID: "(O)400",
      capture: null,
      runtimeRoot: "/tmp/root",
      covenantSeed: null,
      presentedSummary: null,
      voiceResult: null,
      agentTurnResult: null,
      client: { state: { authenticated: true, snapshot: { revision: 42 } } },
      writeRunBundle: async ({ result, failure }) => {
        bundles.push(result);
        bundleFailures.push(failure);
        return { state: "written", runDir: "/run" };
      },
      closeCapture: async () => null,
      writeFile: async (path, contents) => written.push({ path, contents }),
      writeFileSync: () => {},
      // The bundle's reclamation account starts as the explicit "nothing measured yet" record, built by the same
      // module the runner uses: a hand-written literal here would be the second spelling of that shape.
      reclamationRecord,
      // This test asserts the run's result reached GAMEBUDDY_RESULT_FILE, so the one path the assembly writes is the file
      // it set up - the same value the runner derives from that variable at startup.
      RESULT_FILE: resultFile,
      join: (...parts) => parts.join("/"),
    },
  );
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  let refused;
  let crashed;
  try {
    await writeFailureDump(new Error("presentation_refused:presentation_bridge_rejected"));
    // THE REAL INCIDENT (`2026-11-05T11-37-35-764Z-multiday_routine`): a ReferenceError escaped the run's own exit path
    // and its message was published as the reason code. The code is now closed and the site is in the record.
    await writeFailureDump(new ReferenceError("path is not defined"));
    assert.ok(written[0] !== undefined, `the dump wrote nothing; it reported: ${logged.join(" | ")}`);
    refused = JSON.parse(written[0].contents);
    crashed = JSON.parse(written[1].contents);
  } finally {
    console.error = originalError;
    if (previousResultFile === undefined) delete process.env.GAMEBUDDY_RESULT_FILE;
    else process.env.GAMEBUDDY_RESULT_FILE = previousResultFile;
  }
  const dump = written.find((entry) => entry.path === resultFile);
  assert.ok(
    dump !== undefined,
    `an escaped error must leave the run's result, not nothing; the dump reported: ${logged.join(" | ")}`,
  );
  const published = refused;
  assert.equal(published.state, "blocked");
  // A declared code (`throw new Error("stable_token:detail")`) keeps its name; a message that is NOT a code becomes the
  // internal token, and its text moves to errorMessage.
  assert.equal(published.error, "presentation_refused:presentation_bridge_rejected");
  assert.equal(
    published.failure.reasonCode,
    "presentation_refused:presentation_bridge_rejected",
    "the outcome that ended the run is its named failure",
  );
  assert.equal(published.failure.errorClass, "Error");
  assert.equal(published.failure.errorMessage, "presentation_refused:presentation_bridge_rejected");
  // What the run did, read from its own record: the stub this replaces lost every one of these.
  assert.deepEqual(published.attemptedActionIds, ["equip_tool", "till_soil", "harvest_crop"]);
  assert.deepEqual(published.succeededActionIds, ["equip_tool", "harvest_crop"]);
  assert.deepEqual(
    published.programSubmissions,
    programSubmissions,
    "an accepted program it never got to read is still reported",
  );
  assert.deepEqual(
    published.executionTrace,
    {
      ok: true,
      sumsAgree: true,
      flat: 3,
      program: 0,
      programDispatches: 0,
      rows: 3,
      expectedRows: 3,
      unobservedPrograms: 0,
    },
    "the trace counts are the trace's own, on this path too",
  );
  assert.equal(published.revision, 42, "the bridge facts it received are published with it");
  assert.equal(published.bridgeFacts.length, 3, "the bridge log it received travels with the result");
  // The bundle beside it is the run's own contract, written by the same assembly.
  assert.equal(bundles.length, 2);
  // And it is NOT the floor record: a floor says it could not be assembled, which must never be what a run with work
  // in it reads as.
  assert.equal(Object.hasOwn(published, "reason"), false);
  assert.ok(
    logged.every((line) => !line.includes("failure_dump_assembly_failed")),
    "the assembly must not have fallen through to the floor",
  );

  // The crash: a closed code, and the site readable straight out of the artifact.
  assert.equal(crashed.state, "blocked");
  assert.equal(crashed.error, "runner_internal_error", "a programming error is not published under its own prose");
  const failure = crashed.failure;
  assert.equal(failure.reasonCode, "runner_internal_error");
  assert.equal(failure.errorClass, "ReferenceError");
  assert.equal(failure.errorMessage, "path is not defined");
  assert.ok(Array.isArray(failure.errorStack), "the stack is published as frames, not as one blob");
  assert.ok(failure.errorStack.length >= 1, "the first frame is mandatory: without it the run names no site");
  assert.match(
    failure.errorStack[0],
    /:\d+:\d+\)?$/u,
    "the first frame carries a line and a column, so the site can be opened",
  );
  assert.match(failure.errorFrame, /:\d+$/u, "the first frame's file:line is published beside the frames");
  assert.ok(
    failure.errorFrame.includes("run-stardew-native-local-agent-ab-live.test.mjs"),
    `the frame names THIS call site, not a wrapper: ${failure.errorFrame}`,
  );
  // End to end: the same record is what the bundle contract is handed, and it is what an audit reads.
  assert.equal(bundleFailures[1].reasonCode, "runner_internal_error");
  assert.equal(bundleFailures[1].errorFrame, failure.errorFrame);
  assert.equal(bundleFailures[1].errorStack[0], failure.errorStack[0]);
});

test("a run interrupted from outside publishes its own verdict, with the evidence it had accumulated", async () => {
  // Measured 2026-11-06: a run killed at 19:37:14 left its run directory holding `launch.json` and nothing else. Its
  // day records and counters existed only in the memory of a process that was gone, and "we stopped it" was
  // indistinguishable on disk from "the product failed". The killed exit therefore walks the SAME assembly every other
  // exit walks, with the state and the reason the signal gives it - and the bundle is written through the REAL
  // contract, so this asserts the artifact a reader opens rather than a paraphrase of it.
  const captureDir = mkdtempSync(join(tmpdir(), "gb-killed-bundle-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "gb-killed-root-"));
  const written = [];
  const previousWindowMode = process.env.GAMEBUDDY_WINDOW_MODE;
  process.env.GAMEBUDDY_WINDOW_MODE = "hidden";
  const dayRecords = [
    {
      day: 1,
      reasonCode: "day_advanced",
      terminal: { state: "passed", reasonCode: "slept" },
      after: { dayOfMonth: 2 },
    },
  ];
  const actionTrace = [
    {
      requestId: "r1",
      action: "harvest_crop",
      args: { targetX: 12, targetY: 8 },
      state: "succeeded",
      reasonCode: "crop_harvested",
      inGameTime: "620",
      day: 2,
      season: "spring",
      year: 1,
      dispatchedAtMs: 1_700_000_000_000,
    },
  ];
  const factLog = [{ type: "execution_receipt", reasonCode: "crop_harvested", requestId: "r1", executionId: "e1" }];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  let writeKilledDump;
  try {
    const [, , , , , , killedDump] = extractRunnerFunction(
      RUNNER_SOURCE,
      [
        "summarizeDispatchedActions",
        "buildRunResult",
        "failureDumpEvidence",
        "writeUnassembledFailure",
        "writeFailureDump",
        "writeRunDump",
        "writeKilledDump",
        "bundleCrossingRecord",
        "writeRunBundle",
        "deriveRungVerdict",
        "planPollCount",
      ],
      {
        // The run's accumulated evidence: this is what a killed run must not lose.
        ...instrumentGlobals,
        executedActionIds,
        // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once
        // and hands it to its own clause, so a test of the builder supplies the real implementations.
        measureActionBreadth,
        actionBreadthClause,
        deliveryAccountClause,
        readActionBreadthSurface,
        buildSnapshotCensus,
        snapshotFamilyRows: new Map(),
        snapshotCensusSamples: 0,
        NON_ACCOMPLISHMENT_ACTIONS: new Set(["equip_tool"]),
        phaseTimings: { runStartedAtMs: 1_700_000_000_000, marks: {} },
        lastObservedSnapshot: null,
        lastObservedPose: null,
        actionTrace,
        factLog,
        programSubmissions: [{ programId: "p_harvest", code: "accepted", accepted: true }],
        programOutcomes: [],
        programOutcomesReadAtSubmissionCount: 1,
        sampleProgramOutcomes: async () => [],
        programExecutionRows,
        executionTraceInvariant,
        readToolTiming: () => ({ observed: false, invariant: { checked: false, ok: null } }),
        summarizeRunCost,
        describeRunCost,
        TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
        multidayOutcome: { crossings: 1, assessment: { state: "passed", ok: true, violations: [] }, dayRecords },
        // The bundle's account literal is built by the module the runner uses, so this eval binds the same builder.
        reclamationRecord,
        historianRubricOutcome: Object.freeze({
          state: "unmeasured",
          reasonCode: "no_compartments_written",
          obligations: [],
          compartmentsChecked: 0,
        }),
        killedReasonCode,
        runSessionRecord: Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" }),
        providerReadiness: null,
        SCENARIO: "multiday_routine",
        LEGACY_LADDER: null,
        summarizeActionCadence: () => ({ spans: [] }),
        summarizePresentationEvidence: () => NOTHING_PRESENTED,
        buildFailureSnapshot,
        classifyFailure,
        writeFileSync: () => {},
        buildReproPlan: () => ({
          command: "node tools/live-run/game/launch-ladder-live.mjs --scenario multiday_routine",
          expectedWallClockMs: 900_000,
          reach: "the_failing_day",
        }),
        buildRunObservation: (input) => input,
        assessCompanionInteraction: () => ({ passed: true }),
        findProtectedCovenantShipment: () => undefined,
        PROTECTED_COVENANT_ITEM_ID: "(O)400",
        capture: { dir: captureDir },
        runtimeRoot,
        covenantSeed: null,
        presentedSummary: null,
        voiceResult: null,
        agentTurnResult: null,
        client: { state: { authenticated: true, snapshot: { revision: 42 } } },
        closeCapture: async () => ({ state: "closed" }),
        writeFile: async (path, contents) => written.push({ path, contents }),
        // The bundle's own leaves: the contract and the writer are REAL, so what this asserts is the manifest on disk.
        identity: {},
        identityKey: () => "identity-key",
        gameSessionId: "game-session-1",
        environmentFacts: { adapter: null, resolution: null },
        PROGRAM_TRACE_FILE: "programTrace.jsonl",
        writeProgramExecutionTrace: async () => {},
        writeEvidenceBundle: (await import("../../lib/evidence-bundle.mjs")).writeEvidenceBundle,
        existsSync,
        join,
        process,
        ledger: { snapshot: () => ({ clock: "run_monotonic", entries: [] }), entries: () => [] },
        ledgerSpans: () => [],
        ledgerSummary: () => ({ count: 0, open: 0, medianMs: null, maxMs: null, sumMs: 0 }),
      },
    );
    writeKilledDump = killedDump;
    await writeKilledDump("SIGINT");
  } finally {
    console.error = originalError;
    if (previousWindowMode === undefined) delete process.env.GAMEBUDDY_WINDOW_MODE;
    else process.env.GAMEBUDDY_WINDOW_MODE = previousWindowMode;
  }

  // 1. The run's own record, published where a reader looks first.
  assert.ok(
    written.length === 1,
    `the killed run must publish exactly one result, got ${written.length}; the dump reported: ${logged.join(" | ")}`,
  );
  const published = JSON.parse(written[0].contents);
  assert.equal(published.state, "killed", "a killed run is not reported as a failed one");
  assert.equal(published.reasonCode, "run_killed_by_signal:SIGINT");
  assert.equal(published.error, undefined, "nothing errored: the run was stopped from outside");
  assert.equal(published.failure, null, "a killed run has no failure moment to locate or replay");
  assert.equal(published.multiday.crossings, 1);
  assert.deepEqual(published.multiday.dayRecords, dayRecords, "the day records the run had already accumulated travel");
  assert.deepEqual(published.attemptedActionIds, ["harvest_crop"], "and so do its counters");

  // 2. The bundle contract's own face of the same run: the killed state reaches the manifest, the day records reach the
  //    manifest, and no failure dump is claimed.
  const manifest = JSON.parse(readFileSync(join(captureDir, "manifest.json"), "utf8"));
  assert.equal(manifest.verdict.state, "killed");
  assert.equal(manifest.verdict.reasonCode, "run_killed_by_signal:SIGINT");
  assert.equal(manifest.failure, null);
  assert.equal(manifest.repro, null);
  assert.equal(manifest.multiday.crossings, 1);
  assert.equal(manifest.multiday.dayRecords.length, 1);
  const traceRows = readFileSync(join(captureDir, "actionTrace.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    validateEvidenceBundle(manifest, { actionTrace: traceRows }).violations,
    [],
    "the killed bundle must satisfy the contract, not merely exist",
  );
  assert.ok(
    logged.some((line) => line.includes("RUNNER_KILLED run_killed_by_signal:SIGINT")),
    "the kill is announced by its code",
  );
});

test("an unobserved program is not a program that dispatched nothing", async () => {
  // Decision (c): a failed journal read and a program that ran nothing are DIFFERENT facts. The falsifier: when the
  // Mod's status query throws or answers not_found, the record is `observed: false` with `dispatched: null` - never
  // `dispatched: 0`, which would silently turn a read failure into a measured empty execution.
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes", {
    executionsFromJournalEvents,
    programNodeOutcomes,
  });
  const failing = await readProgramOutcomes({
    submissions: [{ programId: "p_unreadable", accepted: true }],
    statusQuery: async () => {
      throw new Error("bridge_disconnected");
    },
    eventsQuery: async () => ({ code: "not_found", events: [], nextCursor: 0 }),
  });
  assert.deepEqual(failing, [
    {
      programId: "p_unreadable",
      accepted: true,
      observed: false,
      // The reason, not just the fact: a read that threw is not a program that did nothing, and this field is what
      // tells them apart without searching a log by hand.
      observation: "read_failed:bridge_disconnected",
      dispatched: null,
      executions: [],
      nodeOutcomes: [],
    },
  ]);
  assert.equal(failing[0].dispatched, null, "an unobserved program must not read as dispatched: 0");

  // A programId the Mod never minted (a rejected submit) is unobserved too, and `accepted: false` says why.
  const notFound = await readProgramOutcomes({
    submissions: [{ programId: "p_rejected", accepted: false }],
    statusQuery: async () => ({ code: "not_found", snapshot: null }),
    eventsQuery: async () => ({ code: "not_found", events: [], nextCursor: 0 }),
  });
  assert.equal(notFound[0].observed, false);
  assert.equal(notFound[0].accepted, false);
  assert.equal(notFound[0].dispatched, null);

  // A program with NO programId at all (the submit hook's own null shape) cannot be queried: unobserved, not zero.
  const noId = await readProgramOutcomes({
    submissions: [{ programId: null, accepted: true }],
    statusQuery: async () => {
      throw new Error("must not be queried");
    },
    eventsQuery: async () => ({ code: "not_found", events: [], nextCursor: 0 }),
  });
  assert.equal(noId[0].observed, false);
  assert.equal(noId[0].dispatched, null);
});

test("a program that dispatched three nodes reports dispatched: 3, and its node outcomes", async () => {
  // The positive falsifier: `dispatched` is exactly the count of the Mod's own `native_dispatch` events - the executions
  // the program produced - and the per-node outcomes are what the Mod's status snapshot reports.
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes", {
    executionsFromJournalEvents,
    programNodeOutcomes,
  });
  const events = [
    { cursor: 1, programId: "p1", kind: "admitted", nodeId: "a" },
    { cursor: 2, programId: "p1", kind: "native_dispatch", nodeId: "a", atMs: 1000 },
    { cursor: 3, programId: "p1", kind: "node_succeeded", nodeId: "a", atMs: 1300 },
    { cursor: 4, programId: "p1", kind: "native_dispatch", nodeId: "b", atMs: 2000 },
    { cursor: 5, programId: "p1", kind: "native_dispatch", nodeId: "b", atMs: 2100 },
  ];
  const records = await readProgramOutcomes({
    // The candidate the Host submitted, which is the only place a node's action id and its arguments exist. `c` was
    // never dispatched and the Mod's snapshot does not list it: it must read `unknown`, not be invented from either.
    submissions: [
      {
        programId: "p1",
        accepted: true,
        nodes: [
          {
            nodeId: "a",
            actionId: "till_soil",
            arguments: {
              x: { type: "integer", canonicalValue: "12" },
              y: { type: "integer", canonicalValue: "8" },
            },
          },
          { nodeId: "b", actionId: "plant_seed", arguments: {} },
          { nodeId: "c", actionId: "water_crop", arguments: {} },
        ],
      },
    ],
    statusQuery: async () => ({
      code: "found",
      snapshot: {
        programId: "p1",
        state: "failed",
        nodes: [
          // A veto the Mod recorded in its own words, on a node that never ran.
          { nodeId: "a", state: "rejected", nodeAttempt: 1, admissionAttempt: 1, rejectionCode: "actor_held_by_modal" },
          // A node whose outcome is unknown. `BodyProgramJournalPersistence.cs:241` FORBIDS a reason code on this
          // state, so the snapshot cannot carry one and none may be invented here.
          { nodeId: "b", state: "recovery_required", nodeAttempt: 1, admissionAttempt: 1 },
        ],
      },
    }),
    eventsQuery: async (_programId, cursor) =>
      cursor === 0
        ? { code: "found", events, nextCursor: 5, highWater: 5 }
        : { code: "found", events: [], nextCursor: 5, highWater: 5 },
  });
  assert.equal(records[0].observed, true);
  assert.equal(records[0].dispatched, 3, "three native_dispatch events are three executions");
  assert.deepEqual(
    records[0].executions,
    [
      { nodeId: "a", nodeAttempt: null, cursor: 2, atMs: 1000, settledAtMs: null },
      { nodeId: "b", nodeAttempt: null, cursor: 4, atMs: 2000, settledAtMs: null },
      { nodeId: "b", nodeAttempt: null, cursor: 5, atMs: 2100, settledAtMs: null },
    ],
    "each execution keeps the journal's own identity, which is what makes it a trace row rather than a count",
  );
  // THE DEFECT THIS PINS: a measured run's bundle held 154 node outcomes, 31 of them `recovery_required` and 9
  // `failed`, and not one said why - no reason, no action, no tile. The same run's settlement digest carried all three
  // for the same nodes, so the bundle's copy was the poorer spelling of one fact.
  assert.deepEqual(records[0].nodeOutcomes, [
    { nodeId: "a", actionId: "till_soil", state: "rejected", reasonCode: "actor_held_by_modal", tile: { x: 12, y: 8 } },
    { nodeId: "b", actionId: "plant_seed", state: "recovery_required" },
    { nodeId: "c", actionId: "water_crop", state: "unknown" },
  ]);

  // A found program with NO native_dispatch events is a real measured zero: observed, dispatched: 0.
  const idle = await readProgramOutcomes({
    submissions: [{ programId: "p2", accepted: true, nodes: [{ nodeId: "a", actionId: "till_soil", arguments: {} }] }],
    statusQuery: async () => ({ code: "found", snapshot: { programId: "p2", state: "succeeded", nodes: [] } }),
    eventsQuery: async () => ({ code: "found", events: [], nextCursor: 0, highWater: 0 }),
  });
  assert.equal(idle[0].observed, true);
  assert.equal(idle[0].dispatched, 0, "observed-with-zero and unobserved are distinct facts");
});

test("lineage is attached only when the receipt carries it, never synthesised", () => {
  // Decision (c) conditional attach: today the Mod mints the program binding internally and receipts carry no program
  // field, so the lineage is EMPTY for a real run. The falsifier: a receipt with no lineage yields no keys (unattributed,
  // not guessed), a receipt with a programId field or a `program_id=` marker yields exactly what it carried.
  const traceLineage = extractRunnerFunction(RUNNER_SOURCE, "traceLineage");
  assert.equal(traceLineage({ state: "succeeded", reasonCode: "soil_tilled", evidence: { detail: "x=1" } }), null);
  assert.equal(traceLineage(null), null);
  assert.equal(traceLineage({ evidence: null }), null);
  assert.deepEqual(traceLineage({ programId: "p1", nodeId: "a" }), { programId: "p1", nodeId: "a" });
  assert.deepEqual(traceLineage({ evidence: { detail: "program_id=p9;node_id=cut" } }), {
    programId: "p9",
    nodeId: "cut",
  });
  // The receipt's own field wins a direct conflict with a marker, and an empty marker is not a lineage.
  assert.deepEqual(traceLineage({ programId: "direct", evidence: { detail: "program_id=marker" } }), {
    programId: "direct",
  });
  assert.equal(traceLineage({ evidence: { detail: "program_id=;node_id=" } }), null);

  // The trace entry reads it: an unattributed receipt cannot gain the field, and an attributed one carries it.
  const execute = RUNNER_SOURCE.slice(
    RUNNER_SOURCE.indexOf("client.execute = async (request) => {"),
    RUNNER_SOURCE.indexOf("// Capture the Agent-authored program id"),
  );
  assert.match(execute, /\.\.\.\(traceLineage\(receipt\) \?\? \{\}\)/);
});

/** One `execution_receipt` fact exactly as the runner's recorder projects it: identity flattened, receipt kept whole. */
function recordedActionReceipt(actionId, reasonCode, state = "succeeded", requestId = `req_${actionId}`) {
  const receipt = {
    executionId: `exec_${requestId}`,
    requestId,
    actionId,
    state,
    reasonCode,
    revision: 1,
    evidence: null,
  };
  return {
    type: "execution_receipt",
    reasonCode,
    requestId,
    executionId: receipt.executionId,
    worldFactPayload: receipt,
  };
}

test("a day's work is read from the receipts both dispatch channels produce", () => {
  // THE MEASURED DEFECT (round7, 2026-10-29). `accomplishedSince` walked `actionTrace.slice(startIndex)`, and
  // `actionTrace` records FLAT single-step dispatches only: that run's file was 0 bytes while all 251 physical actions
  // ran through 53 `stardew_plan_work` batches. So `nextDayAccomplishedActionIds` came back empty and the baseline
  // reported `next_day_produced_no_farm_work` about a day that cut 86 weeds and broke 48 rocks.
  //
  // The receipts are the authority for BOTH channels and they name their own action: the Mod stamps `actionId` onto
  // every published receipt from the router's own binding (`ExecutionManager.AddTrace`), so a program node's terminal
  // arrives in the same fact log as a flat dispatch's, carrying `weeds_cut`/`rock_source_broken` verbatim. What a
  // receipt proves is what the counter needs - the action reached its DECLARED terminal with a success state - and
  // that is strictly stronger than `executedActionIds`, which answers attempt/success from node state and can never
  // name a reason code.
  // The day's work, declared once: every receipt built here is recorded as what the fixture says the day did, so the
  // expectation below is collected from this same log instead of being a second, hand-typed list of action ids.
  const dayWork = [];
  const workedReceipt = (actionId, reasonCode, requestId = `req_${actionId}`) => {
    dayWork.push(actionId);
    return recordedActionReceipt(actionId, reasonCode, "succeeded", requestId);
  };
  const factLog = [
    // 86 weeds and 48 rocks, as that day produced them: every one a succeeded/terminal receipt.
    ...Array.from({ length: 86 }, (_, index) => workedReceipt("cut_weeds", "weeds_cut", `weed_${index}`)),
    ...Array.from({ length: 48 }, (_, index) => workedReceipt("break_rock", "rock_source_broken", `rock_${index}`)),
    workedReceipt("harvest_crop", "crop_harvested"),
    workedReceipt("plant_seed", "seed_planted"),
    workedReceipt("water_crop", "crop_watered"),
    // What the day also did, and what must NOT count: motion, gear, and the task's own progress reports.
    recordedActionReceipt("move_to_tile", "target_reached"),
    recordedActionReceipt("equip_tool", "tool_equipped"),
    recordedActionReceipt("sleep", "day_advanced"),
    recordedActionReceipt("dismiss_modal", "modal_dismissed"),
    // A non-receipt fact in the same log is not work either.
    { type: "world_fact", reasonCode: null, requestId: null, worldFactPayload: { kind: "day_started" } },
  ];
  const [recordedReceipt, receiptsSince, accomplishedSince] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["recordedReceipt", "receiptsSince", "accomplishedSince"],
    {
      factLog,
      actionTrace: [],
      NON_ACCOMPLISHMENT_ACTIONS: new Set(["move_to_tile", "equip_tool"]),
      STARDEW_PUBLISHED_ACTION_GATES,
    },
  );
  assert.ok(recordedReceipt, "the receipt reader is part of the same scope");

  assert.deepEqual(
    accomplishedSince(0),
    [...new Set(dayWork)].sort(),
    "the day cut weeds, broke rocks, harvested, planted and watered - an empty flat trace does not unmake any of it",
  );

  // The CODE path, not just the number: the read is the fact log's, and the flat trace is no longer a source at all.
  // A dispatch row is not evidence of a terminal, and the join it used to need (`fact.requestId === entry.requestId`)
  // disappeared with it - the receipt carries the action id itself. The window moved one function down into
  // `receiptsSince`, which is the only place a receipt leaves the log, so the assertions follow it there.
  const windowBody = receiptsSince.toString();
  assert.match(windowBody, /factLog\s*\n?\s*\.slice\(startFactIndex\)/u, "the window is the fact log's own position");
  assert.match(windowBody, /recordedReceipt/u, "the receipt is read from where the recorder puts it");
  const body = accomplishedSince.toString();
  assert.match(body, /receipt\.actionId/u, "the action is named by the Mod's receipt, never guessed");
  assert.doesNotMatch(body, /actionTrace/u, "the flat trace is not a source of terminals");
  assert.doesNotMatch(body, /entry\.requestId/u, "there is no trace row to join the receipt against");

  // The window is real: a receipt recorded before this day began is not this day's work.
  assert.deepEqual(accomplishedSince(factLog.length), [], "nothing recorded since now is no work");
  const afterFirst = accomplishedSince(factLog.length - 8);
  assert.ok(
    afterFirst.every((actionId) => ["harvest_crop", "plant_seed", "water_crop"].includes(actionId)),
    `only receipts inside the window count, got ${JSON.stringify(afterFirst)}`,
  );
});

test("a receipt that only progressed an action is an attempt, never work", () => {
  // The bar this counter must not lower. `executedActionIds` answers "this action was attempted" from a dispatch or a
  // node state past admission; the baseline asks the stronger question - did the action reach its DECLARED terminal -
  // because crediting an attempt as work turns a false negative into a false positive.
  const factLog = [
    // Dispatched and still running: an attempt, and nothing more.
    recordedActionReceipt("cut_weeds", "accepted", "accepted", "r1"),
    recordedActionReceipt("cut_weeds", "controller_started", "running", "r2"),
    // A succeeded receipt carrying a PROGRESS code instead of the registered terminal: the action moved, it did not finish.
    recordedActionReceipt("harvest_crop", "tool_approach_completed", "succeeded", "r3"),
    // A terminal code with the wrong state: refused work is not credited.
    recordedActionReceipt("break_rock", "rock_source_broken", "rejected", "r4"),
    recordedActionReceipt("plant_seed", "seed_planted", "failed", "r5"),
    // An action with no published gate declares no terminal, so nothing can prove it finished.
    recordedActionReceipt("fridge_store", "item_stored", "succeeded", "r6"),
    // And the one action that IS a registered gate with a success state, so the test cannot pass by counting nothing.
    recordedActionReceipt("water_crop", "crop_watered", "succeeded", "r7"),
  ];
  const accomplishedSince = extractRunnerFunction(
    RUNNER_SOURCE,
    ["recordedReceipt", "receiptsSince", "accomplishedSince"],
    {
      factLog,
      actionTrace: [],
      NON_ACCOMPLISHMENT_ACTIONS: new Set(["move_to_tile"]),
      STARDEW_PUBLISHED_ACTION_GATES,
    },
  )[2];
  assert.deepEqual(accomplishedSince(0), ["water_crop"], "only the receipt that finished its declared action is work");

  // A night the engine crossed by itself has no `advance_day` receipt at all; it must never read as farm work.
  const nightOnly = extractRunnerFunction(RUNNER_SOURCE, ["recordedReceipt", "receiptsSince", "accomplishedSince"], {
    factLog: [recordedActionReceipt("sleep", "day_advanced")],
    actionTrace: [],
    NON_ACCOMPLISHMENT_ACTIONS: new Set(),
    STARDEW_PUBLISHED_ACTION_GATES,
  })[2];
  assert.deepEqual(nightOnly(0), [], "crossing the day is the loop's own producer, not what the loop produces");
});

test("one action dispatched through both channels is one accomplishment", () => {
  // A flat dispatch and a program node are different EXECUTIONS of possibly the same action. The counter answers which
  // ACTIONS produced work, so `cut_weeds` done both ways - or done eighty-six times the same way - is one entry.
  const factLog = [
    recordedActionReceipt("cut_weeds", "weeds_cut", "succeeded", "flat_1"),
    recordedActionReceipt("cut_weeds", "weeds_cut", "succeeded", "program_1"),
    recordedActionReceipt("cut_weeds", "weeds_cut", "partially_succeeded", "program_2"),
    recordedActionReceipt("break_rock", "rock_source_broken", "succeeded", "flat_2"),
  ];
  const accomplishedSince = extractRunnerFunction(
    RUNNER_SOURCE,
    ["recordedReceipt", "receiptsSince", "accomplishedSince"],
    {
      factLog,
      actionTrace: [],
      NON_ACCOMPLISHMENT_ACTIONS: new Set(),
      STARDEW_PUBLISHED_ACTION_GATES,
    },
  )[2];
  assert.deepEqual(accomplishedSince(0), ["break_rock", "cut_weeds"], "one action, counted once");
});

test("a settled turn keeps the day going, and the single accessor is what says so", () => {
  // The day loop used to read `walked.settled` on the `{ turn, status }` envelope and break after the first turn
  // of every day: `undefined !== true`. Day 2 was then judged idle and the scheduled player lines were never
  // reached. The shape has one accessor so a second caller cannot spell it differently.
  const settledTurn = { turn: { settled: true, reason: null }, status: null };
  const unsettledTurn = { turn: { settled: false, reason: "agent_turn_timeout" }, status: null };

  assert.equal(turnSettled(settledTurn), true);
  assert.equal(turnSettled(unsettledTurn), false);
  // The old reading, kept here so the difference is visible: the envelope has no such field.
  assert.equal(settledTurn.settled, undefined);
  assert.equal(settledTurn.settled === true, false);
});

/**
 * The instrument globals `buildRunResult` reads: the run's memory sampler, the projection it publishes, and the ONE path
 * its result is written to. Real implementations, not doubles - the projection is asserted on its own in
 * `tools/lib/live-run-memory.test.mjs`, and a double here would let the assembly publish a series nobody measured.
 */
const instrumentGlobals = Object.freeze({
  hostMemory: Object.freeze({
    samples: 0,
    startRssMb: null,
    minRssMb: null,
    maxHostRssMb: null,
    minFreeMb: null,
    turns: [],
    turnsOmitted: 0,
  }),
  summarizeHostMemory,
  RESULT_FILE: "/tmp/gb-runner-result.json",
});

/** The globals `buildRunResult` reads besides the ones a test supplies, kept in one place for the reason tests below. */
function builderGlobals(overrides = {}) {
  return {
    ...instrumentGlobals,
    executedActionIds,
    // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once and
    // hands it to its own clause, so a test of the builder supplies the real implementations. The surface and the
    // census builder are real too - the denominator of a run is its OWN published census, and a double here would let
    // a test pass against a world the runner could never produce.
    measureActionBreadth,
    actionBreadthClause,
    deliveryAccountClause,
    readActionBreadthSurface,
    buildSnapshotCensus,
    snapshotFamilyRows: new Map(),
    snapshotCensusSamples: 0,
    NON_ACCOMPLISHMENT_ACTIONS: new Set(["move_to_tile"]),
    phaseTimings: { runStartedAtMs: 1, marks: {} },
    lastObservedSnapshot: null,
    lastObservedPose: null,
    actionTrace: [],
    programSubmissions: [],
    programOutcomes: [],
    sampleProgramOutcomes: async () => [],
    programExecutionRows,
    executionTraceInvariant,
    TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
    multidayOutcome: null,
    SCENARIO: "multiday_routine",
    LEGACY_LADDER: null,
    historianRubricOutcome: null,
    runSessionRecord: Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" }),
    summarizeActionCadence: () => ({ spans: [] }),
    summarizePresentationEvidence: () => NOTHING_PRESENTED,
    readToolTiming: () => ({ observed: false, invariant: { checked: false, ok: null } }),
    summarizeRunCost,
    describeRunCost,
    buildFailureSnapshot: (input) => input,
    writeRunBundle: async () => ({ state: "written", runDir: "/run" }),
    closeCapture: async () => ({ state: "closed" }),
    writeFile: async () => {},
    join: (...parts) => parts.join("/"),
    ...overrides,
  };
}

/** ROUND38'S OWN CLAUSE LIST, in the order the runner declares it (measured 2026-11-06). */
const ROUND38_CLAUSES = Object.freeze([
  { id: "morning_routine", passed: true, reasonCode: "multiday_routine_blocked" },
  { id: "memory_covenant", passed: true, reasonCode: "covenant_not_honoured" },
  { id: "npc_social_and_presence", passed: true, reasonCode: "harvest_and_offer_not_delivered" },
  { id: "multiday_routine", passed: true, reasonCode: "multiday_routine_blocked" },
  { id: "context", passed: true, reasonCode: "no_expectation_configured" },
  { id: "content", passed: true, reasonCode: "no_expectation_configured" },
  { id: "world_book", passed: true, reasonCode: "product_has_no_world_book_configured" },
  { id: "companion_interaction", passed: false, reasonCode: "summary_too_long" },
  { id: "historian_rubric", passed: true, reasonCode: "historian_rubric_passed" },
]);

test("a blocked run names the clause that failed, never the scenario it ran in", async () => {
  // MEASURED 2026-11-06 (`round38`): the bundle published `state: "blocked"` with
  // `failure.reasonCode: "multiday_routine_blocked"` while `multiday.assessment.state` was "passed",
  // `sessionVerdict` "completed" and `historianRubric.state` "passed". The only clause the run failed was its
  // companion-interaction gate - `summary_too_long`, a 124-character line - and the artifact said none of that.
  // The code came from `buildRunResult`'s fallback, `${SCENARIO}_blocked`, which names the RUNG and not the fault.
  const deriveRungVerdict = extractRunnerFunction(RUNNER_SOURCE, "deriveRungVerdict");
  assert.deepEqual(
    deriveRungVerdict([{ id: "a", passed: true, reasonCode: "x" }]),
    { state: "passed", reasonCode: null, failedClause: null, failedClauses: [] },
    "`passed` is the residual: no clause objected",
  );
  assert.deepEqual(
    deriveRungVerdict([
      { id: "multiday_routine", passed: true, reasonCode: "multiday_routine_blocked" },
      { id: "companion_interaction", passed: false, reasonCode: "summary_too_long" },
    ]),
    {
      state: "blocked",
      reasonCode: "summary_too_long",
      failedClause: "companion_interaction",
      failedClauses: [{ id: "companion_interaction", reasonCode: "summary_too_long" }],
    },
    "a code that names something which passed must not be able to stand in for the clause that failed",
  );
  // A SECOND failing clause is published, not swallowed: round39's rung reason was the multi-day block while its own
  // task purposes were all `unproven`. One reason is honest; a verdict that cannot see the second finding is not.
  assert.deepEqual(
    deriveRungVerdict([
      { id: "multiday_routine", passed: false, reasonCode: "multiday_routine_blocked" },
      { id: "task_purpose", passed: false, reasonCode: "task_unproven:clear_and_plant_long_patch:no_tiles" },
      { id: "context", passed: true, reasonCode: "no_expectation_configured" },
    ]).failedClauses,
    [
      { id: "multiday_routine", reasonCode: "multiday_routine_blocked" },
      { id: "task_purpose", reasonCode: "task_unproven:clear_and_plant_long_patch:no_tiles" },
    ],
    "every failing clause is named, in the order the rung reads them",
  );

  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    builderGlobals(),
  );
  const result = await buildRunResult({ rungClauses: ROUND38_CLAUSES, settlement: null });
  assert.equal(result.state, "blocked");
  assert.equal(result.failure.reasonCode, "summary_too_long", "the failure record names the clause that failed");
  assert.equal(result.reasonCode, "summary_too_long", "and the result's own reason agrees with it, one spelling");
  assert.doesNotMatch(result.failure.reasonCode, /_blocked$/u, "the scenario's own name is not a diagnosis");
  // The passing side, so this is not a gate that reds everything: the same list with the interaction gate satisfied.
  const passed = await buildRunResult({
    rungClauses: ROUND38_CLAUSES.map((clause) => ({ ...clause, passed: true })),
    settlement: null,
  });
  assert.equal(passed.state, "passed");
  assert.equal(passed.failure, null);
  assert.equal(passed.reasonCode, undefined, "a passed run publishes no reason at all");
});

test("an unproven task is not a pass: the arm names the criterion it could not decide", async () => {
  // ROUND39'S OWN PURPOSES, verbatim from `_multiday_routine-round39.result.json` (measured 2026-11-07). All three
  // days came back `unproven`, and the run's verdict named none of them: the arm read only `not_achieved`, so the
  // residual `completed` stood for "the task may have happened" on a day whose receipts could not say where any plot was.
  const ROUND39_TASK_PURPOSES = Object.freeze([
    Object.freeze({
      day: 1,
      task: "clear_and_plant_long_patch",
      taskId: "clear_and_plant_long_patch",
      state: "unproven",
      reasonCode: "task_purpose_has_no_tile_coordinates",
      purpose: "one long strip, three tiles wide and twenty long, was tilled and sown the whole way",
      missingFact:
        "no receipt of this run carried a tile for the patch: `till_soil` names the tile it turned and `plant_seed`/`water_crop` name the tile their crop is on, so with none of those admitted nothing says where the plot was. This is the run's observation gap, not a failure of the companion's.",
    }),
    Object.freeze({
      day: 2,
      task: "craft_and_place_machine",
      taskId: "craft_and_place_machine",
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: "a machine was crafted, then put down, then put to work",
      missingFact: null,
    }),
    Object.freeze({
      day: 3,
      task: "town_market",
      taskId: "town_market",
      state: "unproven",
      reasonCode: "task_purpose_needs_an_unpublished_fact",
      purpose: "something was bought in town and the post was brought in",
      missingFact:
        "no published fact places the actor in Town: `shop_purchase` publishes the shop and `claim_mail_attachment` the farm mailbox, neither publishes a map, and `travel` publishes endpoints only when travel is the route that was used.",
    }),
  ]);
  const [taskPurposeVerdict, deriveSessionVerdict] = extractRunnerFunction(RUNNER_SOURCE, [
    "taskPurposeVerdict",
    "deriveSessionVerdict",
  ]);
  // Everything a playable session must also have, so the only thing left to decide is the task. round39's own
  // `multidayAssessment` is the PASSING shape here on purpose: this test is about the arm the multi-day block hid.
  const playable = {
    worldStallReason: null,
    sessionTurns: [{ turn: { settled: true } }],
    unsettledTurns: [],
    turnFailureReason: undefined,
    bridgeDisconnections: [],
    hostMemory: null,
    sessionSpoken: true,
    accomplishedActionIds: ["till_soil", "plant_seed", "water_crop"],
    multidayAssessment: { state: "passed", ok: true, violations: [] },
    agentTurnOutcome: { stopReason: "stop" },
    morningLiveness: { violations: [] },
    dialogueGates: [],
  };
  const verdict = deriveSessionVerdict({ ...playable, taskPurposes: ROUND39_TASK_PURPOSES });
  assert.match(verdict, /^task_unproven:/u, "an undecidable task is a verdict, not a pass");
  // EVERY criterion and its OWN reason: a reader learns which purposes were unprovable and why, without opening the
  // artifact's `taskPurposes` - and no reason is paraphrased here.
  for (const purpose of ROUND39_TASK_PURPOSES)
    assert.ok(
      verdict.includes(`${purpose.taskId}:${purpose.reasonCode}`),
      `${purpose.taskId} must be named with its own reason: ${verdict}`,
    );
  assert.equal(
    taskPurposeVerdict(ROUND39_TASK_PURPOSES),
    verdict,
    "the clause and the session verdict report the task from one derivation",
  );

  // THE FALSIFIERS. A gate that reds every run would be as useless as one that passes every run.
  assert.equal(
    deriveSessionVerdict({
      ...playable,
      taskPurposes: ROUND39_TASK_PURPOSES.map((purpose) => ({
        ...purpose,
        state: "achieved",
        reasonCode: "task_purpose_achieved",
      })),
    }),
    "completed",
    "an achieved task is not named as a failure",
  );
  assert.equal(
    deriveSessionVerdict({
      ...playable,
      taskPurposes: [
        { taskId: "mine_delve", state: "not_achieved", reasonCode: "task_purpose_not_achieved" },
        ...ROUND39_TASK_PURPOSES,
      ],
    }),
    "task_not_achieved",
    "complete evidence that a purpose did not hold outranks an undecidable one",
  );
  assert.equal(
    deriveSessionVerdict({ ...playable, taskPurposes: [] }),
    "completed",
    "a scenario that names no task is judged on its session alone",
  );

  // AND THE RUN'S OWN VERDICT CARRIES IT. round39's rung reason was `multiday_routine_blocked`, and the task finding
  // existed in no verdict field at all; a second failing clause is now published beside the first.
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    builderGlobals(),
  );
  const taskCode = taskPurposeVerdict(ROUND39_TASK_PURPOSES);
  const runResult = await buildRunResult({
    rungClauses: [
      { id: "morning_routine", passed: true, reasonCode: verdict },
      { id: "multiday_routine", passed: false, reasonCode: "multiday_routine_blocked" },
      { id: "task_purpose", passed: false, reasonCode: taskCode },
      { id: "context", passed: true, reasonCode: "no_expectation_configured" },
    ],
    settlement: null,
  });
  assert.equal(runResult.reasonCode, "multiday_routine_blocked", "the first failing clause still names the reason");
  assert.deepEqual(
    runResult.failedClauses,
    [
      { id: "multiday_routine", reasonCode: "multiday_routine_blocked" },
      { id: "task_purpose", reasonCode: taskCode },
    ],
    "and the task the run could not be proved to have done is named beside it",
  );
});

test("a run that used a handful of the addressable actions fails its own `action_breadth` clause", async () => {
  // MEASURED 2026-11-07 (`round39`): `executionTrace: { ok: true, rows: 124 }`, 124 executions all `succeeded`-shaped,
  // a `completed` session, and 15 distinct actions attempted - most of the surface it was given never touched, and
  // nothing in the artifact said so. The clause exists so that shape is in the run's OWN verdict.
  //
  // The denominator is the run's OWN census: the families its snapshots carried rows for. This fixture's world shows
  // weeds and a harvestable crop, so `cut_weeds` and `harvest_crop` are target-bound-addressable and `move_to_tile`
  // needs no row at all - everything else in the catalog is world this run never had, and is not charged to it. The
  // reading is the real one (the real catalog and the real `tools/action-breadth-baseline.json`): three actions in
  // three families over twelve executions cannot meet a ratchet recorded at 24 attempts in 11 families.
  const programId = "plan_breadth";
  const nodeIds = ["n1", "n2", "n3"];
  const programOutcomes = Object.freeze([
    Object.freeze({
      programId,
      observed: true,
      dispatched: 12,
      executions: Object.freeze(
        nodeIds.flatMap((nodeId, nodeIndex) =>
          [1, 2, 3, 4].map((nodeAttempt) =>
            Object.freeze({
              nodeId,
              nodeAttempt,
              cursor: nodeIndex * 4 + nodeAttempt,
              atMs: nodeIndex * 10 + nodeAttempt,
              settledAtMs: nodeIndex * 10 + nodeAttempt + 1,
            }),
          ),
        ),
      ),
      nodeOutcomes: Object.freeze(nodeIds.map((nodeId) => Object.freeze({ nodeId, state: "succeeded" }))),
    }),
  ]);
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    builderGlobals({
      programSubmissions: [
        {
          programId,
          code: "accepted",
          accepted: true,
          nodes: [
            { nodeId: "n1", actionId: "cut_weeds" },
            { nodeId: "n2", actionId: "harvest_crop" },
            { nodeId: "n3", actionId: "move_to_tile" },
          ],
        },
      ],
      // Two target families seen with rows, over two snapshots this run read.
      snapshotFamilyRows: new Map([
        ["weedTargets", 16],
        ["harvestTargets", 3],
      ]),
      snapshotCensusSamples: 2,
    }),
  );
  // Every OTHER clause of round38's run satisfied: the breadth clause alone has to be what stops this run.
  const satisfied = ROUND38_CLAUSES.map((clause) => ({ ...clause, passed: true }));
  const blocked = await buildRunResult({
    rungClauses: satisfied,
    programOutcomesAtTeardown: programOutcomes,
    settlement: null,
  });
  assert.equal(blocked.state, "blocked", "a run that barely used the surface is not a passed run");
  assert.equal(blocked.failedClause, "action_breadth");
  assert.match(blocked.reasonCode, /^narrow:below_baseline:/u, "the reason names the ratchet it fell below");
  assert.equal(blocked.failure.reasonCode, blocked.reasonCode, "the failure dump and the result tell one story");
  assert.equal(blocked.actionBreadth.attempted, 3);
  assert.equal(blocked.actionBreadth.families, 3);
  assert.ok(blocked.actionBreadth.published > blocked.actionBreadth.attempted, "the catalog stays visible as context");
  assert.ok(
    blocked.actionBreadth.addressable > 0 && blocked.actionBreadth.addressable < blocked.actionBreadth.published,
    "and the denominator is the world this run was given, not the catalog it could never use",
  );
  assert.equal(blocked.actionBreadth.addressableTargetBound, 2, "weeds and crops: the two families the census carried");
  assert.equal(
    blocked.snapshotCensus.source,
    "runner_observations",
    "the world the reading was measured against is published with the result",
  );
  assert.deepEqual(
    blocked.snapshotCensus.families.filter((entry) => entry.rows > 0),
    [
      { family: "harvestTargets", rows: 3 },
      { family: "weedTargets", rows: 16 },
    ],
    "and it names every target family, so an empty one can be told from an unobserved one",
  );
  assert.equal(
    blocked.actionBreadth.verdict,
    blocked.reasonCode,
    "the published reading and the verdict are the same string, not two spellings",
  );
  // The passing side: a run nothing could be measured on is NOT narrow, and its clause does not object. The ratchet is
  // recorded at 24 actions and no synthetic fixture reaches it, so the honest non-narrow case here is `not_measured` -
  // what must not happen is that a gap in our own reading blocks the run.
  const unmeasured = await buildRunResult({ rungClauses: satisfied, settlement: null });
  assert.equal(unmeasured.state, "passed");
  assert.equal(unmeasured.failedClause, null);
  assert.match(unmeasured.actionBreadth.verdict, /^not_measured:/u);
});

test("a run whose execution record could not be read to the end cannot be `passed`", async () => {
  // `executionTrace.ok` was published and consumed by nobody: measured 2026-11-06, round38 published
  // `{ ok: false, unobservedPrograms: 9, rows: 379, expectedRows: 379 }` and the field never reached a verdict. A red
  // flag nobody reads is decoration, so it is a clause - the LAST one, because it qualifies the clauses above rather
  // than competing with them.
  const [, buildRunResult] = extractRunnerFunction(
    RUNNER_SOURCE,
    ["summarizeDispatchedActions", "buildRunResult", "deriveRungVerdict", "planPollCount"],
    builderGlobals(),
  );
  const unread = [{ programId: "p_unobserved", observed: false, dispatched: null, executions: [] }];
  const blocked = await buildRunResult({
    rungClauses: ROUND38_CLAUSES.map((clause) => ({ ...clause, passed: true })),
    settlement: null,
    programOutcomesAtTeardown: unread,
  });
  assert.equal(blocked.executionTrace.ok, false, "an unobserved program makes the trace incomplete");
  assert.equal(blocked.state, "blocked", "a pass cannot rest on evidence the run failed to read");
  assert.equal(blocked.failure.reasonCode, "execution_trace_incomplete");

  // AND IT DOES NOT STEAL THE REASON. round38's trace was incomplete for this reason, and its actual defect was the
  // companion's 124-character line: reporting the unread journal instead would have hidden the finding the run was red
  // for in the first place.
  const both = await buildRunResult({
    rungClauses: ROUND38_CLAUSES,
    settlement: null,
    programOutcomesAtTeardown: unread,
  });
  assert.equal(both.failure.reasonCode, "summary_too_long", "the first clause that failed is the reason");
});

test("the observation block counts executions from both channels, and says `not_measured` when it cannot", () => {
  // MEASURED 2026-11-06 (`round38`): 379 program executions and the block published `actionCount: 0`,
  // `rejectionCount: 0` - a zero that means "no request frame was sent" reading exactly like "this run did nothing".
  const [buildRunObservation] = extractRunnerFunction(RUNNER_SOURCE, ["buildRunObservation"], { createHash, process });
  const common = {
    prompt: "a day on the farm",
    scenario: "multiday_routine",
    turnStartedAtMs: 1,
    factLog: [],
    contextAssembled: true,
    worldBookAssembled: true,
    presentedSummary: "收工了。",
    runManifestModel: null,
  };
  const batched = buildRunObservation({
    ...common,
    actionTrace: [],
    executionTrace: { ok: false, flat: 0, program: 379, rows: 379, programDispatches: 379, unobservedPrograms: 9 },
  });
  assert.equal(batched.actionCount, 379, "the count is every execution the run had, not the flat half");
  assert.deepEqual(batched.executionChannels, { flat: 0, program: 379 });
  assert.equal(batched.actionCountNotMeasured, null);
  // A rejection count over zero request frames is not "no rejections": the state of a program node lives in the Mod
  // journal, so the block names the input it is missing instead of publishing a zero it cannot support.
  assert.equal(batched.rejectionCount, null);
  assert.equal(batched.rejectionRate, null);
  assert.match(batched.rejectionNotMeasured ?? "", /flat_request_frames_only/u);

  // The other side: a run that dispatched flat is measured, and the numbers are its own.
  const flat = buildRunObservation({
    ...common,
    actionTrace: [
      { action: "till_soil", state: "succeeded" },
      { action: "plant_seed", state: "rejected" },
    ],
    executionTrace: { ok: true, flat: 2, program: 0, rows: 2, programDispatches: 0, unobservedPrograms: 0 },
  });
  assert.equal(flat.actionCount, 2);
  assert.equal(flat.rejectionCount, 1);
  assert.equal(flat.rejectionRate, 0.5);
  assert.equal(flat.rejectionNotMeasured, null);

  // And when no journal was read at all, the count is not a zero: it is absent, and the field says why.
  const unread = buildRunObservation({ ...common, actionTrace: [], executionTrace: null });
  assert.equal(unread.actionCount, null);
  assert.equal(unread.executionChannels, null);
  assert.match(unread.actionCountNotMeasured ?? "", /no_program_journal_read/u);
});

test("the day's shortage fact is composed once, on the first turn, and published beside the task verdicts", () => {
  // The runner must hand the fact over through the module whose once-ness is testable, not re-compose the sentence
  // here: a second spelling of the composition is how a fact quietly becomes an instruction on every turn.
  assert.match(
    RUNNER_SOURCE,
    /import \{ dayPromptWithFact, seedShortageFact \} from "\.\.\/\.\.\/lib\/seed-shortage\.mjs"/,
  );
  assert.match(RUNNER_SOURCE, /const withDayFact = \(prompt, fact\) => dayPromptWithFact\(prompt, fact, localeKey\)/);
  // ONCE PER DAY: the fact is computed under the first-turn guard, from the world as it stands then.
  assert.match(
    RUNNER_SOURCE,
    /const dayFact =\s*turns === 1\s*\?\s*seedShortageFact\(\{/,
    "the fact is computed on the day's first turn and on no other turn",
  );
  assert.match(RUNNER_SOURCE, /taskId: taskForDay\(day\),\s*snapshot: client\.state\?\.snapshot \?\? null,/);
  // And the first-turn prompt is the one that carries it: a fact appended to a continuation turn would repeat.
  assert.match(RUNNER_SOURCE, /turns === 1\s*\?\s*withDayFact\(promptForDay\(day\), dayFact\)/);
  // Published, so "she was handed the supply and did not go" is distinguishable from "nothing ever told her".
  assert.match(RUNNER_SOURCE, /const seedFacts = \[\];/);
  assert.match(RUNNER_SOURCE, /if \(dayFact !== null\) seedFacts\.push\(Object\.freeze\(\{ day, \.\.\.dayFact \}\)\);/);
  assert.match(RUNNER_SOURCE, /\n    seedFacts,/);
});
