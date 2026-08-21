import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    load("continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.js"),
    load("deployment-manifest.js"),
    load("runtime.js"),
    load("tavern/chat-thread-store.js"),
    load("tavern/browser-contract/index.js"),
    load("tavern/chat-management/chat-management-service.js"),
    load("tavern/memory-management/memory-management.js"),
    load("tavern/world-info-management/world-info-management.js"),
    load("tavern/world-info-binding/world-info-binding-management-service.js"),
    load("tavern/tavern-management-state.js"),
    load("tavern/tavern-management-static-shell-composition.js"),
    load("windows-reparse-inspector/index.js"),
    load("windows-stale-lock-reclaimer/index.js"),
    load("path-lock.js"),
  ]);
}

async function startMountedManagementComposition() {
  test.skip(process.platform !== "win32", "requires the real Windows mounted coordinator");
  const pointer = JSON.parse(await readFile(resolve(hostRoot, "dist", "current.json"), "utf8"));
  const artifactRoot = resolve(hostRoot, "dist", "generations", pointer.generation);
  const [
    chatFacade,
    deployment,
    runtime,
    chatThreadStoreModule,
    contract,
    serviceModule,
    memoryModule,
    worldInfoManagementModule,
    worldInfoBindingModule,
    stateModule,
    composition,
    inspectorModule,
    reclaimerModule,
    pathLock,
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
    ],
    operationIds: ["draft.save", "draft.discard", "chat.rename", "memory.mutate", "world-info.bind"],
    navigationItemIds: ["chat", "memory"],
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
  });
  const managementStateFacade = await stateModule.createTavernManagementStateFacade(
    manifest,
    lease,
    profile,
    worldInfoService,
  );
  const managementService = serviceModule.createChatManagementService({ manifest, lease, profile });
  const memoryService = memoryModule.createMemoryManagementService({ manifest, lease, profile });
  const inspector = await inspectorModule.createPublishedWindowsReparseInspector(artifactRoot);
  const server = await composition.startTavernManagementStaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    managementStateFacade,
    managementService,
    memoryService,
    worldInfoService,
    profile,
    bootstrapToken,
  });
  return {
    server,
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

test("management browser preserves the durable selection and shows a locked read-back after a real message locks World Info", async () => {
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
    await panel.getByRole("button", { name: "Bind: Pelican Town" }).click();
    await expect(panel.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    await mounted.appendPlayerMessageToLockWorldInfo();

    // The existing UI snapshot is still selected. A real PUT must now fail
    // through the mounted service's pristine-thread lock and the UI must
    // replace itself from the authoritative locked /state projection.
    await panel.getByRole("button", { name: "Unbind: Pelican Town" }).click();
    await expect(page.getByRole("status")).toContainText("World Info binding could not be updated.");
    await expect(panel.getByText("World Info binding is locked after this chat has messages.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Unbind: Pelican Town" })).toBeDisabled();
    await expect
      .poll(() => responses.some(({ method, path, status }) => method === "PUT" && path.endsWith("/world-info") && status === 409))
      .toBe(true);
    await expect
      .poll(() => responses.filter(({ method, path, status }) => method === "GET" && path.endsWith("/state") && status === 200).length)
      .toBeGreaterThanOrEqual(1);

    // Reload proves the pre-existing exact binding and transcript survived the
    // rejected mutation; the result is a durable locked selected projection,
    // not an optimistic local flip.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    const reloaded = page.locator("[data-world-info-binding]");
    await expect(reloaded.getByText("World Info binding is locked after this chat has messages.")).toBeVisible();
    await expect(reloaded.getByRole("button", { name: "Unbind: Pelican Town" })).toBeDisabled();
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("management browser replaces a stale World Info projection with the durable selected read-back", async () => {
  test.setTimeout(120_000);
  const mounted = await startMountedManagementComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "en-US" });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const responsesA: Array<{ method: string; path: string; status: number }> = [];
    const responsesB: Array<{ method: string; path: string; status: number }> = [];
    const stateBodiesA: Array<{ chat?: { worldInfo?: { state?: string; items?: readonly { selected?: boolean }[] } } }> = [];
    for (const [page, responses] of [
      [pageA, responsesA],
      [pageB, responsesB],
    ] as const) {
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith("/api/tavern/v1/")) {
          responses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
        }
        if (page === pageA && response.request().method() === "GET" && url.pathname.endsWith("/state") && response.status() === 200) {
          void response
            .json()
            .then((body: { chat?: { worldInfo?: { state?: string; items?: readonly { selected?: boolean }[] } } }) => {
              stateBodiesA.push(body);
            });
        }
      });
    }

    // Page B shares the authenticated browser session but receives its own
    // later opaque state projection. It binds the real managed revision;
    // page A's older revision/source handles must then be rejected.
    await pageA.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(pageA.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();
    await pageB.goto(`${mounted.server.origin}/#profile=management`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await expect(pageB.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();
    assert.equal(responsesB.some(({ method, path }) => method === "POST" && path.endsWith("/bootstrap")), false);

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

    // The stale page's old unselected UI must be replaced by the durable
    // selection from page B; no optimistic binding result is used locally.
    // Catalog titles are not browser identities and may legitimately have
    // multiple immutable revisions, so do not infer selectedness from an
    // absent same-title Bind button. Assert both the public selected control
    // and the authority response's exact selected cardinality instead.
    await expect(pageA.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
    await expect
      .poll(() =>
        stateBodiesA.some(
          (body) =>
            body.chat?.worldInfo?.state === "selected" &&
            body.chat.worldInfo.items?.filter((item) => item.selected === true).length === 1,
        ),
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
