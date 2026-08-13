import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  ArchiveLifecycleCommand,
  AuthenticatedContinuityPrincipal,
  ChatCommandReadback,
  ChatSelectionCommand,
  GameAbortReason,
  GameCommand,
  GameCommandReadback,
  GamePermit,
  GameTerminalReceipt,
} from "../continuity-semantic-store/continuity-semantic-store.js";

export type ContinuityAuthority = "SEMANTIC";
export type ContinuityAuthorityCommand =
  | Readonly<{ kind: "chat_select_open"; principal: AuthenticatedContinuityPrincipal; input: ChatSelectionCommand }>
  | Readonly<{ kind: "archive_lifecycle"; principal: AuthenticatedContinuityPrincipal; input: ArchiveLifecycleCommand }>
  | Readonly<{ kind: "game"; principal: AuthenticatedContinuityPrincipal; input: GameCommand }>;
export type ContinuityAuthorityEffect = Readonly<{
  kind: "bootstrap_game_runtime" | "teardown_game_runtime" | "release_game_runtime" | "recover_game_runtime";
  permit: GamePermit;
}>;
/** `effect_owned` is issued by the durable backend to exactly one executor. */
export type ContinuityAuthorityBackendResult =
  | Readonly<{ state: "completed"; result: ChatCommandReadback | GameCommandReadback }>
  | Readonly<{ state: "effect_pending"; result: GameCommandReadback }>
  | Readonly<{ state: "effect_owned"; permit: GamePermit; effect: ContinuityAuthorityEffect }>;
/** The only durable terminalization response accepted after an owned effect fails. */
export type ContinuityAuthorityEffectFailureResult = Readonly<{ state: "effect_failed"; result: GameCommandReadback }>;
export type ContinuityAuthorityBackend = Readonly<{
  authority: ContinuityAuthority;
  prepare(command: ContinuityAuthorityCommand): ContinuityAuthorityBackendResult;
  commit(permit: GamePermit, receipt: GameTerminalReceipt): GameCommandReadback;
  abort(permit: GamePermit, reason: GameAbortReason): void | GameCommandReadback;
  effectFailed(
    principal: AuthenticatedContinuityPrincipal,
    permit: GamePermit,
    reason: "effect_failed",
  ): ContinuityAuthorityEffectFailureResult;
}>;
export type ContinuityAuthorityEffectExecutor = Readonly<{
  execute(effect: ContinuityAuthorityEffect): Promise<GameTerminalReceipt>;
}>;
export type LocalQuiescingLease = Readonly<{ continuityId: string; release(): void }>;
export type ContinuityAuthorityCoordinator = Readonly<{
  /** Unmounted ingress: accepts only a bounded primitive JSON command string. */
  executeJson(commandJson: string): Promise<ChatCommandReadback | GameCommandReadback>;
  beginQuiescing(continuityId: string): Promise<LocalQuiescingLease>;
}>;

export class ContinuityAuthorityCoordinatorError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ContinuityAuthorityCoordinatorError";
  }
}

/**
 * Fixed-route, process-local command coordinator. Durable backend ownership is
 * authoritative: only an `effect_owned` prepare result may invoke an effect.
 */
export function createContinuityAuthorityCoordinator(
  input: Readonly<{
    semanticBackend: ContinuityAuthorityBackend;
    effectExecutor: ContinuityAuthorityEffectExecutor;
    /** @internal Obsolete test-support seam; never used to derive production mutex identity. */
    mutex?: unknown;
    /** Exact, caller-supplied runtime instance identifiers permitted for game commands. */
    runtimeWhitelist: readonly string[];
  }>,
): ContinuityAuthorityCoordinator {
  if (input.semanticBackend.authority !== "SEMANTIC") throw new Error("invalid_continuity_authority_backend");
  const runtimeWhitelist = new Set(input.runtimeWhitelist);
  if (
    runtimeWhitelist.size !== input.runtimeWhitelist.length ||
    [...runtimeWhitelist].some((runtimeInstanceId) => !validId(runtimeInstanceId))
  )
    throw new Error("invalid_continuity_authority_runtime_whitelist");
  const partitions = new Map<
    string,
    { active: number; quiescing: boolean; quarantined: boolean; waiters: (() => void)[] }
  >();
  const partition = (continuityId: string) => {
    let state = partitions.get(continuityId);
    if (!state) {
      state = { active: 0, quiescing: false, quarantined: false, waiters: [] };
      partitions.set(continuityId, state);
    }
    return state;
  };
  const requireContinuityId = (continuityId: string): void => {
    if (!validId(continuityId)) throw error("invalid_continuity_authority_continuity_id");
  };
  const finish = (continuityId: string): void => {
    const state = partition(continuityId);
    state.active -= 1;
    if (state.active === 0) for (const wake of state.waiters.splice(0)) wake();
  };
  // This coordinator has no authority root and must not derive a mutex key
  // from request or continuity identity. Production uses the provisioning-owned
  // root mutex in semantic production coordinator.
  const underMutex = <T>(_continuityId: string, _state: { quarantined: boolean }, work: () => T): Promise<T> =>
    Promise.resolve().then(work);
  // A process may observe a duplicate before its durable backend can return an
  // `effect_pending` observer. Share the first execution instead of issuing a
  // second effect; later retries still go to the durable backend for its receipt.
  const activeGameOperations = new Map<string, Promise<GameCommandReadback>>();
  // This is only an in-flight optimization. Its identity must be at least as
  // specific as the durable operation identity so it can never hide a conflict.
  const operationKey = (
    command: Extract<ContinuityAuthorityCommand, { kind: "game" }>,
    payloadDigest: string,
  ): string =>
    [
      command.input.continuityId,
      command.principal.continuityId,
      command.principal.companionId,
      command.principal.playerId,
      command.input.operationId,
      payloadDigest,
    ].join("\u0000");
  const executeOne = async (
    command: ContinuityAuthorityCommand,
    continuityId: string,
  ): Promise<ChatCommandReadback | GameCommandReadback> => {
    requireContinuityId(continuityId);
    const state = partition(continuityId);
    if (state.quarantined) throw error("continuity_authority_partition_quarantined");
    if (state.quiescing) throw error("continuity_authority_adoption_in_progress");
    state.active += 1;
    const backend = input.semanticBackend;
    try {
      const prepared = await underMutex(continuityId, state, () => backend.prepare(command));
      if (prepared.state === "completed" || prepared.state === "effect_pending") return prepared.result;
      let receipt: GameTerminalReceipt;
      try {
        receipt = await input.effectExecutor.execute(prepared.effect);
      } catch {
        // An owned effect may have changed the runtime before throwing. It has a
        // distinct durable recovery terminalization, never the caller-abort path.
        try {
          const failurePrincipal = freezePrincipal(command.principal);
          const failurePermit = freezePermit(prepared.permit);
          const failed = await underMutex(continuityId, state, () =>
            backend.effectFailed(failurePrincipal, failurePermit, "effect_failed"),
          );
          if (!validEffectFailureResult(failed, failurePermit)) throw new Error("invalid_effect_failure_result");
        } catch {
          // A failed or unverifiable durable terminalization leaves local state
          // unsafe to operate. The public effect error remains deliberately redacted.
          state.quarantined = true;
        }
        throw error("continuity_authority_effect_failed");
      }
      try {
        return await underMutex(continuityId, state, () => backend.commit(prepared.permit, receipt));
      } catch (commitError) {
        state.quarantined = true;
        throw commitError;
      }
    } finally {
      finish(continuityId);
    }
  };

  return Object.freeze({
    async executeJson(commandJson): Promise<ChatCommandReadback | GameCommandReadback> {
      // This unmounted boundary accepts raw primitive JSON only. A future HTTP
      // adapter must hand its raw bounded body here, not parse or mount it.
      const snapshot = snapshotCommandJson(commandJson, runtimeWhitelist);
      if (snapshot.command.kind !== "game") return executeOne(snapshot.command, snapshot.continuityId);
      const key = operationKey(snapshot.command, snapshot.payloadDigest!);
      const existing = activeGameOperations.get(key);
      if (existing) return existing;
      const owned = executeOne(snapshot.command, snapshot.continuityId) as Promise<GameCommandReadback>;
      activeGameOperations.set(key, owned);
      try {
        return await owned;
      } finally {
        if (activeGameOperations.get(key) === owned) activeGameOperations.delete(key);
      }
    },
    async beginQuiescing(continuityId): Promise<LocalQuiescingLease> {
      requireContinuityId(continuityId);
      const state = partition(continuityId);
      if (state.quarantined) throw error("continuity_authority_partition_quarantined");
      if (state.quiescing) throw error("continuity_authority_quiescing_already_active");
      state.quiescing = true;
      if (state.active !== 0) await new Promise<void>((resolve) => state.waiters.push(resolve));
      if (state.quarantined) throw error("continuity_authority_partition_quarantined");
      let released = false;
      return Object.freeze({
        continuityId,
        release() {
          if (released) throw error("continuity_authority_quiescing_lease_released");
          released = true;
          state.quiescing = false;
        },
      });
    },
  });
}

type CommandSnapshot = Readonly<{ command: ContinuityAuthorityCommand; continuityId: string; payloadDigest?: string }>;

/**
 * Establish the command trust boundary without ever evaluating caller-owned
 * properties. Descriptor values are copied recursively to frozen ordinary data.
 */
const MAX_COMMAND_JSON_BYTES = 1_048_576;

function snapshotCommandJson(commandJson: unknown, runtimeWhitelist: ReadonlySet<string>): CommandSnapshot {
  // `typeof` neither reflects nor coerces an object, including transparent Proxy
  // and boxed String values. It must precede parsing, mutexes, backends, and effects.
  if (typeof commandJson !== "string" || Buffer.byteLength(commandJson, "utf8") > MAX_COMMAND_JSON_BYTES)
    throw error("invalid_continuity_authority_command_json");
  // JSON.parse silently applies last-key-wins semantics. Inspect the raw JSON
  // grammar first, so no duplicate object member can reach typed validation.
  if (hasDuplicateJsonObjectKey(commandJson)) throw error("invalid_continuity_authority_envelope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(commandJson);
  } catch {
    throw error("invalid_continuity_authority_command_json");
  }
  let command: ContinuityAuthorityCommand;
  try {
    command = copyPlainData(parsed) as ContinuityAuthorityCommand;
  } catch {
    throw error("invalid_continuity_authority_envelope");
  }
  return validateSnapshot(command, runtimeWhitelist);
}
function hasDuplicateJsonObjectKey(source: string): boolean {
  let offset = 0;
  let duplicate = false;
  const whitespace = () => {
    while (
      offset < source.length &&
      (source[offset] === " " || source[offset] === "\n" || source[offset] === "\r" || source[offset] === "\t")
    )
      offset++;
  };
  const string = (): string => {
    if (source[offset++] !== '"') throw new Error("json");
    let decoded = "";
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return decoded;
      if (character === "\\") {
        const escape = source[offset++];
        if (escape === '"' || escape === "\\" || escape === "/") decoded += escape;
        else if (escape === "b") decoded += "\b";
        else if (escape === "f") decoded += "\f";
        else if (escape === "n") decoded += "\n";
        else if (escape === "r") decoded += "\r";
        else if (escape === "t") decoded += "\t";
        else if (escape === "u") {
          const hex = source.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("json");
          decoded += String.fromCharCode(Number.parseInt(hex, 16));
          offset += 4;
        } else throw new Error("json");
      } else {
        if (character < " " || character === undefined) throw new Error("json");
        decoded += character;
      }
    }
    throw new Error("json");
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset++;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) duplicate = true;
        else keys.add(key);
        whitespace();
        if (source[offset++] !== ":") throw new Error("json");
        value();
        whitespace();
        if (source[offset] === "}") {
          offset++;
          return;
        }
        if (source[offset++] !== ",") throw new Error("json");
      }
    }
    if (source[offset] === "[") {
      offset++;
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return;
      }
      for (;;) {
        value();
        whitespace();
        if (source[offset] === "]") {
          offset++;
          return;
        }
        if (source[offset++] !== ",") throw new Error("json");
      }
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    const literal = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(source.slice(offset));
    if (literal) {
      offset += literal[0].length;
      return;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      return;
    }
    throw new Error("json");
  };
  try {
    whitespace();
    value();
    whitespace();
    return offset === source.length && duplicate;
  } catch {
    return false;
  }
}
function validateSnapshot(command: ContinuityAuthorityCommand, runtimeWhitelist: ReadonlySet<string>): CommandSnapshot {
  if (
    !validPlainObject(command) ||
    !hasExactKeys(command, ["kind", "principal", "input"]) ||
    !validPrincipal(command.principal)
  )
    throw error("invalid_continuity_authority_envelope");
  if (command.kind !== "chat_select_open" && command.kind !== "archive_lifecycle" && command.kind !== "game")
    throw error("invalid_continuity_authority_envelope");
  if (command.kind === "game") {
    const input = command.input;
    if (
      !validGameInput(input) ||
      input.continuityId !== command.principal.continuityId ||
      !samePrincipal(command.principal, input.principal) ||
      !validGameOrigin(input.origin, command.principal) ||
      !samePrincipal(command.principal, input.origin)
    )
      throw error("invalid_continuity_authority_envelope");
    if (!runtimeWhitelist.has(input.runtimeInstanceId)) throw error("continuity_authority_runtime_not_allowed");
    return Object.freeze({ command, continuityId: input.continuityId, payloadDigest: canonicalPayloadDigest(input) });
  }
  const input = command.input;
  if (
    !(command.kind === "chat_select_open" ? validChatSelection(input) : validArchiveLifecycle(input)) ||
    input.continuityId !== command.principal.continuityId ||
    !samePrincipal(command.principal, input.principal) ||
    !samePrincipal(command.principal, input)
  )
    throw error("invalid_continuity_authority_envelope");
  return Object.freeze({ command, continuityId: input.continuityId });
}
function copyPlainData(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("noncanonical");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("noncanonical");
  if (
    (Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : Object.getPrototypeOf(value) !== Object.prototype) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new Error("noncanonical");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors))
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("noncanonical");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return Object.freeze(Object.keys(descriptors).map((key) => copyPlainData(descriptors[key]!.value, seen)));
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors)) copy[key] = copyPlainData(descriptors[key]!.value, seen);
    return Object.freeze(copy);
  } finally {
    seen.delete(value);
  }
}
function validPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  );
}
/** JSON-only deterministic encoding. Reject exotic values, cycles and accessors that throw. */
function canonicalPayloadDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("noncanonical");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("noncanonical");
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new Error("noncanonical");
  seen.add(value);
  try {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
function freezePrincipal(principal: AuthenticatedContinuityPrincipal): AuthenticatedContinuityPrincipal {
  return Object.freeze({
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    playerId: principal.playerId,
  });
}
function freezePermit(permit: GamePermit): GamePermit {
  return Object.freeze({
    kind: permit.kind,
    continuityId: permit.continuityId,
    operationId: permit.operationId,
    payloadDigest: permit.payloadDigest,
    gameSessionId: permit.gameSessionId,
    origin: Object.freeze({ ...permit.origin }),
    world: Object.freeze({ ...permit.world }),
    bindingDigest: permit.bindingDigest,
    fenceEpoch: permit.fenceEpoch,
    fenceToken: permit.fenceToken,
    deadlineAtMs: permit.deadlineAtMs,
    runtimeInstanceId: permit.runtimeInstanceId,
    ownerPid: permit.ownerPid,
    ownerProcessStartIdentity: permit.ownerProcessStartIdentity,
  });
}
function validEffectFailureResult(value: unknown, permit: GamePermit): value is ContinuityAuthorityEffectFailureResult {
  const envelope = sealedPlainData(value, ["state", "result"]);
  if (!envelope || envelope.state !== "effect_failed") return false;
  const result = sealedPlainData(envelope.result, [
    "continuityId",
    "revision",
    "fenceEpoch",
    "operationId",
    "gameSessionId",
    "gameState",
    "originChatState",
    "leaseState",
    "pending",
    "status",
    "abortReason",
    "recoveryReason",
    "recoveryErrorCode",
    "recoveryFacts",
  ]);
  if (!result) return false;
  return (
    validId(result.continuityId) &&
    result.continuityId === permit.continuityId &&
    validId(result.operationId) &&
    result.operationId === permit.operationId &&
    validId(result.gameSessionId) &&
    result.gameSessionId === permit.gameSessionId &&
    validRevision(result.revision) &&
    validRevision(result.fenceEpoch) &&
    result.gameState === "recovery_required" &&
    typeof result.originChatState === "string" &&
    result.leaseState === "recovery_required" &&
    result.pending === false &&
    result.status === "recovery_required" &&
    result.abortReason === null &&
    result.recoveryReason === "effect_failed" &&
    result.recoveryErrorCode === "effect_failed" &&
    validRecoveryFacts(result.recoveryFacts)
  );
}
/** Read only own data descriptors: recovery proof objects cannot run accessors or inherit facts. */
function sealedPlainData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isSealed(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key) => Object.hasOwn(descriptors, key))) return null;
  for (const descriptor of Object.values(descriptors))
    if (!descriptor.enumerable || !("value" in descriptor)) return null;
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validRecoveryFacts(value: unknown): boolean {
  const facts = sealedPlainData(value, ["prepared", "final"]);
  return !!facts && validRevisionVector(facts.prepared) && validRevisionVector(facts.final);
}
function validRevisionVector(value: unknown): boolean {
  const vector = sealedPlainData(value, [
    "partitionRevision",
    "gameRevision",
    "leaseRevision",
    "selectionRevision",
    "fenceEpoch",
  ]);
  return !!vector && Object.values(vector).every(validRevision);
}
function validGameInput(value: unknown): value is GameCommand {
  if (
    !validPlainObject(value) ||
    !hasExactKeys(value, [
      "kind",
      "principal",
      "continuityId",
      "operationId",
      "gameSessionId",
      "origin",
      "world",
      "bindingDigest",
      "expectedPartitionRevision",
      "expectedGameRevision",
      "expectedLeaseRevision",
      "expectedSelectionRevision",
      "expectedFenceEpoch",
      "deadlineAtMs",
      "runtimeInstanceId",
      "ownerPid",
      "ownerProcessStartIdentity",
      "recoveryRequestId",
    ]) ||
    !validPrincipal(value.principal) ||
    !validId(value.continuityId)
  )
    return false;
  return (
    validGameKind(value.kind) &&
    validId(value.operationId) &&
    validId(value.gameSessionId) &&
    validGameWorld(value.world) &&
    validHash(value.bindingDigest) &&
    validId(value.runtimeInstanceId) &&
    validId(value.ownerProcessStartIdentity) &&
    Number.isSafeInteger(value.ownerPid as number) &&
    (value.ownerPid as number) > 0 &&
    [
      value.expectedPartitionRevision,
      value.expectedGameRevision,
      value.expectedLeaseRevision,
      value.expectedSelectionRevision,
      value.expectedFenceEpoch,
    ].every((revision) => Number.isSafeInteger(revision as number) && (revision as number) >= 0) &&
    Number.isSafeInteger(value.deadlineAtMs as number) &&
    (value.deadlineAtMs as number) >= 0 &&
    (value.recoveryRequestId === undefined || validId(value.recoveryRequestId))
  );
}
function validGameKind(value: unknown): value is GameCommand["kind"] {
  return value === "game_enter" || value === "game_return" || value === "lease_release" || value === "game_recovery";
}
function validGameWorld(value: unknown): boolean {
  return (
    validPlainObject(value) &&
    hasExactKeys(value, ["integrationId", "saveId", "worldId"]) &&
    validId(value.integrationId) &&
    validId(value.saveId) &&
    validId(value.worldId)
  );
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validPrincipal(value: unknown): value is AuthenticatedContinuityPrincipal {
  return (
    validPlainObject(value) &&
    hasExactKeys(value, ["continuityId", "companionId", "playerId"]) &&
    validId(value.continuityId) &&
    validId(value.companionId) &&
    validId(value.playerId)
  );
}
function validChatSelection(value: unknown): value is ChatSelectionCommand {
  return (
    validPlainObject(value) &&
    hasExactKeys(value, [
      "principal",
      "continuityId",
      "companionId",
      "playerId",
      "chatThreadId",
      "chatSurfaceSessionId",
      "expectedPartitionRevision",
      "expectedSelectionRevision",
      "expectedFenceEpoch",
      "operationId",
    ]) &&
    validPrincipal(value.principal) &&
    [
      value.continuityId,
      value.companionId,
      value.playerId,
      value.chatThreadId,
      value.chatSurfaceSessionId,
      value.operationId,
    ].every(validId) &&
    [value.expectedPartitionRevision, value.expectedSelectionRevision, value.expectedFenceEpoch].every(
      (n) => Number.isSafeInteger(n as number) && (n as number) >= 0,
    )
  );
}
function validArchiveLifecycle(value: unknown): value is ArchiveLifecycleCommand {
  return (
    validPlainObject(value) &&
    hasExactKeys(value, [
      "principal",
      "continuityId",
      "companionId",
      "playerId",
      "chatThreadId",
      "chatSurfaceSessionId",
      "expectedManagementRevision",
      "expectedFenceEpoch",
      "operationId",
      "operation",
    ]) &&
    validPrincipal(value.principal) &&
    [
      value.continuityId,
      value.companionId,
      value.playerId,
      value.chatThreadId,
      value.chatSurfaceSessionId,
      value.operationId,
    ].every(validId) &&
    [value.expectedManagementRevision, value.expectedFenceEpoch].every(
      (n) => Number.isSafeInteger(n as number) && (n as number) >= 0,
    ) &&
    (value.operation === "archive" || value.operation === "trash" || value.operation === "restore")
  );
}
function validGameOrigin(value: unknown, principal: AuthenticatedContinuityPrincipal): boolean {
  return (
    validPlainObject(value) &&
    hasExactKeys(value, ["chatThreadId", "chatSurfaceSessionId", "playerId", "companionId", "continuityId"]) &&
    validId(value.chatThreadId) &&
    validId(value.chatSurfaceSessionId) &&
    samePrincipal(principal, value as AuthenticatedContinuityPrincipal)
  );
}
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.every((key) => keys.includes(key)) &&
    keys.filter((key) => key !== "recoveryRequestId").every((key) => actual.includes(key))
  );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function samePrincipal(
  a: AuthenticatedContinuityPrincipal,
  b: Readonly<{ continuityId: string; companionId: string; playerId: string }>,
): boolean {
  return a.continuityId === b.continuityId && a.companionId === b.companionId && a.playerId === b.playerId;
}
function error(code: string): ContinuityAuthorityCoordinatorError {
  return new ContinuityAuthorityCoordinatorError(code);
}
