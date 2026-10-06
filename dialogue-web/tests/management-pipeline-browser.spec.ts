import assert from "node:assert/strict";
import {
  assertAccessibilityBaseline,
  assertCriteriaCoverage,
  assertQuiet,
  assertSectionsKeyboardReachable,
  resetCriteriaLedger,
  watchSurface,
} from "./frontend-criteria.js";

/** The obligations the contract declares for the Management surface. */
const MANAGEMENT_CRITERIA_OBLIGATIONS = [
  "frontend-accessibility-baseline",
  "frontend-keyboard-reach",
  "frontend-quiet-walk",
] as const;
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const dialogueRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(dialogueRoot, "..");
const hostRoot = resolve(repositoryRoot, "host");
const bootstrapToken = "A".repeat(43);

async function loadGenerationModules(artifactRoot: string) {
  const load = async (path: string) => await import(pathToFileURL(resolve(artifactRoot, path)).href);
  return await Promise.all([
    load("continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js"),
    load("continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js"),
    load("deployment-manifest.js"),
    load("runtime.js"),
    load("runtime-identity.js"),
    load("tavern/chat-thread-store.js"),
    load("tavern/browser-contract/index.js"),
    load("tavern/chat-management/chat-management-service.js"),
    load("tavern/memory-management/memory-management.js"),
    load("tavern/connection-service.js"),
    load("tavern/connection-probe.js"),
    load("settings/voice-preference-store.js"),
    load("settings/language-preference-store.js"),
    load("tavern/world-info-management/world-info-management.js"),
    load("tavern/world-info-binding/world-info-binding-management-service.js"),
    load("tavern/tavern-management-state.js"),
    load("tavern/tavern-management-static-shell-composition.js"),
    load("windows-reparse-inspector/index.js"),
    load("windows-stale-lock-reclaimer/index.js"),
    load("path-lock.js"),
    load("tavern/artifact-store.js"),
    load("tavern/persona-management/persona-management.js"),
    load("tavern/scenario-management/scenario-management.js"),
    load("tavern/greeting-management/greeting-management.js"),
    load("tavern/st-card-import-service.js"),
    load("tavern/st-card-import-history.js"),
    load("tavern/library-service.js"),
    load("tavern/new-companion-service.js"),
    load("tavern/tavern-paths.js"),
  ]);
}

async function startMountedManagementComposition(
  options: Readonly<{
    /**
     * Answers exactly the endpoint URLs a player's own connection records
     * would probe (design/28 §5.3). When absent the real production probe runs
     * against the network; the browser journeys always supply a bounded local
     * answer so the closed outcome is deterministic.
     */
    endpointHandler?: (url: string, headers: Record<string, string>) => Readonly<{ status: number; body: string }>;
    /**
     * Mounts the Characters surface (design/28 §2): companion library,
     * persona/scenario/greeting CRUD and Chat lifecycle retention through the
     * same real artifact-store services the desktop owner composes. Absent
     * by default so the existing journeys keep the legacy management shape.
     */
    withCharacters?: boolean;
  }> = {},
) {
  test.skip(process.platform !== "win32", "requires the real Windows mounted coordinator");
  const outputRoot = process.env.GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT
    ? resolve(process.env.GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT)
    : resolve(hostRoot, "dist");
  const pointer = JSON.parse(await readFile(resolve(outputRoot, "current.json"), "utf8"));
  const artifactRoot = resolve(outputRoot, "generations", pointer.generation);
  const [
    coordinatorModule,
    chatFacade,
    deployment,
    runtime,
    runtimeIdentity,
    chatThreadStoreModule,
    contract,
    serviceModule,
    memoryModule,
    connectionModule,
    connectionProbeModule,
    voicePreferenceModule,
    languagePreferenceModule,
    worldInfoManagementModule,
    worldInfoBindingModule,
    stateModule,
    composition,
    inspectorModule,
    reclaimerModule,
    pathLock,
    artifactStoreModule,
    personaManagementModule,
    scenarioManagementModule,
    greetingManagementModule,
    stCardImportModule,
    stCardImportHistoryModule,
    libraryServiceModule,
    newCompanionModule,
    tavernPathsModule,
  ] = await loadGenerationModules(artifactRoot);
  const root = resolve(tmpdir(), `gamebuddy-management-browser-${process.pid}-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = resolve(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: root,
      principal,
      bootstrapOperationId: "browser_management_01",
      authorityGeneration: 1,
    }),
  );
  await pathLock.bindWindowsStaleLockReclaimer(
    await reclaimerModule.createPublishedWindowsStaleLockReclaimer(artifactRoot),
  );
  const manifest = await deployment.loadHostDeploymentManifest(manifestPath);
  const facade = await chatFacade.createFreshUnmountedChatSemanticFacade(manifest);
  const lease = await facade.startMountedChatRuntime();
  const profile = contract.composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "draft.save",
      "draft.discard",
      "chat.list",
      "chat.rename",
      "memory.read",
      "memory.mutate",
      "world-info.read",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.voice.devices",
      "settings.language.read",
      "settings.language.update",
      "settings.connection.read",
      "settings.connection.create",
      "settings.connection.test",
      "settings.connection.activate",
      "settings.connection.model",
      "settings.connection.remove",
      ...(options.withCharacters === true
        ? [
            "companion.list",
            "companion.detail",
            "companion.create",
            "persona.read",
            "persona.update",
            "scenario.read",
            "scenario.update",
            "greeting.read",
            "greeting.update",
            "chat.archive",
            "chat.restore",
            "chat.trash",
            "character.import.stage",
            "character.import.read",
            "character.import.review",
            "character.import.confirm",
            "character.import.history",
          ]
        : []),
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "memory.mutate",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.voice.devices",
      "settings.language.read",
      "settings.language.update",
      "settings.connection.read",
      "settings.connection.create",
      "settings.connection.test",
      "settings.connection.activate",
      "settings.connection.model",
      "settings.connection.remove",
      ...(options.withCharacters === true
        ? [
            "companion.list",
            "companion.detail",
            "companion.create",
            "persona.read",
            "persona.update",
            "scenario.read",
            "scenario.update",
            "greeting.read",
            "greeting.update",
            "chat.archive",
            "chat.restore",
            "chat.trash",
            "character.import.stage",
            "character.import.read",
            "character.import.review",
            "character.import.confirm",
            "character.import.history",
          ]
        : []),
    ],
    navigationItemIds: options.withCharacters === true ? ["chat", "memory", "characters"] : ["chat", "memory"],
  });
  const worldInfoRepository = worldInfoManagementModule.createWorldInfoManagementRepository(root);
  await worldInfoRepository.create({
    publicTitle: "Pelican Town",
    summary: "A small valley town.",
    entries: [{ scope: "setting", publicTitle: "Town square", summary: "The center of town." }],
  });
  const worldInfoService = worldInfoBindingModule.createWorldInfoBindingManagementService({
    manifest,
    lease,
    profile,
    repository: worldInfoRepository,
    // Mirror the production assembly (desktop-presentation-admission-owner):
    // pristine bindings settle through the coordinator's convergence path so
    // the browser sees the bound state immediately.
    settleAuthoredContext: () => coordinatorModule.settleMountedAuthoredContext(manifest, lease),
  });
  // The Characters surface shares the same real artifact-store authorities the
  // desktop owner composes (design/28 §2): every journey that mounts it talks
  // to the durable store, never a stub, so read-backs are genuine.
  let personaService: ReturnType<typeof personaManagementModule.createPersonaManagementService> | undefined;
  let scenarioService: ReturnType<typeof scenarioManagementModule.createScenarioManagementService> | undefined;
  let greetingService: ReturnType<typeof greetingManagementModule.createGreetingManagementService> | undefined;
  let libraryService: Readonly<{ listCompanions(): Promise<readonly Readonly<{ handle: string; name: string; isCurrent: boolean }>[]> }> | undefined;
  let stCardImportService: InstanceType<typeof stCardImportModule.StCardImportService> | undefined;
  let stCardImportHistoryService:
    | ReturnType<typeof stCardImportHistoryModule.createStCardImportHistoryService>
    | undefined;
  let confirmStCardImport: ((importId: string) => Promise<Readonly<{ name: string }>>) | undefined;
  let newCompanionProvisioner: Readonly<{ create(name: string): Promise<Readonly<{ name: string }>> }> | undefined;
  if (options.withCharacters === true) {
    const tavernPaths = tavernPathsModule.resolveTavernPaths(
      runtimeIdentity.resolveRuntimePaths(principal, root, lease.chatSurfaceSessionId),
      principal,
    );
    const artifactStore = new artifactStoreModule.TavernArtifactStore(root);
    personaService = personaManagementModule.createPersonaManagementService(artifactStore, tavernPaths.playerRoot);
    scenarioService = scenarioManagementModule.createScenarioManagementService(artifactStore, tavernPaths.companionRoot);
    greetingService = greetingManagementModule.createGreetingManagementService(artifactStore, tavernPaths.companionRoot);
    const libraryThreads = chatThreadStoreModule.createChatThreadStore(root, runtimeIdentity.identityKey(principal));
    const libraryBase = libraryServiceModule.createTavernLibraryService(
      tavernPaths,
      artifactStore,
      libraryThreads,
      {
        // The library's metadata reader is consumed on new-chat paths only;
        // companion listing reads the artifact repositories directly. The
        // browser journeys never create a Chat through the library.
        async readExact() {
          throw new Error("identity_profile_not_written_in_browser_fixture");
        },
      },
    );
    const currentCompanionId = principal.companionId;
    const companionHandleFor = (companionId: string): string =>
      lease.browserProjection.projectCompanionHandle(companionId);
    libraryService = Object.freeze({
      async listCompanions() {
        const companions = await libraryBase.listCompanions();
        return companions.map((companion) =>
          Object.freeze({
            handle: companionHandleFor(companion.companionId),
            name: companion.name,
            isCurrent: companion.companionId === currentCompanionId,
          }),
        );
      },
    });
    // Companion detail is deliberately not bound here: the production owner
    // projects the mounted companion's own runtime identity (see
    // desktop-presentation-admission-owner), which this fixture has no mount
    // identity for, and no journey reads the detail route. Leaving it unbound
    // makes that route answer 404 per request, exactly as the owner does for a
    // handle it cannot resolve.
    //
    // The reviewed ST-card import mirrors the production owner: the service owns
    // the staged artifacts, and confirm re-reads the exact reviewed candidate and
    // provisions it (profile plus the reviewed world book) into a new
    // Host-owned namespace through the same library threads.
    stCardImportService = new stCardImportModule.StCardImportService(artifactStore, tavernPaths);
    // The same durable loss-report authority the production owner composes: the
    // confirm path writes one immutable evidence record per confirmed import.
    const importHistory = stCardImportHistoryModule.createStCardImportHistoryService(
      artifactStore,
      tavernPaths.playerRoot,
    );
    stCardImportHistoryService = importHistory;
    confirmStCardImport = async (importId: string) => {
      const imported = await stCardImportService!.read(importId);
      const review = await stCardImportService!.confirmedReview(importId);
      const provision = await newCompanionModule.provisionNewCompanion(
        root,
        principal.playerId,
        imported.candidate.artifact,
        review,
        libraryThreads,
      );
      await importHistory.record({
        importId,
        occurredAtMs: Date.now(),
        cardName: imported.candidate.artifact.name,
        companionId: provision.companion.companionId,
        dispositions: imported.report.artifact.dispositions,
      });
      return Object.freeze({ name: provision.companion.name });
    };
    newCompanionProvisioner = Object.freeze({
      async create(name: string) {
        const provision = await newCompanionModule.provisionDirectNewCompanion(root, principal.playerId, name);
        return Object.freeze({ name: provision.companion.name });
      },
    });
  }
  const managementStateFacade = await stateModule.createTavernManagementStateFacade(
    manifest,
    lease,
    profile,
    worldInfoService,
  );
  const managementService = serviceModule.createChatManagementService({ manifest, lease, profile });
  const memoryService = memoryModule.createMemoryManagementService({ manifest, lease, profile });
  const inspector = await inspectorModule.createPublishedWindowsReparseInspector(artifactRoot);
  // The durable voice preference store and the connection service are the same
  // production authorities the desktop owner composes (design/28 §5.3): the
  // connection service reports the exact mounted Chat's turn state so an
  // activation cannot switch a running turn.
  // The same root-level preference the runtime reads at mount: the panel writes
  // it here, and the companion speaks it.
  const languagePreferenceStore = new languagePreferenceModule.LanguagePreferenceStore(
    languagePreferenceModule.companionLocalePath(root),
  );
  const voicePreferenceStore = new voicePreferenceModule.VoicePreferenceStore(
    resolve(root, "settings", "voice-preference.json"),
  );
  const connectionProbe =
    options.endpointHandler === undefined
      ? undefined
      : (input: unknown) =>
          connectionProbeModule.probeTavernConnection(
            input,
            (async (url: string, init?: RequestInit) => {
              const response = options.endpointHandler!(String(url), (init?.headers ?? {}) as Record<string, string>);
              return new Response(response.body, { status: response.status });
            }) as unknown as typeof fetch,
          );
  const connectionService = connectionModule.createTavernConnectionService({
    agentDir: runtimeIdentity.resolveRuntimePaths(principal, root, lease.chatSurfaceSessionId).agentDir,
    readTurnState: async () => {
      const state = await managementStateFacade.read();
      const turn = state.turn;
      return {
        turnActive:
          turn !== null &&
          (turn.state === "queued" ||
            turn.state === "running" ||
            turn.state === "response_visible" ||
            turn.state === "stopping"),
      };
    },
    ...(connectionProbe === undefined ? {} : { probe: connectionProbe }),
  });
  const server = await composition.startTavernManagementStaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    managementStateFacade,
    managementService,
    memoryService,
    worldInfoService,
    voicePreferenceStore,
    languagePreferenceStore,
    connectionService,
    ...(personaService === undefined ? {} : { personaService }),
    ...(scenarioService === undefined ? {} : { scenarioService }),
    ...(greetingService === undefined ? {} : { greetingService }),
    ...(libraryService === undefined ? {} : { libraryService }),
    ...(newCompanionProvisioner === undefined ? {} : { newCompanionProvisioner }),
    ...(stCardImportService === undefined ? {} : { stCardImportService }),
    ...(stCardImportHistoryService === undefined ? {} : { stCardImportHistoryService }),
    ...(confirmStCardImport === undefined ? {} : { confirmStCardImport }),
    profile,
    bootstrapToken,
  });
  return {
    server,
    /** The fixture runtime root: every durable read-back reads it directly. */
    root,
    async appendPlayerMessageToLockWorldInfo() {
      const store = chatThreadStoreModule.createChatThreadStore(root, runtime.identityKey(principal));
      await store.appendPlayer(lease.chatThreadId, {
        messageId: "world-info-fixture-lock-1",
        text: "Lock the World Info binding fixture.",
        occurredAtMs: Date.now(),
      });
    },
    async close() {
      await server.close();
      await managementService.close();
      await lease.close();
      await facade.close();
      void rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined);
    },
  };
}

test("management browser lists, saves and discards a durable draft, and renames without switch or submit controls", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const apiRequests: Array<{ method: string; path: string }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiRequests.push({ method: request.method(), path: url.pathname });
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Memory" })).toBeVisible();
    const urlAfterBoot = new URL(page.url());
    assert.equal(urlAfterBoot.search, "");
    assert.equal(urlAfterBoot.hash, "#profile=management");
    await expect(page.locator("textarea.composer-textarea")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /send/i })).toHaveCount(0);
    const draftEditor = page.getByRole("textbox", { name: "Saved draft" });
    await expect(draftEditor).toHaveValue("");
    await draftEditor.fill("A durable browser draft");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(draftEditor).toHaveValue("A durable browser draft");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Saved draft" })).toHaveValue("A durable browser draft");

    await page.getByRole("textbox", { name: "Saved draft" }).fill("A changed unsaved value");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Saved draft" })).toHaveValue("");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Saved draft" })).toHaveValue("");

    await page.getByRole("button", { name: "Chats" }).click();
    const drawer = page.getByRole("dialog", { name: "Chats" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("listitem")).toHaveCount(1);
    await expect(drawer.getByText("Untitled chat", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /new chat/i })).toHaveCount(0);
    await expect(drawer.getByTitle("Rename Chat")).toHaveCount(1);

    await drawer.getByTitle("Rename Chat").click();
    await drawer.locator("input.form-input").fill("A durable browser title");
    await drawer.getByRole("button", { name: "Save" }).click();

    await expect(drawer.getByText("A durable browser title", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Saved successfully.");
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();

    // Ordinary management CRUD is vendor-owned and never mounted as a Pi
    // tool. Every operation receives the fresh vendor read-back, including
    // after a page reload (so no optimistic Memory model survives).
    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.locator("[data-memory-panel]")).toBeVisible();
    await expect(page.locator("[data-memory-state=empty]")).toBeVisible();
    await page.getByRole("textbox", { name: "Memory content" }).fill("A durable player memory");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("A durable player memory", { exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.getByText("A durable player memory", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit memory", exact: true }).click();
    await page.getByRole("textbox", { name: "Memory content: Semantic memory" }).fill("An updated durable memory");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("An updated durable memory", { exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.getByText("An updated durable memory", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Archive memory", exact: true }).click();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.getByText("An updated durable memory", { exact: true })).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();

    assert.equal(apiRequests.filter(({ method, path }) => method === "POST" && path.endsWith("/bootstrap")).length, 1);
    assert.ok(apiRequests.some(({ method, path }) => method === "GET" && path.endsWith("/chats")));
    assert.ok(apiRequests.some(({ method, path }) => method === "GET" && path.endsWith("/memory")));
    // Initial hydration plus the four explicit reloads are the only draft GETs.
    // Save/discard each return the durable read-back in their mutation response.
    assert.equal(apiRequests.filter(({ method, path }) => method === "GET" && path.endsWith("/draft")).length, 6);
    assert.equal(apiRequests.filter(({ method, path }) => method === "PUT" && path.endsWith("/draft")).length, 1);
    assert.equal(apiRequests.filter(({ method, path }) => method === "DELETE" && path.endsWith("/draft")).length, 1);
    assert.ok(apiRequests.some(({ method, path }) => method === "PUT" && path.endsWith("/chat/title")));
    assert.equal(apiRequests.filter(({ method, path }) => method === "PUT" && path.endsWith("/memory")).length, 3);
    assert.equal(apiRequests.some(({ path }) => path.endsWith("/messages")), false);
    assert.equal(apiRequests.some(({ path }) => path.endsWith("/events")), false);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser binds and unbinds an immutable World Info revision through authoritative snapshot read-back", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const responses: Array<{ method: string; path: string; status: number }> = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) {
        responses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
      }
    });

    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-world-info-binding]");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "World Info Binding" })).toBeVisible();
    await expect(panel.getByText("Pelican Town", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();

    await panel.getByRole("button", { name: "Bind: Pelican Town" }).click();
    await expect(page.getByRole("status")).toContainText("Saved successfully.");
    await expect(panel.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    await expect
      .poll(() => responses.some(({ method, path, status }) => method === "PUT" && path.endsWith("/world-info") && status === 200))
      .toBe(true);
    await expect
      .poll(() => responses.filter(({ method, path, status }) => method === "GET" && path.endsWith("/state") && status === 200).length)
      .toBeGreaterThanOrEqual(1);

    await panel.getByRole("button", { name: "Unbind: Pelican Town" }).click();
    await expect(page.getByRole("status")).toContainText("Saved successfully.");
    await expect(panel.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();
    await expect
      .poll(() => responses.filter(({ method, path, status }) => method === "PUT" && path.endsWith("/world-info") && status === 200).length)
      .toBe(2);
    await expect
      .poll(() => responses.filter(({ method, path, status }) => method === "GET" && path.endsWith("/state") && status === 200).length)
      .toBeGreaterThanOrEqual(2);

    // Reload must re-read durable state rather than preserve an optimistic UI selection.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.locator("[data-world-info-binding]").getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();
    assert.equal(await page.locator("body").textContent().then((text) => text?.includes("Pelican Town") ?? false), true);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser persists a World Info bind made after a real message as pending until the next turn", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const responses: Array<{ method: string; path: string; status: number }> = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) {
        responses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
      }
    });

    // A chat with a real transcript. A bind made here must NOT settle
    // immediately: the coordinator converges only on the next turn, so the
    // durable desired binding surfaces as pending with an explanatory
    // notice instead of a false selected state.
    await mounted.appendPlayerMessageToLockWorldInfo();

    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-world-info-binding]");
    await panel.getByRole("button", { name: "Bind: Pelican Town" }).click();
    await expect(page.getByRole("status")).toContainText("Saved successfully.");
    await expect(panel.getByText("This binding is saved and will fully apply on the next turn.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    await expect
      .poll(() => responses.some(({ method, path, status }) => method === "PUT" && path.endsWith("/world-info") && status === 200))
      .toBe(true);

    // Reload proves the pending bind is durable and the transcript intact;
    // the pending notice remains the player's only guide.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    const reloaded = page.locator("[data-world-info-binding]");
    await expect(reloaded.getByText("This binding is saved and will fully apply on the next turn.")).toBeVisible();
    await expect(reloaded.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    assert.equal(await page.locator("body").textContent().then((text) => text?.includes("Lock the World Info binding fixture.") ?? false), true);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser keeps two pages consistent about the desired and pending binding state", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "en-US" });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const responsesA = [];
    const responsesB = [];
    const stateBodiesA = [];
    for (const [page, responses] of [
      [pageA, responsesA],
      [pageB, responsesB],
    ]) {
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith("/api/tavern/v1/")) {
          responses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
        }
        if (page === pageA && response.request().method() === "GET" && url.pathname.endsWith("/state") && response.status() === 200) {
          void response.json().then((body) => { stateBodiesA.push(body); });
        }
      });
    }

    await pageA.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(pageA.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();
    await pageB.goto(mounted.server.origin + "/#profile=management", { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(pageB.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();

    await pageB.getByRole("button", { name: "Bind: Pelican Town" }).click();
    await expect(pageB.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    await expect
      .poll(() => responsesB.some(({ method, path, status }) => method === "PUT" && path.endsWith("/world-info") && status === 200))
      .toBe(true);

    await pageA.getByRole("button", { name: "Bind: Pelican Town" }).click();
    await expect(pageA.getByRole("status")).toContainText("World Info binding could not be updated.");
    await expect
      .poll(() => responsesA.some(({ method, path, status }) => method === "PUT" && path.endsWith("/world-info") && status === 409))
      .toBe(true);
    await expect
      .poll(() => responsesA.filter(({ method, path, status }) => method === "GET" && path.endsWith("/state") && status === 200).length)
      .toBeGreaterThanOrEqual(1);

    await expect(pageA.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    await expect
      .poll(() =>
        stateBodiesA.some((body) => {
          const worldInfo = body && body.chat && body.chat.worldInfo;
          const items = (worldInfo && worldInfo.items) || [];
          return (
            (worldInfo && (worldInfo.state === "selected" || worldInfo.state === "pending")) &&
            items.filter((item) => item.selected === true || item.pending === true).length === 1
          );
        }),
      )
      .toBe(true);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("stale revision title and draft mutations receive the durable conflict and read-back, not optimistic local state", async () => {
  test.setTimeout(180_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    // Two pages in one context share the one browser session cookie: the first
    // page is the interactive session and the second is a stale read
    // projection whose mutations must fail on the duplicate generation/revision
    // CAS and resync to the durable state (design/40 P9: same-cookie stale tab).
    const context = await browser.newContext({ locale: "en-US" });
    const apiA: Array<{ method: string; path: string; status: number }> = [];
    const apiB: Array<{ method: string; path: string; status: number }> = [];
    const pageA = await context.newPage();
    pageA.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) {
        apiA.push({ method: response.request().method(), path: url.pathname, status: response.status() });
      }
    });
    await pageA.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(pageA.getByRole("button", { name: "Chats" })).toBeVisible();

    const pageB = await context.newPage();
    pageB.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) {
        apiB.push({ method: response.request().method(), path: url.pathname, status: response.status() });
      }
    });
    await pageB.goto(`${mounted.server.origin}/#profile=management`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(pageB.getByRole("button", { name: "Chats" })).toBeVisible();

    // The stale page must never consume a second one-time bootstrap; it boots
    // through the shared session cookie only.
    assert.equal(apiB.some(({ method, path }) => method === "POST" && path.endsWith("/bootstrap")), false);
    assert.ok(apiA.some(({ method, path }) => method === "POST" && path.endsWith("/bootstrap")));

    // --- Stale title: page A renames durably; page B still holds the previous
    // management revision, so its rename must conflict and re-read the list.
    await pageA.getByRole("button", { name: "Chats" }).click();
    const drawerA = pageA.getByRole("dialog", { name: "Chats" });
    await expect(drawerA).toBeVisible();
    await drawerA.getByTitle("Rename Chat").click();
    await drawerA.locator("input.form-input").fill("A durable title");
    await drawerA.getByRole("button", { name: "Save" }).click();
    await expect(drawerA.getByText("A durable title", { exact: true })).toBeVisible();
    await expect(pageA.getByRole("status")).toContainText("Saved successfully.");
    await drawerA.getByRole("button", { name: "Close" }).click();
    await expect(drawerA).toHaveCount(0);

    await pageB.getByRole("button", { name: "Chats" }).click();
    const drawerB = pageB.getByRole("dialog", { name: "Chats" });
    await expect(drawerB).toBeVisible();
    await expect(drawerB.getByText("Untitled chat", { exact: true })).toBeVisible();
    await drawerB.getByTitle("Rename Chat").click();
    await drawerB.locator("input.form-input").fill("Optimistic stale title");
    await drawerB.getByRole("button", { name: "Save" }).click();

    await expect(pageB.getByRole("status")).toContainText("Operation failed.");
    await expect
      .poll(() => apiB.some(({ method, path, status }) => method === "PUT" && path.endsWith("/chat/title") && status === 409))
      .toBe(true);
    await expect(drawerB.getByText("A durable title", { exact: true })).toBeVisible();
    await expect(drawerB.getByText("Optimistic stale title", { exact: true })).toHaveCount(0);
    await expect
      .poll(() => apiB.filter(({ method, path }) => method === "GET" && path.endsWith("/chats")).length)
      .toBeGreaterThanOrEqual(2);
    await drawerB.getByRole("button", { name: "Close" }).click();
    await expect(drawerB).toHaveCount(0);

    // --- Stale draft: page A advances the durable draft; page B still holds
    // the previous draft revision, so its save must conflict and re-read the
    // durable draft text instead of keeping the optimistic local value.
    const draftA = pageA.getByRole("textbox", { name: "Saved draft" });
    const draftB = pageB.getByRole("textbox", { name: "Saved draft" });
    await expect(draftB).toHaveValue("");
    await draftA.fill("A durable draft from the live page");
    await pageA.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pageA.getByRole("status")).toContainText("Saved successfully.");
    await expect
      .poll(() => apiA.some(({ method, path, status }) => method === "PUT" && path.endsWith("/draft") && status === 200))
      .toBe(true);

    await draftB.fill("Optimistic stale local text");
    await pageB.getByRole("button", { name: "Save", exact: true }).click();

    await expect(pageB.getByRole("status")).toContainText("Operation failed.");
    await expect
      .poll(() => apiB.some(({ method, path, status }) => method === "PUT" && path.endsWith("/draft") && status === 409))
      .toBe(true);
    // The stale value must not survive as optimistic local state: the editor
    // shows the durable read-back after the conflict.
    await expect(draftB).toHaveValue("A durable draft from the live page", { timeout: 3_000 });
    await expect(draftB).not.toHaveValue("Optimistic stale local text");

    // --- Stale Memory edit: both pages read the same managed row, page A
    // updates it, and page B's stale update gets a 409 plus fresh safe
    // read-back instead of retaining its local text.
    await pageA.getByRole("button", { name: "Memory" }).click();
    await expect(pageA.locator("[data-memory-panel]")).toBeVisible();
    await pageA.getByRole("textbox", { name: "Memory content" }).fill("Original durable memory");
    await pageA.getByRole("button", { name: "Create", exact: true }).click();
    await expect(pageA.getByText("Original durable memory", { exact: true })).toBeVisible();

    await pageB.getByRole("button", { name: "Memory" }).click();
    await expect(pageB.getByText("Original durable memory", { exact: true })).toBeVisible();

    await pageA.getByRole("button", { name: "Edit memory", exact: true }).click();
    await pageA.getByRole("textbox", { name: "Memory content: Semantic memory" }).fill("Durable Memory from page A");
    await pageA.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pageA.getByText("Durable Memory from page A", { exact: true })).toBeVisible();

    await pageB.getByRole("button", { name: "Edit memory", exact: true }).click();
    await pageB.getByRole("textbox", { name: "Memory content: Semantic memory" }).fill("Optimistic stale Memory text");
    await pageB.getByRole("button", { name: "Save", exact: true }).click();

    await expect(pageB.getByRole("status")).toContainText("Operation failed.");
    await expect
      .poll(() => apiB.some(({ method, path, status }) => method === "PUT" && path.endsWith("/memory") && status === 409))
      .toBe(true);
    await expect(pageB.getByText("Durable Memory from page A", { exact: true })).toBeVisible();
    await expect(pageB.getByText("Optimistic stale Memory text", { exact: true })).toHaveCount(0);
    // Reopening after a conflict must seed the textarea from the authoritative
    // reread, rather than reuse the previous rejected local draft.
    await pageB.getByRole("button", { name: "Edit memory", exact: true }).click();
    await expect(pageB.getByRole("textbox", { name: "Memory content: Semantic memory" })).toHaveValue(
      "Durable Memory from page A",
    );
    await pageB.getByRole("textbox", { name: "Memory content: Semantic memory" }).fill("Durable correction from page B");
    await pageB.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pageB.getByText("Durable correction from page B", { exact: true })).toBeVisible();
    await pageA.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await pageA.getByRole("button", { name: "Memory" }).click();
    await expect(pageA.getByText("Durable correction from page B", { exact: true })).toBeVisible();
    await expect
      .poll(() => apiB.filter(({ method, path }) => method === "GET" && path.endsWith("/memory")).length)
      .toBeGreaterThanOrEqual(2);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management journey is readable and usable in zh-CN at a 375x667 viewport", async () => {
  test.setTimeout(180_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 375, height: 667 } });
    const page = await context.newPage();
    const viewport = page.viewportSize() as { width: number; height: number };
    const apiRequests: Array<{ method: string; path: string }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiRequests.push({ method: request.method(), path: url.pathname });
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });

    // html lang follows the resolved zh-CN locale (no persisted override).
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    // Translated chrome: the app-bar Chat list button and draft labels are zh-CN.
    await expect(page.getByRole("button", { name: "会话" })).toBeVisible();

    // Unsupported controls are absent on the mounted management profile (no
    // submit composer, no Send) in zh-CN too.
    await expect(page.locator("textarea.composer-textarea")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /发送/i })).toHaveCount(0);

    // Durable draft read-back: save, reload, and re-read through the cookie.
    const draftEditor = page.getByRole("textbox", { name: "已保存草稿" });
    await expect(draftEditor).toHaveValue("");
    await draftEditor.fill("一条持久化的中文草稿");
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "丢弃", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("保存成功。");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.getByRole("button", { name: "会话" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "已保存草稿" })).toHaveValue("一条持久化的中文草稿");

    // Durable list/title read-back: rename in the drawer, reload, re-read.
    await page.getByRole("button", { name: "会话" }).click();
    const drawer = page.getByRole("dialog", { name: "会话" });
    await expect(drawer).toBeVisible();
    await drawer.getByTitle("重命名会话").click();
    await drawer.locator("input.form-input").fill("持久化的中文标题");
    await drawer.getByRole("button", { name: "保存", exact: true }).click();
    await expect(drawer.getByText("持久化的中文标题", { exact: true })).toBeVisible();

    // The drawer stays within the 375px viewport without horizontal overflow.
    const drawerBox = await drawer.boundingBox();
    assert.ok(drawerBox !== null);
    assert.ok(drawerBox.x >= -1, `drawer left edge ${drawerBox.x}`);
    assert.ok(drawerBox.x + drawerBox.width <= viewport.width + 1, `drawer right edge ${drawerBox.x + drawerBox.width}`);
    assert.equal(await drawer.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
    // Unsupported New Chat stays absent inside the zh-CN drawer.
    await expect(drawer.getByRole("button", { name: /新建会话/i })).toHaveCount(0);

    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(drawer).toHaveCount(0);

    // No horizontal overflow anywhere in the shell at 375px.
    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    assert.ok(overflow.documentWidth <= overflow.viewportWidth + 1, `doc ${overflow.documentWidth} > ${overflow.viewportWidth}`);
    assert.ok(overflow.bodyWidth <= overflow.viewportWidth + 1, `body ${overflow.bodyWidth} > ${overflow.viewportWidth}`);
    assert.equal(apiRequests.filter(({ method, path }) => method === "POST" && path.endsWith("/bootstrap")).length, 1);
    assert.ok(apiRequests.some(({ method, path }) => method === "GET" && path.endsWith("/chats")));
    assert.ok(apiRequests.some(({ method, path }) => method === "GET" && path.endsWith("/draft")));
  } finally {
    await browser.close();
    await mounted.close();
  }
});


/**
 * Connection and model management, design/28 §1 and §5, driven through the real
 * mounted surface: the Host catalog projection, a durable create, the real probe
 * code path answered by a bounded local endpoint, and the write-only credential
 * guarantee. Every request/response here crosses the same authenticated
 * `tavern_browser_api/v1` boundary a player's browser uses.
 */
test("management browser creates a connection from the Host catalog and never reads the credential back", async () => {
  test.setTimeout(180_000);
  const mounted = await startMountedManagementComposition({
    endpointHandler: (url) =>
      url === "http://127.0.0.1:11434/v1/models"
        ? { status: 200, body: JSON.stringify({ data: [{ id: "qwen2.5-coder:7b" }] }) }
        : { status: 404, body: "{}" },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const secret = "sk-synthetic-write-only-9f2c";
    const baseUrl = "http://127.0.0.1:11434/v1";
    const modelId = "qwen2.5-coder:7b";
    // Every request and response that crosses the authenticated browser
    // boundary, so the write-only credential guarantee is checked on all of
    // them rather than on one hand-picked call.
    const apiCalls: Array<{ method: string; path: string; requestBody: string; responseBody: string }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/tavern/v1/")) return;
      // The event stream stays open for the page lifetime, so it has no
      // complete response body to inspect.
      if (url.pathname.endsWith("/events")) return;
      apiCalls.push({
        method: request.method(),
        path: url.pathname,
        requestBody: request.postData() ?? "",
        responseBody: "",
      });
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/tavern/v1/")) return;
      if (url.pathname.endsWith("/events")) return;
      const method = response.request().method();
      const entry = [...apiCalls]
        .reverse()
        .find((call) => call.method === method && call.path === url.pathname && call.responseBody === "");
      if (entry === undefined) return;
      void response
        .text()
        .then((body) => {
          entry.responseBody = body;
        })
        .catch(() => undefined);
    });
    /**
     * True when the plaintext credential is reachable in the serialized
     * document or rendered text. The value of a control the player is still
     * editing is their own typing, not a read-back, so it is checked by
     * `documentLeaksSecretToControls` instead.
     */
    const documentLeaksSecret = async () =>
      await page.evaluate((value) => {
        return [document.documentElement.outerHTML, document.body?.textContent ?? ""].join("\n").includes(value);
      }, secret);
    /** True when any control value in the live document still holds the credential. */
    const documentLeaksSecretToControls = async () =>
      await page.evaluate((value) => {
        return [...document.querySelectorAll("input, textarea, select")].some((element) =>
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value.includes(value)
            : (element.textContent ?? "").includes(value),
        );
      }, secret);
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });

    // 1. The connection group renders, and its provider list is the Host
    // catalog projection rather than anything hard-coded in the frontend.
    const panel = page.locator("[data-connection-settings]");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Connection and model" })).toBeVisible();
    await expect(panel.locator("[data-connection-active-value]")).toHaveText("No connection selected");
    await expect(panel.locator("[data-connection-no-selection]")).toBeVisible();
    const providerIds = await panel.locator("#connection-provider option").evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    assert.deepEqual(providerIds, ["cpa-oai", "deepseek", "openai", "gamebuddy-openai-compatible"]);
    await expect(panel.locator("#connection-provider option")).toHaveCount(4);

    // 2. Provider -> API key -> submit. The escape hatch is the catalog entry
    // whose endpoint and model id the player supplies.
    await panel.locator("#connection-provider").selectOption("gamebuddy-openai-compatible");
    await expect(panel.locator("#connection-base-url")).toBeVisible();
    await expect(panel.locator("#connection-model-id")).toBeVisible();
    await panel.locator("#connection-base-url").fill(baseUrl);
    await panel.locator("#connection-api-key").fill(secret);
    await panel.locator("#connection-model-id").fill(modelId);
    await panel.getByRole("button", { name: "Save connection" }).click();

    const row = panel.locator("[data-connection-row]").filter({ hasText: baseUrl });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-readiness", "configured");
    await expect(row.locator("[data-connection-failure]")).toHaveCount(0);
    // 8. The URL the player typed is the one endpoint fact that reads back and
    // is the only place an endpoint is shown in the document.
    await expect(row.locator("[data-connection-base-url]")).toHaveText(baseUrl);
    await expect(panel.locator("[data-connection-base-url]")).toHaveCount(1);

    // 7. The credential must never be readable back. Four independent surfaces:
    // the submission itself, every other HTTP request and response body, the
    // live document (HTML, text and form-control values), and the durable
    // reload.
    await expect
      .poll(() => apiCalls.filter(({ method, path }) => method === "POST" && path.endsWith("/settings/connections")).length)
      .toBe(1);
    const createCall = apiCalls.find(
      ({ method, path }) => method === "POST" && path.endsWith("/settings/connections"),
    );
    assert.ok(createCall !== undefined);
    await expect.poll(() => createCall.responseBody !== "").toBe(true);
    // The one request allowed to carry the write-only credential is the create.
    assert.equal(createCall.requestBody.includes(secret), true);
    for (const call of apiCalls) {
      assert.equal(call.responseBody.includes(secret), false, `credential leaked in the response to ${call.method} ${call.path}`);
      if (call === createCall) continue;
      assert.equal(call.requestBody.includes(secret), false, `credential leaked in the request ${call.method} ${call.path}`);
    }
    assert.equal(await documentLeaksSecret(), false, "credential leaked into the rendered document");
    // Diagnostic (never a credential value): whether the write-only control
    // still holds the submitted text in the live page before a reload.
    test.info().annotations.push({
      type: "connection-form-after-submit",
      description: (await panel.locator("#connection-api-key").inputValue()) === "" ? "cleared" : "retained",
    });
    // The durable read-back after a reload keeps the endpoint and never the key.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    const reloadedPanel = page.locator("[data-connection-settings]");
    await expect(reloadedPanel).toBeVisible();
    await expect(reloadedPanel.locator("[data-connection-list]")).toBeVisible();
    await expect(
      reloadedPanel.locator("[data-connection-row]").filter({ hasText: baseUrl }),
    ).toBeVisible();
    // Reloading seeds the form from the durable projection, so the write-only
    // field is empty and the credential is nowhere in the document: not in the
    // markup, not in the text, and not in any control value.
    await reloadedPanel.locator("#connection-provider").selectOption("gamebuddy-openai-compatible");
    await expect(reloadedPanel.locator("#connection-api-key")).toHaveValue("");
    assert.equal(await documentLeaksSecret(), false, "credential leaked into the document after reload");
    assert.equal(
      await documentLeaksSecretToControls(),
      false,
      "credential leaked into a control value after reload",
    );
    for (const call of apiCalls) {
      assert.equal(call.responseBody.includes(secret), false, `credential leaked in the response to ${call.method} ${call.path}`);
      if (call === createCall) continue;
      assert.equal(call.requestBody.includes(secret), false, `credential leaked in the request ${call.method} ${call.path}`);
    }
    assert.ok(apiCalls.some(({ method, path }) => method === "GET" && path.endsWith("/settings/connection")));
  } finally {
    await browser.close();
    await mounted.close();
  }
});

/**
 * The closed probe outcome, activation eligibility, model selection and
 * removal rules of design/28 §5.3, all through the real mounted surface. The
 * probe is the production `probeTavernConnection`; only its network hop is
 * answered locally, so `ready` and a closed failure category are deterministic.
 */
test("management browser tests connections with a closed outcome, activates a ready record, selects a model and refuses active removal", async () => {
  test.setTimeout(240_000);
  const authorizations: string[] = [];
  const mounted = await startMountedManagementComposition({
    endpointHandler: (url, headers) => {
      authorizations.push(headers["authorization"] ?? "");
      if (url === "http://127.0.0.1:11434/v1/models")
        return { status: 200, body: JSON.stringify({ data: [{ id: "qwen2.5-coder:7b" }] }) };
      if (url === "http://127.0.0.1:9999/v1/models")
        return { status: 401, body: JSON.stringify({ error: "raw provider text must not surface" }) };
      return { status: 404, body: "{}" };
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const readyBaseUrl = "http://127.0.0.1:11434/v1";
    const failedBaseUrl = "http://127.0.0.1:9999/v1";
    const probes: string[] = [];
    const mutations: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/tavern/v1/")) return;
      const method = response.request().method();
      if (url.pathname.endsWith("/test")) probes.push(method);
      if (method === "DELETE" || url.pathname.endsWith("/activate") || url.pathname.endsWith("/model"))
        mutations.push(`${method} ${url.pathname}`);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });

    const panel = page.locator("[data-connection-settings]");
    await expect(panel).toBeVisible();
    const rowForBaseUrl = (baseUrl: string) => panel.locator("[data-connection-row]").filter({ hasText: baseUrl });

    // 5. A catalog provider with a catalog model: the model is chosen from the
    // Host catalog, and a catalog endpoint never reads back into the surface.
    await panel.locator("#connection-provider").selectOption("deepseek");
    await expect(panel.locator("#connection-model")).toBeVisible();
    await expect(panel.locator("#connection-model option")).toHaveCount(2);
    await panel.locator("#connection-model").selectOption("deepseek-v4-pro");
    await panel.locator("#connection-api-key").fill("sk-synthetic-deepseek-key");
    await panel.getByRole("button", { name: "Save connection" }).click();
    const deepseekRow = panel.locator("[data-connection-row]", { hasText: "DeepSeek V4 Pro" });
    await expect(deepseekRow).toBeVisible();
    await expect(deepseekRow.locator("[data-connection-base-url]")).toHaveCount(0);
    await expect(deepseekRow.locator("select")).toHaveValue("high");

    // 8. Two player-supplied escape-hatch endpoints: one answers, one rejects.
    await panel.locator("#connection-provider").selectOption("gamebuddy-openai-compatible");
    await panel.locator("#connection-base-url").fill(readyBaseUrl);
    await panel.locator("#connection-api-key").fill("sk-synthetic-ready-key");
    await panel.locator("#connection-model-id").fill("qwen2.5-coder:7b");
    await panel.getByRole("button", { name: "Save connection" }).click();
    const readyRow = rowForBaseUrl(readyBaseUrl);
    await expect(readyRow).toBeVisible();

    await panel.locator("#connection-base-url").fill(failedBaseUrl);
    await panel.locator("#connection-api-key").fill("sk-synthetic-rejected-key");
    await panel.locator("#connection-model-id").fill("qwen2.5-coder:7b");
    await panel.getByRole("button", { name: "Save connection" }).click();
    const failedRow = rowForBaseUrl(failedBaseUrl);
    await expect(failedRow).toBeVisible();

    // 3. The real probe: `ready` for the answering endpoint, and the closed
    // `unauthorized` category for the rejecting one. The provider's own text
    // must never reach the document.
    await readyRow.getByRole("button", { name: "Test connection" }).click();
    await expect(readyRow).toHaveAttribute("data-readiness", "ready");
    await expect(readyRow.getByText("Ready", { exact: true })).toBeVisible();
    await expect(readyRow.getByRole("button", { name: "Save and activate" })).toBeEnabled();

    await failedRow.getByRole("button", { name: "Test connection" }).click();
    await expect(failedRow).toHaveAttribute("data-readiness", "failed");
    await expect(failedRow.getByText("Test failed", { exact: true })).toBeVisible();
    await expect(failedRow.locator("[data-connection-failure]")).toHaveText("The endpoint rejected the credential.");
    await expect(page.getByText("raw provider text must not surface", { exact: false })).toHaveCount(0);
    await expect(failedRow.getByRole("button", { name: "Save and activate" })).toBeDisabled();
    await expect(failedRow.getByRole("button", { name: "Save and activate" })).toHaveAttribute(
      "title",
      "Test the connection before activating it.",
    );
    await expect.poll(() => probes.length).toBe(2);
    assert.deepEqual(authorizations, ["Bearer sk-synthetic-ready-key", "Bearer sk-synthetic-rejected-key"]);

    // 4. Only the ready record can be activated, and the UI then shows it as
    // the active connection.
    await readyRow.getByRole("button", { name: "Save and activate" }).click();
    await expect(panel.locator("[data-connection-activated]")).toBeVisible();
    await expect(panel.locator("[data-connection-active-value]")).toHaveText(
      "OpenAI-compatible endpoint · qwen2.5-coder:7b",
    );
    await expect(readyRow.getByRole("button", { name: "Save and activate" })).toBeDisabled();
    await expect.poll(() => mutations.filter((entry) => entry.includes("/activate")).length).toBe(1);

    // 6. The active record cannot be removed and the refusal states why; the
    // other records can.
    await expect(readyRow.getByRole("button", { name: "Remove" })).toBeDisabled();
    await expect(readyRow.getByRole("button", { name: "Remove" })).toHaveAttribute(
      "title",
      "An active connection cannot be removed. Activate another connection first.",
    );
    // A disabled control dispatches no remove request at all.
    assert.equal(mutations.filter((entry) => entry.startsWith("DELETE")).length, 0);
    await failedRow.getByRole("button", { name: "Remove" }).click();
    await expect(failedRow).toHaveCount(0);
    await expect.poll(() => mutations.filter((entry) => entry.startsWith("DELETE")).length).toBe(1);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.locator("[data-connection-settings]")).toBeVisible();
    await expect(rowForBaseUrl(failedBaseUrl)).toHaveCount(0);
    await expect(rowForBaseUrl(readyBaseUrl)).toBeVisible();

    // 5. The thinking level of a saved record is a catalog-constrained choice,
    // and the durable read-back reflects the saved value.
    await deepseekRow.locator("select").selectOption("max");
    await expect(deepseekRow.locator("select")).toHaveValue("max");
    await expect.poll(() => mutations.filter((entry) => entry.endsWith("/model")).length).toBe(1);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.locator("[data-connection-settings]")).toBeVisible();
    const deepseekAfterReload = page.locator("[data-connection-row]", { hasText: "DeepSeek V4 Pro" });
    await expect(deepseekAfterReload.locator("select")).toHaveValue("max");
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser with the Characters surface saves Persona, Scenario and Greeting durably and lists the companion library", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition({ withCharacters: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const mutations: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) mutations.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-characters-panel]");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Persona starts absent and saves through the durable store with a
    // revision read-back; every save is a real PUT round-trip.
    await expect(panel.getByText("No persona saved yet.")).toBeVisible();
    await panel.locator("#persona-name").fill("The Farmer");
    await panel.locator("#persona-description").fill("A quiet soul who loves cauliflower.");
    await panel.getByRole("button", { name: "Save Persona" }).click();
    await expect(panel.getByText("Saved.").first()).toBeVisible();
    await expect(panel.getByText("Present")).toBeVisible();

    // Scenario saves and reloads.
    await panel.locator("#scenario-name").fill("Spring in Pelican Town");
    await panel.locator("#scenario-description").fill("Stardew Valley, the first of spring.");
    await panel.getByRole("button", { name: "Save Scenario" }).click();
    await expect(panel.getByText("Saved.").first()).toBeVisible();

    // Greeting saves one variant through the durable store.
    await panel.locator("#greeting-label").fill("Morning");
    await panel.locator("#greeting-variant-0-text").fill("Good morning, sunshine.");
    await panel.getByRole("button", { name: "Save Greeting" }).click();
    await expect(panel.getByText("Saved.").first()).toBeVisible();

    // The companion library starts empty on a fresh fixture root (the mounted
    // Chat runtime does not mint a companion artifact into the library's
    // repository tree), then a create through the durable store adds one. The
    // mount-projected identity is never the mounted companion here, so the
    // current-marker semantics are not exercised by this journey.
    await expect(panel.getByText("No companions yet.")).toBeVisible();
    await panel.getByRole("textbox", { name: "New companion" }).fill("Harvest Helper");
    await panel.getByRole("button", { name: "Create companion" }).click();
    await expect(panel.locator("[data-companion-entry]").first()).toContainText("Harvest Helper");
    // The projected handle is opaque: no durable companion identity text may
    // reach the DOM (companion_01 is the fixture principal; a created
    // companion would leak a `companion-<uuid>` otherwise).
    await expect(panel.locator("[data-companion-entry]").first()).not.toContainText("companion_01");
    await expect(panel.locator("[data-companion-entry]").first()).not.toContainText("companion-");

    // Reload proves every section read back from the durable store.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    const reloaded = page.locator("[data-characters-panel]");
    await expect(reloaded).toBeVisible();
    await expect(reloaded.getByText("Present")).toBeVisible();
    await expect(reloaded.locator("#persona-name")).toHaveValue("The Farmer");
    await expect(reloaded.locator("#scenario-name")).toHaveValue("Spring in Pelican Town");
    await expect(reloaded.locator("#greeting-variant-0-text")).toHaveValue("Good morning, sunshine.");
    // The created companion is durable too: after reload the library re-reads
    // the artifact repository.
    await expect(reloaded.locator("[data-companion-entry]").first()).toContainText("Harvest Helper");

    // Every durable mutation was a PUT against a mounted route.
    assert.equal(mutations.filter((entry) => entry.startsWith("PUT /api/tavern/v1/persona")).length, 1);
    assert.equal(mutations.filter((entry) => entry.startsWith("PUT /api/tavern/v1/scenario")).length, 1);
    assert.equal(mutations.filter((entry) => entry.startsWith("PUT /api/tavern/v1/greeting")).length, 1);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser with the Characters surface archives and trashes the mounted chat through lifecycle retention", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition({ withCharacters: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const mutations: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) mutations.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-characters-panel]");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // The drawer shows the mounted chat with archive/trash controls on the
    // current row only (retention is a mounted-chat-only operation).
    await page.getByRole("button", { name: "Chats" }).click();
    const currentRow = page.locator(".chat-item-card.selected");
    await expect(currentRow.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(currentRow.getByRole("button", { name: "Trash" })).toBeVisible();

    // Archive removes the chat from the active list through the lifecycle
    // route; the drawer reconciles to the durable list.
    await currentRow.getByRole("button", { name: "Archive" }).click();
    await expect
      .poll(() => mutations.some((entry) => entry.startsWith("POST /api/tavern/v1/chats/") && entry.endsWith("/archive")))
      .toBe(true);
    await expect(page.locator(".chat-item-card")).toHaveCount(0);

    // A reload of the characters surface still renders (retention did not
    // corrupt the management surface) and the drawer stays empty.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.locator("[data-characters-panel]")).toBeVisible();
  } finally {
    await browser.close();
    await mounted.close();
  }
});

/** Depth-first search for one file name under a fixture root. */
async function findFile(directory: string, fileName: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(child, fileName);
      if (found !== null) return found;
    } else if (entry.name === fileName) return child;
  }
  return null;
}

/**
 * A synthetic CCv3 card carrying exactly the two things the reviewed import has
 * to prove: one reviewable persona field, and one always-on world-book entry
 * that must reach the provisioned companion's durable book (the S3 link into the
 * Tier 2 m[0] baseline).
 */
const IMPORTED_CARD = Object.freeze({
  spec: "chara_card_v3",
  data: Object.freeze({
    name: "Imported Rae",
    description: "Quiet, attentive, fond of the valley.",
    mes_example: "<START>\n{{user}}: Morning!\n{{char}}: A quiet start; I like it.",
    character_book: Object.freeze({
      entries: [
        Object.freeze({
          keys: [] as readonly string[],
          content: "Imported Rae knows every footpath around the valley.",
          extensions: Object.freeze({}),
          name: "Footpaths",
          constant: true,
          comment: "Always-on world book entry.",
        }),
      ],
    }),
  }),
});

test("management browser imports a reviewed character card and provisions the companion it names", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition({ withCharacters: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const calls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) calls.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-characters-panel]");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const cardImport = panel.locator("[data-card-import]");
    await expect(cardImport).toBeVisible();

    // The card itself is the player's only input: nothing is supplied out of band.
    await cardImport.locator("textarea").fill(JSON.stringify(IMPORTED_CARD));
    await cardImport.getByRole("button", { name: "Review card" }).click();

    // The player reviews visible evidence, never card body text: the reviewable
    // persona field, the world-book field the always-on entry travels as, and the
    // inert dispositions for what is not included.
    const fields = cardImport.locator("[data-import-fields]");
    await expect(fields).toContainText("persona_core");
    await expect(fields).toContainText("profile_eligible_after_explicit_review");
    await expect(fields).toContainText("worldbook_");
    // The dispositions sit behind the panel's own disclosure: open it the way a
    // player does, then assert it names what was kept and what was not, by
    // classification only (never card body text).
    const excluded = cardImport.locator("details").filter({ hasText: "Not included" }).first();
    await excluded.locator("summary").click();
    const dispositions = cardImport.locator("[data-import-dispositions]");
    await expect(dispositions).toBeVisible();
    await expect(dispositions).toContainText(
      /(accepted_typed|preserved_opaque|dropped_unsupported|rejected_invalid)/u,
    );
    await expect(cardImport).toContainText("Imported Rae");

    await cardImport.getByRole("button", { name: "Confirm & create companion" }).click();
    await expect(cardImport.getByRole("status")).toContainText("Imported companion created.");

    // The provisioned companion joins the library under the name the card
    // carried: approving the reviewed name is what makes that true.
    await expect(panel.locator("[data-companion-entry]").first()).toContainText("Imported Rae");

    // Durable read-back: the reviewed always-on world book the card carried is on
    // disk for the provisioned companion. That file is the S3 link the Chat
    // surface materializes into Tier 2 m[0].
    const provisioned = await findFile(mounted.root, "worldbook.json");
    assert.ok(provisioned !== null, "the provisioned companion's world book is durable");
    const book = JSON.parse(await readFile(provisioned, "utf8")) as {
      entries: readonly { constant?: boolean; content?: string }[];
    };
    assert.equal(
      book.entries.some((entry) => entry.constant === true && (entry.content ?? "").includes("every footpath")),
      true,
    );

    // A reload proves the companion is durable library state, not optimistic DOM.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.locator("[data-companion-entry]").first()).toContainText("Imported Rae");

    // Every step was a real mounted route: stage, the signed review, then confirm.
    assert.equal(calls.filter((entry) => entry === "POST /api/tavern/v1/imports").length, 1);
    assert.equal(calls.filter((entry) => /^POST \/api\/tavern\/v1\/imports\/[^/]+\/review$/u.test(entry)).length, 1);
    assert.equal(calls.filter((entry) => /^POST \/api\/tavern\/v1\/imports\/[^/]+\/confirm$/u.test(entry)).length, 1);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser shows a durable loss report for a confirmed card import and keeps it after reload", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition({ withCharacters: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const calls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) calls.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-characters-panel]");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Nothing has been confirmed yet: the loss report says so plainly instead of
    // showing a placeholder row that would read as a record.
    const history = panel.locator("[data-card-import-history]");
    await expect(history).toBeVisible();
    await expect(history.locator("[data-import-history-entry]")).toHaveCount(0);

    const cardImport = panel.locator("[data-card-import]");
    await cardImport.locator("textarea").fill(JSON.stringify(IMPORTED_CARD));
    await cardImport.getByRole("button", { name: "Review card" }).click();
    await cardImport.getByRole("button", { name: "Confirm & create companion" }).click();
    await expect(cardImport.getByRole("status")).toContainText("Imported companion created.");

    // The record is durable evidence by the time confirm returns, so exactly one
    // entry appears without a reload: the card name the import carried, when,
    // and the per-class counts the Host wrote.
    const entries = history.locator("[data-import-history-entry]");
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText("Imported Rae");
    const counts = entries.first().locator("[data-import-history-counts]");
    for (const classification of [
      "accepted_typed",
      "preserved_opaque",
      "dropped_unsupported",
      "rejected_invalid",
    ])
      await expect(counts).toContainText(classification);
    assert.equal(
      await history.textContent().then((text) => (text ?? "").includes("Quiet, attentive, fond of the valley.")),
      false,
      "the loss report never renders card body text",
    );

    // A reload proves the entry is durable evidence rather than optimistic DOM.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    const reloaded = page.locator("[data-card-import-history]");
    await expect(reloaded.locator("[data-import-history-entry]")).toHaveCount(1);
    await expect(reloaded.locator("[data-import-history-entry]").first()).toContainText("Imported Rae");

    // Initial hydration, the post-confirm refresh, and the reload: three reads,
    // each through the one authenticated route.
    assert.equal(calls.filter((entry) => entry === "GET /api/tavern/v1/import-history").length, 3);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser sets the companion language once, durably, and the runtime reads it", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const languageCalls: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/tavern/v1/settings/language") languageCalls.push(request.method());
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    const panel = page.locator("[data-language-settings]");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // The panel adopts what the Host holds: it never shows a local guess beside a
    // durable setting. A never-configured root records the language the UI is
    // already showing, which is the player's browser language here (en-US).
    const select = panel.getByRole("combobox");
    await expect(select).toHaveValue("en-US", { timeout: 10_000 });

    // Switching writes through the durable store and reports it.
    await select.selectOption("zh-CN");
    await expect(page.locator(".success-banner").first()).toBeVisible({ timeout: 10_000 });

    // Durable read-back on reload: the stored preference, not the local choice.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(page.locator("[data-language-settings]").getByRole("combobox")).toHaveValue("zh-CN", {
      timeout: 10_000,
    });

    // Two writes and no more: the first records the language the panel was
    // already showing (a never-configured root adopts the browser's), the second
    // is the player's switch. A third would mean a write loop.
    assert.equal(languageCalls.filter((method) => method === "PUT").length, 2);
    assert.ok(languageCalls.includes("GET"));
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("conformance: management surface meets the frontend criteria", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition({ withCharacters: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    const noise = watchSurface(page);
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-language-settings]")).toBeVisible({ timeout: 20_000 });
    // Wait for the async panels to finish loading before judging keyboard reach:
    // a panel that appears after the walk would be reported unreachable for the
    // wrong reason, which is a false negative and would make this criterion
    // untrustworthy. The Characters panel is the slowest of them.
    await expect(page.locator("[data-characters-panel]")).toBeVisible({ timeout: 20_000 });

    // The criteria that need a real walk: the surface is judged as rendered, and
    // every settings section it shows must be reachable without a pointer. A
    // panel that a future change wraps in a pointer-only widget fails here.
    resetCriteriaLedger();
    await assertAccessibilityBaseline(page, "management");
    await assertSectionsKeyboardReachable(page, "section[aria-label]");
    assertQuiet(noise, "management");
    assertCriteriaCoverage("management", MANAGEMENT_CRITERIA_OBLIGATIONS);
  } finally {
    await context.close();
    await browser.close();
    await mounted.close();
  }
});
