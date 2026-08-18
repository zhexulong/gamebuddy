#!/usr/bin/env node
/**
 * Non-mutating M4 preflight. It verifies the frozen producer→consumer→verifier
 * handoff and intentionally stops before any bridge/native operation because
 * target-version decompilation correlation is unresolved.
 */
import { checkM4BreakRockSourceContract } from "./stardew-portfolio-m4-break-rock-source-contract.mjs";

export const M4_BREAK_ROCK_SOURCE_BLOCKER = "m4_target_version_decompilation_correlation";
export async function runM4BreakRockSourcePreflight() {
  const contract = await checkM4BreakRockSourceContract();
  return Object.freeze({
    state: "BLOCKED",
    action: contract.action,
    topology: "single_player_native_companion",
    mutationAttempted: false,
    producer: contract.producer,
    consumer: contract.consumer,
    verifier: contract.verifier,
    blocker: M4_BREAK_ROCK_SOURCE_BLOCKER,
    sourceFact:
      "The audit aid identifies ResourceClump health/destroy and separate Debris creation, but blocks target-version decompilation correlation, signed source-class selection, semantic ingress, and fresh-drop partition realization.",
    pickup: "not invoked; distinct existing/future action",
    liveClosure: "none",
  });
}
if (process.argv[1]?.endsWith("run-stardew-portfolio-m4-break-rock-source-preflight.mjs"))
  console.log(JSON.stringify(await runM4BreakRockSourcePreflight(), null, 2));
