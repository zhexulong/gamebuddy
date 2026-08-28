export type MountedTurnTransitionAuthority = Readonly<{
  readonly __mountedTurnTransitionAuthority: unique symbol;
}>;

export type MountedTurnTransitionOperationAuthority = Readonly<{
  readonly __mountedTurnTransitionOperationAuthority: unique symbol;
}>;

export type MountedTurnTransitionOperationAuthorityLease = Readonly<{
  authority: MountedTurnTransitionOperationAuthority;
  revoke(): void;
}>;

export type MountedTurnTransitionAuthorityLease = Readonly<{
  authority: MountedTurnTransitionAuthority;
  mintOperation(): MountedTurnTransitionOperationAuthorityLease;
  revoke(): void;
}>;

type AuthorityRecord = { active: boolean };

const authorityRecords = new WeakMap<object, AuthorityRecord>();
const operationAuthorityRecords = new WeakMap<object, AuthorityRecord>();

/**
 * Coordinator-private authority for durable mounted turn transitions. Structural
 * attempt facts are insufficient: the authority is revoked when its mounted
 * lease begins closing.
 */
export function createMountedTurnTransitionAuthority(): MountedTurnTransitionAuthorityLease {
  const authority = Object.freeze(Object.create(null)) as MountedTurnTransitionAuthority;
  const record: AuthorityRecord = { active: true };
  authorityRecords.set(authority, record);
  return Object.freeze({
    authority,
    mintOperation: (): MountedTurnTransitionOperationAuthorityLease => {
      if (!record.active) throw new Error("p4_p5_transition_authority_unavailable");
      const operationAuthority = Object.freeze(Object.create(null)) as MountedTurnTransitionOperationAuthority;
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

export function assertMountedTurnTransitionAuthority(value: unknown): asserts value is MountedTurnTransitionAuthority {
  if (typeof value !== "object" || value === null || authorityRecords.get(value)?.active !== true)
    throw new Error("p4_p5_transition_authority_unavailable");
}

export function assertMountedTurnTransitionOperationAuthority(
  value: unknown,
): asserts value is MountedTurnTransitionOperationAuthority {
  if (typeof value !== "object" || value === null || operationAuthorityRecords.get(value)?.active !== true)
    throw new Error("p4_p5_transition_operation_authority_unavailable");
}
