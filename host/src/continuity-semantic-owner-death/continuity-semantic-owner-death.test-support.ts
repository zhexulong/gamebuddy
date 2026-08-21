import {
  mintWindowsOwnerDeathVerification,
  type OwnerDeathSubject,
  type WindowsOwnerDeathOutcome,
  type WindowsOwnerDeathVerification,
} from "./continuity-semantic-owner-death.internal.js";

/** Test-only deterministic OS verifier result; production always queries Windows. */
export function createTestWindowsOwnerDeathVerification(
  owner: OwnerDeathSubject,
  outcome: WindowsOwnerDeathOutcome,
): WindowsOwnerDeathVerification {
  return mintWindowsOwnerDeathVerification(owner, outcome);
}
