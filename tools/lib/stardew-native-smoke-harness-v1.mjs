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

const MAX_REQUEST_TIMEOUT_MS = 600_000;
const MAX_TERMINAL_WAIT_MS = 600_000;

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

/**
 * Execute with a snapshot that is re-observed if the world advanced in between.
 *
 * `executeFresh` binds the request to the snapshot it is handed and refuses when the client's cached
 * snapshot is already newer, because a request bound to an outdated revision is not the request the
 * observation justified. The world advancing between an observe and its execute is normal, so this
 * helper treats the refusal as a transient: observe again, and send against the fresh snapshot. It is
 * bounded, so a world that never settles still fails rather than looping.
 */
export async function executeFreshAfterReobserve(client, options, { attempts = 3 } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8) throw new NativeSmokeHarnessError("invalid_native_reobserve_attempts");
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const snapshot = await observeFresh(client, { actionable: options.actionable === true });
    try {
      return await executeFresh(client, { ...options, snapshot });
    } catch (error) {
      if (error instanceof NativeSmokeHarnessError && error.code === "stale_native_snapshot") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new NativeSmokeHarnessError("stale_native_snapshot");
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

/**
 * Assert that every capability a shared-world smoke contract requires is present
 * in the live surface. This is the required-subset capability mode; it is
 * deliberately not `assertExactCapabilities`.
 *
 * A shared world runs the Mod's default consent policy: deny-by-exception, so
 * the Agent-visible surface is every registration whose lifecycle is published
 * or live-verified, minus anything the player denied, plus the experimental
 * actions this profile opted into. That surface is legitimately larger than the
 * one action under test and the runner cannot narrow it, so an equality
 * assertion would fail for a reason the action itself cannot fix. Subset is the
 * honest check there: it still proves the action under test and every
 * precondition it depends on are actually advertised and executable by this
 * exact live publication, and it fails closed on a missing entry, an empty
 * requirement list, or a malformed surface. Ordering and duplicates in the
 * required list carry no meaning.
 *
 * "The fixture leaked another action" is NOT provable here and never was a
 * real contract: under deny-by-exception the whole published底座 is
 * legitimately advertised. Isolation of the policy itself (no unopted
 * experimental action, no denied action, no denied family) is proven once, in
 * `stardew-policy-isolation.test.mjs`, instead of being asserted 39 times with
 * a hand-written list that broke every time an action changed lifecycle.
 */
export function assertRequiredCapabilities(snapshot, requiredCapabilities) {
  validateSnapshot(snapshot);
  if (
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.length === 0 ||
    requiredCapabilities.some((capability) => typeof capability !== "string" || capability.length === 0)
  )
    throw new NativeSmokeHarnessError("invalid_native_required_capabilities");
  if (!Array.isArray(snapshot.capabilities)) throw new NativeSmokeHarnessError("invalid_native_capability_surface");
  const advertised = new Set(snapshot.capabilities);
  const missing = [...new Set(requiredCapabilities)].filter((capability) => !advertised.has(capability)).sort();
  if (missing.length > 0) throw new NativeSmokeHarnessError(`native_required_capability_missing:${missing.join(",")}`);
  return snapshot;
}

/**
 * Validate the Mod policy block of a smoke client config.
 *
 * This is the one place a runner checks policy shape. It replaces the inline
 * `config.ActionPolicyVersion !== 0 || config.EnabledActions !== ...` clauses
 * that every runner used to carry: those fields no longer exist, because the
 * Agent surface is derived from the Mod catalog with deny-by-exception rather
 * than selected by a hand-written allowlist.
 *
 * What it still enforces, and why each part matters:
 *   - `DeniedActions`/`DeniedActionFamilies` must be arrays (a fixture that
 *     cannot express what it denies cannot be checked at all);
 *   - no action or family the runner requires may be denied by this same
 *     config, which would make the run fail for a policy reason the action
 *     itself cannot fix;
 *   - `ExperimentalActions` may only name actions the caller declares
 *     experimental, so the test-only opt-in cannot silently grant itself a
 *     capability the catalog does not classify that way.
 *
 * It deliberately does NOT assert an exact visible surface. Under
 * deny-by-exception the published底座 is legitimately advertised and a runner
 * cannot narrow it; the isolation proof lives in stardew-policy-isolation.
 */
export function validateNativeLocalFixturePolicy(
  config,
  { requiredActions = [], experimentalActions } = {},
) {
  const denied = config?.DeniedActions;
  const deniedFamilies = config?.DeniedActionFamilies;
  if (!Array.isArray(denied) || !Array.isArray(deniedFamilies))
    throw new NativeSmokeHarnessError("native_fixture_policy_invalid");
  const deniedSet = new Set(denied);
  const blocking = requiredActions.filter((action) => deniedSet.has(action));
  if (blocking.length > 0) throw new NativeSmokeHarnessError(`native_fixture_policy_denies_required:${blocking.join(",")}`);
  const optedIn = config?.ExperimentalActions;
  if (!Array.isArray(optedIn)) throw new NativeSmokeHarnessError("native_fixture_policy_invalid");
  // Only enforced when the caller declares which actions may legitimately be
  // opted in. A fixture whose action under test is still experimental must name
  // it, so a blanket "no opt-ins allowed" rule would be wrong.
  if (Array.isArray(experimentalActions)) {
    const allowed = new Set(experimentalActions);
    const illegal = optedIn.filter((action) => !allowed.has(action));
    if (illegal.length > 0) throw new NativeSmokeHarnessError(`native_fixture_policy_illegal_opt_in:${illegal.join(",")}`);
  }
  return config;
}

/**
 * Classify the live topology from the client config a runner was handed.
 *
 * The two supported topologies are mutually exclusive by construction. A config
 * that claims both markers, or neither, fails closed rather than being silently
 * treated as one of them: guessing here would let a runner validate a topology
 * it is not actually connected to.
 */
export function classifyTopology(config) {
  const sharedWorld = config?.FarmhandProvisioner?.Enable === true;
  const nativeLocal = config?.NativeLocalPlayerFixture?.Enable === true;
  if (sharedWorld && nativeLocal) throw new NativeSmokeHarnessError("contradictory_topology_markers");
  if (sharedWorld) return "shared_world_farmhand";
  if (nativeLocal) return "native_local_player_fixture";
  throw new NativeSmokeHarnessError("unknown_topology");
}

/**
 * Assert the capabilities a contract requires for one specific topology.
 *
 * - `native_local_player_fixture` keeps exact equality, which additionally
 *   proves the isolated fixture publication leaked no other action.
 * - `shared_world_farmhand` needs required-subset, because that topology
 *   legitimately publishes the whole consented surface and the runner cannot
 *   narrow it. Equality would fail for a reason the action cannot fix.
 *
 * Both modes still prove the action under test and every precondition it
 * depends on are advertised and executable by this exact live publication.
 */
export function assertTopologyCapabilities(snapshot, topology, requiredCapabilities) {
  if (topology === "shared_world_farmhand") return assertRequiredCapabilities(snapshot, requiredCapabilities);
  if (topology === "native_local_player_fixture") return assertExactCapabilities(snapshot, requiredCapabilities);
  throw new NativeSmokeHarnessError("unknown_topology");
}

/**
 * Observe the opening snapshot of a contract under a known topology.
 *
 * - `native_local_player_fixture` uses the strict form: its isolated fixture
 *   publishes exactly the surface the runner expects, so an un-admitted read is
 *   always an error.
 * - `shared_world_farmhand` tolerates the bridge's deliberate refusal to
 *   re-admit a revision it already admitted. A committed action mints one
 *   revision and admits the projection that follows it; a later solicited read
 *   at that same revision is refused on purpose and must never surface an
 *   un-admitted projection. The already-admitted projection is the current
 *   truth, and every request is re-admitted on the game thread anyway, so
 *   falling back to it is honest rather than a weaker check.
 */
export async function observeTopologySnapshot(client, topology, { actionable = false, timeoutMs = 5_000 } = {}) {
  if (topology === "native_local_player_fixture") return await observeFresh(client, { actionable });
  if (topology !== "shared_world_farmhand") throw new NativeSmokeHarnessError("unknown_topology");
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await observeFresh(client, { actionable });
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || error.message !== "observe_snapshot_not_admitted") throw error;
    }
    const cached = client.state?.snapshot ?? null;
    if (cached !== null && typeof cached.location === "string" && cached.location.length > 0 && cached.location !== "unknown" && Number.isSafeInteger(cached.tile?.x) && cached.tile.x >= 0 && (!actionable || cached.actionable === true)) {
      return cached;
    }
    await delay(100);
  }
  throw lastError ?? new NativeSmokeHarnessError("observe_snapshot_not_admitted");
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
    // Native HUD notice text the game posted inside the action's synchronous
    // window ("+1 Leek", "Out of season."). Forwarded verbatim; absent means the
    // dispatch produced none.
    ...(receipt.nativeNotices == null ? {} : { nativeNotices: receipt.nativeNotices }),
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

/**
 * Poll until the snapshot is actionable with no active execution. A polled
 * observe may be rejected as stale while the world revision is unchanged
 * between actions; that is "not changed yet", not a terminal failure, so the
 * poll continues to its deadline.
 */
export async function waitForActionable(client, snapshot, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TERMINAL_WAIT_MS)
    throw new NativeSmokeHarnessError("invalid_native_actionable_timeout");
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest?.actionable === true && latest.activeExecution == null) return latest;
    await delay(100);
    latest = await observeFreshPolling(client);
  }
  throw new NativeSmokeHarnessError("native_snapshot_not_actionable");
}

/**
 * One poll observation that tolerates the client's stale-revision rejection
 * (same world revision between actions) as "not changed yet".
 */
async function observeFreshPolling(client) {
  try {
    return await observeFresh(client);
  } catch (error) {
    if (error instanceof Error && error.message === "observe_snapshot_not_admitted") {
      const cached = client.state?.snapshot;
      if (cached !== null && cached !== undefined) return cached;
    }
    throw error;
  }
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
    const snapshot = await observeFreshPolling(client);
    if (snapshot.revision < minRevision) { await delay(100); continue; }
    if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null)) { await delay(100); continue; }
    if (check !== undefined && !check(snapshot)) { await delay(100); continue; }
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
