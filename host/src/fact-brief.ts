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
import { CARRIED_BACKLOG_SEMANTIC_KIND, type HeldWorldDeclaration, heldWorldOf } from "./event-pump.js";
import {
  COUNTED_AFTER_THE_STEP,
  formatBodyState,
  formatGameClock,
  formatGameEnvironmentFacts,
  formatRipeCrops,
  MAX_COUNTED_FAMILIES_NAMED,
  MAX_TARGET_FAMILIES_SHOWN,
  NO_TARGET_FRESHNESS,
  nearbyTargetFamilies,
  ROW_TILE_FIELD_PAIRS,
  TARGET_FAMILY_LABELS,
  type TargetFreshness,
} from "./game-world-vocabulary.js";
import { boundedField, MAX_WORLD_FACT_LINES } from "./model-field-budget.js";
import type { Snapshot } from "./protocol.js";
import { describeRefusalRemedy } from "./stardew-action-remedy.js";

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
 * THE HEAD OF THE FIELD IN `<world-state>` THAT CARRIES AN ADDRESS RATHER THAN A SENTENCE.
 *
 * <p>
 * A narration line must read as a sentence. `5 份 防风草种子 (O)472 [槽 2]` does not: the qualified id and the slot marker
 * are the machine's spelling of where a row lives, welded into the middle of a Chinese sentence - and an input that prints
 * them in that position is the only teacher the model has, now that the floor no longer says "do not read ids aloud".
 * </p>
 *
 * <p>
 * WHY THIS PLACE IS REACHABLE WHEN SHE NEEDS TO PASS AN ID. `open_geode` refuses a request without
 * `slot` + `expectedQualifiedItemId` (`host/src/protocol.ts:3748`), `deposit_silo_hay` and `put_item_in_fish_tank` demand
 * `slot` alone - and every one of those numbers is on this field, in the same block, on the same turn, spelled exactly as
 * the wire spells it. Nothing has to be read out of a sentence and no observation call is owed to recover it.
 * </p>
 */
export const ADDRESSABLE_ROWS_HEAD = "可指代的行：";

/**
 * THE HEAD OF THE FIELD IN `<world-facts>` AND `<execution-result>` THAT CARRIES AN ADDRESS RATHER THAN A SENTENCE.
 *
 * <p>
 * The same split `<world-state>` made, one block over. A refusal's sentence says what she can do about it, and the
 * machine's half - `reasonCode=gift_given`, `location=Farm;item=(O)472`, `slot=`, `target=` - is what a LATER tool
 * argument copies, so it prints verbatim, under a head that says it is an address. Both halves are in one delivery, one
 * block, one line apart: nothing has to be read out of a sentence, and no id is lost to the prose that carries it.
 * </p>
 *
 * <p>
 * WHY THE IDS MAY NOT SIMPLY LEAVE. `open_geode` refuses a request without `slot` + `expectedQualifiedItemId`
 * (`host/src/protocol.ts:3748`), and `rockSourceTargets` rows are addressed by the `target=` an id names. A report that
 * dropped them would read better and leave her unable to take the step it just described.
 * </p>
 */
export const ADDRESSABLE_FACTS_HEAD = "可指代的字段：";

/**
 * Every field of this block whose content is the machine's rather than a sentence, so a reader - and the gate
 * `a_line_the_model_reads_is_not_a_machine_token` - can tell a report from an address.
 *
 * THE LIST IS THE COMPOSER'S OWN: `composeWorldState` emits a line under each of these heads and nothing else does, so the
 * gate reads this declaration instead of retyping the heads it has to skip.
 */
export const MACHINE_FIELD_HEADS: readonly string[] = Object.freeze([ADDRESSABLE_ROWS_HEAD, ADDRESSABLE_FACTS_HEAD]);

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
   * The node's own proof, verbatim, from the Mod's `BodyProgramJournalNode.Evidence`.
   *
   * TWO SHAPES, ONE FIELD, because the producer puts both here. A `for_each` settles ONE node for sixty tiles, so its
   * evidence is the pass's own row table - `round63` read it as `{"nodeId":"n02","actionId":"for_each","state":
   * "succeeded"}`: fifteen tiles tilled, forty-five untouched, and not one tile named. A single settled action's evidence
   * is instead the receipt's own detail (`crop_harvested`'s `location=…;tile=…`, projected one-to-one onto
   * `evidence.detail`).
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
  /**
   * The family this step's work consumed, typed - the Mod's `BodyProgramJournalNode.Chore`.
   *
   * THE FIELD A SETTLEMENT NAMES ITS CHORE IN, and the one fact this file cannot derive: that a step consumed a family is
   * the Mod's own declaration. Until it existed the family travelled only inside the `chore=<family>` clause of the two
   * strings above, and this file found it by scanning them - a separator, a reordering or a renamed key silently turned a
   * finished chore into `未測` (`round73`: 205 mints in the log, 9 of 9 remainders reading as silence).
   *
   * Present only on a step that PROVED an effect, which is the same rule `evidence` follows: a step that proved nothing
   * finished no chore. Absent is a fact about this settlement, never a claim that nothing is left.
   */
  chore?: string;
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
  /**
   * The tiles a node of a programme still in flight addressed, so the state block stops offering them (`TargetFreshness`).
   *
   * Absent means no plan is queued, which is the truth for every caller that has no journal at all (the Chat surface's own
   * reader, and the steer, which states no block in the first place).
   */
  inFlightTiles?: ReadonlySet<string>;
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
  const state = composeWorldState(
    input.snapshot,
    provedPackCounts(input.events),
    provedGoneTargets(input.events),
    input.inFlightTiles,
    publishedSceneWords(input.events),
  );
  if (state !== "") blocks.push(state);
  const settlements = input.events.filter((fact) => fact.semanticKind === PROGRAM_SETTLED);
  const facts = input.events.filter((fact) => fact.semanticKind !== PROGRAM_SETTLED);
  const factBlock = composeWorldFacts(facts, worldBeside(input.snapshot, facts));
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
 *
 * THE TARGET FAMILIES ARE COMPOSED FROM THE SAME DELIVERY'S PROOFS, not from the reading alone: `provedGone` is what the
 * batch's own receipts took out of the world (`provedGoneTargets`), and a row it names is not printed - because an id the
 * Mod has already answered `_gone` for is an address to nothing (`round78`: eight stones printed under a receipt block
 * naming six of them broken). It is passed as its own argument rather than folded into `provedPack`, which is a map of
 * ITEM COUNTS: the two proofs answer two different questions and a single shape would let one be read as the other.
 *
 * `inFlightTiles` IS THE THIRD, AND IT IS NEITHER A PROOF NOR A COUNT. Those are the tiles the journal says a programme still
 * in flight addressed: nothing has happened there, and they are still not offerable, because the turn this block opens is
 * the one that plans the next programme. A queue read as a proof would be a lie in the other direction, so the two keep
 * their own arguments and the line states them apart.
 */
export function composeWorldState(
  reading: WorldStateReading | undefined,
  provedPack: ReadonlyMap<string, number> = NO_PACK_FRESHNESS.proved,
  provedGone: ReadonlySet<string> = NO_TARGET_FRESHNESS.gone,
  inFlightTiles: ReadonlySet<string> = NO_TARGET_FRESHNESS.inFlight,
  sceneWordsPublished: boolean | undefined = undefined,
): string {
  if (reading === undefined) return block("world-state", NOTHING_OBSERVED);
  const world = reading.snapshot;
  if (world === null || typeof world !== "object") return block("world-state", NOTHING_OBSERVED);
  const freshness: PackFreshness = Object.freeze({ proved: provedPack, ageTurns: reading.ageTurns });
  const targetFreshness: TargetFreshness = Object.freeze({
    gone: provedGone,
    inFlight: inFlightTiles,
    ageTurns: reading.ageTurns,
  });
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
  const money = formatOwnMoney(world);
  if (money !== "") parts.push(money);
  const body = formatBodyState(world, true);
  if (body !== "") parts.push(body);
  const ripeCrops = formatRipeCrops(world, true);
  if (ripeCrops !== "") parts.push(ripeCrops);
  const canWater = formatCarriedCanWater(world);
  if (canWater !== "") parts.push(canWater);
  const carrying = formatCarrying(world, freshness);
  if (carrying.prose !== "") parts.push(carrying.prose);
  const seeds = formatHeldSeeds(world, freshness);
  if (seeds !== "") parts.push(seeds);
  const lines: string[] = [worldStateHeader(reading)];
  const paragraph = parts.join("；");
  if (paragraph !== "") lines.push(paragraph);
  const scene = sceneContentLine(world, sceneWordsPublished);
  if (scene !== "") lines.push(scene);
  lines.push(...composeNearbyTargets(world, targetFreshness));
  // THE ADDRESS GOES LAST, UNDER ITS OWN HEAD. A reader who wants an id or a slot reads this line; a reader who wants the
  // world reads the paragraph above it, and the two never share a line - which is what stops a sentence from having a
  // machine token in its spine.
  if (carrying.addressable.length > 0) lines.push(`${ADDRESSABLE_ROWS_HEAD}${carrying.addressable.join("；")}`);
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
 * THE LINE THAT NAMES A SCENE HOLD'S CONTENT AS UNPUBLISHED, and the whole string the model reads when it is.
 *
 * <p>
 * MEASURED (a live run, day 1 12:30): the vanilla Community Center event fired - `event_up=true`,
 * `Warping to CommunityCenter` - `express_emote` was refused `cutscene_active`, and `<world-state>` said
 * `身体: 忙 · 持有: event · 可由指令接管: 否 · 下一步: 下一回合` and nothing else about the scene. She filled the silence
 * with Lewis's own dialogue and his plan to sell the center to JOJA: one of the 59 lines that run said, and the one
 * `companion_interaction_gate` refused as `unobserved_event`. THE HOLD WORD INVITED EXACTLY THE INVENTION THE GATE THEN
 * PUNISHED - the same shape as the `narrate rather than act` guidance that was deleted for it.
 * </p>
 *
 * <p>
 * WHY THE LINE STATES THE PUBLICATION AND NOT THE SCENE. The scene's identity and its lines ARE readable inside the Mod
 * (`Game1.CurrentEvent`, its `actors`, and the box's page through `DialogueBox.getCurrentString`), and its words already
 * reach her as facts of their own: `modal_presented.text` is the page the box shows at the mount,
 * `npc_dialogue_presented.pages` is the transcript the pager reached. What the wire does not carry is the event's own
 * identity and the script it has not shown yet - so the block says what it can answer about them. It says the content
 * is NOT PUBLISHED, and in the other direction it says nothing at all: the words are the facts block's, and a second
 * copy here would be one fact in two spellings.
 * </p>
 */
const SCENE_CONTENT_UNPUBLISHED = "过场: 内容未发布（谁在场、说了什么、在演什么，都没有发布）";

/** The wire's `actorDispositionKind` for "the engine is running a scene" (`WorldModel.KindForWire`). */
const SCENE_HOLD_KIND = "event";

/**
 * The block's line for a body held by a scene, or `""` when this composition has nothing to say about its content.
 *
 * `event` is the wire's kind for four engine causes - a cutscene, a minigame, the day transition and a control freeze
 * (`WorldModel.EventHoldDriver`) - and the snapshot names none of them, so this line cannot name the cause either. What
 * it can answer is the question the model actually got wrong: has anything about this scene been published.
 *
 * `undefined` IS NOT `false`. The claim is about a DELIVERY - which words it carried - and a block composed from a
 * snapshot alone (`stardew_observe`'s answer, `game-tools.ts`) has no delivery to speak about: it would answer
 * `内容未发布` in a turn whose own message already quoted the box, one statement contradicting the other inside one turn.
 * So a caller that cannot answer makes no claim, and the per-turn block - the one the model plans from - always can.
 */
function sceneContentLine(world: Snapshot, sceneWordsPublished: boolean | undefined): string {
  if (world.actorDispositionKind !== SCENE_HOLD_KIND) return "";
  return sceneWordsPublished === false ? SCENE_CONTENT_UNPUBLISHED : "";
}

/**
 * Whether this delivery published any of the words the scene on screen is saying.
 *
 * THE SCENE'S WORDS ARRIVE AS FACTS, never on the snapshot: the box's page at its mount (`modal_presented.text`) and the
 * paged-through transcript (`npc_dialogue_presented.pages`). So `<world-state>` may say the content is unpublished only
 * while neither is in the delivery - and a null page or an empty one is not words, which is why both halves are trimmed
 * rather than tested for presence.
 */
function publishedSceneWords(events: readonly WorldFact[]): boolean {
  return events.some((fact) => {
    if (fact.semanticKind === "modal_presented")
      return typeof fact.payload.text === "string" && fact.payload.text.trim() !== "";
    if (fact.semanticKind === "npc_dialogue_presented")
      return (
        Array.isArray(fact.payload.pages) &&
        fact.payload.pages.some((page) => typeof page === "string" && page.trim() !== "")
      );
    return false;
  });
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
 * THE SLOT AND THE ID ARE THE ADDRESS, AND THEY MOVE TO `ADDRESSABLE_ROWS_HEAD`. `slot` and
 * `expectedQualifiedItemId` are the pair `open_geode` demands (`host/src/protocol.ts:3748`), `slot` alone is what
 * `deposit_silo_hay` and `put_item_in_fish_tank` demand - and this line used to drop the slot it was handed, so the number
 * she is asked for was a number she was never shown. They are still printed, one line per row under the head that says they
 * are an address, in the same block and the same turn. WHAT DOES NOT COME BACK is their place inside the sentence: `5 份
 * 防风草种子 (O)472 [槽 2]` is not a sentence, and it is the shape a run learned to answer with ids from. The row's
 * `displayName` is the name and cannot substitute for the id - two stacks of the same item share a name, and no action
 * accepts a name - which is exactly why the two are split rather than merged.
 *
 * THE CAP NAMES WHERE THE REST IS. A truncated row cannot be addressed from here, so the sentence says which reading
 * carries the slots this bound dropped (`stardew_observe` publishes the whole family) rather than counting them into a
 * silence.
 */
type CarriedPack = Readonly<{ prose: string; addressable: readonly string[] }>;

/** No `inventoryItemFacts` family at all: neither a sentence nor an address, which is not the same as an empty pack. */
const NO_CARRIED_PACK: CarriedPack = Object.freeze({ prose: "", addressable: Object.freeze([]) });

function formatCarrying(world: Snapshot, freshness: PackFreshness = NO_PACK_FRESHNESS): CarriedPack {
  const rows = world.inventoryItemFacts;
  if (!Array.isArray(rows)) return NO_CARRIED_PACK;
  const seeds = plantableSeedIds(world);
  const named = rows
    .filter((row) => typeof row?.displayName === "string" && row.displayName.trim() !== "")
    .filter((row) => !seeds.has(row.qualifiedItemId))
    // THE MAPPED ROW KEEPS THE WIRE'S OWN NAMES. An alias (`name: row.displayName`) is how the drop this function is
    // written against became invisible: a reader of the map saw `name` and `stack` and could not see that the slot had
    // been left behind. `tools/check-inventory-row-field-rendering.mjs` reads these names against the schema's own.
    .map((row) => {
      const proved = freshness.proved.get(row.qualifiedItemId);
      return {
        displayName: row.displayName.trim(),
        qualifiedItemId: row.qualifiedItemId,
        slot: row.slot,
        stack: proved ?? (Number.isFinite(row.stack) ? Number(row.stack) : 1),
        source: packCountSource(proved),
        proved: proved !== undefined,
      };
    });
  if (named.length === 0) return Object.freeze({ prose: "身上没有别的东西", addressable: Object.freeze([]) });
  const shown = named.slice(0, MAX_CARRYING_ROWS);
  const sentences = shown.map((row) => `${String(row.stack)} 份 ${row.displayName}${row.source}`);
  // THE ADDRESS IS THE PAIR AN ARGUMENT TAKES, under the name the sentence calls the row, so the two halves can be joined
  // without a second read of the world.
  const addressable = shown.map((row) => `${row.displayName} 槽 ${String(row.slot)} ${row.qualifiedItemId}`);
  const rest = named.length - shown.length;
  // The age covers the rows this line PRINTS: a row the bound dropped is not a count she was handed.
  const aged = packCountsAge(shown.filter((row) => row.proved).length, shown.length, freshness.ageTurns);
  return Object.freeze({
    prose: `身上带着 ${sentences.join("、")}${rest > 0 ? ` 其余 ${String(rest)} 种未列出（全都要看用 stardew_observe，那里的每一行都带槽号）` : ""}${aged}`,
    addressable: Object.freeze(addressable),
  });
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
 * The pack counts THIS DELIVERY has already counted, from the Mod's own receipts.
 *
 * <p>
 * THE VALUE IS A COUNT, keyed by the row's `qualifiedItemId`: the Mod's own post-action sum, never a derived one.
 * </p>
 *
 * <p>
 * WHY. Measured `round75`: `<world-state>` printed `种子: 2 花椰菜种子` on all fourteen refusal turns of a stretch in
 * which she had planted both seeds, and the deliveries in that stretch carried `inventory_after=1` and then
 * `inventory_after=0` in their own receipts. The state line kept its mint-time number while the message it arrived in
 * carried the corrected one: one fact, two spellings, and the stale one at the top where it reads as the present tense.
 * </p>
 *
 * <p>
 * THE QUANTITY IS THE SAME ONE, VERIFIED RATHER THAN ASSUMED. `plant_seed`'s `inventory_after` is
 * `Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0)`
 * (`integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs:387`), which is the same sum
 * `seedSupplyTargets[].heldCount` is built from - so this is the Mod's own answer to the question the seed line asks,
 * taken later. Nothing is derived here and nothing is inferred: an evidence string without `item=` and a numeric
 * `inventory_after=` proves nothing, and a refusal carries neither.
 * </p>
 *
 * <p>
 * BOTH SHAPES REACH HER, so both are read: a bare `execution_receipt` (`receiptLine` prints its detail) and a settled
 * body programme, whose nodes carry the same receipt detail as `node.evidence` (`program-settlement-digest.ts`). Later
 * events win, because events are ordered oldest first and the last count is the one that is still true.
 * </p>
 */
export function provedPackCounts(events: readonly WorldFact[]): ReadonlyMap<string, number> {
  const proved = new Map<string, number>();
  const record = (detail: unknown): void => {
    if (typeof detail !== "string" || detail === "") return;
    const pairs = evidencePairs(detail);
    const item = pairs.get("item");
    if (item === undefined || item === "") return;
    const raw = pairs.get("inventory_after");
    if (raw === undefined || !/^\d+$/u.test(raw)) return;
    proved.set(item, Number(raw));
  };
  for (const fact of events) {
    if (fact.kind === "execution_receipt") {
      record((fact.payload.evidence as { detail?: unknown } | undefined)?.detail);
      continue;
    }
    if (fact.semanticKind !== PROGRAM_SETTLED) continue;
    if (!Array.isArray(fact.payload.nodes)) continue;
    for (const node of fact.payload.nodes as readonly SettledNode[]) record(node.evidence);
  }
  return proved;
}

/**
 * The target rows THIS DELIVERY's receipts proved are out of the world, keyed by the row's own opaque id.
 *
 * <p>
 * WHY. Measured `round78` (2026-11-19, the mine window, her own session): six `break_rock` receipts at revisions 112-123
 * broke six stones while the reading she held was `revision 108`, and the delivery that arrived after them printed
 * `石头 (6,5) (5,5) (5,6) (11,7) (11,8) (4,9) 其余 2 格未列出` - all eight rows, every broken one among them - a few lines
 * under its own `<execution-result>` naming those stones as `rock_source_broken`. Her next plan wrote
 * `snapshot.rockSourceTargets.slice(0, 4)`, the first four rows of that same stale array, and the Mod answered
 * `rock_source_gone` four times: four empty nodes and a wasted round. The count beside it in the same block already had
 * the fix (`30 份 石头（pickup_item 之后数的）`); the row list did not.
 * </p>
 *
 * <p>
 * THE PROOF IS THE MOD'S OWN, and it has two spellings because the Mod publishes two: a receipt that took the row out
 * says `removed=true` (`farmhandexecutioncontroller.resourcetoolactions.cs:310`), and a request whose row the world no
 * longer holds is answered with a reason code ending `_gone` - `rock_source_gone`, `item_target_gone`,
 * `animal_product_target_gone`, `pet_target_gone`, `farm_animal_target_gone`, `npc_relationship_target_gone`,
 * `npc_interaction_target_gone`. Every one of those codes means the row this request named is not in the world, so no
 * table of families is needed and no family has to be named here: the code's own word is the proof. The row's id has to
 * be in the evidence as well, which is what keeps a `_gone` code that names no row (`clear_blocker_gone`) out.
 * </p>
 *
 * <p>
 * THE ROW'S ID is the pair the Mod names it by - `target=` in both spellings, `expected=` for `item_target_gone` - which
 * is the same id the row publishes as `targetId` and the plan copies as `expectedTargetId`. A detail with neither pair
 * proves nothing, and a refusal that names another row does not touch this one.
 * </p>
 *
 * <p>
 * THE RESULT IS IDS AND NOTHING ELSE. Which action took a row out is the receipt's own statement, printed by `receiptLine`
 * in the same delivery with its own action id and evidence; a row list that also spelled the action gave one fact two
 * vocabularies, and the copy in a sentence is the one a run learned to answer with.
 * </p>
 *
 * BOTH SHAPES REACH HER, for the same reason `provedPackCounts` reads both: a bare `execution_receipt` and the nodes of a
 * settled body programme carry the same Mod detail. Later events win.
 *
 * <p>
 * A TILLED TILE IS THE SECOND KIND OF PROOF, and it needs no `_gone` code: `till_soil` states the tiles it turned into
 * HoeDirt (`changed=62:19|62:20`, the whole footprint of the charge), and the row standing there is addressed by that
 * same tile because it carries no id (`rowTargetId` in `game-world-vocabulary.ts`). Measured `round80`: a reading taken
 * before the Hoe went in still said `hoeDirt: false` about tiles `plan_258`'s own seven successes had just tilled, so the
 * line offered them as ground to hoe and the Mod answered `soil_already_tilled` 54 times in eighteen minutes. The tile
 * leaves the row list for the one delivery that carries both the stale reading and the receipt; the next observation
 * publishes it as the plantable tile it now is. SUBTRACTING IS THE SAFE DIRECTION: a tile that is not offered cannot be
 * worked twice, while a tile offered after the work is done is the defect this reads for.
 * </p>
 */
export function provedGoneTargets(events: readonly WorldFact[]): ReadonlySet<string> {
  const gone = new Set<string>();
  const record = (detail: unknown, reasonCode: unknown): void => {
    if (typeof detail !== "string" || detail === "") return;
    const pairs = evidencePairs(detail);
    if (reasonCode === SOIL_TILLED_REASON_CODE) {
      for (const tile of tilledTiles(pairs)) gone.add(tile);
      return;
    }
    const target = pairs.get("target") ?? pairs.get("expected");
    if (target === undefined || target === "") return;
    const removed = pairs.get("removed") === "true";
    const settled = typeof reasonCode === "string" && reasonCode.endsWith(GONE_REASON_SUFFIX);
    if (!(removed || settled)) return;
    gone.add(target);
  };
  for (const fact of events) {
    if (fact.kind === "execution_receipt") {
      record((fact.payload.evidence as { detail?: unknown } | undefined)?.detail, fact.payload.reasonCode);
      continue;
    }
    if (fact.semanticKind !== PROGRAM_SETTLED) continue;
    if (!Array.isArray(fact.payload.nodes)) continue;
    for (const node of fact.payload.nodes as readonly SettledNode[]) record(node.evidence, node.reasonCode);
  }
  return gone;
}

/** The Mod's own word for "the row this request named is out of the world": `rock_source_gone`, `item_target_gone`. */
const GONE_REASON_SUFFIX = "_gone";

/** The Mod's own word for "this receipt turned the tile it names into HoeDirt" (`hasTillSoilCompletionEvidence`). */
const SOIL_TILLED_REASON_CODE = "soil_tilled";

/** One tile as the Mod's evidence spells it: `62:19`, with its sign when the map runs negative. */
const EVIDENCE_TILE = /^-?(?:0|[1-9]\d*):-?(?:0|[1-9]\d*)$/u;

/**
 * The tiles a tilling receipt says it moved, in the Mod's own spelling: the `changed` footprint of the charge, or the
 * single `target=` tile on a Mod older than that pair.
 *
 * `changed=none` is the receipt saying nothing moved, and mints nothing: the same rule the completion contract reads it
 * by, where the count and the named tiles have to agree before the receipt is a measurement.
 */
function tilledTiles(pairs: ReadonlyMap<string, string>): readonly string[] {
  const changed = pairs.get("changed");
  const spelled = changed === undefined ? [pairs.get("target") ?? ""] : changed === "none" ? [] : changed.split("|");
  return spelled.filter((tile) => EVIDENCE_TILE.test(tile));
}

/** The `key=value` pairs of one Mod evidence detail: `location=Farm;item=(O)472;inventory_after=0`. */
function evidencePairs(detail: string): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>();
  for (const part of detail.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return pairs;
}

/**
 * What THIS DELIVERY already knows about the pack, and how old the reading is.
 *
 * <p>
 * The two halves of the freshness question for a pack count, kept beside each other because a renderer that took one
 * without the other could print a count with neither a source nor an age.
 * </p>
 */
type PackFreshness = Readonly<{
  proved: ReadonlyMap<string, number>;
  ageTurns: number;
}>;

const NO_PACK_FRESHNESS: PackFreshness = Object.freeze({ proved: new Map<string, number>(), ageTurns: 0 });

/**
 * The qualifier a count carries when a receipt in THIS delivery re-counted it, or `""`.
 *
 * <p>
 * A count with no qualifier reads as the present tense, which is the defect: `<world-state>` printed `种子: 2` for fifty
 * turns while the deliveries it arrived in carried `inventory_after=0`. Saying that a step re-counted it is what makes
 * "0" a statement about a moment rather than a guess - and it is derived, never written: `proved` is the Mod's own
 * post-action sum. WHICH STEP is not named, and that is deliberate: the receipt that took the count is printed by
 * `receiptLine` with its own action id in the same delivery, so naming it here would be one fact in two vocabularies.
 * </p>
 */
function packCountSource(proved: number | undefined): string {
  return proved === undefined ? "" : `（${COUNTED_AFTER_THE_STEP}）`;
}

/**
 * The aging tail of a pack line: how old the counts on it are, for the rows no receipt re-counted.
 *
 * <p>
 * The age is stated ONCE rather than on every row, because it is the whole reading's age and not a row's - but the
 * wording distinguishes the mixed case, where a bare `（3 轮前数的计数）` would read as applying to the rows a receipt
 * has just counted.
 * </p>
 */
function packCountsAge(provedRows: number, totalRows: number, ageTurns: number): string {
  if (ageTurns < 1 || provedRows >= totalRows) return "";
  return provedRows > 0 ? `（其余是 ${String(ageTurns)} 轮前数的计数）` : `（${String(ageTurns)} 轮前数的计数）`;
}
/** The seed line's own name for the one question the observation cannot answer (`round67`'s 80 g shop). */
const AFFORDABILITY_GAP = "（买种子的钱: 未观察）";

/**
 * Her wallet's balance as the wire published it, or `null` when it published no readable one.
 *
 * <p>
 * THE ONE SPELLING OF "IS THE WALLET OBSERVED". Two lines ask it - the wallet line prints the figure, and the seed line
 * prints its `未观察` gap only while there is no figure - so both read this, and what counts as a readable balance moves
 * them together instead of leaving two spellings of one fact to disagree.
 * </p>
 */
function readOwnMoney(world: Snapshot): number | null {
  const money = world.money;
  return typeof money === "number" && Number.isSafeInteger(money) && money >= 0 ? money : null;
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
 *
 * <p>
 * AND THE MONEY QUESTION IS NAMED AS UNMEASURED ONLY WHILE IT IS, WHICH IS THE FACT AND NOT A SHRUG. Measured
 * 2026-11-18 (`round67`): she priced a seed at 80 g and concluded 「I have little money」 with nothing to read - the
 * absence of a number read as a number - so the line that carries the count named the gap. It used to append it
 * unconditionally, because the wire published no balance at all; `protocol.ts` publishes `money` now and `formatOwnMoney`
 * prints it in the same paragraph, so the gap is DERIVED from that one reading (`readOwnMoney`): it is printed only when
 * the wallet line printed nothing. Measured `round88`: `<world-state>` rendered 18 times and every one carried
 * `金币: 500` beside `种子: 2 花椰菜种子（买种子的钱: 未观察）` - one fact in two spellings, contradicting itself inside
 * one line. The seed line says what the wallet line cannot (which seeds), and nothing about what it can (what they cost).
 * </p>
 */
function formatHeldSeeds(world: Snapshot, freshness: PackFreshness = NO_PACK_FRESHNESS): string {
  const rows = world.seedSupplyTargets;
  if (!Array.isArray(rows)) return "";
  // DERIVED, NOT APPENDED: the gap claims the balance is unobserved, so it is printed only when the wallet line above
  // printed nothing. With a readable `money` the seed line has nothing left to say about affordability.
  const gap = readOwnMoney(world) === null ? AFFORDABILITY_GAP : "";
  if (rows.length === 0) return `种子: 0（背包里没有种子）${gap}`;
  const seeds: string[] = [];
  const seen = new Set<string>();
  let provedSeeds = 0;
  for (const row of rows) {
    if (seen.has(row.qualifiedItemId)) continue;
    seen.add(row.qualifiedItemId);
    const name =
      typeof row.displayName === "string" && row.displayName.trim() !== "" ? row.displayName.trim() : "未命名的种子";
    const proved = freshness.proved.get(row.qualifiedItemId);
    if (proved !== undefined) provedSeeds += 1;
    const count = proved ?? (Number.isFinite(row.heldCount) ? Number(row.heldCount) : null);
    seeds.push(count === null ? `${name}（数量未测）` : `${String(count)} ${name}${packCountSource(proved)}`);
  }
  return `种子: ${seeds.join("、")}${packCountsAge(provedSeeds, seeds.length, freshness.ageTurns)}${gap}`;
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
/**
 * Her own wallet, in the shape her health and stamina are written in.
 *
 * <p>
 * WHY IT IS HERE (measured 2026-11-21, `round87b`). The wire published no money field at all, so every seed-shortage
 * fact ended in `affordability_unknown` and nothing could compare a price with a balance: `round87b`'s `Day` 3 sent
 * `shop_purchase({expectedQualifiedItemId: "(O)378", quantity: 15})` at 75g a unit with 35g in hand, and the refusal
 * only arrived from the game (`insufficient_money ... price=75; available=35; short=40`). `protocol.ts` now publishes
 * `money`, which a field renders or an exemption declares - and a published field no renderer reads is not a fact she
 * has.
 * </p>
 *
 * <p>
 * ABSENT PRINTS NOTHING: an unread wallet is silence, never `0` and never "she can afford it", the same rule
 * `formatOwnHealth` follows for hit points and `formatGameStamina` for stamina. It is also the reading the seed line's
 * `未观察` gap is derived from (`readOwnMoney`), so the two lines cannot claim different things about one wallet.
 * </p>
 */
function formatOwnMoney(world: Snapshot): string {
  const money = readOwnMoney(world);
  return money === null ? "" : `金币: ${String(money)}`;
}

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
 *
 * `freshness` is handed straight to `nearbyTargetFamilies`, which owns both halves of the row question: rows this
 * delivery proved out of the world, and how old the rest of the reading is.
 */
function composeNearbyTargets(world: Snapshot, freshness: TargetFreshness = NO_TARGET_FRESHNESS): readonly string[] {
  const families = nearbyTargetFamilies(world, freshness);
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
  // A family the snapshot published as EMPTY belongs to the "nothing here" line - except the family whose emptiness is
  // itself a statement about what was WITHHELD (`otherFarmersOmitted`): that one carries its own sentence above, and
  // listing it here as well would say "there is nobody" about a count that says there is.
  const empty = families
    .filter((family) => family.total === 0 && family.rendered === undefined)
    .map((family) => family.label);
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

/**
 * What each declaration of a HELD WORLD means, in the words the model reads.
 *
 * <p>
 * Keyed by the declaration union (`HELD_WORLD_DECLARATIONS`) rather than by a kind name, so a producer that starts
 * declaring a hold is rendered without a second table - and a declaration added to that union is a compile error here
 * instead of a `modal_presented` line that silently stops saying why the world stopped. The KEY is printed nowhere: the
 * sentence is what the model reads, the field name is what an operator greps in the Mod.
 * </p>
 */
export const HELD_WORLD_ZH: Readonly<Record<HeldWorldDeclaration, string>> = Object.freeze({
  isQuestion: "在等你回答",
  blocksTimePass: "时间停住了",
});

/**
 * `<world-facts>`: one line per event, the oldest first, the remainder counted, and every address on one line at the end.
 *
 * <p>
 * EVERY LINE SAYS WHICH WORLD IT BELONGS TO, and that is the half `round91` was missing. MEASURED 2026-11-20 (`round91`):
 * `plan_423` failed `door_out_of_range ... actor=9,9` inside the FarmHouse at revision 473 with no presentation lease, so
 * the pump carried it; 130 ms before it was handed over `enter_exit` completed into the Farm at `64,15` at revision 481,
 * and the carried refusal arrived behind it as `<world-facts>` with no `<world-state>` - a steer states no reading
 * (`round77`). Her own thinking, from the session: "the earlier plan said enter_exit succeeded to Farm 64,15, but then
 * this new fact says she is at 9,9 near door 3,12... Confusing hybrid", and she planned a walk back to a door in a room
 * she had left.
 * </p>
 *
 * <p>
 * A FACT'S REVISION IS PART OF WHAT MAKES IT TRUE, so a line that is late says so in its own line: `at_revision=<r>` is
 * the world the fact was minted in, and `stale_because=revision <W>` names the newer world it reads beside. A line at that
 * newer world says `current` instead, so a fact with no `<world-state>` beside it can never be read as if it were. Both
 * are spelled with the revision `<world-state>` itself states, so the two blocks are joined by one number rather than by a
 * second vocabulary.
 * </p>
 *
 * <p>
 * A FACT THAT STATES NO REVISION GETS NO MARK, and that is not an absence standing in for an answer: `revision` 0 is what
 * the pump writes for the facts IT mints (`takeCarriedBacklogFact` and its neighbours - statements about the Host's own
 * ledger, not about the world), so there is no world claim to qualify. Every fact the Mod publishes carries its revision,
 * which is why the defect this renders for is one no producer can state its way out of.
 * </p>
 */
function composeWorldFacts(events: readonly WorldFact[], world: number | undefined): string {
  const rendered = events.flatMap((fact) => {
    const rendering = factLine(fact);
    return rendering === null ? [] : [{ fact, rendering }];
  });
  if (rendered.length === 0) return "";
  const shown = rendered.slice(0, MAX_WORLD_FACT_LINES);
  const rest = rendered.length - shown.length;
  const lines = shown.map((entry) => `${entry.rendering.narration}${worldMark(entry.fact.revision, world)}`);
  if (rest > 0) lines.push(`其余 ${rest} 条未列出`);
  const addresses = shown
    .map((entry) => entry.rendering.address)
    .filter((address): address is string => address !== null);
  if (addresses.length > 0) lines.push(`${ADDRESSABLE_FACTS_HEAD}${addresses.join("；")}`);
  return block("world-facts", lines.join("\n"));
}

/**
 * The world a `<world-facts>` block reads beside: the reading the delivery states, or - for a delivery that states no
 * reading at all, which is every steer after `round77` - the newest revision among the facts themselves.
 *
 * The reading is asked first because it is the one a reader can see: a batch states its revision under `<world-state>`, and
 * a fact that disagrees with that stated world is the fact this whole rendering exists for. A reading that states no world
 * (`revision` 0, before the first observation) falls back to the block's own newest fact, so two late facts beside each
 * other still order themselves correctly.
 */
function worldBeside(reading: WorldStateReading | undefined, facts: readonly WorldFact[]): number | undefined {
  if (reading !== undefined && Number.isFinite(reading.revision) && reading.revision > 0) return reading.revision;
  const stated = facts.map((fact) => fact.revision).filter((revision) => Number.isFinite(revision) && revision > 0);
  return stated.length === 0 ? undefined : Math.max(...stated);
}

/**
 * Which world one `<world-facts>` line belongs to: `current` for the world it reads beside, the fact's own revision and the
 * newer world for a line that is late, and nothing at all for a fact whose producer stated no world.
 */
function worldMark(revision: number, world: number | undefined): string {
  if (!Number.isFinite(revision) || revision <= 0) return "";
  if (world === undefined || revision >= world) return " ·current";
  return ` ·at_revision=${String(revision)};stale_because=revision ${String(world)}`;
}

function factLine(fact: WorldFact): FactRendering | null {
  const at = clockOf(fact);
  switch (fact.kind) {
    case "snapshot":
      // The snapshot is the state block, not news; printing it twice is the duplication this whole change removes.
      return null;
    case "execution_receipt":
      return receiptLine(fact, at);
    case "semantic_event": {
      const kind = typeof fact.payload.kind === "string" ? fact.payload.kind : "semantic_event";
      // THE ONE SEMANTIC EVENT THAT IS A STATEMENT OF ITS OWN, because it says what is UNREAD rather than what happened:
      // it is long enough to need the counts, and `- carried_backlog` told the model nothing (`round72`'s five facts).
      if (kind === CARRIED_BACKLOG_SEMANTIC_KIND) return sentence(carriedBacklogLine(fact, at));
      const words = SEMANTIC_KIND_ZH[kind] ?? kind;
      const reason = typeof fact.payload.reasonCode === "string" ? `（${fact.payload.reasonCode}）` : "";
      return sentence(`- ${at}${words}${reason}`);
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
      return sentence(`- ${at}${state}${reason}`);
    }
    case "world_fact":
      return worldFactLine(fact, at);
  }
}

/**
 * One fact's rendering: the sentence a reader hears, and the address it may need in order to act on it.
 *
 * The two halves are separate fields rather than one string because they are printed under two heads - the sentence in the
 * block's prose, the address on the line that says it is an address - and a renderer that could return only one string
 * would have to choose which of the two facts to drop.
 */
type FactRendering = Readonly<{ narration: string; address: string | null }>;

/** A fact that is prose only, or nothing at all. */
function sentence(narration: string): FactRendering | null {
  return narration === "" ? null : { narration, address: null };
}

/**
 * One fact's address: the Mod's own code and its own evidence, verbatim, prefixed by the same clock and action the
 * sentence carries so a reader can join the two lines without guessing which refusal is which.
 *
 * NOTHING IS REFORMATTED. `detail` is the producer's `key=value;...` string exactly as it arrived, and the separators this
 * function adds are FULL-WIDTH (`；`) for that reason: a detail may contain ASCII `;` between its own fields, and a reader
 * splitting on the ASCII one would break a value the Mod wrote. The prefix repeats the sentence's leading spelling
 * (`08:12 pickup_item`) because two refusals in one turn would otherwise be two unlabelled token runs.
 */
function addressOf(label: string, reasonCode: string | null, detail: string): string | null {
  const parts = [
    ...(reasonCode === null || reasonCode === "" ? [] : [`reasonCode=${reasonCode}`]),
    ...(detail === "" ? [] : [detail]),
  ];
  return parts.length === 0 ? null : `${label} ${parts.join("；")}`;
}

/**
 * One action receipt.
 *
 * THE SENTENCE IS THE MODE AND THE REMEDY, and the code is not in it. `RECEIPT_STATE_ZH` says what the step did
 * (`没做成`, `做成了`), and `stardew-action-remedy.ts` - the one table that answers "what can she do about this code" -
 * appends the instruction when it knows the code. Measured `round78`: the line was `pickup_item 没做成：gift_given
 * （location=Farm;item=(O)472;inventory_after=5）`, and the Game floor carried a second line ordering her to translate
 * `gift_given` herself. The code has not left the delivery: it is on the address line, verbatim.
 *
 * WHY THE REMEDY SENTENCE IS ENGLISH INSIDE A CHINESE BLOCK. It is the same sentence `game-tools.ts` appends to a refused
 * tool result, from the same function - one authority, and a Chinese copy here would be the second spelling of every
 * countermeasure in the product. The model reads both languages on this surface already.
 */
function receiptLine(fact: WorldFact, at: string): FactRendering {
  const action = typeof fact.payload.actionId === "string" ? fact.payload.actionId : "动作";
  const state = typeof fact.payload.state === "string" ? fact.payload.state : "";
  const words = RECEIPT_STATE_ZH[state] ?? state;
  const reasonCode = typeof fact.payload.reasonCode === "string" ? fact.payload.reasonCode : null;
  const detail = evidenceDetail(fact.payload);
  const remedy = describeRefusalRemedy(reasonCode, fact.payload.evidence);
  const said = words === "" ? "" : ` ${words}`;
  return {
    narration: `- ${at}${action}${said}${remedy === null ? "" : `。${remedy.guidance}`}`,
    address: addressOf(`${at}${action}`, reasonCode, detail),
  };
}

/** The Mod's own evidence detail for a receipt, bounded; never a Host paraphrase of it. */
function evidenceDetail(payload: Readonly<Record<string, unknown>>): string {
  const evidence = payload.evidence;
  if (evidence === null || typeof evidence !== "object") return "";
  return boundedField("evidence", (evidence as { detail?: unknown }).detail) ?? "";
}

/**
 * One world fact's line, and the address it may owe.
 *
 * The second half exists because a fact the Host reads PARTIALLY is still a fact she was told: the narration says what she
 * heard in words, and the machine spelling of what the Host could not read (`unknown_field=channel`) prints on the block's
 * address line, where this file keeps every token it does not put in a sentence (`ADDRESSABLE_FACTS_HEAD`).
 *
 * NULL IS A LINE THAT DOES NOT EXIST, and every case here is built from `sentence`, which answers nothing at all for an
 * empty narration (a generic fact whose producer wrote nothing). The caller this returns into (`factLine`) is already
 * nullable and `composeWorldFacts` drops the null, so the absence is stated where it is produced instead of a rendering
 * being invented here for a fact that has no words.
 */
function worldFactLine(fact: WorldFact, at: string): FactRendering | null {
  const kind = fact.semanticKind ?? "";
  switch (kind) {
    case "day_started": {
      const day = fact.payload.day;
      return sentence(`- ${at}新的一天${typeof day === "number" ? `：第 ${day} 天` : ""}`);
    }
    case "time_milestone": {
      const milestone = fact.payload.milestone;
      return sentence(
        `- ${at}又过了一个时辰${typeof milestone === "string" || typeof milestone === "number" ? `：${milestone}` : ""}`,
      );
    }
    // THE ONE FACT THAT SAYS THE WORLD IS WAITING ON HER, and the line `round76` needed and did not have: the account
    // counted 37 of these in ten minutes, not one opened a turn, and the model-facing text for one was the literal word
    // `modal_presented`. What it says now is the engine's own type name, the modal's own prose when the Mod published any,
    // EVERY declaration that is holding the world (`heldWorldOf` - the same reading the opener used, so the line and the
    // turn cannot disagree about whether the world is blocked), and the exact keys `answer_dialogue` sends back. The clock
    // is the fact's own `gameTime`, which on `round76` stood still across eight minutes of these.
    case "modal_presented": {
      const modal =
        typeof fact.payload.modalType === "string" && fact.payload.modalType !== ""
          ? fact.payload.modalType
          : "一个窗口";
      const prose = typeof fact.payload.text === "string" ? fact.payload.text.trim() : "";
      const keys = Array.isArray(fact.payload.responseKeys)
        ? fact.payload.responseKeys.filter((key): key is string => typeof key === "string" && key !== "")
        : [];
      const state = [
        ...heldWorldOf(fact).map((declaration) => HELD_WORLD_ZH[declaration]),
        ...(keys.length === 0 ? [] : [`可以答：${keys.join(" / ")}`]),
      ].join("，");
      return sentence(
        `- ${at}${modal} 挡在面前${prose === "" ? "" : `：「${prose}」`}${state === "" ? "" : `（${state}）`}`,
      );
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
      // THE SAME HOLD, ON THE FACT THAT CARRIES THE WORDS. A dialogue box declares `isQuestion` when the game stopped on a
      // question, and the answers below are the ones it offers - so a line that listed them without saying the box is
      // waiting read as a remark rather than as an obstruction. The declaration's words come from `HELD_WORLD_ZH`, the one
      // reading the pump's opener asks, so the prompt and the turn agree about whether the world is blocked.
      const holding = heldWorldOf(fact).map((declaration) => HELD_WORLD_ZH[declaration]);
      const tail = [...holding, ...(choices.length === 0 ? [] : [`可以答：${choices.join(" / ")}`])].join("，");
      return sentence(`- ${at}${speaker}说：「${pages.join(" ")}」${tail === "" ? "" : `（${tail}）`}`);
    }
    // SOMEONE ELSE IN THE LOBBY SAID SOMETHING, which is the one thing a co-op companion had no fact for at all: the
    // snapshot carries no chat family and the Mod's other chat hook is the TYPING path on the Host's own machine, so a line
    // the Host spoke reached her screen and no fact. It is here, beside `npc_dialogue_presented` and under the same rule -
    // the fact a reader has to decide on - because it is the same kind of event: a person said words to her, and whether
    // they were addressed to her is part of the fact.
    case MULTIPLAYER_CHAT_KIND:
      return multiplayerChatLine(fact, at);
    case "native_notice": {
      // The engine's own HUD line, quoted verbatim: the whole reason this fact exists is that she may answer what the
      // game itself said ("It's getting late..."), and a line that only said 有个提示 would drop the words.
      const notice = typeof fact.payload.notice === "string" ? fact.payload.notice : undefined;
      const clock =
        typeof fact.payload.inGameTime === "string" ? formatGameClock(Number(fact.payload.inGameTime), true) : "";
      return sentence(
        `- ${at}游戏里冒出个提示：${notice === undefined ? "（没有文字）" : `「${notice}」`}${clock === "" ? "" : `（${clock}）`}`,
      );
    }
    case "world_state_stale": {
      // The token is the whole fact, and it is printed VERBATIM: the pump minted it from the one function that spells it
      // (`worldStateStaleCode`), so re-deriving it here would be a second rendering of one number.
      const code = typeof fact.payload.code === "string" ? fact.payload.code : "";
      return sentence(
        `- ${at}${WORLD_FACT_KIND_ZH.world_state_stale ?? "世界观察旧了"}${code === "" ? "" : `：${code}`}`,
      );
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
      return sentence(`- ${at}${action} 卡住不动了${parts.length === 0 ? "" : `（${parts.join("，")}）`}`);
    }
    default:
      return sentence(genericWorldFactLine(fact, at, kind));
  }
}

/**
 * THE ONE KIND THAT CARRIES ANOTHER PLAYER'S WORDS, and the picture of its payload: `MultiplayerChatPayload` on the Mod's
 * side publishes exactly these five fields, so the list below is the reader's half of one wire shape rather than a
 * vocabulary this file invented.
 *
 * <p>
 * WHY THE LIST EXISTS AT ALL. A fact is read field by field, so a field the Mod adds later would vanish without a word: the
 * line would still read as a complete account of what someone said. Naming the population it accepts is what lets the line
 * state the rest on the block's ADDRESS line (`unknown_field=<name>`) - a reader can then see that the two sides of the wire
 * disagree, which is a different fact from "nothing else was published".
 * </p>
 */
const MULTIPLAYER_CHAT_KIND = "multiplayer_chat";

/** The five fields `MultiplayerChatPayload` publishes; anything else is named as unread rather than dropped. */
const MULTIPLAYER_CHAT_FIELDS: readonly string[] = Object.freeze([
  "speaker",
  "text",
  "textTruncated",
  "addressedToThisPlayer",
  "day",
]);

/** The Mod's own word for a speaker the engine could not name (`MultiplayerChatPayload.SpeakerNotMeasured`). */
const SPEAKER_NOT_MEASURED = "not_measured";

/** A run of whitespace, including the line breaks a chat text may carry and a one-line-per-fact block may not. */
const LINE_BREAK_RUN = /\s+/gu;

/**
 * One line another player sent, as she heard it: WHO said it, WHAT they said, whether it was said to her, and the clock it
 * arrived at.
 *
 * <p>
 * WHY THIS LINE IS THE POINT OF THE FACT. A co-op companion stood next to a person who typed a promise into the lobby and
 * had no fact that said a word had been spoken - the snapshot carries no chat family, and the Mod's other chat hook is the
 * TYPING path on the Host's own machine. The words therefore reached her screen and nothing else, so a judgement that
 * needed her to have HEARD a line ("东边那棵树先动") was measuring something no part of the product gave her. The Mod now
 * publishes the reception (`MultiplayerChatReception`), and this is where it becomes a sentence she can act on.
 * </p>
 *
 * <p>
 * THE SPEAKER IS SAID, AND AN UNMEASURED ONE IS NOT A NAME. The Mod publishes `not_measured` for a line the engine could
 * not attribute; printing that token as a name would hand her the machine's word for a person, so an absent speaker reads
 * as `有人` - the same reading `npc_dialogue_presented` gives a dialogue with no name.
 * </p>
 *
 * <p>
 * A CUT LINE SAYS IT WAS CUT. The Mod publishes a verbatim PREFIX when a line passes the wire's bound and sets
 * `textTruncated`; a reader quoting a half sentence must know it was half, so the flag is stated rather than swallowed.
 * </p>
 *
 * <p>
 * THE DAY QUALIFIES THE HOUR, and it is printed in the words `day_started` already uses for the same number: both carry
 * `Game1.Date.TotalDays`, and one number gets one spelling. The hour alone cannot say which night a `01:50` belongs to,
 * which is the reason the Mod publishes the day on this payload at all.
 * </p>
 */
function multiplayerChatLine(fact: WorldFact, at: string): FactRendering {
  const named =
    typeof fact.payload.speaker === "string" &&
    fact.payload.speaker !== "" &&
    fact.payload.speaker !== SPEAKER_NOT_MEASURED
      ? fact.payload.speaker
      : null;
  const who = named === null ? "有人" : `玩家「${named}」`;
  // ONE LINE PER FACT. A chat text arrives from another machine and the wire does not forbid a line break in it; a fact
  // that could write a second line into the block could forge a line she reads as the Host's.
  const said = typeof fact.payload.text === "string" ? fact.payload.text.replace(LINE_BREAK_RUN, " ").trim() : "";
  const toHer = fact.payload.addressedToThisPlayer === true ? "只对你说" : "说";
  const cut = fact.payload.textTruncated === true ? "（原话更长，这里只有前面一段）" : "";
  const day =
    typeof fact.payload.day === "number" && Number.isFinite(fact.payload.day)
      ? `第 ${String(fact.payload.day)} 天 `
      : "";
  const unread = Object.keys(fact.payload)
    .filter((field) => !MULTIPLAYER_CHAT_FIELDS.includes(field))
    .sort();
  return {
    narration: `- ${at}${day}${who}${toHer}：「${said === "" ? "（没有文字）" : said}」${cut}`,
    address: unread.length === 0 ? null : addressOf(MULTIPLAYER_CHAT_KIND, null, `unknown_field=${unread.join(",")}`),
  };
}

/**
 * The Host's own backlog: `N 份结果没读到`, and which families they are.
 *
 * <p>
 * WHY THIS LINE EXISTS AT ALL. `round72`: five terminal receipts were carried, no turn opened for them (a receipt has no
 * presentation identity), and the run sat idle for 166 s while the work they answered had already happened. The pump now
 * opens ONE turn when the backlog has waited (`CARRIED_BACKLOG_BOUND_MS`), and this is what that turn says: the count, how
 * long the oldest waited, and the families - in the same `factShapeName` spelling the account's `no_surface_for` and `lost`
 * braces use, so a reader can join the message to the ledger by name.
 * </p>
 *
 * <p>
 * IT IS NOT A WORLD-CHANGE LINE, and the sentence is written to be unable to read as one: it says what is UNREAD, never
 * what the world did. The receipts themselves are rendered beside it by `receiptLine` (they always owed her the news; they
 * could not OPEN a turn), so this line is the reason the turn exists rather than a summary that replaces them.
 * </p>
 *
 * <p>
 * NOTHING IS INVENTED. `held` is the pump's ledger size, `families` and their counts are the shapes in it, and
 * `oldestHeldMs` is the wait the pump measured, converted to seconds at the one place the text is composed. A payload this
 * file cannot read prints what it can rather than a zero: a sentence that said `0 份` would be the one lie this fact cannot
 * afford.
 * </p>
 */
function carriedBacklogLine(fact: WorldFact, at: string): string {
  const held = Number(fact.payload.held);
  const counted = familyCounts(fact.payload);
  const named = familyNames(fact.payload);
  const omitted = Number(fact.payload.omittedFamilies);
  const waitedMs = Number(fact.payload.oldestHeldMs);
  const waited = Number.isFinite(waitedMs) ? `（最早的一份等了 ${String(Math.round(waitedMs / 1000))} 秒）` : "";
  const families = named
    .map((family) => (counted[family] === undefined ? family : `${family} ${String(counted[family])}`))
    .join("、");
  const rest = Number.isFinite(omitted) && omitted > 0 ? ` 等 ${String(omitted)} 类` : "";
  const count = Number.isFinite(held) && held > 0 ? String(held) : countedTotal(counted);
  // HELD 0 IS NOT A STATEMENT, IT IS THE ABSENCE OF ONE. The pump cannot mint this fact with an empty ledger
  // (`#backlogIsDue`), and a line that said `有 0 份结果没读到` would be the one lie this fact cannot afford - so a payload
  // that says nothing is rendered as nothing rather than as a zero.
  if (count === "0") return "";
  return `- ${at}有 ${count} 份结果没读到${waited}${families === "" ? "" : `：${families}${rest}`}`;
}

/** The families a backlog fact names, in the pump's own order (oldest first), from its own bounded list. */
function familyNames(payload: Readonly<Record<string, unknown>>): readonly string[] {
  const families = payload.families;
  if (!Array.isArray(families)) return [];
  return families.filter((family): family is string => typeof family === "string" && family !== "");
}

/** How many facts of each family the pump counted, so the count beside a name is its own and not a guess. */
function familyCounts(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, number>> {
  const byFamily = payload.byFamily;
  if (byFamily === null || typeof byFamily !== "object") return {};
  const counted: Record<string, number> = {};
  for (const [family, count] of Object.entries(byFamily as Record<string, unknown>))
    if (typeof count === "number" && Number.isFinite(count) && count > 0) counted[family] = count;
  return counted;
}

/** The whole population, for a payload that lost its own `held`: the counts still close to the number of facts. */
function countedTotal(counted: Readonly<Record<string, number>>): string {
  return String(Object.values(counted).reduce((total, count) => total + count, 0));
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

/** `<execution-result>`: what a submitted programme did, in sentences, one per settlement, and one line of addresses. */
function composeExecutionResult(settlements: readonly WorldFact[], reading: WorldStateReading | undefined): string {
  const lines: string[] = [];
  const addresses: string[] = [];
  for (const settlement of settlements) {
    const rendered = settlementLine(settlement, reading);
    if (rendered === null) continue;
    lines.push(rendered.narration);
    addresses.push(...rendered.addresses);
  }
  if (lines.length === 0) return "";
  if (addresses.length > 0) lines.push(`${ADDRESSABLE_FACTS_HEAD}${addresses.join("；")}`);
  return block("execution-result", lines.join("\n"));
}

/** One settlement's rendering: its sentence, and the addresses its own failed nodes need in order to be acted on. */
type SettlementRendering = Readonly<{ narration: string; addresses: readonly string[] }>;

/**
 * One settled programme.
 *
 * The counts and the rows come from `program-settlement-digest.ts`'s own payload (`total`, `counts`, `nodes`), so this
 * sentence and a `stardew_action_program_status` answer cannot disagree. A failure is said in WORDS, with the remedy that
 * code owes (§ `stardew-action-remedy.ts`) and its own `hint` when the Mod wrote one; the node's `reasonCode` and its
 * `reasonDetail` - `owner=Pierre;owner_tile=4,17` - are what a later argument copies, so they print verbatim on the
 * block's address line instead of inside the sentence.
 */
function settlementLine(fact: WorldFact, reading: WorldStateReading | undefined): SettlementRendering | null {
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
  const failed = nodes.filter((node) => typeof node.state === "string" && node.state !== "succeeded");
  const failures = failed.map((node) => failureWords(node)).filter((words): words is string => words !== "");
  const addresses = failed.map((node) => nodeAddress(node)).filter((address): address is string => address !== null);
  const said = [...proofs, ...failures];
  const omitted = Number(fact.payload.omitted);
  const more = Number.isFinite(omitted) && omitted > 0 ? `（另有 ${omitted} 步未列出）` : "";
  return {
    narration: `- ${head}${more}${said.length === 0 ? "" : `：${said.join("；")}`}；${remainderSentence(nodes, reading)}`,
    addresses,
  };
}

/**
 * One failed node's address: which node it was, the Mod's code for it, and the Mod's own detail - verbatim.
 *
 * THE NODE ID IS THE JOIN. A settlement of twenty rows may fail four of them for three different reasons, so a line of
 * unlabelled token runs would be four addresses and no way to tell which step each belongs to.
 */
function nodeAddress(node: SettledNode): string | null {
  const label =
    typeof node.nodeId === "string" ? node.nodeId : typeof node.actionId === "string" ? node.actionId : "一步";
  return addressOf(
    label,
    typeof node.reasonCode === "string" ? node.reasonCode : null,
    boundedField("reasonDetail", node.reasonDetail) ?? "",
  );
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
// descriptor's `Chore` claim, whose family is the `TargetFamily` it addressed - NOT its `Clears`, which answers a routing
// question and is declared only on the actions that open a route, so asking it here answered `未测` for 14 of round70's
// 14 delivered batches), and the Mod publishes it as a TYPED field of the settlement (`BodyProgramJournalNode.Chore`). A
// settlement whose steps say nothing about their chore states `剩下的：未测` rather than staying silent.
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

/**
 * What a family name may be, checked rather than parsed: `harvestTargets`, `weedTargets`, `woodFenceTargets`.
 *
 * THE SCANNER IS GONE, THE CHECK IS NOT. This file used to find the family by looking for `chore=` inside a settlement's
 * strings and reading the identifier that followed it. The family now arrives as `node.chore`, one typed field the Mod
 * writes from its own declaration, so there is no separator left for a producer to change and nothing to scan. What a
 * reader still owes is the bound - `BodyProgramValidation.IsIdentifier`'s own alphabet and length, which is also the wire's
 * `isOpaqueId`, so a value the Mod could not have minted is not one this file counts.
 */
const FAMILY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

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
 * The family whose work one settled step consumed, as the Mod published it: `chore: "weedTargets"`.
 *
 * <p>
 * READ FROM THE FIELD, NEVER FROM THE STRINGS BESIDE IT. The family is the descriptor's own declaration, carried as
 * `BodyProgramJournalNode.Chore`: a `for_each` pass names the ONE family its rows agree on, a single settled action names
 * the family its work consumes, and a step that proved no effect names none. The clause `;chore=<family>` is still minted
 * into the receipt's evidence for every reader that reads it, and this file no longer reads it at all - a scan can only be
 * wrong silently, which is what `round73` measured (205 mints in the log, 9 of 9 remainders saying the Mod had said
 * nothing).
 * </p>
 * <p>
 * Present only on a step whose action declares that its success TAKES its family's row out of the world: a step that
 * reads or loads a machine has no chore, and neither has one that clears a route (`clearing is a different question`).
 * </p>
 */
function choreFamilyOf(node: SettledNode): string | undefined {
  if (typeof node.state !== "string" || !PROVEN_EFFECT_STATES.has(node.state)) return undefined;
  return typeof node.chore === "string" && FAMILY_KEY.test(node.chore) ? node.chore : undefined;
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
 * One failed node in words: the Mod's own hint, and the remedy the code owes - never a bare code.
 *
 * <p>
 * The hint is the SENTENCE that says what would fix it and it is printed as the Mod wrote it. What left this line on
 * 2026-11-19 is the `reasonCode` and the `reasonDetail`: measured at `516e2559` this function printed `hint ?? detail`, so
 * a node carrying both reached her with the sentence alone and the coordinates - the one part of the refusal a guess
 * cannot reconstruct - were dropped, and the fix put the code in front of both. The code was then the first thing she read
 * (`no_native_path：closest=49,14;closest_distance=1`) and the Game floor carried a line telling her to translate it. Both
 * now travel on the block's address line (`nodeAddress`): a run audit still greps the code out of the delivery, and the
 * sentence she reads names the next step through `stardew-action-remedy.ts` - the same table a refused tool result uses.
 * </p>
 *
 * <p>
 * A NODE THE TABLE DOES NOT KNOW still reads as a sentence: `没做成` plus its hint, with no instruction appended rather
 * than an invented one. `a_refusal_she_reads_is_a_sentence` is what keeps that set empty for the codes the Mod declares.
 * </p>
 */
function failureWords(node: SettledNode): string {
  const action = typeof node.actionId === "string" ? node.actionId : "一步";
  const remedy = describeRefusalRemedy(typeof node.reasonCode === "string" ? node.reasonCode : null, null);
  // The Mod's hint first, then the proof half a `partially_succeeded` node keeps - the rows that DID happen and the
  // reason for the ones that did not are one answer about one node.
  const words = [boundedField("hint", node.hint), proofTail(node)]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("｜");
  const said = words === "" ? "" : `（${words}）`;
  return `${action} 没做成${said}${remedy === null ? "" : `。${remedy.guidance}`}`;
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
