import { expect, test, type Page } from "./frontend-coverage";

/**
 * A message's bubble is as wide as its own text, and wraps only when the column is narrower.
 *
 * Measured defect (400x800, the Chinese catalogue): the player's own line was `width: fit-content`
 * on a flex item (`style.css`, `.message.player .message-bubble`), and in a column the fit-content
 * formula starts from the item's MIN-content contribution. The sheet sets `overflow-wrap: anywhere`
 * on every bubble - it is what keeps an unbroken URL from pushing the transcript sideways - and with
 * `anywhere` the min-content of a CJK run is ONE glyph, so a two-character line was laid out as a
 * one-glyph-wide column: 你 above 好, in a 58 px bubble.
 *
 * The existing journey that watches this row (`conversation-rendering-defects.spec.ts`, defect 6)
 * asserts the bubble is NARROWER than the long line and narrower than its body - both of which a
 * collapsed bubble satisfies, because a bubble one glyph wide is narrower than everything. The
 * defect lived inside the boundary of an assertion that only compared two boxes to each other.
 *
 * So the reading here is absolute, and it is taken from the browser's own layout of the same text:
 *
 *  - `oneLine` is the message's text laid out on ONE line at the bubble's own font, measured through
 *    a probe element rather than a second hand-written character width;
 *  - the bubble's content box must be at least `min(oneLine, column)` - the only honest reason for a
 *    line to break is that the column is narrower than the line;
 *  - a short line must occupy exactly one line box, which is the shape the defect destroyed;
 *  - a long line must stay inside its column and scroll neither itself nor the page sideways.
 *
 * The em floor is the arithmetic of the short line, not a round number: two glyphs at 14 px are 28 px
 * and the bubble's own horizontal padding is 14 + 14 px, so "你好" needs 4 em of bubble. A
 * one-glyph-wide column measures about 3 em - below the floor - and a real two-glyph bubble measures
 * about 4.1 em.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const projectionRevision = "P".repeat(42) + "A";
const playerHandle = "X".repeat(42) + "A";
const companionHandle = "W".repeat(42) + "A";

const SHORT = "你好";
const LONG_UNIT = "今天棚子里的番茄全红了，我摘了一整篮，等会儿带去镇上卖掉，顺便把去年冬天欠的账还了。";
const LONG = LONG_UNIT.repeat(10).slice(0, 400);

function composedRoot() {
  const transcript = [
    { role: "companion", text: "门廊上的那盏灯还亮着。" },
    { role: "player", text: SHORT },
    { role: "companion", text: "早上的光从山脊上过来。" },
    { role: "player", text: LONG },
  ];
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
        companion: { name: "Mira", handle: companionHandle },
        title: null,
        transcript: transcript.map((message, index) => ({
          handle: (message.role === "player" ? playerHandle : companionHandle) + String(index),
          role: message.role,
          text: message.text,
          locale: "und",
          order: index,
          revision: 1,
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

async function mountShell(page: Page): Promise<void> {
  const root = composedRoot();
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
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/u, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: [], chapters: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: companionHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(jsonOk({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale: "zh-CN" })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
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
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

test("a short CJK line is as wide as its words, and a long one wraps inside the column", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mountShell(page);

  const measured = await page.evaluate(() => {
    const round = (value: number) => Math.round(value);
    const read = (row: HTMLElement) => {
      const bubble = row.querySelector<HTMLElement>(".message-bubble")!;
      const body = row.querySelector<HTMLElement>(".message-body")!;
      const bubbleRect = bubble.getBoundingClientRect();
      const style = getComputedStyle(bubble);
      const horizontal = (prefix: "padding" | "border") =>
        Number.parseFloat(style[`${prefix}Left` as "paddingLeft"]) + Number.parseFloat(style[`${prefix}Right` as "paddingRight"]);
      // One line of THIS text in THIS font: the browser's own layout of the same string with wrapping
      // taken out of the question. A hand-computed glyph width would be a second opinion, not the fact.
      const probe = document.createElement("span");
      probe.style.cssText = "position: absolute; visibility: hidden; white-space: pre; left: -10000px; top: 0";
      probe.style.font = style.font;
      probe.style.letterSpacing = style.letterSpacing;
      probe.textContent = (bubble.textContent ?? "").trim();
      document.body.append(probe);
      const oneLine = probe.getBoundingClientRect().width;
      probe.remove();
      // How many line boxes the words actually occupy: one rect per line box of the rendered text.
      const lineTops = new Set<number>();
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim() === "") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) lineTops.add(Math.round(rect.top));
      }
      return {
        textLength: (bubble.textContent ?? "").trim().length,
        fontSize: Number.parseFloat(style.fontSize),
        width: round(bubbleRect.width),
        height: round(bubbleRect.height),
        // The box the words are laid out in, the widest box the row could give them, and the column
        // itself - which the bubble may not exceed, whatever its text asks for.
        contentWidth: bubble.clientWidth - horizontal("padding"),
        available: body.clientWidth - horizontal("padding") - horizontal("border"),
        column: body.clientWidth,
        scrollWidth: bubble.scrollWidth,
        padding: horizontal("padding"),
        right: round(bubbleRect.right),
        oneLine: round(oneLine),
        lines: lineTops.size,
      };
    };
    const rows = [...document.querySelectorAll<HTMLElement>("ol.message-list > li.message.player")];
    return {
      short: read(rows[0]!),
      long: read(rows[1]!),
      listWidth: round(document.querySelector<HTMLElement>("ol.message-list")!.getBoundingClientRect().width),
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  console.log(`[bubble-width 400x800] ${JSON.stringify(measured)}`);

  const { short, long } = measured;

  // A two-character line is one line: the defect laid 你 above 好.
  expect(short.lines, `"你好" occupies one line box (measured ${short.lines})`).toBe(1);
  // The only honest reason for a line to break is a column narrower than the line.
  expect(
    short.contentWidth,
    `the bubble's content box holds one line of its own text (${short.contentWidth} px for ${short.oneLine} px of text)`,
  ).toBeGreaterThanOrEqual(Math.min(short.oneLine, short.available) - 1);
  // The em floor is the short line's own arithmetic: two glyphs at 14 px are 28 px, and the bubble's
  // own horizontal padding is 14 + 14 px - so "你好" needs 4 em of bubble, and a one-glyph column
  // measures about 3 em.
  expect(
    short.width,
    `"你好" needs 4 em of bubble (measured ${short.width} px against ${short.fontSize} px type)`,
  ).toBeGreaterThanOrEqual(4 * short.fontSize);

  // A 400-character line still wraps INSIDE the column, and neither the bubble nor the page scrolls.
  expect(long.textLength, "the long fixture is the 400 characters this case is about").toBe(400);
  expect(
    long.width,
    `the long line does not widen its own box past the column it is given (${long.width} > ${long.column})`,
  ).toBeLessThanOrEqual(long.column);
  expect(long.lines, `the long line wraps (measured ${long.lines} line boxes)`).toBeGreaterThan(1);
  expect(long.contentWidth, "and it keeps the whole column it is given").toBeGreaterThanOrEqual(
    Math.min(long.oneLine, long.available) - 1,
  );
  expect(
    long.scrollWidth,
    `and it does not scroll sideways inside itself (${long.scrollWidth} > ${long.contentWidth + long.padding})`,
  ).toBeLessThanOrEqual(long.contentWidth + long.padding + 1);
  expect(long.right, "its right edge stays inside the transcript").toBeLessThanOrEqual(measured.listWidth);
  expect(measured.pageWidth, "and the page itself has no horizontal overflow").toBeLessThanOrEqual(400);
});
