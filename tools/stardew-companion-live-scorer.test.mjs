import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  loadCompanionLiveFixtures,
  scoreScenarioSuite,
  sealScenarioSuite,
} from "./lib/stardew-companion-live-scenario.mjs";

const execFileAsync = promisify(execFile);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reseal = (run) => {
  for (const scenario of run.scenarios) {
    delete scenario.evidenceDigest;
    scenario.evidenceDigest = hash(scenario);
  }
  delete run.evidenceDigest;
  return Object.assign(run, sealScenarioSuite(run));
};
const identity = { topology: "native_ai_farmhand_multiplayer", game: "1", smapi: "1", mod: "1", host: "1", model: "1" };

// Deliberately synthetic scorer inputs. All canonical semantic IDs are derived from validated JSON fixtures.
function syntheticResult(scenario, phrases) {
  const phraseId = `${scenario.phraseSet}:1`,
    base = {
      scenarioId: scenario.id,
      phraseId,
      identity,
      eventRange: { start: 1, end: 20 },
      executionOwners: [],
      receiptIds: [],
      presentationIds: [],
      events: [],
      bodySettled: true,
      verdict: "pass",
    };
  if (["SIM-01", "SIM-02", "SIM-05"].includes(scenario.id))
    base.events.push({ kind: scenario.events[0].kind === "redirect" ? "redirect" : "player_input", phraseId });
  if (scenario.id === "SIM-01")
    Object.assign(base, {
      executionOwners: ["o1"],
      receiptIds: ["r1"],
      events: [
        ...base.events,
        { kind: "action_dispatch", phraseId, ownerId: "o1", receiptId: "r1", toolId: "x", published: true, epoch: 2 },
        { kind: "terminal_receipt", receiptId: "r1" },
      ],
    });
  if (scenario.id === "SIM-02") Object.assign(base, { freshSnapshot: { beforeReplacement: true, oldEpoch: 1 } });
  if (scenario.id === "SIM-03")
    Object.assign(base, {
      receiptIds: ["r31", "r32", "r33", "r34"],
      events: scenario.events[0].timingProfiles.flatMap((timingProfile, index) =>
        [0, 1].map((repeat) => ({
          kind: "stop_receipt",
          timingProfile,
          stopId: `${scenario.id}:${timingProfile}:stop-1`,
          phraseId,
          terminal: true,
          receiptId: `r3${index * 2 + repeat + 1}`,
          epoch: 1,
        })),
      ),
    });
  if (scenario.id === "SIM-04")
    Object.assign(base, {
      receiptIds: ["r4"],
      events: [
        { kind: "silence_window_receipt", windowId: phrases.phraseSets.silence[0], terminal: true, receiptId: "r4" },
      ],
    });
  if (scenario.id === "SIM-05")
    Object.assign(base, {
      receiptIds: ["r5"],
      events: [...base.events, { kind: "scope_receipt", phraseId, scopeAllowed: false, receiptId: "r5" }],
    });
  return base;
}
async function passing() {
  const fixtures = await loadCompanionLiveFixtures();
  return {
    fixtures,
    run: reseal({
      schema: "gamebuddy_stardew_companion_fixture_evidence/v1",
      suiteId: fixtures.manifest.suiteId,
      evidenceClass: "deterministic_fixture",
      scenarios: fixtures.manifest.scenarios.map((scenario) => syntheticResult(scenario, fixtures.phrases)),
    }),
  };
}

test("scores complete class-specific fixture evidence", async () => {
  const { fixtures, run } = await passing();
  assert.equal(scoreScenarioSuite(run, fixtures).verdict, "pass");
});
test("rejects live, admission, and arbitrary proof classes before semantic scoring", async () => {
  for (const schema of [
    "gamebuddy_stardew_companion_live_evidence/v1",
    "gamebuddy_stardew_companion_admission_record/v1",
    "forged",
  ]) {
    const { fixtures, run } = await passing();
    run.schema = schema;
    assert.deepEqual(scoreScenarioSuite(run, fixtures).failures, ["summary_envelope_invalid"]);
  }
});
test("rejects stale JSON-derived semantic correlations", async () => {
  const { fixtures, run } = await passing();
  run.scenarios[0].phraseId = "synthetic:1";
  reseal(run);
  assert.deepEqual(scoreScenarioSuite(run, fixtures).failures, ["scenario_result_ingress_invalid"]);
});
test("fails sealed failed scenarios and missing authoritative fixture receipts", async () => {
  const { fixtures, run } = await passing();
  run.scenarios[3].verdict = "fail";
  run.scenarios[4].events = [{ kind: "player_input", phraseId: run.scenarios[4].phraseId }];
  reseal(run);
  const failures = scoreScenarioSuite(run, fixtures).failures.join(" ");
  assert.match(failures, /sealed_scenario_verdict_failed/);
  assert.match(failures, /scope_expansion_invalid/);
});
test("fixture scorer CLI rejects cross-class summaries without reflecting unsafe input", async () => {
  const { run } = await passing(),
    dir = await mkdtemp(join(tmpdir(), "stardew-companion-score-"));
  run.schema = "gamebuddy_stardew_companion_live_evidence/v1";
  const path = join(dir, "cross-class.json");
  await writeFile(path, JSON.stringify(run));
  await assert.rejects(
    () => execFileAsync(process.execPath, ["tools/score-stardew-companion-live-scenarios.mjs", "--summary", path]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /"verdict":"fail"/);
      return true;
    },
  );
});
