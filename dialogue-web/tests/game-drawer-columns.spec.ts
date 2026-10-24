import { expect, test, type Page } from "@playwright/test";

/**
 * The Game drawer's columns, measured rather than assumed.
 *
 * **F1: the empty board must not occupy half the drawer alone.** When the
 * capability board has nothing published it is one sentence, and it was still
 * taking its own half-width grid cell while the guide took the other - so at
 * 1440x900 the drawer was two 694 px columns, the board painted 56..130 (74 px)
 * and the next block in its column started at 598: **448 px of blank under it,
 * 85% of a 536 px row**, on the one state a fresh session always opens in.
 *
 * The fix is a placement, not a reflow: while the board is in its waiting shape
 * the guide spans the drawer's rows and the three short blocks stack beside it.
 * The reading order is untouched (the guide still leads and the board still
 * follows it in the DOM), the published board is untouched (it keeps its own
 * cell and its own cards), and the narrow window is untouched (one column, the
 * primary control where the previous ruling put it).
 */
const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";
const projectionRevision = "P".repeat(42) + "A";

type Entry = Readonly<{ role: "player" | "companion"; text: string; opening?: boolean; swipes?: { index: number; total: number } }>;

const TRANSCRIPT: readonly Entry[] = [
  { role: "companion", text: "The lantern over the porch is still lit.", opening: true },
  { role: "player", text: "Where are we?" },
  { role: "companion", text: "On the pier. *She leans on the rail.*", swipes: { index: 1, total: 3 } },
  { role: "player", text: "And now?" },
  { role: "companion", text: "Still on the pier." },
];

function composedRoot(published: boolean) {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
        title: null,
        transcript: TRANSCRIPT.map((entry, index) => ({
          handle: `M${String(index).padStart(2, "0")}${"A".repeat(40)}`,
          role: entry.role,
          text: entry.text,
          locale: "und",
          order: index,
          revision: 1,
          ...(entry.opening === true
            ? { openingVariant: { variantId: `${"V".repeat(42)}A`, index: 0, count: 2, label: "Default", locked: false } }
            : {}),
          ...(entry.swipes === undefined
            ? {}
            : {
                swipeInfo: {
                  currentIndex: entry.swipes.index,
                  totalSwipes: entry.swipes.total,
                  label: `\u25c0 ${entry.swipes.index + 1}/${entry.swipes.total} \u25b6`,
                  hasPrevious: entry.swipes.index > 0,
                  hasNext: entry.swipes.index < entry.swipes.total - 1,
                },
              }),
        })),
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
        capabilitySummary: published ? { available: true, count: 4 } : { available: false, count: 0 },
        latestOutcome: "none",
      },
    },
  };
}

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function mountGame(page: Page, options: Readonly<{ locale?: string; published?: boolean }> = {}): Promise<void> {
  const body = JSON.stringify(composedRoot(options.published === true));
  const locale = options.locale ?? "en";
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  // Both reads carry the same projection: the shell re-reads `game.state.read` on a mount, so a
  // bootstrap-only fixture would be overwritten by the empty one.
  for (const pattern of ["**/api/composed-reference-game/v1/bootstrap", "**/api/composed-reference-game/v1/state"]) {
    await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
  }
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: [], chapters: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect(page.locator(".game-capability-board")).toBeVisible();
}

type DrawerReading = Readonly<{
  viewport: { width: number; height: number };
  columns: string;
  drawer: { top: number; bottom: number; width: number; height: number };
  order: readonly string[];
  blocks: readonly Readonly<{ name: string; top: number; bottom: number; left: number; width: number; height: number }>[];
  board: { top: number; bottom: number; left: number; width: number; height: number } | null;
  activate: { top: number; bottom: number } | null;
  install: { top: number; bottom: number } | null;
  /**
   * The blank under the board in its own column: from its bottom edge to the next block that shares
   * its left edge (or to the drawer's bottom when nothing does). This is the number the defect is.
   */
  blankUnderBoard: number;
}>;

async function readDrawer(page: Page): Promise<DrawerReading> {
  return await page.evaluate(() => {
    const round = (value: number) => Math.round(value);
    const box = (node: Element | null) => {
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return {
        top: round(rect.top),
        bottom: round(rect.bottom),
        left: round(rect.left),
        width: round(rect.width),
        height: round(rect.height),
      };
    };
    const drawer = document.querySelector<HTMLElement>(".composed-game-drawer")!;
    const drawerBox = drawer.getBoundingClientRect();
    const board = drawer.querySelector<HTMLElement>('[data-testid="game-capability-board"]');
    // The next block in the board's own column, or the drawer's own bottom.
    const blankUnderBoard =
      board === null
        ? 0
        : (() => {
            const boardBox = board.getBoundingClientRect();
            const below = [...drawer.children]
              .filter((child) => child !== board)
              .map((child) => child.getBoundingClientRect())
              .filter((rect) => Math.round(rect.left) === Math.round(boardBox.left) && rect.top > boardBox.bottom - 1)
              .sort((a, b) => a.top - b.top);
            const next = below[0];
            return round((next === undefined ? drawerBox.bottom : next.top) - boardBox.bottom);
          })();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      columns: getComputedStyle(drawer).gridTemplateColumns,
      drawer: box(drawer)!,
      order: [...drawer.children].map((child) => child.id || child.getAttribute("data-testid") || ""),
      blocks: [...drawer.children].map((child) => ({
        name: child.id || child.getAttribute("data-testid") || "",
        ...box(child)!,
      })),
      board: box(board),
      activate: box(drawer.querySelector('[data-testid="game-activate"]')),
      install: box(document.querySelector(".game-installation-panel")),
      blankUnderBoard,
    };
  });
}

test("the empty capability board does not occupy half the drawer alone", async ({ page }) => {
  await mountGame(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const wide = await readDrawer(page);
  console.log(`[drawer-columns @1440x900] ${JSON.stringify(wide)}`);

  expect(wide.board, "the empty board renders").not.toBeNull();
  // Two columns at 1440 - the drawer's own panes, unchanged; this is the cell the board sits in.
  expect(wide.columns, "the desktop drawer is still two columns").toBe("694px 694px");

  // The defect: the board's own column carried 448 px of blank under a 74 px board.
  expect(
    wide.blankUnderBoard,
    `the board stands ${wide.blankUnderBoard} px clear of the next block in its own column, over a ${wide.board!.height} px board`,
  ).toBeLessThan(40);

  // The space that was blank is now used: the three short blocks sit in the board's column, under
  // it, and the whole drawer is a third shorter.
  const withBoard = wide.blocks.filter((block) => block.left === wide.board!.left);
  expect(withBoard.length, "the board's column carries more than the board alone").toBeGreaterThan(1);
  expect(wide.drawer.height, "the drawer is a third shorter than the 788 px it measured").toBeLessThan(600);

  // The reading order is untouched: the guide leads, and the board still follows it in the DOM.
  expect(wide.order[0], "the guide is still the first group").toBe("game-group-next-step");
  const boardIndex = wide.order.indexOf("game-capability-board");
  expect(boardIndex, "and the board still follows it").toBeGreaterThan(0);

  // No block overlaps another: the placement is a layout, not a paint.
  for (let first = 0; first < wide.blocks.length; first += 1) {
    for (let second = first + 1; second < wide.blocks.length; second += 1) {
      const a = wide.blocks[first]!;
      const b = wide.blocks[second]!;
      const across = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(`${a.name} over ${b.name}`, `${across}px across and ${down}px down`).not.toBe(
        across > 0 && down > 0 ? `${a.name} over ${b.name}` : "",
      );
    }
  }

  // The narrow window keeps the result the previous ruling measured: one column, and the primary
  // control where a fresh session can reach it (measured 270..314 in a 782 px scroller).
  for (const viewport of [
    { width: 400, height: 800 },
    { width: 700, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const narrow = await readDrawer(page);
    console.log(`[drawer-columns @${viewport.width}x${viewport.height}] ${JSON.stringify(narrow)}`);
    expect(narrow.columns.split(" ").length, `the ${viewport.width} px drawer is one column`).toBe(1);
    expect(narrow.activate, "the primary control is on the surface").not.toBeNull();
    expect(
      narrow.activate!.bottom,
      `the primary control's bottom is at ${narrow.activate!.bottom} inside the ${viewport.height} px viewport`,
    ).toBeLessThan(viewport.height);
    expect(narrow.order[0], "and the guide still leads the narrow reading order").toBe("game-group-next-step");
  }
});

test("a published capability board keeps its own cell and its own cards", async ({ page }) => {
  await mountGame(page, { published: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("[data-capability-card]")).toHaveCount(3);

  const wide = await readDrawer(page);
  console.log(`[drawer-columns published @1440x900] ${JSON.stringify(wide)}`);

  // The board leads and the guide shares the row with it: the placement rule must not reach this
  // state, because the board here has a real fact to state and holds its own cell's worth of it.
  expect(wide.order[0], "the published board leads").toBe("game-capability-board");
  const boardColumn = wide.blocks.filter((block) => block.left === wide.board!.left);
  expect(boardColumn.length, "the published board does not stand alone in its column").toBeGreaterThan(1);
  expect(
    boardColumn.some((block) => block.name === "game-group-session"),
    "the session group sits under the published board",
  ).toBe(true);
  // And the guide is still reachable beside it, in the same reading order it had.
  expect(wide.activate!.top, "the guide's primary control is still on screen").toBeLessThan(900);
});
