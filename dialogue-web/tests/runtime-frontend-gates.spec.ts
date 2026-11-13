/**
 * Runtime front-end quality gates.
 *
 * The static gates (`*.test.mjs`) read source. These read the *mounted shell*:
 * the real `ComposedReferenceGameApp` with every route mocked, measured through
 * the browser's own layout and style engines. Each gate below is a defect class
 * the owner found by looking at the product, or a floor a good front end holds
 * for free:
 *
 *   1. Viewport integrity - the shell is anchored to the window at seven sizes
 *      on every surface, in both axes. The owner's report was "sometimes only
 *      half the screen loads, sometimes it loads bigger than the browser".
 *   2. Long unbroken content - a 300-character token in the transcript and a
 *      250-character (the wire's own maximum) companion name must not push the
 *      page; the element that carries them wraps or truncates.
 *   3. Contrast - the dark theme's primary, secondary and muted tones are
 *      sampled as computed colour over the effective background they are drawn
 *      on and held to WCAG AA. A dark theme gets this wrong silently.
 *   4. The keyboard path end to end - Tab reaches every AppBar entry in order
 *      and by name, Enter opens a surface and lands on its heading, Escape
 *      returns to the conversation, and the composer is usable with no pointer.
 *   5. A quiet walk - no console error/warning, no uncaught page error and no
 *      non-2xx `/api/` response while every surface opens. This is the gate that
 *      would have caught the blank problem view the owner hit twice.
 *   6. Empty and loading states are distinguishable from a blank region, and the
 *      shell's loading state names what it is loading.
 *  10. The live caret and the reduced-motion escape, both read as computed values:
 *      the caret's own rect inside its bubble, and the pulse and the skip link
 *      under `prefers-reduced-motion: reduce`.
 *
 * The two contracts this file once pinned as `test.fixme` are met: `Escape`
 * returns focus to the conversation's composer, and a 250-character companion
 * name wraps in the transcript's author line. Both gates run as normal tests.
 * The composer landing place is pinned twice - from Escape and from an AppBar
 * press - because the two are different commits and only the second one unmounts
 * the conversation that has to name where focus goes.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "./frontend-coverage";

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";
const projectionRevision = "P".repeat(42) + "A";

/** The seven sizes the owner's report names: desktop, laptop, the 816px strip, and the phone strips. */
const VIEWPORTS: readonly Readonly<{ width: number; height: number }>[] = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 900, height: 700 },
  { width: 816, height: 767 },
  { width: 480, height: 900 },
  { width: 400, height: 800 },
];

/** The shell's peer surfaces, in AppBar order. */
const SURFACES: readonly Readonly<{ label: string; testId: string }>[] = [
  { label: "Chat", testId: "chat-surface" },
  { label: "Game", testId: "game-surface" },
  { label: "Chats", testId: "chats-surface" },
  { label: "Characters", testId: "characters-surface" },
  { label: "Settings", testId: "settings-surface" },
  { label: "Memory", testId: "memory-surface" },
];

/** A long token, and the longest name the wire's 256-unit bound admits. */
const LONG_URL = `https://example.invalid/${"p".repeat(272)}`;
const LONG_NAME = "N".repeat(250);

const DEFAULT_TRANSCRIPT: readonly Readonly<{ role: "player" | "companion"; text: string }>[] = [
  { role: "companion", text: "The morning light comes over the ridge. Where should we go next?" },
  { role: "player", text: "Let's check the crops and then walk into town." },
  { role: "companion", text: "I'll bring the watering can. The season is turning, so the north field wants attention." },
  { role: "player", text: "Then the general store - I promised to drop off something for Pierre." },
];

/** The one operation the reference profile declares and the composer gates on. */
const submitOperation = {
  operationId: "chat.submit",
  labelKey: "tavern.operation.submit",
  availability: "available",
  routeId: "chat.submit",
};

type FixtureOptions = Readonly<{
  transcript?: readonly Readonly<{ role: "player" | "companion"; text: string }>[];
  companionName?: string;
  /** `null` is a chat the Host has published no title for at all. */
  title?: string | null;
  /** Marks the transcript's last companion message as the committed variant of a swipe set. */
  swipe?: boolean;
  /** Marks message zero as a greeting set's committed variant, still open for choice. */
  opening?: boolean;
  /**
   * The settled turn the surface reports, when a gate needs the notice line a terminal
   * turn earns. `cancelled` is the one state whose sentence is a fixed string rather than
   * a provider's own words, so a gate can read it without depending on a failure cause;
   * `failed` is the Host's own refusal, worded from the class it named.
   *
   * `truncated` is the other fact a settled turn carries: the generation stopped at the
   * model's ceiling, so the reply on screen is a prefix. The surface says that on the row
   * it describes, beside the Host's sentence about the turn - two different problems that
   * a reader must not have to read twice to tell apart.
   */
  turn?: Readonly<{
    handle: string;
    state: "cancelled" | "failed";
    projectionRevision: number;
    canCancel: boolean;
    providerFailure?: "endpoint_unreachable";
    truncated?: true;
  }>;
}>;

function handleFor(index: number): string {
  return `M${String(index).padStart(2, "0")}${"A".repeat(40)}`.slice(0, 42);
}

function composedRoot(options: FixtureOptions = {}) {
  const transcript = options.transcript ?? DEFAULT_TRANSCRIPT;
  // The row a regeneration sits on: the transcript's own last companion reply.
  const lastCompanionIndex = transcript.reduce(
    (last, message, index) => (message.role === "companion" ? index : last),
    -1,
  );
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
      operations: [submitOperation],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: options.companionName ?? "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
        title: options.title === undefined ? "Gate Chat" : options.title,
        transcript: transcript.map((message, index) => ({
          handle: handleFor(index),
          role: message.role,
          text: message.text,
          // The Host's only language fact: no facade infers a per-message
          // language (ChatThreadStore keeps none), so every projected message is
          // `und`. A concrete locale here would paint `lang` on the bubble and
          // move the text out of the document's own `:lang()` rules.
          locale: "und",
          order: index,
          revision: 1,
          ...(options.swipe === true && index === lastCompanionIndex
            ? { swipeInfo: { currentIndex: 1, totalSwipes: 2, label: "1/2", hasPrevious: true, hasNext: true } }
            : {}),
          ...(options.opening === true && index === 0 && message.role === "companion"
            ? { openingVariant: { variantId: "V".repeat(42) + "A", index: 0, count: 2, label: "Default", locked: false } }
            : {}),
        })),
        draft: { revision: 0, present: false },
        turn: options.turn ?? null,
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

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** Route keys a gate can hold open to observe a loading affordance. */
type SlowRoute = "bootstrap" | "chats" | "memory" | "discovery";

type MountOptions = Readonly<{
  root?: unknown;
  slow?: Partial<Record<SlowRoute, number>>;
  /** False to observe the shell's own loading state instead of waiting it out. */
  waitForChat?: boolean;
}>;

/**
 * Mounts the real shell over the real routes, every one mocked on this origin.
 * The mocked set is the union of what every surface reads, so a surface that
 * starts asking for something new shows up in gate 5 rather than as a mystery
 * failure somewhere else.
 */
async function mountShell(page: Page, options: MountOptions = {}): Promise<void> {
  const root = options.root ?? composedRoot();
  const slow = options.slow ?? {};
  const delayed = (ms: number | undefined, body: unknown) => async (route: import("@playwright/test").Route) => {
    if (ms !== undefined) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fulfill(jsonOk(body));
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", delayed(slow.bootstrap, root));
  await page.route("**/api/composed-reference-game/v1/state", delayed(undefined, root));
  await page.route("**/api/tavern/v1/draft", delayed(undefined, { apiVersion: 1, revision: 0, text: null }));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", delayed(undefined, { apiVersion: 1, choices: [] }));
  await page.route(
    "**/api/composed-reference-game/v1/game/installation/discovery",
    delayed(slow.discovery, { apiVersion: 1, candidates: [], diagnostics: [] }),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, delayed(slow.chats, { apiVersion: 1, chats: [] }));
  await page.route(
    "**/api/tavern/v1/memory",
    delayed(slow.memory, { apiVersion: 1, projectionRevision, memories: [], chapters: [] }),
  );
  await page.route("**/api/tavern/v1/world-info", delayed(undefined, { state: "none", revision: worldBookRevision, items: [] }));
  await page.route(
    "**/api/tavern/v1/settings/voice-preference",
    delayed(undefined, { revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", delayed(undefined, { devices: [], defaultSelectable: true }));
  await page.route("**/api/tavern/v1/settings/language", delayed(undefined, { revision: 1, locale: "en-US" }));
  await page.route(
    "**/api/tavern/v1/settings/connection",
    delayed(undefined, { apiVersion: 1, revision: 1, active: null, connections: [], providers: [] }),
  );
  await page.route(
    "**/api/tavern/v1/settings/profiles",
    delayed(undefined, {
      apiVersion: 1,
      chat: { revision: 1, thinkingLevel: "medium" },
      game: { revision: 1, thinkingLevel: "medium" },
      recommendedModels: [],
    }),
  );
  await page.route("**/api/tavern/v1/companions", delayed(undefined, { apiVersion: 1, companions: [{ handle: handleFor(0), name: "Mira", isCurrent: true }] }));
  await page.route(
    "**/api/tavern/v1/persona",
    delayed(undefined, { apiVersion: 1, present: false, revision: null, name: null, description: null }),
  );
  await page.route(
    "**/api/tavern/v1/scenario",
    delayed(undefined, { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null }),
  );
  await page.route(
    "**/api/tavern/v1/greeting",
    delayed(undefined, { apiVersion: 1, present: false, revision: null, label: null, variants: [] }),
  );
  await page.route("**/api/tavern/v1/import-history", delayed(undefined, { apiVersion: 1, entries: [] }));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  if (options.waitForChat !== false) await expect(page.getByTestId("chat-surface")).toBeVisible();
}

/**
 * Reaches a surface's entry the way a player does. On a ≤480 px window the bar
 * folds its trailing peers behind one `More` disclosure (AppBar's `fold`), so a
 * narrow window opens that first; the entry itself is the same control, with the
 * same name and the same target, either way. A wide bar has no trigger to open.
 */
async function revealSurfaceEntry(page: Page, label: string) {
  const entry = page.getByRole("button", { name: label, exact: true });
  if (!(await entry.isVisible())) {
    const more = page.getByRole("button", { name: "More", exact: true });
    if (await more.isVisible()) await more.click();
  }
  return entry;
}

async function openSurface(page: Page, surface: Readonly<{ label: string; testId: string }>): Promise<void> {
  await (await revealSurfaceEntry(page, surface.label)).click();
  await expect(page.getByTestId(surface.testId)).toBeVisible();
}

function record(name: string, value: string): void {
  test.info().annotations.push({ type: name, description: value });
  console.log(`[runtime-gate] ${name}: ${value}`);
}

/**
 * Puts the browser's sequential focus starting point back at the top of the
 * document. Without it, Tab continues from wherever the app left focus - the
 * shell moves focus to the surface heading on mount - and the walk would not be
 * "from the top". No pointer event is involved.
 */
async function resetFocusToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });
}

type Box = Readonly<{ top: number; left: number; right: number; bottom: number; width: number; height: number }>;

type ViewportMeasurement = Readonly<{
  innerWidth: number;
  innerHeight: number;
  documentScrollWidth: number;
  documentScrollHeight: number;
  bodyScrollWidth: number;
  bodyScrollHeight: number;
  shell: Box | null;
}>;

/** Runs in the page: the two document scrollers and the shell's own box, in one pass. */
function measureViewport(): ViewportMeasurement {
  const box = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const shell = document.querySelector<HTMLElement>(".tavern-app-shell");
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
    shell: shell === null ? null : box(shell),
  };
}

/** One honest sentence per broken invariant: a failure names the size, the surface and the number. */
function viewportFailures(at: string, measured: ViewportMeasurement): string[] {
  const failures: string[] = [];
  const tolerance = 1;
  if (measured.shell === null) {
    failures.push(`${at}: the shell is not rendered`);
    return failures;
  }
  if (measured.documentScrollWidth > measured.innerWidth + tolerance)
    failures.push(`${at}: the page scrolls sideways (documentElement.scrollWidth ${measured.documentScrollWidth} > innerWidth ${measured.innerWidth})`);
  if (measured.documentScrollHeight > measured.innerHeight + tolerance)
    failures.push(`${at}: the page scrolls vertically (documentElement.scrollHeight ${measured.documentScrollHeight} > innerHeight ${measured.innerHeight})`);
  if (measured.bodyScrollWidth > measured.innerWidth + tolerance)
    failures.push(`${at}: body overflows sideways (body.scrollWidth ${measured.bodyScrollWidth} > innerWidth ${measured.innerWidth})`);
  if (measured.bodyScrollHeight > measured.innerHeight + tolerance)
    failures.push(`${at}: body overflows (body.scrollHeight ${measured.bodyScrollHeight} > innerHeight ${measured.innerHeight})`);
  if (Math.abs(measured.shell.height - measured.innerHeight) > 2)
    failures.push(`${at}: the shell does not fill the window (height ${measured.shell.height} vs innerHeight ${measured.innerHeight})`);
  if (measured.shell.width < measured.innerWidth - 2)
    failures.push(`${at}: the shell does not fill the window sideways (width ${measured.shell.width} vs innerWidth ${measured.innerWidth})`);
  if (measured.shell.bottom > measured.innerHeight + 2)
    failures.push(`${at}: the shell runs past the window (bottom ${measured.shell.bottom} > innerHeight ${measured.innerHeight})`);
  return failures;
}

/**
 * Gate 1: the mounted shell is viewport-anchored, whatever the surface and the
 * size. The page may never scroll in either axis; a surface may scroll inside
 * itself, and that is not measured here.
 *
 * The failure this catches: a height chain that collapses and leaves the surface
 * a short box in a tall window (the "half the screen" report), or one that grows
 * past the window and clips the composer band ("bigger than the browser").
 */
test("gate 1: the shell is anchored to the viewport at seven sizes on every surface", async ({ page }) => {
  await mountShell(page);
  const failures: string[] = [];
  let checked = 0;
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const surface of SURFACES) {
      await openSurface(page, surface);
      const at = `${viewport.width}x${viewport.height} ${surface.label}`;
      failures.push(...viewportFailures(at, await page.evaluate(measureViewport)));
      checked += 1;
    }
  }
  record("gate-1", `${checked} surface/size combinations checked; ${failures.length} failure(s)`);
  expect(failures, "every surface is anchored to the window at every size").toEqual([]);
});

/**
 * Gate 2: a very long unbroken token never pushes the page.
 *
 * The token is a 300-character URL in the transcript and a 250-character name -
 * the longest the wire's own 256-unit name bound admits - as the companion's
 * display name. Both axes are asserted, and the element that carries the token
 * must wrap it (transcript bubble, timeline heading) or clip it with an ellipsis
 * (the AppBar title), never grow the layout.
 */
test("gate 2: long unbroken content never pushes the page", async ({ page }) => {
  const root = composedRoot({
    companionName: LONG_NAME,
    title: LONG_NAME,
    transcript: [
      { role: "companion", text: `Have a look at this: ${LONG_URL}` },
      { role: "player", text: LONG_URL },
    ],
  });
  await mountShell(page, { root });

  const failures: string[] = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 400, height: 800 }]) {
    await page.setViewportSize(viewport);
    const at = `${viewport.width}x${viewport.height}`;
    failures.push(...viewportFailures(at, await page.evaluate(measureViewport)));

    const measured = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) return null;
        const style = getComputedStyle(element);
        return {
          text: (element.textContent ?? "").trim().slice(0, 12),
          right: Math.round(element.getBoundingClientRect().right),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          overflowWrap: style.overflowWrap,
          overflow: style.overflow,
          textOverflow: style.textOverflow,
        };
      };
      const surface = document.querySelector<HTMLElement>('[data-testid="chat-surface"]');
      return {
        surfaceRight: surface === null ? -1 : Math.round(surface.getBoundingClientRect().right),
        bubble: read(".message-bubble"),
        heading: read(".timeline-heading h1"),
        title: read(".app-bar-title"),
      };
    });

    for (const [what, element] of [
      ["the transcript bubble", measured.bubble],
      ["the timeline heading", measured.heading],
    ] as const) {
      if (element === null) {
        failures.push(`${at}: ${what} is not rendered`);
        continue;
      }
      if (element.scrollWidth > element.clientWidth + 1 && !["anywhere", "break-word"].includes(element.overflowWrap))
        failures.push(
          `${at}: ${what} neither wraps nor clips the long token (scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth}, overflow-wrap ${element.overflowWrap})`,
        );
      if (element.right > measured.surfaceRight + 1)
        failures.push(`${at}: ${what} overflows the surface (right ${element.right} > surface right ${measured.surfaceRight})`);
    }

    // The AppBar title is allowed to clip, but only with an ellipsis: a hard clip
    // hides the name with no cue that there is more of it.
    if (measured.title === null) failures.push(`${at}: the AppBar title is not rendered`);
    else if (measured.title.scrollWidth > measured.title.clientWidth + 1 && !(measured.title.overflow === "hidden" && measured.title.textOverflow === "ellipsis"))
      failures.push(
        `${at}: the AppBar title neither wraps nor ellipsises the long name (overflow ${measured.title.overflow}, text-overflow ${measured.title.textOverflow})`,
      );
  }

  const bubble = `${LONG_URL.length}-char transcript token, ${LONG_NAME.length}-char companion name`;
  record("gate-2", `${bubble} at 1440x900 and 400x800; ${failures.length} failure(s)`);
  expect(failures, "a long unbroken token must not push the page").toEqual([]);
});

/**
 * Gate 2, the author line: the companion's name is also rendered as the
 * transcript's author line, and a 250-character name - the wire's own maximum -
 * must wrap there instead of overflowing its own box and being hard-clipped by
 * the surface.
 *
 * Before the fix, measured at 400x800: `.message-author` scrollWidth 2582 against
 * clientWidth 339, `overflow-wrap: normal`, `overflow: visible`.
 */
test("gate 2: the transcript author line wraps a long companion name", async ({ page }) => {
  const root = composedRoot({
    companionName: LONG_NAME,
    transcript: [{ role: "companion", text: `Have a look at this: ${LONG_URL}` }],
  });
  await mountShell(page, { root });
  await page.setViewportSize({ width: 400, height: 800 });
  const measured = await page.locator(".message-author").first().evaluate((node) => {
    const style = getComputedStyle(node);
    const surface = node.closest<HTMLElement>('[data-testid="chat-surface"]');
    return {
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      overflowWrap: style.overflowWrap,
      right: Math.round(node.getBoundingClientRect().right),
      surfaceRight: surface === null ? -1 : Math.round(surface.getBoundingClientRect().right),
      surfaceScrollWidth: surface?.scrollWidth ?? -1,
      surfaceClientWidth: surface?.clientWidth ?? -1,
    };
  });
  record(
    "gate-2-author",
    `250-char name at 400x800: author scrollWidth ${measured.scrollWidth} / clientWidth ${measured.clientWidth} (overflow-wrap ${measured.overflowWrap}), right ${measured.right} vs surface right ${measured.surfaceRight}; conversation scroll ${measured.surfaceScrollWidth}/${measured.surfaceClientWidth}`,
  );
  expect(
    measured.scrollWidth,
    "the author line wraps the long name instead of overflowing its own box",
  ).toBeLessThanOrEqual(measured.clientWidth + 1);
  expect(measured.right, "the author line stays inside the conversation").toBeLessThanOrEqual(measured.surfaceRight + 1);
  expect(measured.surfaceScrollWidth, "the conversation does not scroll sideways for the name").toBeLessThanOrEqual(
    measured.surfaceClientWidth + 1,
  );
});

/**
 * Gate 3: WCAG AA contrast for every text tone the surfaces draw.
 *
 * Every text-bearing leaf of the surface is sampled: its computed `color`, its
 * font size and weight, and the *effective* background behind it, composited
 * from the element's own background up through its ancestors to the first opaque
 * one. The required ratio is 3:1 for large text (>= 24px, or >= 18.66px bold)
 * and 4.5:1 otherwise. A leaf whose background cannot be resolved to an opaque
 * backing is counted as indeterminate rather than silently passing, and the
 * count is reported; today every surface resolves, so there are none.
 */
test("gate 3: every text tone clears WCAG AA on its effective background", async ({ page }) => {
  await mountShell(page);
  const failures: string[] = [];
  let sampled = 0;
  let indeterminate = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let minimumAt = "";

  for (const surface of SURFACES) {
    await openSurface(page, surface);
    // Let the surface's own reads settle so the tones are the settled ones.
    await page.waitForTimeout(200);
    const measured = await page.evaluate((testId: string) => {
      const parse = (value: string): [number, number, number, number] => {
        const legacy = value.match(/rgba?\(([^)]+)\)/);
        if (legacy !== null) {
          const parts = legacy[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
          return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
        }
        // CSS Color 4: what a modern Chromium computes `color-mix()` to. The channels are 0..1 floats, so scaling by 255 is the same
        // mapping `rgba()` uses - not a different measurement, the same one in another spelling.
        const modern = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/u);
        if (modern !== null) {
          const channel = (part: string): number => Math.round(Number.parseFloat(part) * 255);
          return [
            channel(modern[1]!),
            channel(modern[2]!),
            channel(modern[3]!),
            modern[4] === undefined ? 1 : Number.parseFloat(modern[4]),
          ];
        }
        // An unknown function is not transparent black: measuring it as black is how this gate reported a 6.51:1 badge as 1.32:1.
        // Throwing fails the gate loudly instead of inventing a colour - a new syntax should stop this measurement, not be skipped.
        throw new Error(`unparsed colour: ${value}`);
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
      const root = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
      // An element's own text nodes, not its subtree's: a button that carries an
      // icon and a label keeps its label here, and the icon is not text.
      const ownText = (element: Element): string =>
        [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join("")
          .trim();
      const leaves = [...root.querySelectorAll<HTMLElement>("*")].filter((element) => {
        if ((element.textContent ?? "").trim().length === 0) return false;
        if (element.getClientRects().length === 0) return false;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.opacity === "0") return false;
        // An element with children is still a text leaf when its own text nodes
        // carry the words. Skipping every element with children is how a button
        // that paints light text on a filled accent - with an icon beside the
        // label - stayed under the floor while this gate was green.
        if (element.children.length > 0 && ownText(element).length === 0) return false;
        return true;
      });
      return leaves.map((element) => {
        const style = getComputedStyle(element);
        const background = effective(element);
        const size = Number.parseFloat(style.fontSize);
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        return {
          text: (ownText(element).length > 0 ? ownText(element) : (element.textContent ?? "")).trim().slice(0, 32),
          color: style.color,
          size,
          large,
          ratio: background === null ? null : ratio(parse(style.color), background),
        };
      });
    }, surface.testId);

    for (const sample of measured) {
      if (sample.ratio === null) {
        indeterminate += 1;
        continue;
      }
      sampled += 1;
      const required = sample.large ? 3 : 4.5;
      if (sample.ratio < required - 0.01)
        failures.push(
          `${surface.label}: "${sample.text}" is ${sample.color} at ${sample.size}px = ${sample.ratio.toFixed(2)}:1, needed ${required}:1`,
        );
      if (sample.ratio < minimum) {
        minimum = sample.ratio;
        minimumAt = `${surface.label} "${sample.text}" (${sample.color})`;
      }
    }
  }

  record(
    "gate-3",
    `${sampled} text tone(s) sampled, ${indeterminate} indeterminate; lowest ${Number.isFinite(minimum) ? minimum.toFixed(2) : "n/a"}:1 at ${minimumAt}; ${failures.length} failure(s)`,
  );
  expect(failures, "every text tone clears WCAG AA for its size").toEqual([]);
});

/**
 * Gate 4: the keyboard path, end to end and without a pointer.
 *
 * Tab from the top of the document reaches the SkipLink and then every AppBar
 * entry, in the shell's own order and each announced by its own name; Enter opens
 * a surface and focus lands on that surface's heading; Escape returns to the
 * conversation with focus inside it; and the composer is reachable by Tab and
 * accepts typing.
 */
test("gate 4: Tab reaches every AppBar entry, Enter opens a surface, Escape returns to the conversation", async ({ page }) => {
  await mountShell(page);

  await resetFocusToTop(page);
  const walked: string[] = [];
  for (let press = 0; press < SURFACES.length + 2; press += 1) {
    await page.keyboard.press("Tab");
    walked.push(
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? ""),
    );
  }
  const expectedOrder = SURFACES.map((surface) => surface.label);
  const reached = walked.filter((label) => expectedOrder.includes(label));
  expect(reached, "Tab reaches every AppBar entry, in order and announced by name").toEqual(expectedOrder);

  // From the keyboard alone: Tab to a surface's entry, Enter opens it and moves
  // focus to its heading, and Escape returns to the conversation. Repeated for
  // every surface, because a shell can be one-way for one of them.
  for (const surface of SURFACES) {
    await resetFocusToTop(page);
    let reachedEntry = false;
    for (let press = 0; press < SURFACES.length + 2; press += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label"));
      if (label === surface.label) {
        reachedEntry = true;
        break;
      }
    }
    expect(reachedEntry, `Tab reaches the ${surface.label} entry`).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(surface.testId)).toBeVisible();
    if (surface.testId === "chat-surface") continue;
    await expect(page.locator(`#${surface.testId}-title`)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-surface")).toBeVisible();
    const insideConversation = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="chat-surface"]') !== null,
    );
    expect(insideConversation, `Escape from ${surface.label} returns focus inside the conversation`).toBe(true);
  }

  // The composer is reachable and usable with no pointer at all.
  //
  // The bound is DERIVED from the conversation the fixture mounted rather than pinned to a count: the
  // tab path to the composer is the fixed chrome above the transcript (the skip link, the six AppBar
  // entries, the scroll region itself) plus one stop per focusable control in the message rows.
  // Copying a message added one control to every row (measured: the composer moved from stop 18 to 22
  // on this four-message transcript, which is exactly four copy buttons), and a pinned `16` would have
  // been a number that only ever meant "the rows had four fewer controls than they do".
  await resetFocusToTop(page);
  const bound = await page.evaluate(() => {
    const chrome = 1 /* skip link */ + document.querySelectorAll(".nav-button").length + 1 /* the transcript region */;
    const inRows = document.querySelectorAll(
      "ol.message-list button, ol.message-list [tabindex]:not([tabindex='-1'])",
    ).length;
    return chrome + inRows + 1;
  });
  let onComposer = false;
  let presses = 0;
  for (; presses < bound && !onComposer; presses += 1) {
    await page.keyboard.press("Tab");
    onComposer = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("composer-textarea") ?? false);
  }
  expect(
    onComposer,
    `the composer is reachable with Tab alone, within ${bound} stops (reached at ${presses})`,
  ).toBe(true);
  await page.keyboard.type("typed without a pointer");
  await expect(page.locator(".composer-textarea")).toHaveValue("typed without a pointer");

  record("gate-4", `tab order reached ${reached.join(" > ")}; Enter focused the surface heading; typing works without a pointer`);
});

/**
 * Gate 4, the conversation's landing place: the documented contract says
 * returning to the conversation "moves focus back to where the player types"
 * (`SurfaceView.tsx`), and the conversation's own `SurfaceView` is mounted with
 * no focus target, so its heading takes the mount focus and Escape leaves the
 * keyboard user on the heading.
 *
 * Before the fix, measured: after Escape, `document.activeElement` is
 * `H2#chat-surface-title`, not `.composer-textarea`.
 */
test("gate 4: Escape returns focus to the composer", async ({ page }) => {
  await mountShell(page);
  await openSurface(page, SURFACES[1]!);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.waitForTimeout(100);
  record(
    "gate-4-composer",
    `after Escape from Game: activeElement ${await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id || (document.activeElement as HTMLElement | null)?.className || "(none)")}`,
  );
  await expect(page.locator(".composer-textarea")).toBeFocused();
});

/**
 * Gate 4, the same landing place reached with a pointer: the AppBar's own entries.
 *
 * The keyboard path above goes through Escape, and Escape is not what most switches are: a press on
 * an AppBar entry unmounts the conversation and mounts a peer in one commit. Measured at 1280x720 on
 * the build before this assertion (a window above the 480 px fold, so `.app-bar-more-trigger` is
 * `display: none`): the conversation's `SurfaceView` was mounted with no restore target named, its
 * declaration asked that `display: none` trigger for focus - a no-op - and focus fell to `<body>`
 * before the peer surface's heading claimed it. The way back was a class-name lookup
 * (`document.querySelector(".composer-textarea")`) rather than the field's own ref, so renaming the
 * class would have dropped the keyboard player on `<body>` with nothing to notice it.
 *
 * What this pins is the pair: the conversation names where it goes back to, and the shell moves focus
 * there on a return. Both readings are recorded, so a run says which element the player was left on.
 */
test("gate 4: a surface switch and back lands focus on the composer", async ({ page }) => {
  await mountShell(page);
  const activeReading = async () =>
    page.evaluate(() => {
      const node = document.activeElement as HTMLElement | null;
      return node === null
        ? "(none)"
        : `${node.tagName.toLowerCase()}${node.id === "" ? "" : `#${node.id}`}${
            node.className === "" ? "" : `.${node.className.toString().trim().split(/\s+/u).join(".")}`
          }`;
    });

  await openSurface(page, SURFACES[1]!);
  record("gate-4-switch-away", `after pressing ${SURFACES[1]!.label}: activeElement ${await activeReading()}`);

  await (await revealSurfaceEntry(page, "Chat")).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  record("gate-4-switch-back", `after pressing Chat: activeElement ${await activeReading()}`);
  await expect(page.locator(".composer-textarea")).toBeFocused();
});

/**
 * Gate 5: the walk stays quiet.
 *
 * Opening every surface must log no console error or warning, throw no uncaught
 * page error, and provoke no non-2xx `/api/` response. This is the gate that
 * would have caught the blank problem view the owner hit twice: a surface that
 * fails to render its own state almost always leaves one of these three traces,
 * and the shell hides the rest behind its own overflow.
 */
test("gate 5: no console error, page error or failed API response while opening every surface", async ({ page }) => {
  const consoleNoise: string[] = [];
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleNoise.push(`${message.type()}: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error).slice(0, 200)));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await mountShell(page);
  for (const surface of SURFACES) {
    await openSurface(page, surface);
    await page.waitForTimeout(150);
  }
  // Back to the conversation last, so the return is walked too.
  await openSurface(page, SURFACES[0]!);
  await page.waitForTimeout(150);

  record(
    "gate-5",
    `console ${consoleNoise.length}, pageerror ${pageErrors.length}, non-2xx /api/ ${badResponses.length}`,
  );
  expect(consoleNoise, "no console error or warning").toEqual([]);
  expect(pageErrors, "no uncaught page error").toEqual([]);
  expect(badResponses, "no non-2xx /api/ response").toEqual([]);
});

/**
 * Gate 6: the shell's own first-projection state names the thing it is loading.
 *
 * Held open with a slow bootstrap so the player's view of it can be measured:
 * a loading state that says nothing is indistinguishable from a blank region.
 * This is the shell-level state the "blank problem view" report was about; the
 * per-surface panels are gated separately below.
 */
test("gate 6: the shell's loading state names what it is loading", async ({ page }) => {
  await mountShell(page, { slow: { bootstrap: 1_500 }, waitForChat: false });
  const loading = page.locator(".state-placeholder .loading-text");
  await expect(loading).toBeVisible();
  const loadingText = (await loading.innerText()).trim();
  expect(loadingText.length, "the shell's loading state is not a blank region").toBeGreaterThan(0);
  expect(loadingText, "the shell's loading state names what it is loading").toContain("chat");
  record("gate-6", `shell loading="${loadingText}"`);
});

/**
 * Gate 6, empty half: every surface with nothing to show paints a real
 * affordance, never a bare region.
 *
 * The failures this catches: a conversation with no messages that renders an
 * empty transcript, a Chats or Memory list that renders nothing at all, and a
 * Game surface whose installation panel disappears instead of saying it found
 * no installation.
 */
test("gate 6b: every surface shows a real empty affordance, not a blank region", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ transcript: [] }) });

  const anchor = page.locator("[data-empty-anchor]");
  await expect(anchor).toBeVisible();
  expect((await anchor.innerText()).trim().length, "the empty conversation says something").toBeGreaterThan(0);

  const affordances: Record<string, string> = {
    "chats-surface": ".empty-subtle",
    "memory-surface": '[data-memory-state="empty"]',
    "game-surface": ".installation-state",
  };
  const report: string[] = [];
  for (const surface of SURFACES) {
    await openSurface(page, surface);
    await page.waitForTimeout(200);
    const text = (await page.getByTestId(surface.testId).innerText()).trim();
    expect(text.length, `${surface.label} is not a blank region`).toBeGreaterThan(0);
    const selector = affordances[surface.testId];
    if (selector !== undefined) {
      const affordance = page.getByTestId(surface.testId).locator(selector).first();
      await expect(affordance, `${surface.label} shows its empty affordance`).toBeVisible();
      const affordanceText = (await affordance.innerText()).trim();
      expect(affordanceText.length, `${surface.label}'s empty affordance says something`).toBeGreaterThan(0);
      report.push(`${surface.label}="${affordanceText.slice(0, 40)}"`);
    } else {
      report.push(`${surface.label}=content(${text.length})`);
    }
  }

  record("gate-6b", `empties ${report.join("; ")}`);
});

/**
 * Gate 6, loading half: a slow surface read shows a loading affordance rather
 * than a blank region, at the moment the player would otherwise see nothing.
 *
 * The naming half is reported, not asserted: only the Game installation finder
 * says *what* it is looking for ("Looking for your Stardew Valley
 * installation…"); the Chats and Memory panels say a bare "Loading...". The
 * shell-level state does name the chat. See the gate report.
 */
test("gate 6c: a slow surface read shows a loading affordance, not a blank region", async ({ page }) => {
  await mountShell(page, { slow: { chats: 1_200, memory: 1_200, discovery: 1_200 } });

  const observed: string[] = [];

  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  const chatsLoading = await page.getByTestId("chats-surface").evaluate(
    (node) => (node.querySelector<HTMLElement>(".empty-subtle")?.textContent ?? "").trim(),
  );
  expect(chatsLoading.length, "the Chats surface shows something while its list loads").toBeGreaterThan(0);
  observed.push(`Chats="${chatsLoading}"`);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByTestId("memory-surface")).toBeVisible();
  const memoryLoading = await page.getByTestId("memory-surface").evaluate(
    (node) => (node.querySelector<HTMLElement>('[data-memory-state="loading"]')?.textContent ?? "").trim(),
  );
  expect(memoryLoading.length, "the Memory surface shows something while its projection loads").toBeGreaterThan(0);
  observed.push(`Memory="${memoryLoading}"`);

  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  const gameLoading = await page.getByTestId("game-surface").evaluate(
    (node) => (node.querySelector<HTMLElement>(".installation-state")?.textContent ?? "").trim(),
  );
  expect(gameLoading.length, "the Game surface shows something while discovery runs").toBeGreaterThan(0);
  expect(gameLoading, "the installation finder names what it is looking for").toMatch(/installation/i);
  observed.push(`Game="${gameLoading}"`);

  record("gate-6c", `loading affordances: ${observed.join("; ")}`);
});

/**
 * Gate 7: a conversation that has just been opened names itself and says
 * something.
 *
 * The failures this catches: a zero-message transcript that paints a bare
 * region - no companion, no line - and a first screen that prints the
 * catalogue's untitled placeholder as though it were the conversation's own
 * title. The transcript's heading is the *published* title's own band, so an
 * untitled conversation has none: the first screen is named by its surface
 * heading and by the invitation that names the companion. The zero state is the
 * first screen a new player sees; "it is technically not blank" is the bar it
 * has to clear, not the target.
 */
test("gate 7: a new conversation opens on a real empty state and prints no placeholder title", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ transcript: [], title: null }) });

  const measured = await page.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>("[data-empty-anchor]");
    const band = document.querySelector<HTMLElement>(".timeline-heading");
    const timeline = document.querySelector<HTMLElement>(".timeline");
    const surface = document.querySelector<HTMLElement>('[data-testid="chat-surface"]');
    return {
      titleBand: band === null ? null : (band.textContent ?? "").trim(),
      anchorText: (anchor?.innerText ?? "").trim(),
      anchorHeight: anchor === null ? 0 : anchor.getBoundingClientRect().height,
      timelineHeight: timeline === null ? 0 : timeline.getBoundingClientRect().height,
      surfaceText: (surface?.innerText ?? "").trim(),
    };
  });

  const name = "Mira";
  const failures: string[] = [];
  if (measured.anchorText.length === 0) failures.push("the empty conversation renders no zero state at all");
  if (!measured.anchorText.includes(name))
    failures.push(`the empty conversation does not name the companion (text="${measured.anchorText}")`);
  if (measured.anchorText.replace(name, "").trim().length === 0)
    failures.push(`the empty conversation is only the name, with no line saying where the player is (text="${measured.anchorText}")`);
  if (!measured.surfaceText.includes(name))
    failures.push(`the conversation surface never names the companion (text="${measured.surfaceText}")`);
  // The zero state lives inside the transcript, so it has to fill the transcript
  // rather than leave most of the window bare.
  if (measured.timelineHeight > 0 && measured.anchorHeight < measured.timelineHeight * 0.5)
    failures.push(
      `the zero state fills ${Math.round(measured.anchorHeight)}px of a ${Math.round(measured.timelineHeight)}px transcript`,
    );
  if (measured.titleBand !== null)
    failures.push(`an untitled conversation prints a title band ("${measured.titleBand}")`);

  record(
    "gate-7",
    `title band=${JSON.stringify(measured.titleBand)}; zero state ${Math.round(measured.anchorHeight)}/${Math.round(measured.timelineHeight)}px; ${failures.length} failure(s)`,
  );
  expect(failures, "a new conversation opens on a real zero state, with no placeholder title").toEqual([]);
});

/**
 * Gate 8: the message-level controls are controls.
 *
 * The capture run measured it at 75x21 px, an 11 px label, a transparent
 * background and no border - the smallest interactive target and the smallest
 * type anywhere in the product, on the one control that repeats a companion's
 * answer. The failures this catches: a control that is only a caption-sized muted
 * text row, invisible as an affordance and unusable as a target; and either
 * switcher - the variant pair and the opening choice that share one
 * `.swipe-controls` shape - dropping under the same floor or onto a transparent
 * background.
 */
test("gate 8: the message-level controls clear the touch floor with a visible affordance", async ({ page }) => {
  // One transcript carrying both shapes: the opening the player may still choose
  // (message zero), and a swiped companion row at the tail - the row regeneration
  // re-asks. A fixture ending on the player's line is a state in which the
  // regenerate control must not exist at all.
  await mountShell(page, {
    root: composedRoot({
      opening: true,
      swipe: true,
      transcript: [DEFAULT_TRANSCRIPT[0]!, DEFAULT_TRANSCRIPT[1]!, DEFAULT_TRANSCRIPT[2]!],
    }),
  });
  await expect(page.locator(".message-list > li"), "the transcript is still the three rows it served").toHaveCount(3);

  const measured = await page.evaluate(() => {
    const read = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        fontSize: Number.parseFloat(style.fontSize),
        backgroundColor: style.backgroundColor,
        text: (node.textContent ?? "").trim(),
      };
    };
    return {
      regenerate: read(".regenerate-btn"),
      openingGroup: read(".message-list > li:first-child .swipe-controls"),
      openingButton: read(".message-list > li:first-child .swipe-btn"),
      swipeGroup: read(".message-list > li:last-child .swipe-controls"),
      swipeButton: read(".message-list > li:last-child .swipe-btn"),
    };
  });

  const transparent = ["transparent", "rgba(0, 0, 0, 0)"];
  const failures: string[] = [];
  if (measured.regenerate === null) failures.push("the regenerate control is not rendered");
  else {
    if (measured.regenerate.height < 44)
      failures.push(`the regenerate control is ${measured.regenerate.height}px tall, under the 44px floor`);
    if (transparent.includes(measured.regenerate.backgroundColor))
      failures.push(`the regenerate control computes to a transparent background (${measured.regenerate.backgroundColor})`);
    if (measured.regenerate.fontSize < 12) failures.push(`the regenerate control's label is ${measured.regenerate.fontSize}px`);
  }
  // Both switchers are one control group, so each keeps the same floor and the
  // same visible affordance the regenerate control is held to - one species, not two.
  for (const [what, group, button] of [
    ["the opening switcher", measured.openingGroup, measured.openingButton],
    ["the swipe switcher", measured.swipeGroup, measured.swipeButton],
  ] as const) {
    if (group === null) {
      failures.push(`${what} is not rendered`);
      continue;
    }
    if (group.height < 44) failures.push(`${what} is ${group.height}px tall, under the 44px floor the regenerate control keeps`);
    if (transparent.includes(group.backgroundColor))
      failures.push(`${what} computes to a transparent background (${group.backgroundColor})`);
    if (button === null) failures.push(`${what} has no button`);
  }

  record(
    "gate-8",
    `regenerate ${measured.regenerate?.width}x${measured.regenerate?.height} @${measured.regenerate?.fontSize}px bg=${measured.regenerate?.backgroundColor}; opening group ${measured.openingGroup?.height}px / button ${measured.openingButton?.height}px; swipe group ${measured.swipeGroup?.height}px / button ${measured.swipeButton?.height}px; ${failures.length} failure(s)`,
  );
  expect(failures, "every message-level control is a real target").toEqual([]);
});

/**
 * Gate 9: the app bar announces which peer surface is showing.
 *
 * `class="nav-button active"` is presentation, not state: assistive technology
 * reads none of it, and neither can any gate. The attribute is `aria-current`
 * (`"page"`): the surfaces are peers within one addressable set - the URL names
 * the selected one and Back returns to the previous one - which is what
 * `aria-current` is defined to mark. It is not `aria-selected` (that requires a
 * widget role such as `tab`/`option`, which a plain button does not have), and
 * not `aria-pressed` (a toggle that can be released, while these are exclusive).
 * The failure this catches: the only record of the selection being a CSS class.
 */
test("gate 9: the app bar marks the current peer surface and moves the mark", async ({ page }) => {
  await mountShell(page);
  const read = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].map((entry) => ({
        name: entry.getAttribute("aria-label"),
        current: entry.getAttribute("aria-current"),
      })),
    );

  const failures: string[] = [];
  const chatShown = await read();
  const markedForChat = chatShown.filter((entry) => entry.current !== null);
  if (markedForChat.length !== 1) failures.push(`${markedForChat.length} entries carry aria-current while Chat is shown`);
  else if (markedForChat[0]!.name !== "Chat")
    failures.push(`the marked entry is "${markedForChat[0]!.name}" while Chat is shown`);
  else if (markedForChat[0]!.current !== "page") failures.push(`the Chat entry is marked aria-current="${markedForChat[0]!.current}"`);

  await openSurface(page, SURFACES[1]!);
  const gameShown = await read();
  const markedForGame = gameShown.filter((entry) => entry.current !== null);
  if (markedForGame.length !== 1) failures.push(`${markedForGame.length} entries carry aria-current while Game is shown`);
  else if (markedForGame[0]!.name !== "Game")
    failures.push(`the mark did not move: "${markedForGame[0]!.name}" is still current with Game shown`);

  record(
    "gate-9",
    `Chat: ${chatShown.map((entry) => `${entry.name}=${entry.current ?? "-"}`).join(", ")}; Game: ${gameShown.map((entry) => `${entry.name}=${entry.current ?? "-"}`).join(", ")}`,
  );
  expect(failures, "exactly one peer entry is marked current, and the mark follows the selection").toEqual([]);
});

/** The streaming preview the gate below drives, as the probe exposes it. */
declare global {
  interface Window {
    chatProbe: {
      setPreview(text: string | null): void;
      caretGeometry(handle: string): {
        caret: { top: number; right: number; bottom: number; left: number; width: number; height: number };
        bubble: { top: number; right: number; bottom: number; left: number; width: number; height: number };
        lastBlock: { top: number; right: number; bottom: number; left: number; width: number; height: number } | null;
      } | null;
    };
  }
}

/**
 * Gate 10: the live caret is painted inside its bubble, not beside it.
 *
 * The failure this catches: a caret rendered as a sibling of the bubble. The
 * markup looks harmless - it is still the live turn's cursor - but it is laid out
 * as a sibling *outside* the bubble's box, so while the reply streams the caret
 * hangs below (or beside) the bubble's edge instead of reading as a cursor at the
 * end of the text. The probe mounts the real `Timeline` with a real streaming
 * preview; the assertion is geometric, because markup position proves nothing
 * about painted position.
 */
test("gate 10: the streaming caret is painted inside its bubble", async ({ page }) => {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate(() => window.chatProbe.setPreview("The reply is still arriving, token by token."));

  const box = await page.evaluate(() => window.chatProbe.caretGeometry("T_preview"));
  expect(box, "the streaming preview must carry a caret").not.toBeNull();
  const { caret, bubble, lastBlock } = box!;
  record(
    "gate-10",
    `caret ${caret.left.toFixed(1)},${caret.top.toFixed(1)} ${caret.width}x${caret.height}; bubble ${bubble.left.toFixed(1)},${bubble.top.toFixed(1)} ${bubble.width}x${bubble.height}; last block ${lastBlock === null ? "none" : `${lastBlock.top.toFixed(1)}-${lastBlock.bottom.toFixed(1)}`}`,
  );

  const tolerance = 1;
  const failures: string[] = [];
  if (caret.width <= 0 || caret.height <= 0) failures.push(`the caret is not painted (${caret.width}x${caret.height})`);
  if (caret.top < bubble.top - tolerance) failures.push(`the caret starts ${(bubble.top - caret.top).toFixed(1)}px above the bubble`);
  if (caret.bottom > bubble.bottom + tolerance)
    failures.push(`the caret ends ${(caret.bottom - bubble.bottom).toFixed(1)}px below the bubble`);
  if (caret.left < bubble.left - tolerance) failures.push(`the caret starts ${(bubble.left - caret.left).toFixed(1)}px left of the bubble`);
  if (caret.right > bubble.right + tolerance)
    failures.push(`the caret ends ${(caret.right - bubble.right).toFixed(1)}px right of the bubble`);
  // Containment is not enough: a caret laid out as its own flex row inside the
  // bubble is still "inside" the box while it paints on a line of its own below
  // the reply. The caret must share the last block's own line box.
  if (lastBlock === null) {
    failures.push("the streaming bubble has no block for the caret to trail");
  } else if (caret.top >= lastBlock.bottom || caret.bottom <= lastBlock.top) {
    failures.push(
      `the caret sits on a line of its own: caret ${caret.top.toFixed(1)}-${caret.bottom.toFixed(1)}, last block ${lastBlock.top.toFixed(1)}-${lastBlock.bottom.toFixed(1)}`,
    );
  }
  expect(failures, "the caret's box sits on the bubble's last line").toEqual([]);
});

/**
 * Gate 11: `prefers-reduced-motion: reduce` stops the two sites the universal
 * reset cannot reach.
 *
 * The failure this catches: the reduce escape handled only by the universal
 * `*, *::before, *::after` block. That block sits in `theme.interactions` with
 * the lowest possible specificity - and in an earlier layer than the class rules
 * it is meant to silence - so a class-keyed `animation:` (the app bar's progress
 * dot) and a class-keyed `transition:` (the skip link's slide) both beat it, and
 * a player who asked for no motion keeps watching a pulse and a slide. Both
 * directions are asserted, so the gate cannot pass by the motion having been
 * deleted outright.
 */
test("gate 11: the progress pulse and the skip link stop under reduced motion", async ({ page }) => {
  await mountShell(page);
  await page.evaluate(() => {
    // The app bar's own dot while a turn is in flight. No mounted surface holds
    // that state on demand, so the marker is built from the markup contract the
    // app bar renders (`<span class="status-dot" data-tone="progress">`) and
    // measured against the same stylesheet.
    const dot = document.createElement("span");
    dot.id = "gate-11-progress-dot";
    dot.className = "status-dot";
    dot.setAttribute("data-tone", "progress");
    document.body.appendChild(dot);
  });
  const read = () =>
    page.evaluate(() => {
      const motion = (element: Element | null) => {
        if (element === null) return null;
        const style = getComputedStyle(element);
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
        };
      };
      return {
        dot: motion(document.getElementById("gate-11-progress-dot")),
        skip: motion(document.querySelector(".skip-link")),
      };
    });

  const motion = await read();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await read();
  record(
    "gate-11",
    `progress dot ${JSON.stringify(motion.dot)} -> ${JSON.stringify(reduced.dot)}; skip link ${JSON.stringify(motion.skip)} -> ${JSON.stringify(reduced.skip)}`,
  );

  const failures: string[] = [];
  if (motion.dot?.animationName !== "game-status-pulse")
    failures.push(`the progress dot does not pulse by default (${motion.dot?.animationName})`);
  if (reduced.dot?.animationName !== "none")
    failures.push(`the progress dot keeps animating under reduced motion (${reduced.dot?.animationName} ${reduced.dot?.animationDuration})`);
  if (motion.skip?.transitionProperty !== "top")
    failures.push(`the skip link does not slide by default (${motion.skip?.transitionProperty})`);
  if (reduced.skip?.transitionProperty !== "none")
    failures.push(`the skip link keeps its transition under reduced motion (${reduced.skip?.transitionProperty} ${reduced.skip?.transitionDuration})`);
  expect(failures, "the motion is real by default and gone when the player asks for none").toEqual([]);
});

/**
 * The Game surface reads as a companion capability board rather than a status
 * dump: the board leads with what the companion can do with the player, the
 * machine facts are demoted last, and while nothing is connected the surface
 * reads as "here is how we get going".
 *
 * The three assertions below are what keeps that true:
 *
 *   game.1 - with capabilities published, the board renders the published fact
 *            as player-readable text and nothing internal reaches the surface.
 *            Fails if the board stops reading the projection (a hardcoded
 *            list), if the published summary stops being rendered, or if a raw
 *            contract member, operation id or ability id is rendered.
 *   game.2 - with nothing published, the board says so and names what it is
 *            waiting for. Fails if a static ability list is invented to fill
 *            the empty state, and if the empty state renders nothing at all.
 *   game.3 - while disconnected the three-step guide is present and its
 *            affordances are the *existing* lifecycle and cabin controls (one
 *            each, by their frozen test ids), never a second set of them.
 */
function gameRootWith(overrides: Record<string, unknown>) {
  const base = composedRoot();
  return { ...base, game: { ...base.game, game: { ...base.game.game, ...overrides } } };
}

test("game.1: a published capability surface renders as readable board cards, never as a raw id", async ({ page }) => {
  await mountShell(page, { root: gameRootWith({ capabilitySummary: { available: true, count: 7 } }) });
  await page.getByRole("button", { name: "Game", exact: true }).click();

  const panel = page.getByTestId("game-state-panel");
  const board = panel.getByTestId("game-capability-board");
  await expect(board).toHaveAttribute("data-capability-state", "published");
  // The published summary is what a player reads: the count, in a sentence.
  await expect(board).toContainText("7");

  const cards = board.locator("[data-capability-card]");
  expect(await cards.count(), "the board renders a card per published fact").toBe(3);
  for (const card of await cards.all()) {
    const text = (await card.innerText()).trim();
    expect(text.length, "every board card reads as text, not as a bare value").toBeGreaterThan(0);
  }

  const text = await panel.innerText();
  const leaked = text.match(/\b(connected_idle|not_configured|unchecked|capabilitySummary|move_to_tile|game\.state\.read)\b/g) ?? [];
  record("game-1", `board="${(await board.innerText()).replace(/\s+/gu, " ").slice(0, 120)}"`);
  expect(leaked, "no raw enum, operation id or ability id may reach the surface").toEqual([]);
});

test("game.2: with nothing published the board states what it waits for instead of a static ability list", async ({ page }) => {
  await mountShell(page, { root: composedRoot() });
  await page.getByRole("button", { name: "Game", exact: true }).click();

  const panel = page.getByTestId("game-state-panel");
  const board = panel.getByTestId("game-capability-board");
  await expect(board).toHaveAttribute("data-capability-state", "unpublished");
  await expect(board).toContainText("has not published what your companion can do with you yet");
  await expect(board).toContainText("come from the game itself");

  const text = await panel.innerText();
  const invented = text.match(/watering|harvest|backpack|weather|mine sound/gi) ?? [];
  record("game-2", `unpublished board="${(await board.innerText()).replace(/\s+/gu, " ").slice(0, 120)}"`);
  expect(invented, "the empty state invents no ability the game never published").toEqual([]);
});

test("game.3: while disconnected the start guide presents the existing controls in three steps", async ({ page }) => {
  await mountShell(page, { root: composedRoot() });
  await page.getByRole("button", { name: "Game", exact: true }).click();

  const panel = page.getByTestId("game-state-panel");
  const guide = panel.getByTestId("game-start-guide");
  await expect(guide).toBeVisible();
  await expect(guide.locator("[data-guide-step]")).toHaveCount(3);

  // The pre-activation shape offers activation and setup, and the guide is
  // where they live: exactly one of each in the whole panel, inside step 1.
  await expect(guide.locator('[data-guide-step="1"]').getByTestId("game-activate")).toHaveCount(1);
  await expect(guide.locator('[data-guide-step="1"]').getByTestId("game-setup")).toHaveCount(1);
  await expect(panel.getByTestId("game-activate")).toHaveCount(1);
  await expect(panel.getByTestId("game-setup")).toHaveCount(1);
  // The cabin choice is step 3's affordance, and the frozen list anchor is the
  // same block that was already there.
  await expect(guide.locator('[data-guide-step="3"] .stardew-cabin-handoff')).toHaveCount(1);

  // The activated-but-not-launched shape puts the launch affordance in step 2.
  const staged = composedRoot();
  await mountShell(page, {
    root: {
      ...staged,
      game: {
        ...staged.game,
        game: {
          ...staged.game.game,
          prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
          instance: { status: "none", gameTitle: "Stardew Valley", generation: 1 },
        },
      },
    },
  });
  await page.goto(`/?staged=1#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const stagedPanel = page.getByTestId("game-state-panel");
  await expect(stagedPanel.getByTestId("game-start-guide")).toBeVisible();
  await expect(stagedPanel.locator('[data-guide-step="2"]').getByTestId("game-launch")).toHaveCount(1);
  await expect(stagedPanel.getByTestId("game-launch")).toHaveCount(1);
  record("game-3", "guide: 3 steps, activation/setup in step 1, launch in step 2, cabin handoff in step 3");
});

/**
 * Gate 12: the monogram is a whole character, whatever the name starts with.
 *
 * The failure this catches: `.slice(0, 1)` cuts a UTF-16 code unit, so a name
 * starting with an astral character (an emoji, an extension-area glyph) renders
 * half a surrogate pair as a replacement glyph in both the AppBar and the
 * transcript avatar.
 */
test("gate 12: the monogram is one whole character for an astral name", async ({ page }) => {
  await mountShell(page, {
    root: composedRoot({ companionName: "🌙 Luna", transcript: [{ role: "companion", text: "Hello." }] }),
  });
  // Both plates are `CompanionAvatar`: her picture where the Host serves one, her
  // monogram where it does not, in one element because a 404 and a decode failure
  // are the same player-visible fact. This spec serves no
  // `/assets/companions/<handle>/…` at all, so both plates fall back to the monogram
  // - which is the property under test. Reading it once it is painted keeps the
  // assertion about the character rather than about how long a 404 took: the AppBar
  // is chrome that mounts in the first frame, so its plate was still the (textless)
  // picture when the read happened, while the bubble's had already fallen back.
  const barAvatar = page.locator(".app-bar-companion .avatar");
  const bubbleAvatar = page.locator("li.message.companion .avatar");
  await expect(barAvatar).toHaveText("🌙");
  await expect(bubbleAvatar).toHaveText("🌙");
  const barMonogram = await barAvatar.innerText();
  const bubbleInitial = await bubbleAvatar.innerText();
  record(
    "gate-12",
    `AppBar monogram ${JSON.stringify(barMonogram)} (${Array.from(barMonogram).length} code point(s)); bubble initial ${JSON.stringify(bubbleInitial)}`,
  );
  expect(Array.from(barMonogram).length, "the AppBar monogram is a single code point").toBe(1);
  expect(barMonogram, "the AppBar monogram is the whole first character").toBe("🌙");
  expect(Array.from(bubbleInitial).length, "the transcript initial is a single code point").toBe(1);
  expect(bubbleInitial).toBe("🌙");
});

/**
 * Gate 13: a CJK action beat is de-emphasised, not mechanically slanted.
 *
 * CJK type has no true italic; the browser synthesises a slant that reads as
 * smeared. The failure this catches: `em.message-action` keeps the browser's
 * faux italic and the beat looks broken in the product's own language.
 *
 * `style.css` retires the slant in `.message-bubble em.message-action:lang(zh)`,
 * and `:lang()` reads the *nearest* `lang` in the beat's ancestor chain: the
 * document's own, unless the message painted one. The transcript carries the one
 * language fact a facade projects - `und`, because ChatThreadStore keeps no
 * per-message language - and `MessageBubble` paints nothing for `und`, so the
 * chain ends at `html[lang="zh-CN"]` and the rule reaches the beat. The fixture
 * therefore may not claim a language the Host never projected: an `en` message
 * here paints `lang="en"` on the bubble, moves the Chinese beat out of
 * `:lang(zh)`, and this gate reads the UA's faux italic instead of the product's
 * own rule.
 */
test("gate 13: a CJK action beat is de-emphasised without a faux italic", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await mountShell(page, {
    root: composedRoot({ transcript: [{ role: "companion", text: "*轻轻点头*\n她抬起头。" }] }),
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const fontStyle = await page
    .locator("li.message.companion em.message-action")
    .evaluate((node) => getComputedStyle(node).fontStyle);
  record("gate-13", `CJK action-beat font-style: ${fontStyle}`);
  expect(fontStyle, "a CJK beat is not mechanically slanted").toBe("normal");
});

/**
 * Gate 14: the same `*beat*` reads the same on both sides.
 *
 * The failure this catches: the companion's `*action*` rendered as a stage
 * direction while the player's identical text stayed literal, so one format read
 * two ways depending on who wrote it.
 */
test("gate 14: the same action markup renders the same beat on both sides", async ({ page }) => {
  const action = "*nods slowly*\nShe looks up.";
  await mountShell(page, {
    root: composedRoot({
      transcript: [
        { role: "companion", text: action },
        { role: "player", text: action },
      ],
    }),
  });
  const companionBeat = page.locator("li.message.companion em.message-action");
  const playerBeat = page.locator("li.message.player em.message-action");
  await expect(companionBeat).toHaveCount(1);
  await expect(playerBeat).toHaveCount(1);
  const companionClass = await companionBeat.getAttribute("class");
  const playerClass = await playerBeat.getAttribute("class");
  record("gate-14", `companion class ${companionClass}; player class ${playerClass}`);
  expect(playerClass, "the player's beat carries the companion beat's own class").toBe(companionClass);
  expect(await playerBeat.innerText()).toBe(await companionBeat.innerText());
});

/**
 * Gate 15: the viewport meta asks the on-screen keyboard to resize the visual
 * viewport.
 *
 * The failure this catches: without `interactive-widget=resizes-content` a soft
 * keyboard overlays the visual viewport and buries the composer behind it.
 */
test("gate 15: the viewport meta resizes the visual viewport for the on-screen keyboard", async ({ page }) => {
  const html = await (await page.request.get("/")).text();
  const content = html.match(/<meta name="viewport" content="([^"]*)"/u)?.[1] ?? "";
  record("gate-15", `viewport content="${content}"`);
  expect(content, "the soft keyboard compresses the visual viewport instead of burying the composer").toContain(
    "interactive-widget=resizes-content",
  );
});

/* ========================================================================== *
 * The axes two roles can differ on, and the floors a difference must clear to
 * count as one a reader sees.
 *
 * The vocabulary lives here rather than inside a gate because more than one gate
 * asks it now: gates 16 and 17 both read two elements' computed style and count
 * the channels between them, and two spellings of the size floor would be two
 * verdicts waiting to disagree.
 *
 * The set was established by the beat incident (gate 16): `colour` carries an ink
 * separation ratio, because two inks are not two tones unless the gap between
 * them reads; `weight`, `style`, `tracking` and `size` are the four typographic
 * axes a stylesheet can move. Two more are added here because a role in this
 * product is drawn back by them and this inventory would otherwise call a
 * visibly different control one channel:
 *
 *   * `opacity` - the element's own fill attenuation. `.send-button:disabled` is
 *     drawn at 0.6 against 1, and that is a difference a reader sees.
 *   * `edge` - the widest border side the element actually paints. A system
 *     notice wears a 3 px accent bar; a bubble wears a 1 px hairline.
 *   * `text` - the words themselves, whitespace-normalised. Two problems drawn on
 *     one card, or a notice beside the player's own line, are told apart by their
 *     copy when nothing else moves; an element that differs only in an attribute
 *     or an id is NOT told apart, which is why a `data-` value is not a channel.
 *   * `cursor` - the pointer the browser draws over the element. `not-allowed`
 *     against `pointer` is the only channel an inert control carries that its own
 *     fill does not, and a reader who points at it sees it.
 *
 * NOT MEASURED, named so nobody assumes it was: position and width, and any state a
 * resting page is not in (a `:hover` plate, focus, an in-flight animation). A notice is
 * a block outside the transcript rather than a bubble in it, and that is a strong
 * channel a per-element reading cannot see; so is the plate a live control draws only
 * under the pointer. A pair whose second channel is one of those is declared as a pair
 * with a `beyond` channel: the channel is NAMED, and the page or stylesheet fact it rests
 * on is ASSERTED, so the declaration expires when the thing doing the work goes away.
 * It is never quietly counted as a measured channel, and never declared with a lower
 * number instead.
 * ========================================================================== */

/** An ink separation ratio under this reads as one tone at body sizes. */
const ROLE_INK_SEPARATION = 3;
/** 0.02em is about a quarter pixel at 14 px: the smallest tracking difference that reads as tracking. */
const ROLE_TRACKING_STEP_EM = 0.02;
/**
 * A size step under 8% is under 1.2 px at the 14 px body size, which lands in the
 * glyph raster's own rounding; the beat ships at 10% (`0.9em`).
 */
const ROLE_SIZE_STEP_RATIO = 0.08;
/** One weight rung (400 -> 500) is the smallest step a text face renders as a different voice. */
const ROLE_WEIGHT_STEP = 100;
/** A fill attenuation a reader sees; the product's own disabled control ships at 0.6 against 1. */
const ROLE_OPACITY_STEP = 0.15;
/** A border step a reader sees: a notice's 3 px accent bar against a bubble's 1 px hairline. */
const ROLE_EDGE_STEP_PX = 2;

/**
 * Every axis a pair of roles can be told apart on.
 *
 * The two that are not typographic are here because a role in this product is drawn
 * apart by them: `text` is the words themselves, which is what separates two different
 * problems that share one card, and `cursor` is the pointer the browser draws for the
 * element - `not-allowed` against `pointer` is the only channel an inert control carries
 * that its fill does not.
 */
const ROLE_CHANNELS = ["text", "colour", "weight", "style", "tracking", "size", "opacity", "edge", "cursor"] as const;

type RoleChannel = (typeof ROLE_CHANNELS)[number];

/**
 * The channels gate 16 may count between a beat and its speech.
 *
 * Not every axis: the two roles always say different words and the beat is not the speech's
 * own pointer target, so `text` and `cursor` are excluded - the pair's protection is
 * typographic, and counting copy would have hidden the collapse the gate was written for.
 */
const BEAT_CHANNELS: readonly RoleChannel[] = ["colour", "weight", "style", "tracking", "size", "opacity", "edge"];

/**
 * How many of which channels must separate a declared pair.
 *
 * `of` is not decoration. The words two roles carry are almost always different, so a
 * pair whose protection is typographic has to exclude `text`: the beat incident gate 16
 * was written for (`1.59:1` of ink, tracking alone in Chinese) would have been green on
 * the words alone, and the collapse would have shipped again behind a passing gate.
 */
type ChannelFloor = Readonly<{ atLeast: number; of: readonly RoleChannel[] }>;

/** One element's visible appearance: the axes two roles can differ on. */
type RoleReading = Readonly<{
  fontStyle: string;
  fontSizePx: number;
  fontWeight: number;
  /** Letter-spacing in em, so a reading does not depend on the body size. */
  trackingEm: number;
  color: string;
  opacity: number;
  /** The widest border side this element actually paints, in px. */
  edgePx: number;
  /** The element's own words, whitespace-normalised: the same string is one channel fewer. */
  text: string;
  /** The pointer the browser is asked to draw over this element. */
  cursor: string;
}>;

/**
 * What one element's computed style says it looks like.
 *
 * Written as a page function with no free variables, because it is serialised
 * into the browser: `roleReadingOf` is the ONE place these axes are read, and
 * every gate that counts channels goes through it.
 */
function roleReadingOf(element: Element): RoleReading {
  const style = getComputedStyle(element);
  const size = Number.parseFloat(style.fontSize);
  // A painted border side. Its computed width is 0 when the style is `none`, so the
  // only thing that needs checking separately is a `solid` border at alpha 0.
  const transparent = (colour: string): boolean => {
    const alpha =
      colour.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/u)?.[1] ??
      colour.match(/^color\(srgb[^/]*\/\s*([\d.]+)\s*\)$/u)?.[1];
    return alpha !== undefined && Number.parseFloat(alpha) === 0;
  };
  const edgePx = (["top", "right", "bottom", "left"] as const).reduce((widest, side) => {
    if (style.getPropertyValue(`border-${side}-style`) === "none") return widest;
    if (transparent(style.getPropertyValue(`border-${side}-color`))) return widest;
    return Math.max(widest, Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0);
  }, 0);
  return {
    fontStyle: style.fontStyle,
    fontSizePx: size,
    fontWeight: Number.parseInt(style.fontWeight, 10),
    trackingEm: (Number.parseFloat(style.letterSpacing) || 0) / size,
    color: style.color,
    opacity: Number.parseFloat(style.opacity),
    edgePx,
    text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
    cursor: style.cursor,
  };
}

/** The fill one element paints: the plate its own ink, and anything inside it, is drawn on. */
function paintedBackgroundOf(element: Element): string {
  return getComputedStyle(element).backgroundColor;
}

/** A painted colour as the browser computed it: 0..255 channels and a 0..1 alpha. */
function parsePaintedInk(color: string): readonly [number, number, number, number] {
  const rgb = color.match(/^rgba?\(([^)]+)\)$/u);
  if (rgb !== null) {
    const parts = rgb[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  }
  // CSS Color 4, which a modern Chromium computes `color-mix()` to: channels are 0..1
  // floats, so scaling by 255 is the same mapping `rgba()` uses, not another measurement.
  const srgb = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/u);
  if (srgb !== null) {
    return [
      Math.round(Number.parseFloat(srgb[1]!) * 255),
      Math.round(Number.parseFloat(srgb[2]!) * 255),
      Math.round(Number.parseFloat(srgb[3]!) * 255),
      srgb[4] === undefined ? 1 : Number.parseFloat(srgb[4]),
    ];
  }
  // An unparsed colour is not black. Measuring one as black is how the surface contrast
  // gate once reported a 6.51:1 badge as 1.32:1; throwing stops the reading instead.
  throw new Error(`unparsed painted colour: ${color}`);
}

/** WCAG 2.1 relative luminance of a painted colour. */
function paintedLuminance(color: string): number {
  const [red = 0, green = 0, blue = 0] = parsePaintedInk(color)
    .slice(0, 3)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.1 contrast ratio between two painted colours. */
function paintedContrast(foreground: string, background: string): number {
  const lit = paintedLuminance(foreground);
  const dark = paintedLuminance(background);
  return (Math.max(lit, dark) + 0.05) / (Math.min(lit, dark) + 0.05);
}

/**
 * The channels a reader can actually see between two roles, by name, at the floors above.
 *
 * `of` is the pair's own declaration of which channels its separation may rest on; a
 * channel it did not name cannot make an undeclared pair pass.
 */
function distinguishingChannels(
  a: RoleReading,
  b: RoleReading,
  of: readonly RoleChannel[],
): readonly RoleChannel[] {
  const differing: Record<RoleChannel, boolean> = {
    text: a.text !== b.text,
    colour: paintedContrast(a.color, b.color) >= ROLE_INK_SEPARATION,
    weight: Math.abs(a.fontWeight - b.fontWeight) >= ROLE_WEIGHT_STEP,
    style: a.fontStyle !== b.fontStyle,
    tracking: Math.abs(a.trackingEm - b.trackingEm) >= ROLE_TRACKING_STEP_EM,
    size: Math.abs(a.fontSizePx / b.fontSizePx - 1) >= ROLE_SIZE_STEP_RATIO,
    opacity: Math.abs(a.opacity - b.opacity) >= ROLE_OPACITY_STEP,
    edge: Math.abs(a.edgePx - b.edgePx) >= ROLE_EDGE_STEP_PX,
    cursor: a.cursor !== b.cursor,
  };
  return of.filter((channel) => differing[channel]);
}

/**
 * Measures the settled cascade rather than an animation frame.
 *
 * `.swipe-btn` transitions its colour over 150 ms, so a reading taken straight after a
 * theme switch reports a value between the two themes - and a value between two themes
 * is a value no reader ever sees. (Read live, this gate reported the light appearance's
 * disabled arrow inside a dark cell.) A transition never changes where a value settles,
 * only when, so retiring it for the duration of a reading is the same measurement taken
 * once instead of mid-flight. One helper, so no two gates decide this differently.
 */
async function freezeTransitions(page: Page): Promise<void> {
  await page.addStyleTag({ content: "* { transition: none !important; animation: none !important; }" });
}

/** One role reading, one string, so every row of every table reads alike. */
function roleVoice(reading: RoleReading): string {
  return (
    `${reading.fontStyle} ${reading.fontSizePx.toFixed(2)}px ${reading.fontWeight} ` +
    `tracking ${reading.trackingEm.toFixed(3)}em opacity ${reading.opacity} edge ${reading.edgePx}px ${reading.color} ` +
    `cursor ${reading.cursor} "${reading.text}"`
  );
}

/** The three selectors that name one pair of roles inside one container. */
type RoleSelectors = Readonly<{ scope: string; a: string; b: string }>;

/** One container instance's two roles, read. */
type RolePairRow = Readonly<{ instance: string; a: RoleReading; b: RoleReading }>;

/** One cell's reading of one pair: the rows it produced, and why it produced none. */
type RolePairReading = Readonly<{ rows: readonly RolePairRow[]; problems: readonly string[] }>;

/**
 * Reads a declared pair out of the mounted page, one row per instance of its scope.
 *
 * Both sides must resolve to EXACTLY one element inside their container. A side that
 * resolves to none is the population zero this file treats as a failure; a side that
 * resolves to many would silently compare the first of them, so it is refused too.
 * Either way the complaint names the selector, because "expected true, got false"
 * tells the next reader nothing about which declaration stopped matching.
 */
async function readRolePair(page: Page, pair: RoleSelectors): Promise<RolePairReading> {
  const scope = page.locator(pair.scope);
  const containers = await scope.count();
  const rows: RolePairRow[] = [];
  const problems: string[] = [];
  if (containers === 0) problems.push(`the declared scope \`${pair.scope}\` resolved to no element`);
  for (let index = 0; index < containers; index += 1) {
    const container = scope.nth(index);
    const instance = `${index} ${await container.evaluate(nameOfElement)}`;
    const left = container.locator(pair.a);
    const right = container.locator(pair.b);
    const [leftCount, rightCount] = [await left.count(), await right.count()];
    if (leftCount !== 1 || rightCount !== 1) {
      problems.push(
        `${instance}: expected exactly one \`${pair.a}\` and one \`${pair.b}\`, found ${leftCount} and ${rightCount}`,
      );
      continue;
    }
    rows.push({ instance, a: await left.evaluate(roleReadingOf), b: await right.evaluate(roleReadingOf) });
  }
  return { rows, problems };
}

/** Enough of an element to recognise it in a failure message. */
function nameOfElement(element: Element): string {
  const classes = element.getAttribute("class");
  return `<${element.tagName.toLowerCase()}${classes === null ? "" : ` class="${classes}"`}>`;
}

/**
 * Gate 16: a beat and the speech beside it are two voices, in both appearances
 * and both languages.
 *
 * The owner's report: "浅色情况下动作和后面的话不大容易区分(粗细不明显)" - in the
 * light appearance the bracketed stage direction and the sentence after it did
 * not read as two things.
 *
 * The readings that made that possible are in the commit that added this gate, and
 * they correct a natural guess: the collapse is not a light-theme defect. `style.css`
 * retires the CJK slant (`.message-bubble em.message-action:lang(zh)`), correctly -
 * a slanted CJK face is a smeared one - so the italic is a channel Latin has and
 * Chinese does not. What Chinese had left was tracking alone, and its ink differs
 * from the speech's by 1.59:1 (dark) and 1.69:1 (light), which a contrast ratio can
 * see and a reader cannot. One channel, in both appearances.
 *
 * WHY THE INK IS NOT THE SECOND CHANNEL, in either appearance: a beat is drawn on
 * the player's own bubble too, and the dark burgundy plate under AA caps the ink
 * separation at 2.21:1; the light plate is free of that cap, but the only rung under
 * `--text-secondary` that clears AA there is the ink the product reserves for things
 * the player cannot use (`ui-polish-defects.spec.ts`'s defect 1, a stage direction
 * that read as a dead placeholder). Both walls are in the stylesheet's comment. The
 * size step is the axis that remains.
 *
 * The failure this catches:
 *
 *   * a beat that differs from its speech in fewer than two visible channels - the
 *     Chinese case above, in any appearance. Every combination is measured, and the
 *     count is not relaxed per appearance: a gate that exempts the case that reds is
 *     not a gate.
 *   * a beat whose quieter ink has been pushed off the AA floor on the plate it is
 *     actually drawn on (the player's own `--selection` bubble is the tight one).
 *   * a beat's size that reflows the paragraph it sits in. A quieter stage direction
 *     is a typographic change; a reflowed body copy is a different change.
 *
 * WHY THE READINGS ARE THE BROWSER'S: the sheet authors tokens, `:lang()` and six
 * cascade layers decide which of them the beat wears, and only the engine computes
 * the result. Each channel counts only when the difference is one a reader sees (the
 * floors below), so two inks one step apart are not two tones.
 */

/** One bubble's pair: the beat, the speech block it stands ahead of, and the plate behind both. */
type BeatReading = Readonly<{ beat: RoleReading; speech: RoleReading; bubble: string }>;

/** Both sides of the conversation, because a beat is the same format on both. */
type TranscriptReading = Readonly<{ companion: BeatReading | null; player: BeatReading | null }>;

/** One line box's height, so a reflow can be read as a count and not only as a total. */
type BlockGeometry = Readonly<{ height: number; lines: number }>;

/**
 * Reads the rendered beat and the speech block beside it out of both bubbles.
 *
 * The two roles are two elements, not one element and its own text node: the
 * reply shape is a stage direction in its own paragraph, then what she says, and
 * `:not(:has(em.message-action))` names the second without depending on the
 * wording of either. A bubble with no beat in it is not an instance at all.
 */
async function readBeats(page: Page): Promise<TranscriptReading> {
  return { companion: await readBeatSide(page, BEAT_SIDES.companion), player: await readBeatSide(page, BEAT_SIDES.player) };
}

/** One side's beat, its speech, and the plate under both - or null when either role is absent. */
async function readBeatSide(page: Page, scope: string): Promise<BeatReading | null> {
  const reading = await readRolePair(page, { ...BEAT_PAIR, scope });
  const [row] = reading.rows;
  if (row === undefined || reading.problems.length > 0) return null;
  return { beat: row.a, speech: row.b, bubble: await page.locator(scope).evaluate(paintedBackgroundOf) };
}

/**
 * The line geometry of every block a body carries: `lines` counts the line boxes the
 * paragraph's text actually painted, so a paragraph that grew one more line is
 * visible as a count and not only as a height.
 */
async function readReflow(page: Page): Promise<readonly (readonly BlockGeometry[])[]> {
  return page.evaluate(() => {
    const linesOf = (block: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(block);
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top * 10) / 10));
      return Math.max(1, tops.size);
    };
    return [...document.querySelectorAll("li.message.companion .message-bubble")].map((bubble) =>
      [...bubble.querySelectorAll<HTMLElement>("p")].map((block) => ({
        height: block.getBoundingClientRect().height,
        lines: linesOf(block),
      })),
    );
  });
}

/** One line per combination and side, so a failure prints the whole table and not only its own row. */
function beatTable(
  rows: readonly Readonly<{ appearance: string; locale: string; companion: BeatReading; player: BeatReading }>[],
): string {
  return rows
    .map(({ appearance, locale, companion, player }) => {
      const channels = distinguishingChannels(companion.beat, companion.speech, BEAT_CHANNELS);
      const playerChannels = distinguishingChannels(player.beat, player.speech, BEAT_CHANNELS);
      return (
        `${appearance}/${locale}: beat{${roleVoice(companion.beat)}} speech{${roleVoice(companion.speech)}} ` +
        `card{${companion.bubble}} beat-on-card ${paintedContrast(companion.beat.color, companion.bubble).toFixed(2)}:1 ` +
        `plate{${player.bubble}} beat-on-plate ${paintedContrast(player.beat.color, player.bubble).toFixed(2)}:1 ` +
        `ink-separation ${paintedContrast(companion.beat.color, companion.speech.color).toFixed(2)}:1 ` +
        `channels [${channels.join(", ")}] = ${channels.length}` +
        (playerChannels.join() === channels.join() ? "" : ` player [${playerChannels.join(", ")}]`)
      );
    })
    .join("\n");
}

/**
 * The two replies this gate reads, per language, the way a companion writes them: a
 * stage direction on its own line and the sentence after it. The second reply is the
 * same words with no beat markup at all, and it is the control for the reflow check -
 * the line boxes of the two must be the same height and the same count.
 */
const BEAT_REPLY = {
  en: { withBeat: "*nods slowly*\n\nShe looks up.", plain: "nods slowly\n\nShe looks up." },
  "zh-CN": { withBeat: "*轻轻点头*\n\n她抬起头。", plain: "轻轻点头\n\n她抬起头。" },
} as const;

/** The two roles inside one bubble, named once for every gate that reads the beat. */
const BEAT_PAIR = { a: "em.message-action", b: "p:not(:has(em.message-action))" } as const;

/** The bubble each side of the conversation wears when it carries a beat; a beatless bubble is not an instance. */
const BEAT_SIDES = {
  companion: "li.message.companion .message-bubble:has(em.message-action)",
  player: "li.message.player .message-bubble:has(em.message-action)",
} as const;

/**
 * The two appearances the stylesheet paints. A third token root joins a gate by being
 * written into `style.css`: the population is read off the sheet below, so a new
 * appearance fails loudly instead of going unmeasured.
 */
const PAINTED_APPEARANCES = ["dark", "light"] as const;

for (const locale of ["en", "zh-CN"] as const) {
  test(`gate 16: a beat is told from its speech by more than one visible channel (${locale})`, async ({ page }) => {
    const reply = BEAT_REPLY[locale];
    if (locale === "zh-CN") await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
    await mountShell(page, {
      root: composedRoot({
        transcript: [
          { role: "companion", text: reply.withBeat },
          { role: "player", text: reply.withBeat },
          { role: "companion", text: reply.plain },
        ],
      }),
    });
    // One companion beat (the reply the table reads), one player beat (the other plate),
    // and the same words twice without a beat for the reflow control.
    await expect(page.locator("li.message.companion em.message-action")).toHaveCount(1);
    if (locale === "zh-CN") await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await freezeTransitions(page);

    const rows: { appearance: string; locale: string; companion: BeatReading; player: BeatReading }[] = [];
    for (const appearance of PAINTED_APPEARANCES) {
      // The appearance is the attribute the stylesheet's second token root selects on:
      // `appearance.ts` writes exactly this, and the token roots are what decide every
      // colour below. Writing it here reads one mounted conversation in both
      // appearances; that the attribute lands is `appearance-theme.spec.ts`'s gate.
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), appearance);
      const reading = await readBeats(page);
      expect(reading.companion, `${appearance}/${locale}: the companion's beat and its speech both rendered`).not.toBeNull();
      expect(reading.player, `${appearance}/${locale}: the player's beat and its speech both rendered`).not.toBeNull();
      rows.push({ appearance, locale, companion: reading.companion!, player: reading.player! });
    }

    // The population is the stylesheet's, not this file's: a third appearance joins the
    // gate by being painted, and the drift below fails loudly instead of leaving it
    // unmeasured.
    const stylesheet = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").replace(
      /\/\*[\s\S]*?\*\//gu,
      " ",
    );
    const painted = [...new Set([...stylesheet.matchAll(/:root\[data-theme="([^"]+)"\]/gu)].map((match) => match[1]))];
    expect(painted.sort(), "this gate measures every appearance the stylesheet paints").toEqual(
      [...PAINTED_APPEARANCES].sort(),
    );

    const table = beatTable(rows);
    record("gate-16", `\n${table}`);

    // The attribute really switched the appearance: two identical readings would let an
    // unstyled page pass every assertion below.
    expect(rows[0]!.companion.bubble, "the two appearances paint different plates").not.toBe(
      rows[1]!.companion.bubble,
    );

    for (const row of rows) {
      // The quieter ink is still body text the player reads: AA on both plates it is drawn on.
      for (const [side, reading] of [
        ["card", row.companion],
        ["plate", row.player],
      ] as const) {
        expect(
          paintedContrast(reading.beat.color, reading.bubble),
          `${row.appearance}/${row.locale}: the beat's ink clears AA on the ${side} bubble\n${table}`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // Two visible channels, on both sides of the conversation, in every appearance
      // and every language. No appearance is exempt.
      for (const [side, reading] of [
        ["companion", row.companion],
        ["player", row.player],
      ] as const) {
        expect(
          distinguishingChannels(reading.beat, reading.speech, BEAT_CHANNELS).length,
          `${row.appearance}/${row.locale}: the ${side} beat and its speech collapse into one visible channel\n${table}`,
        ).toBeGreaterThanOrEqual(2);
      }

      // The slant the product retires is retired for Chinese only, and it is still
      // there in Latin: a fix that re-introduced a faux oblique would pass the channel
      // count and fail here.
      expect(row.companion.beat.fontStyle, `${row.appearance}/${locale}: the beat's slant`).toBe(
        locale === "zh-CN" ? "normal" : "italic",
      );
      expect(row.companion.speech.fontStyle, `${row.appearance}/${locale}: the speech is never slanted`).toBe("normal");
    }

    // The size step is the beat's alone: the paragraph keeps its line boxes, so a reply
    // with a beat and the same words without one are the same shape. Both replies are
    // mounted in this transcript as two companion messages.
    const [withBeat, plain] = await readReflow(page);
    const geometry = `${locale}: with a beat [${withBeat!.map((block) => `${block.height.toFixed(2)}px/${block.lines} lines`).join(", ")}] ` +
      `without [${plain!.map((block) => `${block.height.toFixed(2)}px/${block.lines} lines`).join(", ")}]`;
    record("gate-16-reflow", geometry);
    expect(withBeat!.length, `${locale}: both replies render the same blocks - ${geometry}`).toBe(plain!.length);
    for (const [index, block] of withBeat!.entries()) {
      expect(
        Math.abs(block.height - plain![index]!.height),
        `${locale}: block ${index} keeps its height with a beat in it - ${geometry}`,
      ).toBeLessThanOrEqual(0.5);
      expect(block.lines, `${locale}: block ${index} keeps its line count with a beat in it - ${geometry}`).toBe(
        plain![index]!.lines,
      );
    }
  });
}

/* ========================================================================== *
 * Gate 17: two roles that must be told apart are told apart.
 *
 * WHY THIS GATE EXISTS, in the words of the report it answers: every other
 * contrast gate in this repository asks "can you read this?" - an ink measured
 * against the plate it is drawn on, held to WCAG AA. None asked "can you tell
 * these two apart?". A beat and the speech after it sat 1.59:1 apart while each
 * cleared AA on its own, and in `zh-CN` the product deliberately retires the
 * slant, leaving tracking as the only channel between them. Gate 16 found that
 * pair, but it found ONE pair, in four combinations, and only because a player
 * reported it. A collapse survived every gate this project had because no gate
 * ever measured a pair of ROLES, and none evaluated the combination
 * `appearance x language` - each existing gate sampled one cell.
 *
 * This is the generalisation. The role pairs are DECLARED once, below, each with
 * the reason it matters and the number of independent visible channels that must
 * separate them, and the population of cells is the full cross-product of
 * appearance, language and viewport. Nothing here is a list of cells somebody
 * remembered to write down.
 *
 * Three things about the shape of it:
 *
 *   * A pair this surface does not have yet is declared ABSENT with the reason
 *     and a witness, and the witness is scanned. An absence nobody wrote down is
 *     what this gate exists to prevent, and an exemption nobody re-checks is how
 *     a pair outlives the element it exempted: when the marker appears, the scan
 *     reds and the pair has to be measured.
 *   * Zero population is a failure that names the pair and the selector, never a
 *     pass. A declared selector that resolves to nothing is the shape an
 *     exemption takes when the element it exempted is deleted.
 *   * The failure message is the whole table: every cell, both elements' computed
 *     values, the channels they do and do not share, and which cells fell short.
 *     "expected true, got false" would name nothing a reader could act on.
 * ========================================================================== */

/**
 * A separation this gate cannot read from the two elements' own resting styles.
 *
 * It is a DECLARATION, not an exemption: the channel is named, the reason it is out of a
 * per-element reading's reach is stated, and the page or stylesheet fact it rests on is
 * asserted by the gate. When that fact goes away the pair reds, so the declaration cannot
 * outlive the thing doing the work.
 */
type BeyondChannel = Readonly<{
  /** The channel, as the table prints it: `layout`, `pointer state`. */
  channel: string;
  /** What it is, and why the reading below cannot see it. */
  why: string;
  /**
   * The fact the separation rests on.
   *
   * `ownership` - `a` sits outside every `inside` and `b` inside one: the notice is not a
   * message and the player's words are, so position and ownership separate them.
   * `pointer` - `live` draws a brighter ink while pointed at and `still` never changes:
   * the plate the live control wears exists only in a state this page is not resting in.
   */
  witness:
    | Readonly<{ kind: "ownership"; inside: string }>
    | Readonly<{ kind: "pointer"; live: string; still: string }>;
}>;

/** A pair whose two roles both exist: read both, count the channels between them. */
type MeasuredRolePair = Readonly<{
  kind: "measured";
  /** The pair's declared name. Every failure names it, because it is what a reader acts on. */
  name: string;
  /** Why the pair matters, in one sentence. */
  reason: string;
  /** Every instance of this container is one row of the table. */
  scope: string;
  a: string;
  b: string;
  /** How many of which visible channels the two roles must differ by, at the floors above. */
  channels: ChannelFloor;
  /** What separates them that a resting reading cannot see. Never a substitute for `channels`. */
  beyond?: readonly BeyondChannel[];
}>;

/** A pair this surface does not have, declared so the absence is measured rather than omitted. */
type AbsentRolePair = Readonly<{
  kind: "absent";
  name: string;
  reason: string;
  /** What the pair would look like if it appeared; resolving to anything is a failure, not a pass. */
  witness: readonly string[];
  /** Attribute names that would carry the state if it appeared; the page is swept for them. */
  attributes: readonly RegExp[];
}>;

/**
 * The role pairs this product has, and how each is read.
 *
 * The four are the ones the product actually carries, not an exhaustive census of
 * every pair two elements could form. A pair is here when a player has to act on
 * the difference: which words are hers, which line is the product's own, which
 * control will work, and which conversation they have already read.
 *
 * NO PAIR IS DECLARED WITH FEWER THAN TWO SEPARATIONS. `channels.atLeast` counts what
 * the resting readings show and `beyond` counts what they cannot; the gate adds them and
 * refuses a pair that declares one, because a pair separated by one channel is the class
 * this file exists to catch.
 */
const ROLE_PAIRS: readonly (MeasuredRolePair | AbsentRolePair)[] = [
  {
    kind: "measured",
    name: "beat vs speech",
    reason:
      "a stage direction and the line of dialogue after it must read as two voices in every language, and in zh-CN the product retires the slant on purpose so this pair has one channel fewer than Latin has",
    scope: "li.message .message-bubble:has(em.message-action)",
    a: "em.message-action",
    b: "p:not(:has(em.message-action))",
    // The words are the control this pair is measured against, not a channel: a beat and
    // the speech after it always say different things, so counting `text` would let the
    // 1.59:1 collapse gate 16 was written for pass on its own copy.
    channels: { atLeast: 2, of: ["colour", "weight", "style", "tracking", "size", "opacity", "edge"] },
  },
  {
    kind: "measured",
    name: "system notice vs player text",
    reason:
      "a sentence the product says about the turn must never read as something the player said in it",
    scope: '[data-testid="chat-surface"]',
    a: "p.reference-turn-notice:not([data-testid])",
    b: "li.message.player .message-bubble p:not(:has(em.message-action))",
    // Measured today: `text` (the notice's own sentence against the player's) and `edge`
    // (the 3 px accent bar the notice wears, the bubble's 0). The ink is 200,192,182 against
    // 245,240,232 in the dark appearance and 69,61,55 against 26,22,19 in the light - both
    // under the 3:1 floor, so it is not a second tone; the size step is 13 px against 14 =
    // 7.1%, under the 8% floor. The second channel a reader uses is where the two sit.
    channels: { atLeast: 2, of: ["text", "edge", "colour", "size", "weight", "tracking", "opacity"] },
    beyond: [
      {
        channel: "layout",
        why:
          "the notice is a strip outside the transcript, above the composer; the player's words are a bubble inside a message row - a channel no per-element computed style carries",
        witness: { kind: "ownership", inside: "li.message" },
      },
    ],
  },
  {
    kind: "measured",
    name: "reply we could not read vs the Host's refusal",
    reason:
      "one is this app's own statement that the reply stopped at the model's ceiling, the other is the Host's sentence about why the turn failed - a reader can meet both on one page and must not have to read them twice to tell which side broke",
    scope: '[data-testid="chat-surface"]',
    a: ".message-truncated",
    b: "p.reference-turn-notice:not([data-testid])",
    // Both are quiet 12-13 px secondary copy, so neither is a tone apart: what separates
    // them is the words and the accent bar the Host's own sentence wears.
    channels: { atLeast: 2, of: ["text", "edge", "colour", "size", "weight", "tracking", "opacity"] },
  },
  {
    kind: "measured",
    name: "disabled vs available control",
    reason:
      "a control the player cannot press must not look like one they can, and the pager's arrow with nowhere to go sits beside the one that goes somewhere",
    scope: ".swipe-controls",
    a: ".swipe-btn:disabled",
    b: ".swipe-btn:not(:disabled)",
    // At rest this pair has ONE readable channel: the pointer. The dead arrow asks the
    // browser for `not-allowed` and the live one for `pointer`. Its ink is 144,135,126
    // against 200,192,182 in the dark appearance (1.96:1) and 102,93,84 against 69,61,55
    // in the light (1.65:1) - a tone step under the 3:1 floor, and the sheet says so on
    // purpose: `.swipe-btn:disabled` records that giving the unusable arrow a plate of its
    // own was the shipped defect (`the box appeared exactly when the control became
    // unusable`), and that the two states `differ by tone alone`. So the second channel is
    // the plate the LIVE arrow wears under the pointer, declared below and asserted.
    // The order - the unusable one is never the louder - is
    // `disabled-controls-are-quieter.spec.ts`'s fact, not a second copy of it here.
    channels: { atLeast: 1, of: ["cursor", "colour", "opacity", "weight", "edge"] },
    beyond: [
      {
        channel: "pointer state",
        why:
          "`.swipe-btn:hover:not(:disabled)` brightens the live arrow's ink to --text-primary (a 1.65:1 step in the light appearance, 3.11:1 against the dead arrow's tone) and gives it a --surface-panel plate; the arrow that cannot be pressed never enters that state. A resting page is in neither state, so a computed-style reading at rest cannot see it. The channel is the state change, not a tone: its ink step alone is under this file's 3:1 floor in the light appearance, which is why the plate is printed beside it",
        witness: { kind: "pointer", live: ".swipe-btn:not(:disabled)", still: ".swipe-btn:disabled" },
      },
    ],
  },
  {
    kind: "absent",
    name: "unread vs read indicator",
    reason: "a conversation the player has not read must not look like one they have, so the pair belongs on the Chats list - and it is not there at all: no row, badge or dot in this build carries an unread state",
    witness: [
      "[data-unread]",
      '[data-testid*="unread"]',
      '[aria-label*="unread" i]',
      '[aria-label*="未读"]',
      ".chat-item-unread",
    ],
    attributes: [/unread/iu],
  },
  {
    kind: "absent",
    name: "memory count: not measured vs measured zero",
    reason:
      "a count the Host has not measured must never look like a count of zero, so the notebook's line has to say which one it is - and it is not on this page at all: the memory surface is not mounted by this gate, so the pair cannot be measured here and must not be called measured",
    witness: [
      "[data-memory-count]",
      '[data-memory-state="unavailable"]',
      '[data-memory-state="loading"]',
      '[data-memory-state="error"]',
      ".memory-notebook-count",
    ],
    attributes: [/data-memory-(count|state)/iu],
  },
];

/**
 * A set of roles that must be told apart from EACH OTHER.
 *
 * "Three distinct problems must not share one heading" is not expressible as one pair: it is
 * pairwise over three. A group is therefore declared with every member, and the gate compares
 * each member against each other one instead of naming the pairs somebody thought of.
 */
type RoleGroup = Readonly<{
  kind: "group";
  name: string;
  reason: string;
  /**
   * Every member, and what puts it on the page: the composed boundary's answer to the
   * bootstrap read, which is the one failure the whole-window card is drawn for.
   */
  members: readonly Readonly<{
    name: string;
    refusal: Readonly<{ status: number; body: string }>;
    /** The element the member's own fact is drawn in. */
    role: string;
  }>[];
  /** Channels any two members must differ by. */
  channels: ChannelFloor;
}>;

/**
 * The role groups this product has.
 *
 * One, and it is the problem card. `i18n.ts` says it in the catalogue's own words: three
 * faults a player meets while a chat cannot be read, and three headings, because "the card's
 * `<h1>` is what a player reads first and compares between two failures, so a heading it shares
 * with another fault is the card saying nothing where it must say what". The three are the
 * retryable refusal that clears itself, the reconciliation that needs the read taken again, and
 * the internal fault with a code in the detail - three facts, one card.
 *
 * Rendered, all three go through `ProblemView`'s `<h1>`, so the ONLY channel between them is the
 * words. That is what `text` is for, and it is why the gate compares the heading each one draws
 * rather than assuming the catalogue still says three different things.
 */
const ROLE_GROUPS: readonly RoleGroup[] = [
  {
    kind: "group",
    name: "three problems, three headings",
    reason:
      "a player compares the card's heading between two failures, so two different faults that print the same heading are the card saying nothing where it must say what",
    members: [
      {
        // The Host refused with a code it declares: the reconciliation fact.
        name: "the chat could not be reconciled",
        refusal: { status: 503, body: JSON.stringify({ code: "state_reconciliation_required" }) },
        role: ".problem-card h1",
      },
      {
        // A refusal the client can retry but cannot name: it clears itself.
        name: "the read can be taken again",
        refusal: { status: 503, body: JSON.stringify({ code: "gate_not_a_declared_code" }) },
        role: ".problem-card h1",
      },
      {
        // A body the client mirror refuses: this build's own fault, with a code in the detail.
        name: "this build could not read the Host",
        refusal: { status: 200, body: "not a composed state document" },
        role: ".problem-card h1",
      },
    ],
    channels: { atLeast: 1, of: ["text"] },
  },
];

/**
 * The languages every pair is measured in, and the two window sizes.
 *
 * The sizes are the narrowest and the widest member of `VIEWPORTS` above - the two
 * ends where a channel is likeliest to disappear, one to the fold and one to the
 * reading measure. The drift check below keeps them members instead of letting this
 * list quietly describe a window the rest of the file stopped testing.
 */
const ROLE_LOCALES = ["en", "zh-CN"] as const;
const ROLE_VIEWPORTS: readonly Readonly<{ width: number; height: number }>[] = [
  { width: 400, height: 800 },
  { width: 1440, height: 900 },
];

/**
 * The reply this gate reads, per language: a beat and the speech after it on both
 * sides of the conversation, in the shape a companion and a player actually write.
 */
const ROLE_REPLY = {
  en: {
    companion: "*nods slowly*\n\nShe looks up from the ledger.",
    player: "*taps the map*\n\nLet us take the north road.",
    afterCut: "The north road it is, then.",
  },
  "zh-CN": {
    companion: "*轻轻点头*\n\n她从账本上抬起头。",
    player: "*敲了敲地图*\n\n我们走北边那条路。",
    afterCut: "那就走北边。",
  },
} as const;

/** One cell's reading of one declared pair, as the table prints it. */
type RoleTableEntry = Readonly<{
  cell: string;
  pair: string;
  reading: RolePairReading;
  beyond: readonly BeyondReading[];
}>;

/**
 * What a `beyond` channel's witness found.
 *
 * `rendering` is what the table prints, so the declared channel is visible in every cell and
 * not only in the file; `failures` is what went away.
 */
type BeyondReading = Readonly<{ rendering: string; failures: readonly string[] }>;

/** Every cell of one pair: both elements' own values, the channels between them, and why any are missing. */
function roleTable(entries: readonly RoleTableEntry[], of: readonly RoleChannel[]): string {
  return entries
    .flatMap(({ cell, reading, beyond }) => [
      ...reading.problems.map((problem) => `${cell}: ${problem}`),
      ...reading.rows.map((row) => {
        const channels = distinguishingChannels(row.a, row.b, of);
        return (
          `${cell} ${row.instance}: a{${roleVoice(row.a)}} b{${roleVoice(row.b)}} ` +
          `channels [${channels.join(", ") || "none"}] = ${channels.length}`
        );
      }),
      ...beyond.map((one) => `${cell} beyond ${one.rendering}`),
    ])
    .join("\n");
}

/** What an absent pair's witness scan found: the declared shapes, the attribute sweep, and the population. */
type UnreadWitnessScan = Readonly<{
  examined: number;
  selectors: readonly Readonly<{ selector: string; matches: number }>[];
  attributes: readonly string[];
}>;

/**
 * Asserts the page fact a declared `beyond` channel rests on, and says what it found.
 *
 * The witness is the whole point of the declaration: a channel named in a comment is a
 * sentence, a channel whose fact is read back from the page is a gate. Both shapes are
 * measured on the real page - ownership by asking which element contains each role, the
 * pointer state by pointing at the live control and re-reading it.
 */
async function readBeyond(page: Page, pair: MeasuredRolePair): Promise<readonly BeyondReading[]> {
  const readings: BeyondReading[] = [];
  for (const beyond of pair.beyond ?? []) {
    if (beyond.witness.kind === "ownership") {
      const { inside } = beyond.witness;
      const found = await page.locator(pair.scope).first().evaluate(
        (container, selectors) => {
          const left = container.querySelector(selectors.a);
          const right = container.querySelector(selectors.b);
          return {
            aOutside: left !== null && left.closest(selectors.inside) === null,
            bInside: right !== null && right.closest(selectors.inside) !== null,
          };
        },
        { a: pair.a, b: pair.b, inside },
      );
      readings.push({
        rendering: `${beyond.channel}: a outside \`${inside}\` -> ${found.aOutside}, b inside -> ${found.bInside}`,
        failures: [
          ...(found.aOutside
            ? []
            : [`${beyond.channel}: a \`${pair.a}\` now sits inside \`${inside}\`, so the declared separation is gone`]),
          ...(found.bInside ? [] : [`${beyond.channel}: b \`${pair.b}\` no longer sits inside \`${inside}\``]),
        ],
      });
      continue;
    }
    const scope = page.locator(pair.scope).first();
    const live = scope.locator(beyond.witness.live);
    const still = scope.locator(beyond.witness.still);
    // The ink and the plate, because a hover in this product is both: the live arrow
    // brightens to `--text-primary` AND gains a `--surface-panel` plate.
    const paintOf = (element: Element): Readonly<{ ink: string; plate: string }> => ({
      ink: getComputedStyle(element).color,
      plate: getComputedStyle(element).backgroundColor,
    });
    const restingLive = await live.evaluate(paintOf);
    const restingStill = await still.evaluate(paintOf);
    await live.hover();
    const pointedLive = await live.evaluate(paintOf);
    const pointedStill = await still.evaluate(paintOf);
    await still.hover();
    const hoveredStill = await still.evaluate(paintOf);
    // Put the pointer back off both controls, so the next cell is read at rest.
    await page.mouse.move(0, 0);
    const separation = paintedContrast(pointedLive.ink, pointedStill.ink);
    // The channel is the STATE CHANGE, not a tone: pointing at the live control changes its
    // picture and pointing at the inert one changes nothing. The separation is printed
    // because it is the strength of that change, and in the light appearance it is under
    // the tone floor this file uses elsewhere - the plate is what a reader actually sees.
    const liveAnswers = pointedLive.ink !== restingLive.ink || pointedLive.plate !== restingLive.plate;
    const stillIgnores =
      hoveredStill.ink === restingStill.ink && hoveredStill.plate === restingStill.plate;
    readings.push({
      rendering:
        `${beyond.channel}: live ${restingLive.ink} on ${restingLive.plate} -> pointed ${pointedLive.ink} on ${pointedLive.plate}; ` +
        `dead ${restingStill.ink} -> pointed ${hoveredStill.ink} (${stillIgnores ? "unchanged" : "answers"}); ` +
        `live-vs-dead while pointed ${separation.toFixed(2)}:1`,
      failures: [
        ...(liveAnswers
          ? []
          : [`${beyond.channel}: pointing at \`${beyond.witness.live}\` changes nothing, so the state only this role enters is gone`]),
        ...(stillIgnores
          ? []
          : [`${beyond.channel}: \`${beyond.witness.still}\` answers the pointer now, so it is no longer the inert role`]),
      ],
    });
  }
  return readings;
}

for (const locale of ROLE_LOCALES) {
  test(`gate 17: every declared role pair is told apart in every appearance and size (${locale})`, async ({ page }) => {
    const reply = ROLE_REPLY[locale];
    if (locale === "zh-CN") await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
    await mountShell(page, {
      root: composedRoot({
        transcript: [
          { role: "companion", text: reply.companion },
          { role: "player", text: reply.player },
          // A third row so the transcript ENDS on a companion message: that is the row the
          // "stopped at the ceiling" note is drawn on (Timeline's `truncatedHandle`), and it
          // carries no beat, so the beat pair's population is unchanged.
          { role: "companion", text: reply.afterCut },
        ],
        // The greeting set is open on the first message, so its pager is a real control
        // pair in one strip: the arrow with nowhere to go beside the one that goes
        // somewhere. That is the product's own disabled state, not a styled div.
        opening: true,
        // A settled turn is what earns the surface's own notice line - the one sentence
        // on this page that the product says rather than the player. It failed for a cause
        // the Host named, AND its reply stopped at the model's ceiling: the two facts the
        // "could not read the reply" pair is about, on one page.
        turn: {
          handle: handleFor(1),
          state: "failed",
          projectionRevision: 7,
          canCancel: false,
          providerFailure: "endpoint_unreachable",
          truncated: true,
        },
      }),
    });
    if (locale === "zh-CN") await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await freezeTransitions(page);

    // The three live witnesses have to be on the page before anything is measured. A
    // fixture that lost one is the population zero below, named, not a silent exemption.
    await expect(page.locator("li.message.companion em.message-action")).toHaveCount(1);
    await expect(page.locator("li.message.player em.message-action")).toHaveCount(1);
    await expect(page.locator("p.reference-turn-notice:not([data-testid])")).toHaveCount(1);
    await expect(page.locator(".message-truncated")).toHaveCount(1);
    await expect(page.locator(".swipe-controls")).toHaveCount(1);

    const measured = ROLE_PAIRS.filter((pair): pair is MeasuredRolePair => pair.kind === "measured");
    const entries: RoleTableEntry[] = [];
    for (const viewport of ROLE_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const appearance of PAINTED_APPEARANCES) {
        // The appearance is the attribute the stylesheet's second token root selects on;
        // the token roots are what decide every colour and size below.
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), appearance);
        const cell = `${appearance}/${locale}/${viewport.width}x${viewport.height}`;
        for (const pair of measured) {
          // The resting reading first, then the witnesses: a hover would move the ink the
          // resting reading is about.
          const reading = await readRolePair(page, pair);
          entries.push({ cell, pair: pair.name, reading, beyond: await readBeyond(page, pair) });
        }
      }
    }

    // The window sizes are the file's own declared population, not a second one.
    for (const viewport of ROLE_VIEWPORTS) {
      expect(
        VIEWPORTS.some((each) => each.width === viewport.width && each.height === viewport.height),
        `${viewport.width}x${viewport.height} is one of the sizes this file tests`,
      ).toBe(true);
    }

    // Every pair is read and printed before anything is asserted: one failing pair must
    // not hide another's table, which is the whole point of printing them.
    const failures: string[] = [];
    const renderings: string[] = [];
    for (const pair of measured) {
      const cells = entries.filter((entry) => entry.pair === pair.name);
      const rendering = roleTable(cells, pair.channels.of);
      record(`gate-17 ${pair.name}`, `\n${rendering}`);
      const beyond = pair.beyond ?? [];
      const required = `${pair.channels.atLeast} of [${pair.channels.of.join(", ")}] + beyond [${beyond.map((one) => one.channel).join(", ") || "none"}]`;
      renderings.push(`${pair.name}: ${required} - ${pair.reason}\n${rendering}`);
      // A pair separated by one channel in total is the class this file exists to catch:
      // the declared channels and the declared `beyond` channels have to reach two.
      if (pair.channels.atLeast + beyond.length < 2) {
        failures.push(`${pair.name}: declared with ${pair.channels.atLeast + beyond.length} separation(s), and a pair needs two`);
      }
      for (const entry of cells) {
        for (const problem of entry.reading.problems) failures.push(`${pair.name} ${entry.cell}: ${problem}`);
        for (const one of entry.beyond) {
          for (const problem of one.failures) failures.push(`${pair.name} ${entry.cell}: ${problem}`);
        }
        if (entry.reading.rows.length === 0) {
          failures.push(
            `${pair.name} ${entry.cell}: zero population - \`${pair.a}\` / \`${pair.b}\` under \`${pair.scope}\` measured nothing, so nothing about this pair is known here`,
          );
        }
        for (const row of entry.reading.rows) {
          const channels = distinguishingChannels(row.a, row.b, pair.channels.of);
          if (channels.length < pair.channels.atLeast) {
            failures.push(
              `${pair.name} ${entry.cell} ${row.instance}: ${channels.length} visible channel(s) ` +
                `[${channels.join(", ") || "none"}] of [${pair.channels.of.join(", ")}], ${pair.channels.atLeast} required`,
            );
          }
        }
      }
    }
    // Soft assertions, because a gate that must print every pair's table cannot let the
    // first pair's failure swallow the other two: all three verdicts come out of one run.
    expect
      .soft(failures, `the declared role pairs are not all told apart\n\n${renderings.join("\n\n")}`)
      .toEqual([]);

    for (const pair of ROLE_PAIRS.filter((each): each is AbsentRolePair => each.kind === "absent")) {
      const scan = await page.evaluate(
        (declared): UnreadWitnessScan => {
          const attributes: string[] = [];
          const all = [...document.querySelectorAll("*")];
          const names = declared.attributes.map((source) => new RegExp(source, "iu"));
          for (const element of all) {
            for (const attribute of element.getAttributeNames()) {
              if (names.some((each) => each.test(attribute))) attributes.push(`${element.tagName.toLowerCase()}[${attribute}]`);
            }
          }
          return {
            examined: all.length,
            selectors: declared.witness.map((selector) => ({ selector, matches: document.querySelectorAll(selector).length })),
            attributes,
          };
        },
        { witness: pair.witness, attributes: pair.attributes.map((each) => each.source) },
      );
      const rendering =
        `examined ${scan.examined} element(s); ` +
        scan.selectors.map(({ selector, matches }) => `${selector} -> ${matches}`).join(", ") +
        `; attributes naming the state -> ${scan.attributes.join(", ") || "none"}`;
      record(`gate-17 ${pair.name}`, `absent (${pair.reason})\n${rendering}`);
      // A scan that looked at nothing agrees with itself.
      expect
        .soft(scan.examined, `${pair.name}: the page was empty, so this absence was not measured\n${rendering}`)
        .toBeGreaterThan(0);
      expect
        .soft(
          [...scan.selectors.filter(({ matches }) => matches > 0), ...scan.attributes],
          `${pair.name} is declared absent (${pair.reason}), and the witness now resolves - measure it instead\n${rendering}`,
        )
        .toEqual([]);
    }
  });
}

/* ========================================================================== *
 * Gate 18, the group half: three distinct problems are three distinct headings.
 *
 * The pairs above ask whether two roles can be told apart on ONE page. This asks the
 * other shape the audit found: three different faults that each get the whole-window
 * card, one at a time, and must still be three different headings - because the card's
 * `<h1>` is what a player compares between two failures.
 *
 * The population is the declaration: every member is mounted, and every pair of members
 * is compared. A member whose selector resolves to nothing is named as a member that is
 * not on the page (a group that quietly measured two of its three members is the same
 * false pass as a pair that measured neither), and two members the declared channels
 * cannot separate are the collapse, reported with the words both of them said.
 * ========================================================================== */
for (const locale of ROLE_LOCALES) {
  test(`gate 18: every declared role group is told apart member by member (${locale})`, async ({ page }) => {
    if (locale === "zh-CN") await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
    const failures: string[] = [];
    for (const group of ROLE_GROUPS) {
      // A group of one is pairwise over nothing, which is the zero population this file
      // refuses everywhere else.
      if (group.members.length < 2) {
        failures.push(
          `${group.name}: declared with ${group.members.length} member(s), and a group is told apart pairwise - one member compares with nothing`,
        );
      }
      // A group that requires no channel separates nothing: every pair of members would pass
      // on the declaration's own arithmetic, which is the exemption this file refuses.
      if (group.channels.atLeast < 1) {
        failures.push(
          `${group.name}: declared with ${group.channels.atLeast} required channel(s), so no two members have to differ at all`,
        );
      }
      const readings: { member: string; reading: RoleReading }[] = [];
      for (const member of group.members) {
        // The failure that puts this member's own fact on the page: the composed
        // boundary's answer to the read that opens the shell. The later handler wins,
        // so each member re-answers the same route.
        await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
          route.fulfill({ status: member.refusal.status, contentType: "application/json", body: member.refusal.body }),
        );
        // A real load per member: a same-document hash change would keep the first
        // member's failure on screen and make all three read alike, which is exactly the
        // false collapse this gate must not report.
        await page.goto("about:blank");
        await page.goto(`/#profile=composed-reference-game&boot=${token}`);
        await expect(page.locator(".problem-card")).toBeVisible();
        await freezeTransitions(page);
        // Exactly one element, named: a member whose role resolves to nothing is otherwise
        // a Playwright timeout about a locator, which names neither the group nor the member.
        const found = page.locator(member.role);
        const count = await found.count();
        if (count !== 1) {
          failures.push(
            `${group.name} (${locale}) member "${member.name}": \`${member.role}\` resolved to ${count} element(s), ` +
              `so this member is not on the page and the group cannot be told apart`,
          );
          continue;
        }
        readings.push({ member: member.name, reading: await found.evaluate(roleReadingOf) });
      }
      const table = readings
        .map(({ member, reading }) => `${member}: ${group.members.find((each) => each.name === member)?.role}{${roleVoice(reading)}}`)
        .join("\n");
      record(`gate-18 ${group.name}`, `\n${table}`);
      // Every ordered pair of members, so "two of the three are the same" cannot hide
      // behind which two somebody remembered to name.
      for (const [index, left] of readings.entries()) {
        for (const right of readings.slice(index + 1)) {
          const channels = distinguishingChannels(left.reading, right.reading, group.channels.of);
          if (channels.length < group.channels.atLeast) {
            failures.push(
              `${group.name} (${locale}): "${left.member}" and "${right.member}" are not told apart - ` +
                `${channels.length} channel(s) [${channels.join(", ") || "none"}] of ` +
                `[${group.channels.of.join(", ")}], ${group.channels.atLeast} required; ` +
                `a said "${left.reading.text}", b said "${right.reading.text}"`,
            );
          }
        }
      }
    }
    expect.soft(failures, `the declared role groups are not told apart\n\n${recordingsFor(ROLE_GROUPS)}`).toEqual([]);
  });
}

/** The groups, as a failure message can carry them: every member and the words it is meant to say. */
function recordingsFor(groups: readonly RoleGroup[]): string {
  return groups
    .map((group) => `${group.name}: ${group.reason}\n${group.members.map((member) => `  - ${member.name}`).join("\n")}`)
    .join("\n\n");
}
