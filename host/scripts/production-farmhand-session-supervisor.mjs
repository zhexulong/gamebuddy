const WINDOWS_BLOCKERS = Object.freeze([
  "ephemeral_farmhand_bridge_attachment_capability_source_unavailable",
  "ai_client_process_launch_ownership_unavailable",
  "native_farmhand_direct_child_launch_identity_proof_unavailable",
]);

/**
 * Fixed P7 production boundary. It intentionally has no source-owned launch,
 * attachment, or identity capability, so it can only report that gap.
 */
export async function superviseProductionFarmhandSession() {
  if (arguments.length !== 0) throw new Error("production_farmhand_supervisor_input_forbidden");

  return Object.freeze({
    schema: "production_farmhand_session_supervision/v1",
    evidenceClass: "production_farmhand_session_supervision",
    state: "blocked",
    topology: "native_ai_farmhand_multiplayer",
    blockerFacts: process.platform === "win32"
      ? WINDOWS_BLOCKERS
      : Object.freeze(["windows_unsupported"]),
  });
}
