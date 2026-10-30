import { expect, test, type Page } from "@playwright/test";

/**
 * Arriving at the Game surface shows the Host's Game projection as it is *now*, not as it was when
 * the player left.
 *
 * The measured defect (2026-10-31): the shell's arrival read was gated on the conversation alone
 * (`if (shownSurface !== CHAT_PANEL) return`), so the Game panel kept whatever the composed root
 * said the last time anything read it. A journey that started a session on the Host while the player
 * was reading the conversation came back to `Connection No game connection` / `Last result No
 * activity yet`, and paid one `/state` read for the whole trip - none of them on arrival.
 *
 * The fix re-reads the composed root on arrival at the Game surface too, and commits it. It is
 * deliberately NOT `GameSurface`'s own `rereadGame`: that is the authoritative path a Game
 * *operation* takes, and it ends by discarding the streaming preview. The discard is right for an
 * operation - it settles the turn the operation touched - and wrong for an arrival, which would then
 * erase a reply the player is watching on the conversation. Measured on the same journey: the full
 * `rereadGame` read left `previewAfterSwitch=0`, the read-and-commit left it at 1, exactly where the
 * unfixed shell left it. The second test is that invariant.
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
 * The Host behind the shell, as one mutable record the routes answer from, so a journey can move a
 * Game fact through the API while the player is on another surface - never through the UI, which is
 * the whole point: the surface the player is looking at cannot be what refreshes the one they are
 * not.
 */
type HostState = Readonly<{
  connectionStatus: string;
  attachmentStatus: string;
  attachmentGeneration: number;
  instanceStatus: string;
  instanceGeneration: number;
  latestOutcome: string;
  turnState: string | null;
  /**
   * Whether the projection publishes a live event stream. A journey that is not measuring the
   * stream leaves it null: the shell then opens no `EventSource` at all, so the numbers it reads on
   * `/state` are its own instead of a reconnect's.
   */
  stream: boolean;
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
      eventStream: state.stream ? { epoch: streamEpoch, cursor: streamCursor } : null,
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

/** The Host's routes, answered from one mutable record so a journey can move it mid-run. */
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
  return { stateReads: () => stateReads };
}

/**
 * A quiet `EventSource`: it records handlers so a journey can deliver one `companion.delta`, and it
 * never calls `onerror`, so nothing reconnects. A harness that storms measures the storm.
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

const openGame = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
};

const openChat = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
};

test("arriving at the Game surface shows the Host's current projection, not the one the player left", async ({
  page,
}) => {
  const state: HostState = {
    connectionStatus: "none",
    attachmentStatus: "none",
    attachmentGeneration: 0,
    instanceStatus: "none",
    instanceGeneration: 0,
    latestOutcome: "none",
    turnState: null,
    stream: false,
  };
  const host = await stubHost(page, state);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // Where the player starts: the Host has published no session at all.
  await openGame(page);
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toContainText("ConnectionNo game connection");
  await expect(panel).toContainText("Last resultNo activity yet");

  // The player goes back to the conversation, and the Host starts a session while they are there -
  // no Game control is touched, which is the case the always-mounted design could not see.
  await openChat(page);
  const readsBeforeReturn = host.stateReads();
  state.connectionStatus = "connected_idle";
  state.attachmentStatus = "attached";
  state.attachmentGeneration = 3;
  state.instanceStatus = "running";
  state.instanceGeneration = 3;
  state.latestOutcome = "succeeded";

  // Back on the Game surface, every fact the panel shows is the Host's current answer. Before the
  // arrival read these assertions were the reported defect: the panel still read `No game
  // connection` and `No activity yet`, and the journey had paid no `/state` read on the way back.
  await openGame(page);
  await expect(panel).toContainText("ConnectionConnected");
  await expect(panel).toContainText("Last resultCompleted successfully");
  await expect(panel).not.toContainText("ConnectionNo game connection");
  // One read per arrival, never a timer behind it: the arrival is exactly the one the journey paid.
  expect(host.stateReads()).toBe(readsBeforeReturn + 1);

  // And it is not a one-way door: leaving and coming back reads again, so a second move lands too.
  await openChat(page);
  const readsBeforeSecondReturn = host.stateReads();
  state.connectionStatus = "disconnected";
  state.latestOutcome = "failed";
  await openGame(page);
  await expect(panel).toContainText("ConnectionDisconnected");
  await expect(panel).toContainText("Last resultDid not complete");
  expect(host.stateReads()).toBe(readsBeforeSecondReturn + 1);
});

/**
 * The invariant the Game surface's always-mounted design protects, and the one that rules out
 * reusing `GameSurface`'s `rereadGame` for the arrival read: a reply still streaming into the
 * conversation is not the Game arrival's to erase.
 */
test("a Game arrival leaves a reply still streaming on the conversation untouched", async ({ page }) => {
  test.setTimeout(60_000);
  const state: HostState = {
    connectionStatus: "failed",
    attachmentStatus: "attached",
    attachmentGeneration: 3,
    instanceStatus: "running",
    instanceGeneration: 3,
    latestOutcome: "failed",
    turnState: "running",
    stream: true,
  };
  await installQuietStream(page);
  await stubHost(page, state);

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
  await expect(chatSurface).toContainText("A streaming reply.");
  const streaming = chatSurface.locator('[data-streaming="true"]');
  await expect(streaming).toHaveCount(1);

  // Look at the Game surface and come straight back. No Game operation runs, and no second delta
  // arrives, so the preview can only be what the shell still holds.
  await openGame(page);
  await expect(page.getByTestId("game-state-panel")).toContainText("ConnectionConnection failed");
  await openChat(page);
  await expect(streaming).toHaveCount(1);
  await expect(chatSurface).toContainText("A streaming reply.");
});

/**
 * The other half of that invariant, from the Game surface's own side: an attempt the player is
 * watching is not forgotten by a surface switch.
 *
 * It is asserted through the progress line the player reads, not through the preview: a running
 * resume performs its own bounded authoritative rereads, and those deliberately settle the turn the
 * operation touched - the same discard an operation has always performed, which the arrival read
 * neither adds to nor removes. What must survive the switch is the attempt itself, which is local to
 * the always-mounted surface.
 */
test("an in-flight Game resume survives a surface switch and stays beside the Host's projection", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state: HostState = {
    connectionStatus: "failed",
    attachmentStatus: "attached",
    attachmentGeneration: 3,
    instanceStatus: "running",
    instanceGeneration: 3,
    latestOutcome: "failed",
    turnState: null,
    stream: false,
  };
  await stubHost(page, state);
  // A transport admission the authoritative read never confirms, so the attempt stays in flight for
  // the whole journey instead of converging out from under the assertion.
  await page.route("**/api/composed-reference-game/v1/game/resume", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "accepted" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = page.getByTestId("game-state-panel");
  const progress = panel.locator('[role="status"][data-tone="progress"]');
  await panel.getByTestId("game-resume").click();
  await expect(progress).toContainText("Resuming the game connection...");

  // Away to the conversation and back. The attempt is still running when the player returns.
  await openChat(page);
  await openGame(page);
  await expect(progress).toContainText("Resuming the game connection...");
  // The attempt and the Host's current projection are on screen at once, which is what the arrival
  // read has to respect: the panel is re-read around the attempt, never instead of it.
  await expect(panel).toContainText("ConnectionConnection failed");
  await expect(panel).toContainText("Last resultDid not complete");
});

/**
 * A failed arrival read is a background refresh, not a load: the projection the shell already holds
 * was valid when the player switched, so it stays - and the surface says the read did not happen.
 *
 * Both halves matter. Dropping the projection would replace a conversation that is still the truth
 * with a problem page over a refresh nobody asked for; saying nothing would leave the panel reading
 * `Connected` after a read that never happened, which is the defect this whole change exists to fix,
 * pointed the other way.
 */
test("a failed Game arrival read keeps the projection on screen and says why", async ({ page }) => {
  const state: HostState = {
    connectionStatus: "connected_idle",
    attachmentStatus: "attached",
    attachmentGeneration: 3,
    instanceStatus: "running",
    instanceGeneration: 3,
    latestOutcome: "succeeded",
    turnState: null,
    stream: false,
  };
  let stateHealthy = true;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot(state))));
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    stateHealthy
      ? route.fulfill(jsonOk(composedRoot(state)))
      : route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ code: "state_unavailable" }),
        }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toContainText("ConnectionConnected");
  await expect(panel).toContainText("Last resultCompleted successfully");

  // The Host moves while the player is on the conversation, and the read that would carry the move
  // fails.
  await openChat(page);
  state.connectionStatus = "disconnected";
  state.latestOutcome = "failed";
  stateHealthy = false;

  await openGame(page);
  // The projection the shell held is still what the panel shows: the failed refresh did not make it
  // wrong, and the player's conversation is not replaced by a problem page.
  await expect(panel).toContainText("ConnectionConnected");
  await expect(panel).not.toContainText("ConnectionDisconnected");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // And the read that did not happen is stated, in the catalogue's own sentence.
  const notice = page.getByTestId("game-arrival-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("GameBuddy could not read or settle the game's own state just now.");

  // The next arrival refresh that succeeds spends the notice and carries the move. The Host has to
  // answer again before the player leaves: the conversation's own arrival read is still the shell's
  // problem view on failure, so a failing `/state` would end the journey at the AppBar instead of at
  // the Game surface this test is about.
  stateHealthy = true;
  await openChat(page);
  await openGame(page);
  await expect(notice).toHaveCount(0);
  await expect(panel).toContainText("ConnectionDisconnected");
  await expect(panel).toContainText("Last resultDid not complete");
});
