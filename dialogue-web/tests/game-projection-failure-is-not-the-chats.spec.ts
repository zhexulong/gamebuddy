import { type Page, expect, test } from "./frontend-coverage";
import { chat, game, jsonOk, platform, root as composedRoot, tavernRefusal, token } from "./composed-reference-game-fixtures";

/**
 * A Game projection that cannot be read is not a conversation that cannot be read - and neither is the
 * reverse.
 *
 * The Host composes the Chat half and the Game half into ONE document (`readComposedRoot`,
 * `host/src/composed-reference-game-browser.ts`), and the two halves are two producer seams: when EITHER one
 * fails, the root answers the other half and NO member for the failed one, and the session it was read on stays
 * alive. The Chat half also has a route of its own (`GET /api/tavern/v1/state`: the same
 * `TavernStateSnapshotV1` the root carries under `chat`, on the same broker session), which is the read a Chat
 * fault's card takes again.
 *
 * Four readings, measured here:
 *
 *  - the GAME half's fault at mount is not the whole window. `/bootstrap` keeps the session it minted, so the
 *    conversation, the app bar, Settings and Memory stand while the Game surface states its own fault in its
 *    own panel (`[data-game-state="null"]`, `gameStateUnavailable`). The first journey mounts that root at
 *    400x800 and 1440x900 and reads both the surfaces and the bar.
 *  - the CHAT half's fault at mount is not the whole window either, and that direction is the one that used to
 *    be fatal in both halves at once: the card is drawn inside the Chat region (`[data-testid="chat-problem"]`)
 *    and the Game surface mounts and works beside it. The second journey is that reading, in one observation.
 *  - with both halves healthy the shell is the shell it always was: conversation, no card, Game surface
 *    reachable. The second journey starts there before it breaks the Chat half, so the pair is one run's two
 *    readings rather than two runs'.
 *  - the World Info binding (`readProductWorldInfo`) is a Chat read that used to take the aggregate to learn
 *    `chat.selection.generation` and `chat.chat.worldInfo`, so a Game fault emptied the managed World Info
 *    library. It reads the Chat half's own route now, and the third journey is what fails when it goes back.
 *
 * `null` is a third answer for either member and not this file's subject: it is a mount whose profile carries no
 * such surface at all, and the reader tells it from "could not be read" by the member's own presence.
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

/**
 * The root a Host answers when its CHAT half could not be read: the Game half, and no `chat` member at all.
 *
 * Not `chat: null`: that is the mount whose profile carries no Chat, and the difference is the same one the
 * Game half's absence has (`gameUnreadableRoot` below).
 */
const chatUnreadableRoot = { apiVersion: 1, build: composedRoot.build, platform, game };

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
const gameUnreadableRoot = { apiVersion: 1, build: composedRoot.build, platform, chat };

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

test("a Chat half that cannot be read at mount keeps the Game surface, and the card is the Chat region's", async ({ page }) => {
  test.setTimeout(120_000);
  /**
   * Whether the Chat half's own route can answer.
   *
   * It starts broken, because that is the world this journey is about: the root answered with no `chat` member at
   * mount, and the read the card offers is the same producer's. Flipping it is how the card's own step becomes a
   * real call rather than a control that cannot help - the same shape `problem-view-has-a-way-out.spec.ts` holds
   * for the window card.
   */
  let chatHalfAnswers = false;
  let chatHalfReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/state", (route) => {
    chatHalfReads += 1;
    // The Chat half's own route answers the SNAPSHOT the root carries under `chat`, not the root.
    return route.fulfill(chatHalfAnswers ? jsonOk(chat) : tavernRefusal(503, "runtime_unavailable", true));
  });
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(jsonOk(game)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: null })));
  await stubCharactersSurface(page);

  // Both halves healthy: the shell it always was, and no card anywhere.
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator("[data-testid='chat-problem']")).toHaveCount(0);
  await expect(page.locator(".problem-view")).toHaveCount(0);

  // The Host answers a root with the Game half and no Chat member - the answer `readChatHalf` gives when the
  // Chat producer throws or publishes something this Host cannot read.
  await page.unroute("**/api/composed-reference-game/v1/bootstrap");
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(chatUnreadableRoot)));
  // A goto that differs only in the fragment is a hash navigation, not a load: the page has to be left first, or
  // this reads the shell the first mount already committed.
  await page.goto("about:blank");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // The window is the shell, not a card: a Chat fault is the Chat region's.
  await expect(page.locator(".problem-view"), "a Chat fault is not the window's problem").toHaveCount(0);
  await expect(page.getByTestId("chat-surface"), "there is no conversation to draw").toHaveCount(0);
  const card = page.locator("main#main-content [data-testid='chat-problem']");
  await expect(card, "the Chat region holds the fault").toBeVisible();
  await expect(card.locator(".problem-card")).toBeVisible();
  // The bar is intact: both peers are still offered, and the Chat-owned ones are absent with their producer.
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Game", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);

  // ...and the Game surface mounts and works beside it. The card is still there, parked with its region: the two
  // peers hold their own states, and neither is the other's document.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel, "the Game surface is not the Chat half's subject").toBeVisible();
  await expect(panel).toHaveAttribute("data-game-state", "available");
  await expect(page.locator(".problem-view"), "the Game panel is not the window").toHaveCount(0);

  console.log(
    `MEASURE chat-half-unreadable: chat-problem=${await page.locator("[data-testid='chat-problem']").count()} chat-surface=${await page.getByTestId("chat-surface").count()} game-surface=${await page.getByTestId("game-surface").count()} whole-shell-problem=${await page.locator(".problem-view").count()} game-panel-state=${await panel.getAttribute("data-game-state")} chatHalfReads=${chatHalfReads}`,
  );

  // Arriving at the Chat region is a Chat read (`use-arrival-reread`), and it is refused: the Game surface is still
  // mounted afterwards, which is the direction this journey exists against.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect.poll(() => chatHalfReads, { message: "the arrival took the Chat half's read" }).toBeGreaterThan(0);
  await expect(card, "the refused read leaves the card where it was").toBeVisible();
  await expect(page.locator(".problem-view")).toHaveCount(0);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(panel, "a Chat arrival read did not take the Game surface").toBeVisible();

  // The card's own step is that read, and it is a real control: while the producer still refuses, the card stays
  // and says why; once it answers, the conversation mounts and the card goes with it.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const retry = card.getByTestId("problem-retry-read");
  await expect(retry).toBeVisible();
  const readsBefore = chatHalfReads;
  await retry.click();
  await expect.poll(() => chatHalfReads, { message: "the card's own control takes the read" }).toBeGreaterThan(readsBefore);
  await expect(card, "a refused read keeps the card").toBeVisible();

  chatHalfAnswers = true;
  await card.getByTestId("problem-retry-read").click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator("[data-testid='chat-problem']")).toHaveCount(0);
  console.log(
    `MEASURE chat-half-recovered: chat-half-reads=${chatHalfReads} chat-surface=${await page.getByTestId("chat-surface").count()} chat-problem=${await page.locator("[data-testid='chat-problem']").count()}`,
  );
});

/**
 * The same region, the other absence: a Chat half that really holds no conversation.
 *
 * It is a different fact from "could not be read" and the card words it differently - there is no read taken again
 * that would produce a conversation the Host does not hold - so the card offers no control and says where the step
 * is instead. The Game surface is here for the same reason: the absence of a conversation is not the absence of
 * the other surface.
 */
test("a root whose Chat half holds no conversation draws that card in the region, with no read to offer", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const noConversationRoot = { ...composedRoot, chat: { ...chat, chat: null } };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(noConversationRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(noConversationRoot)));
  await page.route("**/api/tavern/v1/state", (route) => route.fulfill(jsonOk({ ...chat, chat: null })));
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(jsonOk(game)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const card = page.locator("main#main-content [data-testid='chat-problem']");
  await expect(card).toBeVisible();
  await expect(card.locator(".problem-card")).toBeVisible();
  await expect(card, "the card names the missing conversation, not a failed read").toContainText("no chat");
  await expect(card.getByTestId("problem-retry-read"), "no read produces a conversation").toHaveCount(0);
  await expect(page.locator(".problem-view")).toHaveCount(0);
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);

  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-state-panel")).toBeVisible();
  console.log(
    `MEASURE chat-half-no-conversation: chat-problem=${await page.locator("[data-testid='chat-problem']").count()} chat-surface=${await page.getByTestId("chat-surface").count()} game-surface=${await page.getByTestId("game-surface").count()} whole-shell-problem=${await page.locator(".problem-view").count()} retry=${await card.getByTestId("problem-retry-read").count()}`,
  );
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
