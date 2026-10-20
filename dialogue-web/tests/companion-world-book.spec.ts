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
      companion: { name: "琥珀", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      // The mount's own World Info: the Host projects it from the same read its
      // `GET /world-info` answers from, so the surface reads this snapshot and not
      // the route. Empty is where a fresh product starts.
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
      jsonOk(worldBook ?? { apiVersion: 1, present: false, revision: null, entries: [] }),
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
    revision: 7,
    entries: [
      { title: "温室", keys: ["温室", "玻璃房"], constant: false, content: "温室的玻璃是她去年冬天换的,她说这样开春就能提前育苗。" },
      { title: "洒水器", keys: ["洒水器", "灌溉"], constant: false, content: "洒水器是她修好的,管子接在井边。" },
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

  // Each entry's own text is readable, one fold down. A row that shows which words
  // reach it but not what it says is a row the player can deliberately reach and
  // still cannot read - the half the earlier "the body is not projected" decision
  // left in place. The list itself is a disclosure, so it opens first; the entry's
  // own fold is what the text hides behind.
  await block.locator("[data-companion-world-book-disclosure] > summary").click();
  const firstText = entries.first().locator("[data-companion-world-book-entry-text]");
  await expect(firstText).toBeVisible();
  await firstText.locator("> summary").click();
  await expect(firstText).toContainText("温室的玻璃是她去年冬天换的");
  // …and the Host renders the card's macros before the browser ever sees the body,
  // so no placeholder can be painted here.
  await expect(block).not.toContainText("{{");

  // The attachable library is a DIFFERENT list and is empty here: it says so and
  // offers its own create control. Empty is now its own state rather than no
  // block at all - a fresh product's library is always empty, and a panel that
  // renders nothing there leaves the whole authoring path unreachable.
  const library = surface.locator("[data-world-book]");
  await expect(library.locator("[data-world-book-empty]")).toHaveText("你的世界书库还是空的。");
  await expect(library.locator("[data-world-book-create]")).toBeVisible();
});

test("a companion who has no world book renders no block for her own book", async ({ page }) => {
  await stubCharacters(page, null);
  const surface = await openCharacters(page, "Characters");

  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-companion-world-book]")).toHaveCount(0);
  // The attachable library is a different list with its own block, and on a fresh
  // product it is empty: it states that and offers create instead of rendering
  // nothing (which is how the authoring path used to be unreachable).
  const library = surface.locator("[data-world-book]");
  await expect(library.locator("[data-world-book-empty]")).toHaveText("Your world book library is empty.");
  await expect(library.locator("[data-world-book-create]")).toBeVisible();
  // The surface itself is not lost with the block: the library and its own
  // sections are still there.
  await expect(surface.getByRole("heading", { name: "Companions" })).toBeVisible();
});

test("a world book that carries no entries says so instead of showing a zero", async ({ page }) => {
  await stubCharacters(page, { apiVersion: 1, present: true, revision: 7, entries: [] });
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
      content: `第 ${index} 条正文。`,
    }));
  await stubCharacters(page, { apiVersion: 1, present: true, revision: 7, entries });
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

  await disclosure.locator("> summary").click();
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
    revision: 7,
    entries: [
      { title: "温室", keys: ["温室", "玻璃房"], constant: false, content: "温室的玻璃是她去年冬天换的,她说这样开春就能提前育苗。" },
      { title: "洒水器", keys: ["洒水器", "灌溉"], constant: false, content: "洒水器是她修好的,管子接在井边。" },
    ],
  });
  // The attachable library is non-empty here, so its own row is the comparison.
  // Registered after `stubCharacters`, which is what makes it win the match: the
  // library now reaches the surface through the composed snapshot's Chat half, so
  // the override is that route and not a second read of `/world-info`.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(
      jsonOk({
        ...composedRoot,
        chat: {
          ...composedRoot.chat,
          chat: {
            ...composedRoot.chat.chat,
            worldInfo: {
              state: "none",
              revision: handle,
              items: [
                { handle: worldInfoItemHandle, title: "Pelican Town", summary: null, selected: false, pending: false },
              ],
            },
          },
        },
      }),
    ),
  );
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await expect(block).toBeVisible();
  const disclosure = block.locator("[data-companion-world-book-disclosure]");
  await disclosure.locator("> summary").click();
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

/**
 * The book is the player's to edit, and the save is the Host's own answer.
 *
 * The whole entry list goes back on one `PUT`, CASed on the revision the read carried,
 * because the durable `entryId` is a storage fact the browser is never handed: the row
 * keys are the rendered facts the player read. The proof is the request the surface
 * actually sent (the revision and the edited text, field by field) and what the list
 * shows after the Host answered with its own re-projection - a surface that re-rendered
 * from a local guess would pass a screenshot and fail this.
 */
test("editing an entry's text and trigger words sends the revision it read, and the list shows the Host's reply", async ({ page }) => {
  const book = {
    apiVersion: 1,
    present: true,
    revision: 7,
    entries: [
      { title: "温室", keys: ["温室", "玻璃房"], constant: false, content: "温室的玻璃是她去年冬天换的。" },
      { title: "洒水器", keys: ["洒水器"], constant: false, content: "洒水器是她修好的。" },
    ],
  };
  await stubCharacters(page, book);
  const sent: { method: string; expectedRevision?: number; content?: string; keys?: readonly string[] }[] = [];
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(book));
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "null") as {
      expectedRevision: number;
      entries: readonly { title: string; keys: readonly string[]; content: string }[];
    };
    sent.push({ method: "PUT", expectedRevision: body.expectedRevision });
    sent[0]!.content = body.entries[0]!.content;
    sent[0]!.keys = body.entries[0]!.keys;
    // The Host's own reply: the same list at the next revision, already rendered.
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 8,
        entries: body.entries.map((entry) => ({ ...entry, content: entry.content })),
      }),
    );
  });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await block.locator("[data-companion-world-book-edit]").click();
  const editor = block.locator("[data-companion-world-book-draft]");
  await expect(editor).toBeVisible();
  await expect(editor.locator("h3")).toHaveText("正在编辑她自己的世界书");

  const firstBody = editor.locator("textarea").first();
  await firstBody.fill("{{user}}说这扇玻璃是她挑的。");
  await editor.locator('input[type="text"]').nth(1).fill("温室、玻璃房、花房");
  await editor.locator("[data-companion-world-book-save]").click();

  // The request the surface sent: the revision it read, the player's own words, her keys.
  await expect(block.locator("[data-companion-world-book-notice]")).toHaveText("已保存。");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.expectedRevision).toBe(7);
  expect(sent[0]!.content).toBe("{{user}}说这扇玻璃是她挑的。");
  expect(sent[0]!.keys).toEqual(["温室", "玻璃房", "花房"]);

  // …and the editor closed onto the list the Host returned.
  await expect(editor).toHaveCount(0);
  await block.locator("[data-companion-world-book-disclosure] > summary").click();
  const rows = block.locator("[data-companion-world-book-entry]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("触发词：温室、玻璃房、花房");
});

/**
 * An edit is invisible to a conversation that is already running, and the panel says so.
 *
 * The runtime publishes its authored catalog once, at mount, so a mounted Chat keeps the
 * background it loaded and picks an edit up when it mounts again. That is a fact about
 * the product a player has to be able to read before she presses save, not a silence -
 * the hint is asserted here in the same words the editor shows.
 */
test("the editor says when an edit reaches a conversation, because a running one keeps what it loaded", async ({ page }) => {
  await stubCharacters(page, {
    apiVersion: 1,
    present: true,
    revision: 7,
    entries: [{ title: "温室", keys: ["温室"], constant: false, content: "温室的玻璃。" }],
  });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await block.locator("[data-companion-world-book-edit]").click();
  await expect(block.locator("[data-companion-world-book-draft]")).toContainText(
    "正在进行的对话仍使用已经载入的背景，改动会在对话重新开始时生效。",
  );
});

/**
 * A save the Host refused because the book moved on says THAT, and the editor keeps the
 * revision it was opened on - so the surface never silently rebases a write over a change
 * the player never saw.
 */
test("a save refused because the book changed says the book changed, not that it failed", async ({ page }) => {
  const book = {
    apiVersion: 1,
    present: true,
    revision: 7,
    entries: [{ title: "温室", keys: ["温室"], constant: false, content: "温室的玻璃是她去年冬天换的。" }],
  };
  await stubCharacters(page, book);
  let attempts = 0;
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(book));
      return;
    }
    attempts += 1;
    // The Host's own problem body: `type`/`title`/`status`/`code`/`requestId`/`retryable`,
    // which is what the client validates before it reads `code` at all.
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "World book revision conflict",
        status: 409,
        code: "companion_world_book_conflict",
        requestId: csrfToken,
        retryable: false,
      }),
    });
  });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  const surface = await openCharacters(page, "角色");

  const block = surface.locator("[data-companion-world-book]");
  await block.locator("[data-companion-world-book-edit]").click();
  await block.locator("[data-companion-world-book-draft] textarea").first().fill("改过了。");
  await block.locator("[data-companion-world-book-save]").click();

  const notice = block.locator("[data-companion-world-book-notice]");
  await expect(notice).toContainText("她的世界书在你读取之后已被改动");
  await expect(notice).toContainText("没有保存");
  await expect(notice).not.toContainText("无法保存");

  // And it is the draft's own column, not the region's: the authoring form takes
  // the management measure and centres itself, and the sentence that reports its
  // outcome has to be the same box. Measured at 1440x900 before this, the draft sat
  // at 400..1040 and this banner at 16..1424 - the region's whole width, 768 px
  // wider than the form it was about.
  const draftBox = await block.locator("[data-companion-world-book-draft]").boundingBox();
  const noticeBox = await notice.boundingBox();
  console.log(`[world-book-notice] draft=${JSON.stringify(draftBox)} notice=${JSON.stringify(noticeBox)}`);
  expect(draftBox, "the draft is on screen to compare against").not.toBeNull();
  expect(Math.round(noticeBox!.x), "the refusal sits on the draft's own column").toBe(Math.round(draftBox!.x));
  expect(Math.round(noticeBox!.width), "and takes the draft's own measure").toBe(Math.round(draftBox!.width));

  // The read-back is the truth: the list shows the book that is actually there, while the
  // editor still CASes on the revision it was opened on, so a second save refuses again
  // rather than overwriting the change nobody showed her.
  await expect(block.locator("[data-companion-world-book-count]")).toHaveText("她自己的世界书里有 1 条词条");
  await block.locator("[data-companion-world-book-save]").click();
  await expect(notice).toContainText("她的世界书在你读取之后已被改动");
  expect(attempts).toBe(2);
});

/**
 * The editor at both widths, measured rather than eyeballed.
 *
 * The Characters surface is one column at 400x800 and six stacked sections; an editor
 * that overflows its column is what the earlier measurements in this file are about
 * (`[data-companion-world-book-list]` alone was 714 px of unwrapped trigger words). The
 * editor is three fields per row, so its own geometry is measured at both widths, and
 * after a save the list is asserted to be the book the Host returned.
 */
test("the editor fits its column at 1440x900 and at 400x800, and removing a row needs a confirmation", async ({ page }) => {
  const entries = Array.from({ length: 3 }, (_, index) => ({
    title: `词条 ${index}`,
    keys: ["料理", "做饭"],
    constant: false,
    content: `第 ${index} 条正文。`,
  }));
  const book = { apiVersion: 1, present: true, revision: 7, entries };
  await stubCharacters(page, book);
  let sentEntries: readonly { title: string; content: string }[] | null = null;
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(book));
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "null") as {
      entries: readonly { title: string; content: string }[];
    };
    sentEntries = body.entries;
    await route.fulfill(jsonOk({ apiVersion: 1, present: true, revision: 8, entries: body.entries }));
  });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));

  const surface = page.getByTestId("characters-surface");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  await expect(surface).toBeVisible();
  const block = surface.locator("[data-companion-world-book]");
  await block.locator("[data-companion-world-book-edit]").click();
  const editor = block.locator("[data-companion-world-book-draft]");
  await expect(editor).toBeVisible();

  // The same open editor at both widths: the geometry is what is being measured, so one
  // mount is measured twice rather than two mounts compared - a second navigation would
  // measure a different page load and, worse, would measure an editor that is not open.
  const measure = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await expect(editor).toBeVisible();
    return await editor.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const inputs = [...node.querySelectorAll<HTMLElement>("input, textarea")].map((field) =>
        Math.round(field.getBoundingClientRect().width),
      );
      return { width: Math.round(rect.width), right: Math.round(rect.right), fields: inputs.length, widest: Math.max(...inputs) };
    });
  };

  const wide = await measure(1440, 900);
  const narrow = await measure(400, 800);
  console.log(`[world-book-editor] wide=${JSON.stringify(wide)} narrow=${JSON.stringify(narrow)}`);
  for (const [label, measured, viewport] of [
    ["1440x900", wide, 1440],
    ["400x800", narrow, 400],
  ] as const) {
    expect(measured.width, `${label}: the editor has a width`).toBeGreaterThan(0);
    expect(measured.right, `${label}: the editor stays inside its viewport`).toBeLessThanOrEqual(viewport);
    expect(measured.fields, `${label}: three fields per row`).toBe(9);
    expect(measured.widest, `${label}: no field is collapsed to nothing`).toBeGreaterThan(40);
  }

  // Removing a row is armed first: a bare delete beside the save control is a control a
  // player fires by accident, and her entry is not recoverable after the save.
  await editor.locator("[data-companion-world-book-remove]").first().click();
  await expect(editor.locator("[data-companion-world-book-remove-yes]")).toBeVisible();
  await editor.locator("[data-companion-world-book-remove-no]").click();
  await expect(editor.locator("[data-companion-world-book-remove-yes]")).toHaveCount(0);
  await expect(editor.locator("[data-companion-world-book-entry-draft]")).toHaveCount(3);

  await editor.locator("[data-companion-world-book-remove]").first().click();
  await editor.locator("[data-companion-world-book-remove-yes]").click();
  await expect(editor.locator("[data-companion-world-book-entry-draft]")).toHaveCount(2);
  await editor.locator("[data-companion-world-book-save]").click();
  await expect(block.locator("[data-companion-world-book-notice]")).toHaveText("已保存。");
  expect(sentEntries!.map((entry) => entry.title)).toEqual(["词条 1", "词条 2"]);
});
