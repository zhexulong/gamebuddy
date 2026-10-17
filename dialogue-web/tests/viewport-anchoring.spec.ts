/**
 * The viewport contract: the page never scrolls, the frame fills the window, and
 * the one scroller is inside the surface.
 *
 * The failure this pins: a box whose height is driven by its content instead of
 * by the viewport. The chain in `style.css` only means anything when an ancestor
 * hands it a definite height (`html`/`body` are `100dvh`, the mount root is the
 * frame, the shell is a flex column, the main region and the surface are
 * `flex: 1 1 0%` children with `min-height: 0`, and exactly one element under the
 * surface scrolls). Break any one link and the same markup reads two ways
 * depending on how much content it happens to hold: with little content the
 * surface is a short box in a tall window ("only half the screen loads"), and
 * with a lot the surface is taller than the window and its lower half - the
 * composer band - is pushed past the bottom edge and clipped unreachable by the
 * `overflow: hidden` above it ("it grows past the browser").
 *
 * Both halves are asserted here, because the product's page and a page that
 * mounts the same surface without the shell are the same contract:
 *
 * - the shipped shell (`#profile=composed-reference-game`, the route-mocked
 *   mount every journey in this suite uses) is measured with a real transcript,
 *   so the surface has content to overflow with;
 * - `tests/chat-surface-probe.html` mounts the real `Timeline` and `Composer`
 *   with the real stylesheet and no shell at all, which is the page where the
 *   mount root is the only link that can supply the frame.
 *
 * A document-level measurement alone is not enough for either: the app hides its
 * own overflow, so an element can sit outside the window while
 * `documentElement.scrollHeight` still reports the viewport height. That is why
 * every box is read with `getBoundingClientRect` as well as the document
 * scrollers, and why a surface box that reaches past the window fails here even
 * though the page itself cannot be scrolled.
 */
import { expect, test, type Page } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

/** The six sizes the owner's report names: desktop, laptop, the 816px strip, and the phone-strip widths. */
const VIEWPORTS: readonly Readonly<{ width: number; height: number }>[] = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 900, height: 700 },
  { width: 816, height: 767 },
  { width: 480, height: 900 },
  { width: 400, height: 800 },
];

const MESSAGE_COUNT = 12;

function transcriptHandle(index: number): string {
  return `M${String(index).padStart(2, "0")}${"A".repeat(40)}`.slice(0, 42) + "A";
}

/** Alternating prose that fills the transcript: the surface must have content to overflow with. */
function transcriptTexts(count: number): string[] {
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    texts.push(
      index % 2 === 0
        ? `Where should we go next? ${"I want to check the crops and then walk into town. ".repeat(3)}`
        : `${"*nods slowly* "}The morning light comes over the ridge. ${"A long reply about the farm, the town and the season ahead. ".repeat(3)}`,
    );
  }
  return texts;
}

function composedRoot() {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: {
      apiVersion: 1,
      build: {
        browserContract: "tavern_browser_api/v1",
        profileId: "gamebuddy.chat-core.reference-pipeline",
      },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
        title: "Viewport",
        transcript: transcriptTexts(MESSAGE_COUNT).map((text, index) => ({
          handle: transcriptHandle(index),
          role: index % 2 === 0 ? "player" : "companion",
          text,
          locale: "en",
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

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mountComposedShell(page: Page): Promise<void> {
  const root = composedRoot();
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

type Box = Readonly<{ top: number; left: number; right: number; bottom: number; width: number; height: number }>;

type ChainMeasurement = Readonly<{
  innerWidth: number;
  innerHeight: number;
  documentScrollWidth: number;
  documentScrollHeight: number;
  bodyScrollWidth: number;
  bodyScrollHeight: number;
  frame: Box & Readonly<{ display: string; minHeight: string; overflow: string }>;
  shell: Box & Readonly<{ computedHeight: string; overflow: string }>;
  main: Box;
  surface: Box;
  transcript: Box & Readonly<{ clientHeight: number; scrollHeight: number; overflowY: string }>;
  composer: Box;
}>;

/**
 * Runs in the page: the boxes and the scrollers of the chain, in one pass. The
 * document scrollers are read alongside the boxes because the shell hides its own
 * overflow, where a document-level reading alone reports the viewport while a
 * box is already outside it.
 */
function measureChain(): ChainMeasurement {
  const box = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const must = (selector: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`viewport-anchoring: ${selector} is not rendered`);
    return element;
  };
  const documentElement = document.documentElement;
  const frame = must("#root, #probe-root");
  const shell = must(".tavern-app-shell, #probe-root");
  const main = must("main#main-content, #probe-root");
  const surface = must('[data-testid$="-surface"], #probe-root');
  const transcript = must(".timeline");
  const composer = must(".composer-section");
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentScrollWidth: documentElement.scrollWidth,
    documentScrollHeight: documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
    frame: { ...box(frame), display: getComputedStyle(frame).display, minHeight: getComputedStyle(frame).minHeight, overflow: getComputedStyle(frame).overflow },
    shell: { ...box(shell), computedHeight: getComputedStyle(shell).height, overflow: getComputedStyle(shell).overflow },
    main: box(main),
    surface: box(surface),
    transcript: {
      ...box(transcript),
      clientHeight: transcript.clientHeight,
      scrollHeight: transcript.scrollHeight,
      overflowY: getComputedStyle(transcript).overflowY,
    },
    composer: box(composer),
  };
}

/** One honest sentence per broken link, so a failing run names the size and the box. */
function chainFailures(at: string, viewport: Readonly<{ width: number; height: number }>, measured: ChainMeasurement): string[] {
  const failures: string[] = [];
  const tolerance = 1;
  if (measured.frame.display !== "flex")
    failures.push(
      `${at}: the mount root is ${measured.frame.display}, not a frame, so every \`flex: 1 1 0%\` and \`min-height: 0\` under it is inert`,
    );
  if (measured.frame.minHeight !== "0px")
    failures.push(`${at}: the mount root cannot shrink to its frame (min-height ${measured.frame.minHeight})`);
  if (measured.documentScrollHeight > viewport.height + tolerance)
    failures.push(`${at}: the page scrolls vertically (documentElement.scrollHeight ${measured.documentScrollHeight} > innerHeight ${viewport.height})`);
  if (measured.documentScrollWidth > viewport.width + tolerance)
    failures.push(`${at}: the page scrolls sideways (documentElement.scrollWidth ${measured.documentScrollWidth} > innerWidth ${viewport.width})`);
  if (measured.bodyScrollHeight > viewport.height + tolerance)
    failures.push(`${at}: body overflows the window (body.scrollHeight ${measured.bodyScrollHeight} > innerHeight ${viewport.height})`);
  if (measured.bodyScrollWidth > viewport.width + tolerance)
    failures.push(`${at}: body overflows the window sideways (body.scrollWidth ${measured.bodyScrollWidth} > innerWidth ${viewport.width})`);
  if (measured.shell.height < viewport.height - tolerance)    failures.push(`${at}: the frame does not fill the window (height ${measured.shell.height} < innerHeight ${viewport.height})`);
  if (measured.shell.bottom > viewport.height + tolerance)
    failures.push(`${at}: the frame runs past the window (bottom ${measured.shell.bottom} > innerHeight ${viewport.height})`);
  if (measured.main.bottom > viewport.height + tolerance)
    failures.push(`${at}: the main region runs past the window (bottom ${measured.main.bottom} > innerHeight ${viewport.height})`);
  if (measured.surface.bottom > viewport.height + tolerance)
    failures.push(`${at}: the surface runs past the window (bottom ${measured.surface.bottom} > innerHeight ${viewport.height})`);
  if (measured.surface.right > viewport.width + tolerance)
    failures.push(`${at}: the surface runs past the window sideways (right ${measured.surface.right} > innerWidth ${viewport.width})`);
  if (measured.transcript.bottom > viewport.height + tolerance)
    failures.push(`${at}: the transcript runs past the window (bottom ${measured.transcript.bottom} > innerHeight ${viewport.height})`);
  if (measured.transcript.clientHeight >= measured.transcript.scrollHeight)
    failures.push(
      `${at}: the transcript is not the scroller, so its box is content-driven (clientHeight ${measured.transcript.clientHeight} >= scrollHeight ${measured.transcript.scrollHeight})`,
    );
  if (measured.composer.top >= viewport.height - tolerance)
    failures.push(`${at}: the composer band is below the window (top ${measured.composer.top} >= innerHeight ${viewport.height})`);
  if (measured.composer.bottom > viewport.height + tolerance)
    failures.push(`${at}: the composer band runs past the window (bottom ${measured.composer.bottom} > innerHeight ${viewport.height})`);
  return failures;
}

test("the shipped shell fills the viewport in both axes, at every size", async ({ page }) => {
  await mountComposedShell(page);
  const failures: string[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const measured = await page.evaluate(measureChain);
    const at = `${viewport.width}x${viewport.height}`;
    // The shell is a frame of its own, not a child of the document flow: it must
    // be the window's height exactly, and its own computed height is what says so.
    if (measured.shell.computedHeight !== `${viewport.height}px`)
      failures.push(`${at}: the shell's computed height is ${measured.shell.computedHeight}, not the window's ${viewport.height}px`);
    failures.push(...chainFailures(at, viewport, measured));
  }
  expect(failures, "the shell must be anchored to the viewport, whatever the transcript weighs").toEqual([]);
});

test("a page that mounts the chat surface without the shell anchors it too", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS[0]);
  await page.goto("/tests/chat-surface-probe.html");
  await expect(page.locator(".timeline")).toBeVisible();
  // The probe is the real Timeline and Composer with the real stylesheet, driven
  // from the page: without a transcript the surface is short enough to look
  // right for the wrong reason, so the content is committed first.
  await page.evaluate((texts: string[]) => {
    const probe = (window as unknown as { chatProbe: { setTranscript(value: readonly string[]): void } }).chatProbe;
    probe.setTranscript(texts);
  }, transcriptTexts(MESSAGE_COUNT));
  await expect(page.locator(".message-list li").first()).toBeVisible();

  const failures: string[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const measured = await page.evaluate(measureChain);
    const at = `${viewport.width}x${viewport.height}`;
    failures.push(...chainFailures(at, viewport, measured));
  }
  expect(failures, "the chat surface must be viewport-anchored on every page that mounts it").toEqual([]);
});
