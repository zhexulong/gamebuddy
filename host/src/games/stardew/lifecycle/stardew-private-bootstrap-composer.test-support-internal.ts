import {
  createStardewBootstrapGuardianOwnerBinding,
  createStardewPrivateBootstrapTestCore,
  type StardewOwnedPlayerHostPhaseACoreTestView,
  type StardewOwnedAiClientStageDResult,
  type StardewOwnedPlayerHostStageCResult,
  type StardewPrivateFarmhandBridgeConnection,
  type StardewPrivateBootstrapCoreDependencies,
} from "./stardew-private-bootstrap-composer.core.js";
import {
  createStardewBootstrapGuardianOwner,
  type StardewBootstrapGuardianNativePorts,
  type StardewBootstrapGuardianOwner,
} from "./stardew-bootstrap-guardian.private.js";
import type { AdmittedStardewInstallation } from "../../../stardew-installation-admission.js";
import type { StardewManifestHandoffCoordinator } from "./stardew-private-bootstrap-composer.core.js";
import type {
  StardewOwnedPlayerHostBootstrap,
  StardewPrivateBootstrapComposition as PublicStardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.js";

export type {
  StardewOwnedAiClientStageDResult,
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
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostBootstrap): import("../../../stardew-attachment.js").StardewAttachmentFlow;
  readAndCorrelateOwnedPlayerHostSession(owner: StardewOwnedPlayerHostBootstrap): Promise<boolean>;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  consumeStagedOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): void;
  materializeAiClientProfileAfterManifestAdmission(
    owner: StardewOwnedPlayerHostBootstrap,
    admission: StardewManifestAdmissionForTesting,
  ): Promise<void>;
  launchMaterializedAiClient(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedAiClientStageDResult>;
  consumeOwnedFarmhandBridgeConnection<T extends Readonly<{ close(): void | Promise<void> }>>(
    owner: StardewOwnedPlayerHostBootstrap,
    callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  ): Promise<T>;
  launchStagedPlayerHost(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  reserveOwnedPlayerHostBootstrapForActivation(
    runtimeRoot: string,
    claim: import("../../../stardew-player-host-bootstrap.js").StardewPlayerHostBootstrapClaim,
  ): Promise<StardewOwnedPlayerHostBootstrap>;
  stageOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  terminalizeOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): void;
  bindOwnedPlayerHostPhaseAOwner(
    owner: StardewOwnedPlayerHostBootstrap,
  ): StardewOwnedPlayerHostPhaseATestView;
  quarantineOwnedPlayerHostOwner(
    owner: StardewOwnedPlayerHostBootstrap,
  ): Promise<void>;
  createStardewBootstrapGuardianOwner(
    owner: StardewOwnedPlayerHostBootstrap,
    native: StardewBootstrapGuardianNativePorts,
  ): StardewBootstrapGuardianOwner;
  createOwnerTransitionsForTesting: ReturnType<typeof createStardewPrivateBootstrapTestCore>["createOwnerTransitionsForTesting"];
}>;

const testOwnerBinders = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (owner: StardewOwnedPlayerHostBootstrap) => StardewOwnedPlayerHostPhaseATestView
>();
const testOwnerViews = new WeakMap<
  object,
  Readonly<{
    composition: PublicStardewPrivateBootstrapComposition;
    bind: (owner: StardewOwnedPlayerHostBootstrap) => StardewOwnedPlayerHostPhaseATestView;
  }>
>();
const testOwnedPlayerHostProfileConsumers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (owner: StardewOwnedPlayerHostBootstrap) => void
>();
const testAiClientMaterializers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (
    owner: StardewOwnedPlayerHostBootstrap,
    admission: StardewManifestAdmissionForTesting,
  ) => Promise<void>
>();
const testMaterializedAiClientLaunchers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ) => Promise<StardewOwnedAiClientStageDResult>
>();
const testBridgeConnectionConsumers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  <T extends Readonly<{ close(): void | Promise<void> }>>(
    owner: StardewOwnedPlayerHostBootstrap,
    callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  ) => Promise<T>
>();
const testStagedPlayerHostLaunchers = new WeakMap<
  PublicStardewPrivateBootstrapComposition,
  (
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ) => Promise<StardewOwnedPlayerHostStageCResult>
>();
const testOwnerTransitionFactories = new WeakMap<
  StardewPrivateBootstrapTestingComposition,
  StardewPrivateBootstrapTestingComposition["createOwnerTransitionsForTesting"]
>();

function registerTestingComposition(
  testingComposition: StardewPrivateBootstrapTestingComposition,
): StardewPrivateBootstrapTestingComposition {
  const base = testingComposition.composition;
  const reserveOwnedPlayerHostBootstrap = base.reserveOwnedPlayerHostBootstrap.bind(base);
  const composition: PublicStardewPrivateBootstrapComposition = Object.freeze({
    ...base,
    async reserveOwnedPlayerHostBootstrap(...args) {
      const owner = await reserveOwnedPlayerHostBootstrap(...args);
      testOwnerViews.set(owner, Object.freeze({
        composition,
        bind: testingComposition.bindOwnedPlayerHostPhaseAOwner,
      }));
      return owner;
    },
  });
  testOwnerBinders.set(composition, testingComposition.bindOwnedPlayerHostPhaseAOwner);
  testOwnedPlayerHostProfileConsumers.set(composition, testingComposition.consumeStagedOwnedPlayerHostProfile);
  testAiClientMaterializers.set(composition, testingComposition.materializeAiClientProfileAfterManifestAdmission);
  testMaterializedAiClientLaunchers.set(composition, testingComposition.launchMaterializedAiClient);
  testBridgeConnectionConsumers.set(composition, testingComposition.consumeOwnedFarmhandBridgeConnection);
  testStagedPlayerHostLaunchers.set(composition, testingComposition.launchStagedPlayerHost);
  const registered = Object.freeze({ ...testingComposition, composition });
  testOwnerTransitionFactories.set(registered, testingComposition.createOwnerTransitionsForTesting);
  return registered;
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
    createStardewBootstrapGuardianOwner: (owner, native) =>
      createStardewBootstrapGuardianOwner(createStardewBootstrapGuardianOwnerBinding(owner), native),
    materializeAiClientProfileAfterManifestAdmission: core.materializeAiClientProfileAfterManifestAdmission,
  }));
}

/**
 * Creates CAS transitions only through a registered test composition. A bare
 * owner path, fence, and fault persistence object cannot reach the core engine.
 */
export function createOwnerTransitionsForTesting(
  testingComposition: StardewPrivateBootstrapTestingComposition,
  input: Parameters<StardewPrivateBootstrapTestingComposition["createOwnerTransitionsForTesting"]>[0],
): ReturnType<StardewPrivateBootstrapTestingComposition["createOwnerTransitionsForTesting"]> {
  const factory = testOwnerTransitionFactories.get(testingComposition);
  if (factory === undefined) throw new Error("stardew_private_bootstrap_test_composition_not_registered");
  return factory(input);
}

export function bindStardewPrivateBootstrapOwnerTestSupport(
  owner: StardewOwnedPlayerHostBootstrap,
  composition?: PublicStardewPrivateBootstrapComposition,
): StardewOwnedPlayerHostPhaseATestView {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
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
export function consumeStagedOwnedPlayerHostProfileForTesting(
  owner: StardewOwnedPlayerHostBootstrap,
  composition?: PublicStardewPrivateBootstrapComposition,
): void {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  }
  const consume = testOwnedPlayerHostProfileConsumers.get(registration.composition);
  if (consume === undefined) throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  consume(owner);
}

/**
 * Composition-bound test-only C1 materialization. The exact composition that
 * minted both owner and admission (or an explicitly supplied same composition)
 * must own the bind before the private materializer is reached.
 */
export const materializeAiClientProfileAfterManifestAdmissionForTesting = async (
  owner: StardewOwnedPlayerHostBootstrap,
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
  if (materialize === undefined) throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  await materialize(owner, admission);
};

export async function launchMaterializedAiClientForTesting(
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
  composition?: PublicStardewPrivateBootstrapComposition,
): Promise<StardewOwnedAiClientStageDResult> {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  }
  const launch = testMaterializedAiClientLaunchers.get(registration.composition);
  if (launch === undefined) throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  return launch(owner, installation);
}

export async function consumeOwnedFarmhandBridgeConnectionForTesting<T extends Readonly<{ close(): void | Promise<void> }>>(
  owner: StardewOwnedPlayerHostBootstrap,
  callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  composition?: PublicStardewPrivateBootstrapComposition,
): Promise<T> {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  }
  const consume = testBridgeConnectionConsumers.get(registration.composition);
  if (consume === undefined) throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  return consume(owner, callback);
}

export async function launchStagedPlayerHostForTesting(
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
  composition?: PublicStardewPrivateBootstrapComposition,
): Promise<StardewOwnedPlayerHostStageCResult> {
  const registration = testOwnerViews.get(owner);
  if (registration === undefined ||
      (composition !== undefined && registration.composition !== composition) ||
      (composition !== undefined && testOwnerBinders.get(composition) !== registration.bind)) {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  }
  const launch = testStagedPlayerHostLaunchers.get(registration.composition);
  if (launch === undefined) throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  return launch(owner, installation);
}
