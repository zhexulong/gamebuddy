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
      jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
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
    return {
      surface: boxOf(surface),
      pageScrollHeight: document.documentElement.scrollHeight,
      mainScrollHeight: main === null ? null : main.scrollHeight,
      contentScrollHeight: content === null ? null : content.scrollHeight,
      contentChildren: content === null ? [] : [...content.children].map(boxOf),
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

/** The switcher's own box, its two buttons' visible words, and the position. */
async function measureSwitcher(page: Page) {
  const controls = page.locator(".message-list .swipe-controls").first();
  await expect(controls).toBeVisible();
  return await controls.evaluate((node) => {
    const words = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    return {
      groupText: words(node),
      groupHeight: Math.round(node.getBoundingClientRect().height),
      buttons: [...node.querySelectorAll<HTMLElement>("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return {
          text: words(button),
          ariaLabel: button.getAttribute("aria-label"),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
    };
  });
}

/**
 * The switcher was two arrow glyphs with no visible text: the icon is
 * `aria-hidden`, so both buttons' meaning lived in `aria-label` alone and a
 * sighted player saw two arrows around a small `默认 1/3`.
 */
test("item 4: the variant switcher's arrows carry their words, not only their name", async ({ page }) => {
  await stubShell(page, { transcript: openingTranscript(3, "Default") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const measured = await measureSwitcher(page);
  console.log(`[item-4 switcher] ${JSON.stringify(measured)}`);

  expect(measured.buttons, "the pager renders two arrows").toHaveLength(2);
  expect(measured.buttons[0]!.text, "the previous arrow says what it does").toBe("上一个变体");
  expect(measured.buttons[1]!.text, "the next arrow says what it does").toBe("下一个变体");
  for (const button of measured.buttons) {
    // Visible words, and the accessible name is those words: the meaning is no
    // longer carried by the attribute alone.
    expect(button.text, "the visible label is the control's own name").toBe(button.ariaLabel);
    expect(button.height, "and the control still clears the 44 px touch floor").toBeGreaterThanOrEqual(44);
  }
  // The position semantics are unchanged: the indicator is still the plain number
  // the Host published, beside the variant's own name.
  expect(measured.groupText, "the position is still the plain number").toContain("1/3");
  expect(measured.groupText, "and the variant's own name is still shown").toContain("默认");
  expect(measured.groupHeight, "the group keeps gate 8's own floor").toBeGreaterThanOrEqual(44);
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
