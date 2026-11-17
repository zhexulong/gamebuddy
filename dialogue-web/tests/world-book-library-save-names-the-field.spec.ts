import { expect, test } from "./frontend-coverage";
import { openLibraryWorldBookEditor, stubLibraryWorldBookSurface } from "./character-world-book-authoring-surface";

/**
 * A press the library's authoring form cannot honour says WHAT is missing, instead of greying the
 * control out.
 *
 * The defect: `[data-world-book-submit]` was `disabled={saving || !worldBookDraftIsComplete(draft)}`
 * and `submitDraft` returned on the same predicate, so a player who cleared one required field - a
 * row's words, or the item's own title - was offered a dead control with no sentence, no focus and
 * nothing on screen naming what was wrong. Measured on the mounted shell: `disabled: true`, no
 * problem message, no `aria-invalid`, the keyboard still on the button, and no save attempted.
 *
 * The rule is unchanged and is still the durable validator's own: an item needs a title and a
 * summary, and every entry needs its title and its words. What changed is where it is enforced - on
 * the press, out loud - so the assertions below are the facts the silence had: the control is
 * offered, every field that is missing something is named one by one (red edge, and a sentence under
 * that field), the keyboard lands on the first of them, and nothing is sent.
 *
 * The two panels that author a world book share one rule (`firstFieldAtFault` in
 * `src/components/field-error.ts`), so "which field does the press land on" is one implementation
 * over each form's own reading order rather than two.
 */

test("a press with a blank entry names the field that is missing something", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = await stubLibraryWorldBookSurface(page);
  const { editor } = await openLibraryWorldBookEditor(page);

  // The row the player asks for and leaves blank, which is the state the old control went dead in.
  await editor.locator("[data-world-book-entry-add]").click();
  const addedTitle = editor.locator("#world-book-entry-1-title");
  const addedWords = editor.locator("#world-book-entry-1-summary");
  const save = editor.locator("[data-world-book-submit]");

  const before = await editor.evaluate((node) => ({
    disabled: (node.querySelector("[data-world-book-submit]") as HTMLButtonElement).disabled,
    problems: node.querySelectorAll("[data-world-book-field-problem]").length,
    invalid: node.querySelectorAll('[aria-invalid="true"]').length,
    active: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
  }));
  console.log(`[library-world-book-press/before] ${JSON.stringify(before)}`);

  // The press is the thing that states the problem, not the keystroke: nothing is marked until it is
  // made, so a player filling the form in is never reading a red edge on work in progress.
  await expect(editor.locator("[data-world-book-field-problem]")).toHaveCount(0);
  await expect(save, "an incomplete draft is still offered a press").toBeEnabled();
  await save.click();

  // Every field that is missing something says so, under itself, and points at its own sentence.
  const problems = editor.locator("[data-world-book-field-problem]");
  await expect(problems).toHaveCount(2);
  await expect(problems.nth(0)).toHaveText("This entry needs a title before the library can keep it.");
  await expect(problems.nth(1)).toHaveText("This entry needs its words before the library can keep it.");
  await expect(addedTitle).toHaveAttribute("aria-invalid", "true");
  await expect(addedTitle).toHaveAttribute("aria-describedby", "world-book-entry-1-title-problem");
  await expect(addedWords).toHaveAttribute("aria-invalid", "true");
  await expect(addedWords).toHaveAttribute("aria-describedby", "world-book-entry-1-summary-problem");
  // The edge is the attribute, not a second class name: what the screen reader is told and what the
  // eye is shown are one attribute, painted with the product's danger token. It is read against the
  // token's own resolved colour, because the field transitions its border (`--motion-duration-fast`)
  // and a comparison made on the first frame would measure the colour it is leaving.
  const dangerToken = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });
  await expect(addedTitle, "the invalid field's edge is the danger token").toHaveCSS(
    "border-top-color",
    dangerToken,
  );
  // The row above it is complete, so it is not painted as refused: the mark is per field.
  const complete = editor.locator("#world-book-entry-0-title");
  await expect(complete).not.toHaveAttribute("aria-invalid", "true");
  await expect(complete, "a complete field keeps the quiet edge").not.toHaveCSS("border-top-color", dangerToken);

  // The keyboard lands on the field the press is about, and it is on screen in the surface's own
  // scroller rather than somewhere above the fold.
  const landed = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const scroller = document.querySelector<HTMLElement>(".surface-content")!;
    const band = scroller.getBoundingClientRect();
    const box = active?.getBoundingClientRect();
    return {
      id: active?.id ?? "",
      inside: box === undefined ? false : box.top >= band.top && box.bottom <= band.bottom,
      box: box === undefined ? null : { top: Math.round(box.top), bottom: Math.round(box.bottom) },
      band: { top: Math.round(band.top), bottom: Math.round(band.bottom) },
    };
  });
  console.log(`[library-world-book-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id, "the press puts the keyboard on the first field that is missing something").toBe(
    "world-book-entry-1-title",
  );
  expect(
    landed.inside,
    `the field it focused is on screen (${JSON.stringify(landed.box)} inside ${JSON.stringify(landed.band)})`,
  ).toBe(true);

  // Nothing was sent: the press named the problem instead of asking the Host to refuse the payload.
  expect(writes, "an incomplete draft is not sent at all").toHaveLength(0);
});

test("the item's own fields are named too, each sentence clears as it is filled, and the complete draft is sent once", async ({
  page,
}) => {
  const writes = await stubLibraryWorldBookSurface(page);
  const { panel, editor } = await openLibraryWorldBookEditor(page);
  const summary = editor.locator("#world-book-item-summary");
  const title = editor.locator("#world-book-item-title");
  const words = editor.locator("#world-book-entry-0-summary");
  await title.fill("");
  await summary.fill("");
  await words.fill("");

  const save = editor.locator("[data-world-book-submit]");
  const problems = editor.locator("[data-world-book-field-problem]");
  await save.click();

  // The item the entries belong to is read first, so its own missing fields are the first two the
  // press names - in the order the form draws them, which is why the keyboard lands on the title.
  await expect(problems).toHaveCount(3);
  await expect(problems.nth(0)).toHaveText("This item needs a title before the library can keep it.");
  await expect(problems.nth(1)).toHaveText("This item needs a summary before the library can keep it.");
  await expect(problems.nth(2)).toHaveText("This entry needs its words before the library can keep it.");
  expect((await page.evaluate(() => document.activeElement?.id)) ?? "").toBe("world-book-item-title");

  // The sentences are derived from the draft, so a field the player fixes loses its own as she types
  // it - not on the next press, which would leave a red edge on a field that is no longer wrong.
  await title.fill("Pelican Town");
  await expect(problems).toHaveCount(2);
  await summary.fill("One square, one river, one saloon.");
  await expect(problems).toHaveCount(1);
  await words.fill("The only place open after dark.");
  await expect(problems).toHaveCount(0);
  expect(writes, "an incomplete draft is not sent at all").toHaveLength(0);

  await save.click();
  // The save that goes out is answered by the Host's own projection, which closes the draft and
  // says so - and it is the only write this journey ever sends.
  await expect(panel.locator('[role="status"]')).toHaveText("Saved.");
  await expect(editor).toHaveCount(0);
  expect(writes, "the complete draft is sent once").toHaveLength(1);
  expect(writes[0]!.method).toBe("PUT");
  expect(writes[0]!.body.item?.expectedRevision, "on the item's own content revision").toBe(3);
  expect(writes[0]!.body.item?.publicTitle).toBe("Pelican Town");
});
