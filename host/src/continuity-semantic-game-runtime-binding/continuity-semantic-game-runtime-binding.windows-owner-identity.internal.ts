import type { OpaqueRuntimeOwnerIdentity } from "./continuity-semantic-game-runtime-binding.internal.js";

export type WindowsRuntimeOwnerIdentityPort = Readonly<{
  createCurrentProcessOwnerIdentity(): Promise<OpaqueRuntimeOwnerIdentity>;
  readonly __windowsRuntimeOwnerIdentityPort: unique symbol;
}>;

const portBrand = new WeakSet<object>();

/** Construction-zone/test-support helper. It is not exported by the public provider module. */
export function brandWindowsRuntimeOwnerIdentityPort(
  port: Readonly<{ createCurrentProcessOwnerIdentity(): Promise<OpaqueRuntimeOwnerIdentity> }>,
): WindowsRuntimeOwnerIdentityPort {
  if (typeof port !== "object" || port === null || typeof port.createCurrentProcessOwnerIdentity !== "function")
    throw new Error("invalid_windows_runtime_owner_identity_port");
  const branded = Object.freeze({
    createCurrentProcessOwnerIdentity: port.createCurrentProcessOwnerIdentity,
  }) as WindowsRuntimeOwnerIdentityPort;
  portBrand.add(branded);
  return branded;
}

export function assertWindowsRuntimeOwnerIdentityPort(
  value: unknown,
): asserts value is WindowsRuntimeOwnerIdentityPort {
  if (typeof value !== "object" || value === null || !portBrand.has(value) || !Object.isFrozen(value))
    throw new Error("invalid_windows_runtime_owner_identity_port");
}
