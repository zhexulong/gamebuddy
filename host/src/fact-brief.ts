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
 * WHICH BLOCK A FACT BELONGS IN is a property of the fact, not of the batch:
 * </p>
 *
 * <ul>
 *   <li>`<player-note>` - the player's own words, verbatim, first, never mixed with a fact;</li>
 *   <li>`<world-state>` - the snapshot as a paragraph: clock, date, weather, where, stamina, what she carries, and the
 *       nearby target families with their tiles;</li>
 *   <li>`<in-flight>` - the programme she has DISPATCHED and not yet seen settle: what `action_program_status` would
 *       answer, with its own words drawing the line between dispatched and done;</li>
 *   <li>`<world-facts>` - the events: receipts, dialogue, stalls, milestones, arrivals, lifecycles;</li>
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
  formatGameClock,
  formatGameEnvironmentFacts,
  gameLocationName,
  MAX_EMPTY_FAMILIES_NAMED,
  MAX_TARGET_FAMILIES_SHOWN,
  nearbyTargetFamilies,
} from "./game-world-vocabulary.js";
import type { InFlightProgramme, InFlightProgrammeReading } from "./program-status-wait.js";
import { MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH, type Snapshot } from "./protocol.js";

/**
 * The closed set of block names a delivery may use.
 *
 * ORDER IS THE READING ORDER, and `<in-flight>` sits between the world and the news on purpose: what is true now, then
 * what she has already set in motion and not yet seen land, then what happened.
 *
 * THE PROMPT FLOOR NAMES FOUR OF THESE (`identity-profile.ts`), and the fifth names itself: see
 * `composeInFlight`'s comment for why the count in that paragraph is now a number the floor has to re-derive, and for
 * the token `fact-brief.test.ts` carries while it has not. The closed set is this list, not that sentence.
 */
export const FACT_BRIEF_BLOCKS = Object.freeze([
  "player-note",
  "world-state",
  "in-flight",
  "world-facts",
  "execution-result",
] as const);

export type FactBriefBlock = (typeof FACT_BRIEF_BLOCKS)[number];

/**
 * The most fact lines `<world-facts>` names before it counts the rest.
 *
 * The pump already bounds how many facts a batch may hold (`MAX_PENDING_*`) and how large the whole delivery may be
 * (`MAX_BATCH_BYTES`), and the byte bound is what protects the context. This cap is the SECOND bound, and it exists
 * because dropping the oldest fact is right for a run and wrong for a REPORT: a batch of ninety receipts answered "what
 * just happened" with the thirty newest ones and said nothing about the sixty it left out. So the line count is
 * bounded where the sentences are composed, and the remainder is named.
 */
export const MAX_WORLD_FACT_LINES = 24;

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
export const WORLD_STATE_STALE_REARM_MULTIPLE = 4;

/** The turn age at which the `published`-th stale fact for one reading is due. */
export function worldStateStaleThreshold(published: number): number {
  return WORLD_STATE_STALE_TURNS * (1 + published * (WORLD_STATE_STALE_REARM_MULTIPLE - 1));
}

/**
 * The one spelling of the stale token: `world_state_stale:<turns>;<revision>;<ageMs>`.
 *
 * The block, the `<world-facts>` line and the Host's published line all carry this exact string, so a reader - a model,
 * a log grep, a run audit - never has to reconcile two renderings of one number.
 */
export function worldStateStaleCode(reading: Readonly<{ ageTurns: number; revision: number; ageMs: number }>): string {
  return `world_state_stale:${String(reading.ageTurns)};${String(reading.revision)};${String(reading.ageMs)}`;
}

/** One node row of a settled programme, as `program-settlement-digest.ts` publishes it. */
type SettledNode = Readonly<{
  nodeId?: string;
  actionId?: string;
  state?: string;
  reasonCode?: string;
  hint?: string;
  reasonDetail?: string;
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
   * Milliseconds since the reading's own revision was admitted.
   *
   * The turn age is what the block is judged by, and this is the wall-clock half of the same fact: a turn can take a
   * minute, so fifty turns is thirty minutes or three hours, and only one of those numbers is about the world she is
   * describing. Measured from the revision, so a re-stated copy of one reading never looks fresher than it is.
   */
  ageMs: number;
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
  /** The events, in the order the batch delivers them. */
  events: readonly WorldFact[];
  /**
   * The programmes the Mod's journal still shows in flight, as the ledger every status read already fills.
   *
   * Omitted means "nothing is unsettled", and that is a different statement from an empty block: a `<in-flight>` holding
   * no rows would tell the model that a programme exists with nothing in it, which is never true and would teach it that
   * the block is noise.
   */
  inFlight?: InFlightProgrammeReading;
  /** The language the player wrote in. The brief is Chinese; this is what a caller checks it against. */
  locale: string;
}>;

/** No programme in flight: the reading a batch carries when the journal has nothing unsettled to name. */
export const NOTHING_IN_FLIGHT: InFlightProgrammeReading = Object.freeze({
  programmes: Object.freeze([]),
  omittedProgrammes: 0,
});

/**
 * The whole model-facing text of one delivery.
 *
 * Deterministic: no clock of its own, no map iteration, no field rendered twice. The text is folded into the session's
 * cached history, so two batches with the same content must render the same bytes.
 */
export function composeFactBrief(input: FactBriefInput): string {
  const blocks: string[] = [];
  const note = composePlayerNote(input.inputs);
  if (note !== "") blocks.push(note);
  const state = composeWorldState(input.snapshot);
  if (state !== "") blocks.push(state);
  const inFlight = composeInFlight(input.inFlight ?? NOTHING_IN_FLIGHT);
  if (inFlight !== "") blocks.push(inFlight);
  const settlements = input.events.filter((fact) => fact.semanticKind === PROGRAM_SETTLED);
  const facts = input.events.filter((fact) => fact.semanticKind !== PROGRAM_SETTLED);
  const factBlock = composeWorldFacts(facts);
  if (factBlock !== "") blocks.push(factBlock);
  const resultBlock = composeExecutionResult(settlements);
  if (resultBlock !== "") blocks.push(resultBlock);
  return blocks.join("\n");
}

/** The player's own words, verbatim, one line per utterance. Empty when nobody said anything. */
function composePlayerNote(inputs: readonly PlayerInput[]): string {
  const lines = inputs.map((input) => input.text.trim()).filter((text) => text !== "");
  if (lines.length === 0) return "";
  return block("player-note", lines.join("\n"));
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
      `${worldStateStaleCode(reading)}（这块世界观察停在 ${String(reading.ageTurns)} 轮之前、${String(Math.round(reading.ageMs / 1000))} 秒之前，世界已经不是这样了；先看一眼再动手）`,
    );
  else if (reading.ageTurns >= 1) parts.push(`（这是 ${reading.ageTurns} 轮之前看到的，世界已经不一样了）`);
  const environment = formatGameEnvironmentFacts(world, true);
  if (environment !== "") parts.push(environment);
  const carrying = formatCarrying(world);
  if (carrying !== "") parts.push(carrying);
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
export const MAX_CARRYING_ROWS = 8;

/**
 * What she is carrying that is not a tool.
 *
 * `inventoryItemFacts` is the Mod's own bounded inventory publication (36 rows: slot, id, stack) and the name it carries
 * is `displayName` - the wire's own spelling, the one the shipping bin and every other reader uses. ABSENT means the Mod
 * did not publish the family at all - the field is gated on the actions that read the inventory - and stays silent,
 * which is a different statement from `身上没有别的东西`.
 */
function formatCarrying(world: Snapshot): string {
  const rows = world.inventoryItemFacts;
  if (!Array.isArray(rows)) return "";
  const named = rows
    .filter((row) => typeof row?.displayName === "string" && row.displayName.trim() !== "")
    .map((row) => ({
      name: row.displayName.trim(),
      stack: Number.isFinite(row.stack) ? Number(row.stack) : 1,
    }));
  if (named.length === 0) return "身上没有别的东西";
  const shown = named.slice(0, MAX_CARRYING_ROWS).map((row) => `${String(row.stack)} 份 ${row.name}`);
  const rest = named.length - shown.length;
  return `身上带着 ${shown.join("、")}${rest > 0 ? ` 其余 ${String(rest)} 种未列出` : ""}`;
}

/**
 * The nearby target families: the non-empty ones first, nearest first, then one line for the families the snapshot
 * published as empty.
 *
 * A family the snapshot does not carry is not printed at all, and a family it carries as `[]` is - `nearbyTargetFamilies`
 * owns that distinction and says why. Both caps live here, in the composition, so the consumer is never the thing that
 * decides how much of the world fits.
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
  const restFamilies = occupied.length - Math.min(occupied.length, MAX_TARGET_FAMILIES_SHOWN);
  if (restFamilies > 0) lines.push(`其余 ${restFamilies} 类未列出`);
  const empty = families.filter((family) => family.total === 0).map((family) => family.label);
  if (empty.length > 0) {
    const named = empty.slice(0, MAX_EMPTY_FAMILIES_NAMED);
    const more = empty.length - named.length;
    lines.push(`这一带没有：${named.join("、")}${more > 0 ? ` 等 ${empty.length} 类` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// The work she has dispatched and not yet seen land.
// ---------------------------------------------------------------------------------------------------------------

/**
 * What the block says about every row it just printed: dispatched is not done.
 *
 * <p>
 * THIS SENTENCE IS THE FIX, and it is a STATEMENT rather than an instruction. Measured 2026-11-11 (`round46`):
 * `plan_work` was accepted at 07:25:53 with `settled: false, remaining: 2`; she spoke 11 s later
 * (`*推开门，晨风凉凉地扑在脸上* 门前这片草和石头还横着呢…`), corrected the plan at 07:26:17, spoke again 9 s after that
 * (`*靴底踩着屋里的木地板往西挪*`), and the world was first observed moving at 07:26:34. Neither batch said a step was
 * outstanding, so "I sent it" and "it happened" were the same sentence to her. A "don't narrate work you haven't
 * done" rule would be the wrong shape - she was not told the work was outstanding, so the rule would be scolding her
 * for the batch's silence. This line is the fact the batch owed her.
 * </p>
 */
const NOT_YET_TRUE = "上面这些只是派出去了：还没结算，就等于一步都还没做成。";

/**
 * `<in-flight>`: the programme she has dispatched, with its own words drawing the line at `settled`.
 *
 * <p>
 * WHAT IT ANSWERS WITHOUT BEING ASKED. `stardew_action_program_status` answered this and cost the run 29 of 96 turns
 * (`round43`): every field below is that tool's own rendering, taken from the ledger it reports from
 * (`program-status-wait.ts#programStatusProgress`), so a batch and a status call cannot disagree about a node's state
 * or its clock.
 * </p>
 *
 * <p>
 * IT NAMES ITSELF, and that is a concession rather than the design. The Game surface's prompt floor (`identity-profile.ts`)
 * lists the blocks the model has to recognize, and that paragraph says "four" - a number written in prose, in a file this
 * change does not own. So the block's first line carries its own meaning instead of depending on being introduced:
 * `in_flight:settled=0;total=2;remaining=2（计划 plan_… 还没结算）` is readable as nothing but what it is. The token is
 * the one a floor, a gate or a run audit can grep (`fact-brief.test.ts` carries `floor_block_count_owes_update`), and
 * when the floor's count is regenerated from `FACT_BRIEF_BLOCKS.length` this concession can be deleted.
 * </p>
 *
 * <p>
 * ABSENT, NEVER EMPTY. An `<in-flight>` with no rows would read as "a programme exists and has no nodes" - the one
 * reading this block must never give - so a reading with no programme renders nothing at all.
 * </p>
 */
export function composeInFlight(reading: InFlightProgrammeReading): string {
  if (reading.programmes.length === 0) return "";
  const lines: string[] = [];
  for (const programme of reading.programmes) lines.push(...inFlightProgrammeLines(programme));
  if (reading.omittedProgrammes > 0) lines.push(`其余 ${String(reading.omittedProgrammes)} 个还没结算的计划未列出`);
  return block("in-flight", lines.join("\n"));
}

/**
 * One unsettled programme: the token and how much of it is done, one row per journal node, and the line that says which
 * half of the ledger these rows are.
 *
 * The rows are the journal's OWN: `index` is the position the journal lists the node at, `state` is the Mod's token
 * verbatim (`pending`, `host_admitted`, `running`), and `actionId` is the Mod's own action name. Not translated: a batch
 * that said 准备中 where the tool says `pending` would be two vocabularies for one fact, and the model holds both.
 */
function inFlightProgrammeLines(programme: InFlightProgramme): readonly string[] {
  const lines = [
    `in_flight:settled=${String(programme.settled)};total=${String(programme.total)};remaining=${String(programme.remaining)}（计划 ${programme.programId} 还没结算）`,
  ];
  for (const node of programme.nodes) {
    const action = node.actionId ?? node.nodeId;
    lines.push(
      `- ${String(node.index + 1)}/${String(programme.total)} ${action} ${node.state}（已等 ${String(Math.round(node.observedInStateMs / 1000))} 秒）`,
    );
  }
  if (programme.omitted > 0)
    lines.push(`其余 ${String(programme.omitted)} 步未列出（这个计划一共 ${String(programme.total)} 步）`);
  lines.push(NOT_YET_TRUE);
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

/**
 * A node hint's ceiling, which is the wire's own number: `protocol.ts:isBodyProgramNodeStatus` refuses a frame carrying a
 * longer one, so a hint that arrived through the bridge can never meet this ceiling, let alone a smaller one.
 *
 * `fact-brief.test.ts` reads that validator and asserts the two numbers are the same one, so this cannot drift from the
 * bound the Mod's journal enforces.
 */
export const MAX_BODY_PROGRAM_NODE_HINT_CHARS = 256;

/**
 * The ceiling every Mod-authored field this file prints is held to, and where each number comes from.
 *
 * <p>
 * TWO KINDS OF FIELD, TWO KINDS OF NUMBER. A node's `hint` and `reasonDetail` are bounded by their PRODUCER: the Mod's
 * journal refuses a hint over 256 characters and a refusal detail over 512
 * (`BodyProgramValidation.MaximumNodeHintLength` / `MaximumNodeRefusalDetailLength`), and `protocol.ts` refuses a frame
 * over the same two numbers. Printing them up to those bounds is printing them WHOLE, and a smaller number is a Host
 * opinion about a field the Mod already sized.
 * </p>
 *
 * <p>
 * WHAT A SMALLER ONE COST, measured 2026-11-11 (`round45`). All 15 failed `for_each` hints reached this file between 169
 * and 255 characters (median 248) and all 15 of their details between 480 and 507, against a flat 160 ceiling: 30 cuts in
 * one run's model-visible text. The ledger survived every cut and the per-code tail - `no_safe_clear:crop:scythe_crop=3;
 * no_rule_matched:ground_58_9=1;…`, the part that says WHICH rows failed - was exactly what fell off, mid-token. The
 * ceiling was wrong, not the text.
 * </p>
 *
 * <p>
 * A receipt's `evidence.detail` is the other kind: the wire declares no bound on an `evidence` object, so 160 here is the
 * Host's own measured share of one `<world-facts>` line. Measured in the same run, a receipt's evidence is 200-600
 * characters of proof facts - a tool result's job to carry, not one line's.
 * </p>
 */
export const MODEL_FIELD_CEILINGS = Object.freeze({
  hint: MAX_BODY_PROGRAM_NODE_HINT_CHARS,
  reasonDetail: MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH,
  evidence: 160,
});

/** Every Mod-authored field this file prints under a ceiling. */
export type ModelVisibleField = keyof typeof MODEL_FIELD_CEILINGS;

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
    case "companion_arrival": {
      // The fact carries its own model-facing sentence (the Host's words: she has just arrived, and this is the day's
      // first clock reading). Printing only 她到了 would drop the instruction that makes her open the morning, and with
      // it the opening `companionArrivalAlreadySaid` looks for.
      const own = fact.contextProjection?.text;
      if (typeof own === "string" && own.trim() !== "") return `- ${at}${own.trim()}`;
      return `- ${at}${WORLD_FACT_KIND_ZH.companion_arrival ?? "她到了"}`;
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
      // The fact exists to say WHICH execution stopped moving and for how long, so the Mod's own identity and labels are
      // printed verbatim beside the words - the same rule a receipt's `reasonCode` follows.
      const action = typeof fact.payload.actionId === "string" ? fact.payload.actionId : "动作";
      const elapsed = Number(fact.payload.elapsedMs);
      const seconds = Number.isFinite(elapsed) ? Math.round(elapsed / 1000) : undefined;
      const last = typeof fact.payload.lastFactKind === "string" ? `，最后一条 ${fact.payload.lastFactKind}` : "";
      return `- ${at}${action} 卡住不动了${seconds === undefined ? "" : `（已 ${String(seconds)} 秒没有消息${last}）`}`;
    }
    default: {
      const words = WORLD_FACT_KIND_ZH[kind] ?? kind ?? "世界消息";
      return `- ${at}${words}`;
    }
  }
}

/** `<execution-result>`: what a submitted programme did, in sentences, one per settlement. */
function composeExecutionResult(settlements: readonly WorldFact[]): string {
  const lines = settlements.map(settlementLine).filter((line) => line !== "");
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
function settlementLine(fact: WorldFact): string {
  const total = Number(fact.payload.total);
  const counts = fact.payload.counts;
  const done =
    counts !== null && typeof counts === "object" ? Number((counts as Record<string, unknown>).succeeded ?? 0) : 0;
  const head = Number.isFinite(total) ? `${done}/${total} 步做成了` : "计划收尾了";
  const nodes = Array.isArray(fact.payload.nodes) ? (fact.payload.nodes as readonly SettledNode[]) : [];
  const failures = nodes
    .filter((node) => typeof node.state === "string" && node.state !== "succeeded")
    .map((node) => failureWords(node))
    .filter((words): words is string => words !== "");
  const omitted = Number(fact.payload.omitted);
  const more = Number.isFinite(omitted) && omitted > 0 ? `（另有 ${omitted} 步未列出）` : "";
  return `- ${head}${more}${failures.length === 0 ? "" : `：${failures.join("；")}`}`;
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
  // introduces the code, so the two halves stay distinguishable in the line.
  const words = [boundedField("hint", node.hint), boundedField("reasonDetail", node.reasonDetail)]
    .filter((part): part is string => part !== undefined)
    .join("｜");
  const reason = words === "" ? code : code === undefined ? words : `${code}：${words}`;
  return reason === undefined ? `${action} 没做成` : `${action} 没做成（${reason}）`;
}

/**
 * One Mod-authored field's share of a line, cut at its own ceiling - and the cut NAMED by the ceiling that made it.
 *
 * A bare ellipsis would leave her reading a partial coordinate list, or a partial ledger, as the whole one; the token says
 * how much of the Mod's text the line is not showing (`evidence_detail_over_ceiling:<length>:<ceiling>`, the same
 * bounded-token shape a node's own `reasonCode` has, so a run audit greps ONE name and reads the ceiling it met). An
 * absent or blank value is `undefined`, so a caller joins only the halves that exist.
 *
 * At the ceiling it prints whole: the point of `MODEL_FIELD_CEILINGS` is that the node fields are then printed exactly as
 * the Mod wrote them, because the wire bound them first.
 */
function boundedField(field: ModelVisibleField, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const ceiling = MODEL_FIELD_CEILINGS[field];
  if (text.length <= ceiling) return text;
  return `${text.slice(0, ceiling)}…[evidence_detail_over_ceiling:${String(text.length)}:${String(ceiling)}]`;
}

/**
 * The game clock a fact happened at, as `HH:MM ` - or nothing at all.
 *
 * `gameTime` is published on some world facts and not on others, and a receipt carries no game clock at all. An absent
 * clock prints as an empty prefix rather than as a Host wall-clock guess: the Host does not know what hour it is in the
 * game (`snapshot-hud.ts#aged` carries the same measurement), and `08:12` invented from `Date.now()` would be a fact.
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

/** The location a fact happened in, for a caller that wants to name it in a diagnostic. */
export function factLocationName(fact: WorldFact, zh: boolean): string {
  return gameLocationName(typeof fact.payload.location === "string" ? fact.payload.location : undefined, zh);
}
