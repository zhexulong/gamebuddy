import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const RUNNER_SOURCE = await readFile(
  new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url),
  "utf8",
);

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
  assert.match(RUNNER_SOURCE, /contextPassed && interactionPassed/);
});

test("prompts teach companionship instead of checklist recitals (ladder-3)", () => {
  // The ladder-3 prompts must NOT ask the Agent to "summarize what you did" —
  // that phrasing is what produced the recital the interaction gate rejects.
  assert.doesNotMatch(RUNNER_SOURCE, /总结你为乔迪做了哪些准备/);
  assert.doesNotMatch(RUNNER_SOURCE, /summarize in one sentence what you prepared for Jodi/);
  assert.match(RUNNER_SOURCE, /不是任务播报员/);
  assert.match(RUNNER_SOURCE, /not a task announcer/);
});
