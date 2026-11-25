#!/usr/bin/env node
/**
 * THE PAIRED LIVE RUN: one deterministic probe x one real companion, four slices, four judgements.
 *
 * WHY THIS RUN EXISTS
 * -------------------
 * A single-companion session answers ONE question per run, costs about three quarters of an hour, and every question
 * after the first is paid for again. This run asks four at once, on one shared world, with the player's side driven by
 * a script that contains no model: joint attention, a concurrent claim on one tile, a co-op night, and cross-day
 * recall. Each slice stops the run when it fails, and each slice prints its OWN line, so one failure cannot hide the
 * other three.
 *
 * WHAT IT REUSES, AND THE ONE THING IT ADDED
 * -----------------------------------------
 *   `tools/lib/stardew-multiplayer-agent-runtime.mjs`  - the product's real Game runtime on the ONE bridge consumer
 *                                                       (`openAgentDrivenSession`, extracted from
 *                                                       `runAgentDrivenLoop` so several turns share one session).
 *   `tools/lib/stardew-native-smoke-harness-v1.mjs`    - `observeFresh`, `executeFreshAfterReobserve`,
 *                                                       `waitForTerminal`, `readNativeClientConfig`.
 *   `tools/lib/multiday-baseline.mjs`                  - `parseReceiptEvidence` and the night-ending authority
 *                                                       (`worldNightEndingsFromFacts` reads BOTH spellings: a
 *                                                       `night_ended_*` fact and a `sleep` receipt's `day_advanced`).
 *   `tools/lib/companion-behaviour-rubric.mjs`         - unchanged; this run judges the world, and hands the same
 *                                                       rubric the same turns it always grades.
 *   `tools/run-stardew-shared-world-action.ps1`        - the two-process topology, the fixture arm and the Host sleep
 *                                                       lane; this run is launched THROUGH it, never beside it.
 *   `tools/lib/stardew-player-probe-driver.mjs`        - ADDED: the player-side script and its dispatch recorder. The
 *                                                       harness could not do it, because every runner in it dispatches
 *                                                       ONE request and waits, and none keeps a second request stream in
 *                                                       flight on one client while a model turn runs.
 *
 * WHICH BODY EACH SIDE DRIVES, said once so no slice has to imply it
 * -----------------------------------------------------------------
 * The Mod builds a bridge only on the AI-Farmhand instance (`integrations/stardew/ModEntry.cs:900-905` returns early
 * when `hostRoleConfigured`; the single `LocalPipeBridge` is `ModEntry.cs:1078-1094`) and it admits ONE consumer. So:
 *   * the PROBE dispatches through the companion's own client, on the companion's own body, in S1, S2 and S4.
 *     "Concurrent" there means two request streams racing on ONE actor - the product's single-actor serialization
 *     invariant (`#1246`), which S2 measures and which nothing outside the product has measured before.
 *   * S3 is the ONE slice with two real farmers: the Host player's night is driven by the file-armed lifecycle
 *     (`tools/run-stardew-shared-world-action.ps1:297-309`, `-HostSleepLifecycleEvidence`) and the companion's night by
 *     the wire `sleep` action on her own farmer.
 * Anything that would need a second bridge body prints `not_measured: two_bodies_unavailable`. The run's value is that
 * its four lines are honest, not that all four are green.
 *
 * `tGameMs` IS ONE MEASUREMENT ACROSS BOTH SIDES
 * ---------------------------------------------
 * Every record - the probe's dispatches and the companion's receipts - carries `atMs` (wall) AND `tGameMs` from the
 * world's own clock (`Game1.timeOfDay` as snapshot `timeOfDay`, and as a receipt's `observation.inGameTime`), so "the
 * same tick" is a number in one trace. A slice whose clock could not be read on either side is `not_measured`: a
 * fabricated 0 compares equal to another fabricated 0 and would read as "same tick".
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assessCompanionBehaviourRubric } from "./lib/companion-behaviour-rubric.mjs";
import { openAgentDrivenSession } from "./lib/stardew-multiplayer-agent-runtime.mjs";
import {
  executeFreshAfterReobserve,
  observeFresh,
  readNativeClientConfig,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import {
  gameClockHhmmFromMs,
  gameClockMsFromInGameTime,
  planProbeScript,
  receiptTargetTile,
  runProbeScript,
  snapshotClock,
} from "./lib/stardew-player-probe-driver.mjs";
import {
  NIGHT_CAUSE_SLEEP,
  parseReceiptEvidence,
  worldDayStartsFromFacts,
  worldNightEndingsFromFacts,
} from "./lib/multiday-baseline.mjs";

/**
 * The four slices, in the order they must run, each with the budget it gets.
 *
 * `gameMinutes` is what the slice is worth in the world; `sliceSeconds` is what it may spend on the wall clock, and
 * the two are reported side by side. They are not the same unit: Stardew advances ten game minutes every seven real
 * seconds, so a slice bounded in GAME minutes would be twenty real seconds - less than one model turn - and the run
 * would then be measuring its own budget instead of the companion.
 */
export const PAIRED_SLICES = Object.freeze([
  Object.freeze({
    id: "s1_attention",
    gameMinutes: 2,
    sliceSeconds: 180,
    measures: "does she act on the tile the probe pointed at",
    probeBody: "companion_body",
  }),
  Object.freeze({
    id: "s2_claim",
    gameMinutes: 3,
    sliceSeconds: 180,
    measures: "two concurrent claims on one actor: exactly one wins, the other refused by name",
    probeBody: "companion_body",
  }),
  Object.freeze({
    id: "s3_night",
    gameMinutes: 3,
    sliceSeconds: 240,
    measures: "do BOTH farmers sleep in the same night, each night readable with a bedTime",
    probeBody: "host_farmer",
  }),
  Object.freeze({
    id: "s4_memory",
    gameMinutes: 2,
    sliceSeconds: 240,
    measures: "on the next day, does she SAY what happened on day one, and is it in the world facts",
    probeBody: "companion_body",
  }),
]);

/**
 * The fixture scenario that would arm each precondition, named so a 3 a.m. reader has the next command and not a
 * diagnosis.
 *
 * The values are the Mod's own scenario ids from the HostAutomation dispatcher
 * (`integrations/stardew/ModEntry.Fixtures.HostAutomation.cs`). NO one scenario carries all four: a ripe crop lives in
 * `native_harvest_crop_v1`, a chest in `native_chest_retrieve_v1`, `native_strawberry_covenant_v1` and
 * `native_multi_day_v1` are native-local only, and the shared-world loop entry arms `LOOP_SCENARIO = ""` while the
 * driver refuses `-Action harvest_crop` (`shared_world_action_not_wired`). That is why a missing precondition fails the
 * slice BY NAME instead of being satisfied by a fixture this run invented - the rule the single-player fixtures paid
 * for.
 */
export const FIXTURE_ARMS = Object.freeze({
  ready_grab_crop: Object.freeze({
    scenario: "native_harvest_crop_v1",
    then: "S1 and S2 measure a real ripe crop (the fixture seeds a Tomato plot and grows it to ready)",
  }),
  second_ready_grab_crop: Object.freeze({
    scenario: "native_harvest_crop_v1",
    then: "S2 contends over a SECOND ripe tile, so S1's own harvest cannot starve it",
  }),
  chest_with_item: Object.freeze({
    scenario: "native_chest_retrieve_v1",
    then: "the probe's chest step opens a container that really holds an item",
  }),
  host_bed: Object.freeze({
    scenario: "the Host save's own farmhouse (the driver's -HostSleepLifecycleEvidence lane)",
    then: "the Host farmer has a bed the file-armed lifecycle can reach, and a night record to read",
  }),
});

const TERMINAL_SUCCESS = new Set(["succeeded", "partially_succeeded"]);

/** The one sentence each slice hands the companion. The S2 line names the tile, because a player would. */
export function sliceAllocation(slice, { tile = null } = {}) {
  if (slice === "s1_attention") return ["玩家在那格熟了的作物旁边挥手叫你了。过去把它收了。"];
  if (slice === "s2_claim") return [`把 (${tile.x},${tile.y}) 那一格熟了的作物收了。`];
  if (slice === "s3_night")
    return ["天不早了，回家上床睡觉吧；这一晚我们一起过。"];
  if (slice === "s4_memory") return ["昨天（第 1 天）你在农场做了什么？说说你亲手做成的事。"];
  throw new Error(`paired_slice_unknown:${String(slice)}`);
}

/** A slice verdict. `state` is `passed` / `failed` / `not_measured`; a missing measurement is never a pass. */
function verdict(slice, state, reasonCode, reads = {}) {
  return Object.freeze({ slice, state, reasonCode, reads: Object.freeze({ ...reads }) });
}

const tileKey = (tile) => (tile === null || tile === undefined ? null : `${tile.x},${tile.y}`);
const addressOf = (tile) => (tile === null || tile === undefined ? null : `${tile.x}:${tile.y}`);

/** The clock delta between two world readings, in game minutes, or `null` when either side never read one. */
export function gameMinutesBetween(leftMs, rightMs) {
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return null;
  return Math.round((rightMs - leftMs) / 60_000);
}

/**
 * S1 - JOINT ATTENTION, as ONE body can measure it: did she act on the tile the probe pointed at.
 *
 * This is not attention between two farmers - no second bridge body exists today (see the header) - so the property
 * judged is the one that survives that limit: a companion pointed at a tile that then acts on a DIFFERENT tile is the
 * defect, and it needs no second farmer to show itself.
 *
 * `wrong_target` is failed and separate from `late` on purpose: acting somewhere else is a wrong reading of the
 * player's attention, while acting nowhere is a slow response. Collapsing them would let the first hide in the second.
 */
export function judgeJointAttention({ probeTile, probeTGameMs, companion = [], companionDay = null, turnTimedOut = false }) {
  if (probeTile === null || probeTile === undefined)
    return verdict("s1_attention", "not_measured", "fixture_missing:ready_grab_crop", { fixtureArm: "ready_grab_crop" });
  // A turn the slice's own budget cut short measured nothing: the reason she acted on nothing is our clock, not her.
  // Without this the two would be the same reading, and a slow harness would report as a slow companion.
  if (turnTimedOut === true && companion.length === 0)
    return verdict("s1_attention", "not_measured", "turn_budget_exhausted", { probeTile: tileKey(probeTile) });
  const withTargets = companion.filter((receipt) => receipt.targetTile !== null && receipt.targetTile !== undefined);
  if (companion.length === 0)
    return verdict("s1_attention", "failed", "late", { probeTile: tileKey(probeTile), probeTGameMs });
  if (withTargets.length === 0)
    return verdict("s1_attention", "not_measured", "no_companion_receipt_names_a_tile", {
      probeTile: tileKey(probeTile),
      companionReceipts: companion.length,
    });
  const onTarget = withTargets.filter((receipt) => tileKey(receipt.targetTile) === tileKey(probeTile));
  const elsewhere = withTargets.filter((receipt) => tileKey(receipt.targetTile) !== tileKey(probeTile));
  const companionClock = onTarget[0]?.tGameMs ?? elsewhere[0]?.tGameMs ?? null;
  const reads = {
    probeTile: tileKey(probeTile),
    probeTGameMs,
    companionTGameMs: companionClock,
    companionDay,
    dGameMin: gameMinutesBetween(probeTGameMs, companionClock),
    probeBody: "companion_body",
    companionTiles: [...new Set(withTargets.map((receipt) => tileKey(receipt.targetTile)))],
  };
  if (onTarget.length > 0) return verdict("s1_attention", "passed", "companion_acted_on_the_pointed_tile", reads);
  if (elsewhere.length > 0) return verdict("s1_attention", "failed", "wrong_target", reads);
  return verdict("s1_attention", "failed", "late", reads);
}

/**
 * S2 - THE CONCURRENT CLAIM: two request streams on one actor, the same tile, the same slice.
 *
 * The invariant under test is `#1246`'s active native mutation serialization: exactly one of two claims on one native
 * row may settle as the effect, and the other must be refused BY NAME rather than settling quietly. "By name" is a
 * non-empty reason code; "may not claim the effect" is enforced on the loser's OWN receipt - its state and its
 * `evicted` addresses - because a refusal that still lists the row as taken is the claim-without-fact shape this run
 * exists to catch.
 */
export function judgeConcurrentClaim({ contended, probe = null, companion = null, world = null }) {
  const contendedKey = tileKey(contended);
  if (contendedKey === null)
    return verdict("s2_claim", "not_measured", "fixture_missing:second_ready_grab_crop", {
      fixtureArm: "second_ready_grab_crop",
    });
  if (probe === null || companion === null)
    return verdict("s2_claim", "not_measured", "one_side_never_dispatched", {
      contended: contendedKey,
      probeDispatched: probe !== null,
      companionDispatched: companion !== null,
    });
  const reads = {
    contended: contendedKey,
    probe: { state: probe.state, reasonCode: probe.reasonCode },
    companion: { state: companion.state, reasonCode: companion.reasonCode },
    dGameMin: gameMinutesBetween(probe.tGameMs, companion.tGameMs),
    world,
  };
  const probeWon = TERMINAL_SUCCESS.has(probe.state);
  const companionWon = TERMINAL_SUCCESS.has(companion.state);
  if (probeWon && companionWon) return verdict("s2_claim", "failed", "both_claimed", reads);
  if (!probeWon && !companionWon) return verdict("s2_claim", "failed", "neither_succeeded", reads);
  const loser = probeWon ? companion : probe;
  const loserName = probeWon ? "companion" : "probe";
  if (typeof loser.reasonCode !== "string" || loser.reasonCode.length === 0)
    return verdict("s2_claim", "failed", `unnamed_refusal:${loserName}`, reads);
  if (loser.evicted.includes(addressOf(contended)))
    return verdict("s2_claim", "failed", `loser_claimed_the_effect:${loserName}`, reads);
  const winner = probeWon ? probe : companion;
  const winnerEvicted = winner.evicted.includes(addressOf(contended));
  const worldConfirms = world === "crop_row_evicted";
  if (!worldConfirms && !winnerEvicted)
    return verdict("s2_claim", "not_measured", "world_fact_absent", { ...reads, winnerEvicted });
  return verdict("s2_claim", "passed", `one_won_one_refused_by_name:${probeWon ? "probe" : "companion"}`, {
    ...reads,
    winner: probeWon ? "probe" : "companion",
    loser: loserName,
    loserReason: loser.reasonCode,
    winnerEvicted,
  });
}

/**
 * S3 - THE CO-OP NIGHT, the one slice with two real farmers.
 *
 * Both nights must be READABLE: `bedTime` is an integer clock reading and `bedTimeSource` says which observation
 * produced it. A night with neither is BARE - `round94`'s `null`, a body that never slept wearing a record's clothes.
 *
 * THREE OUTCOMES, deliberately distinct, because they have three different owners:
 *   * `failed`      - the body did not sleep. `round94`'s shape, and the companion's fault.
 *   * `not_measured`- the instrument cannot see the hour. Today the Host's evidence file publishes the crossing's
 *                     `dayBefore` and NO clock, so the Host side of this slice is unreadable by construction and must
 *                     not be reported as the farmer's failure. The line names the field that would close it.
 *   * `not_measured`- two bodies were never available: the run was not launched with the Host sleep lane.
 */
export function judgeCoopNight({ hostNight, companionNight }) {
  if (hostNight === null || hostNight === undefined)
    return verdict("s3_night", "not_measured", "two_bodies_unavailable:host_night_not_configured", {
      launchesWith: "-HostSleepLifecycleEvidence <absolute path>",
      fixtureArm: "host_bed",
    });
  if (hostNight.absent === true)
    return verdict("s3_night", "not_measured", `two_bodies_unavailable:${hostNight.reason}`, {});
  const reads = {
    hostDay: hostNight.day ?? null,
    hostBedTime: hostNight.bedTime,
    hostBedTimeSource: hostNight.bedTimeSource,
    hostBedTimeAbsent: hostNight.bedTimeAbsent,
    hostState: hostNight.state,
    companionDay: companionNight?.day ?? null,
    companionBedTime: companionNight?.bedTime ?? null,
    companionBedTimeSource: companionNight?.bedTimeSource ?? null,
    companionBedTimeAbsent: companionNight?.bedTimeAbsent ?? null,
  };
  if (!Number.isInteger(hostNight.bedTime))
    return verdict("s3_night", "not_measured", `host_bed_time_unreadable:${hostNight.bedTimeAbsent}`, reads);
  if (companionNight === null || companionNight === undefined)
    return verdict("s3_night", "not_measured", "companion_night_absent", reads);
  if (!Number.isInteger(companionNight.bedTime))
    return verdict("s3_night", "failed", "companion_never_slept", reads);
  if (hostNight.day !== companionNight.day)
    return verdict("s3_night", "failed", `wrong_night:probe=day${hostNight.day}:companion=day${companionNight.day}`, reads);
  return verdict("s3_night", "passed", "both_farmers_slept_in_the_same_night", {
    ...reads,
    order: hostNight.bedTime <= companionNight.bedTime ? "host_first" : "companion_first",
  });
}

/**
 * S4 - CROSS-DAY RECALL, in its two halves, judged separately because they fail differently.
 *
 * Half one: does she SAY it. Half two: is it in the world facts. Right by luck is `claim_without_fact` - she asserted
 * what the trace cannot support; silent about a fact that IS there is `not_recalled`. Both are reported, so a reader
 * sees which half carried the verdict.
 *
 * The instrument is a TOKEN match against the day-one anchor's own vocabulary - the tile, the item id, and the crop's
 * published `displayName` - because that is the only language-independent handle a run has without a semantic judge.
 * It is high precision and LOW recall, so `not_recalled` means "no anchor token appeared", never "she forgot".
 */
export function judgeCrossDayMemory({ anchor, dayOneFactsInTrace, companionTurns = [], dayRolledOver }) {
  if (dayRolledOver !== true) return verdict("s4_memory", "not_measured", "day_did_not_roll_over", {});
  if (anchor === null || anchor === undefined || anchor.tile === null || anchor.tile === undefined)
    return verdict("s4_memory", "not_measured", "anchor_absent:no_day_one_action_on_a_tile", {});
  if (companionTurns.length === 0)
    return verdict("s4_memory", "not_measured", "no_next_day_turn", { anchor: tileKey(anchor.tile) });
  const tokens = anchorTokens(anchor);
  const said = companionTurns.filter((text) => tokens.some((token) => String(text).toLowerCase().includes(token)));
  const reads = {
    anchor: tileKey(anchor.tile),
    anchorItemId: anchor.itemId ?? null,
    anchorDisplayName: anchor.displayName ?? null,
    tokens: tokens.length,
    saysIt: said.length > 0,
    inWorldFacts: dayOneFactsInTrace === true,
    nextDayTurns: companionTurns.length,
  };
  if (reads.saysIt && dayOneFactsInTrace !== true) return verdict("s4_memory", "failed", "claim_without_fact", reads);
  if (!reads.saysIt && dayOneFactsInTrace !== true)
    return verdict("s4_memory", "not_measured", "nothing_to_recall", reads);
  if (!reads.saysIt) return verdict("s4_memory", "failed", "not_recalled", reads);
  return verdict("s4_memory", "passed", "recalled_a_fact_the_trace_holds", reads);
}

/** The vocabulary the day-one anchor can be recognised by. Short and empty tokens are dropped, never matched. */
function anchorTokens(anchor) {
  const tokens = [];
  if (anchor.tile !== null && anchor.tile !== undefined)
    tokens.push(`${anchor.tile.x},${anchor.tile.y}`, `${anchor.tile.x}:${anchor.tile.y}`);
  if (typeof anchor.itemId === "string" && anchor.itemId.length > 1) {
    tokens.push(anchor.itemId.toLowerCase());
    const numeric = /\(O\)([0-9]+)/u.exec(anchor.itemId)?.[1];
    if (numeric !== undefined) tokens.push(numeric);
  }
  if (typeof anchor.displayName === "string" && anchor.displayName.trim().length > 1)
    tokens.push(anchor.displayName.trim().toLowerCase());
  return Object.freeze(tokens.filter((token) => token.length > 1));
}

/** One line per slice, printed the moment the slice is decided; every read the verdict used is on it. */
export function renderSliceLine(sliceVerdict) {
  const reads = Object.entries(sliceVerdict.reads)
    .map(([key, value]) => `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
    .join(" ");
  return `PAIRED_SLICE ${sliceVerdict.slice} ${sliceVerdict.state} ${sliceVerdict.reasonCode}${
    reads.length > 0 ? ` ${reads}` : ""
  }`;
}

/** The fixture gap, written as the message a reader needs at 3 a.m.: what is missing, what arms it, what it measures. */
export function fixtureGapLine(requirement, reason) {
  const arm = FIXTURE_ARMS[requirement];
  return [
    `PAIRED_FIXTURE_MISSING ${requirement} reason=${reason}`,
    `arm=${arm?.scenario ?? "no scenario declared"}`,
    `then=${arm?.then ?? "nothing this run can measure"}`,
  ].join(" ");
}

/** The topology, stated rather than implied: who owns the pipe, which body the probe drives, what is unreachable. */
export function topologyFacts() {
  return Object.freeze({
    bridgeConsumers: 1,
    pipeOwner: "the companion runtime's own LocalStardewBridgeClient; the probe sends через the SAME client object",
    secondConnectionOpenedByProbe: false,
    probeBodyBySlice: Object.freeze(Object.fromEntries(PAIRED_SLICES.map((slice) => [slice.id, slice.probeBody]))),
    secondBodyAvailable: "host_farmer_sleep_only",
    secondBodyReason:
      "ModEntry.cs:900-905 skips bridge construction for the Host role, and LocalPipeBridge admits one consumer",
  });
}

/** Normalise one Mod receipt so a judgement reads fields, never narration. */
export function normalizeReceipt(payload, { atMs, requester = "companion" } = {}) {
  return Object.freeze({
    requester,
    actionId: typeof payload?.actionId === "string" ? payload.actionId : null,
    requestId: payload?.requestId ?? null,
    executionId: payload?.executionId ?? null,
    state: payload?.state ?? "unknown",
    reasonCode: payload?.reasonCode ?? null,
    revision: Number.isSafeInteger(payload?.revision) ? payload.revision : null,
    evidence: payload?.evidence ?? null,
    evicted: Array.isArray(payload?.evicted) ? payload.evicted : [],
    targetTile: receiptTargetTile(payload, { parseEvidence: parseReceiptEvidence }),
    tGameMs: gameClockMsFromInGameTime(payload?.observation?.inGameTime),
    atMs,
  });
}

/**
 * The Host farmer's night, from the file-armed lifecycle's own evidence file.
 *
 * `settlement.dayBefore` is the day the night ended on, which is the identity both writers agree about. The CLOCK IS
 * NOT PUBLISHED by this lane, so `bedTime` is `null` with that reason stated rather than invented - and `judgeCoopNight`
 * turns an unreadable hour into `not_measured`, because the farmer's night and the instrument's blind spot are two
 * different facts.
 */
export function readHostNightRecord(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return Object.freeze({ absent: true, reason: "host_sleep_lifecycle_evidence_missing" });
  }
  let evidence;
  try {
    evidence = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    return Object.freeze({ absent: true, reason: "host_sleep_lifecycle_evidence_unreadable" });
  }
  const dayBefore = evidence?.settlement?.dayBefore;
  return Object.freeze({
    absent: false,
    state: evidence?.state ?? null,
    reasonCode: evidence?.reasonCode ?? null,
    day: Number.isInteger(dayBefore) ? dayBefore : null,
    bedTime: null,
    bedTimeSource: null,
    bedTimeAbsent: "host_lifecycle_evidence_publishes_no_clock",
  });
}

/**
 * The companion's own night, from the trace.
 *
 * The night ending itself is `multiday-baseline.mjs`'s reading, in BOTH spellings (a `night_ended_*` world fact and a
 * `sleep` receipt whose reason is the crossing). The HOUR comes from the clock the runner read immediately before her
 * night began - the same `pre_crossing_clock` provenance that module's watched records carry - and is absent with a
 * reason when no reading was taken.
 */
export function readCompanionNightRecord({ worldFacts = [], receipts = [], preCrossingClock = null }) {
  const endings = worldNightEndingsFromFacts([...worldFacts, ...receipts]);
  if (endings.length === 0) return null;
  const ending = endings.find((entry) => entry.cause === NIGHT_CAUSE_SLEEP) ?? endings[endings.length - 1];
  const bedTime = Number.isFinite(preCrossingClock) ? gameClockHhmmFromMs(preCrossingClock) : null;
  return Object.freeze({
    day: ending.day,
    cause: ending.cause,
    bedTime,
    bedTimeSource: bedTime === null ? null : "pre_crossing_clock",
    bedTimeAbsent: bedTime === null ? "no_clock_reading_before_the_crossing" : null,
  });
}

/** One probe dispatch through the harness's own fresh-request path, on the client the companion already owns. */
async function dispatchProbeStep({ client, receipts, step, snapshot, onRequestId }) {
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const requestId = `native_local_${step.action}_probe_${step.stepId}_${nonce}`.slice(0, 200);
  onRequestId(requestId);
  try {
    const accepted = await executeFreshAfterReobserve(client, {
      action: step.action,
      args: step.args,
      snapshot,
      requestId,
      idempotencyKey: `${requestId}_idem`,
    });
    if (accepted?.state !== "accepted")
      return { requestId, state: accepted?.state ?? "unknown", reasonCode: accepted?.reasonCode ?? "not_accepted" };
    const terminal = await waitForTerminal(receipts(), accepted, 30_000);
    return { requestId, state: terminal.state, reasonCode: terminal.reasonCode ?? null };
  } catch (error) {
    return { requestId, state: "failed", reasonCode: String(error?.message ?? error) };
  }
}

/** Race a promise against a wall budget, reporting the timeout instead of throwing it. */
async function withBudget(promise, timeoutMs) {
  let timer;
  const budget = new Promise((resolveBudget) => {
    timer = setTimeout(() => resolveBudget({ timedOut: true, value: null }), timeoutMs);
  });
  try {
    const value = await Promise.race([promise.then((result) => ({ timedOut: false, value: result })), budget]);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function readPairedOptions(argv = process.argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  return Object.freeze({
    // The existing multiplayer loop entry already exports `GAMEBUDDY_LOOP_TRACE_DIR` for the runner it launches, so a
    // paired run started through it needs no second convention: one variable, one meaning.
    traceDir: value("trace-dir") ?? process.env.GAMEBUDDY_PAIRED_TRACE_DIR ?? process.env.GAMEBUDDY_LOOP_TRACE_DIR ?? null,
    hostNightEvidence: value("host-night-evidence") ?? process.env.GAMEBUDDY_PAIRED_HOST_SLEEP_EVIDENCE ?? null,
    sliceSeconds: Number(value("slice-seconds") ?? 0) || null,
  });
}

/**
 * The run itself: four slices against one open session, every record written to ONE trace.
 *
 * `sessionFactory`, `observe` and `dispatch` are injected so the slices can be driven by a test without a game; the
 * production call uses none of them.
 */
export async function runPairedLiveRun({
  config,
  traceDir,
  hostNightEvidence = null,
  sliceSeconds = null,
  sessionFactory = openAgentDrivenSession,
  now = () => Date.now(),
  observe = null,
  dispatch = null,
  runTurn = null,
}) {
  if (typeof traceDir !== "string" || traceDir.length === 0) throw new Error("paired_trace_dir_required");
  mkdirSync(traceDir, { recursive: true });
  const startedAtMs = now();
  const receipts = [];
  const worldFacts = [];
  const probeRequestIds = new Set();
  const lines = [];
  const timelinePath = join(traceDir, "timeline.jsonl");
  const probePath = join(traceDir, "probe.jsonl");
  const slicePath = join(traceDir, "slices.jsonl");
  let traceBytes = 0;

  const timeline = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    traceBytes += Buffer.byteLength(line, "utf8");
    appendFileSync(timelinePath, line);
  };
  const print = (line) => {
    lines.push(line);
    appendFileSync(slicePath, `${line}\n`);
    console.log(line);
  };

  const onFact = (fact) => {
    const atMs = now() - startedAtMs;
    if (fact.type === "execution_receipt") {
      const requester = probeRequestIds.has(fact.payload?.requestId) ? "probe" : "companion";
      const receipt = normalizeReceipt(fact.payload, { atMs, requester });
      receipts.push(receipt);
      timeline({ atMs, tGameMs: receipt.tGameMs, type: fact.type, requester, payload: fact.payload });
      return;
    }
    if (fact.type === "world_fact") worldFacts.push(fact.payload);
    timeline({ atMs, type: fact.type, payload: fact.payload });
  };

  const session = await sessionFactory({ config, traceDir, onFact });
  const client = session.client ?? null;
  const clockOf = (snapshot) => snapshotClock(snapshot);
  const observeFn = observe ?? (() => observeFresh(client));
  const dispatchFn =
    dispatch ??
    ((request) => dispatchProbeStep({ client, receipts: () => receipts, step: request.step, snapshot: request.snapshot, onRequestId: (id) => probeRequestIds.add(id) }));
  const dayStartsAtStart = worldDayStartsFromFacts(worldFacts).length;
  let knownTurns = 0;
  const turnsSeen = [];
  const results = [];
  let stoppedBy = null;
  let s1Anchor = null;
  let contendedTile = null;

  const askCompanion = async (allocation) => {
    const turn = await (runTurn ?? ((lines) => session.runTurn(lines)))(allocation);
    const turns = Array.isArray(turn?.turns) ? turn.turns : [];
    // The transcript is read whole on every turn, so "the turns this turn produced" is the suffix after the ones
    // already seen - and `knownTurns` is advanced HERE, not at a call site, so no slice can forget to.
    const produced = turns.slice(knownTurns);
    knownTurns = turns.length;
    turnsSeen.push(...produced.map((entry) => entry.text));
    return { ...turn, turns, produced };
  };

  const recordProbe = (records) => {
    for (const record of records) appendFileSync(probePath, `${JSON.stringify(record)}\n`);
  };

  const runSlice = async (sliceId, body) => {
    if (stoppedBy !== null) {
      const skipped = verdict(sliceId, "not_measured", `run_stopped_by:${stoppedBy.slice}:${stoppedBy.reasonCode}`);
      results.push(skipped);
      print(renderSliceLine(skipped));
      return skipped;
    }
    const slice = PAIRED_SLICES.find((entry) => entry.id === sliceId);
    const budgetMs = (sliceSeconds ?? slice.sliceSeconds) * 1_000;
    let decided;
    try {
      decided = await body(budgetMs);
    } catch (error) {
      decided = verdict(sliceId, "failed", `slice_error:${String(error?.message ?? error)}`);
    }
    results.push(decided);
    print(renderSliceLine(decided));
    if (decided.state === "failed") stoppedBy = declaredStop(decided);
    return decided;
  };

  // ---- S1: joint attention -----------------------------------------------------------------------------------
  await runSlice("s1_attention", async (budgetMs) => {
    const snapshot = await observeFn();
    const plan = planProbeScript({ snapshot, slice: "s1_attention", targetIndex: 0 });
    const crop = Array.isArray(snapshot?.harvestTargets)
      ? snapshot.harvestTargets.find((row) => row?.x === plan.tile?.x && row?.y === plan.tile?.y) ?? null
      : null;
    if (plan.tile !== null)
      s1Anchor = Object.freeze({ tile: plan.tile, itemId: crop?.qualifiedHarvestItemId ?? null, displayName: crop?.displayName ?? null });
    if (plan.tile === null) {
      print(fixtureGapLine("ready_grab_crop", plan.dropped[0]?.reason ?? "unknown"));
      return judgeJointAttention({ probeTile: null, probeTGameMs: null });
    }
    for (const dropped of plan.dropped) print(fixtureGapLine("chest_with_item", dropped.reason));
    const mark = receipts.length;
    const clock = clockOf(snapshot);
    const turnPromise = askCompanion(sliceAllocation("s1_attention"));
    const probeRecords = await runProbeScript({
      slice: "s1_attention",
      plan,
      observe: observeFn,
      dispatch: dispatchFn,
      now,
      startedAtMs,
    });
    recordProbe(probeRecords);
    const turn = await withBudget(turnPromise, budgetMs);
    const probeClock = probeRecords.find((record) => record.tGameMs !== null) ?? probeRecords[0] ?? null;
    return judgeJointAttention({
      probeTile: plan.tile,
      probeTGameMs: probeClock?.tGameMs ?? clock.tGameMs,
      companion: receipts.slice(mark).filter((receipt) => receipt.requester === "companion"),
      companionDay: probeClock?.dayOfMonth ?? clock.dayOfMonth,
      turnTimedOut: turn.timedOut === true,
    });
  });

  // ---- S2: the concurrent claim ------------------------------------------------------------------------------
  await runSlice("s2_claim", async (budgetMs) => {
    const snapshot = await observeFn();
    const plan = planProbeScript({ snapshot, slice: "s2_claim", targetIndex: 1 });
    if (plan.tile === null) {
      print(fixtureGapLine("second_ready_grab_crop", plan.dropped[0]?.reason ?? "unknown"));
      return judgeConcurrentClaim({ contended: null });
    }
    contendedTile = plan.tile;
    const contendedTargetId = plan.steps[0]?.args?.targetRef ?? null;
    const mark = receipts.length;
    const turnPromise = askCompanion(sliceAllocation("s2_claim", { tile: plan.tile }));
    const probeRecords = await runProbeScript({
      slice: "s2_claim",
      plan,
      observe: observeFn,
      dispatch: dispatchFn,
      now,
      startedAtMs,
    });
    recordProbe(probeRecords);
    await withBudget(turnPromise, budgetMs);
    const probeRecord = probeRecords.find((record) => record.action === "harvest_crop") ?? null;
    // The probe's ADDRESSES come from its own receipt, not from the dispatch summary: `evicted` is what the Mod
    // proved the world no longer describes, and it is the field that decides whether a "refused" step quietly claims
    // the effect it lost.
    const probeReceipt =
      probeRecord === null ? null : receipts.find((receipt) => receipt.requestId === probeRecord.requestId) ?? null;
    const probeSide =
      probeRecord === null
        ? null
        : {
            state: probeRecord.state,
            reasonCode: probeRecord.reasonCode,
            tGameMs: probeRecord.tGameMs,
            evicted: probeReceipt?.evicted ?? [],
            targetTile: probeReceipt?.targetTile ?? null,
          };
    const companionReceipts = receipts
      .slice(mark)
      .filter((receipt) => receipt.requester === "companion" && receipt.actionId === "harvest_crop");
    const companionReceipt =
      companionReceipts.find((receipt) => tileKey(receipt.targetTile) === tileKey(plan.tile)) ??
      companionReceipts[0] ??
      null;
    // THE WORLD FACT: the row the winner claims, read back from the world rather than from either receipt.
    let world = null;
    try {
      const after = await observeFn();
      const stillThere = Array.isArray(after?.harvestTargets)
        ? after.harvestTargets.some((row) => row?.targetId === contendedTargetId)
        : null;
      world = stillThere === false ? "crop_row_evicted" : stillThere === true ? "crop_row_still_present" : null;
    } catch {
      world = null;
    }
    return judgeConcurrentClaim({ contended: plan.tile, probe: probeSide, companion: companionReceipt, world });
  });

  // ---- S3: the co-op night -----------------------------------------------------------------------------------
  await runSlice("s3_night", async (budgetMs) => {
    const hostNight = readHostNightRecord(hostNightEvidence);
    if (hostNight === null || hostNight.absent === true) {
      print(fixtureGapLine("host_bed", hostNight?.reason ?? "host_sleep_lifecycle_evidence_not_configured"));
      return judgeCoopNight({ hostNight, companionNight: null });
    }
    const before = await observeFn().catch(() => null);
    const preCrossingClock = before === null ? null : clockOf(before).tGameMs;
    const mark = receipts.length;
    await withBudget(askCompanion(sliceAllocation("s3_night")), budgetMs);
    // The night is the WORLD's answer, so it is waited for in the world's own facts rather than assumed from her
    // turn having finished: a turn that says "去睡了" and a night that crossed are two different facts.
    const nightDeadline = now() + budgetMs;
    while (now() < nightDeadline) {
      if (readCompanionNightRecord({ worldFacts, receipts: [] }) !== null) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    const companionNight = readCompanionNightRecord({
      worldFacts,
      receipts: receipts.slice(mark).filter((receipt) => receipt.actionId === "sleep"),
      preCrossingClock,
    });
    return judgeCoopNight({ hostNight, companionNight });
  });

  // ---- S4: cross-day recall ----------------------------------------------------------------------------------
  await runSlice("s4_memory", async (budgetMs) => {
    const dayRolledOver = worldDayStartsFromFacts(worldFacts).length > dayStartsAtStart;
    const dayOneFactsInTrace =
      s1Anchor !== null &&
      receipts.some(
        (receipt) =>
          TERMINAL_SUCCESS.has(receipt.state) &&
          receipt.targetTile !== null &&
          tileKey(receipt.targetTile) === tileKey(s1Anchor.tile),
      );
    const turn = await withBudget(askCompanion(sliceAllocation("s4_memory")), budgetMs);
    const nextDayTurns = (turn.value?.produced ?? []).map((entry) => entry.text);
    return judgeCrossDayMemory({
      anchor: s1Anchor,
      dayOneFactsInTrace,
      companionTurns: nextDayTurns,
      dayRolledOver,
    });
  });

  const rubric = assessCompanionBehaviourRubric({
    turns: turnsSeen.map((text, index) => ({ turnId: `paired_${index + 1}`, text })),
    runReport: {
      durationSeconds: (now() - startedAtMs) / 1_000,
      traceBytes: { total: traceBytes },
      observationMeasurement: "not_applicable_paired_mode",
    },
  });
  const state = results.some((entry) => entry.state === "failed")
    ? "failed"
    : results.some((entry) => entry.state !== "passed")
      ? "blocked"
      : "passed";
  const report = Object.freeze({
    state,
    reasonCode: results.find((entry) => entry.state !== "passed")?.reasonCode ?? "all_four_slices_passed",
    durationSeconds: (now() - startedAtMs) / 1_000,
    slices: Object.freeze([...results]),
    topology: topologyFacts(),
    counts: Object.freeze({
      receipts: receipts.length,
      probeReceipts: receipts.filter((receipt) => receipt.requester === "probe").length,
      worldFacts: worldFacts.length,
      dayStarts: worldDayStartsFromFacts(worldFacts).length,
      contendedTile: tileKey(contendedTile),
    }),
    traceBytes,
    rubric,
  });
  writeFileSync(join(traceDir, "paired-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PAIRED_TOPOLOGY ${JSON.stringify(report.topology)}`);
  console.log(`PAIRED_RESULT ${JSON.stringify(report)}`);
  if (typeof session.dispose === "function") session.dispose();
  return report;
}

function declaredStop(sliceVerdict) {
  return { slice: sliceVerdict.slice, reasonCode: sliceVerdict.reasonCode };
}

if (import.meta.main) {
  const options = readPairedOptions();
  if (typeof options.traceDir !== "string" || options.traceDir.length === 0) {
    console.log(`PAIRED_RESULT ${JSON.stringify({ state: "blocked", reasonCode: "paired_trace_dir_required" })}`);
    process.exitCode = 2;
  } else {
    const config = await readNativeClientConfig();
    const report = await runPairedLiveRun({ config, ...options });
    // Every fact is on disk by this line, and the product runtime keeps handles open (bridge socket, timers) - the
    // same reason the multiplayer loop exits explicitly instead of letting the driver time it out.
    process.exit(report.state === "passed" ? 0 : report.state === "failed" ? 1 : 2);
  }
}
