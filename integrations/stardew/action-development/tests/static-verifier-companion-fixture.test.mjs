import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  loadCompanionLiveFixtures,
  runScenarioSuite,
  scoreScenarioSuite,
  sealScenarioSuite,
  validatePhraseManifest,
} from "../static-verifier/remaining-leaves/companion-live-scenario.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const phraseIdFor = (scenario) => `${scenario.phraseSet}:1`;

function evidence(scenario, phrases, { scorer = false } = {}) {
  const phraseId = phraseIdFor(scenario);
  const base = { ...(scorer ? { scenarioId: scenario.id, phraseId } : {}), identity: { topology: scenario.topology, game: "1", smapi: "1", mod: "1", host: "1", model: "1" }, eventRange: { start: 1, end: 20 }, executionOwners: [], receiptIds: [], presentationIds: [], events: [], bodySettled: true, verdict: "pass" };
  if (scenario.id === "SIM-01") return { ...base, executionOwners: ["o1"], receiptIds: ["r1"], events: [{ kind: "player_input", phraseId }, { kind: "action_dispatch", phraseId, ownerId: "o1", receiptId: "r1", toolId: "published_action", published: true, epoch: 1 }, { kind: scorer ? "terminal_receipt" : "authoritative_progress", receiptId: "r1", epoch: 1 }] };
  if (scenario.id === "SIM-02") return { ...base, freshSnapshot: { beforeReplacement: true, oldEpoch: 1 }, events: [{ kind: "redirect", phraseId }] };
  if (scenario.id === "SIM-03") return { ...base, receiptIds: ["stopReceipt1", "stopReceipt2", "stopReceipt3", "stopReceipt4"], events: scenario.events[0].timingProfiles.flatMap((timingProfile, index) => [0, 1].map((repeat) => ({ kind: "stop_receipt", timingProfile, stopId: `${scenario.id}:${timingProfile}:stop-1`, phraseId, terminal: true, receiptId: `stopReceipt${index * 2 + repeat + 1}`, epoch: 1 }))) };
  if (scenario.id === "SIM-04") return { ...base, receiptIds: ["silenceReceipt"], events: [{ kind: "silence_window_receipt", windowId: phrases.phraseSets.silence[0], terminal: true, receiptId: "silenceReceipt" }] };
  return { ...base, receiptIds: ["scopeReceipt"], events: [{ kind: "player_input", phraseId }, { kind: "scope_receipt", phraseId, scopeAllowed: false, receiptId: "scopeReceipt" }] };
}

test("package-owned companion scenario fixture contract validates and runs deterministic inputs", async () => {
  const { manifest, phrases } = await loadCompanionLiveFixtures();
  const byId = new Map(manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  const adapter = { controlPortKind: "stardew_companion_control_v1", async awaitTrigger() {}, async sendPlayerInput() {}, async redirect() {}, async stopAll() {}, async awaitSilenceWindow() {}, async collectScenarioEvidence({ scenarioId, phase }) { return phase === "before" ? { unsettledExecutionOwners: [] } : evidence(byId.get(scenarioId), phrases); } };
  const run = await runScenarioSuite({ manifest, phrases, adapter });
  assert.equal(run.evidenceClass, "deterministic_fixture");
  assert.equal(run.scenarios.length, 5);
  const tampered = structuredClone(phrases); tampered.integrity = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validatePhraseManifest(tampered), /phrase_manifest_integrity_invalid/);
});

test("package-owned companion scorer accepts sealed fixture evidence and rejects cross-class input", async () => {
  const fixtures = await loadCompanionLiveFixtures();
  const run = { schema: "gamebuddy_stardew_companion_fixture_evidence/v1", suiteId: fixtures.manifest.suiteId, evidenceClass: "deterministic_fixture", scenarios: fixtures.manifest.scenarios.map((scenario) => evidence(scenario, fixtures.phrases, { scorer: true })) };
  for (const scenario of run.scenarios) scenario.evidenceDigest = hash(scenario);
  Object.assign(run, sealScenarioSuite(run));
  const score = scoreScenarioSuite(run, fixtures);
  assert.equal(score.verdict, "pass", JSON.stringify(score.failures));
  run.schema = "gamebuddy-stardew-companion-live-evidence/v1";
  assert.deepEqual(scoreScenarioSuite(run, fixtures).failures, ["summary_envelope_invalid"]);
});
