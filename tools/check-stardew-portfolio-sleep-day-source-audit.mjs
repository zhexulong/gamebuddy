#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACTION = "single_player_sleep_and_advance_day";
const TOPOLOGY = "single_player_native_companion";
const TARGET = Object.freeze({
  gameVersion: "1.6.15.24356",
  assemblySha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
});
const NORMAL_PLAYER_PATH = Object.freeze([
  "TouchAction Sleep",
  "createQuestionDialogue",
  "player confirmation",
  "answerDialogue(Sleep_Yes)",
  "private GameLocation.startSleep/doSleep",
  "Game1.NewDay",
]);
const PROHIBITED_ALTERNATIVES = Object.freeze([
  "Game1.NewDay", "SaveGame.Save", "GameLocation.startSleep", "GameLocation.doSleep",
  "answerDialogueAction", "UI/input", "reflection", "generic dispatcher", "save edit",
]);
const REQUIRED_SEAM = "A separately approved source-owned typed semantic sleep entrypoint that preserves the complete normal-player decision and lifecycle without invoking a private confirmation continuation or raw save/day API.";
const REQUIRED_HANDOFF = "PortfolioBridgeSession/PortfolioIntegration/PortfolioLocalPlayerBinding must durably record the exact old-binding execution before invalidation, and only an authenticated exact new-binding reclaim may correlate Saving, Saved, DayStarted, close, and reopen into one terminal receipt.";

function exact(value, expected, label) {
  assert.deepEqual(value, expected, `${label} must match the approved sleep/day source boundary.`);
}

export function validateStardewPortfolioSleepDaySourceAudit(audit) {
  assert.deepEqual(Object.keys(audit ?? {}).sort(), [
    "action", "artifactKind", "auditId", "nonClaim", "normalPlayerPath", "prohibitedAlternatives",
    "requiredCrossGenerationHandoff", "schemaVersion", "sourceOwnedMissingSeam", "target", "topology",
  ].sort(), "sleep/day source audit fields must be closed.");
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.artifactKind, "portfolio_sleep_day_source_admissibility_audit");
  assert.equal(audit.auditId, "portfolio_sleep_day_source_admissibility_v1");
  assert.equal(audit.action, ACTION);
  assert.equal(audit.topology, TOPOLOGY);
  exact(audit.target, TARGET, "target");
  exact(audit.normalPlayerPath, NORMAL_PLAYER_PATH, "normalPlayerPath");
  exact(audit.prohibitedAlternatives, PROHIBITED_ALTERNATIVES, "prohibitedAlternatives");
  assert.deepEqual(Object.keys(audit.sourceOwnedMissingSeam ?? {}).sort(), ["code", "requiredSeam", "status"]);
  assert.equal(audit.sourceOwnedMissingSeam.code, "native_sleep_ingress_unavailable");
  assert.equal(audit.sourceOwnedMissingSeam.requiredSeam, REQUIRED_SEAM);
  assert.equal(audit.sourceOwnedMissingSeam.status, "blocked");
  assert.equal(audit.requiredCrossGenerationHandoff, REQUIRED_HANDOFF);
  assert.match(audit.nonClaim ?? "", /neither authorizes an adapter nor establishes action execution/);
  return Object.freeze({
    action: ACTION,
    topology: TOPOLOGY,
    sourceIngress: "unavailable",
    state: "BLOCKED",
    code: audit.sourceOwnedMissingSeam.code,
    requiredSeam: audit.sourceOwnedMissingSeam.requiredSeam,
  });
}

export async function checkStardewPortfolioSleepDaySourceAudit(auditPath) {
  return validateStardewPortfolioSleepDaySourceAudit(JSON.parse(await readFile(auditPath, "utf8")));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkStardewPortfolioSleepDaySourceAudit(
      path.resolve("tools/stardew-portfolio-sleep-day-source-audit.json"),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`stardew-portfolio-sleep-day-source-audit: ${error.message}\n`);
    process.exitCode = 1;
  }
}
