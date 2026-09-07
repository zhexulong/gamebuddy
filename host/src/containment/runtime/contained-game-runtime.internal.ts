/** Host-private generic owner for contained game-role launch and containment. */
import type {
  ContainmentCorrelation,
  ContainmentDeadline,
  ContainmentRole,
  DesktopGuardianSession,
} from "../auth/desktop-guardian-session.internal.js";

declare const containedGameRuntimeAuthorizationBrand: unique symbol;

/** A closure-bound, one-shot producer capability; it cannot be serialized or minted by callers. */
export type ContainedGameRuntimeAuthorization = ((privateFrame: Uint8Array) => void) & {
  readonly [containedGameRuntimeAuthorizationBrand]: never;
};

type ContainedGameRuntimeOutcome = Readonly<{
  role: ContainmentRole;
  status: "succeeded" | "failed";
}>;

export type ContainedGameRuntime = Readonly<{
  launchRole(
    role: ContainmentRole,
    produceAuthorization: (authorization: ContainedGameRuntimeAuthorization) => void | Promise<void>,
  ): Promise<ContainedGameRuntimeOutcome>;
  containRole(role: ContainmentRole): Promise<ContainedGameRuntimeOutcome>;
  close(): Promise<void>;
}>;

type RuntimeBinding = ContainmentCorrelation & ContainmentDeadline;

const rejected = (message: string): never => { throw new Error(`contained game runtime: ${message}`); };

/**
 * Builds the generic runtime around the already-authenticated platform session. The binding
 * and private frame never cross this module's redacted result boundary. The runtime binds the
 * requested role in the session input; the opaque private frame's game-specific role semantics
 * remain the producer's responsibility.
 */
export function createContainedGameRuntime(
  session: DesktopGuardianSession,
  binding: RuntimeBinding,
): ContainedGameRuntime {
  // Snapshot primitive correlation/deadline values at construction. Callers cannot alter the
  // binding used by a queued operation after handing it to the runtime.
  const bindingSnapshot = Object.freeze({
    guardianInstanceId: binding.guardianInstanceId,
    guardianEpoch: binding.guardianEpoch,
    attemptId: binding.attemptId,
    deadlineUnixMs: binding.deadlineUnixMs,
  });
  let armed = false;
  let armAttempted = false;
  let closed = false;
  let operation: Promise<unknown> = Promise.resolve();
  type RoleState = "launching" | "launched" | "containing" | "contained" | "launch-failed" | "contain-failed";
  const roleStates = new Map<ContainmentRole, RoleState>();

  const launchInput = (role: ContainmentRole, frame: Uint8Array) =>
    ({ ...bindingSnapshot, role, privateFrame: new Uint8Array(frame) });
  const containInput = (role: ContainmentRole) => ({ ...bindingSnapshot, role });
  const outcome = (role: ContainmentRole, status: "succeeded" | "failed"): ContainedGameRuntimeOutcome =>
    Object.freeze({ role, status });

  const ensureOpen = () => {
    if (closed) rejected("runtime is closed");
    if (!Number.isFinite(bindingSnapshot.deadlineUnixMs) || Date.now() >= bindingSnapshot.deadlineUnixMs) rejected("operation expired");
  };
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.then(() => undefined, () => undefined);
    return next;
  };

  const runtime: ContainedGameRuntime = Object.freeze({
    launchRole(role, produceAuthorization) {
      return serialize(async () => {
        ensureOpen();
        if (roleStates.has(role)) rejected("role was already launched");
        if (armAttempted && !armed) rejected("arm already failed");
        let frame: Uint8Array | undefined;
        let used = false;
        let active = true;
        const authorization = ((candidate: Uint8Array) => {
          if (!active) rejected("authorization is stale");
          if (used) rejected("authorization replay");
          used = true;
          if (!(candidate instanceof Uint8Array)) rejected("authorization forged");
          ensureOpen();
          frame = new Uint8Array(candidate);
        }) as ContainedGameRuntimeAuthorization;
        try {
          await produceAuthorization(authorization);
        } finally {
          // A capability is valid only for this producer invocation and requested role.
          active = false;
        }
        const authorizedFrame: Uint8Array = frame === undefined
          ? rejected("authorization was not produced")
          : frame;
        ensureOpen();
        if (!armed) {
          armAttempted = true;
          await session.arm({ ...bindingSnapshot, privateFrame: new Uint8Array(authorizedFrame) });
          armed = true;
        }
        ensureOpen();
        // Reserve the role before entering the native call: both successful and failed native
        // launch attempts are terminal and cannot be retried.
        roleStates.set(role, "launching");
        try {
          await session.launch(launchInput(role, authorizedFrame));
          roleStates.set(role, "launched");
          return outcome(role, "succeeded");
        } catch {
          roleStates.set(role, "launch-failed");
          return outcome(role, "failed");
        }
      });
    },
    containRole(role) {
      return serialize(async () => {
        ensureOpen();
        if (roleStates.get(role) !== "launched") rejected("role was not launched");
        // Reserve containment before entering the native call so a failed containment attempt
        // is terminal just like a successful one.
        roleStates.set(role, "containing");
        try {
          await session.contain(containInput(role));
          roleStates.set(role, "contained");
          return outcome(role, "succeeded");
        } catch {
          roleStates.set(role, "contain-failed");
          return outcome(role, "failed");
        }
      });
    },
    close() {
      if (closed) return operation.then(() => undefined);
      closed = true;
      return serialize(async () => {
        await session.close();
      });
    },
  });
  return runtime;
}
