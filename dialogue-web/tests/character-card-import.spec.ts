/**
 * The Characters surface: importing a card, and what the Host did with it.
 *
 * Importing is a file picker whose result is the Host's own staged report - never a local
 * guess - a refusal is reported as a failure rather than as a new companion, cancelling
 * imports nothing, accepted lorebook entries land on the character's own view beside its world
 * book, and an opening variant is stored with the character and read back with it.
 */
import { expect, test } from "./frontend-coverage";
import { token, characterHandle, csrfToken, jsonOk } from "./composed-reference-game-fixtures";
import {
  importIdHandle,
  stubCharacterReads,
  stagedCard,
  stubImportSuccess,
  openCharactersSurface,
  chooseCardFile,
} from "./character-card-fixtures";

/**
 * "choosing a character card file stages a review the player approves, and
 * reports what the Host kept and could not use" fails if the primary path is not
 * a real file input (the owner's complaint: a staged review ceremony *instead of*
 * a picker), if choosing a file does not post the file's own text as
 * `character.import.stage`, if the Host's staged report is not what the player
 * sees before approving it, if anything is confirmed before that approval, if the
 * review is not the Host's own eligible field set, if confirm is not CSRF-bound,
 * if the notice claims a companion the Host never confirmed, or if the "could not
 * use" list is locally invented instead of read from the Host's dispositions.
 * It also pins that the paste path still produces the same durable result.
 */
test("choosing a character card file stages a review, and reports what the Host kept and could not use", async ({
  page,
}) => {
  const cardText = JSON.stringify({
    spec: "chara_card_v3",
    data: { name: "Nova", description: "A quiet astronomer." },
  });
  await stubCharacterReads(page);
  const { imports, reviews, confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  // The file picker is the primary path: the player chooses a file their own
  // browser reads; the card text is what the Host receives, and what comes back
  // is the Host's own staged report - not a companion yet.
  await chooseCardFile(page, cardText);
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await expect(review).toContainText("The card names it Nova.");
  await expect(review).toContainText("Will keep 2 card field entries: Name, Persona.");
  await expect(review).toContainText("Carries 2 lorebook entries.");
  await expect(review).toContainText("Could not use: Alternate opening.");
  await expect(surface.locator("[data-card-import-result=created]")).toHaveCount(0);
  expect(confirms.length, "the companion was confirmed before the player approved the review").toBe(0);
  expect(reviews.length, "a review was recorded before the player approved it").toBe(0);

  await review.locator("[data-card-import-review-confirm]").click();
  await expect.poll(() => confirms.length).toBe(1);

  expect(imports[0]?.body).toEqual({ apiVersion: 1, cardSource: "json", card: cardText });
  expect(imports[0]?.csrf).toBe(csrfToken);
  const reviewedFields = (body: unknown): unknown => (body as { reviewedFields?: unknown }).reviewedFields;
  expect(reviewedFields(reviews[0]?.body)).toEqual(["name", "persona_core"]);
  expect(reviews[0]?.csrf).toBe(csrfToken);
  expect(confirms[0]?.body).toEqual({ apiVersion: 1 });
  expect(confirms[0]?.csrf).toBe(csrfToken);

  const created = surface.locator("[data-card-import-result=created]");
  await expect(created).toContainText("Imported Nova.");
  await expect(created).toContainText("Kept 2 card field entries.");
  await expect(created).toContainText("Could not use: Alternate opening.");
  await expect(review).toHaveCount(0);

  // The secondary paste path produces the same durable result as the picker,
  // and it stages the same review: the paste button is not the approval either.
  await surface.locator("[data-card-import] summary").click();
  await surface
    .getByRole("textbox", { name: "Paste card text" })
    .fill(JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } }));
  await surface.getByRole("button", { name: "Import card" }).click();
  await expect(review).toBeVisible();
  expect(confirms.length).toBe(1);
  await review.locator("[data-card-import-review-confirm]").click();
  await expect.poll(() => confirms.length).toBe(2);
  expect(reviewedFields(reviews[1]?.body)).toEqual(reviewedFields(reviews[0]?.body));
  expect(confirms[1]?.body).toEqual(confirms[0]?.body);
});


/**
 * "a staged card can be cancelled without importing anything" fails if the
 * cancel leaves a companion behind, if it records a review, or if the surface
 * keeps claiming the staged card afterwards. The durable companion list is the
 * authority: the mount reads it once and nothing in this journey may change it.
 */
test("cancelling the staged review imports nothing and leaves the companion list unchanged", async ({ page }) => {
  const cardText = JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } });
  await stubCharacterReads(page, { companions: [{ handle: characterHandle, name: "Nova", isCurrent: true }] });
  const companionReads: unknown[] = [];
  await page.route("**/api/tavern/v1/companions", async (route) => {
    companionReads.push(route.request().method());
    await route.fulfill(
      jsonOk({ apiVersion: 1, companions: [{ handle: characterHandle, name: "Nova", isCurrent: true }] }),
    );
  });
  const { imports, reviews, confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");
  const readsBefore = companionReads.length;

  await chooseCardFile(page, cardText);
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await review.locator("[data-card-import-review-cancel]").click();

  // The staged card is dropped, nothing was confirmed and no review was signed.
  await expect(review).toHaveCount(0);
  expect(imports.length, "the card was staged").toBe(1);
  expect(reviews.length, "cancel recorded a review").toBe(0);
  expect(confirms.length, "cancel confirmed the card").toBe(0);
  await expect(surface.locator("[data-card-import-result=created]")).toHaveCount(0);
  // The durable companion list is unchanged: the same single companion, and not
  // one extra read of it either - a cancel is not a mutation.
  await expect(surface.locator("[data-companion-entry]")).toContainText("Nova");
  expect(companionReads.length).toBe(readsBefore);
});


/**
 * "a card's lorebook entries and the character's world book live in one place"
 * fails if the imported lorebook entries are not surfaced on the character's
 * own view, if the world book is still a separate peer surface, or if World
 * Info remains an AppBar entry after it was folded into Characters.
 */
test("a card whose lorebook entries import produces them on the character's own view, where its world book also lives", async ({
  page,
}) => {
  const cardText = JSON.stringify({
    spec: "chara_card_v3",
    data: {
      name: "Nova",
      description: "A quiet astronomer.",
      character_book: {
        entries: [
          { comment: "Observatory", content: "The hilltop observatory is open at night.", constant: true },
          { comment: "Comet", content: "A comet is expected next week.", keys: ["comet"] },
        ],
      },
    },
  });
  await stubCharacterReads(page, {
    companions: [{ handle: characterHandle, name: "Nova", isCurrent: true }],
    // What the Host would serve after this card was confirmed: the companion's
    // own world book, entry by entry, with the trigger words the card supplied.
      companionWorldBook: {
        apiVersion: 1,
        present: true,
        // The durable revision the projection carries: an edit CASes on it, and the
        // client mirror rejects a book without it exactly as it rejects one without a body.
        revision: 4,
        entries: [
          // The body is part of the entry's shape and the client mirror validates
          // it exactly, so a fixture without it is rejected whole and the section
          // then renders nothing at all.
          { title: "Observatory", keys: [], constant: true, content: "The old observatory on the ridge." },
          { title: "Comet", keys: ["comet"], constant: false, content: "A comet is expected next week." },
        ],
      },
  });
  const { confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await chooseCardFile(page, cardText);
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await expect(review).toContainText("Carries 2 lorebook entries.");
  await review.locator("[data-card-import-review-confirm]").click();
  await expect.poll(() => confirms.length).toBe(1);
  await expect(surface.locator("[data-card-import-result=created]")).toContainText("Carries 2 lorebook entries.");

  // The world book is the character's own view on the same surface: the book the
  // card carried, its count, and the words that actually reach each entry ...
  const own = surface.locator("[data-companion-world-book]");
  await expect(own).toBeVisible();
  await expect(own.locator("h3")).toHaveText("Your companion's own world book");
  await expect(own.locator("[data-companion-world-book-count]")).toHaveText("Entries in her own book: 2");
  const ownEntries = own.locator("[data-companion-world-book-entry]");
  await expect(ownEntries).toHaveCount(2);
  await expect(ownEntries.first()).toContainText("Always with her");
  await expect(ownEntries.nth(1)).toContainText("Trigger words: comet");
  // ... and it is no longer a peer surface of the shell.
  await expect(page.getByTestId("world-info-surface")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "World Info", exact: true })).toHaveCount(0);
});


/**
 * "an alternate opening is stored with the character" fails if a second opening
 * variant is dropped from the save, if the save is not a revision-CAS update of
 * the character's opening, or if the read-back does not carry both variants.
 * It is the honest local counterpart of the card's `alternate_greetings`, which
 * the Host decoder drops (see the field-mapping report).
 */
test("an alternate opening variant is stored with the character and read back with it", async ({ page }) => {
  await stubCharacterReads(page);
  let greeting: Record<string, unknown> = {
    apiVersion: 1,
    present: true,
    revision: 1,
    label: "Morning",
    variants: [{ label: "Default", text: "Good morning." }],
  };
  const saves: unknown[] = [];
  await page.route("**/api/tavern/v1/greeting", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonOk(greeting));
      return;
    }
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      label?: string;
      variants: readonly { label?: string; text: string }[];
    };
    saves.push(body);
    greeting = {
      apiVersion: 1,
      present: true,
      revision: body.expectedRevision + 1,
      label: body.label ?? null,
      variants: body.variants.map((variant) => ({ label: variant.label ?? null, text: variant.text })),
    };
    await route.fulfill(jsonOk(greeting));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await expect(surface.locator("#opening-variant-0-text")).toHaveValue("Good morning.");
  await surface.getByRole("button", { name: "Add opening" }).click();
  await surface.locator("#opening-variant-1-text").fill("Good evening, farmer.");
  await surface.getByRole("button", { name: "Save opening" }).click();

  await expect.poll(() => saves.length).toBe(1);
  expect((saves[0] as { expectedRevision: number }).expectedRevision).toBe(1);
  expect((saves[0] as { variants: unknown }).variants).toEqual([
    { label: "Default", text: "Good morning." },
    { text: "Good evening, farmer." },
  ]);
  await expect(surface.locator("#opening-variant-1-text")).toHaveValue("Good evening, farmer.");
});


/**
 * "a Host refusal is reported instead of shown as success" fails if a refused
 * confirm is optimistically rendered as a created companion, or if the failure
 * is swallowed. The import path must surface the closed failure and never a
 * success banner.
 */
test("a refused import is reported as a failure and never as a created companion", async ({ page }) => {
  const cardText = JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } });
  await stubCharacterReads(page);
  await page.route("**/api/tavern/v1/imports", (route) => route.fulfill(jsonOk(stagedCard())));
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        importId: importIdHandle,
        reviewedFields: ["name", "persona_core"],
        approvedAtMs: 1,
      }),
    ),
  );
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Card import rejected",
        status: 422,
        code: "st_card_import_rejected",
        requestId: importIdHandle,
        retryable: false,
      }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await chooseCardFile(page, cardText);
  // The refusal is reported at the confirm step: the Host's staged report is what
  // the player approves, and the 422 is what the surface shows - never a created
  // companion.
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await review.locator("[data-card-import-review-confirm]").click();
  await expect(surface.locator("[data-card-import-result=error]")).toContainText(
    "The card could not be imported.",
  );
  await expect(surface.locator("[data-card-import-result=created]")).toHaveCount(0);
});

