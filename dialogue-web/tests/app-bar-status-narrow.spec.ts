import { type Page, expect, test } from "./frontend-coverage";

/**
 * U-02: the app-bar status stays a named badge on the companion, not a dot
 * floating in the bar.
 *
 * The measured defect at 400px: the status word was retired with
 * `clip-path: inset(50%)` so the companion's name could keep its width, which
 * left the dot alone beside the monogram. A dot on its own is not a status a
 * player can read.
 *
 * The assertions, and the failure each one catches:
 *  - the status badge overlaps the monogram: catches a badge that drifted back
 *    into the bar as a stray dot;
 *  - the badge is out of the row's flow (`position: absolute`) and the companion
 *    name is not truncated (`scrollWidth <= clientWidth`): catches a fix that
 *    bought the badge its space back out of the name;
 *  - the badge carries the status word as its accessible name: catches a state
 *    that is carried by colour alone;
 *  - no element in the bar overflows its own box: catches the retired status word
 *    coming back as a 1px box whose text still lays out 24px (`overBy 23`) - a
 *    clipped sliver that is neither readable nor gone.
 *
 * The mount is a conversation with an active connection, because the badge this file
 * measures is the dot: the dot is a claim about whether this conversation can send, so a
 * mount whose model route never answered draws no dot at all and there would be nothing on
 * the monogram to place (`app-bar-status-claims-a-fact.spec.ts` pins that reading, and the
 * two settings reads below are what make this one a real connectable conversation).
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

/**
 * The composed root this file mounts, with the companion's name as the one parameter.
 *
 * The name is a parameter because the bar's budget is a fact about the NAME's width: a two-character
 * name fits a bar where a real one is truncated, so the width sweep below picks a name long enough
 * that "the name is whole" can fail.
 */
const composedRoot = (companionName: string) => ({
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
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    chat: {
      companion: { name: companionName, handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
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
});

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// The two projections `chat-model-route.ts` reads, so the badge has a route to claim.
const connectionId = "E".repeat(42) + "A";
const ACTIVE_CONNECTION = {
  connectionId,
  label: "DeepSeek",
  providerLabel: "DeepSeek",
  modelId: "deepseek-v4-pro",
  modelLabel: "DeepSeek V4 Pro",
  thinkingLevel: "high",
  readiness: "ready",
  baseUrl: null,
  failure: null,
  lastCheckedAtMs: null,
};

/**
 * Every route the composed shell reads to paint this bar, with the companion's name as the parameter.
 *
 * The connection and profile reads are not decoration: the badge this file measures is the status
 * DOT, which is a claim about whether this conversation can send, so a mount whose model route never
 * answered draws no dot at all.
 */
async function stubBar(page: Page, companionName: string): Promise<void> {
  const root = composedRoot(companionName);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: ACTIVE_CONNECTION,
        connections: [
          {
            connectionId,
            label: "DeepSeek",
            providerId: "deepseek",
            providerLabel: "DeepSeek",
            configured: true,
            readiness: "ready",
            active: true,
            modelId: "deepseek-v4-pro",
            modelLabel: "DeepSeek V4 Pro",
            thinkingLevel: "high",
            allowedThinkingLevels: ["high", "max"],
            modelIds: null,
            baseUrl: null,
            failure: null,
            lastCheckedAtMs: null,
          },
        ],
        providers: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
}

test("the 400px app bar names its status on the companion's monogram and keeps the name whole", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await stubBar(page, "琥珀");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const status = page.locator(".app-bar-status");
  await expect(status).toBeVisible();

  const measured = await page.evaluate(() => {
    const statusNode = document.querySelector<HTMLElement>(".app-bar-status");
    const dot = document.querySelector<HTMLElement>(".app-bar-status .status-dot");
    const avatar = document.querySelector<HTMLElement>(".app-bar-companion .avatar");
    const title = document.querySelector<HTMLElement>(".app-bar-title");
    const labelNode = document.querySelector<HTMLElement>(".app-bar-status-label");
    if (statusNode === null || dot === null || avatar === null || title === null || labelNode === null)
      throw new Error("app-bar-status-narrow: the app bar is not rendered");
    const box = (element: Element) => element.getBoundingClientRect();
    const dotBox = box(dot);
    const avatarBox = box(avatar);
    const appBar = document.querySelector(".app-bar");
    // Every element the bar lays out, not only the word: one element whose
    // scrollWidth beats its clientWidth is content a viewer sees cut off, and
    // `scrollWidth` is what the viewport gates measure.
    const appBarOverflowers =
      appBar === null
        ? []
        : [...appBar.querySelectorAll("*")]
            .map((node) => {
              const element = node as HTMLElement & { scrollWidth?: number; clientWidth?: number };
              const cls =
                typeof element.className === "string"
                  ? element.className
                  : (element.getAttribute("class") ?? "");
              return {
                tag: element.tagName.toLowerCase(),
                cls,
                overBy: (element.scrollWidth ?? 0) - (element.clientWidth ?? 0),
              };
            })
            .filter((entry) => entry.overBy > 0);
    return {
      labelInDom: (labelNode.textContent ?? "").trim(),
      labelDisplay: getComputedStyle(labelNode).display,
      labelBox: { width: Math.round(box(labelNode).width), height: Math.round(box(labelNode).height) },
      appBarOverflowers,
      titleInDom: (title.textContent ?? "").trim(),
      statusPosition: getComputedStyle(statusNode).position,
      titleOverflow: title.scrollWidth - title.clientWidth,
      titleWidth: Math.round(box(title).width),
      dotInsideAvatar:
        dotBox.left >= avatarBox.left - 1 &&
        dotBox.right <= avatarBox.right + 1 &&
        dotBox.top >= avatarBox.top - 1 &&
        dotBox.bottom <= avatarBox.bottom + 1,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  console.log(`[app-bar] ${JSON.stringify(measured)}`);
  // The badge is on the monogram, not floating in the bar.
  expect(measured.dotInsideAvatar, "the status dot is not on the companion's monogram").toBe(true);
  // The space it needs is not taken from the name.
  expect(measured.statusPosition, "the badge must leave the row's flow").toBe("absolute");
  expect(measured.titleOverflow, "the companion's name is truncated at 400px").toBeLessThanOrEqual(1);
  expect(measured.titleWidth, "the companion's name is not rendered at 400px").toBeGreaterThan(0);
  expect(measured.pageOverflowX, "the badge must not widen the bar").toBeLessThanOrEqual(0);
  // No element in the bar is wider than its own box. Catches the retired status
  // word coming back as the classic 1px-box recipe, whose text still laid out 24px
  // inside a 1px box and reported `scrollWidth 24 / clientWidth 1 / overBy 23`:
  // neither readable nor gone, and an overflow every viewport gate can see.
  expect(
    measured.appBarOverflowers,
    "an element in the app bar overflows its own box at 400px",
  ).toEqual([]);
  // The word is out of the flow at this width, not squeezed into a sliver: it is
  // still in the DOM (the accessible name below is read from it) and lays out no box.
  expect(measured.labelDisplay, "the status word is still laid out at 400px").toBe("none");
  expect(measured.labelBox, "the status word still occupies a box at 400px").toEqual({ width: 0, height: 0 });

  // The state is named, not merely coloured: the badge's accessible name is the
  // same word the live region carries.
  expect(measured.labelInDom.length).toBeGreaterThan(0);
  await expect(status).toHaveAccessibleName(measured.labelInDom);
  await expect(status).toHaveAttribute("aria-label", measured.labelInDom);
  await expect(status).toHaveAttribute("title", measured.labelInDom);
  expect(measured.titleInDom).toBe("琥珀");
});

/**
 * The app bar's width budget, swept: the companion's name is never truncated and the page never
 * scrolls sideways, at every width where the bar changes shape.
 *
 * WHY A SWEEP
 *
 * The bar reclaimed width at four independent thresholds - the rail folded behind `More` at 480, the
 * status word was retired at 480, the wordmark went at 640, the nav labels went at 860 - and nothing
 * measured the width where two of them disagreed. At 481 px the 6 icon-only peers took 304 px of a
 * 481 px bar (32 px padding + a 28 px mark + 6 x 44 + 5 x 8), the status word came back in the same
 * breath, and the companion block - avatar, name, badge - was left about 15 px: the name the strip
 * exists to show was a bare "(" exactly as the file's own 400 px report describes.
 *
 * So the assertion is not about any one breakpoint: at every width in the sweep the title's
 * `scrollWidth` must equal its `clientWidth` (an ellipsised name is a name the bar failed to give
 * room), and the document must not overflow. The failure names the width, because which threshold
 * disagreed is the only useful thing to know when this goes red.
 *
 * The name is deliberately long: `Amber Nightshade` is 15 characters, which is where a bar with a
 * 100 px budget for the name actually truncates. A two-character name would pass at every width and
 * the sweep would assert nothing.
 */
const SWEPT_WIDTHS = [400, 481, 560, 640, 860, 1440] as const;

test("the app bar never truncates the companion's name, nor widens the page, at any width", async ({ page }) => {
  await stubBar(page, "Amber Nightshade");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".app-bar-title")).toBeVisible();
  // The status word's own width is part of the bar's budget, so the sweep starts from the settled
  // state rather than from whatever the badge happened to say while the two settings reads were in
  // flight (`Not ready to send` is the widest thing it can say, and it is not this mount's state).
  await expect(page.locator(".app-bar-status")).toHaveAccessibleName("Online");

  const readings: {
    width: number;
    title: number;
    scrollWidth: number;
    clientWidth: number;
    overBy: number;
    pageOverflowX: number;
    peers: number;
    fold: boolean;
    statusWord: string;
    wordmark: string;
  }[] = [];

  for (const width of SWEPT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const reading = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>(".app-bar-title");
      const label = document.querySelector<HTMLElement>(".app-bar-status-label");
      const wordmark = document.querySelector<HTMLElement>(".app-bar-brand-name");
      const trigger = document.querySelector<HTMLElement>(".app-bar-more-trigger");
      if (title === null || label === null || wordmark === null) throw new Error("the app bar is not mounted");
      const laidOut = (element: HTMLElement): boolean => getComputedStyle(element).display !== "none";
      return {
        title: Math.round(title.getBoundingClientRect().width),
        bar: Math.round((document.querySelector(".app-bar") as HTMLElement).getBoundingClientRect().width),
        viewport: document.documentElement.clientWidth,
        scrollWidth: title.scrollWidth,
        clientWidth: title.clientWidth,
        overBy: title.scrollWidth - title.clientWidth,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        // Which shape the bar is in at this width: the numbers that explain a failure.
        peers: [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].filter(
          (button) => getComputedStyle(button).display !== "none" && button.offsetParent !== null,
        ).length,
        fold: trigger !== null && laidOut(trigger),
        statusWord: getComputedStyle(label).display,
        wordmark: getComputedStyle(wordmark).display,
      };
    });
    readings.push({ width, ...reading });
    console.log(`[app-bar-sweep @${width}] ${JSON.stringify(reading)}`);
  }

  for (const reading of readings) {
    const { width } = reading;
    expect(
      reading.overBy,
      `at ${width}px the companion's name is ${reading.overBy}px wider than the ${reading.clientWidth}px the bar gave it ` +
        `(peers ${reading.peers}, fold ${reading.fold}, status word ${reading.statusWord}, wordmark ${reading.wordmark})`,
    ).toBeLessThanOrEqual(1);
    expect(reading.title, `at ${width}px the companion's name is not rendered at all`).toBeGreaterThan(0);
    expect(
      reading.pageOverflowX,
      `at ${width}px the bar widens the document by ${reading.pageOverflowX}px`,
    ).toBeLessThanOrEqual(0);
  }

  // The sweep really visited both halves of the one breakpoint: a bar that never folded, or never
  // expanded, would report the same name width at every reading and prove nothing.
  expect(new Set(readings.map((reading) => reading.fold)).size, "the sweep saw both bar shapes").toBe(2);
});
