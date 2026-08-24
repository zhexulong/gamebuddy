import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, test, type Page } from "@playwright/test";

/**
 * Contract-level live-listener browser spec for the reference-pipeline
 * surface (design/75 Task 4). It deliberately uses NO `page.route` mocks:
 * the browser talks to the real shipped Host artifact modules composed on a
 * real loopback listener. The read/reload case uses narrow Host-typed stubs;
 * the submit case uses a real mounted lease and production service, with an
 * injected start gate that intentionally stops before provider terminalization.
 * The mounted submit case additionally captures real EventSource reconnect
 * evidence: SSE event ids/sequences from actual messages, /events request
 * URLs and headers, and loss-free same-epoch replay of the one event
 * published while the TCP stream is down.
 */

const dialogueRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(dialogueRoot, "..");
const hostRoot = resolve(repositoryRoot, "host");
const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";

/** Field-level shapes captured by the page-side SSE evidence wrapper. */
type SseLogEntry = Readonly<{
  kind: "source" | "message" | "error";
  sourceId: number;
  url?: string;
  eventType?: string;
  lastEventId?: string | null;
  epoch?: string | null;
  sequence?: number | null;
  idConsistent?: boolean;
  readyState?: number;
}>;

/** A fully populated SSE message entry (id and data payload cross-checked). */
type SseMessageEntry = Readonly<{
  kind: "message";
  sourceId: number;
  eventType: string;
  lastEventId: string;
  epoch: string;
  sequence: number;
  idConsistent: boolean;
}>;

async function readSseLog(page: Page): Promise<SseLogEntry[]> {
  return await page.evaluate(
    () => (window as unknown as { __gamebuddySseLog: SseLogEntry[] }).__gamebuddySseLog,
  );
}

function messageEntries(log: readonly SseLogEntry[]): SseMessageEntry[] {
  return log.filter(
    (entry): entry is SseMessageEntry =>
      entry.kind === "message" &&
      typeof entry.eventType === "string" &&
      typeof entry.lastEventId === "string" &&
      typeof entry.epoch === "string" &&
      typeof entry.sequence === "number" &&
      typeof entry.idConsistent === "boolean",
  );
}

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
  ]);
}

async function startMountedReferenceComposition(eventWindowSize = 64) {
  if (process.platform !== "win32") throw new Error("reference_browser_mount_requires_windows");
  const pointer = JSON.parse(await readFile(resolve(hostRoot, "dist", "current.json"), "utf8"));
  const artifactRoot = resolve(hostRoot, "dist", "generations", pointer.generation);
  const [chatFacade, deployment, contract, serviceModule, stateModule, eventStreamModule, composition, inspectorModule, reclaimerModule, pathLock, coordinator] =
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
    async armCurrentTurn() {
      if (activeTurn !== undefined) throw new Error("reference_browser_turn_already_armed");
      let armed!: () => void;
      let settle!: (outcome: "release" | "fail") => void;
      const armedTurn = new Promise<void>((resolve) => { armed = resolve; });
      const terminalSignal = new Promise<"release" | "fail">((resolve) => { settle = resolve; });
      activeTurn = coordinator.startMountedP4Attempt(manifest, lease, (invocation: unknown) =>
        coordinator.consumeMountedP4AttemptInvocationAdmission(invocation, async (scope: {
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
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
    operationIds: ["chat.submit", "chat.cancel"],
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
    async cancel() {
      throw new Error("reference_cancel_not_wired_in_contract_slice");
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

test("reference browser stops an armed response, reloads its durable cancellation, and sends again", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(60_000);
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const requestPaths: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/tavern/v1/")) requestPaths.push(path);
    });

    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await page.locator("textarea.composer-textarea").fill("Please begin a cancellable reply");
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(1);
    await mounted.armCurrentTurn();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    // The test harness owns the synthetic active prompt; release it after the
    // durable Stop winner has been selected so runtime teardown can drain.
    await mounted.settleArmedTurn("release");
    await expect(page.getByRole("status")).toContainText("Reply stopped. You can send another message.");
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await expect.poll(() => requestPaths.filter((path) => /\/turns\/[^/]+\/cancel$/u.test(path)).length).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toContainText("Reply stopped. You can send another message.");
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await page.locator("textarea.composer-textarea").fill("A second message after Stop");
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(2);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("reference browser renders provider failure from durable state and enables retry", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(60_000);
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await page.locator("textarea.composer-textarea").fill("Please fail deterministically");
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(1);
    await mounted.armCurrentTurn();
    await mounted.settleArmedTurn("fail");

    await expect(page.getByRole("status")).toContainText("The reply failed. You can try again.");
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toContainText("The reply failed. You can try again.");
    await page.locator("textarea.composer-textarea").fill("A second message after failure");
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(2);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("reference browser replays a same-epoch frame loss-free at the default window after a mounted TCP close", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(60_000);
  // Default replay window: the single frame published while the TCP stream is
  // down stays inside the bounded window, so the same-epoch reconnect must
  // replay it loss-free instead of forcing a resync-driven /state recovery.
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await installSseEvidence(page);
    const apiPaths: string[] = [];
    let appEventsStreamSeen = false;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiPaths.push(url.pathname);
    });
    // A 200 response head for the app-managed events stream is written only
    // after the server has registered the live subscription, so a publish made
    // afterwards is guaranteed to be delivered live (never only buffered).
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/api/tavern/v1/events" && url.searchParams.has("cursor") && response.status() === 200) {
        appEventsStreamSeen = true;
      }
    });

    // The submit journey through the real mounted listener: the message must
    // not exist before the click or be appended by the browser on 202; it may
    // appear only after the durable state read-back.
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await expect.poll(() => appEventsStreamSeen, { timeout: 10_000 }).toBe(true);
    await page.locator("textarea.composer-textarea").fill("A loss-free browser request");
    await expect(page.locator(".message-list").getByText("A loss-free browser request", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(1);
    await expect(page.locator(".message-list").getByText("A loss-free browser request", { exact: true })).toHaveCount(1);
    await expect(page.locator("textarea.composer-textarea")).toBeDisabled();
    await expect.poll(() => readSseLog(page).then((log) => messageEntries(log).length), { timeout: 10_000 }).toBeGreaterThan(0);

    const messagesBefore = messageEntries(await readSseLog(page));
    const oldCursor = messagesBefore[messagesBefore.length - 1]?.lastEventId;
    assert.ok(oldCursor);
    assert.equal(mounted.eventStream.decodeCursor(oldCursor)?.epoch, mounted.eventStream.epoch);
    const stateReads = apiPaths.filter((path) => path === "/api/tavern/v1/state").length;
    const initialSources = (await readSseLog(page)).filter((entry) => entry.kind === "source");
    assert.equal(initialSources.length, 1);

    // Publish one frame while the TCP stream is down, inside the default
    // replay window; the epoch is preserved end to end.
    mounted.server.closeAllConnections();
    const whileDown = mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 2, present: false },
    });
    assert.equal(whileDown.epoch, mounted.eventStream.epoch);

    // The same-epoch reconnect replays the single missed frame loss-free on a
    // fresh source (no resync marker) and re-reads authoritative state.
    await expect.poll(
      () => readSseLog(page).then((log) => log.filter((entry) => entry.kind === "message" && entry.sequence === whileDown.sequence).length),
      { timeout: 15_000 },
    ).toBe(1);
    await expect.poll(
      () => readSseLog(page).then((log) => log.filter((entry) => entry.kind === "source").length),
      { timeout: 10_000 },
    ).toBe(2);
    await expect.poll(
      () => apiPaths.filter((path) => path === "/api/tavern/v1/state").length,
      { timeout: 10_000 },
    ).toBeGreaterThan(stateReads);

    const logAfterReplay = await readSseLog(page);
    const replayed = messageEntries(logAfterReplay).find((entry) => entry.sequence === whileDown.sequence);
    assert.ok(replayed);
    assert.equal(replayed.sourceId, 2);
    assert.equal(
      replayed.lastEventId,
      mounted.eventStream.encodeCursor({ epoch: mounted.eventStream.epoch, sequence: whileDown.sequence }),
    );
    assert.equal(replayed.idConsistent, true);

    // Loss-free means the cursor was never invalidated: the reconnect reuses
    // the last-received cursor on the same epoch, and the stream never emitted
    // a resync marker.
    const sourcesAfter = logAfterReplay.filter((entry) => entry.kind === "source");
    const recoveredUrl = sourcesAfter[sourcesAfter.length - 1]?.url;
    assert.ok(recoveredUrl);
    const recoveredCursor = new URL(recoveredUrl, mounted.server.launchUrl).searchParams.get("cursor");
    assert.ok(recoveredCursor);
    assert.equal(recoveredCursor, oldCursor);
    assert.equal(mounted.eventStream.decodeCursor(recoveredCursor)?.epoch, mounted.eventStream.epoch);
    assert.equal(logAfterReplay.filter((entry) => entry.kind === "message" && entry.eventType === "stream.resync_required").length, 0);

    // Stability: exactly one replayed frame, exactly one reconnect, no resync
    // loop and no additional source churn.
    await new Promise<void>((resolveStable) => setTimeout(resolveStable, 2_500));
    const logAfterStable = await readSseLog(page);
    assert.equal(logAfterStable.filter((entry) => entry.kind === "source").length, 2);
    assert.equal(logAfterStable.filter((entry) => entry.kind === "message" && entry.sequence === whileDown.sequence).length, 1);
    assert.equal(logAfterStable.filter((entry) => entry.kind === "message" && entry.eventType === "stream.resync_required").length, 0);

    // The recovered stream is live: a later event reaches the same source.
    const liveAfter = mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 3, present: true },
    });
    await expect.poll(
      () => readSseLog(page).then((log) => log.filter((entry) => entry.kind === "message" && entry.sequence === liveAfter.sequence && entry.sourceId === 2).length),
      { timeout: 15_000 },
    ).toBe(1);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("reference browser recovers from a mounted SSE replay gap through authoritative state", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(45_000);
  const mounted = await startMountedReferenceComposition(1);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await installSseEvidence(page);
    const apiPaths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiPaths.push(url.pathname);
    });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await page.locator("textarea.composer-textarea").fill("A durable browser request");
    await page.getByRole("button", { name: /send/i }).click();
    await expect.poll(() => mounted.starts, { timeout: 10_000 }).toBe(1);
    await expect(page.locator(".message-list").getByText("A durable browser request", { exact: true })).toHaveCount(1);
    await expect.poll(() => readSseLog(page).then((log) => messageEntries(log).length), { timeout: 10_000 }).toBeGreaterThan(0);

    const before = messageEntries(await readSseLog(page));
    const stateReads = apiPaths.filter((path) => path === "/api/tavern/v1/state").length;
    const sources = (await readSseLog(page)).filter((entry) => entry.kind === "source").length;
    const oldCursor = before[before.length - 1]?.lastEventId;
    assert.ok(oldCursor);

    mounted.server.closeAllConnections();
    mounted.eventStream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 2, present: false } });
    // The replay window of one retains only the newest frame, so the reconnect
    // sees a genuine on-wire gap that authoritative state alone can repair.
    const laterStale = mounted.eventStream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 3, present: true } });

    await expect.poll(
      () => readSseLog(page).then((log) => log.filter((entry) => entry.kind === "message" && entry.eventType === "stream.resync_required").length),
      { timeout: 15_000 },
    ).toBe(1);
    await expect.poll(
      () => apiPaths.filter((path) => path === "/api/tavern/v1/state").length,
      { timeout: 10_000 },
    ).toBeGreaterThan(stateReads);
    // Latch on the resync-driven recovery source/cursor. The transport
    // reconnect that precedes it reuses the last-received cursor, so waiting on
    // the raw source count alone races that first reconnect and can pick the
    // old-cursor URL as the "latest" source.
    await expect.poll(
      () => readSseLog(page).then((log) => {
        const latest = log.filter((entry) => entry.kind === "source");
        const url = latest[latest.length - 1]?.url;
        if (url === undefined) return false;
        const cursor = new URL(url, mounted.server.launchUrl).searchParams.get("cursor");
        return cursor !== null && cursor !== oldCursor;
      }),
      { timeout: 15_000 },
    ).toBe(true);

    const logAfterRecovery = await readSseLog(page);
    const recoveredSources = logAfterRecovery.filter((entry) => entry.kind === "source");
    const reconnectUrl = recoveredSources[recoveredSources.length - 1]?.url;
    assert.ok(reconnectUrl);
    const recoveredCursor = new URL(reconnectUrl, mounted.server.launchUrl).searchParams.get("cursor");
    assert.ok(recoveredCursor);
    assert.notEqual(recoveredCursor, oldCursor);
    // The recovery cursor is the authoritative stream position minted by the
    // gap resync marker (last stale frame plus the resync advance), same epoch.
    assert.equal(
      recoveredCursor,
      mounted.eventStream.encodeCursor({ epoch: mounted.eventStream.epoch, sequence: laterStale.sequence + 1 }),
    );
    assert.equal(mounted.eventStream.decodeCursor(recoveredCursor)?.epoch, mounted.eventStream.epoch);
    assert.ok(recoveredSources.length > sources);

    const later = mounted.eventStream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 4, present: false } });
    await expect.poll(
      () => readSseLog(page).then((log) => log.filter((entry) => entry.kind === "message" && entry.eventType === "draft.changed" && entry.sequence === later.sequence).length),
      { timeout: 15_000 },
    ).toBe(1);

    const events = messageEntries(await readSseLog(page));
    assert.equal(events.filter((entry) => entry.eventType === "stream.resync_required").length, 1);
    assert.equal(events.filter((entry) => entry.sequence === later.sequence).length, 1);
    assert.equal(new Set(events.map((entry) => `${entry.eventType}:${entry.sequence}`)).size, events.length);
  } finally {
    await browser.close();
    await mounted.close();
  }
});

/**
 * Page-side evidence capture installed before any application script runs:
 * - the app-managed EventSource is wrapped so every app stream and frame is
 *   attributed to the `window.__gamebuddySseLog` evidence log (source URL,
 *   event type, SSE `id`, payload epoch/sequence and id consistency);
 * - the untouched native EventSource constructor is stashed separately so a
 *   passive probe can be created without ever entering the app-managed log.
 */
async function installSseEvidence(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const types = ["message.committed", "draft.changed", "turn.state_changed", "memory.changed", "stream.resync_required"];
    const state = window as unknown as {
      __gamebuddySseLog: SseLogEntry[];
      __gamebuddyProbeEventSource: typeof EventSource;
      __gamebuddyProbe: { url: string; ids: string[]; errors: number; readyState: number; source: EventSource | null };
    };
    state.__gamebuddySseLog = [];
    state.__gamebuddyProbe = { url: "", ids: [], errors: 0, readyState: -1, source: null };
    let nextSourceId = 0;
    const Native = window.EventSource;
    // Passive probe handle: the untouched native constructor, kept outside the
    // wrapper below so probe traffic never pollutes the app-managed log.
    state.__gamebuddyProbeEventSource = Native;
    const encodeEventId = (epoch: string, sequence: number): string =>
      btoa(JSON.stringify([epoch, sequence])).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
    const Wrapped = function (this: EventSource, url: string | URL, init?: EventSourceInit) {
      const sourceId = ++nextSourceId;
      const source = new Native(url, init);
      state.__gamebuddySseLog.push({ kind: "source", sourceId, url: String(url) });
      for (const type of types) {
        source.addEventListener(type, (raw) => {
          const message = raw as MessageEvent<string>;
          let payload: { epoch?: unknown; sequence?: unknown } = {};
          try {
            payload = JSON.parse(message.data) as { epoch?: unknown; sequence?: unknown };
          } catch {
            return;
          }
          const epoch = typeof payload.epoch === "string" ? payload.epoch : null;
          const sequence = typeof payload.sequence === "number" ? payload.sequence : null;
          const expectedId = epoch !== null && sequence !== null ? encodeEventId(epoch, sequence) : null;
          state.__gamebuddySseLog.push({
            kind: "message",
            sourceId,
            eventType: type,
            lastEventId: message.lastEventId,
            epoch,
            sequence,
            idConsistent: expectedId !== null && message.lastEventId === expectedId,
          });
        });
      }
      // addEventListener keeps this logger independent of the application's own
      // onerror assignment in the API client (the wrapper must observe errors
      // even when the app replaces `source.onerror`).
      source.addEventListener("error", () => {
        state.__gamebuddySseLog.push({ kind: "error", sourceId, readyState: source.readyState });
      });
      return source;
    } as unknown as typeof EventSource;
    Wrapped.prototype = Native.prototype;
    window.EventSource = Wrapped;
  });
}

test("reference browser performs exactly one authoritative /state recovery for a stale selectionGeneration event and reconnects on the state cursor", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(60_000);
  const mounted = await startMountedReferenceComposition(1);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await installSseEvidence(page);
    const apiPaths: string[] = [];
    let appEventsStreamSeen = false;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/tavern/v1/")) apiPaths.push(url.pathname);
    });
    // A 200 response head for the app-managed events stream is written only
    // after the server has registered the live subscription, so a publish made
    // afterwards is guaranteed to be delivered live (never only buffered).
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/api/tavern/v1/events" && url.searchParams.has("cursor") && response.status() === 200) {
        appEventsStreamSeen = true;
      }
    });

    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
    await expect.poll(() => appEventsStreamSeen, { timeout: 10_000 }).toBe(true);
    const initialSources = await readSseLog(page);
    assert.equal(initialSources.filter((entry) => entry.kind === "source").length, 1);
    const initialUrl = initialSources.find((entry) => entry.kind === "source")?.url;
    assert.ok(initialUrl);
    const initialCursor = new URL(initialUrl, mounted.server.launchUrl).searchParams.get("cursor");
    assert.ok(initialCursor);
    assert.equal(mounted.eventStream.decodeCursor(initialCursor)?.epoch, mounted.eventStream.epoch);

    // Baseline: bootstrap returns the snapshot directly and the app reads only
    // the draft afterwards, so no /state request has happened yet.
    const stateReads = apiPaths.filter((path) => path === "/api/tavern/v1/state").length;
    const draftReads = apiPaths.filter((path) => path === "/api/tavern/v1/draft").length;

    // Legal publish of one schema-valid stale-generation event through the
    // mounted composition's own event stream; no production path is bypassed.
    const stale = mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 2,
      payload: { revision: 2, present: false },
    });
    assert.equal(stale.selectionGeneration, 2);
    assert.equal(stale.epoch, mounted.eventStream.epoch);

    // The app reducer rejects the stale-generation event and recovers exactly
    // once: one authoritative /state read plus one /draft read, and one new
    // app-managed EventSource connection.
    await expect.poll(() => apiPaths.filter((path) => path === "/api/tavern/v1/state").length, { timeout: 15_000 }).toBe(stateReads + 1);
    await expect.poll(() => apiPaths.filter((path) => path === "/api/tavern/v1/draft").length, { timeout: 15_000 }).toBe(draftReads + 1);
    await expect.poll(() => readSseLog(page).then((log) => log.filter((entry) => entry.kind === "source").length), { timeout: 15_000 }).toBe(2);

    // Stability window: the recovery must not loop (no second roll of /state).
    await new Promise<void>((resolveStable) => setTimeout(resolveStable, 2_500));
    assert.equal(apiPaths.filter((path) => path === "/api/tavern/v1/state").length, stateReads + 1);
    assert.equal(apiPaths.filter((path) => path === "/api/tavern/v1/draft").length, draftReads + 1);
    const logAfterStable = await readSseLog(page);
    assert.equal(logAfterStable.filter((entry) => entry.kind === "source").length, 2);

    // The reconnect uses the authoritative state cursor: same epoch, sequence
    // advanced past the stale event, and visibly different from the initial one.
    const reconnectUrl = logAfterStable.find((entry) => entry.kind === "source" && entry.sourceId === 2)?.url;
    assert.ok(reconnectUrl);
    const recoveredCursor = new URL(reconnectUrl, mounted.server.launchUrl).searchParams.get("cursor");
    assert.ok(recoveredCursor);
    assert.notEqual(recoveredCursor, initialCursor);
    assert.equal(
      recoveredCursor,
      mounted.eventStream.encodeCursor({ epoch: mounted.eventStream.epoch, sequence: stale.sequence }),
    );

    // The stale frame was delivered on the first source with an id-consistent
    // wire envelope; every captured frame carries an internally consistent id.
    const messages = messageEntries(await readSseLog(page));
    assert.equal(
      messages.some((entry) => entry.sequence === stale.sequence && entry.eventType === "draft.changed"),
      true,
    );
    assert.equal(messages.every((entry) => entry.idConsistent), true);

    // A subsequent same-generation event reaches the app on the recovered
    // source without a problem view, proving the recovered cursor is live.
    const valid = mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 3, present: true },
    });
    await expect.poll(
      () => page.evaluate(
        (sequence) => (window as unknown as { __gamebuddySseLog: Array<{ kind: string; sequence?: number | null }> }).__gamebuddySseLog.filter((entry) => entry.kind === "message" && entry.sequence === sequence).length,
        valid.sequence,
      ),
      { timeout: 15_000 },
    ).toBe(1);
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("reference browser passive native EventSource probe carries Last-Event-ID on Chromium retry across server close", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(60_000);
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await installSseEvidence(page);
    // Capture every /events request with its full wire headers in arrival
    // order; header promises resolve deterministically by array position.
    const eventsRequests: Array<{ url: URL; headers: Promise<Record<string, string>> }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname !== "/api/tavern/v1/events") return;
      eventsRequests.push({ url, headers: request.allHeaders() });
    });

    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea.composer-textarea")).toBeEnabled();

    // Open the passive probe through the untouched native constructor. Its
    // source is left open on purpose: it must survive the server close below.
    const probeUrl = await page.evaluate(() => {
      const state = window as unknown as {
        __gamebuddyProbeEventSource: typeof EventSource;
        __gamebuddyProbe: { url: string; ids: string[]; errors: number; readyState: number; source: EventSource | null };
      };
      const url = new URL("/api/tavern/v1/events", window.location.href);
      url.searchParams.set("apiVersion", "1");
      const probe = state.__gamebuddyProbe;
      probe.url = url.toString();
      const source = new state.__gamebuddyProbeEventSource(probe.url, { withCredentials: true });
      probe.source = source;
      probe.readyState = source.readyState;
      for (const type of ["message.committed", "draft.changed", "turn.state_changed", "memory.changed", "stream.resync_required"]) {
        source.addEventListener(type, (raw) => {
          probe.ids.push((raw as MessageEvent<string>).lastEventId);
        });
      }
      source.addEventListener("error", () => {
        probe.errors += 1;
      });
      return probe.url;
    });

    // Isolation: the probe was never constructed through the app-managed
    // wrapper, so no app-managed source entry may claim the probe URL and
    // every app-managed source keeps its state cursor.
    const appSources = (await readSseLog(page)).filter((entry) => entry.kind === "source");
    assert.ok(appSources.length >= 1);
    assert.equal(appSources.some((entry) => entry.url === probeUrl), false);
    for (const entry of appSources) {
      assert.ok(entry.url !== undefined && new URL(entry.url, mounted.server.launchUrl).searchParams.has("cursor"));
    }

    // Publish one live event so the probe records its first received id.
    const first = mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 2, present: false },
    });
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __gamebuddyProbe: { ids: string[] } }).__gamebuddyProbe.ids.length),
      { timeout: 10_000 },
    ).toBeGreaterThan(0);
    const receivedId = await page.evaluate(() => (window as unknown as { __gamebuddyProbe: { ids: string[] } }).__gamebuddyProbe.ids[0] ?? "");
    const expectedFirstId = mounted.eventStream.encodeCursor({ epoch: mounted.eventStream.epoch, sequence: first.sequence });
    assert.equal(receivedId, expectedFirstId);

    const probeRequestsBefore = eventsRequests.filter((entry) => !entry.url.searchParams.has("cursor"));
    assert.equal(probeRequestsBefore.length, 1);
    const initialProbeHeaders = await probeRequestsBefore[0].headers;
    // The first probe request carries no Last-Event-ID; the header may only
    // appear once Chromium retries after an id was received.
    assert.ok(!Object.prototype.hasOwnProperty.call(initialProbeHeaders, "last-event-id"));

    // The probe source is open when the server closes the TCP connections;
    // the native EventSource must retry on its own.
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __gamebuddyProbe: { source: EventSource | null } }).__gamebuddyProbe.source?.readyState ?? -1),
      { timeout: 10_000 },
    ).toBe(1);
    mounted.server.closeAllConnections();

    await expect.poll(
      () => eventsRequests.filter((entry) => !entry.url.searchParams.has("cursor")).length,
      { timeout: 15_000 },
    ).toBeGreaterThan(probeRequestsBefore.length);
    const probeRequestsAfter = eventsRequests.filter((entry) => !entry.url.searchParams.has("cursor"));
    const retriedProbe = probeRequestsAfter[probeRequestsAfter.length - 1];
    const retriedHeaders = await retriedProbe.headers;
    // Chromium's native retry carries Last-Event-ID equal to the last id the
    // probe received before the close, on the probe's own cursor-less URL.
    assert.equal(retriedHeaders["last-event-id"], receivedId);
    assert.equal(retriedProbe.url.searchParams.has("cursor"), false);

    // The retried stream is live: a later event reaches the probe with its id.
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __gamebuddyProbe: { source: EventSource | null } }).__gamebuddyProbe.source?.readyState ?? -1),
      { timeout: 10_000 },
    ).toBe(1);
    const second = mounted.eventStream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 3, present: true },
    });
    const expectedSecondId = mounted.eventStream.encodeCursor({ epoch: mounted.eventStream.epoch, sequence: second.sequence });
    await expect.poll(
      () => page.evaluate((id) => (window as unknown as { __gamebuddyProbe: { ids: string[] } }).__gamebuddyProbe.ids.includes(id), expectedSecondId),
      { timeout: 10_000 },
    ).toBe(true);

    // The app-managed source entries remain isolated from the probe traffic.
    const appSourcesAfter = (await readSseLog(page)).filter((entry) => entry.kind === "source");
    assert.equal(appSourcesAfter.some((entry) => entry.url === probeUrl), false);
  } finally {
    await browser.close();
    await mounted.close();
  }
});
