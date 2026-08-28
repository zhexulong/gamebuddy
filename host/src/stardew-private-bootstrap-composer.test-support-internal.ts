import {
  createStardewPrivateBootstrapTestCore,
  type StardewOwnedPlayerHostPhaseACoreTestView,
  type StardewOwnedPlayerHostStageCResult,
  type StardewPrivateBootstrapCoreDependencies,
} from "./stardew-private-bootstrap-composer.core.js";
import type { AdmittedStardewInstallation } from "./stardew-installation-admission.js";
import type { StardewManifestHandoffCoordinator } from "./stardew-private-bootstrap-composer.core.js";
import type {
  StardewOwnedPlayerHostPhaseAOwner,
  StardewPrivateBootstrapComposition as PublicStardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.js";

export type {
  StardewOwnedPlayerHostStageCResult,
  StardewPrivateBootstrapCoreDependencies,
} from "./stardew-private-bootstrap-composer.core.js";

export type StardewOwnedPlayerHostPhaseATestView = StardewOwnedPlayerHostPhaseACoreTestView;
export type StardewManifestAdmissionForTesting = Awaited<ReturnType<StardewManifestHandoffCoordinator["confirmAndAdmit"]>>;

/**
 * Deterministic package and secret fixtures are intentionally defined only in
 * this internal test adapter. They are never accepted by public test support.
 */
export type StardewPrivateModProfileStagingTestSupportInput = Readonly<{
  readPackage(): Promise<Readonly<{ root: string; entries: readonly string[] }>>;
  createSecret(): string;
  nowMs(): number;
}>;

export type StardewPrivateBootstrapTestingComposition = Readonly<{
  composition: PublicStardewPrivateBootstrapComposition;
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostPhaseAOwner): import("./stardew-attachment.js").StardewAttachmentFlow;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  consumeStagedOwnedPlayerHostPhaseB(owner: StardewOwnedPlayerHostPhaseAOwner): void;
  materializeAiClientProfileAfterManifestAdmission(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    admission: StardewManifestAdmissionForTesting,
  ): Promise<void>;
  launchOwnedPlayerHostStageC(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  reserveOwnedPlayerHostPhaseAForActivation(
    runtimeRoot: string,
    claim: import("./stardew-player-host-bootstrap.js").StardewPlayerHostBootstrapClaim,
  ): Promise<StardewOwnedPlayerHostPhaseAOwner>;
  stageOwnedPlayerHostPhaseB(owner: StardewOwnedPlayerHostPhaseAOwner): Promise<void>;
  terminalizeOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostPhaseAOwner): void;
  bindOwnedPlayerHostPhaseAOwner(
    owner: StardewOwnedPlayerHostPhaseAOwner,
  ): StardewOwnedPlayerHostPhaseATestView;
  quarantineOwnedPlayerHostOwner(
    owner: StardewOwnedPlayerHostPhaseAOwner,
  ): Promise<void>;
}>;

const testOwnerBinders = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (owner: StardewOwnedPlayerHostPhaseAOwner) => StardewOwnedPlayerHostPhaseATestView
>();
const testOwnerViews = new WeakMap<
  object,
  Readonly<{
    composition: PublicStardewPrivateBootstrapComposition;
    bind: (owner: StardewOwnedPlayerHostPhaseAOwner) => StardewOwnedPlayerHostPhaseATestView;
  }>
>();
const testOwnedPhaseBConsumers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (owner: StardewOwnedPlayerHostPhaseAOwner) => void
>();
const testAiClientMaterializers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (
    owner: StardewOwnedPlayerHostPhaseAOwner,
    admission: StardewManifestAdmissionForTesting,
  ) => Promise<void>
>();
const testStageCLaunchers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (
    owner: StardewOwnedPlayerHostPhaseAOwner,
    installation: AdmittedStardewInstallation,
  ) => Promise<StardewOwnedPlayerHostStageCResult>
>();

function registerTestingComposition(
  testingComposition: StardewPrivateBootstrapTestingComposition,
): StardewPrivateBootstrapTestingComposition {
  const base = testingComposition.composition;
  const reserveOwnedPlayerHostPhaseA = base.reserveOwnedPlayerHostPhaseA.bind(base);
  const composition: PublicStardewPrivateBootstrapComposition = Object.freeze({
    ...base,
    async reserveOwnedPlayerHostPhaseA(...args) {
      const owner = await reserveOwnedPlayerHostPhaseA(...args);
      testOwnerViews.set(owner, Object.freeze({
        composition,
        bind: testingComposition.bindOwnedPlayerHostPhaseAOwner,
      }));
      return owner;
    },
  });
  testOwnerBinders.set(composition, testingComposition.bindOwnedPlayerHostPhaseAOwner);
  testOwnedPhaseBConsumers.set(composition, testingComposition.consumeStagedOwnedPlayerHostPhaseB);
  testAiClientMaterializers.set(composition, testingComposition.materializeAiClientProfileAfterManifestAdmission);
  testStageCLaunchers.set(composition, testingComposition.launchOwnedPlayerHostStageC);
  return Object.freeze({ ...testingComposition, composition });
}

/**
 * Dedicated internal-only adapter over the neutral closed composition core.
 * Callers in this file may provide deterministic package/secret fixtures; the
 * public test-support constructor cannot provide those dependencies.
 */
export function createStardewPrivateBootstrapCompositionForTesting(
  dependencies: StardewPrivateBootstrapCoreDependencies,
): StardewPrivateBootstrapTestingComposition {
  const core = createStardewPrivateBootstrapTestCore(dependencies);
  return registerTestingComposition(Object.freeze({
    ...core,
    materializeAiClientProfileAfterManifestAdmission: core.materializeAiClientProfileAfterManifestAdmission,
  }));
}

export function bindStardewPrivateBootstrapOwnerTestSupport(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  composition?: PublicStardewPrivateBootstrapComposition,
): StardewOwnedPlayerHostPhaseATestView {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_phase_a_owner_not_registered");
  }
  return registration.bind(owner);
}

/**
 * Composition-bound test-only staged consume. The exact composition that
 * minted the owner (or an explicitly supplied same composition) must own the
 * bind: forged, unregistered, and cross-composition owners are rejected before
 * the private core primitive sees them, so no staged marker or durable state
 * changes. On the matching composition the staged profile is consumed exactly
 * once and the staged marker is permanently drained.
 */
export function consumeStagedOwnedPlayerHostPhaseBForTesting(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  composition?: PublicStardewPrivateBootstrapComposition,
): void {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_phase_a_owner_not_registered");
  }
  const consume = testOwnedPhaseBConsumers.get(registration.composition);
  if (consume === undefined) throw new Error("stardew_owned_phase_a_owner_not_registered");
  consume(owner);
}

/**
 * Composition-bound test-only C1 materialization. The exact composition that
 * minted both owner and admission (or an explicitly supplied same composition)
 * must own the bind before the private materializer is reached.
 */
export const materializeAiClientProfileAfterManifestAdmissionForTesting = async (
  owner: StardewOwnedPlayerHostPhaseAOwner,
  admission: StardewManifestAdmissionForTesting,
  composition?: PublicStardewPrivateBootstrapComposition,
): Promise<void> => {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_ai_client_profile_materialization_not_admissible");
  }
  const materialize = testAiClientMaterializers.get(registration.composition);
  if (materialize === undefined) throw new Error("stardew_owned_phase_a_owner_not_registered");
  await materialize(owner, admission);
};

export async function launchOwnedPlayerHostStageCForTesting(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  installation: AdmittedStardewInstallation,
  composition?: PublicStardewPrivateBootstrapComposition,
): Promise<StardewOwnedPlayerHostStageCResult> {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_phase_a_owner_not_registered");
  }
  const launch = testStageCLaunchers.get(registration.composition);
  if (launch === undefined) throw new Error("stardew_owned_phase_a_owner_not_registered");
  return launch(owner, installation);
}
