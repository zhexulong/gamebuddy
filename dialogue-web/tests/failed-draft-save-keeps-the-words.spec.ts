import { expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * A draft save the Host REFUSES costs the attempt, never the paragraph.
 *
 * Measured defect: the failure branch read the authoritative draft and seeded it straight back into
 * the composer, so a 409 (`draft_conflict` - the ordinary stale-tab case) or a network blip replaced
 * the sentence the player was still writing with whatever the Host happened to hold. The product rule
 * that forbids it is not subtle: user input must never be discarded on an API, validation or network
 * failure. The read itself was not the mistake - a refused write does mean this mount's revision is
 * stale, and the next save must be a compare-and-swap against what the Host really holds - so the
 * read-back is kept as the AUTHORITY and only the write into the composer is gone.
 *
 * The three facts asserted below, in the order the player meets them:
 *
 *  1. after the refusal the field still holds every word they typed;
 *  2. the refusal is stated, in the sentence its own code earns;
 *  3. the next save is the compare-and-swap the read-back was for - `expectedRevision` is the
 *     revision the Host just answered with, not the stale one this mount held - so the words can
 *     actually be saved instead of failing forever.
 *
 * A stub that accepted the first write would hide all of this behind an authority that already
 * agrees with the player, which is why the first write is refused.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const requestId = `${"R".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

/** What the player is writing: distinctive, unsaved, and the thing the product must not lose. */
const playerText =
  "Before the lamps are lit I want to write down the morning the mill was still turning with nobody at the wheel.";

/** What the Host holds instead: a different draft, at a revision this mount has never seen. */
const HOST_DRAFT_REVISION = 4;
const HOST_DRAFT_TEXT = "The Host's own copy, which the player never typed and never asked for.";

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
    title: "A refused draft save",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
    // No durable draft on this mount: the revision the player's save carries is 0.
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

test("a refused draft save keeps the typed words, states the refusal, and re-arms the next save", async ({ page }) => {
  test.setTimeout(120_000);
  const saves: { expectedRevision: number; text: string }[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonOk({ apiVersion: 1, revision: HOST_DRAFT_REVISION, text: HOST_DRAFT_TEXT }));
      return;
    }
    const body = route.request().postDataJSON() as { expectedRevision: number; text: string };
    saves.push({ expectedRevision: body.expectedRevision, text: body.text });
    if (saves.length === 1) {
      // The stale-tab conflict: this mount's revision is not the one the Host holds.
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Draft revision conflict",
          status: 409,
          code: "draft_conflict",
          requestId,
          retryable: false,
        }),
      });
      return;
    }
    await route.fulfill(jsonOk({ apiVersion: 1, revision: HOST_DRAFT_REVISION + 1, text: body.text }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  await composer.fill(playerText);
  const draftRow = surface.locator("[data-draft-actions]");
  const save = draftRow.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0], "the first save is the mount's own stale revision").toEqual({
    expectedRevision: 0,
    text: playerText,
  });

  // (2) The refusal is stated, in the sentence its own code earns rather than a generic one. It is
  // asserted before the field's own value on purpose: the refusal is the LATER of the two writers in
  // the defect (the read-back was seeded into the field first, then the notice was set), so waiting
  // for the sentence is what makes the composer assertion below read the settled screen instead of a
  // frame that had not re-rendered yet.
  const notice = draftRow.locator(".error-banner");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(messages("en").problemRevisionConflictDetail);
  // (1) THE DEFECT, and the fact that costs the player work they cannot get back: the words are
  // still in the field. Before this change the Host's copy replaced them.
  await expect(composer).toHaveValue(playerText);
  // The refusal did not become the page: the conversation and the composer are still there.
  await expect(page.locator(".problem-view")).toHaveCount(0);

  // (3) The read-back the refusal earned is re-used on the next attempt: the save is a compare-and-
  // swap against the revision the Host answered with, carrying the player's own words again.
  await save.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1], "the next save is the CAS the read-back was for, with the player's text").toEqual({
    expectedRevision: HOST_DRAFT_REVISION,
    text: playerText,
  });
  await expect(draftRow.locator(".success-banner")).toBeVisible();
  await expect(composer).toHaveValue(playerText);
});
