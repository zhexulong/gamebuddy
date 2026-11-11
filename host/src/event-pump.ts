import { randomUUID } from "node:crypto";

import { isTerminalExecutionState } from "./execution-correlation-ledger.js";
import {
  composeFactBrief,
  type WorldStateReading,
  worldStateStaleCode,
  worldStateStaleThreshold,
} from "./fact-brief.js";
import { type InFlightProgrammeReading, readInFlightProgrammes } from "./program-status-wait.js";
import type { ExecutionState, Snapshot } from "./protocol.js";
// The Mod's evidence detail is one format with one reader (`key=value;...`), and the body-owner refusal puts the owner
// it names inside it. Reusing that reader is what keeps the pump and the Agent's refusal guidance from disagreeing
// about who holds the body.
import { evidenceDetailOf, evidenceField } from "./stardew-action-remedy.js";

export type FactKind = "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle" | "world_fact";
export type WorldFact = Readonly<{
  /** Adapter-owned source label, or Host's explicitly non-world transport label. */
  source: string;
  kind: FactKind;
  eventId?: string;
  occurredAtMs?: number;
  correlationId: string;
  revision: number;
  executionId?: string;
  requestId?: string;
  sourceEventId?: string;
  observedTick?: number;
  gameTime?: string | null;
  payload: Readonly<Record<string, unknown>>;
  /** Bounded model-facing context; the authoritative payload stays Host-owned. */
  contextProjection?: Readonly<Record<string, unknown>>;
  /**
   * Mod-owned semantic identity of a world_fact (day_started, time_milestone,
   * …). The Host keeps it only as an opaque label for bounded sensory
   * presentation leases; it never interprets the payload.
   */
  semanticKind?: string;
}>;
export type PlayerInput = Readonly<{
  source: "player_text" | "voice_final";
  inputId: string;
  eventId?: string;
  text: string;
  locale: string;
  timestampMs: number;
}>;

export type DeliveryDisposition = "steer" | "follow_up" | "hold";

/**
 * How one delivered turn ENDED, as observed by whoever ran it.
 *
 * `completed` — Pi settled the turn without reporting a failure.
 * `aborted` / `error` — Pi's own final-message classification said so (see
 *   `native-companion-content.ts:252-258`, which already distinguishes them).
 * `refused` — Magic Context declined to prepare the pass and aborted the run rather than sending it
 *   unmanaged (see `companion-turn-refusal.ts`). It is its own ending: the abort is the refusal's
 *   consequence, not the player's STOP, and a refused turn must never read as `completed` or as
 *   `unobserved`.
 * `unobserved` — the adapter cannot say (no Pi event stream, or the turn never ran).
 *
 * This vocabulary exists because the classification WAS being discarded: the Game loop passed
 * `onRejected: () => undefined`, so an aborted/errored provider turn reached the caller as an ordinary
 * accepted message. A caller must be able to tell "the companion answered" from "the turn died", and
 * "nobody looked" must not be spelled the same way as "it worked".
 */
export type CompanionTurnOutcome = "completed" | "aborted" | "error" | "refused" | "unobserved";

/**
 * What a delivered turn DID, which `CompanionTurnOutcome` cannot say.
 *
 * `completed` covers both "acted" and "only spoke", so the one distinction the liveness question needs is measured
 * separately by the layer that sees Pi's event stream and the assistant message itself.
 */
export const TURN_PRODUCTION = Object.freeze({
  /** It ran at least one tool: the turn moved something. */
  worked: "worked",
  /** It carried assistant text and ran no tool: narration. */
  spoke: "spoke",
  /**
   * It carried no assistant text at all - a provider that answered with nothing, or a message whose tool call never ran.
   * Not narration either way, so it ends the run rather than extending it.
   */
  saidNothing: "said_nothing",
});

export type TurnProduction = (typeof TURN_PRODUCTION)[keyof typeof TURN_PRODUCTION];

/**
 * The closed list of things that make a batch worth a turn, and the whole population of the opening decision.
 *
 * <p>
 * THE INVARIANT: a turn opens only when the batch carries at least one thing she did not have and that can change what
 * she does next. Everything outside this list does not open one - in particular a snapshot that re-states the revision
 * she already has, a programme still in flight with no state change, and an event that only re-states a fact already
 * delivered.
 * </p>
 * <p>
 * MEASURED 2026-11-11 (`round46b`, `2026-11-11T07-25-22-940Z_01a1c97f`): two consecutive prompt turns,
 * `07:28:19.998Z` and `07:30:43.718Z`, carried byte-identical content - the same `revision 14` reading marked
 * `本轮无新观察` and the same `<execution-result>` re-stating one `for_each` settlement. The second turn existed because
 * the settlement was published again under a fresh event id, and the pump had no record of what it had already handed
 * her. Nothing in it could have changed what she did next, and this is the class the list exists to close.
 * </p>
 */
export const TURN_OPENING = Object.freeze({
  /** The person spoke. Always opens a turn, whatever else is pending. */
  playerInput: "player_input",
  /** A fact whose content she has not received before: a settlement, a refusal, a notice, a clock mark. */
  worldFact: "world_fact",
  /** A snapshot whose revision has moved past the one she was last shown. */
  observation: "observation",
  /** A Host-owned schedule came due: the stall watch, a stale reading, a narration run (`HOST_MINTED_WAKE_KINDS`). */
  due: "due",
});

export const TURN_OPENINGS = Object.freeze(Object.values(TURN_OPENING));

export type TurnOpening = (typeof TURN_OPENINGS)[number];

/**
 * Why a flush that was EXAMINED opened no turn. Closed, so "fewer turns" and "lost turns" are distinguishable.
 *
 * The two re-statement reasons are derived from the member they answer: a batch whose only pending content is the
 * `observation` member at a revision already delivered, or `world_fact` members she already received. A fact whose
 * content is a MOMENT rather than a statement is never a re-statement (`DAY_BOUNDARY_SEMANTIC_KINDS`), so `due` needs no
 * reason of its own: a Host-minted wake fact carries its re-arm counter in its content, and a clock or day fact is news
 * every time.
 *
 * `nothing_pending` is not a lost turn: there was nothing to deliver, and counting it keeps the arithmetic closed
 * (`examined === opened + every suppressed reason`).
 */
export const TURN_SUPPRESSION = Object.freeze({
  observationRestated: `${TURN_OPENING.observation}_restated`,
  worldFactRestated: `${TURN_OPENING.worldFact}_restated`,
  nothingPending: "nothing_pending",
});

export const TURN_SUPPRESSIONS = Object.freeze(Object.values(TURN_SUPPRESSION));

export type TurnSuppression = (typeof TURN_SUPPRESSIONS)[number];

/** How the most recent examined flush was decided. */
export type TurnDecision =
  | Readonly<{ kind: "opened"; index: number; reason: TurnOpening }>
  | Readonly<{ kind: "suppressed"; reason: TurnSuppression }>;

/**
 * What this pump has done with the flushes it examined: one counter per member, one per suppression reason.
 *
 * `examined` is DERIVED (`opened + every suppressed reason`) rather than counted, so a flush cannot be decided and then
 * disappear from the account: a third outcome would break the identity instead of going unreported.
 */
export type TurnAccount = Readonly<{
  opened: number;
  byReason: Readonly<Record<TurnOpening, number>>;
  suppressed: Readonly<Record<TurnSuppression, number>>;
  examined: number;
  lastDecision: TurnDecision | undefined;
}>;

/**
 * The account as the one line a run's log carries, in the shape the invariant is read back in.
 *
 * `turns opened N · suppressed M {reason: count} · flushes examined F`. A suppression reason that has never fired is
 * still printed as `0`: it is a declared member of the closed list, and a reader must be able to see that it exists and
 * never happened rather than guess from its absence.
 */
export function turnAccountLine(account: TurnAccount): string {
  const suppressed = TURN_SUPPRESSIONS.map((reason) => `${reason}: ${String(account.suppressed[reason])}`).join(", ");
  return `turns opened ${String(account.opened)} · suppressed ${String(suppressedTotal(account))} {${suppressed}} · flushes examined ${String(account.examined)}`;
}

function suppressedTotal(account: TurnAccount): number {
  return TURN_SUPPRESSIONS.reduce((total, reason) => total + account.suppressed[reason], 0);
}

/**
 * One delivered batch: the model-facing TEXT, and the frame its readers hang on it.
 *
 * <p>
 * The text is `composeFactBrief`'s named blocks of prose (`fact-brief.ts`). It is one string and nothing parses it: what
 * a reader needs structurally - the batch identity, the inputs' locales, the presentation events - is a field here, so
 * there is exactly one spelling of each and no JSON envelope inside the model's user message.
 * </p>
 */
export type PendingBatch = Readonly<{
  batchId: string;
  disposition: Exclude<DeliveryDisposition, "hold">;
  triggerEventIds: readonly string[];
  inputs: readonly PlayerInput[];
  facts: readonly WorldFact[];
  /** The presentation events, in delivery order - what `canonicalPresentationSource` reads. */
  events: readonly NormalizedEvent[];
  /** The exact model-facing text. Retained verbatim if the sink rejects it. */
  text: string;
}>;

export type NormalizedEvent = Readonly<{
  eventId: string;
  occurredAtMs: number;
  source: string;
  kind: string;
  correlationId: string;
  revision: number;
  executionId?: string;
  requestId?: string;
  sourceEventId?: string;
  /** The Mod's own semantic identity of a `world_fact`; the presentation lease is granted on it. */
  semanticKind?: string;
  observedTick?: number;
  payload?: Readonly<Record<string, unknown>>;
  input?: PlayerInput;
}>;

// Sized from measurement, not from taste. A real run (`g97cross`) produced 870 facts in 535 s - about 1.6 per second,
// three of them per dispatch (accepted -> running -> succeeded) plus outcome semantics - while a single turn held them
// because a turn here can think for 60+ s. At 128 that window was crossed by ANY long turn, so the bridge closed
// mid-run (`g98cross`, with the drop rule already in: the window had nothing superseded left to evict, which is the
// honest refusal but the wrong outcome). 512 covers five minutes of the measured arrival rate at a stalled turn.
export const MAX_PENDING_INPUTS = 128;
export const MAX_PENDING_RECEIPTS = 512;
export const MAX_PENDING_SEMANTIC_EVENTS = 512;
export const MAX_PENDING_LIFECYCLE = 128;
export const MAX_PENDING_WORLD_FACTS = 32;

/**
 * How many delivered fact contents the pump can still recognise as "she already has this".
 *
 * Sized from the measured fact traffic rather than from taste: `round46b` delivered 58 fact batches in 36 minutes, so a
 * 512-entry memory spans roughly five hours of turns - longer than any Game session this product has recorded - while
 * costing at most a few hundred kilobytes of strings. The drain is FIFO (`#rememberDelivered`), and forgetting one is
 * the safe direction: it costs a turn rather than a fact.
 */
export const MAX_DELIVERED_FACT_IDENTITIES = 512;

/**
 * The semantic kinds whose CONTENT is a moment rather than a thing: the clock, the day, a pass-out.
 *
 * They are the one class a re-statement check must not touch, and the reason is that two of them can be byte-identical
 * while saying different things: `time_milestone` carries the time and not the day, so a 13:00 mark on day 1 and the
 * same mark on day 7 agree until the block beside them states which day it is. Suppressing the second would lose a real
 * turn - a day starting is the fact a companion most needs - so these are news every time.
 *
 * ONE SPELLING: `describeWorldChange` (is this the world contradicting the reading?) and the turn-opening rule (is this
 * a re-statement?) both read this set.
 */
export const DAY_BOUNDARY_SEMANTIC_KINDS: ReadonlySet<string> = Object.freeze(
  new Set(["time_milestone", "day_started", "night_ended_pass_out"]),
);

/**
 * The semantic kind of the fact the Host mints when an execution stops making progress.
 *
 * Measured 2026-11-08 (`round43`): the Mod owned an execution and then published nothing for more than 180 s while the
 * receipt the Host still held said `running`, the companion's session record aged past three minutes, and no turn was
 * created - her body was "busy" for the rest of the run. A stall is a condition the Host can distinguish and cannot
 * prevent, so it needs a fact of its own rather than a run audit six minutes later.
 */
export const EXECUTION_STALL_SEMANTIC_KIND = "execution_stalled";

/** The same Host-minted source label the arrival, notice, settled-plan, world-stale and narration facts carry. */
export const HOST_MINTED_FACT_SOURCE = "host_game_session";

/**
 * The semantic kind of the fact the Host mints when the world reading it re-states has outlived its bound.
 *
 * <p>
 * Measured 2026-11-10 (`round45`): the reading froze at `revision 352` for the last 50 turns of the run - 30 minutes -
 * while the clock walked from `06:00` through two `02:00` pass-outs and two day starts, the location changed (a
 * pass-out warps her to the farmhouse) and nothing re-observed. The block's own parenthetical said
 * `（这是 50 轮之前看到的，世界已经不一样了）` on every one of those turns and asked for nothing; she dispatched nothing
 * for the last 30 minutes.
 * </p>
 *
 * <p>
 * The freeze itself is not a defect of any one layer: the Mod answers a snapshot only when it is asked
 * (`BridgeSession.cs:301`), and the Host's one snapshot slot is written only by that admitted answer - so "no new
 * revision" means "nobody looked" just as often as it means "nothing changed", and the product could not tell the two
 * apart. A condition the code can compute and cannot prevent needs a fact, which is the same reason
 * `EXECUTION_STALL_SEMANTIC_KIND` exists.
 * </p>
 */
export const WORLD_STATE_STALE_SEMANTIC_KIND = "world_state_stale";

/**
 * The semantic kind of the fact the Host mints when an awake companion has spoken without acting for a while.
 *
 * <p>
 * Measured 2026-11-10 (`round45`): after 22:28:02 she dispatched nothing for the rest of the run. The last five turns
 * were pure narration - 「斧头扛上肩，靴子一踏进湿草」「推开门，晨光一下打到脸上…外头的雾还没散」 - while her body stood still
 * and the engine passed her out twice at 02:00. The run's own account is 134 assistant messages, 97 prompt turns and 60
 * `continuation` wakes: the loop kept asking and she kept narrating, and nothing in the loop said so.
 * </p>
 *
 * <p>
 * The counter that was meant to catch it (`HostService.#idleTurnsWithoutWork`) could not. Its one wake called `flush`,
 * which returns `undefined` when nothing is pending - which is the whole premise - so no turn was created, no fact was
 * published and the model was never told. A condition the code can distinguish and cannot prevent needs a fact of its
 * own, the same reason `EXECUTION_STALL_SEMANTIC_KIND` and `WORLD_STATE_STALE_SEMANTIC_KIND` exist.
 * </p>
 */
export const NARRATION_WITHOUT_WORK_SEMANTIC_KIND = "narration_without_work";

/**
 * How long an in-flight execution may go without a fact before the Host says so.
 *
 * Below the measured 180 s, so the fact arrives while the silence is still news, and above the gaps a live action leaves
 * between its own `route_progress` observations, so ordinary work never reads as a stall.
 */
export const EXECUTION_STALL_BOUND_MS = 120_000;

/**
 * Each further stall fact for the SAME execution waits this many bounds of the same silence.
 *
 * One per bound would spend the run on one refusal being re-read: an hour of silence would be thirty model turns. Four
 * bounds gives 120 s, 480 s, 840 s, ... - eight facts for an hour - which keeps the fact alive without paying for it
 * thirty times.
 */
export const EXECUTION_STALL_REARM_MULTIPLE = 4;

/**
 * One delivered turn, at the cadence this product measured.
 *
 * `round45` delivered 62 turns across 2,624,081 ms (its own `result.json`), which is 42,324 ms per turn; `round43`
 * measured ~9.4 s per turn (`body-program-script.ts` `planSettlementNote`). The slower of the two is the one used,
 * because a bound derived from the fast one would name a provider that is merely thinking.
 */
export const MEASURED_TURN_CADENCE_MS = 42_324;

/**
 * Consecutive narration turns that make `narration_without_work` due.
 *
 * DERIVED, NOT CHOSEN. The bound this file already treats as "this is no longer progress" is
 * `EXECUTION_STALL_BOUND_MS`, and at the measured cadence that is 2.84 turns - so the first whole turn past it is 3. A
 * companion who speaks once and then works (the ordinary shape, and the reason the retired bound was 2) is never named;
 * one who speaks three turns running is. Later facts re-arm by `EXECUTION_STALL_REARM_MULTIPLE`, so forty narration
 * turns are five facts (3, 12, 21, 30, 39) rather than forty.
 */
export const NARRATION_WITHOUT_WORK_TURNS = Math.ceil(EXECUTION_STALL_BOUND_MS / MEASURED_TURN_CADENCE_MS);

/**
 * Executions one pump times at once.
 *
 * The Mod serializes native mutation on one embodied actor, so the live count is one; the bound exists because the
 * record is a collection a run appends to, and its drain is the terminal receipt. An execution that never settles is
 * therefore evicted and NAMED (`stallWatch.unmeasured`), never silently forgotten.
 */
export const MAX_WATCHED_EXECUTIONS = 8;

/**
 * How many unmeasured executions one stall fact carries.
 *
 * The fact is model context, not an audit log: the FIRST few name what the watch could not date, and `omitted` says how
 * many more there were. A list that grows with the run would put the whole receipt window into a prompt, which is the
 * 2026-10-27 context blow-up this pump bounds everywhere else.
 */
export const MAX_STALL_UNMEASURED_SHOWN = 8;

export const HISTORIAN_CHUNK_FALLBACK_TOKENS = 22_879;

/**
 * Share of one fold chunk a single delivered batch may occupy.
 *
 * Below a half on purpose: at half, a fold pass spends its entire budget on one delivery and the protected
 * tail cannot shrink at all. A third leaves room for two more batches per pass.
 */
export const FACT_BATCH_SHARE_OF_CHUNK = 0.32;

/**
 * Mean characters per token measured on real fact batches.
 *
 * 4 (the usual English approximation) is wrong for this product by a factor of 1.5, which is exactly how
 * 60,000 characters came to be believed a 15k-token batch. Measured 2.47-2.76 across 22 batches from
 * `2026-10-31T19-26-54`; the low end is used in the derivation so the bound errs small.
 */
export const FACT_BATCH_CHARS_PER_TOKEN_MIN = 2.47;

/**
 * Size one batch against the chunk that consumes it.
 *
 * @param foldChunkTokens Tokens one fold pass can absorb; Magic Context's `deriveHistorianChunkTokens` is the
 * authority for this when it is reachable.
 * @returns The character bound for one delivery.
 */
export function deriveMaxBatchBytes(foldChunkTokens: number): number {
  const usable =
    Number.isFinite(foldChunkTokens) && foldChunkTokens > 0 ? foldChunkTokens : HISTORIAN_CHUNK_FALLBACK_TOKENS;
  return Math.floor(usable * FACT_BATCH_SHARE_OF_CHUNK * FACT_BATCH_CHARS_PER_TOKEN_MIN);
}

/**
 * How many characters one delivered batch may serialize to.
 *
 * The windows above bound the COUNT of pending facts. They do not bound the SIZE, and the two are not the
 * same constraint: on 2026-10-27 a twelve-minute multiday run accumulated 685 facts - 417 semantic events
 * and 260 execution receipts, comfortably inside the 512-entry windows - which serialized to 1,037,822
 * characters. The model answered `input: 373915, output: 1, stopReason: "length"` and then produced no
 * further action for the rest of the run, while the companion stood in the farmhouse with
 * `can_move=True; navigate=idle`.
 *
 * A batch must be a FRACTION of the fold chunk that consumes it, so one fold pass drains several batches
 * instead of barely one. Two earlier values got that wrong in the same direction:
 *
 *   - 120,000 characters was half a fold at best, measured 2026-10-29 (`round7`): 29 fold runs, ten
 *     messages each, three `gamebuddy_fact_batch` messages still uncleared - 104,972 of 123,130 input
 *     tokens (85%).
 *   - 60,000 characters was chosen as "roughly 15k tokens", assuming ~4 characters per token. These
 *     batches are JSON of Chinese prose beside English keys and measure 2.47-2.76 chars/token across 22
 *     of them (`2026-10-31T19-26-54`), mean 2.66. So 60,000 was 22,534 tokens against a 22,879-token
 *     chunk: 98-106% of a whole one.
 *
 * The consequence of the second: 22 uncleared batches held 434,021 tokens - 96% of all active message
 * tokens - while folding had already run 86 times. Five deliveries in 28 seconds then filled a
 * 200,000-token window (203,926) and the model answered `stopReason: "length"`.
 *
 * THE BOUND IS DERIVED, NOT CHOSEN. `deriveMaxBatchBytes` applies the same shape Magic Context uses for its
 * own budgets (`derive-budgets.ts`: a percentage of the consumer's context, clamped): a share of the fold
 * chunk, converted at the measured characters-per-token ratio.
 *
 * THE TRADE THIS MAKES, stated rather than hidden: a smaller bound means more deliveries, so one burst
 * becomes several batches instead of one. That is the direction the fold wants - it drains a fixed token
 * budget per pass, so more, smaller items drain where fewer, larger ones stall - but it is not free: each
 * delivery is a model turn. If a future measurement shows turn count rising faster than the tail shrinks,
 * the fraction is what to revisit, not the principle.
 *
 * Overflow is not dropped: `takeBatch` puts it back and the next flush delivers it.
 */
export const MAX_BATCH_BYTES = deriveMaxBatchBytes(HISTORIAN_CHUNK_FALLBACK_TOKENS);

/**
 * The language the brief is composed in when no player input rides the batch.
 *
 * Every block is Chinese (`fact-brief.ts`), and the shipped card, world book and player are Chinese: this names the
 * absence of a player utterance, not a preference. A batch that does carry player input passes its own locale.
 */
const DEFAULT_BRIEF_LOCALE = "zh-CN";

/** What the stall watch knows about one execution: when it last spoke, and what it said. */
export type WatchedExecution = Readonly<{
  executionId: string;
  /** The Mod's own action label, when the receipt carried one. */
  actionId?: string;
  /** Milliseconds since the last REAL fact for this execution. A stall fact never resets this. */
  elapsedMs: number;
  /** The last real fact's label, e.g. `execution_receipt:running`. */
  lastFactKind: string;
  /** Stall facts already minted for this execution. */
  published: number;
}>;

/** Everything one reading of the stall watch can say. */
export type StallWatchReading = Readonly<{
  /** Executions being timed, soonest due first. */
  watched: readonly WatchedExecution[];
  /** Milliseconds until `takeStallFact` has something to say; `undefined` when nothing is in flight. */
  nextStallInMs: number | undefined;
  /** The world transition holding the body, as the Mod's own `body_owned_by_*` code, when one is in progress. */
  owner: string | undefined;
  /** What ends that ownership - see `#stallEndsOwnershipWith`. */
  endsOwnershipWith: string | undefined;
  /**
   * In-flight executions the watch cannot time, each with its reason: `not_measured`, never silence.
   *
   * Two causes: a receipt that names no execution (`execution_id_absent`), and an execution whose record the bound
   * evicted while it was still running (`stall_watch_evicted:<executionId>`).
   */
  unmeasured: readonly Readonly<{ executionId?: string; reason: string }>[];
  /** How many executions `MAX_WATCHED_EXECUTIONS` evicted while the pump was running: the `evicted K` reading. */
  evicted: number;
}>;

/**
 * What the pump can say about a companion who is speaking without acting.
 *
 * <p>
 * Measured from delivered turns, because that is the only layer that sees how a turn ENDED
 * (`CompanionLoop` publishes `turnProduction`). `due` is the decision; the three fields beside it are the numbers the
 * fact prints, so a reader never has to re-derive them from the block.
 * </p>
 */
export type NarrationWithoutWorkReading = Readonly<{
  /** Consecutive delivered turns that spoke and ran no tool, with nothing in flight behind them. */
  turns: number;
  /** Milliseconds since the last delivered turn that produced work; the session's own start when none has. */
  lastWorkTurnAgoMs: number;
  /** The `turns` value the next fact waits for (`NARRATION_WITHOUT_WORK_TURNS`, re-armed by `published`). */
  boundTurns: number;
  /** Whether `takeNarrationWithoutWorkFact` has something to say now. */
  due: boolean;
}>;

/**
 * A world transition holding the companion's body, as the Mod named it.
 *
 * <p>
 * The CODE alone was the whole record, and that is what made the hold unreleasable: `flush` released it on
 * `day_started` only, so every transition whose end is not a new day held delivery until the next morning - and the
 * clock only moves when an action runs, so a held turn is the only thing that could move it. Measured 2026-11-11: a
 * `body_owned_by_navigation` refusal (a warp, a beeline the Mod owns) froze a whole session.
 * </p>
 * <p>
 * So a transition is a PAIR: the code the Mod refused with, and the owner it named. The owner is what the release
 * matches on (`#worldTransitionEnds`), because "the transition finished" is a statement about that execution, not
 * about the pump's clock.
 * </p>
 */
type WorldTransition = Readonly<{
  /** The Mod's own `body_owned_by_*` refusal code. */
  code: string;
  /** The action the refusal named as holding the body (`owner_action`), when it named one. */
  ownerAction: string | undefined;
  /** The execution that holds the body (`owner_execution_id`), when the refusal named one. */
  ownerExecutionId: string | undefined;
  /**
   * The newest snapshot revision this pump had admitted when the hold began.
   *
   * A releasing snapshot must be NEWER than this: a snapshot the pump already held describes a moment before the
   * refusal, and a re-published copy of it is not the body being free again.
   */
  entrySnapshotRevision: number;
}>;

/** One execution being timed. Mutable in place: the pump owns it and nothing else holds a reference. */
type ExecutionWatch = {
  executionId: string;
  actionId?: string;
  lastFactKind: string;
  lastFactAtMs: number;
  published: number;
};

export interface CompanionTurnSink {
  /**
   * Deliver one batch. The return value is how the turn ended; an adapter that cannot observe it returns
   * nothing, which callers must read as `unobserved` rather than as success.
   */
  deliver(batch: PendingBatch): Promise<CompanionTurnOutcome | void>;
}

/** Product-neutral Host event pump. It forwards labelled facts; it never plans or interprets receipts. */
export class CompanionEventPump {
  /**
   * The one reading a batch cannot derive from the facts it forwards: the programmes the Mod's journal still shows in
   * flight.
   *
   * <p>
   * WHY IT IS INJECTED. The pump holds receipts and world events, and neither names a programme or a node - an
   * `execution_receipt` carries an `executionId`, not the step that owned it. The layer that knows is the journal ledger
   * (`program-status-wait.ts#programStatusProgress`), which the submit echo, the settlement watch and every status call
   * already write, so the production default is that ledger and nothing had to change to wire it. It is a constructor
   * argument because a test that had to feed a process-global ledger to prove a batch's text would be one test's
   * leftover programme deciding another test's batch.
   * </p>
   *
   * <p>
   * READ ONCE PER BATCH (`takeBatch`, `takeExpiringOnly`): the byte-bound loop recomposes the same batch several times,
   * and a reading that moved between those passes would give the retry a text the delivery never had.
   * </p>
   */
  readonly #inFlight: () => InFlightProgrammeReading;

  public constructor(inFlight: () => InFlightProgrammeReading = readInFlightProgrammes) {
    this.#inFlight = inFlight;
  }

  /** The snapshot slot the next batch TAKES: consumed by `takeBatch`, so a batch carries a snapshot once. */
  #snapshot: WorldFact | undefined;
  /**
   * The world as LAST HEARD, for rendering `<world-state>` on every batch.
   *
   * <p>
   * Written whenever a snapshot is admitted, and never cleared by `takeBatch`: the slot above is latest-wins and
   * consumed, so measured `round44` carried a snapshot in only 102 of 109 batches and a block composed from it would
   * be absent from the rest. This field is the vertical slice of state that answers "what world was she last told
   * about", and nothing else reads it - the facts a batch delivers are unchanged.
   * </p>
   */
  #lastSnapshot: WorldFact | undefined;
  /** The snapshot revision the model has already been shown, so a re-statement cannot read as a fresh observation. */
  #lastSnapshotDeliveredRevision: number | undefined;
  /** `#deliveredBatches` when that revision was composed into a batch; the difference is the age `<world-state>` states. */
  #lastSnapshotDeliveredBatch = 0;
  /**
   * When the CURRENT reading's revision was admitted, for the `ageMs` half of `world_state_stale`.
   *
   * Advanced only by a revision that moves, because a re-stated copy of one reading arrives as a `snapshot` fact too
   * (`host-service.ts#restateWorldSnapshot`) and this layer cannot tell it from a re-observation of an unchanged world -
   * the block's own comment makes the same concession for `#lastSnapshotDeliveredRevision`. The one error it can make is
   * aging a reading too far, which is the safe direction for a warning.
   */
  #lastSnapshotArrivedAtMs = 0;
  /** Stale facts already published for the current reading; the re-arm, and the fact's own `staleFactsSoFar`. */
  #worldStateStalePublished = 0;
  /**
   * Facts since the current reading that say the WORLD moved: the clock, the day, a pass-out, a warp, or a body that is
   * standing somewhere else.
   *
   * <p>
   * This is what makes a stale reading a FACT rather than an alarm about silence. A reading that has aged while the world
   * said nothing new is just an old picture of an unchanged world; a reading that has aged while the Mod published
   * `time_milestone`, `night_ended_pass_out`, `day_started` or its own `snapshot_changed` is a picture the world has
   * already contradicted.
   * </p>
   * <p>
   * MEASURED 2026-11-10 (`round45`): she entered the farmhouse at 22:25:25 (`enter_exit_completed` revision 348), the
   * published reading was taken inside at `(9,9)` and reached the model at 22:25:51 (`revision 352`), and then she walked
   * back out at 22:26:19 - `enter_exit_completed` revision 364 AND the Mod's own `snapshot_changed:warped` at revision 364.
   * That fact says the world is now at 364 while the block still said 352, and for the next fifty turns the block said
   * `农舍 (9,9)` while her body was on the Farm at `(39,15)`. Nothing connected the world's own statement to the block.
   * </p>
   */
  #worldChangesSinceReading = 0;
  /** The newest of those changes, as a label a fact can print (`snapshot_changed:warped`, `location:Farm`, …). */
  #lastWorldChange: string | undefined;
  readonly #receipts = new Map<string, WorldFact>();
  readonly #semanticEvents = new Map<string, WorldFact>();
  readonly #lifecycle = new Map<string, WorldFact>();
  readonly #worldFacts = new Map<string, WorldFact>();
  readonly #inputs: PlayerInput[] = [];
  /**
   * What each held PROGRESS slot last TOLD the model, by slot key (see `factContentIdentity`).
   *
   * The windows below keep one fact per slot, but the surviving fact was re-delivered into every later
   * batch, so a body that never left its tile was described again and again. Measured 2026-10-27 on a
   * twelve-minute session: `input` reached 114,569 tokens against a 131,072 window and the model answered
   * `stopReason: "length"` twice; the fact traffic by semantic kind was `route_progress` 859,
   * `execution_settled_succeeded` 219, `body_idle` 211, `execution_started` 184.
   *
   * A fact whose slot already told the model this exact state carries no information, so it stays behind.
   * It still triggers nothing either way (see `#opening`): progress never minted a turn.
   */
  readonly #deliveredProgress = new Map<string, string>();
  /**
   * What each fact she has been SHOWN said, by content (`factContentIdentity`), so a re-statement cannot open a turn.
   *
   * <p>
   * The windows above cannot answer this: a fact the pump has delivered leaves its window, and the next publish of the
   * same content arrives under a fresh event id - so "is this news" had no record to ask, and the pump opened a turn for
   * every copy. Measured 2026-11-11 (`round46b`): two consecutive prompt turns carried the same settlement verbatim.
   * </p>
   * <p>
   * BOUNDED, WITH A DRAIN: the oldest identity is forgotten when `MAX_DELIVERED_FACT_IDENTITIES` is reached, and a
   * re-delivery moves its own identity to the young end. The only error the drain can make is calling something news
   * again hours later, which costs a turn rather than losing a fact - and it is the direction a bound on a set of
   * strings has to err in, because the opposite would silence a real fact.
   * </p>
   */
  readonly #deliveredFactIdentities = new Set<string>();
  /** Turns this pump opened, one count per `TURN_OPENINGS` member. */
  readonly #openedByReason: Record<TurnOpening, number> = {
    [TURN_OPENING.playerInput]: 0,
    [TURN_OPENING.worldFact]: 0,
    [TURN_OPENING.observation]: 0,
    [TURN_OPENING.due]: 0,
  };
  #openedTurns = 0;
  /** Examined flushes that opened no turn, one count per `TURN_SUPPRESSIONS` member. */
  readonly #suppressedByReason: Record<TurnSuppression, number> = {
    [TURN_SUPPRESSION.observationRestated]: 0,
    [TURN_SUPPRESSION.worldFactRestated]: 0,
    [TURN_SUPPRESSION.nothingPending]: 0,
  };
  #lastTurnDecision: TurnDecision | undefined;
  /**
   * One timing record per execution the pump has seen and not seen settle.
   *
   * A record of its own rather than a reading of `#receipts`, because `takeBatch` empties that window on every delivery
   * - so the receipt window can answer "is an execution in flight" only until the next turn, while the stall question
   * spans turns by definition.
   */
  readonly #watch = new Map<string, ExecutionWatch>();
  #evictedExecutions = 0;
  /**
   * The exact batch a rejected delivery owned, WITH the reason it asked for its turn.
   *
   * One field rather than two, because a retry that lost its opening reason would be a batch the gate could neither open
   * a turn for nor name a suppression for: the two facts are one decision and are stored as one.
   */
  #retry: Readonly<{ batch: PendingBatch; opening: TurnOpening }> | undefined;
  /**
   * How many batches this pump has handed to a turn that accepted them.
   *
   * The one age the Host can put on state it re-states: a snapshot is not refreshed between turns, so "how many
   * turns have been delivered since this reading arrived" is the only honest measure of how old the block is. A
   * batch the sink rejected is not counted - the model never read it.
   */
  #deliveredBatches = 0;
  /**
   * Consecutive delivered turns that spoke and ran no tool, with nothing in flight behind them.
   *
   * <p>
   * The measurement `NARRATION_WITHOUT_WORK_SEMANTIC_KIND` publishes. It lives here rather than in the Host because a
   * turn's production is published to the pump by the loop that saw it, and because the pump is the layer that can also
   * see whether anything is still executing - so "she spoke and did nothing" is one reading, not two counters that can
   * disagree.
   * </p>
   */
  #turnsWithoutWork = 0;
  /** When the last delivered turn produced work; the pump's own start when none has, so the age is never undefined. */
  #lastWorkTurnAtMs = Date.now();
  /** Narration facts already published for this run: the re-arm, and the fact's own `narrationFactsSoFar`. */
  #narrationWithoutWorkPublished = 0;
  /** Facts the bounds dropped instead of closing the bridge (see the full-queue branch of `enqueueFact`). */
  #droppedFacts = 0;
  #delivering = false;
  // A clear can race an awaited sink delivery. Its generation revokes the
  // captured batch so a late rejection cannot resurrect stale facts.
  #generation = 0;

  public enqueueFact(fact: WorldFact): void {
    if (typeof fact.source !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(fact.source))
      throw new Error("invalid_world_fact_source");
    if (fact.source === "host_local_transport" && (fact.kind !== "lifecycle" || fact.revision !== 0))
      throw new Error("invalid_local_transport_fact");
    const frozen = Object.freeze({ ...fact });
    this.#observeWorldTransition(frozen);
    this.#observeExecutionProgress(frozen);
    if (fact.kind === "snapshot") {
      const previous = this.#lastSnapshot;
      const advances = previous === undefined || fact.revision > previous.revision;
      if (this.#snapshot === undefined || fact.revision >= this.#snapshot.revision) this.#snapshot = frozen;
      if (previous === undefined || fact.revision >= previous.revision) this.#lastSnapshot = frozen;
      if (advances) {
        this.#lastSnapshotArrivedAtMs = Date.now();
        this.#worldStateStalePublished = 0;
        this.#worldChangesSinceReading = 0;
        this.#lastWorldChange = undefined;
      }
      return;
    }
    // The world saying it moved is the other half of "this reading is stale": see `#worldChangesSinceReading`.
    this.#observeWorldChange(frozen);
    // An execution that has SETTLED can publish no further progress, so its record is dead weight. Dropping
    // it here keeps the record bounded by the in-flight executions instead of by the session's action count.
    if (isTerminalExecutionFact(fact)) this.#forgetSettledProgress(fact);
    const destination =
      fact.kind === "execution_receipt"
        ? this.#receipts
        : fact.kind === "semantic_event"
          ? this.#semanticEvents
          : fact.kind === "world_fact"
            ? this.#worldFacts
            : this.#lifecycle;
    const limit =
      fact.kind === "execution_receipt"
        ? MAX_PENDING_RECEIPTS
        : fact.kind === "semantic_event"
          ? MAX_PENDING_SEMANTIC_EVENTS
          : fact.kind === "world_fact"
            ? MAX_PENDING_WORLD_FACTS
            : MAX_PENDING_LIFECYCLE;
    // Stable world-fact identity is the Mod eventId; correlationId is only a
    // transport-scoped routing label. Same eventId/different correlationId is
    // one fact, while distinct eventIds never collapse.
    //
    // A PROGRESS semantic event collapses onto the thing it is progressing: its execution when it names one, or
    // its kind when it does not (`body_idle` describes the actor, not an execution). The Mod mints a fresh
    // correlationId per event, so keying these by correlationId gave every per-tile observation its own slot -
    // and one long agent turn's 129 route observations filled the 128-entry window, which closed the bridge
    // mid-run (measured 2026-10-17). Collapsing them is what the receipt half of the same traffic already does.
    const key = factSlotKey(fact);
    if (!destination.has(key) && destination.size >= limit) {
      // FULL - and there are two different situations here that must not be answered the same way.
      //
      // A TERMINAL receipt is the authority for its execution: dropping it leaves a request that never settles, which is
      // exactly the shape the pump's fail-closed policy exists to refuse. Every OTHER fact only describes state that a
      // later fact describes again, so when the window is full the ARRIVAL is what can go - counted, never silent.
      //
      // Measured 2026-10-19 (`g97cross`): 870 facts in one run, 470 of them receipts, arriving while a turn was in
      // flight (a turn here thinks for 60+ s). The window is what makes a long turn safe; closing the whole bridge on it
      // is not what "bounded" has to mean, and it ended that run short of its night.
      if (isSupersededFact(fact)) {
        this.#droppedFacts += 1;
        return;
      }
      const evictable = [...destination.entries()].find(([, entry]) => isSupersededFact(entry));
      // A WORLD-FACT window is the one window that can fill with facts no later fact repeats: a day
      // started, a clock milestone, a native notice. Nothing in it is supersedable, so there is
      // nothing to evict - and closing the bridge over that destroys a healthy pipe, every fact it
      // held, and the session, to avoid losing one observation.
      //
      // The ARRIVAL always survives: it is the newest thing the world did, and dropping it would
      // leave the window permanently full of the OLDEST facts (`takeBatch` already applies the same
      // rule to a batch that is too large - a later fact describes a later world). What goes instead
      // is the OLDEST observation, and it is COUNTED (`droppedFacts`), so the loss is named rather
      // than silent. A terminal receipt and an execution OUTCOME keep failing closed: those are the
      // authority for an execution, and losing one leaves a request that never settles.
      const evictedKey = evictable?.[0] ?? (fact.kind === "world_fact" ? oldestWorldFactKey(destination) : undefined);
      if (evictedKey === undefined)
        throw new Error(
          fact.kind === "execution_receipt" ? "event_pump_terminal_overflow" : "event_pump_event_overflow",
        );
      destination.delete(evictedKey);
      this.#droppedFacts += 1;
    }
    const previous = destination.get(key);
    if (previous === undefined || fact.revision >= previous.revision) destination.set(key, frozen);
  }

  /**
   * Put a fact back in the window it came from, without re-running admission.
   *
   * Used only by `takeBatch` when a batch had to be split to fit the byte bound. These facts were
   * already admitted and may be older than what is in the window now, so re-admitting them would let an
   * older fact evict a newer one - the opposite of what the bound is for.
   */
  /** Forget both slots a settled execution could still be holding. Neither can publish again. */
  #forgetSettledProgress(fact: WorldFact): void {
    this.#deliveredProgress.delete(factSlotKey(fact));
    const executionId = fact.executionId;
    if (executionId !== undefined) this.#deliveredProgress.delete(executionProgressSlotKey(executionId));
  }

  #readmit(fact: WorldFact): void {
    const destination =
      fact.kind === "execution_receipt"
        ? this.#receipts
        : fact.kind === "semantic_event"
          ? this.#semanticEvents
          : fact.kind === "world_fact"
            ? this.#worldFacts
            : this.#lifecycle;
    const key = factSlotKey(fact);
    if (!destination.has(key)) destination.set(key, fact);
  }
  public enqueuePlayerInput(input: PlayerInput): void {
    if (input.text.length === 0)
      throw new Error(input.source === "voice_final" ? "empty_final_voice_input" : "empty_player_input");
    if (this.#inputs.length >= MAX_PENDING_INPUTS) throw new Error("event_pump_input_overflow");
    this.#inputs.push(Object.freeze({ ...input }));
  }

  /** How many facts the bounds have dropped instead of closing the bridge. Named, because every drop is a loss. */
  public get droppedFacts(): number {
    return this.#droppedFacts;
  }

  /** How many batches have been delivered to a turn (see `#deliveredBatches`). */
  public get deliveredBatches(): number {
    return this.#deliveredBatches;
  }

  /** Dispose-time cancellation boundary; pending facts are never replayed into a closed runtime. */
  public clear(): void {
    this.#generation++;
    this.#snapshot = undefined;
    this.#lastSnapshot = undefined;
    this.#lastSnapshotDeliveredRevision = undefined;
    this.#lastSnapshotDeliveredBatch = 0;
    this.#lastSnapshotArrivedAtMs = 0;
    this.#worldStateStalePublished = 0;
    this.#worldChangesSinceReading = 0;
    this.#lastWorldChange = undefined;
    this.#receipts.clear();
    this.#semanticEvents.clear();
    this.#lifecycle.clear();
    this.#worldFacts.clear();
    this.#inputs.length = 0;
    this.#deliveredProgress.clear();
    this.#watch.clear();
    this.#evictedExecutions = 0;
    this.#worldTransition = null;
    this.#retry = undefined;
    this.#turnsWithoutWork = 0;
    this.#lastWorkTurnAtMs = Date.now();
    this.#narrationWithoutWorkPublished = 0;
    // The turn account and the delivered-content memory are this session's own measurements: a cleared pump belongs to
    // no run, and carrying either across it would let one session's turns answer for another's.
    this.#deliveredFactIdentities.clear();
    this.#openedTurns = 0;
    for (const reason of TURN_OPENINGS) this.#openedByReason[reason] = 0;
    for (const reason of TURN_SUPPRESSIONS) this.#suppressedByReason[reason] = 0;
    this.#lastTurnDecision = undefined;
  }

  public get pendingCount(): number {
    return (
      (this.#snapshot === undefined ? 0 : 1) +
      this.#receipts.size +
      this.#semanticEvents.size +
      this.#lifecycle.size +
      this.#worldFacts.size +
      this.#inputs.length +
      (this.#retry === undefined ? 0 : this.#retry.batch.inputs.length + this.#retry.batch.facts.length)
    );
  }

  /** True only when pending state can create a Pi turn; held state remains latest-only. */
  public get hasPendingDelivery(): boolean {
    return this.#retry !== undefined || this.#opening() !== undefined;
  }

  /**
   * What this pump has decided about the flushes it examined (see `TurnAccount`), and the one reading a run's log needs.
   *
   * Read by the caller that opens turns (`CompanionLoop.flush`) so the account is printed where turns are created, and by
   * `turn_without_new_content` so "fewer turns" and "lost turns" are different answers instead of one number.
   */
  public get turnAccount(): TurnAccount {
    const suppressed = TURN_SUPPRESSIONS.reduce((total, reason) => total + this.#suppressedByReason[reason], 0);
    return Object.freeze({
      opened: this.#openedTurns,
      byReason: Object.freeze({ ...this.#openedByReason }),
      suppressed: Object.freeze({ ...this.#suppressedByReason }),
      examined: this.#openedTurns + suppressed,
      lastDecision: this.#lastTurnDecision,
    });
  }

  /**
   * What the most recently DELIVERED turn did, as the layer that saw Pi's event stream measured it.
   *
   * <p>
   * Set by `CompanionLoop` after each delivery, because that is the only layer that sees Pi's stream. The three states
   * are the whole population, and they are separate because the pump acts differently on each: `worked` clears the
   * narration run, `spoke` extends it, `silent` ends it. A boolean could not say `silent`, and reading a turn that
   * carried nothing as narration would blame her for a provider that answered with nothing - which
   * `provider_empty_completion` already names on its own path.
   * </p>
   */
  public turnProduction: TurnProduction = TURN_PRODUCTION.saidNothing;

  /**
   * The steer currently queued into a running turn, until Pi settles it.
   *
   * <p>
   * Its only job is to stop the same expiring fact being handed to Pi twice: while this is pending the next
   * `flush` waits for it rather than composing another steer from the same window.
   * </p>
   */
  #steerInFlight: Promise<boolean> | undefined;

  /**
   * The world is mid-transition and the companion's BODY is owned by it.
   *
   * <p>
   * Day advance is the measured case: at 22:00 the companion runs `sleep()`, the Mod answers
   * `body_owned_by_day_advance`, and the pump kept delivering - a 23:40 batch, a 24:10 full snapshot, and then the
   * engine's own 26:00 `night_ended_pass_out_day_5` - to a character who was, in the fiction, asleep. She rationalised
   * it the only way available to her and said "睡到系统替我关灯了", which is the machinery showing through the stage.
   * </p>
   * <p>
   * The same window exists for every transition that takes the body: a warp, a cutscene, a festival, a pass-out. The
   * class is "facts describing the runtime's own bookkeeping reach the persona while the persona is inside a state the
   * player reads as asleep, waiting or loading". So the guard is not named after sleep.
   * </p>
   * <p>
   * While this is set, `flush` delivers nothing: the facts stay queued, nothing is dropped, and the first flush after
   * the transition ends carries them together with the fact that ended it. Player input is queued too - a person
   * typing is not told to wait by our bookkeeping - and STOP never comes through here at all.
   * </p>
   */
  #worldTransition: WorldTransition | null = null;

  /**
   * Read the transition state off the facts, because that is the one thing both sides already agree on.
   *
   * <p>
   * ENTERING is the Mod saying the body is no longer ours - `body_owned_by_*` arrives as a refusal code, together with
   * the owner it names. LEAVING is the fact that ends THAT transition, whichever of the game's own statements comes
   * first (see `#worldTransitionEnds`). A timeout is not one of them: it would be a second authority that can disagree
   * with the game, and a release on the wrong tick puts the machinery back through the stage.
   * </p>
   */
  #observeWorldTransition(fact: WorldFact): void {
    const payload = fact.payload as Record<string, unknown> | undefined;
    const codes = [payload?.reasonCode, payload?.failureCode, payload?.rejectionCode].filter(
      (value): value is string => typeof value === "string",
    );
    const owned = codes.find((code) => code.startsWith("body_owned_by_"));
    if (owned !== undefined) {
      this.#worldTransition = Object.freeze({
        code: owned,
        ownerAction: bodyOwnerField(payload, "owner_action"),
        ownerExecutionId: bodyOwnerField(payload, "owner_execution_id"),
        entrySnapshotRevision: this.#lastSnapshot?.revision ?? -1,
      });
      return;
    }
    const hold = this.#worldTransition;
    if (hold !== null && this.#worldTransitionEnds(hold, fact, payload)) this.#worldTransition = null;
  }

  /**
   * Whether this fact is the transition ENDING, in one of the three forms the GAME itself states it.
   *
   * <p>
   * 1. `day_started` - the day actually starting, unchanged: it is the release for a day advance and also the fact the
   * companion needs in order to know where it now is.
   * </p>
   * <p>
   * 2. The owning execution's own TERMINAL receipt - the game saying the transition it was running has finished. It must
   * be the OWNER's: the refusal that started the hold is itself a terminal receipt, and an unrelated execution settling
   * says nothing about this one. When the Mod named an execution that is the identity; `owner_action` is the fallback
   * for the owners whose execution id the Mod does not know (`owner_execution_id=unknown`).
   * </p>
   * <p>
   * 3. A snapshot NEWER than the hold whose `actionable` is true - the Mod's own admission gate saying the body is free
   * again. It is the same authority that minted the refusal, so the two cannot disagree about whether a hold is still
   * there.
   * </p>
   */
  #worldTransitionEnds(hold: WorldTransition, fact: WorldFact, payload: Record<string, unknown> | undefined): boolean {
    const kind =
      typeof payload?.kind === "string" ? payload.kind : typeof payload?.state === "string" ? payload.state : "";
    if (kind === "day_started") return true;
    if (fact.kind === "execution_receipt" && isTerminalExecutionFact(fact)) {
      if (hold.ownerExecutionId !== undefined) return fact.executionId === hold.ownerExecutionId;
      return hold.ownerAction !== undefined && payload?.actionId === hold.ownerAction;
    }
    if (fact.kind !== "snapshot") return false;
    return fact.revision > hold.entrySnapshotRevision && payload?.actionable === true;
  }

  /** Whether the pump is holding delivery because the body is owned by a world transition. */
  public get isWorldTransition(): boolean {
    return this.#worldTransition !== null;
  }

  /** Authenticated player input has been accepted but is not yet Pi-consumed. */
  public get hasPendingPlayerInput(): boolean {
    return this.#inputs.length > 0 || (this.#retry?.batch.inputs.length ?? 0) > 0;
  }

  /**
   * Whether the Mod is executing something for the companion, read from the receipts this pump still holds.
   *
   * <p>
   * Derived, not flagged: an execution receipt's window slot is its own `executionId`
   * (`stardew-integration-launcher-body-program.internal.ts:toWorldFact` sets `correlationId` to it), so the terminal
   * receipt for an execution REPLACES the `accepted`/`running` one and "does any held receipt describe an execution that
   * has not settled" is the whole question. There is no second map to keep in step, and therefore nothing that can
   * disagree with the receipts it summarises.
   * </p>
   * <p>
   * What it does NOT claim: the windows hold only what a turn has not delivered (`takeBatch` empties them), so `false`
   * means "this pump is holding no unfinished execution", not "nothing in the world is running". That is the honest
   * reading for `companion-activity.ts`, whose `busy` is published where the pump's own view is the answer.
   * </p>
   */
  public get hasExecutionInFlight(): boolean {
    for (const fact of this.#receipts.values()) if (!isTerminalExecutionFact(fact)) return true;
    return false;
  }

  /**
   * What the stall watch can say right now: which executions it is timing, and when the next stall fact is due.
   *
   * <p>
   * THE SPLIT THIS IMPLEMENTS: the pump measures, the Host owns liveness. Reading this enqueues, mints and delivers
   * nothing. The Host arms ONE timer from `nextStallInMs` while an execution is in flight and asks `takeStallFact` when
   * it fires, so starting a turn stays where every other turn start already lives (`HostService.#turnOwesAnother`).
   * </p>
   * <p>
   * An execution the watch cannot date is reported in `unmeasured` with its reason rather than omitted: a silent zero
   * would read as "nothing is stuck", which is the one answer this reading must never invent.
   * </p>
   */
  public get stallWatch(): StallWatchReading {
    const nowMs = Date.now();
    const watched: WatchedExecution[] = [];
    for (const watch of this.#watch.values()) {
      watched.push(
        Object.freeze({
          executionId: watch.executionId,
          ...(watch.actionId === undefined ? {} : { actionId: watch.actionId }),
          elapsedMs: nowMs - watch.lastFactAtMs,
          lastFactKind: watch.lastFactKind,
          published: watch.published,
        }),
      );
    }
    watched.sort(
      (left, right) =>
        stallThresholdMs(left.published) - left.elapsedMs - (stallThresholdMs(right.published) - right.elapsedMs) ||
        left.executionId.localeCompare(right.executionId),
    );
    const unmeasured: Array<Readonly<{ executionId?: string; reason: string }>> = [];
    for (const fact of this.#receipts.values()) {
      if (isTerminalExecutionFact(fact)) continue;
      const executionId = fact.executionId;
      if (executionId !== undefined && executionId.length > 0 && this.#watch.has(executionId)) continue;
      const named = executionId !== undefined && executionId.length > 0;
      unmeasured.push(
        Object.freeze({
          ...(named ? { executionId } : {}),
          reason: named ? `stall_watch_evicted:${executionId}` : "execution_id_absent",
        }),
      );
    }
    const first = watched[0];
    return Object.freeze({
      watched: Object.freeze(watched),
      nextStallInMs: first === undefined ? undefined : Math.max(0, stallThresholdMs(first.published) - first.elapsedMs),
      owner: this.#worldTransition?.code,
      endsOwnershipWith: this.#stallEndsOwnershipWith(),
      unmeasured: Object.freeze(unmeasured),
      evicted: this.#evictedExecutions,
    });
  }

  /**
   * The fact that says an execution has stopped making progress, or `undefined` when none is due yet.
   *
   * <p>
   * Minted here rather than composed by the caller so the payload has ONE spelling, and counted here so a long stall is
   * bounded: `published` is what moves the next threshold out (`EXECUTION_STALL_REARM_MULTIPLE`). The threshold itself
   * is measured from the last REAL fact, so a stall fact never silences the next one.
   * </p>
   * <p>
   * No prose: the pump holds no presentation locale (the notice ledger reads one from the snapshot), and these keys say
   * the same thing in any language - which execution, how long it has been silent, what it last said, and what would
   * release it.
   * </p>
   */
  public takeStallFact(): WorldFact | undefined {
    const nowMs = Date.now();
    let due: ExecutionWatch | undefined;
    for (const watch of this.#watch.values()) {
      if (nowMs - watch.lastFactAtMs < stallThresholdMs(watch.published)) continue;
      if (due === undefined || watch.lastFactAtMs < due.lastFactAtMs) due = watch;
    }
    if (due === undefined) return undefined;
    due.published += 1;
    const reading = this.stallWatch;
    const elapsedMs = nowMs - due.lastFactAtMs;
    const eventId = `${EXECUTION_STALL_SEMANTIC_KIND}_${due.executionId}_${String(due.published)}`;
    const shown = reading.unmeasured.slice(0, MAX_STALL_UNMEASURED_SHOWN);
    return Object.freeze({
      source: HOST_MINTED_FACT_SOURCE,
      kind: "world_fact" as const,
      eventId,
      sourceEventId: eventId,
      correlationId: due.executionId,
      revision: due.published,
      occurredAtMs: nowMs,
      executionId: due.executionId,
      semanticKind: EXECUTION_STALL_SEMANTIC_KIND,
      payload: Object.freeze({
        kind: EXECUTION_STALL_SEMANTIC_KIND,
        executionId: due.executionId,
        actionId: due.actionId ?? null,
        elapsedMs,
        lastFactKind: due.lastFactKind,
        stallFactsSoFar: due.published,
        owner: reading.owner ?? null,
        endsOwnershipWith: reading.endsOwnershipWith ?? null,
        // A null owner on its own reads as "nobody holds the body". What this fact actually knows when it is null is
        // narrower: no body-owning transition is in progress, so nothing beyond this execution's own terminal receipt
        // would release it. Naming that is the difference between "nobody holds it" and "this fact cannot say who does".
        ...(reading.owner === undefined
          ? { ownershipAbsentReason: "no_body_owning_transition_in_progress" as const }
          : {}),
        watched: reading.watched.length,
        evicted: reading.evicted,
        ...(reading.unmeasured.length === 0
          ? {}
          : {
              unmeasured: shown,
              omitted: reading.unmeasured.length - shown.length,
            }),
      }),
    });
  }

  /**
   * Keep the stall timing for whichever execution this fact belongs to.
   *
   * <p>
   * Every fact carrying an `executionId` is evidence its execution is still moving; only the terminal receipt ends it.
   * The arrival clock is the pump's own (`Date.now()`), not the Mod's `occurredAtMs`: two processes' clocks disagree, and
   * a silence measured across them would be an argument between clocks rather than a duration.
   * </p>
   */
  #observeExecutionProgress(fact: WorldFact): void {
    const executionId = fact.executionId;
    if (executionId === undefined || executionId.length === 0) return;
    if (isTerminalExecutionFact(fact)) {
      this.#watch.delete(executionId);
      return;
    }
    // The pump's OWN stall fact is not progress: counting it would push the next threshold out by a re-arm multiple and
    // let one stall silence the next.
    if (fact.semanticKind === EXECUTION_STALL_SEMANTIC_KIND) return;
    const nowMs = Date.now();
    const existing = this.#watch.get(executionId);
    const actionId = typeof fact.payload.actionId === "string" ? fact.payload.actionId : undefined;
    if (existing === undefined) {
      if (this.#watch.size >= MAX_WATCHED_EXECUTIONS) this.#evictLeastRecentWatch();
      this.#watch.set(executionId, {
        executionId,
        ...(actionId === undefined ? {} : { actionId }),
        lastFactKind: factLabel(fact),
        lastFactAtMs: nowMs,
        published: 0,
      });
      return;
    }
    existing.lastFactKind = factLabel(fact);
    existing.lastFactAtMs = nowMs;
    if (actionId !== undefined) existing.actionId = actionId;
  }

  /** Drop the record whose execution has been quiet longest, and keep its id among `unmeasured`. */
  #evictLeastRecentWatch(): void {
    let victim: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [executionId, watch] of this.#watch) {
      if (watch.lastFactAtMs < oldest) {
        oldest = watch.lastFactAtMs;
        victim = executionId;
      }
    }
    if (victim === undefined) return;
    this.#watch.delete(victim);
    this.#evictedExecutions += 1;
  }

  /**
   * What releases the body from the transition holding it.
   *
   * <p>
   * The action the Mod's refusal named as holding the body (`owner_action`), because that execution ending is what
   * releases it; or, when the Mod named none, the fact the transition guard has always cleared on (`day_started`).
   * Both are the game's statements - `#worldTransitionEnds` also ends the hold on the owner's terminal receipt and on
   * a snapshot that shows the body free, and neither is derivable from this one label.
   * </p>
   */
  #stallEndsOwnershipWith(): string | undefined {
    const hold = this.#worldTransition;
    if (hold === null) return undefined;
    return hold.ownerAction ?? "day_started";
  }

  public async flush(sink: CompanionTurnSink): Promise<CompanionTurnOutcome | undefined> {
    // HELD, NOT DROPPED. A companion whose body is inside a transition does not get woken to read the runtime's
    // bookkeeping; the facts wait for the transition to end and arrive together with the fact that ended it. A hold is
    // not a decision this gate owns, so it is neither examined nor named - and the previous decision is cleared so a
    // caller cannot read a hold as the answer to this flush.
    if (this.isWorldTransition) {
      this.#lastTurnDecision = undefined;
      return undefined;
    }
    // A delivery already in flight is the same turn, not another one.
    if (this.#delivering) {
      this.#lastTurnDecision = undefined;
      return undefined;
    }
    const retry = this.#retry;
    const opening = retry === undefined ? this.#opening() : retry.opening;
    if (opening === undefined) {
      this.#suppress(this.#suppressionReason());
      return undefined;
    }
    this.#delivering = true;
    const generation = this.#generation;
    const pending = retry?.batch ?? this.takeBatch();
    this.#retry = undefined;
    this.#openedTurns += 1;
    this.#openedByReason[opening] += 1;
    this.#lastTurnDecision = Object.freeze({ kind: "opened", index: this.#openedTurns, reason: opening });
    try {
      const outcome = (await sink.deliver(pending)) ?? undefined;
      this.#deliveredBatches += 1;
      this.#observeTurnProduction(outcome);
      return outcome;
    } catch (error) {
      // Do not revive a batch cleared while its asynchronous delivery was in
      // flight. Facts admitted after clear belong to the current generation.
      if (this.#generation === generation) this.#retry = Object.freeze({ batch: pending, opening });
      throw error;
    } finally {
      this.#delivering = false;
    }
  }

  /**
   * Why this flush would open a turn, or `undefined` when everything waiting is something she already has.
   *
   * ONE place: `hasPendingDelivery`, `flush` and the account all ask this, so "is a turn owed" and "was one taken"
   * cannot disagree.
   */
  #opening(): TurnOpening | undefined {
    if (this.#inputs.length > 0) return TURN_OPENING.playerInput;
    if (this.#snapshotAdvanced()) return TURN_OPENING.observation;
    for (const fact of this.#ordinaryFacts()) {
      if (isHeldFact(fact) || this.#isRestatement(fact)) continue;
      return isDueFact(fact) ? TURN_OPENING.due : TURN_OPENING.worldFact;
    }
    return undefined;
  }

  /**
   * Whether this fact tells her exactly what a fact already delivered told her.
   *
   * A clock or day fact is never one (see `DAY_BOUNDARY_SEMANTIC_KINDS`), and neither is a fact nobody has delivered.
   */
  #isRestatement(fact: WorldFact): boolean {
    return isRestatementEligible(fact) && this.#deliveredFactIdentities.has(factContentIdentity(fact));
  }

  /**
   * Whether the held snapshot is a revision she has not been shown.
   *
   * A reading with no DELIVERED predecessor is not one: the membership is "moved past the last one delivered", and the
   * session's first picture is carried by the turn that attachment itself asks for (`host-service.ts` states it in the
   * arrival fact and re-states it before every turn). Counting the first reading as an opening would turn every session's
   * attach into a turn of its own, which is a session-start behaviour this gate has no business changing.
   */
  #snapshotAdvanced(): boolean {
    const snapshot = this.#snapshot;
    const delivered = this.#lastSnapshotDeliveredRevision;
    return snapshot !== undefined && delivered !== undefined && snapshot.revision > delivered;
  }

  /** Every fact waiting in an ordinary window: the population the fact members of the closed list are read from. */
  #ordinaryFacts(): readonly WorldFact[] {
    return [
      ...this.#receipts.values(),
      ...this.#semanticEvents.values(),
      ...this.#lifecycle.values(),
      ...this.#worldFacts.values(),
    ];
  }

  /**
   * Which member a suppressed flush was answered by absence of.
   *
   * An ordinary fact that is waiting but NOT an opening one is a fact whose content she already received (`#opening`
   * skipped it for that reason); a snapshot waiting at exactly the revision she was shown is the observation member
   * re-stated. `nothing_pending` is the rest - including a FIRST reading, which no turn opens for because nothing in it
   * moved past what she was delivered.
   */
  #suppressionReason(): TurnSuppression {
    if (this.#ordinaryFacts().some((fact) => !isHeldFact(fact) && this.#isRestatement(fact)))
      return TURN_SUPPRESSION.worldFactRestated;
    if (this.#snapshot !== undefined && this.#snapshot.revision === this.#lastSnapshotDeliveredRevision)
      return TURN_SUPPRESSION.observationRestated;
    return TURN_SUPPRESSION.nothingPending;
  }

  #suppress(reason: TurnSuppression): void {
    this.#suppressedByReason[reason] += 1;
    this.#lastTurnDecision = Object.freeze({ kind: "suppressed", reason });
  }

  /**
   * Record what a batch TAUGHT the model, so the same content arriving again is not a turn.
   *
   * Recorded for what the batch actually CARRIES (a fact the byte bound pushed into a later batch was not delivered),
   * for the same reason `#deliveredProgress` is.
   */
  #rememberDelivered(facts: readonly WorldFact[]): void {
    for (const fact of facts) {
      if (!isRestatementEligible(fact)) continue;
      const identity = factContentIdentity(fact);
      this.#deliveredFactIdentities.delete(identity);
      this.#deliveredFactIdentities.add(identity);
      for (const oldest of this.#deliveredFactIdentities) {
        if (this.#deliveredFactIdentities.size <= MAX_DELIVERED_FACT_IDENTITIES) break;
        this.#deliveredFactIdentities.delete(oldest);
      }
    }
  }

  /**
   * Hand the expiring facts to the RUNNING turn, without composing a turn of its own.
   *
   * <p>
   * This is a separate method from `flush` because the two answer different questions and live on different clocks.
   * `flush` means "there is pending work, start or continue a turn", and its caller (`HostService.#flushSoon`) holds
   * a `#flushScheduled` flag for the entire duration of that turn - so anything routed through `flush` cannot run
   * while a turn is in flight, which is the only time a steer is useful. `steer` means "inject into the turn that is
   * already running"; putting it inside the turn-scoped method made it dead code.
   * </p>
   * <p>
   * Measured 2026-11-02 (`round25`): 8 milestones, 2 answered. The two that landed were the day-start ones, where
   * the turn happened to be ending anyway; 1200 / 1800 / 2200 all arrived mid-turn and none reached the model.
   * </p>
   *
   * @returns true when a steer was handed to the sink, false when there was nothing expiring to send.
   */
  public async steer(sink: CompanionTurnSink): Promise<boolean> {
    const steering = this.#steerInFlight;
    if (steering !== undefined) {
      const settled = await steering;
      this.#steerInFlight = undefined;
      if (!settled) return false;
    }
    const expiring = this.takeExpiringOnly();
    if (expiring === undefined) return false;
    this.#steerInFlight = sink.deliver(expiring).then(
      () => true,
      () => false,
    );
    await this.#steerInFlight;
    this.#steerInFlight = undefined;
    return true;
  }

  /**
   * Whether anything waiting describes a moment that will have passed by the time a run ends.
   *
   * <p>
   * Read by `HostService` to decide whether an arriving fact warrants a steer at all, so the narrowness here is what
   * keeps a receipt from interrupting a running plan: an `execution_receipt` terminal state does not expire - the
   * result is the result - and only the world's own clock does.
   * </p>
   */
  public get hasExpiringFact(): boolean {
    return this.#hasExpiringFact();
  }

  /**
   * The batch a steer carries while a turn is running: the expiring facts ONLY, and nothing else is consumed.
   *
   * <p>
   * It does not go through `takeBatch` because that method's whole contract is to empty every window - which is
   * correct for a turn that is about to run and catastrophically wrong here, where a second batch is being handed to a
   * turn that is still working through the first. Taking only the two or three `time_milestone` facts leaves the
   * snapshot, the receipts and the player's input exactly where the in-flight turn's own follow-up expects them.
   * </p>
   */
  private takeExpiringOnly(): PendingBatch | undefined {
    const expiring: WorldFact[] = [];
    for (const [key, fact] of [...this.#worldFacts.entries()]) {
      if (fact.kind !== "world_fact" || fact.semanticKind !== "time_milestone") continue;
      expiring.push(fact);
      this.#worldFacts.delete(key);
    }
    if (expiring.length === 0) return undefined;

    const deliveredFacts = expiring.map((fact) => {
      const projection = fact.contextProjection;
      if (projection === undefined) return fact;
      const { contextProjection: _contextProjection, ...factWithoutProjection } = fact;
      return Object.freeze({ ...factWithoutProjection, payload: projection });
    });
    const triggerEventIds = Object.freeze(expiring.map(factEventId));
    // A steer hands these to a turn that is already running, so they are delivered content like any other - and a
    // milestone published again later must not be a reason to open a new turn for what she has already been told.
    this.#rememberDelivered(expiring);
    return Object.freeze({
      batchId: randomUUID(),
      disposition: "steer" as const,
      triggerEventIds,
      inputs: Object.freeze([]),
      facts: Object.freeze(deliveredFacts),
      events: Object.freeze([]),
      // A steer states the world it is already carrying: the turn it joins has `<world-state>` from its own batch, and
      // this one repeats the same reading rather than leaving the model with no state at all.
      text: composeFactBrief({
        inputs: [],
        snapshot: this.#worldStateReading(false),
        events: expiring,
        inFlight: this.#inFlight(),
        locale: DEFAULT_BRIEF_LOCALE,
      }),
    });
  }

  /**
   * Whether anything waiting describes a moment that will have passed by the time a run ends.
   *
   * <p>
   * The distinction the disposition was missing. `inputs.length > 0 ? "steer" : "follow_up"` decided by WHO the
   * message came from; what matters is whether the message stays true long enough to be worth delivering late. Player
   * input keeps - a person is waiting for an answer. A time milestone does not: `{"milestone":"1200"}` delivered after
   * the day ended is a statement about the past dressed as news.
   * </p>
   * <p>
   * Deliberately narrow. An `execution_receipt` terminal state does NOT expire - the result is the result, and
   * interrupting a running plan to announce one would trade a finished action for a half-finished thought.
   * </p>
   */
  #hasExpiringFact(): boolean {
    for (const fact of this.#worldFacts.values()) {
      if (fact.kind === "world_fact" && fact.semanticKind === "time_milestone") return true;
    }
    return (
      this.#retry !== undefined &&
      this.#retry.batch.facts.some((fact) => fact.kind === "world_fact" && fact.semanticKind === "time_milestone")
    );
  }

  private takeBatch(): PendingBatch {
    const inputs = this.#inputs.splice(0);
    const snapshot = this.#snapshot;
    this.#snapshot = undefined;
    const receipts = [...this.#receipts.values()];
    this.#receipts.clear();
    const semanticEvents = [...this.#semanticEvents.values()];
    this.#semanticEvents.clear();
    const lifecycle = [...this.#lifecycle.values()];
    this.#lifecycle.clear();
    const worldFacts = [...this.#worldFacts.values()].sort(compareWorldFacts);
    this.#worldFacts.clear(); // A held PROGRESS fact whose slot already delivered this exact state says nothing new, so it does not
    // enter the batch at all. It is dropped rather than readmitted: re-delivering it is the defect, and the
    // slot's CURRENT state is what the next changed fact will carry.
    const facts = [...receipts, ...semanticEvents, ...lifecycle, ...worldFacts].filter((fact) => {
      if (!isHeldProgressFact(fact)) return true;
      return this.#deliveredProgress.get(factSlotKey(fact)) !== factContentIdentity(fact);
    });
    // takeBatch is called only when input/fact triggering is already known.
    // Hold is represented by retaining latest state in the pump, never by an
    // empty Pi delivery.
    // The disposition is chosen by how long the batch's content stays TRUE, not by who sent it.
    //
    // Player input steers because a person is waiting. A time milestone steers because `{"milestone":"1200"}`
    // delivered once the day is over is a statement about the past dressed as news. Everything else follows up:
    // a receipt's terminal state does not expire, so there is nothing to gain by interrupting a running plan.
    const disposition = inputs.length > 0 || this.#hasExpiringFact() ? "steer" : "follow_up";
    const batchId = randomUUID();
    const batchInputs = Object.freeze(inputs);
    const normalizedInputs = batchInputs.map((input) => normalizeInput(input));
    // Whether this batch BROUGHT the observation, which is a different question from whether a reading exists: the
    // Host re-states the last snapshot before every turn (`CompanionHostService.#restateWorldSnapshot`), so a batch
    // almost always carries one - and a block that called every re-statement `刚刚更新` would be claiming a freshness
    // nothing observed.
    const broughtObservation =
      snapshot !== undefined &&
      (this.#lastSnapshotDeliveredRevision === undefined || snapshot.revision > this.#lastSnapshotDeliveredRevision);
    const worldState = this.#worldStateReading(broughtObservation);
    const locale = batchInputs.at(-1)?.locale ?? DEFAULT_BRIEF_LOCALE;
    // Read ONCE for this batch, outside the byte-bound loop below: every pass states the same programme in the same
    // state, so the text the delivery carries is the text the retry would compose.
    const inFlight = this.#inFlight();

    // Fit the batch to MAX_BATCH_BYTES by dropping the OLDEST facts, and hand back whatever did not fit.
    //
    // The windows above bound how many facts the pump holds, not how large a delivery is. Measured
    // 2026-10-27: 685 facts inside those windows serialized to 1,037,822 characters, the model answered
    // `input: 373915, output: 1, stopReason: "length"`, and the run produced no further action.
    //
    // Oldest-first because a later fact describes a later world: keeping the beginning of a long turn
    // while the companion has moved on is a summary of somewhere it is no longer standing.
    const compose = (chosen: readonly WorldFact[], triggersForBatch: readonly WorldFact[]) => {
      const batchFacts = Object.freeze([...(snapshot === undefined ? [] : [snapshot]), ...chosen]);
      const deliveredFacts = batchFacts.map((fact) => {
        const projection = fact.contextProjection;
        if (projection === undefined) return fact;
        const { contextProjection: _contextProjection, ...factWithoutProjection } = fact;
        return Object.freeze({ ...factWithoutProjection, payload: projection });
      });
      // `events` is the PRESENTATION projection: the two kinds `canonicalPresentationSource`
      // (`host/src/companion-loop.ts`) reads, plus the player inputs it attributes a turn to. A `semantic_event` or an
      // `execution_receipt` in it would be a second copy of a fact nothing reads there.
      const presentationKinds = new Set(["snapshot", "world_fact"]);
      const events = [
        ...normalizedInputs,
        ...deliveredFacts
          .filter((fact) => fact.kind !== undefined && presentationKinds.has(fact.kind))
          .map((fact) => normalizeFact(fact)),
      ].sort(compareEvents);
      const text = composeFactBrief({
        inputs: batchInputs,
        snapshot: worldState,
        events: batchFacts,
        inFlight,
        locale,
      });
      const triggerEventIds = Object.freeze([
        ...inputs.map((input) => input.eventId ?? input.inputId),
        ...triggersForBatch.map(factEventId),
      ]);
      return Object.freeze({
        batchFacts,
        deliveredFacts,
        events,
        triggerEventIds,
        text,
      });
    };

    let chosen = facts;
    let composed = compose(
      chosen,
      chosen.filter((fact) => !isHeldFact(fact)),
    );
    while (composed.text.length > MAX_BATCH_BYTES && chosen.length > 1) {
      chosen = chosen.slice(1);
      composed = compose(
        chosen,
        chosen.filter((fact) => !isHeldFact(fact)),
      );
    }

    // Anything left out goes back where it came from, so the next flush delivers it. Re-inserted
    // directly rather than through `enqueueFact`: these facts were already admitted, and re-running
    // admission would evict a newer fact to make room for an older one.
    const dropped = facts.slice(0, facts.length - chosen.length);
    for (const fact of dropped) this.#readmit(fact);

    // This batch was shown the observation, so the next one counts its age from here. Recorded at composition, not at
    // acceptance: a rejected batch is retried with this exact text ("刚刚更新"), and the only error this can make is
    // aging a reading too far - the safe direction for a block whose whole job is to not look fresher than it is.
    if (broughtObservation && snapshot !== undefined) {
      this.#lastSnapshotDeliveredRevision = snapshot.revision;
      this.#lastSnapshotDeliveredBatch = this.#deliveredBatches;
    }

    // Remember what the model was just told by each held progress slot, and what the batch as a whole taught it, so the
    // same content arriving again is not a turn. Recorded for what the batch actually CARRIES: a fact the byte bound
    // pushed into a later batch was not delivered and must still go out.
    for (const fact of composed.batchFacts) {
      if (!isHeldProgressFact(fact)) continue;
      this.#deliveredProgress.set(factSlotKey(fact), factContentIdentity(fact));
    }
    this.#rememberDelivered(composed.batchFacts);

    return Object.freeze({
      batchId,
      disposition,
      triggerEventIds: composed.triggerEventIds,
      inputs: batchInputs,
      facts: composed.deliveredFacts,
      events: composed.events,
      text: composed.text,
    });
  }

  /**
   * The world as `<world-state>` states it: the last reading, its own revision, and how many delivered turns old it is.
   *
   * `broughtObservation` is the batch's fact, not this method's inference: a re-stated snapshot leaves the revision it
   * already showed, and that is the difference between `刚刚更新` and `本轮无新观察`.
   */
  #worldStateReading(broughtObservation: boolean): WorldStateReading | undefined {
    const fact = this.#lastSnapshot;
    if (fact === undefined) return undefined;
    const age = this.#deliveredBatches - this.#lastSnapshotDeliveredBatch;
    return Object.freeze({
      snapshot: fact.payload as unknown as Snapshot,
      revision: fact.revision,
      ageTurns: broughtObservation ? 0 : Math.max(1, age),
      ageMs: Math.max(0, Date.now() - this.#lastSnapshotArrivedAtMs),
    });
  }

  /**
   * The fact that says the world reading this pump re-states has outlived its bound, or `undefined` when none is due.
   *
   * <p>
   * Minted by the pump for the same reason `takeStallFact` is: the pump owns the measurement (it is the only layer that
   * sees every snapshot and every delivered batch), and the Host owns publication, so a stale world cannot become a
   * second way to start a turn. Bounded by `WORLD_STATE_STALE_REARM_MULTIPLE`: `published` moves the next threshold out,
   * so fifty turns of one frozen reading is three facts rather than fifty.
   * </p>
   *
   * <p>
   * TWO CONDITIONS, because one of them alone would be a claim the pump cannot make. The reading must be older than
   * `WORLD_STATE_STALE_TURNS`, AND the world must have said it moved since - a clock milestone, a day start, a pass-out,
   * the Mod's own `snapshot_changed`, or a body standing somewhere other than the reading says. A reading that aged while
   * nothing at all happened is an old picture of an unchanged world, and the block's own parenthetical already says so.
   * </p>
   *
   * <p>
   * `undefined` therefore has three causes, and they are not the same statement: no reading at all (nothing has been
   * observed, so there is nothing to be stale), a reading still inside its bound, and a reading that outlived its bound
   * in a world that never contradicted it. The block itself states the age on every turn (`fact-brief.ts`), so the
   * distinction is visible where it matters.
   * </p>
   */
  public takeWorldStateStaleFact(): WorldFact | undefined {
    const reading = this.#worldStateReading(false);
    if (reading === undefined || !this.#worldStateStaleDue(reading)) return undefined;
    this.#worldStateStalePublished += 1;
    const code = worldStateStaleCode(reading);
    const eventId = `${WORLD_STATE_STALE_SEMANTIC_KIND}_${String(reading.revision)}_${String(this.#worldStateStalePublished)}`;
    return Object.freeze({
      source: HOST_MINTED_FACT_SOURCE,
      kind: "world_fact" as const,
      eventId,
      sourceEventId: eventId,
      correlationId: eventId,
      revision: reading.revision,
      occurredAtMs: Date.now(),
      semanticKind: WORLD_STATE_STALE_SEMANTIC_KIND,
      payload: Object.freeze({
        kind: WORLD_STATE_STALE_SEMANTIC_KIND,
        code,
        turns: reading.ageTurns,
        revision: reading.revision,
        ageMs: reading.ageMs,
        worldChanges: this.#worldChangesSinceReading,
        ...(this.#lastWorldChange === undefined ? {} : { lastWorldChange: this.#lastWorldChange }),
        staleFactsSoFar: this.#worldStateStalePublished,
      }),
    });
  }

  /** Whether a stale-world fact is owed right now, without consuming it (see `takeWorldStateStaleFact`). */
  #worldStateStaleDue(reading: WorldStateReading): boolean {
    return (
      reading.ageTurns >= worldStateStaleThreshold(this.#worldStateStalePublished) && this.#worldChangesSinceReading > 0
    );
  }

  /**
   * What the pump can say about a companion who is speaking without acting, right now.
   *
   * <p>
   * The measurement, split from the publication exactly as `stallWatch` is split from `takeStallFact`: reading this
   * enqueues, mints and delivers nothing. The Host owns the wake (`HostService.wakeReason`), so a narration fact cannot
   * become a second way to start a turn.
   * </p>
   *
   * <p>
   * A FROZEN WORLD OUTRANKS HER SILENCE, and the ordering is stated here because this is the layer that owns both
   * measurements. While a `world_state_stale` fact is still owed, `due` is `false`: her picture of the world has already
   * been contradicted, so "she spoke and did nothing" is not the statement to make about that turn - the world's own
   * fact is, and it names the one action that fixes her picture. Once that fact has been published the ordering releases,
   * because the world has then said what it had to say.
   * </p>
   */
  public get narrationWithoutWork(): NarrationWithoutWorkReading {
    const reading = this.#worldStateReading(false);
    const boundTurns = narrationWithoutWorkThreshold(this.#narrationWithoutWorkPublished);
    return Object.freeze({
      turns: this.#turnsWithoutWork,
      lastWorkTurnAgoMs: Math.max(0, Date.now() - this.#lastWorkTurnAtMs),
      boundTurns,
      due:
        this.#turnsWithoutWork >= boundTurns &&
        !this.hasExecutionInFlight &&
        (reading === undefined || !this.#worldStateStaleDue(reading)),
    });
  }

  /**
   * The fact that says an awake companion has spoken without acting, or `undefined` when none is due.
   *
   * <p>
   * It carries no prose and no instruction: the payload says what happened (`turns`, `lastToolTurnAgoMs`) and the prompt
   * floor already states the rules, so this is a fact beside the block rather than a scolding. `narrationFactsSoFar` is
   * what keeps it bounded - `narrationWithoutWorkThreshold` moves the next one out, so forty narration turns are five
   * facts rather than forty.
   * </p>
   */
  public takeNarrationWithoutWorkFact(): WorldFact | undefined {
    const reading = this.narrationWithoutWork;
    if (!reading.due) return undefined;
    this.#narrationWithoutWorkPublished += 1;
    const code = `${NARRATION_WITHOUT_WORK_SEMANTIC_KIND}:${String(reading.turns)}:${String(reading.lastWorkTurnAgoMs)}`;
    const eventId = `${NARRATION_WITHOUT_WORK_SEMANTIC_KIND}_${String(reading.turns)}_${String(this.#narrationWithoutWorkPublished)}`;
    return Object.freeze({
      source: HOST_MINTED_FACT_SOURCE,
      kind: "world_fact" as const,
      eventId,
      sourceEventId: eventId,
      correlationId: eventId,
      revision: this.#lastSnapshot?.revision ?? 0,
      occurredAtMs: Date.now(),
      semanticKind: NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
      payload: Object.freeze({
        kind: NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
        code,
        turns: reading.turns,
        lastToolTurnAgoMs: reading.lastWorkTurnAgoMs,
        boundTurns: reading.boundTurns,
        narrationFactsSoFar: this.#narrationWithoutWorkPublished,
      }),
    });
  }

  /**
   * Record what the turn that just settled DID, for `narrationWithoutWork`.
   *
   * <p>
   * A turn that produced work clears the run and dates it; a turn that spoke and ran no tool extends it; anything else
   * ends it. "Anything else" is not a gap in the measurement: an aborted or errored turn is the provider's or the
   * player's own decision, `said_nothing` is a turn that carried no assistant text (already named on its own path when
   * it is a provider answering nothing), and `unobserved` is nobody looked - none of the three is narration.
   * </p>
   * <p>
   * `hasExecutionInFlight` is asked at settlement, the only moment this pump can ask it honestly: it reads the receipts
   * window, and that window is emptied by the batch the turn consumed - so a receipt that arrived DURING the turn for an
   * execution still running is seen, and a turn with her body mid-action is not narration.
   * </p>
   */
  #observeTurnProduction(outcome: CompanionTurnOutcome | undefined): void {
    if (outcome !== "completed") {
      this.#turnsWithoutWork = 0;
      return;
    }
    if (this.turnProduction === TURN_PRODUCTION.worked) {
      this.#turnsWithoutWork = 0;
      this.#lastWorkTurnAtMs = Date.now();
      return;
    }
    this.#turnsWithoutWork =
      this.turnProduction === TURN_PRODUCTION.spoke && !this.hasExecutionInFlight ? this.#turnsWithoutWork + 1 : 0;
  }

  /**
   * Record whether this fact is the world saying it moved, and how.
   *
   * <p>
   * The three shapes are the ones the Mod already publishes, so this adds no authority: its own `snapshot_changed` (a
   * warp, minted at `ModEntry.cs:1787`), the clock and day facts, and a body trace whose `location` differs from the
   * reading's. The last one is derived rather than published - a snapshot carries `location`, and every body trace
   * carries the location the body is actually in, so “she is standing somewhere else” needs no new field from the Mod.
   * </p>
   */
  #observeWorldChange(fact: WorldFact): void {
    const change = describeWorldChange(fact, this.#readingLocation());
    if (change === undefined) return;
    this.#worldChangesSinceReading += 1;
    this.#lastWorldChange = change;
  }

  /** The location the current reading claims, for comparing against where the body actually is. */
  #readingLocation(): string | undefined {
    const location = (this.#lastSnapshot?.payload as { location?: unknown } | undefined)?.location;
    return typeof location === "string" && location.length > 0 ? location : undefined;
  }
}

/**
 * The two fact shapes the pump holds latest-only, each with the reason it is safe: the population the
 * classification test reads. A kind may only be held when a NAMED later fact will wake the model for it, otherwise
 * the pump silently swallows the only news the model was going to get.
 *
 * Measured 2026-11-07 (round39 and the run before it): `program_settled` sat in the held set, so a submitted plan
 * settled into a fact that never asked for a turn. The companion went quiet for 816.5 s and the first bubble came only
 * because the player typed. Nothing in any bundle records "a turn was owed" - the fact is never delivered, so there is
 * no artifact of it at all - which is why the silence walked past every audit until someone read this file.
 */
export const HELD_RECEIPT_PROGRESS_STATES: Readonly<Record<string, string>> = Object.freeze({
  accepted: "the terminal receipt for the same execution wakes the model",
  running: "the terminal receipt for the same execution wakes the model",
  meaningful_progress: "the terminal receipt for the same execution wakes the model",
});

/**
 * Semantic-event kinds that are PROGRESS, not outcomes: per-tile route advance, the start of an execution, and
 * the actor falling idle. They describe a moving state, so only the latest one matters.
 *
 * Measured 2026-10-17 on a real multi-day run: one long agent turn (70 assistant messages, ~350s) made the Mod
 * publish 129 such observations, each with its OWN freshly-minted correlationId, and they filled the 128-entry
 * pending window - so the pump threw and the bridge closed mid-run. The receipt counterpart of exactly this
 * traffic is already latest-only; a semantic event describing the same progress must be treated the same way, or a
 * long session is indistinguishable from a flood.
 */
export const HELD_SEMANTIC_PROGRESS_KINDS: Readonly<Record<string, string>> = Object.freeze({
  execution_started: "the receipt for the same execution wakes the model, and its terminal does too",
  route_progress: "the node's own completion or rejection arrives as a receipt fact",
  body_idle: "the next receipt or plan settlement arrives as an ordinary fact",
});

/**
 * Semantic kinds the HOST mints itself, each with the path that turns it into a turn.
 *
 * Same defect class as the held tables above, with the trap that makes it worse: no adapter will ever publish one of
 * these, so "a later fact from the Mod arrives" is not an available answer. The wake source has to be a Host path, and
 * naming it here is what makes an unclassifiable kind fail loudly instead of sitting in the pump unwatched.
 */
export const HOST_MINTED_WAKE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  [EXECUTION_STALL_SEMANTIC_KIND]:
    "the Host's stall timer arms from stallWatch.nextStallInMs, and hands this fact to acceptHostMintedFact, which enqueues it and flushes a turn immediately",
  [WORLD_STATE_STALE_SEMANTIC_KIND]:
    "the Host asks takeWorldStateStaleFact after every adapter fact it admits, and hands the fact to acceptHostMintedFact",
  [NARRATION_WITHOUT_WORK_SEMANTIC_KIND]:
    "the Host reads wakeReason when a flush settles, and when it answers narration_without_work it mints the fact with takeNarrationWithoutWorkFact and hands it to acceptHostMintedFact, which enqueues it and flushes a turn",
});

/** Receipt progress is latest-only; terminal and invalidating states remain ordinary facts. */
function isMeaningfulProgressFact(fact: WorldFact): boolean {
  return (
    fact.kind === "execution_receipt" &&
    typeof fact.payload.state === "string" &&
    fact.payload.state in HELD_RECEIPT_PROGRESS_STATES
  );
}

/**
 * Semantic-event kinds that are PROGRESS, not outcomes: per-tile route advance, the start of an execution, and
 * the actor falling idle. They describe a moving state, so only the latest one matters.
 *
 * Measured 2026-10-17 on a real multi-day run: one long agent turn (70 assistant messages, ~350s) made the Mod
 * publish 129 such observations, each with its OWN freshly-minted correlationId, and they filled the 128-entry
 * pending window - so the pump threw and the bridge closed mid-run. The receipt counterpart of exactly this
 * traffic is already latest-only (see `isMeaningfulProgressFact`); a semantic event describing the same progress
 * must be treated the same way, or a long session is indistinguishable from a flood.
 *
 * The settled/invalidated kinds are deliberately NOT here: those are outcomes, and dropping one would hide an
 * execution that already ended.
 */
function isProgressSemanticEvent(fact: WorldFact): boolean {
  return (
    fact.kind === "semantic_event" &&
    typeof fact.payload.kind === "string" &&
    fact.payload.kind in HELD_SEMANTIC_PROGRESS_KINDS
  );
}

function isHeldFact(fact: WorldFact): boolean {
  return fact.kind === "snapshot" || isHeldProgressFact(fact);
}

/**
 * A fact that is HELD latest-only AND describes movement rather than an outcome: the two progress classes the
 * pump already collapses into one slot each.
 *
 * The snapshot is deliberately not here. It is held too, but it is the world the rest of a batch describes, so a
 * batch that carried facts without it would describe a state the model cannot see.
 */
function isHeldProgressFact(fact: WorldFact): boolean {
  return isMeaningfulProgressFact(fact) || isProgressSemanticEvent(fact);
}

/**
 * One field of the Mod's body-owner refusal: the payload key when the writer put it there, otherwise the Mod's own
 * evidence detail (`owner_execution_id=exec_1;owner_action=pickup_item;interruptible=false;...`,
 * `farmhandexecutioncontroller.cs:881`), which is where the body-owner describer actually carries the owner.
 *
 * `unknown` is the Mod's own spelling for "this field has no value" (`OwnerToken`), so it is no value here too - a hold
 * that matched on the literal token could never be released by the execution it was waiting for.
 */
function bodyOwnerField(payload: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const direct = payload?.[key];
  if (typeof direct === "string" && direct.length > 0 && direct !== "unknown") return direct;
  const field = evidenceField(evidenceDetailOf(payload?.evidence), key);
  return field === null || field.length === 0 || field === "unknown" ? undefined : field;
}

/**
 * May the same CONTENT arriving twice be the same news?
 *
 * No for the clock and the day (`DAY_BOUNDARY_SEMANTIC_KINDS`): their content is a moment, and two moments with one
 * stamp are still two moments. Yes for everything else - a settlement, a refusal, a notice, a terminal receipt - because
 * there the content IS the statement, and a second copy of it tells her nothing she did not already have.
 */
function isRestatementEligible(fact: WorldFact): boolean {
  return fact.semanticKind === undefined || !DAY_BOUNDARY_SEMANTIC_KINDS.has(fact.semanticKind);
}

/**
 * Is this fact one the HOST minted on its own schedule - the stall watch, a stale reading, a narration run?
 *
 * The population is `HOST_MINTED_WAKE_KINDS`, which already names every such kind and the Host path that publishes it,
 * so a kind added there is classified without editing this predicate.
 */
function isDueFact(fact: WorldFact): boolean {
  const kind = fact.semanticKind;
  return fact.kind === "world_fact" && kind !== undefined && kind in HOST_MINTED_WAKE_KINDS;
}

function isTerminalExecutionFact(fact: WorldFact): boolean {
  // ONE classification of "this execution is over": the ledger's, which the launcher and every correlation consumer
  // already share. A hand-written list here left `blocked` out, and a blocked execution therefore kept its stall entry -
  // MEASURED 2026-11-09 (round44): two `navigate_to_destination` executions ended `destination_unreachable`
  // (`topology=unreachable`) at 11:34:45 and 11:35:58, and a stall fact at 12:01:58 reported `elapsedMs 1560015` for an
  // execution that had stopped 26 minutes earlier.
  return (
    fact.kind === "execution_receipt" &&
    typeof fact.payload.state === "string" &&
    isTerminalExecutionState(fact.payload.state as ExecutionState)
  );
}

/**
 * The slot a PROGRESS semantic event occupies: the newest observation of that execution (or of the actor itself)
 * supersedes every earlier one. Deliberately NOT the correlationId, which the Mod mints fresh per event.
 */
function progressSemanticEventKey(fact: WorldFact): string {
  const executionId = fact.executionId;
  return typeof executionId === "string" && executionId.length > 0
    ? executionProgressSlotKey(executionId)
    : `progress:${String(fact.payload.kind)}`;
}

function executionProgressSlotKey(executionId: string): string {
  return `progress:${executionId}`;
}

/**
 * Which pending-window slot a fact occupies. ONE spelling: `enqueueFact`, `#readmit` and the delivered-progress
 * record all ask this, so a fact cannot be held under one key and compared under another.
 */
function factSlotKey(fact: WorldFact): string {
  if (fact.kind === "world_fact") return worldFactKey(fact);
  if (isProgressSemanticEvent(fact)) return progressSemanticEventKey(fact);
  return fact.correlationId;
}

/**
 * What a fact TELLS the model, as a comparable string.
 *
 * The per-observation counters are excluded, because they advance on every publish of an unchanged state: the
 * Mod mints a fresh wire message id and a fresh revision for each receipt it publishes, and each body trace
 * carries the game tick it was sampled at. Counting those as content is exactly the defect - a body standing
 * still on `64,15` re-observed forty times would read as forty facts.
 *
 * The PROVENANCE ids go with them, for the same reason and one step further: `eventId`, `sourceEventId` and
 * `correlationId` are minted per publish, so a settlement re-read from the journal arrives as a "new" event carrying the
 * same statement - which is how `round46b` opened a turn at 07:30:43 to say what the 07:28:19 turn had already said.
 * Identity is about the statement, not the envelope that carried it.
 *
 * Everything else is content: the kind, the state, the reason, the location, the tile, the active execution and
 * its phase. A change in any of them is a change the model has not been told.
 */
export function factContentIdentity(fact: WorldFact): string {
  const {
    eventId: _eventId,
    sourceEventId: _sourceEventId,
    correlationId: _correlationId,
    occurredAtMs: _occurredAtMs,
    ...stable
  } = fact;
  return JSON.stringify(stable, (key, value) => (key === "tick" || key === "revision" ? undefined : value));
}

/**
 * The silence the `published`-th stall fact waits for.
 *
 * The first waits one bound; each later one waits a re-arm multiple more, so a stall that lasts an hour is eight facts
 * rather than thirty (see `EXECUTION_STALL_REARM_MULTIPLE`).
 */
function stallThresholdMs(published: number): number {
  return EXECUTION_STALL_BOUND_MS * (1 + published * (EXECUTION_STALL_REARM_MULTIPLE - 1));
}

/**
 * The narration run the `published`-th narration fact waits for.
 *
 * The first waits `NARRATION_WITHOUT_WORK_TURNS`; each later one waits `EXECUTION_STALL_REARM_MULTIPLE` more of the same
 * run, for the same reason the stall watch re-arms: saying the same thing every turn spends the run on one reading.
 */
function narrationWithoutWorkThreshold(published: number): number {
  return NARRATION_WITHOUT_WORK_TURNS * (1 + published * (EXECUTION_STALL_REARM_MULTIPLE - 1));
}

/**
 * What this fact says about the world having MOVED, as a label - or `undefined` when it says nothing about the world.
 *
 * <p>
 * Only the shapes the Mod already publishes: its own `snapshot_changed` (a warp, `ModEntry.cs:1787`), the clock and day
 * facts, and a body trace whose location differs from the reading's. A `route_progress` one tile away says the body
 * moved, which is her own walking, not the world - only a DIFFERENT map counts.
 * </p>
 */
function describeWorldChange(fact: WorldFact, readingLocation: string | undefined): string | undefined {
  if (fact.kind === "semantic_event" && fact.payload.kind === "snapshot_changed")
    return `snapshot_changed:${typeof fact.payload.reasonCode === "string" ? fact.payload.reasonCode : "changed"}`;
  if (
    fact.kind === "world_fact" &&
    fact.semanticKind !== undefined &&
    DAY_BOUNDARY_SEMANTIC_KINDS.has(fact.semanticKind)
  )
    return fact.semanticKind;
  const location = locationOf(fact.payload);
  return location !== undefined && readingLocation !== undefined && location !== readingLocation
    ? `location:${location}`
    : undefined;
}

/** The location a fact carries about where the BODY is, in either of the two places the Mod puts it. */
function locationOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const trace = payload.bodyTrace;
  const traced = trace !== null && typeof trace === "object" ? (trace as { location?: unknown }).location : undefined;
  const location = typeof traced === "string" ? traced : payload.location;
  return typeof location === "string" && location.length > 0 ? location : undefined;
}

/** One stable label for what a fact SAID, which is what a stall answer has to name as its last progress. */
function factLabel(fact: WorldFact): string {
  if (fact.kind === "execution_receipt" && typeof fact.payload.state === "string")
    return `${fact.kind}:${fact.payload.state}`;
  if (fact.kind === "semantic_event" && typeof fact.payload.kind === "string")
    return `${fact.kind}:${fact.payload.kind}`;
  return fact.kind;
}

function factEventId(fact: WorldFact): string {
  return fact.eventId ?? `${fact.source}:${fact.kind}:${fact.correlationId}:${fact.revision}`;
}

/** World-fact deduplication key: the stable Mod eventId, else its correlationId. */
function worldFactKey(fact: WorldFact): string {
  return fact.eventId ?? fact.correlationId;
}

/**
 * The world fact a full window sheds first: the OLDEST by the pump's own ordering (`compareWorldFacts`,
 * the same order a batch is delivered in), not by insertion or arrival luck.
 *
 * `undefined` only for an empty window, which `enqueueFact` cannot reach - it asks for a victim only
 * after `destination.size >= limit`. Naming that case keeps the caller's fail-closed branch honest
 * instead of deleting a key that does not exist.
 */
function oldestWorldFactKey(destination: ReadonlyMap<string, WorldFact>): string | undefined {
  let oldestKey: string | undefined;
  let oldest: WorldFact | undefined;
  for (const [key, entry] of destination) {
    if (oldest === undefined || compareWorldFacts(entry, oldest) < 0) {
      oldest = entry;
      oldestKey = key;
    }
  }
  return oldestKey;
}

function normalizeInput(input: PlayerInput): NormalizedEvent {
  return {
    eventId: input.eventId ?? input.inputId,
    occurredAtMs: input.timestampMs,
    source: input.source,
    kind: "player_input",
    correlationId: input.inputId,
    revision: 0,
    input,
  };
}

function normalizeFact(fact: WorldFact): NormalizedEvent {
  return {
    eventId: factEventId(fact),
    occurredAtMs: fact.occurredAtMs ?? 0,
    source: fact.source,
    kind: fact.kind,
    correlationId: fact.correlationId,
    revision: fact.revision,
    ...(fact.observedTick === undefined ? {} : { observedTick: fact.observedTick }),
    ...(fact.executionId === undefined ? {} : { executionId: fact.executionId }),
    ...(fact.requestId === undefined ? {} : { requestId: fact.requestId }),
    ...(fact.sourceEventId === undefined ? {} : { sourceEventId: fact.sourceEventId }),
    ...(fact.semanticKind === undefined ? {} : { semanticKind: fact.semanticKind }),
    payload: fact.contextProjection ?? fact.payload,
  };
}

function compareWorldFacts(left: WorldFact, right: WorldFact): number {
  const tickDiff = (left.observedTick ?? 0) - (right.observedTick ?? 0);
  if (tickDiff !== 0) return tickDiff;
  const revDiff = left.revision - right.revision;
  if (revDiff !== 0) return revDiff;
  return (left.eventId ?? "").localeCompare(right.eventId ?? "");
}

function compareEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  if (left.kind === "world_fact" && right.kind === "world_fact") {
    const tickDiff = (left.observedTick ?? 0) - (right.observedTick ?? 0);
    if (tickDiff !== 0) return tickDiff;
    const revDiff = left.revision - right.revision;
    if (revDiff !== 0) return revDiff;
    return left.eventId.localeCompare(right.eventId);
  }
  return (
    left.occurredAtMs - right.occurredAtMs ||
    left.revision - right.revision ||
    left.eventId.localeCompare(right.eventId)
  );
}

/**
 * May this fact be dropped when a window is full?
 *
 * Only facts a LATER fact supersedes: progress observations of a live execution, a non-terminal receipt (its terminal is
 * still to come), and a lifecycle notice. Everything else carries something no other fact will say again - a terminal
 * receipt is the authority for its execution, and an execution's OUTCOME semantic event is how the companion learns it
 * ended - so those evict a superseded entry instead, and only close the bridge when the window holds nothing else.
 */
function isSupersededFact(fact: WorldFact): boolean {
  if (fact.kind === "execution_receipt") return !isTerminalExecutionFact(fact);
  if (fact.kind === "semantic_event") return isProgressSemanticEvent(fact);
  return fact.kind === "lifecycle";
}
