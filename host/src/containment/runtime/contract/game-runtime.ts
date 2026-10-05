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

/**
 * Redacted terminal-settlement outcome. `settled` means every launched role was
 * durably recorded as contained and the platform closed out the attempt; it
 * never carries the platform's proof or the platform's durable state.
 */
export type RedactedSettlementOutcome = Readonly<{
  readonly status: "settled" | "unavailable";
}>;

export type ContainedGameRuntime = Readonly<{
  launchRole(
    role: ContainmentRole,
    operation: RoleLaunchOperation,
    produceAuthorization: TypedPrivateGameAuthorizationProducer,
  ): Promise<RedactedRoleLaunchOutcome>;
  containRole(role: ContainmentRole): Promise<RedactedContainmentOutcome>;
  /**
   * Protected terminal settlement. It is legal only when every role that
   * actually reached `launched` is already contained, so a normal close, an AI
   * crash or a controller EOF can never reach it. The platform owns what a
   * settlement durably means; the generic runtime only owns the guard.
   */
  settle(): Promise<RedactedSettlementOutcome>;
  close(): Promise<void>;
}>;

/**
 * The durable containment transition refuses to record a role as contained a
 * second time: a recovery resumed after a crash between a role's durable CAS
 * and that role's CAS acknowledgement meets the same role classified contained
 * again while the record already holds it.
 *
 * That refusal is a shared typed identity rather than a message both sides
 * compare, because the two sides are independent projections of this port: the
 * durable engine belongs to a game composition, the recovery wire is
 * deliberately generic. A message literal only the engine can see cannot be
 * checked by the other side, so renaming it would silently turn the one refusal
 * a resumed recovery tolerates back into a closed session.
 */
export class ContainmentRoleAlreadyContainedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContainmentRoleAlreadyContainedError";
  }
}
