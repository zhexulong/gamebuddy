export type P4P5MountedTransitionAuthority = Readonly<{
  readonly __p4P5MountedTransitionAuthority: unique symbol;
}>;

export type P4P5MountedTransitionOperationAuthority = Readonly<{
  readonly __p4P5MountedTransitionOperationAuthority: unique symbol;
}>;

export type P4P5MountedTransitionOperationAuthorityLease = Readonly<{
  authority: P4P5MountedTransitionOperationAuthority;
  revoke(): void;
}>;

export type P4P5MountedTransitionAuthorityLease = Readonly<{
  authority: P4P5MountedTransitionAuthority;
  mintOperation(): P4P5MountedTransitionOperationAuthorityLease;
  revoke(): void;
}>;

type AuthorityRecord = { active: boolean };

const authorityRecords = new WeakMap<object, AuthorityRecord>();
const operationAuthorityRecords = new WeakMap<object, AuthorityRecord>();

/**
 * Coordinator-private authority for durable P4c/P5 transitions. Structural
 * attempt facts are insufficient: the authority is revoked when its mounted
 * lease begins closing.
 */
export function createP4P5MountedTransitionAuthority(): P4P5MountedTransitionAuthorityLease {
  const authority = Object.freeze(Object.create(null)) as P4P5MountedTransitionAuthority;
  const record: AuthorityRecord = { active: true };
  authorityRecords.set(authority, record);
  return Object.freeze({
    authority,
    mintOperation: (): P4P5MountedTransitionOperationAuthorityLease => {
      if (!record.active) throw new Error("p4_p5_transition_authority_unavailable");
      const operationAuthority = Object.freeze(Object.create(null)) as P4P5MountedTransitionOperationAuthority;
      const operationRecord: AuthorityRecord = { active: true };
      operationAuthorityRecords.set(operationAuthority, operationRecord);
      return Object.freeze({
        authority: operationAuthority,
        revoke: () => {
          operationRecord.active = false;
        },
      });
    },
    revoke: () => {
      record.active = false;
    },
  });
}

export function assertP4P5MountedTransitionAuthority(value: unknown): asserts value is P4P5MountedTransitionAuthority {
  if (typeof value !== "object" || value === null || authorityRecords.get(value)?.active !== true)
    throw new Error("p4_p5_transition_authority_unavailable");
}

export function assertP4P5MountedTransitionOperationAuthority(
  value: unknown,
): asserts value is P4P5MountedTransitionOperationAuthority {
  if (typeof value !== "object" || value === null || operationAuthorityRecords.get(value)?.active !== true)
    throw new Error("p4_p5_transition_operation_authority_unavailable");
}
