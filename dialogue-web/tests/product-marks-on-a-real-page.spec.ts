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
type TranscriptRow = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: string;
  order: number;
  revision: number;
}>;

type HostState = {
  turnState: "running" | "completed" | null;
  transcript: readonly TranscriptRow[];
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
        transcript: state.transcript.map((row) => ({ ...row })),
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

type PageMark = Readonly<{ name: string; at: number; detail: Record<string, string> }>;

/** Every mark on the page's own timeline, in page order - the buffer the live reader reads. */
async function readMarks(page: Page): Promise<PageMark[]> {
  return await page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .map((entry) => ({ name: entry.name, at: entry.startTime, detail: (entry.detail ?? {}) as Record<string, string> })),
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
    const state: HostState = { turnState: null, transcript: [] };
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

  /**
   * The other end of that rule, on the surface the shell opens with: a press that selects the
   * conversation while the conversation is already the region still commits, because there is no
   * later commit to wait for. Its pair was left open at `start` forever, so a reader reporting what a
   * surface switch cost read the app's first press as a switch that never finished.
   *
   * The first paint itself is deliberately NOT a pair: nobody pressed an entry, and `start` is the
   * player's selection. That is the same reason Back and Escape arrive as `done` alone.
   */
  test("the first press on the conversation records both ends of its switch", async ({ page }) => {
    await stubHost(page, { turnState: null, transcript: [] });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    // The app opened on the conversation without anyone selecting it.
    expect((await readMarks(page)).filter((mark) => mark.name.startsWith("gamebuddy:switch:"))).toEqual([]);

    // The player's own control for the surface already on screen. It pushes the entry that names the
    // conversation, and with it the region is where it was: one switch, both ends.
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect.poll(async () => (await readMarks(page)).map((mark) => mark.name)).toContain("gamebuddy:switch:chat:done");
    const chatMarks = (await readMarks(page)).filter((mark) => mark.name.startsWith("gamebuddy:switch:chat:"));
    expect(chatMarks.map((mark) => mark.name)).toEqual(["gamebuddy:switch:chat:start", "gamebuddy:switch:chat:done"]);
  });

  test("a turn records its submit and its settlement", async ({ page }) => {
    test.setTimeout(60_000);
    const state: HostState = { turnState: null, transcript: [] };
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

  /**
   * A regenerate starts a durable turn of its own, and the page has to say whose turn it is.
   *
   * Measured on a real run: `handleRegenerate` published the pending record and sent the request,
   * and did nothing else - so the turn it started carried no `submit` mark and nothing ever wrote
   * `turnKeyRef.current`. Its `accepted`/`first-token`/`settled` marks were emitted with `null`.
   *
   * The worse half is what this journey drives. The fallback poll (and the reconcile pass that
   * confirms a committed message) spends the pending record from an authoritative read and never
   * clears the ref - only a terminal `turn.state_changed` does - so a turn settled that way leaves
   * the PREVIOUS turn's key standing, and the next regenerate's marks borrow it. A mark that names
   * another turn is worse than no mark: it attributes one turn's timing to another.
   *
   * The key is not invented here. It is the `idempotency-key` header the page sends on the
   * regenerate request - the same durable turn identity the Host stamps on the provider request
   * (`X-GameBuddy-Idempotency-Key`) and the wire capture records.
   */
  test("a regenerated turn marks itself, and does not borrow the turn before it", async ({ page }) => {
    test.setTimeout(60_000);
    const openingHandle = `${"O".repeat(42)}A`;
    const playerHandle = `${"P".repeat(42)}A`;
    const replyHandle = `${"R".repeat(42)}A`;
    const playerText = "A first line.";
    const replyText = "Her first reply.";
    const opening: TranscriptRow = {
      handle: openingHandle,
      role: "companion",
      text: "An opening greet.",
      locale: "und",
      order: 0,
      revision: 1,
    };
    const state: HostState = { turnState: null, transcript: [opening] };
    await installQuietStream(page);
    await stubHost(page, state);

    const acceptedBody = (message: TranscriptRow) =>
      JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message,
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      });
    let sendKey: string | null = null;
    let regenerateKey: string | null = null;
    await page.route("**/api/tavern/v1/messages", (route) => {
      sendKey = route.request().headers()["idempotency-key"] ?? null;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: acceptedBody({
          handle: playerHandle,
          role: "player",
          text: playerText,
          locale: "und",
          order: 1,
          revision: 1,
        }),
      });
    });
    await page.route("**/api/tavern/v1/messages/regenerate", (route) => {
      regenerateKey = route.request().headers()["idempotency-key"] ?? null;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: acceptedBody({
          handle: replyHandle,
          role: "companion",
          text: replyText,
          locale: "und",
          order: 2,
          revision: 2,
        }),
      });
    });

    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();
    await expect
      .poll(async () => await page.evaluate(() => (window as unknown as { __handlers: unknown[] }).__handlers.length))
      .toBe(1);

    // A turn the player really started, so a previous turn's key exists to be borrowed.
    await chat.locator("textarea").fill(playerText);
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await waitForMark(page, "gamebuddy:turn:submit");
    await expect.poll(() => sendKey).not.toBeNull();

    // THE STALE-KEY SHAPE. The reply lands with the turn already terminal, and the page learns it
    // from a committed message rather than a terminal transition: the reconcile pass spends the
    // pending record from its authoritative read, and the ref - which only a terminal
    // `turn.state_changed` clears - keeps the send's key.
    state.turnState = "completed";
    state.transcript = [
      opening,
      { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
      { handle: replyHandle, role: "companion", text: replyText, locale: "und", order: 2, revision: 2 },
    ];
    await emitEvent(
      page,
      "message.committed",
      JSON.stringify({
        apiVersion: 1,
        epoch: streamEpoch,
        sequence: 1,
        selectionGeneration: 1,
        eventType: "message.committed",
        payload: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
      }),
    );

    // The reply row and its control, which only the authoritative read can bring.
    const regenerateControl = page.locator(`li[data-handle="${replyHandle}"] .regenerate-btn`);
    await expect(regenerateControl).toBeVisible();
    await regenerateControl.click();
    await expect.poll(() => regenerateKey).not.toBeNull();

    // The turn that regenerate started reaches `running` on the stream the page opened.
    await emitEvent(
      page,
      "turn.state_changed",
      JSON.stringify({
        apiVersion: 1,
        epoch: streamEpoch,
        sequence: 2,
        selectionGeneration: 1,
        eventType: "turn.state_changed",
        payload: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    );

    const marks = await readMarks(page);
    const acceptedMarks = marks.filter((mark) => mark.name === "gamebuddy:turn:accepted");
    expect(acceptedMarks.length).toBeGreaterThan(0);
    const accepted = acceptedMarks[acceptedMarks.length - 1]!;
    // The mark must name the turn it belongs to.
    expect(accepted.detail.turnKey).toBe(regenerateKey);
    // The stale case on its own, because it is the failure that matters: a mark borrowed from the
    // turn before attributes this turn's timing to one that already settled.
    expect(accepted.detail.turnKey).not.toBe(sendKey);
    // ...and the submit that acceptance belongs to is on the timeline under the same key, first.
    const regenerateSubmits = marks.filter(
      (mark) => mark.name === "gamebuddy:turn:submit" && mark.detail.turnKey === regenerateKey,
    );
    expect(regenerateSubmits).toHaveLength(1);
    expect(regenerateSubmits[0]!.at).toBeLessThanOrEqual(accepted.at);
  });
});
