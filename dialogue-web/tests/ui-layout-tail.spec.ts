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
      companion: { name: "琥珀", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
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

/** The mounted Chat over a given transcript, for the pager items. */
function chatRoot(transcript: readonly Readonly<Record<string, unknown>>[]) {
  return { ...composedRoot, chat: { ...composedRoot.chat, chat: { ...composedRoot.chat.chat, transcript } } };
}

/**
 * The Characters surface as the generation really mounts it: three authored
 * groups present, a companion with a voice directive, and an opening the card
 * shipped with three variants. The 730 px card the audit measured is that third
 * variant editor - it is content, not slack, so the fix may not be to delete it.
 */
async function stubShell(
  page: Page,
  options: Readonly<{ transcript?: readonly Readonly<Record<string, unknown>>[] }> = {},
): Promise<void> {
  const root = options.transcript === undefined ? composedRoot : chatRoot(options.transcript);
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
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
        // The revision the book is CASed on. The mirror validates the read exactly,
        // and a fixture without it is rejected whole - the section then renders
        // nothing at all, which is what this stub did before the field was added
        // here: the disclosure below was simply absent from the DOM.
        revision: 1,
        // The shipped default companion's own book: seven keyed entries, which
        // is what the audit's surface carried.
        entries: Array.from({ length: 7 }, (_, index) => ({
          title: `词条 ${index}`,
          keys: ["料理", "做饭", "黑莓脆皮乐", "土豆饼", "绿茶"],
          constant: false,
          // The client mirror validates the entry exactly, and the body is part of
          // that shape (the Host renders it through the macro table before sending
          // it). A fixture without it is rejected whole, and the section then renders
          // nothing at all - which is what this stub did until the shape grew.
          content: `第 ${index} 条正文。`,
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
 * The Characters grid's own geometry: every card's box, plus how much of that box
 * is empty card - the distance from the card's own last child (and that child's
 * margin) down to its inner bottom edge. A card whose content is its own height
 * reports `slack` 0; a card stretched to its row's tallest neighbour reports
 * exactly the height it does not fill.
 */
async function measureCharactersGrid(page: Page) {
  return await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-characters-panel]");
    if (panel === null) return null;
    const style = getComputedStyle(panel);
    const round = (value: number) => Math.round(value);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const columns = style.gridTemplateColumns.split(/\s+/u).filter((value) => value.length > 0);
    const cards = [...panel.children].map((child) => {
      const card = child as HTMLElement;
      const box = card.getBoundingClientRect();
      const own = getComputedStyle(card);
      const last = card.lastElementChild;
      const lastBox = last === null ? null : last.getBoundingClientRect();
      const contentBottom =
        lastBox === null ? box.bottom : lastBox.bottom + px(getComputedStyle(last!).marginBottom);
      const innerBottom = box.bottom - px(own.paddingBottom) - px(own.borderBottomWidth);
      return {
        label: card.getAttribute("aria-label") ?? card.tagName.toLowerCase(),
        left: round(box.left),
        top: round(box.top),
        width: round(box.width),
        height: round(box.height),
        bottom: round(box.bottom),
        contentBottom: round(contentBottom),
        slack: round(innerBottom - contentBottom),
      };
    });
    const rowTops = [...new Set(cards.map((card) => card.top))].sort((left, right) => left - right);
    const rows = rowTops.map((top) => {
      const inRow = cards.filter((card) => card.top === top);
      return {
        top,
        cardCount: inRow.length,
        bottoms: inRow.map((card) => card.bottom),
        cards: inRow.map((card) => `${card.label}: ${card.contentBottom}->${card.bottom} (${card.slack} px)`),
      };
    });
    return {
      display: style.display,
      alignItems: style.alignItems,
      columnCount: columns.length,
      columnGap: round(px(style.columnGap)),
      rowGap: round(px(style.rowGap)),
      panelScrollHeight: panel.scrollHeight,
      cardCount: cards.length,
      rows,
      cards,
      largestSlack: Math.max(0, ...cards.map((card) => card.slack)),
    };
  });
}

test("item 1: a card is as tall as its own content, and the trigger list is folded by default", async ({ page }) => {
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

  // The target: a card's box is its own content, not its row's tallest neighbour.
  // Before the change the grid's default `stretch` made every card in the second
  // row 730 px tall, while the persona and scenario cards' content ended at
  // y=824 and y=766 against a card bottom of 1130 - 306 px and 364 px of empty
  // card below their last control. The allowance is 1 px: the box is the content
  // plus the card's own 12 px padding and 1 px border, and nothing else.
  expect(grid!.columnCount, "1440 leaves room for three columns").toBe(3);
  expect(
    grid!.largestSlack,
    `every card ends within 1 px of its own content: ${JSON.stringify(grid!.rows)}`,
  ).toBeLessThanOrEqual(1);

  // Sensitivity proof, measured through the same probe: the pre-fix `stretch` is
  // what padded a short card to its row's tallest neighbour. The injected rule is
  // unlayered, so it wins over the layered stylesheet.
  const stretch = await page.addStyleTag({
    content: "[data-characters-panel] { align-items: stretch; }\n",
  });
  const stretched = await measureCharactersGrid(page);
  console.log(`[item-1 characters @1440, stretch injected] ${JSON.stringify(stretched)}`);
  await stretch.evaluate((node) => node.remove());
  expect(stretched, "the Characters surface renders with `stretch` injected").not.toBeNull();
  expect(
    stretched!.largestSlack,
    `stretch pads the short cards to the row's tallest again (${JSON.stringify(stretched!.rows)}); the assertion above is what sees it`,
  ).toBeGreaterThan(100);

  // …and the same holds in the one-column layout, where every card is its own row.
  await page.setViewportSize({ width: 400, height: 800 });
  const narrow = await measureCharactersGrid(page);
  console.log(`[item-1 characters @400] ${JSON.stringify(narrow)}`);
  expect(narrow, "the Characters surface renders at 400").not.toBeNull();
  expect(narrow!.columnCount, "400 is one column").toBe(1);
  expect(narrow!.cardCount, "every card is still mounted").toBe(grid!.cardCount);
  expect(
    narrow!.largestSlack,
    `at 400 every card is its own content too: ${JSON.stringify(narrow!.rows)}`,
  ).toBeLessThanOrEqual(1);
});

/**
 * The Settings surface's own reads: the language, voice, connection and
 * model-profile groups all mount only once their read resolves, so every one of
 * them is served here. The connection list is empty, which is the state the audit
 * measured: the field stacks under test are the creation form, the three
 * selectors (interface language, companion language, output device) and the two
 * model editors.
 */
const connectionEscapeHatch = {
  providerId: "openai-compatible",
  label: "OpenAI-compatible",
  setupFields: ["apiKey", "baseUrl", "apiShape", "modelId"],
  allowedPlayerModels: [],
  escapeHatch: true,
  environmentManaged: false,
};

async function stubSettings(page: Page): Promise<void> {
  await stubShell(page);
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(jsonOk({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [connectionEscapeHatch] }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "high" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "high" },
        recommendedModels: [],
      }),
    ),
  );
}

/** Every field control on the Settings surface, with its width and left edge. */
async function measureSettingsFields(page: Page) {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
    if (surface === null) return null;
    const fields = [...surface.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, textarea")].map(
      (node) => {
        const box = node.getBoundingClientRect();
        return {
          id: node.id === "" ? node.tagName.toLowerCase() : node.id,
          width: Math.round(box.width),
          left: Math.round(box.left),
        };
      },
    );
    const widths = fields.map((field) => field.width);
    const lefts = [...new Set(fields.map((field) => field.left))].sort((left, right) => left - right);
    return {
      count: fields.length,
      fields,
      widest: Math.max(...widths),
      narrowest: Math.min(...widths),
      lefts,
      surfaceWidth: Math.round(surface.getBoundingClientRect().width),
    };
  });
}

test("item 2: every settings field quotes the one form measure, wide and narrow", async ({ page }) => {
  await stubSettings(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  // Every group under test is up: the connection form, the three selectors and
  // both model editors.
  await expect(surface.locator("#connection-provider")).toBeVisible();
  await expect(surface.locator("#model-profile-model-chat")).toBeVisible();

  const wide = await measureSettingsFields(page);
  console.log(`[item-2 settings @1440] ${JSON.stringify(wide)}`);
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(surface.locator("#connection-provider")).toBeVisible();
  const narrow = await measureSettingsFields(page);
  console.log(`[item-2 settings @400] ${JSON.stringify(narrow)}`);

  for (const [name, measured] of [
    ["1440x900", wide],
    ["400x800", narrow],
  ] as const) {
    expect(measured, `the settings surface renders at ${name}`).not.toBeNull();
    const quoted = measured!.fields.map((field) => `${field.id}=${field.width}`).join(", ");
    // One measure: every field on the surface is the same width and starts on the
    // same left edge, whichever group it belongs to. The 2 px allowance is the
    // card's own hairline (the model editors are cards, and a card's border is not
    // part of the field column) - not a second scale.
    expect(
      measured!.widest - measured!.narrowest,
      `at ${name} every settings field is one width: ${quoted}`,
    ).toBeLessThanOrEqual(2);
    expect(
      measured!.lefts[measured!.lefts.length - 1]! - measured!.lefts[0]!,
      `at ${name} every settings field starts on one left edge: ${JSON.stringify(measured!.lefts)}`,
    ).toBeLessThanOrEqual(2);
  }

  // The measure is a cap on the fields, not on the surface.
  expect(wide!.widest, "the widest settings field is inside the form measure").toBeLessThanOrEqual(640);
  expect(wide!.surfaceWidth, "the desktop settings surface itself is the wide panel").toBeGreaterThan(1200);
});

/**
 * The Game surface's own groups: the drawer's rows (capability board, the start
 * guide, the connection and installation groups, the diagnostics), each with the
 * box it was painted in, plus the region that scrolls them.
 */
async function measureGameSurface(page: Page) {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="game-surface"]');
    if (surface === null) return null;
    const round = (value: number) => Math.round(value);
    const boxOf = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(),
        name:
          node.getAttribute("data-testid") ??
          node.getAttribute("aria-label") ??
          node.className.toString().split(/\s+/u).filter((part) => part.length > 0).slice(0, 2).join("."),
        top: round(box.top),
        left: round(box.left),
        width: round(box.width),
        height: round(box.height),
      };
    };
    const drawer = surface.querySelector<HTMLElement>(".composed-game-drawer");
    const groups = drawer === null ? [] : [...drawer.children].map(boxOf);
    const main = document.querySelector<HTMLElement>("#main-content");
    const content = surface.querySelector<HTMLElement>(".surface-content");
    const allLefts = [...new Set(groups.map((group) => group.left))].sort((left, right) => left - right);
    // Any two of the region's own blocks painted in the same place. Measured off
    // the rects rather than inferred from the grid: the defect this reports was
    // an installation card that overran its row and painted over the model
    // settings below it, and `position`, `margin` and `transform` all read
    // innocent while it did.
    const blocks = content === null ? [] : [...content.children].map((child) => child as HTMLElement);
    const overlaps: string[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        const a = blocks[i]!.getBoundingClientRect();
        const b = blocks[j]!.getBoundingClientRect();
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 0 && down > 0) {
          overlaps.push(`${blocks[i]!.className.toString().split(/\s+/u)[0]} over ${blocks[j]!.className.toString().split(/\s+/u)[0]} by ${round(across)}x${round(down)}`);
        }
      }
    }
    return {
      surface: boxOf(surface),
      pageScrollHeight: document.documentElement.scrollHeight,
      mainScrollHeight: main === null ? null : main.scrollHeight,
      contentScrollHeight: content === null ? null : content.scrollHeight,
      contentChildren: content === null ? [] : [...content.children].map(boxOf),
      contentOverlaps: overlaps,
      contentColumnCount:
        content === null
          ? 0
          : new Set([...content.children].map((child) => round(child.getBoundingClientRect().left))).size,
      surfaceScrollHeight: surface.scrollHeight,
      drawerHeight: drawer === null ? null : round(drawer.getBoundingClientRect().height),
      surfaceChildren: [...surface.children].map(boxOf),
      groupCount: groups.length,
      columnCount: allLefts.length,
      lefts: allLefts,
      groups,
    };
  });
}

test("item 3: the Game surface uses the width it is given, and stays one column at 400", async ({ page }) => {
  await stubShell(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=game`);
  const surface = page.getByTestId("game-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".composed-game-drawer")).toBeVisible();

  const wide = await measureGameSurface(page);
  console.log(`[item-3 game @1440] ${JSON.stringify(wide)}`);

  // Sensitivity proof, measured through the same probe rather than quoted from a
  // report: the drawer's pre-fix layout (one flex column) puts the surface back to
  // one column and the taller drawer, so the assertions below are what catch the
  // defect and not a coincidence of today's numbers. The injected rule is
  // unlayered, which is exactly why it wins over the layered stylesheet.
  await page.addStyleTag({
    content:
      ".composed-game-drawer { display: flex; flex-direction: column; align-items: stretch; }",
  });
  const reverted = await measureGameSurface(page);
  console.log(`[item-3 game @1440, pre-fix layout injected] ${JSON.stringify(reverted)}`);
  await page.reload();
  await expect(surface.locator(".composed-game-drawer")).toBeVisible();

  await page.setViewportSize({ width: 400, height: 800 });
  const narrow = await measureGameSurface(page);
  console.log(`[item-3 game @400] ${JSON.stringify(narrow)}`);

  // Sensitivity proof for the overlap assertion below, taken through the same
  // probe: rows sized by `auto` are what let a self-scrolling card overrun its
  // own row, so putting that back must reproduce the overlap. The injected rule
  // is unlayered, so it wins over the layered stylesheet.
  const autoRows = await page.addStyleTag({
    content: ".surface-game > .surface-content { grid-auto-rows: auto; }",
  });
  const overrun = await measureGameSurface(page);
  console.log(`[item-3 game @400, rows sized auto] ${JSON.stringify(overrun)}`);
  await autoRows.evaluate((node) => node.remove());

  expect(wide, "the Game surface renders").not.toBeNull();
  expect(reverted, "the Game surface renders with the pre-fix layout injected").not.toBeNull();
  expect(narrow, "the Game surface renders at 400").not.toBeNull();

  // The width is used: the drawer's groups occupy more than one column at 1440,
  // and each group gives up the whole-panel width it used to run to.
  expect(wide!.surface.width, "the desktop Game surface is the wide panel").toBeGreaterThan(1200);
  expect(wide!.columnCount, "the drawer's groups are laid out in more than one column at 1440").toBeGreaterThan(1);
  expect(
    wide!.contentColumnCount,
    `the blocks below the drawer also pair up (${JSON.stringify(wide!.contentChildren.map((child) => `${child.name}=${child.width}@${child.left}`))})`,
  ).toBeGreaterThan(1);
  expect(
    Math.max(...wide!.groups.map((group) => group.width)),
    "no group runs the whole panel width at 1440",
  ).toBeLessThan(wide!.surface.width * 0.75);
  // …and the surface is shorter for it.
  expect(
    wide!.drawerHeight!,
    `the drawer is shorter in two columns (${wide!.drawerHeight} px against ${reverted!.drawerHeight} px in one column)`,
  ).toBeLessThan(reverted!.drawerHeight!);
  expect(
    wide!.contentScrollHeight!,
    `the surface's content scrolls ${wide!.contentScrollHeight} px against ${reverted!.contentScrollHeight} px before the fix`,
  ).toBeLessThan(reverted!.contentScrollHeight!);
  // The injected pre-fix layout is one column: the sensitivity proof.
  expect(reverted!.columnCount, "the pre-fix layout measured one column").toBe(1);
  // …and the narrow surface is still one readable column, at both levels.
  expect(narrow!.columnCount, "the narrow surface is a single column").toBe(1);
  expect(narrow!.contentColumnCount, "the narrow surface's content is a single column too").toBe(1);
  expect(narrow!.surface.width, "400 leaves a single readable column").toBeLessThan(420);

  // No two blocks of the region are painted on top of each other, at either
  // width. The failure this catches: the installation card is a scroll container
  // (`max-height` + `overflow-y: auto`), which contributes no block-axis content
  // to an `auto` row - at 400x800 the card was 256 px tall in a 26 px row, so the
  // model settings started at y=1492 inside a card that ran to y=1710.
  expect(overrun, "the Game surface renders with rows sized auto").not.toBeNull();
  expect(overrun!.contentOverlaps, "rows sized auto put the card over the block below it").not.toEqual([]);
  for (const [name, measured] of [
    ["1440x900", wide],
    ["400x800", narrow],
  ] as const) {
    expect(
      measured!.contentOverlaps,
      `at ${name} the region's blocks do not paint over each other: ${JSON.stringify(measured!.contentChildren.map((child) => `${child.name}@${child.top}+${child.height}`))}`,
    ).toEqual([]);
  }
});

/**
 * The pager items mount the real Chat with a real opening: the Host publishes
 * `openingVariant` on the message while the greeting set still resolves, and the
 * shell offers the choice only there.
 */
const OPENING_VARIANT_ID = "V".repeat(42) + "A";
const OPENING_HANDLE = "W".repeat(42) + "A";

function openingTranscript(count: number, label: string | null) {
  return [
    {
      handle: OPENING_HANDLE,
      role: "companion",
      text: "门廊上的那盏灯还亮着。",
      locale: "und",
      order: 0,
      revision: 1,
      openingVariant: { variantId: OPENING_VARIANT_ID, index: 0, count, label, locked: false },
    },
  ];
}

/**
 * The switcher's own box, its two buttons' visible words, and the position.
 *
 * `rows` is measured by each child's **vertical centre**, not by its top: the
 * indicator is 11 px type vertically centred beside 44 px buttons, so its `top`
 * differs by design and counting tops would report two rows for a strip that is
 * plainly one. Two rows is a real state (the strip wrapped inside the bubble's
 * measure), and a centred row is what this has to tell apart.
 */
async function measureSwitcher(page: Page) {
  const controls = page.locator(".message-list .swipe-controls").first();
  await expect(controls).toBeVisible();
  return await controls.evaluate((node) => {
    const words = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    const centres = (root: Element) =>
      [...root.children].map((child) => {
        const box = child.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      });
    const buttons = [...node.querySelectorAll<HTMLElement>("button")].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        text: words(button),
        ariaLabel: button.getAttribute("aria-label"),
        title: button.getAttribute("title"),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    });
    const strip = node.closest(".message-actions");
    return {
      groupText: words(node),
      groupHeight: Math.round(node.getBoundingClientRect().height),
      groupWidth: Math.round(node.getBoundingClientRect().width),
      groupRows: new Set(centres(node)).size,
      stripRows: strip === null ? 0 : new Set(centres(strip)).size,
      stripHeight: strip === null ? 0 : Math.round(strip.getBoundingClientRect().height),
      buttons,
    };
  });
}

/**
 * The switcher is Tavern's compact stepper: a bare arrow, the visible position,
 * a bare arrow. It used to carry its words inside the buttons, and two long
 * labels are what wrapped the control strip onto a second row at 400 px - where
 * the dialogue, not the pager, is what the player is reading. The owner chose the
 * tavern form deliberately (it has survived years of global use for exactly this
 * reason), so the contract this test holds is now: **the glyph is visible, the
 * number is visible and readable, and the meaning is carried by the accessible
 * name** - a pager with no name, no position, or no 44 px target still fails.
 */
test("item 4: the variant switcher is a compact stepper with a named arrow and a visible position", async ({ page }) => {
  await stubShell(page, { transcript: openingTranscript(3, "Default") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const measured = await measureSwitcher(page);
  console.log(`[item-4 switcher] ${JSON.stringify(measured)}`);

  expect(measured.buttons, "the pager renders two arrows").toHaveLength(2);
  for (const button of measured.buttons) {
    // The accessible name is the control's meaning, and it is a real sentence
    // rather than the bare glyph: the arrow itself is decoration.
    expect(button.ariaLabel, "each arrow carries its own name").toBeTruthy();
    expect(button.title, "and the pointer gets the same words").toBe(button.ariaLabel);
    expect(button.ariaLabel, "neither name is the raw glyph").not.toMatch(/^[\u2039\u203a<>\u2190\u2192]+$/u);
    // Visible text is gone - that is the decision, not an omission.
    expect(button.text, "the arrow is the whole visible control").toBe("");
    expect(button.height, "and the control still clears the 44 px touch floor").toBeGreaterThanOrEqual(44);
    expect(button.width, "and it is still a square-ish target, not a shrunken glyph").toBeGreaterThanOrEqual(44);
  }
  // The position semantics are unchanged: the indicator is still the plain number
  // the Host published, beside the variant's own name.
  expect(measured.groupText, "the position is still the plain number").toContain("1/3");
  expect(measured.groupText, "and the variant's own name is still shown").toContain("默认");
  expect(measured.groupHeight, "the group keeps gate 8's own floor").toBeGreaterThanOrEqual(44);
  expect(measured.groupText, "no raw markup reaches the player").not.toMatch(/[*{}]|\{\{/u);
});

/**
 * The compact form exists for the narrow viewport, so the narrow viewport is
 * where it has to be proved: at 400 px the strip is one row and stays inside the
 * bubble's measure. The words that used to sit in the buttons are the reason it
 * wrapped, so this asserts the property the change was made for rather than the
 * mechanism that replaced it.
 */
test("item 4: the switcher fits the 400 px bubble on one row", async ({ page }) => {
  await stubShell(page, { transcript: openingTranscript(3, "Default") });
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const measured = await measureSwitcher(page);
  console.log(`[item-4 switcher @400] ${JSON.stringify(measured)}`);

  expect(measured.groupRows, "the strip is one row at 400 px").toBe(1);
  expect(
    measured.stripRows,
    `the story's own control strip is one row too (${measured.stripHeight} px tall)`,
  ).toBe(1);
  expect(
    measured.groupHeight,
    "so it is one 44 px target tall, not two stacked ones",
  ).toBeLessThan(64);
  expect(measured.groupText, "the position survives the narrow form").toContain("1/3");
});

test("item 4: one variant has no switcher at all", async ({ page }) => {
  await stubShell(page, { transcript: openingTranscript(1, "Default") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  // The message is really mounted: the control's absence is not an empty surface.
  await expect(page.locator(".message-list > li[data-handle]")).toHaveCount(1);
  await expect(page.locator(".message-list .swipe-controls")).toHaveCount(0);
});

/**
 * Item 5's own transcript: the opening (its pager is the third row's sibling
 * control), the player's line, and the companion reply regeneration produced -
 * a swipe set, which is the one row that carries BOTH a pager and the
 * regenerate control.
 */
const PLAYER_HANDLE = "P".repeat(42) + "A";
const SWIPE_HANDLE = "S".repeat(42) + "A";

function openingThenSwipedTranscript() {
  return [
    ...openingTranscript(3, "Default"),
    {
      handle: PLAYER_HANDLE,
      role: "player",
      text: "你昨晚睡得好吗？",
      locale: "und",
      order: 1,
      revision: 1,
    },
    {
      handle: SWIPE_HANDLE,
      role: "companion",
      text: "……还行。",
      locale: "und",
      order: 2,
      revision: 1,
      swipeInfo: { currentIndex: 1, totalSwipes: 2, label: "1/2", hasPrevious: true, hasNext: true },
    },
  ];
}

/**
 * Item 5's two boxes: the pager (the variant switcher) and the regenerate
 * button, each with the bubble they belong to, so "above the bubble, at its top
 * right" and "beside it, in the strip below" are both numbers.
 */
async function measureBubbleActions(page: Page) {
  const row = page.locator(".message-list > li[data-handle]").last();
  await expect(row).toBeVisible();
  return await row.evaluate((node) => {
    const round = (value: number) => Math.round(value);
    const boxOf = (selector: string) => {
      const element = node.querySelector<HTMLElement>(selector);
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return {
        top: round(box.top),
        left: round(box.left),
        right: round(box.right),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height),
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      };
    };
    return {
      bubble: boxOf(".message-bubble"),
      pager: boxOf(".swipe-controls"),
      regenerate: boxOf(".regenerate-btn"),
      headerChildren: [...(node.querySelector(".message-header")?.children ?? [])].map((child) =>
        (child.className || child.tagName).toString(),
      ),
      actionChildren: [...(node.querySelector(".message-actions")?.children ?? [])].map((child) =>
        (child.className || child.tagName).toString(),
      ),
    };
  });
}

/**
 * The pager sat in the bubble's author line - above the bubble, at its right -
 * while regenerate sat below the bubble at its left, so regenerating and then
 * picking another variant meant crossing the whole bubble. Neither control is
 * wrong on its own; the defect is that one message's two controls are diagonally
 * opposite.
 */
test("item 5: the variant pager and regenerate are one strip at the bubble's foot", async ({ page }) => {
  await stubShell(page, { transcript: openingThenSwipedTranscript() });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator(".message-list > li[data-handle]")).toHaveCount(3);

  const measured = await measureBubbleActions(page);
  console.log(`[item-5 controls] ${JSON.stringify(measured)}`);
  expect(measured.pager, "the variant pager renders").not.toBeNull();
  expect(measured.regenerate, "the regenerate control renders").not.toBeNull();
  expect(measured.bubble, "the bubble renders").not.toBeNull();

  const pager = measured.pager!;
  const regenerate = measured.regenerate!;
  const bubble = measured.bubble!;

  // Both controls are below the bubble: the author line keeps the name and
  // nothing else.
  expect(pager.top, `the pager is below the bubble (pager ${pager.top}, bubble ${bubble.bottom})`).toBeGreaterThanOrEqual(
    bubble.bottom,
  );
  expect(
    regenerate.top,
    `regenerate is below the bubble (${regenerate.top}, bubble ${bubble.bottom})`,
  ).toBeGreaterThanOrEqual(bubble.bottom);
  // …on one line…
  expect(
    Math.abs(Math.round(pager.top + pager.height / 2) - Math.round(regenerate.top + regenerate.height / 2)),
    `the two controls share a line (pager ${pager.top}..${pager.bottom}, regenerate ${regenerate.top}..${regenerate.bottom})`,
  ).toBeLessThanOrEqual(8);
  // …beside each other, in one strip: the horizontal gap between them is the
  // strip's own gap, not the width of a bubble.
  const horizontalGap = Math.abs(
    pager.left < regenerate.left ? regenerate.left - pager.right : pager.left - regenerate.right,
  );
  expect(horizontalGap, `the two controls are adjacent (${horizontalGap} px apart)`).toBeLessThanOrEqual(16);
  // The author line no longer carries a control.
  expect(measured.headerChildren, "the author line holds the name and nothing else").toEqual(["message-author"]);
  expect(
    measured.actionChildren.some((child) => child.includes("swipe-controls")),
    `the strip holds the pager: ${JSON.stringify(measured.actionChildren)}`,
  ).toBe(true);
});

/**
 * Every multi-line authoring field, measured against its own rendered line box.
 *
 * The fields on the Characters surface ended on a sliced line - 演出指导, 场景文本, each 开场白
 * variant and 词条正文 showed the top half of a last line and no more (shots-final41,
 * `10-characters-1440x900.png`, `88-world-book-refusal-stale-revision-1440x900.png`). The cause is
 * the shared class: `.form-textarea` never declared a `line-height`, so its `line-height` was
 * `normal` - a value the browser derives from a *font*, and it derived the row size from the
 * Latin face while the Chinese glyphs came from a taller fallback. The box was therefore sized
 * for 4 x 18 px while the rendered lines measured 21 px, and 72 px admits 3.43 of them.
 *
 * The proof is the rendered arithmetic, not the declaration: the line box is measured by growing
 * the field one line at a time and reading `scrollHeight`'s own step, then compared with the
 * content box the browser laid out. `scrollHeight % lineHeight` is deliberately *not* the
 * assertion - `scrollHeight` carries the field's padding, which is not a line box, so that
 * remainder is 16 px in every state and would pass for a sliced field as readily as a whole one.
 *
 * Before (shipped stack): `lineHeight: normal`, 演出指导/用户设定描述/场景文本/词条正文 measured
 * `clientHeight 88` (content box 72) against their own line box, and under the Latin-first stack
 * the same fields reported 3.37 visible lines.
 */
async function measureAuthoringFields(page: Page) {
  return await page.evaluate(() => {
    const round = (value: number) => Math.round(value * 100) / 100;
    const line = "这一行用来量出真正的行盒高度。";
    return [...document.querySelectorAll<HTMLTextAreaElement>("textarea.form-textarea")]
      .filter((node) => node.getBoundingClientRect().height > 0)
      .map((node) => {
        const style = getComputedStyle(node);
        const padTop = Number.parseFloat(style.paddingTop);
        const padBottom = Number.parseFloat(style.paddingBottom);
        const original = node.value;
        const scrolledFor = (lines: number): number => {
          node.value = Array.from({ length: lines }, () => line).join("\n");
          return node.scrollHeight;
        };
        const five = scrolledFor(5);
        const six = scrolledFor(6);
        node.value = original;
        void node.scrollHeight;
        const lineBox = six - five;
        const contentBox = round(node.clientHeight - padTop - padBottom);
        const visibleLines = round(contentBox / lineBox);
        return {
          label: node.id || node.getAttribute("aria-label") || "textarea",
          rows: node.rows,
          lineHeight: style.lineHeight,
          declaredLineHeight: round(Number.parseFloat(style.lineHeight)),
          clientHeight: node.clientHeight,
          scrollHeightAtFiveLines: five,
          contentBox,
          lineBox,
          visibleLines,
          whole: Math.abs(visibleLines - Math.round(visibleLines)) < 0.02,
        };
      });
  });
}

test("item 6: every multi-line authoring field shows whole lines, and a scrolling one does not cut one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubShell(page);
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: worldInfoHandle, memories: [], chapters: [] })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  await expect(page.locator("[data-opening-editor]")).toBeVisible();
  // The entry bodies only exist inside the editor, so open it: 词条正文 was one of the four
  // fields the review saw sliced.
  await page.locator("[data-companion-world-book-edit]").click();
  await expect(page.locator("[data-companion-world-book-draft]")).toBeVisible();

  const shipped = await measureAuthoringFields(page);
  console.log(`[item-6 authoring fields @1440] ${JSON.stringify(shipped)}`);

  // The fields the review named, plus every other one the shared class reaches: the assertion is
  // about the class, so a field missing from this list is a field the fix does not cover.
  const labels = shipped.map((field) => field.label);
  for (const named of [
    "character-voice-text",
    "scenario-description",
    "persona-description",
    "opening-variant-0-text",
    "companion-world-book-entry-0-body",
  ]) {
    expect(labels, `${named} is one of the authoring fields under test`).toContain(named);
  }
  expect(shipped.length, `every authoring field on the surface is measured: ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(
    14,
  );

  for (const field of shipped) {
    const quoted = JSON.stringify(field);
    // 1. The row count is derived from a definite line box, not from a font's `normal`.
    expect(
      Number.isFinite(field.declaredLineHeight),
      `the row size of ${field.label} is not a font-derived 'normal': ${quoted}`,
    ).toBe(true);
    // 2. The box the browser laid out is a whole number of the line boxes it renders.
    expect(field.whole, `${field.label} shows whole lines, not ${field.visibleLines}: ${quoted}`).toBe(true);
    expect(
      field.contentBox,
      `${field.label} is exactly ${field.rows} rows of ${field.lineBox} px: ${quoted}`,
    ).toBe(field.rows * field.lineBox);
  }

  // …and the scrolling case: a field whose text overflows keeps its own line box in charge, so
  // the lines below the fold are whole lines too. The Latin-first stack is the shape the shots
  // were rendered in (the product's own stack puts Latin faces in front of the CJK fallback);
  // injecting it makes the two metrics differ deterministically instead of depending on which
  // fonts the machine happens to have.
  const latinFirst = await page.addStyleTag({
    content: "textarea.form-textarea { font-family: Arial; }",
  });
  const sliced = await measureAuthoringFields(page);
  console.log(`[item-6 authoring fields, Latin-first stack] ${JSON.stringify(sliced)}`);
  await latinFirst.evaluate((node) => node.remove());
  for (const field of sliced) {
    expect(
      field.contentBox,
      `${field.label} keeps its own line box when the font changes: ${JSON.stringify(field)}`,
    ).toBe(field.rows * field.lineBox);
  }

  // The same class is the one the Memory composer uses, so the fields there are whole too.
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.locator("[data-memory-authoring-toggle]").click();
  const memory = await measureAuthoringFields(page);
  console.log(`[item-6 memory composer] ${JSON.stringify(memory)}`);
  expect(memory).toHaveLength(1);
  expect(memory[0]!.whole, `记忆内容 is a whole number of lines: ${JSON.stringify(memory[0])}`).toBe(true);
});
