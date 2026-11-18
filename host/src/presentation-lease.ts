/**
 * Which facts the player's surface can SHOW, declared once for the two layers that have to agree about it.
 *
 * <p>
 * THE SAME QUESTION WAS BEING ASKED IN ONE PLACE ONLY. `CompanionLoop` decides, per batch, whether a presentation lineage
 * may be opened (`canonicalPresentationSource`), and that answer is the difference between a bubble the player sees and
 * text nobody ever will (`no_presentation_lease`). The pump, one layer below, decides whether a turn exists at all - so
 * "this fact can present" has to be ONE reading, not a belief in the pump and a white-list in the loop that can drift
 * apart. MEASURED 2026-11-17 (`round66`, ten minutes): 21 turns opened, 15 admitted, 6 `admitted:false` - and every one of
 * the six carried exactly `["execution_receipt","snapshot"]`, i.e. a node's terminal receipt with nothing the surface was
 * ever told about. `lost 8 {no_presentation_lease: 8}` is what that costs.
 * </p>
 * <p>
 * THE IDENTITY IS OPAQUE, AND THAT IS PART OF THE PREDICATE. A lease is not "the fact's kind is on the list": it is that
 * kind carrying a token both the lease (`isOpaqueSource`) and the Game lineage (`GameTurnLineageTracker.beginPlayerBatch`,
 * `[A-Za-z0-9_-]{1,128}`) accept. A `:` in it does not fail loudly - it makes the turn silent, which is how the round40
 * run lost its answers to settled plans.
 * </p>
 */

/**
 * White-listed fact kinds allowed to mint a bounded presentation lease.
 *
 * DECLARED, not written inside the predicate, because a gate has to read the same population this decision reads: a test
 * that typed the kinds out again could agree with a stale copy and disagree with the loop.
 *
 * Two families qualify, and a member is added only with the sentence that justifies it.
 *
 * SENSORY. `day_started` / `time_milestone` are the Mod's own salient events. `companion_arrival` is the
 * Host's (see `companion-arrival-fact.ts`): she has just arrived on the farm and the world clock gave its
 * first reading, the one proactive turn the product owes the player at arrival. `native_notice` is the
 * Host's too (`native-notice-fact.ts`): the game itself said something about the hour and the companion
 * may answer it out loud. `night_ended_pass_out` is the Mod's verdict on how the night ended. Each rides
 * the lease for the same reason - a reply that reaches the model but not the chat is a decision the
 * player never sees.
 *
 * OUTCOME. `program_settled` is the one-line ledger of a plan that stopped (`program-settlement-digest.ts`).
 * The pump already treats a settlement as news that opens a turn (`event-pump.ts:isHeldProgressFact`:
 * it is deliberately NOT held); without a lease the answer to that news was counted - and lost - as text
 * nobody was shown. An outcome is not progress, so its volume is one per program, never one per tile.
 *
 * Progress and every other world fact keep today's silence: the per-tile traffic (`route_progress`, the
 * receipt states) is what fills a session, and a bubble per harvested crop is not a companion.
 */
export const PRESENTATION_LEASE_KINDS = Object.freeze([
  "day_started",
  "time_milestone",
  "companion_arrival",
  "native_notice",
  "night_ended_pass_out",
  "program_settled",
] as const);

/** Does a fact of this kind open a bounded presentation lease? The ONE reading of the list above. */
export function opensPresentationLease(kind: string | undefined): boolean {
  return kind !== undefined && (PRESENTATION_LEASE_KINDS as readonly string[]).includes(kind);
}

/**
 * The only identity shape a presentation source may have: the Game lineage's own grammar.
 *
 * One spelling for both layers, because a source that satisfies the lease and one that satisfies the lineage have to be
 * the same string - `host-service.ts:beginPlayerBatch` refuses anything else.
 */
export function isOpaqueSource(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** What this reading needs of a fact: its kind, the Mod's own label for it, and the identity it would present under. */
export type PresentationCandidate = Readonly<{
  kind?: string;
  semanticKind?: string;
  sourceEventId?: string;
}>;

/**
 * The presentation identity this fact can mint, or `undefined` when the player's surface cannot show a turn opened on it.
 *
 * <p>
 * THE ONE READING OF "THIS FACT CAN REACH THE PLAYER". A `world_fact` whose `semanticKind` is on the lease list and whose
 * `sourceEventId` is an opaque token is the only shape that can: a `snapshot` is standing state, a `semantic_event` is a
 * trace, a `lifecycle` event is the transport speaking, and an `execution_receipt` has no event identity on the wire at all
 * (`protocol/bridge-v1.schema.json#receipt`: `executionId`, `requestId`, `state`, `evidence`, `origin` - there is nothing to
 * present under). A receipt can therefore never be shown, and no Host-side list can change that.
 * </p>
 */
export function presentationSourceOf(fact: PresentationCandidate): string | undefined {
  if (fact.kind !== "world_fact" || !opensPresentationLease(fact.semanticKind)) return undefined;
  return isOpaqueSource(fact.sourceEventId) ? fact.sourceEventId : undefined;
}
