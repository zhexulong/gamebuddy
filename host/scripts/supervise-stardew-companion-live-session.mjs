import { gateProductionCompanionLiveEvidence } from "../../tools/lib/stardew-companion-live-evidence.mjs";

const PROBE_SCHEMA = "gamebuddy-stardew-companion-admission-probe/v1";
const PHASE_B_SCHEMA = "gamebuddy-stardew-companion-phase-b-supervision/v1";

/**
 * Phase A remains deliberately read-only. It cannot select a launcher or
 * receive control material, so it can publish only this redacted block.
 */
export async function superviseStardewCompanionAdmissionProbe(input = undefined) {
  if (input !== undefined) throw new Error("admission_supervisor_override_forbidden");
  return Object.freeze({ schema: PROBE_SCHEMA, state: "blocked", reasonCode: "companion_live_source_attestation_unavailable" });
}

/** Read-only real-run gate. It receives no launch/control material and can only assess a redacted artifact. */
export async function superviseNativeChatLiveEvidence(input = undefined) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "artifactText,productionArtifactReady,runbookPreflightReady")
    throw new Error("native_chat_live_evidence_input_invalid");
  const result = gateProductionCompanionLiveEvidence(input);
  return Object.freeze({ schema: PHASE_B_SCHEMA, phase: "B", ...result });
}

/**
 * Phase B deliberately owns no launcher or control material. Real session
 * supervision remains blocked pending its separately frozen source/topology
 * authority contract.
 */
export async function superviseFarmhandSessionPhaseB() {
  return Object.freeze({ schema: PHASE_B_SCHEMA, phase: "B", state: "blocked", reasonCode: "phase_b_production_launcher_unavailable" });
}
