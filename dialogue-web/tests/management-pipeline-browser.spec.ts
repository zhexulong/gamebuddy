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
    load("tavern/browser-contract/index.js"),
    load("tavern/chat-management/chat-management-service.js"),
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
  const [chatFacade, deployment, contract, serviceModule, stateModule, composition, inspectorModule, reclaimerModule, pathLock] =
    await loadGenerationModules(artifactRoot);
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
    routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename"],
    operationIds: ["draft.save", "draft.discard", "chat.rename"],
    navigationItemIds: ["chat"],
  });
  const managementStateFacade = await stateModule.createTavernManagementStateFacade(manifest, lease, profile);
  const managementService = serviceModule.createChatManagementService({ manifest, lease, profile });
  const inspector = await inspectorModule.createPublishedWindowsReparseInspector(artifactRoot);
  const server = await composition.startTavernManagementStaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    managementStateFacade,
    managementService,
    profile,
    bootstrapToken,
  });
  return {
    server,
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
    assert.equal(apiRequests.filter(({ method, path }) => method === "POST" && path.endsWith("/bootstrap")).length, 1);
    assert.ok(apiRequests.some(({ method, path }) => method === "GET" && path.endsWith("/chats")));
    assert.equal(apiRequests.filter(({ method, path }) => method === "GET" && path.endsWith("/draft")).length, 3);
    assert.equal(apiRequests.filter(({ method, path }) => method === "PUT" && path.endsWith("/draft")).length, 1);
    assert.equal(apiRequests.filter(({ method, path }) => method === "DELETE" && path.endsWith("/draft")).length, 1);
    assert.ok(apiRequests.some(({ method, path }) => method === "PUT" && path.endsWith("/chat/title")));
    assert.equal(apiRequests.some(({ path }) => path.endsWith("/messages")), false);
    assert.equal(apiRequests.some(({ path }) => path.endsWith("/events")), false);
  } finally {
    await browser.close();
    await mounted.close();
  }
});
