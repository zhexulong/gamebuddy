import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
/** Independent deterministic-only verifier; it has no game, runner, or mutation dependency. */
export function verifyDeterministicBootstrapComposition(input) {
  try {
    const { handoffs, challengeSha256, mutationCalls = 0 } = input ?? {};
    if (!Array.isArray(handoffs) || handoffs.length !== 1 || mutationCalls !== 0 || !SHA256.test(challengeSha256 ?? ""))
      throw new Error();
    const handoff = handoffs[0];
    if (
      !handoff ||
      handoff.schema !== "gamebuddy-production-control-capability/v1" ||
      handoff.protocolVersion !== 1 ||
      typeof handoff.pipeName !== "string" ||
      typeof handoff.launchToken !== "string" ||
      !SHA256.test(handoff.launchBinding ?? "")
    )
      throw new Error();
    // The child control-server attestation is intentionally redacted: its
    // controlReady fact is the only public hello success projection.  The
    // verifier must not require a parent-supplied raw runtime or fabricated
    // protocol transcript.
    const source = evidence;
    if (
      !source ||
      Object.keys(source).sort().join(",") !==
        "challengeSha256,controlReady,evidenceClass,launchBindingSha256,protocolVersion,runtimeInstanceSha256,schema" ||
      source.schema !== "gamebuddy-companion-bootstrap-evidence/v1" ||
      source.evidenceClass !== "deterministic_bootstrap_composition" ||
      source.protocolVersion !== 1 ||
      source.controlReady !== true ||
      source.challengeSha256 !== challengeSha256 ||
      source.launchBindingSha256 !== handoff.launchBinding ||
      !SHA256.test(source.runtimeInstanceSha256)
    )
      throw new Error();
    const serialized = JSON.stringify(source);
    if (
      serialized.includes(JSON.stringify(handoff.launchToken)) ||
      serialized.includes(JSON.stringify(handoff.pipeName))
    )
      throw new Error();
    return "deterministic_bootstrap_composition_passed";
  } catch {
    return "deterministic_bootstrap_composition_failed";
  }
}
export function blockedDeterministicBootstrapComposition() {
  return "deterministic_bootstrap_composition_blocked";
}
function _digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
