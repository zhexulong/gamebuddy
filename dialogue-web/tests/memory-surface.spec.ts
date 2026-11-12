/**
 * The Memory surface: the companion's notebook, its authoring path, and its one-origin view.
 *
 * The count and the badges are read from the Host rather than counted locally, authoring goes
 * through `memory.mutate` and shows the Host's read-back, a rejected write is reported instead
 * of being drawn as saved, and narrowing to one origin and back preserves what the player was
 * reading.
 */
import { expect, test } from "./frontend-coverage";
import { token, csrfToken, draft, root } from "./composed-reference-game-fixtures";

/**
 * The product's Memory surface is the management surface's own panel, not a
 * read-only lookalike: it authors through the frozen `memory.mutate` route and
 * shows only the durable read-back the Host returns.
 *
 * The two assertions below own the two ways this can silently regress:
 *
 * 1. "the product Memory surface authors the exact memory.mutate command and
 *    shows the Host read-back" fails if the surface never posts `memory.mutate`
 *    (the read-only stub the product shipped with), if it posts a command the
 *    frozen route would reject (no `expectedProjectionRevision` compare-and-swap,
 *    a wrong operation), if it posts it without the broker session's CSRF token,
 *    or if it renders a locally invented row instead of the Host's own title and
 *    handle for the written memory.
 * 2. "a rejected Memory mutation is reported, never shown as saved" fails if a
 *    refused write is optimistically rendered as a created memory (the surface
 *    must re-read the authority and then report the failure), and it also pins
 *    that the failure notice is player-visible.
 */
test("the product Memory surface authors through memory.mutate and shows the Host read-back, and reports a rejected write instead of showing it as saved", async ({ page }) => {
  const projectionRevision = `${"M".repeat(42)}A`;
  const nextProjectionRevision = `${"P".repeat(42)}A`;
  const memoryHandle = `${"N".repeat(42)}A`;
  const writtenContent = "The player keeps a spare watering can by the cabin door.";
  const refusedContent = "A memory the Host refused to write.";

  const writes: Array<{ body: unknown; csrf: string | undefined }> = [];
  let reads = 0;
  let memories: ReadonlyArray<Record<string, unknown>> = [];
  let refuseWrites = false;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/memory", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      reads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ apiVersion: 1, projectionRevision, memories, chapters: [] }),
      });
      return;
    }
    writes.push({ body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
    if (refuseWrites) {
      // The management route's own mapping of a Memory projection conflict: a
      // safe 409 with no stale success projection.
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Memory projection conflict",
          status: 409,
          code: "state_reconciliation_required",
          requestId: nextProjectionRevision,
          retryable: false,
        }),
      });
      return;
    }
    // The validated mutation response IS the durable read-back: the row carries a
    // Host-chosen title and handle no local state could have guessed.
    memories = [
      {
        handle: memoryHandle,
        title: "Semantic memory",
        content: writtenContent,
        category: "semantic",
        status: "active",
        origin: "player",
        pinned: false,
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, projectionRevision: nextProjectionRevision, memories, chapters: [] }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  // The surface reads the management route itself; the composed Chat projection
  // carries no Memory capability for it to hide behind.
  await expect(surface.locator("[data-memory-state=empty]")).toBeVisible();
  expect(reads).toBe(1);

  // Manual authoring is secondary now: it opens from the quiet button beneath
  // the notebook and then writes through the same `memory.mutate` route.
  await surface.locator("[data-memory-authoring-toggle]").click();
  await surface.getByRole("textbox", { name: "Memory content" }).fill(writtenContent);
  await surface.getByRole("button", { name: "Create", exact: true }).click();

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({
    apiVersion: 1,
    operation: "create",
    expectedProjectionRevision: projectionRevision,
    content: writtenContent,
  });
  expect(writes[0]?.csrf).toBe(csrfToken);
  // The row carries the Host's own opaque handle for the written memory, so a
  // locally invented row cannot pass this.
  await expect(surface.locator(`[data-memory-handle="${memoryHandle}"]`)).toBeVisible();
  await expect(surface.getByText(writtenContent, { exact: true })).toBeVisible();

  // A refresh re-reads the authority, and the written row is still the store's.
  await surface.getByRole("button", { name: "Refresh Memory" }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(surface.getByText(writtenContent, { exact: true })).toBeVisible();

  // A refused write is re-read and reported, never rendered as a written memory. Two readings say
  // so, and both are asserted: the surface's own banner reports the refusal, and the create field
  // keeps the words it was refused for and names the same refusal beside them (the field is released
  // only when the write lands, see `memory-authoring-keeps-the-words.spec.ts`).
  refuseWrites = true;
  memories = [];
  await surface.getByRole("textbox", { name: "Memory content" }).fill(refusedContent);
  await surface.getByRole("button", { name: "Create", exact: true }).click();
  const reconciliation = "The chat state could not be safely reconciled.";
  await expect(surface.locator(".error-banner").first()).toContainText(reconciliation);
  await expect(surface.locator("[data-memory-create-refusal]")).toHaveText(reconciliation);
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toHaveValue(refusedContent);
  await expect.poll(() => reads).toBe(3);
  // The refusal did not become a row. The words are still in the field the player typed them into,
  // which is where they must be until the write lands - so this reading is about the LIST, not the
  // page: the earlier form of it matched any text in the surface, which a preserved draft would fail
  // for the right reason and hide the assertion's actual subject.
  await expect(surface.locator("[data-memory-state=ready] [role=listitem]")).toHaveCount(0);
  await expect(surface.locator("[data-memory-state=empty]")).toBeVisible();
});


/**
 * The Memory surface reads as the companion's notebook, not as a database form
 * (the owner's report: "我得像程序员填数据一样手动往里写记忆").
 *
 * The failure each assertion catches:
 *
 * 1. `explains the notebook while it is empty` - an empty Memory projection that
 *    paints a blank form (no notebook card, no honest zero) is the reported
 *    defect; the card must say what the notebook is and how it fills - the player
 *    asking her to keep something - even when the Host returns no rows. It must
 *    NOT promise a writer production does not run: promotion is gated off and the
 *    historian fold that would carry it fires at 65% of the usable window, so
 *    `memory-notebook-promise-gate.test.mjs` pins the wording and this spec pins
 *    what the mounted card actually renders.
 * 2. `counts exactly what the Host returned` - a fabricated or locally guessed
 *    number, or a count that ignores the mounted rows, fails; the card's number is
 *    compared to the two rows the route returned.
 * 3. `says the category in player words` - a badge that prints the contract's own
 *    member (`semantic`/`interaction`) or drops the label fails, and the surface's
 *    own text is asserted to contain neither member.
 * 4. `keeps manual authoring behind the quiet button` - a surface that either
 *    always shows the create form (a form, not a notebook) or hides authoring
 *    entirely fails; the textbox is absent until the toggle opens it.
 */
test("the Memory surface reads as the companion's notebook, with a real count and player-word badges", async ({ page }) => {
  const memoryRevision = "M".repeat(42) + "A";
  const semanticHandle = "N".repeat(42) + "A";
  const interactionHandle = "Q".repeat(42) + "A";

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  let memories: ReadonlyArray<Record<string, unknown>> = [];
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, projectionRevision: memoryRevision, memories, chapters: [] }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();

  // 1. Zero memories still explains the notebook, and the zero is readable: the
  // digits are in the sentence the player sees, not only in an element attribute
  // (the attribute is kept in step with the words, and the words are what is
  // asserted here). It states the route that exists (the player telling her), not
  // an automatic writer (see the file header and memory-notebook-promise-gate.test.mjs).
  const notebook = surface.locator("[data-memory-notebook]");
  await expect(notebook).toBeVisible();
  await expect(notebook).toContainText("This is her notebook");
  await expect(notebook).not.toContainText("writes this down");
  await expect(notebook).not.toContainText("fills in as you talk");
  const notebookCount = notebook.locator("[data-memory-count]");
  await expect(notebookCount).toContainText("Nothing written down yet (0 so far)");
  await expect(notebookCount).toHaveAttribute("data-memory-count", "0");

  // 4. Authoring is secondary: it opens on demand and does not define the surface.
  // Closed by default, but it is still a control a player finds without being told:
  // it is visible, it is the surface's last line, and its own words say what it does.
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toHaveCount(0);
  const authoringToggle = surface.locator("[data-memory-authoring-toggle]");
  await expect(authoringToggle).toBeVisible();
  await expect(authoringToggle).toHaveAttribute("aria-expanded", "false");
  await expect(authoringToggle).toContainText("Whisper something to your companion");
  await authoringToggle.click();
  await expect(authoringToggle).toHaveAttribute("aria-expanded", "true");
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toBeVisible();

  // 2 + 3. Two rows, two life-flavoured badges, and a count that equals them.
  memories = [
    { handle: semanticHandle, title: "Semantic memory", content: "The farmer keeps a spare watering can by the door.", category: "semantic", status: "active", origin: "player", pinned: false },
    { handle: interactionHandle, title: "Interaction memory", content: "They shared a rainy afternoon by the sea.", category: "interaction", status: "active", origin: "companion", pinned: false },
  ];
  await surface.getByRole("button", { name: "Refresh Memory" }).click();
  const rows = surface.locator("[data-memory-state=ready] [role=listitem]");
  await expect(rows).toHaveCount(2);
  await expect(notebookCount).toContainText("2 memories written down");
  await expect(notebookCount).toHaveAttribute("data-memory-count", "2");

  const badges = surface.locator("[data-memory-category]");
  await expect(badges).toHaveCount(2);
  await expect(badges.first()).toHaveText("Things she keeps");
  await expect(badges.nth(1)).toHaveText("Times you shared");

  // The raw contract members never reach the player (design/104 §10).
  const text = await surface.innerText();
  expect(text).not.toMatch(/\bsemantic\b/iu);
  expect(text).not.toMatch(/\binteraction\b/iu);
});



/**
 * The Memory surface's origin filter (reviewer point 4).
 *
 * The failure each assertion catches:
 *
 * 1. `narrows to one origin` - without the filter the panel renders every row
 *    in one mixed list, which is the reported "只能在混杂长列表里逐条肉眼查找": a
 *    player auditing what the companion remembered on its own has no way to
 *    ask. The assertion is on the rows actually rendered, not on a control
 *    being present, so a filter that is painted but not wired fails.
 * 2. `and back` - a filter that narrows but cannot be released strands the
 *    player in a slice of their own memory, so the return to All is asserted
 *    with the full row count - both by pressing the All chip and by pressing the
 *    chip that is currently pressed.
 */
test("the Memory surface narrows to one origin and back", async ({ page }) => {
  const playerMemoryHandle = `${"N".repeat(42)}A`;
  const companionMemoryHandle = `${"Q".repeat(42)}A`;
  const memoryRevision = `${"M".repeat(42)}A`;

  const memoryWrites: unknown[] = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/memory", (route) => {
    // The filter is presentation state over the projection the Host already
    // sent, so a filter click must issue no request at all; a write reaching
    // this route is recorded and refused instead of being answered.
    if (route.request().method() !== "GET") {
      memoryWrites.push(route.request().postDataJSON());
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        projectionRevision: memoryRevision,
        memories: [
          {
            handle: playerMemoryHandle,
            title: "Player memory",
            content: "You told her about the farm.",
            category: "semantic",
            status: "active",
            origin: "player",
            pinned: false,
          },
          {
            handle: companionMemoryHandle,
            title: "Companion memory",
            content: "She remembers the rainy afternoon.",
            category: "interaction",
            status: "active",
            origin: "companion",
            pinned: false,
          },
        ],
        chapters: [],
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  const rows = surface.locator("[data-memory-state=ready] [role=listitem]");
  await expect(rows).toHaveCount(2);

  const filter = surface.locator("[data-memory-filter-group]");
  await expect(filter).toBeVisible();
  // The group is named by the panel's heading, and the two origin chips reuse the
  // labels the rows themselves carry: the filter is the same split, said twice.
  await expect(filter).toHaveAccessibleName("Your companion's notebook");
  const chips = {
    all: filter.locator("[data-memory-filter=all]"),
    player: filter.locator("[data-memory-filter=player]"),
    companion: filter.locator("[data-memory-filter=companion]"),
  };
  await expect(chips.all).toHaveText("All");
  await expect(chips.player).toHaveText("I told her this");
  await expect(chips.companion).toHaveText("She remembers this");
  await expect(chips.all).toHaveAttribute("aria-pressed", "true");

  await chips.player.click();
  await expect(chips.player).toHaveAttribute("aria-pressed", "true");
  await expect(chips.all).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("[data-memory-origin]")).toHaveAttribute("data-memory-origin", "player");
  await expect(surface).not.toContainText("She remembers the rainy afternoon.");

  await chips.companion.click();
  await expect(chips.companion).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("[data-memory-origin]")).toHaveAttribute("data-memory-origin", "companion");
  await expect(surface).not.toContainText("You told her about the farm.");

  // The pressed chip releases itself: pressing it again clears back to All.
  await chips.companion.click();
  await expect(chips.all).toHaveAttribute("aria-pressed", "true");
  await expect(chips.companion).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(2);

  // ...and the All chip reaches the same place from a fresh selection.
  await chips.player.click();
  await expect(rows).toHaveCount(1);
  await chips.all.click();
  await expect(chips.all).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(2);
  // Nothing here mutates anything: the filter is presentation state over the
  // projection the Host already sent.
  expect(memoryWrites).toEqual([]);
});

