// GENERATED FILE - do not edit.
// Regenerate: node tools/generate-vocabulary.mjs --contract contracts/stardew-cabin-occupancy-unknown-reasons.v1.json --write
import { type Static, Type } from "typebox";

/** Every way the Mod's own session document can fail to decide whether this save holds the companion: each member names the layer that failed, and `manifest_farmhand_unavailable` is the one that is about the manifest rather than the document. */
export const StardewCabinOccupancyUnknownReasonV1 = Type.Union([
  Type.Literal("session_document_missing"),
  Type.Literal("session_document_unreadable"),
  Type.Literal("session_document_unauthenticated"),
  Type.Literal("session_document_stale"),
  Type.Literal("session_document_clock_ahead"),
  Type.Literal("session_document_other_world"),
  Type.Literal("session_host_not_ready"),
  Type.Literal("session_protocol_mismatch"),
  Type.Literal("manifest_farmhand_unavailable"),
]);
export type StardewCabinOccupancyUnknownReasonV1 = Static<typeof StardewCabinOccupancyUnknownReasonV1>;
