/**
 * The platform's own facts outlive whichever halves the mount could read - and a root without them says so.
 *
 * WHY THIS FILE EXISTS. The shell's CSRF token, the appearance it paints itself in, the interface language and the
 * connection directory were all read out of the Chat half: the token was `session.snapshot.csrfToken`, and the two
 * preferences were the Chat's own settings routes. That is fine while a Chat half exists, and it is exactly what a
 * mount with no readable Chat half cannot do - which `d045d506` made expressible and left unsolved. The platform is
 * now a member of the composed root in its own right (`readPlatformMember` in
 * `host/src/composed-reference-game-browser.ts`), carrying the session, the two page-level preferences and whether
 * this Host has a connection directory at all.
 *
 * Three readings, all off one mount:
 *
 *  1. A MOUNT WITH NO CHAT HALF AT ALL (`chat` omitted, `game` omitted: a profile that mounts neither surface) still
 *     renders the shell. The bar is there, the two regions state their own absences, the document is painted in the
 *     appearance and language the PLATFORM member carried, and nothing on the page reads `undefined`.
 *  2. A CHAT-ABSENT MOUNT'S MANAGEMENT PEERS CAN STILL AUTHENTICATE. The Game surface's thinking level is a
 *     management write (`PUT /api/tavern/v1/settings/profiles`) and it is made on a root that carries no `chat`
 *     member at all; the header it carries is the platform's session token.
 *  3. THE NEGATIVE. A root with no `platform` member is not drawn as six surfaces with `undefined` behind them: the
 *     shell states the absence by name (`[data-testid="platform-problem"]`), draws no peer, and offers the step the
 *     catalogue names for a page this Host cannot arm.
 */
import { messages } from "../src/i18n";
import { type Page, type Route, expect, test } from "./frontend-coverage";
import { game, jsonOk, platform, root as composedRoot, token } from "./composed-reference-game-fixtures";

/** The appearance and the language the platform member carries: both differ from the OS and the browser. */
const chosenPlatform = {
  ...platform,
  preference: { revision: 3, appearance: "dark", locale: "zh-CN" },
};

/** The root a Host answers for a mount with NO Chat half at all: the platform and the Game half. */
const chatlessRoot = {
  apiVersion: composedRoot.apiVersion,
  build: composedRoot.build,
  platform: chosenPlatform,
  game,
};

/** The same mount speaking the other catalogue: the panel's own labels are then the English ones. */
const englishChatlessRoot = {
  ...chatlessRoot,
  platform: { ...chosenPlatform, preference: { ...chosenPlatform.preference, locale: "en" as const } },
};

/** A root this page cannot arm: the Host answered, and it published no platform member at all. */
const platformlessRoot = {
  apiVersion: composedRoot.apiVersion,
  build: composedRoot.build,
  chat: composedRoot.chat,
  game,
};

const recommendedModels = [
  {
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    modelId: "deepseek-v4",
    modelLabel: "DeepSeek V4",
    allowedThinkingLevels: ["off", "low", "high", "max"],
    defaultThinkingLevel: "low",
  },
];

const profilesFor = (thinkingLevel: string) => ({
  apiVersion: 1,
  chat: { revision: 1, thinkingLevel: "off" },
  game: { revision: 1, thinkingLevel },
  recommendedModels,
});

/**
 * Every route the shell reads on the way to a settled page, and the one write this file measures.
 *
 * The Game surface's editor is its own component (`SurfaceModelSettings surface="game"`), so it reads the two
 * model-profile records and writes one of them - and the write is the management call this file is about.
 */
async function stubRoutes(
  page: Page,
  answerRoot: () => unknown,
): Promise<Readonly<{ writes: Array<Record<string, string>> }>> {
  const writes: Array<Record<string, string>> = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(answerRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(answerRoot())));
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(jsonOk(game)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/settings", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 0,
        families: [],
        advanceDayMinimumOnlineFarmers: 1,
        appliesToRunningGame: {
          actionPolicy: "within_seconds",
          advanceDayMinimumOnlineFarmers: "next_world_load",
          windowMode: "within_seconds",
          deniedActions: "within_seconds",
        },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: null })));
  // The platform's own two routes: a panel that re-reads either asks here, never the Chat half's settings.
  await page.route("**/api/platform/v1/appearance", (route) =>
    route.fulfill(jsonOk({ revision: chosenPlatform.preference.revision, appearance: "dark" })),
  );
  await page.route("**/api/platform/v1/locale", (route) =>
    route.fulfill(jsonOk({ revision: chosenPlatform.preference.revision, locale: "zh-CN" })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale: "en-US" })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({
        revision: 1,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(jsonOk({ devices: [] })));
  await page.route("**/api/tavern/v1/settings/profiles", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonOk(profilesFor("low")));
      return;
    }
    writes.push(route.request().headers());
    await route.fulfill(jsonOk(profilesFor("high")));
  });
  return { writes };
}

/** What the page paints itself with, and whether anything on it is a missing value rendered as text. */
async function readPage(page: Page) {
  return await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      lang: document.documentElement.lang,
      declaresUndefined: /undefined|\[object Object\]|NaN/u.test(body),
    };
  });
}

test("a Chat-absent mount still renders the shell, painted and speaking by the platform", async ({ page }) => {
  test.setTimeout(90_000);
  await stubRoutes(page, () => chatlessRoot);
  const chinese = messages("zh-CN");

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // The window is the shell and nothing else: no whole-window card, and no platform card either - the member is
  // here, so the Chat region states its own absence and every other peer keeps its place.
  await expect(page.locator(".problem-view")).toHaveCount(0);
  await expect(page.getByTestId("platform-problem")).toHaveCount(0);
  await expect(page.locator(".tavern-app-shell")).toBeVisible();
  await expect(page.getByTestId("chat-problem"), "there is no conversation to draw").toBeVisible();
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  // The bar is the shell's, and both peers are still offered - in the language the platform carried.
  await expect(page.getByRole("button", { name: chinese.chatPanel, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: chinese.gamePanel, exact: true })).toBeVisible();

  const painted = await readPage(page);
  console.log(`MEASURE chatless-mount: theme=${painted.theme} lang=${painted.lang} undefined=${painted.declaresUndefined}`);
  expect(painted.theme, "the appearance the platform member carried is the one painted").toBe("dark");
  expect(painted.lang, "and the interface language it carried is the one applied").toBe("zh-CN");
  expect(painted.declaresUndefined, "nothing on the page is a missing value rendered as text").toBe(false);
  console.log(
    `MEASURE chatless-mount: problem-view=${await page.locator(".problem-view").count()} ` +
      `platform-problem=${await page.getByTestId("platform-problem").count()} ` +
      `chat-problem=${await page.getByTestId("chat-problem").count()} ` +
      `chat-member=${String("chat" in chatlessRoot)}`,
  );
});

test("a Chat-absent mount's management peers authenticate on the platform's token", async ({ page }) => {
  test.setTimeout(90_000);
  const wire = await stubRoutes(page, () => englishChatlessRoot);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // No `chat` member at all: the conversation's own region holds its card, and nothing else does.
  await expect(page.getByTestId("chat-problem")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  await expect(page.locator(".problem-view")).toHaveCount(0);
  const painted = await readPage(page);
  expect(painted.theme, "a Chat-absent mount is still painted in the player's appearance").toBe("dark");
  expect(painted.lang, "and still speaks the interface language the platform carried").toBe("en");

  await page.getByRole("button", { name: messages("en").gamePanel, exact: true }).click();
  const editor = page.getByTestId("game-surface").locator('.surface-model-settings[data-surface="game"]');
  await expect(editor, "the Game surface is not the Chat half's subject").toBeVisible();
  await editor.getByLabel("Thinking level").selectOption("high");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => wire.writes.length, { message: "the management write reached the Host" }).toBe(1);
  // The write is admitted under the PLATFORM member's token. On this root there is no `chat` member, so a shell
  // that took its token from the Chat half's snapshot had none to send.
  expect(wire.writes[0]?.["x-csrf-token"], "the platform's session token").toBe(chosenPlatform.csrfToken);
  await expect(editor.locator("[data-model-notice]")).toHaveText(messages("en").modelProfilesApplied);
  console.log(
    `MEASURE chatless-management-write: chat-member=${String("chat" in chatlessRoot)} ` +
      `writes=${wire.writes.length} token=${wire.writes[0]?.["x-csrf-token"] === chosenPlatform.csrfToken ? "platform" : "other"}`,
  );
});

test("a root with no platform member states it by name instead of drawing the surfaces", async ({ page }) => {
  test.setTimeout(90_000);
  await stubRoutes(page, () => platformlessRoot);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const card = page.locator("main#main-content [data-testid='platform-problem']");
  await expect(card, "the shell names the missing member").toBeVisible();
  await expect(card.locator(".problem-card")).toBeVisible();
  await expect(card, "and offers the step this Host's page has").toContainText("start GameBuddy again");
  // Nothing is drawn that would act on a token the root did not publish: the conversation is a Chat-half fact and
  // the Game surface needs the same session, so neither peer is mounted.
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  await expect(page.getByTestId("game-surface")).toHaveCount(0);
  // It is the region's card, not the window's: the shell itself is still here.
  await expect(page.locator(".tavern-app-shell")).toBeVisible();
  await expect(page.locator(".problem-view")).toHaveCount(0);
  const painted = await readPage(page);
  expect(painted.declaresUndefined, "no surface renders a value the root never published").toBe(false);
  console.log(
    `MEASURE platformless-mount: platform-problem=${await card.count()} ` +
      `chat-surface=${await page.getByTestId("chat-surface").count()} ` +
      `game-surface=${await page.getByTestId("game-surface").count()} ` +
      `whole-shell-problem=${await page.locator(".problem-view").count()} undefined=${painted.declaresUndefined}`,
  );
});
