/** Host-private implementation of the stable contained game runtime contract. */
import type {
  ContainedGameRuntime,
  ContainmentRole,
  RedactedContainmentOutcome,
  RedactedRoleLaunchOutcome,
  RoleLaunchOperation,
  TypedPrivateGameAuthorizationProducer,
} from "../contract/game-runtime.js";
import type {
  ContainmentCorrelation,
  ContainmentDeadline,
  DesktopGuardianSession,
} from "../../auth/desktop-guardian-session.internal.js";

type RuntimeBinding = ContainmentCorrelation & ContainmentDeadline;

type InternalAuthorization = (privateGameFacts: unknown) => void;

const rejected = (message: string): never => { throw new Error(`contained game runtime: ${message}`); };

const encodePrivateFacts = (facts: unknown): Uint8Array => {
  if (facts instanceof Uint8Array) return new Uint8Array(facts);
  return new TextEncoder().encode(JSON.stringify(facts));
};

export function createContainedGameRuntime(
  session: DesktopGuardianSession,
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
  let operation: Promise<unknown> = Promise.resolve();
  type RoleState = "launching" | "launched" | "containing" | "contained" | "launch-failed" | "contain-failed";
  const roleStates = new Map<ContainmentRole, RoleState>();

  const outcome = (role: ContainmentRole, status: "succeeded" | "failed"): RedactedRoleLaunchOutcome =>
    Object.freeze({ role, status });
  const containmentOutcome = (role: ContainmentRole, status: "succeeded" | "failed"): RedactedContainmentOutcome =>
    Object.freeze({ role, status });
  const ensureOpen = (deadlineUnixMs: number) => {
    if (closed) rejected("runtime is closed");
    if (!Number.isSafeInteger(deadlineUnixMs) || Date.now() >= deadlineUnixMs) rejected("operation expired");
  };
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.then(() => undefined, () => undefined);
    return next;
  };

  const runtime: ContainedGameRuntime = Object.freeze({
    launchRole(role, launchOperation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer) {
      return serialize(async () => {
        const deadlineUnixMs = launchOperation.deadlineUnixMs;
        ensureOpen(deadlineUnixMs);
        if (roleStates.has(role)) rejected("role was already launched");
        if (armAttempted && !armed) rejected("arm already failed");
        let privateFrame: Uint8Array | undefined;
        let used = false;
        let active = true;
        const authorization: InternalAuthorization = (facts) => {
          if (!active) rejected("authorization is stale");
          if (used) rejected("authorization replay");
          used = true;
          if (facts === undefined) rejected("authorization forged");
          ensureOpen(deadlineUnixMs);
          privateFrame = encodePrivateFacts(facts);
        };
        try {
          await produceAuthorization(authorization);
        } finally {
          active = false;
        }
        const authorizedFrame = privateFrame === undefined
          ? rejected("authorization was not produced")
          : privateFrame;
        ensureOpen(deadlineUnixMs);
        if (!armed) {
          armAttempted = true;
          await session.arm({ ...bindingSnapshot, deadlineUnixMs, privateFrame: new Uint8Array(authorizedFrame) });
          armed = true;
        }
        ensureOpen(deadlineUnixMs);
        roleStates.set(role, "launching");
        try {
          await session.launch({ ...bindingSnapshot, deadlineUnixMs, role, privateFrame: new Uint8Array(authorizedFrame) });
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
        if (closed) rejected("runtime is closed");
        if (roleStates.get(role) !== "launched") rejected("role was not launched");
        roleStates.set(role, "containing");
        try {
          await session.contain({ ...bindingSnapshot, deadlineUnixMs: binding.deadlineUnixMs, role });
          roleStates.set(role, "contained");
          return containmentOutcome(role, "succeeded");
        } catch {
          roleStates.set(role, "contain-failed");
          return containmentOutcome(role, "failed");
        }
      });
    },
    close() {
      if (closed) return operation.then(() => undefined);
      closed = true;
      return serialize(async () => { await session.close(); });
    },
  });
  return runtime;
}
