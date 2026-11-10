import { expect, test } from "./frontend-coverage";

/**
 * A regenerate the Host REFUSES must hand the composer back.
 *
 * Regeneration starts a real turn, so it begins the way a send does: it publishes a pending
 * submission record (`beginTurnMutation`) and only then calls the Host. A refusal is the Host
 * stating that no turn was created - and `rereadChat`'s own settle rule looks for a TERMINAL
 * TURN, which a refusal never produces. So the record survived the read, the composer's phase
 * stayed `submitting`, and the band showed the spinner of a submission no turn backs: the field
 * disabled, no Send, no Stop, and nothing on this surface able to clear it short of switching
 * chats or reloading.
 *
 * The send path already answers this - its refusal branch spends the record it published
 * (`withPending(null)` beside the sentence). The regenerate path, which publishes the same
 * record through the same seam, did not. That asymmetry is the defect this journey encodes.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs: 1_900_000_000_000 },
  // `chat.submit` available is what admits a turn-starting mutation at all, and it is also what
  // tells the composer the Host would take one: a regenerate is gated on exactly this.
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "A refused regenerate",
    transcript: [
      { handle: playerHandle, role: "player", text: "Who is at the door?", locale: "und", order: 0, revision: 1 },
      { handle: companionHandle, role: "companion", text: "The miller, and he is early.", locale: "und", order: 1, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    // No turn: the refusal below creates none, which is the whole point.
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

test("a refused regenerate gives the composer back instead of leaving a spinner no turn backs", async ({ page }) => {
  test.setTimeout(120_000);
  let regenerates = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // Every read answers the same untouched projection: the Host holds no turn, and `chat.submit`
  // is still available - i.e. the refusal left nothing behind to settle.
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/messages/regenerate", async (route) => {
    regenerates += 1;
    // The Host answers, and its answer is a refusal: the store could not be used, so no turn ran.
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Storage unavailable",
        status: 503,
        code: "storage_unavailable",
        requestId: playerHandle,
        retryable: true,
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  // Regenerate is legal on the transcript's last row and it spoke: one press is the whole journey.
  const reply = surface.locator(".message-list > li").last();
  await reply.locator(".regenerate-btn").click();
  await expect.poll(() => regenerates).toBe(1);

  // The refusal's own sentence stands beside the conversation - it is the refusal that reached the
  // player, and it must not be replaced by a busy surface.
  const notice = surface.locator(".reference-turn-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("One of GameBuddy's own services could not be used just now");

  // THE DEFECT: the band stayed in `submitting` - a spinner for a submission the Host refused, with
  // the field locked and no Send to offer - because the pending record the refused regenerate
  // published outlived the refusal.
  const busy = surface.locator("[data-composer-busy]");
  const page1 = await page.evaluate(() => ({
    text: document.querySelector(".problem-view")?.textContent ?? null,
    busy: document.querySelectorAll("[data-composer-busy]").length,
    send: document.querySelectorAll("[data-testid=\"composer-send\"]").length,
    stop: document.querySelectorAll(".stop-button").length,
    fieldDisabled: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled ?? null,
    fieldValue: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.value ?? null,
  }));
  console.log(`MEASURE refused regenerate: ${JSON.stringify(page1)}`);

  await expect(busy).toHaveCount(0);
  await expect(surface.getByTestId("composer-send")).toHaveCount(1);
  await expect(composer).toBeEnabled();

  // …and it is not merely a frame: the state stays handable. A spinner that cleared on the next
  // render would be the same defect one poll hop later, because the record it reads is gone.
  await page.waitForTimeout(3_000);
  await expect(busy).toHaveCount(0);
  await expect(composer).toBeEnabled();
});
