import { type Page, expect, test } from "./frontend-coverage";
import { stubShell, token } from "./draft-surfaces";

/**
 * The Settings surface spends its width on height: two tracks of the form measure, not one column in a wide region.
 *
 * THE DEFECT THIS MEASURES. The regional empty share at 1440x900 was 54.55 % (`1 - 640/1408`: one 640 px column in a
 * 1408 px region) and the surface was the SAME HEIGHT AT EVERY WIDTH - 2646 px at 400x800 and at 2560x1440, because
 * every block took the form measure and a wider window only bought empty canvas. The world-book surface beside it
 * already proves the other arrangement: its cards pack into columns that follow its own box, and the surface reads
 * 2786 -> 2009 px as the grid goes 3 -> 5 columns.
 *
 * WHAT IS ASSERTED, and why it is relational rather than a table of numbers:
 *
 *   1. THE TRACKS ARE A FUNCTION OF THE REGION, not of the window. The count is read off the layout (the blocks that
 *      take the measure, grouped by the column they were laid out on) and compared with the region's own width and the
 *      measure's own value: a region narrower than two measures has exactly one track, a region at least that wide has
 *      more than one. No cell is named as "the wide one", so a change to the measure moves the expectation with it.
 *      The docked reading proves the derivation is a container fact: the same region width produced by narrowing the
 *      shell inside a 1440 px window gives the same count as a window of that width, which a viewport media query
 *      cannot do (that defect was fixed twice already - the app bar and the character grid).
 *   2. WIDTH BUYS HEIGHT. The surface's own page height at a wide cell is strictly shorter than at the narrow one, and
 *      the empty share of the region falls with it. Before this lane both readings were equal at every cell.
 *   3. THE FIRST VIEWPORT CARRIES THE MAJORITY. More than half of the surface's named blocks are wholly inside the
 *      1440x900 window, which is the aim the operator stated: the majority of core settings visible without scrolling.
 *   4. THE DECLARED RULE, NOT A BREAKPOINT: no block on this surface may be laid out by a `@media` width query - the
 *      docked reading above is what makes that a measurement instead of a reading of the sheet.
 *
 * THE POPULATION of named blocks is the surface's own `data-` hooks - the same ones `style.css` selects on - so a
 * block added to the surface joins this table without an edit here. It refuses to pass over zero of them.
 *
 * red-proof (before the two tracks): `settings@desktop: 1 track in a 1393px region that holds two 640px measures` and
 * the page height 2646 at every cell. Both fail on the same run.
 */

/** The cells this lane was measured at, with the reason each one is a different arrangement. */
const CELLS = [
  {
    name: "small-laptop",
    width: 1280,
    height: 720,
    reason: "The shortest window the first screen is held to, and the widest cell whose region still holds one measure.",
  },
  {
    name: "desktop",
    width: 1440,
    height: 900,
    reason: "The owner's own cell: the window the 2646 px page and the 54.55 % empty share were measured in.",
  },
  {
    name: "laptop-14",
    width: 1728,
    height: 1117,
    reason: "A 14-inch laptop at its scaled default: wider than the desktop cell, one more of the same arrangement.",
  },
  {
    name: "qhd",
    width: 2560,
    height: 1440,
    reason: "The widest window the product is used at: more measures fit than the surface has tracks, so a grid that",
  },
  { name: "phone", width: 400, height: 800, reason: "The phone baseline: one track, and the first-viewport gate's cell." },
] as const;

/** Every block the surface is made of, by the hook the sheet selects it on. */
const NAMED_BLOCKS = [
  { name: "connection", selector: "[data-connection-settings]" },
  { name: "language", selector: "[data-language-settings]" },
  { name: "appearance", selector: "[data-appearance-settings]" },
  { name: "model-profiles", selector: "[data-model-profiles]" },
  { name: "game-prompt-addition", selector: "[data-game-prompt-addition]" },
  { name: "sampler-temperature", selector: "[data-sampler-temperature]" },
  { name: "voice", selector: "[data-voice-settings]" },
  { name: "profile-backup", selector: "[data-profile-backup-section]" },
  { name: "presets", selector: "[data-settings-presets-disclosure]" },
] as const;

type BlockReading = Readonly<{
  name: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
  /** Wholly inside the window, on the first viewport, with the region at its top. */
  inside: boolean;
}>;

type CellReading = Readonly<{
  viewport: Readonly<{ width: number; height: number }>;
  measure: number;
  /** The scroll container's border box and its content width - the width the tracks are resolved against. */
  region: Readonly<{ left: number; right: number; width: number; height: number }>;
  /** The surface's own page height: everything it holds, which is what a player scrolls. */
  pageHeight: number;
  /**
   * The height of the TAB the surface is showing, which is the height width is being spent on.
   *
   * Not the page: a scroll container's `scrollHeight` is never less than its client height, so a taller
   * WINDOW floors the page at its own height and the comparison across cells would be reading the window
   * rather than the layout.
   */
  panelHeight: number;
  /** The columns the blocks were laid out on, left to right, each as the interval its blocks share. */
  columns: readonly Readonly<{ left: number; right: number; width: number; blocks: readonly string[] }>[];
  /** What the layout declares, when it declares it: the non-empty tracks of the tracks container's template. */
  declaredTracks: number | null;
  /** The share of the region's width that no column of blocks occupies. */
  emptyShare: number;
  blocks: readonly BlockReading[];
}>;

/**
 * Mount the Settings surface over the shared management fixture, with the sampler route answered too.
 *
 * The shared `stubShell` is the surface's own population of panels in the state the other layout gates measure, and
 * the sampler read is added here because an unanswered route renders that block as its unavailable sentence: the page
 * this lane is about is the one with every group answered.
 */
async function mountSettings(page: Page): Promise<void> {
  await page.route("**/api/tavern/v1/settings/sampler", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, temperature: null }) }),
  );
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  // The tab the surface opens on is the one the reads whose groups it holds answer for: the connection
  // and the two model profiles both have to have landed before the panel this lane measures is whole.
  await expect(surface.locator("[data-connection-settings]")).toBeVisible();
  await expect(surface.locator("[data-model-profiles]")).toBeVisible();
  await surface.locator(".surface-content").evaluate((content) => {
    content.scrollTop = 0;
  });
}

/**
 * The layout of the TAB the surface is showing, read off the browser.
 *
 * A tab is a view of the surface, not a mount of it: the other two panels are in the document and take no
 * room, so they are not part of any reading about where blocks landed. Reading the whole surface would count
 * a hidden block at a 0x0 rect as "inside the first viewport", which is a reading that agrees with itself.
 */
async function readLayout(
  page: Page,
  named: readonly Readonly<{ name: string; selector: string }>[],
): Promise<CellReading> {
  const reading = await page.evaluate((namedBlocks) => {
    const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
    if (surface === null) throw new Error("the Settings surface is not mounted");
    const scroller = surface.querySelector<HTMLElement>(".surface-content");
    if (scroller === null) throw new Error("the Settings surface has no scroll container");
    const panel = surface.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    if (panel === null) throw new Error("the Settings surface is showing no tab");
    const measure = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--management-form-measure"),
    );
    if (!Number.isFinite(measure)) throw new Error("--management-form-measure is not a pixel value");
    const round = (value: number): number => Math.round(value * 10) / 10;

    // The columns are derived from the layout, not from a selector list: every block that takes the measure is
    // grouped by the interval it was painted on, and the groups ARE the tracks the surface used.
    const onMeasure: { name: string; left: number; right: number }[] = [];
    for (const element of Array.from(panel.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.display === "inline") continue;
      if (Number.parseFloat(style.maxWidth) !== round(measure)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue;
      const [attribute] = Array.from(element.attributes).map((entry) => entry.name);
      onMeasure.push({ name: attribute ?? element.tagName.toLowerCase(), left: round(rect.left), right: round(rect.right) });
    }
    const byInterval = new Map<string, { left: number; right: number; blocks: string[] }>();
    for (const block of onMeasure) {
      const key = `${block.left}:${block.right}`;
      const entry = byInterval.get(key) ?? { left: block.left, right: block.right, blocks: [] };
      entry.blocks.push(block.name);
      byInterval.set(key, entry);
    }
    const columns = [...byInterval.values()].sort((left, right) => left.left - right.left);

    // What the layout DECLARES, when it declares tracks: the template's own used sizes, counted without a zero.
    const tracks = panel.querySelector<HTMLElement>("[data-settings-tracks]");
    const declaredTracks =
      tracks === null
        ? null
        : getComputedStyle(tracks)
            .gridTemplateColumns.split(" ")
            .map((size) => Number.parseFloat(size))
            .filter((size) => Number.isFinite(size) && size > 0).length;

    const scrollerRect = scroller.getBoundingClientRect();
    const inside = (rect: DOMRect): boolean =>
      rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
    // Only the blocks THIS tab holds: a named block on another tab is not on the screen being read.
    const blocks = namedBlocks
      .filter((entry) => panel.querySelector(entry.selector) !== null)
      .map((entry) => {
        const node = panel.querySelector<HTMLElement>(entry.selector)!;
        const rect = node.getBoundingClientRect();
        return {
          name: entry.name,
          top: round(rect.top),
          bottom: round(rect.bottom),
          left: round(rect.left),
          right: round(rect.right),
          height: round(rect.height),
          inside: inside(rect),
        };
      });

    // The empty share is the region's width that no column covers, clipped to the region's own box: on a surface that
    // is one column, everything but the column is empty, and two tracks make that number fall.
    const covered = columns
      .map((column) => [Math.max(column.left, scrollerRect.left), Math.min(column.right, scrollerRect.right)])
      .sort((left, right) => left[0]! - right[0]!);
    let coveredWidth = 0;
    let reach = scrollerRect.left;
    for (const [left, right] of covered) {
      const start = Math.max(left!, reach);
      if (right! > start) coveredWidth += right! - start;
      reach = Math.max(reach, right!);
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      measure,
      region: {
        left: round(scrollerRect.left),
        right: round(scrollerRect.right),
        width: round(scrollerRect.width),
        height: round(scrollerRect.height),
      },
      pageHeight: Math.round(scroller.scrollHeight),
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      columns,
      declaredTracks,
      emptyShare: Math.round((1 - coveredWidth / scrollerRect.width) * 10000) / 10000,
      blocks,
    };
  }, named);
  return reading;
}

/** The content width the tracks are resolved against: the region minus its reserved scrollbar gutter. */
async function contentWidth(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="settings-surface"] .surface-content');
    if (scroller === null) throw new Error("the Settings surface has no scroll container");
    return Math.round(scroller.clientWidth);
  });
}

/**
 * The layout once the surface has stopped growing.
 *
 * The panel mounts its groups as their reads answer, one read after another, so the first paint is a partial surface:
 * the first reading of the 1280x720 cell caught the sampler group before its read landed and read the page 176 px short of
 * what the same page says a moment later. A table taken over a surface that is still filling is a table of the mount, so
 * the reading is taken again until three consecutive reads name the same blocks at the same places - a stability the
 * layout itself proves, not a timer.
 */
async function settledLayout(
  page: Page,
  named: readonly Readonly<{ name: string; selector: string }>[],
): Promise<CellReading> {
  const fingerprint = (reading: CellReading): string =>
    JSON.stringify([reading.pageHeight, reading.columns.length, reading.blocks.map((block) => [block.name, block.top, block.height])]);
  let reading = await readLayout(page, named);
  let stable = 1;
  for (let attempt = 0; attempt < 25 && stable < 3; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await readLayout(page, named);
    stable = fingerprint(next) === fingerprint(reading) ? stable + 1 : 1;
    reading = next;
  }
  return reading;
}

function describe(reading: CellReading, content: number): string {
  return (
    `measure=${reading.measure} region=${reading.region.width} content=${content} ` +
    `page=${reading.pageHeight} tab=${reading.panelHeight} tracks=${reading.columns.length} declared=${reading.declaredTracks} ` +
    `empty=${(reading.emptyShare * 100).toFixed(2)}% ` +
    `columns=${JSON.stringify(reading.columns.map((column) => `${column.left}..${column.right}`))} ` +
    `blocks=${JSON.stringify(reading.blocks.map((block) => `${block.name}:${block.top}..${block.bottom}${block.inside ? "" : "(not in viewport)"}`))}`
  );
}

test("the Settings surface buys height with width: two tracks of the measure, and the same page in both frames", async ({
  page,
}) => {
  await page.setViewportSize({ width: CELLS[0].width, height: CELLS[0].height });
  await mountSettings(page);

  const rows: { cell: (typeof CELLS)[number]; reading: CellReading; content: number }[] = [];
  for (const cell of CELLS) {
    await page.setViewportSize({ width: cell.width, height: cell.height });
    await page.getByTestId("settings-surface").locator(".surface-content").evaluate((content) => {
      content.scrollTop = 0;
    });
    const reading = await settledLayout(page, NAMED_BLOCKS);
    const content = await contentWidth(page);
    rows.push({ cell, reading, content });
    console.log(`[settings-tracks] ${cell.name}@${cell.width}x${cell.height} ${describe(reading, content)}`);
  }

  const failures: string[] = [];
  const byName = new Map(rows.map((row) => [row.cell.name, row]));

  for (const row of rows) {
    const { cell, reading, content } = row;
    // FAIL LOUDLY ON ZERO: a reading with no column means the wrong region was read, not that the layout is fine.
    if (reading.columns.length === 0)
      failures.push(`${cell.name}: no block takes the ${reading.measure}px measure - the gate read the wrong region`);
    if (reading.blocks.length === 0) failures.push(`${cell.name}: the tab the surface opens on renders none of its blocks`);

    // 1. THE TRACKS ARE A FUNCTION OF THE REGION. The two measures' worth of room is the measure's own arithmetic and
    //    nothing else: below it the surface has one column, at or above it the surface has more than one.
    const twoMeasures = reading.measure * 2;
    if (content < twoMeasures && reading.columns.length !== 1)
      failures.push(
        `${cell.name}: ${reading.columns.length} tracks in a ${content}px region that cannot hold two ${reading.measure}px ` +
          `measures - a track has to be the measure or the region, never a fraction of either`,
      );
    if (content >= twoMeasures + reading.measure / 2 && reading.columns.length < 2)
      failures.push(
        `${cell.name}: ${reading.columns.length} track in a ${content}px region that holds two ${reading.measure}px ` +
          `measures - the width is being spent on empty canvas`,
      );
    if (reading.declaredTracks !== null && reading.declaredTracks !== reading.columns.length)
      failures.push(
        `${cell.name}: the layout declares ${reading.declaredTracks} track(s) and the blocks were laid out on ` +
          `${reading.columns.length} - an empty track is width nobody uses`,
      );
    // Every track is exactly the measure, so the class gate's one measure is still one measure.
    for (const column of reading.columns) {
      if (column.right - column.left > reading.measure + 1)
        failures.push(
          `${cell.name}: a track is ${Math.round(column.right - column.left)}px wide inside a ${reading.measure}px ` +
            `measure - a track may not be wider than the measure it is made of`,
        );
    }
  }

  // 2. WIDTH BUYS HEIGHT. The page a player scrolls is shorter where the tracks are, and the second track fills a share
  //    of the region that one column left empty. Before this lane both readings were a single column at every cell: the
  //    page was 2822 px at 1280x720 and at 2560x1440 alike.
  //
  //    The reference is the one-track arrangement, and which cells are in it is the region's own arithmetic - the rule
  //    assertion 1 proves the tracks follow: a region narrower than two measures cannot hold two of them. Taking the
  //    reference from that rule rather than from the count of tracks a reading grouped means the comparison is made
  //    against the width the surface derives from, and every cell whose region does hold two measures is held to it
  //    below.
  const singleTrack = rows.filter((row) => row.content < row.reading.measure * 2);
  const tallestSingle = singleTrack.reduce((tallest, row) => Math.max(tallest, row.reading.panelHeight), 0);
  for (const row of rows) {
    if (row.reading.columns.length < 2) continue;
    if (row.reading.panelHeight >= tallestSingle)
      failures.push(
        `${row.cell.name}: the ${row.cell.width}x${row.cell.height} tab is ${row.reading.panelHeight}px tall, and the ` +
          `same tab in a region that cannot hold two ${row.reading.measure}px measures is ${tallestSingle}px - the ` +
          `extra width bought no height`,
      );
    // The share one column leaves empty is the number to beat: a second track that does not beat it has not taken
    // any of the width the single column was not using.
    const oneColumnShare = 1 - row.reading.measure / row.reading.region.width;
    if (row.reading.emptyShare >= oneColumnShare - 0.01)
      failures.push(
        `${row.cell.name}: the region's empty share is ${(row.reading.emptyShare * 100).toFixed(2)}% against the ` +
          `${(oneColumnShare * 100).toFixed(2)}% one ${row.reading.measure}px column leaves in the same ` +
          `${row.reading.region.width}px region - the second track filled no width the first one left empty`,
      );
  }

  // 3. THE FIRST VIEWPORT CARRIES THE TAB A PLAYER LANDS ON: the operator's aim, restated for a surface split
  //    into tabs. Before the split this was "the majority of the surface's nine blocks"; the surface no longer
  //    holds nine blocks at once, so the same aim is every block on the opening tab wholly inside the window -
  //    which is a stricter statement about that screen than "most of nine" was about the old one.
  const desktop = byName.get("desktop");
  if (desktop === undefined) failures.push("desktop: the declared cell was never measured");
  else {
    const outside = desktop.reading.blocks.filter((block) => !block.inside);
    if (outside.length > 0)
      failures.push(
        `desktop: these blocks of the opening tab are not wholly inside the ${desktop.cell.width}x` +
          `${desktop.cell.height} first viewport (${outside.map((block) => `${block.name} at ${block.top}`).join(", ")}) - the` +
          " aim is the screen a player lands on, and a block below its fold is one they have to scroll to find",
      );
  }

  expect(failures, `${failures.length} finding(s) about the Settings surface's tracks`).toEqual([]);
});

/** The frame the docked readings are taken in: the shell takes a width the window does not set. */
const DOCK_FRAME = ".tavern-app-shell { width: var(--dock-width, 100%); }";

/**
 * One tab's panel and the measured heights the tab gate reads.
 *
 * `closed` is the state the tab arrives in (its low-frequency regions shut) and `open` is with every one of
 * them open, because both are states a player really meets and only one of them can be the one a tab's first
 * screen is judged against.
 */
type TabReading = Readonly<{
  label: string;
  regions: readonly string[];
  closed: number;
  open: number;
}>;

/** Every tab of the surface, its panel's height as it arrives, and its height with every region open. */
async function readTabs(page: Page): Promise<TabReading[]> {
  const tabs = page.locator('[data-testid="settings-surface"] [role="tab"]');
  const rows: TabReading[] = [];
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const tab = tabs.nth(index);
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = page.locator('[data-testid="settings-surface"] [role="tabpanel"]:not([hidden])');
    const label = (await tab.textContent())?.trim() ?? "";
    const regions = await panel.evaluate(
      (node, blocks) => blocks.filter((entry) => node.querySelector(entry.selector) !== null).map((entry) => entry.name),
      NAMED_BLOCKS.map((entry) => ({ name: entry.name, selector: entry.selector })),
    );
    const closed = await panel.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    const summaries = panel.locator("details:not([open]) > summary");
    for (let left = await summaries.count(); left > 0; left -= 1) await summaries.first().click();
    const open = await panel.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    rows.push({ label, regions, closed, open });
  }
  return rows;
}

/**
 * The split loses no region, duplicates none, and each tab is shorter than the column it was cut from.
 *
 * THE POPULATION is the surface's own `data-` hooks (`NAMED_BLOCKS`) - the same list the layout reading walks -
 * so a region added to this surface joins this gate without an edit here. A region that fits no tab, or one a
 * careless move renders twice, fails by name.
 *
 * THE HEIGHT is reported for both states of every tab and asserted only as a property the split must keep: a
 * tab's panel is shorter than the whole surface's column was, and the tab a player lands on is not the tallest.
 * Whether a tab is ONE SCREEN is printed beside it, because at 400x800 it cannot always be true - the numbers
 * say which tab is over and by how much.
 */
test("the three tabs hold every region once, and the strip opens on the connection", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mountSettings(page);

  // Where the surface opens: the tab holding the control that decides whether a reply can happen.
  await expect(page.getByRole("tab", { name: "Connection and model", exact: true })).toHaveAttribute("aria-selected", "true");

  const rows = await readTabs(page);
  const fold = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-testid="settings-surface"] .surface-content');
    return content === null ? 0 : content.clientHeight;
  });
  for (const row of rows) {
    console.log(
      `[settings-tabs] ${row.label} closed=${row.closed}px open=${row.open}px against a ${fold}px fold ` +
        `regions=${JSON.stringify(row.regions)}`,
    );
  }

  const failures: string[] = [];
  // The population, from the surface's own hooks: every region exactly once, across the three tabs.
  const placed = rows.flatMap((row) => row.regions);
  for (const entry of NAMED_BLOCKS) {
    const count = placed.filter((name) => name === entry.name).length;
    if (count !== 1)
      failures.push(
        `${entry.name} is in ${count} tab(s) - every region of this surface belongs to exactly one tab, and a` +
          " region in none of them is a setting a player can no longer reach",
      );
  }
  if (rows.length !== 3) failures.push(`the surface offers ${rows.length} tab(s), and it was split into three`);
  // The split's own point, stated as a floor rather than as a wish: at a phone's window at least two of the three
  // tabs arrive inside ONE screen. Before the split none of them did, because there was one 3122 px column; if a
  // region regrows enough to put a second tab over the fold, this fails and names it.
  const oneScreen = rows.filter((row) => row.closed <= fold);
  if (oneScreen.length < 2)
    failures.push(
      `${oneScreen.length} of ${rows.length} tabs arrive inside the ${fold}px first screen ` +
        `(${rows.map((row) => `${row.label} ${row.closed}px`).join(", ")}) - the split's whole point is that a` +
        " player changes one kind of thing without scrolling past the others",
    );
  if (rows.some((row) => row.closed > fold))
    console.log(
      `[settings-tabs] over one screen at 400x800: ${rows
        .filter((row) => row.closed > fold)
        .map((row) => `${row.label} (+${row.closed - fold}px)`)
        .join(", ")}`,
    );

  expect(failures, "the Settings surface's three tabs" ).toEqual([]);
});

/** The tuning tab's OTHER column, in reading order: what opening a row in this one must not move. */
const INSTRUCTIONS_COLUMN = ["[data-game-prompt-addition]", "[data-sampler-temperature]"] as const;

test("a disclosure in one track opens without moving the other track", async ({ page }) => {
  await page.setViewportSize({ width: CELLS[1].width, height: CELLS[1].height });
  await mountSettings(page);
  // The third tab, because that is the tab whose two columns this is about: its instruction column stays
  // open and its machine column is the one that opens rows. One press, and the assertion below is the
  // assertion it always was - the extra press is the tab.
  await page.getByRole("tab", { name: "Advanced and tuning", exact: true }).click();
  const disclosure = page.locator("[data-settings-presets-disclosure]");
  await expect(disclosure).toHaveCount(1);

  // The blocks' own offsets in the surface's content, not in the window: opening the disclosure may need the region
  // scrolled to it, and a viewport coordinate would then report the scroll as a move.
  const tops = async (): Promise<readonly number[]> =>
    await page.evaluate((selectors) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="settings-surface"] .surface-content');
      if (scroller === null) throw new Error("the Settings surface has no scroll container");
      return selectors.map((selector) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (node === null) throw new Error(`no ${selector}`);
        return Math.round(node.getBoundingClientRect().top + scroller.scrollTop);
      });
    }, INSTRUCTIONS_COLUMN);

  const before = await tops();
  const collapsed = await disclosure.evaluate((node) => (node as HTMLDetailsElement).open);
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", /.*/u);
  // The disclosure really opened: its own body is painted, and its track grew downward.
  await expect(disclosure.locator(".composer-actions button")).toBeVisible();
  const opened = await disclosure.evaluate((node) => Math.round(node.getBoundingClientRect().height));
  const after = await tops();

  expect(collapsed, "the disclosure starts collapsed").toBe(false);
  expect(opened, "the disclosure's own body is painted when it opens").toBeGreaterThan(0);
  expect(
    after,
    `opening the preset disclosure in the machine column moved the instruction column's blocks: ${JSON.stringify(
      INSTRUCTIONS_COLUMN.map((selector, index) => `${selector} ${before[index]} -> ${after[index]}`),
    )}`,
  ).toEqual(before);
});

test("the tracks follow the region's own width, in a window and in a dock", async ({ page }) => {
  await page.setViewportSize({ width: CELLS[1].width, height: CELLS[1].height });
  await mountSettings(page);
  await page.addStyleTag({ content: DOCK_FRAME });

  const rows: { cell: (typeof CELLS)[number]; natural: number; docked: number }[] = [];
  for (const cell of CELLS) {
    await page.evaluate(() => document.documentElement.style.removeProperty("--dock-width"));
    await page.setViewportSize({ width: cell.width, height: cell.height });
    const natural = (await settledLayout(page, [])).columns.length;
    await page.setViewportSize({ width: CELLS[1].width, height: CELLS[1].height });
    await page.evaluate((width) => document.documentElement.style.setProperty("--dock-width", `${width}px`), cell.width);
    const docked = (await settledLayout(page, [])).columns.length;
    rows.push({ cell, natural, docked });
    console.log(`[settings-tracks-docked] ${cell.name} natural=${natural} docked=${docked}`);
  }

  for (const row of rows) {
    expect(
      row.docked,
      `${row.cell.name}: a ${row.cell.width}px shell inside a ${CELLS[1].width}px window lays the surface out in ` +
        `${row.docked} track(s), and a ${row.cell.width}px window lays it out in ${row.natural} - the tracks are ` +
        "following the window rather than the region they are laid out in",
    ).toBe(row.natural);
  }
});
