// Stardew-local mechanical mechanics for native player smoke runners.
// This module deliberately does not choose actions or targets, interpret native
// evidence, grant capabilities, or decide action-specific postconditions.

export const TERMINAL_STATES = new Set([
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
]);

const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TERMINAL_WAIT_MS = 300_000;

export class NativeSmokeHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = "NativeSmokeHarnessError";
    this.code = code;
  }
}

/** Build the exact Stardew bridge scope without carrying authentication data. */
export function createNativeScope(config) {
  if (!config || typeof config !== "object") throw new NativeSmokeHarnessError("invalid_native_config");
  const scope = {
    integrationId: "stardew",
    saveId: config.SaveId,
    worldId: config.WorldId,
    playerId: config.PlayerId,
    companionId: config.CompanionId,
  };
  for (const value of Object.values(scope)) {
    if (typeof value !== "string" || value.length === 0) throw new NativeSmokeHarnessError("invalid_native_scope");
  }
  return Object.freeze(scope);
}

/** Return a bounded absolute wall-clock deadline for a Mod request. */
export function deadlineAfter(timeoutMs, now = Date.now()) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS)
    throw new NativeSmokeHarnessError("invalid_native_request_timeout");
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - timeoutMs)
    throw new NativeSmokeHarnessError("invalid_native_deadline_clock");
  return now + timeoutMs;
}

/** Observe once and reject malformed or stale local state before a request. */
export async function observeFresh(client, { actionable = false } = {}) {
  if (!client || typeof client.observe !== "function") throw new NativeSmokeHarnessError("invalid_native_client");
  const snapshot = await client.observe();
  validateSnapshot(snapshot);
  const cachedRevision = client.state?.snapshot?.revision;
  if (Number.isSafeInteger(cachedRevision) && cachedRevision > snapshot.revision)
    throw new NativeSmokeHarnessError("stale_native_snapshot");
  if (actionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new NativeSmokeHarnessError("native_snapshot_not_actionable");
  return snapshot;
}

/** Submit one fresh, revision-bound request and verify its immediate receipt. */
export async function executeFresh(client, { action, args, snapshot, requestId, idempotencyKey, timeoutMs }) {
  if (!client || typeof client.execute !== "function") throw new NativeSmokeHarnessError("invalid_native_client");
  if (typeof action !== "string" || action.length === 0) throw new NativeSmokeHarnessError("invalid_native_action");
  validateSnapshot(snapshot);
  validateId(requestId, "invalid_native_request_id");
  validateId(idempotencyKey, "invalid_native_idempotency_key");
  const cachedRevision = client.state?.snapshot?.revision;
  if (Number.isSafeInteger(cachedRevision) && cachedRevision > snapshot.revision)
    throw new NativeSmokeHarnessError("stale_native_snapshot");
  const accepted = await client.execute({
    requestId,
    idempotencyKey,
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: deadlineAfter(timeoutMs),
  });
  // The bridge's response is the only source of the execution identity, but
  // it is still untrusted input. Validate request correlation and require the
  // returned executionId independently before handing the pair to any later
  // receipt wait; never manufacture an expected id from a missing field.
  assertImmediateReceipt(accepted, { requestId });
  return accepted;
}

/** Validate the immediate bridge response before using its returned executionId. */
export function assertImmediateReceipt(receipt, { requestId } = {}) {
  validateId(requestId, "invalid_native_accepted_request_id");
  validateId(receipt?.requestId, "invalid_native_receipt_request_id");
  validateId(receipt?.executionId, "invalid_native_receipt_execution_id");
  if (receipt.requestId !== requestId)
    throw new NativeSmokeHarnessError("native_receipt_request_id_mismatch");
  return receipt;
}

/** Require the exact request/execution pair for an authoritative receipt. */
export function assertReceiptIdentity(receipt, accepted) {
  validateId(accepted?.requestId, "invalid_native_accepted_request_id");
  validateId(accepted?.executionId, "invalid_native_accepted_execution_id");
  validateId(receipt?.requestId, "invalid_native_receipt_request_id");
  validateId(receipt?.executionId, "invalid_native_receipt_execution_id");
  if (receipt.requestId !== accepted.requestId)
    throw new NativeSmokeHarnessError("native_receipt_request_id_mismatch");
  if (receipt.executionId !== accepted.executionId)
    throw new NativeSmokeHarnessError("native_receipt_execution_id_mismatch");
  return receipt;
}

/** Assert the exact action capability surface expected by a smoke contract. */
export function assertExactCapabilities(snapshot, expectedCapabilities) {
  validateSnapshot(snapshot);
  if (!Array.isArray(expectedCapabilities) || expectedCapabilities.some((value) => typeof value !== "string"))
    throw new NativeSmokeHarnessError("invalid_native_expected_capabilities");
  const actual = [...(Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [])].sort();
  const expected = [...expectedCapabilities].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
    throw new NativeSmokeHarnessError("native_capability_surface_mismatch");
  return snapshot;
}

/** Bind the post-terminal observation to the receipt revision exposed by v1. */
export function assertPostTerminalRevision(snapshot, terminal) {
  validateSnapshot(snapshot);
  validateId(terminal?.requestId, "invalid_native_terminal_request_id");
  validateId(terminal?.executionId, "invalid_native_terminal_execution_id");
  if (!Number.isSafeInteger(terminal?.revision))
    throw new NativeSmokeHarnessError("invalid_native_terminal_revision");
  if (snapshot.revision !== terminal.revision)
    throw new NativeSmokeHarnessError("native_post_terminal_revision_mismatch");
  return snapshot;
}

/**
 * Wait for a terminal receipt matching both identities. Nonmatching facts are
 * intentionally ignored: a stale fact must never satisfy this wait.
 */
export async function waitForTerminal(receipts, accepted, timeoutMs) {
  if (!Array.isArray(receipts)) throw new NativeSmokeHarnessError("invalid_native_receipt_buffer");
  validateId(accepted?.requestId, "invalid_native_accepted_request_id");
  validateId(accepted?.executionId, "invalid_native_accepted_execution_id");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TERMINAL_WAIT_MS)
    throw new NativeSmokeHarnessError("invalid_native_terminal_timeout");

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const terminal = [accepted, ...receipts].find(
      (receipt) =>
        receipt?.requestId === accepted.requestId &&
        receipt?.executionId === accepted.executionId &&
        TERMINAL_STATES.has(receipt.state),
    );
    if (terminal !== undefined) return assertReceiptIdentity(terminal, accepted);
    if (Date.now() >= deadline) break;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw new NativeSmokeHarnessError("native_terminal_receipt_missing_or_stale");
}

/** Redacted, action-neutral snapshot diagnostics. */
export function summarizeSnapshot(snapshot) {
  if (snapshot == null) return null;
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    capabilityCount: Array.isArray(snapshot.capabilities) ? snapshot.capabilities.length : 0,
    activeExecution: snapshot.activeExecution
      ? {
          executionId: snapshot.activeExecution.executionId,
          requestId: snapshot.activeExecution.requestId,
          state: snapshot.activeExecution.state,
          reasonCode: snapshot.activeExecution.reasonCode,
        }
      : null,
  };
}

/** Redacted, action-neutral receipt diagnostics; native evidence is omitted. */
export function summarizeReceipt(receipt) {
  if (receipt == null) return null;
  return {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    hasEvidence: receipt.evidence != null,
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Number.isSafeInteger(snapshot.revision))
    throw new NativeSmokeHarnessError("invalid_native_snapshot");
}

function validateId(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new NativeSmokeHarnessError(code);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
