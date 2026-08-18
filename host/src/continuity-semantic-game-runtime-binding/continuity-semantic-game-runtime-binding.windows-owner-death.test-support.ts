import type { ProductionGameOwner } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  mintWindowsOwnerDeathVerification,
  type WindowsOwnerDeathOutcome,
  type WindowsOwnerDeathVerification,
} from "./continuity-semantic-game-runtime-binding.windows-owner-death.internal.js";

/** Test-only deterministic OS verifier result; production always queries Windows. */
export function createTestWindowsOwnerDeathVerification(
  owner: ProductionGameOwner,
  outcome: WindowsOwnerDeathOutcome,
): WindowsOwnerDeathVerification {
  return mintWindowsOwnerDeathVerification(owner, outcome);
}
