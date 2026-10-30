import { type Locator, type Page, expect, test } from "@playwright/test";
import { characterLabels } from "../src/components/character-domain-labels";

/**
 * A save her own world book refuses must leave the editor able to save again, with her words
 * still in it.
 *
 * The defect: `CompanionWorldBookSection.submit` CASed every save on the revision `beginEdit`
 * snapshotted, and a refusal only re-read the book into the reading list - the draft's own
 * `expectedRevision` was never written again. So one `companion_world_book_conflict` (another
 * tab, or her card re-imported, between the read and the save) left the editor resending the
 * revision that had already lost: every press of save was refused identically, forever, until
 * the editor was closed and reopened. The comment above `submit` even stated the deadlock as
 * intent ("the editor keeps the revision it was opened on").
 *
 * The invariant encoded here is the one the family needs: the value a save CASes on follows the
 * authority, and the entries never do - they are what the player wrote. So the journeys below
 * assert, for every shape a refusal can take:
 *
 *  - the refusal is reported in the catalogue's own sentence for it, not swallowed;
 *  - the editor is still open with the player's text in it (nothing may trade her words for a
 *    re-read);
 *  - after a conflict, the next save carries the revision the re-read returned and lands. That
 *    last one is the assertion the old code failed: it can pass only if the conflict moved the
 *    draft's CAS basis.
 *
 * The stubs serve the book in the exact shape the client mirror validates (`isCompanionWorldBook`
 * in `management-pipeline-api.ts`): a projection with a field too many or too few is rejected
 * whole, the block then renders as absent, and the journey would be measuring the fixture.
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    chat: {
      companion: { name: "Amber", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: { state: "none", revision: handle, items: [] },
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken,
    browserSession: { expiresAtMs },
    game: {
      prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
      instance: { status: "none", gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      actionAuthority: "unavailable",
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: { available: false, count: 0 },
      latestOutcome: "none",
    },
  },
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** A validated problem, shaped exactly as the Host's `problemFor` emits one. */
const problem = (status: number, code: string, title: string, retryable: boolean) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ type: "about:blank", title, status, code, requestId: csrfToken, retryable }),
});

/** One save as the editor put it on the wire. */
type Save = Readonly<{
  expectedRevision: number;
  entries: readonly { title: string; keys: readonly string[]; constant: boolean; content: string }[];
}>;

/** Everything the Characters surface reads on mount, except the book under test. */
async function stubSurface(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Amber", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: handle, items: [] })),
  );
}

/** The block's editor, opened the way a player opens it. */
async function openEditor(page: Page): Promise<{
  block: Locator;
  editor: Locator;
  body: Locator;
  save: Locator;
  notice: Locator;
}> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  const block = surface.locator("[data-companion-world-book]");
  await expect(block).toBeVisible();
  await block.locator("[data-companion-world-book-edit]").click();
  const editor = block.locator("[data-companion-world-book-draft]");
  await expect(editor).toBeVisible();
  return {
    block,
    editor,
    body: editor.locator("textarea").first(),
    save: block.locator("[data-companion-world-book-save]"),
    notice: block.locator("[data-companion-world-book-notice]"),
  };
}

const labels = characterLabels("en");
const playerText = "The glass was hers, chosen one winter.";

/**
 * The deadlock itself: the book moved on under the save, the refusal says so, and the SECOND
 * save lands because it carries the revision the re-read returned.
 */
test("a world book conflict moves the save onto the revision the re-read found, so the next save lands", async ({
  page,
}) => {
  // What the panel read: revision 7, one entry.
  const opened = {
    apiVersion: 1,
    present: true,
    revision: 7,
    entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." }],
  };
  // What another writer left behind while the editor was open: the same entry, rewritten.
  const theirs = {
    apiVersion: 1,
    present: true,
    revision: 8,
    entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Rewritten elsewhere." }],
  };
  let durable: Record<string, unknown> = opened;
  const saves: Save[] = [];
  const refusedRevisions: number[] = [];
  await stubSurface(page);
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(durable));
      return;
    }
    const body = route.request().postDataJSON() as Save;
    saves.push(body);
    if (body.expectedRevision !== 8) {
      // The first save is refused: the book it CASed on is no longer the book that is there.
      refusedRevisions.push(body.expectedRevision);
      durable = theirs;
      await route.fulfill(problem(409, "companion_world_book_conflict", "World book revision conflict", false));
      return;
    }
    durable = { apiVersion: 1, present: true, revision: 9, entries: body.entries };
    await route.fulfill(jsonOk(durable));
  });

  const { body, save, notice, editor } = await openEditor(page);
  await body.fill(playerText);
  await save.click();

  // The refusal is worded with the catalogue's own sentence for that code, not swallowed.
  await expect(notice).toHaveText(labels.companionWorldBookConflict);
  await expect(editor).toBeVisible();
  // Her words are untouched by the read-back: the read is the revision's authority, not the text's.
  await expect(body).toHaveValue(playerText);
  expect(refusedRevisions, "the first save CASed on the revision the editor was opened on").toEqual([7]);

  // The half that was broken: pressing save again must not resend 7. It carries 8, which the
  // book now holds, so it lands.
  await save.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]!.expectedRevision, "the retry CASes on the revision the re-read returned").toBe(8);
  expect(saves[1]!.entries[0]!.content, "the retry carries the text the player wrote").toBe(playerText);
  await expect(notice).toHaveText(labels.saved);
  await expect(editor).toHaveCount(0);
});

/**
 * A refusal that is not a conflict leaves the CAS basis alone - there is nothing to rebase onto -
 * and still keeps her words.
 */
test("a non-conflict refusal keeps the editor and its text, and does not move the revision", async ({ page }) => {
  const book = {
    apiVersion: 1,
    present: true,
    revision: 4,
    entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." }],
  };
  const saves: Save[] = [];
  await stubSurface(page);
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(book));
      return;
    }
    saves.push(route.request().postDataJSON() as Save);
    await route.fulfill(problem(400, "authored_content_invalid", "Authored content invalid", false));
  });

  const { body, save, notice, editor } = await openEditor(page);
  await body.fill(playerText);
  await save.click();

  await expect(notice).toHaveText(labels.companionWorldBookInvalid);
  await expect(editor).toBeVisible();
  await expect(body).toHaveValue(playerText);
  expect(saves[0]!.expectedRevision).toBe(4);
});

/**
 * A refusal the network caused, and then a re-read that also fails: the surface must keep
 * showing the book it has and the editor over it. Re-rendering as "she has no book" because one
 * re-read failed unmounts the editor - and the player's unsigned entries with it.
 */
test("an unreachable Host keeps the editor and the text instead of unmounting them", async ({ page }) => {
  const book = {
    apiVersion: 1,
    present: true,
    revision: 6,
    entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." }],
  };
  let reachable = true;
  await stubSurface(page);
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (!reachable) {
      await route.abort("connectionfailed");
      return;
    }
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(book));
      return;
    }
    // The save itself kills the connection, and the re-read that follows cannot reach the Host either.
    reachable = false;
    await route.abort("connectionfailed");
  });

  const { body, save, notice, editor } = await openEditor(page);
  await body.fill(playerText);
  await save.click();

  // The generic sentence, because no Host answer named a code - and the refusal is still reported.
  await expect(notice).toBeVisible();
  await expect(editor, "the editor survives a Host it cannot reach").toBeVisible();
  await expect(body).toHaveValue(playerText);
  await expect(body).toBeEnabled();
});

/**
 * The row the player was editing is gone from the book the re-read found. Her version stays - the
 * editor is the only place it exists - and the notice says the book no longer has that row, so
 * the next save is not a silent resurrection she did not ask for.
 */
test("a row the book no longer has stays in the editor, and the notice names it", async ({ page }) => {
  const book = {
    apiVersion: 1,
    present: true,
    revision: 2,
    entries: [
      { title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." },
      { title: "Sprinkler", keys: ["sprinkler"], constant: false, content: "The one she fixed." },
    ],
  };
  const afterTheirEdit = {
    apiVersion: 1,
    present: true,
    revision: 3,
    entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." }],
  };
  let durable: Record<string, unknown> = book;
  const saves: Save[] = [];
  await stubSurface(page);
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(durable));
      return;
    }
    const body = route.request().postDataJSON() as Save;
    saves.push(body);
    if (body.expectedRevision === 2) {
      durable = afterTheirEdit;
      await route.fulfill(problem(409, "companion_world_book_conflict", "World book revision conflict", false));
      return;
    }
    durable = { apiVersion: 1, present: true, revision: 4, entries: body.entries };
    await route.fulfill(jsonOk(durable));
  });

  const { block, editor, save, notice } = await openEditor(page);
  await expect(editor.locator("[data-companion-world-book-entry-draft]")).toHaveCount(2);
  await editor.locator("textarea").nth(1).fill("The sprinkler is the one she fixed herself.");
  await save.click();

  // Both rows are still the editor's: the one the book lost was not silently dropped from the
  // draft, and its text is still readable and editable.
  await expect(editor).toBeVisible();
  await expect(editor.locator("[data-companion-world-book-entry-draft]")).toHaveCount(2);
  await expect(editor.locator("textarea").nth(1)).toHaveValue("The sprinkler is the one she fixed herself.");
  await expect(notice).toContainText(labels.companionWorldBookConflict);
  await expect(notice).toContainText(
    labels.companionWorldBookConflictEntryGone.replace("{{titles}}", "Sprinkler"),
  );
  // The reading list is the book that is actually there - that is the read the notice is about.
  await expect(block.locator("[data-companion-world-book-count]")).toHaveText(
    labels.companionWorldBookCount.replace("{{count}}", "1"),
  );

  // Saving again puts her version of that row back, on the revision the re-read returned.
  await save.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]!.expectedRevision).toBe(3);
  expect(saves[1]!.entries.map((entry) => entry.title)).toEqual(["Greenhouse", "Sprinkler"]);
  await expect(notice).toHaveText(labels.saved);
});

/** The code the panel words is the code the Host sent; nothing is concatenated into the sentence. */
test("the conflict sentence is the product's, with no code-shaped token in it", async ({ page }) => {
  await stubSurface(page);
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(
        jsonOk({
          apiVersion: 1,
          present: true,
          revision: 5,
          entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." }],
        }),
      );
      return;
    }
    await route.fulfill(problem(409, "companion_world_book_conflict", "World book revision conflict", false));
  });

  const { editor, save, notice } = await openEditor(page);
  await editor.locator("textarea").first().fill("The glass was chosen one winter.");
  await save.click();

  await expect(notice).toBeVisible();
  expect(await notice.innerText()).not.toMatch(/[a-z]+_[a-z_]+/u);
  expect(await notice.innerText()).toBe(labels.companionWorldBookConflict);
});
