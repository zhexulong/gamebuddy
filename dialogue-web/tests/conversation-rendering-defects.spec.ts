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
 *   3. The surface heading's scripted focus was painted in the saturated accent,
 *      so every static one-word heading read as an unclicked pink badge.
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

type Message = Readonly<{ role: "player" | "companion"; text: string; opening?: boolean }>;

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

test("defect 3: the surface heading's scripted focus is a colourless hairline, not the accent badge", async ({ page }) => {
  await mountShell(page);

  const focused = await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>(".surface-header h2")!;
    const style = getComputedStyle(heading);
    return {
      text: (heading.textContent ?? "").trim(),
      isActive: document.activeElement === heading,
      focusVisible: heading.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      borderRadius: style.borderRadius,
    };
  });
  console.log(`[defect-3] mount: ${JSON.stringify(focused)}`);

  expect(focused.isActive, "the heading takes focus on mount").toBe(true);
  expect(focused.outlineStyle, "scripted focus still shows an indicator").not.toBe("none");
  expect(focused.outlineWidth, "the indicator is a hairline, not a 2px badge border").toBe("1px");
  expect(
    focused.outlineColor,
    `the scripted focus ring is ${focused.outlineColor}, the saturated accent; it must be a low-contrast hairline`,
  ).not.toBe("rgb(200, 120, 125)");

  // The keyboard floor: a control reached with the keyboard still paints the
  // product's own focus ring, so the low-contrast heading did not delete focus
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
  // The card's record is read after the first paint; wait for the chips to land
  // (or for the read to prove it offers none) before the screen is measured.
  await page
    .locator(".composer-chips-row")
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);

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
      chips: document.querySelectorAll(".composer-chip").length,
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
  // The void is guided: the card's own openings reach the first screen, and the
  // zero state still fills the transcript.
  expect(measured.chips, "a chip per opening the card carries").toBe(OPENINGS.length);
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
