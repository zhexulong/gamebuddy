import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The card's own openings on the phone strip: one scrollable row, not three
 * stacked lines.
 *
 * The measured defect (audit screenshot `shots-final4/00-fresh-first-400x800.png`,
 * evidence `shots-final4/b-surfaces.txt:15`): at 400x800 the three shipped
 * openings wrapped to three lines, so the composer band grew to 255 px - 32% of
 * the window - and the transcript paid for it (the companion's first line and
 * the 重新生成 control sat at bottom 806 > 800). The same row also clipped the
 * longest opening behind an ellipsis (`scrollWidth - clientWidth` = 53 px), so
 * the chip's own text was unreachable as well as expensive.
 *
 * Every number below is read from the browser's own layout at the two widths the
 * audit measured, and the three viewport invariants are the ones
 * `runtime-frontend-gates.spec.ts` gate 1 and `viewport-anchoring.spec.ts`
 * already assert: no page-level overflow in either axis, and a shell that is
 * exactly the window's height. What this file adds is what those gates cannot
 * see - what the composer band costs the transcript, and whether a chip is
 * hiding its own label.
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";
const openingVariantId = "V".repeat(42) + "A";
const openedMessageHandle = "W".repeat(42) + "A";

/** The shipped companion card's own opening material, not a comfortable fixture. */
const shippedCard = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../assets/tavern/presets/default-companion/card.json", import.meta.url)),
    "utf8",
  ),
) as Readonly<{ data: Readonly<{ first_mes: string; alternate_greetings: readonly string[] }> }>;

const OPENINGS: readonly string[] = [shippedCard.data.first_mes, ...shippedCard.data.alternate_greetings];

const VIEWPORTS: readonly Readonly<{ width: number; height: number }>[] = [
  { width: 400, height: 800 },
  { width: 1440, height: 900 },
];

/** A conversation that has not started: the companion's own committed opening, alone. */
function composedRoot() {
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
        companion: { name: "琥珀" },
        title: null,
        transcript: [
          {
            handle: openedMessageHandle,
            role: "companion",
            text: OPENINGS[0]!,
            locale: "zh-CN",
            order: 0,
            revision: 1,
            openingVariant: { variantId: openingVariantId, index: 0, count: OPENINGS.length, label: "Default", locked: false },
          },
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

async function mountFirstScreen(page: Page): Promise<void> {
  const root = composedRoot();
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        label: "Initial Greeting",
        variants: OPENINGS.map((text) => ({ label: "Default", text })),
      }),
    ),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator(".composer-chip")).toHaveCount(OPENINGS.length);
}

type Box = Readonly<{ top: number; bottom: number; left: number; right: number; height: number; width: number }>;

type ChipsMeasurement = Readonly<{
  viewport: Readonly<{ width: number; height: number }>;
  documentScrollWidth: number;
  documentScrollHeight: number;
  bodyScrollWidth: number;
  bodyScrollHeight: number;
  shell: Box & Readonly<{ computedHeight: string }>;
  composer: Box;
  timeline: Box & Readonly<{ clientHeight: number }>;
  chipsRow: Readonly<{
    height: number;
    top: number;
    right: number;
    clientWidth: number;
    scrollWidth: number;
    flexWrap: string;
    overflowX: string;
    maskImage: string;
    paddingRight: string;
  }>;
  chips: readonly Readonly<{
    text: string;
    name: string | null;
    top: number;
    right: number;
    width: number;
    clientWidth: number;
    scrollWidth: number;
  }>[];
  /** Elements that clip their own content with no scroll path to it. */
  overflowers: readonly Readonly<{ tag: string; cls: string; overBy: number }>[];
}>;

/** Runs in the page: every box the phone strip's defect was measured with. */
function measureChips(): ChipsMeasurement {
  const box = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      height: rect.height,
      width: rect.width,
    };
  };
  const must = (selector: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`composer-chips-narrow: ${selector} is not rendered`);
    return element;
  };
  const shell = must(".tavern-app-shell");
  const composer = must(".composer-section");
  const timeline = must(".timeline");
  const row = must(".composer-chips-row");
  const rowStyle = getComputedStyle(row);
  const documentElement = document.documentElement;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentScrollWidth: documentElement.scrollWidth,
    documentScrollHeight: documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
    shell: { ...box(shell), computedHeight: getComputedStyle(shell).height },
    composer: box(composer),
    timeline: { ...box(timeline), clientHeight: timeline.clientHeight },
    chipsRow: {
      height: box(row).height,
      top: box(row).top,
      right: box(row).right,
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      flexWrap: rowStyle.flexWrap,
      overflowX: rowStyle.overflowX,
      maskImage: rowStyle.maskImage === "" ? "none" : rowStyle.maskImage,
      paddingRight: rowStyle.paddingRight,
    },
    chips: [...row.querySelectorAll<HTMLElement>(".composer-chip")].map((chip) => ({
      text: (chip.textContent ?? "").trim(),
      name: chip.getAttribute("aria-label"),
      top: box(chip).top,
      right: box(chip).right,
      width: box(chip).width,
      clientWidth: chip.clientWidth,
      scrollWidth: chip.scrollWidth,
    })),
    // A box that clips what it holds, with nothing to scroll the rest into
    // view, is content the player cannot reach: the audit's overflowering chip.
    // A scroller (`overflow-x` auto/scroll) is a way to reach the rest, so it is
    // not one; neither is a text field, which scrolls its own value by design.
    overflowers: [...document.querySelectorAll<HTMLElement>('[data-testid="chat-surface"] *')]
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        cls: node.getAttribute("class") ?? "",
        overBy: node.scrollWidth - node.clientWidth,
        scrollable: ["auto", "scroll"].includes(getComputedStyle(node).overflowX),
      }))
      .filter((entry) => entry.overBy > 1 && !entry.scrollable && !["textarea", "input", "select"].includes(entry.tag))
      .map(({ tag, cls, overBy }) => ({ tag, cls, overBy })),
  };
}

/**
 * One honest sentence per broken invariant, so a failing run names the width and
 * the box.
 *
 * The viewport invariants hold at every width. The row's own contract is the
 * phone strip's: below 480 the openings must not stack, because the band they
 * stack in is the band the transcript pays for. Above it the row wraps as it
 * always has - there is vertical room there, and no gate has ever measured that
 * arm.
 */
function chipsFailures(measured: ChipsMeasurement): string[] {
  const failures: string[] = [];
  const { width, height } = measured.viewport;
  const at = `${width}x${height}`;
  const tolerance = 1;
  const narrow = width <= 480;

  // The three viewport invariants the runtime gates already assert.
  if (measured.documentScrollHeight > height + tolerance)
    failures.push(`${at}: the page scrolls vertically (documentElement.scrollHeight ${measured.documentScrollHeight} > innerHeight ${height})`);
  if (measured.documentScrollWidth > width + tolerance)
    failures.push(`${at}: the page scrolls sideways (documentElement.scrollWidth ${measured.documentScrollWidth} > innerWidth ${width})`);
  if (measured.bodyScrollHeight > height + tolerance)
    failures.push(`${at}: body overflows (body.scrollHeight ${measured.bodyScrollHeight} > innerHeight ${height})`);
  if (measured.bodyScrollWidth > width + tolerance)
    failures.push(`${at}: body overflows sideways (body.scrollWidth ${measured.bodyScrollWidth} > innerWidth ${width})`);
  if (measured.shell.computedHeight !== `${height}px`)
    failures.push(`${at}: the shell is ${measured.shell.computedHeight}, not the window's ${height}px`);
  if (measured.shell.bottom > height + tolerance)
    failures.push(`${at}: the shell runs past the window (bottom ${measured.shell.bottom})`);

  // The composer band: inside the window, and not eating the transcript.
  if (measured.composer.bottom > height + tolerance)
    failures.push(`${at}: the composer band runs past the window (bottom ${measured.composer.bottom})`);
  if (measured.composer.top >= height - tolerance)
    failures.push(`${at}: the composer band is below the window (top ${measured.composer.top})`);
  if (measured.timeline.height < height * 0.55)
    failures.push(`${at}: the transcript keeps only ${Math.round(measured.timeline.height)}px of ${height}`);

  if (narrow) {
    // The phone band: one line that scrolls sideways, and a real affordance.
    if (measured.composer.height > height * 0.25)
      failures.push(
        `${at}: the composer band is ${Math.round(measured.composer.height)}px, ${Math.round((measured.composer.height / height) * 100)}% of the window`,
      );
    if (measured.chipsRow.flexWrap !== "nowrap")
      failures.push(`${at}: the chip row wraps (flex-wrap ${measured.chipsRow.flexWrap})`);
    const tops = new Set(measured.chips.map((chip) => Math.round(chip.top)));
    if (tops.size !== 1) failures.push(`${at}: the chips are on ${tops.size} lines (tops ${[...tops].join(", ")})`);
    if (measured.chipsRow.height > 2 * 44)
      failures.push(`${at}: the chip row is ${Math.round(measured.chipsRow.height)}px tall, not one 44 px line`);
    if (measured.chipsRow.scrollWidth <= measured.chipsRow.clientWidth)
      failures.push(
        `${at}: the chip row does not scroll (scrollWidth ${measured.chipsRow.scrollWidth} <= clientWidth ${measured.chipsRow.clientWidth})`,
      );
    if (measured.chipsRow.overflowX !== "auto")
      failures.push(`${at}: the chip row is not the scroller (overflow-x ${measured.chipsRow.overflowX})`);
    if (measured.chipsRow.maskImage === "none")
      failures.push(`${at}: the chip row has no scroll affordance at its trailing edge`);
    if (Number.parseFloat(measured.chipsRow.paddingRight) < 8)
      failures.push(
        `${at}: the row keeps no trailing padding for the affordance (padding-right ${measured.chipsRow.paddingRight})`,
      );
  } else if (measured.chipsRow.overflowX === "auto") {
    failures.push(`${at}: the wide row became a sideways scroller (overflow-x ${measured.chipsRow.overflowX})`);
  }

  // Every chip renders its own label, and says what a tap does.
  for (const [index, chip] of measured.chips.entries()) {
    if (chip.scrollWidth > chip.clientWidth + tolerance)
      failures.push(`${at}: chip ${index} hides ${chip.scrollWidth - chip.clientWidth}px of its own label behind an ellipsis`);
    expect(chip.name ?? "", `chip ${index} is named by what a tap does`).toMatch(/^用这句开场：/u);
    expect((chip.name ?? "").length, `chip ${index}'s accessible name is an action, not a paragraph`).toBeLessThan(80);
  }

  if (measured.overflowers.length > 0)
    failures.push(`${at}: unreachable clipped content: ${measured.overflowers.map((entry) => `${entry.tag}.${entry.cls.split(/\s+/u)[0]} +${entry.overBy}px`).join(", ")}`);

  return failures;
}

test("the card's own openings stay one row on the phone strip, and the composer stops eating the transcript", async ({
  page,
}) => {
  await mountFirstScreen(page);

  const measured: ChipsMeasurement[] = [];
  const failures: string[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const reading = await page.evaluate(measureChips);
    measured.push(reading);
    failures.push(...chipsFailures(reading));
  }

  for (const reading of measured) {
    const { width, height } = reading.viewport;
    console.log(
      `[chips] ${width}x${height}: composer ${Math.round(reading.composer.height)}px (bottom ${Math.round(reading.composer.bottom)} vs innerHeight ${height}), row ${Math.round(reading.chipsRow.height)}px, timeline ${Math.round(reading.timeline.height)}px, overflowers ${JSON.stringify(reading.overflowers)}`,
    );
  }
  console.log(`[chips] measurements: ${JSON.stringify(measured)}`);

  expect(failures, "the openings stay one scrollable row, and the composer keeps the transcript its height").toEqual([]);
});

test("the last chip is reachable, not merely clipped: a horizontal scroll reveals the row's whole content", async ({
  page,
}) => {
  await mountFirstScreen(page);
  await page.setViewportSize({ width: 400, height: 800 });

  const scrolled = await page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>(".composer-chips-row");
    if (row === null) throw new Error("composer-chips-narrow: the chip row is not rendered");
    const before = { scrollLeft: row.scrollLeft, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth };
    row.scrollLeft = row.scrollWidth;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const last = row.querySelector<HTMLElement>(".composer-chip:last-of-type");
    const rowBox = row.getBoundingClientRect();
    const lastBox = last === null ? null : last.getBoundingClientRect();
    return {
      before,
      atEnd: {
        scrollLeft: row.scrollLeft,
        maxScroll: row.scrollWidth - row.clientWidth,
        lastRight: lastBox === null ? null : lastBox.right,
        rowRight: rowBox.right,
        // The trailing fade must sit over the row's own padding, not over the
        // last chip, or the affordance would hide the very content it invites.
        lastClearOfFade: lastBox === null ? false : rowBox.right - lastBox.right >= 8,
      },
    };
  });

  console.log(`[chips] scroll to end: ${JSON.stringify(scrolled)}`);
  expect(scrolled.before.scrollWidth, "the row has content off its trailing edge").toBeGreaterThan(
    scrolled.before.clientWidth,
  );
  expect(scrolled.atEnd.scrollLeft, "the row scrolls to its end").toBe(scrolled.atEnd.maxScroll);
  expect(scrolled.atEnd.lastClearOfFade, "the last chip is not hidden under the trailing affordance").toBe(true);
});
