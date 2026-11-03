/**
 * The marks the product records, read off a page the product is really driving.
 *
 * Two families are emitted today, and until this journey neither had ever been seen on a mounted page:
 *
 *   `gamebuddy:switch:<surface>:start|done`  `composed-surface-route.ts` - the player selected a
 *                                            surface, and the new region is committed and painted.
 *   `gamebuddy:turn:submit|settled`          `turn-timings.ts` - the player pressed send, and the turn
 *                                            reached a terminal state.
 *
 * `tools/live-run/frontend/capture/observation.cjs` reads both, and its own unit tests feed it marks it
 * built itself. That is the "stored but never sent" shape: a reader whose tests are green while the
 * product emits nothing. The unit test cannot see it, because it constructs the marks it then reads;
 * only a page the product is driving can say whether the names ever reach `performance`.
 *
 * So nothing here records a mark. The switch is the player's own control (the shell's entry in the app
 * bar), and the turn is a real send through the composer. For the settlement the journey delivers the
 * Host's contract event on the stream the product opened - `turn-timings.ts` is what turns it into the
 * mark, exactly as it does against a live Host - which is why the quiet `EventSource` below exists and
 * why the mark it produces is the product's, not this file's.
 */
import { expect, test, type Page } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const eventId = `${"H".repeat(42)}A`;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * The Host behind the shell, as one mutable record: a journey can settle a turn on it without
 * reloading the page, which is what a live Host does while the player watches.
 */
type HostState = {
  turnState: "running" | "completed" | null;
};

function composedRoot(state: HostState) {
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
            : { handle: turnHandle, state: state.turnState, projectionRevision: 1, canCancel: false },
        worldInfo: null,
      },
      memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
      // The stream the shell opens. The marks this journey reads are recorded on its events, so the
      // projection has to publish one for the turn half to exist at all.
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
    },
    game: {
      apiVersion: 1,
      build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
      csrfToken,
      browserSession: { expiresAtMs },
      game: {
        prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
        instance: { status: "none", gameTitle: "Stardew Valley", generation: 0 },
        compatibility: { status: "compatible", message: null },
        attachment: { status: "none", generation: 0 },
        connectionStatus: "none",
        actionAuthority: "unavailable",
        role: null,
        companionName: null,
        selectedWorld: null,
        selectedSave: null,
        capabilitySummary: { available: false, count: 0 },
        latestOutcome: "none",
      },
    },
  };
}

/** The routes this journey's two surfaces read, answered from the one mutable record. */
async function stubHost(page: Page, state: HostState): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot(state))));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot(state))));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
}

/**
 * A quiet `EventSource`: it records the handlers the product registers, never calls `onerror`, and
 * delivers only what a journey hands it. A harness that storms measures the storm.
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
    (
      window as unknown as { __emit: (eventType: string, data: string, id: string) => void }
    ).__emit = (eventType, data, id) => {
      for (const entry of handlers) {
        for (const handler of entry.get(eventType) ?? []) handler({ data, lastEventId: id, type: eventType });
      }
    };
  });
}

/** Deliver one contract event on the stream the product opened. */
async function emitEvent(page: Page, eventType: string, data: string): Promise<void> {
  await page.evaluate(
    (payload: { eventType: string; data: string; id: string }) =>
      (
        window as unknown as { __emit: (eventType: string, data: string, id: string) => void }
      ).__emit(payload.eventType, payload.data, payload.id),
    { eventType, data, id: eventId },
  );
}

type PageMark = Readonly<{ name: string; at: number }>;

/** Every mark on the page's own timeline, in page order - the buffer the live reader reads. */
async function readMarks(page: Page): Promise<PageMark[]> {
  return await page.evaluate(() =>
    performance.getEntriesByType("mark").map((entry) => ({ name: entry.name, at: entry.startTime })),
  );
}

/**
 * Wait until the product has recorded `name`, naming the mark in the failure rather than reporting a
 * bare `false`: the finding this journey exists to produce is "the product never emitted this".
 */
async function waitForMark(page: Page, name: string): Promise<void> {
  await expect
    .poll(async () => (await readMarks(page)).some((mark) => mark.name === name), {
      message: `the product records ${name} on the page's own timeline`,
    })
    .toBe(true);
}

const startOf = (marks: readonly PageMark[], name: string): number => {
  const mark = marks.find((candidate) => candidate.name === name);
  if (mark === undefined) throw new Error(`${name} is not on the timeline`);
  return mark.at;
};

test.describe("the marks the product records reach a real page", () => {
  test("switching surfaces records both ends of the switch", async ({ page }) => {
    const state: HostState = { turnState: null };
    await stubHost(page, state);
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    // The player's own control - the shell's entry in the app bar - not a hand-edited URL.
    await page.getByRole("button", { name: "Game", exact: true }).click();
    await expect(page.getByTestId("game-surface")).toBeVisible();
    await waitForMark(page, "gamebuddy:switch:game:start");
    await waitForMark(page, "gamebuddy:switch:game:done");

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByTestId("chat-surface")).toBeVisible();
    await waitForMark(page, "gamebuddy:switch:chat:start");
    await waitForMark(page, "gamebuddy:switch:chat:done");

    // Each switch is one pair, and its ends are in page order: a `done` before its `start` would make
    // every duration the reader computes negative.
    const marks = await readMarks(page);
    for (const surface of ["game", "chat"]) {
      expect(startOf(marks, `gamebuddy:switch:${surface}:done`)).toBeGreaterThanOrEqual(
        startOf(marks, `gamebuddy:switch:${surface}:start`),
      );
    }
  });

  test("a turn records its submit and its settlement", async ({ page }) => {
    test.setTimeout(60_000);
    const state: HostState = { turnState: null };
    await installQuietStream(page);
    await stubHost(page, state);
    await page.route("**/api/tavern/v1/messages", (route) =>
      route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          apiVersion: 1,
          disposition: "accepted",
          message: {
            handle: `${"P".repeat(42)}A`,
            role: "player",
            text: "Are you there?",
            locale: "und",
            order: 0,
            revision: 1,
          },
          turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
        }),
      }),
    );

    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();
    // The product opened its own stream; without it a turn has no live channel to settle on.
    await expect
      .poll(async () => await page.evaluate(() => (window as unknown as { __handlers: unknown[] }).__handlers.length))
      .toBe(1);

    await chat.locator("textarea").fill("Are you there?");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await waitForMark(page, "gamebuddy:turn:submit");

    // The Host settles the turn on the stream it publishes. This journey delivers the contract event
    // and nothing else: the mark is `turn-timings.ts`'s own mapping of it.
    state.turnState = "completed";
    await emitEvent(
      page,
      "turn.state_changed",
      JSON.stringify({
        apiVersion: 1,
        epoch: streamEpoch,
        sequence: 1,
        selectionGeneration: 1,
        eventType: "turn.state_changed",
        payload: { handle: turnHandle, state: "completed", projectionRevision: 1, canCancel: false },
      }),
    );
    await waitForMark(page, "gamebuddy:turn:settled");

    const marks = await readMarks(page);
    expect(startOf(marks, "gamebuddy:turn:settled")).toBeGreaterThanOrEqual(startOf(marks, "gamebuddy:turn:submit"));
  });
});
