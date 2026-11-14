import { expect, test } from "./frontend-coverage";

/**
 * The Enter that confirms a Chinese, Japanese or Korean candidate must not send the message.
 *
 * The measured defect: a player typing in a character input method confirms a candidate with the
 * same key the composer sends with, so the half-finished line went out mid-composition and the
 * candidate list stayed open on an empty field. The guard that fails this is the one that reads
 * `KeyboardEvent.isComposing` alone - it is false on the confirming keydown in WebKit (bug 165004),
 * and the field then reads a plain Enter. What Chromium, Firefox and WebKit all report is the
 * virtual key code of a key the input method processed, `VK_PROCESSKEY` (229), so the guard is
 * `isImeProcessingKey` (`src/components/ime-composition.ts`) and this journey drives both facts
 * exactly as the browser delivers them.
 *
 * The three readings, in the order they can go wrong:
 *
 *  1. a composing Enter (`isComposing` false, `keyCode` 229 - the Safari ordering) sends nothing:
 *     the field keeps the words, and no pending row appears, which is the same instant the
 *     optimistic echo would be on screen;
 *  2. a plain Enter still sends - the same field, the same mount, so the first reading cannot pass
 *     by the composer having stopped working;
 *  3. Shift+Enter still inserts a newline rather than sending, which is what a bare Enter's default
 *     action was before the guard and must stay.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const sentPlayerHandle = `${"Q".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

/** The line the player is still composing, and the line they confirm before sending. */
const composed = "你好";
const sent = "好了";

const chat = {
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
    title: "A composed line",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The gate is open.", locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: chatHandle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test("a composing Enter keeps the message and a plain Enter still sends it", async ({ page }) => {
  test.setTimeout(120_000);
  let submitted = "";
  let postAttempts = 0;
  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      chat: {
        ...chat.chat,
        transcript: [
          ...chat.chat.transcript,
          ...(submitted === ""
            ? []
            : [{ handle: sentPlayerHandle, role: "player", text: submitted, locale: "und", order: 1, revision: 1 }]),
        ],
        turn:
          submitted === ""
            ? null
            : { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/messages", async (route) => {
    postAttempts += 1;
    submitted = (route.request().postDataJSON() as { text: string }).text;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: sentPlayerHandle, role: "player", text: submitted, locale: "und", order: 1, revision: 1 },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  // 3. Shift+Enter is a newline in the field, not a send. Asserted first, so the IME reading below
  // cannot pass by the composer having lost its Enter paths altogether.
  await composer.fill("一是");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("一是\n");
  expect(postAttempts).toBe(0);

  // 1. The Safari ordering: the composition is open, its confirming keydown arrives with
  // `isComposing` already false, and only `keyCode` 229 still says the input method handled it.
  await composer.fill(composed);
  await composer.evaluate((field) => {
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: false, bubbles: true, cancelable: true }),
    );
  });
  await expect(composer).toHaveValue(composed);
  // The pending echo is on screen the instant a send is accepted, so its absence is the immediate
  // proof that nothing was submitted - no polling window is doing the work here.
  await expect(surface.getByTestId("optimistic-player-message")).toHaveCount(0);
  expect(postAttempts).toBe(0);

  // 2. A plain Enter, with no composition open, is still the send. The same mount, the same field.
  await composer.fill(sent);
  await composer.press("Enter");
  await expect.poll(() => postAttempts).toBe(1);
  await expect(surface.locator(".message-list > li", { hasText: sent })).toHaveCount(1);
  await expect(composer).toHaveValue("");
});
