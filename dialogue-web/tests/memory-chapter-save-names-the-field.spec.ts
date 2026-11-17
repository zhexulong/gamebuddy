import { type Locator, type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * A chapter correction that cannot be honoured says WHAT is missing, instead of greying the control
 * out.
 *
 * The defect: `management-panels.tsx:1726` was
 * `disabled={chapterSaving || chapterDraft.value.trim().length === 0}` and the press it guards is
 * the one that sends `update_chapter`. A player who cleared the chapter's body was offered a dead
 * control with no sentence, no `aria-invalid`, the keyboard on the button, and no way to learn what
 * the control wanted - the same silence the world book's two authoring forms were cured of
 * (`be20b787`, `818b20a4`).
 *
 * The rule is unchanged and is still the Host's own: a chapter is corrected with words. What changed
 * is where it is enforced - on the press, out loud - so the assertions below are the facts the
 * silence had: the control is offered, the field is named (red edge, and a sentence under it), the
 * keyboard lands on it, and nothing is sent until the field says something.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const chatHandle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "D".repeat(42) + "A";
const projectionRevision = "M".repeat(42) + "A";
const nextProjectionRevision = "P".repeat(42) + "A";
const chapterHandle = "V".repeat(42) + "A";

/** The player's own words: distinctive, so a fixture's copy cannot be mistaken for them. */
const SENTINEL_CHAPTER = "SENTINEL_CHAPTER we spent the first weeks putting the farm in order.";

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [
      { itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" },
      { itemId: "memory", labelKey: "tavern.nav.memory", availability: "available" },
    ],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: companionHandle },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision },
    eventStream: null,
  },
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const sealedChapter = {
  handle: chapterHandle,
  title: "Spring, first weeks",
  span: "1–28",
  content: "You and I spent the first weeks of spring getting the farm in order.",
  status: "sealed",
  editedByPlayer: false,
};

type Command = Readonly<{ operation: string; content?: string; handle?: string }>;

/** The Memory surface's own routes, and every mutation it sends, in the order it sent them. */
async function stubMemory(page: Page): Promise<Command[]> {
  const writes: Command[] = [];
  let chapters: ReadonlyArray<Record<string, unknown>> = [sealedChapter];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/memory", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: [], chapters }));
      return;
    }
    const command = request.postDataJSON() as Command;
    writes.push(command);
    if (command.operation === "update_chapter")
      chapters = [{ ...sealedChapter, content: command.content, editedByPlayer: true }];
    await route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: nextProjectionRevision, memories: [], chapters }));
  });
  return writes;
}

async function openMemory(page: Page): Promise<Locator> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  return surface;
}

/** The catalogue's own words, so a journey names the surface the way the product does. */
const catalogue = messages("en");

test("a correction with no words names the chapter instead of withdrawing the press", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = await stubMemory(page);
  const surface = await openMemory(page);
  const panel = surface.locator("[data-memory-chapters]");
  await panel.getByRole("button", { name: catalogue.memoryChapterEdit, exact: true }).click();
  const draft = panel.locator("textarea");
  const save = panel.locator("[data-memory-chapter-save]");
  await expect(draft).toBeVisible();

  // The state the old control went dead in: the player cleared the correction.
  await draft.fill("");
  const before = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("[data-memory-chapter-save]");
    return {
      disabled: button?.disabled ?? null,
      problems: document.querySelectorAll("[data-memory-chapter-problem]").length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
    };
  });
  console.log(`[memory-chapter-press/before] ${JSON.stringify(before)}`);

  await expect(panel.locator("[data-memory-chapter-problem]")).toHaveCount(0);
  await expect(save, "an empty correction is still offered a press").toBeEnabled();
  await save.click();

  const problem = panel.locator("[data-memory-chapter-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText("A chapter needs its words before it can be kept.");
  const marked = await draft.evaluate((element: HTMLElement) => {
    const describedBy = element.getAttribute("aria-describedby");
    const target = describedBy === null ? null : element.ownerDocument.getElementById(describedBy);
    return { invalid: element.getAttribute("aria-invalid"), description: (target?.textContent ?? "").trim() };
  });
  console.log(`[memory-chapter-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe("A chapter needs its words before it can be kept.");
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
  console.log(`[memory-chapter-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id, "the press puts the keyboard on the field it is about").toBe(
    `memory-chapter-correct-${chapterHandle}`,
  );
  expect(landed.inside, "the field it focused is on screen").toBe(true);
  expect(writes, "a correction with no words is not sent at all").toHaveLength(0);

  // The sentence is derived from the draft, so it clears as the player types - and the complete save
  // is the one write this journey ever sends.
  await draft.fill(SENTINEL_CHAPTER);
  await expect(problem).toHaveCount(0);
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    apiVersion: 1,
    operation: "update_chapter",
    expectedProjectionRevision: projectionRevision,
    handle: chapterHandle,
    content: SENTINEL_CHAPTER,
  });
});
