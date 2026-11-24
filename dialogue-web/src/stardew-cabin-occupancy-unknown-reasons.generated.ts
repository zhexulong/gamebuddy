// GENERATED FILE - do not edit.
// Regenerate: node tools/generate-vocabulary.mjs --contract contracts/stardew-cabin-occupancy-unknown-reasons.v1.json --write
export const CABIN_OCCUPANCY_UNKNOWN_REASONS = [
  "session_document_missing",
  "session_document_unreadable",
  "session_document_unauthenticated",
  "session_document_stale",
  "session_document_clock_ahead",
  "session_document_other_world",
  "session_host_not_ready",
  "session_protocol_mismatch",
  "manifest_farmhand_unavailable",
] as const;

/** Every way the Mod's own session document can fail to decide whether this save holds the companion: each member names the layer that failed, and `manifest_farmhand_unavailable` is the one that is about the manifest rather than the document. */
export type CabinOccupancyUnknownReason = (typeof CABIN_OCCUPANCY_UNKNOWN_REASONS)[number];
