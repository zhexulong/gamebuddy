import { expect, test, type Page } from "./frontend-coverage";

/**
 * A Game-driven authoritative read commits the Game projection and nothing else.
 *
 * `GameSurface.rereadGame` is the read every Game lifecycle handler takes after it acts. It read the
 * shell's view BEFORE its round trip and committed that whole photograph after it, so anything the
 * Chat channel published while the read was in flight was overwritten by a picture of the screen it
 * replaced. The shell's own Chat read path names this exact defect at its own site
 * (`ComposedReferenceGameApp.tsx`, `rereadChat`): the erased pending record is the one that keeps the
 * fallback poll alive and the send gate shut, so the player's just-sent line leaves the screen and the
 * composer unlocks mid-turn.
 *
 * The interleaving is ordinary rather than contrived: a Game operation runs while the player is on
 * the Chat surface - the surface stays mounted when they switch away, so its command and its reads
 * keep running - and the player sends into that window.
 *
 * The second journey is the other half of the same boundary: the streaming preview belongs to the
 * turn it was built from and is spent by the Chat channel's reads (`rereadChat`, `reconcile`,
 * `recover`), never by a Game read. A Game read that publishes no running turn is a fact about the
 * Game projection, not a decision about what the conversation is showing.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;
const replyHandle = `${"R".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const playerText = "The miller left his coat on the step and walked on.";
const companionText = "He will come back for it before the rain.";

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * The Host behind the shell, as one mutable record the routes answer from.
 *
 * `turnState` and the two transcript flags are the whole conversation as far as these journeys are
 * concerned: whether a turn is running is what a read can settle, and which rows the transcript
 * carries is what it publishes.
 */
type HostState = {
  turnState: string | null;
  playerLine: boolean;
  companionLine: boolean;
};

function chatOf(state: HostState) {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: state.turnState === null ? "available" : "busy",
        routeId: "chat.submit",
      },
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: companionHandle },
      title: "A read that outlived its subject",
      transcript: [
        { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
        ...(state.playerLine
          ? [{ handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 }]
          : []),
        ...(state.companionLine
          ? [{ handle: replyHandle, role: "companion", text: companionText, locale: "und", order: 2, revision: 1 }]
          : []),
      ],
      draft: { revision: 0, present: false },
      turn:
        state.turnState === null
          ? null
          : { handle: turnHandle, state: state.turnState, projectionRevision: 1, canCancel: true },
      worldInfo: { state: "none", revision: chatHandle, items: [] },
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
    eventStream: { epoch: streamEpoch, cursor: streamCursor },
  };
}

/**
 * The Game half: one live attachment, connected and idle, which is the shape `game-stop` acts on.
 * Nothing here is the journeys' subject except that a Game command exists to press.
 */
const game = {
  apiVersion: 1,
  build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
  csrfToken,
  browserSession: { expiresAtMs },
  game: {
    prerequisites: { status: "met", detectedGame: "Stardew Valley" },
    instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 },
    compatibility: { status: "compatible", message: null },
    attachment: { status: "attached", generation: 1 },
    connectionStatus: "connected_idle",
    actionAuthority: "active",
    role: "companion",
    companionName: "Mira",
    selectedWorld: "The Farm",
    selectedSave: "Save One",
    capabilitySummary: { available: true, count: 3 },
    latestOutcome: "none",
  },
};

const composedRoot = (state: HostState) => ({
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: chatOf(state),
  game,
});

/**
 * A quiet `EventSource`: it never calls `onerror` and delivers only what this journey hands it, so the
 * fallback poll stays suspended under it. The stream is what makes the read under test the only read
 * that lands inside the window the journey opens - without it a poll hop could commit the same state
 * for its own reasons and the reading would not be about the Game read at all.
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

/** One `companion.delta` frame, and never a second: the preview can only be the one the shell holds. */
async function emitDelta(page: Page, delta: string): Promise<void> {
  await page.evaluate(
    ({ data, id }: { data: string; id: string }) =>
      (window as unknown as { __emit: (data: string, id: string) => void }).__emit(data, id),
    {
      data: JSON.stringify({
        apiVersion: 1,
        epoch: streamEpoch,
        sequence: 1,
        selectionGeneration: 1,
        eventType: "companion.delta",
        payload: { turnHandle, delta },
      }),
      id: `${"H".repeat(42)}A`,
    },
  );
}

type Host = Readonly<{
  stateReads: () => number;
  held: { reading: boolean };
  /**
   * Holds the next read of one route open, so the journey can act inside its round trip.
   *
   * Two different reads matter here, and they are two different routes: the panel's own Game read
   * (`/game`) is what a Game command rereads, and the Chat channel's read (`/state`, through
   * `rereadChat`) is what spends a preview. Which one is held is the whole point of each journey.
   */
  holdNextState: (target: "game" | "chat") => void;
  releaseHeld: () => void;
  submits: () => readonly string[];
}>;

async function stubHost(page: Page, state: HostState): Promise<Host> {
  let stateReads = 0;
  const held = { reading: false };
  let holdTarget: "game" | "chat" | null = null;
  let releaseHeld: (() => void) | null = null;
  const submits: string[] = [];
  /** Holds this read open if the journey asked for this route, and returns whether it did. */
  const holdIfAsked = async (target: "game" | "chat"): Promise<void> => {
    if (holdTarget !== target) return;
    holdTarget = null;
    held.reading = true;
    await new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(composedRoot(state))),
  );
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    // The Chat channel's own read: `rereadChat` takes it on arrival, and it is the one that spends a
    // preview whose turn is over.
    await holdIfAsked("chat");
    await route.fulfill(jsonOk(composedRoot(state)));
  });
  // The panel's own read is the Game slice's route (`readGameState`), and it is the read every Game
  // command rereads. Its answer is fixed when the read is taken and only its delivery is slow - that is
  // what a round trip is, and it is the whole interleaving: the reading describes the screen before the
  // press, and the press lands while it is still in flight.
  await page.route("**/api/composed-reference-game/v1/game", async (route) => {
    const body = game;
    stateReads += 1;
    await holdIfAsked("game");
    await route.fulfill(jsonOk(body));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "accepted" })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/messages", async (route) => {
    submits.push(route.request().headers()["idempotency-key"] ?? "(none)");
    state.turnState = "running";
    state.playerLine = true;
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    );
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "accepted" })),
  );

  return {
    stateReads: () => stateReads,
    held,
    holdNextState: (target) => {
      holdTarget = target;
    },
    releaseHeld: () => {
      if (releaseHeld !== null) (releaseHeld as () => void)();
    },
    submits: () => submits,
  };
}

test("a send that lands inside a Game read is not erased by it", async ({ page }) => {
  test.setTimeout(120_000);
  const state: HostState = { turnState: null, playerLine: false, companionLine: false };
  await installQuietStream(page);
  const host = await stubHost(page, state);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  // A Game operation, taken while the player is on its own surface. Its read is held open, and the
  // player goes back to the conversation and sends into that window.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel.getByTestId("game-stop")).toBeVisible();
  host.holdNextState("game");
  await panel.getByTestId("game-stop").click();
  await expect.poll(() => host.held.reading).toBe(true);

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(surface).toBeVisible();
  await composer.fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => host.submits().length).toBe(1);
  // The submission the send published is on screen while the Game read is still open.
  await expect(surface.getByTestId("optimistic-player-message")).toBeVisible();

  // The Game read lands, carrying the projection it took before the send existed.
  host.releaseHeld();
  await page.waitForTimeout(150);

  const send = surface.getByTestId("composer-send");
  const measured = await page.evaluate(() => ({
    optimistic: document.querySelectorAll('[data-testid="optimistic-player-message"]').length,
    playerRows: document.querySelectorAll(".message-list > li").length,
    send: document.querySelectorAll('[data-testid="composer-send"]').length,
    busy: document.querySelectorAll("[data-composer-busy]").length,
    fieldDisabled: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled ?? null,
  }));
  console.log(`MEASURE game read raced a send: ${JSON.stringify(measured)}`);

  // THE DEFECT: the pre-send photograph was committed over the send, so the player's just-sent line
  // left the screen and the gate reopened while the Host held the turn. Both readings are taken
  // before anything is pressed again, so what fails is the interleaving, not a second click.
  expect(measured.optimistic, "the line the player just sent left the screen").toBe(1);
  expect(measured.send, "the send gate reopened inside a turn the Host is holding").toBe(0);
  expect(measured.busy, "the composer lost the record that says a turn is in flight").toBe(1);
  // If the erasure did unlock the composer, pressing Send again is the duplicate the erased record
  // would have prevented; it is measured rather than assumed.
  if ((await send.count()) > 0) await send.click();
  expect(host.submits(), "the same press was sent twice").toHaveLength(1);
  await expect(
    surface.getByTestId("optimistic-player-message").or(surface.locator(".message-list > li", { hasText: playerText })).first(),
  ).toBeVisible();
});

test("a Game read publishes no running turn without spending the preview the Chat channel owns", async ({ page }) => {
  test.setTimeout(120_000);
  const state: HostState = { turnState: "running", playerLine: false, companionLine: false };
  await installQuietStream(page);
  const host = await stubHost(page, state);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();

  // The reply is streaming and the player is reading it. Nothing here delivers a second delta, so
  // the preview below can only be the one the shell still holds.
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as { __handlers: unknown[] }).__handlers.length)))
    .toBe(1);
  await emitDelta(page, "A streaming reply.");
  await expect(surface.locator('[data-streaming="true"]')).toHaveCount(1);
  await expect(surface).toContainText("A streaming reply.");

  // A Game operation, taken with the turn still running. Its own read is the second answer of this
  // journey: the Host publishes the turn as over.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel.getByTestId("game-stop")).toBeVisible();
  state.turnState = "completed";
  state.companionLine = true;
  const readsBeforeStop = host.stateReads();
  const stop = panel.getByTestId("game-stop");
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect.poll(() => host.stateReads()).toBeGreaterThan(readsBeforeStop);
  await page.waitForTimeout(100);

  // Back to the conversation. The arrival read is held open so the reading is taken before Chat's own
  // read lands: between the two, the only writer to the conversation was the Game read.
  host.holdNextState("chat");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(surface).toBeVisible();
  await expect.poll(() => host.held.reading).toBe(true);
  const previewBeforeChatRead = await surface.locator('[data-streaming="true"]').count();
  console.log(`MEASURE previewAfterGameRead=${previewBeforeChatRead} stateReads=${host.stateReads()}`);

  // THE DEFECT: the Game read decided Chat's presentation, so the reply the player was watching was
  // already gone before the Chat channel had answered anything.
  expect(previewBeforeChatRead, "a Game read spent a preview the Chat channel owns").toBe(1);
  await expect(surface).toContainText("A streaming reply.");

  // …and the Chat channel's own read is the one that settles it: the authoritative transcript now
  // carries the reply, so the preview it replaced is spent.
  host.releaseHeld();
  await expect(surface.locator('[data-streaming="true"]')).toHaveCount(0);
  await expect(surface.locator(".message-list > li", { hasText: companionText })).toHaveCount(1);
});
