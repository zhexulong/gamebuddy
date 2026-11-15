import { expect, test } from "./frontend-coverage";
import {
  companionWorldBookCsrf,
  companionWorldBookRoute,
  openCompanionWorldBookEditor,
  stubCompanionWorldBookSurface,
} from "./companion-world-book-authoring-surface";

/**
 * A press the form cannot honour says WHAT is missing, instead of greying the control out.
 *
 * The defect: `[data-companion-world-book-save]` was `disabled={saving || !complete}`, so a player who
 * pressed 添加词条 and left the new row blank was offered a dead control with no sentence, no focus and
 * nothing on screen naming what was wrong - measured on the mounted shell at 1440x900, the button read
 * `disabled: true`, the editor held `0` problem messages and `0` error banners, and a press could not
 * even be attempted. With fifteen entries in the book the row that needed something could be anywhere
 * in a nine-thousand-pixel column.
 *
 * The rule is unchanged and is still the durable validator's own: an entry needs a title and a body.
 * What changed is where it is enforced - on the press, out loud - so the assertions below are the
 * three facts the silence had: the control is offered, the fields that are missing something are named
 * one by one (red edge, and a sentence under the field itself), and the keyboard lands on the first of
 * them with the row open and on screen.
 *
 * A payload the Host refuses is a different fact and keeps the Host's own sentence: nothing here is
 * marked red for it, the notice says what the Host said, and the player's work stays in the editor.
 */

const book = {
  apiVersion: 1,
  present: true,
  revision: 7,
  entries: [
    { title: "温室", keys: ["温室"], constant: false, enabled: true, content: "温室的玻璃是她去年冬天换的。" },
  ],
};

test("a press with a blank entry names every field that is missing something", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const saves = await stubCompanionWorldBookSurface(page, book);
  const { block, editor } = await openCompanionWorldBookEditor(page);

  // The row the player asks for, and the state the old control went dead in.
  await editor.locator("[data-companion-world-book-add]").click();
  const blank = editor.locator("[data-companion-world-book-entry-draft]").nth(1);
  const save = block.locator("[data-companion-world-book-save]");
  await expect(save).toBeEnabled();

  // …and the form is quiet until she presses: no field is painted as refused for a row she has not
  // tried to save yet. The press is the thing that states the problem, not the keystroke.
  await expect(editor.locator("[data-companion-world-book-entry-problem]")).toHaveCount(0);
  await expect(editor.locator(".error-banner")).toHaveCount(0);

  await save.click();

  // Every field that is missing something says so, and the sentence is under its own field.
  const problems = editor.locator("[data-companion-world-book-entry-problem]");
  await expect(problems).toHaveCount(2);
  await expect(problems.first()).toHaveText("这条词条还没有标题，她的世界书收不下。");
  await expect(problems.nth(1)).toHaveText("这条词条还没有正文，她的世界书收不下。");

  const title = blank.locator('input[id$="-title"]');
  const body = blank.locator("textarea");
  for (const [name, field, describedBy] of [
    ["the title", title, "companion-world-book-entry-1-title-problem"],
    ["the body", body, "companion-world-book-entry-1-body-problem"],
  ] as const) {
    await expect(field, `${name} is marked invalid`).toHaveAttribute("aria-invalid", "true");
    await expect(field, `${name} points at its own sentence`).toHaveAttribute("aria-describedby", describedBy);
  }
  // The edge is the attribute, not a second class name: the fact the screen reader is told and the
  // fact the eye is shown are one attribute, and the sheet paints it with the product's danger token.
  const edge = await title.evaluate((node) => getComputedStyle(node).borderTopColor);
  const quiet = await editor.locator('input[id$="-keys"]').first().evaluate((node) => getComputedStyle(node).borderTopColor);
  expect(edge, `the invalid field's edge is ${edge}, a field with no problem is ${quiet}`).not.toBe(quiet);

  // The row it is about was shut, so the press opens it, puts the keyboard on the first field that is
  // missing something, and leaves that field inside the surface's own scroller.
  await expect(blank).toHaveAttribute("open", "");
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
  console.log(`[world-book-save-press] ${JSON.stringify(landed)}`);
  expect(landed.id, "the press puts the keyboard on the field that is missing something").toBe(
    "companion-world-book-entry-1-title",
  );
  expect(landed.inside, `the field it focused is on screen (${JSON.stringify(landed.box)} inside ${JSON.stringify(landed.band)})`)
    .toBe(true);

  // Nothing was sent: the press named the problem instead of asking the Host to refuse the payload.
  expect(saves, "an incomplete draft is not sent at all").toHaveLength(0);
});

test("each sentence clears as its field is filled, and the press then sends the whole list", async ({ page }) => {
  const saves = await stubCompanionWorldBookSurface(page, book);
  const { block, editor } = await openCompanionWorldBookEditor(page);

  await editor.locator("[data-companion-world-book-add]").click();
  const blank = editor.locator("[data-companion-world-book-entry-draft]").nth(1);
  const problems = editor.locator("[data-companion-world-book-entry-problem]");
  const save = block.locator("[data-companion-world-book-save]");
  await save.click();
  await expect(problems).toHaveCount(2);

  // The sentences are derived from the draft, so a field the player fixes loses its own as she types
  // it - not on the next press, which would leave a red edge on a field that is no longer wrong.
  await blank.locator('input[id$="-title"]').fill("新的词条");
  await expect(problems).toHaveCount(1);
  await expect(problems.first()).toHaveText("这条词条还没有正文，她的世界书收不下。");
  await expect(blank.locator('input[id$="-title"]')).not.toHaveAttribute("aria-invalid", "true");

  await blank.locator("textarea").fill("她自己写的正文。");
  await expect(problems).toHaveCount(0);
  await save.click();

  await expect(block.locator("[data-companion-world-book-notice]")).toHaveText("已保存。");
  expect(saves, "the complete draft is sent").toHaveLength(1);
  expect(saves[0]!.expectedRevision, "on the revision the read carried").toBe(7);
  expect(saves[0]!.entries.map((entry) => entry.title)).toEqual(["温室", "新的词条"]);
});

/**
 * The other half of "do not disable it": a payload the client thought complete and the Host refuses is
 * answered in the Host's own words, and the player's draft survives the refusal.
 *
 * Which sentence fires is the point of the assertion. The completeness rule now runs on the press, so
 * `companionWorldBookInvalid` is not the path for an empty title or body any more - it is the path for
 * a payload the client accepted and the Host would not keep, and the notice is the Host's sentence
 * rather than a second one this component invented.
 */
test("a payload the Host refuses answers in the Host's words, and the draft survives it", async ({ page }) => {
  await stubCompanionWorldBookSurface(page, book);
  // The Host's own refusal of a payload it will not keep, installed after the fixture's own handler so
  // it answers the PUT; the read still falls through to the book the fixture serves.
  await page.route(companionWorldBookRoute, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Authored content invalid",
        status: 422,
        code: "authored_content_invalid",
        // The problem envelope's `requestId` is an opaque handle: 32 bytes, canonical unpadded
        // base64url, so its last character's padding bits are zero. A run of one letter is not one.
        requestId: companionWorldBookCsrf,
        retryable: false,
      }),
    });
  });
  const { block, editor } = await openCompanionWorldBookEditor(page);
  await editor.locator("[data-companion-world-book-entry-draft] summary").first().click();

  const typed = "{{user}}说这扇玻璃是她挑的。";
  await editor.locator("textarea").first().fill(typed);
  await block.locator("[data-companion-world-book-save]").click();

  await expect(block.locator("[data-companion-world-book-notice]")).toContainText("Host 无法保留这次改动");
  // Nothing is painted red for this one: no field is missing anything, the Host refused the payload.
  await expect(editor.locator("[data-companion-world-book-entry-problem]")).toHaveCount(0);
  // …and the work is still here, which is the invariant the editor had before this lane and keeps.
  await expect(editor).toBeVisible();
  await expect(editor.locator("textarea").first()).toHaveValue(typed);
  await expect(editor.locator("[data-companion-world-book-entry-draft]")).toHaveCount(1);
});
