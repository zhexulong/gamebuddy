import { expect, test, type Page } from "./frontend-coverage";

/**
 * A Game operation's authoritative reread is not the conversation's turn to settle.
 *
 * `GameSurface.rereadGame` is the read every Game lifecycle handler takes after it acts. It ended by
 * spending the conversation's streaming preview unconditionally, so any Game operation performed
 * while a reply streamed - the resume below is the shortest one that keeps rereading - erased the
 * text the player was watching until the stream's next delta rebuilt it from that delta alone. On a
 * turn whose first token takes seconds, that is the whole reply.
 *
 * The preview belongs to the turn it was built from, and the Chat channel owns it: `companion.delta`
 * appends to it, a committed message or a turn transition spends it, and the shell's recovery read,
 * `reconcile` and `rereadChat`'s own settle rule spend it too - all of them gated on the mounted
 * conversation, never on the selected surface. So the rule this journey asserts is the one those
 * reads already follow: a read keeps a preview whose turn is still running, and spends it only when
 * the read publishes no running turn.
 *
 * Nothing here delivers a second delta. The preview can therefore only be the one the shell still
 * holds: `previewAfter=1` is the unfixed arrival read's own measurement, and `0` is this defect's.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * The Host behind the shell, as one mutable record the routes answer from. `turnState` is the whole
 * conversation as far as this journey is concerned: a running turn is what a preview can belong to.
 */
type HostState = Readonly<{
  connectionStatus: string;
  attachmentStatus: string;
  attachmentGeneration: number;
  instanceStatus: string;
  instanceGeneration: number;
  latestOutcome: string;
  turnState: string | null;
}>;

function composedRoot(state: HostState) {
  const connected = state.connectionStatus === "connected_idle" || state.connectionStatus === "active";
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle, generation: 1, stateRevision: chatHandle },
      chat: {
        companion: { name: "Mira", handle: companionHandle },
        title: null,
        transcript: [],
        draft: { revision: 4, present: true },
        turn:
          state.turnState === null
            ? null
            : { handle: turnHandle, state: state.turnState, projectionRevision: 1, canCancel: true },
        worldInfo: null,
      },
      memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
    },
    game: {
      apiVersion: 1,
      build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
      csrfToken,
      browserSession: { expiresAtMs },
      game: {
        prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
        instance: { status: state.instanceStatus, gameTitle: "Stardew Valley", generation: state.instanceGeneration },
        compatibility: { status: "compatible", message: null },
        attachment: { status: state.attachmentStatus, generation: state.attachmentGeneration },
        connectionStatus: state.connectionStatus,
        actionAuthority: connected ? "active" : "unavailable",
        role: connected ? "companion" : null,
        companionName: connected ? "Mira" : null,
        selectedWorld: "The Farm",
        selectedSave: "Save One",
        capabilitySummary: { available: true, count: 3 },
        latestOutcome: state.latestOutcome,
      },
    },
  };
}

/** The routes this journey reads, answered from one mutable record, counting the authoritative reads. */
async function stubHost(page: Page, state: HostState): Promise<{ stateReads: () => number }> {
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot(state))));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(composedRoot(state)));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  // A transport admission the authoritative read never confirms, so the resume keeps rereading
  // instead of converging out from under the assertion.
  await page.route("**/api/composed-reference-game/v1/game/resume", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "accepted" })),
  );
  return { stateReads: () => stateReads };
}

/**
 * A quiet `EventSource`: it records the handlers the product registers, never calls `onerror`, and
 * delivers only what this journey hands it - one `companion.delta`, and never a second.
 */
async function installQuietStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const handlers: Array<Map<string, Array<(raw: unknown) => void>>> = [];
    (window as unknown as { __handlers: typeof handlers }).__handlers = handlers;
    class QuietEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor() {
        this.__index = handlers.length;
        handlers.push(new Map());
      }
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = handlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = handlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {}
    }
    window.EventSource = QuietEventSource as unknown as typeof EventSource;
    (window as unknown as { __emit: (data: string, id: string) => void }).__emit = (data, id) => {
      for (const entry of handlers) {
        for (const handler of entry.get("companion.delta") ?? [])
          handler({ data, lastEventId: id, type: "companion.delta" });
      }
    };
  });
}

test("a Game operation's reread keeps a reply that is still streaming", async ({ page }) => {
  test.setTimeout(90_000);
  const state: HostState = {
    connectionStatus: "failed",
    attachmentStatus: "attached",
    attachmentGeneration: 3,
    instanceStatus: "running",
    instanceGeneration: 3,
    latestOutcome: "failed",
    turnState: "running",
  };
  await installQuietStream(page);
  const host = await stubHost(page, state);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  await expect
    .poll(async () => await page.evaluate(() => (window as unknown as { __handlers: unknown[] }).__handlers.length))
    .toBe(1);

  // The reply is streaming and the player is reading it.
  await page.evaluate(
    (data: string) =>
      (window as unknown as { __emit: (data: string, id: string) => void }).__emit(data, `${"H".repeat(42)}A`),
    JSON.stringify({
      apiVersion: 1,
      epoch: streamEpoch,
      sequence: 1,
      selectionGeneration: 1,
      eventType: "companion.delta",
      payload: { turnHandle, delta: "A streaming reply." },
    }),
  );
  const streaming = chatSurface.locator('[data-streaming="true"]');
  await expect(streaming).toHaveCount(1);
  await expect(chatSurface).toContainText("A streaming reply.");

  // A Game operation, taken while the reply streams. The panel's own arrival read is spent before the
  // press, so every read counted below belongs to the operation.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toContainText("ConnectionConnection failed");
  const readsBeforeResume = host.stateReads();
  await panel.getByTestId("game-resume").click();
  await expect(panel.locator('[role="status"][data-tone="progress"]')).toContainText("Resuming the game connection...");
  // The operation really reread: this is the read that used to spend the preview.
  await expect.poll(async () => host.stateReads()).toBeGreaterThan(readsBeforeResume);

  // Back on the conversation, the reply the player was watching is still there - the same text, in one
  // streaming row, with no second delta delivered to rebuild it.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(chatSurface).toBeVisible();
  await expect(streaming).toHaveCount(1);
  await expect(chatSurface).toContainText("A streaming reply.");
});
