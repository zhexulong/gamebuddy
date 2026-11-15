import { type Page, expect, test } from "./frontend-coverage";
import { WALKED_SURFACES, openSurface, stubShell, token } from "./draft-surfaces";
import { DESKTOP, VIEWPORT_SIZES } from "./viewport-policy";

/**
 * The management measure is one COLUMN's width, and every block on a management surface is on a column of it.
 *
 * THE INVARIANT, in the sheet's own words (`style.css`, the `--management-form-measure` token): a block that
 * stretches to the whole region reads as two unrelated ends - a field's label and its control, a section title and
 * its own button. The sheet states that measure once; this file reads it from the token and asks every block on the
 * two surfaces that keep it whether it is on a column of that width.
 *
 * WHY THE POPULATION IS DERIVED AND NOT LISTED. The defect this file exists for is a family, not five selectors:
 * `[data-appearance-settings]`, `[data-sampler-temperature]`, `[data-settings-presets-disclosure]`,
 * `[data-companion-card-export-section]` and `[data-companion-world-book]` were each appended to their surface
 * after the measure went in, so each spanned the region while its siblings sat on the column (measured at 1440x900:
 * 1398 px wide on a left edge of 16, against 640 on 395..1035) - and `[data-profile-backup-section]` and
 * `[data-game-prompt-addition]` were the same defect one pass earlier. A gate over a written-out list of those
 * attributes would have passed for every one of them, which is why nothing here names a block:
 *
 *  - the population is every block whose computed `max-width` resolves to the token's own value (no second copy of
 *    640 lives in this file);
 *  - a COLUMN is the interval the outermost blocks of that population were painted on. A block nested inside another
 *    block on the measure only follows its parent, so it inherits that column rather than claiming one;
 *  - an OFFENDER is any laid-out descendant of the surface's scroll container that is wider than that measure and
 *    does not sit inside another offender - the top of each chain, because the parent is the block that lost the
 *    measure and its paragraphs are only following it.
 *
 * A SURFACE MAY HAVE MORE THAN ONE COLUMN, and this file used to assume it could not. The Settings surface lays its
 * blocks out in two tracks of the measure on a wide window (the width is spent on height there instead of on canvas),
 * so the assertion is no longer "one column" but "real columns": each one exactly the measure wide (or the region,
 * when the region is narrower than the measure), none of them overlapping another, and the frame they make centred in
 * the region - which is what every block on this measure said when there was only one of them. HOW MANY columns a
 * surface has is its own layout's decision, held where that decision is made: `tests/settings-two-tracks.spec.ts`
 * derives the Settings surface's count from the region and the measure, and the Characters surface's single column is
 * held here and by `tests/character-columns-follow-their-container.spec.ts`.
 *
 * THE EXEMPTION IS A DECLARATION, NOT A SELECTOR. Two blocks genuinely need the width: the Characters surface's
 * companion grid, whose column count follows the PANEL's own width (`--characters-column-width`, pinned by
 * `tests/character-columns-follow-their-container.spec.ts`), and the Settings surface's own frame, which holds two
 * tracks of the measure and therefore cannot be one measure wide. Each says so in `style.css`, in
 * `--exceeds-form-measure` beside its rule, and this file reads that property off the element: the exemption is the
 * block's own written reason, and a declaration whose block is never wider than the measure fails as spent instead of
 * standing forever. There is no selector list here that could drift from the sheet.
 *
 * THE CELLS ARE `VIEWPORT_SIZES`. A column is a fact about the width the surface is handed, so it is asked at every
 * declared width. Above the measure a block has two edges to disagree about; below it the region is narrower than the
 * measure, both readings are the region's own, and the row says so rather than pretending the comparison proved
 * something - which is why the last assertion requires at least one cell per surface where the region really is wide
 * enough to have two edges.
 *
 * The reading also logs the surface's own `scrollHeight`: bringing a block into a column narrows it, and the height
 * the surface pays for that is the other half of the trade.
 *
 * red-proof, for the class rather than the five: add
 * `[data-profile-backup-section] > p:first-of-type { width: 1200px; max-width: none }` to `style.css` ->
 *   `settings@desktop: p.management-settings-hint is 1200px wide (721..1921) in a 1408px region whose measure is 640px -
 *   its right edge at 1921 is past the column's 1361`, at every cell wide enough to have two edges. That block is in no
 *   list; before the fix, the five blocks themselves were the listing, 1398 px at 16..1414 beside the column at
 *   395..1035.
 * red-proof, for the columns rather than the column: move one block off its track with
 * `[data-settings-track="tuning"] { margin-left: 240px }` -> `settings@desktop: the columns sit at 309..1601 in a
 *   1398px region, leaving 293px on the left and 123px on the right - every block on this measure centres itself in the
 *   region, so the column or columns they make do too`.
 */

/** The two surfaces the measure is declared for and the two this gate walks: both are management form surfaces. */
const MEASURED_SURFACES = ["settings", "characters"] as const;

type BlockReading = Readonly<{
  name: string;
  width: number;
  left: number;
  right: number;
  /** The computed `max-width`, or null when the block states none. */
  maxWidth: number | null;
  /** A block's own written reason for exceeding the form measure. */
  declared: string | null;
}>;

/** One of the surface's columns: the interval the blocks on it were painted on. */
type ColumnReading = Readonly<{
  left: number;
  right: number;
  width: number;
  /** The outermost blocks that were laid out on it, so a failure names what it holds. */
  blocks: readonly string[];
}>;

type SurfaceReading = Readonly<{
  measure: number;
  /** The scroll container's content width: the region the columns are laid out in. */
  contentWidth: number;
  scroller: Readonly<{ width: number; left: number; right: number; scrollHeight: number }>;
  /** The columns the surface's blocks were laid out in, left to right. */
  columns: readonly ColumnReading[];
  /** Every laid-out block whose computed `max-width` is the token's value. */
  keepsMeasure: readonly BlockReading[];
  /** Every laid-out block wider than the token's value, at the top of its chain, with no written exemption. */
  offenders: readonly BlockReading[];
  /** Every block that declares it may exceed the measure, wide or not: the ledger the next assertion checks. */
  declared: readonly BlockReading[];
}>;

async function readSurface(page: Page, testId: string): Promise<SurfaceReading> {
  const reading = await page.evaluate((id) => {
    const region = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (region === null) return null;
    const scroller = region.querySelector<HTMLElement>(".surface-content");
    if (scroller === null) return null;
    const measure = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--management-form-measure"),
    );
    if (!Number.isFinite(measure)) return null;

    const round = (value: number): number => Math.round(value * 10) / 10;
    // A block is named by the first `data-*` attribute it carries, which is what every rule in the sheet selects on;
    // a block with none is named by its tag and first class, so a failure still says where to look.
    const nameOf = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith("data-")) return `${tag}[${attribute.name}]`;
      }
      const [first] = Array.from(element.classList);
      return first === undefined ? tag : `${tag}.${first}`;
    };
    const describe = (element: Element): BlockReading => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const maxWidth = Number.parseFloat(style.maxWidth);
      return {
        name: nameOf(element),
        width: round(rect.width),
        left: round(rect.left),
        right: round(rect.right),
        maxWidth: Number.isFinite(maxWidth) ? round(maxWidth) : null,
        declared: style.getPropertyValue("--exceeds-form-measure").trim() || null,
      };
    };

    const laidOut: Element[] = [];
    for (const element of Array.from(scroller.querySelectorAll("*"))) {
      const style = getComputedStyle(element);
      // An inline box has no width of its own to be on a column; a flatly hidden one is not on the surface.
      if (style.display === "none" || style.display === "inline") continue;
      if (element.getBoundingClientRect().width === 0) continue;
      laidOut.push(element);
    }

    // The top of each chain of wide blocks: its parent is not itself wider than the measure, so this is the block
    // that lost the measure - a paragraph inside it is only following it.
    const wider = laidOut.filter((element) => element.getBoundingClientRect().width > measure + 1);
    const wideSet = new Set(wider);
    const topOfChain = new Set(
      wider
        .filter((element) => {
          for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
            if (ancestor === scroller) return true;
            if (wideSet.has(ancestor)) return false;
          }
          return true;
        })
        .map((element) => laidOut.indexOf(element)),
    );

    // THE COLUMNS are the intervals the OUTERMOST blocks on the measure were painted on: a block nested inside another
    // block that keeps the measure only follows its parent's column, so it inherits that column instead of becoming one.
    const onMeasure = new Set(
      laidOut.filter((element) => Number.parseFloat(getComputedStyle(element).maxWidth) === round(measure)),
    );
    const byColumn = new Map<string, { left: number; right: number; blocks: string[] }>();
    for (const element of onMeasure) {
      let nested = false;
      for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
        if (ancestor === scroller) break;
        if (onMeasure.has(ancestor)) {
          nested = true;
          break;
        }
      }
      if (nested) continue;
      const rect = element.getBoundingClientRect();
      const key = `${round(rect.left)}:${round(rect.right)}`;
      const column = byColumn.get(key) ?? { left: round(rect.left), right: round(rect.right), blocks: [] };
      column.blocks.push(nameOf(element));
      byColumn.set(key, column);
    }
    const columns = [...byColumn.values()].sort((left, right) => left.left - right.left);

    const scrollerRect = scroller.getBoundingClientRect();
    const read = laidOut.map(describe);
    return {
      measure,
      contentWidth: round(scroller.clientWidth),
      scroller: {
        width: round(scrollerRect.width),
        left: round(scrollerRect.left),
        right: round(scrollerRect.right),
        scrollHeight: Math.round(scroller.scrollHeight),
      },
      columns: columns.map((column) => ({ ...column, width: round(column.right - column.left) })),
      keepsMeasure: read.filter((block) => block.maxWidth === round(measure)),
      offenders: read.filter((block, index) => topOfChain.has(index) && block.declared === null),
      declared: read.filter((block) => block.declared !== null),
    };
  }, testId);
  if (reading === null) throw new Error(`the ${testId} region or its scroll container is not rendered`);
  return reading;
}

/**
 * Open a surface and wait until the blocks it is made of stop arriving.
 *
 * The surface mounts its groups as their reads answer, so the first paint is a partial surface: measured at 1440x900
 * the first read of Settings had eight blocks on the measure and no connection group at all, and the same window read
 * sixteen a moment later. A gate over a partial surface is a gate with holes in it, so the reading is taken again
 * until three consecutive reads name the same blocks - a stability the population itself proves, not a timer.
 */
async function settledSurface(page: Page, testId: string): Promise<SurfaceReading> {
  await page.waitForLoadState("networkidle");
  const fingerprint = (reading: SurfaceReading): string =>
    JSON.stringify([
      reading.keepsMeasure.map((block) => block.name),
      reading.offenders.map((block) => block.name),
      reading.declared.map((block) => block.name),
    ]);
  let reading = await readSurface(page, testId);
  let stable = 1;
  for (let attempt = 0; attempt < 20 && stable < 3; attempt += 1) {
    await page.waitForTimeout(150);
    const next = await readSurface(page, testId);
    stable = fingerprint(next) === fingerprint(reading) ? stable + 1 : 1;
    reading = next;
  }
  return reading;
}

test("every management form block is on the token's one column, at every declared width", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const rows: { surface: string; cell: string; reading: SurfaceReading }[] = [];
  for (const name of MEASURED_SURFACES) {
    const surface = WALKED_SURFACES.find((candidate) => candidate.name === name);
    if (surface === undefined) throw new Error(`the surface "${name}" is not one the shell offers`);
    await openSurface(page, surface);
    for (const cell of VIEWPORT_SIZES) {
      await page.setViewportSize(cell);
      const reading = await settledSurface(page, surface.testId);
      console.log(
        `[measure-column] ${name}@${cell.name} measure=${reading.measure} region=${JSON.stringify(reading.scroller)} content=${reading.contentWidth} ` +
          `columns=${JSON.stringify(reading.columns)} onColumn=${JSON.stringify(reading.keepsMeasure)} offenders=${JSON.stringify(reading.offenders)} ` +
          `declared=${JSON.stringify(reading.declared)}`,
      );
      rows.push({ surface: name, cell: cell.name, reading });
      await page.setViewportSize(DESKTOP);
    }
  }

  const failures: string[] = [];
  const declaredNames = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const row of rows) {
    const { surface, cell, reading } = row;
    const { measure } = reading;

    // THE COLUMNS. The blocks that take the measure are the surface's column population: grouped by the interval they
    // were painted on, each group is one column. A column is the measure wide - or the region, when the region is
    // narrower than the measure - the columns do not overlap, and the frame they make together is centred in the region,
    // which is the statement every block on this measure made when there was only one of them. Whether a surface has
    // ONE column or several is its own layout's decision (`[data-settings-tracks]` in the sheet, whose count
    // `tests/settings-two-tracks.spec.ts` holds as a function of the region); what this gate holds is that there are no
    // half-columns, no overlaps and no off-centre frames.
    if (reading.keepsMeasure.length === 0)
      failures.push(
        `${surface}@${cell}: no block on the surface takes the ${measure}px measure - the gate read the wrong region`,
      );
    const expectedColumnWidth = Math.min(measure, reading.contentWidth);
    for (const column of reading.columns) {
      if (Math.abs(column.width - expectedColumnWidth) > 1)
        failures.push(
          `${surface}@${cell}: the column holding ${column.blocks.join(", ")} is ${column.width}px wide ` +
            `(${column.left}..${column.right}) and a column here is ${expectedColumnWidth}px - the measure, or the ` +
            `region when the ${reading.contentWidth}px region is narrower than it`,
        );
    }
    for (let index = 1; index < reading.columns.length; index += 1) {
      const previous = reading.columns[index - 1]!;
      const column = reading.columns[index]!;
      if (column.left < previous.right - 1)
        failures.push(
          `${surface}@${cell}: two columns overlap - ${previous.blocks.join(", ")} at ${previous.left}..` +
            `${previous.right} and ${column.blocks.join(", ")} at ${column.left}..${column.right}. A block that is on ` +
            "the measure but not on one of the surface's columns belongs on a column, not beside it",
        );
    }
    if (reading.columns.length === 0) {
      failures.push(`${surface}@${cell}: no block on the measure was laid out at all, so the surface has no column`);
    } else {
      const frameLeft = reading.columns[0]!.left;
      const frameRight = reading.columns[reading.columns.length - 1]!.right;
      const leftMargin = frameLeft - reading.scroller.left;
      const rightMargin = reading.scroller.left + reading.contentWidth - frameRight;
      if (Math.abs(leftMargin - rightMargin) > 1)
        failures.push(
          `${surface}@${cell}: the columns sit at ${frameLeft}..${frameRight} in a ${reading.contentWidth}px region, ` +
            `leaving ${leftMargin}px on the left and ${rightMargin}px on the right - every block on this measure ` +
            "centres itself in the region, so the column or columns they make do too",
        );
    }

    // THE OFFENDERS. Wider than the declared measure, at the top of the chain, with no written reason. The column is
    // where the block belongs, so the failure says which of the block's own edges is off it.
    const columnLeft = reading.columns[0]?.left ?? reading.scroller.left;
    const columnRight = reading.columns[reading.columns.length - 1]?.right ?? reading.scroller.right;
    for (const block of reading.offenders) {
      const side =
        block.left < columnLeft - 1
          ? `its left edge at ${block.left} is left of the column's ${columnLeft}`
          : `its right edge at ${block.right} is past the column's ${columnRight}`;
      failures.push(
        `${surface}@${cell}: ${block.name} is ${block.width}px wide (${block.left}..${block.right}) in a ` +
          `${reading.scroller.width}px region whose measure is ${measure}px - ${side}. It belongs on the column: give ` +
          "it `max-width: var(--management-form-measure)` and `margin-inline: auto`, or declare its own reason for " +
          "exceeding the measure with `--exceeds-form-measure` beside its rule",
      );
    }

    // THE LEDGER. A block that says it may exceed the measure has to be a block that does, somewhere: an exemption
    // nothing needs is the same debt as a missing measure, and it would hide the block that does need one.
    for (const block of reading.declared) {
      declaredNames.set(block.name, block.declared!);
      if (block.width > measure + 1) usedNames.add(block.name);
    }
  }

  for (const [name, reason] of declaredNames) {
    if (usedNames.has(name)) continue;
    failures.push(
      `${name} declares it may exceed the form measure (${reason}) and is never wider than it in any declared ` +
        "cell - the declaration is spent, remove it",
    );
  }

  // THE READING VISITED A WIDE CELL. Below the measure every block is inside the region by construction, so a run
  // that only ever measured narrow cells would agree with itself for a reason that has nothing to do with this.
  for (const name of MEASURED_SURFACES) {
    const wide = rows.filter((row) => row.surface === name && row.reading.scroller.width >= row.reading.measure * 2);
    if (wide.length === 0)
      failures.push(
        `${name}: no declared cell handed the surface a region twice the measure, so no cell could show a second ` +
          "column - the population measured the wrong widths",
      );
  }

  expect(failures, `${failures.length} block(s) off the management column`).toEqual([]);
});
