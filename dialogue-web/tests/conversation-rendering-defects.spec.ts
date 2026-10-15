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
  /** The position the Host publishes for a swipe set, in its own `◀ 1/3 ▶` spelling. */
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
        companion: { name: "Mira" },
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
}>;

async function mountShell(page: Page, options: MountOptions = {}): Promise<void> {
  const root = options.root ?? composedRoot();
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
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
    route.fulfill(jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null })),
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
 * The heading's focus indicator is read the way the eye meets it: the outline the
 * browser computed, composited over the tone it is drawn on, as a WCAG contrast
 * ratio. Both the outline and the colour behind it come from the live cascade.
 */
const headingFocusReading = () => {
  const heading = document.querySelector<HTMLElement>(".surface-header h2")!;
  const style = getComputedStyle(heading);
  const parse = (value: string): [number, number, number, number] => {
    const match = /rgba?\(([^)]+)\)/u.exec(value);
    if (match === null) return [0, 0, 0, 0];
    const parts = match[1]!.split(",").map((part) => Number(part.trim()));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  };
  const linear = (channel: number): number => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb: readonly number[]): number =>
    0.2126 * linear(rgb[0]!) + 0.7152 * linear(rgb[1]!) + 0.0722 * linear(rgb[2]!);
  let backdrop: number[] = [12, 11, 11];
  for (let node: HTMLElement | null = heading; node !== null; node = node.parentElement) {
    const value = parse(getComputedStyle(node).backgroundColor);
    if (value[3] === 1) {
      backdrop = [value[0]!, value[1]!, value[2]!];
      break;
    }
  }
  const outline = parse(style.outlineColor);
  const composited = [0, 1, 2].map(
    (index) => outline[index]! * outline[3]! + backdrop[index]! * (1 - outline[3]!),
  );
  const ratio =
    (Math.max(luminance(composited), luminance(backdrop)) + 0.05) /
    (Math.min(luminance(composited), luminance(backdrop)) + 0.05);
  return {
    text: (heading.textContent ?? "").trim(),
    isActive: document.activeElement === heading,
    focusVisible: heading.matches(":focus-visible"),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    backdrop: `rgb(${backdrop.join(", ")})`,
    ratio: Math.round(ratio * 100) / 100,
  };
};

/**
 * The heading is focused by the shell, not by the player, and the measured matrix
 * is the whole point of this test:
 *
 *   path             :focus-visible  outline before            contrast before
 *   mount            true            1px rgba(255,255,255,.15)       1.48:1
 *   pointer switch   false           none - no indicator at all           -
 *   keyboard switch  true            1px rgba(255,255,255,.15)       1.48:1
 *
 * So `--border-strong` was under the 3:1 floor a focus indicator needs on the two
 * paths that drew it, and the pointer path drew nothing at all. One
 * `:focus-visible` selector cannot separate "a surface entered with the keyboard"
 * from "a page that has had no input yet" - Chromium matches it for both - so the
 * heading cannot wear the product's gold ring on the keyboard path alone without
 * wearing it for the whole pre-interaction life of the surface. It keeps one
 * quiet, colourless indicator on every path instead, at a contrast that clears
 * 3:1; the distinction that survives is the one the lane drew (a grey hairline on
 * the heading, the product's ring on the controls).
 *
 * The assertions, and the failure each one catches:
 *  - the heading takes focus on all three paths: catches a surface that moved
 *    focus somewhere else entirely;
 *  - the indicator is drawn, is a 1 px hairline and is not the accent on all
 *    three: catches the saturated 2px badge border coming back, and catches the
 *    pointer path being left with no indicator;
 *  - every drawn hairline measures 3:1 or better against the tone behind it:
 *    catches the 1.48:1 `--border-strong` hairline, which is what the audit
 *    measured as 1.3:1;
 *  - a control reached with the keyboard still paints the product's own ring:
 *    catches a quiet heading indicator that quietly replaced the real focus ring
 *    everywhere.
 */
test("defect 3: the surface heading's focus indicator is a colourless hairline that clears 3:1 on every path", async ({ page }) => {
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
    expect(reading.outlineStyle, `scripted focus still shows an indicator (${geometry})`).not.toBe("none");
    expect(reading.outlineWidth, `the indicator is a hairline, not a 2px badge border (${geometry})`).toBe("1px");
    expect(
      reading.outlineColor,
      `the ${path} focus ring is ${reading.outlineColor}, the saturated accent; it must be a low-contrast hairline (${geometry})`,
    ).not.toBe("rgb(200, 120, 125)");
    expect(
      reading.ratio,
      `the ${path} focus hairline measures ${reading.ratio}:1 on ${reading.backdrop}; a focus indicator needs 3:1 (${geometry})`,
    ).toBeGreaterThanOrEqual(3);
  }

  // The keyboard floor: a control reached with the keyboard still paints the
  // product's own focus ring, so the quiet heading did not delete focus
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
  expect(measured.stack.appBarBrand?.text, "the app bar keeps the product mark").toBe("GameBuddy 酒馆");
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
 * The Host publishes the swipe position in the standard SillyTavern / Pi
 * spelling, `◀ 1/3 ▶` (`formatSwipeLabel`, `host/src/tavern/message-tree.ts:94-98`;
 * the swipe route writes the same shape inline at
 * `host/src/tavern/chat-pipeline-service.ts:471-479`), and `MessageBubble`
 * printed that string verbatim between its own `ChevronLeft` / `ChevronRight`
 * buttons - so a message that has more than one swipe read as arrows inside
 * arrows. The pinned screenshot run (`shots-final10`) never showed it because no
 * message in that transcript carried more than one swipe, so the route's own
 * shape is what this journey serves.
 *
 * The assertions, and the failure each one catches:
 *  - the indicator is the Host's position alone: catches the label's `◀`/`▶`
 *    decoration printed beside the real pair;
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
