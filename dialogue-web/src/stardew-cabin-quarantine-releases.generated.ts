// GENERATED FILE - do not edit.
// Regenerate: node tools/generate-vocabulary.mjs --contract contracts/stardew-cabin-quarantine-releases.v1.json --write
export const CABIN_QUARANTINE_RELEASES = [
  "released",
  "not_licensed",
  "record_is_not_the_quarantined_attempt",
  "registration_names_another_attempt",
  "guardian_objects_not_proven_dead",
  "evidence_not_fresh_for_this_world",
] as const;

/** What the press that asks whether this save holds the companion did with the answer it read: `not_licensed` licenses nothing, and the four refusals are the release's own assertions, one name each. */
export type CabinQuarantineRelease = (typeof CABIN_QUARANTINE_RELEASES)[number];
