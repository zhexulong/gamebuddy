import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
} from "./identity-profile.js";
import { candidateToIdentityProfile, previewStCard } from "./st-card-import.js";
import {
  MAX_GAME_SNAPSHOT_PROJECTION_BYTES,
  projectGameSnapshotContext,
} from "./snapshot-projection.js";
import type { Snapshot } from "./protocol.js";

test("reviewed ST-card scenario and WorldBook remain candidates and cannot cross into profile or Chat/Game prompts", () => {
  const scenarioMarker = "CARD_SCENARIO_MUST_STAY_CANDIDATE_ONLY";
  const worldBookMarker = "CARD_WORLDBOOK_MUST_STAY_CANDIDATE_ONLY";
  const preview = previewStCard({
    spec: "chara_card_v3",
    data: {
      name: "Reviewed Rin",
      description: "A calm companion.",
      personality: "Listen first.",
      scenario: scenarioMarker,
      character_book: {
        entries: [{ comment: "reviewed lore", content: worldBookMarker }],
      },
    },
  });

  // The import seam retains both values for explicit review, but keeps scenario
  // outside the profile candidate and does not execute or render WorldBook data.
  assert.equal(preview.scenario, scenarioMarker);
  assert.equal(preview.worldBookCandidates[0]?.content, worldBookMarker);
  const candidate = {
    profileCandidate: preview.profileCandidate,
    scenario: preview.scenario,
    worldBookCandidates: preview.worldBookCandidates,
  };
  const profile = candidateToIdentityProfile(candidate, 1);
  const serializedProfile = JSON.stringify(profile);
  assert.doesNotMatch(serializedProfile, new RegExp(scenarioMarker));
  assert.doesNotMatch(serializedProfile, new RegExp(worldBookMarker));

  const chatPrompt = buildChatCompanionSystemPrompt(profile);
  const gamePrompt = buildGameCompanionSystemPrompt(profile);
  assert.doesNotMatch(chatPrompt, new RegExp(scenarioMarker));
  assert.doesNotMatch(chatPrompt, new RegExp(worldBookMarker));
  assert.doesNotMatch(gamePrompt, new RegExp(scenarioMarker));
  assert.doesNotMatch(gamePrompt, new RegExp(worldBookMarker));
});

test("Game Snapshot crosses the boundary only as a bounded frozen advisory projection", () => {
  const snapshot = {
    revision: 7,
    location: "Farm",
    tile: { x: 5, y: 10 },
    stamina: 80,
    health: 100,
    actionable: true,
    capabilities: ["CAPABILITY_SECRET"],
    catalogRevision: 22,
    enabledActionIds: ["ACTION_SECRET"],
    presentationLocale: "en-US",
    activeExecution: {
      executionId: "EXECUTION_SECRET",
      requestId: "REQUEST_SECRET",
      action: "ACTION_SECRET",
      capabilityId: "CAPABILITY_SECRET",
    },
  } as unknown as Snapshot;
  const projection = projectGameSnapshotContext(snapshot, 1_000, 1_050);
  assert.equal(projection.available, true);
  if (!projection.available) return;
  const text = JSON.stringify(projection);
  assert.doesNotMatch(text, /EXECUTION_SECRET|REQUEST_SECRET|ACTION_SECRET|CAPABILITY_SECRET/);
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_GAME_SNAPSHOT_PROJECTION_BYTES);
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.movement));
});
