import { expect, test } from "./frontend-coverage";

/**
 * The optimistic player line is shown by the position the turn was submitted at, not by the text.
 *
 * Measured defect: a player who sends a phrase the transcript already carries - "好的", "ok", "yes",
 * the answer to the same question a second time - saw the field clear and then NOTHING for the whole
 * turn. The rule that hid the pending line was
 *
 *   the authoritative transcript has not yet carried the same player line,
 *
 * implemented as a scan of the WHOLE transcript for a player row with equal text. The intent was the
 * row this turn will produce; the scan matched a row from ten turns ago, so the pending copy was
 * suppressed for the entire turn and the reply landed as if out of nowhere. The phrase being common
 * is the whole point: the fixture below carries the identical line in history and sends it again.
 *
 * There is no identity to key on instead: a committed `BrowserMessageV1` carries handle, role, text,
 * locale, order and revision and never the submission's idempotency key, and the pending record
 * carries no text or handle (it is content-free by contract). So the honest rule is positional - the
 * row this pending turn produces is the first one committed AFTER the transcript length the send was
 * accepted at - and the assertions below are what that rule has to satisfy:
 *
 *  - the pending line is visible while the transcript is still exactly as long as it was at submit;
 *  - it is visible even though an identical player line already sits in history;
 *  - it collapses to exactly one authoritative row per send (two identical lines afterwards, no
 *    third copy from the pending echo), so the pair still collapses as the send contract promises.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const earlierPlayerHandle = `${"P".repeat(42)}A`;
const sentPlayerHandle = `${"Q".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

/** The phrase already in history, and the phrase sent again. Identical on purpose. */
const repeatedLine = "好的";

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
    title: "A repeated line",
    transcript: [
      { handle: companionHandle, role: "companion", text: "Did you lock the gate?", locale: "und", order: 0, revision: 1 },
      // The row that used to suppress the pending echo: the same words, sent turns ago.
      { handle: earlierPlayerHandle, role: "player", text: repeatedLine, locale: "und", order: 1, revision: 1 },
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

test("a send of a phrase already in the transcript keeps its pending line until the reply lands", async ({ page }) => {
  test.setTimeout(120_000);
  let submitted = false;
  // The row the pending turn will produce, and the running turn that answers it.
  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      chat: {
        ...chat.chat,
        transcript: submitted
          ? [
              ...chat.chat.transcript,
              { handle: sentPlayerHandle, role: "player", text: repeatedLine, locale: "und", order: 2, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: submitted ? { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true } : null,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/messages", async (route) => {
    // Hold the submit so the pending line is observable before the Host answers.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    submitted = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: sentPlayerHandle, role: "player", text: repeatedLine, locale: "und", order: 2, revision: 1 },
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
  // The repeated line is in the reading flow before the send, so the assertion below cannot pass by
  // the transcript merely being empty.
  const history = surface.locator(".message-list > li", { hasText: repeatedLine });
  await expect(history).toHaveCount(1);

  await composer.fill(repeatedLine);
  await surface.getByRole("button", { name: "Send", exact: true }).click();

  // THE DEFECT: the pending line was suppressed by the identical row above, so the player watched an
  // emptied composer for the whole turn. It must be visible from the press, marked pending.
  const pending = surface.getByTestId("optimistic-player-message");
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("data-pending", "true");
  await expect(pending).toContainText(repeatedLine);
  // …and it is still not a second row of the authoritative list while it waits.
  await expect(history).toHaveCount(1);

  // The Host's row for this turn lands: the pending copy collapses into it, leaving exactly one row
  // per send. Two identical player lines, no third.
  await expect(pending).toHaveCount(0);
  await expect(history).toHaveCount(2);
  await expect(surface.locator(".message-list > li")).toHaveCount(3);
});
