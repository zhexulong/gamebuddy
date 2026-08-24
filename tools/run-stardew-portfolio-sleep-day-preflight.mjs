#!/usr/bin/env node
import path from "node:path";
/**
 * Read-only preflight for the blocked M2/M5/M6 sleep/day coordination action.
 *
 * It may inspect a target-version native observation supplied by an attach-only
 * caller. It never starts Stardew, sends a bridge request, drives a menu,
 * dispatches dialogue, saves, closes, reopens, or mutates a save. The target
 * 1.6.15.24356 source route has no lawful public typed non-UI ingress that
 * preserves the bed confirmation decision, so this preflight deliberately
 * returns BLOCKED rather than accepting a fabricated receipt-shaped payload.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkStardewPortfolioSleepDaySourceAudit } from "./check-stardew-portfolio-sleep-day-source-audit.mjs";

const ACTION = "single_player_sleep_and_advance_day";
const TOPOLOGY = "single_player_native_companion";
const SOURCE_AUDIT_PATH = new URL("./stardew-portfolio-sleep-day-source-audit.json", import.meta.url);
const SCOPE_KEYS = Object.freeze([
  "integrationId",
  "topology",
  "saveId",
  "worldId",
  "localPlayerId",
  "companionId",
  "bindingGeneration",
  "bindingHash",
]);
const SOURCE_BLOCKER = Object.freeze({
  code: "native_sleep_ingress_unavailable",
  targetVersion: "1.6.15.24356",
  sourceFact:
    "TouchAction Sleep reaches private GameLocation.startSleep/doSleep confirmation continuations before direct Game1.NewDay; no approved non-UI typed semantic ingress exists.",
  prohibitedAlternatives: Object.freeze([
    "Game1.NewDay",
    "SaveGame.Save",
    "GameLocation.startSleep",
    "GameLocation.doSleep",
    "answerDialogueAction",
    "UI/input",
    "reflection",
    "generic dispatcher",
    "save edit",
  ]),
  requiredSharedIntegrationSeam:
    "PortfolioBridgeSession/PortfolioIntegration/PortfolioLocalPlayerBinding must durably record the exact old-binding execution before invalidation, and only an authenticated exact new-binding reclaim may correlate Saving, Saved, DayStarted, close, and reopen into one terminal receipt.",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sameExactScope(actual, expected) {
  return (
    isRecord(actual) &&
    isRecord(expected) &&
    Object.keys(actual).length === SCOPE_KEYS.length &&
    Object.keys(expected).length === SCOPE_KEYS.length &&
    SCOPE_KEYS.every(
      (key) => Object.hasOwn(actual, key) && Object.hasOwn(expected, key) && actual[key] === expected[key],
    )
  );
}
function blocked(code, details = {}) {
  return Object.freeze({ state: "BLOCKED", action: ACTION, topology: TOPOLOGY, code, ...details });
}

/** Given: independently read only a lawful nonterminal, sleep-eligible state. */
export async function readSleepDayGiven({ observeNative, expectedScope } = {}) {
  if (typeof observeNative !== "function") return blocked("sleep_day_native_probe_required");
  let facts;
  try {
    facts = await observeNative();
  } catch {
    return blocked("sleep_day_native_probe_failed");
  }
  if (
    !isRecord(facts) ||
    facts.source !== "target_version_native_sleep_probe" ||
    facts.readOnly !== true ||
    facts.saveMutationObserved !== false ||
    facts.gameplayMutationObserved !== false ||
    facts.topology !== TOPOLOGY ||
    facts.singlePlayer !== true ||
    facts.currentNativeLocalPlayer !== true ||
    facts.sleepEligible !== true ||
    facts.activeMenu !== false ||
    facts.activeEvent !== false ||
    facts.activeMinigame !== false ||
    facts.terminalOutcomePresent !== false ||
    !sameExactScope(facts.scope, expectedScope)
  )
    return blocked("sleep_day_given_invalid");
  return Object.freeze({ state: "READY", kind: "sleep_day_given", facts: Object.freeze({ ...facts }) });
}

/**
 * When/Then/And remain blocked: no caller may substitute a raw save, direct
 * NewDay call, UI confirmation, or receipt fixture for the missing native edge.
 */
export async function runSleepDayPreflight({ observeNative, expectedScope } = {}) {
  let sourceAudit;
  try {
    sourceAudit = await checkStardewPortfolioSleepDaySourceAudit(SOURCE_AUDIT_PATH);
  } catch {
    return blocked("sleep_day_source_audit_invalid");
  }
  if (sourceAudit.state !== "BLOCKED" || sourceAudit.code !== SOURCE_BLOCKER.code)
    return blocked("sleep_day_source_audit_invalid");
  const given = await readSleepDayGiven({ observeNative, expectedScope });
  if (given.state !== "READY") return Object.freeze({ ...given, sourceBlocker: SOURCE_BLOCKER });
  return blocked(SOURCE_BLOCKER.code, { given, sourceBlocker: SOURCE_BLOCKER });
}

export const SLEEP_DAY_PREFLIGHT_ACTION = ACTION;
export const SLEEP_DAY_PREFLIGHT_TOPOLOGY = TOPOLOGY;
export const SLEEP_DAY_SOURCE_BLOCKER = SOURCE_BLOCKER;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // There is intentionally no CLI bridge adapter: an invocation without an
  // attach-only native probe is a blocked preflight, not a green static run.
  console.log(JSON.stringify(await runSleepDayPreflight(), null, 2));
  process.exitCode = 2;
}
