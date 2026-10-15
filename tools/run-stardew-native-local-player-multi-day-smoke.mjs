import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_STATES,
  assertRequiredCapabilities,
  classifyTopology,
  connectNativeLocalClient,
  delay,
  executeFresh,
  executeFreshAfterReobserve,
  observeTopologySnapshot,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "advance_day";
const DISMISS_ACTION = "dismiss_modal";
const SCENARIO = "native_multi_day_v1";
const REQUIRED_CAPABILITIES = [ACTION, DISMISS_ACTION];
const DEFAULT_DAYS = 3;
/** Two is the honest minimum for a CROSS-day claim; three is the useful one. */
const MINIMUM_DAYS = 2;
const MAXIMUM_DAYS = 14;
/** Poll spacing while a night rolls over. */
const POLL_INTERVAL_MS = 250;
/** How many times ONE menu type may be dismissed before its persistence is named. */
const MAX_DISMISS_ATTEMPTS = 3;
const DEFAULT_RESULT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scratch",
  "native-multi-day-result.json",
);

/**
 * The multi-day crossing, driven entirely by the product's own actions.
 *
 * The structural question is whether the companion loop can cross several in-game
 * days in ONE run, and the measured answer depends on a native ORDER that is easy to
 * get wrong: a day rollover pushes its end-of-night menus BEFORE DayStarted fires
 * (Game1.cs:4292-4305 clears `showingEndOfNightStuff` only once every end-of-night
 * menu is gone, and `OnDayStarted()` runs after that fade), while `advance_day`
 * confirms `day_advanced` only when the fresh DayStarted edge arrives
 * (SleepAndAdvanceDayLifecycle.DecideDayStart). So a menu that holds the actor -
 * the morning-after ShippingMenu the rollover pushes from
 * `player.displayedShippedItems` (Game1.cs:9119-9121) - must be cleared WHILE the
 * night is still in flight. Waiting for the terminal first would deadlock until the
 * lifecycle's own day-start budget expired and then report `day_start_not_observed`,
 * which reads exactly like a hang.
 *
 * This runner therefore does both halves the owner asked for, in one loop:
 *   * at each morning, read a fresh snapshot and clear whatever holds the actor, and
 *   * during each night, keep observing and clear the menu the rollover pushes, then
 *     record the day number/time, the menu, the actor's location and every receipt.
 * Every outcome is named. A menu the product must not close (LevelUpMenu) stops the
 * run BY NAME instead of timing out, and so does a hold the product itself reports.
 */

/** The rolling menu facts the Mod publishes about the actor each tick. */
export function readRolloverMenu(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return null;
  if (snapshot.actorDispositionKind !== "modal") return null;
  const detail = snapshot.actorDispositionDetail;
  // A modal whose class the Mod could not name is still a hold, and the honest move
  // is to stop by name rather than assume the actor is free.
  return typeof detail === "string" && detail.length > 0 ? detail : "unknown";
}

/**
 * Modals that are engine- or action-owned: they exit on their own and ask the runner
 * for no decision.
 *
 *  - `SaveGameMenu` is the day-end save progress modal. It has no user interaction;
 *    the game clears it when the save finishes. Interrupting it would be a silent
 *    world change, and the product's own dismiss refuses it anyway.
 *  - `DialogueBox` is the native Sleep prompt, which `advance_day`'s own lifecycle
 *    answers (`GameLocation.answerDialogue` + `beginOutro`). That is the action's
 *    business, not this runner's.
 *  - `ReadyCheckDialog` is the shared-world night barrier, owned by the other
 *    farmers. The action declares `requires_other_player` rather than forging it,
 *    so the runner only waits for that terminal.
 */
export const ROLLOVER_WAIT_MENUS = Object.freeze(["SaveGameMenu", "DialogueBox", "ReadyCheckDialog"]);

/**
 * The operation menus a day rollover pushes that the product's own `dismiss_modal`
 * closes as a pure cancel. `ShippingMenu` is the only one a rollover raises, and it
 * is in the Mod's audited dismissible set for exactly this reason: its open/close
 * path writes nothing (its own day-end save runs in `update()`, ShippingMenu.cs:361-428).
 */
export const ROLLOVER_DISMISSIBLE_MENUS = Object.freeze(["ShippingMenu"]);

/**
 * The runner's one judgement, kept pure so it can be pinned without a live game: what
 * to do about the menu (if any) currently holding the actor.
 *
 * `blocked` is the case the owner called out. `LevelUpMenu` is the other menu a
 * rollover can push and it is deliberately NOT dismissible - its close hook
 * `cleanupBeforeExit` runs `okButtonClicked` -> `getLevelPerk` + `RemoveLevelFromLevelList`
 * (LevelUpMenu.cs:629-648), i.e. the close writes saved state - so the honest outcome
 * is a stop that NAMES the type, never a timeout that looks like a hang.
 */
export function decideRolloverMenu(menuType) {
  if (menuType === null || menuType === undefined) return Object.freeze({ kind: "none", menuType: null });
  if (ROLLOVER_WAIT_MENUS.includes(menuType)) return Object.freeze({ kind: "wait", menuType });
  if (ROLLOVER_DISMISSIBLE_MENUS.includes(menuType)) return Object.freeze({ kind: "dismiss", menuType });
  return Object.freeze({
    kind: "blocked",
    menuType,
    reasonCode: `actor_held_by_unclosable_menu:${menuType}`,
  });
}

/**
 * A hold the Mod reports through its own disposition vocabulary. These are not menus,
 * so there is nothing to dismiss; naming them keeps the stop diagnosable.
 */
export function classifyActorHold(snapshot) {
  const kind = typeof snapshot?.actorDispositionKind === "string" ? snapshot.actorDispositionKind : null;
  if (kind === "event") return { kind, hold: "cutscene", reasonCode: "actor_held_by_cutscene" };
  if (kind === "pass_out") return { kind, hold: "pass_out", reasonCode: "actor_passed_out" };
  return { kind, hold: null, reasonCode: null };
}

/** The Mod's own `key=value;key=value` evidence projection, read by key. */
export function parseRolloverEvidence(evidence) {
  const detail = typeof evidence === "string" ? evidence : "";
  const facts = {};
  for (const pair of detail.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) facts[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return facts;
}

/**
 * Did this night really advance the day by exactly one?
 *
 * The receipt's own claim is cross-checked against the world the runner observes
 * afterwards, the way the single-day gate does: `day_after`/`days_after` must each
 * move by one, and the world's own `dayOfMonth` must be the calendar day those total
 * days imply. A receipt that claims day_advanced while the world disagrees is a
 * blocked result, not a pass.
 *
 * `saved_observed` is deliberately NOT required. A rollover whose ShippingMenu was
 * cleared by the product skips the menu-owned day-end save, and that is a fact the
 * record must SHOW rather than a fact the gate may hide.
 */
export function classifyRollover({ terminal, evidence, snapshot }) {
  if (terminal?.state !== "succeeded" || terminal?.reasonCode !== "day_advanced")
    return Object.freeze({
      advanced: false,
      reasonCode: `night_not_completed:${terminal?.state ?? "none"}/${terminal?.reasonCode ?? "none"}`,
    });
  const dayBefore = Number(evidence.day_before);
  const dayAfter = Number(evidence.day_after);
  const daysBefore = Number(evidence.days_before);
  const daysAfter = Number(evidence.days_after);
  if (!Number.isInteger(dayBefore) || dayAfter !== dayBefore + 1)
    return Object.freeze({
      advanced: false,
      reasonCode: `rollover_day_counter_mismatch:${evidence.day_before}->${evidence.day_after}`,
    });
  if (!Number.isInteger(daysBefore) || daysAfter !== daysBefore + 1)
    return Object.freeze({
      advanced: false,
      reasonCode: `rollover_days_played_mismatch:${evidence.days_before}->${evidence.days_after}`,
    });
  const expectedDayOfMonth = (((dayAfter % 28) + 28) % 28) + 1;
  if (snapshot?.dayOfMonth !== expectedDayOfMonth)
    return Object.freeze({
      advanced: false,
      reasonCode: `rollover_world_day_mismatch:${snapshot?.dayOfMonth}:expected=${expectedDayOfMonth}`,
    });
  return Object.freeze({ advanced: true, reasonCode: "day_advanced", dayAfter, expectedDayOfMonth });
}

/** The world/actor facts every record carries, so a run is readable after the fact. */
function describeWorld(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return null;
  return {
    revision: snapshot.revision ?? null,
    location: snapshot.location ?? null,
    tile: snapshot.tile ?? null,
    actionable: snapshot.actionable ?? null,
    dispositionKind: snapshot.actorDispositionKind ?? null,
    dispositionDetail: snapshot.actorDispositionDetail ?? null,
    dayOfMonth: snapshot.dayOfMonth ?? null,
    timeOfDay: snapshot.timeOfDay ?? null,
    seasonIndex: snapshot.seasonIndex ?? null,
    year: snapshot.year ?? null,
  };
}

function findTerminal(receipts, accepted) {
  return [accepted, ...receipts].find(
    (receipt) =>
      receipt?.requestId === accepted.requestId &&
      receipt?.executionId === accepted.executionId &&
      TERMINAL_STATES.has(receipt.state),
  );
}

/**
 * Observe without ever turning a momentary admission refusal into a verdict: a
 * rollover's fade legitimately refuses an observation for a frame or two, and the
 * cached projection is the current truth in that window.
 */
async function observeQuietly(client, topology) {
  try {
    return await observeTopologySnapshot(client, topology, { actionable: false, timeoutMs: 2_000 });
  } catch {
    return client.state?.snapshot ?? null;
  }
}

/** Send the product's own dismiss and read its own receipt. Never infers success. */
async function dismissMenu(client, receipts, requestId, menuType, dismissTimeoutMs) {
  try {
    const accepted = await executeFreshAfterReobserve(client, {
      action: DISMISS_ACTION,
      args: {},
      requestId,
      idempotencyKey: `${requestId}_idem`,
      timeoutMs: 30_000,
    });
    const terminal = await waitForTerminal(receipts, accepted, dismissTimeoutMs);
    if (terminal.state === "succeeded" && terminal.reasonCode === "modal_dismissed")
      return { receipt: terminal, reasonCode: null };
    return {
      receipt: terminal,
      reasonCode: `rollover_menu_not_dismissed:${menuType}:${terminal.state}/${terminal.reasonCode}`,
    };
  } catch (error) {
    return {
      receipt: null,
      reasonCode: `rollover_menu_not_dismissed:${menuType}:${String(error?.message ?? error).slice(0, 192)}`,
    };
  }
}

/**
 * Apply `decideRolloverMenu` to one observed snapshot.
 *
 * Returns `{ reasonCode: null }` when the actor should simply be waited for, a named
 * reason when the run must stop, and the dismiss receipt when one was sent.
 */
async function handleObservedHold(client, receipts, { snapshot, menus, attempts, requestId, dismissTimeoutMs }) {
  const menuType = readRolloverMenu(snapshot);
  const decision = decideRolloverMenu(menuType);
  if (menuType !== null && !menus.some((entry) => entry.menuType === menuType))
    menus.push({ menuType, decision: decision.kind });

  if (decision.kind === "blocked") return { reasonCode: decision.reasonCode };
  const hold = classifyActorHold(snapshot);
  if (hold.reasonCode !== null) return { reasonCode: hold.reasonCode };
  if (decision.kind !== "dismiss") return { reasonCode: null };

  const sent = attempts.get(menuType) ?? 0;
  if (sent >= MAX_DISMISS_ATTEMPTS) return { reasonCode: `rollover_menu_not_cleared:${menuType}` };
  attempts.set(menuType, sent + 1);
  const outcome = await dismissMenu(client, receipts, `${requestId}_dismiss_${sent + 1}`, menuType, dismissTimeoutMs);
  const entry = menus.find((candidate) => candidate.menuType === menuType);
  entry.dismissReceipt = summarizeReceipt(outcome.receipt);
  entry.dismissReasonCode = outcome.reasonCode;
  return { reasonCode: outcome.reasonCode };
}

/**
 * Wait, bounded, until the actor is a free, actionable body - clearing whatever holds
 * it on the way. This is the "at each morning: read the fresh snapshot, and if a menu
 * holds the actor, close it" half of the contract, and it also covers the moment a
 * previous night is still settling.
 */
async function settleFreeActor(client, receipts, topology, { timeoutMs, requestId, dismissTimeoutMs }) {
  const menus = [];
  const attempts = new Map();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await observeQuietly(client, topology);
    const handled = await handleObservedHold(client, receipts, {
      snapshot,
      menus,
      attempts,
      requestId,
      dismissTimeoutMs,
    });
    if (handled.reasonCode !== null) return { snapshot, menus, stop: handled.reasonCode };
    if (snapshot?.actionable === true && snapshot.activeExecution == null) return { snapshot, menus, stop: null };
    if (Date.now() >= deadline)
      return {
        snapshot,
        menus,
        stop: `morning_not_settled:${snapshot?.actorDispositionKind ?? "unknown"}:${snapshot?.actorDispositionDetail ?? "none"}`,
      };
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Dispatch one night and watch it through the rollover.
 *
 * The observation loop is the point: the rollover's menu appears while the execution
 * is still in flight, so the menu is handled HERE, and the terminal is read from the
 * same loop.
 */
async function advanceOneNight(client, receipts, topology, { day, nightTimeoutMs, dismissTimeoutMs }) {
  const requestId = `native_local_multi_day_${day}_${Date.now()}`;
  const menus = [];
  const attempts = new Map();
  const before = await observeTopologySnapshot(client, topology, { actionable: true });
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: {},
    snapshot: before,
    timeoutMs: 30_000,
  });
  const deadline = Date.now() + nightTimeoutMs;
  for (;;) {
    const terminal = findTerminal(receipts, accepted);
    if (terminal !== undefined) {
      const after = await observeQuietly(client, topology);
      return { requestId, accepted, terminal, before, after, menus, stop: null };
    }
    const snapshot = await observeQuietly(client, topology);
    const handled = await handleObservedHold(client, receipts, {
      snapshot,
      menus,
      attempts,
      requestId,
      dismissTimeoutMs,
    });
    if (handled.reasonCode !== null)
      return { requestId, accepted, terminal: null, before, after: snapshot, menus, stop: handled.reasonCode };
    if (Date.now() >= deadline)
      return {
        requestId,
        accepted,
        terminal: null,
        before,
        after: snapshot,
        menus,
        stop: `night_terminal_not_observed:${snapshot?.actorDispositionKind ?? "unknown"}:${snapshot?.actorDispositionDetail ?? "none"}`,
      };
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Cross `days` in-game days, one product-dispatched night at a time.
 *
 * Returns `passed` only when every night reached `succeeded/day_advanced` with the
 * world agreeing, and no observation ever stopped the run by name. Any other outcome
 * is `blocked` with the RECEIPT's own reason code, so a night that failed for a
 * product reason can never be read as a harness timeout.
 */
export async function runMultiDaySmoke(
  client,
  receipts,
  config,
  {
    days = DEFAULT_DAYS,
    nightTimeoutMs = 600_000,
    settleTimeoutMs = 120_000,
    dismissTimeoutMs = 60_000,
    resultFile = null,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  const topology = validateTopologyConfig(config);
  const scenario = config.NativeLocalPlayerFixture?.FixtureScenario;
  if (scenario !== SCENARIO) throw new Error(`native_local_fixture_invalid_scenario:${scenario}`);
  const requestedDays = Math.max(MINIMUM_DAYS, Math.min(MAXIMUM_DAYS, Math.trunc(days)));
  const dayRecords = [];
  let crossed = 0;
  try {
    const opening = await observeTopologySnapshot(client, topology, { actionable: false });
    assertRequiredCapabilities(opening, REQUIRED_CAPABILITIES);
    for (let day = 1; day <= requestedDays; day += 1) {
      const morning = await settleFreeActor(client, receipts, topology, {
        timeoutMs: settleTimeoutMs,
        requestId: `native_local_multi_day_morning_${day}_${Date.now()}`,
        dismissTimeoutMs,
      });
      const record = { day, morning: describeWorld(morning.snapshot), menus: [...morning.menus] };
      dayRecords.push(record);
      if (morning.stop !== null)
        return blocked(trace, dayRecords, startedAt, morning.stop, {
          daysCrossed: crossed,
          scenario,
          daysRequested: requestedDays,
        });

      const night = await advanceOneNight(client, receipts, topology, { day, nightTimeoutMs, dismissTimeoutMs });
      record.menus.push(...night.menus);
      record.accepted = summarizeReceipt(night.accepted);
      record.terminal = summarizeReceipt(night.terminal);
      record.evidence = parseRolloverEvidence(night.terminal?.evidence);
      record.after = describeWorld(night.after);
      trace.push({ day, action: ACTION, receipt: summarizeReceipt(night.terminal ?? night.accepted) });
      if (night.stop !== null)
        return blocked(trace, dayRecords, startedAt, night.stop, {
          daysCrossed: crossed,
          scenario,
          daysRequested: requestedDays,
        });

      const rollover = classifyRollover({
        terminal: night.terminal,
        evidence: record.evidence,
        snapshot: night.after,
      });
      record.rollover = rollover;
      if (!rollover.advanced)
        return blocked(trace, dayRecords, startedAt, rollover.reasonCode, {
          daysCrossed: crossed,
          scenario,
          daysRequested: requestedDays,
        });
      crossed += 1;
    }
  } catch (error) {
    return blocked(trace, dayRecords, startedAt, String(error?.message ?? error).slice(0, 256), {
      daysCrossed: crossed,
      scenario,
      daysRequested: requestedDays,
    });
  }
  const result = {
    state: "passed",
    reasonCode: "days_crossed",
    scenario,
    topology,
    daysRequested: requestedDays,
    daysCrossed: crossed,
    scope: describeScope(config),
    dayRecords,
    trace,
    durationMs: Date.now() - startedAt,
  };
  return writeResult(result, resultFile);
}

function describeScope(config) {
  return {
    saveId: config.SaveId,
    worldId: config.WorldId,
    playerId: config.PlayerId,
    companionId: config.CompanionId,
  };
}

/** A blocked result always names WHY, and never counts a night that did not cross. */
function blocked(
  trace,
  dayRecords,
  startedAt,
  reasonCode,
  { daysCrossed = 0, scenario = SCENARIO, daysRequested = null } = {},
) {
  return {
    state: "blocked",
    reasonCode,
    scenario,
    daysRequested,
    daysCrossed,
    dayRecords,
    trace,
    durationMs: Date.now() - startedAt,
  };
}

function writeResult(result, resultFile) {
  if (resultFile === null) return result;
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function validateTopologyConfig(value) {
  const topology = classifyTopology(value);
  // Policy is the derived deny-by-exception block; the shape check is what applies.
  validateNativeLocalFixturePolicy(value, {});
  return topology;
}

/** Bounded CLI options, parsed the same way the sibling runners parse theirs. */
function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const days = option("--days", String(DEFAULT_DAYS));
  const resultFile = resolve(option("--result-file", process.env.GAMEBUDDY_MULTI_DAY_RESULT ?? DEFAULT_RESULT_PATH));
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runMultiDaySmoke(session.client, session.receipts, config, {
      days: Number(days),
      resultFile,
    });
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
