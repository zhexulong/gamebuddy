/**
 * The real Chat-surface composition, mounted over a real loopback listener with
 * the shipped Host artifact modules. Shared by the browser specs: the SSE/replay
 * journeys drive it with a synthetic start gate that stops before provider
 * terminalization, while the provider-turn journeys run it exactly as production
 * composes it (no start override).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const dialogueRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(dialogueRoot, "..");
const hostRoot = resolve(repositoryRoot, "host");
const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";

async function loadGenerationModules(artifactRoot: string) {
  const load = async (path: string) => await import(pathToFileURL(resolve(artifactRoot, path)).href);
  return await Promise.all([
    load("continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js"),
    load("deployment-manifest.js"),
    load("tavern/browser-contract/index.js"),
    load("tavern/chat-pipeline-service.js"),
    load("tavern/reference-pipeline-state.js"),
    load("tavern/chat-event-stream.js"),
    load("tavern/reference-pipeline-static-shell-composition.js"),
    load("windows-reparse-inspector/index.js"),
    load("windows-stale-lock-reclaimer/index.js"),
    load("path-lock.js"),
    load("continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js"),
    load("runtime-identity.js"),
  ]);
}

/**
 * The generation under test. Defaults to the checked-in `host/dist`, whose
 * generation is older than the code under test, so the release job (and any local
 * run that wants today's code) names a fresh one.
 */
function resolveGenerationRoot(): string {
  const outputRoot = process.env.GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT
    ? resolve(process.env.GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT)
    : resolve(hostRoot, "dist");
  return { outputRoot, artifactOf: (generation: string) => resolve(outputRoot, "generations", generation) };
}

export async function startMountedReferenceComposition(
  eventWindowSize = 64,
  options: Readonly<{ realProvider?: boolean; root?: string; reopen?: boolean }> = {},
) {
  if (process.platform !== "win32") throw new Error("reference_browser_mount_requires_windows");
  const { outputRoot, artifactOf } = resolveGenerationRoot();
  const pointer = JSON.parse(await readFile(resolve(outputRoot, "current.json"), "utf8"));
  const artifactRoot = artifactOf(pointer.generation);
  const [chatFacade, deployment, contract, serviceModule, stateModule, eventStreamModule, composition, inspectorModule, reclaimerModule, pathLock, coordinator, runtimeIdentity] =
    await loadGenerationModules(artifactRoot);
  const root = options.root ?? resolve(tmpdir(), `gamebuddy-reference-browser-${process.pid}-${Date.now()}`);
  if (options.root === undefined) {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  }
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = resolve(root, "manifest.json");
  // A reopened surface reuses the manifest the first mount provisioned: the
  // authority marker binds the root to its bootstrap operation, so a second
  // launch that minted a fresh id would be refused for a real reason.
  const manifestAlreadyProvisioned = await readFile(manifestPath, "utf8").then(
    () => true,
    () => false,
  );
  if (!manifestAlreadyProvisioned)
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: root,
      principal,
      bootstrapOperationId: "browser_reference_01",
      authorityGeneration: 1,
    }));
  await pathLock.bindWindowsStaleLockReclaimer(await reclaimerModule.createPublishedWindowsStaleLockReclaimer(artifactRoot));
  // A real provider turn needs the two pieces the product reads at turn time:
  // the model profile the surface sends with, and the provider credential. Both
  // are ordinary configuration written into the runtime root - the same recipe
  // the Stardew ladder uses - never a script-level stub of the provider itself.
  if (options.realProvider === true) {
    await mkdir(resolve(root, "settings"), { recursive: true });
    await writeFile(
      resolve(root, "settings", "model-profiles.json"),
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
        game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      }),
    );
    const agentDir = runtimeIdentity.resolveRuntimePaths(principal, root).agentDir;
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      resolve(agentDir, "auth.json"),
      JSON.stringify({ "cpa-oai": { type: "api_key", key: process.env.CPA_OAI_API_KEY ?? "" } }),
    );
  }
  const manifest = await deployment.loadHostDeploymentManifest(manifestPath);
  const facade =
    options.reopen === true
      ? // A restart OPENS the authority the first instance provisioned. Fresh
        // provisioning refuses a root that already holds an authority artifact,
        // which is exactly the evidence that the first instance wrote it.
        await chatFacade.createKnownUnmountedChatSemanticFacade(manifest)
      : await chatFacade.createFreshUnmountedChatSemanticFacade(manifest);
  const lease = await facade.startMountedChatRuntime();
  const profile = contract.composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  const eventStream = eventStreamModule.createChatEventStream(eventWindowSize);
  const referenceStateFacade = await stateModule.createReferencePipelineStateFacade(manifest, lease, profile, eventStream);
  let starts = 0;
  let activeTurn: Promise<unknown> | undefined;
  let settleActiveTurn: ((outcome: "release" | "fail") => void) | undefined;
  const pipelineService = serviceModule.createChatPipelineService({
    manifest,
    lease,
    profile,
    eventStream,
    // Production composes this service with no start override, so the turn runs
    // through the real provider path; the synthetic gate is opt-in for the
    // cancellation/replay journeys, which need to stop before terminalization.
    ...(options.realProvider === true
      ? {}
      : { deps: Object.freeze({ start: Object.freeze({ start: async () => { starts += 1; } }) }) }),
  });
  const inspector = await inspectorModule.createPublishedWindowsReparseInspector(artifactRoot);
  const server = await composition.startReferencePipelineStaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    referenceStateFacade,
    pipelineService,
    eventStream,
    profile,
    bootstrapToken: token,
  });
  return {
    server,
    eventStream,
    root,
    get starts() { return starts; },
    async armCurrentTurn() {
      if (activeTurn !== undefined) throw new Error("reference_browser_turn_already_armed");
      let armed!: () => void;
      let settle!: (outcome: "release" | "fail") => void;
      const armedTurn = new Promise<void>((resolve) => { armed = resolve; });
      const terminalSignal = new Promise<"release" | "fail">((resolve) => { settle = resolve; });
      activeTurn = coordinator.startMountedAttempt(manifest, lease, (invocation: unknown) =>
        coordinator.consumeMountedAttemptInvocationAdmission(invocation, async (scope: {
          transitionStore(command: unknown): Promise<unknown>;
          beginActivePrompt(): () => void;
          readCurrentTurnLedger(): Promise<unknown>;
        }) => {
          await scope.transitionStore({ operation: "arm", observedAtMs: Date.now() });
          const releasePrompt = scope.beginActivePrompt();
          armed();
          const outcome = await terminalSignal;
          releasePrompt();
          if (outcome === "fail") {
            return await scope.transitionStore({
              operation: "fail",
              reasonCode: "runtime_unavailable",
              observedAtMs: Date.now(),
              failedAtMs: Date.now(),
            });
          }
          return await scope.readCurrentTurnLedger();
        }),
      );
      settleActiveTurn = settle;
      await armedTurn;
    },
    async settleArmedTurn(outcome: "release" | "fail") {
      if (activeTurn === undefined || settleActiveTurn === undefined) throw new Error("reference_browser_no_armed_turn");
      settleActiveTurn(outcome);
      try {
        await activeTurn;
      } finally {
        activeTurn = undefined;
        settleActiveTurn = undefined;
      }
    },
    async close(options: Readonly<{ keepRoot?: boolean }> = {}) {
      await server.close();
      await pipelineService.close();
      await lease.close();
      await facade.close();
      // A reopened surface keeps its root: that is the point of a restart journey,
      // which is why close is not always a full teardown.
      if (options.keepRoot !== true)
        void rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined);
    },
  };
}

export async function startShippedReferenceComposition() {
  const pointer = JSON.parse(await readFile(resolve(hostRoot, "dist", "current.json"), "utf8"));
  if (!pointer || typeof pointer.generation !== "string" || !/^g-[a-z0-9-]+$/.test(pointer.generation))
    throw new Error("reference_test_production_generation_unavailable");
  const artifactRoot = resolve(hostRoot, "dist", "generations", pointer.generation);
  const load = async (path: string) =>
    await import(pathToFileURL(resolve(artifactRoot, path)).href);
  const [{ startReferencePipelineStaticShellComposition }, { composeTavernProfile }, { createPublishedWindowsReparseInspector }, { createChatEventStream }] =
    await Promise.all([
      load("tavern/reference-pipeline-static-shell-composition.js"),
      load("tavern/browser-contract/index.js"),
      load("windows-reparse-inspector/index.js"),
      load("tavern/chat-event-stream.js"),
    ]);
  const eventStream = createChatEventStream();
  let transcript = Object.freeze([
    Object.freeze({ handle, role: "player" as const, text: "A synthetic durable message.", locale: "und", order: 0, revision: 1 }),
  ]);
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  const referenceState = Object.freeze({
    selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
    companionDisplayName: "Mira",
    title: "Reference Chat",
    get transcript() {
      return transcript;
    },
    draft: Object.freeze({ revision: 1, text: "Sentinel draft" }),
    turn: null,
    eventStream: Object.freeze({ epoch: eventStream.epoch, cursor: eventStream.cursor }),
    operations: Object.freeze([
      Object.freeze({
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      }),
    ]),
  });
  const referenceStateFacade = Object.freeze({
    read: async () => referenceState,
    readDraft: async () => Object.freeze({ apiVersion: 1, revision: 1, text: "Sentinel draft" }),
  });
  const pipelineService = Object.freeze({
    async submitAfterResponseCommit() {
      throw new Error("reference_submit_not_wired_in_contract_slice");
    },
    async cancel() {
      throw new Error("reference_cancel_not_wired_in_contract_slice");
    },
    async readSubmissionStatus() {
      throw new Error("reference_submit_not_wired_in_contract_slice");
    },
    async close() {},
  });
  const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
  const server = await startReferencePipelineStaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    referenceStateFacade,
    pipelineService,
    eventStream,
    profile,
    bootstrapToken: token,
  });
  return Object.freeze({
    ...server,
    eventStream,
    commitNativeText(text: string): void {
      transcript = Object.freeze([
        ...transcript,
        Object.freeze({
          handle,
          role: "companion" as const,
          text,
          locale: "und",
          order: transcript.length,
          revision: 1,
        }),
      ]);
    },
  });
}
