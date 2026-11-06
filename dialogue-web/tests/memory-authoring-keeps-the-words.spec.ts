import { type Locator, type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * Writing something into her notebook costs the attempt, never the words.
 *
 * The defect: `MemoryCreateForm` cleared its own textarea in the click handler and the chapter
 * editor closed itself the moment its save was pressed - both BEFORE the request settled, because
 * `onMutate` returned nothing and no control could know whether the write landed. An offline
 * create, a projection conflict, any refusal at all therefore destroyed what the player typed,
 * and nothing in the tree held a copy: the text lived only in that child's own state.
 *
 * The seam was the cause, so the seam is what changed: `onMutate` answers with the outcome, so
 * the control that owns the words releases them only once the Host accepted them - and says the
 * refusal beside the text it kept. Every journey below asserts both halves of that:
 *
 *  - a refused write keeps the text in its field and reports what happened, in each failure shape
 *    (offline, a projection conflict, a refusal whose own re-read also fails);
 *  - an accepted write clears the field. Leaving the text behind after a real save would be the
 *    same defect pointing the other way, so the success path is asserted, not assumed.
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
const SENTINEL_MEMORY = "SENTINEL_MEMORY the spare watering can lives by the cabin door.";
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

/** A validated problem, shaped exactly as the Host's `problemFor` emits one. */
const problem = (status: number, code: string, title: string, retryable: boolean) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ type: "about:blank", title, status, code, requestId: csrfToken, retryable }),
});

const sealedChapter = {
  handle: chapterHandle,
  title: "Spring, first weeks",
  span: "1–28",
  content: "You and I spent the first weeks of spring getting the farm in order.",
  status: "sealed",
  editedByPlayer: false,
};

/** One memory the Host already holds, so a row exists to correct on arrival. */
const storedMemory = {
  handle: "R".repeat(42) + "A",
  title: "Semantic memory",
  content: "A stored memory the Host already holds.",
  category: "semantic",
  status: "active",
  origin: "player",
  pinned: false,
};

type Command = Readonly<{ operation: string; content?: string; handle?: string }>;

/**
 * The Memory surface's own routes, plus the one route under test.
 *
 * `refusal` is what the first `mutation-total` writes answer: a problem body, or `"offline"` for a
 * connection that never reached the Host. `rereadFails` makes the re-read a refusal triggers fail
 * as well - the shape in which the old panel replaced the whole group with its error sentence.
 */
async function stubMemory(
  page: Page,
  options: Readonly<{
    refusals: number;
    refusal: unknown | "offline";
    rereadFails?: boolean;
    seedMemories?: ReadonlyArray<Record<string, unknown>>;
  }>,
): Promise<{ writes: Command[] }> {
  const writes: Command[] = [];
  let reads = 0;
  let memories: ReadonlyArray<Record<string, unknown>> = options.seedMemories ?? [];
  let chapters: ReadonlyArray<Record<string, unknown>> = [sealedChapter];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/memory", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      reads += 1;
      // Only the mount's own read is served: a re-read is the second one, and it is the shape
      // where a refusal and a dead connection arrive together.
      if (options.rereadFails === true && reads > 1 && writes.length > 0) {
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill(
        jsonOk({ apiVersion: 1, projectionRevision, memories, chapters }),
      );
      return;
    }
    const command = request.postDataJSON() as Command;
    writes.push(command);
    if (writes.length <= options.refusals) {
      if (options.refusal === "offline") {
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill(options.refusal as { status: number });
      return;
    }
    if (command.operation === "create")
      memories = [
        {
          handle: "R".repeat(42) + "A",
          title: "Semantic memory",
          content: command.content,
          category: "semantic",
          status: "active",
          origin: "player",
          pinned: false,
        },
      ];
    // A corrected memory: the projection the Host answers with is the new body, so a save that
    // landed is read back rather than assumed.
    if (command.operation === "update")
      memories = memories.map((memory) =>
        memory.handle === command.handle ? { ...memory, content: command.content } : memory,
      );
    // The Host's answer to a correction: the body and the provenance change, the chapter's lifecycle does
    // not. It is still the chapter the fold sealed - only the words in it are now the player's.
    if (command.operation === "update_chapter")
      chapters = [{ ...sealedChapter, content: command.content, status: "sealed", editedByPlayer: true }];
    await route.fulfill(
      jsonOk({ apiVersion: 1, projectionRevision: nextProjectionRevision, memories, chapters }),
    );
  });
  return { writes };
}

async function openMemory(page: Page): Promise<Locator> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  return surface;
}

const catalogue = messages("en");

/** The create form, opened the way the player opens it. */
async function openCreateForm(surface: Locator): Promise<{
  field: Locator;
  create: Locator;
  refusal: Locator;
}> {
  await surface.locator("[data-memory-authoring-toggle]").click();
  return {
    field: surface.getByRole("textbox", { name: catalogue.memoryContent }),
    create: surface.getByRole("button", { name: catalogue.create, exact: true }),
    refusal: surface.locator("[data-memory-create-refusal]"),
  };
}

test.describe("the player's new memory", () => {
  for (const outcome of [
    {
      name: "refused for a stale projection",
      refusal: problem(409, "state_reconciliation_required", "Memory projection conflict", false),
      sentence: catalogue.problemReconciliationFailedDetail,
    },
    {
      // No Host answer at all, just a dead connection: no code, so the panel's own generic line.
      name: "lost before the Host answered",
      refusal: "offline" as const,
      sentence: catalogue.failure,
    },
  ] as const) {
    test(`${outcome.name} keeps the words in the form, and a save that lands clears them`, async ({ page }) => {
      const stub = await stubMemory(page, { refusals: 1, refusal: outcome.refusal });
      const surface = await openMemory(page);
      const { field, create, refusal } = await openCreateForm(surface);

      await field.fill(SENTINEL_MEMORY);
      await create.click();
      await expect.poll(() => stub.writes.length).toBe(1);

      // The words are still there - the fact this file exists for, asserted first because it is
      // the one the player cannot get back.
      await expect(field).toHaveValue(SENTINEL_MEMORY);
      // …and what happened is stated beside them.
      await expect(refusal).toHaveText(outcome.sentence);
      await expect(field).toBeEnabled();
      await expect(create).toBeEnabled();

      // The retry lands, and only then is the field released.
      await create.click();
      await expect.poll(() => stub.writes.length).toBe(2);
      expect(stub.writes[1]).toEqual({
        apiVersion: 1,
        operation: "create",
        expectedProjectionRevision: projectionRevision,
        content: SENTINEL_MEMORY,
      });
      await expect(field).toHaveValue("");
      await expect(refusal).toHaveCount(0);
    });
  }

  test("refused while the re-read also fails: the form stays, with the words in it", async ({ page }) => {
    const stub = await stubMemory(page, {
      refusals: 1,
      refusal: problem(503, "storage_unavailable", "Storage unavailable", true),
      rereadFails: true,
    });
    const surface = await openMemory(page);
    const { field, create } = await openCreateForm(surface);

    await field.fill(SENTINEL_MEMORY);
    await create.click();
    await expect.poll(() => stub.writes.length).toBe(1);

    await expect(field).toHaveValue(SENTINEL_MEMORY);
    await expect(field).toBeEnabled();
  });
});

test.describe("the player's correction of a chapter", () => {
  test("a refused correction keeps the draft open with its text, and the next save lands", async ({ page }) => {
    const stub = await stubMemory(page, {
      refusals: 1,
      refusal: problem(409, "state_reconciliation_required", "Memory projection conflict", false),
    });
    const surface = await openMemory(page);
    const panel = surface.locator("[data-memory-chapters]");
    await expect(panel).toBeVisible();

    await panel.getByRole("button", { name: catalogue.memoryChapterEdit, exact: true }).click();
    const draft = panel.locator("textarea");
    await draft.fill(SENTINEL_CHAPTER);
    await panel.getByRole("button", { name: catalogue.memoryChapterSave, exact: true }).click();
    await expect.poll(() => stub.writes.length).toBe(1);
    expect(stub.writes[0]).toEqual({
      apiVersion: 1,
      operation: "update_chapter",
      expectedProjectionRevision: projectionRevision,
      handle: chapterHandle,
      content: SENTINEL_CHAPTER,
    });

    // The editor stays open: closing it was what took her draft off the screen with the text in it.
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue(SENTINEL_CHAPTER);
    await expect(panel.locator("[data-memory-chapter-refusal]")).toHaveText(
      catalogue.problemReconciliationFailedDetail,
    );

    // The retry lands, and only on success does the correction close onto the Host's own text.
    await panel.getByRole("button", { name: catalogue.memoryChapterSave, exact: true }).click();
    await expect.poll(() => stub.writes.length).toBe(2);
    await expect(panel.locator("textarea")).toHaveCount(0);
    await expect(panel).toContainText(SENTINEL_CHAPTER);
    // Both facts, each in its own place: the correction is the provenance badge ...
    await expect(panel.locator('[data-memory-chapter-provenance="player"]')).toHaveText(catalogue.memoryChapterEdited);
    // ... and it did not overwrite the lifecycle, which still says whose chapter this is.
    await expect(panel.locator('[data-memory-chapter-badge="sealed"]')).toHaveText(catalogue.memoryChapterSealed);
  });

  test("a correction survives leaving the surface and coming back", async ({ page }) => {
    // The failure this catches: the open row and the player's words were this panel's own
    // `useState`, and the shell renders every surface conditionally (`shownSurface === …`), so
    // looking at Settings unmounted the corrigible row with the half-typed correction in it - and
    // the chapter came back CLOSED, which does not lose the words so much as make them
    // unreachable. Both facts are the shell's drafts now, keyed by the chapter's own handle.
    await stubMemory(page, { refusals: 0, refusal: "offline" });
    const surface = await openMemory(page);
    const panel = surface.locator("[data-memory-chapters]");
    await panel.getByRole("button", { name: catalogue.memoryChapterEdit, exact: true }).click();
    await panel.locator("textarea").fill(SENTINEL_CHAPTER);

    await page.getByRole("button", { name: catalogue.settingsPanel, exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await page.getByRole("button", { name: catalogue.memoryPanel, exact: true }).click();
    await expect(surface).toBeVisible();

    // The surface re-read her notebook on the way back, and the player's correction still wins over
    // what the projection seeded the editor with.
    await expect(panel.getByRole("button", { name: catalogue.memoryChapterSave, exact: true })).toBeVisible();
    await expect(panel.locator("textarea")).toHaveValue(SENTINEL_CHAPTER);
  });

  test("a correction lost before the Host answered keeps its draft too", async ({ page }) => {
    const stub = await stubMemory(page, { refusals: 1, refusal: "offline" });
    const surface = await openMemory(page);
    const panel = surface.locator("[data-memory-chapters]");

    await panel.getByRole("button", { name: catalogue.memoryChapterEdit, exact: true }).click();
    const draft = panel.locator("textarea");
    await draft.fill(SENTINEL_CHAPTER);
    await panel.getByRole("button", { name: catalogue.memoryChapterSave, exact: true }).click();
    await expect.poll(() => stub.writes.length).toBe(1);

    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue(SENTINEL_CHAPTER);
    await expect(panel.locator("[data-memory-chapter-refusal]")).toHaveText(catalogue.failure);
  });
});

/**
 * One memory's correction, held by the shell for the same reason the chapter's is.
 *
 * `MemoryRow` was the last of these editors still holding its words in its own `useState`, and the
 * panel is rendered only while Memory is the selected surface - so a correction the player was
 * part-way through came back CLOSED, the row showing what the Host holds and the words out of reach.
 * The editor and the text are the shell's drafts now, keyed by the row's own handle.
 */
test.describe("the player's correction of one memory", () => {
  test("a correction of a row survives leaving the surface and coming back", async ({ page }) => {
    await stubMemory(page, { refusals: 0, refusal: "offline", seedMemories: [storedMemory] });
    const surface = await openMemory(page);
    const row = surface.locator(`[data-memory-handle="${storedMemory.handle}"]`);
    await row.getByRole("button", { name: catalogue.editMemory, exact: true }).click();
    await row.locator("textarea").fill(SENTINEL_MEMORY);

    await page.getByRole("button", { name: catalogue.settingsPanel, exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await page.getByRole("button", { name: catalogue.memoryPanel, exact: true }).click();
    await expect(surface).toBeVisible();

    // The surface re-read the notebook on the way back and re-seeded the row with what the Host
    // holds; the editor is open and holds the player's own correction, not that seed.
    await expect(row.locator("textarea")).toHaveValue(SENTINEL_MEMORY);
  });

  test("a landed correction hands the editor back to the Host's own words", async ({ page }) => {
    const stub = await stubMemory(page, { refusals: 0, refusal: "offline", seedMemories: [storedMemory] });
    const surface = await openMemory(page);
    const row = surface.locator(`[data-memory-handle="${storedMemory.handle}"]`);

    await row.getByRole("button", { name: catalogue.editMemory, exact: true }).click();
    await row.locator("textarea").fill(SENTINEL_MEMORY);
    await row.getByRole("button", { name: catalogue.save, exact: true }).click();
    await expect.poll(() => stub.writes.length).toBe(1);

    // The save landed, so the editor closes and the row reads the projection again - a draft that
    // outlived its own save would pin the row to a copy of what the Host already says.
    await expect(row.locator("textarea")).toHaveCount(0);
    await expect(row.locator("p")).toContainText(SENTINEL_MEMORY);
  });
});
