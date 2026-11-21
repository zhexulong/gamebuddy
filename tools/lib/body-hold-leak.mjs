import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ANIMATION_CLASS } from "./action-pace.mjs";
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
 * WHAT IT CANNOT READ, stated rather than left to be discovered. A `[body-hold]` line carries no timestamp of its own, so
 * it can name a writer but never place one in time; the Travel and ToolApproach slots carry their action id in the spec
 * (`travel.Action`, `approach.ActionId`), so an end of one of those actions is outside this population by construction
 * rather than because it is clean; and nothing publishes slot occupancy, so a stall with no non-Succeeded end before it
 * is `not_measured` instead of attributed to a guess. These are printed with every reading.
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

const STALLED_HOLD = /held_by=stalled_with_no_holder:([A-Za-z0-9_]+)/u;
// The tool flag as the Mod publishes it when it settles beside the body: `farmhandexecutioncontroller.fishingactions.cs`
// writes `can_move=…|using_tool=…`, and the one shape that reports it up is the one this limb exists for.
const USING_TOOL_UP = /(?:using_tool|UsingTool)=(?:true|True)\b/u;
const HELD_BY = /held_by=/u;
const PROBE_SITE = /\[body-hold\]\s+unattributed\s+site=([^;\s]+)/u;

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
  const nonSucceeded = [...wire.values()].filter((word) => !unsettled.has(word) && !SUCCEEDED_STATES.includes(word));
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

/** The `[body-hold] unattributed` lines a run's Mod log carries, in log order. */
export function readProbeLines(modLogText) {
  if (typeof modLogText !== "string") return null;
  const lines = [];
  for (const line of modLogText.split("\n")) {
    const site = PROBE_SITE.exec(line)?.[1];
    if (site !== undefined) lines.push(site);
  }
  return Object.freeze(lines);
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
      if (!unsettled.includes(state) && !SUCCEEDED_STATES.includes(state)) unknownStates.add(state);
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
  const limits = Object.freeze([
    `a [body-hold] line carries no timestamp, so a writer can be named there but never placed in time (this run: ${probeLines === null ? "no mod-log.txt at all" : `${String(probeLines.length)} line(s)`})`,
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

  // THE PROBE LINE IS THE WRITER'S NAME, not a second signal: it cannot be placed in time, so it only says WHO took the
  // flag. A run whose log carried none answers `none_logged`; a run with no log at all answers `no_mod_log`, because
  // "there was nothing to read" and "nothing was written" are not the same fact.
  const writer =
    probeLines === null
      ? Object.freeze({ state: "no_mod_log", site: null, lines: null })
      : probeLines.length === 0
        ? Object.freeze({ state: "none_logged", site: null, lines: 0 })
        : Object.freeze({ state: "logged", site: probeLines[probeLines.length - 1], lines: probeLines.length });

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
