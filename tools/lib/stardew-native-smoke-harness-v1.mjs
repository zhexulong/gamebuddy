// Stardew-local mechanical mechanics for native player smoke runners.
// This module deliberately does not choose actions or targets, interpret native
// evidence, grant capabilities, or decide action-specific postconditions.

import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./host-production-module.mjs";

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
  if (receipt.requestId !== requestId) throw new NativeSmokeHarnessError("native_receipt_request_id_mismatch");
  return receipt;
}

/** Require the exact request/execution pair for an authoritative receipt. */
export function assertReceiptIdentity(receipt, accepted) {
  validateId(accepted?.requestId, "invalid_native_accepted_request_id");
  validateId(accepted?.executionId, "invalid_native_accepted_execution_id");
  validateId(receipt?.requestId, "invalid_native_receipt_request_id");
  validateId(receipt?.executionId, "invalid_native_receipt_execution_id");
  if (receipt.requestId !== accepted.requestId) throw new NativeSmokeHarnessError("native_receipt_request_id_mismatch");
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
  if (!Number.isSafeInteger(terminal?.revision)) throw new NativeSmokeHarnessError("invalid_native_terminal_revision");
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
    actionable: snapshot.actionable,
    capabilityCount: Array.isArray(snapshot.capabilities) ? snapshot.capabilities.length : 0,
    hasLocation: typeof snapshot.location === "string" && snapshot.location.length > 0,
    hasTile: snapshot.tile != null,
    activeExecution: snapshot.activeExecution
      ? {
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
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    hasEvidence: receipt.evidence != null,
  };
}

/** Look up one required CLI argument by exact name. */
export function requiredArg(name, argv = process.argv) {
  if (typeof name !== "string" || !name.startsWith("--")) throw new NativeSmokeHarnessError("invalid_native_arg_name");
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) throw new NativeSmokeHarnessError(`missing_${name.slice(2)}`);
  return argv[index + 1];
}

/** Read and parse the bounded runner client config JSON from --client-config. */
export async function readNativeClientConfig(argv = process.argv) {
  let raw;
  try {
    raw = await readFile(requiredArg("--client-config", argv), "utf8");
  } catch (_error) {
    throw new NativeSmokeHarnessError("invalid_native_client_config");
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new NativeSmokeHarnessError("invalid_native_client_config");
  }
}

/**
 * Connect one native-local smoke session: production client, bounded scope,
 * receipt buffer, and a close() that unsubscribes and closes the client.
 * `loadModule` is injectable for contract tests; production always loads the
 * immutable Host production generation.
 */
export async function connectNativeLocalClient(
  config,
  { loadModule = loadHostProductionModule, entry = "local-stardew-bridge.js" } = {},
) {
  if (!config || typeof config !== "object") throw new NativeSmokeHarnessError("invalid_native_config");
  if (
    typeof config.PipeName !== "string" ||
    config.PipeName.length === 0 ||
    typeof config.BridgeToken !== "string" ||
    config.BridgeToken.length === 0
  )
    throw new NativeSmokeHarnessError("invalid_native_config");
  const scope = createNativeScope(config);
  const { LocalStardewBridgeClient } = await loadModule(entry);
  const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
  const receipts = [];
  const diagnostics = [];
  const unsubscribe = client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const unsubscribeDiagnostic = typeof client.onDiagnostic === "function"
    ? client.onDiagnostic((diagnostic) => {
      diagnostics.push(diagnostic);
      if (diagnostics.length > 16) diagnostics.shift();
    })
    : () => {};
  return {
    client,
    scope,
    receipts,
    diagnostics,
    async close() {
      unsubscribe();
      unsubscribeDiagnostic();
      await client.close();
    },
  };
}

/** Poll until the snapshot is actionable with no active execution. */
export async function waitForActionable(client, snapshot, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TERMINAL_WAIT_MS)
    throw new NativeSmokeHarnessError("invalid_native_actionable_timeout");
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest?.actionable === true && latest.activeExecution == null) return latest;
    await delay(100);
    latest = await observeFresh(client);
  }
  throw new NativeSmokeHarnessError("native_snapshot_not_actionable");
}

/**
 * Poll fresh observations until one satisfies revision, actionability, and an
 * optional action-supplied check. Never interprets native evidence itself.
 */
export async function waitForFreshSnapshot(
  client,
  { minRevision = 0, timeoutMs = 5_000, requireActionable = false, check } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TERMINAL_WAIT_MS)
    throw new NativeSmokeHarnessError("invalid_native_reread_timeout");
  if (!Number.isSafeInteger(minRevision) || minRevision < 0)
    throw new NativeSmokeHarnessError("invalid_native_reread_revision");
  if (check !== undefined && typeof check !== "function")
    throw new NativeSmokeHarnessError("invalid_native_reread_check");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await observeFresh(client);
    if (snapshot.revision < minRevision) continue;
    if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null)) continue;
    if (check !== undefined && !check(snapshot)) continue;
    return snapshot;
  }
  throw new NativeSmokeHarnessError("native_fresh_snapshot_timeout");
}

/**
 * Poll fresh observations for a stable post-terminal revision window. A
 * revision that advanced past the terminal is fail-closed: the observation
 * no longer describes the same execution's postcondition.
 */
export async function waitForStableRevision(client, { revision, timeoutMs = 5_000, check } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new NativeSmokeHarnessError("invalid_native_revision");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TERMINAL_WAIT_MS)
    throw new NativeSmokeHarnessError("invalid_native_reread_timeout");
  if (check !== undefined && typeof check !== "function")
    throw new NativeSmokeHarnessError("invalid_native_reread_check");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await observeFresh(client);
    if (snapshot.revision > revision)
      throw new NativeSmokeHarnessError(`native_post_terminal_revision_mismatch:${snapshot.revision}:${revision}`);
    if (snapshot.revision === revision && (check === undefined || check(snapshot))) return snapshot;
    await delay(100);
  }
  throw new NativeSmokeHarnessError("native_stable_revision_timeout");
}

/** Shared bounded sleep for polling loops. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Number.isSafeInteger(snapshot.revision))
    throw new NativeSmokeHarnessError("invalid_native_snapshot");
}

function validateId(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new NativeSmokeHarnessError(code);
}
