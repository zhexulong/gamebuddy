import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, test } from "@playwright/test";

/**
 * Contract-level live-listener browser spec for the reference-pipeline
 * surface (design/75 Task 4). It deliberately uses NO `page.route` mocks:
 * the browser talks to the real shipped Host artifact modules composed on a
 * real loopback listener. The read/reload case uses narrow Host-typed stubs;
 * the submit case uses a real mounted lease and production service, with an
 * injected start gate that intentionally stops before provider terminalization.
 */

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
  ]);
}

async function startMountedReferenceComposition() {
  if (process.platform !== "win32") throw new Error("reference_browser_mount_requires_windows");
  const pointer = JSON.parse(await readFile(resolve(hostRoot, "dist", "current.json"), "utf8"));
  const artifactRoot = resolve(hostRoot, "dist", "generations", pointer.generation);
  const [chatFacade, deployment, contract, serviceModule, stateModule, eventStreamModule, composition, inspectorModule, reclaimerModule, pathLock] =
    await loadGenerationModules(artifactRoot);
  const root = resolve(tmpdir(), `gamebuddy-reference-browser-${process.pid}-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = resolve(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: root,
    principal,
    bootstrapOperationId: "browser_reference_01",
    authorityGeneration: 1,
  }));
  await pathLock.bindWindowsStaleLockReclaimer(await reclaimerModule.createPublishedWindowsStaleLockReclaimer(artifactRoot));
  const manifest = await deployment.loadHostDeploymentManifest(manifestPath);
  const facade = await chatFacade.createFreshUnmountedChatSemanticFacade(manifest);
  const lease = await facade.startMountedChatRuntime();
  const profile = contract.composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status", "events"],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
  const eventStream = eventStreamModule.createChatEventStream();
  const referenceStateFacade = await stateModule.createReferencePipelineStateFacade(manifest, lease, profile, eventStream);
  let starts = 0;
  const pipelineService = serviceModule.createChatPipelineService({
    manifest,
    lease,
    profile,
    eventStream,
    deps: Object.freeze({ start: Object.freeze({ start: async () => { starts += 1; } }) }),
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
    get starts() { return starts; },
    async close() {
      await server.close();
      await pipelineService.close();
      await lease.close();
      await facade.close();
      void rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined);
    },
  };
}

async function startShippedReferenceComposition() {
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
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status", "events"],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
  const referenceState = Object.freeze({
    selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
    companionDisplayName: "Mira",
    title: "Reference Chat",
    transcript: Object.freeze([
      Object.freeze({ handle, role: "player", text: "A synthetic durable message.", locale: "und", order: 0, revision: 1 }),
    ]),
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
    async readSubmissionStatus() {
      throw new Error("reference_submit_not_wired_in_contract_slice");
    },
    async close() {},
  });
  const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
  return await startReferencePipelineStaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    referenceStateFacade,
    pipelineService,
    eventStream,
    profile,
    bootstrapToken: token,
  });
}

test("reference browser mounts the reference surface with live SSE and cookie reload", async () => {
  const server = await startShippedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const apiPaths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiPaths.push(url.pathname);
    });

    await page.goto(server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Reference Chat" })).toBeVisible();
    const urlAfterBoot = new URL(page.url());
    assert.equal(urlAfterBoot.search, "");
    assert.equal(urlAfterBoot.hash, "#profile=reference");


    await expect(page.getByText("Mira", { exact: true })).toBeVisible();
    await expect(page.getByText("A synthetic durable message.", { exact: true })).toBeVisible();
    await expect(page.getByText("Sentinel draft", { exact: true })).toBeVisible();
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(0);
    await expect(page.locator("[data-testid=memory]")).toHaveCount(0);

    await expect.poll(() => apiPaths.filter((path) => path === "/api/tavern/v1/events").length).toBeGreaterThan(0);
    assert.equal(apiPaths.includes("/api/tavern/v1/messages"), false);
    assert.equal(apiPaths.includes("/api/tavern/v1/message-submission-status"), false);
    assert.equal(apiPaths.filter((path) => path === "/api/tavern/v1/bootstrap").length, 1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Reference Chat" })).toBeVisible();
    assert.equal(apiPaths.filter((path) => path === "/api/tavern/v1/bootstrap").length, 1);
    assert.ok(apiPaths.filter((path) => path === "/api/tavern/v1/state").length >= 1);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("reference browser submits through the real mounted listener and receives live SSE before reconnect replay", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(45_000);
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.addInitScript(() => {
      const eventTypes = ["message.committed", "draft.changed", "turn.state_changed", "memory.changed", "stream.resync_required"];
      (window as unknown as { __gamebuddySseEvents: number }).__gamebuddySseEvents = 0;
      const NativeEventSource = window.EventSource;
      const WrappedEventSource = function (this: EventSource, url: string | URL, init?: EventSourceInit) {
        const source = new NativeEventSource(url, init);
        for (const eventType of eventTypes) source.addEventListener(eventType, () => {
          const state = window as unknown as { __gamebuddySseEvents: number };
          state.__gamebuddySseEvents += 1;
        });
        return source;
      } as unknown as typeof EventSource;
      WrappedEventSource.prototype = NativeEventSource.prototype;
      window.EventSource = WrappedEventSource;
    });
    const apiPaths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiPaths.push(url.pathname);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await page.locator("textarea.composer-textarea").fill("A durable browser request");
    await expect(page.locator(".message-list").getByText("A durable browser request", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(1);
    await expect.poll(
      () => apiPaths.filter((path) => path === "/api/tavern/v1/message-submission-status").length,
      { timeout: 10_000 },
    ).toBeGreaterThan(0);
    // The message may appear only after the durable state read-back. It must
    // not exist before the click or be appended by the browser on 202.
    await expect(page.locator(".message-list").getByText("A durable browser request", { exact: true })).toHaveCount(1);
    await expect(page.locator("textarea.composer-textarea")).toBeDisabled();
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __gamebuddySseEvents: number }).__gamebuddySseEvents),
      { timeout: 10_000 },
    ).toBeGreaterThan(0);
    expect(apiPaths).toContain("/api/tavern/v1/messages");
    expect(apiPaths).toContain("/api/tavern/v1/events");
    const firstEventCount = await page.evaluate(() => (window as unknown as { __gamebuddySseEvents: number }).__gamebuddySseEvents);
    const firstStateCount = apiPaths.filter((path) => path === "/api/tavern/v1/state").length;
    mounted.server.closeAllConnections();
    mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 2, present: false },
    });
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __gamebuddySseEvents: number }).__gamebuddySseEvents),
      { timeout: 15_000 },
    ).toBeGreaterThan(firstEventCount);
    await expect.poll(
      () => apiPaths.filter((path) => path === "/api/tavern/v1/state").length,
      { timeout: 10_000 },
    ).toBeGreaterThan(firstStateCount);
  } finally {
    await browser.close();
    await mounted.close();
  }
});
