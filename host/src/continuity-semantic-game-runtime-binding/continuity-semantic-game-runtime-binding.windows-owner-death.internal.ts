import type { ProductionGameOwner } from "../continuity-semantic-store/continuity-semantic-production-store.js";

export type WindowsOwnerDeathVerification = Readonly<{
  readonly __windowsOwnerDeathVerification: unique symbol;
}>;

export type WindowsOwnerDeathOutcome = "proven_dead" | "alive" | "mismatch" | "ambiguous" | "unavailable";

type Record = Readonly<{ owner: ProductionGameOwner; outcome: WindowsOwnerDeathOutcome }>;
const records = new WeakMap<object, Record>();

export function mintWindowsOwnerDeathVerification(
  owner: ProductionGameOwner,
  outcome: WindowsOwnerDeathOutcome,
): WindowsOwnerDeathVerification {
  const verification = Object.freeze(Object.create(null)) as WindowsOwnerDeathVerification;
  records.set(verification, Object.freeze({ owner: Object.freeze({ ...owner }), outcome }));
  return verification;
}

export function readWindowsOwnerDeathVerification(
  value: unknown,
): Readonly<{ owner: ProductionGameOwner; outcome: WindowsOwnerDeathOutcome }> {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value))
    throw new Error("windows_owner_death_verification_invalid");
  const record = records.get(value);
  if (!record) throw new Error("windows_owner_death_verification_invalid");
  return record;
}
