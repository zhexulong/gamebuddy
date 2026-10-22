import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveLiveRunRoot } from "../core/capture.mjs";
import { validateEvidenceBundle } from "../../lib/evidence-bundle.mjs";
import { classifyNight } from "../../lib/multiday-baseline.mjs";
import { TERMINAL_STATES } from "../../lib/stardew-native-smoke-harness-v1.mjs";

const RUNNER_SOURCE = await readFile(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");
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
  const end = source.indexOf("parameters: bodyProgramToolParameters(name)", descriptionAt);
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
  assert.match(RUNNER_SOURCE, /const gameSessionId = `game-\$\{Date\.now\(\)\}`/);
  assert.match(RUNNER_SOURCE, /resolveRuntimePaths\(identity, runtimeRoot, gameSessionId\)/);
  assert.match(RUNNER_SOURCE, /readAssembledContextEvidence\(gameSessionPaths\)/);
  assert.match(RUNNER_SOURCE, /gameSessionId,/);
});

test("a model profile is filled only where one is missing, never overwritten", () => {
  assert.match(RUNNER_SOURCE, /const usesDisposableRoot = !usesConfiguredRuntimeRoot;/);
  // The gate is now "the root has no profile", not "the root is disposable": a configured root without one used to
  // fall through to the Host's default model, which is not in the runtime's own catalog, and the run died with
  // `provider_error:404 model_not_found` while its manifest said `deepseek-v4-flash` (measured 2026-10-21). Filling a
  // gap is safe; overwriting an operator's choice would not be, so the gate must READ before it writes.
  const gapGate = RUNNER_SOURCE.indexOf("if (!hasModelProfile)");
  const profileRead = RUNNER_SOURCE.indexOf("const hasModelProfile");
  assert.ok(profileRead >= 0 && gapGate > profileRead, "the profile is READ before anything is decided");
  // The write is pinned as a pair with its gate, because the path literal itself now appears earlier (in the constant
  // that the gate reads), so a character-position comparison cannot express "the gate precedes the write".
  assert.match(
    RUNNER_SOURCE,
    /if \(!hasModelProfile\)\s*await writeFile\(\s*modelProfilePath/,
    "the write goes to the path that was read",
  );
});

test("the runner enforces a companion-interaction gate on every speaking scenario", () => {
  // The gate must be wired into the verdict so a "checklist of what I did" closing
  // line blocks the run instead of passing silently.
  assert.match(RUNNER_SOURCE, /assessCompanionInteraction/);
  // The interaction gate publishes an OUTCOME vocabulary: `unobserved` means nobody could assess the reply,
  // which must stay distinguishable from `verified`. The old boolean (`=== null || .passed`) could not say
  // which, and the verdict-guard now rejects that spelling outright.
  assert.match(RUNNER_SOURCE, /const interactionOutcome =/);
  assert.match(RUNNER_SOURCE, /interactionAssessment === null \? "unobserved"/);
  assert.match(RUNNER_SOURCE, /const interactionPassed = interactionOutcome !== "failed";/);
  // An unassessed interaction can never turn a scenario into a pass: the outcome vocabulary is published and
  // only `failed` blocks, so `unobserved` stays distinguishable from `verified`.
  assert.match(RUNNER_SOURCE, /const interactionPassed = interactionOutcome !== "failed";/);
  assert.match(RUNNER_SOURCE, /interactionOutcome,/);
  // Every scenario's clause plus the shared gates, in one conjunction the verdict reads.
  assert.match(
    RUNNER_SOURCE,
    /contextPassed &&\n      contentPassed &&\n      worldBookPassed &&\n      interactionPassed/,
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
  // Ladder 5 dialogue is covered by the interaction gate too (its reply is the
  // covenant answer to the player); before this it was never assessed at all.
  assert.match(
    RUNNER_SOURCE,
    /typeof presentedSummary === "string" && presentedSummary\.trim\(\)\.length > 0\n      \? assessCompanionInteraction/,
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

test("prompts teach companionship instead of checklist recitals (ladder-3)", () => {
  // The ladder-3 prompts must NOT ask the Agent to "summarize what you did" —
  // that phrasing is what produced the recital the interaction gate rejects.
  assert.doesNotMatch(RUNNER_SOURCE, /总结你为乔迪做了哪些准备/);
  assert.doesNotMatch(RUNNER_SOURCE, /summarize in one sentence what you prepared for Jodi/);
  assert.match(RUNNER_SOURCE, /不是任务播报员/);
  assert.match(RUNNER_SOURCE, /not a task announcer/);
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
  assert.match(description, /the plan and the moves that carry it out travel together/);
  assert.match(description, /advances the successors itself/);
  assert.match(description, /does not come back between steps/);
  // The cost of the alternative, in one clause: without this the unit is stated but the trade is not.
  assert.match(description, /waiting for a decision between every step/);
  assert.match(description, /must be actions currently advertised to you/);
  assert.match(description, /bounded and side-effect free/);
  assert.match(description, /Nodes carry no deadline/);
  assert.match(description, /"programId":"farm_morning"/);
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
  assert.match(RUNNER_SOURCE, /presentation: summarizePresentationEvidence\(\),/);
  assert.doesNotMatch(RUNNER_SOURCE, /const presentation = summarizePresentationEvidence\(\);/);
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
  const deriveSessionVerdict = extractRunnerFunction(RUNNER_SOURCE, "deriveSessionVerdict");
  const healthy = {
    worldStallReason: null,
    sessionTurns: [{}],
    unsettledTurns: [],
    turnFailureReason: undefined,
    bridgeDisconnections: [],
    sessionSpoken: true,
    accomplishedActionIds: ["harvest_crop"],
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
  const verdictExpression = RUNNER_SOURCE.slice(
    RUNNER_SOURCE.indexOf("    state:\n"),
    RUNNER_SOURCE.indexOf('        ? "passed"'),
  );
  assert.ok(
    verdictExpression.includes("morningRoutinePassed &&"),
    "the verdict must depend on the scenario's own clause",
  );
  assert.ok(verdictExpression.includes("memoryCovenantPassed &&"));
  assert.ok(verdictExpression.includes("npcSocialAndPresencePassed &&"));
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
  // One derivation of the three lists: the verdict reads it and the result publishes it (summarizeDispatchedActions).
  assert.match(
    RUNNER_SOURCE,
    /accomplished: succeeded\.filter\(\(actionId\) => !NON_ACCOMPLISHMENT_ACTIONS\.has\(actionId\)\),/,
  );
  assert.match(
    RUNNER_SOURCE,
    /const \{ attempted: attemptedActionIds, accomplished: accomplishedActionIds \} =\s*summarizeDispatchedActions\(actionTrace\);/,
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
  // the root error. Nor may it silently lose the artifact at all — three runs (N, O, P) died with
  // no result file — so whatever escapes the run's own try/catch still writes one.
  assert.match(RUNNER_SOURCE, /function writeFailureArtifact\(reason\)/);
  assert.match(RUNNER_SOURCE, /process\.on\("uncaughtException"/);
  assert.match(RUNNER_SOURCE, /process\.on\("unhandledRejection"/);
  assert.match(RUNNER_SOURCE, /reason: "runner_failed_before_reporting"/);
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
function extractRunnerFunction(source, name, globals = {}) {
  // An array of names compiles ALL of them into one scope, so a helper that a tested function calls is
  // evaluated with it. Without this, an extracted copy referenced a function that only existed in the
  // runner file and the behavioural test failed for a reason that had nothing to do with the behaviour.
  if (Array.isArray(name)) {
    const parts = name.map((one) => extractRunnerFunction(source, one).source);
    const names = Object.keys(globals);
    return new Function(...names, `${parts.join("\n")}\nreturn [${name.join(", ")}];`)(
      ...names.map((key) => globals[key]),
    );
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
  const value = new Function(`${body}\nreturn ${name};`)();
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
    /if \(SCENARIO === "memory_covenant" && !usesDisposableRoot\) \{\n  const seeded = await seedMemoriesViaManagementSurface\(\{\n    root,\n    deploymentManifestPath: manifestPath,\n    seeds: \["玩家说好的规矩/,
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
  // ...and the day's record carries the cause the watch observed.
  assert.match(RUNNER_SOURCE, /const cause = outcome\.passOutObserved === true \? "pass_out" : "sleep";/u);
  assert.match(RUNNER_SOURCE, /record\.cause = nightCauses\.get\(record\.day\) \?\? null;/u);
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
    actionId: "advance_day",
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
  // The one literal: from the builder's `const result = {` to its closing brace.
  const literalAt = builder.indexOf("const result = {");
  assert.ok(literalAt > 0, "the builder must build one result literal");
  const literal = builder.slice(literalAt, builder.indexOf("\n  };", literalAt));
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
    const key = new RegExp(`^\\s*${field}[:,]`, "gm");
    assert.equal((literal.match(key) ?? []).length, 1, `${field} must be published exactly once, by the builder`);
    assert.equal((exits.match(key) ?? []).length, 0, `${field} must not be published by an exit path`);
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
  const [, buildRunResult] = extractRunnerFunction(RUNNER_SOURCE, ["summarizeDispatchedActions", "buildRunResult"], {
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
    multidayOutcome: { crossings: 1, dayRecords: [] },
    SCENARIO: "morning_routine",
    LEGACY_LADDER: null,
    historianRubricOutcome: null,
    sessionRecordPath: undefined,
    summarizeActionCadence: () => ({ spans: [] }),
    summarizePresentationEvidence: () => ({ pieces: [] }),
    readToolTiming: () => ({ observed: false }),
    buildFailureSnapshot: (input) => input,
    writeRunBundle: async () => ({ state: "written", runDir: "/run" }),
    closeCapture: async () => ({ state: "closed" }),
    writeFile: async () => {},
    join: (...parts) => parts.join("/"),
  });
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
});

test("an unobserved program is not a program that dispatched nothing", async () => {
  // Decision (c): a failed journal read and a program that ran nothing are DIFFERENT facts. The falsifier: when the
  // Mod's status query throws or answers not_found, the record is `observed: false` with `dispatched: null` - never
  // `dispatched: 0`, which would silently turn a read failure into a measured empty execution.
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes");
  const failing = await readProgramOutcomes({
    submissions: [{ programId: "p_unreadable", accepted: true }],
    statusQuery: async () => {
      throw new Error("bridge_disconnected");
    },
    eventsQuery: async () => ({ code: "not_found", events: [], nextCursor: 0 }),
  });
  assert.deepEqual(failing, [
    { programId: "p_unreadable", accepted: true, observed: false, dispatched: null, nodeOutcomes: [] },
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
  // the program produced - and the per-node states are what the Mod's status snapshot reports.
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes");
  const events = [
    { cursor: 1, programId: "p1", kind: "admitted", nodeId: "a" },
    { cursor: 2, programId: "p1", kind: "native_dispatch", nodeId: "a" },
    { cursor: 3, programId: "p1", kind: "node_succeeded", nodeId: "a" },
    { cursor: 4, programId: "p1", kind: "native_dispatch", nodeId: "b" },
    { cursor: 5, programId: "p1", kind: "native_dispatch", nodeId: "b" },
  ];
  const records = await readProgramOutcomes({
    submissions: [{ programId: "p1", accepted: true }],
    statusQuery: async () => ({
      code: "found",
      snapshot: {
        programId: "p1",
        state: "succeeded",
        nodes: [
          { nodeId: "a", state: "succeeded" },
          { nodeId: "b", state: "failed" },
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
  assert.deepEqual(records[0].nodeOutcomes, [
    { nodeId: "a", state: "succeeded" },
    { nodeId: "b", state: "failed" },
  ]);

  // A found program with NO native_dispatch events is a real measured zero: observed, dispatched: 0.
  const idle = await readProgramOutcomes({
    submissions: [{ programId: "p2", accepted: true }],
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
