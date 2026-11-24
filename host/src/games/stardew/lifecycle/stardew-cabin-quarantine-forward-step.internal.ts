import type { StardewCabinOccupancy, StardewCabinOccupancyUnknownReason } from "../../../stardew-attachment.js";

/**
 * What a player-asked cabin-occupancy probe licenses the Host to do with the attempt a cabin press
 * quarantined.
 *
 * The quarantine this decides is the one `confirmCabinChoice` writes when its signed manifest WAS
 * admitted and the attach that follows it refused (`stardew_cabin_publication_uncertain`). That
 * record is terminal for a measured reason: a second signed manifest into the same world is the
 * double binding the rule exists to prevent (`.tmp/lane-quarantinewhy.md` §5). Releasing it was
 * therefore never a matter of trying again - it is a matter of proving that the first publication
 * did NOT take effect in the save, which is what the Mod's own advertisement answers.
 *
 * This function is the ONE mapping, so the surface cannot invent a fourth answer and the release
 * cannot be reached from any other reading: `not_bound` is the only answer that releases, and it is
 * only reachable from a document the probe had already refused to trust if it was stale, forged,
 * unreadable, of another world, or published while the host was not ready.
 */
export type StardewCabinQuarantineStep =
  /** The save does not hold her: the publication did not take effect, so the held attempt may be released and the cabin choice offered again. */
  | Readonly<{ step: "release_and_offer_cabin" }>
  /** The save does hold her: the handoff is over and the surface states where she is - nothing is released. */
  | Readonly<{ step: "advance_to_moved_in"; cabinId: string }>
  /** Nothing moves, and the reason is named rather than left to the player to guess. */
  | Readonly<{ step: "stay_quarantined_with_reason"; reason: StardewCabinQuarantineStayReason }>;

/** Every reason the probe's answer leaves the quarantine exactly where it is. */
export type StardewCabinQuarantineStayReason =
  | StardewCabinOccupancyUnknownReason
  /** The attempt in hand is not the publication quarantine: this probe is not evidence about it. */
  | "record_is_not_a_publication_quarantine";

/**
 * The attempt states this decision is asked about.
 *
 * Only one of them is the cabin press's quarantine. The others are shipped as a member rather than
 * left to a boolean so a caller cannot pass "quarantined" for an attempt that was quarantined by the
 * launch rail, whose native state is unknown for a different reason and whose records never carried
 * an admitted manifest.
 */
export type StardewCabinQuarantineRecord = "publication_uncertain_quarantine" | "other_attempt_state";

/**
 * The one mapping from the probe's answer to the step, in the order the evidence wins:
 *
 * 1. `already_bound` first, because she being in the save is a fact about the player's world and not
 *    about a record: it decides the surface wherever it is found. The record keeps its quarantine
 *    either way - releasing it here is exactly the second manifest.
 * 2. Any other record than the publication quarantine stops here: the probe answers a question about
 *    the cabin press, and no other attempt may be moved by it.
 * 3. `unknown` and everything it names keeps the attempt where it is.
 * 4. `not_bound` - and only a LIVE document about THIS save that holds neither her nor the farmhand
 *    the admitted manifest named can say that - releases.
 */
export function decideStardewCabinQuarantineStep(
  evidence: Readonly<{ occupancy: StardewCabinOccupancy; record: StardewCabinQuarantineRecord }>,
): StardewCabinQuarantineStep {
  if (evidence.occupancy.status === "already_bound")
    return Object.freeze({ step: "advance_to_moved_in" as const, cabinId: evidence.occupancy.cabinId });
  if (evidence.record !== "publication_uncertain_quarantine")
    return Object.freeze({
      step: "stay_quarantined_with_reason" as const,
      reason: "record_is_not_a_publication_quarantine" as const,
    });
  if (evidence.occupancy.status === "unknown")
    return Object.freeze({ step: "stay_quarantined_with_reason" as const, reason: evidence.occupancy.reason });
  return Object.freeze({ step: "release_and_offer_cabin" as const });
}
