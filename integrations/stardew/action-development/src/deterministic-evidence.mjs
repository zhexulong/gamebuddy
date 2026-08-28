import {
  beginEvidenceRun,
  finalizeEvidenceRun,
  finalizeIncompleteEvidenceRun,
} from "@gamebuddy/game-action-devkit";
import { runDeterministicScenario } from "./deterministic-scenario.mjs";

function fail(code) {
  throw new Error(`stardew_action_deterministic_evidence_${code}`);
}

function evidenceIdentity(identity) {
  if (identity === null || typeof identity !== "object") fail("invalid_identity");
  for (const key of ["gameId", "actionId", "runId", "stage", "profileIdentity", "claimScope"]) {
    if (typeof identity[key] !== "string") fail("invalid_identity");
  }
  return Object.freeze({ gameId: identity.gameId, actionId: identity.actionId, runId: identity.runId });
}

function redactedMetadata(identity, verdict) {
  return Object.freeze({
    evidenceKind: "deterministic_fake_backend",
    stage: identity.stage,
    profileIdentity: identity.profileIdentity,
    claimScope: identity.claimScope,
    terminalVerdict: verdict,
  });
}

/**
 * Runs only the package-local fake scenario and records its process-plumbing outcome.
 * This evidence is explicitly non-live and must never authorize publication or target-runtime claims.
 */
export async function runDeterministicScenarioWithEvidence({ identity, evidenceRoot, mode = "valid", timeoutMs } = {}) {
  const run = await beginEvidenceRun({ root: evidenceRoot, identity: evidenceIdentity(identity) });
  try {
    const outcome = await runDeterministicScenario({ identity, mode, timeoutMs });
    const bundle = await finalizeEvidenceRun(run, {
      status: "complete",
      verdict: "passed",
      metadata: redactedMetadata(identity, outcome.result.verdict),
    });
    return Object.freeze({ outcome, bundle });
  } catch (error) {
    try {
      await finalizeIncompleteEvidenceRun(run, {
        verdict: "failed",
        metadata: redactedMetadata(identity, "failed"),
      });
    } catch {
      // The caller still receives the deterministic scenario's primary failure.
    }
    throw error;
  }
}
