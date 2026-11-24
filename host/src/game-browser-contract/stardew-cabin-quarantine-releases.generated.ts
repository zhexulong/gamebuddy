// GENERATED FILE - do not edit.
// Regenerate: node tools/generate-vocabulary.mjs --contract contracts/stardew-cabin-quarantine-releases.v1.json --write
import { type Static, Type } from "typebox";

/** What the press that asks whether this save holds the companion did with the answer it read: `not_licensed` licenses nothing, and the four refusals are the release's own assertions, one name each. */
export const StardewCabinQuarantineReleaseV1 = Type.Union([
  Type.Literal("released"),
  Type.Literal("not_licensed"),
  Type.Literal("record_is_not_the_quarantined_attempt"),
  Type.Literal("registration_names_another_attempt"),
  Type.Literal("guardian_objects_not_proven_dead"),
  Type.Literal("evidence_not_fresh_for_this_world"),
]);
export type StardewCabinQuarantineReleaseV1 = Static<typeof StardewCabinQuarantineReleaseV1>;
