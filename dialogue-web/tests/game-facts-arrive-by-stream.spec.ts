/**
 * The panel is told, instead of asking.
 *
 * Measured on the real Host before this channel existed: one admitted `game.resume` waited up to ten seconds and
 * re-read `/game` twenty times, and nineteen of those reads were byte-identical - the fact it was waiting for arrives
 * at a coordinator transition, never on a cadence.
 *
 * These journeys are the three halves of that claim, all on the mounted shell:
 *
 * 1. with a stream, the attachment transition ends the wait and `/game` is read ZERO times - the same wait that used
 *    to be nineteen identical reads;
 * 2. without a stream, the same wait still polls, because the panel's behaviour is a property of what the Host
 *    publishes rather than of a client switch;
 * 3. a cursor the Host cannot serve is answered with one resync frame, and the panel's recovery is the `/game`
 *    snapshot - which is exactly why that route stays.
 */
import { expect, test } from "./frontend-coverage";
import { emitStreamEvent, installSyntheticEventStream, streamUrls } from "./synthetic-event-stream";
import { composeGameEvent, gameStreamCursor } from "./game-stream-fixtures";
import { csrfToken, draft, game, openGameDrawer, root, token } from "./composed-reference-game-fixtures";

// Epochs are canonical opaque handles, the shape every handle this boundary accepts has: 43 base64url characters whose
// final one carries two zero bits (`"A"` is index 0), so a fixture cannot pass where the real Host's own epoch would not.
const SESSION_EPOCH = `${"S".repeat(42)}A`;
const RESTARTED_EPOCH = `${"T".repeat(42)}A`;

type Page = Parameters<typeof openGameDrawer>[0];

/** The projection every journey here starts from: an attached session the player may resume. */
function attachedGame(checkpoint?: Readonly<{ epoch: string; cursor: string }>) {
  return {
    ...game,
    ...(checkpoint === undefined ? {} : { eventStream: checkpoint }),
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
}

/**
 * The routes every Game journey needs before the surface can be looked at, plus the one that is the measurement.
 *
 * `/game` is counted rather than served from a constant: a read of it here is a poll, so the count is what proves
 * whether the wait was ended by a frame or by a clock. The arrival at the Game surface reads this same route
 * (`use-arrival-reread`), which is why a journey that means "the WAIT read nothing" baselines the counter after the
 * panel is open rather than at page load.
 */
async function routeGameSurface(
  page: Page,
  options: Readonly<{
    arrival: ReturnType<typeof attachedGame>;
    snapshot?: ReturnType<typeof attachedGame> | (() => ReturnType<typeof attachedGame>);
    onGameRead?: () => void;
  }>,
): Promise<void> {
  const snapshot = options.snapshot ?? options.arrival;
  const projection = typeof snapshot === "function" ? snapshot : () => snapshot;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...root, game: options.arrival }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...root, game: options.arrival }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/composed-reference-game/v1/game", (route) => {
    options.onGameRead?.();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projection()) });
  });
}

/** The admitted resume itself: `accepted` is a transport answer, never runtime success. */
async function routeResumeAccepted(page: Page, onAdmitted?: () => void): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/game/resume", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    onAdmitted?.();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, status: "accepted" }),
    });
  });
}

async function gameStreamIndex(page: Page): Promise<number> {
  await expect.poll(async () => (await streamUrls(page)).some(isGameStream)).toBe(true);
  return (await streamUrls(page)).findIndex(isGameStream);
}

function isGameStream(url: string): boolean {
  return url.includes("/api/composed-reference-game/v1/events");
}

test("a Game fact ends the resume wait with zero /game reads", async ({ page }) => {
  await installSyntheticEventStream(page);
  let gameReads = 0;
  const projection = attachedGame({ epoch: SESSION_EPOCH, cursor: gameStreamCursor(SESSION_EPOCH, 0) });
  await routeGameSurface(page, {
    arrival: projection,
    onGameRead: () => {
      gameReads += 1;
    },
  });
  await routeResumeAccepted(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await expect(resume).toBeVisible();

  // The surface subscribed to the GAME channel - the Game surface's own route, not the Chat one - carrying the cursor
  // the snapshot published.
  const streamIndex = await gameStreamIndex(page);
  expect((await streamUrls(page))[streamIndex]).toContain(
    encodeURIComponent(gameStreamCursor(SESSION_EPOCH, 0)),
  );
  // The arrival's own read, which is not the wait's: the wait is what must read nothing.
  const readsOnArrival = gameReads;

  await resume.click();
  // The Host's own attachment transition, published after the command was admitted: connected, same generation.
  await emitStreamEvent(
    page,
    streamIndex,
    composeGameEvent({ epoch: SESSION_EPOCH, sequence: 1, fact: "attachment", connectionStatus: "connected_idle" }),
    gameStreamCursor(SESSION_EPOCH, 1),
  );

  await expect(panel).toContainText("ConnectionConnected");
  await expect(resume).toHaveCount(0);
  // The measurement: the frame ended the wait, so the route that used to be polled was never read at all - counted
  // from the press, because the arrival at this surface reads `/game` once by design (`use-arrival-reread`).
  expect(gameReads - readsOnArrival).toBe(0);
});

test("a Host that publishes no stream is still polled, so the same wait still converges", async ({ page }) => {
  let gameReads = 0;
  const attached = attachedGame();
  const connected = { ...attached, game: { ...attached.game, connectionStatus: "connected_idle" } };
  // The Host's state moves when the resume is ADMITTED - never before it. The arrival read answers `attached` like
  // every other read made before the press, so what converges here is the wait's own polling.
  let admitted = false;
  await routeGameSurface(page, {
    arrival: attached,
    snapshot: () => (admitted ? connected : attached),
    onGameRead: () => {
      gameReads += 1;
    },
  });
  await routeResumeAccepted(page, () => {
    admitted = true;
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Resume game" }).click();
  await expect(panel).toContainText("ConnectionConnected");
  expect(gameReads).toBeGreaterThan(0);
});

test("a cursor the Host cannot serve resyncs the panel to the /game snapshot", async ({ page }) => {
  await installSyntheticEventStream(page);
  let gameReads = 0;
  const stale = attachedGame({ epoch: SESSION_EPOCH, cursor: gameStreamCursor(SESSION_EPOCH, 7) });
  const restarted = attachedGame({ epoch: RESTARTED_EPOCH, cursor: gameStreamCursor(RESTARTED_EPOCH, 0) });
  await routeGameSurface(page, {
    arrival: stale,
    snapshot: restarted,
    onGameRead: () => {
      gameReads += 1;
    },
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const streamIndex = await gameStreamIndex(page);

  // The Host restarted: this cursor belongs to an epoch it no longer holds.
  await emitStreamEvent(
    page,
    streamIndex,
    {
      apiVersion: 1,
      epoch: SESSION_EPOCH,
      sequence: 8,
      eventType: "game.stream_resync_required",
      payload: { reason: "epoch_changed" },
    },
    gameStreamCursor(SESSION_EPOCH, 8),
  );

  // One snapshot read - the recovery path, not a second guess at what the frames it missed said.
  await expect.poll(() => gameReads).toBe(1);
  const urls = await streamUrls(page);
  const next = urls.slice(streamIndex + 1).find(isGameStream);
  expect(next).toBeDefined();
  expect(next).toContain(encodeURIComponent(gameStreamCursor(RESTARTED_EPOCH, 0)));
  // Recovered once, not in a loop: the resync budget replaces NOTHING after a good snapshot.
  await expect.poll(() => gameReads).toBe(1);
});
