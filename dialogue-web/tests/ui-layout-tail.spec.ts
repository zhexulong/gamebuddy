import { expect, test, type Page } from "@playwright/test";

/**
 * The layout tail: four surfaces where the shell's own geometry, not its
 * content, is what the player reads as broken.
 *
 * Every number below is measured off the live cascade at the two viewports the
 * audit's shots were taken at (1440x900 and 400x800) - a row's card bottoms, a
 * panel's scroll height, a control's width, the visible text of a control - not
 * read out of a class name. Each assertion quotes the measurement it decided on,
 * and each defect's "before" is in the test's own comment so the fix can be told
 * apart from a re-measurement.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const companionHandle = "B".repeat(42) + "A";
const worldInfoHandle = "W".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The mounted Chat's transcript carries one companion turn for the pager items. */
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
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      },
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: companionHandle, generation: 1, stateRevision: companionHandle },
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

/**
 * The Characters surface as the generation really mounts it: three authored
 * groups present, a companion with a voice directive, and an opening the card
 * shipped with three variants. The 730 px card the audit measured is that third
 * variant editor - it is content, not slack, so the fix may not be to delete it.
 */
async function stubShell(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        companions: [{ handle: companionHandle, name: "琥珀", isCurrent: true }],
      }),
    ),
  );
  await page.route(/\/api\/tavern\/v1\/companions\/[^/]+\/voice/u, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        profileRevision: 1,
        characterVoice: { text: "轻声，语速慢一点。", source: "card" },
      }),
    ),
  );
  await page.route(/\/api\/tavern\/v1\/companions\/[^/]+\/worldbook/u, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        // The shipped default companion's own book: seven keyed entries, which
        // is what the audit's surface carried.
        entries: Array.from({ length: 7 }, (_, index) => ({
          title: `词条 ${index}`,
          keys: ["料理", "做饭", "黑莓脆皮乐", "土豆饼", "绿茶"],
          constant: false,
        })),
      }),
    ),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        name: "拓荒者",
        description: "刚下车的农场主。",
      }),
    ),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        name: "鹈鹕镇",
        description: "春天的第一周。",
        preview: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        label: "默认",
        variants: [
          { label: "默认", text: "清晨的鹈鹕镇还没醒。" },
          { label: "雨夜", text: "雨点落在谷仓的铁皮上。" },
          { label: "集市", text: "集市的日子，人来人往。" },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldInfoHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/u, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
}

/**
 * The Characters grid's own geometry: every card's box, grouped into the rows
 * the grid actually placed them in. A row's track is as tall as its tallest
 * card, so the dead space a short card leaves is `rowBottom - cardBottom` - the
 * number the audit quoted as 348 px and 405 px.
 */
async function measureCharactersGrid(page: Page) {
  return await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-characters-panel]");
    if (panel === null) return null;
    const style = getComputedStyle(panel);
    const round = (value: number) => Math.round(value);
    const columns = style.gridTemplateColumns.split(/\s+/u).filter((value) => value.length > 0);
    const cards = [...panel.children].map((child) => {
      const box = child.getBoundingClientRect();
      return {
        label: child.getAttribute("aria-label") ?? child.tagName.toLowerCase(),
        left: round(box.left),
        top: round(box.top),
        width: round(box.width),
        height: round(box.height),
        bottom: round(box.bottom),
      };
    });
    const rowTops = [...new Set(cards.map((card) => card.top))].sort((left, right) => left - right);
    const rows = rowTops.map((top) => {
      const inRow = cards.filter((card) => card.top === top);
      const bottom = Math.max(...inRow.map((card) => card.bottom));
      return {
        top,
        bottom,
        height: bottom - top,
        cards: inRow.map((card) => ({
          label: card.label,
          height: card.height,
          deadGap: bottom - card.bottom,
        })),
      };
    });
    return {
      display: style.display,
      columnCount: columns.length,
      columnGap: round(Number.parseFloat(style.columnGap) || 0),
      rowGap: round(Number.parseFloat(style.rowGap) || 0),
      panelScrollHeight: panel.scrollHeight,
      cardCount: cards.length,
      rows,
      largestDeadGap: Math.max(0, ...rows.flatMap((row) => row.cards.map((card) => card.deadGap))),
    };
  });
}

test("item 1: one row's cards end on one line, and the trigger list is folded by default", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  await expect(page.locator("[data-opening-editor]")).toBeVisible();

  // The companion's own world book is a disclosure, and the audit's own claim is
  // that it is closed: if it were open, the tallest card would be this, not the
  // opening editor.
  const disclosure = page.locator("[data-companion-world-book-disclosure]");
  await expect(disclosure).toBeVisible();
  const disclosureState = await disclosure.evaluate((node: HTMLDetailsElement) => {
    const box = node.getBoundingClientRect();
    const rows = [...node.querySelectorAll<HTMLElement>("[data-companion-world-book-entry]")];
    // What a folded disclosure must not do is paint a row. A row that is still
    // laid out but skipped (the closed `details`' own hiding) reports a stale box
    // outside the disclosure's own: only a box INSIDE it is paint.
    const insideDisclosure = rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.top < box.bottom - 0.5 && rect.bottom > box.top + 0.5;
    }).length;
    return {
      open: node.open,
      rows: rows.length,
      rowsLaidOut: rows.filter((row) => row.getBoundingClientRect().height > 0).length,
      rowsPaintedInside: insideDisclosure,
      height: Math.round(box.height),
      cardHeight: Math.round(node.closest("section")!.getBoundingClientRect().height),
    };
  });
  console.log(`[item-1 disclosure] ${JSON.stringify(disclosureState)}`);
  console.log(`[item-1 row visible to playwright] ${await disclosure.locator("[data-companion-world-book-entry]").first().isVisible()}`);

  const grid = await measureCharactersGrid(page);
  console.log(`[item-1 characters @1440] ${JSON.stringify(grid)}`);
  expect(grid, "the Characters surface lays its cards out as a grid").not.toBeNull();

  expect(disclosureState.open, "the trigger list is folded by default, so its card is one summary tall").toBe(false);
  expect(disclosureState.rowsPaintedInside, "a folded disclosure paints none of its rows").toBe(0);
  expect(disclosureState.rows, "the rows are still in the DOM while folded").toBe(7);
  expect(await disclosure.locator("[data-companion-world-book-entry]").first().isVisible(), "a folded row is hidden")
    .toBe(false);

  // The target: a card's bottom edge is at its row's bottom edge, to within the
  // grid's own gap. Before the fix at 1440x900 the second row's short cards
  // measured 382 px and 325 px against a 730 px track (dead gaps 348 / 405).
  expect(grid!.columnCount, "1440 leaves room for three columns").toBe(3);
  expect(grid!.largestDeadGap, `no card leaves a gap larger than the ${grid!.rowGap} px grid gap`).toBeLessThanOrEqual(
    grid!.rowGap,
  );
});
