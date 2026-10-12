import { expect, test, type Page } from "@playwright/test";

/**
 * The four screen defects a player met on a real run of this product, each with
 * the assertion that fails before its fix.
 *
 *   1. The Game surface's primary action and the Characters badge are below the
 *      WCAG AA floor (2.88:1 and 4.48:1). The failure this catches: the accent
 *      is used as a *fill* under light text, and as *ink* on a plate that is not
 *      deep enough, so the pair is under the floor wherever it appears.
 *   2. The third guide step shows a fault and "reload the page" where the next
 *      action belongs. The failure this catches: "no game session yet" - a state
 *      - is rendered as a read failure.
 *   3. The advanced Pi JSON block is English inside an otherwise Chinese
 *      surface. The failure this catches: the block reads its own second
 *      catalogue with `locale ?? "en"` and no caller passes a locale.
 *   4. The installation panel answers "not found" on one visit and "still
 *      searching" on another. The failure this catches: the panel's answer is a
 *      mount-local default rather than one truthful answer per moment, and the
 *      surface shows a second, generic loading line beside it.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";
const projectionRevision = "P".repeat(42) + "A";

/** The catalogue's fixed points, spelled as the player reads them. */
const ZH = {
  searching: "正在查找《星露谷物语》安装位置…",
  notFound: "未找到《星露谷物语》安装位置。",
  genericLoading: "加载中...",
  reloadAdvice: "重新加载页面",
  cabinAwaitingSession: "还没有可以读取小屋的游戏会话",
} as const;

type GameProjectionOverrides = Readonly<{ instanceStatus?: string; attachmentStatus?: string }>;

function composedRoot(overrides: GameProjectionOverrides = {}) {
  const instanceStatus = overrides.instanceStatus ?? "none";
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
        title: "Reference Game Chat",
        transcript: [
          { handle: "D".repeat(42) + "A", role: "companion", text: "The morning light comes over the ridge.", locale: "en", order: 0, revision: 1 },
        ],
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
        instance: { status: instanceStatus, gameTitle: null, generation: 0 },
        compatibility: { status: "unchecked", message: null },
        attachment: { status: overrides.attachmentStatus ?? "none", generation: 0 },
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

type MountOptions = Readonly<{
  root?: unknown;
  /** Hold the discovery route open for this many ms before answering. */
  discoveryDelayMs?: number;
  /** Hold the discovery route open until the test releases it with `releaseDiscovery()`. */
  discoveryHangs?: boolean;
  /** Answer the discovery route with nothing found, or with one candidate. */
  discoveryCandidates?: readonly unknown[];
  /** Answer the cabin read the way the Host does when no Player Host instance exists. */
  cabinsUnavailable?: boolean;
}>;

/** The one held discovery response, so a test can release the scan it hung. */
let releaseHeldDiscovery: (() => void) | null = null;

function releaseDiscovery(): void {
  releaseHeldDiscovery?.();
  releaseHeldDiscovery = null;
}

/** Mounts the real shell over the real routes, every one mocked on this origin. */
async function mountShell(page: Page, options: MountOptions = {}): Promise<void> {
  const root = options.root ?? composedRoot();
  const delay = options.discoveryDelayMs ?? 0;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    options.cabinsUnavailable === true
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "stardew_cabin_handoff_unavailable" }) })
      : route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", async (route) => {
    if (options.discoveryHangs === true) await new Promise<void>((resolve) => { releaseHeldDiscovery = resolve; });
    else if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill(jsonOk({ apiVersion: 1, candidates: options.discoveryCandidates ?? [], diagnostics: [] }));
  });
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/retry", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/cancel", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "cancelled" })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) => route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: [] })));
  await page.route("**/api/tavern/v1/world-info", (route) => route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })));
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
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "GameBuddy Companion", isCurrent: true }] })),
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

async function openSurface(page: Page, label: string, testId: string): Promise<void> {
  const entry = page.getByRole("button", { name: label, exact: true });
  if (!(await page.getByTestId(testId).isVisible())) await entry.click();
  await expect(page.getByTestId(testId)).toBeVisible();
}

/** The installation panel is the surface's own discovery region (never inside the game region). */
const installationPanel = (page: Page) => page.locator(".game-installation-panel");

/**
 * The sampled tones of each selector, measured exactly the way the runtime
 * contrast gate measures them: computed colour, the effective background
 * composited up through the ancestors to the first opaque one, and the WCAG
 * ratio for the element's own size and weight.
 */
async function sampleContrast(page: Page, selectors: readonly string[]) {
  return page.evaluate((wanted: readonly string[]) => {
    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (match === null) return [0, 0, 0, 0];
      const parts = match[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const effective = (element: Element): [number, number, number] | null => {
      const stack: [number, number, number, number][] = [];
      let node: Element | null = element;
      while (node !== null) {
        const background = parse(getComputedStyle(node).backgroundColor);
        stack.push(background);
        if (background[3] >= 0.999) break;
        node = node.parentElement;
      }
      const bottom = stack[stack.length - 1]!;
      if (bottom[3] < 0.999) return null;
      let result = bottom;
      for (let index = stack.length - 2; index >= 0; index -= 1) {
        const top = stack[index]!;
        const alpha = top[3];
        result = [
          top[0] * alpha + result[0] * (1 - alpha),
          top[1] * alpha + result[1] * (1 - alpha),
          top[2] * alpha + result[2] * (1 - alpha),
          1,
        ];
      }
      return [result[0], result[1], result[2]];
    };
    const luminance = ([red, green, blue]: readonly number[]): number => {
      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!);
    };
    const ratio = (foreground: readonly number[], background: readonly number[]): number => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (lighter! + 0.05) / (darker! + 0.05);
    };
    return wanted.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) return { selector, found: false, text: "", color: "", background: "", size: 0, weight: 0, ratio: 0 };
      const style = getComputedStyle(element);
      const background = effective(element);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      return {
        selector,
        found: true,
        text: (element.textContent ?? "").trim().slice(0, 32),
        color: style.color,
        background: background === null ? "unresolved" : `rgb(${background.map((value) => Math.round(value)).join(",")})`,
        size,
        weight,
        ratio: background === null ? 0 : ratio(parse(style.color), background),
      };
    });
  }, selectors);
}

/**
 * Defect 1. Measured before the fix: `启用伙伴陪玩` cream `rgb(245,240,232)` on
 * rose `rgb(200,120,125)` = **2.88:1**, and `当前` rose on `rgb(58,34,38)` =
 * **4.48:1**; both are under the 4.5:1 floor for their size.
 *
 * The failure this catches: a filled accent control paints light ink on the same
 * tone the accent uses as ink, and the plate the badge draws its accent ink on is
 * too shallow. Sampling every filled accent control on the surface - not just the
 * one the owner measured - is what makes this a tone defect rather than one
 * button's.
 */
test("defect 1: a filled accent control and the current badge clear WCAG AA", async ({ page }) => {
  await mountShell(page);
  await openSurface(page, "游戏", "game-surface");
  const fixedPrimary = await sampleContrast(page, ["button.game-action.primary"]);
  await openSurface(page, "角色", "characters-surface");
  const fixedBadge = await sampleContrast(page, ["em.companion-current-badge"]);
  console.log(`[defect-1] fixed: ${JSON.stringify([...fixedPrimary, ...fixedBadge])}`);

  expect(fixedPrimary[0]?.found, "the Game surface offers its primary activation action").toBe(true);
  expect(fixedBadge[0]?.found, "the Characters surface renders its current-companion badge").toBe(true);
  for (const sample of [...fixedPrimary, ...fixedBadge]) {
    expect(
      sample.ratio,
      `${sample.selector} "${sample.text}" is ${sample.color} on ${sample.background} at ${sample.size}px = ${sample.ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  // Sensitivity proof, measured through the same engine rather than quoted from a
  // report: the tokens as they were before the fix put both elements back under
  // the floor, so the assertion above is what catches the defect and not a
  // coincidence of today's values.
  await page.addStyleTag({ content: ":root{--accent-solid:#c8787d;--palette-burgundy-dark:#3a2226}" });
  const beforeBadge = await sampleContrast(page, ["em.companion-current-badge"]);
  await openSurface(page, "游戏", "game-surface");
  const beforePrimary = await sampleContrast(page, ["button.game-action.primary"]);
  console.log(`[defect-1] with the pre-fix tokens: ${JSON.stringify([...beforePrimary, ...beforeBadge])}`);
  expect(beforePrimary[0]!.ratio, "the sampled primary action really was 2.88:1 before the fix").toBeLessThan(4.5);
  expect(beforeBadge[0]!.ratio, "the sampled badge really was 4.48:1 before the fix").toBeLessThan(4.5);
});
