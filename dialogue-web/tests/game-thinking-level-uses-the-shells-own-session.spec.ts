/**
 * The Game surface's own thinking level is written on the shell's one session - not on a Chat's.
 *
 * The claim this file settles: "the Game surface must borrow a Chat session's CSRF token to change
 * its own agent's thinking level", because global settings live under `/api/tavern/v1/...`.
 *
 * Measured, twice over:
 *
 *  - the token the Game surface presents is the composed broker's own session token - the one value
 *    `/bootstrap` and `/state` publish, and the one the management routes' delegated admission
 *    verifies (`admitRequest` -> `verifyComposedReferenceGameBrowserAuth`). It lives on the Chat
 *    half of the composed root because that is where the wire's `TavernStateSnapshotV1` carries it -
 *    the root's shape, not a Chat-owned precondition: the Chat surface is not the subject of the
 *    write, is not read for it, and the same token is what the conversation's own Settings writes
 *    carry.
 *  - the write lands while the conversation's own read (`/state`) is refused, which a route that
 *    needed a mounted Chat could not do.
 *
 * Both are read off the request the browser actually makes, so this is a measurement of the wire
 * rather than of the module's wording. `/api/tavern/v1/` is tavern-*named*: `management-pipeline-api.ts`
 * says what gates it.
 */
import { expect, test, type Page, type Route } from "./frontend-coverage";
import { game, jsonOk, root, token, stubGameRead } from "./composed-reference-game-fixtures";

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

/** The Host's model-profile record: one durable row per surface. */
function profilesFor(thinkingLevel: string) {
  return {
    apiVersion: 1,
    chat: { revision: 1, thinkingLevel: "off" },
    game: { revision: 1, thinkingLevel },
    recommendedModels,
  };
}

/** One mounted session's view of the two model-profile routes: what was asked, and with what. */
type ProfileWire = Readonly<{
  writes: ReadonlyArray<{ headers: Record<string, string>; body: Record<string, unknown> }>;
}>;

async function mountWithProfiles(page: Page, thinkingLevel: string): Promise<ProfileWire> {
  const writes: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: null })));
  await stubGameRead(page);
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
  // The conversation's own model route and the surfaces' preference reads: answered so nothing the
  // shell draws is an unstubbed 404 (which is indistinguishable from a refusal in this journey).
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/profiles", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonOk(profilesFor(thinkingLevel)));
      return;
    }
    writes.push({
      headers: route.request().headers(),
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    await route.fulfill(jsonOk(profilesFor("high")));
  });
  return { writes };
}

/** The Game surface's own editor. */
function gameEditor(page: Page) {
  return page.getByTestId("game-surface").locator('.surface-model-settings[data-surface="game"]');
}

test("the Game surface's thinking level is written on the shell's one session token", async ({ page }) => {
  test.setTimeout(90_000);
  const wire = await mountWithProfiles(page, "low");

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const editor = gameEditor(page);
  await expect(editor).toBeVisible();

  await editor.getByLabel("Thinking level").selectOption("high");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => wire.writes.length).toBe(1);

  const write = wire.writes[0]!;
  console.log(
    `MEASURE game-thinking-level: surface=${String(write.body.surface)} ` +
      `level=${String(write.body.thinkingLevel)} token=${write.headers["x-csrf-token"] === game.csrfToken ? "shell session" : "other"}`,
  );
  // The token the Game surface presents is the composed root's own session token - the one value
  // `/bootstrap` publishes on its Chat half, and the one the management mount admits.
  expect(write.headers["x-csrf-token"], "the shell's own session token").toBe(game.csrfToken);
  expect(write.body).toEqual({ apiVersion: 1, surface: "game", expectedRevision: 1, thinkingLevel: "high" });
  await expect(editor.locator("[data-model-notice]")).toHaveText(
    "Saved. It applies the next time that surface's runtime starts.",
  );
});

test("the same write lands while the conversation's own read is refused", async ({ page }) => {
  test.setTimeout(90_000);
  const wire = await mountWithProfiles(page, "low");
  // From here on the conversation cannot be re-read at all: `/state` answers the Host's refusal for
  // a projection it could not build. A route that needed a mounted Chat could not be written.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable", cause: "chat_projection_failed" }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const editor = gameEditor(page);
  await expect(editor).toBeVisible();

  await editor.getByLabel("Thinking level").selectOption("high");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => wire.writes.length).toBe(1);
  console.log(`MEASURE game-thinking-level: writes=${wire.writes.length} with the conversation unreadable`);
  await expect(editor.locator("[data-model-notice]")).toHaveText(
    "Saved. It applies the next time that surface's runtime starts.",
  );
});
