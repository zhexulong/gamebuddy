import { join, resolve } from "node:path";
import { withPathLock } from "./path-lock.js";
import {
  consumeStardewBootstrapGuardianOwnerBinding,
  mintStardewBootstrapGuardianSettlementProof,
  readStardewGuardianArmBinding,
  type StardewBootstrapGuardianOwnerBinding,
  type StardewBootstrapGuardianSettlementProof,
  type StardewBootstrapGuardianRecoveryGateBinding,
} from "./stardew-private-bootstrap-composer.core.js";
import type { StardewGuardianBinding } from "./stardew-private-bootstrap-owner-records.private.js";
import type { DesktopGuardianSession, GuardianAck } from "./desktop-guardian-session.internal.js";
import { readStardewBootstrapGuardianNativeArmFrame } from "./stardew-private-bootstrap-composer.core.js";

const OWNER_FILE = "owner.json";
const OPAQUE = /^[A-Za-z0-9_-]{1,128}$/;

type GuardianRole = "playerHost" | "aiClient";
type StardewBootstrapGuardianOutcome = "contained" | "unavailable" | "quarantined";

/** Native contracts only: Batch C supplies the Win32 implementations. */
type StardewBootstrapGuardianControlledClosePort = Readonly<{
  /** Desktop-backed public arm acknowledgement, before the durable CAS. */
  arm?: (binding: StardewBootstrapGuardianOwnerBinding) => Promise<void>;
  /** Desktop-backed public role acknowledgement, before the durable CAS. */
  launchRole?: (binding: StardewBootstrapGuardianOwnerBinding, role: GuardianRole) => Promise<void>;
  drainRole(binding: StardewBootstrapGuardianOwnerBinding, role: GuardianRole): Promise<void>;
  releaseAndExit(binding: StardewBootstrapGuardianOwnerBinding): Promise<void>;
}>;

declare const recoveryCapabilityBrand: unique symbol;
type StardewBootstrapGuardianRecoveryCapability = Readonly<{
  readonly [recoveryCapabilityBrand]: never;
}>;
/** The pre-CAS ingress deliberately has no Job names, owner record revision, or durable role state. */
/** The post-CAS ingress is authorized only after the durable recovering CAS. */
type StardewBootstrapGuardianRecoveryClassificationBinding = StardewBootstrapGuardianOwnerBinding;
type StardewBootstrapGuardianRecoveryGatePort = Readonly<{
  acquire(binding: StardewBootstrapGuardianRecoveryGateBinding): Promise<
    | Readonly<{ kind: "held" }>
    | Readonly<{ kind: "acquired"; capability: StardewBootstrapGuardianRecoveryCapability }>
  >;
  release(capability: StardewBootstrapGuardianRecoveryCapability): Promise<void>;
}>;
type StardewBootstrapGuardianRecoveryClassificationPort = Readonly<{
  classify(binding: StardewBootstrapGuardianRecoveryClassificationBinding, capability: StardewBootstrapGuardianRecoveryCapability, role: GuardianRole): Promise<"contained" | "unavailable" | "quarantined">;
}>;

export type StardewBootstrapGuardianNativePorts = Readonly<{
  controlledClose: StardewBootstrapGuardianControlledClosePort;
  recoveryGate: StardewBootstrapGuardianRecoveryGatePort;
  recoveryClassification: StardewBootstrapGuardianRecoveryClassificationPort;
}>;

export type StardewBootstrapGuardianOwner = Readonly<{
  /** Durable acknowledgement only; it does not claim or launch a native process. */
  arm(): Promise<void>;
  /** Durable role-active acknowledgement only; Batch B makes no native launch claim. */
  launchPlayerHost(): Promise<void>;
  /** Durable role-active acknowledgement only; Batch B makes no native launch claim. */
  launchAiClient(): Promise<void>;
  /** Nonterminal private containment: drains and CASes Player Host only. */
  containPlayerHost(): Promise<void>;
  /** Nonterminal private containment: drains and CASes AI Client only. */
  containAiClient(): Promise<void>;
  recoverOrQuarantine(recoveryInstanceId: string): Promise<StardewBootstrapGuardianOutcome>;
  close(): Promise<StardewBootstrapGuardianOutcome>;
  /** Mints one exact containment proof only after controlled close succeeds. */
  settle(): Promise<StardewBootstrapGuardianSettlementProof>;
}>;

/**
 * Private orchestration owner over one composition-minted, one-shot binding.
 * It never receives a path, fence, revision, record, or persistence callback.
 */
/**
 * Adapts the authenticated Desktop session without exposing its transport. The
 * owner binding is the sole source for every correlation/native arm fact.
 * Launch is intentionally unavailable until an exact native launch plan exists.
 */
export function createStardewBootstrapGuardianNativePortsFromDesktopSession(
  binding: StardewBootstrapGuardianOwnerBinding,
  session: DesktopGuardianSession,
  deadlineUnixMs: number,
): StardewBootstrapGuardianNativePorts {
  if (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= Date.now()) throw new Error("stardew_bootstrap_guardian_session_unavailable");
  const arm = readStardewBootstrapGuardianNativeArmFrame(binding);
  const correlation = Object.freeze({ guardianInstanceId: arm.guardianInstanceId, guardianEpoch: arm.guardianEpoch, attemptId: arm.attemptId });
  const role = (value: GuardianRole): "player_host" | "ai_client" => value === "playerHost" ? "player_host" : "ai_client";
  const expect = (ack: GuardianAck, operation: string, expectedRole?: "player_host" | "ai_client") => {
    if (ack.operation !== operation || ack.bootstrapId !== arm.bootstrapId || ack.guardianInstanceId !== arm.guardianInstanceId ||
        ack.guardianEpoch !== arm.guardianEpoch || ack.attemptId !== arm.attemptId || (expectedRole !== undefined && ack.role !== expectedRole))
      throw new Error("stardew_bootstrap_guardian_session_ack_mismatch");
  };
  return Object.freeze({
      controlledClose: Object.freeze({
      async arm() {
        const body = Buffer.from(JSON.stringify({ guardianInstanceId: arm.guardianInstanceId, guardianEpoch: arm.guardianEpoch, attemptId: arm.attemptId, revision: arm.revision, leaseName: arm.leaseName, playerJobName: arm.playerJobName, aiJobName: arm.aiJobName }), "utf8");
        const ack = await session.arm({ ...correlation, deadlineUnixMs, privateFrame: body });
        expect(ack, "arm_attempt");
      },
      async launchRole(_ownerBinding: StardewBootstrapGuardianOwnerBinding, target: GuardianRole) {
        throw new Error("stardew_bootstrap_guardian_native_launch_plan_unavailable");
      },
      async drainRole(_ownerBinding: StardewBootstrapGuardianOwnerBinding, target: GuardianRole) {
        const ack = await session.contain({ ...correlation, deadlineUnixMs, attemptId: arm.attemptId, role: role(target) });
        expect(ack, "contain_role", role(target));
      },
      async releaseAndExit() { await session.close(); },
    }),
    recoveryGate: Object.freeze({
      async acquire() { return { kind: "held" as const }; },
      async release() { await session.close(); },
    }),
    recoveryClassification: Object.freeze({
      async classify() { return "unavailable" as const; },
    }),
  });
}

export function createStardewBootstrapGuardianOwner(
  binding: StardewBootstrapGuardianOwnerBinding,
  native: StardewBootstrapGuardianNativePorts,
): StardewBootstrapGuardianOwner {
  validateNativePorts(native);
  const consumedBinding = consumeStardewBootstrapGuardianOwnerBinding(binding);
  const transitions = consumedBinding.transitions;
  const recoveryGateBinding = consumedBinding.recoveryGateBinding;
  const settlementBinding = consumedBinding.settlementBinding;
  let settlementProof: StardewBootstrapGuardianSettlementProof | undefined;
  // Reserve settlement synchronously so concurrent callers cannot both enter close/mint.
  let settlementInFlight = false;
  let armState: "new" | "armed" = "new";
  let playerLaunched = false;
  let aiLaunched = false;
  let controlledState: "open" | "closing" | "release_pending" | "closed" | "quarantined" = "open";
  const contained = new Set<GuardianRole>();
  let recovery: undefined | {
    id: string;
    capability: StardewBootstrapGuardianRecoveryCapability;
    phase: "begin" | "classify" | "release_pending" | "quarantine_release_pending" | "closed" | "quarantined";
    readonly classified: Set<GuardianRole>;
  };

  const activate = async (role: GuardianRole): Promise<void> => {
    if (armState !== "armed" || controlledState !== "open" || recovery !== undefined || (role === "playerHost" ? playerLaunched : aiLaunched)) {
      throw new Error("stardew_bootstrap_guardian_owner_transition_unavailable");
    }
    if (native.controlledClose.launchRole !== undefined) await native.controlledClose.launchRole(binding, role);
    await transitions.roleActive(role);
    if (role === "playerHost") playerLaunched = true;
    else aiLaunched = true;
  };
  const quarantineControlled = async (): Promise<boolean> => {
    if (controlledState === "release_pending" || controlledState === "closed") return false;
    try {
      await transitions.quarantine();
      controlledState = "quarantined";
      return true;
    } catch {
      // The predecessor is not known terminal when its quarantine CAS fails.
      return false;
    }
  };
  const beginControlledClose = async (): Promise<void> => {
    if (controlledState === "open") {
      try {
        await transitions.beginControlledClose();
        controlledState = "closing";
      } catch (error) {
        await quarantineControlled();
        throw error;
      }
    }
    if (controlledState !== "closing") throw new Error("stardew_bootstrap_guardian_owner_transition_unavailable");
  };
  const containRole = async (role: GuardianRole): Promise<void> => {
    await beginControlledClose();
    if (contained.has(role)) throw new Error("stardew_bootstrap_guardian_owner_transition_unavailable");
    try {
      await native.controlledClose.drainRole(binding, role);
      await transitions.controlledRoleContained(role);
      contained.add(role);
    } catch (error) {
      await quarantineControlled();
      throw error;
    }
  };
  const finishControlledClose = async (): Promise<StardewBootstrapGuardianOutcome> => {
    if (controlledState === "closed") return "contained";
    if (controlledState === "release_pending") {
      try {
        await native.controlledClose.releaseAndExit(binding);
        controlledState = "closed";
        return "contained";
      } catch {
        return "unavailable";
      }
    }
    if (controlledState === "quarantined") return "quarantined";
    try {
      await beginControlledClose();
      for (const role of ["playerHost", "aiClient"] as const) if (!contained.has(role)) await containRole(role);
      await transitions.finalizeControlledContained();
      controlledState = "release_pending";
      return finishControlledClose();
    } catch {
      return "unavailable";
    }
  };
  const recover = async (recoveryInstanceId: string): Promise<StardewBootstrapGuardianOutcome> => {
    if (!OPAQUE.test(recoveryInstanceId) || controlledState !== "open") throw new Error("stardew_bootstrap_guardian_owner_transition_unavailable");
    if (recovery !== undefined && recovery.id !== recoveryInstanceId) throw new Error("stardew_bootstrap_guardian_owner_transition_unavailable");
    if (recovery?.phase === "closed") return "contained";
    if (recovery?.phase === "quarantined") return "quarantined";
    if (recovery === undefined) {
      let gate: unknown;
        try { gate = await native.recoveryGate.acquire(recoveryGateBinding); } catch { return "unavailable"; }
      if (!isRecoveryGateResult(gate) || gate.kind === "held") return "unavailable";
      recovery = { id: recoveryInstanceId, capability: gate.capability, phase: "begin", classified: new Set() };
    }
    const active = recovery;
    const releaseTerminal = async (outcome: "contained" | "quarantined"): Promise<StardewBootstrapGuardianOutcome> => {
      try {
        await native.recoveryGate.release(active.capability);
        active.phase = outcome === "contained" ? "closed" : "quarantined";
        return outcome;
      } catch {
        active.phase = outcome === "contained" ? "release_pending" : "quarantine_release_pending";
        return "unavailable";
      }
    };
    if (active.phase === "release_pending") return releaseTerminal("contained");
    if (active.phase === "quarantine_release_pending") return releaseTerminal("quarantined");
    try {
      if (active.phase === "begin") {
        await transitions.beginRecovery(active.id);
        active.phase = "classify";
      }
      for (const role of ["playerHost", "aiClient"] as const) {
        if (active.classified.has(role)) continue;
        const classification = await native.recoveryClassification.classify(binding, active.capability, role);
        if (classification !== "contained") {
          await transitions.quarantineRecovery(active.id);
          return releaseTerminal("quarantined");
        }
        await transitions.recoveryRoleContained(role, active.id);
        active.classified.add(role);
      }
      await transitions.finalizeRecoveredContained(active.id);
      active.phase = "release_pending";
      return releaseTerminal("contained");
    } catch {
      if (active.phase === "begin") return "unavailable";
      try {
        await transitions.quarantineRecovery(active.id);
        return releaseTerminal("quarantined");
      } catch { return "unavailable"; }
    }
  };
  return Object.freeze({
    async arm() {
       if (armState !== "new" || controlledState !== "open" || recovery !== undefined) throw new Error("stardew_bootstrap_guardian_owner_transition_unavailable");
       if (native.controlledClose.arm !== undefined) await native.controlledClose.arm(binding);
       await transitions.armAcknowledged();
      armState = "armed";
    },
    launchPlayerHost: () => activate("playerHost"),
    launchAiClient: () => activate("aiClient"),
    containPlayerHost: () => containRole("playerHost"),
    containAiClient: () => containRole("aiClient"),
    recoverOrQuarantine: recover,
    close: finishControlledClose,
    async settle() {
      if (settlementProof !== undefined || settlementInFlight) throw new Error("stardew_bootstrap_guardian_settlement_proof_unavailable");
      settlementInFlight = true;
      try {
        if (await finishControlledClose() !== "contained" || controlledState !== "closed") {
          throw new Error("stardew_bootstrap_guardian_settlement_proof_unavailable");
        }
        settlementProof = mintStardewBootstrapGuardianSettlementProof(binding, settlementBinding);
        return settlementProof;
      } catch (error) {
        settlementInFlight = false;
        throw error;
      }
    },
  });
}

function isRecoveryGateResult(value: unknown): value is Awaited<ReturnType<StardewBootstrapGuardianRecoveryGatePort["acquire"]>> {
  return isRecord(value) && (
    (value.kind === "held" && Object.keys(value).length === 1) ||
    (value.kind === "acquired" && Object.keys(value).length === 2 && value.capability !== undefined)
  );
}

function validateNativePorts(value: StardewBootstrapGuardianNativePorts): void {
  if (!isRecord(value) || !isRecord(value.controlledClose) || !isRecord(value.recoveryGate) || !isRecord(value.recoveryClassification) ||
      typeof value.controlledClose.drainRole !== "function" || typeof value.controlledClose.releaseAndExit !== "function" ||
      typeof value.recoveryGate.acquire !== "function" || typeof value.recoveryGate.release !== "function" ||
      typeof value.recoveryClassification.classify !== "function") throw new TypeError("invalid_stardew_bootstrap_guardian_native_ports");
}

export type StardewBootstrapGuardianArmCorrelation = Readonly<{ runtimeRoot: string; bootstrapId: string; playerId: string; companionId: string; expectedRevision: string; expectedOwnerRecordRevision: number }>;
type StardewBootstrapGuardianArmBinding = Readonly<StardewGuardianBinding & { ownerRecordRevision: number }>;
export type StardewBootstrapGuardianPrivateArmBindingFacade = Readonly<{ consumeArmBinding<T>(callback: (binding: StardewBootstrapGuardianArmBinding) => Promise<T> | T): Promise<T> }>;

export function createStardewBootstrapGuardianPrivateArmBindingFacade(correlation: StardewBootstrapGuardianArmCorrelation): StardewBootstrapGuardianPrivateArmBindingFacade {
  validateCorrelation(correlation);
  const frozenCorrelation = Object.freeze({ ...correlation });
  let consumed = false;
  return Object.freeze({ async consumeArmBinding<T>(callback: (binding: StardewBootstrapGuardianArmBinding) => Promise<T> | T): Promise<T> {
    if (typeof callback !== "function" || consumed) throw new Error("stardew_bootstrap_guardian_arm_binding_unavailable");
    consumed = true;
    const root = resolve(frozenCorrelation.runtimeRoot);
    const ownerPath = join(root, "stardew-private-bootstrap", frozenCorrelation.bootstrapId, OWNER_FILE);
    return withPathLock(ownerPath, async () => callback(await readStardewGuardianArmBinding({ ownerPath, containmentRoot: root, bootstrapId: frozenCorrelation.bootstrapId, playerId: frozenCorrelation.playerId, companionId: frozenCorrelation.companionId, expectedRevision: frozenCorrelation.expectedRevision, expectedOwnerRecordRevision: frozenCorrelation.expectedOwnerRecordRevision, nowMs: Date.now() }) as StardewBootstrapGuardianArmBinding), { containmentRoot: root });
  } });
}
function validateCorrelation(value: StardewBootstrapGuardianArmCorrelation): void {
  if (!isRecord(value) || !exactKeys(value, ["runtimeRoot", "bootstrapId", "playerId", "companionId", "expectedRevision", "expectedOwnerRecordRevision"]) || typeof value.runtimeRoot !== "string" || value.runtimeRoot.length === 0 || !OPAQUE.test(value.bootstrapId) || !OPAQUE.test(value.playerId) || !OPAQUE.test(value.companionId) || !OPAQUE.test(value.expectedRevision) || typeof value.expectedOwnerRecordRevision !== "number" || !Number.isSafeInteger(value.expectedOwnerRecordRevision) || value.expectedOwnerRecordRevision <= 0) throw new TypeError("invalid_stardew_bootstrap_guardian_arm_correlation");
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value).sort(); const wanted = [...expected].sort(); return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]); }
