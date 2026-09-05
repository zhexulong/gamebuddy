type WindowsStardewBootstrapGuardianOperation =
  | "arm_attempt"
  | "launch_role"
  | "contain_role"
  | "recover_attempt";
type WindowsStardewBootstrapGuardianRole = "player_host" | "ai_client";
export type WindowsStardewBootstrapGuardianCategory =
  | "armed"
  | "role_active"
  | "role_contained"
  | "attempt_contained"
  | "kept_unavailable"
  | "indeterminate";

type GuardianCorrelation = Readonly<{
  schemaVersion: 1;
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
}>;

export type ArmAttemptRequest = GuardianCorrelation & Readonly<{ operation: "arm_attempt" }>;
export type LaunchRoleRequest = GuardianCorrelation & Readonly<{ operation: "launch_role"; role: WindowsStardewBootstrapGuardianRole }>;
export type ContainRoleRequest = GuardianCorrelation & Readonly<{ operation: "contain_role"; role: WindowsStardewBootstrapGuardianRole }>;
export type RecoverAttemptRequest = GuardianCorrelation & Readonly<{ operation: "recover_attempt"; recoveryInstanceId: string }>;
export type WindowsStardewBootstrapGuardianRequest =
  | ArmAttemptRequest
  | LaunchRoleRequest
  | ContainRoleRequest
  | RecoverAttemptRequest;

const OPAQUE_CORRELATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GUARDIAN_EPOCH = 0x7fffffff;
const EXACT_REQUEST_KEYS: ReadonlyMap<WindowsStardewBootstrapGuardianOperation, readonly string[]> = new Map([
  ["arm_attempt", ["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId"]],
  ["launch_role", ["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "role"]],
  ["contain_role", ["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "role"]],
  ["recover_attempt", ["schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId"]],
]);

/** Validates and reconstructs the redacted Task 1 request. It grants no native
 * execution authority and has no process, path, PID, token, bridge, or Job seam. */
export function validateGuardianRequest(input: unknown): WindowsStardewBootstrapGuardianRequest {
  if (!isRecord(input)) throw invalid();
  const operation = input.operation;
  if (typeof operation !== "string") throw invalid();
  const expectedKeys = EXACT_REQUEST_KEYS.get(operation as WindowsStardewBootstrapGuardianOperation);
  if (expectedKeys === undefined) throw invalid();
  const ownKeys = Object.keys(input);
  if (ownKeys.length !== expectedKeys.length || !expectedKeys.every((key) => Object.hasOwn(input, key))) throw invalid();
  if (input.schemaVersion !== 1 || input.operation !== operation) throw invalid();
  const common = {
    schemaVersion: 1 as const,
    guardianInstanceId: validateOpaqueCorrelation(input.guardianInstanceId),
    guardianEpoch: validateGuardianEpoch(input.guardianEpoch),
    attemptId: validateOpaqueCorrelation(input.attemptId),
  };
  switch (operation) {
    case "arm_attempt": return Object.freeze({ ...common, operation });
    case "launch_role":
    case "contain_role": {
      if (input.role !== "player_host" && input.role !== "ai_client") throw invalid();
      return Object.freeze({ ...common, operation, role: input.role });
    }
    case "recover_attempt":
      return Object.freeze({ ...common, operation, recoveryInstanceId: validateOpaqueCorrelation(input.recoveryInstanceId) });
    default: throw invalid();
  }
}

function validateOpaqueCorrelation(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_CORRELATION_PATTERN.test(value)) throw invalid();
  return value;
}
function validateGuardianEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_GUARDIAN_EPOCH) throw invalid();
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): Error {
  return new Error("windows_stardew_bootstrap_guardian_invalid_request");
}
