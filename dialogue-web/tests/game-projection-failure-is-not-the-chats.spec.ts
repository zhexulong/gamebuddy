import { type Page, expect, test } from "./frontend-coverage";
import { chat, game, jsonOk, root as composedRoot, token } from "./composed-reference-game-fixtures";

/**
 * A Game projection that cannot be read is not a conversation that cannot be read.
 *
 * The Host composes the Chat half and the Game half into ONE document (`readComposedRoot`,
 * `host/src/composed-reference-game-browser.ts`), and the two halves are two producer seams: when the GAME
 * one fails, the root answers the complete Chat half and NO `game` member at all, and the session it was
 * read on stays alive; when the CHAT one fails there is no conversation to draw, and the root is refused
 * as a whole. The Chat half also has a route of its own (`GET /api/tavern/v1/state`: the same
 * `TavernStateSnapshotV1` the root carries under `chat`, on the same broker session), which is the route a
 * Chat read takes when it means the Chat.
 *
 * Three readings, measured here:
 *
 *  - the MOUNT read is no longer the whole window. `/bootstrap` keeps the session it minted, so the
 *    conversation, the app bar, Settings and Memory stand while the Game surface states its own fault in
 *    its own panel (`[data-game-state="null"]`, `gameStateUnavailable`). The first journey mounts that
 *    root at 400x800 and 1440x900 and reads both the surfaces and the bar.
 *  - the reverse direction is still fatal, and must stay so: a root whose CHAT half cannot be read is a
 *    card and nothing else - there is no conversation to mount and no honest way to draw one - so the
 *    same page refuses it as the whole window (`409 {code: "state_unavailable",
 *    cause: "chat_projection_failed"}`). The second journey is that reading.
 *  - the World Info binding (`readProductWorldInfo`) is a Chat read that used to take the aggregate to
 *    learn `chat.selection.generation` and `chat.chat.worldInfo`, so a Game fault emptied the managed
 *    World Info library. It reads the Chat half's own route now, and the third journey is what fails when
 *    it goes back.
 *
 * `game: null` is a third answer and not this file's subject: it is a mount whose profile carries no Game
 * at all, and the reader tells it from "could not be read" by the member's own presence.
 */

const gameProjectionRefusal = {
  status: 409,
  contentType: "application/json",
  headers: { "x-gamebuddy-bootstrap-cause": "game_projection_failed" },
  body: JSON.stringify({ code: "state_unavailable", cause: "game_projection_failed" }),
};

const chatProjectionRefusal = {
  status: 409,
  contentType: "application/json",
  headers: { "x-gamebuddy-bootstrap-cause": "chat_projection_failed" },
  body: JSON.stringify({ code: "state_unavailable", cause: "chat_projection_failed" }),
};

const js = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Every read the Characters surface takes on mount, so the journey measures the read under test. */
async function stubCharactersSurface(page: Page): Promise<void> {
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(
      js({ apiVersion: 1, companions: [{ handle: chat.selection.chatHandle, name: "Mira", isCurrent: true }] }),
    ),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(js({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(js({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(js({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(js({ apiVersion: 1, entries: [] })));
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(js({ state: "none", revision: chat.selection.chatHandle, items: [] })),
  );
}

/**
 * The root a Host answers when its GAME half could not be read: the complete Chat half and no `game` member
 * at all (`readGameHalf` in `host/src/composed-reference-game-browser.ts` answers `undefined`, and the root
 * is built without the member).
 *
 * Not `game: null`: that is the mount whose profile carries no Game at all, and the difference is the point -
 * a client that flattened the absence into `null` could not tell "this build has no game" from "your game
 * could not be read".
 */
const gameUnreadableRoot = { apiVersion: 1, build: composedRoot.build, chat };

/** The two windows the shell has to stand in: a phone-width one and a desktop one. */
const VIEWPORTS = [
  { width: 400, height: 800 },
  { width: 1440, height: 900 },
] as const;

/**
 * One bar entry, pressed the way a player reaches it.
 *
 * At a narrow window the bar folds its trailing peers behind one `More` disclosure (`surface-chrome.spec.ts`
 * pins the fold), so an entry that is not on screen is opened from it rather than clicked through the hash.
 */
async function pressBarEntry(page: Page, name: string): Promise<void> {
  const entry = page.getByRole("button", { name, exact: true });
  if ((await entry.count()) === 0) await page.getByRole("button", { name: "More", exact: true }).click();
  await entry.click();
}

test("a Game half that cannot be read at mount leaves the conversation, the bar and the management surfaces standing", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let chatHalfReads = 0;
  let aggregateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(js(gameUnreadableRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    aggregateReads += 1;
    return route.fulfill(js(gameUnreadableRoot));
  });
  await page.route("**/api/tavern/v1/state", (route) => {
    chatHalfReads += 1;
    return route.fulfill(js(chat));
  });
  // The Game half's own authority still refuses: what was degraded is the ROOT, not the game's own route.
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(gameProjectionRefusal));

  for (const viewport of VIEWPORTS) {
    await test.step(`${viewport.width}x${viewport.height}`, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/#profile=composed-reference-game&boot=${token}`);

      // The window is the shell, not a card: a Game fault is the Game surface's.
      await expect(page.locator(".problem-view"), "a Game fault is not the window's problem").toHaveCount(0);
      const conversation = page.getByTestId("chat-surface");
      await expect(conversation).toBeVisible();
      await expect(conversation).toContainText("The game projection is read-only.");
      await expect(page.getByTestId("chat-problem"), "the conversation is not in a problem state").toHaveCount(0);
      // Usable, not merely painted: the composer is there and can take a line.
      await expect(page.locator(".composer-textarea")).toBeEditable();
      await expect(page.getByTestId("composer-send")).toBeVisible();

      // The bar is intact: its leading pair is on screen at both widths, and the peers behind the fold
      // are still there to reach.
      await expect(page.getByRole("button", { name: "Chat", exact: true }), "the bar keeps the conversation").toBeVisible();
      await expect(page.getByRole("button", { name: "Game", exact: true }), "the bar keeps the Game surface").toBeVisible();
      // Settings and Memory are the services a Game fault used to take with it.
      await pressBarEntry(page, "Settings");
      await expect(page.getByTestId("settings-surface")).toBeVisible();
      await pressBarEntry(page, "Memory");
      await expect(page.getByTestId("memory-surface")).toBeVisible();

      // ...and the Game surface is where the fault is stated, in its own panel.
      await pressBarEntry(page, "Game");
      const panel = page.getByTestId("game-state-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("data-game-state", "null");
      await expect(panel).toContainText("GameBuddy cannot read your game");
      await expect(
        page.locator(".problem-view"),
        "the Game panel states the fault; it does not become the window",
      ).toHaveCount(0);

      console.log(
        `MEASURE degraded-mount ${viewport.width}x${viewport.height}: problem-view=${await page.locator(".problem-view").count()} chat-surface=${await page.getByTestId("chat-surface").count()} chat-usable=${await page.locator(".composer-textarea").count()} game-panel-state=${await panel.getAttribute("data-game-state")} aggregateReads=${aggregateReads} chatHalfReads=${chatHalfReads}`,
      );
    });
  }
});

test("a Chat half that cannot be read at mount is still the whole window", async ({ page }) => {
  test.setTimeout(90_000);
  let chatHalfReads = 0;
  // The Host's own answer when the CHAT half is what failed, cause header included.
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(chatProjectionRefusal));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(chatProjectionRefusal));
  // ...while the Chat half's own route would answer perfectly well, if anything could still ask it.
  await page.route("**/api/tavern/v1/state", (route) => {
    chatHalfReads += 1;
    return route.fulfill(js(chat));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const card = page.locator(".problem-view");
  await expect(card, "a conversation that could not be read is the page").toHaveCount(1);
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  await expect(page.getByTestId("game-surface")).toHaveCount(0);
  // The one step a whole-window card can own: the read it came from, taken again.
  await expect(card.getByTestId("problem-retry-read")).toHaveCount(1);
  // The refusal retired the session, so the Chat half's own route cannot be asked either: the shell
  // cannot honestly draw a conversation it could not read, and this is the direction that stays fatal.
  expect(chatHalfReads, "a refused bootstrap left no session to read the Chat half on").toBe(0);

  const reading = await page.evaluate(() => {
    const root = document.querySelector(".problem-view");
    if (root === null) return "no problem-view";
    const texts = [...root.querySelectorAll("h1, h2, p")].map((node) => node.textContent?.trim() ?? "");
    return `texts=${JSON.stringify(texts)}`;
  });
  console.log(`MEASURE mount-chat-fault: problem-view=1 chat-surface=0 game-surface=0 ${reading}`);
});

test("a Game projection failure does not empty the world book the Chat owns", async ({ page }) => {
  test.setTimeout(90_000);
  let gameHalfBroken = false;
  let aggregateReads = 0;
  let chatHalfReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(js(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    aggregateReads += 1;
    return route.fulfill(gameHalfBroken ? gameProjectionRefusal : js(composedRoot));
  });
  await page.route("**/api/tavern/v1/state", (route) => {
    chatHalfReads += 1;
    return route.fulfill(js(chat));
  });
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(js(game)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(js({ apiVersion: 1, revision: 4, text: null })));
  await stubCharactersSurface(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const conversation = page.getByTestId("chat-surface");
  await expect(conversation).toBeVisible();
  await expect(conversation).toContainText("The game projection is read-only.");

  // The Game half breaks; the conversation does not.
  gameHalfBroken = true;
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  const worldBook = page.getByTestId("characters-surface").locator("[data-world-book]");
  await expect(worldBook, "the managed World Info library is on the surface").toBeVisible();
  const libraryRead = () => aggregateReads + chatHalfReads;
  await expect.poll(libraryRead, { message: "the binding took its read" }).toBeGreaterThan(0);
  // Which branch the library settled on. "empty" is the library, ready and holding nothing - where
  // every fresh product starts. "read-failed" is the library a Game fault took away, and there is
  // then nothing left for a conversation to attach its items from. The reading is a poll rather than
  // a negative count: a count of zero passes before the panel has drawn anything at all.
  const settled = () =>
    worldBook.evaluate((node) =>
      node.hasAttribute("data-world-book-read-failed")
        ? "read-failed"
        : node.querySelector("[data-world-book-empty]") !== null
          ? "empty"
          : node.querySelector("[data-world-book-list]") !== null
            ? "items"
            : "other",
    );
  await expect
    .poll(settled, { message: "a Game fault may not empty the World Info library the Chat owns" })
    .toBe("empty");

  // and the conversation is still the conversation.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(conversation).toBeVisible();
  await expect(conversation).toContainText("The game projection is read-only.");
  await expect(page.locator(".problem-view"), "a Game fault is not the window's problem").toHaveCount(0);
  console.log(
    `MEASURE world-book-with-game-fault: aggregateReads=${aggregateReads} chatHalfReads=${chatHalfReads} libraryReadFailed=${await worldBook.locator("[data-world-book-read-failed]").count()}`,
  );
});

test("a Chat projection failure writes nothing to the Game surface", async ({ page }) => {
  test.setTimeout(90_000);
  let chatHalfBroken = false;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(js(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(chatHalfBroken ? chatProjectionRefusal : js(composedRoot)),
  );
  await page.route("**/api/tavern/v1/state", (route) =>
    route.fulfill(chatHalfBroken ? chatProjectionRefusal : js(chat)),
  );
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(js(game)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(js({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(js({ apiVersion: 1, revision: 4, text: null })));
  await stubCharactersSurface(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  chatHalfBroken = true;
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface").locator("[data-world-book]")).toBeVisible();

  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel, "a Chat-side refusal may not take the Game surface").toBeVisible();
  await expect(page.locator(".problem-view"), "a Chat read failure is not the window's problem").toHaveCount(0);
  console.log(
    `MEASURE reverse-chat-fault: game-panel=${await panel.count()} problem-view=${await page.locator(".problem-view").count()}`,
  );
});
