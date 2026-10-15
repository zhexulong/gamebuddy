import { expect, test } from "@playwright/test";

/**
 * The companion's OWN world book on the Characters surface.
 *
 * The defect (audit `shots-final7`, commit 6c447329): the surface's 世界书 block
 * read the managed World Info LIBRARY (`GET /world-info`) - the artifacts a
 * conversation may attach - while it was labelled "该角色的对话所读取的世界书。". In a
 * fresh product that library is empty, so the surface printed
 * `暂时没有可用的世界书。` beside a companion that durably HAS a world book: the
 * shipped default companion carries seven keyed entries, and a card imported with
 * `character_book.entries[].keys` persists its trigger words (`bc848292`). A
 * player who had just imported a card was told, in effect, that nothing was kept.
 *
 * The two lists are different things and are now rendered as such: the
 * companion's own book (this file) with its entries and their trigger words, and
 * the attachable library separately (`[data-world-book]`, covered by the
 * management-surface and composed-reference-game journeys).
 *
 * The assertions, and the failure each one catches:
 *  - a companion whose book carries keyed entries shows the COUNT as text and
 *    each entry's TRIGGER WORDS: catches the entries being projected but not
 *    shown, or shown as titles with the words that actually reach them dropped;
 *  - a companion with no book renders NO block at all: catches an empty box (or a
 *    "nothing here" sentence) standing in for a book that was never kept;
 *  - a book that is present but carries no entries says so in words: catches a
 *    bare zero that a player reads as a book whose entries were lost.
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const worldInfoItemHandle = "V".repeat(42) + "A";
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
      companion: { name: "琥珀" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
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

/**
 * Everything the Characters surface reads once on mount, with the companion's own
 * world book under test. `null` serves `present: false` (this companion has no
 * book); the attachable library stays empty here, which is the state the audit
 * measured.
 */
async function stubCharacters(
  page: import("@playwright/test").Page,
  worldBook: Record<string, unknown> | null,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "琥珀", isCurrent: true }] })),
  );
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, (route) =>
    route.fulfill(
      jsonOk(worldBook ?? { apiVersion: 1, present: false, entries: [] }),
    ),
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
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: handle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
}

async function openCharacters(
  page: import("@playwright/test").Page,
  navLabel: string,
): Promise<import("@playwright/test").Locator> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: navLabel, exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  return surface;
}

test("a companion who has a world book shows its count and its trigger words", async ({ page }) => {
  // The audit's own shape: a card imported with two keyed entries persisted
  // `keys = [温室,玻璃房] [洒水器,灌溉]` in the companion's worldbook.json.
  await stubCharacters(page, {
    apiVersion: 1,
    present: true,
    entries: [
      { title: "温室", keys: ["温室", "玻璃房"], constant: false },
      { title: "洒水器", keys: ["洒水器", "灌溉"], constant: false },
    ],
  });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await expect(block).toBeVisible();
  await expect(block.locator("h3")).toHaveText("伴侣自己的世界书");
  // The count is text a player reads, not only an attribute or a list header.
  await expect(block.locator("[data-companion-world-book-count]")).toHaveText(
    "她自己的世界书里有 2 条词条",
  );

  const entries = block.locator("[data-companion-world-book-entry]");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText("温室");
  await expect(entries.first()).toContainText("触发词：温室、玻璃房");
  await expect(entries.nth(1)).toContainText("洒水器");
  await expect(entries.nth(1)).toContainText("触发词：洒水器、灌溉");

  // The attachable library is a DIFFERENT list and is empty here, so its block is
  // not rendered at all - it can no longer read as "you have no world book".
  await expect(surface.locator("[data-world-book]")).toHaveCount(0);
});

test("a companion who has no world book renders no world-book block", async ({ page }) => {
  await stubCharacters(page, null);
  const surface = await openCharacters(page, "Characters");

  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-companion-world-book]")).toHaveCount(0);
  await expect(surface.locator("[data-world-book]")).toHaveCount(0);
  // The surface itself is not lost with the block: the library and its own
  // sections are still there.
  await expect(surface.getByRole("heading", { name: "Companions" })).toBeVisible();
});

test("a world book that carries no entries says so instead of showing a zero", async ({ page }) => {
  await stubCharacters(page, { apiVersion: 1, present: true, entries: [] });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await expect(block).toBeVisible();
  await expect(block.locator("[data-companion-world-book-empty]")).toHaveText(
    "她的世界书已在这里，但里面还没有词条。",
  );
  await expect(block.locator("[data-companion-world-book-count]")).toHaveCount(0);
  await expect(block.locator("[data-companion-world-book-entry]")).toHaveCount(0);
});


/**
 * The trigger list is a wall at the narrow width. Measured on the shipped set
 * (`shots-final10`, d-characters-swipe): at 400x800 the Characters surface is a
 * single column, `[data-companion-world-book-list]` alone was 714 px of unwrapped
 * trigger words with no way to fold it, and the surface's content scrolled 2810 px
 * in a 682 px region. The entries are a disclosure now (closed by default), so the
 * count is what the section costs until the player asks for the words - and the
 * rows are still in the DOM, so nothing was deleted to make it fit.
 */
test("the companion's trigger list folds into a disclosure at 400x800", async ({ page }) => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    title: `词条 ${index}`,
    keys: ["料理", "做饭", "黑莓脆皮乐", "土豆饼", "绿茶", "防风草", "清晨", "拓荒"],
    constant: false,
  }));
  await stubCharacters(page, { apiVersion: 1, present: true, entries });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();

  const block = surface.locator("[data-companion-world-book]");
  await expect(block).toBeVisible();
  const disclosure = block.locator("[data-companion-world-book-disclosure]");
  await expect(disclosure).toBeVisible();
  // The count is the disclosure's own summary, and it is visible while closed.
  await expect(block.locator("[data-companion-world-book-count]")).toBeVisible();
  await expect(block.locator("[data-companion-world-book-count]")).toHaveText("她自己的世界书里有 8 条词条");

  // Closed by default: every row is still in the DOM, none of them is painted.
  const rows = block.locator("[data-companion-world-book-entry]");
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toBeHidden();
  const collapsed = await block.evaluate((node) => Math.round(node.getBoundingClientRect().height));

  await disclosure.locator("summary").click();
  await expect(rows.first()).toBeVisible();
  const expanded = await block.evaluate((node) => Math.round(node.getBoundingClientRect().height));
  console.log(`[world-book-disclosure] collapsed=${collapsed} expanded=${expanded}`);
  expect(expanded, "opening the disclosure reveals the trigger list").toBeGreaterThan(collapsed + 200);
});

/**
 * The companion's own trigger list is the card/list layer, measured against the
 * bindable library's rows IN THE SAME MOUNT.
 *
 * The measured defect (`shots-final10`, 10-角色-1440x900): the two lists render
 * one above the other on the Characters surface, and only the library's rows had
 * stylesheet rules - `[data-world-book-list]`, used by
 * `CharactersSurfacePanel.tsx:230` - while the companion's own list
 * (`data-companion-world-book-list`, `:124`, shipped by 6c447329) matched no rule
 * at all. So the seven entries at the foot of the surface painted as bare,
 * squeezed text: transparent, no border, no padding, no row floor, and 14 px
 * body copy beside 13 px sibling rows.
 *
 * The comparison is geometry and typography read off the live cascade, not a
 * class or attribute check, and both rows are measured in one page: the
 * companion's first entry against the library's first (attachable) row. The
 * properties compared are the ones the card/list layer declares for both.
 */
test("the companion's own trigger list draws the same card rows as the bindable library beside it", async ({ page }) => {
  await stubCharacters(page, {
    apiVersion: 1,
    present: true,
    entries: [
      { title: "温室", keys: ["温室", "玻璃房"], constant: false },
      { title: "洒水器", keys: ["洒水器", "灌溉"], constant: false },
    ],
  });
  // The attachable library is non-empty here, so its own row is the comparison.
  // Registered after `stubCharacters`, which is what makes it win the match.
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(
      jsonOk({
        state: "none",
        revision: handle,
        items: [{ handle: worldInfoItemHandle, title: "Pelican Town", summary: null, selected: false, pending: false }],
      }),
    ),
  );
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await expect(block).toBeVisible();
  const disclosure = block.locator("[data-companion-world-book-disclosure]");
  await disclosure.locator("summary").click();
  await expect(block.locator("[data-companion-world-book-entry]").first()).toBeVisible();
  await expect(surface.locator("[data-world-book-list] > [role=listitem]").first()).toBeVisible();

  const measured = await surface.evaluate((node) => {
    const readList = (selector: string) => {
      const list = node.querySelector<HTMLElement>(selector);
      if (list === null) return null;
      const style = getComputedStyle(list);
      return {
        display: style.display,
        direction: style.flexDirection,
        gap: style.rowGap,
        listStyle: style.listStyleType,
        marker: style.listStylePosition,
      };
    };
    const read = (selector: string) => {
      const row = node.querySelector<HTMLElement>(selector);
      if (row === null) return null;
      const style = getComputedStyle(row);
      const strong = row.querySelector<HTMLElement>("strong");
      const strongStyle = strong === null ? null : getComputedStyle(strong);
      const rect = row.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        borderColor: style.borderTopColor,
        radius: style.borderTopLeftRadius,
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        listStyle: style.listStyleType,
        strongFontSize: strongStyle?.fontSize ?? null,
        strongFontWeight: strongStyle?.fontWeight ?? null,
        strongColor: strongStyle?.color ?? null,
      };
    };
    return {
      companion: read("[data-companion-world-book-list] > [data-companion-world-book-entry]"),
      library: read("[data-world-book-list] > [role=listitem]"),
      companionList: readList("[data-companion-world-book-list]"),
      libraryList: readList("[data-world-book-list]"),
    };
  });
  console.log(`[companion-world-book-list] measured: ${JSON.stringify(measured)}`);

  const { companion, library, companionList, libraryList } = measured;
  expect(companion, "the companion's own entry row renders").not.toBeNull();
  expect(library, "the bindable library's own row renders").not.toBeNull();
  // One card treatment for both rows: the same tone, hairline, radius, padding
  // and row floor, measured in one mount.
  expect(companion!.background, "the companion's entry is a card, not bare text").toBe(library!.background);
  expect(companion!.background, "the card tone, not the surface behind it").not.toBe("rgba(0, 0, 0, 0)");
  expect({ width: companion!.borderWidth, style: companion!.borderStyle, color: companion!.borderColor }).toEqual({
    width: library!.borderWidth,
    style: library!.borderStyle,
    color: library!.borderColor,
  });
  expect(companion!.radius).toBe(library!.radius);
  expect(companion!.padding).toBe(library!.padding);
  expect(companion!.height, "the entry clears the 52 px row floor").toBeGreaterThanOrEqual(52);
  // The typography of both rows, not only the container.
  expect(companion!.strongFontSize).toBe(library!.strongFontSize);
  expect(companion!.strongFontWeight).toBe(library!.strongFontWeight);
  expect(companion!.strongColor).toBe(library!.strongColor);
  // A `role="list"` of drawers/cards paints no markers either way, and the two
  // containers are the same column with the same 8 px cadence.
  expect(companion!.listStyle).toBe(library!.listStyle);
  expect(companionList).toEqual(libraryList);
  expect(companionList!.display, "the list itself is a column").toBe("flex");
  expect(companionList!.listStyle, "no marker from the container").toBe("none");
});
