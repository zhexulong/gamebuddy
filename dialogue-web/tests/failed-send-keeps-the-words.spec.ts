import { expect, test } from "@playwright/test";

/**
 * A send the Host REFUSES costs the attempt, never the paragraph.
 *
 * Two facts have to hold together, and either alone is a half-fix: the player is told what
 * happened, and the field still holds every word they wrote. `payload_too_large` is the
 * refusal that makes the second fact load-bearing - its own sentence tells the player to
 * send a smaller text, which they cannot do without the text they just lost.
 *
 * The defect: `handleSend` clears the field before it awaits the send, and the failure path
 * replaced the whole shell with its problem page - so a refused send unmounted the composer
 * with the words inside it. `1b468db2` gave the text back on a retryable failure; the
 * non-retryable branch beside it still dropped it, and everything the shell drew went with it.
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "D".repeat(42) + "A";

/** The player's paragraph: long, distinctive, and the thing the product must not lose. */
const playerText =
  "Before the lamps are lit I want to tell you about the morning the mill was still turning with nobody at the wheel, " +
  "and how the whole lane smelled of cut wheat for a week afterwards, and how you said nothing at all about it.";

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  // `chat.submit` published as available is what makes the composer operable: the field's own
  // enablement is a projection of that operation, so a journey that must type has to publish it.
  operations: [{ operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" }],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "A refused send",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: handle, items: [] },
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

/** Every send in these journeys is answered by the refusal their own case describes. */
test.describe("a send the Host does not accept", () => {
  for (const outcome of [
    {
      name: "refused outright, with a next step the player can only take by editing the text",
      reply: { kind: "problem", status: 413, title: "Payload too large", code: "payload_too_large", retryable: false },
      sentence: "The request could not be taken as it was sent",
    },
    {
      name: "refused by an outage that retrying can cure",
      reply: { kind: "problem", status: 503, title: "Storage unavailable", code: "storage_unavailable", retryable: true },
      sentence: "One of GameBuddy's own services could not be used just now",
    },
    {
      // The failure `1b468db2` measured: no Host answer at all, just a dead connection.
      name: "lost before the Host ever answered",
      reply: { kind: "offline" },
      sentence: null,
    },
  ] as const) {
    test(`${outcome.name} keeps the words in the field beside the sentence`, async ({ page }) => {
      let sends = 0;
      await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
      await page.route("**/api/tavern/v1/draft", (route) =>
        route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
      );
      await page.route("**/api/tavern/v1/messages", async (route) => {
        sends += 1;
        if (outcome.reply.kind === "offline") {
          await route.abort("connectionfailed");
          return;
        }
        await route.fulfill({
          status: outcome.reply.status,
          contentType: "application/json",
          body: JSON.stringify({
            type: "about:blank",
            title: outcome.reply.title,
            status: outcome.reply.status,
            code: outcome.reply.code,
            requestId: handle,
            retryable: outcome.reply.retryable,
          }),
        });
      });

      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      const surface = page.getByTestId("chat-surface");
      await expect(surface).toBeVisible();
      const composer = surface.locator(".composer-textarea");
      await expect(composer).toBeEnabled();

      await composer.fill(playerText);
      await surface.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => sends).toBe(1);

      // The words are still there - the defect this file exists for, asserted first because it is
      // the one that costs the player something they cannot get back.
      await expect(composer).toHaveValue(playerText);
      // …and what happened is stated beside them, in the refusal's own words wherever the Host
      // named the refusal, rather than a generic "something went wrong".
      const notice = surface.locator(".reference-turn-notice");
      await expect(notice).toBeVisible();
      console.log(`MEASURE ${outcome.name}: notice=${JSON.stringify(await notice.innerText())}`);
      if (outcome.sentence !== null) await expect(notice).toContainText(outcome.sentence);
      await expect(composer).toBeEnabled();

      // The refusal did not become the page: the conversation stays readable, and nothing was
      // written into it as if the send had been accepted.
      await expect(page.locator(".problem-view")).toHaveCount(0);
      await expect(surface.locator(".message-list > li")).toHaveCount(1);
      await expect(surface.getByTestId("optimistic-player-message")).toHaveCount(0);
    });
  }
});
