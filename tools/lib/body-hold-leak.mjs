import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ANIMATION_CLASS } from "./action-pace.mjs";
import { MAX_SILENT_STRETCH_MS } from "./latency-silence.mjs";
import { readStardewActionIds } from "./stardew-published-action-registry.mjs";

/**
 * A BODY THAT CAME BACK LOCKED AFTER AN EXECUTION ENDED IS A LEAK, AND THE VERDICT NAMES THE WRITER.
 *
 * <p>
 * MEASURED `round88` (2026-11-21, `.live-runs/game-ladder/2026-11-21T17-48-27-810Z-multiday_routine`): the game clock
 * froze for five minutes at day 6 17:00. The last fact before the freeze was one `fish_here` cast that settled
 * `fish_here_catch_window_deadline_expired` at 18:08:32.593Z, and every receipt after it - six `move_to_tile` refusals
 * spanning 18:08:38 to 18:12:48 - said `held_by=stalled_with_no_holder:CanMove`. The verdict read that run as a story
 * about a disconnected bridge: nothing in it said the fishing execution had handed the body back locked, because no
 * reading compared an execution's END against the hold published after it.
 * </p>
 * <p>
 * THE INVARIANT. Any run that ends an execution non-Succeeded, and then publishes a hold that belongs to nobody - a
 * `stalled_with_no_holder:` refusal, a tool still up at its own settlement, or a `[body-hold] unattributed` write - has an
 * `implicit_body_hold_leak:<actionId>:<reasonCode>` and may not be read as a pass. The code names the execution that
 * ended, not the action that was refused afterwards: `move_to_tile` was never the owner, it was the caller being told
 * the body was taken.
 * </p>
 * <p>
 * THE POPULATION IS THE MOD'S OWN DECLARATION, never a list here. Which executions can hold the body is
 * `ActiveBodySlots.cs`'s `rows` table - the slot members and the action word each row's `Owner` names - and which ends
 * are non-Succeeded is the `ExecutionState` enum beside the wire words and its own `IsTerminal` predicate. A new slot row
 * or a new terminal state joins this reading without an edit here; the same fact spelled twice is the disagreement this
 * avoids.
 * </p>
 * <p>
 * WHAT IT CANNOT READ, stated rather than left to be discovered. A `[body-hold]` line is placed in time only by a clock
 * on it or beside it - the probe writes `game_ms` (the engine's elapsed game time) and `wall_ms` (the receipt stream's
 * clock) from this build on, an older line only by its `[hh:mm:ss]` log prefix (a local wall clock with no date, read
 * against the run's `startedAtMs` and good to ±1 s) or by a same-site line in the same log that carries one; a line
 * with none of those is reported unplaced rather than guessed. The Travel and ToolApproach slots carry their action id in
 * the spec (`travel.Action`, `approach.ActionId`), so an end of one of those actions is outside this population by
 * construction rather than because it is clean; and nothing publishes slot occupancy, so a stall with no non-Succeeded
 * end before it is `not_measured` instead of attributed to a guess. These are printed with every reading.
 * </p>
 * <p>
 * MEASURED `round89` (2026-11-21T20-38-52-354Z): 14 `[body-hold] unattributed` lines named seven frames - the body the
 * engine took through `performWarpFarmer`, `Crop.harvest`, `FishingRod.tickUpdate` - and not one carried a clock, so the
 * verdict could name the writer and not place it. The clocks on the line are that run's other half; its own seven
 * prefixed lines are still placed, through the log's `[hh:mm:ss]` and their untimed console copies, which is what the
 * placement rows below are.
 * </p>
 */

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The Mod's declared body slots: the one table that answers which executions can hold the body. */
const SLOTS_PATH = resolve(root, "integrations", "stardew", "ActiveBodySlots.cs");
/** The Mod's declared execution states: the enum, the wire words, and the predicate that says which states settle. */
const EXECUTION_STATE_PATH = resolve(
  root,
  "integrations",
  "stardew",
  "src",
  "Core",
  "Models",
  "BridgeProtocolModels.cs",
);

export const IMPLICIT_BODY_HOLD_LEAK = "implicit_body_hold_leak";

/**
 * The longest legitimate tool animation the tree declares, in milliseconds: `toolSwing`'s 480 ms (`Tool.cs:610-620`,
 * `animateOnce(160|168|176|184, 60f * num, 8)` at `num = 1`) against the watering can's 375 ms (`:585-596`,
 * `animateOnce(164|172|180|188, 125f * num, 3)`). Derived from `ANIMATION_CLASS` rather than restated, because a second
 * copy of 480 is a bound that drifts while both copies look right - and a bound nobody can trace is a threshold someone
 * will tune.
 */
export const USING_TOOL_BOUND_MS = Math.max(ANIMATION_CLASS.toolSwing, ANIMATION_CLASS.wateringCanSwing);

const USING_TOOL_BOUND_SOURCE =
  "tools/lib/action-pace.mjs ANIMATION_CLASS.toolSwing = 480 ms (`Tool.cs:610-620` animateOnce(160|168|176|184, 60f * num, 8) at num = 1)";

/** The two wire words that are a SUCCESS. Every other terminal state is a non-Succeeded end. */
const SUCCEEDED_STATES = Object.freeze(["succeeded", "partially_succeeded"]);

/**
 * How far a write may sit from the receipt that places it: the product's own silence ceiling
 * (`MAX_SILENT_STRETCH_MS`), because a receipt is an observable settlement and no run may go longer than that without
 * one. Derived rather than restated - a second copy of 10 s is a bound that drifts while both copies look right.
 */
export const PROBE_JOIN_WINDOW_MS = MAX_SILENT_STRETCH_MS;

/** The probe's own clocks on the line, as `BodyHold.ClockField` writes them: elapsed game ms, and the receipt clock. */
const PROBE_GAME_MS = /;game_ms=(\d+|none);/u;
const PROBE_WALL_MS = /;wall_ms=(\d+);/u;
/** SMAPI's own line prefix on the Mod log's file source: `[04:39:36 WARN  GameBuddy]`. Local time, no date, no zone. */
const LOG_STAMP = /^\[(\d{2}):(\d{2}):(\d{2})\s/u;

const STALLED_HOLD = /held_by=stalled_with_no_holder:([A-Za-z0-9_]+)/u;
// The tool flag as the Mod publishes it when it settles beside the body: `farmhandexecutioncontroller.fishingactions.cs`
// writes `can_move=…|using_tool=…`, and the one shape that reports it up is the one this limb exists for.
const USING_TOOL_UP = /(?:using_tool|UsingTool)=(?:true|True)\b/u;
const HELD_BY = /held_by=/u;
const PROBE_SITE = /\[body-hold\]\s+unattributed\s+site=([^;\s]+)/u;

const DAY_MS = 86_400_000;
/** The granule of every real zone offset, and so of the search that recovers one from a local stamp. */
const OFFSET_STEP_MS = 15 * 60_000;

const fail = (code) => {
  throw new Error(`body_hold_leak_${code}`);
};

/**
 * The Mod's slot table: the slot members it declares and the action word each row's owner names.
 *
 * <p>
 * TWO ROWS CARRY THEIR ACTION IN THE SPEC and are reported as such rather than dropped: `Travel` names `travel.Action`
 * and `ToolApproach` names `approach.ActionId`, so the action id of those holds is a fact only the running spec has. A
 * reader that quietly kept only the literals would report those holds as clean.
 * </p>
 */
export function readBodySlotActions({ slotsPath = SLOTS_PATH } = {}) {
  const source = readFileSync(slotsPath, "utf8");
  const members = [...source.matchAll(/internal\s+BodySlot<[^>]+>\s+(\w+)\s*\{\s*get;\s*\}/gu)].map(
    (match) => match[1],
  );
  const rows = source.match(/new\s+SlotRow\(/gu)?.length ?? 0;
  // The owner row's third argument: a literal action word, or the spec member the slot carries at runtime.
  const ownerArguments = [...source.matchAll(/new\s+OwnerRow\(\s*code\s*,\s*[^,]+,\s*([^,]+),/gu)].map((match) =>
    match[1].trim(),
  );
  const activityArguments = [
    ...source.matchAll(/ActivityOwner\(\s*code\s*,\s*[^,]+,\s*"([a-z][a-z0-9_]{1,127})"\s*\)/gu),
  ].map((match) => match[1]);
  const actionIds = new Set([
    ...ownerArguments.flatMap((argument) =>
      /^"([a-z][a-z0-9_]{1,127})"$/u.test(argument) ? [argument.slice(1, -1)] : [],
    ),
    ...activityArguments,
  ]);
  const specCarried = ownerArguments.filter((argument) => /\.Action(?:Id)?$/u.test(argument));
  if (rows === 0 || members.length === 0 || actionIds.size === 0)
    fail(`slot_table_unreadable:${slotsPath}: rows=${rows} members=${members.length} actions=${actionIds.size}`);
  return Object.freeze({
    path: slotsPath,
    members: Object.freeze(members),
    rows,
    actionIds: Object.freeze([...actionIds].sort()),
    specCarried: Object.freeze(specCarried),
  });
}

/**
 * The wire words that settle an execution, minus the two that are a success: the non-Succeeded population.
 *
 * <p>
 * Read from the Mod's `ExecutionState` enum, its `ToWireValue` map and its own `IsTerminal` predicate, because a state
 * added later must join this reading without an edit in a tool. The three states that do NOT settle are taken from
 * `IsTerminal` itself; the two successes are the one fact the enum does not carry as a predicate.
 * </p>
 */
export function readNonSucceededStates({ path = EXECUTION_STATE_PATH } = {}) {
  const source = readFileSync(path, "utf8");
  const declared = [
    ...(source.match(/public enum ExecutionState\s*\{([\s\S]*?)\}/u)?.[1] ?? "").matchAll(/\b([A-Z]\w*)\b/gu),
  ].map((match) => match[1]);
  const wire = new Map(
    [...source.matchAll(/ExecutionState\.(\w+)\s*=>\s*"([a-z_]+)"/gu)].map((match) => [match[1], match[2]]),
  );
  const unsettled = new Set(
    [
      ...(source.match(/IsTerminal\(this ExecutionState state\)\s*=>\s*state is not \(([^)]*)\)/u)?.[1] ?? "").matchAll(
        /ExecutionState\.(\w+)/gu,
      ),
    ].map((match) => wire.get(match[1])),
  );
  if (declared.length === 0 || wire.size === 0 || unsettled.size === 0)
    fail(
      `execution_states_unreadable:${path}: declared=${declared.length} wire=${wire.size} unsettled=${unsettled.size}`,
    );
  const nonSucceeded = [...wire.values()].filter((word) => !(unsettled.has(word) || SUCCEEDED_STATES.includes(word)));
  return Object.freeze({
    path,
    wireWords: Object.freeze([...wire.values()]),
    unsettled: Object.freeze([...unsettled]),
    nonSucceeded: Object.freeze(nonSucceeded.sort()),
  });
}

const detailOf = (receipt) => String(receipt?.evidence?.detail ?? receipt?.worldFactPayload?.evidence?.detail ?? "");
const stateOf = (receipt) => String(receipt?.worldFactPayload?.state ?? "");
const actionOf = (receipt) => String(receipt?.worldFactPayload?.actionId ?? "");
const atMsOf = (receipt) => (Number.isFinite(receipt?.atMs) ? receipt.atMs : null);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "an unreported time");

/** The `[hh:mm:ss]` SMAPI stamps a log line with, as text and as milliseconds since local midnight. */
function stampOfLine(line) {
  const stamp = LOG_STAMP.exec(line);
  return stamp === null
    ? null
    : {
        text: `${stamp[1]}:${stamp[2]}:${stamp[3]}`,
        ms: Number(stamp[1]) * 3_600_000 + Number(stamp[2]) * 60_000 + Number(stamp[3]) * 1_000,
      };
}

/**
 * The `[body-hold] unattributed` lines a run's Mod log carries, in log order, with whatever clock each line has.
 *
 * <p>
 * A line from this build names the writer AND the two clocks it was written with; a line from before that names the
 * writer alone and has only the `[hh:mm:ss]` SMAPI gives its file source, which the launcher's console capture does not
 * stamp at all. `game_ms=none` is read as no clock rather than 0, because outside a game there is no engine clock and 0
 * would place the write at the engine's first millisecond.
 * </p>
 */
export function readProbeLines(modLogText) {
  if (typeof modLogText !== "string") return null;
  const lines = [];
  for (const line of modLogText.split("\n")) {
    const site = PROBE_SITE.exec(line)?.[1];
    if (site === undefined) continue;
    const gameMs = PROBE_GAME_MS.exec(line)?.[1];
    const wallMs = PROBE_WALL_MS.exec(line)?.[1];
    const stamp = stampOfLine(line);
    lines.push(
      Object.freeze({
        site,
        gameMs: gameMs === undefined || gameMs === "none" ? null : Number(gameMs),
        wallMs: wallMs === undefined ? null : Number(wallMs),
        logStamp: stamp === null ? null : stamp.text,
        logStampMs: stamp === null ? null : stamp.ms,
      }),
    );
  }
  return Object.freeze(lines);
}

/**
 * The log's own first clock: the `[hh:mm:ss]` prefix of its first stamped line, which for this Mod log is SMAPI's
 * session banner. That second is the session's first, and it is what the zone offset below is recovered from.
 */
export function readLogSessionStart(modLogText) {
  if (typeof modLogText !== "string") return null;
  for (const line of modLogText.split("\n")) {
    const stamp = stampOfLine(line);
    if (stamp === null) continue;
    return Object.freeze({ logStamp: stamp.text, logStampMs: stamp.ms });
  }
  return null;
}

/**
 * The log's `[hh:mm:ss]` prefix is local time with no date and no zone, so it can only be read against the run's own
 * start: the prefix on the log's first stamped line is the session's first second, and the whole-hour-plus-quarter
 * offset that puts it nearest `startedAtMs` is the one the machine was on. Quarter-hours because that is the granule
 * every real zone offset has, and the residual is printed beside the reading - a first stamp further than half a step
 * from the run's start is not this run's start, and no placement is derived from it.
 */
function logClockAnchor({ sessionStartStamp, startedAtMs }) {
  if (!Number.isFinite(startedAtMs) || sessionStartStamp === null) return null;
  let best = null;
  for (let offsetMs = -12 * 3_600_000; offsetMs <= 14 * 3_600_000; offsetMs += OFFSET_STEP_MS) {
    const localDayStart = Math.floor((startedAtMs + offsetMs) / DAY_MS) * DAY_MS;
    const epoch = localDayStart + sessionStartStamp.logStampMs - offsetMs;
    const residualMs = Math.abs(epoch - startedAtMs);
    if (best === null || residualMs < best.residualMs) best = { offsetMs, localDayStart, epoch, residualMs };
  }
  if (best.residualMs >= OFFSET_STEP_MS / 2) return null;
  const sign = best.offsetMs < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(best.offsetMs) / 3_600_000)).padStart(2, "0");
  const minutes = String(Math.floor((Math.abs(best.offsetMs) % 3_600_000) / 60_000)).padStart(2, "0");
  return Object.freeze({
    ...best,
    text:
      `log prefixes read as ${sign}${hours}:${minutes} against this run's startedAtMs ${iso(startedAtMs)}` +
      ` - the log's first stamp ${sessionStartStamp.logStamp} sits ${String(best.residualMs)} ms from it`,
  });
}

/** The instant a line's own `[hh:mm:ss]` names, on the anchor's day - plus one when the session crossed local midnight. */
function stampInstant(anchor, line) {
  const epoch = anchor.localDayStart + line.logStampMs - anchor.offsetMs;
  return epoch < anchor.epoch - 12 * 3_600_000 ? epoch + DAY_MS : epoch;
}

/** A distance between a write and the receipt beside it: milliseconds while they are close, seconds once they are not. */
const signed = (ms) =>
  `${ms < 0 ? "-" : "+"}${Math.abs(ms) < PROBE_JOIN_WINDOW_MS ? `${String(Math.abs(ms))} ms` : `${(Math.abs(ms) / 1_000).toFixed(1)} s`}`;

/**
 * Where each `[body-hold]` line sits in time, and the receipt nearest that instant.
 *
 * <p>
 * Three clocks, in the order the artifacts earn them. `wall_ms` is the receipt stream's own clock, so the join is exact.
 * An older line has only its `[hh:mm:ss]` prefix, read through the anchor above and printed with its ±1 s resolution. A
 * line with neither - the launcher's console capture stamps nothing - is placed by its own site's timed copy, which is
 * one write and not two because the Mod logs a site once per session while the log holds that session's sources.
 * </p>
 * <p>
 * A write further from every receipt than the product's own silence budget lands in a window the bridge did not speak
 * in; that is printed as the fact it is (`no receipt within 10 s`) rather than stretched into a placement.
 * </p>
 */
export function placeProbeLines({ lines = [], receipts = [], startedAtMs = null, sessionStartStamp = null } = {}) {
  const anchor = logClockAnchor({ sessionStartStamp, startedAtMs });
  const stampedByTheLog = lines.some((line) => line.logStampMs !== null);
  const times = receipts
    .filter((receipt) => Number.isFinite(receipt?.atMs))
    .map((receipt) => ({ atMs: receipt.atMs, reasonCode: String(receipt.reasonCode ?? "unknown_reason") }));

  const nearestOf = (atMs) => {
    let best = null;
    for (const receipt of times)
      if (best === null || Math.abs(receipt.atMs - atMs) < Math.abs(best.atMs - atMs)) best = receipt;
    return best;
  };
  const joinText = (atMs) => {
    const nearest = nearestOf(atMs);
    if (nearest === null) return { text: "no receipt in this run to join", within: false };
    // The sign is read from the receipt to the write: `+1250 ms` is a write 1250 ms AFTER the receipt it is placed
    // beside, `-189 ms` one just before it.
    const delta = atMs - nearest.atMs;
    return Math.abs(delta) <= PROBE_JOIN_WINDOW_MS
      ? { text: `nearest receipt ${nearest.reasonCode} ${signed(delta)}`, within: true }
      : {
          text: `no receipt within ${String(PROBE_JOIN_WINDOW_MS / 1_000)} s (nearest ${nearest.reasonCode} ${signed(delta)})`,
          within: false,
        };
  };
  /** The clock the line itself carries, or null when it carries none. */
  const ownClock = (line) => {
    if (Number.isFinite(line.wallMs))
      return {
        atMs: line.wallMs,
        clock: line.gameMs === null ? `no engine clock, wall ${iso(line.wallMs)}` : `game_ms=${String(line.gameMs)}`,
      };
    if (line.logStampMs !== null && anchor !== null)
      return { atMs: stampInstant(anchor, line), clock: `${line.logStamp} (log prefix, ±1 s)` };
    return null;
  };

  const owned = lines.map(ownClock);
  const placements = lines.map((line, index) => {
    const own = owned[index];
    if (own !== null) {
      const joined = joinText(own.atMs);
      return Object.freeze({
        site: line.site,
        ...own,
        join: joined.text,
        withinWindow: joined.within,
        untimedCopy: false,
      });
    }
    const twinIndex = owned.findIndex((candidate, other) => candidate !== null && lines[other].site === line.site);
    if (twinIndex >= 0) {
      const twin = lines[twinIndex];
      const twinStamp = twin.logStamp ?? `wall ${iso(twin.wallMs)}`;
      const joined = joinText(owned[twinIndex].atMs);
      return Object.freeze({
        site: line.site,
        atMs: owned[twinIndex].atMs,
        clock: `no clock on the line (untimed copy: its same-site copy at ${twinStamp} places the write)`,
        join: joined.text,
        withinWindow: joined.within,
        untimedCopy: true,
      });
    }
    return Object.freeze({
      site: line.site,
      atMs: null,
      clock: "no clock on the line",
      join: "no receipt within any window - the line carries nothing to place it",
      withinWindow: false,
      untimedCopy: false,
    });
  });

  return Object.freeze({
    placements: Object.freeze(placements),
    // The anchor is a fact about HOW a prefix was read, so it is printed only when a prefix was actually read: a run whose
    // lines all carry `wall_ms` needs no zone, and one with no prefix at all has nothing to anchor.
    anchor: stampedByTheLog ? anchor : null,
    clockedByTheLog: stampedByTheLog && anchor === null,
    placed: placements.filter((placement) => placement.withinWindow).length,
    // A write whose nearest receipt is further than the window is placed in TIME and not in a WINDOW: both are printed,
    // and neither is the same fact as a line that carries no clock at all.
    outsideWindow: placements.filter((placement) => placement.atMs !== null && !placement.withinWindow).length,
    untimedCopies: placements.filter((placement) => placement.untimedCopy).length,
    unplaced: placements.filter((placement) => placement.atMs === null).length,
  });
}

/**
 * The executions that could have handed the body back: a non-Succeeded end of an action the slot table names.
 *
 * <p>
 * A receipt carrying `held_by=` is EXCLUDED, and that exclusion is what keeps the code naming the writer rather than the
 * victim. `WorldModel.DescribeHeldBody` writes `held_by=` for a request refused because the body was ALREADY taken, so
 * such a receipt never held the body and cannot be the execution that failed to release it - `round88`'s six
 * `move_to_tile`/`transient_busy` refusals are exactly that shape, and counting them as ends would have put
 * `implicit_body_hold_leak:move_to_tile:transient_busy` beside the true code.
 * </p>
 */
function endedExecutions({ receipts, slotActions, nonSucceeded, unsettled }) {
  const ends = [];
  const unknownStates = new Set();
  for (const receipt of receipts) {
    const state = stateOf(receipt);
    const atMs = atMsOf(receipt);
    if (state === "") continue;
    if (!nonSucceeded.includes(state)) {
      if (!(unsettled.includes(state) || SUCCEEDED_STATES.includes(state))) unknownStates.add(state);
      continue;
    }
    const actionId = actionOf(receipt);
    if (atMs === null || !slotActions.has(actionId)) continue;
    if (HELD_BY.test(detailOf(receipt))) continue;
    ends.push({
      actionId,
      state,
      reasonCode: String(receipt.reasonCode ?? "unknown_reason"),
      atMs,
      executionId: String(receipt.executionId ?? "unknown"),
    });
  }
  return { ends, unknownStates: Object.freeze([...unknownStates].sort()) };
}

/** The `using_tool=true` readings a receipt publishes, with the receipt that carried them. */
function usingToolReadings(receipts) {
  const readings = [];
  for (const receipt of receipts) {
    if (!USING_TOOL_UP.test(detailOf(receipt))) continue;
    const atMs = atMsOf(receipt);
    if (atMs === null) continue;
    readings.push({
      atMs,
      executionId: String(receipt.executionId ?? "unknown"),
      actionId: actionOf(receipt),
      reasonCode: String(receipt.reasonCode ?? "unknown_reason"),
    });
  }
  return readings;
}

/**
 * The whole reading: for one run, the leak codes, the writer, and the population each answer came from.
 *
 * <p>
 * `result` is the run's published bundle and `modLogText` its Mod log. Neither is required to exist: an absent bundle
 * answers `not_measured` naming the field, never `clear`.
 * </p>
 */
export function summarizeBodyHoldLeak({
  result,
  modLogText = null,
  startedAtMs = null,
  slotsPath = SLOTS_PATH,
  statePath = EXECUTION_STATE_PATH,
} = {}) {
  const slots = readBodySlotActions({ slotsPath });
  const states = readNonSucceededStates({ path: statePath });
  const mounted = readStardewActionIds();
  const slotActions = new Set(slots.actionIds);
  const unmounted = slots.actionIds.filter((actionId) => !mounted.has(actionId));
  const population =
    `${String(slots.actionIds.length)} slot-holding actions: ${slots.actionIds.join(",")}` +
    ` · of ${String(mounted.size)} mounted (integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs Registrations)` +
    ` · ${String(slots.members.length)} declared slot members in ${String(slots.rows)} rows` +
    (slots.specCarried.length === 0
      ? ""
      : `, ${String(slots.specCarried.length)} rows carrying their action in the spec (${slots.specCarried.join(", ")})`);

  const facts = Array.isArray(result?.bridgeFacts) ? result.bridgeFacts : null;
  const receipts = facts === null ? null : facts.filter((fact) => fact?.type === "execution_receipt");
  const probeLines = readProbeLines(modLogText);
  const placing = placeProbeLines({
    lines: probeLines ?? [],
    receipts: receipts ?? [],
    startedAtMs,
    sessionStartStamp: readLogSessionStart(modLogText),
  });
  const limits = Object.freeze([
    `a [body-hold] line is placed only by a clock on it or beside it - game_ms+wall_ms on a line from this build, a [hh:mm:ss] prefix read against this run's startedAtMs (±1 s), or a same-site line that carries one - so any other line stays unplaced rather than guessed (this run: ${
      probeLines === null
        ? "no mod-log.txt at all"
        : `${
            receipts === null
              ? `${String(probeLines.length)} line(s), no receipt stream to join`
              : `${String(placing.placed)} of ${String(probeLines.length)} line(s) placed`
          }`
    })`,
    ...(slots.specCarried.length === 0
      ? []
      : [
          `an end of an action the slot carries at runtime (${slots.specCarried.join(", ")}) is outside this population by construction, not because it is clean`,
        ]),
    "no receipt publishes slot occupancy (`slots=`, `activeClickableMenu`, `event_up`), so a stall with no non-Succeeded end before it stays not_measured instead of attributed to a guess",
    `a tool that is still up at a settlement counts as past the ${String(USING_TOOL_BOUND_MS)} ms bound because the execution that owned the swing has already ended`,
  ]);

  if (receipts === null) {
    return Object.freeze({
      slots,
      states,
      population,
      mounted: mounted.size,
      boundMs: USING_TOOL_BOUND_MS,
      boundSource: USING_TOOL_BOUND_SOURCE,
      examined: 0,
      leaks: Object.freeze([]),
      writer: Object.freeze({ state: "no_mod_log", site: null, lines: null }),
      stalls: 0,
      unattributedStalls: 0,
      unattributed: Object.freeze([]),
      usingTool: 0,
      probeLines: probeLines ?? Object.freeze([]),
      placements: Object.freeze([]),
      placedLines: 0,
      outsideWindowLines: 0,
      untimedCopies: 0,
      unplacedLines: 0,
      clockAnchor: null,
      unknownStates: Object.freeze([]),
      unmounted: Object.freeze(unmounted),
      limits,
      // NOT `not_measured`, and not `clear`: a bundle carrying no receipt stream cannot be ASKED the question, the same
      // shape the standstill partition calls `blocked` when a bundle carries no clock at all. Nothing was refused here,
      // so the verdict keeps its own exit code and the block prints `not_measured` on the reading it could not take.
      gate: "unaskable",
      absent: "result.json carries no bridgeFacts",
    });
  }

  const { ends, unknownStates } = endedExecutions({
    receipts,
    slotActions,
    nonSucceeded: states.nonSucceeded,
    unsettled: states.unsettled,
  });
  const windowed = usingToolReadings(receipts);
  const leaks = [];
  const unattributed = [];
  let stalls = 0;

  /** The last end at or before `atMs`: the execution that could have left the body locked. */
  const ownerOf = (atMs) => {
    let owner = null;
    for (const end of ends) if (end.atMs <= atMs) owner = end;
    return owner;
  };
  const leakFor = (end) => {
    let leak = leaks.find(
      (entry) => entry.actionId === end.actionId && entry.reasonCode === end.reasonCode && entry.atMs === end.atMs,
    );
    if (leak === undefined) {
      leak = {
        actionId: end.actionId,
        reasonCode: end.reasonCode,
        state: end.state,
        atMs: end.atMs,
        executionId: end.executionId,
        stalls: 0,
        stallHolders: [],
        usingTool: 0,
      };
      leaks.push(leak);
    }
    return leak;
  };

  for (const receipt of receipts) {
    const holder = STALLED_HOLD.exec(detailOf(receipt));
    if (holder === null) continue;
    stalls += 1;
    const atMs = atMsOf(receipt);
    if (atMs === null) {
      unattributed.push({ atMs: null, holder: holder[1], why: "no atMs" });
      continue;
    }
    const owner = ownerOf(atMs);
    if (owner === null) {
      unattributed.push({
        atMs,
        holder: holder[1],
        why: `no non-Succeeded end of a slot-holding action at or before ${iso(atMs)}`,
      });
      continue;
    }
    const leak = leakFor(owner);
    leak.stalls += 1;
    if (!leak.stallHolders.includes(holder[1])) leak.stallHolders.push(holder[1]);
  }

  // THE TOOL THAT WAS STILL UP belongs to the execution that ended, and to no other: a `using_tool=true` reading on a
  // different execution is that execution's own swing, and attributing it to an older end would mint a leak out of an
  // unrelated tool. So the limb reads the ended receipt's OWN settlement - the one shape the artifacts can place.
  let usingTool = 0;
  for (const reading of windowed) {
    const owner = ends.find((end) => end.executionId === reading.executionId) ?? null;
    if (owner === null) continue;
    usingTool += 1;
    leakFor(owner).usingTool += 1;
  }

  // THE PROBE LINE IS THE WRITER'S NAME, AND ITS OWN CLOCK IS WHERE IT HAPPENED. A run whose log carried none answers
  // `none_logged`; a run with no log at all answers `no_mod_log`, because "there was nothing to read" and "nothing was
  // written" are not the same fact. The placements below are the other half: each line joined to the receipt nearest it.
  const writer =
    probeLines === null
      ? Object.freeze({ state: "no_mod_log", site: null, lines: null })
      : probeLines.length === 0
        ? Object.freeze({ state: "none_logged", site: null, lines: 0 })
        : Object.freeze({ state: "logged", site: probeLines[probeLines.length - 1].site, lines: probeLines.length });

  const gate = leaks.length > 0 ? "blocked" : unattributed.length > 0 ? "not_measured" : "clear";

  return Object.freeze({
    slots,
    states,
    population,
    mounted: mounted.size,
    boundMs: USING_TOOL_BOUND_MS,
    boundSource: USING_TOOL_BOUND_SOURCE,
    examined: ends.length,
    ends: Object.freeze(ends),
    leaks: Object.freeze(leaks),
    codes: Object.freeze(leaks.map((leak) => `${IMPLICIT_BODY_HOLD_LEAK}:${leak.actionId}:${leak.reasonCode}`)),
    writer,
    stalls,
    unattributedStalls: unattributed.length,
    unattributed: Object.freeze(unattributed),
    usingTool,
    probeLines: probeLines ?? Object.freeze([]),
    placements: placing.placements,
    placedLines: placing.placed,
    outsideWindowLines: placing.outsideWindow,
    untimedCopies: placing.untimedCopies,
    unplacedLines: placing.unplaced,
    clockAnchor: placing.anchor,
    clockedByTheLogUnreadable: placing.clockedByTheLog,
    unknownStates,
    unmounted: Object.freeze(unmounted),
    limits,
    gate,
    absent: null,
  });
}

/** The codes a reader has to act on, one line each, with what produced them. */
const slotsRelative = (path) =>
  path
    .slice(root.length + 1)
    .split("\\")
    .join("/");

export function bodyHoldLeakLines(report) {
  const label = (name) => `${name.padEnd(19)}`;
  const statusLabel = (name) => `    ${name.padEnd(18)}`;
  const lines = [];
  const push = (line) => lines.push(line);
  push(
    `${label("body-hold-leak")} ${report.gate === "unaskable" ? "NOT_MEASURED" : report.gate.toUpperCase()}  ${
      report.absent === null ? report.codes.join(" · ") || "no leak" : `not_measured (${report.absent})`
    }`,
  );
  for (const leak of report.leaks)
    push(
      `${statusLabel("ended")}${iso(leak.atMs)} ${leak.actionId} ${leak.state} ${leak.reasonCode}` +
        ` · stalled_with_no_holder:${leak.stallHolders.join(",") || "none"} x${String(leak.stalls)}` +
        ` · using_tool=true x${String(leak.usingTool)}`,
    );
  push(
    `${statusLabel("writer")}${
      report.writer.state === "logged"
        ? `${report.writer.site} (native:${report.writer.site}; last of ${String(report.writer.lines)} [body-hold] unattributed line(s) in mod-log.txt)`
        : report.writer.state === "none_logged"
          ? "none_logged - mod-log.txt carried no [body-hold] unattributed line, which is why the hold has no name"
          : "no_mod_log - this run published no mod-log.txt, so the writer was never readable"
    }`,
  );
  push(
    `${statusLabel("signals")}stalled_with_no_holder:CanMove x${String(report.stalls)}` +
      ` · using_tool=true x${String(report.usingTool)} (bound ${String(report.boundMs)} ms)` +
      ` · [body-hold] unattributed x${String(report.probeLines.length)}`,
  );
  for (const placement of report.placements)
    push(`${statusLabel("placement")}[body-hold] writer=${placement.site} at ${placement.clock} -> ${placement.join}`);
  if (report.placements.length > 0)
    push(
      `${statusLabel("placed")}${String(report.placedLines)} of ${String(report.placements.length)} [body-hold] unattributed line(s) placed` +
        ` · ${String(report.untimedCopies)} untimed copy(ies) placed by a same-site line` +
        ` · ${String(report.outsideWindowLines)} with no receipt within ${String(PROBE_JOIN_WINDOW_MS / 1_000)} s` +
        ` · ${String(report.unplacedLines)} with no clock and no twin`,
    );
  if (report.clockAnchor !== null) push(`${statusLabel("anchor")}${report.clockAnchor.text}`);
  else if (report.clockedByTheLogUnreadable)
    push(
      `${statusLabel("anchor")}none - mod-log.txt carries [hh:mm:ss] prefixes but the run published no startedAtMs to read them against, so those lines are unplaced rather than guessed at`,
    );
  push(`${statusLabel("bound")}${String(report.boundMs)} ms <- ${report.boundSource}`);
  push(
    `${label("population")}slot-holding actions ${String(report.slots.actionIds.length)} · of ${String(
      report.mounted,
    )} mounted · windows examined ${String(report.examined)} · blocked ${String(report.leaks.length)}`,
  );
  push(`${statusLabel("derived")}${report.population}`);
  if (report.unmounted.length > 0)
    push(
      `${statusLabel("unmounted")}${report.unmounted.join(",")} - a slot word the registration table does not publish, so the population is stale`,
    );
  if (report.unknownStates.length > 0)
    push(
      `${statusLabel("unknown")}${report.unknownStates.join(",")} - a state this reading cannot place between succeeded and non-Succeeded`,
    );
  if (report.unattributedStalls > 0)
    for (const entry of report.unattributed)
      push(`${statusLabel("unattributed")}${iso(entry.atMs)} stalled_with_no_holder:${entry.holder} - ${entry.why}`);
  for (const limit of report.limits) push(`${statusLabel("limit")}${limit}`);
  push(
    `${statusLabel("<-")}result.json bridgeFacts execution_receipt · ${slotsRelative(report.slots.path)} rows · ${slotsRelative(report.states.path)} ExecutionState · mod-log.txt`,
  );
  return Object.freeze(lines);
}
