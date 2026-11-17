/**
 * The model-facing text of one delivery, as four named blocks of prose.
 *
 * <p>
 * WHY NOT JSON. Measured 2026-11-10 (`round44`, 109 delivered batches): the model's user message was ONE stringified
 * object - `{"kind":"gamebuddy_fact_batch", batchId, disposition, triggerEventIds, playerInputs, worldFacts, events}` -
 * averaging 11,066 characters, carrying 819,382 characters of `worldFacts` and the SAME facts again under `events`. The
 * player's day note ("找片水，钓条鱼回来") was one array element inside an 11 KB frame, and she never mentioned fishing:
 * 0 of 162 thinking parts. A JSON envelope is the wrong shape for a world report; the instruction has to be a block of
 * its own, not an element beside the facts.
 * </p>
 *
 * <p>
 * THE CLOSED SET is `FACT_BRIEF_BLOCKS`, and the Game surface's prompt floor names four of the five once, at session
 * construction (`identity-profile.ts`). A block with nothing to say is omitted rather than emitted empty - except
 * `<world-state>`, which is emitted on EVERY batch: a session that has heard nothing says `世界：尚未收到观察`, because an
 * omitted world block reads as "there is nothing there" and the model then answers from what it remembers.
 * </p>
 *
 * <p>
 * THE HEAD OF THE MESSAGE IS SPEECH, and it is not a block. The player's own words are the first text in the message,
 * character for character what they typed, outside every block and under no label: a person talking to their companion
 * is not a field of the machine's report. Until `2026-11-14` they arrived inside `<player-note>` and were split by an
 * attribution rule (`player-note.ts`) that guessed, per sentence, whether the words were his own business or a job for
 * her - machinery that existed only because speech had been presented as data. An imperative addressed to her is hers
 * and a statement about him is context; nothing has to classify that, and nothing does any more.
 * </p>
 *
 * <p>
 * WHICH BLOCK A FACT BELONGS IN is a property of the fact, not of the batch:
 * </p>
 *
 * <ul>
 *   <li>`<world-state>` - the snapshot as a paragraph: clock, date, weather, where, stamina, what she carries, and the
 *       nearby target families with their tiles;</li>
 *   <li>`<world-facts>` - the DECISIONS: a refusal, a notice, an arrival, the transport going away. Not a stream of
 *       "the world changed" - she calls `stardew_observe` when she wants to know, and a successful step of a programme she
 *       dispatched is stated by `<execution-result>`;</li>
 *   <li>`<execution-result>` - what a submitted programme DID, in sentences. A settlement is deliberately NOT also a
 *       `<world-facts>` line: the two blocks would then state one outcome twice, and the aggregate is the only place a
 *       run of twenty node rows becomes a sentence.</li>
 * </ul>
 *
 * <p>
 * WHAT IS NOT HERE. `batchId`, `disposition` and `triggerEventIds` are Host bookkeeping and never enter the text; the
 * delivery frame carries them beside it (`PendingBatch`). Chinese, because the player and the card are Chinese and the
 * vocabulary for the world already is (`game-world-vocabulary.ts`).
 * </p>
 */

import type { PlayerInput, WorldFact } from "./event-pump.js";
import {
  formatBodyState,
  formatGameClock,
  formatGameEnvironmentFacts,
  formatRipeCrops,
  MAX_COUNTED_FAMILIES_NAMED,
  MAX_TARGET_FAMILIES_SHOWN,
  nearbyTargetFamilies,
} from "./game-world-vocabulary.js";
import { MAX_WORLD_FACT_LINES, boundedField } from "./model-field-budget.js";
import { ROW_TILE_FIELD_PAIRS, TARGET_FAMILY_LABELS } from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

/**
 * The closed set of block names a delivery may use.
 *
 * ORDER IS THE READING ORDER: what is true now, then what she has to decide on, then what a call of hers did.
 *
 * `<in-flight>` IS GONE (`design/fact-authority.md` §1b, 2026-11-16). It printed a row per unfinished node of a
 * programme she had already dispatched - "dispatched is not done" repeated every turn - where the settlement is the
 * answer and states the same nodes with their bounded evidence. Measured `round64`: 401 admitted "facts" for 8 opened
 * turns, 260 of them one tile of her body moving, stated twice.
 *
 * THE PROMPT FLOOR NAMES EVERY ONE OF THESE (`identity-profile.ts`), and it reads the list and the count from this
 * array rather than restating them: its paragraph is built from `FACT_BRIEF_BLOCKS.length` and a
 * `Record<FactBriefBlock, string>` of glosses, so a sixth block is a compile error there instead of a block the prompt
 * forgot. Between 2026-11-11 and the same day's later commit the floor said "four" while this set held five; that
 * window is why `fact-brief.private.test.ts` now asserts the stated count equals this array's length. The closed set is this
 * list.
 */
export const FACT_BRIEF_BLOCKS = Object.freeze(["world-state", "world-facts", "execution-result"] as const);

export type FactBriefBlock = (typeof FACT_BRIEF_BLOCKS)[number];

/**
 * How many delivered turns a re-stated world reading may age before its age stops being a parenthetical and becomes a
 * named fact.
 *
 * <p>
 * A reading is re-stated into every batch (`host-service.ts#restateWorldSnapshot`), so the block always has an age and
 * that age was words: `（这是 50 轮之前看到的，世界已经不一样了）`. Measured 2026-11-10 (`round45`): the reading froze at
 * `revision 352` for 50 turns and 30 minutes while the clock walked from 06:00 through two 02:00 pass-outs and two day
 * starts, she dispatched nothing for the last 30 minutes, and the only trace was that sentence. Nothing could act on
 * it - not the model (prose inside the block it invalidates reads as the present tense), not a run audit (no token),
 * not the wake decider (no fact).
 * </p>
 *
 * <p>
 * The bound is in TURNS because a turn is a delivery the model read: five turns is long enough that ordinary work
 * between two observations never reaches it (every dispatch publishes receipts, and an observe is what the model does
 * when it needs the world) and far below the fifty that were narrated.
 * </p>
 */
export const WORLD_STATE_STALE_TURNS = 5;

/**
 * Each further stale fact for the SAME reading waits this many bouns of the same silence.
 *
 * One per turn would spend the run on one warning: fifty turns of a frozen reading is three facts (5, 20, 35), not
 * fifty, which keeps the fact alive without paying for it every turn.
 */
const WORLD_STATE_STALE_REARM_MULTIPLE = 4;

/** The turn age at which the `published`-th stale fact for one reading is due. */
export function worldStateStaleThreshold(published: number): number {
  return WORLD_STATE_STALE_TURNS * (1 + published * (WORLD_STATE_STALE_REARM_MULTIPLE - 1));
}

/**
 * The one spelling of the stale token: `world_state_stale:<turns>;<revision>;<contentAgeMs>`.
 *
 * The block, the `<world-facts>` line and the Host's published line all carry this exact string, so a reader - a model,
 * a log grep, a run audit - never has to reconcile two renderings of one number.
 *
 * THE NUMBER IS THE CONTENT'S AGE, not the reading's: the token says "this picture is invalid", and a picture re-read a
 * second ago is exactly as invalid as it was before the re-read. The reading's own age travels beside it on the fact
 * (`ageMs`), because "nobody has looked for five minutes" and "we looked and the world still says what we cannot see" are
 * different conditions that a run has to tell apart.
 */
export function worldStateStaleCode(
  reading: Readonly<{ ageTurns: number; revision: number; contentAgeMs: number }>,
): string {
  return `world_state_stale:${String(reading.ageTurns)};${String(reading.revision)};${String(reading.contentAgeMs)}`;
}

/** One node row of a settled programme, as `program-settlement-digest.ts` publishes it. */
type SettledNode = Readonly<{
  nodeId?: string;
  actionId?: string;
  state?: string;
  reasonCode?: string;
  hint?: string;
  reasonDetail?: string;
  /**
   * The pass's own row table, verbatim, from the Mod's `BodyProgramJournalNode.Evidence`.
   *
   * `for_each` settles ONE node for sixty tiles, so this row - not sixty facts - is where a batch's per-row outcome lives,
   * and it is the row `round63` read as `{"nodeId":"n02","actionId":"for_each","state":"succeeded"}`: fifteen tiles
   * tilled, forty-five untouched, and not one tile named.
   */
  evidence?: string;
  /**
   * The tile the step's own arguments name, when they name one - the same field `stardew_action_program_status` answers
   * with, and the one thing that says WHERE a step's work landed. Absent for the thirteen families whose rows carry no
   * tile and for a pass, whose rows are in `evidence` instead.
   */
  tile?: Readonly<{ x: number; y: number }>;
  /** The pass's own verdict line, verbatim: `for_each_pass:decided=60:succeeded=45:left_alone=0:omitted=0`. */
  postconditionVerification?: string;
}>;

/**
 * One reading of the world, as `<world-state>` states it.
 *
 * The snapshot is the Mod's own admitted `Snapshot` payload - never the bounded context projection, which is built for
 * a dispatch and withholds the target families. `revision` is the snapshot's own, and `ageTurns` is how many delivered
 * turns ago this reading arrived: `0` is the turn it arrived in.
 */
export type WorldStateReading = Readonly<{
  snapshot: Snapshot;
  revision: number;
  ageTurns: number;
  /**
   * Milliseconds since the world was last READ, by any caller and whether or not it said anything new.
   *
   * The reading half of the freshness question: a world re-read every thirty seconds is a world nobody has lost sight of,
   * and a run that reported otherwise told the model its picture was old when the Mod had answered seconds ago
   * (`round66`, `round67`).
   */
  ageMs: number;
  /**
   * Milliseconds since this reading's CONTENT was first admitted: how old the picture is.
   *
   * The turn age (`ageTurns`) and this one say the same thing in two units, and both are about the content because that
   * is what the stale token invalidates. A re-read that finds the world unchanged refreshes `ageMs` and leaves this
   * running - which is the difference between "nobody looked" and "we looked, and it still says this".
   */
  contentAgeMs: number;
}>;

/** What one delivered batch shows the model. The snapshot is state, everything else is news. */
export type FactBriefInput = Readonly<{
  inputs: readonly PlayerInput[];
  /**
   * The world as LAST HEARD, and how many delivered turns ago it was observed (`0` is this turn).
   *
   * Not "the snapshot this batch carried": the pump's snapshot slot is consumed by the batch that takes it, so a
   * block composed from that slot would be absent from every later batch - the blindness this brief exists to end.
   */
  snapshot: WorldStateReading | undefined;
  /**
   * The decisions this delivery states, in the order it delivers them.
   *
   * NOT "everything the batch carried": the frame carries what arrived, and this carries what the model is owed - her
   * own call's result, a refusal, a notice, an arrival, the bridge going away (`design/fact-authority.md` §1b). A
   * programme's step and a clock mark are not in this list: she asks `stardew_observe` for the world, and the settlement
   * states the work.
   */
  events: readonly WorldFact[];
  /** The language the player wrote in. The brief is Chinese; this is what a caller checks it against. */
  locale: string;
}>;

/**
 * The whole model-facing text of one delivery.
 *
 * Deterministic: no clock of its own, no map iteration, no field rendered twice. The text is folded into the session's
 * cached history, so two batches with the same content must render the same bytes.
 */
export function composeFactBrief(input: FactBriefInput): string {
  const blocks: string[] = [];
  const speech = playerSpeech(input.inputs);
  if (speech !== "") blocks.push(speech);
  const state = composeWorldState(input.snapshot);
  if (state !== "") blocks.push(state);
  const settlements = input.events.filter((fact) => fact.semanticKind === PROGRAM_SETTLED);
  const facts = input.events.filter((fact) => fact.semanticKind !== PROGRAM_SETTLED);
  const factBlock = composeWorldFacts(facts);
  if (factBlock !== "") blocks.push(factBlock);
  const resultBlock = composeExecutionResult(settlements, input.snapshot);
  if (resultBlock !== "") blocks.push(resultBlock);
  return blocks.join("\n");
}

/**
 * The player's own words, verbatim, as the head of the message: outside every block and under no label.
 *
 * <p>
 * NOTHING IS ADDED, REMOVED OR REORDERED. Not trimmed, not re-punctuated, not joined into sentences: the text is what
 * the person typed, and one message per input, in arrival order. A blank input is dropped rather than rendered as an
 * empty line, which is the one thing a caller can hand over that is not words.
 * </p>
 *
 * <p>
 * It is deliberately not wrapped in a block. A block is the machine's channel, and the prompt floor tells her that
 * everything in a block is written by the machine; putting speech in one made the person a field of a report, which is
 * the defect `<player-note>` carried for three days of live runs.
 * </p>
 *
 * <p>
 * IT IS NOT FILTERED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. Passed through unchanged, a player who types a
 * block's own markup (`<world-state>`, `</world-state>`) puts that markup in the message, and position alone no longer
 * tells their words from the machine's report. It is left alone because this channel has ONE sender: `player_text` is
 * minted by the authenticated control surface of the person this companion belongs to (`companion-control-server.ts`),
 * so imitating a block imitates it to themselves - there is no third party to deceive, and the words grant nothing.
 * Everything they could ask for is still admitted by the Mod against the live world on the game thread
 * (`FarmhandCapabilitySurface`), and a run's verdicts read receipts rather than prose. Escaping or stripping the markup
 * would silently edit what the player said, which is the one thing this function promises not to do.
 * </p>
 */
function playerSpeech(inputs: readonly PlayerInput[]): string {
  return inputs
    .map((input) => input.text)
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * The world as one paragraph, under a first line that says WHICH reading and HOW FRESH it is.
 *
 * THE FIRST LINE IS THE AGE, because the rest of the paragraph reads as the present tense. A reading is not the world:
 * measured 2026-11-05, six consecutive turns were handed `18:00` while the model's own reasoning read "It's 22:00 now"
 * in the same turn, and the run ended `companion_did_not_sleep`. The revision is the Mod's own, so two readings can be
 * told apart without trusting the clock; `本轮无新观察` is the honest label for a re-statement, and `刚刚更新` for the
 * turn the observation arrived in.
 *
 * PAST THE DECLARED BOUND the age stops being a parenthetical and becomes the token itself
 * (`world_state_stale:<turns>;<revision>;<ageMs>`): a numbered fact beside the block it invalidates rather than a
 * sentence inside it, because the sentence was there for fifty turns and changed nothing.
 *
 * THE PARAGRAPH is `formatGameEnvironmentFacts` - the same line the Chat surface's `<runtime-environment>` carries, from
 * the same vocabulary module, so a clock or a map is spelled one way in both places. On top of it: what she is
 * carrying, and the target families.
 *
 * WHY THE TARGETS ARE HERE. Measured 2026-11-10 (`round44`): 31 of 109 turns called `stardew_observe` and a snapshot was
 * already in the batch that opened 28 of them - the state block was not missing, it was missing the objects she acts on.
 * Not one of those batches named a tile.
 *
 * A session that has received nothing yet says so, in the same block: an omitted block would read as "nothing here" and
 * an invented one would be a world the Mod never published.
 */
export function composeWorldState(reading: WorldStateReading | undefined): string {
  if (reading === undefined) return block("world-state", NOTHING_OBSERVED);
  const world = reading.snapshot;
  if (world === null || typeof world !== "object") return block("world-state", NOTHING_OBSERVED);
  const parts: string[] = [];
  if (reading.ageTurns >= WORLD_STATE_STALE_TURNS)
    parts.push(
      `${worldStateStaleCode(reading)}（这块世界观察停在 ${String(reading.ageTurns)} 轮之前、${String(Math.round(reading.contentAgeMs / 1000))} 秒之前，世界已经不是这样了）`,
    );
  else if (reading.ageTurns >= 1) parts.push(`（这是 ${reading.ageTurns} 轮之前看到的，世界已经不一样了）`);
  const environment = formatGameEnvironmentFacts(world, true);
  if (environment !== "") parts.push(environment);
  const health = formatOwnHealth(world);
  if (health !== "") parts.push(health);
  const body = formatBodyState(world, true);
  if (body !== "") parts.push(body);
  const ripeCrops = formatRipeCrops(world, true);
  if (ripeCrops !== "") parts.push(ripeCrops);
  const canWater = formatCarriedCanWater(world);
  if (canWater !== "") parts.push(canWater);
  const carrying = formatCarrying(world);
  if (carrying !== "") parts.push(carrying);
  const seeds = formatHeldSeeds(world);
  if (seeds !== "") parts.push(seeds);
  const lines: string[] = [worldStateHeader(reading)];
  const paragraph = parts.join("；");
  if (paragraph !== "") lines.push(paragraph);
  lines.push(...composeNearbyTargets(world));
  return block("world-state", lines.join("\n"));
}

/** What `<world-state>` says before any observation has arrived: a statement about the Host, not about the world. */
const NOTHING_OBSERVED = "世界：尚未收到观察";

/** The block's first line: which revision, and whether this turn brought it. */
function worldStateHeader(reading: WorldStateReading): string {
  return reading.ageTurns === 0
    ? `世界（revision ${String(reading.revision)}，刚刚更新）`
    : `世界（revision ${String(reading.revision)}，本轮无新观察）`;
}

/**
 * The whole answer to an observation that found the revision it was already showing.
 *
 * `stardew_observe` used to answer every call with the entire snapshot - measured `round44`: median 20,980 characters
 * per call, 648,059 over 31 calls, 81.1% of all tool-result text - and most of those calls were made while the batch
 * that opened the turn already carried the same revision.
 */
export function unchangedWorldAnswer(revision: number): string {
  return `自 revision ${String(revision)} 以来世界没有变化`;
}

/** How many item rows the pack names before it counts the rest. */
const MAX_CARRYING_ROWS = 8;

/**
 * What she is carrying that is not a tool.
 *
 * `inventoryItemFacts` is the Mod's own bounded inventory publication (36 rows: slot, id, stack) and the name it carries
 * is `displayName` - the wire's own spelling, the one the shipping bin and every other reader uses. ABSENT means the Mod
 * did not publish the family at all - the field is gated on the actions that read the inventory - and stays silent,
 * which is a different statement from `身上没有别的东西`.
 *
 * THE PLANTABLE SEEDS ARE NOT PRINTED TWICE: the ids `seedSupplyTargets` names are left out here and printed by
 * `formatHeldSeeds`, which states the count AND the one thing this list cannot - that a measured empty one means she can
 * sow nothing. One count in two sentences would be two readings of one fact, and the seed half has a consumer (the tilled
 * ground waiting for it) this list does not serve.
 *
 * THE SLOT AND THE ID ARE THE ADDRESS, AND BOTH ARE PRINTED. `slot` and `expectedQualifiedItemId` are the pair
 * `open_geode` demands (`host/src/protocol.ts:3748`), `slot` alone is what `deposit_silo_hay` and
 * `put_item_in_fish_tank` demand - and this line used to drop the slot it was handed, so the number she is asked for was
 * a number she was never shown. The row's `displayName` is the label and cannot substitute: two stacks of the same item
 * share a name, and no action accepts a name. Both are the wire's own values, printed unmodified.
 *
 * THE CAP NAMES WHERE THE REST IS. A truncated row cannot be addressed from here, so the sentence says which reading
 * carries the slots this bound dropped (`stardew_observe` publishes the whole family) rather than counting them into a
 * silence.
 */
function formatCarrying(world: Snapshot): string {
  const rows = world.inventoryItemFacts;
  if (!Array.isArray(rows)) return "";
  const seeds = plantableSeedIds(world);
  const named = rows
    .filter((row) => typeof row?.displayName === "string" && row.displayName.trim() !== "")
    .filter((row) => !seeds.has(row.qualifiedItemId))
    // THE MAPPED ROW KEEPS THE WIRE'S OWN NAMES. An alias (`name: row.displayName`) is how the drop this function is
    // written against became invisible: a reader of the map saw `name` and `stack` and could not see that the slot had
    // been left behind. `tools/check-inventory-row-field-rendering.mjs` reads these names against the schema's own.
    .map((row) => ({
      displayName: row.displayName.trim(),
      qualifiedItemId: row.qualifiedItemId,
      slot: row.slot,
      stack: Number.isFinite(row.stack) ? Number(row.stack) : 1,
    }));
  if (named.length === 0) return "身上没有别的东西";
  const shown = named
    .slice(0, MAX_CARRYING_ROWS)
    .map((row) => `${String(row.stack)} 份 ${row.displayName} ${row.qualifiedItemId} [槽 ${String(row.slot)}]`);
  const rest = named.length - shown.length;
  return `身上带着 ${shown.join("、")}${rest > 0 ? ` 其余 ${String(rest)} 种未列出（全都要看用 stardew_observe，那里的每一行都带槽号）` : ""}`;
}

/**
 * The qualified ids of the seeds she is holding, as the supply family states them.
 *
 * ONE AUTHORITY, TWO SPELLINGS REFUSED. `seedSupplyTargets` is the Mod's own answer to "which seeds in this pack can be
 * planted" - it reads `Object.SeedsCategory` on the game thread - and its `heldCount` is summed from the same
 * `inventoryItemFacts` rows this pack list prints. So the seed half of the pack is printed once, from that family:
 * whichever renderer prints the count, the other one leaves those ids alone.
 */
function plantableSeedIds(world: Snapshot): ReadonlySet<string> {
  const rows = world.seedSupplyTargets;
  if (!Array.isArray(rows)) return new Set();
  return new Set(rows.map((row) => row.qualifiedItemId));
}

/**
 * The seeds she can actually plant, and how many of each.
 *
 * <p>
 * WHY IT IS HERE. Measured 2026-11-13: `<world-state>` rendered `可锄的地块 (62,18) …` 43 times in one run and never said
 * whether she held a seed, so her own thinking answered it - `Note 让种地，但我背包似乎没种子？` - and she did not check the
 * pack and did not plan to buy one; she went and chopped trees instead. The tile fact was true and she could not act on
 * it. The two readings that decide whether hoeing is worth anything are the can's water (`formatCarriedCanWater`) and
 * this one.
 * </p>
 *
 * <p>
 * THE ZERO IS THE FACT, AND IT IS MEASURED. `seedSupplyTargets` is published only while `plant_seed` is advertised, and
 * the Mod answers with an empty row set only when no pack slot holds an `Object.SeedsCategory` item - so `[]` is "she
 * holds no plantable seed", the sentence that turns her guess into a plan. A family the snapshot does not carry prints
 * NOTHING: absent is not zero, exactly as for the can and for the pack list.
 * </p>
 *
 * <p>
 * THE COUNT IS THE WIRE'S OWN, NEVER A DEFAULT. A row's `heldCount` is absent when the pack rows were not published at
 * all, and then the seed is named without a number rather than counted as `0`. Rows are (seed x shop), so the seeds are
 * de-duplicated by id and the seed's first row states its count.
 * </p>
 *
 * <p>
 * NO SHOP IS NAMED BESIDE IT. The rows carry where a seed she HOLDS is sold (`shopLocation` / `shopDestination`), and a
 * zero-seed actor has no row at all - so a counter named beside the zero would be the one invention this line exists to
 * prevent. The zero is the whole next step: with no seed, hoeing sows nothing.
 * </p>
 */
function formatHeldSeeds(world: Snapshot): string {
  const rows = world.seedSupplyTargets;
  if (!Array.isArray(rows)) return "";
  if (rows.length === 0) return "种子: 0（背包里没有种子）";
  const seeds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.qualifiedItemId)) continue;
    seen.add(row.qualifiedItemId);
    const name =
      typeof row.displayName === "string" && row.displayName.trim() !== ""
        ? row.displayName.trim()
        : row.qualifiedItemId;
    seeds.push(Number.isFinite(row.heldCount) ? `${String(row.heldCount)} ${name}` : `${name}（数量未测）`);
  }
  return `种子: ${seeds.join("、")}`;
}

/**
 * Her own health, in the shape the stamina beside it is written in.
 *
 * <p>
 * WHY IT IS HERE (measured 2026-11-21). `health` was exempted in `tools/check-snapshot-field-rendering.mjs` by
 * `printedBy: "host/src/snapshot-hud.ts"`, a module that composed a `[State HUD: …]` block into
 * `contextProjection.hud` - and that block's only consumer in the tree was a `typeof` guard. So her own hit points
 * were composed on every turn, printed by a module, and read by nobody: the fact a mine level is spent against was the
 * one fact the gate counted as handled. That module is gone - `host/src/snapshot-hud.ts` and its suite were deleted in
 * `90b1cabf`, the snapshot-HUD removal, which also dropped the declaration's last `unread` renderer - and the exemption
 * was deleted in `1501a852`, the same commit that added this line; the measurement is kept because it is why the line
 * exists. The sentence that did the damage was the exemption's own - the prose "states the stamina a day's work spends
 * and says nothing about collapsing at zero" - which named the gap and then closed it with a rendering nobody
 * receives.
 * </p>
 *
 * <p>
 * THE FIGURE IS THE WIRE'S OWN AND IS NOT COMPLETED. `protocol.ts` refuses a snapshot whose `health` is not a finite
 * number and the Mod publishes no maximum beside it, so a percentage or a `45/100` would be a number this file invented -
 * the rule `formatGameStamina` already follows for stamina, and the reason the value prints bare. ABSENT PRINTS NOTHING:
 * an unreadable reading is silence, never a healthy default.
 * </p>
 */
function formatOwnHealth(world: Snapshot): string {
  const health = world.health;
  if (typeof health !== "number" || !Number.isFinite(health)) return "";
  return `血量: ${String(health)}`;
}

/**
 * The water in the can she carries, stated beside the tool she is holding.
 *
 * <p>
 * WHY IT IS HERE. Measured 2026-11-11 in that morning's live run: the bridge published
 * `wateringCanFacts: [{slot:2, qualifiedItemId:"(T)WateringCan", water:40, max:40}]`, and its five observed revisions
 * of the day carried water 40, 40, 38, 36, 36 of 40. The `<world-state>` she read named the can only as `1 份 喷壶` in
 * the pack list, so she shook it and narrated a gauge instead: `壶里这点底子够浇这两穴`, `壶底见底了`, `壶空了正好`. A
 * published field no renderer reads is not a fact she has.
 * </p>
 *
 * <p>
 * WHICH CAN, AND WHICH NUMBER. The row for the held slot when her hand is in a can; otherwise the can itself when the
 * pack published exactly one, because that is the can she carries and its water still decides her day (the batch above
 * held the axe, and the can at slot 2 was exactly the one she was guessing at). Two cans and neither in hand is not a
 * question this line answers: it says nothing rather than picking one.
 * </p>
 *
 * <p>
 * ABSENT, NEVER ZERO. `wateringCanFacts` is published only while `refill_watering_can` is advertised, so an absent
 * family prints nothing - a different statement from `水 0/0`, and the reason this is not `?? 0`. The figure is the
 * wire's own `water`/`max` unmodified: `isWateringCanFact` bounds both to 0..100 with `water <= max`, and a percentage
 * would be a second spelling of two numbers. A bottomless can is NOT named as such, because the wire carries no
 * discriminator (`BridgeWateringCanFact` has five members and the validator refuses a sixth); it reads the full figure
 * its own `water`/`max` states, which is true of a can that never drains.
 * </p>
 */
function formatCarriedCanWater(world: Snapshot): string {
  const rows = world.wateringCanFacts;
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const can = rows.find((row) => row.slot === world.currentToolSlot) ?? (rows.length === 1 ? rows[0] : undefined);
  if (can === undefined) return "";
  return `壶里的水: ${String(can.water)}/${String(can.max)}`;
}

/**
 * The nearby target families: the non-empty ones first, nearest first, then one line for the families the snapshot
 * published as empty.
 *
 * A family the snapshot does not carry is not printed at all, and a family it carries as `[]` is - `nearbyTargetFamilies`
 * owns that distinction and says why. Both caps live here, in the composition, so the consumer is never the thing that
 * decides how much of the world fits.
 *
 * THE CAP NAMES WHAT IT DROPPED. A line that said only `其余 1 类未列出` left the reader unable to tell which family of
 * the thirteen she could not see - the same silence one level up from the family this line used to omit entirely
 * (`soilTiles`). The names cost a few bytes; a numbered absence costs a turn spent guessing.
 */
function composeNearbyTargets(world: Snapshot): readonly string[] {
  const families = nearbyTargetFamilies(world);
  const occupied = families
    .filter((family) => family.rendered !== undefined)
    .sort(
      (left, right) =>
        (left.nearest?.distance ?? Number.MAX_SAFE_INTEGER) - (right.nearest?.distance ?? Number.MAX_SAFE_INTEGER) ||
        left.family.localeCompare(right.family),
    );
  const lines: string[] = [];
  for (const family of occupied.slice(0, MAX_TARGET_FAMILIES_SHOWN))
    if (family.rendered !== undefined) lines.push(family.rendered);
  const dropped = occupied.slice(MAX_TARGET_FAMILIES_SHOWN).map((family) => family.label);
  if (dropped.length > 0) {
    const named = dropped.slice(0, MAX_COUNTED_FAMILIES_NAMED);
    lines.push(
      `其余 ${dropped.length} 类未列出：${named.join("、")}${dropped.length > named.length ? ` 等 ${dropped.length} 类` : ""}`,
    );
  }
  const empty = families.filter((family) => family.total === 0).map((family) => family.label);
  if (empty.length > 0) {
    const named = empty.slice(0, MAX_COUNTED_FAMILIES_NAMED);
    const more = empty.length - named.length;
    lines.push(`这一带没有：${named.join("、")}${more > 0 ? ` 等 ${empty.length} 类` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// The events.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The receipt states, said in words.
 *
 * The Mod's token is the authority and it is printed beside the words, not replaced by them: a run audit greps for
 * `rejected`, and a sentence that only said 没做成 would be a second vocabulary for the same fact.
 */
const RECEIPT_STATE_ZH: Readonly<Record<string, string>> = Object.freeze({
  accepted: "已接下",
  running: "正在进行",
  meaningful_progress: "有进展",
  blocked: "卡住了",
  succeeded: "做成了",
  rejected: "没做成",
  failed: "失败了",
  cancelled: "取消了",
  uncertain: "结果不明",
});

/** The Mod's own semantic-event kinds, said in words. A kind not named here is printed verbatim rather than dropped. */
const SEMANTIC_KIND_ZH: Readonly<Record<string, string>> = Object.freeze({
  execution_started: "开始动手",
  execution_settled_succeeded: "这一步成了",
  execution_settled_failed: "这一步没成",
  route_progress: "在路上",
  body_idle: "身体空下来了",
  snapshot_changed: "眼前变了",
});

/** The Host's and the Mod's world-fact kinds, said in words. */
const WORLD_FACT_KIND_ZH: Readonly<Record<string, string>> = Object.freeze({
  day_started: "新的一天",
  time_milestone: "又过了一个时辰",
  npc_dialogue_presented: "有人跟你说话",
  companion_arrival: "她到了",
  native_notice: "游戏里冒出个提示",
  night_ended_pass_out: "夜里没撑住，昏过去了",
  world_state_stale: "世界观察旧了",
  world_state_refresh_refused: "世界观察刷新被拒绝",
});

const PROGRAM_SETTLED = "program_settled";

/** `<world-facts>`: one line per event, the oldest first, the remainder counted. */
function composeWorldFacts(events: readonly WorldFact[]): string {
  const lines = events.map(factLine).filter((line): line is string => line !== "");
  if (lines.length === 0) return "";
  const shown = lines.slice(0, MAX_WORLD_FACT_LINES);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`其余 ${rest} 条未列出`);
  return block("world-facts", shown.join("\n"));
}

function factLine(fact: WorldFact): string {
  const at = clockOf(fact);
  switch (fact.kind) {
    case "snapshot":
      // The snapshot is the state block, not news; printing it twice is the duplication this whole change removes.
      return "";
    case "execution_receipt":
      return receiptLine(fact, at);
    case "semantic_event": {
      const kind = typeof fact.payload.kind === "string" ? fact.payload.kind : "semantic_event";
      const words = SEMANTIC_KIND_ZH[kind] ?? kind;
      const reason = typeof fact.payload.reasonCode === "string" ? `（${fact.payload.reasonCode}）` : "";
      return `- ${at}${words}${reason}`;
    }
    case "lifecycle": {
      // `state` is what the adapter's own lifecycle event carries; `kind` is what the Mod's day-start lifecycle notice
      // carries. Either is printed with its reason, because a transport event is the one thing the model must be able
      // to name (and a run audit greps for it) - there is no Chinese word for "this integration stopped".
      const state =
        typeof fact.payload.state === "string"
          ? fact.payload.state
          : typeof fact.payload.kind === "string"
            ? fact.payload.kind
            : "lifecycle";
      const reason = typeof fact.payload.reasonCode === "string" ? `：${fact.payload.reasonCode}` : "";
      return `- ${at}${state}${reason}`;
    }
    case "world_fact":
      return worldFactLine(fact, at);
  }
}

/**
 * One action receipt.
 *
 * A refusal prints the Mod's own `reasonCode` and, when it published one, its `evidence.detail` - the refusal text the
 * Mod already produces, reused rather than rephrased here. "够不到 (74,22)，那块地不可耕" is the shape this line is for:
 * the code names the rule, the detail names the tile, and neither is invented by the Host.
 */
function receiptLine(fact: WorldFact, at: string): string {
  const action = typeof fact.payload.actionId === "string" ? fact.payload.actionId : "动作";
  const state = typeof fact.payload.state === "string" ? fact.payload.state : "";
  const words = RECEIPT_STATE_ZH[state] ?? state;
  const reason = typeof fact.payload.reasonCode === "string" ? `：${fact.payload.reasonCode}` : "";
  const detail = evidenceDetail(fact.payload);
  return `- ${at}${action} ${words}${reason}${detail === "" ? "" : `（${detail}）`}`;
}

/** The Mod's own evidence detail for a receipt, bounded; never a Host paraphrase of it. */
function evidenceDetail(payload: Readonly<Record<string, unknown>>): string {
  const evidence = payload.evidence;
  if (evidence === null || typeof evidence !== "object") return "";
  return boundedField("evidence", (evidence as { detail?: unknown }).detail) ?? "";
}

function worldFactLine(fact: WorldFact, at: string): string {
  const kind = fact.semanticKind ?? "";
  switch (kind) {
    case "day_started": {
      const day = fact.payload.day;
      return `- ${at}新的一天${typeof day === "number" ? `：第 ${day} 天` : ""}`;
    }
    case "time_milestone": {
      const milestone = fact.payload.milestone;
      return `- ${at}又过了一个时辰${typeof milestone === "string" || typeof milestone === "number" ? `：${milestone}` : ""}`;
    }
    case "npc_dialogue_presented": {
      const speaker = typeof fact.payload.speaker === "string" ? fact.payload.speaker : "有人";
      const pages = Array.isArray(fact.payload.pages)
        ? fact.payload.pages.filter((page): page is string => typeof page === "string")
        : [];
      const choices = Array.isArray(fact.payload.choices)
        ? fact.payload.choices
            .map((choice) =>
              typeof choice === "object" && choice !== null && typeof (choice as { text?: unknown }).text === "string"
                ? String((choice as { text: string }).text)
                : undefined,
            )
            .filter((text): text is string => text !== undefined)
        : [];
      return `- ${at}${speaker}说：「${pages.join(" ")}」${choices.length === 0 ? "" : `（可以答：${choices.join(" / ")}）`}`;
    }
    case "native_notice": {
      // The engine's own HUD line, quoted verbatim: the whole reason this fact exists is that she may answer what the
      // game itself said ("It's getting late..."), and a line that only said 有个提示 would drop the words.
      const notice = typeof fact.payload.notice === "string" ? fact.payload.notice : undefined;
      const clock =
        typeof fact.payload.inGameTime === "string" ? formatGameClock(Number(fact.payload.inGameTime), true) : "";
      return `- ${at}游戏里冒出个提示：${notice === undefined ? "（没有文字）" : `「${notice}」`}${clock === "" ? "" : `（${clock}）`}`;
    }
    case "world_state_stale": {
      // The token is the whole fact, and it is printed VERBATIM: the pump minted it from the one function that spells it
      // (`worldStateStaleCode`), so re-deriving it here would be a second rendering of one number.
      const code = typeof fact.payload.code === "string" ? fact.payload.code : "";
      return `- ${at}${WORLD_FACT_KIND_ZH.world_state_stale ?? "世界观察旧了"}${code === "" ? "" : `：${code}`}`;
    }
    case "execution_stalled": {
      // WHICH execution, WHY the body is waiting, and FOR HOW LONG are all the Mod's own statements (`reason=
      // entity_block` and `stalled_ticks` on its `stalled_waiting` verdict), printed verbatim beside the action they are
      // about - the same rule a receipt's `reasonCode` follows. Nothing here is a duration the Host measured.
      const action = typeof fact.payload.actionId === "string" ? fact.payload.actionId : "动作";
      const reason = typeof fact.payload.reason === "string" ? fact.payload.reason : "";
      const waited = Number(fact.payload.waitedMs);
      const seconds = Number.isFinite(waited) ? Math.round(waited / 1000) : undefined;
      const parts: string[] = [];
      if (seconds !== undefined) parts.push(`已等 ${String(seconds)} 秒`);
      if (reason !== "") parts.push(`原因 ${reason}`);
      return `- ${at}${action} 卡住不动了${parts.length === 0 ? "" : `（${parts.join("，")}）`}`;
    }
    default:
      return genericWorldFactLine(fact, at, kind);
  }
}

/**
 * A world fact this file has no sentence of its own for.
 *
 * <p>
 * A kind that HAS words here is a kind the Host mints, and those carry their statement in `payload.code`
 * (`world_state_refresh_refused:bridge_not_authenticated`) - so the code is printed beside the words, verbatim. Without
 * it a refused refresh reads as "the world observation was not refreshed" and she cannot tell a dead bridge from a world
 * that did not move, which is the difference between waiting and reporting. A kind this file has no words for (the
 * Mod's `program_settled`, the pump's own narration count) prints its verbatim kind as it always has.
 * </p>
 */
function genericWorldFactLine(fact: WorldFact, at: string, kind: string): string {
  const words = WORLD_FACT_KIND_ZH[kind];
  if (words === undefined) return `- ${at}${kind === "" ? "世界消息" : kind}`;
  const code = typeof fact.payload.code === "string" && fact.payload.code !== "" ? `：${fact.payload.code}` : "";
  return `- ${at}${words}${code}`;
}

/** `<execution-result>`: what a submitted programme did, in sentences, one per settlement. */
function composeExecutionResult(settlements: readonly WorldFact[], reading: WorldStateReading | undefined): string {
  const lines = settlements.map((settlement) => settlementLine(settlement, reading)).filter((line) => line !== "");
  return lines.length === 0 ? "" : block("execution-result", lines.join("\n"));
}

/**
 * One settled programme.
 *
 * The counts and the rows come from `program-settlement-digest.ts`'s own payload (`total`, `counts`, `nodes`), so this
 * sentence and a `stardew_action_program_status` answer cannot disagree. A failure is said in WORDS: the node's own
 * `hint` and its own `reasonDetail`, each bounded, with its `reasonCode` beside them - never a Host paraphrase, and never
 * a bare count.
 */
function settlementLine(fact: WorldFact, reading: WorldStateReading | undefined): string {
  const total = Number(fact.payload.total);
  const counts = fact.payload.counts;
  const done =
    counts !== null && typeof counts === "object" ? Number((counts as Record<string, unknown>).succeeded ?? 0) : 0;
  const head = Number.isFinite(total) ? `${done}/${total} 步做成了` : "计划收尾了";
  const nodes = Array.isArray(fact.payload.nodes) ? (fact.payload.nodes as readonly SettledNode[]) : [];
  // WHAT THE STEPS PROVED, for every node that reported a row table - including one whose own state is `succeeded`,
  // because the table IS that node's answer: a `for_each` of sixty tiles proves which sixty, and `succeeded` alone does
  // not. Printed before the shortfalls, in the order the effect happened and then what did not.
  const proofs = nodes
    .filter((node) => node.state === "succeeded")
    .map((node) => proofLine(node))
    .filter((words): words is string => words !== "");
  const failures = nodes
    .filter((node) => typeof node.state === "string" && node.state !== "succeeded")
    .map((node) => failureWords(node))
    .filter((words): words is string => words !== "");
  const said = [...proofs, ...failures];
  const omitted = Number(fact.payload.omitted);
  const more = Number.isFinite(omitted) && omitted > 0 ? `（另有 ${omitted} 步未列出）` : "";
  return `- ${head}${more}${said.length === 0 ? "" : `：${said.join("；")}`}；${remainderSentence(nodes, reading)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// What is LEFT of the chore a settlement finished.
//
// WHY IT IS HERE. Measured `round69`: a script of 16 nodes cleared `weeds_cut 6`, and every health counter read 0 -
// `travel_postcondition_mismatch 0`, `destination_locked 0`, `nothing_pending 0`, `due 0` - and then the run sat idle
// for 2.8 minutes. Six weeds out of a field that has more, and the answer she was handed said `16/16 步做成了`: a
// settlement that never says what is left reads as a finished job, and there is nothing in it to plan the next turn
// from. The one thing every settlement omitted was the remainder of the chore it had just finished.
//
// WHAT IT COSTS. Nothing. The population is the reading this SAME message already carries (`<world-state>`), and the
// tiles it subtracts are the ones the settlement's own node rows prove were worked - `tile` on a single node, the
// pass's own row table for a `for_each`. No world query is made here and none may be: a second read would answer about
// a world later than the settlement, so the remainder could contradict the answer it sits beside.
//
// THE ONE THING THE HOST CANNOT DERIVE is WHICH family a step's work consumes. That is the Mod's declaration (its
// descriptor's `TargetFamily`, present only where the descriptor also declares what it `Clears`, because "how many
// machines are left" is not a chore), and the Mod mints it into the node's own verdict line as `chore=<family>`. A
// settlement whose steps say nothing about their chore states `还剩多少未测` rather than staying silent.
// ---------------------------------------------------------------------------------------------------------------

/** How many chore families one settlement's remainder names before it counts the rest. */
const MAX_REMAINDER_FAMILIES = 4;

/** How many of a family's remaining tiles it names - the same six the world block spends on a family it names there. */
const MAX_REMAINDER_TILES = 6;

/** One tile, as the reading and a node's own proof both spell it. */
type RemainderTile = Readonly<{ x: number; y: number }>;

/** What one finished chore has left, taken from the reading the settlement is delivered with. */
type ChoreRemainder = Readonly<{
  family: string;
  /** The word the world block uses for the same rows, so one family cannot be named two ways in one message. */
  label: string;
  left: number;
  /** Up to `MAX_REMAINDER_TILES` of the tiles still carrying the chore, nearest to her first. */
  nearest: readonly RemainderTile[];
}>;

/** The three states a chore family can be in, each named: work left, work done, rows this reading never carried. */
type ChoreReading = Readonly<{
  left: readonly ChoreRemainder[];
  done: readonly ChoreRemainder[];
  unmeasured: readonly string[];
}>;

/** The Mod's token for the family a step's work consumed, inside the node's verdict line. */
const CHORE_FIELD = "chore=";

/**
 * The states in which a node PROVED it did something.
 *
 * `partially_succeeded` is included on purpose: a pass that worked forty-five of sixty rows cleared forty-five, and
 * omitting it would report those forty-five tiles as work still to do.
 */
const PROVEN_EFFECT_STATES: ReadonlySet<string> = new Set(["succeeded", "partially_succeeded"]);

/**
 * The one sentence a settlement owes about what is left of its own chore.
 *
 * BOTH POLARITIES ARE REQUIRED. `还剩 杂草 14 处（最近 (66,15) …）` is what lets the next turn continue the job;
 * `这一类没剩（杂草）` is what lets her stop. A settlement that always said there was more would be as wrong as the
 * one this replaces, in the other direction.
 *
 * A THIRD ANSWER IS NAMED RATHER THAN SILENT: no reading in this delivery, or steps that never said which family they
 * worked, or a reading that does not carry the family at all. Each is a statement about what could not be measured,
 * which is a different fact from "nothing is left" and must never be spelled as one.
 */
function remainderSentence(nodes: readonly SettledNode[], reading: WorldStateReading | undefined): string {
  const chores = choreReading(nodes, reading);
  if (chores === undefined) return `${REMAINDER_LEAD}未测（${unmeasuredReason(reading, [])}）`;
  const named = chores.left.slice(0, MAX_REMAINDER_FAMILIES);
  const unmeasuredSuffix =
    chores.unmeasured.length === 0
      ? ""
      : `；${chores.unmeasured.slice(0, MAX_REMAINDER_FAMILIES).join("、")} 这一回合的观察里没有`;
  if (named.length > 0) {
    const parts = named.map(
      (chore) => `${chore.label} ${String(chore.left)} 处（最近 ${chore.nearest.map(tileWord).join(" ")}）`,
    );
    const rest = chores.left.length - named.length;
    return `${REMAINDER_LEAD}${parts.join("、")}${rest > 0 ? ` 等 ${String(chores.left.length)} 类` : ""}${unmeasuredSuffix}`;
  }
  if (chores.done.length > 0)
    return `${REMAINDER_LEAD}没剩（${chores.done
      .slice(0, MAX_REMAINDER_FAMILIES)
      .map((chore) => chore.label)
      .join("、")}）${unmeasuredSuffix}`;
  return `${REMAINDER_LEAD}未测（${unmeasuredReason(reading, chores.unmeasured)}）`;
}

/**
 * The words every remainder answer opens with, so ONE rule decides what a settlement says about its own remainder.
 *
 * It is a lead rather than three separate sentences because the answer is a fact of one shape with three values -
 * work left, none left, and could-not-be-measured - and a reader (or an audit) that finds this word has found the
 * answer whatever its value is.
 */
const REMAINDER_LEAD = "剩下的：";

/** Why a remainder could not be measured, in the one condition that applies. */
function unmeasuredReason(reading: WorldStateReading | undefined, families: readonly string[]): string {
  if (reading === undefined || reading.snapshot === null || typeof reading.snapshot !== "object")
    return "这一回合没有世界观察";
  if (families.length > 0) return `这一回合的观察里没有 ${families.join("、")}`;
  return "这一份结算没说是哪一类活";
}

/** A tile, spelled the one way this file spells a coordinate. */
function tileWord(tile: RemainderTile): string {
  return `(${String(tile.x)},${String(tile.y)})`;
}

/**
 * What each chore one settlement finished has left, from the settlement's own rows and the reading beside it.
 *
 * `undefined` means the question cannot be asked at all: no reading in this delivery, or not one settled step that
 * names the family it worked. A family the reading does not publish is `unmeasured`, never `0` - an absent family is
 * one the Mod did not measure, and the whole vocabulary of this block turns on that distinction.
 */
function choreReading(nodes: readonly SettledNode[], reading: WorldStateReading | undefined): ChoreReading | undefined {
  const worked = new Map<string, RemainderTile[]>();
  for (const node of nodes) {
    const family = choreFamilyOf(node);
    if (family === undefined) continue;
    const tiles = worked.get(family) ?? [];
    tiles.push(...workedTiles(node));
    worked.set(family, tiles);
  }
  if (worked.size === 0) return undefined;
  if (reading === undefined) return undefined;
  const snapshot = reading.snapshot;
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  const actor = snapshot.tile;
  const reach = (tile: RemainderTile): number =>
    Number.isFinite(actor?.x) && Number.isFinite(actor?.y)
      ? Math.max(Math.abs(tile.x - actor.x), Math.abs(tile.y - actor.y))
      : 0;
  const left: ChoreRemainder[] = [];
  const done: ChoreRemainder[] = [];
  const unmeasured: string[] = [];
  for (const [family, workedTilesOfFamily] of worked) {
    const label = TARGET_FAMILY_LABELS[family] ?? family;
    const rows = (snapshot as unknown as Record<string, unknown>)[family];
    if (!Array.isArray(rows)) {
      unmeasured.push(label);
      continue;
    }
    const taken = new Set(workedTilesOfFamily.map((tile) => `${String(tile.x)},${String(tile.y)}`));
    let remaining = 0;
    const rest: RemainderTile[] = [];
    for (const row of rows) {
      const tile = row === null || typeof row !== "object" ? undefined : rowTileOf(row as Record<string, unknown>);
      // A ROW THIS READING CANNOT PLACE IS STILL A ROW: counted as work left, and it cannot be named - the same rule
      // the world block follows for a family whose rows carry no tile.
      if (tile === undefined) {
        remaining += 1;
        continue;
      }
      if (taken.has(`${String(tile.x)},${String(tile.y)}`)) continue;
      remaining += 1;
      rest.push(tile);
    }
    const remainder: ChoreRemainder = Object.freeze({
      family,
      label,
      left: remaining,
      nearest: Object.freeze(
        rest
          .sort((a, b) => reach(a) - reach(b) || a.x - b.x || a.y - b.y)
          .slice(0, MAX_REMAINDER_TILES)
          .map((tile) => Object.freeze({ x: tile.x, y: tile.y })),
      ),
    });
    (remaining > 0 ? left : done).push(remainder);
  }
  if (left.length === 0 && done.length === 0 && unmeasured.length === 0) return undefined;
  // The family with the most work left first, so a cap becomes "the rest is smaller" rather than a lottery.
  left.sort((a, b) => b.left - a.left || a.family.localeCompare(b.family));
  return Object.freeze({ left: Object.freeze(left), done: Object.freeze(done), unmeasured: Object.freeze(unmeasured) });
}

/**
 * The family whose work one settled step consumed, as the Mod minted it: `…:chore=weedTargets`.
 *
 * Read from the node's own verdict line - the `:`-delimited `key=value` document the Mod already writes there
 * (`route_reentrant_terminal:state=…:request=…:revision=…`, `for_each_pass:decided=…:succeeded=…`) - so the family
 * arrives from the descriptor that declares it rather than from a table here that could drift from that declaration.
 * Present only on a step whose action declares what it CLEARS: a step that reads or loads a machine has no chore.
 */
function choreFamilyOf(node: SettledNode): string | undefined {
  if (typeof node.state !== "string" || !PROVEN_EFFECT_STATES.has(node.state)) return undefined;
  for (const field of [node.postconditionVerification, node.evidence]) {
    if (typeof field !== "string") continue;
    for (const segment of field.split(":")) {
      if (!segment.startsWith(CHORE_FIELD)) continue;
      const family = segment.slice(CHORE_FIELD.length);
      if (family !== "") return family;
    }
  }
  return undefined;
}

/**
 * The tiles one settled step proves it worked: its own tile, or the pass's own row table.
 *
 * A `for_each` settles ONE node for up to sixty-four rows, and its aggregate
 * (`{"state":…,"succeeded":N,…,"rows":[{"x":…,"y":…,"state":"succeeded"}]}`) is where those rows live - the
 * same document the settlement prints. Reading it is reading the producer's own table, never a second derivation.
 */
function workedTiles(node: SettledNode): readonly RemainderTile[] {
  if (node.tile !== undefined) return [node.tile];
  if (typeof node.evidence !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(node.evidence);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  const tiles: RemainderTile[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    if (entry.state !== "succeeded") continue;
    const tile = rowTileOf(entry);
    if (tile !== undefined) tiles.push(tile);
  }
  return tiles;
}

/**
 * The tile a row stands on, through the wire's own placement contract.
 *
 * NOT a guess and not a second table: `ROW_TILE_FIELD_PAIRS` is the declaration the world block places its rows with
 * (`x`/`y` for seventy-two families, `sourceX`/`sourceY` for `doorTargets` and `warps`), so a row this function cannot
 * place is one that block cannot place either.
 */
function rowTileOf(row: Record<string, unknown>): RemainderTile | undefined {
  for (const [xField, yField] of ROW_TILE_FIELD_PAIRS) {
    const x = row[xField];
    const y = row[yField];
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return undefined;
}
/**
 * One node's own proof of what it did: its action, the pass's verdict line, and the row table - all the Mod's bytes.
 *
 * <p>
 * NOTHING IS SUMMARISED HERE, and that is the point rather than an omission. A sixty-row table rendered as `60 格`/`45 格`
 * is the same drop one layer further out: the model already receives the count, and what it cannot reconstruct is WHICH
 * tile and what was on it. So the two fields are printed verbatim, in the producer's own spelling, under the producer's
 * own names' order - the `for_each_pass:decided=…` line first, because it is the sentence, and the table second, because
 * it is the evidence.
 * </p>
 *
 * <p>
 * WHY NO CEILING FROM `MODEL_FIELD_CEILINGS`. That table exists to stop a HOST-sized share of a line being spent on a
 * field whose producer declares no bound (`a receipt's evidence.detail`); these two are bounded at their producer
 * (1..4096, `BodyProgramValidation.IsOpaqueTerminalProof`) and the row table counts what it could not fit into that
 * number itself (`rowsOmitted`). A Host ceiling below the producer's would cut a table that is already whole, and it would
 * cut it at a `;` boundary that means nothing in a JSON document - the operator this file already recorded for `hint`.
 * </p>
 */
function proofLine(node: SettledNode): string {
  const words = proofTail(node);
  if (words === undefined) return "";
  const action = typeof node.actionId === "string" ? node.actionId : (node.nodeId ?? "一步");
  return `${action} ${words}`;
}

/**
 * One failed node in words: the Mod's own hint AND its own detail, each bounded, never one instead of the other.
 *
 * <p>
 * The hint is the SENTENCE that says what would fix it; `reasonDetail` is the EVIDENCE that makes the sentence
 * actionable (`owner=Pierre;owner_tile=4,17;actor_tile=5,19;radius=1`). Measured at `516e2559`, this function printed
 * `hint ?? detail`, so a node carrying both reached her with the sentence alone and the coordinates - the one part of the
 * refusal a guess cannot reconstruct - were dropped. A refusal she cannot decode is a refusal she answers by inventing a
 * world fact.
 * </p>
 *
 * <p>
 * The node's `reasonCode` is printed BESIDE both, never replaced by either - a run audit greps for
 * `shop_counter_out_of_reach`, and a sentence that only said the counter was out of reach would be a second vocabulary
 * for the same refusal (`round41`: six of those refusals reached the model as a bare code, which is why the sentence
 * exists; neither half may cost the other).
 * </p>
 */
function failureWords(node: SettledNode): string {
  const action = typeof node.actionId === "string" ? node.actionId : "一步";
  const code = typeof node.reasonCode === "string" && node.reasonCode !== "" ? node.reasonCode : undefined;
  // Sentence first, its evidence second: the order a reader needs them in. The separator is not `：`, which already
  // introduces the code, so the two halves stay distinguishable in the line. A node that ALSO carries a row table - the
  // `partially_succeeded` half of a batch - keeps it beside its reason, because the rows that did happen and the reason
  // for the ones that did not are one answer about one node.
  const words = [boundedField("hint", node.hint), boundedField("reasonDetail", node.reasonDetail), proofTail(node)]
    .filter((part): part is string => part !== undefined)
    .join("｜");
  const reason = words === "" ? code : code === undefined ? words : `${code}：${words}`;
  return reason === undefined ? `${action} 没做成` : `${action} 没做成（${reason}）`;
}

/**
 * The two proof fields, joined as one part of a line - or nothing at all when the node carried neither.
 *
 * The action is not named here: `failureWords` already opens with it, and `proofLine` names it for the succeeded node,
 * so a `partially_succeeded` row reads `for_each 没做成（…）` once rather than once per half.
 */
function proofTail(node: SettledNode): string | undefined {
  const words = [node.postconditionVerification, node.evidence]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join("｜");
  return words === "" ? undefined : words;
}

/**
 * The game clock a fact happened at, as `HH:MM ` - or nothing at all.
 *
 * `gameTime` is published on some world facts and not on others, and a receipt carries no game clock at all. An absent
 * clock prints as an empty prefix rather than as a Host wall-clock guess: the Host does not know what hour it is in the
 * game (`composeWorldState` states the age of the observation in turns for the same reason), and `08:12` invented from
 * `Date.now()` would be a fact.
 */
function clockOf(fact: WorldFact): string {
  if (typeof fact.gameTime !== "string") return "";
  const parsed = Number(fact.gameTime);
  if (!Number.isFinite(parsed)) return "";
  const clock = formatGameClock(parsed, true);
  return clock === "" ? "" : `${clock.replace(/（.*$/, "")} `;
}

/** One block, closed by its own name. */
function block(name: FactBriefBlock, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}
