import {
  beginEvidenceRun,
  finalizeEvidenceRun,
  finalizeIncompleteEvidenceRun,
  readLatestEvidenceStatus,
} from "@gamebuddy/game-action-devkit";
import { createImmutableReleaseBundleBinding } from "./immutable-release-bundle.mjs";
import { runEquipToolLifecycle } from "./equip-tool-lifecycle.mjs";
import { consumeReadyEquipToolProfile, preflightEquipTool } from "./equip-tool-preflight.mjs";
import { acquireTargetRuntimeLease } from "./target-runtime-lease.mjs";
import { validateEquipToolScenarioProof } from "./equip-tool-scenario-result.mjs";

const CLAIM_SCOPE = "native-local-equip-tool-v1";

function fail(code) {
  throw new Error(`stardew_equip_tool_live_${code}`);
}

function exactInvocation(invocation, { requireProfile, requireRunId }) {
  if (!invocation || invocation.actionId !== "equip_tool") fail("invalid_invocation");
  if (requireProfile && typeof invocation.profileFile !== "string") fail("profile_missing");
  if (requireRunId && (typeof invocation.runId !== "string" || invocation.runId.length === 0)) fail("run_id_missing");
}

const FAILURE_PREFIXES = Object.freeze([
  "stardew_immutable_release_bundle_",
  "stardew_equip_tool_lifecycle_",
  "stardew_target_runtime_lease_",
  "game_action_evidence_",
]);
function boundedFailureCode(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  for (const prefix of FAILURE_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return "unknown_failure";
}

function proofMetadata({ runId, profile, proof, bundleDigest, cleanupComplete, leaseReleased, stagingReleased }) {
  return Object.freeze({
    schema: "gamebuddy-stardew-equip-tool-live-proof/v1",
    runId,
    profileIdentity: profile.profileIdentity,
    targetVersion: profile.targetVersion,
    claimScope: CLAIM_SCOPE,
    request: proof.receipt.request,
    accepted: proof.receipt.accepted,
    terminal: proof.receipt.terminal,
    evidence: proof.receipt.evidence,
    postcondition: proof.postcondition,
    bundle: Object.freeze({ algorithm: "sha256", digest: bundleDigest }),
    cleanup: Object.freeze({ lifecycle: cleanupComplete, immutableStaging: stagingReleased, runtimeLease: leaseReleased }),
  });
}

async function runEquipToolLiveWithDependencies({ manifest, invocation, dependencies } = {}) {
  exactInvocation(invocation, { requireProfile: true, requireRunId: true });
  if (!manifest || manifest.gameId !== "stardew" || typeof manifest.evidenceRoot !== "string" || typeof manifest.baseDirectory !== "string") fail("manifest_invalid");
  const deps = {
    preflight: preflightEquipTool,
    consumeReadyProfile: consumeReadyEquipToolProfile,
    acquireLease: acquireTargetRuntimeLease,
    beginEvidence: beginEvidenceRun,
    finalizeComplete: finalizeEvidenceRun,
    finalizeIncomplete: finalizeIncompleteEvidenceRun,
    createBundle: createImmutableReleaseBundleBinding,
    runLifecycle: runEquipToolLifecycle,
    ...dependencies,
  };

  const preflight = await deps.preflight({ invocation, dependencies: dependencies?.preflightDependencies });
  if (preflight?.state !== "READY" || preflight.ready !== true || !preflight.bundle?.digest) {
    return Object.freeze({ gameId: "stardew", actionId: "equip_tool", status: "live", state: "BLOCKED", runId: invocation.runId, reasons: preflight?.reasons ?? ["preflight_not_ready"] });
  }
  const profile = deps.consumeReadyProfile(preflight);
  const identity = Object.freeze({ gameId: "stardew", actionId: "equip_tool", runId: invocation.runId });
  let lease;
  let evidence;
  let bundle;
  let proof;
  let lifecycleComplete = false;
  let stagingReleased = false;
  let leaseReleased = false;
  let failure;
  let failureStage = "lease_acquisition";

  try {
    lease = await deps.acquireLease({ root: profile.runtimeLeaseRoot, identity: profile.runtimeLeaseIdentity });
    failureStage = "evidence_begin";
    evidence = await deps.beginEvidence({ root: manifest.evidenceRoot, identity });
    failureStage = "immutable_bundle";
    bundle = await deps.createBundle({
      releaseDir: profile.releaseDir,
      modsPath: profile.modsPath,
      runRoot: profile.runtimeLeaseRoot,
      runIdentity: invocation.runId,
      expectedDigest: preflight.bundle.digest,
    });
    failureStage = "lifecycle";
    proof = await bundle.runLifecycle(
      ({ releaseDir }) => deps.runLifecycle({
        projectRoot: manifest.baseDirectory,
        profile,
        runId: invocation.runId,
        releaseDir,
        resultRoot: profile.runtimeLeaseRoot,
      }),
    );
    lifecycleComplete = true;
    failureStage = "immutable_cleanup";
    await bundle.close();
    stagingReleased = true;
    failureStage = "lease_release";
    await lease.release();
    leaseReleased = true;
  } catch (error) {
    failure = error;
  }

  if (!leaseReleased && lease) {
    try { await lease.release(); leaseReleased = true; }
    catch (error) { failureStage = "lease_release"; failure = failure ? new AggregateError([failure, error]) : error; }
  }

  const passed = !failure && proof?.verdict === "passed" && lifecycleComplete && stagingReleased && leaseReleased;
  const metadata = passed
    ? proofMetadata({ runId: invocation.runId, profile, proof, bundleDigest: preflight.bundle.digest, cleanupComplete: true, leaseReleased, stagingReleased })
    : Object.freeze({
      schema: "gamebuddy-stardew-equip-tool-live-incomplete/v1",
      runId: invocation.runId,
      profileIdentity: profile.profileIdentity,
      targetVersion: profile.targetVersion,
      claimScope: CLAIM_SCOPE,
      reason: failure ? "orchestration_failed" : "proof_not_passed",
      failureStage: failure ? failureStage : "proof_validation",
      failureCode: failure ? boundedFailureCode(failure) : "proof_not_passed",
      bundle: Object.freeze({ algorithm: "sha256", digest: preflight.bundle.digest }),
      cleanup: Object.freeze({ lifecycle: lifecycleComplete, immutableStaging: stagingReleased, runtimeLease: leaseReleased }),
    });

  if (!evidence) {
    fail(failure ? boundedFailureCode(failure) : "evidence_unavailable");
  }
  const finalized = passed
    ? await deps.finalizeComplete(evidence, { status: "complete", verdict: "passed", metadata })
    : await deps.finalizeIncomplete(evidence, { verdict: "uncertain", metadata });
  return Object.freeze({
    gameId: "stardew",
    actionId: "equip_tool",
    status: "live",
    state: passed ? "PASSED" : "INCOMPLETE",
    runId: invocation.runId,
    evidenceStatus: finalized.status,
    verdict: finalized.verdict,
    // The adapter never projects this action-owned payload. The registration
    // verifier consumes it before the result is reduced to the neutral report.
    ...(passed ? {
      verification: Object.freeze({
        receipt: proof.receipt,
        postcondition: proof.postcondition,
        cleanup: Object.freeze({ lifecycle: lifecycleComplete, immutableStaging: stagingReleased, runtimeLease: leaseReleased }),
        reasonCode: proof.reasonCode,
      }),
    } : {}),
  });
}

export async function runEquipToolLive({ manifest, invocation, dependencies } = {}) {
  exactInvocation(invocation, { requireProfile: true, requireRunId: true });
  if (!manifest || manifest.gameId !== "stardew" || typeof manifest.evidenceRoot !== "string" || typeof manifest.baseDirectory !== "string") fail("manifest_invalid");
  if (dependencies !== undefined) fail("dependency_override_forbidden");
  return runEquipToolLiveWithDependencies({ manifest, invocation });
}

/** Test-only composition seam; production callers must use runEquipToolLive. */
export const __testOnly = Object.freeze({
  runEquipToolLive: runEquipToolLiveWithDependencies,
});

export function verifyEquipToolReceiptEvidencePostcondition({ actionId, invocation, result } = {}) {
  if (actionId !== "equip_tool" || !invocation || typeof invocation.runId !== "string") fail("verification_input_invalid");
  if (!result || result.gameId !== "stardew" || result.actionId !== actionId || result.runId !== invocation.runId) fail("verification_identity_mismatch");
  if (result.state !== "PASSED" || result.evidenceStatus !== "complete" || result.verdict !== "passed") fail("receipt_evidence_postcondition_invalid");
  const verification = result.verification;
  if (!verification || typeof verification !== "object" || verification.reasonCode !== "tool_selected") fail("receipt_evidence_postcondition_invalid");
  try {
    validateEquipToolScenarioProof({
      verdict: result.verdict,
      reasonCode: verification.reasonCode,
      receipt: verification.receipt,
      postcondition: verification.postcondition,
    });
  } catch {
    fail("receipt_evidence_postcondition_invalid");
  }
  return Object.freeze({ gameId: "stardew", actionId, runId: invocation.runId, verified: true });
}

export function verifyEquipToolCleanup({ actionId, invocation, result } = {}) {
  if (actionId !== "equip_tool" || !invocation || typeof invocation.runId !== "string") fail("cleanup_verification_input_invalid");
  if (!result || result.gameId !== "stardew" || result.actionId !== actionId || result.runId !== invocation.runId) fail("cleanup_verification_identity_mismatch");
  const cleanup = result.verification?.cleanup;
  if (result.state !== "PASSED" || result.evidenceStatus !== "complete" || result.verdict !== "passed"
    || cleanup?.lifecycle !== true || cleanup?.immutableStaging !== true || cleanup?.runtimeLease !== true) {
    fail("cleanup_incomplete");
  }
  return Object.freeze({ gameId: "stardew", actionId, runId: invocation.runId, complete: true });
}

export async function readEquipToolLiveStatus({ manifest, invocation, dependencies } = {}) {
  exactInvocation(invocation, { requireProfile: false, requireRunId: false });
  if (!manifest || manifest.gameId !== "stardew" || typeof manifest.evidenceRoot !== "string") fail("manifest_invalid");
  const readLatest = dependencies?.readLatestEvidence ?? readLatestEvidenceStatus;
  const observation = await readLatest({ root: manifest.evidenceRoot, gameId: "stardew", actionId: "equip_tool" });
  return Object.freeze({ gameId: "stardew", actionId: "equip_tool", status: "evidence", observation });
}
