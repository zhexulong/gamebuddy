import { randomUUID } from "node:crypto";

import { isTerminalExecutionState } from "./execution-correlation-ledger.js";
import {
  composeFactBrief,
  type WorldStateReading,
  worldStateStaleCode,
  worldStateStaleThreshold,
} from "./fact-brief.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND, settledProgramOk } from "./program-settlement-digest.js";
// The programme's own state is one of the two authorities that decide whether her work is alive
// (`ExecutionLivenessReading`); it is a READ of the journal ledger the submit echo, the settlement watch and every status
// call already write, so the pump asks it rather than keeping a second account of what is running.
import { type InFlightProgrammeReading, readInFlightProgrammes } from "./program-status-wait.js";
import {
  BODY_PROGRAM_PROOF_NODE_STATES,
  EXECUTION_STATES,
  type ExecutionOrigin,
  type ExecutionState,
  type Snapshot,
} from "./protocol.js";
// The Mod's evidence detail is one format with one reader (`key=value;...`), and the body-owner refusal puts the owner
// it names inside it. Reusing that reader is what keeps the pump and the Agent's refusal guidance from disagreeing
// about who holds the body.
import { evidenceDetailOf, evidenceField } from "./stardew-action-remedy.js";
// Which facts the player's surface can show: the ONE reading the loop's own admission reads too (`presentation-lease.ts`),
// so "this fact can present" cannot be true in one layer and false in the other.
import { presentationSourceOf } from "./presentation-lease.js";

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
  /** It ran at least one tool and delivered speech: it moved something and said what it moved. */
  worked: "worked",
  /**
   * It ran at least one tool and delivered NO speech: it worked and chose not to narrate the work.
   *
   * This is the member that makes `turn_settled_silent` a shape a turn can LAND on. Measured 2026-11-15
   * (`round58`, 21 opened turns): every turn in the run both acted and spoke, so `bubbles 21 / turns 21` and the
   * account had one counter for the turn spent on speech (`turn_closed_without_action`) and none for the turn spent
   * on work with nothing said. Silence was not refused by any layer - `deliverTurn` draws no bubble for it and the
   * loop's `PROVIDER_EMPTY_COMPLETION` excludes a message that asked for a tool - it simply collapsed into `worked`.
   */
  workedSilently: "worked_silently",
  /** It carried assistant text and ran no tool: narration. */
  spoke: "spoke",
  /**
   * It carried no assistant text at all - a provider that answered with nothing, or a message whose tool call never ran.
   * Not narration either way, so it ends the run rather than extending it.
   */
  saidNothing: "said_nothing",
});

export type TurnProduction = (typeof TURN_PRODUCTION)[keyof typeof TURN_PRODUCTION];

/** Every member of the closed list, derived - the population of every histogram over it and of the printer below. */
export const TURN_PRODUCTIONS = Object.freeze(Object.values(TURN_PRODUCTION));

/**
 * What one turn produced, from the two raw facts, in ONE spelling over the closed list.
 *
 * <p>
 * The loop asks it per delivered batch (work executed, text delivered) and the pump asks it per assistant RECORD (a tool
 * asked for, text carried), so the two units cannot be classified by two expressions that disagree - see
 * `AssistantTurnTally`.
 * </p>
 */
export function turnProductionOf(producedWork: boolean, producedText: boolean): TurnProduction {
  if (producedWork) return producedText ? TURN_PRODUCTION.worked : TURN_PRODUCTION.workedSilently;
  return producedText ? TURN_PRODUCTION.spoke : TURN_PRODUCTION.saidNothing;
}

/**
 * Did the turn carry any assistant text? One spelling of that question, over the closed list.
 *
 * <p>
 * The two working members differ in exactly this bit, which is why it is asked here and not re-derived at every call
 * site: `worked` and `spoke` delivered speech, `workedSilently` and `saidNothing` did not.
 * </p>
 */
export function turnProducedSpeech(production: TurnProduction): boolean {
  return production === TURN_PRODUCTION.worked || production === TURN_PRODUCTION.spoke;
}

/** Did the turn run at least one tool? Both working members did; narration and an empty message did not. */
export function turnProducedWork(production: TurnProduction): boolean {
  return production === TURN_PRODUCTION.worked || production === TURN_PRODUCTION.workedSilently;
}

/**
 * The closed list of things that make a batch worth a turn, and the whole population of the opening decision.
 *
 * <p>
 * THE INVARIANT: a turn opens only when something NEEDS A DECISION now. Everything outside this list does not open one -
 * in particular a programme still in flight with no state change, an event that only re-states a fact already delivered,
 * and THE READING ITSELF.
 * </p>
 * <p>
 * THE READING IS STANDING STATE, AND IT TOOK TWO PATHS. A snapshot is the `<world-state>` block: `takeBatch` renders the
 * last reading into every delivery (`#worldStateReading`), and `fact-brief.ts` prints nothing for a snapshot fact ("The
 * snapshot is the state block, not news"). The opener asked the opposite question - does this reading differ from the one
 * she was last shown - so it opened turns for a paragraph the next turn would have carried anyway.
 * </p>
 * <p>
 * MEASURED 2026-11-15 (`round55`, `tools/_multiday_routine-round55-live-runner.log`): 120 turns opened, 115 of them
 * `observation`, and 86 of those closed `turn_closed_without_action {observation:nothing_pending}`. The run's bridge
 * traffic says why: of its 131 examined flushes, 90 carried no fact at all - no receipt, no semantic event, no world fact,
 * no lifecycle, no player word - only a snapshot, and 87 of those 90 turns ended with speech and no action. The other 41
 * windows carried a fact, and 28 of those turns acted. At about three per action turn, those 90 were the observations her
 * own tool calls left in the pump, re-stated by `HostService.#restateWorldSnapshot` and turned into a new turn.
 * </p>
 * <p>
 * NOTHING SHE SEES IS LOST, and the forward path is the facts: a person's words, an outcome, a clock mark, a due wake.
 * Each of those opens the turn it needs and carries the freshest reading with the header `刚刚更新`, so the reading is
 * delivered by the turn that has something to decide. A suppressed flush still ASKS the world about an aged reading
 * (`#beginAgedReadingAsk`), which is the refresh the run's `auto_observe_on_stale` already measured as working.
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
  /**
   * A Host-owned statement came due: a stale reading, a narration run - and the stall verdict the Host mints from the
   * Mod's own (`PUMP_MINTED_WAKE_KINDS`).
   */
  due: "due",
});

export const TURN_OPENINGS = Object.freeze(Object.values(TURN_OPENING));

export type TurnOpening = (typeof TURN_OPENINGS)[number];

/**
 * Who can put a fact on this pump, declared once.
 *
 * <p>
 * `TURN_OPENING` answers why a turn opened at the granularity of a REASON, so a run that printed `world_fact: 28` said
 * a fact woke her twenty-eight times and nothing about which of the pump's entrances produced one of them - the producer
 * was something a reader found by reading `enqueueFact`'s call sites. Measured 2026-11-15 (`round56`): 28 of 31 turns
 * were `world_fact`, and the account could not separate the Mod's own traffic from the Host re-stating a reading it
 * already held.
 * </p>
 * <p>
 * THE MEMBERS ARE THE CALL SITES. One entry per `enqueueFact` call site, in the order a fact can arrive: the adapter's
 * stream first, then the Host's own mints, then the two the Host publishes on another layer's behalf. The Host's
 * Host-minted route (`acceptHostMintedFact`) carries five of them, which is why the producer is a parameter of that
 * route and not a property of the fact.
 * </p>
 * <p>
 * A member without a call site, and a call site without a member, are what `event-pump.fact-producer.test.ts` reds on -
 * and the second is also a compile error, because `enqueueFact` demands a producer.
 * </p>
 */
export const FACT_PRODUCER = Object.freeze({
  /** `HostService.acceptIntegrationFact`: the authenticated adapter's own fact stream - snapshot, receipt, semantic event, world fact. */
  adapterIngress: "adapter_ingress",
  /** `HostService.acceptLifecycleEvent`: the local adapter transport going away - the one fact that is not the world speaking. */
  transportLifecycle: "transport_lifecycle",
  /** `HostService.#sayArrivalOnce`: the once-per-session "I have arrived, and the clock has ticked" fact. */
  companionArrival: "companion_arrival",
  /** `HostService.#admitNativeNotices`: an unseen native notice lifted out of the payload of the receipt that carried it. */
  nativeNotice: "native_notice",
  /** `HostService.#injectVoiceInterruptionNote`: the player cut the previous utterance off (Voice-local, never Chat or Game state). */
  voiceInterruption: "voice_interruption",
  /** `HostService.#restateWorldSnapshot`: the Host re-states the session's current reading before composing a batch. */
  snapshotRestate: "snapshot_restate",
  /** The settled-plan digest, announced by the materializer's `announceHostFact` once the Mod's journal reports a plan stopped. */
  programSettlement: "program_settlement",
  /** `HostService.#publishStallFact`: an execution stopped making progress, on the Host's own timer. */
  stallWatch: "stall_watch",
  /** `HostService.#publishWorldStateStaleFact`: the reading this session re-states has outlived its bound. */
  worldStateStale: "world_state_stale",
  /** `HostService.#publishNarrationWithoutWorkFact`: an awake companion spoke and ran nothing. */
  narrationWithoutWork: "narration_without_work",
  /** The pump's own refresh probe came back refused, published through the materializer's `publish` port. */
  worldStateRefreshRefused: "world_state_refresh_refused",
});

export const FACT_PRODUCERS = Object.freeze(Object.values(FACT_PRODUCER));

export type FactProducer = (typeof FACT_PRODUCERS)[number];

/** One decision, with the producer of the fact that made it. `undefined` means no fact decided it. */
type FlushDecision<Decision extends string> = Readonly<{ decision: Decision; producedBy: FactProducer | undefined }>;

/**
 * A `not_owed` answer, plus the fact SHAPE that could not be shown when the surface is what refused the turn.
 *
 * The shape is the reason's own detail rather than a second reason: `no_surface_for` is one member of the closed list (a
 * reason added per Mod kind would be an open list the account could not print), and which shape arrived is what a reader
 * acts on - see `TurnAccount.noSurface`.
 */
type NotOwedCause = FlushDecision<NotOwedReason> & Readonly<{ shape?: string }>;

/**
 * Why a flush that was EXAMINED opened no turn. Closed, so "fewer turns" and "lost turns" are distinguishable.
 *
 * A batch whose only pending content is a `world_fact` she already received is the re-statement reason. A fact whose
 * content is a MOMENT rather than a statement is never a re-statement (`DAY_BOUNDARY_SEMANTIC_KINDS`), so `due` needs no
 * reason of its own: a Host-minted wake fact carries its re-arm counter in its content, and a clock or day fact is news
 * every time.
 *
 * A flush that held a reading and nothing else used to be ONE member, `observation_is_state`, and that member was a second
 * spelling of the bucket it labelled: `HostService.#restateWorldSnapshot` re-states the session's reading before EVERY
 * flush, so every suppressed flush that carried no restated fact held a reading, and the member could only ever equal
 * `suppressed - world_fact_restated`. Measured 2026-11-15 (`round56`): `suppressed 624 {observation_is_state: 610,
 * world_fact_restated: 5, nothing_pending: 9}` - the 610 said exactly what the 624 said.
 *
 * It is now the one question such a flush can answer about ITSELF, asked of the reading against the reading the pump
 * already held. `observation_restated` is a re-reading of a world whose own last statement it repeats - what asking again
 * costs when nothing moved; `observation_moved` is a reading that says something the held one did not and still opens no
 * turn, which is the rule "a reading is standing state, not news" (`TURN_OPENING`) applied to a reading she has not been
 * handed. On `round56` the night window was 742 watches at 3.56 Hz and the second number is what says how many of them
 * were the world moving at all.
 *
 * `nothing_pending` is not a lost turn: there was nothing to deliver, and counting it keeps the arithmetic closed
 * (`examined === opened + every suppressed reason`).
 *
 * `in_flight_progress` is the same rule applied to INGRESS rather than to the reading: a step of a programme she already
 * dispatched is standing state too, and the programme's settlement is the turn that carries it
 * (`IN_FLIGHT_RECEIPT_PROGRESS_STATES`). What makes it a step is the fact's own `origin`, not what the ledger happens to
 * be naming - see `factExecutionOrigin`.
 */
/**
 * Why a flush CALL owed no turn, in the closed list the account prints.
 *
 * <p>
 * THESE ARE NOT FLUSHES. Before this list had its own name, every call to `flush()` was counted as an examined flush and
 * then answered with one of these - so `round64` printed `flushes examined 134 · turns opened 8 · suppressed 126
 * {in_flight_progress 125}`, and 93% of the pump's work was: assemble a batch, decide it owes no turn, drop it. A fact
 * that cannot open a turn must not become a flush in the first place: it waits in its window and the next turn that opens
 * for a decision carries it (`CarryTicket` proves it arrived). So these reasons now count CALLS THAT WERE NEVER FLUSHES.
 * </p>
 * <p>
 * The members are unchanged because the states are: the reading was one she already held, the fact was one she had already
 * been told, the fact was a step of a programme she dispatched, the fact was progress she has not been shown, or there was
 * nothing at all. What changed is the unit, and the unit was the defect.
 * </p>
 */
export const NOT_OWED = Object.freeze({
  /** The flush held a copy of the reading the pump already held: nothing this flush saw was different. */
  observationRestated: "observation_restated",
  /** The flush held a reading that says something the held one did not, and a reading opens no turn. */
  observationMoved: "observation_moved",
  worldFactRestated: `${TURN_OPENING.worldFact}_restated`,
  /**
   * The flush held a step of a programme: the receipt's own provenance says a programme owns its execution, and that
   * settlement is the turn which states it.
   */
  inFlightProgress: "in_flight_progress",
  /**
   * The flush held facts the classification calls progress and she has not been shown: they travel in the next turn that
   * opens for a decision.
   *
   * A separate member from the reading reasons because it is a different statement: `observation_restated` says the world
   * said nothing new, and this says the machine finished a piece of work it was told to do. Measured 2026-11-15
   * (`round59`): a reading is re-stated before EVERY flush (`HostService.#restateWorldSnapshot`), so without this member
   * every successful programme's settlement would be counted as a re-stated reading and the turns this rule removes would
   * be invisible in the account that exists to count them.
   */
  progress: "progress",
  /**
   * The flush held a DECISION fact whose own kind the player's surface cannot show: a node's terminal receipt, a lifecycle
   * event, a world fact no projection is drawn for.
   *
   * <p>
   * A decision fact that cannot present still owes her the news (`#owesTurn` keeps it in the batch's model-facing text), and it
   * still does not open a turn of its own: the surface would attach no projection, so her answer to it could only be text
   * nobody is shown. MEASURED 2026-11-17 (`round66`, ten minutes): 21 turns opened, 15 admitted; the six `admitted:false`
   * turns each carried exactly `["execution_receipt","snapshot"]`, and the run counted `lost 8 {no_presentation_lease: 8}`
   * for text it had paid a provider turn to write. The fact keeps its place in its window and the next turn that CAN present
   * carries it - which is what `no_surface_for` counts and what the `CarryTicket` beside it proves.
   * </p>
   * <p>
   * The reason's own braces in the account name the SHAPES (`factTurnShape`: `receipt:succeeded`, `world_fact`, ...) rather
   * than the producer, because every one of them arrives through the adapter and the question a reader has is which fact
   * shape is being invited to speak into nothing.
   * </p>
   */
  noSurface: "no_surface_for",
  nothingPending: "nothing_pending",
});

export const NOT_OWED_REASONS = Object.freeze(Object.values(NOT_OWED));

export type NotOwedReason = (typeof NOT_OWED_REASONS)[number];

/** How the most recent flush call was decided. */
export type TurnDecision =
  | Readonly<{ kind: "opened"; index: number; reason: TurnOpening }>
  | Readonly<{ kind: "not_owed"; reason: NotOwedReason }>;

/**
 * The proof that a fact which opened no turn did not vanish: the slot keys it waits under, and the batch that carried them.
 *
 * <p>
 * THIS EXISTS BECAUSE A BOOLEAN COULD NOT SAY IT. `#owesTurn` answered yes or no about one fact, so "this fact owes no turn"
 * and "this fact has nowhere to go" were the same value - and the second one is the defect that lost 126 flushes in
 * `round64`. A ticket names the facts (their window slot keys, the one spelling `factSlotKey` gives), and
 * `carriedInto(ticket)` answers the batch id that consumed them, or `undefined` while they are still waiting. The two are
 * different states and they are now spelled differently.
 * </p>
 */
export type CarryTicket = Readonly<{ ticketId: string; facts: readonly string[] }>;

/**
 * What one call to `flush` DID, as a closed union - never `undefined`.
 *
 * <p>
 * `opened` - a turn was owed, a batch was composed, and that exact batch reached delivery.
 * `not_owed` - nothing owed a turn: NO batch was composed, and the ticket proves where the facts went instead.
 * `held` - the call could not be answered at all (a world transition, or a delivery already in flight); the facts stay
 *   where they are and the next call decides them.
 * </p>
 * <p>
 * The three are separate members because a caller has to treat them differently, which is the whole reason the old return
 * type (`CompanionTurnOutcome | undefined`) was wrong: "no turn was owed" and "a delivery is in flight" both arrived as
 * `undefined`, and neither said whether anything had been dropped.
 * </p>
 */
export type FlushOutcome =
  | Readonly<{ kind: "opened"; batchId: string; opener: TurnOpening; turn: CompanionTurnOutcome }>
  | Readonly<{ kind: "not_owed"; reason: NotOwedReason; carry: CarryTicket }>
  | Readonly<{ kind: "held"; reason: "world_transition" | "delivery_in_flight" }>;

/**
 * Why a turn that spoke and ran no tool closed with nothing done, in the three conditions the pump can tell apart.
 *
 * MEASURED 2026-11-13 (`round47`, the companion's own account): 64 assistant turns, 41 of them speech only, median 27
 * characters, while the world reading stood still for eighteen turns. Her explanation was economic and exact - "a line of
 * speech passes, the cost is zero; submitting a plan may be refused, may fail, and has to be awaited". Nothing in the run
 * could say how many of those turns were that shape, because a turn that spoke was counted as a turn that happened.
 *
 * <p>
 * The three reasons are the conditions that can make acting impossible WITHOUT being a refusal, and they are ordered:
 * a contradicted picture first (the block itself already calls an aged reading "the world is not like this any more"),
 * then a body the engine holds, then the residual - nothing was pending and she was free to act. `nothing_pending` is the
 * one this measurement exists to expose: it is the shape where the zero-cost exit won with nothing at all in its way.
 * </p>
 */
export const TURN_WITHOUT_ACTION_REASON = Object.freeze({
  /** The turn was handed a reading it did not bring: her picture of the world was already out of date. */
  worldStale: "world_stale",
  /** The snapshot says the body cannot take a command (`actionable: false`): the engine is holding the actor. */
  bodyHeld: "body_held",
  /** A fresh reading, a free body, and still no action. */
  nothingPending: "nothing_pending",
});

export const TURN_WITHOUT_ACTION_REASONS = Object.freeze(Object.values(TURN_WITHOUT_ACTION_REASON));

export type TurnWithoutActionReason = (typeof TURN_WITHOUT_ACTION_REASONS)[number];

/** The emitted name of one empty-turn shape: `turn_closed_without_action:<opener>:<reason>`. */
export const TURN_WITHOUT_ACTION = "turn_closed_without_action";

/** The one shape key, so a log reader and this counter spell a shape the same way. */
export type TurnWithoutActionShape = `${TurnOpening}:${TurnWithoutActionReason}`;

/** The shape key of one `<opener>:<reason>` pair: one spelling for the counter, the printer and any reader. */
export function turnWithoutActionShape(opener: TurnOpening, reason: TurnWithoutActionReason): TurnWithoutActionShape {
  return `${opener}:${reason}`;
}

export function turnWithoutActionToken(opener: TurnOpening, reason: TurnWithoutActionReason): string {
  return `${TURN_WITHOUT_ACTION}:${turnWithoutActionShape(opener, reason)}`;
}

/**
 * Silence in the unit Pi writes it: the ASSISTANT TURN - one assistant record inside a delivered batch.
 *
 * <p>
 * EVERY OTHER COUNTER IN THIS ACCOUNT IS COUNTED PER DELIVERED BATCH (`#observeTurnProduction`), which is the unit the
 * product pays for and not the unit silence happens in. MEASURED 2026-11-15 (`round60`, one Game session): **169** assistant
 * records, **133** with text, **36** that ran a tool and said no word - and `turn_settled_silent` printed `0`. The pump
 * re-segmented the same run into 86 batches (29 spoke, 57 worked), and a batch carrying any line is `worked` by
 * construction because `turnProduction` ORs `producedText` over the whole batch. So none of the 36 landed in any counter: a
 * batch-shaped number and a turn-shaped number are different facts about the same run, and neither can stand for the other.
 * </p>
 * <p>
 * The population is the same closed list `turnProduction` uses, classified by the same `turnProductionOf`, so the two units
 * cannot disagree about what a member means. `examined` is DERIVED from `byProduction`, so the members sum to it and an
 * assistant turn cannot be counted and then disappear from the account.
 * </p>
 */
export type AssistantTurnTally = Readonly<{
  examined: number;
  byProduction: Readonly<Record<TurnProduction, number>>;
}>;

/** The assistant turns that carried text - `worked` + `spoke`, derived over the closed list. */
export function assistantTurnsWithText(tally: AssistantTurnTally): number {
  return countAssistantTurns(tally, turnProducedSpeech);
}

/**
 * The assistant turns that ran a tool and said nothing: work without text, derived from the two predicates rather than
 * named, so it stays the same question `turn_settled_silent` asks - in the other unit.
 */
export function assistantTurnsToolOnly(tally: AssistantTurnTally): number {
  return countAssistantTurns(tally, (production) => turnProducedWork(production) && !turnProducedSpeech(production));
}

function countAssistantTurns(tally: AssistantTurnTally, counted: (production: TurnProduction) => boolean): number {
  return TURN_PRODUCTIONS.reduce(
    (total, production) => (counted(production) ? total + tally.byProduction[production] : total),
    0,
  );
}

/** The account line's label for the assistant-turn group: the unit is named in the label, not in a reader's memory. */
export const ASSISTANT_TURNS_EXAMINED = "assistant turns examined";
/** The two headline readings inside that group, both derived from the members beside them. */
export const ASSISTANT_TURNS_WITH_TEXT = "with text";
export const ASSISTANT_TURNS_TOOL_ONLY = "tool-only";
/**
 * The unit of every segment that follows this one on the account line: one DELIVERED BATCH.
 *
 * It is stated once, at the head of the group it governs, because repeating it on nine segments would say the same word
 * nine times - and because a reader who adds `assistant turns examined` to `turns opened` is the defect this whole unit
 * exists to close.
 */
export const PER_DELIVERED_BATCH = "per delivered batch:";

/**
 * The four labels the flush/delivery reading prints, named once so the printer and its reader cannot disagree.
 *
 * `flushes examined` is the batches the pump assembled, and it must equal `turns opened`: a call that owed no turn is
 * counted under `not owed` instead, and the facts it declined to deliver are proved under `carried`.
 */
export const FLUSHES_EXAMINED = "flushes examined";
export const NOT_OWED_LABEL = "not owed";
export const CARRIED = "carried";
/** Facts admitted whose shape is a BODY TRACE: not an event, never a turn (see `TurnAccount.traces`). */
export const TRACES = "traces";

/**
 * How many traces the account counted, over the kinds it counted them in.
 *
 * Derived, so a total and its members cannot disagree: the account prints this number and the braces beside it, and a
 * count moved from one kind to another cannot change the total without changing the reading beside it.
 */
export function tracedFacts(traces: Readonly<Record<string, number>>): number {
  return Object.values(traces).reduce((total, count) => total + count, 0);
}
export const BUBBLES_DELIVERED = "bubbles delivered";
export const LOST = "lost";
/**
 * The label of the stall reading: how many `execution_stalled` facts this run minted, by the Mod's own reason.
 *
 * IT EXISTS BECAUSE THE OLD READING WAS A ZERO THAT MEANT NOTHING. A run with `lost 0` and no stall segment cannot say
 * whether no execution stalled or whether nothing was measuring - and the measurement was the thing being replaced. With
 * the segment, `stalled 0` means the two authorities never said so, and `stalled 2 {entity_block: 2}` names what the body
 * was blocked on. The braces print ONLY when a fact carried a reason: an empty `{}` would read as an unnamed stall.
 */
export const STALLED = "stalled";

/**
 * The label of the provenance reading: every fact that stated which programme its execution belongs to.
 *
 * MEASURED, THRICE. `round57` `turns opened 66 {adapter_ingress: 57}`, `round59` `88 {adapter_ingress: 79}`, `round62`
 * `82 {adapter_ingress: 82}` against 224 programme dispatches - and no artifact could say how many of those receipts even
 * claimed a programme, because the wire had no field for it. This segment is that reading: `programme` + `standalone` must
 * equal the receipts a run delivered, and `unstated` must be 0 for a bridge that validates its frames.
 */
export const RECEIPTS_WITH_PROVENANCE = "receipts with provenance";

/**
 * A defect token, not a counter: the Mod's journal could not say which programme owns an execution.
 *
 * It prints the count and the executions (bounded), so `unattributed_execution 3 {exec_a, exec_b, exec_c}` is joinable to
 * the Mod's own diagnostic and to a body-program status read. An execution nobody can attribute is the condition that made
 * every previous fix a guess.
 */
export const UNATTRIBUTED_EXECUTION_TOKEN = "unattributed_execution";

/**
 * Turns that delivered speech, ran no action, and closed - counted by BOTH halves of the shape.
 *
 * The opener is half of it because the two mean different things: a `player_input` turn that spoke and did nothing was
 * an answer to the person, while a `due` turn that spoke and did nothing is the robot narrating to itself. `total` is
 * counted beside the shapes so the two can be checked against each other, and the shape population is the product of the
 * two closed lists so a new opener or reason cannot go unreported.
 */
export type TurnWithoutActionResult = Readonly<{
  total: number;
  byShape: Readonly<Record<TurnWithoutActionShape, number>>;
}>;

/**
 * The provenance reading: what the Mod's journal said about the executions whose facts this pump admitted.
 *
 * One count per `ExecutionOrigin` member plus `unstated` (a fact that carried none), and the executions that could not be
 * attributed - the ones whose `unattributed_execution:<id>` a run's account has to be able to name.
 */
export type ExecutionProvenanceAccount = Readonly<{
  facts: Readonly<{ programme: number; standalone: number; unattributed: number; unstated: number }>;
  unattributedExecutions: readonly string[];
  omittedUnattributed: number;
}>;

/**
 * How many unattributed executions the account names. A defect is not traffic: past this many, the count still closes and
 * the names stop, which is what keeps a stuck journal from growing the account with the session.
 */
export const MAX_NAMED_UNATTRIBUTED_EXECUTIONS = 8;

/**
 * What this pump has done with the flushes it examined: one counter per member, one per suppression reason.
 *
 * `examined` is DERIVED (`opened + every suppressed reason`) rather than counted, so a flush cannot be decided and then
 * disappear from the account: a third outcome would break the identity instead of going unreported.
 */
export type TurnAccount = Readonly<{
  opened: number;
  byReason: Readonly<Record<TurnOpening, number>>;
  /**
   * Which producer's fact opened each turn, per opener.
   *
   * The nested half of `byReason`: `world_fact: 28` and `due: 1` are both `Σ producer`, while a `player_input` turn's
   * cause is a person's word rather than a fact and stays zero on every producer. `byReason[opener]` is the authority
   * for the count; this says which entrance the fact came in through.
   */
  openedByProducer: Readonly<Record<TurnOpening, Readonly<Record<FactProducer, number>>>>;
  /**
   * Flush CALLS that owed no turn, one count per `NOT_OWED_REASONS` member.
   *
   * These are the calls the pump declined to treat as flushes: no batch was composed for them, so they are not in
   * `examined` and the arithmetic `examined === opened` holds by construction rather than by subtraction.
   */
  notOwed: Readonly<Record<NotOwedReason, number>>;
  /** Which producer's fact answered each such call: the re-stated fact, the step, or the reading held as state. */
  notOwedByProducer: Readonly<Record<NotOwedReason, Readonly<Record<FactProducer, number>>>>;
  /**
   * The decision facts this pump declined to open a turn for because the surface could not show an answer, by the pump's own
   * fact shape (`factTurnShape`) - `receipt:succeeded`, `world_fact`, `lifecycle`.
   *
   * THE SHAPE IS THE READING. `no_surface_for: 6 {adapter_ingress: 6}` would name the mouth the fact came in through, which is
   * the same mouth for every one of them; what a reader has to fix is the KIND, and `round66`'s six lost turns were one kind
   * (`execution_receipt`) with nothing else in the window. Its total is `notOwed[no_surface_for]` - one shape per call that
   * was answered that way, so the two numbers cannot disagree and a missing shape would show as a short sum.
   */
  noSurface: Readonly<Record<string, number>>;
  /**
   * The batches this pump assembled, counted where the batch is composed.
   *
   * INDEPENDENTLY OF `opened`, deliberately: if a future change composes a batch and then finds it owes no turn, this
   * number grows while `opened` does not, and `event-pump.flushed-then-discarded.test.ts` fails by name. A derived
   * `examined = opened + notOwed` - which is what this field used to be - can never disagree with itself.
   */
  examined: number;
  /** Facts that opened no turn and were consumed by a later batch, and the ones still waiting (see `CarryTicket`). */
  carry: Readonly<{ carried: number; pending: number }>;
  /**
   * Facts admitted whose shape is a body trace, one count per trace KIND: not news, never a turn, never counted as a fact
   * that arrived.
   *
   * <p>
   * A MAP RATHER THAN A NUMBER, and `round65` is why. That run printed `traces 69` over ten minutes and the number named
   * nothing: `tile_advanced` was 0, so the pump could say that the per-tile flood was gone and could not say what had
   * replaced it. The kinds are `TRACE_KINDS`, derived from the two tables the pump classifies traces by, so a state or
   * semantic kind added there is counted and printed without a second list - and the total is `tracedFacts`, derived, so
   * the number and the braces beside it cannot disagree.
   * </p>
   */
  traces: Readonly<Record<string, number>>;
  /**
   * The stall facts this run minted, by the Mod's own reason - the `stalled N {reason: count}` reading.
   *
   * Counted where the fact is minted (`takeStallFact`), so it cannot be derived from anything else and cannot agree with
   * itself about a stall that was never announced.
   */
  stalled: Readonly<{ total: number; byReason: Readonly<Record<string, number>> }>;
  /** What happened to the words a turn produced: the bubbles that committed, and the text that never arrived, by reason. */
  delivery: Readonly<{ bubbles: number; lost: Readonly<Record<string, number>>; lostTotal: number }>;
  /**
   * The assistant turns Pi wrote, per production member: the unit silence is counted in, beside the batch counters that
   * cannot see it - see `AssistantTurnTally`.
   */
  assistantTurns: AssistantTurnTally;
  emptyTurns: TurnWithoutActionResult;
  /** The turns that settled silently: work delivered, no text - see `TurnSettledSilentResult`. */
  silentSettled: TurnSettledSilentResult;
  /** The settled turns that closed with one of her own executions still running - see `TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT`. */
  settledWithExecutionInFlight: number;
  /**
   * Every fact this pump admitted that stated an execution's provenance, by what it said.
   *
   * The reading `round62` could not produce: `unattributed` is a NAMED defect (the Mod's journal could not say which
   * programme owns an execution), and `unstated` is a fact that said nothing at all - the shape the wire now refuses. Both
   * are counted rather than inferred from an absence, because an absence is what the Host used to resolve by time.
   */
  executionProvenance: ExecutionProvenanceAccount;
  /** The flushes a stale reading decided, and why - see `AutoObserveAccount`. */
  autoObserve: AutoObserveAccount;
  lastDecision: TurnDecision | undefined;
}>;

/**
 * The account as the one line a run's log carries, in the shape the invariant is read back in.
 *
 * <p>
 * THE LINE IS TWO READING GROUPS, AND EACH GROUP'S HEAD NAMES ITS UNIT. First the ASSISTANT TURNS - one assistant record
 * Pi wrote: `assistant turns examined N {worked: count, worked_silently: count, spoke: count, said_nothing: count}`, then
 * the two headline readings derived from those members, `with text T` and `tool-only O`. Then the DELIVERED BATCHES, from
 * `per delivered batch:` to the end of the line: `turns opened N {opener: count} · flushes examined F · not owed M
 * {reason: count} · carried C {pending: P} · bubbles delivered B · lost L {reason: count} · stalled N {reason: count} ·
 * turn_closed_without_action E {opener:reason: count}` `· turn_settled_silent S {opener: count}` `·
 * turn_settled_with_execution_in_flight I` `· aged readings A · auto_observe_on_stale R {ageTurns}` `·
 * auto_observe_unavailable U {reason: count}` `· refresh_rearmed W {reason: count}`.
 * </p>
 * <p>
 * `flushes examined F` AND `turns opened O` ARE ONE NUMBER, PRINTED TWICE, and that is the invariant this line exists to
 * make readable: a batch is composed only when a turn is owed, so there is no code path that assembles one and discards
 * it. The calls that owe no turn are a different population entirely (`not owed M`), and the facts they declined to
 * deliver are proved under `carried C` - consumed by a later batch - with `pending: P` naming the ones still waiting.
 * Measured 2026-11-16 (`round64`), before this split: `flushes examined 134 · turns opened 8 · suppressed 126
 * {in_flight_progress 125}`, i.e. 93% of the pump's work was assembling a batch and dropping it.
 * </p>
 * <p>
 * `bubbles delivered B · lost L {reason: count}` IS THE DELIVERY HALF, and it exists because a bubble that was delivered
 * but never presented (`no_presentation_lease`: the turn carried no presentation source, so no projection ever saw its
 * text) was counted per turn on stderr and nowhere a run's account could be read. A loss has to be a number a reader can
 * see, not a zero that means "nobody looked".
 * </p>
 * <p>
 * `stalled N {reason: count}` IS THE LIVENESS READING, and it is the segment the replaced measurement could not produce.
 * Liveness used to be a wall-clock bound on how long an execution had gone without a fact, so that reading could only ever
 * say "how long since anything happened" - and a run whose Mod had stopped emitting traces read as one long stall. Every
 * fact counted here was minted from the body controller's own verdict, so `N` counts announcements and the braces name the
 * Mod's reasons (`entity_block`). The braces are omitted when no fact carried a reason, and printing the number at all is
 * the point: `stalled 0` says the two authorities never said so, rather than a zero that might mean nobody asked.
 * </p>
 * <p>
 * WHY THE TWO GROUPS ARE NAMED. MEASURED 2026-11-15 (`round60`): one run had 169 assistant turns, 36 of which said
 * nothing, and an account that printed `turn_settled_silent 0` - because every one of those turns sat inside a batch that
 * also carried a line, and the batch is the unit every counter on the second half of the line is counted in. A reader who
 * adds the two groups together reads a number nobody measured, so the unit is stated at each group's head rather than
 * left to the doc.
 * </p>
 *
 * A reason that has
 * never fired is still printed as `0`: it is a declared member of a closed list, and a reader must be able to see that it
 * exists and never happened rather than guess from its absence. The opener histogram is printed for the same reason at the level above: `opened 55` said a number and nothing
 * about what opened them, so "she was woken by the clock fifty times" and "the person spoke fifty times" were the same
 * line.
 *
 * A reason a FACT decided carries the producers of those facts inside its own braces - `world_fact: 28 {adapter_ingress:
 * 26, narration_without_work: 2}` - because the reason alone still collapses six entrances into one word, and `flushes
 * examined 655` with no producer on it was a question answered by reading `enqueueFact`'s call sites instead of the log.
 * Only producers that FIRED are printed: the closed set is declared once above, the reason's own count is the declared
 * total beside it, and eleven zeroes repeated on each of a run's six hundred lines would be noise where the reading is
 * one number. `no_surface_for` is the one exception, and it is the reverse: its braces name the fact SHAPES that could not
 * be shown (`no_surface_for: 6 {receipt:succeeded: 6}`), because all six came in through the same producer and the shape is
 * what `round66` measured and what a fix has to move.
 *
 * The three stale segments are what makes a REMOVED turn countable AND a turn that was NOT removed explainable. A refresh
 * costs no turn, so without them "the stale notices stopped opening turns" and "the stale notices stopped happening"
 * would print the same line; with them, `A` is how many examined flushes reached their decision holding a reading they
 * did not bring, `R` is how many of those asked the world and were answered, and `U` is how many could not be asked,
 * split by why. `A` is printed first because it is the population the other two partition: an aged reading with `R + U`
 * short of it is one nobody has accounted for. `W` is not in that partition - it is not a turn - and it exists because
 * `U`'s `refresh_attempts_spent` hides the one question a frozen world forces: WHAT earned the budget back. After
 * `round61` the answer can be the world's own statement that it moved while the snapshot stayed frozen, and a reader who
 * could not see that number would read the pump as deaf for ten and a half minutes.
 */
export function turnAccountLine(account: TurnAccount): string {
  const assistantProductions = TURN_PRODUCTIONS.map(
    (production) => `${production}: ${String(account.assistantTurns.byProduction[production])}`,
  ).join(", ");
  const opened = TURN_OPENINGS.map(
    (reason) => `${reason}: ${String(account.byReason[reason])}${producerBlock(account.openedByProducer[reason])}`,
  ).join(", ");
  const notOwed = NOT_OWED_REASONS.map((reason) => {
    // The surface reason's braces name the SHAPES that could not be shown rather than the producer that sent them: every one
    // of them arrives through the adapter, so the producer would answer a question nobody asked.
    const braces =
      reason === NOT_OWED.noSurface ? shapeBlock(account.noSurface) : producerBlock(account.notOwedByProducer[reason]);
    return `${reason}: ${String(account.notOwed[reason])}${braces}`;
  }).join(", ");
  // The loss reading's population is the reasons the delivery layer REPORTED, so a reason the projection adds appears here
  // without a second table to extend. Sorted, so two runs' lines can be compared.
  const empty = emptyTurnShapes()
    .map((shape) => `${shape}: ${String(account.emptyTurns.byShape[shape])}`)
    .join(", ");
  const silent = SILENT_SETTLED_OPENINGS.map(
    (opener) => `${opener}: ${String(account.silentSettled.byOpener[opener])}`,
  ).join(", ");
  const unavailable = AUTO_OBSERVE_UNAVAILABLE_REASONS.map(
    (reason) => `${reason}: ${String(account.autoObserve.unavailable[reason])}`,
  ).join(", ");
  // The age is printed only where a refresh happened: `0` is a real age (a reading asked about on the turn it moved),
  // so a zero printed for "no refresh yet" would be the one number a reader could not tell apart from a measurement.
  const refreshed =
    account.autoObserve.refreshed === 0 || account.autoObserve.lastAgeTurns === undefined
      ? `${AUTO_OBSERVE_ON_STALE} 0`
      : `${AUTO_OBSERVE_ON_STALE} ${String(account.autoObserve.refreshed)} {ageTurns: ${String(account.autoObserve.lastAgeTurns)}}`;
  const declined = AUTO_OBSERVE_UNAVAILABLE_REASONS.reduce(
    (total, reason) => total + account.autoObserve.unavailable[reason],
    0,
  );
  const rearmed = AUTO_OBSERVE_REARM_REASONS.map(
    (reason) => `${reason}: ${String(account.autoObserve.rearmed[reason])}`,
  ).join(", ");
  const rearmedAgain = AUTO_OBSERVE_REARM_REASONS.reduce(
    (total, reason) => total + account.autoObserve.rearmed[reason],
    0,
  );
  // The provenance reading, and the defect it exists to name. A run whose journal cannot attribute an execution says
  // `unattributed_execution <id>` here, in the same line a reader already greps for turns: the missing field that let
  // `round62` open 82 ingress turns was invisible in every artifact a run produced.
  const provenance = account.executionProvenance;
  const unattributed = `${UNATTRIBUTED_EXECUTION_TOKEN} ${String(provenance.facts.unattributed)}${
    provenance.unattributedExecutions.length === 0
      ? ""
      : ` {${provenance.unattributedExecutions.join(", ")}${provenance.omittedUnattributed === 0 ? "" : `, +${String(provenance.omittedUnattributed)}`}}`
  }`;
  const receiptProvenance = `${RECEIPTS_WITH_PROVENANCE} ${String(
    provenance.facts.programme +
      provenance.facts.standalone +
      provenance.facts.unattributed +
      provenance.facts.unstated,
  )} {programme: ${String(provenance.facts.programme)}, standalone: ${String(provenance.facts.standalone)}, unattributed: ${String(provenance.facts.unattributed)}, unstated: ${String(provenance.facts.unstated)}}`;
  const lostReading = Object.keys(account.delivery.lost)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((reason) => `${reason}: ${String(account.delivery.lost[reason])}`)
    .join(", ");
  // The stall reading's population is the reasons the FACTS carried, so a reason the body controller adds appears here
  // without a second table to extend - and the braces are printed only when one did, because `stalled 3 {}` would name a
  // stall whose reason nobody wrote down.
  const stalledReading = Object.keys(account.stalled.byReason)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((reason) => `${reason}: ${String(account.stalled.byReason[reason])}`)
    .join(", ");
  const stalledSegment = `${STALLED} ${String(account.stalled.total)}${stalledReading === "" ? "" : ` {${stalledReading}}`}`;
  // The trace reading's population is the pump's own `TRACE_KINDS`, so a declared member is printed as `0` rather than
  // left out: `traces 69` alone was a number no run could act on (`round65`), and `which trace stopped` is the question
  // the zeros answer.
  const tracesReading = TRACE_KINDS.map((kind) => `${kind}: ${String(account.traces[kind] ?? 0)}`).join(", ");
  const tracesSegment = `${TRACES} ${String(tracedFacts(account.traces))} {${tracesReading}}`;
  return `${ASSISTANT_TURNS_EXAMINED} ${String(account.assistantTurns.examined)} {${assistantProductions}} · ${ASSISTANT_TURNS_WITH_TEXT} ${String(assistantTurnsWithText(account.assistantTurns))} · ${ASSISTANT_TURNS_TOOL_ONLY} ${String(assistantTurnsToolOnly(account.assistantTurns))} · ${PER_DELIVERED_BATCH} turns opened ${String(account.opened)} {${opened}} · ${FLUSHES_EXAMINED} ${String(account.examined)} · ${NOT_OWED_LABEL} ${String(notOwedTotal(account))} {${notOwed}} · ${CARRIED} ${String(account.carry.carried)} {pending: ${String(account.carry.pending)}} · ${tracesSegment} · ${BUBBLES_DELIVERED} ${String(account.delivery.bubbles)} · ${LOST} ${String(account.delivery.lostTotal)} {${lostReading}} · ${stalledSegment} · ${TURN_WITHOUT_ACTION} ${String(account.emptyTurns.total)} {${empty}} · ${TURN_SETTLED_SILENT} ${String(account.silentSettled.total)} {${silent}} · ${TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT} ${String(account.settledWithExecutionInFlight)} · ${AUTO_OBSERVE_AGED_TURNS} ${String(account.autoObserve.agedTurns)} · ${refreshed} · ${AUTO_OBSERVE_UNAVAILABLE_TOKEN} ${String(declined)} {${unavailable}} · ${AUTO_OBSERVE_REARMED} ${String(rearmedAgain)} {${rearmed}} · ${receiptProvenance} · ${unattributed}`;
}

/**
 * Every shape an empty turn can have: the product of the two closed lists, in one spelling.
 *
 * Derived rather than listed, so an opener added to `TURN_OPENINGS` (or a reason added beside this function) is printed
 * and counted without anyone remembering to extend a second table.
 */
export function emptyTurnShapes(): readonly TurnWithoutActionShape[] {
  return TURN_OPENINGS.flatMap((opener) =>
    TURN_WITHOUT_ACTION_REASONS.map((reason) => turnWithoutActionShape(opener, reason)),
  );
}

/**
 * One frozen copy of a producer histogram per reason: the account is a reading, so a caller cannot move a counter by
 * holding what it was handed.
 */
function freezeProducerHistograms<Reason extends string>(
  counts: Readonly<Record<Reason, Record<FactProducer, number>>>,
  reasons: readonly Reason[],
): Readonly<Record<Reason, Readonly<Record<FactProducer, number>>>> {
  const frozen = {} as Record<Reason, Readonly<Record<FactProducer, number>>>;
  for (const reason of reasons) frozen[reason] = Object.freeze({ ...counts[reason] });
  return Object.freeze(frozen);
}

function notOwedTotal(account: TurnAccount): number {
  return NOT_OWED_REASONS.reduce((total, reason) => total + account.notOwed[reason], 0);
}

/**
 * The producers that fired inside one reason's braces, or nothing when none did.
 *
 * Nothing is printed for `player_input` and `nothing_pending` for the reason a zero block would be a lie about the
 * question: no fact decided those flushes, so no producer of one can be named. A reason no producer fired for is the
 * same shape - the reason's own count beside it is the reading, and it is the declared member that says so.
 */
function producerBlock(counts: Readonly<Record<FactProducer, number>>): string {
  const fired = FACT_PRODUCERS.filter((producer) => counts[producer] > 0).map(
    (producer) => `${producer}: ${String(counts[producer])}`,
  );
  return fired.length === 0 ? "" : ` {${fired.join(", ")}}`;
}

/**
 * The fact shapes inside one reason's braces, sorted - see `TurnAccount.noSurface` for why this reason names shapes.
 *
 * Nothing is printed when the reason has not fired: the reason's own count beside it is the reading, and an empty block would
 * be a claim that a shape was named.
 */
function shapeBlock(counts: Readonly<Record<string, number>>): string {
  const fired = Object.keys(counts)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((shape) => `${shape}: ${String(counts[shape])}`);
  return fired.length === 0 ? "" : ` {${fired.join(", ")}}`;
}

/** The counter, keyed by the closed set of shapes rather than by what this run happened to do. */
function initializedEmptyTurns(): Record<TurnWithoutActionShape, number> {
  const counts = {} as Record<TurnWithoutActionShape, number>;
  for (const shape of emptyTurnShapes()) counts[shape] = 0;
  return counts;
}

/** One all-zero counter per reason in a closed list, derived so a second table cannot forget a member. */
function initializedByReason<Reason extends string>(reasons: readonly Reason[]): Record<Reason, number> {
  const counts = {} as Record<Reason, number>;
  for (const reason of reasons) counts[reason] = 0;
  return counts;
}

/**
 * One all-zero producer histogram per reason, from the two closed lists.
 *
 * Derived rather than listed, so a producer added to `FACT_PRODUCER` (or a reason added to its own list) is counted
 * without anyone remembering to extend a second table - and a pair that never fired is a declared zero rather than an
 * absent key.
 */
function initializedByProducer<Reason extends string>(
  reasons: readonly Reason[],
): Record<Reason, Record<FactProducer, number>> {
  const counts = {} as Record<Reason, Record<FactProducer, number>>;
  for (const reason of reasons) {
    const producers = {} as Record<FactProducer, number>;
    for (const producer of FACT_PRODUCERS) producers[producer] = 0;
    counts[reason] = producers;
  }
  return counts;
}

/**
 * The emitted name of a turn that settled SILENT: it produced work and delivered no speech - counted by the opener beside
 * it.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`): 188 planned nodes across 55 turns, `turn_closed_without_action` 41 of 64 assistant
 * turns, and the run's own clock split 376 s in turns that acted against 239 s in turns of pure talk. Those 41 are one
 * statement, "she spoke and did nothing", and the account had no second statement for the turn whose only sanctioned
 * outcome was a line of speech because the batch that opened it carried RECEIPTS that had already settled everything in
 * it. That shape exists by construction - the plan tool's description ends with "…end your turn and speak to the player",
 * and a terminal receipt is a non-held fact that opens a follow-up turn (`#hasPendingFactTrigger`) - and nothing could
 * count it.
 * </p>
 * <p>
 * It is the OTHER HALF of `turn_closed_without_action`, not a second name for it: that one delivered speech and no action,
 * this one delivered action and no speech. With both on the line a reader can tell "she spent the turn talking" from "she
 * spent the turn working", which is the distinction no artifact of that run carried.
 * </p>
 * <p>
 * A READING, NOT A PERMISSION. Nothing here forbids speech, suppresses it, or asks for silence: the counter reports how a
 * turn ended, and it cannot make a turn end that way. Measured 2026-11-15 (`round58`): 21 opened turns, 21 bubbles, this
 * counter `0`, because the reading only recognised `said_nothing` - the one member a completed turn cannot reach - so the
 * act-without-a-word shape had no name and every count of "one bubble per turn" had to be inferred from the difference
 * between two other numbers.
 * </p>
 * <p>
 * MEASURED AGAIN 2026-11-15 (`round59`): 42 settled turns, all 42 with text, this counter `0` - and a probe of the same
 * tree returned `0` for a quiet turn whose own receipt was in flight while returning `1` for the same turn with nothing in
 * flight. The counter was gated on "nothing of hers is still settling", and she submits a programme on nearly every turn,
 * so the shape it exists to name was excluded by the state it most often lands in. That condition is gone from the
 * classification; the number it was hiding behind is printed beside this one.
 * </p>
 * <p>
 * COUNTED PER DELIVERED BATCH, WHICH IS WHY IT READ `0` AGAIN. MEASURED 2026-11-15 (`round60`): 169 assistant turns, 36 of
 * them silent, and this counter `0` - every one of those 36 sat inside a batch that also carried a line, and a batch with
 * any text in it is `worked` by construction. So the silence of a turn is counted where the turn is written
 * (`AssistantTurnTally`, printed as `assistant turns examined N {…} · with text T · tool-only O`), and this counter keeps
 * the question it CAN answer: how many DELIVERIES spent themselves on work with no word. The two are different populations
 * of the same run and neither is the other's total.
 * </p>
 */
export const TURN_SETTLED_SILENT = "turn_settled_silent";

/**
 * A silent settlement cannot be the person's turn: a turn the person opened is owed an answer.
 *
 * <p>
 * `player_input` is the one opener whose silence is a different defect with its own reading - someone spoke and got
 * nothing - so counting it here would say "there was nothing to say" about the one case where the opposite is known. The
 * class is stated as the complement of that single member rather than as a list of the openers a turn may fall silent on,
 * so a new opener is counted without anyone returning to this declaration.
 * </p>
 */
export type SilentSettledOpening = Exclude<TurnOpening, "player_input">;

/** Every opener a silent settlement can have, derived from `TURN_OPENINGS` - the population is the closed list. */
export const SILENT_SETTLED_OPENINGS = Object.freeze(
  TURN_OPENINGS.filter((opener): opener is SilentSettledOpening => opener !== TURN_OPENING.playerInput),
);

/**
 * Turns that produced work and delivered no speech, counted by opener.
 *
 * The opener is half of it for the reason the empty-turn counter gives: a fact arriving is a turn the HOST owed, the
 * world's own clock or notice is a turn the WORLD owed, and a due wake is a turn her own schedule owed - three different
 * statements about why a companion had a turn and used it for nothing.
 *
 * What it counts is the turn that had something to do and did it without a word: `workedSilently`, or - stated as the two
 * properties rather than the member's name - work produced and no text produced. A turn that did nothing at all produces
 * neither and is not counted here, and a turn whose own receipt was still in flight when it closed is silence like any
 * other; how many turns closed that way is `settledWithExecutionInFlight` beside it.
 */
export type TurnSettledSilentResult = Readonly<{
  total: number;
  byOpener: Readonly<Record<SilentSettledOpening, number>>;
}>;

/** The counter, keyed by the declared openers rather than by what this run happened to do. */
function initializedSilentSettled(): Record<SilentSettledOpening, number> {
  const counts = {} as Record<SilentSettledOpening, number>;
  for (const opener of SILENT_SETTLED_OPENINGS) counts[opener] = 0;
  return counts;
}

/**
 * The emitted name of the settled turns that closed with one of her own executions still running: `28` of `36` programme
 * turns, on the one run that was read to find this.
 *
 * <p>
 * THIS IS THE CONDITION THAT USED TO EXCLUDE, written down instead of acted on. `turn_settled_silent` counts the turn that
 * worked and said nothing, and a receipt still in flight describes how much of that work is left - not whether anything was
 * said. But until this segment existed the in-flight bit was only a discount on the other counter, so a run whose every
 * working turn was quiet (`round59`: `42 settled turns · with text 42 · tool-only 0`, `turn_settled_silent 0`) could not
 * say whether the silence was hers or whether the counter's own gate had been shut 28 times. A reader asked to reconstruct
 * that from session logs is being asked to re-derive a number this pump already held at the only moment it could be asked.
 * </p>
 * <p>
 * It is a POPULATION OF ALL SETTLED TURNS, not a subclass of the silent ones: a turn that worked, spoke and was still
 * running when it closed counts here and in neither silence counter.
 * </p>
 */
export const TURN_SETTLED_WITH_EXECUTION_IN_FLIGHT = "turn_settled_with_execution_in_flight";

/**
 * One delivered batch: the model-facing TEXT, and the frame its readers hang on it.
 *
 * <p>
 * The text is the player's own words verbatim at its head, then `composeFactBrief`'s named blocks of prose
 * (`fact-brief.ts`). It is one string and nothing parses it: what a reader needs structurally - the batch identity, the
 * inputs' locales, the presentation events - is a field here, so there is exactly one spelling of each and no JSON
 * envelope inside the model's user message.
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
  /**
   * Whether THIS batch brought the observation, as `takeBatch` decided it for the world-state block.
   *
   * Carried on the batch rather than re-derived at settlement because it is the batch's own statement: the model was
   * told `刚刚更新` or `本轮无新观察` according to this flag, so a turn that spoke and did nothing can be split into "her
   * picture was already old" and "her picture was current" without a second computation that could disagree with the
   * one the model read.
   */
  broughtObservation: boolean;
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
 * How many carry tickets the pump remembers.
 *
 * A ticket's only job is to answer "which batch consumed these facts", so a bound on them is a bound on the answer's
 * window rather than on the facts: resolved tickets are evicted first, and a ticket whose answer has aged out is a name a
 * reader can see missing rather than a fact nobody can prove.
 */
export const MAX_CARRY_TICKETS = 512;

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

/** The same Host-minted source label the arrival, notice, settled-plan, world-stale, refresh-refused and narration
 * facts carry. */
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
 * The semantic kind of the fact the Host mints when it ASKED for a fresh observation and the integration would not
 * serve one.
 *
 * <p>
 * `world_state_stale` says the reading is old; it does not say whether anybody tried to replace it. A probe that fails
 * silently is indistinguishable from a probe that found the world unchanged - both leave the reading where it was, and
 * the second is the ordinary case - so a bridge that is down reads exactly like a world that did not move. Measured
 * 2026-11-10 (`round45`): fifty turns on `revision 352` with no layer asking for another reading, so "the bridge would
 * not answer" was never a statement any artifact could carry.
 * </p>
 */
export const WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND = "world_state_refresh_refused";

/**
 * Fresh observations one AGED reading may be asked for, and why three.
 *
 * <p>
 * The unit is one READING - the content of one observation she has already been shown: every flush decided while that
 * content is still the current one is decided on the same reading, so the budget is re-armed when the READING MOVES and
 * never per flush or per counter. A frozen world therefore cannot become a spin: the same reading is never asked about
 * more than this many times, however many flushes it lasts - and a re-observation that only bumped the Mod's revision is
 * still the same reading, which is why the key is the content and not that number.
 * </p>
 *
 * <p>
 * THE READING IS NOT THE ONLY RE-ARM KEY, and it cannot be (`AUTO_OBSERVE_REARM`, measured in `round61`): its content is
 * produced by the ask this bound gates, so a snapshot channel that stopped publishing was a budget that could never come
 * back while the clock kept advancing. The world saying it moved earns the next ask. Neither key is the flush, so the
 * cadence this refuses to poll at is still refused.
 * </p>
 *
 * <p>
 * One would cover the ordinary case - the bridge is up and the answer moves the reading. The other two exist because the
 * first can land on a transient (a `bridge_response_timeout` at the exact moment the world crossed), and the cost of not
 * asking again is the whole defect this exists for: fifty turns on a picture the Host already knows is wrong.
 * </p>
 *
 * <p>
 * MEASURED 2026-11-13 (`round50b`): two turns in, three asks were still unspent and the reading was already aged - the
 * filter that had to pass first (a flush opened by nothing but a stale notice) was not the condition the diagnosis was
 * made on, so `world_stale` was classified and nothing asked. The budget is now spent by every flush that reaches its
 * decision holding the aged reading - including the ones it then suppresses - which is why three asks is also the longest
 * a frozen reading goes quiet: past the third ask the world is not answering, and that is SAID (`world_state_stale`, then
 * `auto_observe_unavailable:refresh_attempts_spent`) rather than retried.
 * </p>
 */
export const WORLD_STATE_REFRESH_ATTEMPTS = 3;

/**
 * Why a flush holding an aged reading could not be cured, in the conditions this pump can tell apart.
 *
 * <p>
 * Each of them means the same thing for what follows: the refresh did not happen, so the reading stays as it was and (past
 * its own threshold) still carries the stale notice - and the account says which condition it was, because "nobody
 * asked", "the budget is spent" and "the bridge refused" are different readings of one frozen world.
 * </p>
 */
export const AUTO_OBSERVE_UNAVAILABLE = Object.freeze({
  /** No port is attached: this pump structurally cannot ask (a reduced composition, or a wiring bug). */
  noBridge: "no_bridge",
  /** This reading has already spent `WORLD_STATE_REFRESH_ATTEMPTS`, and the world has said nothing new since the last
   * ask; asking again asks the same question. */
  attemptsSpent: "refresh_attempts_spent",
  /** The route was asked and refused - `world_state_refresh_refused` carries the route's own words. */
  refused: "refresh_refused",
});

export const AUTO_OBSERVE_UNAVAILABLE_REASONS = Object.freeze(Object.values(AUTO_OBSERVE_UNAVAILABLE));

export type AutoObserveUnavailableReason = (typeof AUTO_OBSERVE_UNAVAILABLE_REASONS)[number];

/**
 * The two signals that earn a spent refresh budget again, one spelling each.
 *
 * <p>
 * MEASURED 2026-11-15 (`round61`): `GAME_CLOCK_STALLED` reported `sinceLastSnapshotMs 630353` while `GAME_CLOCK_READ` read
 * the clock every 30 s all the way to day 6 - the bridge answered and the world moved, the snapshot never arrived - and
 * the pump had spent its three asks before that, so `refresh_attempts_spent` was every aged turn it could state for ten
 * and a half minutes. Thirteen turns closed `world_stale` and the companion had no world to act in.
 * </p>
 *
 * <p>
 * The defect was the SHAPE of the bound, not its size: the re-arm key was the reading's own content, and the only producer
 * of a different reading is the ask that budget gates - so a frozen snapshot was a budget that could never come back, and
 * the reset condition was the success of the operation it bounds. The two signals here are the two independent things that
 * make "is there a reading other than this one" a NEW question: the reading moved (an ask was answered), or the world
 * SAID it moved while the reading did not (the Mod's own clock, day, pass-out and `snapshot_changed` facts, as
 * `describeWorldChange` reads them). The clock is the member that carries the second in practice, and it is proof the
 * bridge is answering - so a frozen snapshot is a publish problem, not a world that is not answering.
 * </p>
 *
 * <p>
 * NEITHER SIGNAL IS THE FLUSH. A flush that brings no statement from the world re-arms nothing, however many of them
 * there are: the re-arm is what the world said, never the fact that a turn happened, which is what keeps the flush cadence
 * from becoming a probe cadence in a world that is genuinely still (`WORLD_STATE_REFRESH_ATTEMPTS`).
 * </p>
 */
export const AUTO_OBSERVE_REARM = Object.freeze({
  /** The reading's content changed: the ask was answered with a different world. */
  readingMoved: "reading_moved",
  /** The world said it moved - the clock, the day, a pass-out, a warp - while the reading stayed frozen. */
  worldMoved: "world_moved",
});

export const AUTO_OBSERVE_REARM_REASONS = Object.freeze(Object.values(AUTO_OBSERVE_REARM));

export type AutoObserveRearmReason = (typeof AUTO_OBSERVE_REARM_REASONS)[number];

/** The emitted name of the budget's re-arm: `refresh_rearmed W {reason: count}`, once per signal. */
export const AUTO_OBSERVE_REARMED = "refresh_rearmed";

/** The emitted name of one refresh: `auto_observe_on_stale:<ageTurns>`, one per refresh. */
export const AUTO_OBSERVE_ON_STALE = "auto_observe_on_stale";

export function autoObserveOnStaleToken(ageTurns: number): string {
  return `${AUTO_OBSERVE_ON_STALE}:${String(ageTurns)}`;
}

/** The emitted name of one crossing the world could not be asked about: `auto_observe_unavailable:<reason>`. */
export const AUTO_OBSERVE_UNAVAILABLE_TOKEN = "auto_observe_unavailable";

export function autoObserveUnavailableToken(reason: AutoObserveUnavailableReason): string {
  return `${AUTO_OBSERVE_UNAVAILABLE_TOKEN}:${reason}`;
}

/**
 * The printed name of the population the refresh serves: `aged readings N`, one per examined flush that reached its
 * decision holding a reading she had already been shown.
 */
export const AUTO_OBSERVE_AGED_TURNS = "aged readings";

/**
 * What the pump did about the turns it was about to compose from a reading the world had already moved past.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`): 22 of the 41 talk-only turns were handed `world_state_stale:...`. The Host opened a
 * turn to tell her that the world she could not see was out of date, and the cheapest thing she could do with that turn
 * was describe it - the same observation the Host could have fetched for free. So a stale reading is answered by ASKING,
 * and the turn that would have been spent narrating the notice does not open.
 * </p>
 *
 * <p>
 * THE THREE NUMBERS ADD UP, and that is what makes them a reading rather than three counters: `agedTurns` is every
 * examined flush that reached its decision holding a reading she already had, and each of those is exactly one of
 * `refreshed` (the world was asked and answered, so whatever turn follows states the answer) or `unavailable` (it could not
 * be asked, by reason). `refreshed` is therefore one per `auto_observe_on_stale:<ageTurns>` and NOT one per request: an ask
 * the route refused is counted in `unavailable[refresh_refused]`, and `worldStateRefresh.probes` remains the count of
 * requests made. `lastAgeTurns` is the age the most recent refresh was applied at, and `undefined` before any - so the
 * count and the number it was counted at cannot be confused with a zero.
 * </p>
 *
 * <p>
 * MEASURED 2026-11-13 (`round50b`), which is why `agedTurns` is printed at all: the account said
 * `auto_observe_on_stale 0 · auto_observe_unavailable 0 {...}` for a run whose only two turns were `world_stale` and
 * `nothing_pending`. Both counters were truthful and the account could not say that anything had been aged, so "the cure
 * never fired" and "no turn was aged" read as the same line.
 * </p>
 */
export type AutoObserveAccount = Readonly<{
  /** Examined flushes that reached their decision on a reading she had already been shown: the population every other
   * field here partitions. */
  agedTurns: number;
  refreshed: number;
  lastAgeTurns: number | undefined;
  unavailable: Readonly<Record<AutoObserveUnavailableReason, number>>;
  /**
   * How a SPENT budget was earned again, one count per `AUTO_OBSERVE_REARM` member.
   *
   * The two are different readings of one recovery and a reader must be able to tell them apart: `readingMoved` is the ask
   * being answered, `worldMoved` is the world saying it moved while the snapshot stayed frozen (`round61`). Neither is a
   * turn count, so neither belongs in the `agedTurns` partition above.
   */
  rearmed: Readonly<Record<AutoObserveRearmReason, number>>;
}>;

/**
 * Where a stale reading is acted on: the integration's own fresh observation, and the one route a Host-minted fact is
 * published by.
 *
 * <p>
 * `observe` is the producer `stardew_observe` and the execute path's `stale_snapshot` re-take already call
 * (`StardewBridgeConnection.observe` -> `observe_request`), so this asks the Mod exactly what the model's own tool asks
 * and puts no new message on the wire. `publish` is `CompanionHostService.acceptHostMintedFact`, so a refusal travels
 * the same route every other Host-minted fact does and cannot become a second way to start a turn.
 * </p>
 */
export type WorldStateRefreshPort = Readonly<{
  /** Ask the integration for a fresh observation; what it published arrives as an ordinary snapshot fact. */
  observe(): Promise<unknown>;
  /** Deliver one fact this pump minted, by the Host's own Host-minted-fact route. */
  publish(fact: WorldFact): void;
}>;

/**
 * What the refresh can say about itself: whether it can fire at all, and what asking has done.
 *
 * `attached: false` is a pump that structurally cannot refresh - the composition never installed a port - which is a
 * condition a gate has to be able to read rather than infer from a message that never appears.
 */
export type WorldStateRefreshReading = Readonly<{
  attached: boolean;
  /** Fresh observations asked for over this pump's life. */
  probes: number;
  /** `world_state_refresh_refused` facts published over this pump's life. */
  refusals: number;
}>;

/**
 * One request for a fresh observation, taken as far as it can go synchronously.
 *
 * <p>
 * The two arms are two different things for the caller to do, and they are one type because they are one decision: a
 * `declined` ask means no request is possible, so there is nothing to wait for and the turn is composed from the reading
 * it has (the account records why); an `inFlight` ask is the request itself, which the turn that is about to be composed
 * WAITS for. Collapsing the two into "a promise that may reject" would make "nobody asked" indistinguishable from "the
 * bridge refused", which is the distinction the whole block exists for.
 * </p>
 *
 * <p>
 * The return is synchronous for a reason a test found: a pump with no port, or a revision whose attempts are spent, must
 * decide before the batch is composed rather than a microtask later - `flush` composes nothing it did not decide, and a
 * pump that cannot ask must compose exactly what it did before this existed.
 * </p>
 */
type FreshObservationAsk = Readonly<{ declined: AutoObserveUnavailableReason } | { inFlight: Promise<void> }>;

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
 * The Mod's own word for "this execution is waiting, and I have said so": the body controller's `stalled_waiting`
 * receipt.
 *
 * <p>
 * MINTED WHERE THE BODY CONTROLLER KNOWS IT (`StardewBodyController.cs:1174`), and read here INSTEAD of counted as
 * traffic: a receipt that carries this reason is the one statement in the product that says an execution is not making
 * progress. Counting its arrival as liveness was the defect - the Mod shouting "I am stuck" re-armed the clock that
 * existed to notice the silence, so the stuckest execution was the one that looked healthiest.
 * </p>
 */
export const MOD_STALL_VERDICT_CODE = "stalled_waiting";

/**
 * The engine's own step, for the one place a duration crosses from the Mod to the Host.
 *
 * The body controller measures its wait in TICKS (`stalled_ticks`, `StardewBodyController.cs:1174`) and the Host speaks
 * milliseconds, so exactly one conversion exists and it lives here with its rate named once: Stardew's update loop is the
 * 60 Hz step the Mod's own suite states (`StageLogSamplerTests.cs:23`, "one engine tick at 60 fps, so a simulated second
 * is exactly 60 ticks").
 */
export const STARDEW_TICKS_PER_SECOND = 60;

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
 * <p>
 * CHOSEN BETWEEN TWO MEASURED SHAPES. It used to be derived from `EXECUTION_STALL_BOUND_MS` - the ms bound this file no
 * longer has, because a wall-clock distance cannot answer whether an execution is alive - and a THRESHOLD may not hang
 * off an authority the product has stopped keeping. So it is stated, and bounded by what was measured: the ordinary
 * "speak, then act" shape is ONE spoken turn (a companion who speaks once and then works is never named), and
 * `round45`'s defect was five consecutive turns of pure narration while her body stood still. Three sits between them, at
 * `MEASURED_TURN_CADENCE_MS` 127 s of the run spent speaking and doing nothing - past a minute, and short of the five the
 * defect took.
 * </p>
 */
export const NARRATION_WITHOUT_WORK_TURNS = 3;

/**
 * Each further narration fact waits this many bounds of the same run.
 *
 * One per bound would spend the run on one reading re-stated: forty narration turns would be forty facts. Four bounds
 * gives 3, 12, 21, 30, 39 - five facts for the same forty turns - which keeps the reading alive without paying for it
 * every turn.
 */
export const NARRATION_REARM_MULTIPLE = 4;

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

/**
 * One standing stall verdict: the Mod's own statement that an execution is waiting, in its own words.
 *
 * <p>
 * NOTHING HERE IS A HOST MEASUREMENT. `reason` and `waitedMs` are the body controller's own - `reason=entity_block` from
 * the verdict's evidence, and `stalled_ticks` converted once at `STARDEW_TICKS_PER_SECOND` - and the fact minted from it
 * carries them verbatim, so the model reads what the Mod decided rather than how long the Host has heard nothing.
 * </p>
 */
export type ModStallVerdict = Readonly<{
  executionId: string;
  /** The Mod's own action label, when the receipt carried one. */
  actionId?: string;
  /** Why the body is not moving, in the Mod's own word (`entity_block`), else the verdict's own code. */
  reason: string;
  /** How long the Mod says it has waited, converted from its own ticks. */
  waitedMs: number;
  /** Whether the stall fact for THIS verdict has already been minted. One verdict is announced once. */
  published: boolean;
}>;

/**
 * Everything one reading of an execution's liveness can say, from the two authorities that can say it.
 *
 * <p>
 * `programmesInFlight` is the programme's own state (`readInFlightProgrammes`): work the journal still shows running, and
 * a running programme is not stalled. `verdicts` is the Mod's statement that the body of that work is waiting. The two
 * answer different questions and that is the point - state answers "is anything alive", the verdict answers "is the
 * live thing stuck" - so neither can stand in for the other.
 * </p>
 */
export type ExecutionLivenessReading = Readonly<{
  /** The verdicts standing now, in the order they arrived. */
  verdicts: readonly ModStallVerdict[];
  /** Programmes the Mod's journal still shows in flight (`readInFlightProgrammes`). */
  programmesInFlight: number;
  /** Whether `takeStallFact` has something to say now. */
  due: boolean;
  /**
   * Standing verdicts this reading will NOT announce, each with its reason: `not_measured`, never silence.
   *
   * One cause: a verdict whose execution no programme is running (`verdict_without_programme_in_flight`) - the journal
   * says the work is over, so a verdict left behind it is a statement about nothing this Host can act on.
   */
  unmeasured: readonly Readonly<{ executionId?: string; reason: string }>[];
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

/** One standing verdict. Mutable in place: the pump owns it and nothing else holds a reference. */
type StandingStallVerdict = {
  executionId: string;
  actionId?: string;
  /** The identity of the Mod fact that stated it, so the same statement re-admitted is not a second episode. */
  verdictId: string;
  reason: string;
  waitedMs: number;
  published: boolean;
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
  public constructor(readInFlight: () => InFlightProgrammeReading = readInFlightProgrammes) {
    this.#readInFlight = readInFlight;
  }

  /** The snapshot slot the next batch TAKES: consumed by `takeBatch`, so a batch carries a snapshot once. */
  #snapshot: WorldFact | undefined;
  /**
   * Whether the reading in that slot says what the reading the pump already held said.
   *
   * <p>
   * The ONE comparison admission already makes to decide whether the world moved (see the `changes` branch of
   * `enqueueFact`), kept beside the slot rather than computed again at flush time: a second spelling of "the reading says
   * something else" is the disagreement this file exists to prevent. It travels with the slot - cleared by `takeBatch`
   * with it - because it is a property of the reading being held, not of the session.
   * </p>
   * <p>
   * What reads it is the suppressed-flush reason: `#notOwed` names a re-statement of the held reading
   * (`observation_restated`) apart from a reading that moved (`observation_moved`), which is the difference between "the
   * watcher asked again and the world had not spoken" and "the world spoke and a reading still opens no turn".
   * </p>
   */
  #snapshotRestatesPrevious = false;
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
  /**
   * The reading she was last TOLD ABOUT, as its own content (`readingContentIdentity`), so a re-statement cannot read as a
   * fresh observation.
   *
   * <p>
   * NOT the Mod's `revision`. That number is the Mod's action-echo counter: it moves inside action handlers
   * (`farmhandexecutioncontroller.cs:1779`, `:348`) and not when the world does - a time milestone is published as its own
   * fact carrying the UNCHANGED revision (`StardewSalientEventHooks.cs:196-207`). Measured (`round53`): a reading whose
   * clock walked `06:10` -> `11:30`, whose location changed to the town, whose stamina fell to 41 and whose weather turned
   * to rain arrived at the SAME revision as the one she had been shown and was suppressed as a re-statement - 320 game
   * minutes dropped because no action had run. In the other direction (`round46b`) a byte-identical payload carrying a
   * bumped revision opened a turn to say what the previous turn had said.
   * </p>
   *
   * <p>
   * The suppressor's question is "does this reading tell her something the delivered one did not", so it is asked of the
   * reading's own content - the same fields the block renders - and `revision` is left to the purposes that need a counter
   * (ordering two readings of one world, naming a reading in a fact).
   * </p>
   */
  #lastSnapshotDeliveredIdentity: string | undefined;
  /** `#deliveredBatches` when that content was composed into a batch; the difference is the age `<world-state>` states. */
  #lastSnapshotDeliveredBatch = 0;
  /**
   * When the CURRENT reading's content was first admitted, for the `ageMs` half of `world_state_stale`.
   *
   * Advanced only by a reading that says something else, because a re-stated copy of one reading arrives as a `snapshot`
   * fact too (`host-service.ts#restateWorldSnapshot`) and the Mod's revision cannot tell the two apart - it is minted per
   * frame and bumped by its own action receipts, so a counter-keyed clock would report a fifty-turn-old picture as fresh.
   */
  #lastSnapshotArrivedAtMs = 0;
  /** Stale facts already published for the current reading; the re-arm, and the fact's own `staleFactsSoFar`. */
  #worldStateStalePublished = 0;
  /**
   * Where a stale reading is acted on. Absent means this pump cannot refresh - see `worldStateRefresh.attached`.
   *
   * Attached once by the composition that owns the integration (`continuity-semantic-game-runtime-materializer.ts`), and
   * NOT reset by `clear()`: it is wiring, not one session's measurement.
   */
  #worldStateRefreshPort: WorldStateRefreshPort | undefined;
  /**
   * The crossed READING whose probes have been spent, whether its refusal has already been said, and how far the world had
   * said it moved when the last ask was made.
   *
   * The reading's own CONTENT (`readingContentIdentity`) is one of the two re-arm keys, not the turn and not the Mod's
   * revision: a probe can only be answered by a reading that says something else, so a second probe under the same content
   * asks the question the first one asked. Keyed on the revision instead, a re-observation that only bumped the counter
   * re-armed the budget and a frozen world became a spin; keyed on content, `WORLD_STATE_REFRESH_ATTEMPTS` is spent by the
   * reading and only a reading that actually moved earns a new one. `revision` is kept beside the key because the refusal
   * fact names the reading it could not replace in the Mod's own numbering.
   *
   * CONTENT ALONE WAS THE DEADLOCK (`round61`, `AUTO_OBSERVE_REARM`): it is produced by the ask this budget gates, so a
   * snapshot channel that stopped publishing while the clock kept advancing was a budget that could never come back.
   * `worldChanges` is the second key - `#worldChangesSinceReading` as of the last ask - so a world statement made after the
   * budget was spent earns the next ask once, and the same statement cannot earn a second one.
   */
  #worldStateRefreshFor:
    | { identity: string; revision: number; probes: number; refusalPublished: boolean; worldChanges: number }
    | undefined;
  #worldStateRefreshProbes = 0;
  #worldStateRefreshRefusals = 0;
  /**
   * Turns composed from an aged reading, and how many of those the world answered (see `AutoObserveAccount`).
   *
   * `#autoObserveAgedTurns` is the population: `#autoObserveRefreshed + every #autoObserveUnavailable member` is its
   * partition, so a turn counted as aged and then neither asked about nor declined is an arithmetic break rather than a
   * quiet omission.
   */
  #autoObserveAgedTurns = 0;
  #autoObserveRefreshed = 0;
  #autoObserveLastAgeTurns: number | undefined;
  /** Crossings the world could not be asked about, one count per `AUTO_OBSERVE_UNAVAILABLE_REASONS` member. */
  readonly #autoObserveUnavailable: Record<AutoObserveUnavailableReason, number> = {
    [AUTO_OBSERVE_UNAVAILABLE.noBridge]: 0,
    [AUTO_OBSERVE_UNAVAILABLE.attemptsSpent]: 0,
    [AUTO_OBSERVE_UNAVAILABLE.refused]: 0,
  };
  /** Spent budgets the world earned back, one count per `AUTO_OBSERVE_REARM` member. */
  readonly #autoObserveRearmed: Record<AutoObserveRearmReason, number> = {
    [AUTO_OBSERVE_REARM.readingMoved]: 0,
    [AUTO_OBSERVE_REARM.worldMoved]: 0,
  };
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
  /**
   * What each execution's provenance said, so "a receipt nobody could attribute" is a READING rather than an absence.
   *
   * <p>
   * One count per fact that stated a provenance, and the names of the executions the Mod's journal could not attribute.
   * `unattributed` is a defect the Mod names (`unattributed_execution:<id>`, `OpenBodyProgramJournalAuthority`'s
   * `AttributeExecution`), and a pump that filed such a fact and said nothing would be the same silence that let the
   * missing field last three rounds.
   * </p>
   * <p>
   * BOUNDED, WITH A DRAIN: the names stop at `MAX_NAMED_UNATTRIBUTED_EXECUTIONS` and the remainder is counted in
   * `omittedUnattributed`, so the total is always exact and the list never grows with the session. A session that keeps
   * producing unattributed executions is naming a defect, not traffic to keep.
   * </p>
   */
  readonly #executionProvenance = {
    programme: 0,
    standalone: 0,
    unattributed: 0,
    unstated: 0,
    unattributedExecutions: [] as string[],
    omittedUnattributed: 0,
  };
  /** Turns this pump opened, one count per `TURN_OPENINGS` member. */
  readonly #openedByReason: Record<TurnOpening, number> = {
    [TURN_OPENING.playerInput]: 0,
    [TURN_OPENING.worldFact]: 0,
    [TURN_OPENING.due]: 0,
  };
  #openedTurns = 0;
  /**
   * Batches this pump COMPOSED, counted at `takeBatch`.
   *
   * The field `examined` was `opened + suppressed`, i.e. the sum of its own terms, so it could never disagree with
   * itself while a call that owed no turn was counted as an examined flush. It is counted here instead, at the one place
   * a batch exists, and `event-pump.flushed-then-discarded.test.ts` asserts `examined === opened` over every
   * `NOT_OWED_REASONS` member.
   */
  #examinedFlushes = 0;
  /**
   * Facts admitted whose shape is a BODY TRACE rather than an event, one count per `TRACE_KINDS` member (`factTraceKind`).
   *
   * <p>
   * The distinction the flood needed: `round64` produced 401 "facts", of which 260 were `tile_advanced` and its second
   * spelling `route_progress` - her body moving one tile, stated twice. A trace is not news and never opens a turn, so it
   * is counted as a trace the moment it is admitted, and the gate asserts that every member of this population classifies
   * as progress (`event-pump.flushed-then-discarded.test.ts`). What this counter must never do is grow with something that
   * was a decision.
   * </p>
   * <p>
   * COUNTED BY KIND, because a total alone was a number nobody could act on: `round65` printed `traces 69` in ten minutes
   * and, with `tile_advanced 0`, could not say what the 69 were - so the one question a run's log should answer (which
   * trace is the Mod still producing) needed the Mod's source. The population is `TRACE_KINDS`, declared zeros included,
   * so a member that stopped is as visible as one that fired.
   * </p>
   */
  readonly #tracesByKind: Record<string, number> = initializedTraceKinds();
  /** Flush calls that owed no turn, one count per `NOT_OWED_REASONS` member - DERIVED, so a reason added to that
   * list is counted here without a second table to extend. */
  readonly #notOwedByReason: Record<NotOwedReason, number> = initializedByReason(NOT_OWED_REASONS);
  /** The nested half of both histograms above: which `FACT_PRODUCER` entrance the deciding fact came in through. */
  readonly #openedByProducer = initializedByProducer(TURN_OPENINGS);
  readonly #notOwedByProducer = initializedByProducer(NOT_OWED_REASONS);
  /** The shapes behind `NOT_OWED.noSurface`, in the pump's own spelling (`factTurnShape`); emptied by `clear()`. */
  readonly #noSurfaceByShape: Record<string, number> = {};
  /**
   * Which producer put each WAITING fact here, by slot key.
   *
   * Beside the windows rather than on the fact: a fact is delivered to the model verbatim (`takeBatch` -> `batch.facts`),
   * so a field added for the Host's own counting would travel into the prompt as a label about the Host's plumbing. The
   * record's population is the windows', not the run's - `#pruneProducedBy` drains it with them.
   */
  readonly #producedBy = new Map<string, FactProducer>();
  /**
   * The facts that arrived while no turn was owed, by window slot key, waiting for the batch that carries them.
   *
   * <p>
   * THIS IS THE PROOF THAT NOTHING VANISHED. A `not_owed` answer and "the fact has nowhere to go" used to be one value
   * (`#owesTurn` is a boolean, and a boolean has no third answer), so the 126 progress calls of `round64` dropped their
   * facts silently. Here a fact that opened no turn is named, and `takeBatch` moves it to `#carriedFacts` when the batch
   * that consumed it is composed - so `carried` is how many of those facts arrived, and `pending` is how many have not.
   * </p>
   */
  readonly #carryPending = new Set<string>();
  /** The same facts, by ticket, with the batch that carried them - what `carriedInto` answers. */
  readonly #carryTickets = new Map<string, { facts: readonly string[]; carriedInto: string | undefined }>();
  #carriedFacts = 0;
  /** Bubbles a delivered turn committed to the player, and the text no projection ever saw, by reason. */
  #deliveryBubbles = 0;
  readonly #deliveryLost: Record<string, number> = {};
  /** Which producer put the reading in the snapshot slot. The one slot whose key is not a fact slot. */
  #snapshotProducedBy: FactProducer | undefined;
  #lastTurnDecision: TurnDecision | undefined;
  /**
   * Turns that spoke, ran no action and closed, one count per `<opener>:<reason>` shape.
   *
   * Its population is `emptyTurnShapes()`, so the counter and the line a run prints cannot disagree about which shapes
   * exist - a shape nobody has taken is still a declared zero rather than an absent key.
   */
  readonly #emptyTurnsByShape: Record<TurnWithoutActionShape, number> = initializedEmptyTurns();
  #emptyTurns = 0;
  /**
   * Turns that produced work and delivered no speech, one count per opener, beside `#emptyTurns`.
   *
   * The two counters answer one question between them - did a delivered turn spend itself on speech, or on work it did not
   * narrate? - and they are counted in the same place, from the same settlement, so they cannot disagree about which turns
   * existed.
   */
  readonly #silentSettledByOpener: Record<SilentSettledOpening, number> = initializedSilentSettled();
  #silentSettledTurns = 0;
  /**
   * Settled turns that closed with one of her own executions still running.
   *
   * Taken from `hasExecutionInFlight` at the same settlement, and published rather than used to decide anything: the turn
   * was silent or it was not, and this says whether its work was still running when it said so.
   */
  #settledWithExecutionInFlight = 0;
  /**
   * Assistant turns Pi wrote, one count per production member - the population is `TURN_PRODUCTIONS`.
   *
   * Counted where the record is (`noteAssistantTurn`, from the loop's `message_end`), not at settlement: a batch's own
   * settlement sees one aggregate per delivery and cannot see that one of the two assistant turns inside it said nothing,
   * which is exactly the reading `round60`'s 36 silent turns had nowhere to land in.
   */
  readonly #assistantTurnsByProduction: Record<TurnProduction, number> = initializedByReason(TURN_PRODUCTIONS);
  /**
   * The standing stall verdicts, one per execution: the Mod's own statement that a body is waiting.
   *
   * <p>
   * A record of its own rather than a reading of `#receipts`, because `takeBatch` empties that window on every delivery -
   * so the receipt window can answer "what did the Mod just say" only until the next turn, while a verdict outlives the
   * turn it was announced in. It is bounded by the executions in flight and its drain is the same receipt that ends them.
   * </p>
   */
  readonly #stallVerdicts = new Map<string, StandingStallVerdict>();
  /**
   * The programme's own state, asked only where the answer decides something (`executionLiveness`, `takeStallFact`).
   *
   * A port with the real journal ledger as its default, not a field the composition fills in: the question is asked of the
   * one ledger every status call already writes, and a test that had to stand up a bridge to answer it would not be the
   * same question.
   */
  readonly #readInFlight: () => InFlightProgrammeReading;
  #stallFacts = 0;
  /** Stall facts by the Mod's own reason (`entity_block`, ...): the account's `stalled N {reason: count}`. */
  readonly #stallReasons: Record<string, number> = {};
  /**
   * The exact batch a rejected delivery owned, WITH the reason it asked for its turn.
   *
   * One field rather than two, because a retry that lost its opening reason would be a batch the gate could neither open
   * a turn for nor name a suppression for: the two facts are one decision and are stored as one.
   */
  #retry: Readonly<{ batch: PendingBatch; opening: FlushDecision<TurnOpening> }> | undefined;
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

  /**
   * Admit one fact, naming the entrance it came in through.
   *
   * <p>
   * `producedBy` is REQUIRED, and that is the whole point: a new ingress cannot appear without saying who it is, because
   * a call that omits it does not compile. It is not part of the fact - a fact is delivered to the model verbatim - so the
   * pump keeps it beside the window entry, and the account prints it under the reason the fact decided.
   * </p>
   */
  public enqueueFact(fact: WorldFact, producedBy: FactProducer): void {
    if (typeof fact.source !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(fact.source))
      throw new Error("invalid_world_fact_source");
    if (fact.source === "host_local_transport" && (fact.kind !== "lifecycle" || fact.revision !== 0))
      throw new Error("invalid_local_transport_fact");
    const frozen = Object.freeze({ ...fact });
    this.#observeWorldTransition(frozen);
    this.#observeExecutionLiveness(frozen);
    this.#observeExecutionProvenance(frozen);
    // A BODY TRACE IS COUNTED AS ONE, not as a fact that arrived: `tile_advanced` and `route_progress` are the same step
    // stated twice and neither can open a turn, so they are named here rather than in the population a delivery is measured
    // against. The watch bookkeeping above still sees them - a moving body is how the stall watch knows she is NOT stalled
    // - which is exactly why a trace can be counted and still not be a fact. Counted by KIND, so the account says which
    // trace the Mod is producing rather than how many of them there were.
    const trace = factTraceKind(frozen);
    if (trace !== undefined) this.#tracesByKind[trace] = (this.#tracesByKind[trace] ?? 0) + 1;
    if (fact.kind === "snapshot") {
      const previous = this.#lastSnapshot;
      // An OLDER reading describes an older world (`takeBatch` applies the same rule to a batch that is too large), so
      // neither slot takes it. One guard for both slots, because two guards left the pending slot able to hold a reading
      // the block would never render.
      if (previous !== undefined && fact.revision < previous.revision) return;
      // The world MOVED only if the reading says something else: the Mod's revision also moves when the Mod publishes a
      // receipt of its own action (`farmhandexecutioncontroller.cs`), and a counter that counts her actions cannot witness
      // a world that stood still. Keyed on content, a re-stated reading keeps its age and keeps the `world_state_stale`
      // evidence beside it (`#worldChangesSinceReading`) instead of resetting both without an observation.
      const changes = previous === undefined || readingContentIdentity(fact) !== readingContentIdentity(previous);
      this.#snapshot = frozen;
      this.#lastSnapshot = frozen;
      this.#snapshotRestatesPrevious = !changes;
      this.#snapshotProducedBy = producedBy;
      if (changes) {
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
        // A fact the bound refused is not waiting for anything, so its carry ticket must not outlive it.
        this.#carryPending.delete(key);
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
      // The producer leaves with the fact it was recorded for, or the record grows with the session instead of with the
      // windows it describes.
      this.#producedBy.delete(evictedKey);
      this.#carryPending.delete(evictedKey);
      this.#droppedFacts += 1;
    }
    const previous = destination.get(key);
    if (previous === undefined || fact.revision >= previous.revision) {
      destination.set(key, frozen);
      this.#producedBy.set(key, producedBy);
    }
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

  /**
   * Forget the producers of facts no window holds any more.
   *
   * The record's population is the four windows' (plus the snapshot slot, which is emptied with them), so it is BOUNDED by
   * the same numbers that bound the pump - and a fact a bound evicted already had its entry deleted at the eviction. This
   * runs after `takeBatch` has put back what the byte bound pushed out, which is why it can be a plain sweep rather than a
   * before/after copy.
   */
  #pruneProducedBy(): void {
    for (const key of [...this.#producedBy.keys()]) {
      if (this.#receipts.has(key) || this.#semanticEvents.has(key)) continue;
      if (this.#lifecycle.has(key) || this.#worldFacts.has(key)) continue;
      this.#producedBy.delete(key);
    }
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
    this.#snapshotRestatesPrevious = false;
    this.#snapshotProducedBy = undefined;
    this.#lastSnapshot = undefined;
    this.#lastSnapshotDeliveredIdentity = undefined;
    this.#lastSnapshotDeliveredBatch = 0;
    this.#lastSnapshotArrivedAtMs = 0;
    this.#worldStateStalePublished = 0;
    // The probe bookkeeping is one session's measurement too; the attached PORT is not - it is how this pump reaches the
    // integration at all, and a clear() is a STOP rather than a re-wiring.
    this.#worldStateRefreshFor = undefined;
    this.#worldStateRefreshProbes = 0;
    this.#worldStateRefreshRefusals = 0;
    this.#autoObserveAgedTurns = 0;
    this.#autoObserveRefreshed = 0;
    this.#autoObserveLastAgeTurns = undefined;
    for (const reason of AUTO_OBSERVE_UNAVAILABLE_REASONS) this.#autoObserveUnavailable[reason] = 0;
    for (const reason of AUTO_OBSERVE_REARM_REASONS) this.#autoObserveRearmed[reason] = 0;
    this.#worldChangesSinceReading = 0;
    this.#lastWorldChange = undefined;
    this.#receipts.clear();
    this.#semanticEvents.clear();
    this.#lifecycle.clear();
    this.#worldFacts.clear();
    this.#producedBy.clear();
    this.#inputs.length = 0;
    this.#deliveredProgress.clear();
    this.#stallVerdicts.clear();
    this.#worldTransition = null;
    this.#retry = undefined;
    this.#turnsWithoutWork = 0;
    this.#lastWorkTurnAtMs = Date.now();
    this.#narrationWithoutWorkPublished = 0;
    // The turn account and the delivered-content memory are this session's own measurements: a cleared pump belongs to
    // no run, and carrying either across it would let one session's turns answer for another's.
    this.#deliveredFactIdentities.clear();
    this.#openedTurns = 0;
    this.#examinedFlushes = 0;
    for (const kind of TRACE_KINDS) this.#tracesByKind[kind] = 0;
    this.#stallFacts = 0;
    for (const reason of Object.keys(this.#stallReasons)) delete this.#stallReasons[reason];
    this.#carryPending.clear();
    this.#carryTickets.clear();
    this.#carriedFacts = 0;
    this.#deliveryBubbles = 0;
    for (const reason of Object.keys(this.#deliveryLost)) delete this.#deliveryLost[reason];
    for (const reason of TURN_OPENINGS) this.#openedByReason[reason] = 0;
    for (const reason of NOT_OWED_REASONS) this.#notOwedByReason[reason] = 0;
    for (const shape of Object.keys(this.#noSurfaceByShape)) delete this.#noSurfaceByShape[shape];
    for (const reason of TURN_OPENINGS)
      for (const producer of FACT_PRODUCERS) this.#openedByProducer[reason][producer] = 0;
    for (const reason of NOT_OWED_REASONS)
      for (const producer of FACT_PRODUCERS) this.#notOwedByProducer[reason][producer] = 0;
    for (const shape of emptyTurnShapes()) this.#emptyTurnsByShape[shape] = 0;
    this.#emptyTurns = 0;
    for (const opener of SILENT_SETTLED_OPENINGS) this.#silentSettledByOpener[opener] = 0;
    this.#silentSettledTurns = 0;
    this.#settledWithExecutionInFlight = 0;
    for (const production of TURN_PRODUCTIONS) this.#assistantTurnsByProduction[production] = 0;
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
    return Object.freeze({
      opened: this.#openedTurns,
      byReason: Object.freeze({ ...this.#openedByReason }),
      openedByProducer: freezeProducerHistograms(this.#openedByProducer, TURN_OPENINGS),
      notOwed: Object.freeze({ ...this.#notOwedByReason }),
      notOwedByProducer: freezeProducerHistograms(this.#notOwedByProducer, NOT_OWED_REASONS),
      noSurface: Object.freeze({ ...this.#noSurfaceByShape }),
      // COUNTED WHERE THE BATCH IS COMPOSED (`takeBatch`), not derived from the two histograms beside it: a count that is
      // the sum of its own terms cannot witness a batch that was assembled and then discarded, which is the defect this
      // number exists to make impossible.
      examined: this.#examinedFlushes,
      carry: Object.freeze({ carried: this.#carriedFacts, pending: this.#carryPending.size }),
      traces: Object.freeze({ ...this.#tracesByKind }),
      stalled: Object.freeze({ total: this.#stallFacts, byReason: Object.freeze({ ...this.#stallReasons }) }),
      delivery: Object.freeze({
        bubbles: this.#deliveryBubbles,
        lost: Object.freeze({ ...this.#deliveryLost }),
        lostTotal: Object.values(this.#deliveryLost).reduce((total, count) => total + count, 0),
      }),
      assistantTurns: Object.freeze({
        examined: TURN_PRODUCTIONS.reduce(
          (total, production) => total + this.#assistantTurnsByProduction[production],
          0,
        ),
        byProduction: Object.freeze({ ...this.#assistantTurnsByProduction }),
      }),
      emptyTurns: Object.freeze({ total: this.#emptyTurns, byShape: Object.freeze({ ...this.#emptyTurnsByShape }) }),
      silentSettled: Object.freeze({
        total: this.#silentSettledTurns,
        byOpener: Object.freeze({ ...this.#silentSettledByOpener }),
      }),
      settledWithExecutionInFlight: this.#settledWithExecutionInFlight,
      executionProvenance: Object.freeze({
        facts: Object.freeze({
          programme: this.#executionProvenance.programme,
          standalone: this.#executionProvenance.standalone,
          unattributed: this.#executionProvenance.unattributed,
          unstated: this.#executionProvenance.unstated,
        }),
        unattributedExecutions: Object.freeze([...this.#executionProvenance.unattributedExecutions]),
        omittedUnattributed: this.#executionProvenance.omittedUnattributed,
      }),
      autoObserve: Object.freeze({
        agedTurns: this.#autoObserveAgedTurns,
        refreshed: this.#autoObserveRefreshed,
        lastAgeTurns: this.#autoObserveLastAgeTurns,
        unavailable: Object.freeze({ ...this.#autoObserveUnavailable }),
        rearmed: Object.freeze({ ...this.#autoObserveRearmed }),
      }),
      lastDecision: this.#lastTurnDecision,
    });
  }

  /**
   * What the most recently DELIVERED turn did, as the layer that saw Pi's event stream measured it.
   *
   * <p>
   * Set by `CompanionLoop` after each delivery, because that is the only layer that sees Pi's stream. The four states are
   * the whole population, and they are separate because the pump acts differently on each: `worked` and `workedSilently`
   * clear the narration run, `spoke` extends it, the two silent members end it and are the ones `turn_settled_silent`
   * counts. A boolean could not say `silent`, and reading a turn that carried nothing as narration would blame her for a
   * provider that answered with nothing - which `provider_empty_completion` already names on its own path.
   * </p>
   */
  public turnProduction: TurnProduction = TURN_PRODUCTION.saidNothing;

  /**
   * Record ONE assistant turn: one assistant record Pi wrote, inside whatever batch it landed in.
   *
   * <p>
   * This is the hook the loop did not have. `turnProduction` is published once per DELIVERED BATCH, so a batch that
   * carried a line and then worked silently is `worked` and its silence is invisible (`round60`: 36 such records, every
   * counter `0`). A message is a turn in Pi's own record, so it is classified here as it arrives, in the same member
   * vocabulary, with the same `turnProductionOf`.
   * </p>
   * <p>
   * The two facts are the record's own content, not the turn's: a message either carried text or asked for a tool. A
   * message that carries neither is `said_nothing` - a provider that answered with nothing, or a message whose tool call
   * never ran - and it is counted rather than dropped, because a population with a silently missing member is not a
   * population.
   * </p>
   */
  public noteAssistantTurn(facts: Readonly<{ hasText: boolean; hasToolCall: boolean }>): void {
    this.#assistantTurnsByProduction[turnProductionOf(facts.hasToolCall, facts.hasText)] += 1;
  }

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
   * Whether her work is alive right now, said by the two authorities that can say it.
   *
   * <p>
   * THE SPLIT THIS IMPLEMENTS: the pump measures NOTHING about time. `programmesInFlight` is the programme's own state
   * (`readInFlightProgrammes`) - a running programme is not stalled - and `verdicts` is the Mod's own statement that the
   * body of that work is waiting, with the reason and the wait beside it. Reading this enqueues, mints and delivers
   * nothing; `takeStallFact` announces one verdict, and starting the turn stays where every other turn start lives.
   * </p>
   * <p>
   * A verdict with no programme in flight is reported in `unmeasured` rather than omitted: the journal says that work is
   * over, so a stall would be news about something that is not running - the one answer this reading must never invent
   * either way.
   * </p>
   */
  public get executionLiveness(): ExecutionLivenessReading {
    const programmesInFlight = this.#readInFlight().programmes.length;
    const verdicts: ModStallVerdict[] = [];
    const unmeasured: Array<Readonly<{ executionId?: string; reason: string }>> = [];
    for (const verdict of this.#stallVerdicts.values()) {
      verdicts.push(
        Object.freeze({
          executionId: verdict.executionId,
          ...(verdict.actionId === undefined ? {} : { actionId: verdict.actionId }),
          reason: verdict.reason,
          waitedMs: verdict.waitedMs,
          published: verdict.published,
        }),
      );
      if (programmesInFlight === 0)
        unmeasured.push(
          Object.freeze({ executionId: verdict.executionId, reason: "verdict_without_programme_in_flight" }),
        );
    }
    return Object.freeze({
      verdicts: Object.freeze(verdicts),
      programmesInFlight,
      due: programmesInFlight > 0 && verdicts.some((verdict) => !verdict.published),
      unmeasured: Object.freeze(unmeasured),
    });
  }

  /**
   * The fact that says the Mod is waiting for something, or `undefined` when no authority says so.
   *
   * <p>
   * ONE FACT PER VERDICT, EVER. `published` is the whole re-arm: a verdict the body controller states once is announced
   * once, where the retired wall-clock threshold re-armed itself and announced the same silence again every four bounds.
   * The pump announces it only while the programme's own state still shows its work in flight - the other authority's
   * half of the question - so a verdict left behind a finished programme is named in `unmeasured` instead.
   * </p>
   * <p>
   * No prose: the pump holds no presentation locale (the notice ledger reads one from the snapshot), and these keys say
   * the same thing in any language - which execution, WHY the body is waiting, how long the Mod says it has waited, and
   * what would release it.
   * </p>
   */
  public takeStallFact(): WorldFact | undefined {
    const reading = this.executionLiveness;
    if (!reading.due) return undefined;
    const announced = reading.verdicts.find((verdict) => !verdict.published);
    if (announced === undefined) return undefined;
    const standing = this.#stallVerdicts.get(announced.executionId);
    if (standing === undefined) return undefined;
    standing.published = true;
    this.#stallFacts += 1;
    this.#stallReasons[announced.reason] = (this.#stallReasons[announced.reason] ?? 0) + 1;
    const nowMs = Date.now();
    // The Mod's own statement is the identity, so a second episode of the same execution is a second fact and the same
    // episode re-admitted is the same one.
    const eventId = `${EXECUTION_STALL_SEMANTIC_KIND}_${announced.executionId}_${standing.verdictId}`;
    return Object.freeze({
      source: HOST_MINTED_FACT_SOURCE,
      kind: "world_fact" as const,
      eventId,
      sourceEventId: eventId,
      correlationId: announced.executionId,
      revision: 1,
      occurredAtMs: nowMs,
      executionId: announced.executionId,
      semanticKind: EXECUTION_STALL_SEMANTIC_KIND,
      payload: Object.freeze({
        kind: EXECUTION_STALL_SEMANTIC_KIND,
        executionId: announced.executionId,
        actionId: announced.actionId ?? null,
        reason: announced.reason,
        waitedMs: announced.waitedMs,
        programmesInFlight: reading.programmesInFlight,
        owner: this.#worldTransition?.code ?? null,
        endsOwnershipWith: this.#stallEndsOwnershipWith() ?? null,
        // A null owner on its own reads as "nobody holds the body". What this fact actually knows when it is null is
        // narrower: no body-owning transition is in progress, so nothing beyond this execution's own terminal receipt
        // would release it. Naming that is the difference between "nobody holds it" and "this fact cannot say who does".
        ...(this.#worldTransition === null
          ? { ownershipAbsentReason: "no_body_owning_transition_in_progress" as const }
          : {}),
      }),
    });
  }

  /**
   * Count what one admitted fact said about the programme its execution belongs to.
   *
   * <p>
   * Counted HERE and not where the filing happens, because the filing asks the same question more than once per flush
   * (`#opening` skims the window, `#notOwed` explains it) and a fact is admitted once. The population is
   * "facts that state an execution's provenance", which is every `execution_receipt` and every body trace - the two
   * spellings of one step.
   * </p>
   */
  #observeExecutionProvenance(fact: WorldFact): void {
    const statesAnExecution =
      fact.kind === "execution_receipt" || (fact.kind === "semantic_event" && fact.payload.bodyTrace !== undefined);
    if (!statesAnExecution) return;
    const origin = factExecutionOrigin(fact);
    if (origin === undefined) {
      this.#executionProvenance.unstated += 1;
      return;
    }
    this.#executionProvenance[origin.kind] += 1;
    if (origin.kind !== "unattributed") return;
    const executionId = fact.executionId;
    if (executionId === undefined || executionId.length === 0) return;
    if (this.#executionProvenance.unattributedExecutions.includes(executionId)) return;
    if (this.#executionProvenance.unattributedExecutions.length >= MAX_NAMED_UNATTRIBUTED_EXECUTIONS) {
      this.#executionProvenance.omittedUnattributed += 1;
      return;
    }
    this.#executionProvenance.unattributedExecutions.push(executionId);
  }

  /**
   * Record the Mod's standing verdict for the execution this fact is about, and drop it when that execution ends.
   *
   * <p>
   * NO CLOCK IS READ HERE. The record this replaces wrote "a fact arrived at T" for every fact that named an execution,
   * which is what made an arrival look like liveness; this records only what the Mod SAID. A later verdict replaces the
   * one standing before it (the body controller re-states its wait as the wait grows), an identical re-admission is not a
   * new episode (`verdictId`), and a terminal receipt drains the entry - so the record is bounded by the executions in
   * flight and its drain is the same receipt that ends them.
   * </p>
   */
  #observeExecutionLiveness(fact: WorldFact): void {
    const executionId = fact.executionId;
    if (executionId === undefined || executionId.length === 0) return;
    if (isTerminalExecutionFact(fact)) {
      this.#stallVerdicts.delete(executionId);
      return;
    }
    const verdictId = fact.eventId ?? fact.sourceEventId ?? `${fact.correlationId}:${String(fact.revision)}`;
    const existing = this.#stallVerdicts.get(executionId);
    if (existing?.verdictId === verdictId) return;
    const verdict = modStallVerdictOf(fact);
    if (verdict === undefined) return;
    this.#stallVerdicts.set(executionId, { executionId, verdictId, published: false, ...verdict });
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

  /**
   * Answer one flush call: open the turn it owes, or name why no turn is owed - never `undefined`.
   *
   * <p>
   * THE DECISION COMES BEFORE THE BATCH, and that order is the invariant: `takeBatch` is reached only on the `opened`
   * branch, so a call that owes no turn composes nothing to throw away. `round64` measured the other shape - `flushes
   * examined 134 · turns opened 8 · suppressed 126 {in_flight_progress 125}` - because every admission of a programme step
   * called this method and the method then decided the step owed no turn.
   * </p>
   * <p>
   * THE CURE STILL RUNS ON EVERY CALL. An aged reading is not a turn and costs no batch: it is one pipe round-trip that
   * replaces the reading a later turn will state (`#beginAgedReadingAsk`), so a call that owes no turn still refreshes the
   * world rather than returning the reading it was handed. What a `not_owed` call must never do is assemble a batch.
   * </p>
   */
  public async flush(sink: CompanionTurnSink): Promise<FlushOutcome> {
    // HELD, NOT DROPPED. A companion whose body is inside a transition does not get woken to read the runtime's
    // bookkeeping; the facts wait for the transition to end and arrive together with the fact that ended it. A hold is
    // not a decision this gate owns, so it is neither examined nor named - and the previous decision is cleared so a
    // caller cannot read a hold as the answer to this flush.
    if (this.isWorldTransition) {
      this.#lastTurnDecision = undefined;
      return Object.freeze({ kind: "held" as const, reason: "world_transition" as const });
    }
    // A delivery already in flight is the same turn, not another one.
    if (this.#delivering) {
      this.#lastTurnDecision = undefined;
      return Object.freeze({ kind: "held" as const, reason: "delivery_in_flight" as const });
    }
    const retry = this.#retry;
    this.#delivering = true;
    const generation = this.#generation;
    // THE CURE RUNS BEFORE THE DIAGNOSIS, AND THE DIAGNOSIS IS TAKEN ON THE ANSWER. A flush holding a reading it did not
    // bring is the same condition that makes an empty turn `world_stale` (`#readingIsAged`), and it is where the reading
    // can still be replaced: ask the integration first, then decide on whatever the answer made current. Asked BEFORE the
    // batch is taken, because `takeBatch` consumes the snapshot slot - and asked before the DECISION, because a flush that
    // suppresses for that exact reason used to return without ever reaching the cure (`round53`: nine clock-only
    // suppressions, zero probes), while the answer the one probe did get re-entered the same predicate.
    //
    // A retry does not ask again: it must send the exact text the sink rejected, which was composed from the reading of
    // that moment, and asking for a new one would put a second, unreviewed composition behind one turn.
    let pending: PendingBatch | undefined;
    let opening: FlushDecision<TurnOpening> | undefined;
    try {
      const aged = retry === undefined ? this.#beginAgedReadingAsk() : undefined;
      if (aged !== undefined) {
        if ("declined" in aged) this.#autoObserveUnavailable[aged.declined] += 1;
        else {
          await aged.inFlight;
          // A clear() while the observation was in flight revokes this turn: the pump belongs to no run, and a turn
          // opened on the other side of a teardown is a delivery nobody asked for.
          if (this.#generation !== generation) {
            this.#lastTurnDecision = undefined;
            return Object.freeze({ kind: "held" as const, reason: "delivery_in_flight" as const });
          }
        }
      }
      opening = retry === undefined ? this.#opening() : retry.opening;
      if (opening === undefined) return this.#noteNotOwed(this.#notOwed());
      // FROM HERE A TURN IS OWED, and this is the only branch that composes a batch.
      pending = retry?.batch ?? this.takeBatch();
      this.#retry = undefined;
      this.#openedTurns += 1;
      this.#openedByReason[opening.decision] += 1;
      if (opening.producedBy !== undefined) this.#openedByProducer[opening.decision][opening.producedBy] += 1;
      this.#lastTurnDecision = Object.freeze({ kind: "opened", index: this.#openedTurns, reason: opening.decision });
      const outcome = (await sink.deliver(pending)) ?? "unobserved";
      this.#deliveredBatches += 1;
      this.#observeTurnProduction(outcome, opening.decision, pending.broughtObservation);
      return Object.freeze({
        kind: "opened" as const,
        batchId: pending.batchId,
        opener: opening.decision,
        turn: outcome,
      });
    } catch (error) {
      // Do not revive a batch cleared while its asynchronous delivery was in
      // flight. Facts admitted after clear belong to the current generation.
      if (pending !== undefined && opening !== undefined && this.#generation === generation)
        this.#retry = Object.freeze({ batch: pending, opening });
      throw error;
    } finally {
      this.#delivering = false;
    }
  }

  /**
   * Why this flush would open a turn, or `undefined` when everything waiting is something she already has.
   *
   * ONE place: `hasPendingDelivery`, `flush` and the account all ask this, so "is a turn owed" and "was one taken"
   * cannot disagree. The snapshot slot is deliberately not asked: a reading is standing state (`TURN_OPENING`), so the
   * flush that holds only a reading suppresses and names which reading it held (`NOT_OWED.observationRestated` /
   * `observationMoved`).
   */
  #opening(): FlushDecision<TurnOpening> | undefined {
    // A person's word is not a fact, so it has no producer: the opener's own count carries it, and every producer stays
    // at zero for this decision instead of one of them being credited with a turn it did not cause.
    //
    // ITS LEASE IS THE INGRESS'S, not this opener's: `HostService.acceptPlayerInput` refuses a `sourceEventId` that is not an
    // opaque token, so a player turn always has a surface. A fact has no such gate between the Mod and this window, which is
    // why the loop below asks.
    if (this.#inputs.length > 0) return Object.freeze({ decision: TURN_OPENING.playerInput, producedBy: undefined });
    for (const fact of this.#ordinaryFacts()) {
      if (!this.#opensTurn(fact)) continue;
      return Object.freeze({
        decision: isDueFact(fact) ? TURN_OPENING.due : TURN_OPENING.worldFact,
        producedBy: this.#producedBy.get(factSlotKey(fact)),
      });
    }
    return undefined;
  }

  /**
   * Whether this fact may OPEN a turn: it states something she must decide on, she has not already been told it, and the
   * player's surface can show her answer - or it is a wake the Host mints to make her LOOK (`TURN_OPENING.due`).
   *
   * <p>
   * THE WAKE IS THE ONE DECLARED EXCEPTION, and it is a liveness rule rather than a hole. A stale reading, a refused refresh,
   * a body that stalled and a run of narration are facts whose whole purpose is that the model looks again: what the turn has
   * to produce is the look, not a line, and a wake that waits for something else to present is a wake that never fires. They
   * are the `due` opener, their population is `PUMP_MINTED_WAKE_KINDS` (every member named with the path that publishes it),
   * and the account prints how many turns they opened - so the exception is measured rather than assumed. Making one of them
   * PRESENT would mean teaching the Game side a new salient identity, which is `integrations/**` and not this layer's to
   * mint (`host-service.ts:GameTurnLineageTracker` refuses an id the Game did not register).
   * </p>
   * <p>
   * `#owesTurn` AND THIS ARE TWO QUESTIONS, AND COLLAPSING THEM SILENTLY DELETES ONE. `#owesTurn` answers "the prompt
   * states it"; this answers "the model is woken for it". A terminal receipt OWES a turn and OPENS none, because
   * `presentationSourceOf` answers `undefined` for every `execution_receipt` - `protocol/bridge-v1.schema.json#receipt`
   * carries no event identity to present under. Filing such a receipt as `progress` would make `#owesTurn` false, and the
   * model-facing text is `promptFacts`, filtered on `#owesTurn` - so the only fact that says the node ran would leave the
   * prompt; the same filter composes a STEER's text, so a `rejected` receipt would steer a batch that states nothing.
   * </p>
   * <p>
   * WHAT A PLAN COSTS IN TURNS, MEASURED 2026-11-18 (the built pump, real facts, one flush per case):
   * 60 node receipts in one flush ⇒ <b>0 turns</b> (`not_owed {no_surface_for {receipt:succeeded: 60}}`); the same 60
   * flushed one per receipt ⇒ <b>0 turns</b>; 60 receipts plus the programme's settlement ⇒ <b>1 turn</b>; 60 receipts
   * plus a presentable milestone ⇒ <b>1 turn</b>. Adding a node buys no turn, and the settlement's turn states the nodes.
   * The wake for a plan is therefore ONE HOP, and it is the settlement - a presentable fact, so it opens its own turn. A
   * terminal receipt belonging to NO programme has no settlement: it waits for the next presentable fact (the Mod's five
   * clock marks a day, the day boundary, her arrival, a native notice, any player word), and the pump imposes no bound of
   * its own - `event-pump.node-batch-turns.test.ts` holds this reading red-able so it is not re-derived.
   * </p>
   */
  #opensTurn(fact: WorldFact): boolean {
    if (!this.#owesTurn(fact) || this.#isRestatement(fact)) return false;
    return isDueFact(fact) || this.#canPresent(fact);
  }

  /**
   * Whether this fact can reach the player's surface at all: one of the loop's lease kinds, carrying the opaque identity it
   * requires (`presentation-lease.ts#presentationSourceOf`).
   *
   * <p>
   * A DECISION FACT THAT CANNOT PRESENT STILL OWES HER THE NEWS, so it is not suppressed: `#owesTurn` keeps it, `takeBatch`
   * renders it into the next batch's model-facing text, and it is answered `NOT_OWED.noSurface` with a `CarryTicket` that
   * proves where it went. What it does not do is open a turn of its own, because a turn whose batch carries no presentation
   * source attaches no projection: she would decide, act and speak, and the player would see nothing
   * (`round66`: `lost 8 → 12 {no_presentation_lease}`, and every one of those batches carried exactly
   * `["execution_receipt","snapshot"]`).
   * </p>
   * <p>
   * WHAT BOUNDS THE HOLD, since nothing here hands a fact to a deadline:
   * </p>
   * <ul>
   *   <li>IT COALESCES RATHER THAN ACCUMULATES. The windows this reads are the pump's own - one slot per moving state and a
   *       cap per window - so a thousand arrivals hold at most a windowful, and the newest of each slot is the one that
   *       travels. The hold cannot grow with the session.</li>
   *   <li>EVERY PRESENTABLE FACT DRAINS IT, ALL OF IT. `takeBatch` empties every window on the next turn that opens, so a
   *       carried fact waits exactly as long as the next thing the player can see: the game's own HUD lines (`native_notice`
   *       rides the receipt it appeared in), the five clock marks a day (`time_milestone`, `AllowedMilestones`), the day's
   *       boundary and her own arrival, and every settlement - which is presentable by construction, because the digest
   *       carries an opaque `sourceEventId` of its own. In `round66` 15 of 21 windows already had one of those.</li>
   *   <li>IF NOTHING EVER PRESENTS, NOTHING NEW IS HAPPENING EITHER. The facts that would drain the hold are the game's own
   *       traffic; a world that produces none produces no reason to act, and the next player word opens a turn regardless
   *       (the branch above).</li>
   * </ul>
   */
  #canPresent(fact: WorldFact): boolean {
    return presentationSourceOf(fact) !== undefined;
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
   * Whether a reading says something other than the one she was shown: the ONE comparison the block's header and the
   * composition's cure are both derived from.
   *
   * <p>
   * `undefined` is not a "no": before the first delivery there is nothing to compare against, and the two callers want
   * different answers to that - a session's first picture is not a re-statement (attachment already carries it), while a
   * block that HAS never been shown is news by definition. Keeping the third answer here is what stops either caller from
   * inventing its own reading of "nothing delivered yet".
   * </p>
   */
  #readingIsNews(fact: WorldFact | undefined): boolean | undefined {
    if (fact === undefined) return undefined;
    const shown = this.#lastSnapshotDeliveredIdentity;
    if (shown === undefined) return undefined;
    return readingContentIdentity(fact) !== shown;
  }

  /**
   * Whether this fact is one STEP of a programme: the fact's OWN provenance says so (`factExecutionOrigin`).
   *
   * Asked of the shape first, so a flush holding an ordinary fact - a settlement, a milestone, a person's word - never
   * reads a provenance to decide whether it may open a turn.
   */
  #isInFlightProgress(fact: WorldFact): boolean {
    return factTurnConsequence(fact) === "in_flight_progress" && factExecutionOrigin(fact)?.kind === "programme";
  }

  /**
   * Whether this fact can open a turn: the classification's answer, with the fact's own provenance read where the step is.
   *
   * <p>
   * `decision` opens, `progress` never does, and `in_flight_progress` opens only when the fact does NOT state that a
   * programme owns the execution. What is NOT asked here is whether the fact is held latest-only: that is a property of
   * the pending WINDOW (one slot per moving state), and it coincided with "opens no turn" only because every `progress`
   * shape happened to be held. A settlement that succeeded is progress and is NOT held - it keeps its place in the window
   * and is delivered whole by the next turn - so the coincidence is gone and the classification has to be asked directly.
   * </p>
   * <p>
   * NOTHING HERE READS A CLOCK OR A LEDGER. `round62` filed such a receipt inside a ten-second window because the ledger
   * that named its programme had just been told the programme stopped, and the window was the fix for that: a duration
   * standing in for a fact. The provenance travels WITH the receipt (`protocol.ts#ExecutionOrigin`), so the same receipt
   * is filed the same way whether its programme is running, stopped a second ago, or never read at all.
   * </p>
   */
  #owesTurn(fact: WorldFact): boolean {
    const consequence = factTurnConsequence(fact);
    if (consequence === "decision") return true;
    if (consequence === "in_flight_progress") return factExecutionOrigin(fact)?.kind !== "programme";
    return false;
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
   * Which member a call that owed no turn was answered by absence of, AND the carry ticket that proves where its facts went.
   *
   * An ordinary fact that is waiting but NOT an opening one is a fact whose content she already received (`#opening`
   * skipped it for that reason). A step of a programme is its own reason (`in_flight_progress`):
   * the fact is not a re-statement - she has never seen it - and it still opens no turn, because the programme's
   * settlement is what she has to decide on. A snapshot slot holding a reading is a READING AND NOTHING ELSE, and which
   * of the two members it is depends on the reading alone: a copy of the one the pump already held is
   * `observation_restated` - the world's last statement, asked about again - and a reading that says something else is
   * `observation_moved`, which is standing state she has not been handed rather than a wake (`TURN_OPENING`).
   * `nothing_pending` is the rest.
   *
   * THE TICKET IS TAKEN HERE, at the moment the pump says "no turn is owed", and it names every waiting fact slot. Those
   * slots leave the ledger only when `takeBatch` consumes them, which is what makes `carriedInto` a measurement rather
   * than a promise. A reading is not ticketed: it is rendered into every batch by `#worldStateReading`, so it does not need
   * a slot of its own to arrive.
   */
  #notOwed(): Readonly<{
    reason: NotOwedReason;
    producedBy: FactProducer | undefined;
    shape: string | undefined;
    carry: CarryTicket;
  }> {
    const decision = this.#notOwedReason();
    return Object.freeze({
      reason: decision.decision,
      producedBy: decision.producedBy,
      shape: decision.shape,
      carry: this.#takeCarryTicket(),
    });
  }

  /** The reason half of `#notOwed`: the one question "why did nothing owe a turn", answered once per call. */
  #notOwedReason(): NotOwedCause {
    const facts = this.#ordinaryFacts();
    // THE SURFACE FIRST, because it is the one answer here that changed WHICH turn exists: a decision fact that cannot present
    // is not a fact she has already been told (the re-statement below) and not a step of a programme she dispatched (the two
    // reviews after it) - it is news the surface has nowhere to put, and `#opening` declined it for exactly that reason.
    for (const fact of facts) {
      if (this.#opensTurn(fact)) continue;
      if (!this.#owesTurn(fact) || this.#isRestatement(fact) || this.#canPresent(fact)) continue;
      return Object.freeze({
        decision: NOT_OWED.noSurface,
        producedBy: this.#producedBy.get(factSlotKey(fact)),
        shape: noSurfaceShape(fact),
      });
    }
    // The step first, because it is the answer `#opening` skipped the fact for (`#owesTurn`); the re-statement below is
    // the older reason and means the same flush was already told this once.
    for (const fact of facts) {
      if (!this.#isInFlightProgress(fact)) continue;
      return Object.freeze({
        decision: NOT_OWED.inFlightProgress,
        producedBy: this.#producedBy.get(factSlotKey(fact)),
      });
    }
    for (const fact of facts) {
      if (isHeldFact(fact) || !this.#isRestatement(fact)) continue;
      return Object.freeze({
        decision: NOT_OWED.worldFactRestated,
        producedBy: this.#producedBy.get(factSlotKey(fact)),
      });
    }
    // A fact the classification calls progress that she has NOT been shown: it keeps its place in the window and travels
    // in the next turn that opens for a decision. Naming it here is what keeps that turn's absence COUNTED - without this
    // loop a flush holding a successful settlement would be reported as `observation_restated`, because a reading is
    // re-stated before every flush, and a rerun could not tell how many turns this rule removed from a reading that had
    // nothing to do with it.
    for (const fact of facts) {
      if (factTurnConsequence(fact) !== "progress") continue;
      return Object.freeze({
        decision: NOT_OWED.progress,
        producedBy: this.#producedBy.get(factSlotKey(fact)),
      });
    }
    if (this.#snapshot !== undefined)
      return Object.freeze({
        decision: this.#snapshotRestatesPrevious ? NOT_OWED.observationRestated : NOT_OWED.observationMoved,
        producedBy: this.#snapshotProducedBy,
      });
    return Object.freeze({ decision: NOT_OWED.nothingPending, producedBy: undefined });
  }

  /**
   * Record a call that owed no turn, and hand the caller the ticket that proves its facts are still on their way.
   *
   * THE COUNTER IS NOT A FLUSH COUNTER: this is not an examined flush, because no batch was composed and none was
   * discarded. It is the population of calls that were answered "not yet", and the four segments beside it (`flushes
   * examined`, `turns opened`, `carried`, and this one) are read together.
   */
  #noteNotOwed(
    notOwed: Readonly<{
      reason: NotOwedReason;
      producedBy: FactProducer | undefined;
      shape: string | undefined;
      carry: CarryTicket;
    }>,
  ): FlushOutcome {
    this.#notOwedByReason[notOwed.reason] += 1;
    if (notOwed.producedBy !== undefined) this.#notOwedByProducer[notOwed.reason][notOwed.producedBy] += 1;
    if (notOwed.reason === NOT_OWED.noSurface && notOwed.shape !== undefined)
      this.#noSurfaceByShape[notOwed.shape] = (this.#noSurfaceByShape[notOwed.shape] ?? 0) + 1;
    this.#lastTurnDecision = Object.freeze({ kind: "not_owed", reason: notOwed.reason });
    return Object.freeze({ kind: "not_owed" as const, reason: notOwed.reason, carry: notOwed.carry });
  }

  /**
   * Name the facts that are waiting because no turn is owed, and return them as one ticket.
   *
   * The ledger is keyed by the SAME slot key `enqueueFact`, `#readmit` and the delivered-progress record use
   * (`factSlotKey`), so a fact cannot be ticketed under one identity and consumed under another. Bounded by the windows
   * themselves plus `MAX_CARRY_TICKETS`, and a ticket older than that is dropped with its facts still counted as pending
   * - a bound that forgets is visible, where a bound that lies is not.
   */
  #takeCarryTicket(): CarryTicket {
    for (const fact of this.#ordinaryFacts()) this.#carryPending.add(factSlotKey(fact));
    const facts = Object.freeze([...this.#carryPending]);
    const ticketId = `carry_${String(this.#carryTickets.size + 1)}`;
    this.#carryTickets.set(ticketId, { facts, carriedInto: undefined });
    for (const [oldest, held] of this.#carryTickets) {
      if (this.#carryTickets.size <= MAX_CARRY_TICKETS) break;
      if (held.carriedInto === undefined) continue;
      this.#carryTickets.delete(oldest);
    }
    return Object.freeze({ ticketId, facts });
  }

  /**
   * The batch that consumed the facts of one carry ticket, or `undefined` while they are still waiting.
   *
   * `undefined` is a STATE here, not a collapse: it says "not yet", and `turnAccount.carry.pending` counts the same
   * facts from the same ledger. A caller can therefore tell "it went into turn 4" from "nobody has carried it yet".
   */
  public carriedInto(ticket: CarryTicket): string | undefined {
    return this.#carryTickets.get(ticket.ticketId)?.carriedInto;
  }

  /**
   * Record what happened to the words a delivered turn produced: how many bubbles committed, and what was lost by reason.
   *
   * <p>
   * THE DELIVERY LAYER OWNS THIS READING (it is the only layer that sees a projection's own answers), and the pump owns
   * the ACCOUNT it has to appear in: a bubble that was delivered but never presented was counted on stderr per turn and
   * nowhere a run's account could be read, so `round64`'s batch 6 arrived and nobody was told. The reason vocabulary is the
   * delivery layer's - each key is a reason it actually reported - rather than a second list kept here that could drift
   * from the projection's own enum.
   * </p>
   */
  public noteDelivery(reading: Readonly<{ bubbles: number; lost: Readonly<Record<string, number>> }>): void {
    this.#deliveryBubbles += reading.bubbles;
    for (const [reason, count] of Object.entries(reading.lost))
      if (count > 0) this.#deliveryLost[reason] = (this.#deliveryLost[reason] ?? 0) + count;
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
   * Hand the STEERABLE facts to the RUNNING turn, without composing a turn of its own.
   *
   * <p>
   * This is a separate method from `flush` because the two answer different questions and live on different clocks.
   * `flush` means "there is pending work, start or continue a turn", and its caller (`HostService.#flushSoon`) holds
   * a `#flushScheduled` flag for the entire duration of that turn - so anything routed through `flush` cannot run
   * while a turn is in flight, which is the only time a steer is useful. `steer` means "inject into the turn that is
   * already running"; putting it inside the turn-scoped method made it dead code.
   * </p>
   * <p>
   * TWO CLASSES ARRIVE THIS WAY and `takeSteerableOnly` is the one function that decides which: a milestone, whose
   * content is about to stop being true, and a receipt that says the plan CANNOT continue (`isPreemptingFact`). Both
   * have the same property - waiting for the end of the turn buys nothing - which is the whole reason a steer exists.
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
    const steerable = this.takeSteerableOnly();
    if (steerable === undefined) return false;
    this.#steerInFlight = sink.deliver(steerable).then(
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
   * Read by `HostService` to decide whether an arriving fact warrants a steer at all. The narrowness here is about the
   * CLOCK and nothing else: a `time_milestone` is true now and false later, so waiting for the end of the turn would
   * deliver a statement about the past dressed as news. What this getter must never answer is the other question - "is
   * the plan this turn is thinking about still able to continue" - because the two have different populations and
   * different answers (`hasPreemptingFact`).
   * </p>
   */
  public get hasExpiringFact(): boolean {
    return this.#hasExpiringFact();
  }

  /**
   * Whether anything waiting says the plan this turn is working on CANNOT CONTINUE.
   *
   * <p>
   * The other half of "is this worth interrupting a thought for", and the half that was missing. `hasExpiringFact`
   * recognises only the world's clock, so NO execution receipt of any state could steer: measured `round66` and the
   * round before it, a step rejected while a turn was thinking waited for the REST OF THE TURN (26 s measured on that
   * run) before the model heard about it, and everything she thought in those 26 s was about a body that was not
   * there. A `rejected` step is not progress to be dated; it is a wall, and the sooner she has it the fewer thoughts
   * are spent on the wrong world.
   * </p>
   * <p>
   * Deliberately NOT `time_milestone`, and deliberately not every receipt: a `succeeded` one is the plan WORKING, and
   * interrupting a running plan to announce progress trades a finished action for a half-finished thought. See
   * `isPreemptingFact` for the classification and `PREEMPTING_EXECUTION_STATES` for its population.
   * </p>
   */
  public get hasPreemptingFact(): boolean {
    return this.#hasPreemptingFact();
  }

  /**
   * The batch a steer carries while a turn is running: the steerable facts ONLY, and nothing else is consumed.
   *
   * <p>
   * It does not go through `takeBatch` because that method's whole contract is to empty every window - which is
   * correct for a turn that is about to run and catastrophically wrong here, where a second batch is being handed to a
   * turn that is still working through the first. Taking only the milestones and the receipts that stop the plan
   * leaves the snapshot, the successful receipts and the player's input exactly where the in-flight turn's own
   * follow-up expects them - which is a contract this function has to keep, not a description of what it happens to do.
   * </p>
   * <p>
   * THE ORDER IS RECEIPTS FIRST: an obstruction is what she can act on, a clock mark is what she can only note.
   * </p>
   */
  private takeSteerableOnly(): PendingBatch | undefined {
    const steerable: WorldFact[] = [];
    for (const [key, fact] of [...this.#receipts.entries()]) {
      if (!isPreemptingFact(fact)) continue;
      steerable.push(fact);
      this.#receipts.delete(key);
      this.#producedBy.delete(key);
    }
    for (const [key, fact] of [...this.#worldFacts.entries()]) {
      if (fact.kind !== "world_fact" || fact.semanticKind !== "time_milestone") continue;
      steerable.push(fact);
      this.#worldFacts.delete(key);
      this.#producedBy.delete(key);
    }
    if (steerable.length === 0) return undefined;

    const deliveredFacts = steerable.map((fact) => {
      const projection = fact.contextProjection;
      if (projection === undefined) return fact;
      const { contextProjection: _contextProjection, ...factWithoutProjection } = fact;
      return Object.freeze({ ...factWithoutProjection, payload: projection });
    });
    const triggerEventIds = Object.freeze(steerable.map(factEventId));
    // A steer hands these to a turn that is already running, so they are delivered content like any other - and a
    // milestone published again later must not be a reason to open a new turn for what she has already been told.
    this.#rememberDelivered(steerable);
    return Object.freeze({
      batchId: randomUUID(),
      disposition: "steer" as const,
      triggerEventIds,
      inputs: Object.freeze([]),
      facts: Object.freeze(deliveredFacts),
      events: Object.freeze([]),
      // A steer states the world it is already carrying: the turn it joins has `<world-state>` from its own batch, and
      // this one repeats the same reading rather than leaving the model with no state at all - which is also why it
      // brought no observation: it opened no turn, and the settlement that counts empty turns reads the batch that DID.
      broughtObservation: false,
      text: composeFactBrief({
        inputs: [],
        snapshot: this.#worldStateReading(),
        // A receipt is rendered by `receiptLine` (`actionId`, state, the Mod's own `reasonCode` and evidence detail),
        // so the obstruction arrives as the Mod's words rather than as a Host paraphrase of them.
        events: steerable.filter((fact) => this.#owesTurn(fact)),
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
   * THE RULING THIS USED TO ENCODE WAS HALF RIGHT, and the wrong half is why a blocked step waited out the turn.
   * "An `execution_receipt` terminal state does not expire" is true of `succeeded`: the result is the result, and
   * interrupting a running plan to announce progress trades a finished action for a half-finished thought. It is false
   * of a receipt that says the plan CANNOT CONTINUE - a `rejected` node, a `failed` one, a Mod-verdict stall - which
   * expires in the only sense that matters: it is useless to a turn that spends the next twenty seconds thinking about
   * a body that has already stopped. That second class is `#hasPreemptingFact`, a separate question with its own name
   * rather than a widening of this one.
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

  /**
   * Whether a waiting fact says the plan this turn is working on has STOPPED.
   *
   * <p>
   * Two windows, because a receipt lives in `#receipts` and never in `#worldFacts`: a getter that scanned only the
   * world facts would answer `false` for every receipt in the pump, which is exactly the shape of the defect this
   * replaces. `#retry` is read for the same reason `#hasExpiringFact` reads it - a batch that could not be delivered is
   * still owed, and the caller's question is "is there something worth steering", not "is the window I happen to scan
   * full".
   * </p>
   */
  #hasPreemptingFact(): boolean {
    for (const fact of this.#receipts.values()) if (isPreemptingFact(fact)) return true;
    return this.#retry !== undefined && this.#retry.batch.facts.some(isPreemptingFact);
  }

  private takeBatch(): PendingBatch {
    // THE ONLY PLACE A BATCH EXISTS. `examined` is counted here rather than derived from the decision histograms, so a
    // batch composed by a path that then decides it owes no turn grows `examined` without growing `opened` - which is
    // exactly the reading `round64` printed as `flushes examined 134 · turns opened 8`.
    this.#examinedFlushes += 1;
    const inputs = this.#inputs.splice(0);
    const snapshot = this.#snapshot;
    const broughtObservation = this.#snapshotBringsObservation();
    this.#snapshot = undefined;
    this.#snapshotRestatesPrevious = false;
    this.#snapshotProducedBy = undefined;
    const carriedSlots = [
      ...this.#receipts.keys(),
      ...this.#semanticEvents.keys(),
      ...this.#lifecycle.keys(),
      ...this.#worldFacts.keys(),
    ];
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
    const worldState = this.#worldStateReading();
    const locale = batchInputs.at(-1)?.locale ?? DEFAULT_BRIEF_LOCALE;

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
      // WHAT THIS DELIVERY IS OWED, which is not the same as everything it CARRIES. `batchFacts` is the frame - the record
      // of what arrived, which `canonicalPresentationSource` and the account read - while the model-facing text states only
      // the four classes a turn exists for: her own call's result (the settlement, rendered by `<execution-result>` below),
      // a refusal, a notice or an arrival, and the player's own words. A program's step is a TRACE of her body, and a clock
      // mark is only news if she asks (`stardew_observe`, the pull); neither is delivered. Measured 2026-11-16 (`round64`):
      // 401 admitted "facts" for 8 opened turns, 260 of them one tile of movement stated twice.
      const promptFacts = batchFacts.filter(
        (fact) => fact.semanticKind === PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND || this.#owesTurn(fact),
      );
      const text = composeFactBrief({
        inputs: batchInputs,
        snapshot: worldState,
        events: promptFacts,
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
      chosen.filter((fact) => this.#owesTurn(fact)),
    );
    while (composed.text.length > MAX_BATCH_BYTES && chosen.length > 1) {
      chosen = chosen.slice(1);
      composed = compose(
        chosen,
        chosen.filter((fact) => this.#owesTurn(fact)),
      );
    }

    // Anything left out goes back where it came from, so the next flush delivers it. Re-inserted
    // directly rather than through `enqueueFact`: these facts were already admitted, and re-running
    // admission would evict a newer fact to make room for an older one.
    const dropped = facts.slice(0, facts.length - chosen.length);
    for (const fact of dropped) this.#readmit(fact);
    this.#pruneProducedBy();
    // THE CARRY LEDGER IS SETTLED HERE, against what actually left the windows: every ticketed slot this batch consumed is
    // a fact that arrived, and the ones the byte bound pushed back stay pending. This is the proof `round64`'s 126 dropped
    // flushes never had - `carried` counts facts, not calls, so the fact count cannot fall to make the arithmetic look
    // right.
    const readmitted = new Set(dropped.map(factSlotKey));
    for (const slot of carriedSlots) {
      if (readmitted.has(slot)) continue;
      if (!this.#carryPending.delete(slot)) continue;
      this.#carriedFacts += 1;
    }
    for (const [ticketId, ticket] of this.#carryTickets) {
      if (ticket.carriedInto !== undefined) continue;
      if (!ticket.facts.every((slot) => !this.#carryPending.has(slot))) continue;
      this.#carryTickets.set(ticketId, { facts: ticket.facts, carriedInto: batchId });
    }

    // This batch was shown the observation, so the next one counts its age from here. Recorded at composition, not at
    // acceptance: a rejected batch is retried with this exact text ("刚刚更新"), and the only error this can make is
    // aging a reading too far - the safe direction for a block whose whole job is to not look fresher than it is.
    // What this batch SHOWED her. The identity is the reading the block above rendered, written on every batch because
    // every batch renders it; the AGE is written only for a batch that brought it, and it is the number of delivered turns
    // this exact text has been re-stated - so the parenthetical beside a re-stated reading grows while the reading does not.
    if (this.#lastSnapshot !== undefined) {
      this.#lastSnapshotDeliveredIdentity = readingContentIdentity(this.#lastSnapshot);
      if (broughtObservation) this.#lastSnapshotDeliveredBatch = this.#deliveredBatches;
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
      broughtObservation,
    });
  }

  /**
   * The world as `<world-state>` states it: the last reading, the revision the Mod reported for it, and how many delivered
   * turns old it is.
   *
   * THE FRESHNESS IS THE COMPARISON, not a caller's flag. `ageTurns === 0` is what `fact-brief.ts` renders as `刚刚更新`
   * and anything else as `本轮无新观察`, so it is decided the same way the suppressor decides a flush: by asking whether this
   * reading's own content is one she was shown. A caller that could pass the answer in could pass a different one from the
   * text it composes, and measured `round53` that is exactly what happened - a block printed `11:30（上午）· 天气：雨天 ·
   * 位置: 镇上 · 体力: 41` under a header saying `本轮无新观察`.
   */
  #worldStateReading(): WorldStateReading | undefined {
    const fact = this.#lastSnapshot;
    if (fact === undefined) return undefined;
    const age = this.#deliveredBatches - this.#lastSnapshotDeliveredBatch;
    return Object.freeze({
      snapshot: fact.payload as unknown as Snapshot,
      revision: fact.revision,
      ageTurns: this.#readingIsNews(fact) === false ? Math.max(1, age) : 0,
      ageMs: Math.max(0, Date.now() - this.#lastSnapshotArrivedAtMs),
    });
  }

  /**
   * Whether the snapshot slot holds a reading she has not been shown: the freshness half of `#readingIsAged`.
   *
   * The batch's own `broughtObservation`, and the only expression that decides it - `takeBatch` reads it, so the flag the
   * model was told `刚刚更新` by and the flag the cure is keyed on are one derivation rather than two that can disagree.
   */
  #snapshotBringsObservation(): boolean {
    return this.#snapshot !== undefined && this.#readingIsNews(this.#snapshot) !== false;
  }

  /**
   * THE ONE STALENESS CONDITION: whether the reading a turn states is one she already had.
   *
   * <p>
   * Two questions ask it and neither may grow a test of its own, because they were the defect: the settlement asks it to
   * NAME an empty turn (`#emptyTurnReason`), and the composition asks it to CURE the reading before the turn is built
   * (`#agedReadingBeforeComposition`). Measured 2026-11-13 (`round50b`): the name was computed from this condition while
   * the cure was computed from `worldStateStaleThreshold` (five turns, re-armed 5/20/35) AND from `worldChangesSinceReading`
   * - so a turn two batches into a run was named `world_stale` while every probe the Host owns was still unspent, and she
   * was handed `（这是 1 轮之前看到的，世界已经不一样了）` with nothing asked.
   * </p>
   *
   * <p>
   * WHICH BOUND WINS, and why. For the CURE it is this one - "the batch did not bring the observation" - which is age 1.
   * For the NOTICE it stays `worldStateStaleThreshold`, which is age 5 and re-arms outwards. The two answer different
   * questions and the difference is not a matter of taste: a refresh costs one pipe round-trip, replaces the reading in a
   * turn that was being opened anyway, and is bounded per READING (`WORLD_STATE_REFRESH_ATTEMPTS`), while a notice costs
   * a turn - it is a statement to the model - so it has to be spaced out. Waiting for the notice's bound before asking is
   * how fifty turns were spent on one picture nobody refreshed.
   * </p>
   */
  #readingIsAged(broughtObservation: boolean): boolean {
    return this.#lastSnapshot !== undefined && !broughtObservation;
  }

  /**
   * The aged reading this turn is about to be composed from, or `undefined` when there is nothing to cure.
   *
   * `undefined` has two causes and neither is a staleness statement: the batch brings an observation, or no reading has
   * ever arrived (a session's first turns). Both compose exactly as they did before this method existed.
   *
   * IT IS ASKED FROM THE DECISION, NOT FROM THE OPENING (`flush`), because a flush that suppresses for this exact reason -
   * the reading it is holding is one she has already read - was the one place the cure could never reach. Measured
   * (`.tmp/audit/probe-refresh-loop.mjs`): nine clock-only suppressions, zero probes, and the only answer they ever got
   * re-entered the same predicate, so no turn opened, nothing acted, and the reading could never move.
   *
   * The IDENTITY comes back with the reading because it is the probe budget's key (`#worldStateRefreshFor`): the question
   * asked is "is there a reading other than this one", and only that reading's own content answers it.
   */
  #agedReadingBeforeComposition(): Readonly<{ reading: WorldStateReading; identity: string }> | undefined {
    const fact = this.#lastSnapshot;
    if (fact === undefined) return undefined;
    if (!this.#readingIsAged(this.#snapshotBringsObservation())) return undefined;
    const reading = this.#worldStateReading();
    if (reading === undefined || reading.ageTurns === 0) return undefined;
    return Object.freeze({ reading, identity: readingContentIdentity(fact) });
  }

  /**
   * Take the remedy for the reading this turn is about to be handed, and say what it will cost to wait for.
   *
   * `undefined` is a turn with nothing to cure. Otherwise the ask is taken as far as it can go synchronously - a pump
   * with no port, or a revision whose attempts are spent, answers now and the caller names the reason - so the only
   * caller that waits on the world is the one holding a request that is actually out.
   */
  #beginAgedReadingAsk(): FreshObservationAsk | undefined {
    const aged = this.#agedReadingBeforeComposition();
    if (aged === undefined) return undefined;
    this.#autoObserveAgedTurns += 1;
    return this.#askForFreshObservation(aged.identity, aged.reading);
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
   *
   * <p>
   * NOTHING IS ASKED HERE ANY MORE, and that is the unit's whole point. The ask lives where the reading is about to be
   * composed into a turn (`#beginAgedReadingAsk`, called by `flush`), keyed on the SAME condition that names an empty
   * turn `world_stale` rather than on this notice's own threshold. Measured 2026-11-13 (`round50b`): the notice's
   * threshold was five turns and its re-arm 5/20/35, while the classification called a one-turn-old reading
   * `world_stale` - so this method's ask fired on a trigger almost no turn took, and two turns of the run were composed
   * from an aged reading with all three probes unspent. What is left here is the NOTICE, and it now means something
   * sharper than it did: it is due only for a reading that outlived `WORLD_STATE_STALE_TURNS` in a world that said it
   * moved, and every one of those turns was already offered to the world and could not be cured - so `world_state_stale`
   * is what the Host says when the refresh did not work, not what it says instead of refreshing.
   * </p>
   *
   * <p>
   * MEASURED 2026-11-13 (`round47`): 22 of 41 talk-only turns were handed `world_state_stale:...`, and the cheapest thing
   * she could do with such a turn was describe the world she had been told she could not see. The refresh was already
   * installed and already fired; what it could not do was replace the turn it was meant to save. Her own debrief says
   * why being TOLD was not enough: she read the in-flight block's 「还没结算，就等于一步都还没做成」 as "no action is
   * issuable", and the one fact that names "narrated but did not work" (`narration_without_work`) reached her once in 64
   * turns and read as a reminder rather than a verdict. A stale world must therefore not have to be narrated at all:
   * the Host fetches it and says nothing. (The in-flight sentence is a separate defect and is not fixed here.)
   * </p>
   *
   * <p>
   * WHEN THE CURE COULD NOT FIRE the fact IS minted, so the stale notice still reaches her and the turn still opens; the
   * account says which condition it was (`autoObserve.unavailable`, one member of
   * `AUTO_OBSERVE_UNAVAILABLE_REASONS`). A refresh is never silent and never assumed.
   * </p>
   */
  public takeWorldStateStaleFact(): WorldFact | undefined {
    const reading = this.#worldStateReading();
    if (reading === undefined || !this.#worldStateStaleDue(reading)) return undefined;
    this.#worldStateStalePublished += 1;
    const code = worldStateStaleCode(reading);
    const eventId = `${WORLD_STATE_STALE_SEMANTIC_KIND}_${String(reading.revision)}_${String(this.#worldStateStalePublished)}`;
    const fact = Object.freeze({
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
    return fact;
  }

  /**
   * Install where a stale reading is acted on. One per pump: the composition that owns the integration attaches it once
   * (`continuity-semantic-game-runtime-materializer.ts`), and a second attach is a wiring bug rather than a policy.
   */
  public attachWorldStateRefresh(port: WorldStateRefreshPort): void {
    if (this.#worldStateRefreshPort !== undefined) throw new Error("world_state_refresh_already_attached");
    this.#worldStateRefreshPort = port;
  }

  /** Whether a stale reading can be refreshed at all here, and what asking has done (`WorldStateRefreshReading`). */
  public get worldStateRefresh(): WorldStateRefreshReading {
    return Object.freeze({
      attached: this.#worldStateRefreshPort !== undefined,
      probes: this.#worldStateRefreshProbes,
      refusals: this.#worldStateRefreshRefusals,
    });
  }

  /**
   * Ask the integration for a fresh observation of the aged reading, or say why the world cannot be asked.
   *
   * <p>
   * THE THREE BOUNDS that keep this from becoming a poll, because a failed refresh must not retry by itself:
   * </p>
   * <ol>
   *   <li>`WORLD_STATE_REFRESH_ATTEMPTS` per reading: one reading she has already been shown is asked about three times and
   *     then declined with `refresh_attempts_spent`. The re-arm keys are the reading's own CONTENT and the world's own
   *     statement that it MOVED (`AUTO_OBSERVE_REARM`), so a world that never moves cannot turn the flush cadence into a
   *     probe cadence, and a counter that moved without the world does not re-arm it.</li>
   *   <li>An ask is made for every examined flush whose reading it did not bring (`flush` -> `#beginAgedReadingAsk`), before
   *     the flush decides whether to open a turn - never from a timer or a publication: there is one trigger and it is the
   *     staleness condition itself.</li>
   *   <li>The episode is re-armed by the READING moving or by the WORLD saying it moved, never by time and never by a flush,
   *     and a refusal is published once per reading (`#refuseWorldStateRefresh`) - so a bridge that never answers produces
   *     one statement, not a stream.</li>
   * </ol>
   *
   * <p>
   * THE SECOND RE-ARM KEY IS WHAT `round61` PROVED NECESSARY. The first one alone is self-defeating: the only producer of a
   * different reading is this ask, so a snapshot channel that stopped publishing while the clock kept walking was a budget
   * that could never come back - ten and a half minutes and thirteen `world_stale` turns on a bridge that was answering.
   * The world's own statement is independent of the channel it is not arriving on, and it is asked for ONCE per statement:
   * several movements between two flushes are one question ("read the world now"), and a statement already answered by an
   * ask cannot earn a second one.
   * </p>
   *
   * <p>
   * THE ANSWER IS WAITED FOR when a caller can wait: the request travels the integration's own observation route
   * (`StardewBridgeConnection.observe`) and its answer arrives as an ordinary snapshot fact through `enqueueFact`, so what
   * the caller reads after the wait is the same state every other fact writes - not a second copy of the world held here.
   * What this method owes the caller either way is the FAILURE: a rejection is published as a fact
   * (`#refuseWorldStateRefresh`) rather than swallowed, because a probe the integration would not serve must be as
   * visible as the stale reading it could not replace.
   * </p>
   */
  #askForFreshObservation(identity: string, reading: WorldStateReading): FreshObservationAsk {
    const port = this.#worldStateRefreshPort;
    if (port === undefined) return Object.freeze({ declined: AUTO_OBSERVE_UNAVAILABLE.noBridge });
    const episode = this.#worldStateRefreshFor;
    const same = episode !== undefined && episode.identity === identity;
    const probes = same ? episode.probes : 0;
    // The world said it moved after the last ask: `#worldChangesSinceReading` is the SAME count `world_state_stale` names
    // as its evidence, so "the world moved" has one spelling in this pump rather than two that can disagree.
    const worldMoved = same && this.#worldChangesSinceReading > episode.worldChanges;
    if (probes >= WORLD_STATE_REFRESH_ATTEMPTS && !worldMoved)
      return Object.freeze({ declined: AUTO_OBSERVE_UNAVAILABLE.attemptsSpent });
    // Which signal earned this budget, counted where it is decided rather than inferred from two counters later.
    if (episode !== undefined && episode.probes >= WORLD_STATE_REFRESH_ATTEMPTS) {
      this.#autoObserveRearmed[same ? AUTO_OBSERVE_REARM.worldMoved : AUTO_OBSERVE_REARM.readingMoved] += 1;
    }
    this.#worldStateRefreshFor = {
      identity,
      revision: reading.revision,
      probes: probes + 1,
      refusalPublished: same ? episode.refusalPublished : false,
      worldChanges: this.#worldChangesSinceReading,
    };
    this.#worldStateRefreshProbes += 1;
    const inFlight = (async (): Promise<void> => {
      try {
        await port.observe();
      } catch (error: unknown) {
        // Counted per ASK, not per reading: every flush the route refused is a flush decided on an old reading,
        // which is what makes `agedReadings = refreshed + every unavailable reason` hold. The FACT the refusal publishes
        // is still said once per reading (`#refuseWorldStateRefresh`) - a condition and a statement are different sums.
        this.#autoObserveUnavailable[AUTO_OBSERVE_UNAVAILABLE.refused] += 1;
        this.#refuseWorldStateRefresh(identity, reading.revision, error);
        return;
      }
      // Counted where the answer arrives rather than where the request left: an ask the route refused is not a refresh,
      // and `worldStateRefresh.probes` is already the count of requests made.
      this.#autoObserveRefreshed += 1;
      this.#autoObserveLastAgeTurns = reading.ageTurns;
    })();
    return Object.freeze({ inFlight });
  }

  /**
   * Say that the probe for `revision` came back refused, once per reading.
   *
   * Once, not once per probe: the reason is the same statement until the reading moves, and three copies of "the bridge
   * is not answering" would be three turns spent re-reading one condition. `publish` is the Host's Host-minted-fact
   * route, so this fact wakes a turn exactly where the stale fact did and nowhere else.
   */
  #refuseWorldStateRefresh(identity: string, revision: number, error: unknown): void {
    const port = this.#worldStateRefreshPort;
    const episode = this.#worldStateRefreshFor;
    if (port === undefined || episode === undefined || episode.identity !== identity) return;
    if (episode.refusalPublished) return;
    episode.refusalPublished = true;
    try {
      port.publish(this.#worldStateRefreshRefusedFact(revision, error));
    } catch {
      // The publisher's own admission refused the fact (a full pump, `event_pump_overflow`). The Host reports that limit
      // on its own path; what must not happen here is a rejection escaping a fire-and-forget probe.
      episode.refusalPublished = false;
      return;
    }
    this.#worldStateRefreshRefusals += 1;
  }

  /** The one spelling of the refusal fact: `world_state_refresh_refused:<reason>`. */
  #worldStateRefreshRefusedFact(revision: number, error: unknown): WorldFact {
    const reason = worldStateRefreshRefusalReason(error);
    const eventId = `${WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND}_${String(revision)}_${String(this.#worldStateRefreshRefusals + 1)}`;
    return Object.freeze({
      source: HOST_MINTED_FACT_SOURCE,
      kind: "world_fact" as const,
      eventId,
      sourceEventId: eventId,
      correlationId: eventId,
      revision,
      occurredAtMs: Date.now(),
      semanticKind: WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND,
      payload: Object.freeze({
        kind: WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND,
        code: `${WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND}:${reason}`,
        reason,
        revision,
        probes: this.#worldStateRefreshFor?.probes ?? 0,
        attempts: WORLD_STATE_REFRESH_ATTEMPTS,
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
   * The measurement, split from the publication exactly as `executionLiveness` is split from `takeStallFact`: reading this
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
    const reading = this.#worldStateReading();
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
   * Record what the turn that just settled DID, for `narrationWithoutWork` and for the empty-turn reading.
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
   * <p>
   * THE SAME SETTLEMENT ANSWERS THE OTHER QUESTION: `turnProduction === spoke` is exactly "delivered speech, ran no
   * tool", so the turn is counted under the shape its opener and its condition describe. It is a READING and not a
   * refusal - nothing here changes what the turn was allowed to do - because the run's own account has to be able to say
   * "41 of 64 turns were this shape" without anyone opening a session file.
   * </p>
   * <p>
   * AND THE THIRD: a turn that produced work and delivered no speech is counted as `turn_settled_silent` - the other half
   * of the same distinction, taken at the same moment and from the same production the loop published. Two properties keep
   * it honest, and neither is a state the receipt window is in: WORK was produced (a turn that did nothing is not a
   * companion who chose quiet), and no text was (the speaking members are the other counter's). The person's own opener is
   * never silence, because a turn someone opened is owed an answer and its emptiness is a different defect than this one.
   * </p>
   * <p>
   * A RECEIPT STILL IN FLIGHT IS A QUALIFIER, NOT AN EXCLUSION. MEASURED 2026-11-15 (`round59`): this counter printed `0`
   * for 42 settled turns that all carried text, and the same tree answered `0` for a silent working turn whose own
   * programme was running at settlement while answering `1` for the same turn with nothing in flight - 28 of 36 programme
   * turns closed with her own receipt open, so the counter was structurally unable to say anything about the turns it
   * exists to describe. The number is COUNTED instead (`settledWithExecutionInFlight`), so "she was quiet while her work ran"
   * is a reading rather than an inference from logs.
   * </p>
   * <p>
   * WHICH TURNS THE SILENT COUNTER INCLUDES IS THE LOOP'S OWN ANSWER, NOT A GUESS FROM `worked`. `turnProducedWork` and
   * `turnProducedSpeech` are the two properties, asked once over the closed list: work without text is silence, and both
   * speaking members are not. MEASURED 2026-11-15 (`round58`): 21 turns opened, 21 bubbles, and this counter printed `0`
   * because the only member it read as silence was `said_nothing`, a state a completed turn can only reach when Pi reported
   * no message at all. A turn that acted and chose not to speak had nowhere to land.
   * </p>
   */
  #observeTurnProduction(
    outcome: CompanionTurnOutcome | undefined,
    opening: TurnOpening,
    broughtObservation: boolean,
  ): void {
    if (outcome !== "completed") {
      this.#turnsWithoutWork = 0;
      return;
    }
    const producedSpeech = turnProducedSpeech(this.turnProduction);
    const producedWork = turnProducedWork(this.turnProduction);
    const inFlight = this.hasExecutionInFlight;
    if (inFlight) this.#settledWithExecutionInFlight += 1;
    if (this.turnProduction === TURN_PRODUCTION.spoke && !inFlight) {
      const shape = turnWithoutActionShape(opening, this.#emptyTurnReason(broughtObservation));
      this.#emptyTurns += 1;
      this.#emptyTurnsByShape[shape] += 1;
    }
    if (producedWork && !producedSpeech && opening !== TURN_OPENING.playerInput) {
      this.#silentSettledTurns += 1;
      this.#silentSettledByOpener[opening] += 1;
    }
    if (producedWork) {
      this.#turnsWithoutWork = 0;
      this.#lastWorkTurnAtMs = Date.now();
      return;
    }
    this.#turnsWithoutWork =
      this.turnProduction === TURN_PRODUCTION.spoke && !inFlight ? this.#turnsWithoutWork + 1 : 0;
  }

  /**
   * Why a speaking turn with no action behind it closed, in the declared order of `TURN_WITHOUT_ACTION_REASON`.
   *
   * The snapshot is asked directly for the body half: `actionable` is the Mod's own admission gate, so "the engine is
   * holding this actor" is its statement rather than this pump's inference. A session with no reading at all is neither
   * stale nor held - it has nothing to act on - and falls to `nothing_pending`, where the absence is already visible in
   * the world-state block's `尚未收到观察`.
   */
  #emptyTurnReason(broughtObservation: boolean): TurnWithoutActionReason {
    if (this.#readingIsAged(broughtObservation)) return TURN_WITHOUT_ACTION_REASON.worldStale;
    if (this.#bodyHeld()) return TURN_WITHOUT_ACTION_REASON.bodyHeld;
    return TURN_WITHOUT_ACTION_REASON.nothingPending;
  }

  /** Whether the last reading says the actor cannot take a command (`Snapshot.actionable`). */
  #bodyHeld(): boolean {
    return (this.#lastSnapshot?.payload as { actionable?: unknown } | undefined)?.actionable === false;
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
 * Why a fresh observation was refused, as the one token the fact carries after its own kind.
 *
 * The route's own words (`bridge_not_authenticated`, `bridge_response_timeout`, `bridge_rejected:<reasonCode>`) are
 * printed verbatim: they are the producer's vocabulary and the only thing that tells a dead bridge from a busy one. The
 * first line only, because a thrown value can carry a stack-shaped tail and nothing here parsed the error.
 */
function worldStateRefreshRefusalReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  const firstLine = message.split(/\r?\n/u)[0]?.trim() ?? "";
  return firstLine === "" ? "unknown" : firstLine;
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
 *
 * <p>
 * A TERMINAL RECEIPT IS NOT HELD HERE, AND IT OPENS NO TURN EITHER - IT OWES ONE. `#owesTurn` and `#opensTurn` answer
 * different questions ("the prompt states it" / "the model is woken for it"), a receipt can never present, so for every
 * terminal state the two answers differ. Filing those states here would delete the first answer - the outcome would
 * leave `promptFacts`, and a `rejected` one would steer a batch that states nothing - which is measured, red, in
 * `event-pump.node-batch-turns.test.ts`.
 * </p>
 */
export const HELD_RECEIPT_PROGRESS_STATES: Readonly<Record<string, string>> = Object.freeze({
  accepted: "the programme's settlement states the step and opens the turn: it is the plan's one answer",
  running: "the programme's settlement states the step and opens the turn: it is the plan's one answer",
  meaningful_progress: "the programme's settlement states the step and opens the turn: it is the plan's one answer",
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
 * The kinds a body trace can be, in the one spelling `factTraceKind` answers with: `receipt:<state>` for the latest-only
 * receipt states and `semantic:<kind>` for the semantic ones.
 *
 * <p>
 * DERIVED FROM THE TWO HELD TABLES ABOVE, so a state or kind added there is counted and printed without a second list.
 * This is the shape of `TurnAccount.traces` and the reason a run cannot print `traces 69` and leave the reader guessing
 * which 69: `round65` counted 69 traces in ten minutes, `tile_advanced` was 0, and the account could not say what the 69
 * were - the only way to answer "which trace is the Mod still producing" was to read the Mod.
 * </p>
 */
export const TRACE_KINDS: readonly string[] = Object.freeze(
  [
    ...Object.keys(HELD_RECEIPT_PROGRESS_STATES).map((state) => `receipt:${state}`),
    ...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS).map((kind) => `semantic:${kind}`),
  ].sort(),
);

/**
 * Semantic kinds the HOST mints on a schedule it keeps itself, each with the path that turns it into a turn.
 *
 * Same defect class as the held tables above, with the trap that makes it worse: no adapter will ever publish one of
 * these, so "a later fact from the Mod arrives" is not an available answer. The wake source has to be a Host path, and
 * naming it here is what makes an unclassifiable kind fail loudly instead of sitting in the pump unwatched.
 */
export const HOST_MINTED_WAKE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  [WORLD_STATE_STALE_SEMANTIC_KIND]:
    "the Host asks takeWorldStateStaleFact after every adapter fact it admits, and hands the fact to acceptHostMintedFact",
  [WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND]:
    "the pump's own refresh probe rejects, and the port the composition attached publishes this fact through acceptHostMintedFact - the same route the stale fact takes, so a bridge that will not answer wakes a turn instead of waiting one out",
  [NARRATION_WITHOUT_WORK_SEMANTIC_KIND]:
    "the Host reads wakeReason when a flush settles, and when it answers narration_without_work it mints the fact with takeNarrationWithoutWorkFact and hands it to acceptHostMintedFact, which enqueues it and flushes a turn",
});

/**
 * Semantic kinds whose VERDICT comes from the Mod, each with the path that turns it into a turn.
 *
 * <p>
 * A separate table from `HOST_MINTED_WAKE_KINDS` because the authority is the whole difference: a HOST-MINTED kind is a
 * schedule the Host keeps coming due (`world_state_stale`, a narration run), while a MOD VERDICT is the body controller
 * deciding something about the body it owns - the Host only gives it the model-facing shape. `execution_stalled` belongs
 * to the second: its reason and its wait are the body controller's (`stalled_waiting`), and a Host that timed instead was
 * answering a question with the wrong authority.
 * </p>
 */
export const MOD_VERDICT_WAKE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  [EXECUTION_STALL_SEMANTIC_KIND]:
    "the body controller states `stalled_waiting` on the execution's own receipt (reason=..., stalled_ticks=...), the Host asks takeStallFact after admitting it, and the fact that mints travels acceptHostMintedFact, which enqueues it and flushes a turn immediately",
});

/**
 * Every kind the pump can deliver ITSELF, from the two tables that say which authority decides it.
 *
 * The population the turn classification below and the wake-classification gate read, so a kind added to either table is
 * classified without anyone remembering a third list.
 */
export const PUMP_MINTED_WAKE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  ...HOST_MINTED_WAKE_KINDS,
  ...MOD_VERDICT_WAKE_KINDS,
});

/**
 * Receipt states a programme's step is suppressed by - and therefore the reasons a step receipt must not open a turn.
 *
 * <p>
 * EMPTY BY RULING. A receipt's own state cannot say whether a programme is in flight, and "a programme is in flight" is a
 * judgement about TURNS, never a suppressor of a fact (`design/fact-authority.md`): the classification is a property of
 * the fact's shape, and a step that did run opens its own turn like any other outcome. What kept this table populated was
 * a shape question wearing a liveness name - `round57` opened 57 of 66 turns on one adapter fact because every finished
 * node was declared silent while its programme ran, and `round64` shows what is actually left once the body traces are
 * gone: about 16 real receipts and 22 settlements in one run, not 66 turns.
 * </p>
 * <p>
 * MEASURED AGAIN, AND IT HOLDS. `round65` (`tools/_multiday_routine-round65-live-runner.log`) opened 26 turns with
 * `program_settlement 0`, and the first reading of that number was "the steps stole the turns". Attributing each of the 24
 * `adapter_ingress` openers to the facts in its window says otherwise: 20 had a terminal receipt of a NAMED programme arrive
 * with them, and the other four are a lone action's outcome (2 standalone receipts), a clock mark, and two turns opened by
 * a fact carried from an earlier window. **No turn in that run was opened by an orphan receipt** - a receipt arriving after
 * its programme was gone. The 103 terminal programme receipts went out as 26 turns because the pump batches them, so
 * `program_settlement 0` is a CREDIT artefact, not a lost answer: the settlement is delivered in the batch
 * (`promptFacts` admits it unconditionally) and simply is not the fact `#opening` names first.
 * </p>
 * <p>
 * THE DECLARATION STAYS, AND IT IS THE GATE'S READING. `tools/check-fact-authority.mjs` refuses a fact suppressed
 * because a programme is in flight, and it finds the suppressors by THIS NAME - so the place a future author would have to
 * write one into is still read, still empty, and still fails the gate by name the moment a Mod fact kind appears here. A
 * deleted declaration would make that check unmeasurable rather than passing.
 * </p>
 * <p>
 * WHAT IS STILL HELD, and it is not suppression: the per-node states a programme is still working through
 * (`accepted`, `running`, `meaningful_progress`) are PROGRESS (`HELD_RECEIPT_PROGRESS_STATES`) - they never open a flush,
 * and the settlement that closes the programme carries them as its evidence.
 * </p>
 */
export const IN_FLIGHT_RECEIPT_PROGRESS_STATES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * What a SETTLEMENT states about the programme it closes, as the one classification its fact SHAPE is built from.
 *
 * <p>
 * ONE CALL, ONE ANSWER, AND THE ANSWER OPENS ITS TURN. A settlement is the only fact that states a programme's outcome per
 * node, and the answer is only an answer if she can read it when it arrives (`design/fact-authority.md` §1c), so BOTH
 * outcomes are `decision`: the turn it opens carries the verdict and its bounded evidence (`ok`, `reason`, `total`,
 * `counts`, `nodes`, `omitted` from `program-settlement-digest.ts`), and a programme whose answer nobody was handed does
 * not exist. Which of the two it is stays its own reading - it is what `settledSummary` names and what the account can
 * count - but it no longer decides whether the answer is delivered.
 * </p>
 * <p>
 * NOT THE SHAPE `round59` MEASURED. That run opened 88 turns, 79 of them on one adapter fact, because the stop that
 * produced them was every finished NODE opening a turn of its own; a programme that succeeded then bought one utterance
 * per plan on top. Those turn sources are gone (`04598eda` removed the body traces, and a step receipt is now the
 * programme's own row in `<execution-result>`), and `round64` measures what is left: about 16 real receipts and 22
 * settlements in a run - a settlement per plan, not a turn per node.
 * </p>
 * <p>
 * THE READING IS THE DIGEST'S OWN, NOT A SECOND ONE. `counts` and `total` are what `program-settlement-digest.ts`
 * publishes (`settledProgramOk`) and what `settlementLine` renders, so the line she reads and the classification this pump
 * makes cannot disagree about whether a plan worked.
 * </p>
 */
export const SETTLED_PROGRAM_OUTCOMES = Object.freeze({
  succeeded: Object.freeze({
    why: "every node did what it was told: the answer states it with its counts and rows, and it opens the turn that hands her the answer",
  }),
  refused: Object.freeze({
    why: "at least one node was refused, failed, stopped, only partially done or unreadable - the answer names it in `reason`, and that is the one thing in a plan she can act on",
  }),
});

export type SettledProgramOutcome = keyof typeof SETTLED_PROGRAM_OUTCOMES;

/**
 * Which of the two a settlement fact states, read from the counts its producer published.
 *
 * <p>
 * A payload it cannot read is `refused`, for the same reason a shape outside the classification table is a `decision`:
 * the pump forwards facts verbatim, so an unreadable settlement must cost a turn rather than be filed as success.
 * </p>
 */
export function settledProgramOutcome(fact: WorldFact): SettledProgramOutcome {
  const total = fact.payload.total;
  const counts = fact.payload.counts;
  if (typeof total !== "number" || total <= 0 || typeof counts !== "object" || counts === null) return "refused";
  // The digest's own verdict function, not a second spelling of "every node succeeded": the sentence she reads
  // (`settledSummary`) and the classification here are the same arithmetic over the same counts.
  return settledProgramOk(counts as Readonly<Record<string, number>>, total) ? "succeeded" : "refused";
}

/**
 * What one fact SHAPE owes her, as the one classification this pump and its gate read.
 *
 * <ul>
 *   <li>`decision` - it can change what she does next, so it may open a turn. Every OUTCOME is one: a finished step, a
 *       refusal, a settlement and the world speaking.</li>
 *   <li>`progress` - standing state inside work already answered: never a turn, always delivered by the next one. The
 *       per-node states a programme is still working through, a held body trace, and the reading.</li>
 *   <li>`in_flight_progress` - a step of a programme whose delivery depends on WHICH programme owns its execution. No shape
 *       is one today (`IN_FLIGHT_RECEIPT_PROGRESS_STATES` is empty by ruling); the member stays because the mechanism that
 *       reads it (`#owesTurn`, `factExecutionOrigin`) is the one that must exist if such a fact ever returns, and because
 *       its emptiness is what the fact-authority gate measures.</li>
 * </ul>
 *
 * <p>
 * A SETTLEMENT IS ONE ANSWER, SO BOTH OF ITS OUTCOMES ARE DECISIONS: `settled:succeeded` and `settled:refused` differ in
 * what she reads (`ok`/`reason`), not in whether she is handed it (`SETTLED_PROGRAM_OUTCOMES`). Every other world fact is
 * one shape - `world_fact` - because the world speaking, a clock mark and a notice are all news nothing else will state.
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED, NOT LISTED: every `EXECUTION_STATES` member is classified as a receipt, every settlement
 * outcome the pump declares is classified as a settlement, and every kind the
 * pump's own tables declare (`HELD_SEMANTIC_PROGRESS_KINDS`, `HOST_MINTED_WAKE_KINDS`, `MOD_VERDICT_WAKE_KINDS`, and the
 * empty `IN_FLIGHT_RECEIPT_PROGRESS_STATES`) is classified as a semantic event. A state the protocol adds, an outcome or
 * kind added to one of those tables, appears here or fails `event-pump.in-flight-progress.test.ts` by name - which is also
 * why the table is built by code rather than typed out: two hand-written copies of one vocabulary disagree eventually.
 * </p>
 */
function buildFactTurnConsequence(): Readonly<Record<string, FactTurnConsequence>> {
  const table: Record<string, FactTurnConsequence> = {
    // A reading is the `<world-state>` block every turn re-states: standing state, never news (`TURN_OPENING`).
    snapshot: "progress",
    // The world speaking, and the transport going away: nothing else will ever state either.
    world_fact: "decision",
    lifecycle: "decision",
  };
  for (const state of EXECUTION_STATES) table[`receipt:${state}`] = "decision";
  for (const state of Object.keys(HELD_RECEIPT_PROGRESS_STATES)) table[`receipt:${state}`] = "progress";
  for (const state of Object.keys(IN_FLIGHT_RECEIPT_PROGRESS_STATES)) table[`receipt:${state}`] = "in_flight_progress";
  for (const kind of Object.keys(HELD_SEMANTIC_PROGRESS_KINDS)) table[`semantic:${kind}`] = "progress";
  for (const kind of Object.keys(HOST_MINTED_WAKE_KINDS)) table[`semantic:${kind}`] = "decision";
  for (const kind of Object.keys(MOD_VERDICT_WAKE_KINDS)) table[`semantic:${kind}`] = "decision";
  for (const outcome of Object.keys(SETTLED_PROGRAM_OUTCOMES) as SettledProgramOutcome[])
    table[`settled:${outcome}`] = "decision";
  return Object.freeze(table);
}

export type FactTurnConsequence = "decision" | "progress" | "in_flight_progress";

export const FACT_TURN_CONSEQUENCE: Readonly<Record<string, FactTurnConsequence>> = buildFactTurnConsequence();

/** The table key one fact occupies: its kind, split by the state, the semantic kind or the settlement outcome that says
 * what it means. */
export function factTurnShape(fact: WorldFact): string {
  if (fact.kind === "execution_receipt") return `receipt:${String(fact.payload.state)}`;
  if (fact.kind === "semantic_event") return `semantic:${String(fact.payload.kind)}`;
  if (fact.kind === "world_fact" && fact.semanticKind === PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND)
    return `settled:${settledProgramOutcome(fact)}`;
  return fact.kind;
}

/**
 * The shape a `no_surface_for` answer is filed under: `factTurnShape`, except that a plain world fact is named by its OWN
 * semantic kind - `world_fact:modal_presented`.
 *
 * `world_fact` alone would collapse every kind that cannot present into one word, and the kind is the thing a fix has to
 * move: `round66`'s twelve lost turns were all one shape, and a reader of `no_surface_for 12 {world_fact: 12}` could not
 * tell that from twelve undrawn HUD lines. The classification's own key stays `world_fact` (`factTurnShape`), because that
 * is the shape's consequence; this is the finer spelling the ACCOUNT needs, and nowhere else.
 */
function noSurfaceShape(fact: WorldFact): string {
  const shape = factTurnShape(fact);
  if (shape !== "world_fact") return shape;
  return fact.semanticKind === undefined ? shape : `world_fact:${fact.semanticKind}`;
}

/**
 * What a fact of this shape owes her - the ONE reading of the classification above.
 *
 * A shape outside the table is a `decision`, and that direction is deliberate: the pump forwards facts verbatim and the
 * Mod's semantic vocabulary is open, so an unknown kind must cost a turn rather than a fact. The gate is what keeps
 * this from being a silent default for the pump's OWN vocabulary - it derives the population from the tables and
 * `EXECUTION_STATES`, so a member added there is classified here or fails by name.
 */
export function factTurnConsequence(fact: WorldFact): FactTurnConsequence {
  return FACT_TURN_CONSEQUENCE[factTurnShape(fact)] ?? "decision";
}

/**
 * Which programme the fact's execution belongs to, as the MOD's OWN JOURNAL stated it on the wire.
 *
 * <p>
 * THE ONE READING OF A STEP'S CAUSE. The `execution_receipt` carries it, and so does the body trace that would restate
 * one - both from one journal lookup in the Mod (`BridgeSession#OriginOf`) - so they cannot disagree about which
 * programme owns an execution.
 * </p>
 * <p>
 * `undefined` means THIS FACT SAYS NOTHING ABOUT AN EXECUTION: a settlement, a milestone, the world speaking. A fact that
 * DOES state an execution but carries no readable provenance is the other case, and it is the caller's to treat as
 * `unattributed` - never as "no programme, so it is a lone outcome", because that reading is the guess this field exists
 * to replace. An origin this reader cannot read is therefore NO statement: the fact owes a turn (the direction that
 * cannot lose an outcome) and the account counts it in `unstated`.
 * </p>
 */
export function factExecutionOrigin(fact: WorldFact): ExecutionOrigin | undefined {
  if (fact.kind === "execution_receipt") return statedOrigin(fact.payload.origin);
  if (fact.kind !== "semantic_event") return undefined;
  const trace = fact.payload.bodyTrace;
  if (trace === null || typeof trace !== "object") return undefined;
  return statedOrigin((trace as { origin?: unknown }).origin);
}

/** `payload.origin` when it is one of the three statements `protocol.ts` declares, and nothing otherwise. */
function statedOrigin(value: unknown): ExecutionOrigin | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "standalone" || kind === "unattributed") return value as ExecutionOrigin;
  if (kind !== "programme") return undefined;
  const named = value as { programId?: unknown; nodeId?: unknown };
  // HALF A NAME IS NOT A NAME: a programme origin with one id is a broken frame, not a step of that programme.
  return typeof named.programId === "string" &&
    named.programId.length > 0 &&
    typeof named.nodeId === "string" &&
    named.nodeId.length > 0
    ? (value as ExecutionOrigin)
    : undefined;
}

/**
 * Semantic-event kinds that are PROGRESS, not outcomes: per-tile route advance, the start of an execution, and
 * the actor falling idle. They describe a moving state, so only the latest one matters.
 *
 * Measured 2026-10-17 on a real multi-day run: one long agent turn (70 assistant messages, ~350s) made the Mod
 * publish 129 such observations, each with its OWN freshly-minted correlationId, and they filled the 128-entry
 * pending window - so the pump threw and the bridge closed mid-run. The receipt counterpart of exactly this
 * traffic is already latest-only (see `HELD_RECEIPT_PROGRESS_STATES`); a semantic event describing the same progress
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
/**
 * Which `TRACE_KINDS` member this fact is, or `undefined` when it is an event rather than a trace.
 *
 * THE ONE SPELLING, and the reason the two tables are read in one place: `isHeldProgressFact` ("never a turn"), the
 * account's per-kind counter, and the declared population `initializedTraceKinds` all come from here, so a trace cannot be
 * counted under one kind and classified under another.
 */
export function factTraceKind(fact: WorldFact): string | undefined {
  if (fact.kind === "execution_receipt" && typeof fact.payload.state === "string")
    return fact.payload.state in HELD_RECEIPT_PROGRESS_STATES ? `receipt:${fact.payload.state}` : undefined;
  if (fact.kind === "semantic_event" && typeof fact.payload.kind === "string")
    return fact.payload.kind in HELD_SEMANTIC_PROGRESS_KINDS ? `semantic:${fact.payload.kind}` : undefined;
  return undefined;
}

/** The account's trace ledger, every declared kind present at zero: a member that stopped is a reading, not an absence. */
function initializedTraceKinds(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of TRACE_KINDS) counts[kind] = 0;
  return counts;
}

function isHeldProgressFact(fact: WorldFact): boolean {
  return factTraceKind(fact) !== undefined;
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
 * Is this fact one the HOST itself minted - a stale reading, a narration run, or the stall verdict it gives the Mod's own
 * decision its model-facing shape in?
 *
 * The population is `PUMP_MINTED_WAKE_KINDS`, which names every such kind and the path that publishes it, so a kind added
 * to either authority's table is classified without editing this predicate.
 */
function isDueFact(fact: WorldFact): boolean {
  const kind = fact.semanticKind;
  return fact.kind === "world_fact" && kind !== undefined && kind in PUMP_MINTED_WAKE_KINDS;
}

/**
 * The Mod's stall verdict this fact states, in the Mod's own words - or `undefined` when it states none.
 *
 * <p>
 * THE ONE PLACE THE VERDICT IS READ. The body controller mints it where it knows the answer
 * (`StardewBodyController.cs:1174`: `transition(Running, "stalled_waiting", "reason=entity_block;...;stalled_ticks=N")`),
 * so the reason and the wait are its own fields and this reader only names them. `waitedMs` is the Mod's own tick count at
 * the engine's own step (`STARDEW_TICKS_PER_SECOND`), never the Host's distance since a fact: a verdict that carries no
 * wait is not a measured stall, and says so by being absent here rather than by being announced with a zero.
 * </p>
 */
function modStallVerdictOf(
  fact: WorldFact,
): Readonly<{ actionId?: string; reason: string; waitedMs: number }> | undefined {
  if (fact.kind !== "execution_receipt") return undefined;
  if (fact.payload.reasonCode !== MOD_STALL_VERDICT_CODE) return undefined;
  const detail = evidenceDetailOf(fact.payload.evidence);
  const ticks = evidenceField(detail, "stalled_ticks");
  if (ticks === null || !/^\d+$/u.test(ticks)) return undefined;
  const actionId = typeof fact.payload.actionId === "string" ? fact.payload.actionId : undefined;
  return Object.freeze({
    ...(actionId === undefined ? {} : { actionId }),
    reason: evidenceField(detail, "reason") ?? MOD_STALL_VERDICT_CODE,
    waitedMs: Math.round((Number(ticks) * 1000) / STARDEW_TICKS_PER_SECOND),
  });
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
 * The execution states whose receipts PROVED an effect, the one authority saying so.
 *
 * <p>
 * `BODY_PROGRAM_PROOF_NODE_STATES` is the wire half of the Mod's own `provesEffect` rule
 * (`OpenBodyProgramJournalAuthority.TryComplete`: `outcome is Succeeded or PartiallySucceeded`), already used to decide
 * which node rows may carry evidence. A receipt that proved an effect is the plan WORKING, which is the difference the
 * steer classification turns on - so it is read from that declaration rather than spelled again here.
 * </p>
 */
const PROVED_EFFECT_STATES: ReadonlySet<string> = new Set<string>(BODY_PROGRAM_PROOF_NODE_STATES);

/**
 * Whether a receipt in this state says the plan it belongs to CANNOT CONTINUE - the population of `hasPreemptingFact`.
 *
 * <p>
 * DERIVED FROM TWO AUTHORITIES RATHER THAN LISTED, because a listed set fails open the day a state is added: a receipt
 * is stopped-plan iff the ledger says the execution can never resume (`TERMINAL_EXECUTION_STATES`, its single
 * classification) and the Mod's `provesEffect` rule says it proved no effect. Everything else is progress - the three
 * in-flight states, and the two that prove the step did something.
 * </p>
 * <p>
 * THE STALL IS ALREADY HERE, and that is worth stating because the ruling used to name it separately: the live Mod's
 * stall verdict is a `failed` receipt - the watchdog times out and calls `Fail(StallRefusalCode(...))`
 * (`StardewBodyController.cs`), so it arrives with `native_path_ended` or `path_blocked_by_character:<name>` and no
 * special case is needed. The non-terminal `stalled_waiting` receipt this file still names (`MOD_STALL_VERDICT_CODE`) is
 * no longer minted: `WorldInterruptionTests.cs` pins its absence from the body loop, because the wait itself is body
 * state. A branch for it would be a branch nothing can reach.
 * </p>
 * <p>
 * `cancelled` IS THE ONE STATE THE TABLE CANNOT DECIDE ALONE: a cancel SHE asked for is already in her own tool result,
 * so announcing it would interrupt a running thought with something she herself said; one the Mod performed is an
 * obstruction she has not been told about. The record holds the un-narrowed reading - the direction that cannot lose an
 * outcome - and `isPreemptingFact` applies the one narrowing the payload supports.
 * </p>
 */
export const PREEMPTING_EXECUTION_STATES: Readonly<Record<ExecutionState, boolean>> = Object.freeze(
  Object.fromEntries(
    EXECUTION_STATES.map((state) => [state, isTerminalExecutionState(state) && !PROVED_EFFECT_STATES.has(state)]),
  ) as Record<ExecutionState, boolean>,
);

/**
 * The reason code that says a cancellation was HER OWN ASK rather than the Mod's verdict.
 *
 * <p>
 * The payload DOES say which cancel a `cancelled` receipt is, so this is read rather than guessed. The Host's only
 * production cancel is the `stardew_stop_action` tool, and it sends this code (`game-tools.ts`); the Mod keys its own
 * refusal gate on the same token (`farmhandexecutioncontroller.cs#ModelStopReasonCode`) and echoes whatever the stop
 * request carried straight onto the receipt it mints. Anything else on a `cancelled` receipt - `no_active_execution`, a
 * superseded night that had not begun - is the Mod deciding, and that is news.
 * </p>
 * <p>
 * The player's own STOP is NOT one of these and does not need to be: an interruption after a native side effect settles
 * `Uncertain`, never `Cancelled`, which is the Mod's own stated distinction at `ModelStopReasonCode`.
 * </p>
 */
export const MODEL_STOP_REASON_CODE = "model_stop_requested";

/**
 * Whether this fact says the plan the running turn is working on has STOPPED - the one thing a steer exists for.
 *
 * <p>
 * Exported so the classification's population can be exercised through the real predicate instead of a second copy of
 * the rule: `event-pump.steer-preemption.test.ts` walks `EXECUTION_STATES` through this function and through the pump's
 * own getter, which are two paths, and fails by name on the member where they disagree.
 * </p>
 */
export function isPreemptingFact(fact: WorldFact): boolean {
  if (fact.kind !== "execution_receipt") return false;
  const state = fact.payload.state;
  // `Object.hasOwn` rather than a bare index: the payload is wire data, and `in`/`[]` would read a prototype member
  // (`constructor`) as a classification.
  if (typeof state !== "string" || !Object.hasOwn(PREEMPTING_EXECUTION_STATES, state)) return false;
  if (!PREEMPTING_EXECUTION_STATES[state as ExecutionState]) return false;
  return !(state === "cancelled" && fact.payload.reasonCode === MODEL_STOP_REASON_CODE);
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
 *
 * The ORDER of the members is not content, and the fact's `payload` is the parsed frame the Mod sent, so its member
 * order is the Mod's byte layout rather than anything she was told: two frames carrying ONE statement in two layouts
 * have to be one identity here, or a re-serialised payload opens a turn to repeat what she already had.
 */
export function factContentIdentity(fact: WorldFact): string {
  const {
    eventId: _eventId,
    sourceEventId: _sourceEventId,
    correlationId: _correlationId,
    occurredAtMs: _occurredAtMs,
    ...stable
  } = fact;
  return canonicalFactJson(stable);
}

/**
 * What a READING says, as a comparable string: the snapshot's own payload, canonically ordered.
 *
 * <p>
 * The reading's content is its PAYLOAD - the clock, the day, the weather, the location, the tile, the body, the
 * neighbourhood and the target families, which is exactly what `fact-brief.ts` renders into the block. The envelope is
 * not content: `observedTick` advances on every publish, `occurredAtMs` and the provenance ids are minted per frame, and
 * `revision` is the Mod's action-echo counter (`farmhandexecutioncontroller.cs:1779`). `canonicalFactJson` already drops
 * `revision` and `tick` at every depth, so a payload that was re-published under a new revision and a new tick has the
 * same identity here - which is what makes "she has already read this" answerable without trusting either number.
 * </p>
 *
 * <p>
 * ONE spelling, used by the two questions that are really one: is the block's header allowed to say `本轮无新观察`
 * (`#worldStateReading`), and has the probe budget for this reading been spent (`#worldStateRefreshFor`, beside the second
 * key `AUTO_OBSERVE_REARM.worldMoved`). The third
 * question this used to answer - does the reading open a turn - is gone with the opener: a reading is standing state.
 * </p>
 */
export function readingContentIdentity(fact: WorldFact): string {
  return canonicalFactJson(fact.payload);
}

/**
 * The statement a fact makes, as one string, with the member order decided HERE rather than inherited from the frame.
 *
 * <p>
 * `JSON.stringify` writes an object's members in insertion order - which for a parsed payload is whichever order the
 * producer's compiler laid the record out in. An identity computed over that is an identity of the ENCODING: the same
 * settlement published by two builds, or by one build whose record was reordered, reads as two facts, and the pump
 * pays a provider turn to say the second one. Measured 2026-11-11: the Mod's own snapshot gate failed on the same
 * twelve thousand values laid out differently, `targetId` moved from the front of its row to the back.
 * </p>
 * <p>
 * Members are therefore ordered by ordinal name at every depth. Arrays keep their order: a list of rows is a sequence
 * the producer arranged, and reordering it is a different statement.
 * </p>
 */
function canonicalFactJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalFactJson(entry)).join(",")}]`;
  const members: string[] = [];
  for (const key of Object.keys(value as Readonly<Record<string, unknown>>).sort()) {
    if (key === "tick" || key === "revision") continue;
    const member = (value as Readonly<Record<string, unknown>>)[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${canonicalFactJson(member)}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * The narration run the `published`-th narration fact waits for.
 *
 * The first waits `NARRATION_WITHOUT_WORK_TURNS`; each later one waits `NARRATION_REARM_MULTIPLE` more of the same
 * run, for the same reason the stall re-arms: saying the same thing every turn spends the run on one reading.
 */
function narrationWithoutWorkThreshold(published: number): number {
  return NARRATION_WITHOUT_WORK_TURNS * (1 + published * (NARRATION_REARM_MULTIPLE - 1));
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
