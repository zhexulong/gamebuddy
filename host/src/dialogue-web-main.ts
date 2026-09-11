import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChatSemanticFacadeFromSharedAuthority,
  createFreshUnmountedChatSemanticFacade,
  createKnownUnmountedChatSemanticFacade,
  type ConstructedUnmountedChatSemanticFacade,
} from "./continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js";
import {
  createSharedSemanticProductionAuthorityFromDeploymentManifest,
} from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import { type HostDeploymentManifest, loadHostDeploymentManifest } from "./deployment-manifest.js";
import { parseDialogueLaunchMode } from "./dialogue-launch-mode.js";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import { composeGameProfile } from "./game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "./game-browser/game-browser-state-provider.js";
import { createStardewProductionLifecycleCoordinator } from "./stardew-production-lifecycle-coordinator.internal.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createChatEventStream } from "./tavern/chat-event-stream.js";
import { createChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { createChatPipelineService } from "./tavern/chat-pipeline-service.js";
import { createMemoryManagementService } from "./tavern/memory-management/memory-management.js";
import { closeReferencePipelineRuntime } from "./tavern/reference-pipeline-runtime-lifecycle.js";
import { createReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";
import { startReferencePipelineStaticShellComposition } from "./tavern/reference-pipeline-static-shell-composition.js";
import { startComposedReferenceGameStaticShellComposition } from "./tavern/composed-reference-game-static-shell-composition.js";
import { createTavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import { startTavernManagementStaticShellComposition } from "./tavern/tavern-management-static-shell-composition.js";
import { createWorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { createWorldInfoManagementRepository } from "./tavern/world-info-management/world-info-management.js";
import { createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
import { createPublishedWindowsStardewFolderPicker } from "./windows-stardew-folder-picker/index.js";

const launch = parseDialogueLaunchMode(process.argv.slice(2));
const manifestPath = launch.manifestPath ?? process.env.GAMEBUDDY_DIALOGUE_CONFIG;
if (manifestPath === undefined) throw new Error("dialogue_deployment_manifest_path_required");

const manifest = await loadHostDeploymentManifest(resolve(manifestPath));
if (launch.profile === "management") {
  await runManagementProfile(manifest, launch.mode);
} else if (launch.profile === "reference-game") {
  await runReferenceGameProfile(manifest, launch.mode);
} else {
  await runReferenceProfile(manifest, launch.mode);
}

async function runReferenceProfile(manifest: HostDeploymentManifest, mode: "fresh" | "known"): Promise<void> {
  const launchOptions =
    launch.tavernNarrativeGateNonceSha256 === undefined
      ? undefined
      : { tavernNarrativeGateNonceSha256: launch.tavernNarrativeGateNonceSha256 };
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  const bootstrapToken = randomBytes(32).toString("base64url");
  const facade =
    mode === "known"
      ? await createKnownUnmountedChatSemanticFacade(manifest, launchOptions)
      : await createFreshUnmountedChatSemanticFacade(manifest, launchOptions);
  let lease: Awaited<ReturnType<typeof facade.startMountedChatRuntime>> | undefined;
  let pipelineService: ReturnType<typeof createChatPipelineService> | undefined;
  let server: Awaited<ReturnType<typeof startReferencePipelineStaticShellComposition>> | undefined;
  const eventStream = createChatEventStream();
  try {
    lease = await facade.startMountedChatRuntime();
    const referenceStateFacade = await createReferencePipelineStateFacade(manifest, lease, profile, eventStream);
    pipelineService = createChatPipelineService({ manifest, lease, profile, eventStream });
    const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
    const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
    server = await startReferencePipelineStaticShellComposition({
      referenceStateFacade,
      pipelineService,
      eventStream,
      profile,
      bootstrapToken,
      inspector,
      artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    });
    process.stdout.write(`GameBuddy Dialogue is ready at ${server.launchUrl}\n`);
    await waitForSignal();
  } finally {
    await closeReferencePipelineRuntime({ server, pipelineService, lease, facade });
  }
}

async function runReferenceGameProfile(manifest: HostDeploymentManifest, mode: "fresh" | "known"): Promise<void> {
  const tavernProfile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  const gameProfile = composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: ["game.state.read", "game.prerequisites.setup", "game.launch", "game.stop", "game.disconnect", "game.stardew.cabins.read", "game.stardew.cabins.confirm"],
    navigationItemIds: ["game"],
  });
  const profile = composeReferenceGameBrowserProfile({ tavernProfile, gameProfile });
  const bootstrapToken = randomBytes(32).toString("base64url");
  const eventStream = createChatEventStream();
  const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  let shared: Awaited<ReturnType<typeof createSharedSemanticProductionAuthorityFromDeploymentManifest>> | undefined;
  let facade: ConstructedUnmountedChatSemanticFacade | undefined;
  let lifecycleCoordinator: ReturnType<typeof createStardewProductionLifecycleCoordinator> | undefined;
  let lease: Awaited<ReturnType<ConstructedUnmountedChatSemanticFacade["startMountedChatRuntime"]>> | undefined;
  let pipelineService: ReturnType<typeof createChatPipelineService> | undefined;
  let server: Awaited<ReturnType<typeof startComposedReferenceGameStaticShellComposition>> | undefined;
  try {
    // The reference-game profile shares one semantic SQLite authority (one
    // provision and one root mutex/broker) between the mounted Chat runtime and
    // the Stardew Game authority. The lifecycle coordinator consumes the same
    // Game projection; neither Chat nor Stardew constructs a second authority,
    // and the materializer consumes the injected Game projection directly.
    // Every construction step is inside this try so a failure at any point
    // drains only what already succeeded: the shared owner, then the Chat
    // facade, then the lifecycle coordinator, in the existing close order.
    shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest, mode);
    facade = await createChatSemanticFacadeFromSharedAuthority(shared.chat);
    const folderPicker = await createPublishedWindowsStardewFolderPicker(hostArtifactRoot);
    // Construction failure must not leak Chat/Game resources. The shared owner
    // is created before the lifecycle so a Stardew construction failure still
    // lets the Chat runtime and shared owner drain below.
    lifecycleCoordinator = createStardewProductionLifecycleCoordinator(manifest, folderPicker, shared.game);
    lease = await facade.startMountedChatRuntime();
    const referenceStateFacade = await createReferencePipelineStateFacade(manifest, lease, tavernProfile, eventStream);
    pipelineService = createChatPipelineService({ manifest, lease, profile: tavernProfile, eventStream });
    const gameStateProvider = createGameBrowserStateProvider(
      gameProfile,
      lifecycleCoordinator.lifecycleReader,
      lifecycleCoordinator.attachmentReader,
      lifecycleCoordinator.launchReadinessReader,
    );
    const artifactRoot = hostArtifactRoot;
    const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
    server = await startComposedReferenceGameStaticShellComposition({
      profile,
      bootstrapToken,
      referenceStateFacade,
      pipelineService,
      eventStream,
      readGame: gameStateProvider.readState,
      lifecycleActivationBindingSink: lifecycleCoordinator.activationOwner,
      inspector,
      artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    });
    process.stdout.write(`GameBuddy Reference Game is ready at ${server.launchUrl}\n`);
    await waitForSignal();
  } finally {
    let failure: unknown;
    try {
      // Chat runtime (lease/runtime authority) closes first. The facade drains
      // its mounted Chat runtime projection even when the lease never started;
      // without a facade no Chat-lane resource was constructed.
      if (facade !== undefined) {
        await closeReferencePipelineRuntime({ server, pipelineService, lease, facade });
      }
    } catch (error) {
      failure ??= error;
    }
    try {
      // The Game mount/process owner closes its lifecycle coordinator.
      await lifecycleCoordinator?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      // The shared owner closes the Game projection, Chat projection, then the
      // single provision and mutex/broker, in retryable/idempotent order.
      await shared?.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}

async function runManagementProfile(manifest: HostDeploymentManifest, mode: "fresh" | "known"): Promise<void> {
  const profile = composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename", "memory.read", "memory.mutate", "world-info.read", "world-info.bind"],
    operationIds: ["draft.save", "draft.discard", "chat.rename", "memory.mutate", "world-info.bind"],
    // A mounted Memory route is paired with the Memory navigation item; the
    // item only projects `available` after the exact-bound read succeeds.
    navigationItemIds: ["chat", "memory"],
  });
  const bootstrapToken = randomBytes(32).toString("base64url");
  const facade =
    mode === "known"
      ? await createKnownUnmountedChatSemanticFacade(manifest)
      : await createFreshUnmountedChatSemanticFacade(manifest);
  let lease: Awaited<ReturnType<typeof facade.startMountedChatRuntime>> | undefined;
  let managementService: ReturnType<typeof createChatManagementService> | undefined;
  let memoryService: ReturnType<typeof createMemoryManagementService> | undefined;
  let worldInfoService: Awaited<ReturnType<typeof createWorldInfoBindingManagementService>> | undefined;
  let worldInfoRepository: ReturnType<typeof createWorldInfoManagementRepository> | undefined;
  let server: Awaited<ReturnType<typeof startTavernManagementStaticShellComposition>> | undefined;
  try {
    lease = await facade.startMountedChatRuntime();
    // The real durable managed repository backs the lease-bound binding
    // service; no browser fixture or alternate resolver is ever injected.
    worldInfoRepository = createWorldInfoManagementRepository(manifest.runtimeRoot);
    worldInfoService = createWorldInfoBindingManagementService({
      manifest,
      lease,
      profile,
      repository: worldInfoRepository,
    });
    const managementStateFacade = await createTavernManagementStateFacade(
      manifest,
      lease,
      profile,
      worldInfoService,
    );
    managementService = createChatManagementService({ manifest, lease, profile });
    memoryService = createMemoryManagementService({ manifest, lease, profile });
    const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
    const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
    server = await startTavernManagementStaticShellComposition({
      managementStateFacade,
      managementService,
      memoryService,
      worldInfoService,
      profile,
      bootstrapToken,
      inspector,
      artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    });
    process.stdout.write(`GameBuddy Tavern management is ready at ${server.launchUrl}\n`);
    await waitForSignal();
  } finally {
    await closeReferencePipelineRuntime({
      server,
      pipelineService: managementService,
      lease,
      facade,
    });
  }
}

async function waitForSignal(): Promise<void> {
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
}
