/** Host-private implementation of the stable contained game runtime contract. */
import type {
  ContainedGameRuntime,
  ContainmentRole,
  RedactedContainmentOutcome,
  RedactedRoleLaunchOutcome,
  RoleLaunchOperation,
  TypedPrivateGameAuthorizationProducer,
  TypedPrivateGameFacts,
} from "../contract/game-runtime.js";
import type {
  ContainmentCorrelation,
  ContainmentOperationWaitBudget,
  GuardianRecoveryAck,
  GuardianRecoveryRole,
} from "../../auth/desktop-guardian-session.internal.js";
import { DESKTOP_BOOTSTRAP_REFUSAL_PREFIX } from "../../auth/desktop-guardian-session.internal.js";

type RuntimeBinding = ContainmentCorrelation &
  ContainmentOperationWaitBudget &
  Readonly<{
    /**
     * The attempt's native arm binding facts, read from the composition's own arm
     * frame. They are the arm operation's own input and deliberately NOT the launch
     * authorization: the arm body is built from these facts (plus the approved
     * executable), so the launch facts bag never becomes the arm body.
     */
    readonly armFacts: TypedPrivateGameFacts;
  }>;

/**
 * Composition-owned platform port. It receives typed game facts and owns the
 * translation to its authenticated platform transport.
 */
export type ContainedGameRuntimePlatform = Readonly<{
  arm(
    input: Readonly<{
      readonly guardianInstanceId: string;
      readonly guardianEpoch: number;
      readonly attemptId: string;
      readonly operationWaitBudgetMs: number;
      /** The attempt's native arm binding facts; the arm body is built from these. */
      readonly armFacts: TypedPrivateGameFacts;
      /**
       * The launch authorization produced for this attempt. The arm body takes
       * ONLY its approved executable from it: the attested installation executable
       * is the one fact the native arm parser needs that is not an arm binding
       * fact, and no other launch fact may enter the arm body.
       */
      readonly authorization: TypedPrivateGameFacts;
    }>,
  ): Promise<void>;
  launch(
    input: Readonly<{
      readonly guardianInstanceId: string;
      readonly guardianEpoch: number;
      readonly attemptId: string;
      readonly deadlineUnixMs: number;
      readonly role: ContainmentRole;
      readonly authorization: TypedPrivateGameFacts;
    }>,
  ): Promise<void>;
  contain(
    input: Readonly<{
      readonly guardianInstanceId: string;
      readonly guardianEpoch: number;
      readonly attemptId: string;
      readonly operationWaitBudgetMs: number;
      readonly role: ContainmentRole;
    }>,
  ): Promise<void>;
  /**
   * One bounded recovery conversation with the recovery transport.
   *
   * Recovery is a multi-frame durable protocol rather than one request: the gate
   * facts are sent before the durable recovering CAS, the post-CAS binding facts
   * `beginRecovery` returns are validated against that exact gate, and every role
   * the native classified as contained is durably recorded before its CAS
   * acknowledgement is written. This port carries typed facts only; the
   * composition owns their encoding into platform frames, so no platform frame
   * representation enters this module.
   */
  recover(
    input: Readonly<{
      readonly guardianInstanceId: string;
      readonly guardianEpoch: number;
      readonly attemptId: string;
      readonly operationWaitBudgetMs: number;
      readonly recoveryInstanceId: string;
      /** Typed facts of the exact recovery lease binding the native gate must acquire. */
      readonly gateFacts: TypedPrivateGameFacts;
      /** Durable recovering CAS; the successor facts it returns are the post-CAS binding. */
      readonly beginRecovery: () => Promise<TypedPrivateGameFacts>;
      /** Durable per-role containment CAS, before that role's recovery CAS acknowledgement. */
      readonly roleContained: (role: GuardianRecoveryRole) => Promise<void>;
    }>,
  ): Promise<GuardianRecoveryAck>;
  /**
   * Protected terminal settlement for one attempt. The platform owns what a
   * settlement durably records and proves; the generic runtime only guarantees
   * that every role which actually launched is already contained before this is
   * ever called, so no ordinary close, AI crash or controller EOF can reach it.
   * `launchedRoles` names exactly those roles the runtime actually launched, so
   * a platform never has to invent or guess what to record as contained.
   */
  settle(
    input: Readonly<{
      readonly guardianInstanceId: string;
      readonly guardianEpoch: number;
      readonly attemptId: string;
      readonly operationWaitBudgetMs: number;
      readonly launchedRoles: readonly ContainmentRole[];
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}>;

type InternalAuthorization = (privateGameFacts: TypedPrivateGameFacts) => void;

const rejected = (message: string): never => {
  throw new Error(`contained game runtime: ${message}`);
};

/**
 * The shape a refusal's name may cross in: lowercase words joined by single underscores.
 *
 * It is the bound, not a preference. The message can be an OS error, a game path or a session's raw
 * detail, and none of those may enter an outcome that leaves this layer - so anything that is not a
 * code reads as a refusal that named nothing rather than as text wearing a code's clothes.
 *
 * A refusal arrives from the authenticated session this runtime's platform speaks on, and that wire
 * spells every one of its refusals `<wrapper><code>` (`DESKTOP_BOOTSTRAP_REFUSAL_PREFIX`). The
 * wrapper is a fixed constant rather than the refusal's own text, so the code after it crosses and
 * the wrapper does not: without that, every transport refusal and every frame this side refused to
 * write arrived here as a refusal that named nothing, and the launch that never reached the game
 * could only be reported as one word standing for a lost Guardian, a refused native plan and an
 * authorization failure alike.
 */
const BOUNDED_REFUSAL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/** The bounded name a refused step's error carries, or `null` when it carries none that may cross. */
const refusalName = (error: unknown): string | null => {
  if (!(error instanceof Error) || error.message.length > 96) return null;
  const name = error.message.startsWith(DESKTOP_BOOTSTRAP_REFUSAL_PREFIX)
    ? error.message.slice(DESKTOP_BOOTSTRAP_REFUSAL_PREFIX.length)
    : error.message;
  return BOUNDED_REFUSAL_NAME.test(name) ? name : null;
};

/**
 * The same refusal under the bounded name it carries, or the error unchanged when it carries none.
 *
 * The wire spells every refusal `<wrapper><code>`, and `refusalName` above is the one reading of that
 * spelling. The launch step reports what it decoded, but the arm step is a throw rather than an
 * outcome, so its refusal left this layer as the wrapper-prefixed text - a message that is not a
 * code, which the wire's own bounded-cause projection therefore drops, so a Player Host launch
 * refused while arming could only reach the player as the generic wrapper. Nothing an arm can
 * refuse has started a process, so the code is the whole fact; the raw refusal stays as its cause
 * and never crosses.
 */
const namedRefusal = (error: unknown): unknown => {
  const name = refusalName(error);
  return name === null ? error : new Error(name, { cause: error });
};

export function createContainedGameRuntime(
  platform: ContainedGameRuntimePlatform,
  binding: RuntimeBinding,
): ContainedGameRuntime {
  const bindingSnapshot = Object.freeze({
    guardianInstanceId: binding.guardianInstanceId,
    guardianEpoch: binding.guardianEpoch,
    attemptId: binding.attemptId,
  });
  let armed = false;
  let armAttempted = false;
  let closed = false;
  let settled = false;
  let operation: Promise<unknown> = Promise.resolve();
  type RoleState = "launching" | "launched" | "containing" | "contained" | "launch-failed" | "contain-failed";
  const roleStates = new Map<ContainmentRole, RoleState>();

  const launched = (role: ContainmentRole): RedactedRoleLaunchOutcome =>
    Object.freeze({ role, status: "succeeded" as const });
  const launchRefused = (role: ContainmentRole, refusal: string | null): RedactedRoleLaunchOutcome =>
    Object.freeze({ role, status: "failed" as const, refusal });
  const containmentOutcome = (role: ContainmentRole, status: "succeeded" | "failed"): RedactedContainmentOutcome =>
    Object.freeze({ role, status });
  const ensureOpen = (deadlineUnixMs: number) => {
    if (closed) rejected("runtime is closed");
    if (!Number.isSafeInteger(deadlineUnixMs) || Date.now() >= deadlineUnixMs) rejected("operation expired");
  };
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const runtime: ContainedGameRuntime = Object.freeze({
    launchRole(
      role,
      launchOperation: RoleLaunchOperation,
      produceAuthorization: TypedPrivateGameAuthorizationProducer,
    ) {
      return serialize(async () => {
        const deadlineUnixMs = launchOperation.deadlineUnixMs;
        ensureOpen(deadlineUnixMs);
        // A settled attempt is terminal, so it must not accept a new role. The
        // `settled` latch is one-way, so a role launched after it would never be
        // settled at all; enforcing the terminal property here keeps it a contract
        // guarantee rather than something only the coordinator's structure prevents.
        if (settled) rejected("runtime was already settled");
        if (roleStates.has(role)) rejected("role was already launched");
        if (armAttempted && !armed) rejected("arm already failed");
        let privateAuthorization: TypedPrivateGameFacts | undefined;
        let used = false;
        let active = true;
        const authorization: InternalAuthorization = (privateGameFacts) => {
          if (!active) rejected("authorization is stale");
          if (used) rejected("authorization replay");
          used = true;
          if (privateGameFacts === undefined) rejected("authorization forged");
          ensureOpen(deadlineUnixMs);
          privateAuthorization = privateGameFacts;
        };
        try {
          await produceAuthorization(authorization);
        } finally {
          active = false;
        }
        if (privateAuthorization === undefined) rejected("authorization was not produced");
        const authorizedValue: TypedPrivateGameFacts = privateAuthorization!;
        ensureOpen(deadlineUnixMs);
        if (!armed) {
          armAttempted = true;
          try {
            await platform.arm({
              ...bindingSnapshot,
              operationWaitBudgetMs: binding.operationWaitBudgetMs,
              armFacts: binding.armFacts,
              authorization: authorizedValue,
            });
          } catch (error) {
            throw namedRefusal(error);
          }
          armed = true;
        }
        ensureOpen(deadlineUnixMs);
        roleStates.set(role, "launching");
        try {
          await platform.launch({ ...bindingSnapshot, deadlineUnixMs, role, authorization: authorizedValue });
          roleStates.set(role, "launched");
          return launched(role);
        } catch (error) {
          roleStates.set(role, "launch-failed");
          // Deliberately over-conservative: a launch that failed BEFORE dispatching
          // any native frame is recorded as `launch-failed` too, which blocks
          // settlement for that role. The runtime cannot distinguish "definitely did
          // not dispatch" from "may have produced a side effect" here, so it takes
          // the safe direction and leaves the attempt to recovery/quarantine. Do not
          // "fix" this into a dispatch assertion: that would let an uncertain side
          // effect settle as if nothing happened.
          //
          // The refusal's own bounded name IS kept. The conservatism above is about the role's
          // state, not about the reason: a failed launch used to answer one word for every cause
          // (measured 2026-11-20, `.tmp/lane-launchdetail.md`), and this catch is the only place
          // the reason was ever seen.
          return launchRefused(role, refusalName(error));
        }
      });
    },
    containRole(role) {
      return serialize(async () => {
        if (closed) rejected("runtime is closed");
        if (roleStates.get(role) !== "launched") rejected("role was not launched");
        roleStates.set(role, "containing");
        try {
          await platform.contain({ ...bindingSnapshot, operationWaitBudgetMs: binding.operationWaitBudgetMs, role });
          roleStates.set(role, "contained");
          return containmentOutcome(role, "succeeded");
        } catch {
          roleStates.set(role, "contain-failed");
          return containmentOutcome(role, "failed");
        }
      });
    },
    settle() {
      return serialize(async () => {
        if (closed) rejected("runtime is closed");
        if (!armAttempted || !armed) rejected("runtime was never armed");
        // Settlement is the deliberate terminal operation. It is legal only
        // once every role that actually reached `launched` was already
        // contained, so an ordinary close or a failed launch can never produce
        // it and the platform never sees a settlement it did not earn.
        //
        // An armed attempt that recorded NO launched role is refused. `arm` and
        // `launch` are separate steps and the post-arm expiry/close check can fail
        // before any role is recorded, leaving an attempt that armed but never
        // dispatched. That attempt is still classified pre-claim and retryable by
        // the coordinator, so letting it settle here would durably mark it
        // `contained` and release the registration pointer for a launch that never
        // happened. The generic layer cannot judge whether an empty role set is
        // benign: "an unlaunched role still owns an empty Job" is a
        // Stardew-native fact that belongs to the composer, not here.
        if (roleStates.size === 0) rejected("no role ever reached launch");
        for (const state of roleStates.values()) {
          if (state !== "contained") rejected("not every launched role is contained");
        }
        // Settlement is terminal: a second call must not reach the platform
        // again. The platform's own proof reservation would fail closed, but the
        // generic contract must not depend on that to keep its guarantee honest.
        if (settled) rejected("runtime was already settled");
        settled = true;
        try {
          await platform.settle({
            ...bindingSnapshot,
            operationWaitBudgetMs: binding.operationWaitBudgetMs,
            // Name exactly the roles that reached `launched`; the guard above
            // already proved each of them is contained, and a role that never
            // launched is never reported as contained.
            launchedRoles: [...roleStates.entries()].filter(([, state]) => state === "contained").map(([role]) => role),
          });
          return Object.freeze({ status: "settled" as const });
        } catch {
          // A failed settlement is not retryable: recovery owns this attempt, so
          // the terminal flag stays latched rather than reopening the operation.
          return Object.freeze({ status: "unavailable" as const });
        }
      });
    },
    close() {
      // Closing forbids any further arm/launch/contain/settle immediately, which is
      // what `settle()`'s `closed` guard relies on. The close itself is still
      // re-driven on every call: the platform layer deduplicates a concurrent or
      // already-successful close, and a close that FAILED must stay retryable
      // rather than being reported as a success to the next caller. The earlier
      // `if (closed) return operation.then(() => undefined)` returned a resolved
      // promise after a rejected close, which faked success.
      closed = true;
      return serialize(async () => {
        await platform.close();
      });
    },
  });
  return runtime;
}
