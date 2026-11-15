/**
 * The app bar carries two facts, each with its own name: the model behind the conversation and the
 * game behind the companion.
 *
 * THE DEFECT (audit item 4). The bar had one badge, and everything it knew was the conversation's
 * model route (`appBarStatus`). A game that disconnected or crashed left the bar reading "Online" -
 * the one claim the player would check when the companion stopped answering in game - because the
 * game's own connection was never a fact the badge carried: `ComposedReferenceGameApp` says the
 * Game connection "has its own drawer ... it is not announced from here".
 *
 * WHAT IS ASSERTED:
 *
 *   1. an active connection and a connected game are TWO badges with two different accessible
 *      names - so a reader that hears "Online" is hearing about the model, and the game fact is
 *      its own word rather than the same light painted twice;
 *   2. a crashed game is stated as disconnected WHILE the model keeps its own word: the pair is
 *      independent, which is the whole point of splitting it;
 *   3. no game session draws no game dot at all (`game.connectionStatus === "none"`): an unlit
 *      badge and a green one must not be the only choices when the fact is "there is no game".
 */
import { type Page, expect, test } from "./frontend-coverage";
import { game, jsonOk, root, token } from "./composed-reference-game-fixtures";
import { messages } from "../src/i18n";

const catalogue = messages("en");
const connectionId = `${"E".repeat(42)}A`;

const ACTIVE_CONNECTION = {
  connectionId,
  label: "DeepSeek",
  providerLabel: "DeepSeek",
  modelId: "deepseek-v4-pro",
  modelLabel: "DeepSeek V4 Pro",
  thinkingLevel: "high",
  readiness: "ready",
  baseUrl: null,
  failure: null,
  lastCheckedAtMs: null,
};

const ACTIVE_CONNECTION_ROW = {
  connectionId,
  label: "DeepSeek",
  providerId: "deepseek",
  providerLabel: "DeepSeek",
  configured: true,
  readiness: "ready",
  active: true,
  modelId: "deepseek-v4-pro",
  modelLabel: "DeepSeek V4 Pro",
  thinkingLevel: "high",
  allowedThinkingLevels: ["high", "max"],
  modelIds: null,
  baseUrl: null,
  failure: null,
  lastCheckedAtMs: null,
};

const MODEL_PROFILES = {
  apiVersion: 1,
  recommendedModels: [],
  chat: { revision: 0, thinkingLevel: "high" },
  game: { revision: 0, thinkingLevel: "high" },
};

/** The composed root with the game in one connection state, the conversation's model always active. */
const rootWithGame = (connectionStatus: string) => ({
  ...root,
  game: { ...game, game: { ...game.game, connectionStatus } },
});

async function stub(page: Page, connectionStatus: string): Promise<void> {
  const projection = rootWithGame(connectionStatus);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: ACTIVE_CONNECTION,
        connections: [ACTIVE_CONNECTION_ROW],
        providers: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) => route.fulfill(jsonOk(MODEL_PROFILES)));
}

const modelBadge = (page: Page) => page.getByTestId("app-bar-model-status");
const gameBadge = (page: Page) => page.getByTestId("app-bar-game-status");

/** The success paint for the game dot, resolved from the token rather than transcribed. */
async function successPaint(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--success)";
    document.body.appendChild(probe);
    const success = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return success;
  });
}

test("a connected game and an active model are two badges with two names", async ({ page }) => {
  await stub(page, "connected_idle");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await expect(modelBadge(page)).toHaveAttribute("aria-label", catalogue.online);
  await expect(gameBadge(page)).toHaveAttribute("aria-label", catalogue.gameStatusConnected);
  expect(
    await modelBadge(page).getAttribute("aria-label"),
    "the two facts are two words, not one light painted twice",
  ).not.toBe(await gameBadge(page).getAttribute("aria-label"));
  // The game's own light: the shared success paint is the "connected" claim in the other channel.
  const success = await successPaint(page);
  const gameDot = gameBadge(page).locator(".status-dot");
  await expect(gameDot).toHaveCount(1);
  expect(await gameDot.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(success);
  console.log(
    `[app-bar-two-facts] model="${await modelBadge(page).getAttribute("aria-label")}" game="${await gameBadge(page).getAttribute("aria-label")}"`,
  );
});

test("a crashed game is disconnected while the model keeps its own word", async ({ page }) => {
  await stub(page, "failed");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await expect(gameBadge(page)).toHaveAttribute("aria-label", catalogue.gameStatusDisconnected);
  // The defect this item fixes: the old badge said "Online" here, because the game was not a fact
  // it carried. The model badge still says it - that half is true - and the game half does not.
  await expect(modelBadge(page)).toHaveAttribute("aria-label", catalogue.online);
  await expect(gameBadge(page).locator(".status-dot")).toHaveAttribute("data-tone", "danger");
});

test("no game session draws no game dot at all", async ({ page }) => {
  await stub(page, "none");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await expect(gameBadge(page), "the absence of a game is still stated").toHaveAttribute(
    "aria-label",
    catalogue.gameStatusNoSession,
  );
  await expect(gameBadge(page).locator(".status-dot"), "and nothing is lit for it").toHaveCount(0);
  await expect(modelBadge(page).locator(".status-dot"), "the model's own light is unaffected").toHaveCount(1);
});
