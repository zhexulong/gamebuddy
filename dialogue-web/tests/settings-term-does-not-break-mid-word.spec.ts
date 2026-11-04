import { type Page, expect, test } from "./frontend-coverage";

/**
 * A read-back term is a word, and a word does not break inside itself.
 *
 * The connection group reads a label/value pair back as
 * `.management-settings-details` - a `flex` row with `space-between`, the term
 * on the left in secondary ink and the value right-aligned on the right. Both
 * children default to `flex-shrink: 1` and to the automatic minimum size, which
 * for text is its min-content width. CJK text has a one-character min-content,
 * so the row's free space was taken out of the term as readily as out of the
 * value: measured at 400x800 with a real-shaped activated connection
 * (`openai-compatible/deepseek-v4.1-flash-2026-01-25`), the term `当前连接`
 * measured 46.02 px wide - 52 px of text shrunk by the row - and its two line
 * boxes were 39 px and 13 px: "当前连" / "接", a term broken in the middle of its
 * own word while the value beside it merely wrapped.
 *
 * The fix is on the term: `white-space: nowrap` makes its min-content its own
 * word, so the row cannot take space out of it, and the value - which carries
 * `overflow-wrap: anywhere` - is what wraps. The row also wraps, so a pair that
 * genuinely cannot share a line puts the value under the term instead of
 * overflowing the surface.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

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
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
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

const connectionId = `${"E".repeat(42)}A`;
/** The player's own name for the connection: one unbroken token, as a model id is. */
const longLabel = "openai-compatible/deepseek-v4.1-flash-2026-01-25";
const longModel = "deepseek-v4.1-flash-preview-0125";

/**
 * The activated connection both read-back rows describe. `label` is what the
 * active-connection row shows, and it is long for the same reason a real one is:
 * it names the endpoint and the model the player typed.
 */
function connectionState() {
  return {
    apiVersion: 1,
    revision: 3,
    active: {
      connectionId,
      label: longLabel,
      providerLabel: "OpenAI-compatible",
      modelId: longModel,
      modelLabel: longModel,
      thinkingLevel: "high",
      readiness: "ready",
      baseUrl: null,
      failure: null,
      lastCheckedAtMs: null,
    },
    connections: [
      {
        connectionId,
        label: longLabel,
        providerId: "openai-compatible",
        providerLabel: "OpenAI-compatible",
        configured: true,
        readiness: "ready",
        active: true,
        modelId: longModel,
        modelLabel: longModel,
        thinkingLevel: "high",
        allowedThinkingLevels: ["low", "high"],
        modelIds: null,
        baseUrl: null,
        failure: null,
        lastCheckedAtMs: null,
      },
    ],
    providers: [
      {
        providerId: "openai-compatible",
        label: "OpenAI-compatible",
        setupFields: ["apiKey", "baseUrl", "apiShape", "modelId"],
        allowedPlayerModels: [],
        escapeHatch: true,
        environmentManaged: false,
      },
    ],
  };
}

/** Every route the shell and the settings groups read, in the product's own shape. */
async function stubSettings(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "zh-CN" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({
        revision: 1,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(jsonOk({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) => route.fulfill(jsonOk(connectionState())));
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, thinkingLevel: "high" },
        game: { revision: 1, thinkingLevel: "high" },
        recommendedModels: [],
      }),
    ),
  );
}

/**
 * The pair's own geometry: how many line boxes the term's text occupies, the
 * term's used width against the width its text needs, and the same for the value
 * - plus the horizontal overflow of the page and of the surface's scroller, so a
 * term that "fits" by pushing the row sideways is not mistaken for a fix.
 */
async function measureTerm(page: Page) {
  return await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-connection-active] > div");
    const term = row?.querySelector<HTMLElement>("dt") ?? null;
    const value = row?.querySelector<HTMLElement>("dd") ?? null;
    if (row === null || term === null || value === null) return null;
    const round = (number: number) => Math.round(number * 100) / 100;
    const lineBoxes = (node: HTMLElement): number[] => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map((rect) => round(rect.width));
    };
    const scroller = document.querySelector<HTMLElement>(".surface-content");
    return {
      term: term.textContent,
      termLines: lineBoxes(term),
      termWidth: round(term.getBoundingClientRect().width),
      termScrollWidth: term.scrollWidth,
      termWhiteSpace: getComputedStyle(term).whiteSpace,
      valueLines: lineBoxes(value).length,
      rowWidth: round(row.getBoundingClientRect().width),
      pageOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
      surfaceOverflow: scroller === null ? null : scroller.scrollWidth - scroller.clientWidth,
    };
  });
}

test("item 24: a read-back term stays on one line and the value wraps instead", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await stubSettings(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  const term = surface.locator("[data-connection-active] dt");
  await expect(term).toHaveText("当前连接");

  const narrow = await measureTerm(page);
  console.log(`[item-24 term @400] ${JSON.stringify(narrow)}`);
  expect(narrow, "the activated connection's read-back row is mounted").not.toBeNull();
  expect(
    narrow!.termLines.length,
    `the term's text is one line box, not ${JSON.stringify(narrow!.termLines)}`,
  ).toBe(1);
  // …because the row may not take its width out of the term: with `nowrap` the
  // term's used width is the width its own text needs.
  expect(
    narrow!.termWidth,
    `the term keeps the width its text needs (${narrow!.termWidth} used against ${narrow!.termScrollWidth} needed)`,
  ).toBeGreaterThanOrEqual(narrow!.termScrollWidth);
  // The value is what gives way: it wraps inside its own box rather than the term
  // breaking inside a word.
  expect(narrow!.valueLines, "the long value wraps instead").toBeGreaterThan(1);
  expect(
    narrow!.pageOverflow,
    "the page does not scroll sideways to make room for the pair",
  ).toBe(0);
  expect(narrow!.surfaceOverflow, "the surface's own scroller does not scroll sideways either").toBe(0);

  // Sensitivity proof, measured through the same probe: the pre-fix rule. An
  // unlayered declaration wins over the layered stylesheet, so the term is shrunk
  // by the row again and the same reading reports the broken word.
  const preFix = await page.addStyleTag({ content: ".management-settings-details dt { white-space: normal; }" });
  const squeezed = await measureTerm(page);
  console.log(`[item-24 term @400, pre-fix rule injected] ${JSON.stringify(squeezed)}`);
  await preFix.evaluate((node) => node.remove());
  expect(
    squeezed!.termLines.length,
    `without the rule the row shrinks the term into ${JSON.stringify(squeezed!.termLines)}`,
  ).toBeGreaterThan(1);
  expect(
    squeezed!.termWidth,
    `…and the row then takes the term below the width its word needs (${squeezed!.termWidth} used against ${narrow!.termWidth} for the same word) `,
  ).toBeLessThan(narrow!.termWidth);

  // The wide surface reads the same pair on one line each, so the fix is not a
  // narrow-surface special case that costs the desktop its read-back.
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await measureTerm(page);
  console.log(`[item-24 term @1440] ${JSON.stringify(wide)}`);
  expect(wide!.termLines.length, "at 1440 the term is one line box too").toBe(1);
  expect(wide!.valueLines, "at 1440 the value fits on one line").toBe(1);
  expect(wide!.termWidth, "at 1440 the term is its own text's width").toBeGreaterThanOrEqual(wide!.termScrollWidth);
  expect(wide!.pageOverflow, "at 1440 the pair still does not push the page sideways").toBe(0);
});
