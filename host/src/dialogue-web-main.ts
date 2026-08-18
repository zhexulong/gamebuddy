import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFreshUnmountedChatSemanticFacade,
  createKnownUnmountedChatSemanticFacade,
} from "./continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js";
import { loadHostDeploymentManifest, type HostDeploymentManifest } from "./deployment-manifest.js";
import { parseDialogueLaunchMode, type DialogueLaunchProfile } from "./dialogue-launch-mode.js";
import { startReferencePipelineStaticShellComposition } from "./tavern/reference-pipeline-static-shell-composition.js";
import { startTavernManagementStaticShellComposition } from "./tavern/tavern-management-static-shell-composition.js";
import { createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createChatPipelineService } from "./tavern/chat-pipeline-service.js";
import { createChatEventStream } from "./tavern/chat-event-stream.js";
import { createChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { createReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";
import { createTavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import { closeReferencePipelineRuntime } from "./tavern/reference-pipeline-runtime-lifecycle.js";

const launch = parseDialogueLaunchMode(process.argv.slice(2));
const manifestPath = launch.manifestPath ?? process.env.GAMEBUDDY_DIALOGUE_CONFIG;
if (manifestPath === undefined) throw new Error("dialogue_deployment_manifest_path_required");

const manifest = await loadHostDeploymentManifest(resolve(manifestPath));
if (launch.profile === "management") {
  await runManagementProfile(manifest, launch.mode);
} else {
  await runReferenceProfile(manifest, launch.mode);
}

async function runReferenceProfile(manifest: HostDeploymentManifest, mode: "fresh" | "known"): Promise<void> {
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "chat.submit",
      "chat.submission_status",
      "events",
    ],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
  const bootstrapToken = randomBytes(32).toString("base64url");
  const facade = mode === "known"
    ? await createKnownUnmountedChatSemanticFacade(manifest)
    : await createFreshUnmountedChatSemanticFacade(manifest);
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

async function runManagementProfile(manifest: HostDeploymentManifest, mode: "fresh" | "known"): Promise<void> {
  const profile = composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename"],
    operationIds: ["draft.save", "draft.discard", "chat.rename"],
    navigationItemIds: ["chat"],
  });
  const bootstrapToken = randomBytes(32).toString("base64url");
  const facade = mode === "known"
    ? await createKnownUnmountedChatSemanticFacade(manifest)
    : await createFreshUnmountedChatSemanticFacade(manifest);
  let lease: Awaited<ReturnType<typeof facade.startMountedChatRuntime>> | undefined;
  let managementService: ReturnType<typeof createChatManagementService> | undefined;
  let server: Awaited<ReturnType<typeof startTavernManagementStaticShellComposition>> | undefined;
  try {
    lease = await facade.startMountedChatRuntime();
    const managementStateFacade = await createTavernManagementStateFacade(manifest, lease, profile);
    managementService = createChatManagementService({ manifest, lease, profile });
    const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
    const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
    server = await startTavernManagementStaticShellComposition({
      managementStateFacade,
      managementService,
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
