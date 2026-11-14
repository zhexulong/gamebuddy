import { expect, test, type Page } from "./frontend-coverage";
import { chat, installedRoot, jsonOk, root as composedRoot, token } from "./composed-reference-game-fixtures";
import { emitStreamEvent, installSyntheticEventStream, streamUrls } from "./synthetic-event-stream";

/**
 * A Chat problem stays inside the Chat region; the Game surface is not its subject.
 *
 * The measured defect: the shell rendered ONE top-level problem screen (`view.kind === "problem"`
 * replaced the AppBar, every surface and `<GameSurface />` itself). A Chat read that could not be
 * reconciled - a resync whose authoritative answer no longer publishes a stream - therefore
 * unmounted the Game surface while the Player Host, SMAPI and the game kept running, and the game
 * channel stayed dead until the player reloaded the page. Chat and Game are peer surfaces that
 * start, stop and recover independently (`design/architecture/product-surfaces.md`), so a failure
 * in one may not take the other's region.
 *
 * What these journeys hold:
 *  - with the Game panel selected, a Chat failure leaves it mounted and draws no whole-window card;
 *  - with the conversation selected, the same failure draws the card INSIDE the main region, with
 *    its own retry, and the Game panel is still mounted afterwards;
 *  - the reverse direction: a Game refusal is drawn in the Game region and the conversation stays
 *    mounted (`/lifecycle/activate` refused here).
 */

const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const frameId = `${"H".repeat(42)}A`;

/** `installedRoot`'s game is the one shape whose activation control has a premise. */
const activationRoot = installedRoot;

function frame(sequence: number, eventType: string, payload: unknown) {
  return { apiVersion: 1, epoch: streamEpoch, sequence, selectionGeneration: 1, eventType, payload };
}

type ChatHost = Readonly<{
  stateReads: () => number;
  /** What the next `/state` publishes: the projection the mount opened with, or the same one with no stream. */
  publishStream: (present: boolean) => void;
}>;

/**
 * Mounts the shell with a Chat projection whose `/state` answer can stop publishing the stream -
 * the answer a mounted session cannot apply, i.e. a Chat read that fails for good while the Game
 * projection beside it is perfectly readable.
 */
async function mountWithAFailingChatRead(page: Page): Promise<ChatHost> {
  await installSyntheticEventStream(page);
  let publishesStream = true;
  let stateReads = 0;
  const projection = (withStream: boolean) => ({
    ...composedRoot,
    chat: { ...chat, eventStream: withStream ? { epoch: streamEpoch, cursor: streamCursor } : null },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection(true))));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(projection(publishesStream)));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect.poll(() => streamUrls(page)).toHaveLength(1);
  return {
    stateReads: () => stateReads,
    publishStream: (present: boolean) => {
      publishesStream = present;
    },
  };
}

test("a Chat read failure leaves the Game panel mounted and takes no window card", async ({ page }) => {
  test.setTimeout(90_000);
  const host = await mountWithAFailingChatRead(page);

  // The player is looking at the game when the Chat read fails - the state in which the old card
  // took the whole window, and with it the live game channel.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toBeVisible();

  host.publishStream(false);
  await emitStreamEvent(page, 0, frame(1, "stream.resync_required", { reason: "gap" }), frameId);
  await expect.poll(() => host.stateReads(), { message: "the resync took the authoritative read" }).toBeGreaterThan(0);

  // The Game surface is still the mounted surface: its panel is on screen and the bar that reaches
  // it is still the app's.
  await expect(panel, "a Chat failure may not unmount the Game surface").toBeVisible();
  await expect(page.getByRole("button", { name: "Game", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
  // ...and the failure did not become a page: the whole-window card is the OTHER case (no session).
  await expect(page.locator(".problem-view"), "the Chat card did not take the window").toHaveCount(0);
});

test("the Chat problem is drawn inside the Chat region, with its own retry", async ({ page }) => {
  test.setTimeout(90_000);
  const host = await mountWithAFailingChatRead(page);

  host.publishStream(false);
  await emitStreamEvent(page, 0, frame(1, "stream.resync_required", { reason: "gap" }), frameId);
  await expect.poll(() => host.stateReads(), { message: "the resync took the authoritative read" }).toBeGreaterThan(0);

  // The card takes the Chat region, under the bar the app still owns - not the window.
  const region = page.locator("main#main-content [data-testid='chat-problem']");
  await expect(region, "the Chat problem is drawn inside the Chat region").toBeVisible();
  await expect(region.locator(".problem-card")).toBeVisible();
  await expect(page.locator(".problem-view"), "the Chat card did not take the window").toHaveCount(0);
  console.log(
    `[chat-problem/region] ${await page.evaluate(() => document.querySelector("[data-testid='chat-problem']")?.innerHTML ?? "(none)")}`,
  );

  // Every problem state has a step, and this one's step is the read again: a real control, not a
  // dead end (`problem-view-has-a-way-out.spec.ts` holds the window card's own version of this).
  const retry = region.getByTestId("problem-retry-read");
  await expect(retry).toBeVisible();

  // The step is real: the read is taken again and the conversation it publishes replaces the card.
  host.publishStream(true);
  await retry.click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toContainText("The game projection is read-only.");
  await expect(page.locator("[data-testid='chat-problem']")).toHaveCount(0);

  // The Game panel was mounted throughout: it is still there, with its own projection.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-state-panel"), "the Game panel survived the Chat failure").toBeVisible();
});

test("a Game refusal is drawn in the Game region and the conversation stays mounted", async ({ page }) => {
  test.setTimeout(90_000);
  await installSyntheticEventStream(page);
  let activationRequests = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(activationRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(activationRoot)));
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) => {
    activationRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "unauthorized" }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toBeVisible();

  await panel.getByTestId("game-activate").click();
  await expect.poll(() => activationRequests, { message: "the refusal was the game's own operation" }).toBe(1);

  // The refusal is the game region's fact: no whole-window card, and the conversation is still the
  // mounted Chat surface.
  await expect(page.locator(".problem-view"), "a Game refusal may not replace the window").toHaveCount(0);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toContainText("The game projection is read-only.");
});
