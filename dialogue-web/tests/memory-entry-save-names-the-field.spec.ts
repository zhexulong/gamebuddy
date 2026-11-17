import { type Locator, type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * A memory whose field is empty says so when the press is made, instead of the press being withheld.
 *
 * The defect, twice in the same panel: `management-panels.tsx:1957` (the player's new memory) and
 * `:2060` (one row's correction) were both `disabled={saving || …value.trim().length === 0}`. The
 * button was the only thing that said anything, and what it said was nothing: no sentence, no
 * `aria-invalid`, the keyboard left where it was, no write attempted - the player had no way to
 * learn which field the control wanted, which is the same silence the world book's editor was cured
 * of in `818b20a4`.
 *
 * The rule is unchanged - a memory is kept with words - and where it is enforced changed: the press
 * is offered, the field is named (red edge and a sentence under it), the keyboard lands on it, and
 * nothing is sent until the field says something. Both editors read the same helper
 * (`useRequiredField`) the chapter correction reads, so there is one answer in this panel, not
 * three.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const chatHandle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "D".repeat(42) + "A";
const projectionRevision = "M".repeat(42) + "A";
const nextProjectionRevision = "P".repeat(42) + "A";
const rowHandle = "R".repeat(42) + "A";

/** The player's own words: distinctive, so a fixture's copy cannot be mistaken for them. */
const SENTINEL_MEMORY = "SENTINEL_MEMORY the spare watering can lives by the cabin door.";

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

/** One memory the Host already holds, so a row exists to correct on arrival. */
const storedMemory = {
  handle: rowHandle,
  title: "Semantic memory",
  content: "A stored memory the Host already holds.",
  category: "semantic",
  status: "active",
  origin: "player",
  pinned: false,
};

type Command = Readonly<{ operation: string; content?: string; handle?: string }>;

/** The Memory surface's own routes, and every mutation it sends, in the order it sent them. */
async function stubMemory(page: Page): Promise<Command[]> {
  const writes: Command[] = [];
  let memories: ReadonlyArray<Record<string, unknown>> = [storedMemory];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/memory", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories, chapters: [] }));
      return;
    }
    const command = request.postDataJSON() as Command;
    writes.push(command);
    if (command.operation === "create")
      memories = [{ ...storedMemory, handle: "S".repeat(42) + "A", content: command.content }];
    if (command.operation === "update")
      memories = memories.map((memory) =>
        memory.handle === command.handle ? { ...memory, content: command.content } : memory,
      );
    await route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: nextProjectionRevision, memories, chapters: [] }));
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

const catalogue = messages("en");

/** `aria-invalid` and the sentence `aria-describedby` resolves to, as the browser reports them. */
async function associationOf(field: Locator): Promise<Readonly<{ invalid: string | null; description: string }>> {
  return field.evaluate((element: HTMLElement) => {
    const describedBy = element.getAttribute("aria-describedby");
    const target = describedBy === null ? null : element.ownerDocument.getElementById(describedBy);
    return { invalid: element.getAttribute("aria-invalid"), description: (target?.textContent ?? "").trim() };
  });
}

/** Where the keyboard went, and whether that field is inside the surface's own scroller. */
async function landing(page: Page): Promise<Readonly<{ id: string; inside: boolean }>> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const scroller = document.querySelector<HTMLElement>(".surface-content");
    const band = scroller?.getBoundingClientRect();
    const box = active?.getBoundingClientRect();
    return {
      id: active?.id ?? "",
      inside: band === undefined || box === undefined ? false : box.top >= band.top && box.bottom <= band.bottom,
    };
  });
}

test("a new memory with no words names the field instead of withdrawing the press", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = await stubMemory(page);
  const surface = await openMemory(page);
  await surface.locator("[data-memory-authoring-toggle]").click();
  const field = surface.getByRole("textbox", { name: catalogue.memoryContent });
  const create = surface.getByRole("button", { name: catalogue.create, exact: true });

  const before = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Create",
    );
    return {
      disabled: button?.disabled ?? null,
      problems: document.querySelectorAll("[data-memory-create-problem]").length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
    };
  });
  console.log(`[memory-create-press/before] ${JSON.stringify(before)}`);

  await expect(surface.locator("[data-memory-create-problem]")).toHaveCount(0);
  await expect(create, "an empty new memory is still offered a press").toBeEnabled();
  await create.click();

  const problem = surface.locator("[data-memory-create-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText("Write what she should remember before keeping it.");
  const marked = await associationOf(field);
  console.log(`[memory-create-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe("Write what she should remember before keeping it.");
  const landed = await landing(page);
  console.log(`[memory-create-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe("memory-create-content");
  expect(landed.inside, "the field it focused is on screen").toBe(true);
  expect(writes, "an empty memory is not sent at all").toHaveLength(0);

  await field.fill(SENTINEL_MEMORY);
  await expect(problem).toHaveCount(0);
  await create.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    apiVersion: 1,
    operation: "create",
    expectedProjectionRevision: projectionRevision,
    content: SENTINEL_MEMORY,
  });
});

test("a row correction with no words names the field instead of withdrawing the press", async ({ page }) => {
  const writes = await stubMemory(page);
  const surface = await openMemory(page);
  const row = surface.locator(`[data-memory-handle="${rowHandle}"]`);
  await row.getByRole("button", { name: catalogue.editMemory, exact: true }).click();
  const field = row.locator("textarea");
  const save = row.getByRole("button", { name: catalogue.save, exact: true });

  // The state the old control went dead in: the player cleared the memory's body.
  await field.fill("");
  const before = await page.evaluate(() => {
    const row = document.querySelector('[data-memory-handle]');
    const button = [...(row?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === "Save",
    );
    return {
      disabled: button?.disabled ?? null,
      problems: document.querySelectorAll("[data-memory-item-problem]").length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
    };
  });
  console.log(`[memory-item-press/before] ${JSON.stringify(before)}`);

  await expect(row.locator("[data-memory-item-problem]")).toHaveCount(0);
  await expect(save, "an empty correction is still offered a press").toBeEnabled();
  await save.click();

  const problem = row.locator("[data-memory-item-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText("A memory needs its words before it can be kept.");
  const marked = await associationOf(field);
  console.log(`[memory-item-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe("A memory needs its words before it can be kept.");
  const landed = await landing(page);
  console.log(`[memory-item-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe(`memory-item-content-${rowHandle}`);
  expect(writes).toHaveLength(0);

  await field.fill(SENTINEL_MEMORY);
  await expect(problem).toHaveCount(0);
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    apiVersion: 1,
    operation: "update",
    expectedProjectionRevision: projectionRevision,
    handle: rowHandle,
    content: SENTINEL_MEMORY,
  });
});
