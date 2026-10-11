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
 *
 * The two contracts this file once pinned as `test.fixme` are met: `Escape`
 * returns focus to the conversation's composer, and a 250-character companion
 * name wraps in the transcript's author line. Both gates run as normal tests.
 */
import { expect, test, type Page } from "@playwright/test";

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
  /** Marks the first companion message as the committed variant of a swipe set. */
  swipe?: boolean;
}>;

function handleFor(index: number): string {
  return `M${String(index).padStart(2, "0")}${"A".repeat(40)}`.slice(0, 42);
}

function composedRoot(options: FixtureOptions = {}) {
  const transcript = options.transcript ?? DEFAULT_TRANSCRIPT;
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
        companion: { name: options.companionName ?? "Mira" },
        title: options.title === undefined ? "Gate Chat" : options.title,
        transcript: transcript.map((message, index) => ({
          handle: handleFor(index),
          role: message.role,
          text: message.text,
          locale: "en",
          order: index,
          revision: 1,
          ...(options.swipe === true && message.role === "companion" && index === 0
            ? { swipeInfo: { currentIndex: 1, totalSwipes: 2, label: "1/2", hasPrevious: true, hasNext: true } }
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
    delayed(slow.memory, { apiVersion: 1, projectionRevision, memories: [] }),
  );
  await page.route("**/api/tavern/v1/world-info", delayed(undefined, { state: "none", revision: worldBookRevision, items: [] }));
  await page.route(
    "**/api/tavern/v1/settings/voice-preference",
    delayed(undefined, { revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
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
      chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
      game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
      recommendedModels: [],
    }),
  );
  await page.route("**/api/tavern/v1/companions", delayed(undefined, { apiVersion: 1, companions: [] }));
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

async function openSurface(page: Page, surface: Readonly<{ label: string; testId: string }>): Promise<void> {
  await page.getByRole("button", { name: surface.label, exact: true }).click();
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
      const root = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
      const leaves = [...root.querySelectorAll<HTMLElement>("*")].filter((element) => {
        if (element.children.length > 0) return false;
        if ((element.textContent ?? "").trim().length === 0) return false;
        if (element.getClientRects().length === 0) return false;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.opacity === "0") return false;
        return true;
      });
      return leaves.map((element) => {
        const style = getComputedStyle(element);
        const background = effective(element);
        const size = Number.parseFloat(style.fontSize);
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        return {
          text: (element.textContent ?? "").trim().slice(0, 32),
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
  await resetFocusToTop(page);
  let onComposer = false;
  for (let press = 0; press < 16 && !onComposer; press += 1) {
    await page.keyboard.press("Tab");
    onComposer = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("composer-textarea") ?? false);
  }
  expect(onComposer, "the composer is reachable with Tab alone").toBe(true);
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
 * region - no companion, no line - and a conversation whose own heading reads as
 * the untitled placeholder, so the player cannot tell what they are looking at.
 * The zero state is the first screen a new player sees; "it is technically not
 * blank" is the bar it has to clear, not the target.
 */
test("gate 7: a new conversation is titled for real and opens on a real empty state", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ transcript: [], title: null }) });

  const measured = await page.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>("[data-empty-anchor]");
    const heading = document.querySelector<HTMLElement>(".timeline-heading h1");
    const timeline = document.querySelector<HTMLElement>(".timeline");
    const surface = document.querySelector<HTMLElement>('[data-testid="chat-surface"]');
    return {
      heading: (heading?.textContent ?? "").trim(),
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
  if (["", "Untitled chat", "未命名聊天"].includes(measured.heading))
    failures.push(`the conversation title is the untitled placeholder "${measured.heading}"`);

  record(
    "gate-7",
    `heading="${measured.heading}"; zero state ${Math.round(measured.anchorHeight)}/${Math.round(measured.timelineHeight)}px; ${failures.length} failure(s)`,
  );
  expect(failures, "a new conversation is titled for real and opens on a real zero state").toEqual([]);
});

/**
 * Gate 8: the regenerate control is a control, and the swipe pair reads with it.
 *
 * The capture run measured it at 75x21 px, an 11 px label, a transparent
 * background and no border - the smallest interactive target and the smallest
 * type anywhere in the product, on the one control that repeats a companion's
 * answer. The failure this catches: a control that is only a caption-sized muted
 * text row, invisible as an affordance and unusable as a target, beside a swipe
 * pair that is not the same kind of thing.
 */
test("gate 8: the regenerate control clears the touch floor with a visible affordance", async ({ page }) => {
  await mountShell(page, { root: composedRoot({ swipe: true }) });

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
    return { regenerate: read(".regenerate-btn"), group: read(".swipe-controls"), button: read(".swipe-btn") };
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
  // The swiped variant's pair sits in the same message, so it keeps the same
  // floor and the same visible affordance - one control group, not two species.
  for (const [what, node] of [
    ["the swipe group", measured.group],
    ["a swipe button", measured.button],
  ] as const) {
    if (node === null) {
      failures.push(`${what} is not rendered for a swiped message`);
      continue;
    }
    if (node.height < 44) failures.push(`${what} is ${node.height}px tall, under the 44px floor the regenerate control keeps`);
  }
  if (measured.group !== null && transparent.includes(measured.group.backgroundColor))
    failures.push(`the swipe group computes to a transparent background (${measured.group.backgroundColor})`);

  record(
    "gate-8",
    `regenerate ${measured.regenerate?.width}x${measured.regenerate?.height} @${measured.regenerate?.fontSize}px bg=${measured.regenerate?.backgroundColor}; swipe group ${measured.group?.height}px / button ${measured.button?.height}px; ${failures.length} failure(s)`,
  );
  expect(failures, "the regenerate control is a real target and the swipe pair matches it").toEqual([]);
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
