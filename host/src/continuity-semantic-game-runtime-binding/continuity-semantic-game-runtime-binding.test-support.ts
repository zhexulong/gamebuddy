import {
  brandRuntimeOwnerIdentity,
  type OpaqueRuntimeOwnerIdentity,
} from "./continuity-semantic-game-runtime-binding.internal.js";
import {
  brandWindowsRuntimeOwnerIdentityPort,
  type WindowsRuntimeOwnerIdentityPort,
} from "./continuity-semantic-game-runtime-binding.windows-owner-identity.internal.js";

/** Test graph only: deterministic proof factory, never emitted in production artifacts. */
export function createTestRuntimeOwnerIdentity(
  processId = process.pid,
  creationTime100ns = "1",
): OpaqueRuntimeOwnerIdentity {
  return brandRuntimeOwnerIdentity({ processId, creationTime100ns });
}

/** Test graph only: deterministic branded port factory, never emitted in production artifacts. */
export function createTestWindowsRuntimeOwnerIdentityPort(
  proof: () => Promise<OpaqueRuntimeOwnerIdentity> | OpaqueRuntimeOwnerIdentity = () =>
    createTestRuntimeOwnerIdentity(),
): WindowsRuntimeOwnerIdentityPort {
  return brandWindowsRuntimeOwnerIdentityPort({ createCurrentProcessOwnerIdentity: async () => proof() });
}
