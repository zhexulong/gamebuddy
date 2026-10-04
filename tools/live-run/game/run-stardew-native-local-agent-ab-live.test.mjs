import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveLiveRunRoot } from "../core/capture.mjs";

const RUNNER_SOURCE = await readFile(
  new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url),
  "utf8",
);

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

test("a disposable runtime root is the explicit fallback and is the only path that writes a model profile", () => {
  assert.match(RUNNER_SOURCE, /const usesDisposableRoot = configuredRuntimeRoot === undefined/);
  assert.match(RUNNER_SOURCE, /if \(usesDisposableRoot\)\s*\n\s*await writeFile\(join\(runtimeRoot, "settings", "model-profiles\.json"\)/);
});

test("the runner enforces a companion-interaction gate for ladder-3 summaries", () => {
  // The gate must be wired into the ladder-3 verdict so a "checklist of what I
  // did" closing line blocks the run instead of passing silently.
  assert.match(RUNNER_SOURCE, /assessCompanionInteraction/);
  assert.match(RUNNER_SOURCE, /interactionPassed = interactionAssessment === null \|\| interactionAssessment\.passed/);
  assert.match(RUNNER_SOURCE, /contextPassed && contentPassed && worldBookPassed && interactionPassed/);
});

test("the runner emits system findings as a first-class health signal", () => {
  // Every live run must yield a system health report (findings with component
  // attribution + counts), not just pass/blocked — that report is the feedback
  // signal of the system-level RL loop.
  assert.match(RUNNER_SOURCE, /import \{ summarizeSystemFindings \} from "\.\.\/\..\/lib\/system-findings\.mjs"/);
  assert.match(RUNNER_SOURCE, /const actionTrace = \[\]/);
  assert.match(RUNNER_SOURCE, /actionTrace\.push\(entry\)/);
  assert.match(RUNNER_SOURCE, /const systemFindings = summarizeSystemFindings\(actionTrace\)/);
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
  assert.match(RUNNER_SOURCE, /resolveLiveRunRoot\(\{ repoRoot: fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.", import\.meta\.url\)\) \}\)/);
  assert.doesNotMatch(RUNNER_SOURCE, /resolveLiveRunRoot\(\{ repoRoot: fileURLToPath\(new URL\("\.\.\/\.\.", import\.meta\.url\)\) \}\)/);
  assert.match(RUNNER_SOURCE, /result\.capture = await closeCapture\(capture, runtimeRoot, result\);/);
  assert.match(RUNNER_SOURCE, /partialResult\.capture = await closeCapture\(capture, runtimeRoot, partialResult\);/);
  // Content gate: the same canonical profile the assembly gate hashes is
  // assessed for persona presence and macro residue; a hollow default card or
  // unrendered macros fails the run loudly instead of passing silently.
  assert.match(RUNNER_SOURCE, /import \{ assessIdentityProfile \} from "\.\.\/core\/content-gate\.mjs";/);
  assert.match(RUNNER_SOURCE, /contentGate: canonicalProfile === null \? null : assessIdentityProfile\(canonicalProfile\),/);
  assert.match(RUNNER_SOURCE, /const contentGate = personaWorldBook\.contentGate \?\? null;/);
  assert.match(RUNNER_SOURCE, /contentGate\.personaPresent && contentGate\.macroResidue\.length === 0/);
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
  assert.match(RUNNER_SOURCE, /import \{ explainAuthorityIdentityMismatch \} from "\.\.\/core\/authority-identity\.mjs";/);
  assert.match(RUNNER_SOURCE, /function withAuthorityIdentityMismatch\(error, root, manifest\) \{\n  return explainAuthorityIdentityMismatch\(error, root, manifest\);/);
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
  assert.match(RUNNER_SOURCE, /const presentation = summarizePresentationEvidence\(\)/);
  // Recorded before the single-shot voice gate: chunk evidence must not depend
  // on voice being enabled or on a piece being the first one.
  assert.doesNotMatch(RUNNER_SOURCE, /if \(voiceStarted \|\| typeof text/);
  // The failure path also reports presentation evidence.
  assert.match(RUNNER_SOURCE, /presentation: summarizePresentationEvidence\(\),/);
});

test("the run computes the deterministic claim-fulfillability presence projection", () => {
  // Mechanism-B / audit-dimension §3: spoken promises are compared against the
  // same-turn receipts and the live capability face. The vocabulary is scenario
  // data; the parser applies the first-person guardrail.
  assert.match(RUNNER_SOURCE, /import \{ buildPresenceProjection \} from "\.\.\/\..\/lib\/stardew-companion-presence-projection\.mjs"/);
  assert.match(RUNNER_SOURCE, /PRESENCE_ACTION_VOCABULARY/);
  assert.match(RUNNER_SOURCE, /const presenceProjection = presentationPieces\.length > 0/);
  assert.match(RUNNER_SOURCE, /visibleActionIds/);
  assert.match(RUNNER_SOURCE, /presenceProjection,/);
});
/**
 * Extracts a named top-level function's exact source text from the runner, so
 * the structure test can run the REAL predicate instead of a paraphrase. The
 * runner module never loads here (top-level live side effects), so the function
 * text is evaluated in isolation; it must therefore be free of closures.
 */
function extractRunnerFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `runner must define ${name}`);
  const bodyOpen = source.indexOf("{", start + marker.length);
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
  const body = source.slice(start, end);
  return new Function(`${body}\nreturn ${name};`)();
}

test("ladder 5 is an embodied-memory covenant rung judged by receipts, not keywords", () => {
  // design 10.5 class 1 (preference/production covenant): the companion must
  // harvest the real mature strawberries and then honor the standing rule —
  // the protected item must never ship. The judgement must sit on REAL
  // execution receipts (item_shipped evidence carrying item=(O)400), never on
  // transcript text, and the top-level verdict must depend on it.
  assert.match(RUNNER_SOURCE, /LADDER === "5"\n      \? "今天是星露谷春季的雨天/);
  assert.match(RUNNER_SOURCE, /LADDER === "5"\n      \? "Today is a rainy Spring day/);
  assert.match(RUNNER_SOURCE, /PROTECTED_COVENANT_ITEM_ID = "\(O\)400";/);
  assert.match(RUNNER_SOURCE, /function findProtectedCovenantShipment\(receipts, protectedItemId\)/);
  assert.match(RUNNER_SOURCE, /receipt\.reasonCode !== "item_shipped"/);
  assert.match(RUNNER_SOURCE, /const covenantReceipt = findProtectedCovenantShipment\(receipts, PROTECTED_COVENANT_ITEM_ID\);/);
  assert.match(RUNNER_SOURCE, /const ladderFivePassed = LADDER === "5" \? harvestReceipt !== undefined && covenantPassed/);
  assert.match(RUNNER_SOURCE, /ladderFivePassed && contextPassed/);
  assert.match(RUNNER_SOURCE, /covenantReceipt: covenantReceipt \?\? null,/);
  assert.match(RUNNER_SOURCE, /covenantPassed,/);
  // ladder-5 prompts are intent-only: goal + the standing covenant, with no
  // tool sequence, no coordinates, and no call-count budgeting (the shared
  // prompt-gate test bans those phrasings from the whole runner, and this rung
  // must not smuggle them back in via its own prompt).
  assert.doesNotMatch(RUNNER_SOURCE, /LADDER === "5"[\s\S]{0,200}先检查（inspect）/);
  assert.doesNotMatch(RUNNER_SOURCE, /LADDER === "5"[\s\S]{0,200}先观察 observe/);
  // Ladder 5's standing rule now lives in MEMORY, not in the prompt: the
  // runner seeds the covenant through the management surface (same continuity
  // as the Game runtime), and the prompt only asks the Agent to recall a rule
  // about the strawberries instead of stating what it is.
  assert.match(
    RUNNER_SOURCE,
    /import \{ seedMemoriesViaManagementSurface \} from "\.\.\/memory\/run-memory-live-loop\.mjs";/,
  );
  assert.match(RUNNER_SOURCE, /if \(LADDER === "5" && !usesDisposableRoot\) \{\n  const seeded = await seedMemoriesViaManagementSurface\(\{\n    root,\n    deploymentManifestPath: manifestPath,\n    seeds: \["玩家说好的规矩/);
  assert.match(RUNNER_SOURCE, /covenantSeed = Object\.freeze\(\{ durable: seeded\.result\.durable/);
  assert.match(RUNNER_SOURCE, /有没有什么关于这些草莓的规矩/);
  // The prompt no longer states the rule: the seeded memory carries it.
  assert.doesNotMatch(RUNNER_SOURCE, /LADDER === "5"[\s\S]{0,400}一颗都不要卖掉/);
  assert.doesNotMatch(RUNNER_SOURCE, /LADDER === "5"[\s\S]{0,400}never sold or sent to the shipping bin/);
  assert.match(RUNNER_SOURCE, /covenantSeed,/);
});

test("the ladder-5 covenant gate fails on a protected ship_item receipt and passes otherwise", () => {
  // Run the runner's OWN predicate (extracted verbatim) against synthetic
  // receipts shaped exactly like the Mod's serialized evidence.
  const findProtectedCovenantShipment = extractRunnerFunction(RUNNER_SOURCE, "findProtectedCovenantShipment");
  const protectedShipment = {
    type: "execution_receipt",
    reasonCode: "item_shipped",
    requestId: "ship-reserved-1",
    executionId: "e-1",
    evidence: { detail: "location=Farm;target=shipping_bin_0123456789abcdef;bin=71,14;tile=71,14;item=(O)400;slot=2;stack=5;inventory_before=6;inventory_after=1;bin_before=0;bin_after=5;last_item_shipped_matched=true" },
  };
  const safeShipment = {
    type: "execution_receipt",
    reasonCode: "item_shipped",
    requestId: "ship-sellable-1",
    executionId: "e-2",
    evidence: { detail: "location=Farm;target=shipping_bin_0123456789abcdef;bin=71,14;tile=71,14;item=(O)16;slot=1;stack=3;inventory_before=3;inventory_after=0;bin_before=0;bin_after=3;last_item_shipped_matched=true" },
  };
  const harvest = {
    type: "execution_receipt",
    reasonCode: "crop_harvested",
    requestId: "harvest-1",
    executionId: "e-3",
    evidence: { detail: "location=Greenhouse;target=greenhouse_0123456789abcdef;tile=22,10;crop=strawberry;item=(O)400;inventory_before=0;inventory_after=5" },
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