import { type Page, expect, test } from "./frontend-coverage";
import { chat, game, jsonOk, root as composedRoot, token } from "./composed-reference-game-fixtures";

/**
 * A Game projection that cannot be read is not a conversation that cannot be read.
 *
 * The Host's shape is what makes the crossing possible: `readComposedRoot`
 * (`host/src/composed-reference-game-browser.ts`) composes the Chat half and then the Game half into
 * ONE document and throws `ControlledStateError("game_projection_failed")` when the Game half is the
 * one that failed - so both writers of that root (the `/bootstrap` that mints the session, and the
 * authenticated `/state`) answer `409 {code: "state_unavailable", cause: "game_projection_failed"}`
 * for a fault the conversation has no part in. The Chat half has a route of its own
 * (`GET /api/tavern/v1/state`: the same `TavernStateSnapshotV1` the root carries under `chat`, served
 * on the same broker session), and that is the route a Chat read takes when it means the Chat.
 *
 * Three reads, three different answers, measured here:
 *
 *  - the MOUNT read is the whole window. `/bootstrap` refuses and retires the session it had just
 *    minted (`if (session === activeSession) session = undefined`), so there is no region to draw a
 *    card in AND no session for the Chat half's own route to answer on: the first journey holds both
 *    facts, and they are the reason this direction has no client-side fix at all.
 *  - the World Info binding (`readProductWorldInfo`) is a Chat read that used to take the aggregate
 *    to learn `chat.selection.generation` and `chat.chat.worldInfo`, so a Game fault emptied the
 *    managed World Info library - the library the conversation ATTACHES its items from - while the
 *    conversation itself stayed perfectly readable. It reads the Chat half's own route now, and the
 *    second journey is what fails when it goes back.
 *  - the reverse direction is the same shape: a Chat projection that cannot be read must not take
 *    the Game surface away. `chat-problem-keeps-the-game-mounted.spec.ts` holds its own shape of
 *    that; this file holds the one a Chat-side refusal of the AGGREGATE produces.
 *
 * The mount cannot be decoupled from this side of the wire, and the two ends of that are worth
 * naming together: `readComposedRoot` throws for the Game half
 * (`host/src/composed-reference-game-browser.ts:1577`), and `handleBootstrap` answers that throw by
 * retiring the session it had just minted (`:1703`, `if (session === activeSession) session =
 * undefined`) - so the refusal arrives with no session left for the Chat half's own route to answer
 * on. That pair, not a missing retry, is why the first journey measures `chatHalfReads` instead of
 * pressing a control: what a real fix needs is a `/bootstrap` that answers a root with no Game slice
 * and a session that survives it, plus a mount state that draws the shell with a degraded Game
 * panel. Neither is this client's to choose, so neither was built here.
 *
 * Two reds found while measuring, left where they belong and not fixed by this lane:
 *  - `world-book-entry-opens-without-cutting-the-line-above.spec.ts` item 30: its sensitivity probe
 *    assigns `scrollTop` on `.surface-content` and reads 0 - the container has no overflow at
 *    400x800 - and it fails identically against the pre-change source of the read this file pins.
 *  - `companion-activation.spec.ts:513` asserts `labels.unavailable`, which is `undefined`:
 *    `acc58ac4` renamed that key to `companionsUnreadable` in both catalogues, in the same commit
 *    that added the journey asserting it.
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

test("a Game projection failure at mount is the whole window, and it retires the session the Chat half's route needs", async ({
  page,
}) => {
  test.setTimeout(90_000);
  let chatHalfReads = 0;
  // The Host's own answer when the Game half is what failed, cause header included.
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(gameProjectionRefusal));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(gameProjectionRefusal));
  // ...while the Chat half's own route would answer perfectly well, if anything could still ask it.
  await page.route("**/api/tavern/v1/state", (route) => {
    chatHalfReads += 1;
    return route.fulfill(js(chat));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const card = page.locator(".problem-view");
  await expect(card, "the mount's own card is the page").toHaveCount(1);
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  await expect(page.getByTestId("game-surface")).toHaveCount(0);
  // The one step a whole-window card can own: the read it came from, taken again.
  await expect(card.getByTestId("problem-retry-read")).toHaveCount(1);
  // The fact the "decouple the shell" decision hangs on: the refusal retired the session, so the
  // Chat half's own route is not merely unused here - it cannot be asked at all.
  expect(chatHalfReads, "a refused bootstrap left no session to read the Chat half on").toBe(0);

  const reading = await page.evaluate(() => {
    const root = document.querySelector(".problem-view");
    if (root === null) return "no problem-view";
    const texts = [...root.querySelectorAll("h1, h2, p")].map((node) => node.textContent?.trim() ?? "");
    return `texts=${JSON.stringify(texts)}`;
  });
  console.log(`MEASURE mount-game-fault: problem-view=1 chat-surface=0 game-surface=0 ${reading}`);
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
