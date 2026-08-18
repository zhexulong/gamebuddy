const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Accepts only a direct-child attestation sequence proving that a native STOP
 * sealed a Pi batch that was active at the seal boundary.
 */
export function createActiveStopProofVerifier(launchBindingSha256) {
  if (!SHA256.test(launchBindingSha256)) throw new Error("active_stop_proof_binding_invalid");

  let runtimeInstanceSha256;
  let activeBatchSha256;
  let proof;
  let failed = false;

  const fail = () => {
    failed = true;
  };
  const sameRuntime = (evidence) => {
    if (runtimeInstanceSha256 === undefined) {
      runtimeInstanceSha256 = evidence.runtimeInstanceSha256;
      return true;
    }
    return runtimeInstanceSha256 === evidence.runtimeInstanceSha256;
  };
  const sameProof = (evidence) =>
    proof !== undefined &&
    proof.batchIdSha256 === evidence.batchIdSha256 &&
    proof.stopIdSha256 === evidence.stopIdSha256 &&
    proof.epoch === evidence.epoch;

  return Object.freeze({
    accept(evidence) {
      if (failed) return false;
      if (evidence.launchBindingSha256 !== launchBindingSha256 || !sameRuntime(evidence)) {
        fail();
        return false;
      }
      switch (evidence.kind) {
        case "pi_turn_accepted":
          if (proof !== undefined || activeBatchSha256 !== undefined || evidence.batchIdSha256 === null) {
            fail();
            return false;
          }
          activeBatchSha256 = evidence.batchIdSha256;
          return true;
        case "pi_turn_settled":
          if (activeBatchSha256 === undefined || evidence.batchIdSha256 !== activeBatchSha256) {
            fail();
            return false;
          }
          activeBatchSha256 = undefined;
          return true;
        case "native_stop_all_observed":
          if (proof !== undefined || evidence.stopIdSha256 === null) {
            fail();
            return false;
          }
          proof = Object.freeze({
            batchIdSha256: undefined,
            stopIdSha256: evidence.stopIdSha256,
            epoch: undefined,
            nativeObserved: true,
            sealed: false,
            settled: false,
            oldEpochQuiet: false,
            bodySettled: false,
          });
          return true;
        case "stop_sealed":
          if (
            proof === undefined ||
            !proof.nativeObserved ||
            proof.sealed ||
            evidence.batchIdSha256 === null ||
            evidence.batchIdSha256 !== activeBatchSha256 ||
            evidence.stopIdSha256 !== proof.stopIdSha256 ||
            evidence.epoch === null
          ) {
            fail();
            return false;
          }
          proof = Object.freeze({ ...proof, batchIdSha256: evidence.batchIdSha256, epoch: evidence.epoch, sealed: true });
          return true;
        case "stop_settled":
          if (proof === undefined || !proof.sealed || proof.settled || !sameProof(evidence)) {
            fail();
            return false;
          }
          proof = Object.freeze({ ...proof, settled: true });
          return true;
        case "old_epoch_quiet":
          if (proof === undefined || !proof.settled || proof.oldEpochQuiet || !sameProof(evidence)) {
            fail();
            return false;
          }
          proof = Object.freeze({ ...proof, oldEpochQuiet: true });
          return true;
        case "body_settled":
          if (proof === undefined || !proof.settled || proof.bodySettled || !sameProof(evidence)) {
            fail();
            return false;
          }
          proof = Object.freeze({ ...proof, bodySettled: true });
          return true;
        case "stop_uncertain":
          fail();
          return false;
        default:
          return true;
      }
    },
    result() {
      return !failed && proof !== undefined && proof.sealed && proof.settled && proof.oldEpochQuiet && proof.bodySettled;
    },
  });
}
