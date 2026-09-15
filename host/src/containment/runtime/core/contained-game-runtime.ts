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
} from "../../auth/desktop-guardian-session.internal.js";

type RuntimeBinding = ContainmentCorrelation & ContainmentOperationWaitBudget;

/**
 * Composition-owned platform port. It receives typed game facts and owns the
 * translation to its authenticated platform transport.
 */
export type ContainedGameRuntimePlatform = Readonly<{
  arm(input: Readonly<{
    readonly guardianInstanceId: string;
    readonly guardianEpoch: number;
    readonly attemptId: string;
    readonly operationWaitBudgetMs: number;
    readonly authorization: TypedPrivateGameFacts;
  }>): Promise<void>;
  launch(input: Readonly<{
    readonly guardianInstanceId: string;
    readonly guardianEpoch: number;
    readonly attemptId: string;
    readonly deadlineUnixMs: number;
    readonly role: ContainmentRole;
    readonly authorization: TypedPrivateGameFacts;
  }>): Promise<void>;
  contain(input: Readonly<{
    readonly guardianInstanceId: string;
    readonly guardianEpoch: number;
    readonly attemptId: string;
    readonly operationWaitBudgetMs: number;
    readonly role: ContainmentRole;
  }>): Promise<void>;
  close(): Promise<void>;
}>;

type InternalAuthorization = (privateGameFacts: TypedPrivateGameFacts) => void;

const rejected = (message: string): never => { throw new Error(`contained game runtime: ${message}`); };

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
          await platform.arm({ ...bindingSnapshot, operationWaitBudgetMs: binding.operationWaitBudgetMs, authorization: authorizedValue });
          armed = true;
        }
        ensureOpen(deadlineUnixMs);
        roleStates.set(role, "launching");
        try {
          await platform.launch({ ...bindingSnapshot, deadlineUnixMs, role, authorization: authorizedValue });
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
          await platform.contain({ ...bindingSnapshot, operationWaitBudgetMs: binding.operationWaitBudgetMs, role });
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
      return serialize(async () => { await platform.close(); });
    },
  });
  return runtime;
}
