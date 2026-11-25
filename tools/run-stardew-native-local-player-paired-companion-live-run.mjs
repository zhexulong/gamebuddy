#!/usr/bin/env node
/**
 * THE PAIRED LIVE RUN: two real farmers, four slices, four judgements.
 *
 * WHY THIS RUN EXISTS
 * -------------------
 * A single-companion session answers ONE question per run, costs about three quarters of an hour, and every question
 * after the first is paid for again. This run asks four at once on one shared world, and it keeps a script with no
 * model in the decision path for the player's side. Each slice prints its OWN line, so one failure cannot hide the
 * other three.
 *
 * WHICH BODY EACH SIDE DRIVES, said once so no slice has to imply it
 * -----------------------------------------------------------------
 * The Mod builds a bridge only on the AI-Farmhand instance (`integrations/stardew/ModEntry.cs` returns early when
 * `hostRoleConfigured`; the single `LocalPipeBridge` is admitted by `LocalPipeBridge.cs:LocalPipeBridge`) and it admits ONE consumer. So on this
 * topology the Host player has no wire at all, and the only way to make her a second farmer is the fixture's own file
 * arms:
 *   * the HOST PLAYER is driven by `HostPlayerScriptChannel` (`integrations/stardew/HostPlayerScript.cs`) in S1 and S2:
 *     a script file the fixture writes, performed on the game thread against `Game1.player` through the engine's own
 *     native entries, with one record per settled step. That is the same kind of act the cross-day lifecycle already
 *     performs on the same body, and it is NOT a second bridge: no socket, no frame, no consumer, no request/response.
 *   * the COMPANION is driven by her own model turn on the one wire, and by nothing else: this run no longer dispatches
 *     a single request through her client. Every earlier "concurrent" reading was therefore two request streams on ONE
 *     actor; S2 now races two independent farmers over one container instead.
 *   * S3 has both: the Host player's night is this run's own `sleep` step on the script channel, dispatched in S3's
 *     window, and the companion's night is her own `sleep` turn. Neither side marks the other ready: the engine's
 *     `ReadyCheckDialog` crosses the day once both farmers have declared it.
 * Anything that would still need a third body prints `not_measured`, by name.
 *
 * WHAT EACH SLICE MEASURES NOW, AND WHAT IT MEASURED BEFORE
 * --------------------------------------------------------
 *   S1  a person waves at her from a place the slice has not named, and she starts at least
 *       `S1_MIN_ANCHOR_SEPARATION_TILES` (7) tiles from that place. The prompt carries NO tile and NO instruction to go
 *       anywhere; her only cue is `otherFarmers` in her own observation. The judgement is whether the tile she acts on
 *       is the tile that person is standing beside. The slice REFUSES TO START when the world stages her closer than
 *       that: a companion who begins inside the interaction radius can pass by standing still, and one who begins
 *       inside the six tiles `otherFarmers` used to be bounded by cannot show that the bound was the thing that moved.
 *   S2  the Host player and the companion contend for ONE container holding ONE item. The judgement reads both sides'
 *       records and the world's own answer afterwards, and it assumes neither order: either side may win.
 *   S3  both farmers sleep in the same night, each with a readable `bedTime`.
 *   S4  a promise the field cannot answer, made on day one, asked again after the session is REBUILT - a fresh game
 *       runtime session on the same durable runtime root and the same continuity identity, so the conversation is gone
 *       and anything recalled has to come from durable memory rather than from two screens of history. It is read for
 *       the PROMISE she says, not for the tree she names: the subject is what the field publishes, and naming it is not
 *       remembering (`covenant_subject_without_the_promise`).
 *
 * `tGameMs` IS ONE MEASUREMENT ACROSS BOTH SIDES
 * ---------------------------------------------
 * Every record - the Host player's steps and the companion's receipts - carries `atMs` (wall) AND `tGameMs` from the
 * world's own clock (`Game1.timeOfDay` as snapshot `timeOfDay`, as a receipt's `observation.inGameTime`, and as a
 * script record's `timeOfDay`), so "the same tick" is a number in one trace. A slice whose clock could not be read on
 * either side is `not_measured`: a fabricated 0 compares equal to another fabricated 0 and would read as "same tick".
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assessCompanionBehaviourRubric } from "./lib/companion-behaviour-rubric.mjs";
import { collectMemoryCacheLedger, describeMemoryCacheLedger } from "./lib/memory-cache-ledger.mjs";
import {
  NIGHT_CAUSE_SLEEP,
  parseReceiptEvidence,
  worldDayStartsFromFacts,
  worldNightEndingsFromFacts,
} from "./lib/multiday-baseline.mjs";
import { awaitCompanionPlacement, tileKey } from "./lib/paired-companion-placement.mjs";
import { openAgentDrivenSession } from "./lib/stardew-multiplayer-agent-runtime.mjs";
import { observeFresh, readNativeClientConfig } from "./lib/stardew-native-smoke-harness-v1.mjs";
import {
  chestWithItem,
  gameClockHhmmFromMs,
  gameClockMs,
  gameClockMsFromInGameTime,
  PROBE_EMOTE,
  readyGrabCrop,
  receiptTargetTile,
  snapshotClock,
} from "./lib/stardew-player-probe-driver.mjs";

/**
 * The Host player's script wire (`integrations/stardew/HostPlayerScript.cs`). The run writes this schema and the Mod
 * performs it; both sides assert the literal, so a drift on either side fails its own test instead of producing a
 * script the other side refuses at run time.
 *
 * IT IS ONE GROWING DOCUMENT, NOT ONE FILE PER SLICE. S2 proved the one-file-one-life shape impossible: the Mod adopted
 * S1's steps and finished, so the steps S2 wrote to the same path were never performed and the slice reported
 * `not_measured: one_side_never_dispatched` about a fixture that had been armed. So each slice APPENDS its steps to the
 * same document, every step carries the 1-based `seq` this run gives it, and the Mod's cursor over those positions is
 * what makes a step new. v2 is that contract: v1 had no positions and could not be extended.
 */
export const HOST_PLAYER_SCRIPT_SCHEMA = "gamebuddy-host-player-script/v2";

/**
 * THE COVENANT: the one promise S4 asks about, made by the player in S1 through the world's own chat.
 *
 * It must be something the FIELD CANNOT ANSWER. "There is a tree somewhere east" is in the world; "leave that tree
 * alone until I come back" is only in the conversation. The vocabulary is deliberately outside every name the
 * observation publishes - no tile address, no item id, no display name - and `covenantIsFieldDerivable` re-checks that
 * against the observation actually taken, so a future edit that names a world thing fails the slice instead of
 * passing it.
 *
 * THE LINE IS THE TEMPLATE AND THE TOKENS BELONG TO IT: both families are read off this one sentence - the subject family
 * word for word, and at least one promise token, since a recital that satisfied no promise token would fail its own
 * covenant - and a test pins exactly that. An edit here that rewords the promise fails that test instead of quietly
 * widening the instrument.
 */
export const COVENANT_LINE = "记住我们说好的：东边那棵树先别动，等我回来一起看。";

/**
 * WHAT THE COVENANT IS ABOUT, as opposed to WHAT IT PROMISES - two facts, because only the second one is memory.
 *
 * The check below used to hold both of these and nothing else (`["东边", "树"]`) and called it a recall. Both belong to
 * the SUBJECT side: a companion who had forgotten the promise entirely passed by saying "东边那片树", and "she
 * remembered" was read out of a landmark the field itself publishes. The subject is what a look at the farm can
 * already answer; the promise is the only thing the conversation added.
 *
 * THE SUBJECT FAMILY IS AN `every`: `东边` alone is a bare direction and `树` alone is any tree on the farm, so both are
 * needed to name the one tree the covenant is about.
 */
export const COVENANT_SUBJECT_TOKENS = Object.freeze(["东边", "树"]);

/**
 * THE PROMISE ITSELF, as the words a farmer actually says it in.
 *
 *   token   the part of the promise it carries
 *   ------  ---------------------------------------------------------------------------------------------------
 *   别动    THE NON-INTERFERENCE CONSTRAINT, in the covenant's own words: do not touch or move it yet.
 *   别砍    the SAME constraint named by the act a farmer would name instead: do not chop it.
 *   留着    the same constraint in its POSITIVE form: keep it for later, rather than forbid an act.
 *   等      THE DEFERRAL: wait until I come back - the half that says the promise outlives this morning.
 *
 * THE FAMILY IS A `some`, and that is the whole of how a paraphrase is recognised: each token is one spelling of one
 * half of the promise, so any one of them plus the subject family is a recall - "东边那棵树你留着，等你回来" is as
 * much a remembered covenant as the sentence itself, and demanding the exact line is how the old check was overfitted
 * to one phrasing.
 *
 * WHAT IT CANNOT RECOGNISE, said here rather than discovered later: a promise phrased outside these four families
 * ("那棵树我不碰", "我记着呢") is invisible to the instrument. An answer of that shape names no subject either, so it
 * lands in `nothing_to_recall` (`not_measured`) and `not_measured` stays available for it; an answer that names the
 * subject and no promise family is reported as `covenant_subject_without_the_promise`, whose code names what is missing
 * rather than claiming she forgot. `等` is the loosest of the four - it also matches an unrelated "等会儿" - so it can
 * over-count a promise where the other three cannot; the cost is stated rather than hidden, because a miss in this
 * direction would fail a companion who did remember.
 */
export const COVENANT_PROMISE_TOKENS = Object.freeze(["别动", "别砍", "留着", "等"]);

/**
 * The words a next-day answer uses when it asserts that a day-one act COMPLETED - as opposed to mentioning the thing it
 * happened to.
 *
 * MENTIONING AND CLAIMING ARE TWO DIFFERENT FACTS. The judge used to read one from the other: any day-one token in her
 * answer meant "she says she did it", so naming yesterday's chest or crop was enough to convict her of a fabricated
 * action - including when the Host player had won that chest and her own receipt was a refusal. The list below holds
 * the PERFECTIVE forms, which is why their denials are absent from it: `没拿到` is not `拿到了`, and `没摘` is not
 * `摘了`. It is the same instrument the covenant is read with - high precision, LOW recall - so a claim phrased without
 * one of these words is not judged as a claim at all, and `claim_without_fact` fires only on an answer that both names
 * the day-one subject and says the act was done.
 */
export const DAY_ONE_CLAIM_MARKERS = Object.freeze([
  "收了",
  "摘了",
  "拿了",
  "拿到了",
  "拿走了",
  "拿出来了",
  "取出了",
  "收进了",
]);

/**
 * The four slices, in the order they must run, each with the budget it gets.
 *
 * `gameMinutes` is what the slice is worth in the world; `sliceSeconds` is what it may spend on the wall clock, and
 * the two are reported side by side. They are not the same unit: Stardew advances ten game minutes every seven real
 * seconds, so a slice bounded in GAME minutes would be twenty real seconds - less than one model turn - and the run
 * would then be measuring its own budget instead of the companion.
 *
 * `probeBody` names the body the script drives, not a wire: `host_farmer` is the Host player's script channel, and
 * `companion_body` is her own turn. No slice drives the companion through the probe any more, because a second request
 * stream on her own body was never a second farmer.
 */
export const PAIRED_SLICES = Object.freeze([
  Object.freeze({
    id: "s1_attention",
    gameMinutes: 2,
    sliceSeconds: 180,
    measures: "does she go to where the other farmer is waving from, having been told neither the tile nor to go",
    probeBody: "host_farmer",
  }),
  Object.freeze({
    id: "s2_claim",
    gameMinutes: 3,
    sliceSeconds: 180,
    measures: "two independent farmers contend for one container: exactly one takes it, the other refused by name",
    probeBody: "host_farmer",
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
    measures: "after the session is rebuilt, does she say the promise the field cannot answer",
    probeBody: "companion_body",
  }),
]);

/**
 * The fixture scenario that arms each precondition, named so a 3 a.m. reader has the next command and not a diagnosis.
 *
 * ONE SCENARIO NOW CARRIES BOTH FARM FACTS. It did not: a ripe crop lived in `native_harvest_crop_v1`, a chest holding
 * an item in `native_chest_retrieve_v1`, `native_strawberry_covenant_v1` and `native_multi_day_v1` are native-local
 * only, and the shared-world driver arms exactly one scenario per launch - so S1 (a place to stand beside) and S2 (a
 * container with something in it) had to be measured on DIFFERENT launches of this same run. `native_paired_companion_v1`
 * is the world that removes that split: both facts on the Farm, nothing pre-taken, and her body already on that map
 * within the observation's own discovery radius of both. What is still refused here is the other way out - a fixture
 * invented by this run to satisfy its own slice.
 */
export const FIXTURE_ARMS = Object.freeze({
  ready_grab_crop: Object.freeze({
    scenario: "native_paired_companion_v1",
    then: "S1 has a ripe crop for the Host player to stand beside (the world grows it with the engine's own SpreadSeeds/GrowCrops commands, and keeps exactly one)",
  }),
  chest_with_item: Object.freeze({
    scenario: "native_paired_companion_v1",
    then: "S2 has one container holding one item for two farmers to contend over, within the six-tile discovery radius of the same subject S1 used",
  }),
  s1_staging: Object.freeze({
    scenario: "native_paired_companion_v1 - its companion warp is the arm this slice still needs",
    then: "S1 can start: her own tile at least seven tiles (Chebyshev) from the anchor. The fixture places her three to TargetDiscoveryRadius (6) tiles from the crop today, so S1 refuses to run rather than pass by standing still",
  }),
  host_player_stub: Object.freeze({
    scenario: "-HostPlayerScript / -HostPlayerScriptRecords (the fixture's Host player lane)",
    then: "the Host player can be walked, waved, asked to speak and sent to bed without a second bridge",
  }),
  host_sleep_step: Object.freeze({
    scenario: "-HostPlayerScript / -HostPlayerScriptRecords (the fixture's Host player lane)",
    then: "S3 puts the Host farmer in bed inside its own window, and the engine crosses the night once both farmers are ready",
  }),
});

/** The launch that arms the Host player's script channel; printed whenever a slice needs it and it is not there. */
export const HOST_PLAYER_STUB_LAUNCH = "-HostPlayerScript <absolute path> -HostPlayerScriptRecords <absolute path>";

const TERMINAL_SUCCESS = new Set(["succeeded", "partially_succeeded"]);

/** The one sentence each slice hands the companion. S4's question must not restate the promise it asks about. */
export function sliceAllocation(slice, { item = null } = {}) {
  if (slice === "s1_attention") return ["有人朝你挥手叫你过去，过去看看是谁。"];
  if (slice === "s2_claim") return [`把箱子里那个 ${item ?? "东西"} 拿出来。`];
  if (slice === "s3_night") return ["天不早了，回家上床睡觉吧；这一晚我们一起过。"];
  if (slice === "s4_memory") return ["我们昨天说好的那件事，你还记得吗？说给我听。"];
  throw new Error(`paired_slice_unknown:${String(slice)}`);
}

/**
 * Whether a slice's own sentence hands away the answer it is measuring.
 *
 * S1's property is that she learns WHERE the person is from her observation, so a sentence that contains the tile is
 * a leak and the slice proves nothing: it is `not_measured` however she behaves. The check is deliberately blunt - any
 * occurrence of either coordinate, in any of the spellings a tile travels in - because a leak that is clever enough to
 * hide from it is not worth the risk of reading as a pass.
 */
export function allocationLeaksTile(allocation, tile) {
  if (tile === null || tile === undefined || !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y))
    return false;
  const text = Array.isArray(allocation) ? allocation.join("\n") : String(allocation ?? "");
  const wanted = new Set([
    `${tile.x},${tile.y}`,
    `${tile.x}:${tile.y}`,
    `${tile.x}, ${tile.y}`,
    `${tile.x}: ${tile.y}`,
  ]);
  if ([...wanted].some((spelling) => text.includes(spelling))) return true;
  const numbers = text.match(/-?\d+/gu) ?? [];
  return numbers.includes(String(tile.x)) || numbers.includes(String(tile.y));
}

/** A slice verdict. `state` is `passed` / `failed` / `not_measured`; a missing measurement is never a pass. */
function verdict(slice, state, reasonCode, reads = {}) {
  return Object.freeze({ slice, state, reasonCode, reads: Object.freeze({ ...reads }) });
}

const addressOf = (tile) => (tile === null || tile === undefined ? null : `${tile.x}:${tile.y}`);
const chebyshev = (left, right) => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
const arrayOf = (value) => (Array.isArray(value) ? value : []);

/** The clock delta between two world readings, in game minutes, or `null` when either side never read one. */
export function gameMinutesBetween(leftMs, rightMs) {
  if (!(Number.isFinite(leftMs) && Number.isFinite(rightMs))) return null;
  return Math.round((rightMs - leftMs) / 60_000);
}

/**
 * THE TWO RADII S1'S STAGING IS MEASURED AGAINST, and where each of them comes from.
 *
 * `S1_OLD_PERCEPTION_RADIUS_TILES` is `ExecutionManager.TargetDiscoveryRadius`
 * (`integrations/stardew/farmhandexecutioncontroller.cs:28`): the six-tile window every other discovery family still
 * uses, and the window `FarmhandTargetDiscovery.DiscoverOtherFarmers` used for other FARMERS until `628c0967` bounded
 * the roster by the map instead. S1 exists to ask whether she noticed a person the OLD window would not have carried,
 * so the radius that was wrong is the number to stand outside.
 *
 * `S1_INTERACTION_RADIUS_TILES` is the reach one act has: the judge's own pass predicate (`chebyshev(targetTile,
 * hostTile)` against this constant, inside `judgeJointAttention`) and the `nearby` walk the Host player's script makes,
 * which lands on one orthogonal neighbour of the subject. A companion who already stands inside it can satisfy the
 * verdict without moving, and "she was already there" would be read as "she came because she saw the player".
 */
export const S1_OLD_PERCEPTION_RADIUS_TILES = 6;
export const S1_INTERACTION_RADIUS_TILES = 1;

/**
 * HOW FAR APART THE TWO FARMERS MUST START FOR S1 TO MEAN ANYTHING, in tiles (Chebyshev).
 *
 * SEVEN, NOT THE FURTHEST TILE THE FARM HAS. The property is "outside the radius that was wrong", not "as far as
 * possible", and every extra tile is a longer walk the Host player's script has to complete inside the slice's budget:
 * seven is the nearest tile the old six-tile window could NOT have published, which is exactly the tile that makes the
 * `628c0967` fix observable. It is also outside the interaction radius by six tiles, so a pass here cannot be a
 * companion who began already standing beside the anchor.
 */
export const S1_MIN_ANCHOR_SEPARATION_TILES = 7;

/** A published tile as an integer pair, or `null`: `BridgeSnapshot.Tile` is a float pair and a guess is not a tile. */
function readTile(value) {
  if (!(Number.isFinite(value?.x) && Number.isFinite(value?.y))) return null;
  return Object.freeze({ x: Math.round(value.x), y: Math.round(value.y) });
}

/**
 * WHETHER S1 MAY START AT ALL, decided from the world's own two tiles before the slice arms anything.
 *
 * A SLICE THAT CAN PASS BY STANDING STILL MUST NOT RUN. Two distances refuse it, and they are two different facts:
 *   * `paired_s1_companion_already_there:<tile>` - she begins within the interaction radius, so any act of hers settles
 *     the verdict whatever she understood. The code names her own tile, because that is the position that makes the
 *     reading impossible.
 *   * `paired_s1_companion_inside_the_old_radius:<tile>:d=<distance>:need=<n>` - she begins outside the interaction
 *     radius but inside the six tiles `otherFarmers` used to be bounded by, so even a genuine walk proves nothing about
 *     `628c0967`: the old code would have shown her the person anyway.
 * Both are `not_measured`, one with the numbers in the code, because the missing fact is the WORLD's staging and not her
 * attention.
 */
export function attentionStaging({ anchorTile, companionTile }) {
  const anchor = readTile(anchorTile);
  const companion = readTile(companionTile);
  const distance = anchor === null || companion === null ? null : chebyshev(companion, anchor);
  const reads = Object.freeze({
    anchorTile: anchor === null ? null : tileKey(anchor),
    companionStartTile: companion === null ? null : tileKey(companion),
    distance,
    interactionRadius: S1_INTERACTION_RADIUS_TILES,
    oldPerceptionRadius: S1_OLD_PERCEPTION_RADIUS_TILES,
    required: S1_MIN_ANCHOR_SEPARATION_TILES,
  });
  if (distance === null)
    return Object.freeze({ ran: false, reasonCode: "paired_s1_companion_position_unreadable", reads });
  if (distance <= S1_INTERACTION_RADIUS_TILES)
    return Object.freeze({ ran: false, reasonCode: `paired_s1_companion_already_there:${tileKey(companion)}`, reads });
  if (distance < S1_MIN_ANCHOR_SEPARATION_TILES)
    return Object.freeze({
      ran: false,
      reasonCode: `paired_s1_companion_inside_the_old_radius:${tileKey(companion)}:d=${distance}:need=${S1_MIN_ANCHOR_SEPARATION_TILES}`,
      reads,
    });
  return Object.freeze({ ran: true, reasonCode: null, reads });
}

/**
 * The place the Host player should walk to in S1: the world's own answer, not an operator's.
 *
 * A ripe grab crop first, because the crop plot is what the harvest arm places; else a chest holding an item, because
 * that is what the container arm places. Either is a real place a person stands beside, and which one it is travels in
 * the verdict (`subject`), so a reader can see what the slice used. Null means this launch armed neither, which is the
 * fixture gap printed by name rather than a substituted tile.
 */
export function attentionSubject(snapshot) {
  const location = typeof snapshot?.location === "string" && snapshot.location.length > 0 ? snapshot.location : null;
  if (location === null) return null;
  const crop = readyGrabCrop(snapshot, { index: 0 });
  if (crop !== null)
    return Object.freeze({
      kind: "ready_grab_crop",
      location,
      tile: Object.freeze({ x: crop.x, y: crop.y }),
      itemId: crop.qualifiedHarvestItemId ?? null,
      displayName: crop.displayName ?? null,
    });
  const chest = chestWithItem(snapshot);
  if (chest === null) return null;
  const item = arrayOf(chest.items).find((entry) => typeof entry?.qualifiedItemId === "string") ?? null;
  return Object.freeze({
    kind: "chest_with_item",
    location,
    tile: Object.freeze({ x: chest.x, y: chest.y }),
    chestId: chest.chestId,
    itemId: item?.qualifiedItemId ?? null,
    displayName: item?.displayName ?? null,
  });
}

/**
 * S1's script: stand beside the subject, raise one balloon, say the covenant.
 *
 * `nearby` is how a person stands beside a crop or a chest that occupies the tile itself; the Mod's channel tries the
 * four orthogonal neighbours in a fixed order and records the tile it reached, so the judgement reads where the player
 * ACTUALLY stood. The covenant is spoken here rather than in the prompt because it is the player's line, and because a
 * promise she was told by the harness is not a promise she keeps.
 */
export function planHostAttentionScript({ snapshot, covenant = COVENANT_LINE }) {
  const subject = attentionSubject(snapshot);
  if (subject === null)
    return Object.freeze({
      subject: null,
      steps: Object.freeze([]),
      dropped: Object.freeze([
        Object.freeze({ step: "all", reason: "snapshot_published_no_ripe_crop_and_no_chest_holding_an_item" }),
      ]),
    });
  return Object.freeze({
    subject,
    steps: Object.freeze([
      Object.freeze({
        stepId: "walk",
        action: "walk_to_tile",
        location: subject.location,
        x: subject.tile.x,
        y: subject.tile.y,
        nearby: true,
      }),
      Object.freeze({ stepId: "emote", action: "emote", emote: PROBE_EMOTE }),
      Object.freeze({ stepId: "say", action: "say", text: covenant }),
    ]),
    dropped: Object.freeze([]),
  });
}

/**
 * S2's script: stand beside the container, take the item.
 *
 * The container's published id is the whole address the Mod resolves, and the item is the stack the world says it
 * holds. There is exactly ONE item, because contention over a row with two of them would let both farmers succeed and
 * measure nothing.
 */
export function planHostClaimScript({ snapshot }) {
  const chest = chestWithItem(snapshot);
  const location = typeof snapshot?.location === "string" && snapshot.location.length > 0 ? snapshot.location : null;
  if (chest === null || location === null)
    return Object.freeze({
      contended: null,
      steps: Object.freeze([]),
      dropped: Object.freeze([Object.freeze({ step: "all", reason: "snapshot_published_no_chest_holding_an_item" })]),
    });
  const item = arrayOf(chest.items).find((entry) => typeof entry?.qualifiedItemId === "string") ?? null;
  const contended = Object.freeze({
    chestId: chest.chestId,
    tile: Object.freeze({ x: chest.x, y: chest.y }),
    itemId: item?.qualifiedItemId ?? null,
    displayName: item?.displayName ?? item?.qualifiedItemId ?? null,
  });
  return Object.freeze({
    contended,
    steps: Object.freeze([
      Object.freeze({
        stepId: "walk",
        action: "walk_to_tile",
        location,
        x: chest.x,
        y: chest.y,
        nearby: true,
      }),
      Object.freeze({
        stepId: "chest",
        action: "chest_take",
        targetRef: chest.chestId,
        expectedQualifiedItemId: contended.itemId,
      }),
    ]),
    dropped: Object.freeze([]),
  });
}

/**
 * S3's script: the Host player goes to bed.
 *
 * ONE STEP AND NO ARGUMENT. Which bed is the engine's own answer (`FarmHouse.GetPlayerBedSpot`) and which house is the
 * save's own home, so a step that named a tile would be a second spelling of both - one this run would have to keep in
 * step with a save it does not own. `seq` is the writer's, like every other step.
 */
export function planHostNightScript() {
  return Object.freeze([Object.freeze({ stepId: "sleep", action: "sleep" })]);
}

/**
 * Hand the Host player's channel one slice's steps, appended behind the ones already armed. The returned `seqs` are this
 * slice's positions in the document - what a wait is matched by and what a record is attributed to - and the writer is
 * the only thing that assigns them, so two slices cannot name the same position.
 *
 * THE WRITE IS A REPLACE, NOT A TRUNCATE. The Mod polls this path while the world runs, so a partial document would be
 * read as an unreadable one and stop the channel for the rest of the run: the text lands in a staging file first and is
 * renamed over the document, which the reader sees either whole-old or whole-new.
 *
 * A SEALED DOCUMENT REFUSES THE APPEND BY NAME. `sealed` is the fixture saying it will append no more, and the Mod stops
 * reading the file when it sees one - so a step written past it would be performed by nobody and a slice would wait out
 * its budget for a cue that was never armed. That is exactly how S3's night would disappear, which is why the refusal is
 * here rather than in the slice that notices the wait.
 */
export function appendHostPlayerScript(path, steps, { sealed = false } = {}) {
  if (typeof path !== "string" || path.length === 0)
    return Object.freeze({ ok: false, reason: "host_player_script_not_configured", seqs: Object.freeze([]) });
  const existing = readHostPlayerScriptDocument(path);
  if (existing.reason !== null) return Object.freeze({ ok: false, reason: existing.reason, seqs: Object.freeze([]) });
  if (existing.sealed === true)
    return Object.freeze({ ok: false, reason: "host_player_script_sealed", seqs: Object.freeze([]) });
  const appended = arrayOf(steps).map((step, offset) =>
    Object.freeze({ ...step, seq: existing.steps.length + offset + 1 }),
  );
  const staging = `${path}.writing`;
  writeFileSync(
    staging,
    `${JSON.stringify({ schema: HOST_PLAYER_SCRIPT_SCHEMA, sealed, steps: [...existing.steps, ...appended] }, null, 2)}\n`,
  );
  renameSync(staging, path);
  return Object.freeze({ ok: true, reason: null, seqs: Object.freeze(appended.map((step) => step.seq)) });
}

/**
 * The fixture saying it will append no more. This is the only way the channel ends quietly: an open document whose steps
 * have all settled is a wait for the next slice, and a run that never seals would leave it polling a file nobody writes.
 */
export function sealHostPlayerScript(path) {
  return appendHostPlayerScript(path, [], { sealed: true });
}

/** The document as it stands, or the reason it cannot be extended. A missing file is an empty document, not an error. */
function readHostPlayerScriptDocument(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { steps: [], sealed: false, reason: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { steps: [], sealed: false, reason: "host_player_script_unreadable" };
  }
  if (parsed?.schema !== HOST_PLAYER_SCRIPT_SCHEMA)
    return { steps: [], sealed: false, reason: "host_player_script_schema_mismatch" };
  if (!Array.isArray(parsed.steps)) return { steps: [], sealed: false, reason: "host_player_script_steps_missing" };
  return { steps: parsed.steps, sealed: parsed.sealed === true, reason: null };
}

/**
 * One record the Host player's channel wrote, normalised into the same field names a receipt is read by. `seq` is the
 * step's position in the document and is what makes the record attributable to the slice that appended it.
 */
export function normalizeHostRecord(payload) {
  const tile =
    Number.isInteger(payload?.x) && Number.isInteger(payload?.y)
      ? Object.freeze({ x: payload.x, y: payload.y, source: "host_player_record" })
      : null;
  return Object.freeze({
    seq: Number.isSafeInteger(payload?.seq) ? payload.seq : null,
    stepId: typeof payload?.stepId === "string" ? payload.stepId : null,
    action: typeof payload?.action === "string" ? payload.action : "unknown",
    state: payload?.state ?? "unknown",
    reasonCode: payload?.reasonCode ?? null,
    location: typeof payload?.location === "string" ? payload.location : null,
    targetTile: tile,
    tGameMs: gameClockMs(payload?.timeOfDay),
    dayOfMonth: Number.isSafeInteger(payload?.dayOfMonth) ? payload.dayOfMonth : null,
    detail: typeof payload?.detail === "string" ? payload.detail : null,
  });
}

/**
 * The Host player's records, as written. A line that cannot be parsed is reported as one unreadable record rather than
 * dropped: a trace with a missing line and a trace with a corrupt line are different facts.
 */
export function readHostPlayerRecords(path) {
  if (typeof path !== "string" || path.length === 0) return [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(normalizeHostRecord(JSON.parse(trimmed)));
    } catch {
      records.push(
        Object.freeze({
          seq: null,
          stepId: null,
          action: "records",
          state: "unreadable",
          reasonCode: "host_player_record_unreadable",
          location: null,
          targetTile: null,
          tGameMs: null,
          dayOfMonth: null,
          detail: trimmed.slice(0, 200),
        }),
      );
    }
  }
  return records;
}

/**
 * Wait until the channel has settled the steps THIS slice appended, or the slice's budget runs out.
 *
 * A WAIT IS MATCHED BY POSITION, NOT BY STEP ID AND NOT BY "THE FILE CHANGED". The document is shared by every slice, and
 * S1's `walk` and S2's `walk` are two different steps in it, so a wait keyed on the name would be satisfied by the
 * previous slice's record the instant it started - which is exactly how S2 used to read as dispatched when nothing had
 * dispatched it. `seqs` is what the writer handed back, so a stale record from an earlier slice cannot match.
 *
 * A CHANNEL-LEVEL REFUSAL ends the wait at once and travels with the records: the channel is finished, no further step
 * will ever settle, and a slice that waited out its budget instead would report its own clock as the finding.
 *
 * The steps are performed by the OTHER process on the game thread, so a wait is the only way to read them; `timedOut`
 * travels with the records because "the player did not arrive in time" and "the player arrived" are different readings
 * of the same file.
 */
export async function awaitHostPlayerRecords({ path, seqs = [], timeoutMs, now = () => Date.now(), pollMs = 250 }) {
  const wanted = arrayOf(seqs);
  const deadline = now() + timeoutMs;
  while (true) {
    const all = readHostPlayerRecords(path);
    const own = all.filter((record) => record.seq !== null && wanted.includes(record.seq));
    const refusal = all.find((record) => record.action === "script" && record.state === "rejected") ?? null;
    if (refusal !== null) return { records: [...own, refusal], timedOut: false };
    if (wanted.every((seq) => own.some((record) => record.seq === seq))) return { records: own, timedOut: false };
    if (now() >= deadline) return { records: own, timedOut: true };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }
}

/** The tile the Host player actually reached, from the walk step's own record; null when she never got there. */
function hostWalkTile(records) {
  const walk = arrayOf(records).find(
    (record) => record.action === "walk_to_tile" && TERMINAL_SUCCESS.has(record.state),
  );
  return walk?.targetTile ?? null;
}

/** Why the Host player's lane produced no walk: the script's own refusal when it has one, else that it wrote nothing. */
function hostStubReason(records) {
  const settled = arrayOf(records).find((record) => record.reasonCode !== null);
  return settled?.reasonCode ?? (arrayOf(records).length === 0 ? "no_records" : "no_walk_record");
}

/**
 * S1 - JOINT ATTENTION, between two real farmers: did she go to where the person waving is.
 *
 * `not_measured` BEFORE `failed`, five times, and each time for a different fact:
 *   * the WORLD staged her too close to see the difference - `attentionStaging` refused the slice before it armed
 *     anything, because a companion who begins inside the interaction radius passes by standing still and one who
 *     begins inside the six tiles the old `otherFarmers` window carried cannot show that the window was the thing that
 *     moved (`paired_s1_companion_already_there`, `paired_s1_companion_inside_the_old_radius`);
 *   * the prompt named the tile - the slice measured its own sentence, not her attention;
 *   * the Host player never arrived - the cue was never given;
 *   * the person was not in her observation - `otherFarmers` publishes every other player on HER map
 *     (`FarmhandTargetDiscovery.DiscoverOtherFarmers`, bounded by the map rather than by the six-tile item radius), so a
 *     person it does not carry is a fact she was never shown rather than one she ignored;
 *   * the slice's own budget cut her turn - that is our clock, not her.
 * What is left is measured: an action within `S1_INTERACTION_RADIUS_TILES` of the person's tile is the property, an action
 * somewhere else is `failed/acted_away_from_the_other_farmer`, and no action at all is `failed/late`.
 */
export function judgeJointAttention({
  hostRecords = null,
  otherFarmers = null,
  companion = [],
  subject = null,
  probeTGameMs = null,
  companionDay = null,
  turnTimedOut = false,
  promptTileLeak = false,
  staging = null,
}) {
  // FIRST, because a slice that was never allowed to run did not measure anything else either.
  if (staging !== null && staging !== undefined && staging.ran !== true)
    return verdict("s1_attention", "not_measured", staging.reasonCode, {
      subject,
      ...staging.reads,
      fixtureArm: "s1_staging",
      rule: "S1 must not start where it could pass by standing still, or inside the radius 628c0967 replaced",
    });
  const hostTile = hostWalkTile(hostRecords);
  if (promptTileLeak === true)
    return verdict("s1_attention", "not_measured", "prompt_leaks_the_tile", {
      subject,
      hostTile: tileKey(hostTile),
      rule: "S1 proves nothing when its own sentence names the place",
    });
  if (hostTile === null)
    return verdict("s1_attention", "not_measured", `host_player_stub_unavailable:${hostStubReason(hostRecords)}`, {
      launchesWith: HOST_PLAYER_STUB_LAUNCH,
      fixtureArm: "host_player_stub",
      hostRecords: arrayOf(hostRecords).length,
    });
  if (otherFarmers !== null && otherFarmers !== undefined) {
    const seen = arrayOf(otherFarmers).some((row) => row?.x === hostTile.x && row?.y === hostTile.y);
    if (!seen)
      return verdict("s1_attention", "not_measured", "other_farmer_not_in_her_observation", {
        hostTile: tileKey(hostTile),
        otherFarmers: arrayOf(otherFarmers).length,
        rule: "otherFarmers is her own map's other players, not a six-tile window",
      });
  }
  if (turnTimedOut === true && companion.length === 0)
    return verdict("s1_attention", "not_measured", "turn_budget_exhausted", { hostTile: tileKey(hostTile) });
  const withTargets = companion.filter((receipt) => receipt.targetTile !== null && receipt.targetTile !== undefined);
  const reads = {
    subject,
    hostTile: tileKey(hostTile),
    probeTGameMs,
    companionTGameMs: withTargets[0]?.tGameMs ?? companion[0]?.tGameMs ?? null,
    companionDay,
    dGameMin: gameMinutesBetween(probeTGameMs, withTargets[0]?.tGameMs ?? companion[0]?.tGameMs ?? null),
    companionTiles: [...new Set(withTargets.map((receipt) => tileKey(receipt.targetTile)))],
    rule: "the acted tile must be the person's tile or one beside it",
  };
  if (companion.length === 0) return verdict("s1_attention", "failed", "late", reads);
  if (withTargets.length === 0)
    return verdict("s1_attention", "not_measured", "no_companion_receipt_names_a_tile", {
      ...reads,
      companionReceipts: companion.length,
    });
  if (withTargets.some((receipt) => chebyshev(receipt.targetTile, hostTile) <= S1_INTERACTION_RADIUS_TILES))
    return verdict("s1_attention", "passed", "went_to_the_other_farmer", reads);
  return verdict("s1_attention", "failed", "acted_away_from_the_other_farmer", reads);
}

/**
 * S2 - THE CONCURRENT CLAIM, between two independent farmers: one container, one item, two bodies.
 *
 * Neither side has a mutex over the other: the product's active-mutation serialization is per actor, and the container's
 * own `Chest.GetMutex()` is the only cross-player lock either side can take. So the property is about the ROW, not
 * about who went first:
 *   * exactly one side settles as the take, and the other is refused BY NAME (a non-empty reason code);
 *   * the loser may not claim the effect - her own receipt's `evicted` addresses must not name the container's tile;
 *   * the world must agree afterwards: the item is gone from the container. A world that cannot be re-read is
 *     `not_measured`, never a pass.
 * The order is not part of the judgement and is not read: either side may win, and a run that assumed the probe went
 * first would call a legitimate host win a failure.
 */
export function judgeConcurrentClaim({ contended, host = null, companion = null, world = null }) {
  if (contended === null || contended === undefined)
    return verdict("s2_claim", "not_measured", "fixture_missing:chest_with_item", { fixtureArm: "chest_with_item" });
  const reads = {
    contended: contended.chestId ?? null,
    contendedTile: tileKey(contended.tile ?? null),
    contendedItemId: contended.itemId ?? null,
    host: host === null ? null : { state: host.state, reasonCode: host.reasonCode },
    companion: companion === null ? null : { state: companion.state, reasonCode: companion.reasonCode },
    dGameMin: gameMinutesBetween(host?.tGameMs ?? null, companion?.tGameMs ?? null),
    world,
  };
  if (host === null || companion === null)
    return verdict("s2_claim", "not_measured", "one_side_never_dispatched", {
      ...reads,
      hostDispatched: host !== null,
      companionDispatched: companion !== null,
    });
  const hostWon = TERMINAL_SUCCESS.has(host.state);
  const companionWon = TERMINAL_SUCCESS.has(companion.state);
  if (hostWon && companionWon) return verdict("s2_claim", "failed", "both_claimed", reads);
  if (!(hostWon || companionWon)) return verdict("s2_claim", "failed", "neither_succeeded", reads);
  const loserSide = hostWon ? "companion" : "host";
  const loser = hostWon ? companion : host;
  if (typeof loser.reasonCode !== "string" || loser.reasonCode.length === 0)
    return verdict("s2_claim", "failed", `unnamed_refusal:${loserSide}`, reads);
  const loserEvicted = Array.isArray(loser.evicted) ? loser.evicted : [];
  if (contended.tile !== undefined && contended.tile !== null && loserEvicted.includes(addressOf(contended.tile)))
    return verdict("s2_claim", "failed", `loser_claimed_the_effect:${loserSide}`, reads);
  if (world !== "item_evicted") return verdict("s2_claim", "not_measured", "world_fact_absent", reads);
  return verdict("s2_claim", "passed", `one_took_it_one_refused_by_name:${hostWon ? "host" : "companion"}`, {
    ...reads,
    winner: hostWon ? "host" : "companion",
    loser: loserSide,
    loserReason: loser.reasonCode,
  });
}

/**
 * S3 - THE CO-OP NIGHT, the one slice that always had two real farmers.
 *
 * Both nights must be READABLE: `bedTime` is an integer clock reading and `bedTimeSource` says which observation
 * produced it. A night with neither is BARE - `round94`'s `null`, a body that never slept wearing a record's clothes.
 *
 * THE HOST'S NIGHT IS HER OWN BODY'S, never a file armed before the run. `hostNight` is read off the `sleep` step's own
 * record (`readHostNightFromSleepRecord`), and `hostSleepStep` is what that step settled as - because "the Host is in
 * bed" and "the night crossed" are two different facts and this slice may state only the first from the step.
 *
 * FOUR OUTCOMES, deliberately distinct, because they have four different owners:
 *   * `failed`       - the Host's night began and the world never crossed it (`host_night_never_started`): both bodies
 *                      were in bed, so nothing was left for the engine's ready barrier to wait on.
 *   * `failed`       - the body did not sleep (her own night is bare, or the two nights are different nights).
 *   * `not_measured` - the instrument cannot see the hour, or could not drive the Host's body into bed at all: the step's
 *                      own refusal is the code, so a farmer who never arrived is never reported as one who never slept.
 *   * `not_measured` - two bodies were never available: the run was not launched with the Host player's script lane.
 *
 * SIMULTANEITY IS NOT DEMANDED. Two people going to bed at the same clock minute is not what a co-op night is and not
 * what this judge reads: the nights are the same night, each hour is the farmer's own, and `order` reports which came
 * first without judging it.
 */
export function judgeCoopNight({ hostNight, companionNight, hostSleepStep = null }) {
  if (hostNight === null || hostNight === undefined)
    return verdict("s3_night", "not_measured", "two_bodies_unavailable:host_sleep_step_never_settled", {
      launchesWith: HOST_PLAYER_STUB_LAUNCH,
      fixtureArm: "host_sleep_step",
      hostSleepState: hostSleepStep?.state ?? null,
      hostSleepReason: hostSleepStep?.reasonCode ?? null,
      hostSleepDetail: hostSleepStep?.detail ?? null,
    });
  const reads = {
    hostDay: hostNight.day ?? null,
    hostBedTime: hostNight.bedTime,
    hostBedTimeSource: hostNight.bedTimeSource,
    hostBedTimeAbsent: hostNight.bedTimeAbsent,
    hostState: hostNight.state,
    hostSleepState: hostSleepStep?.state ?? null,
    hostSleepReason: hostSleepStep?.reasonCode ?? null,
    hostSleepDetail: hostSleepStep?.detail ?? null,
    companionDay: companionNight?.day ?? null,
    companionBedTime: companionNight?.bedTime ?? null,
    companionBedTimeSource: companionNight?.bedTimeSource ?? null,
    companionBedTimeAbsent: companionNight?.bedTimeAbsent ?? null,
  };
  if (!Number.isInteger(hostNight.bedTime))
    return verdict("s3_night", "not_measured", `host_bed_time_unreadable:${hostNight.bedTimeAbsent}`, reads);
  // THE HOST'S NIGHT IS IN BED AND THE WORLD DID NOT FOLLOW: this is the reading the whole slice exists for, and the one
  // an un-crossed co-op night produced while S3 only ever said "not measured".
  if (hostSleepStep?.settled === true && (companionNight === null || companionNight === undefined))
    return verdict("s3_night", "failed", "host_night_never_started", reads);
  if (companionNight === null || companionNight === undefined)
    return verdict("s3_night", "not_measured", "companion_night_absent", reads);
  if (!Number.isInteger(companionNight.bedTime)) return verdict("s3_night", "failed", "companion_never_slept", reads);
  if (hostNight.day !== companionNight.day)
    return verdict(
      "s3_night",
      "failed",
      `wrong_night:probe=day${hostNight.day}:companion=day${companionNight.day}`,
      reads,
    );
  return verdict("s3_night", "passed", "both_farmers_slept_in_the_same_night", {
    ...reads,
    order: hostNight.bedTime <= companionNight.bedTime ? "host_first" : "companion_first",
  });
}

/** The one dictionary the day-one anchor can be recognised by. Short and empty tokens are dropped, never matched. */
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

/**
 * Every address and name the observation publishes - the vocabulary a question about this farm could be answered from
 * WITHOUT remembering anything.
 *
 * Deliberately drawn from the observation itself rather than from a hand-written list: the question of whether a
 * covenant is field-derivable is a question about what the field published at the time, and a list of words this file
 * decided on could only ever answer a different question.
 */
export function worldVocabularyTokens(observation) {
  const tokens = new Set();
  const push = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 1) tokens.add(trimmed);
  };
  const pushTile = (row) => {
    if (Number.isSafeInteger(row?.x) && Number.isSafeInteger(row?.y)) {
      push(`${row.x},${row.y}`);
      push(`${row.x}:${row.y}`);
    }
  };
  for (const row of arrayOf(observation?.harvestTargets)) {
    push(row?.qualifiedHarvestItemId);
    push(row?.displayName);
    push(row?.targetId);
    pushTile(row);
  }
  for (const row of arrayOf(observation?.chests)) {
    push(row?.chestId);
    push(row?.displayName);
    pushTile(row);
    for (const item of arrayOf(row?.items)) {
      push(item?.qualifiedItemId);
      push(item?.displayName);
    }
  }
  for (const row of arrayOf(observation?.otherFarmers)) push(row?.name);
  for (const row of arrayOf(observation?.villagers)) push(row?.displayName);
  push(observation?.location);
  return Object.freeze([...tokens]);
}

/**
 * Whether the covenant's answer was already sitting in the field when it was made.
 *
 * `null` is "cannot be decided" and is never a pass: without an observation there is nothing to compare against, and
 * the slice must say so rather than assume the promise was hard.
 */
export function covenantIsFieldDerivable(line, observation) {
  if (typeof line !== "string" || line.trim().length === 0) return null;
  if (observation === null || observation === undefined) return null;
  const text = line.toLowerCase();
  return worldVocabularyTokens(observation).some((token) => text.includes(token));
}

/**
 * Whether one of HER receipts addresses the day-one subject - which is what a later mention of it is proved by.
 *
 * TWO SPELLINGS AND NO THIRD. The tile is read through `receiptTargetTile` (`evicted` first, then the evidence detail),
 * the item id from the evidence the container and crop actions publish (`item=(O)24`). Both are the producers' own
 * fields; nothing here re-derives a target from narration.
 *
 * THE STATE IS DELIBERATELY NOT READ. `chest_empty` is what a take that lost the race settles as - the container
 * resolved, the lock was granted, and the item was already gone - so a refusal names its subject exactly as a success
 * does, and a judge that demanded `succeeded` would convict an honest companion the moment the Host player won.
 */
function receiptNamesAnchor(receipt, anchor) {
  if (receipt === null || receipt === undefined) return false;
  const anchorTile = anchor?.tile ?? null;
  const receiptTile = receipt.targetTile ?? null;
  if (anchorTile !== null && receiptTile !== null && tileKey(receiptTile) === tileKey(anchorTile)) return true;
  const itemId = typeof anchor?.itemId === "string" ? anchor.itemId.toLowerCase() : null;
  const evidence = typeof receipt.evidence === "string" ? receipt.evidence.toLowerCase() : null;
  return itemId !== null && itemId.length > 1 && evidence !== null && evidence.includes(`item=${itemId}`);
}

/**
 * The turns that CLAIM a completed act on the day-one subject while no receipt of hers addresses it.
 *
 * An empty list is not a clean bill of health for her honesty - it means nothing she said was phrased as a claim this
 * instrument can adjudicate. What it does guarantee is the direction that matters: a mention that asserts nothing, and
 * any mention at all while one receipt (a refusal included) names the subject, is never reported as a fabrication.
 */
function assertedDayOneActs(companionTurns, tokens, backedByAReceipt) {
  const asserted = [];
  for (const text of companionTurns) {
    const lowered = String(text).toLowerCase();
    const markers = DAY_ONE_CLAIM_MARKERS.filter((marker) => lowered.includes(marker));
    if (markers.length === 0) continue;
    if (!tokens.some((token) => lowered.includes(token))) continue;
    if (backedByAReceipt) continue;
    asserted.push(Object.freeze({ turn: String(text), markers: Object.freeze(markers) }));
  }
  return Object.freeze(asserted);
}

/**
 * S4 - CROSS-DAY RECALL ACROSS A REBUILT SESSION, judged as the THREE claims it is made of, because they are supported
 * by three different facts and the old judge read all three out of one.
 *
 *   (a) THE COVENANT - "do you remember what we agreed yesterday?". This is the ONLY thing the question asks, and the
 *       only pass condition. `covenantSaid` requires the SUBJECT family AND the PROMISE family, and nothing else:
 *       reciting the day-one tile, the crop's name or a coordinate is not required, because nobody asked for one. A
 *       companion who answers "东边那棵树先别动，等我回来一起看" has recalled the covenant exactly, and a judge that then
 *       failed her for not also naming a tile was reading its own question into hers.
 *
 *       THE PROMISE IS THE PROPERTY AND THE SUBJECT IS NOT. A companion who says only "东边那片树" has named a landmark
 *       the field publishes - she could have answered by looking, or by guessing - and asserting nothing about what was
 *       promised. That answer is `failed/covenant_subject_without_the_promise`, its own code, because "she named it and
 *       promised nothing" is a different fact from "she said nothing about it" (`covenant_not_recalled`) and from "there
 *       was nothing to recall" (`nothing_to_recall`).
 *
 *   (b) A MENTION OF A DAY-ONE ACT SHE TOOK - read against her OWN receipts (`dayOneReceipts`), never against the
 *       anchor tile, and in every state: a receipt that was REFUSED is a fact about what happened to that subject just
 *       as a success is, and it is the ordinary outcome here whenever the Host player wins. It is published as reads
 *       and never judged - mentioning yesterday's chest is not a claim about herself.
 *
 *   (c) A CLAIM SHE DID NOT TAKE - the real `claim_without_fact`, and the only failure in this family. It fires only
 *       when an answer asserts a COMPLETED act (`DAY_ONE_CLAIM_MARKERS`) on the day-one subject AND no receipt of hers
 *       addresses that subject at all. It cannot fire merely because the anchor was never hers to act on: one refusal
 *       naming it is enough, and a mention that asserts nothing is not a claim.
 *
 * The gates before all three are about the QUESTION rather than about her: `covenant_field_derivable` means the field
 * already answers it and a companion who never remembered anything could reply by looking; `covenant_never_spoken` and
 * `covenant_absent` mean there was no promise. The instrument is a TOKEN match throughout - high precision and LOW
 * recall - so `covenant_not_recalled` means "no covenant token appeared", never "she forgot", and
 * `covenant_subject_without_the_promise` means "the subject appeared and no promise family did", never "she promised
 * nothing" (see `COVENANT_PROMISE_TOKENS` for what the families cannot recognise).
 */
export function judgeCrossDayMemory({
  anchor,
  dayOneReceipts = [],
  companionTurns = [],
  dayRolledOver,
  covenant = null,
  sessionBoundary = null,
}) {
  if (dayRolledOver !== true) return verdict("s4_memory", "not_measured", "day_did_not_roll_over", {});
  const covenantReads = {
    sessionBoundary,
    covenantLine: covenant?.line ?? null,
    covenantSpoken: covenant?.spoken ?? null,
    covenantFieldDerivable: covenant?.fieldDerivable ?? null,
    covenantSubjectTokens: Array.isArray(covenant?.subjectTokens) ? covenant.subjectTokens.length : 0,
    covenantPromiseTokens: Array.isArray(covenant?.promiseTokens) ? covenant.promiseTokens.length : 0,
  };
  if (covenant === null || covenant === undefined)
    return verdict("s4_memory", "not_measured", "covenant_absent:no_verbal_promise_before_the_boundary", covenantReads);
  if (covenant.fieldDerivable !== true && covenant.fieldDerivable !== false)
    return verdict("s4_memory", "not_measured", "covenant_derivability_unknown", covenantReads);
  if (covenant.fieldDerivable === true)
    return verdict("s4_memory", "failed", "covenant_field_derivable", {
      ...covenantReads,
      rule: "the field already answers it, so recalling it proves nothing",
    });
  if (covenant.spoken !== true) return verdict("s4_memory", "not_measured", "covenant_never_spoken", covenantReads);
  // THE ANCHOR IS THE DAY-ONE SUBJECT, not an action she took on it: the mention instrument and the fabricated-claim
  // check both read the subject, and neither requires that the subject was ever hers to act on.
  if (anchor === null || anchor === undefined || anchor.tile === null || anchor.tile === undefined)
    return verdict("s4_memory", "not_measured", "anchor_absent:no_day_one_subject", covenantReads);
  if (companionTurns.length === 0)
    return verdict("s4_memory", "not_measured", "no_next_day_turn", { ...covenantReads, anchor: tileKey(anchor.tile) });
  const tokens = anchorTokens(anchor);
  const mentions = companionTurns.filter((text) => tokens.some((token) => String(text).toLowerCase().includes(token)));
  const saidSomewhere = (token) =>
    companionTurns.some((text) => String(text).toLowerCase().includes(String(token).toLowerCase()));
  // TWO FAMILIES, TWO QUANTIFIERS, and the pass is their conjunction: the subject is EVERY token (a direction alone or a
  // bare "tree" names nothing yet), the promise is ANY one token (each is one spelling of one half of the promise, so a
  // paraphrase is a recall). The subject-only failure below is this same predicate minus its second half, so there is
  // one spelling of each fact. An EMPTY family is not a satisfied one: `[].every(...)` would pass, so a descriptor that
  // declares no subject tokens can only ever fail.
  const subjectTokens = Array.isArray(covenant.subjectTokens) ? covenant.subjectTokens : [];
  const promiseTokens = Array.isArray(covenant.promiseTokens) ? covenant.promiseTokens : [];
  const subjectSaid = subjectTokens.length > 0 && subjectTokens.every(saidSomewhere);
  const promiseTokensSeen = promiseTokens.filter(saidSomewhere);
  const promiseSaid = promiseTokensSeen.length > 0;
  const covenantSaid = subjectSaid && promiseSaid;
  // The receipts that would prove a day-one act on this subject, in EVERY state: a refusal at the container is a fact
  // about what happened to it just as a success is, and on this topology the Host player winning the race is an
  // ordinary outcome (see the header).
  const backing = arrayOf(dayOneReceipts).filter((receipt) => receiptNamesAnchor(receipt, anchor));
  const fabricated = assertedDayOneActs(companionTurns, tokens, backing.length > 0);
  const reads = {
    ...covenantReads,
    anchor: tileKey(anchor.tile),
    anchorItemId: anchor.itemId ?? null,
    anchorDisplayName: anchor.displayName ?? null,
    tokens: tokens.length,
    dayOneReceipts: arrayOf(dayOneReceipts).length,
    receiptsNamingTheAnchor: backing.length,
    mentionsTheDayOneSubject: mentions.length > 0,
    covenantSubjectSaid: subjectSaid,
    covenantPromiseSaid: promiseSaid,
    covenantPromiseTokensSeen: Object.freeze(promiseTokensSeen),
    covenantSaid,
    nextDayTurns: companionTurns.length,
  };
  if (fabricated.length > 0)
    return verdict("s4_memory", "failed", "claim_without_fact", { ...reads, fabricatedClaims: fabricated });
  if (!covenantSaid) {
    if (subjectSaid)
      return verdict("s4_memory", "failed", "covenant_subject_without_the_promise", {
        ...reads,
        rule: "the subject is what the field publishes; the promise is what the conversation added",
      });
    if (mentions.length === 0 && arrayOf(dayOneReceipts).length === 0)
      return verdict("s4_memory", "not_measured", "nothing_to_recall", reads);
    return verdict("s4_memory", "failed", "covenant_not_recalled", reads);
  }
  return verdict("s4_memory", "passed", "recalled_the_promise_the_field_cannot_answer", reads);
}

/** One line per slice, printed the moment the slice is decided; every read the verdict used is on it. */
export function renderSliceLine(sliceVerdict) {
  const reads = Object.entries(sliceVerdict.reads)
    .map(
      ([key, value]) => `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`,
    )
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

/** The topology, stated rather than implied: who owns the pipe, which body each slice drives, what is unreachable. */
export function topologyFacts() {
  return Object.freeze({
    bridgeConsumers: 1,
    pipeOwner: "the companion runtime's own LocalStardewBridgeClient; this run dispatches nothing through it",
    secondConnectionOpenedByProbe: false,
    probeBodyBySlice: Object.freeze(Object.fromEntries(PAIRED_SLICES.map((slice) => [slice.id, slice.probeBody]))),
    secondBodyAvailable: "host_farmer_script",
    secondBodyReason:
      "the Host player is moved by the fixture's own file arm (HostPlayerScriptChannel: S1's walk/emote/say, S2's container, S3's sleep), never by a second bridge",
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

/** Which instrument read the Host farmer's bed hour: the `sleep` step's own record, written on the game thread. */
export const HOST_BED_TIME_SOURCE = "host_player_record";

/**
 * THE HOST FARMER'S NIGHT, from the one step that started it.
 *
 * `timeOfDay` and `dayOfMonth` are the world's own clock, read by the Mod on the game thread at the moment it answered the
 * bed prompt - BEFORE `Game1.NewDay` resets the clock to 600 - so the hour is the hour she went to bed and the day is the
 * day the night ended on. Those are the same two numbers the companion's night is read by (`day_before` and a pre-crossing
 * clock), which is what makes the two comparable at all.
 *
 * A step that did not settle successfully states its own refusal as `bedTimeAbsent` rather than an hour: a night the
 * fixture never began is a named gap, not a farmer who woke at 06:00.
 */
export function readHostNightFromSleepRecord(record) {
  if (record === null || record === undefined) return null;
  const started = record.state === "succeeded";
  const bedTime = started && Number.isFinite(record.tGameMs) ? gameClockHhmmFromMs(record.tGameMs) : null;
  const day = started && Number.isInteger(record.dayOfMonth) ? record.dayOfMonth : null;
  return Object.freeze({
    state: record.state,
    reasonCode: record.reasonCode,
    day,
    bedTime,
    bedTimeSource: bedTime === null ? null : HOST_BED_TIME_SOURCE,
    bedTimeAbsent:
      bedTime === null
        ? started
          ? "host_sleep_step_unreadable"
          : (record.reasonCode ?? "host_sleep_step_unreadable")
        : null,
  });
}

/**
 * The companion's own night, from the trace.
 *
 * The night ending itself is `multiday-baseline.mjs`'s reading, in BOTH spellings (a `night_ended_*` world fact and a
 * `sleep` receipt whose reason is the crossing). The HOUR comes from the clock the runner read immediately before her
 * night began - the same `pre_crossing_clock` provenance the Host lane now publishes - and is absent with a reason when
 * no reading was taken.
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
    traceDir:
      value("trace-dir") ?? process.env.GAMEBUDDY_PAIRED_TRACE_DIR ?? process.env.GAMEBUDDY_LOOP_TRACE_DIR ?? null,
    // The fixture's Host player lane. Both paths are absolute and both are required: the driver arms them into the Host
    // process before launch, so a run that is given one of them is a run whose arm is half-written. This is also the only
    // lane S3 gets the Host farmer's night through - a second flag for an evidence file was retired with the pre-armed
    // lifecycle it described.
    hostPlayerScript: value("host-player-script") ?? process.env.GAMEBUDDY_PAIRED_HOST_PLAYER_SCRIPT ?? null,
    hostPlayerScriptRecords:
      value("host-player-script-records") ?? process.env.GAMEBUDDY_PAIRED_HOST_PLAYER_SCRIPT_RECORDS ?? null,
    sliceSeconds: Number(value("slice-seconds") ?? 0) || null,
  });
}

/** The durable identity both sessions of one run share: a rebuilt session must keep the memory boundary it crosses. */
function runIdentity(startedAtMs) {
  return `paired-run-${startedAtMs}`;
}

/**
 * The run itself: four slices against one open session, every record written to ONE trace.
 *
 * `sessionFactory`, `observe` and `runTurn` are injected so the slices can be driven by a test without a game; the
 * production call uses none of them.
 *
 * THE SESSION IS REBUILT ONCE, between S3 and S4, and that boundary is the slice. Both sessions are opened on the SAME
 * `runtimeRoot` and the SAME `continuityId`, so the durable side of memory is shared while the conversation is not: a
 * fresh game runtime session gets a fresh Pi session under the identity's own paths. That is the strongest boundary the
 * harness supports, and it is stated in the trace (`session_boundary`) rather than implied.
 */
export async function runPairedLiveRun({
  config,
  traceDir,
  hostPlayerScript = null,
  hostPlayerScriptRecords = null,
  sliceSeconds = null,
  sessionFactory = openAgentDrivenSession,
  now = () => Date.now(),
  observe = null,
  runTurn = null,
  pollMs = 250,
}) {
  if (typeof traceDir !== "string" || traceDir.length === 0) throw new Error("paired_trace_dir_required");
  mkdirSync(traceDir, { recursive: true });
  const startedAtMs = now();
  const identity = runIdentity(startedAtMs);
  const runtimeRoot = join(traceDir, "runtime");
  const receipts = [];
  const worldFacts = [];
  const lines = [];
  const timelinePath = join(traceDir, "timeline.jsonl");
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
      // Every receipt in this run is hers: the run dispatches nothing through her client, and the Host player's acts
      // arrive as script records instead of receipts.
      const receipt = normalizeReceipt(fact.payload, { atMs, requester: "companion" });
      receipts.push(receipt);
      timeline({ atMs, tGameMs: receipt.tGameMs, type: fact.type, requester: "companion", payload: fact.payload });
      return;
    }
    if (fact.type === "world_fact") worldFacts.push(fact.payload);
    timeline({ atMs, type: fact.type, payload: fact.payload });
  };

  const openSession = () => sessionFactory({ config, traceDir, onFact, runtimeRoot, continuityId: identity });
  let session = await openSession();
  const observeFn = observe ?? (() => observeFresh(session.client));
  const clockOf = (snapshot) => snapshotClock(snapshot);
  const dayStartsAtStart = worldDayStartsFromFacts(worldFacts).length;
  let knownTurns = 0;
  const turnsSeen = [];
  const results = [];
  let stoppedBy = null;
  let s1Anchor = null;
  let s1Observation = null;
  let contendedTile = null;

  const askCompanion = async (allocation) => {
    const turn = await (runTurn ?? ((lines) => session.runTurn(lines)))(allocation);
    const turns = Array.isArray(turn?.turns) ? turn.turns : [];
    // The transcript is read whole on every turn, so "the turns this turn produced" is the suffix after the ones
    // already seen - and `knownTurns` is advanced HERE, not at a call site, so no slice can forget to. A rebuilt
    // session starts its own transcript, which is why the boundary below resets the counter.
    const produced = turns.slice(knownTurns);
    knownTurns = turns.length;
    turnsSeen.push(...produced.map((entry) => entry.text));
    return { ...turn, turns, produced };
  };

  /**
   * Close the game runtime session and open a fresh one on the same durable identity.
   *
   * `client.close()` matters: the Mod admits ONE bridge consumer, so the second session's connection is admitted only
   * after the first generation has dropped. If it is not admitted the next turn reports it (`bridge_not_authenticated`)
   * and S4 prints `not_measured`, which is the honest reading of a boundary the run could not cross.
   */
  const rebuildSession = async (reasonCode) => {
    const previous = session;
    session = null;
    try {
      if (typeof previous?.client?.close === "function") previous.client.close("paired_session_boundary");
    } catch {
      // A close that throws has already dropped what it could; the fresh connection is what the boundary needs.
    }
    if (typeof previous?.dispose === "function") previous.dispose();
    timeline({
      atMs: now() - startedAtMs,
      type: "session_boundary",
      payload: {
        reasonCode,
        continuityId: identity,
        runtimeRoot,
        conversation: "fresh_game_runtime_session",
        durableMemory: "same continuity identity and runtime root",
      },
    });
    session = await openSession();
    knownTurns = 0;
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

  // ---- S1: joint attention, with the Host player as the cue --------------------------------------------------
  await runSlice("s1_attention", async (budgetMs) => {
    // HER PLACEMENT FIRST, before anything is observed or armed. S1 asks whether she went to a person she SAW, which
    // presumes her own observation is taken from the world the slice was armed on: if she is still in her Cabin there is
    // no subject to stand beside and no person on her map, and `not_measured:fixture_missing` would blame the world for a
    // handshake this run never completed. The record is an act written by HER process, not a tile this runner assumed.
    const placement = await awaitCompanionPlacement({
      path: hostPlayerScriptRecords,
      timeoutMs: budgetMs,
      now,
      pollMs,
    });
    timeline({ atMs: now() - startedAtMs, type: "s1_placement", payload: placement });
    if (placement.confirmed !== true) {
      print(`PAIRED_PLACEMENT_UNCONFIRMED ${placement.reasonCode}`);
      return verdict("s1_attention", "failed", placement.reasonCode, { placement });
    }
    const snapshot = await observeFn();
    const plan = planHostAttentionScript({ snapshot, covenant: COVENANT_LINE });
    if (plan.subject === null) {
      print(fixtureGapLine("ready_grab_crop", plan.dropped[0]?.reason ?? "unknown"));
      return judgeJointAttention({ hostRecords: null, companion: [] });
    }
    s1Anchor = Object.freeze({
      tile: plan.subject.tile,
      itemId: plan.subject.itemId ?? null,
      displayName: plan.subject.displayName ?? null,
    });
    // WHETHER THIS SLICE MAY RUN AT ALL, from the world's own two tiles and before anything is armed: a companion who
    // starts beside the anchor would pass by standing still, and one who starts inside the six tiles `otherFarmers` used
    // to be bounded by would pass even if `628c0967` had never landed. The timeline keeps the numbers either way.
    const staging = attentionStaging({ anchorTile: plan.subject.tile, companionTile: snapshot?.tile ?? null });
    timeline({ atMs: now() - startedAtMs, type: "s1_staging", payload: staging });
    if (staging.ran !== true) {
      print(fixtureGapLine("s1_staging", staging.reasonCode));
      return judgeJointAttention({ hostRecords: null, companion: [], subject: plan.subject.kind, staging });
    }
    const allocation = sliceAllocation("s1_attention");
    const promptTileLeak = allocationLeaksTile(allocation, plan.subject.tile);
    timeline({ atMs: now() - startedAtMs, type: "s1_allocation", payload: { allocation, promptTileLeak } });
    const armed = appendHostPlayerScript(hostPlayerScript, plan.steps);
    if (!armed.ok)
      return judgeJointAttention({
        hostRecords: null,
        companion: [],
        subject: plan.subject.kind,
        promptTileLeak,
        staging,
      });
    const stub = await awaitHostPlayerRecords({
      path: hostPlayerScriptRecords,
      seqs: armed.seqs,
      timeoutMs: budgetMs,
      now,
      pollMs,
    });
    // HER observation, taken after the player arrived: `otherFarmers` is the cue the prompt deliberately does not give,
    // and the observation is read through her own client so it is the cue she was actually shown.
    const observation = await observeFn().catch(() => null);
    s1Observation = observation ?? snapshot;
    const clock = clockOf(observation ?? snapshot);
    const mark = receipts.length;
    const turn = await withBudget(askCompanion(allocation), budgetMs);
    return judgeJointAttention({
      hostRecords: stub.records,
      otherFarmers: Array.isArray(observation?.otherFarmers) ? observation.otherFarmers : null,
      companion: receipts.slice(mark),
      subject: plan.subject.kind,
      probeTGameMs: clock.tGameMs,
      companionDay: clock.dayOfMonth,
      turnTimedOut: turn.timedOut === true,
      promptTileLeak,
      staging,
    });
  });

  // ---- S2: two independent farmers contend for one container -----------------------------------------------
  await runSlice("s2_claim", async (budgetMs) => {
    const snapshot = await observeFn();
    const plan = planHostClaimScript({ snapshot });
    if (plan.contended === null) {
      print(fixtureGapLine("chest_with_item", plan.dropped[0]?.reason ?? "unknown"));
      return judgeConcurrentClaim({ contended: null });
    }
    contendedTile = plan.contended.tile;
    const armed = appendHostPlayerScript(hostPlayerScript, plan.steps);
    if (!armed.ok) {
      print(`PAIRED_FIXTURE_MISSING host_player_stub reason=${armed.reason} arm=${HOST_PLAYER_STUB_LAUNCH}`);
      return judgeConcurrentClaim({ contended: null });
    }
    const mark = receipts.length;
    // She is asked first and the script is already on disk: neither side is held back, so whichever of them reaches the
    // container first is the world's answer and not an ordering this run imposed.
    const turnPromise = askCompanion(sliceAllocation("s2_claim", { item: plan.contended.displayName }));
    const stub = await awaitHostPlayerRecords({
      path: hostPlayerScriptRecords,
      seqs: armed.seqs,
      timeoutMs: budgetMs,
      now,
      pollMs,
    });
    await withBudget(turnPromise, budgetMs);
    const hostRecord = stub.records.find((record) => record.action === "chest_take") ?? null;
    const hostSide =
      hostRecord === null
        ? null
        : Object.freeze({
            state: hostRecord.state,
            reasonCode: hostRecord.reasonCode,
            tGameMs: hostRecord.tGameMs,
            evicted: Object.freeze([]),
            targetTile: hostRecord.targetTile,
          });
    const herReceipts = receipts.slice(mark).filter((receipt) => receipt.actionId === "chest_retrieve");
    const companionSide =
      herReceipts.find((receipt) => tileKey(receipt.targetTile) === tileKey(plan.contended.tile)) ??
      herReceipts[0] ??
      null;
    return judgeConcurrentClaim({
      contended: plan.contended,
      host: hostSide,
      companion: companionSide,
      world: await readContendedItemState(observeFn, plan.contended),
    });
  });

  // ---- S3: the co-op night -----------------------------------------------------------------------------------
  await runSlice("s3_night", async (budgetMs) => {
    // THE HOST'S HALF OF THE NIGHT IS ARMED IN THIS SLICE'S WINDOW, not before the run: a farmhand cannot end the day
    // alone (the engine's ready barrier waits for both farmers), so a Host night nothing started is exactly the night
    // this slice used to spend its whole budget waiting for.
    const armed = appendHostPlayerScript(hostPlayerScript, planHostNightScript());
    if (!armed.ok) {
      print(fixtureGapLine("host_sleep_step", armed.reason));
      return judgeCoopNight({ hostNight: null, companionNight: null });
    }
    // HER SIDE'S HOUR IS THE CLOCK READ IMMEDIATELY BEFORE HER NIGHT BEGAN, and the Host's is her own step's record: two
    // instruments, because "the hour she went to bed" is not something the world's facts state for either of them.
    const before = await observeFn().catch(() => null);
    const preCrossingClock = before === null ? null : clockOf(before).tGameMs;
    const mark = receipts.length;
    // BOTH BODIES ARE ASKED AT ONCE, and neither is held back for the other: the barrier completes when both are ready, so
    // an ordering this run imposed would be the run's own answer to a question about two farmers.
    const turnPromise = askCompanion(sliceAllocation("s3_night"));
    const step = await awaitHostPlayerRecords({
      path: hostPlayerScriptRecords,
      seqs: armed.seqs,
      timeoutMs: budgetMs,
      now,
      pollMs,
    });
    const sleepRecord = step.records.find((record) => record.seq === armed.seqs[0]) ?? null;
    const hostSleepStep = Object.freeze({
      settled: sleepRecord?.state === "succeeded",
      state: sleepRecord?.state ?? null,
      reasonCode: sleepRecord?.reasonCode ?? (step.timedOut ? "host_sleep_step_never_settled" : null),
      // The channel stops on a NAMED refusal (`script_stopped_by:<step>` plus the reason in `detail`), so the detail travels
      // with the verdict: "the step was refused" without the reason is a code a reader cannot act on.
      detail: sleepRecord?.detail ?? null,
    });
    await withBudget(turnPromise, budgetMs);
    // The night is the WORLD'S answer, so it is waited for in the world's own spellings rather than assumed from either
    // body's turn having finished: a farmer who says "去睡了" and a night that crossed are two different facts. Both
    // spellings are read (`night_ended_*` facts and her own `sleep` receipt that carries the crossing), so the wait ends
    // when whichever one this topology publishes arrives instead of spending the slice's budget on a shape that is not
    // coming.
    const sliceReceipts = receipts.slice(mark).filter((receipt) => receipt.actionId === "sleep");
    const nightDeadline = now() + budgetMs;
    while (now() < nightDeadline) {
      if (readCompanionNightRecord({ worldFacts, receipts: sliceReceipts }) !== null) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
    }
    const companionNight = readCompanionNightRecord({ worldFacts, receipts: sliceReceipts, preCrossingClock });
    return judgeCoopNight({
      hostNight: readHostNightFromSleepRecord(sleepRecord),
      companionNight,
      hostSleepStep,
    });
  });

  // ---- S4: cross-day recall across a rebuilt session ---------------------------------------------------------
  await runSlice("s4_memory", async (budgetMs) => {
    const dayRolledOver = worldDayStartsFromFacts(worldFacts).length > dayStartsAtStart;
    // EVERYTHING BEFORE THE BOUNDARY IS DAY ONE, and this copy is taken before it so her own next-day receipts cannot
    // be read as day-one evidence for her own next-day claim.
    const dayOneReceipts = Object.freeze([...receipts]);
    const said = readHostPlayerRecords(hostPlayerScriptRecords).find(
      (record) => record.action === "say" && record.state === "succeeded",
    );
    const covenant = Object.freeze({
      line: COVENANT_LINE,
      subjectTokens: COVENANT_SUBJECT_TOKENS,
      promiseTokens: COVENANT_PROMISE_TOKENS,
      spoken: said !== undefined && said !== null,
      fieldDerivable: covenantIsFieldDerivable(COVENANT_LINE, s1Observation),
    });
    await rebuildSession("paired_session_boundary_before_the_next_day");
    const turn = await withBudget(askCompanion(sliceAllocation("s4_memory")), budgetMs);
    const nextDayTurns = (turn.value?.produced ?? []).map((entry) => entry.text);
    return judgeCrossDayMemory({
      anchor: s1Anchor,
      dayOneReceipts,
      companionTurns: nextDayTurns,
      dayRolledOver,
      covenant,
      sessionBoundary: "fresh_game_runtime_session_on_the_same_continuity_identity",
    });
  });

  // The fixture is done arming. Sealing is what lets the Host player's channel end quietly once its last step settles,
  // instead of polling a document nobody will append to for the rest of the process. A launch with no arm has nothing to
  // seal, and its own `not_configured` line was already printed by the slice that needed it.
  sealHostPlayerScript(hostPlayerScript);

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
  // THE MEMORY AND PROMPT-CACHE LEDGER, once per paired run.
  //
  // The paired run crosses a session boundary on ONE continuity identity, which is the only topology in this repository
  // where durable memory is shared while the conversation is not - so the funnel this publishes (`memories`,
  // `historian_runs`, `notes`, `primers`, `dream_runs`) is the WP-C/WP-D evidence a Chat or Game session cannot supply.
  // The project scope is resolved from the store's own `session_projects` rows by this run's own continuity suffix;
  // a store that cannot name it reports `not_measured` and reads nothing globally.
  const memoryLedger = collectMemoryCacheLedger({
    contextsRoot: join(runtimeRoot, "contexts"),
    continuityId: identity,
  });
  console.error("PAIRED_MEMORY_LEDGER", describeMemoryCacheLedger(memoryLedger), JSON.stringify(memoryLedger));
  const report = Object.freeze({
    state,
    reasonCode: results.find((entry) => entry.state !== "passed")?.reasonCode ?? "all_four_slices_passed",
    durationSeconds: (now() - startedAtMs) / 1_000,
    slices: Object.freeze([...results]),
    topology: topologyFacts(),
    counts: Object.freeze({
      receipts: receipts.length,
      worldFacts: worldFacts.length,
      dayStarts: worldDayStartsFromFacts(worldFacts).length,
      contendedTile: tileKey(contendedTile),
      hostPlayerRecords: readHostPlayerRecords(hostPlayerScriptRecords).length,
    }),
    traceBytes,
    rubric,
    // Recorded, not blocking: the six §4 metrics and the three red lines this run's own store and session imply.
    memoryLedger,
  });
  writeFileSync(join(traceDir, "paired-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PAIRED_TOPOLOGY ${JSON.stringify(report.topology)}`);
  console.log(`PAIRED_RESULT ${JSON.stringify(report)}`);
  if (typeof session?.dispose === "function") session.dispose();
  return report;
}

/**
 * Where the contended item is now, read back from the world rather than from either side's record.
 *
 * Three answers and nothing else: `item_evicted` (the container no longer holds it), `item_still_there`, or null when
 * the container could not be read at all - which the judge reports as `world_fact_absent` rather than assuming the
 * take happened.
 */
async function readContendedItemState(observe, contended) {
  if (contended === null || contended === undefined || contended.itemId === null) return null;
  let after;
  try {
    after = await observe();
  } catch {
    return null;
  }
  const row = Array.isArray(after?.chests) ? after.chests.find((entry) => entry?.chestId === contended.chestId) : null;
  if (row === null || row === undefined) return null;
  const stillHeld = Array.isArray(row.items)
    ? row.items.some((item) => item?.qualifiedItemId === contended.itemId)
    : null;
  if (stillHeld === null) return null;
  return stillHeld ? "item_still_there" : "item_evicted";
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
