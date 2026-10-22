import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The conversation-rendering defects, each asserted through a value the browser
 * computes rather than through the source that produced it.
 *
 *   1. The player's avatar was laid out on the inner side of the bubble: the row
 *      carried `flex-direction: row-reverse` while the avatar was the *last* DOM
 *      child, so the bubble hugged the right edge and the avatar floated
 *      inboard. A player's avatar belongs on the outer (right) boundary.
 *   2. The player's own line was printed twice: the monogram read 你 and the
 *      author line above the bubble read 你 again, so input read as "[你] 你: 你好".
 *   3. The surface heading's focus indicator was painted in the saturated accent,
 *      so every static one-word heading read as an unclicked pink badge. Its
 *      replacement hairline then measured 1.48:1 - under the 3:1 a focus
 *      indicator needs - on the mount and keyboard paths, and the pointer path
 *      drew no indicator at all.
 *   4. The first screen stacked four titles - the app bar's mark and companion,
 *      the surface heading, the transcript's untitled placeholder - and printed
 *      the companion's name a third time in the zero state's plate.
 *   5. A button beside a `width: 100%` field was squeezed until its label
 *      wrapped: 创建伙伴 broke in two and 创建 stacked its two characters.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";
const projectionRevision = "P".repeat(42) + "A";
const playerMessageHandle = "X".repeat(42) + "A";
const openedMessageHandle = "W".repeat(42) + "A";

type Message = Readonly<{
  role: "player" | "companion";
  text: string;
  opening?: boolean;
  /** The swipe position the fixture serves. Kept in the older `◀ 1/3 ▶` spelling on purpose: it is the shape this journey's own root serves, and the client's read-back of the arrows stays exercised. */
  swipes?: Readonly<{ index: number; total: number }>;
}>;

function composedRoot(options: Readonly<{ transcript?: readonly Message[]; title?: string | null }> = {}) {
  const transcript = options.transcript ?? [];
  return {
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
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
        title: options.title ?? null,
        transcript: transcript.map((message, index) => ({
          handle: message.role === "player" ? playerMessageHandle + String(index) : openedMessageHandle + String(index),
          role: message.role,
          text: message.text,
          locale: "und",
          order: index,
          revision: 1,
          ...(message.opening === true
            ? { openingVariant: { variantId: "V".repeat(42) + "A", index: 0, count: 2, label: "Default", locked: false } }
            : {}),
          ...(message.swipes === undefined
            ? {}
            : {
                swipeInfo: {
                  currentIndex: message.swipes.index,
                  totalSwipes: message.swipes.total,
                  // The Host's exact shape: `formatSwipeLabel`
                  // (`host/src/tavern/message-tree.ts:97`) and the swipe route's
                  // own inline template both wrap the position in the arrows.
                  label: `\u25c0 ${message.swipes.index + 1}/${message.swipes.total} \u25b6`,
                  hasPrevious: message.swipes.index > 0,
                  hasNext: message.swipes.index < message.swipes.total - 1,
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
        capabilitySummary: { available: false, count: 0 },
        latestOutcome: "none",
      },
    },
  };
}

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const OPENINGS = [
  { label: "Default", text: "The lantern over the porch is still lit." },
  { label: "Alternate 1", text: "Rain has been falling since dawn." },
];

type MountOptions = Readonly<{
  root?: unknown;
  /** Answer the greeting record with the card's own openings. */
  openings?: readonly Readonly<{ label: string; text: string }>[];
  /** The UI language this mount boots in; the fixture's default is the Chinese surface. */
  locale?: "en" | "zh-CN";
}>;

async function mountShell(page: Page, options: MountOptions = {}): Promise<void> {
  const root = options.root ?? composedRoot();
  await page.addInitScript(
    (locale) => localStorage.setItem("gamebuddy.tavern.ui-locale", locale),
    options.locale ?? "zh-CN",
  );
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) => route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: [], chapters: [] })));
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null })),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(jsonOk({ devices: [], defaultSelectable: true })));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale: "zh-CN" })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        recommendedModels: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Mira", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(
      jsonOk(
        options.openings === undefined
          ? { apiVersion: 1, present: false, revision: null, label: null, variants: [] }
          : { apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: options.openings },
      ),
    ),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

// --- defect 1 ----------------------------------------------------------------

test("defect 1: the player avatar hugs the right outer boundary, outside the bubble", async ({ page }) => {
  await mountShell(page, {
    root: composedRoot({
      transcript: [
        { role: "companion", text: "The morning light comes over the ridge." },
        { role: "player", text: "Let's check the crops." },
      ],
    }),
  });

  const measured = await page.evaluate(() => {
    const ordered = (selector: string) => {
      const row = document.querySelector<HTMLElement>(selector);
      if (row === null) return null;
      const avatar = row.querySelector<HTMLElement>(".avatar");
      const bubble = row.querySelector<HTMLElement>(".message-bubble");
      const rowRect = row.getBoundingClientRect();
      return {
        children: [...row.children].map((child) => child.className),
        direction: getComputedStyle(row).flexDirection,
        row: { left: Math.round(rowRect.left), right: Math.round(rowRect.right) },
        avatar: avatar === null ? null : (() => {
          const rect = avatar.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        })(),
        bubble: bubble === null ? null : (() => {
          const rect = bubble.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        })(),
      };
    };
    return { player: ordered("li.message.player"), companion: ordered("li.message.companion") };
  });
  console.log(`[defect-1] measured: ${JSON.stringify(measured)}`);

  const player = measured.player;
  expect(player, "the player row renders").not.toBeNull();
  expect(player!.avatar, "the player row carries its monogram").not.toBeNull();
  expect(player!.bubble, "the player row carries its bubble").not.toBeNull();
  const { avatar, bubble, row } = player!;
  expect(
    avatar!.left,
    `the player avatar sits inboard at left=${avatar!.left} while the bubble ends at ${bubble!.right}: the avatar must be outside the bubble, hugging the right boundary`,
  ).toBeGreaterThanOrEqual(bubble!.right - 1);
  expect(
    row.right - avatar!.right,
    `the player avatar must hug the row's right boundary (avatar right ${avatar!.right}, row right ${row.right})`,
  ).toBeLessThanOrEqual(8);
  // The companion row keeps the mirrored layout: avatar outside on the left.
  expect(measured.companion!.avatar!.right, "the companion avatar sits outside its bubble").toBeLessThanOrEqual(
    measured.companion!.bubble!.left + 1,
  );
});

// --- defect 2 ----------------------------------------------------------------

test("defect 2: the player's own line is not repeated above the bubble", async ({ page }) => {
  await mountShell(page, {
    root: composedRoot({
      transcript: [
        { role: "companion", text: "The morning light comes over the ridge." },
        { role: "player", text: "你好" },
      ],
    }),
  });

  const measured = await page.evaluate(() => {
    const read = (selector: string) => {
      const row = document.querySelector<HTMLElement>(selector);
      return {
        authors: [...row!.querySelectorAll<HTMLElement>(".message-author")].map((node) => node.textContent),
        avatars: [...row!.querySelectorAll<HTMLElement>(".avatar")].map((node) => node.textContent),
        bubbleTop: Math.round(row!.querySelector<HTMLElement>(".message-bubble")!.getBoundingClientRect().top),
        bodyTop: Math.round(row!.querySelector<HTMLElement>(".message-body")!.getBoundingClientRect().top),
      };
    };
    return { player: read("li.message.player"), companion: read("li.message.companion") };
  });
  console.log(`[defect-2] measured: ${JSON.stringify(measured)}`);

  expect(measured.player.avatars, "the player keeps the right-edge monogram").toEqual(["你"]);
  expect(measured.player.authors, "the player line is not printed twice").toEqual([]);
  expect(measured.companion.authors, "the companion keeps its author line").toEqual(["Mira"]);
  // The companion's author line is real content in its header; the player's
  // bubble starts at the top of its body, with no empty header keeping a gap.
  expect(
    measured.player.bubbleTop,
    `the player's bubble starts at the top of its body (bubble ${measured.player.bubbleTop}, body ${measured.player.bodyTop})`,
  ).toBe(measured.player.bodyTop);
});

// --- defect 3 ----------------------------------------------------------------

/**
 * The heading's focus indicator, read the way the eye meets it: whether the
 * heading is the active element at all, whether it is a control, and the outline
 * the browser computed for it.
 */
const headingFocusReading = () => {
  const heading = document.querySelector<HTMLElement>(".surface-header h2")!;
  const style = getComputedStyle(heading);
  return {
    text: (heading.textContent ?? "").trim(),
    isActive: document.activeElement === heading,
    focusVisible: heading.matches(":focus-visible"),
    tabIndex: heading.tabIndex,
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
  };
};

/**
 * The heading is focused by the shell, not by the player, and the owner's ruling
 * is that it carries no ring at all: it is a programme-focus target
 * (`SurfaceView` focuses it on every route change, `tabindex="-1"`), not a
 * control, and a ring on something a player cannot press is a misleading
 * affordance - which is exactly how the earlier 2px accent ring, and then the 1px
 * grey hairline, read. WCAG 2.4.11 is about the components a player operates, so
 * the measured matrix is now:
 *
 *   path              tabindex  :focus-visible  outline
 *   mount             -1        true            none
 *   pointer switch    -1        false           none
 *   keyboard switch   -1        true            none
 *
 * The assertions, and the failure each one catches:
 *  - the heading takes focus on all three paths: catches a surface that moved
 *    focus somewhere else entirely;
 *  - the heading is a programme-focus target and not a control (`tabIndex -1`):
 *    catches the ruling's premise drifting, which is the one thing that would make
 *    "no ring here" the wrong call;
 *  - the heading draws no outline on any path: catches the accent badge and the
 *    grey hairline coming back, and catches the case a rule's mere absence cannot
 *    cover - the sheet's class-less `:focus-visible` ring landing on the heading
 *    again;
 *  - a control reached with the keyboard still paints the product's own ring:
 *    catches "no ring on the heading" being implemented by deleting focus
 *    visibility everywhere.
 */
test("defect 3: the surface heading is a programme-focus target and wears no ring", async ({ page }) => {
  await mountShell(page);

  const mounted = await page.evaluate(headingFocusReading);
  console.log(`[defect-3] mount: ${JSON.stringify(mounted)}`);
  expect(mounted.isActive, "the heading takes focus on mount").toBe(true);

  // A surface switch made with the pointer, and one made with the keyboard: the
  // two paths a player actually reaches a surface by.
  await openSurface(page, "游戏", "game-surface");
  const pointer = await page.evaluate(headingFocusReading);
  console.log(`[defect-3] pointer switch: ${JSON.stringify(pointer)}`);
  expect(pointer.isActive, "the heading takes focus on a pointer switch").toBe(true);

  const entry = page.getByRole("button", { name: "角色", exact: true });
  if (!(await entry.isVisible())) await page.getByRole("button", { name: "更多", exact: true }).click();
  await entry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const keyboard = await page.evaluate(headingFocusReading);
  console.log(`[defect-3] keyboard switch: ${JSON.stringify(keyboard)}`);
  expect(keyboard.isActive, "the heading takes focus on a keyboard switch").toBe(true);

  for (const [path, reading] of Object.entries({ mounted, pointer, keyboard })) {
    const geometry = `${path} ${JSON.stringify(reading)}`;
    expect(reading.tabIndex, `the heading is an unpressable programme-focus target (${geometry})`).toBe(-1);
    // `outline-width` stays at its initial `medium` (3px) while the style is `none`,
    // so the painted signal is the style: nothing is drawn.
    expect(reading.outlineStyle, `the heading wears no ring (${geometry})`).toBe("none");
  }

  // The keyboard floor: a control reached with the keyboard still paints the
  // product's own focus ring, so "no ring on the heading" did not delete focus
  // visibility for the path that needs it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const keyboardRing = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active === null) return null;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName,
      className: active.className,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
    };
  });
  console.log(`[defect-3] keyboard: ${JSON.stringify(keyboardRing)}`);
  expect(keyboardRing, "Tab lands on a control").not.toBeNull();
  expect(keyboardRing!.outlineColor, "the keyboard focus ring is the product's own").toBe("rgb(214, 168, 91)");
});

// --- defect 4 ----------------------------------------------------------------

test("defect 4: the first screen's title stack is collapsed and the void is guided", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ transcript: [] }), openings: OPENINGS });

  const measured = await page.evaluate(() => {
    const read = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { text: (node.textContent ?? "").trim(), top: Math.round(rect.top), height: Math.round(rect.height) };
    };
    const timeline = document.querySelector<HTMLElement>(".timeline");
    const anchor = document.querySelector<HTMLElement>("[data-empty-anchor]");
    return {
      stack: {
        appBarBrand: read(".app-bar-brand-name"),
        appBarCompanion: read(".app-bar-title"),
        surfaceHeading: read(".surface-header h2"),
        titleBand: read(".timeline-heading"),
        nameplate: read(".empty-state-nameplate"),
        openingLine: read(".empty-state-opening"),
      },
      chips: document.querySelectorAll(".composer-chip, .composer-chips-row").length,
      timelineHeight: timeline === null ? 0 : Math.round(timeline.getBoundingClientRect().height),
      anchorHeight: anchor === null ? 0 : Math.round(anchor.getBoundingClientRect().height),
    };
  });
  console.log(`[defect-4] first screen: ${JSON.stringify(measured)}`);

  // The two redundant layers are gone: no placeholder title band above the
  // transcript, and no plate repeating the name the app bar already carries.
  expect(measured.stack.titleBand, "an untitled conversation prints no title band").toBeNull();
  expect(measured.stack.nameplate, "the companion's name is not printed a third time").toBeNull();
  // The levels that survive: the app bar's brand + companion, the surface
  // heading, and the zero state's invitation (which names the companion).
  expect(measured.stack.appBarBrand?.text, "the app bar keeps the product mark").toBe("GameBuddy");
  expect(measured.stack.appBarCompanion?.text, "the app bar keeps the companion identity").toBe("Mira");
  expect(measured.stack.surfaceHeading?.text, "the surface keeps its own heading").toBe("聊天");
  expect(measured.stack.openingLine?.text, "the invitation names the companion").toContain("Mira");
  // The void is guided by the zero state alone: the composer offers no
  // break-ice row, because the only text it could submit is the companion's own
  // opening (choosing a variant lives on the opening bubble's own switcher).
  expect(measured.chips, "the composer offers no inverted opening path").toBe(0);
  expect(measured.anchorHeight, "the zero state fills the transcript").toBeGreaterThanOrEqual(
    measured.timelineHeight * 0.5,
  );
});

/**
 * The other half of the collapse: the band is not gone for good. A conversation
 * the Host has titled shows that title where the placeholder used to sit, so the
 * change removed a placeholder and not the transcript's own heading.
 */
test("defect 4: a published title is what the transcript heading shows", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ transcript: [], title: "Gate Chat" }) });
  const titled = await page.evaluate(
    () => document.querySelector<HTMLElement>(".timeline-heading h1")?.textContent?.trim() ?? null,
  );
  console.log(`[defect-4] published title: ${JSON.stringify(titled)}`);
  expect(titled, "a published title is what the transcript heading shows").toBe("Gate Chat");
});

// --- defect 4, the narrow window (owner ruling 2026-10-19, superseded 2026-10-21) ---

/**
 * The title stack's second layer on the window that has no room for it - and the
 * window that has no other name.
 *
 * The 2026-10-19 ruling dropped the band because the bar's own entry carried the
 * same word, marked itself `aria-current="page"`, and kept that name even where
 * the bar is icon-only. The 2026-10-21 ruling found the half that premise never
 * covered: below 861 px `.nav-label` is not drawn at all, so the bar is a row of
 * unlabelled icons - and under 480 px four of the six entries are not drawn
 * either, they sit inside the `More` panel whose trigger looks the same on every
 * one of them. At 400x800 the shell named no surface anywhere.
 *
 * So the heading is drawn where the bar stopped naming, and the assertions keep
 * the force the earlier premise protected from the other side:
 *
 *  - the region's accessible name is still exactly one node at both widths, and it
 *    is still the heading `SurfaceView` points `aria-labelledby` at - not a copy
 *    of the word somewhere else;
 *  - the mount focus still lands on that heading;
 *  - 1440x900 still draws nothing new: the band is still out of the flow and out of
 *    the column, and the room it spends there is still the measured 62 px.
 *
 * The 400x800 measurement is read from the layout rather than from a class name:
 * the band's own box (`headerHeight`), the word in it, where the scroll container
 * starts relative to that box and the column's gap, and - by turning the two
 * declarations back on in this same mounted layout - what the band costs there
 * (62 px: the 54 px box and the column's 8 px gap).
 */
test("defect 4: the narrow window draws the surface's name and the wide window still does not", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mountShell(page, { root: composedRoot({ transcript: [], title: "Gate Chat" }) });

  const narrow = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".surface-header")!;
    const heading = document.querySelector<HTMLElement>(".surface-header h2")!;
    const surface = document.querySelector<HTMLElement>('[data-testid="chat-surface"]')!;
    const content = surface.querySelector<HTMLElement>(".surface-content")!;
    const style = getComputedStyle(header);
    const headerRect = header.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    return {
      clipPath: style.clipPath,
      position: style.position,
      surfaceTop: Math.round(surface.getBoundingClientRect().top),
      regionHeight: Math.round(surface.getBoundingClientRect().height),
      gap: Math.round(Number.parseFloat(getComputedStyle(surface).rowGap || "0")),
      headerHeight: Math.round(headerRect.height),
      headerWidth: Math.round(headerRect.width),
      headerBottom: Math.round(headerRect.bottom),
      headingText: (heading.textContent ?? "").trim(),
      headingTop: Math.round(headingRect.top),
      headingHeight: Math.round(headingRect.height),
      headingWidth: Math.round(headingRect.width),
      contentTop: Math.round(content.getBoundingClientRect().top),
      contentClientHeight: content.clientHeight,
      labelledBy: surface.getAttribute("aria-labelledby"),
      headingFocused: document.activeElement === heading,
    };
  });
  const namedRegions = await page.getByRole("region", { name: "聊天", exact: true }).count();
  console.log(`[defect-4 narrow] ${JSON.stringify({ ...narrow, namedRegions })}`);

  // The label a 400 px player reads: the surface's own word, in the band the bar
  // gave up. Both catalogues carry it (`chatPanel`: 聊天 / Chat); this is the zh one.
  expect(narrow.clipPath, "the heading is drawn at 400x800").toBe("none");
  expect(narrow.position, "and it is in the column's flow").toBe("static");
  expect(narrow.headingText, "the drawn word is the surface's own").toBe("聊天");
  expect(narrow.headerHeight, "the band has a real box").toBeGreaterThan(0);
  expect(narrow.headingWidth, "the word has a real box").toBeGreaterThan(0);
  expect(narrow.headingTop, "and it is on the screen, not clipped off it").toBeGreaterThanOrEqual(narrow.surfaceTop);
  // It sits above the content, on the column's own gap: the band leads the surface.
  expect(
    narrow.contentTop,
    `the content starts under the band and its gap (${narrow.contentTop} vs ${narrow.headerBottom} + ${narrow.gap})`,
  ).toBe(narrow.headerBottom + narrow.gap);
  expect(
    narrow.contentTop - narrow.surfaceTop,
    "so the band is the first thing the surface draws",
  ).toBe(narrow.headerHeight + narrow.gap);

  // The room the band spends, measured in the same mounted layout: turning the two
  // declarations back on is the 400x800 capture's 744.
  const narrowContentWhileClipped = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".surface-header")!;
    const content = document.querySelector<HTMLElement>('[data-testid="chat-surface"] .surface-content')!;
    header.style.position = "absolute";
    header.style.clipPath = "inset(50%)";
    const clipped = content.clientHeight;
    header.style.position = "";
    header.style.clipPath = "";
    return clipped;
  });
  console.log(`[defect-4 narrow-clipped] contentClientHeight while the band is out of the column: ${narrowContentWhileClipped}`);
  expect(narrowContentWhileClipped, "and what the capture read while the band was retired is 744").toBe(744);
  expect(
    narrowContentWhileClipped - narrow.contentClientHeight,
    "the room the band's box and the column's gap spend at 400x800",
  ).toBe(62);

  // The half a11y depends on: the region is still the thing named 聊天, by the
  // node the heading IS - not by a copy of the word somewhere else.
  expect(narrow.labelledBy, "the region is still labelled by the heading's id").toBe("chat-surface-title");
  expect(namedRegions, "and exactly one region answers to the surface's name").toBe(1);
  expect(narrow.headingFocused, "the mount focus still lands on the heading").toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".surface-header")!;
    const surface = document.querySelector<HTMLElement>('[data-testid="chat-surface"]')!;
    const content = surface.querySelector<HTMLElement>(".surface-content")!;
    const surfaceTop = Math.round(surface.getBoundingClientRect().top);
    const style = getComputedStyle(header);
    return {
      clipPath: style.clipPath,
      position: style.position,
      height: Math.round(header.getBoundingClientRect().height),
      // The column's own `gap`, which is the second half of what the rule buys
      // back: a clipped box left in the flow keeps its height AND its gap.
      gap: Math.round(Number.parseFloat(getComputedStyle(surface).rowGap || "0")),
      headerTop: Math.round(header.getBoundingClientRect().top),
      contentTop: Math.round(content.getBoundingClientRect().top),
      contentClientHeight: content.clientHeight,
      surfaceTop,
    };
  });
  const wideContentWhileDrawn = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".surface-header")!;
    const content = document.querySelector<HTMLElement>('[data-testid="chat-surface"] .surface-content')!;
    header.style.position = "static";
    header.style.clipPath = "none";
    const drawn = content.clientHeight;
    header.style.position = "";
    header.style.clipPath = "";
    return drawn;
  });
  const wideNamedRegions = await page.getByRole("region", { name: "聊天", exact: true }).count();
  console.log(`[defect-4 wide] ${JSON.stringify({ ...wide, namedRegions: wideNamedRegions, whileDrawn: wideContentWhileDrawn })}`);
  // The 2026-10-20 ruling stands: at 1440x900 the bar spells the selected surface's
  // word, so the band stays retired there and this change draws nothing new.
  expect(wide.clipPath, "a wide window draws no band").toBe("inset(50%)");
  expect(wide.position, "so its box stays out of the column").toBe("absolute");
  expect(wide.gap, "the column keeps its own gap for other blocks").toBeGreaterThan(0);
  expect(wideNamedRegions, "the region answers to the surface's name at the wide width too").toBe(1);
  expect(
    wide.contentTop,
    `the surface's content starts at the surface at 1440x900 too (${wide.contentTop} vs ${wide.surfaceTop})`,
  ).toBe(wide.surfaceTop);
  expect(wide.contentClientHeight, "the room the band and the gap were spending comes back").toBe(844);
  expect(wideContentWhileDrawn, "and with the band put back in the column it reads 782").toBe(782);
  expect(
    wide.contentClientHeight - wideContentWhileDrawn,
    "the band's 54 px box plus the column's 8 px gap",
  ).toBe(62);
});

// --- defect 5 ----------------------------------------------------------------

/** The number of line boxes a control's own text occupies. */
async function textLineCount(locator: Locator): Promise<number> {
  return locator.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const tops = new Set<number>();
    let textNode = walker.nextNode();
    while (textNode !== null) {
      if ((textNode.textContent ?? "").trim().length > 0) {
        range.selectNodeContents(textNode);
        for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
      }
      textNode = walker.nextNode();
    }
    return tops.size;
  });
}

async function openSurface(page: Page, label: string, testId: string): Promise<void> {
  const entry = page.getByRole("button", { name: label, exact: true });
  if (!(await page.getByTestId(testId).isVisible())) {
    if (!(await entry.isVisible())) await page.getByRole("button", { name: "更多", exact: true }).click();
    await entry.click();
  }
  await expect(page.getByTestId(testId)).toBeVisible();
}

test("defect 5: a button beside a full-width field keeps its label on one line", async ({ page }) => {
  await mountShell(page);

  const read = (locator: Locator) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        text: (node.textContent ?? "").trim(),
        whiteSpace: style.whiteSpace,
        flexShrink: style.flexShrink,
        height: Math.round(node.getBoundingClientRect().height),
        width: Math.round(node.getBoundingClientRect().width),
      };
    });

  await openSurface(page, "角色", "characters-surface");
  const createCompanion = page.getByTestId("characters-surface").getByRole("button", { name: "创建伙伴", exact: true });
  await expect(createCompanion).toBeVisible();
  const characters = await read(createCompanion);
  const charactersLines = await textLineCount(createCompanion);
  console.log(`[defect-5] characters: lines=${charactersLines} ${JSON.stringify(characters)}`);

  await openSurface(page, "记忆", "memory-surface");
  await page.getByTestId("memory-surface").locator("[data-memory-authoring-toggle]").click();
  const createMemory = page.getByTestId("memory-surface").getByRole("button", { name: "创建", exact: true });
  await expect(createMemory).toBeVisible();
  const memory = await read(createMemory);
  const memoryLines = await textLineCount(createMemory);
  console.log(`[defect-5] memory: lines=${memoryLines} ${JSON.stringify(memory)}`);

  expect(charactersLines, "创建伙伴 stays on one line").toBe(1);
  expect(memoryLines, "创建 stays on one line").toBe(1);
  expect(characters.whiteSpace, "a shared button never wraps its label").toBe("nowrap");
  expect(memory.whiteSpace, "a shared button never wraps its label").toBe("nowrap");
  expect(characters.flexShrink, "a shared button is not squeezed by the field").toBe("0");
  expect(memory.flexShrink, "a shared button is not squeezed by the field").toBe("0");
  expect(characters.height, "the label fits inside the 44px floor").toBe(44);
  expect(memory.height, "the label fits inside the 44px floor").toBe(44);
});


// --- defect 6 ----------------------------------------------------------------

/**
 * The Memory surface's own primary action read as its weakest control: the way to tell her
 * something was a bare 12 px `--text-secondary` text link with no chrome, while 刷新记忆 - a
 * recovery action - was a 44 px bordered button in the header. The surface therefore offered
 * two controls and painted the maintenance one loudest.
 *
 * The treatment is the product's own primary (`small-button primary`, `--accent-solid`), so
 * nothing here invents a colour step: the assertion reads the token off the sheet and compares
 * the two controls against it. `--accent-solid` is resolved through a probe element rather than
 * written as a literal, so the test follows the sheet if the token moves.
 *
 * Before: the toggle measured `background-color: rgba(0, 0, 0, 0)`, `font-size: 12px`,
 * `color: rgb(200, 192, 182)`, `border: 0` against 刷新记忆's `rgb(32, 29, 29)` behind a 1 px
 * border at 13 px/`rgb(245, 240, 232)`.
 */
test("the Memory surface's primary action outranks its secondaries", async ({ page }) => {
  await mountShell(page);
  await openSurface(page, "记忆", "memory-surface");
  const surface = page.getByTestId("memory-surface");

  const accentSolid = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--accent-solid)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });

  const read = (locator: Locator) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        text: (node.textContent ?? "").trim(),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        height: Math.round(node.getBoundingClientRect().height),
      };
    });

  const toggle = surface.locator("[data-memory-authoring-toggle]");
  const refresh = surface.getByRole("button", { name: "刷新记忆", exact: true });
  const closed = await read(toggle);
  const secondary = await read(refresh);
  console.log(`[memory-primary closed] primary=${JSON.stringify(closed)} secondary=${JSON.stringify(secondary)}`);

  expect(closed.backgroundColor, "the surface's own action is painted as the product's primary").toBe(accentSolid);
  expect(
    closed.backgroundColor,
    `the primary (${closed.backgroundColor}) is not the secondary's fill (${secondary.backgroundColor})`,
  ).not.toBe(secondary.backgroundColor);
  expect(
    closed.fontSize,
    `the primary is not quieter than the recovery control (${closed.fontSize} vs ${secondary.fontSize})`,
  ).toBe(secondary.fontSize);
  expect(closed.height, "and it keeps the 44 px floor like every other control").toBe(44);
  // The two secondaries are untouched: the recovery control keeps its quiet fill and border.
  expect(secondary.borderTopWidth, "刷新记忆 keeps its resting border").toBe("1px");

  // Opening the form moves the primary to the verb that commits it: the toggle becomes the way
  // out, so it drops back to the secondary treatment instead of two primaries sharing the panel.
  await toggle.click();
  const save = surface.getByRole("button", { name: "创建", exact: true });
  await expect(save).toBeVisible();
  // Off the button, and settled: `small-button` transitions its own fill, so the reading below is
  // taken after the repaint rather than mid-interpolation.
  await page.mouse.move(0, 0);
  await expect(toggle).toHaveCSS("background-color", secondary.backgroundColor);
  const opened = await read(toggle);
  const committed = await read(save);
  console.log(`[memory-primary open] withdraw=${JSON.stringify(opened)} save=${JSON.stringify(committed)}`);

  expect(committed.backgroundColor, "the compose-and-save control is the primary one").toBe(accentSolid);
  expect(opened.backgroundColor, "and the withdraw beside it is not").not.toBe(accentSolid);
  expect(opened.backgroundColor, "the withdraw is the same secondary treatment as 刷新记忆").toBe(
    secondary.backgroundColor,
  );
  // The labelled control is the one the surface is for: the primary carries the notebook's words.
  expect(closed.text, "the primary is the action the surface exists for").toContain("悄悄告诉伴侣一件事");
});

// --- the opening switcher's label vocabulary ---------------------------------

/**
 * The opening switcher printed the Host's own greeting-set label raw, so an
 * otherwise zh-CN surface read `Default 1/2`: `openingVariant.label` is the
 * greeting set's structural entry name (`Default`, `Alternate N`, built from the
 * card's 1-based order in `new-companion-service.ts`), not a player word. The
 * catalogue now carries that vocabulary and the switcher translates it, keeping
 * the Host's own order in an alternate's name and the position beside it.
 */
test("the opening switcher translates the Host's variant label into the UI language", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ transcript: [{ role: "companion", text: "炉子上的热水刚开。", opening: true }] }) });
  const indicator = page.locator(".swipe-indicator");
  await expect(indicator).toBeVisible();

  const measured = (await indicator.textContent())?.trim() ?? "";
  console.log(`[variant-label zh] ${JSON.stringify(measured)}`);
  expect(measured, "the Host's default greeting reads as the catalogue's own word").toContain("默认");
  expect(measured, "and its position in the set is still shown").toContain("1/2");
  expect(measured, "the Host's English literal never reaches a zh-CN surface").not.toContain("Default");
});

// --- the swipe switcher's own arrows ------------------------------------------

/**
 * The swipe switcher drew the Host's arrows inside its own.
 *
 * The Host used to publish the swipe position in the standard SillyTavern / Pi
 * spelling, `◀ 1/3 ▶` (`formatSwipeLabel`, `host/src/tavern/message-tree.ts`; the
 * swipe route wrote the same shape inline at
 * `host/src/tavern/chat-pipeline-service.ts`), and `MessageBubble` printed that
 * string verbatim between its own `ChevronLeft` / `ChevronRight` buttons - so a
 * message that has more than one swipe read as arrows inside arrows. The pinned
 * screenshot run (`shots-final10`) never showed it because no message in that
 * transcript carried more than one swipe. The Host now publishes the plain
 * position, and this journey keeps serving the older spelling so the client's own
 * read-back of that decoration is what the assertions still cover.
 *
 * The assertions, and the failure each one catches:
 *  - the indicator is the Host's position alone: catches the arrows of that older
 *    spelling printed beside the real pair;
 *  - the switcher still owns exactly the two named buttons: catches the fix that
 *    drops the buttons instead of the decoration, which would leave the position
 *    as text with nothing to press.
 */
test("the swipe switcher draws one pair of arrows, not the Host's arrows inside its own", async ({ page }) => {
  await mountShell(page, {
    root: composedRoot({
      transcript: [
        { role: "player", text: "你好" },
        { role: "companion", text: "雨下得真透，地里的土都喝饱了。", swipes: { index: 1, total: 3 } },
      ],
    }),
  });

  const controls = page.locator(".swipe-controls");
  await expect(controls).toBeVisible();
  const measured = await controls.evaluate((node) => ({
    indicator: (node.querySelector(".swipe-indicator")?.textContent ?? "").trim(),
    text: (node.textContent ?? "").trim(),
    buttons: [...node.querySelectorAll("button")].map((button) => (button.getAttribute("aria-label") ?? "").trim()),
  }));
  console.log(`[swipe-switcher] measured: ${JSON.stringify(measured)}`);

  expect(measured.indicator, "the indicator is the Host's position, undecorated").toBe("2/3");
  expect(measured.text, "the left arrow belongs to the button, not to the label").not.toContain("◀");
  expect(measured.text, "the right arrow belongs to the button, not to the label").not.toContain("▶");
  expect(measured.buttons, "the switcher is still the two real buttons").toEqual(["上一个变体", "下一个变体"]);
});

// --- the stepper's disabled arrow (owner ruling, 2026-10-21) -------------------

/**
 * An arrow that cannot move still looks like an arrow.
 *
 * The stepper is the owner's bare `‹ 1/3 ›`: the glyph IS the visible control and the words live in
 * the accessible name. What the bare form lost was the DISABLED state - `--text-disabled` on the
 * strip's own card tone and nothing else - so an arrow at the first variant read as empty space
 * rather than as an arrow that cannot go further.
 *
 * The rule the component and the sheet are held to, and the failure each assertion catches:
 *  - the disabled arrow draws a container of its own, from the tokens the sheet already declares for
 *    quiet controls (`--surface-panel` under the strip's `--surface-raised`, plus `--border-subtle`):
 *    catches the tone-only state that started this, and catches a new colour invented for one arrow;
 *  - the enabled arrow is untouched - the bare glyph on the strip, no plate, no hairline of its own:
 *    catches the container leaking into the live state;
 *  - the disabled state is attenuated ONCE (the tone alone, no `opacity`): catches the earlier double
 *    dimming coming back through a fill that is composited with an opacity;
 *  - the glyph clears 3:1 against ITS OWN container, not against the strip it used to sit on:
 *    catches a container so close to the muted tone that "unavailable" reads as "absent";
 *  - both arrows are the same 44 px target, so the strip's own box cannot move: catches the container
 *    being bought with a smaller hit area;
 *  - the names: the enabled arrow keeps 「下一个变体」 and the disabled one says WHY it cannot move.
 */
test("a disabled stepper arrow keeps a container, one attenuation and a name that says why", async ({ page }) => {
  await mountShell(page, {
    root: composedRoot({ transcript: [{ role: "companion", text: "门廊上的那盏灯还亮着。", opening: true }] }),
  });

  const measured = await page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (match === null) return [0, 0, 0, 0];
      const parts = match[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const channel = (value: number): number => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (colour: readonly number[]): number =>
      0.2126 * channel(colour[0]!) + 0.7152 * channel(colour[1]!) + 0.0722 * channel(colour[2]!);
    const ratio = (foreground: readonly number[], background: readonly number[]): number => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (lighter! + 0.05) / (darker! + 0.05);
    };
    /** The opaque colour the glyph is painted on, composited exactly as the runtime contrast gate does. */
    const container = (button: Element): number[] => {
      const stack: [number, number, number, number][] = [];
      for (let current: Element | null = button; current !== null; current = current.parentElement) {
        const background = parse(getComputedStyle(current).backgroundColor);
        stack.push(background);
        if (background[3] >= 0.999) break;
      }
      let effective: number[] = [...stack[stack.length - 1]!.slice(0, 3)];
      for (let index = stack.length - 2; index >= 0; index -= 1) {
        const top = stack[index]!;
        effective = [
          top[0]! * top[3] + effective[0]! * (1 - top[3]),
          top[1]! * top[3] + effective[1]! * (1 - top[3]),
          top[2]! * top[3] + effective[2]! * (1 - top[3]),
        ];
      }
      return effective.map((value) => Math.round(value));
    };
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const read = (button: HTMLElement) => {
      const style = getComputedStyle(button);
      const fill = container(button);
      return {
        name: (button.getAttribute("aria-label") ?? "").trim(),
        disabled: (button as HTMLButtonElement).disabled,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderTopColor: style.borderTopColor,
        opacity: style.opacity,
        box: box(button),
        container: `rgb(${fill.join(",")})`,
        ratio: Math.round(ratio(parse(style.color).slice(0, 3), fill) * 100) / 100,
      };
    };
    const pager = document.querySelector<HTMLElement>(".swipe-controls")!;
    const [previous, next] = [...pager.querySelectorAll<HTMLElement>(".swipe-btn")];
    return {
      indicator: (pager.querySelector(".swipe-indicator")?.textContent ?? "").trim(),
      pager: box(pager),
      stripBackground: getComputedStyle(pager).backgroundColor,
      previous: read(previous!),
      next: read(next!),
    };
  });
  console.log(`[stepper-disabled] ${JSON.stringify(measured)}`);

  const { previous, next } = measured;
  expect(previous.disabled, "the Host's own index <= 0 precondition disables the previous arrow").toBe(true);
  expect(next.disabled, "and the next direction stays operable").toBe(false);

  // Present: the disabled arrow draws the quiet control's own box, one layer down from the strip.
  expect(previous.backgroundColor, "the disabled arrow is not a transparent glyph any more").not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  expect(previous.backgroundColor, "and its plate is not the strip's own fill, which would be invisible").not.toBe(
    measured.stripBackground,
  );
  expect(previous.borderTopWidth, "it carries the quiet hairline").toBe("1px");
  expect(previous.borderTopColor, "in a colour that is actually drawn").not.toBe("rgba(0, 0, 0, 0)");

  // Unavailable, and legible: the number this file's own [stepper-disabled] line printed.
  expect(
    previous.ratio,
    `the disabled glyph paints ${previous.color} on ${previous.container} = ${previous.ratio}:1`,
  ).toBeGreaterThanOrEqual(3);

  // Attenuated once: the tone alone.
  expect(Number.parseFloat(previous.opacity), "no opacity dims the disabled arrow a second time").toBe(1);

  // The enabled arrow is exactly what it was: the bare glyph on the strip.
  expect(next.backgroundColor, "the enabled arrow draws no plate").toBe("rgba(0, 0, 0, 0)");
  expect(next.borderTopWidth, "and no hairline of its own").toBe("0px");

  // The 44 px target is not what changed, so the strip's own box cannot have moved with it.
  expect(previous.box, "the disabled arrow is the same target the enabled one is").toEqual(next.box);
  expect(previous.box.width, "and it is still the 44 px floor").toBeGreaterThanOrEqual(44);
  expect(previous.box.height, "in both directions").toBeGreaterThanOrEqual(44);

  // The names: the live one keeps the short word, the dead one says why.
  expect(next.name, "the enabled arrow keeps the catalogue's short name").toBe("下一个变体");
  expect(previous.name, "the disabled arrow says which end of the set it is on").toBe(
    "上一个变体（这已经是第一个变体）",
  );
});

/**
 * The same pair of names in the other catalogue.
 *
 * The disabled name is not a translation of the glyph but a sentence, so it is pinned per language
 * rather than once: a catalogue that dropped it would leave the English surface with the bare
 * 「上一个变体」 and the same silence about WHY.
 */
test("the disabled stepper arrow says why in the English catalogue too", async ({ page }) => {
  await mountShell(page, {
    locale: "en",
    root: composedRoot({
      transcript: [{ role: "companion", text: "The lantern over the porch is still lit.", opening: true }],
    }),
  });

  const arrows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".swipe-btn")].map((button) => ({
      name: (button.getAttribute("aria-label") ?? "").trim(),
      disabled: (button as HTMLButtonElement).disabled,
    })),
  );
  console.log(`[stepper-disabled en] ${JSON.stringify(arrows)}`);

  expect(arrows, "the English surface names both states, and only the first states its reason").toEqual([
    { name: "Previous variant (this is the first variant)", disabled: true },
    { name: "Next variant", disabled: false },
  ]);
});

// --- defect 6, the narrow control strip and the player's own line (owner ruling, 2026-10-19) ---

/**
 * The strip under a reply is as short as the reply itself, and the player's own
 * line is as wide as the line.
 *
 * Two measurements of one screen at 400x800:
 *
 *  - **the strip.** Her reply's controls wrapped onto a second row - 96 px under a
 *    46 px bubble, on a message whose own text is two lines at that width - because
 *    the four buttons spent their width on their words. The words were never what
 *    named them: each already carries an `aria-label` (and the same string as its
 *    `title`) that is longer and more specific than the visible word, so the
 *    narrow window retires the word and keeps the name. The assertion is therefore
 *    on the RESULT (one row, every target 44 px, every control named) and not on
 *    the mechanism: a strip that put the words back, or that bought the row with a
 *    24 px glyph, fails.
 *  - **the player's bubble.** The row's body is a flex column and `align-items`
 *    defaults to `stretch`, so a two-character line ran out to whatever was widest
 *    under it - the strip - instead of to the words. The bubble is now as wide as
 *    the message; the force kept here is that its OUTER edge does not move (the
 *    avatar beside it stays where it was) and that a long line still takes the
 *    whole column it is given.
 */
test("defect 6: the narrow strip is one row and the player's own line is as wide as the line", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mountShell(page, {
    root: composedRoot({
      transcript: [
        { role: "companion", text: "门廊上的那盏灯还亮着。" },
        { role: "player", text: "你好" },
        { role: "companion", text: "早上的光从山脊上过来。", swipes: { index: 1, total: 3 } },
        { role: "player", text: "今天棚子里的番茄全红了，我摘了一整篮，等会儿带去镇上卖掉，顺便把去年冬天欠的账还了。" },
        { role: "companion", text: "那就带上篮子，正午前出发。" },
      ],
    }),
  });

  const measured = await page.evaluate(() => {
    const round = (value: number) => Math.round(value);
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return { left: round(rect.left), right: round(rect.right), width: round(rect.width), height: round(rect.height) };
    };
    const rows = [...document.querySelectorAll<HTMLElement>("ol.message-list > li")];
    // The reply the fixture gives a swipe set: the one row that carries the pager
    // AND the rewind AND the edit AND the delete - the strip's worst case.
    const swiped = rows[2]!;
    const strip = swiped.querySelector<HTMLElement>(".message-actions")!;
    const controls = [...strip.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        className: child.className,
        name: (child.getAttribute("aria-label") ?? "").trim(),
        // The glyph actually drawn, from the icon family's own class: the rewind and
        // Regenerate sit next to each other and must not be one shape.
        glyph: [...(child.querySelector("svg")?.classList ?? [])].find((token) => token.startsWith("lucide-")) ?? null,
        width: round(rect.width),
        height: round(rect.height),
        centre: Math.round(rect.top + rect.height / 2),
      };
    });
    const playerRows = rows.filter((row) => row.classList.contains("player"));
    const readPlayer = (row: HTMLElement) => {
      const body = row.querySelector<HTMLElement>(".message-body")!;
      const bubble = row.querySelector<HTMLElement>(".message-bubble")!;
      const avatar = row.querySelector<HTMLElement>(".avatar-small")!;
      return { body: box(body), bubble: box(bubble), avatar: box(avatar) };
    };
    return {
      strip: { box: box(strip), rows: new Set(controls.map((control) => control.centre)).size, controls },
      pager: box(strip.querySelector<HTMLElement>(".swipe-controls")!),
      short: readPlayer(playerRows[0]!),
      long: readPlayer(playerRows[1]!),
      listWidth: round(document.querySelector<HTMLElement>("ol.message-list")!.getBoundingClientRect().width),
    };
  });
  console.log(`[defect-6 narrow] ${JSON.stringify(measured)}`);

  // One row, and its controls are the whole of it: the strip is as tall as one
  // 44 px target (the pager's own box is 46), not two stacked ones.
  expect(measured.strip.rows, `the strip is one row (${JSON.stringify(measured.strip.controls)})`).toBe(1);
  expect(measured.strip.box.height, "so the strip is one target tall, not two").toBeLessThanOrEqual(50);
  expect(measured.strip.controls.length, "and it still holds every control it had").toBe(4);
  for (const control of measured.strip.controls) {
    // The name is the meaning, and it is a real sentence rather than the glyph the
    // narrow form leaves visible.
    expect(control.name, `${control.className} keeps an accessible name`).not.toBe("");
    expect(control.name, `${control.className}'s name is not the bare glyph`).not.toMatch(/^[‹›<>←→×✔✎🗑]+$/u);
    expect(control.height, `${control.className} clears the 44 px floor`).toBeGreaterThanOrEqual(44);
    expect(control.width, `${control.className} is a target, not a squeezed glyph`).toBeGreaterThanOrEqual(44);
  }
  expect(measured.strip.box.width, "the strip is inside the reply's own column").toBeLessThanOrEqual(
    measured.listWidth,
  );
  // The strip's recorded box (`shots-final31`, 400x800) and the arithmetic the narrow block rests on
  // (`style.css`: the pager at 136 plus three 44 px targets plus three 6 px gaps). The disabled arrow's
  // new container may not buy itself a single pixel out of either number.
  expect(
    { width: measured.strip.box.width, height: measured.strip.box.height },
    "the strip keeps the box shots-final31 recorded",
  ).toEqual({ width: 286, height: 46 });
  expect({ width: measured.pager.width, height: measured.pager.height }, "and the pager keeps its 136 px").toEqual({
    width: 136,
    height: 46,
  });

  // The rewind does not wear the regenerate arrow. `Undo2` and `RefreshCw` were one
  // stroke apart, and a player reading the counter-clockwise circular arrow as
  // "answer me again" pressed the one control here that DELETES the rest of the
  // conversation - so the glyph is pinned on both sides: a cut on the destructive
  // control, the circular arrow on Regenerate, never the same shape. The two share a
  // screen rather than a strip - Regenerate is the Host's precondition for the
  // transcript's LAST reply, a rewind point is never the last row - which is exactly
  // how one vocabulary teaches the other, so both are read from the transcript.
  const glyphs = await page.evaluate(() => {
    const read = (selector: string) => {
      const button = document.querySelector<HTMLElement>(selector);
      if (button === null) return null;
      const rect = button.getBoundingClientRect();
      const svg = button.querySelector("svg");
      return {
        glyph: svg === null ? null : ([...svg.classList].find((token) => token.startsWith("lucide-")) ?? null),
        name: (button.getAttribute("aria-label") ?? "").trim(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      regenerate: read(".regenerate-btn"),
    };
  });
  const rewindControl = measured.strip.controls.find((control) => String(control.className).includes("rewind-btn"));
  expect(rewindControl?.glyph, "the rewind draws a cut").toBe("lucide-scissors");
  expect(glyphs.regenerate?.glyph, "Regenerate keeps its circular arrow").toBe("lucide-refresh-cw");
  expect(rewindControl?.glyph, "so the destructive control is not the friendly one").not.toBe(
    glyphs.regenerate?.glyph,
  );
  expect(rewindControl?.name, "and the rewind still names what it keeps and removes").toContain("回退到此处");
  expect(rewindControl?.name, "including the count it would remove").toContain("（共 2 条）");
  expect(glyphs.regenerate?.name, "while Regenerate is still named by its own word").toBe("重新生成");
  expect(rewindControl?.width, "the rewind's box did not move with its glyph").toBe(44);
  expect(rewindControl?.height, "and neither did its target").toBe(44);
  expect(glyphs.regenerate?.width, "nor did the control beside it in the transcript").toBe(44);
  expect(glyphs.regenerate?.height, "which keeps the same touch floor").toBe(44);

  // The player's own line: as wide as the line, and no wider.
  expect(
    measured.short.bubble.width,
    `a two-character line is a two-character bubble (${measured.short.bubble.width} px)`,
  ).toBeLessThan(measured.long.bubble.width);
  expect(measured.short.bubble.width, "and it is not the strip's width either").toBeLessThan(measured.short.body.width);
  // The outer edge is what the avatar hangs off: it does not move.
  expect(measured.short.bubble.right, "the short line still ends at the row's own outer edge").toBe(
    measured.long.bubble.right,
  );
  expect(measured.short.avatar.left, "and the avatar is where it always was").toBe(measured.long.avatar.left);
  // A long line is unchanged: it fills the column the row gives it.
  expect(
    measured.long.bubble.width,
    `a long line still fills its body (${measured.long.bubble.width} in ${measured.long.body.width})`,
  ).toBe(measured.long.body.width);

  // The same two boxes at the wide window. The arrows are the same 44 px target there (the narrow
  // block only retires the OTHER controls' words), so the pager does not move and the strip keeps the
  // width its own contents give it.
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const round = (value: number) => Math.round(value);
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { width: round(rect.width), height: round(rect.height) };
    };
    const rows = [...document.querySelectorAll<HTMLElement>("ol.message-list > li")];
    const strip = rows[2]!.querySelector<HTMLElement>(".message-actions")!;
    return { strip: box(strip), pager: box(strip.querySelector<HTMLElement>(".swipe-controls")!) };
  });
  console.log(`[defect-6 wide] ${JSON.stringify(wide)}`);
  expect(wide.pager, "the pager is the same 136 px at 1440x900").toEqual({ width: 136, height: 46 });
  expect(wide.strip.height, "and the strip is still one target tall").toBe(46);
  // 403 is what this strip's contents give it on the wide window (the same pager plus the three
  // controls wearing their words); the arrows are 44x44 on both sides of this change, so it is the
  // same number it was before the disabled arrow grew a container.
  expect(wide.strip.width, "and the strip keeps the width its contents give it").toBe(403);
});

// --- the prosody tag's badge --------------------------------------------------

/**
 * A leading `（轻声）` was printed as ordinary prose, so a stage direction read as
 * something she said.
 *
 * The voice layer already treats a parenthesised group as an inline tag and performs it
 * instead of speaking it (`dehydrateCompanionSpeech`, `INLINE_TAG_RE`,
 * `host/src/companion-speech-dehydration.ts`), which makes the transcript the one surface
 * that showed it as text. It now reads as what it is: the product's dim badge plate, set
 * ahead of her speech inside the same paragraph.
 *
 * The assertions, and the failure each one catches:
 *  - the plate is a plate and not a bar (inline-flex, its own two words' width): catches a
 *    sibling block above the bubble, which the column's `stretch` paints edge to edge;
 *  - its ink and its plate are the product's own tones, measured against the bubble:
 *    catches a new colour for one chip, and catches a "dim" tone that dims past the floor;
 *  - the words are MOVED, never deleted - the speech beside the badge, and the whole
 *    sentence of a tag that appears mid-line, are quoted and compared: catches the tag
 *    being stripped from her text (a player losing what she said) and catches the
 *    mid-sentence parenthetical being lifted out of the middle of a sentence.
 */
test("a leading prosody tag reads as a badge, and her words are moved rather than deleted", async ({ page }) => {
  const opening = "（轻声）种子我已经帮你种好啦。";
  const midline = "种子（轻声）我已经种好了。";
  await mountShell(page, {
    root: composedRoot({
      transcript: [
        { role: "companion", text: opening },
        { role: "player", text: "谢谢你。" },
        { role: "companion", text: midline },
      ],
    }),
  });

  const measured = await page.evaluate(() => {
    const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (colour: string) => {
      const [r, g, b] = [...colour.matchAll(/[\d.]+/gu)].map((match) => Number(match[0]));
      return 0.2126 * channel(r! / 255) + 0.7152 * channel(g! / 255) + 0.0722 * channel(b! / 255);
    };
    const ratio = (a: string, b: string) => {
      const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
      return Math.round(((high! + 0.05) / (low! + 0.05)) * 100) / 100;
    };
    const read = (row: HTMLElement) => {
      const bubble = row.querySelector<HTMLElement>(".message-bubble")!;
      const badges = [...bubble.querySelectorAll<HTMLElement>("[data-mood-tag]")];
      const speechOnly = bubble.cloneNode(true) as HTMLElement;
      for (const badge of speechOnly.querySelectorAll("[data-mood-tag]")) badge.remove();
      return {
        printed: (bubble.textContent ?? "").replace(/\s+/gu, " ").trim(),
        spoken: (speechOnly.textContent ?? "").replace(/\s+/gu, " ").trim(),
        bubbleBackground: getComputedStyle(bubble).backgroundColor,
        badgeCount: badges.length,
        badge:
          badges.length === 0
            ? null
            : (() => {
                const node = badges[0]!;
                const style = getComputedStyle(node);
                const box = node.getBoundingClientRect();
                return {
                  text: (node.textContent ?? "").trim(),
                  colour: style.color,
                  background: style.backgroundColor,
                  display: style.display,
                  parent: node.parentElement?.tagName ?? null,
                  firstChild: node.parentElement?.firstElementChild === node,
                  width: Math.round(box.width),
                  height: Math.round(box.height),
                  bubbleWidth: Math.round(bubble.getBoundingClientRect().width),
                };
              })(),
      };
    };
    const rows = [...document.querySelectorAll<HTMLElement>("ol.message-list > li")];
    return {
      tagged: read(rows[0]!),
      midline: read(rows[2]!),
      inkOnPlate: (() => {
        const bubble = rows[0]!.querySelector<HTMLElement>(".message-bubble")!;
        const badge = rows[0]!.querySelector<HTMLElement>("[data-mood-tag]")!;
        const badgeStyle = getComputedStyle(badge);
        return {
          badgeInkOnItsPlate: ratio(badgeStyle.color, badgeStyle.backgroundColor),
          badgeInkOnBubble: ratio(badgeStyle.color, getComputedStyle(bubble).backgroundColor),
          plateAgainstBubble: ratio(badgeStyle.backgroundColor, getComputedStyle(bubble).backgroundColor),
        };
      })(),
    };
  });
  console.log(`[prosody-tag] ${JSON.stringify(measured)}`);

  // The tag is ahead of the speech, inside the paragraph, and it hugs its own words.
  expect(measured.tagged.badgeCount, "the opening tag is one badge").toBe(1);
  const badge = measured.tagged.badge!;
  expect(badge.text, "the badge carries the direction's own words").toBe("轻声");
  expect(badge.parent, "the badge sits inside her first prose block").toBe("P");
  expect(badge.firstChild, "and it leads it, ahead of her speech").toBe(true);
  expect(badge.display, "an inline plate, not a stretched row").toBe("inline-flex");
  expect(badge.width, "the plate hugs its two words").toBeLessThan(badge.bubbleWidth);
  expect(badge.height, "and it is one line of badge, not a bar").toBeGreaterThan(14);
  expect(badge.height, "and it is one line of badge, not a bar").toBeLessThan(30);

  // The tone: the product's badge plate on the companion bubble, its ink clear of the floor.
  console.log(
    `[prosody-tag] contrast ink-on-plate=${measured.inkOnPlate.badgeInkOnItsPlate}:1 ink-on-bubble=${measured.inkOnPlate.badgeInkOnBubble}:1 plate-on-bubble=${measured.inkOnPlate.plateAgainstBubble}:1`,
  );
  expect(badge.colour, "the dim tone is the product's own secondary ink").toBe("rgb(200, 192, 182)");
  expect(badge.background, "and the plate is the product's own elevated card tone").toBe("rgb(40, 37, 37)");
  // Her bubble is the Card tone and the plate is the Elevated tone above it - the same one-step
  // lift every card in the product takes on hover. One step is what it is: 1.10:1 is a quiet
  // edge, so the badge's shape (an 11 px nowrap plate with the product's hairline) and its
  // smaller type carry the distinction, and the ink is what has to clear the floor.
  expect(measured.tagged.bubbleBackground, "inside her own bubble, not another surface").toBe("rgb(32, 29, 29)");
  expect(
    measured.inkOnPlate.badgeInkOnItsPlate,
    `the badge's ink clears the 4.5:1 floor on its own plate (${measured.inkOnPlate.badgeInkOnItsPlate}:1)`,
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    measured.inkOnPlate.badgeInkOnBubble,
    `and it would clear it against the bubble itself (${measured.inkOnPlate.badgeInkOnBubble}:1)`,
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    measured.inkOnPlate.plateAgainstBubble,
    `the plate is a step above the bubble, not the bubble (${measured.inkOnPlate.plateAgainstBubble}:1)`,
  ).toBeGreaterThan(1.05);
  expect(
    measured.inkOnPlate.plateAgainstBubble,
    "and it is the product's one-step lift, not a new colour ramp",
  ).toBeLessThan(1.3);

  // The words: the speech is exactly the sentence without the direction, and the tag's own
  // words are on screen in the badge rather than gone.
  expect(badge.text, "the direction's words are kept, in the badge").toBe("轻声");
  expect(measured.tagged.printed, "nothing prints the whole parenthetical as prose").not.toContain("（轻声）");
  expect(measured.tagged.spoken, "her speech is the sentence she says, unchanged").toBe("种子我已经帮你种好啦。");

  // A tag inside the sentence is part of what she said: no badge, and not one character moved.
  expect(measured.midline.badgeCount, "a mid-sentence parenthetical is not a badge").toBe(0);
  expect(measured.midline.printed, "and her sentence is printed exactly as she wrote it").toBe(midline);
  expect(measured.midline.spoken, "with nothing lifted out of the middle").toBe(midline);
});
