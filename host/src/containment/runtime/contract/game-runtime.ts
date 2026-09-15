/** Stable game-facing contract for the generic contained game runtime. */

export type ContainmentRole = string;

/** JSON-shaped game-owned facts; platform frame representations are not contract values. */
export type TypedPrivateGameFact =
  | string
  | number
  | boolean
  | null
  | readonly TypedPrivateGameFact[]
  | { readonly [key: string]: TypedPrivateGameFact };
export type TypedPrivateGameFacts = Readonly<Record<string, TypedPrivateGameFact>>;

/** A fresh, single role-launch operation. Its deadline is not the runtime lifetime. */
export type RoleLaunchOperation = Readonly<{
  readonly deadlineUnixMs: number;
}>;

/**
 * Game-owned producer callback. The callback receives an opaque typed/private
 * authorization capability; game facts never become part of the runtime result.
 */
export type TypedPrivateGameAuthorizationProducer = (
  authorization: (privateGameFacts: TypedPrivateGameFacts) => void,
) => void | Promise<void>;

export type RedactedRoleLaunchOutcome = Readonly<{
  readonly role: ContainmentRole;
  readonly status: "succeeded" | "failed";
}>;

export type RedactedContainmentOutcome = Readonly<{
  readonly role: ContainmentRole;
  readonly status: "succeeded" | "failed";
}>;

export type ContainedGameRuntime = Readonly<{
  launchRole(
    role: ContainmentRole,
    operation: RoleLaunchOperation,
    produceAuthorization: TypedPrivateGameAuthorizationProducer,
  ): Promise<RedactedRoleLaunchOutcome>;
  containRole(role: ContainmentRole): Promise<RedactedContainmentOutcome>;
  close(): Promise<void>;
}>;
