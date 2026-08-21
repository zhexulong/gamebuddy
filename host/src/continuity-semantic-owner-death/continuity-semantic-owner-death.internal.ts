/** Neutral owner tuple shared by the store and the Windows verifier leaf. */
export type OwnerDeathSubject = Readonly<{
  ownerToken: string;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
}>;

export type WindowsOwnerDeathVerification = Readonly<{
  readonly __windowsOwnerDeathVerification: unique symbol;
}>;

export type WindowsOwnerDeathOutcome = "proven_dead" | "alive" | "mismatch" | "ambiguous" | "unavailable";

const WINDOWS_UTC_CREATION_DATE_TICKS = /^[1-9][0-9]{0,18}$/;
const MAX_DATETIME_TICKS = 3155378975999999999n;

/** Canonical decimal .NET UTC `DateTime.Ticks` emitted by the Windows owner query. */
export function isCanonicalWindowsProcessStartIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    WINDOWS_UTC_CREATION_DATE_TICKS.test(value) &&
    BigInt(value) <= MAX_DATETIME_TICKS
  );
}

type Record = Readonly<{ owner: OwnerDeathSubject; outcome: WindowsOwnerDeathOutcome }>;
const records = new WeakMap<object, Record>();

export function mintWindowsOwnerDeathVerification(
  owner: OwnerDeathSubject,
  outcome: WindowsOwnerDeathOutcome,
): WindowsOwnerDeathVerification {
  const verification = Object.freeze(Object.create(null)) as WindowsOwnerDeathVerification;
  records.set(verification, Object.freeze({ owner: Object.freeze({ ...owner }), outcome }));
  return verification;
}

/**
 * Opaque fresh OS evidence is process-local and one-shot. Store recovery consumes it
 * immediately; no verification object or record is serializable or durable, preventing replay.
 */
export function readWindowsOwnerDeathVerification(
  value: unknown,
): Readonly<{ owner: OwnerDeathSubject; outcome: WindowsOwnerDeathOutcome }> {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value))
    throw new Error("windows_owner_death_verification_invalid");
  const record = records.get(value);
  if (!record) throw new Error("windows_owner_death_verification_invalid");
  records.delete(value);
  return record;
}
