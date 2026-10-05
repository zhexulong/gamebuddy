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

/**
 * One bounded recovery of an attempt whose durable record is not terminal (a
 * crashed attempt) rather than a live role launch.
 *
 * A recovery is a multi-frame durable protocol, so its parts are the two facts
 * the platform conversation is built from: the typed `gateFacts` of the exact
 * recovery-lease binding the native gate must acquire, and the two durable steps
 * the recovery may only run while that gate is held. Every value here is a typed
 * game fact or a durable step, so the platform frame representation stays with
 * the composition that owns the transport and never enters this contract.
 */
export type RecoveryOperation = Readonly<{
  /** Opaque recovery actor; a resumed recovery adopts the recorded one. */
  readonly recoveryInstanceId: string;
  /** Typed facts of the exact recovery-lease binding the native gate must acquire. */
  readonly gateFacts: TypedPrivateGameFacts;
  /** Durable recovering CAS; the facts it returns are the post-CAS binding. */
  readonly beginRecovery: () => Promise<TypedPrivateGameFacts>;
  /** Durable per-role containment CAS, recorded before that role's acknowledgement. */
  readonly roleContained: (role: ContainmentRole) => Promise<void>;
}>;

/**
 * Redacted recovery outcome. `recovered` is the only success and means the
 * platform's recovery conversation reached its terminal containment for every
 * role it classified. `unavailable` means the recovery could not be driven to
 * that state: the attempt is still unproven, so an uncertain native recovery is
 * never reported as containment and is never silently retried.
 *
 * `gate_held` is the recovery gate's own refusal, separated from `unavailable`
 * because it is the only answer the conversation reports about the LEASE rather
 * than about the recovery. A held gate means a live handle exists at the lease
 * name, which proves only that the holder was NOT PROVEN GONE. It is never proof
 * that the owner is alive: the handle may be a recovery gate the Host itself
 * opened, so a consumer must not invert it into a liveness verdict. Nothing
 * native ran, the previous lease stays authority, and the attempt is refused
 * exactly as `unavailable` refuses it - a consumer that only asks "did the
 * recovery run" may read the two alike, and one that consumes this verdict as a
 * lease probe must not.
 */
export type RedactedRecoveryOutcome = Readonly<{
  readonly status: "recovered" | "unavailable" | "gate_held";
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
  /**
   * Recovery drive for an attempt whose durable record is not terminal.
   *
   * Optional, because a recovery is driven for an exact owner: it needs that
   * owner's one-shot Guardian binding (its recovery-gate correlation and its
   * durable transition port) plus the composition's authenticated session, and
   * the generic core holds neither. A core runtime therefore has no recovery to
   * offer rather than a recovery it cannot drive, and only a composition that
   * holds the owner supplies it.
   */
  recover?(operation: RecoveryOperation): Promise<RedactedRecoveryOutcome>;
  close(): Promise<void>;
}>;

/**
 * A contained runtime whose composition holds the exact owner's durable
 * recovery drive, so `recover` is present rather than optional. The owner-held
 * drive is what makes the member implementable at all, so this refinement is
 * exactly the difference between a core runtime and a bound one.
 */
export type RecoverableContainedGameRuntime = ContainedGameRuntime & Readonly<{
  recover(operation: RecoveryOperation): Promise<RedactedRecoveryOutcome>;
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

/**
 * The exact owner's Farmhand bridge connection authority is not in the state the
 * caller requires. One refusal, two callers, and (before this identity existed)
 * two different meanings read off the same message text:
 *
 * - the composition refuses to consume a connection that is not `available`
 *   (the one-shot connection was already consumed, or is not armed yet), which
 *   the lifecycle reads as "this attach cannot be built here, defer it";
 * - the composition refuses to arm a fresh activation because the previous one
 *   never fully ended, which the lifecycle reads as "the owner's first one-shot
 *   activation is still intact", the state a create launches through.
 *
 * Both refusals are legitimately reported by the same composition probe, so the
 * lifecycle cannot distinguish them by call site; it distinguishes the two
 * readings by which probe it just ran. What it must NOT do is distinguish them
 * by comparing a message literal that only the composition can see: renaming
 * the text would silently turn "still intact, launch through it" into a hard
 * failure, or turn a real refusal into something the lifecycle tolerates. The
 * identity therefore lives in this port and is what both sides classify on,
 * exactly like the durable containment refusal above.
 */
export class FarmhandBridgeConnectionNotAvailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FarmhandBridgeConnectionNotAvailableError";
  }
}
