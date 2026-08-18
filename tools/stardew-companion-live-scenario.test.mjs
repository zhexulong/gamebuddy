import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CompanionLiveScenarioError,
  loadCompanionLiveFixtures,
  runScenarioSuite,
  validatePhraseManifest,
  validateScenarioManifest,
} from "./lib/stardew-companion-live-scenario.mjs";

const execFileAsync = promisify(execFile);
const mutate = (value, path, replacement) => {
  const copy = structuredClone(value);
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = replacement;
  return copy;
};
const mismatch = (validate, value) =>
  assert.throws(
    () => validate(value),
    (error) => error instanceof CompanionLiveScenarioError && /contract_mismatch|integrity_invalid/.test(error.code),
  );
const phraseIdFor = (scenario) => `${scenario.phraseSet}:1`;

// Canonical scenario IDs, phrase IDs, event kinds, and silence windows are derived from the validated JSON loader.
test("loads the canonical JSON-only fixture truth", async () => {
  const { manifest, phrases } = await loadCompanionLiveFixtures();
  assert.equal(manifest.scenarios.length, 5);
  assert.equal(phrases.locale, "zh-CN");
  assert.deepEqual(
    manifest.scenarios.map((scenario) => phraseIdFor(scenario)),
    manifest.scenarios.map((scenario) => `${scenario.phraseSet}:1`),
  );
});
test("rejects structural fixture mutations", async () => {
  const { manifest, phrases } = await loadCompanionLiveFixtures();
  for (const [path, value] of [
    [["schemaVersion"], 2],
    [["suiteId"], "other"],
    [["scenarios", 0, "id"], "SIM-99"],
    [["scenarios", 0, "events", 0, "kind"], "stop_all"],
  ])
    mismatch(validateScenarioManifest, mutate(manifest, path, value));
  mismatch(validatePhraseManifest, mutate(phrases, ["integrity"], "sha256:deadbeef"));
  const injected = structuredClone(phrases);
  injected.phraseSets.extra = ["synthetic adversarial input"];
  mismatch(validatePhraseManifest, injected);
});
test("live entrypoint blocks machine-readably and rejects cross-class flags", async () => {
  for (const args of [[], ["--mode", "real"], ["--fixture-adapter", "x"], ["--preflight-only"]])
    await assert.rejects(
      () => execFileAsync(process.execPath, ["tools/run-stardew-companion-live-scenarios.mjs", ...args]),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).evidenceClass, "target_live");
        return true;
      },
    );
});
test("fixture runner uses validated JSON truth and redacts synthetic adapter evidence", async () => {
  const { manifest, phrases } = await loadCompanionLiveFixtures();
  const scenarios = new Map(manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  const adapter = {
    controlPortKind: "stardew_companion_control_v1",
    async awaitTrigger() {},
    async sendPlayerInput() {},
    async redirect() {},
    async stopAll() {},
    async awaitSilenceWindow() {},
    async collectScenarioEvidence({ scenarioId, phase }) {
      return phase === "before"
        ? { unsettledExecutionOwners: [] }
        : syntheticEvidence(scenarios.get(scenarioId), phrases);
    },
  };
  const run = await runScenarioSuite({ manifest, phrases, adapter });
  assert.equal(run.evidenceClass, "deterministic_fixture");
  assert.deepEqual(run.scenarios.map((result) => result.phraseId).sort(), manifest.scenarios.map(phraseIdFor).sort());
  await assert.rejects(
    () => runScenarioSuite({ manifest, phrases, adapter: {} }),
    /deterministic_fixture_control_port_unavailable/,
  );
});

// Deliberately synthetic adversarial adapter evidence; it is not scenario/phrase source truth.
function syntheticEvidence(scenario, phrases) {
  const phraseId = phraseIdFor(scenario),
    base = {
      identity: { topology: scenario.topology, game: "1", smapi: "1", mod: "1", host: "1", model: "1" },
      eventRange: { start: 1, end: 3 },
      executionOwners: [],
      receiptIds: [],
      presentationIds: [],
      events: [],
      bodySettled: true,
      verdict: "pass",
    };
  if (scenario.id === "SIM-01")
    return {
      ...base,
      executionOwners: ["owner-1"],
      receiptIds: ["receipt-1"],
      events: [
        { kind: "player_input", phraseId },
        {
          kind: "action_dispatch",
          phraseId,
          ownerId: "owner-1",
          receiptId: "receipt-1",
          toolId: "published_action",
          published: true,
          epoch: 1,
        },
        { kind: "authoritative_progress", receiptId: "receipt-1", epoch: 1 },
      ],
    };
  if (scenario.id === "SIM-02")
    return {
      ...base,
      freshSnapshot: { beforeReplacement: true, oldEpoch: 1 },
      events: [{ kind: "redirect", phraseId }],
    };
  if (scenario.id === "SIM-03")
    return {
      ...base,
      receiptIds: ["r1", "r2", "r3", "r4"],
      events: scenario.events[0].timingProfiles.flatMap((timingProfile, index) =>
        [0, 1].map((repeat) => ({
          kind: "stop_receipt",
          timingProfile,
          stopId: `${scenario.id}:${timingProfile}:stop-1`,
          phraseId,
          terminal: true,
          receiptId: `r${index * 2 + repeat + 1}`,
          epoch: 1,
        })),
      ),
    };
  if (scenario.id === "SIM-04")
    return {
      ...base,
      receiptIds: ["r4"],
      events: [
        { kind: "silence_window_receipt", windowId: phrases.phraseSets.silence[0], terminal: true, receiptId: "r4" },
      ],
    };
  return {
    ...base,
    receiptIds: ["r5"],
    events: [
      { kind: "player_input", phraseId },
      { kind: "scope_receipt", phraseId, scopeAllowed: false, receiptId: "r5" },
    ],
  };
}
