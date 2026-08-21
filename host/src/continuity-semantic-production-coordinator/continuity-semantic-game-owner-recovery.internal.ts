import {
  createCanonicalProductionAuthorityAdmission,
  openKnownProductionContinuityFromCanonicalAdmission,
  type FreshContinuityProvision,
  type FreshContinuityProvisionOptions,
} from "../continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js";
import type {
  ProductionGameReadback,
  ProductionGameRecoveryTarget,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  createWindowsOwnerDeathVerifier,
  type WindowsOwnerDeathVerifier,
} from "../continuity-semantic-owner-death/continuity-semantic-owner-death.windows.js";
import { WindowsNamedMutexBroker } from "../windows-named-mutex-broker.js";
import {
  createWindowsAuthorityRootMutex,
  type WindowsAuthorityRootMutex,
  type WindowsPartitionMutexLease,
} from "../windows-partition-mutex.js";

export class SemanticGameOwnerRecoveryError extends Error {
  public constructor(readonly code: string) {
    super(code);
    this.name = "SemanticGameOwnerRecoveryError";
  }
}

export type SemanticGameOwnerRecoveryAuthority = Readonly<{
  authority: "SEMANTIC";
  recoverDeadOwner(input: Readonly<{ request: "recover_dead_owner"; operationId: string }>): Promise<ProductionGameReadback>;
  close(): Promise<void>;
}>;

/** Opens only an already-provisioned authority; it never creates or adopts a root. */
export async function createKnownSemanticGameOwnerRecoveryAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
): Promise<SemanticGameOwnerRecoveryAuthority> {
  const input: FreshContinuityProvisionOptions = Object.freeze({
    runtimeCwd: manifest.runtimeRoot,
    principal: Object.freeze({ ...manifest.principal }),
    bootstrapOperationId: manifest.bootstrapOperationId,
    authorityGeneration: manifest.authorityGeneration,
  });
  const broker = new WindowsNamedMutexBroker();
  const mutex = createWindowsAuthorityRootMutex(broker);
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    const provision = await openProvisionWithAdmission(
      () => openKnownProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    return createRecoveryAuthority(provision, mutex, broker, createWindowsOwnerDeathVerifier());
  } catch (error) {
    await closeOwnedMutex(mutex, broker).catch(() => undefined);
    throw error;
  }
}

function createRecoveryAuthority(
  provision: FreshContinuityProvision,
  mutex: WindowsAuthorityRootMutex,
  broker: WindowsNamedMutexBroker,
  verifier: WindowsOwnerDeathVerifier,
): SemanticGameOwnerRecoveryAuthority {
  let closing = false;
  let closed = false;
  let pending = 0;
  let closePromise: Promise<void> | undefined;
  const waiters = new Set<() => void>();
  const begin = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed) return Promise.reject(new SemanticGameOwnerRecoveryError("semantic_game_owner_recovery_closed"));
    pending += 1;
    return work().finally(() => {
      pending -= 1;
      if (pending === 0) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    });
  };
  const locked = async <T>(work: () => T): Promise<T> => {
    const lease = await requireLease(mutex, provision.authorityRootIdentity, provision, () => {
      closing = true;
    });
    try {
      return work();
    } finally {
      await lease.release();
    }
  };
  return Object.freeze({
    authority: "SEMANTIC" as const,
    recoverDeadOwner: (input) =>
      begin(() =>
        orchestrateExplicitGameRecovery(
          input,
          (operationId) =>
            locked(() => provision.store.readGameRecoveryTarget(Object.freeze({ principal: provision.principal, operationId }))),
          (target, proof) =>
            locked(() =>
              provision.store.recoverGame(
                Object.freeze({
                  request: "recover_dead_owner" as const,
                  principal: provision.principal,
                  permit: target.permit,
                  proof,
                  receipt: recoveryReceipt(target),
                }),
              ),
            ),
          verifier,
        ),
      ),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (pending !== 0) await new Promise<void>((resolve) => waiters.add(resolve));
        provision.close();
        await closeOwnedMutex(mutex, broker);
        closed = true;
      })();
      return closePromise;
    },
  });
}

/** Shared recovery choreography; tests inject only a neutral OS verifier. */
export async function orchestrateExplicitGameRecovery(
  input: Readonly<{ request: "recover_dead_owner"; operationId: string }>,
  readTarget: (operationId: string) => Promise<ProductionGameRecoveryTarget | null>,
  forward: (target: ProductionGameRecoveryTarget, proof: import("../continuity-semantic-owner-death/continuity-semantic-owner-death.internal.js").WindowsOwnerDeathVerification) => Promise<ProductionGameReadback>,
  verifier: WindowsOwnerDeathVerifier,
): Promise<ProductionGameReadback> {
  if (!validRecoveryRequest(input)) throw new SemanticGameOwnerRecoveryError("semantic_game_recovery_request_rejected");
  const target = await readTarget(input.operationId);
  if (!target) throw new SemanticGameOwnerRecoveryError("semantic_game_recovery_target_unavailable");
  // Exactly one fresh verifier call, after the durable target has been read.
  return forward(target, await verifier.verify(target.owner));
}

async function openProvisionWithAdmission(
  open: () => FreshContinuityProvision,
  root: string,
  mutex: WindowsAuthorityRootMutex,
): Promise<FreshContinuityProvision> {
  const lease = await requireLease(mutex, root, undefined);
  let provision: FreshContinuityProvision | undefined;
  let sealed = false;
  const seal = async () => { if (!sealed) { sealed = true; await lease.safetySealAfterAbandonedQuarantineFailure(); } };
  try {
    try { provision = open(); } catch (error) { if (lease.disposition === "abandoned") await seal(); throw error; }
    if (lease.disposition === "abandoned") {
      try {
        provision.store.quarantineAfterAbandonedMutex();
        const state = provision.store.readQuarantine();
        if (!state.quarantined || state.reason !== "abandoned_windows_root_mutex") throw new Error("quarantine_readback_mismatch");
        await lease.release();
      } catch (error) { await seal(); throw error; }
      throw new SemanticGameOwnerRecoveryError("semantic_production_abandoned_mutex_quarantined");
    }
    await lease.release();
    return provision;
  } catch (error) {
    if (lease.disposition !== "abandoned") await lease.release().catch(() => undefined);
    else if (!sealed) await seal().catch(() => undefined);
    provision?.close();
    throw error;
  }
}

async function requireLease(
  mutex: WindowsAuthorityRootMutex,
  root: string,
  provision: FreshContinuityProvision | undefined,
  poisonBeforeVerifiedRelease?: () => void,
): Promise<WindowsPartitionMutexLease> {
  if (!mutex.acquire) throw new SemanticGameOwnerRecoveryError("semantic_production_root_mutex_required");
  const lease = await mutex.acquire(root);
  if (lease.disposition !== "abandoned" || !provision) return lease;
  try {
    provision.store.quarantineAfterAbandonedMutex();
    const state = provision.store.readQuarantine();
    if (!state.quarantined || state.reason !== "abandoned_windows_root_mutex") throw new Error("quarantine_readback_mismatch");
  } catch (error) {
    await lease.safetySealAfterAbandonedQuarantineFailure();
    throw error;
  }
  poisonBeforeVerifiedRelease?.();
  try { await lease.release(); } catch (error) { await lease.safetySealAfterAbandonedQuarantineFailure(); throw error; }
  throw new SemanticGameOwnerRecoveryError("semantic_production_abandoned_mutex_quarantined");
}

function recoveryReceipt(target: ProductionGameRecoveryTarget) {
  const permit = target.permit;
  return Object.freeze({ kind: "recovery_completed" as const, operationId: permit.operationId, requestId: permit.requestId, gameSessionId: permit.gameSessionId, bindingDigest: permit.bindingDigest, world: permit.world, owner: permit.owner, fenceToken: permit.fenceToken, occurredAtMs: Date.now() });
}
function validRecoveryRequest(input: unknown): input is Readonly<{ request: "recover_dead_owner"; operationId: string }> {
  return !!input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).length === 2 && (input as { request?: unknown }).request === "recover_dead_owner" && typeof (input as { operationId?: unknown }).operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test((input as { operationId: string }).operationId);
}
async function closeOwnedMutex(mutex: WindowsAuthorityRootMutex, broker: WindowsNamedMutexBroker): Promise<void> {
  let failure: unknown;
  for (const close of [() => mutex.close(), () => broker.close()]) try { await close(); } catch (error) { failure ??= error; }
  if (failure !== undefined) throw failure;
}
