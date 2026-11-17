import { expect, test } from "./frontend-coverage";
import { token } from "./composed-reference-game-fixtures";
import { openCharactersSurface, stubCharacterReads, stubImportSuccess } from "./character-card-fixtures";

/**
 * The card import's paste press says what is missing, instead of being withheld.
 *
 * The defect: `CharacterCardImport.tsx:462` was `disabled={busy || pasted.value.trim().length === 0}`.
 * The press it guards is the whole of the paste path - it posts the box's own text as
 * `character.import.stage` - so a player who opened the disclosure and pressed it with nothing in
 * the box got a dead control, no sentence, no `aria-invalid`, the keyboard left where it was, and no
 * way to learn what it wanted.
 *
 * This is not a form of fields, so the honest analogue of the world book's "name every field that is
 * missing something" is one line about the one thing the press needs: that there is nothing to
 * import yet, and what belongs in the box (or which control above can supply it). The box is marked
 * and takes the keyboard for the same reason every other marked field does - a sentence nobody is
 * taken to is a sentence a screen-reader user has to go looking for - and the box is not a form
 * field with a label, so the line says what to paste rather than naming a label.
 */

test("pressing import with an empty paste box says what to paste, and sends nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubCharacterReads(page);
  const { imports } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");
  // The paste path is the disclosure's own arm; the file picker above it stays the primary one.
  await surface.locator("[data-card-import] summary").click();
  const box = surface.getByRole("textbox", { name: "Paste card text" });
  const press = surface.getByRole("button", { name: "Import card" });

  const before = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("[data-card-import] button")].find(
      (candidate) => candidate.textContent?.trim() === "Import card",
    );
    return {
      disabled: button?.disabled ?? null,
      problems: document.querySelectorAll("[data-card-import-paste-problem]").length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
    };
  });
  console.log(`[card-import-paste/before] ${JSON.stringify(before)}`);

  await expect(surface.locator("[data-card-import-paste-problem]")).toHaveCount(0);
  await expect(press, "an empty paste box is still offered a press").toBeEnabled();
  await press.click();

  const problem = surface.locator("[data-card-import-paste-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText(
    "There is nothing to import yet: paste the card's JSON here, or choose a file above.",
  );
  const marked = await box.evaluate((element: HTMLElement) => {
    const describedBy = element.getAttribute("aria-describedby");
    const target = describedBy === null ? null : element.ownerDocument.getElementById(describedBy);
    return { invalid: element.getAttribute("aria-invalid"), description: (target?.textContent ?? "").trim() };
  });
  console.log(`[card-import-paste/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe(
    "There is nothing to import yet: paste the card's JSON here, or choose a file above.",
  );
  const landed = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const scroller = document.querySelector<HTMLElement>(".surface-content");
    const band = scroller?.getBoundingClientRect();
    const box = active?.getBoundingClientRect();
    return {
      id: active?.id ?? "",
      inside: band === undefined || box === undefined ? false : box.top >= band.top && box.bottom <= band.bottom,
    };
  });
  console.log(`[card-import-paste/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe("card-import-paste");
  expect(landed.inside, "the box it focused is on screen").toBe(true);
  expect(imports, "an empty box is not sent at all").toHaveLength(0);

  // The line is derived from the box, so it clears as the player pastes - not on the next press,
  // which would leave a red edge on a box that is no longer empty.
  const cardText = JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } });
  await box.fill(cardText);
  await expect(problem).toHaveCount(0);
  await press.click();
  await expect.poll(() => imports.length).toBe(1);
  expect(imports[0]?.body).toEqual({ apiVersion: 1, cardSource: "json", card: cardText });
  // Staging is not importing: the Host's report is on screen for the player to approve.
  await expect(surface.locator("[data-card-import-review]")).toBeVisible();
});
