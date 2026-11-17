/**
 * A Chat read may not put the Game panel back on an older projection.
 *
 * `/state` answers the whole aggregate: the conversation *and* a `game` slice beside it, photographed when the
 * request left. The shell's Chat reads committed that whole document, so a Chat read that was in flight when the
 * game moved - a resume converging, a farm loading, a world ending, all of which reach the panel on its own
 * channel - landed on the OLDER projection and stayed there: the Chat channel never speaks again about the game,
 * so nothing put the panel forward.
 *
 * The journey is deliberately an in-flight one, and it asserts what the panel SHOWS rather than that a request
 * happened: the player is on the Game surface, the Game's own channel publishes the move, and the Chat read that
 * was already outstanding answers the projection from before it.
 */
import { expect, test } from "./frontend-coverage";
import { composeGameEvent, gameStreamCursor } from "./game-stream-fixtures";
import { emitStreamEvent, installSyntheticEventStream, streamUrls } from "./synthetic-event-stream";
import { draft, game, jsonOk, root, stubGameRead, token } from "./composed-reference-game-fixtures";

// A canonical opaque epoch handle: 43 base64url characters whose last carries two zero bits, the shape this
// boundary accepts, so the fixture cannot pass where the real Host's own epoch would not.
const SESSION_EPOCH = `${"S".repeat(42)}A`;

/** The projection before the move: no game connection, and a channel to be told about the next one. */
const quietGame = {
  ...game,
  eventStream: { epoch: SESSION_EPOCH, cursor: gameStreamCursor(SESSION_EPOCH, 0) },
};

const panel = (page: Parameters<typeof stubGameRead>[0]) => page.getByTestId("game-state-panel");

function isGameStream(url: string): boolean {
  return url.includes("/api/composed-reference-game/v1/events");
}

test("a Chat read that outlives a Game fact does not put the panel back on the older projection", async ({ page }) => {
  await installSyntheticEventStream(page);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk({ ...root, game: quietGame })),
  );
  // The Chat read the journey holds: it is armed immediately before the player leaves the conversation, and what
  // it answers is the projection from BEFORE the frame below - which is exactly what a round trip returns.
  let armed = false;
  let release: (() => void) | null = null;
  let landed: (() => void) | null = null;
  const landedAt = () => new Promise<void>((resolve) => (landed = resolve));
  let chatReadLanded = landedAt();
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    const held = armed;
    armed = false;
    if (held) await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill(jsonOk({ ...root, game: quietGame }));
    landed?.();
  });
  // The panel's own read answers the same quiet projection: the ONLY thing that says the game moved is its channel,
  // which is the fact the older Chat read must not undo.
  await stubGameRead(page, () => quietGame);
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect(panel(page)).toContainText("ConnectionNo game connection");

  // The player goes back to the conversation - whose arrival read is now outstanding - and returns to the panel
  // before it answers.
  armed = true;
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  // The Host publishes its move on the Game's own channel: the companion is in the farm.
  await expect.poll(async () => (await streamUrls(page)).some(isGameStream)).toBe(true);
  const streamIndex = (await streamUrls(page)).findIndex(isGameStream);
  // The frame is only heard by a connection that has attached its listener: deliver it to a channel the surface
  // is really listening on, or the journey would be measuring its own timing.
  await expect
    .poll(
      async () =>
        await page.evaluate((at: number) => {
          const state = window as unknown as { __streamHandlers: Array<Map<string, unknown[]>> };
          return (state.__streamHandlers[at]?.get("game.fact_changed") ?? []).length;
        }, streamIndex),
    )
    .toBeGreaterThan(0);
  await emitStreamEvent(
    page,
    streamIndex,
    composeGameEvent({ epoch: SESSION_EPOCH, sequence: 1, fact: "attachment", connectionStatus: "connected_idle" }),
    gameStreamCursor(SESSION_EPOCH, 1),
  );
  await expect(panel(page)).toContainText("ConnectionConnected");

  // Now the Chat read that left before the move answers. The panel the player is looking at is the fact under test.
  expect(release, "the Chat arrival read was the one held").not.toBeNull();
  release?.();
  await chatReadLanded;
  await page.waitForTimeout(500);
  await expect(panel(page)).toContainText("ConnectionConnected");
  await expect(panel(page)).not.toContainText("ConnectionNo game connection");
});
