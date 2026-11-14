import { type Page, expect, test } from "./frontend-coverage";
import { draft, jsonOk, root, token } from "./composed-reference-game-fixtures";
import { LEADING_SURFACE_COUNT } from "../src/components/surface-bar-entries";
import { DESKTOP, PHONE, VIEWPORT_SIZES } from "./viewport-policy";

/**
 * The AppBar's shape is a fact about the AppBar's own width, not about the window's.
 *
 * THE DEFECT. Five width rules in `style.css` decide what the bar gives up as it runs out of
 * room, and every one of them was written as `@media (max-width: ...)` - a VIEWPORT fact:
 * the rail's labels retired at 860, the wordmark at 640, its own air and the status word at
 * 480, and the trailing peers folded behind one `More` at 860. The bar's budget, though, is
 * the width of the box it is laid out in. When the shell is narrower than the window - the
 * companion docked beside the game rather than filling a window of its own - a 400 px bar sat
 * inside a 1440 px viewport, no query fired, and the six peers, the companion's name and the
 * status dot were squeezed into a strip that never declared itself a strip.
 *
 * WHAT IS MEASURED, and why it is a pair rather than a size: the same bar width is produced
 * two ways - naturally, by a window of that width, and docked, by holding a 1440 px window and
 * constraining the shell to it - and the two readings must agree on everything the bar does
 * with the width it has. That is the invariant the container query states, so a spec that
 * asserted "at 400 px the bar folds" would pass on the defect whenever a window happened to be
 * 400 px wide. The pair fails on it, and the failure names the width, the window and both
 * shapes.
 *
 * THE POPULATION is `VIEWPORT_SIZES`: the bar's fold sits on one of the widths the shipped
 * sheet already declares, so every declared cell is a width the bar must read the same way in
 * either frame. The docked side is derived from the same cells - the bar is constrained to the
 * cell's width, not to a second list of widths - so a new cell joins this file without an edit.
 *
 * WHAT THIS FILE DOES NOT ASSERT, stated so a green run is not read as more than it is: that a
 * wide bar never truncates the companion's name. It does - measured at the 1024 and 900 px cells
 * of the declared population, where the seven worded peers leave the name 10 px and 0 px - and
 * that is a fact about the fold height rather than about which box the fold asks, so it is
 * reported by the run's own output and left to the owner who chose that height. What is asserted
 * of every cell is that the WINDOW and the DOCK agree, which is the one thing this change moves.
 *
 * red-proof: inject  put the shell's five width rules back as `@media (max-width: Npx)` ->
 *   `a 400px bar inside a 1440px window did not fold: {"viewport":1440,"bar":400,"folded":false,
 *   "peers":7,"titleWidth":0,"titleOverBy":127}` and, per declared cell, `a 816px bar is unfolded
 *   in a 1440px window, and folded in a 816px one` (run at the commit that added this file, before
 *   the sheet was changed).
 */
const COMPANION_NAME = "Amber Nightshade";

/**
 * The mounted root: the shared fixture, with a companion name long enough to truncate.
 *
 * The name is a parameter of the fixture rather than of this file's assertions: "the name is
 * whole" is only a claim a bar can fail when the name is longer than the room a squeezed bar
 * gives it (`app-bar-status-narrow.spec.ts` states the same reading for its own sweep).
 */
function rootWithLongName(): unknown {
  return {
    ...root,
    chat: { ...root.chat, chat: { ...root.chat.chat, companion: { ...root.chat.chat.companion, name: COMPANION_NAME } } },
  };
}

const ACTIVE_CONNECTION = {
  connectionId: `${"E".repeat(42)}A`,
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
 * Every route the bar's own render reads.
 *
 * The two settings reads are not decoration: the bar's status badge is a claim about whether
 * this conversation can send, so a mount whose model route never answered would settle on a
 * different word - and the status word is part of the width the bar has to give away. Stubbing
 * them makes the word `Online` at every reading, which is the state the sweep compares.
 */
async function stubBar(page: Page): Promise<void> {
  const body = rootWithLongName();
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(body)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(body)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: ACTIVE_CONNECTION,
        connections: [
          {
            ...ACTIVE_CONNECTION,
            providerId: "deepseek",
            configured: true,
            active: true,
            allowedThinkingLevels: ["high", "max"],
            modelIds: null,
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

/** The frame the docked readings are taken in: the shell takes a width the window does not set. */
const DOCK_FRAME = ".tavern-app-shell { width: var(--dock-width, 100%); }";

async function dock(page: Page, width: number | null): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) document.documentElement.style.removeProperty("--dock-width");
    else document.documentElement.style.setProperty("--dock-width", `${value}px`);
  }, width);
}

type BarReading = Readonly<{
  /** The window's own width, so a failure can say the two frames apart. */
  viewport: number;
  /** The bar's border box: the width every rule on this bar should be a function of. */
  bar: number;
  height: number;
  /** True when the trailing peers are behind the one `More` disclosure. */
  folded: boolean;
  /** The peer controls the bar itself offers, the disclosure counted once. */
  peers: number;
  titleWidth: number;
  /** How much of the companion's name the bar cut off; ellipsis is `overflow: hidden`. */
  titleOverBy: number;
  statusWord: string;
  wordmark: string;
  /** Elements inside the bar whose content is wider than their own box. */
  overflowers: readonly string[];
  pageOverflowX: number;
}>;

/**
 * What the bar is doing, read off the browser's own layout.
 *
 * Every element in the bar is checked for overflow rather than only the name: one box whose
 * `scrollWidth` beats its `clientWidth` is content a viewer sees cut off, and it is the same
 * reading the viewport gates make.
 */
async function readBar(page: Page): Promise<BarReading> {
  return await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".app-bar");
    const title = document.querySelector<HTMLElement>(".app-bar-title");
    const trigger = document.querySelector<HTMLElement>(".app-bar-more-trigger");
    const statusWord = document.querySelector<HTMLElement>(".app-bar-status-label");
    const wordmark = document.querySelector<HTMLElement>(".app-bar-brand-name");
    if (bar === null || title === null || statusWord === null || wordmark === null)
      throw new Error("app-bar-folds-on-its-container: the app bar is not rendered");
    // `offsetParent` is null for a box with a `display: none` ancestor, which is how the
    // disclosure's wrapper retires itself above its threshold (`display: contents`).
    const laidOut = (element: HTMLElement | null): boolean =>
      element !== null && getComputedStyle(element).display !== "none" && element.offsetParent !== null;
    const peers = [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].filter(
      (button) => button !== trigger && laidOut(button),
    ).length;
    const overflowers = [...bar.querySelectorAll<HTMLElement>("*")]
      .map((element) => ({
        what: `${element.tagName.toLowerCase()}${
          typeof element.className === "string" && element.className.trim().length > 0
            ? `.${element.className.trim().split(/\s+/u).join(".")}`
            : ""
        }`,
        overBy: (element.scrollWidth ?? 0) - (element.clientWidth ?? 0),
      }))
      .filter((entry) => entry.overBy > 0)
      .map((entry) => `${entry.what}:${entry.overBy}`);
    const box = bar.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      bar: Math.round(box.width),
      height: Math.round(box.height),
      folded: laidOut(trigger),
      peers,
      titleWidth: Math.round(title.getBoundingClientRect().width),
      titleOverBy: title.scrollWidth - title.clientWidth,
      statusWord: getComputedStyle(statusWord).display,
      wordmark: getComputedStyle(wordmark).display,
      overflowers,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test("the bar behaves the same in a window that width and in a dock that width", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await stubBar(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".app-bar-status")).toHaveAccessibleName("Online");
  await page.addStyleTag({ content: DOCK_FRAME });

  const rows: { name: string; natural: BarReading; docked: BarReading }[] = [];
  for (const cell of VIEWPORT_SIZES) {
    // The natural reading: a window exactly as wide as the bar under test.
    await dock(page, null);
    await page.setViewportSize(cell);
    const natural = await readBar(page);
    // The docked reading: the same bar width, inside the widest declared window.
    await page.setViewportSize(DESKTOP);
    await dock(page, cell.width);
    const docked = await readBar(page);
    rows.push({ name: cell.name, natural, docked });
    console.log(`[app-bar-container] ${cell.name} natural=${JSON.stringify(natural)} docked=${JSON.stringify(docked)}`);
  }

  for (const row of rows) {
    const { name, natural, docked } = row;
    // The dock really did reproduce the width under test: a frame that did nothing would make
    // every comparison below a comparison of the window with itself.
    expect(docked.bar, `${name}: the docked frame did not reproduce the bar's own width`).toBe(natural.bar);
    expect(
      docked.folded,
      `${name}: a ${docked.bar}px bar is ${docked.folded ? "folded" : "unfolded"} in a ${docked.viewport}px window, ` +
        `and ${natural.folded ? "folded" : "unfolded"} in a ${natural.viewport}px one - the shape is a fact about ` +
        "the box the bar is in, not about the window",
    ).toBe(natural.folded);
    expect(docked.peers, `${name}: the docked bar offers a different number of peers than the windowed one`).toBe(
      natural.peers,
    );
    expect(docked.statusWord, `${name}: the docked bar retires the status word differently`).toBe(natural.statusWord);
    expect(docked.wordmark, `${name}: the docked bar retires the wordmark differently`).toBe(natural.wordmark);
    expect(docked.height, `${name}: the bar is a different height in the dock`).toBe(natural.height);
    expect(docked.overflowers, `${name}: the docked bar cuts off a different set of its own children`).toEqual(
      natural.overflowers,
    );
    expect(natural.titleOverBy, `${name}: the companion's name has a different budget in the dock`).toBe(
      docked.titleOverBy,
    );
    expect(docked.pageOverflowX, `${name}: the docked bar widens the document`).toBeLessThanOrEqual(0);
    expect(natural.pageOverflowX, `${name}: the bar widens the document`).toBeLessThanOrEqual(0);
  }

  // The population visited both shapes, so "the two agree" is not the trivially true reading
  // of a set where nothing ever folds.
  expect(
    new Set(rows.map((row) => row.natural.folded)).size,
    `no declared cell folds the bar, so this comparison proved nothing: ${JSON.stringify(rows.map((row) => [row.name, row.natural.bar, row.natural.folded]))}`,
  ).toBe(2);
});

test("the strip beside the game folds while the window it sits in is wide", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await stubBar(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".app-bar-status")).toHaveAccessibleName("Online");
  await page.addStyleTag({ content: DOCK_FRAME });

  // The widths the owner's report names: GameBuddy floats beside Stardew Valley in a 400-500 px
  // strip, and 816 is the widest declared width that still folds.
  for (const width of [400, 420, 500, 600, 816]) {
    await dock(page, width);
    const reading = await readBar(page);
    console.log(`[app-bar-container] strip@${width} ${JSON.stringify(reading)}`);
    expect(
      reading.folded,
      `a ${width}px bar inside a ${reading.viewport}px window did not fold: ${JSON.stringify(reading)}`,
    ).toBe(true);
    expect(reading.peers, `${width}px: the folded bar keeps its leading pair, and only that`).toBe(
      LEADING_SURFACE_COUNT,
    );
    expect(reading.titleOverBy, `${width}px: the companion's name is cut off`).toBeLessThanOrEqual(1);
    expect(reading.overflowers, `${width}px: an element of the bar is cut off inside its own box`).toEqual([]);
  }

  // The other direction - a bar wider than the window - is not a state the shell can present:
  // an ancestor hands the shell its width and the document does not scroll (`html`/`body` are
  // `100dvh` with the overflow hidden), so a 900 px bar in a 400 px window is CLIPPED, not laid
  // out wide. Measured rather than assumed, because this is the direction that would justify a
  // media query the container cannot replace.
  await page.setViewportSize(PHONE);
  await dock(page, 900);
  const wider = await readBar(page);
  console.log(`[app-bar-container] wider-than-window ${JSON.stringify(wider)}`);
  expect(wider.bar, "the shell's own width was not the width under test").toBe(900);
  expect(
    wider.pageOverflowX,
    `a ${wider.bar}px bar in a ${wider.viewport}px window scrolled the document, so a bar wider than its window is a state the shell can present`,
  ).toBeLessThanOrEqual(0);
});
