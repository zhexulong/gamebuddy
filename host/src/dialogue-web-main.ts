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
} from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { type HostDeploymentManifest, loadHostDeploymentManifest } from "./deployment-manifest.js";
import { parseDialogueLaunchMode } from "./dialogue-launch-mode.js";
import {
  startChatOnlyPresentationAdmission,
  startDesktopPresentationAdmission,
  startTavernManagementPresentationAdmission,
  type DesktopPresentationAdmission,
} from "./composition/desktop-presentation-admission-owner.js";
import { createStardewGamePresentationProjection } from "./games/stardew/provider.js";
import { createStardewProductionLifecycleCoordinator } from "./stardew-production-lifecycle-coordinator.internal.js";
import { createChatEventStream } from "./tavern/chat-event-stream.js";
import { closeReferencePipelineRuntime } from "./tavern/reference-pipeline-runtime-lifecycle.js";
import { createChatLiveWindowsReparseInspector, createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
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
  // MIGRATION-ERA (browser/product helper): this Chat-only profile is now a
  // pure dispatch into the composition-owned chat-only presentation admission
  // (Lane E1); nothing but the dispatch remains here, and this entry goes away
  // with Lane E3.
  const launchOptions =
    launch.tavernNarrativeGateNonceSha256 === undefined
      ? undefined
      : { tavernNarrativeGateNonceSha256: launch.tavernNarrativeGateNonceSha256 };
  const bootstrapToken = randomBytes(32).toString("base64url");
  const facade =
    mode === "known"
      ? await createKnownUnmountedChatSemanticFacade(manifest, launchOptions)
      : await createFreshUnmountedChatSemanticFacade(manifest, launchOptions);
  let lease: Awaited<ReturnType<typeof facade.startMountedChatRuntime>> | undefined;
  let admission: DesktopPresentationAdmission | undefined;
  const eventStream = createChatEventStream();
  try {
    lease = await facade.startMountedChatRuntime();
    const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
    const inspector = process.env.GAMEBUDDY_CHAT_LIVE_ARTIFACT === "gamebuddy.chat-live.v1"
    ? await createChatLiveWindowsReparseInspector(hostArtifactRoot)
    : await createPublishedWindowsReparseInspector(hostArtifactRoot);
    admission = await startChatOnlyPresentationAdmission({
      manifest,
      hostArtifactRoot,
      bootstrapToken,
      eventStream,
      lease,
      inspector,
    });
    process.stdout.write(`GameBuddy Dialogue is ready at ${admission.launchUrl}\n`);
    await waitForSignal();
  } finally {
    let failure: unknown;
    try {
      // The chat-only admission closes its own listener and delegated services
      // before the mounted lease drains below.
      await admission?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await closeReferencePipelineRuntime({
        ...(lease === undefined ? {} : { lease }),
        facade,
      });
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}

async function runReferenceGameProfile(manifest: HostDeploymentManifest, mode: "fresh" | "known"): Promise<void> {
  const bootstrapToken = randomBytes(32).toString("base64url");
  const eventStream = createChatEventStream();
  const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  let shared: Awaited<ReturnType<typeof createSharedSemanticProductionAuthorityFromDeploymentManifest>> | undefined;
  let facade: ConstructedUnmountedChatSemanticFacade | undefined;
  let lifecycleCoordinator: ReturnType<typeof createStardewProductionLifecycleCoordinator> | undefined;
  let lease: Awaited<ReturnType<ConstructedUnmountedChatSemanticFacade["startMountedChatRuntime"]>> | undefined;
  let presentation: DesktopPresentationAdmission | undefined;
  try {
    // The reference-game profile shares one semantic SQLite authority (one
    // provision and one root mutex/broker) between the mounted Chat runtime and
    // the Stardew Game authority. The lifecycle coordinator consumes the same
    // Game projection; neither Chat nor Stardew constructs a second authority,
    // and the materializer consumes the injected Game projection directly.
    // Every construction step is inside this try so a failure at any point
    // drains only what already succeeded: the presentation admission, then the
    // Chat facade, then the lifecycle coordinator, in the existing close order.
    shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest, mode);
    facade = await createChatSemanticFacadeFromSharedAuthority(shared.chat);
    const folderPicker = await createPublishedWindowsStardewFolderPicker(hostArtifactRoot);
    // Construction failure must not leak Chat/Game resources. The shared owner
    // is created before the lifecycle so a Stardew construction failure still
    // lets the Chat runtime and shared owner drain below.
    // MIGRATION-ERA (browser/product helper): no runtime collaborator is
    // passed, so both role launches fail closed at the coordinator with
    // stardew_*_launch_runtime_unavailable — never a silent raw spawn. The
    // formal Desktop composition is the sole production launch authority; this
    // entry and its imports are removed when the composition-owned startup
    // replaces this browser preview (design ADR-0007 Phase 1/2).
    lifecycleCoordinator = createStardewProductionLifecycleCoordinator(manifest, folderPicker, shared.game);
    lease = await facade.startMountedChatRuntime();
    const inspector = process.env.GAMEBUDDY_CHAT_LIVE_ARTIFACT === "gamebuddy.chat-live.v1"
    ? await createChatLiveWindowsReparseInspector(hostArtifactRoot)
    : await createPublishedWindowsReparseInspector(hostArtifactRoot);
    // MIGRATION-ERA (browser/product helper): the reference-game profile now
    // consumes the composition-owned presentation admission owner instead of
    // assembling the listener, Chat state facade, pipeline service, and composed
    // profile itself; the formal Desktop composition is the production owner of
    // that same startup.
    presentation = await startDesktopPresentationAdmission({
      manifest,
      hostArtifactRoot,
      bootstrapToken,
      eventStream,
      lease,
      inspector,
      presentation: createStardewGamePresentationProjection(lifecycleCoordinator),
    });
    process.stdout.write(`GameBuddy Reference Game is ready at ${presentation.launchUrl}\n`);
    await waitForSignal();
  } finally {
    let failure: unknown;
    try {
      // The presentation admission closes first: the one listener drains its
      // delegated Chat admission and the Chat pipeline service behind it while
      // the mounted lease stays live for the Chat-lane drain below.
      await presentation?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      // Chat runtime (lease/runtime authority) closes next. The facade drains
      // its mounted Chat runtime projection even when the lease never started;
      // without a facade no Chat-lane resource was constructed.
      if (facade !== undefined) {
        await closeReferencePipelineRuntime({
          ...(lease === undefined ? {} : { lease }),
          facade,
        });
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
  // MIGRATION-ERA (browser/product helper): this Tavern-management profile is
  // now a pure dispatch into the composition-owned management presentation
  // admission (Lane E1); nothing but the dispatch remains here, and this entry
  // goes away with Lane E3.
  const bootstrapToken = randomBytes(32).toString("base64url");
  const facade =
    mode === "known"
      ? await createKnownUnmountedChatSemanticFacade(manifest)
      : await createFreshUnmountedChatSemanticFacade(manifest);
  let lease: Awaited<ReturnType<typeof facade.startMountedChatRuntime>> | undefined;
  let admission: DesktopPresentationAdmission | undefined;
  const eventStream = createChatEventStream();
  try {
    lease = await facade.startMountedChatRuntime();
    const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
    const inspector = process.env.GAMEBUDDY_CHAT_LIVE_ARTIFACT === "gamebuddy.chat-live.v1"
    ? await createChatLiveWindowsReparseInspector(hostArtifactRoot)
    : await createPublishedWindowsReparseInspector(hostArtifactRoot);
    admission = await startTavernManagementPresentationAdmission({
      manifest,
      hostArtifactRoot,
      bootstrapToken,
      eventStream,
      lease,
      inspector,
    });
    process.stdout.write(`GameBuddy Tavern management is ready at ${admission.launchUrl}\n`);
    await waitForSignal();
  } finally {
    let failure: unknown;
    try {
      // The management admission closes its own listener and delegated
      // management/Memory/World Info services before the mounted lease drains
      // below.
      await admission?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await closeReferencePipelineRuntime({
        ...(lease === undefined ? {} : { lease }),
        facade,
      });
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}

async function waitForSignal(): Promise<void> {
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
}
