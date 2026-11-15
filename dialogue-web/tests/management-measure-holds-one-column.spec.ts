import { type Page, expect, test } from "./frontend-coverage";
import { WALKED_SURFACES, openSurface, stubShell, token } from "./draft-surfaces";
import { DESKTOP, VIEWPORT_SIZES } from "./viewport-policy";

/**
 * The management measure is ONE column, and every block on a management surface is on it.
 *
 * THE INVARIANT, in the sheet's own words (`style.css`, the `--management-form-measure` token): a block that
 * stretches to the whole region reads as two unrelated ends - a field's label and its control, a section title and
 * its own button. The sheet states that measure once; this file reads it from the token and asks every block on the
 * two surfaces that keep it whether it is on that column.
 *
 * WHY THE POPULATION IS DERIVED AND NOT LISTED. The defect this file exists for is a family, not five selectors:
 * `[data-appearance-settings]`, `[data-sampler-temperature]`, `[data-settings-presets-disclosure]`,
 * `[data-companion-card-export-section]` and `[data-companion-world-book]` were each appended to their surface
 * after the measure went in, so each spanned the region while its siblings sat on the column (measured at 1440x900:
 * 1398 px wide on a left edge of 16, against 640 on 395..1035) - and `[data-profile-backup-section]` and
 * `[data-game-prompt-addition]` were the same defect one pass earlier. A gate over a written-out list of those
 * attributes would have passed for every one of them, which is why nothing here names a block:
 *
 *  - the COLUMN is the set of blocks whose computed `max-width` resolves to the token's own value (no second copy
 *    of 640 lives in this file);
 *  - an OFFENDER is any laid-out descendant of the surface's scroll container that is wider than that measure and
 *    does not sit inside another offender - the top of each chain, because the parent is the block that lost the
 *    measure and its paragraphs are only following it.
 *
 * That second set is what a newly appended block joins, so it is what the assertion is on: the failure names the
 * element and says which side it belongs on.
 *
 * THE EXEMPTION IS A DECLARATION, NOT A SELECTOR. One block on the Characters surface genuinely needs the width: the
 * companion grid, whose column count follows the PANEL's own width (`--characters-column-width`, pinned by
 * `tests/character-columns-follow-their-container.spec.ts`), so a form measure on it would be a second, contradictory
 * ceiling. It says so in `style.css`, in `--exceeds-form-measure` beside its rule, and this file reads that property
 * off the element: the exemption is the block's own written reason, and a declaration whose block is never wider than
 * the measure fails as spent instead of standing forever. There is no selector list here that could drift from the
 * sheet.
 *
 * THE CELLS ARE `VIEWPORT_SIZES`. The column is a fact about the width the surface is handed, so it is asked at every
 * declared width. Above the measure the column has two edges to disagree about; below it the region is narrower than
 * the measure, both readings are the region's own, and the row says so rather than pretending the comparison proved
 * something - which is why the last assertion requires at least one cell per surface where the region really is wide
 * enough to have two edges.
 *
 * The reading also logs the surface's own `scrollHeight`: bringing a block into the column narrows it, and the height
 * the surface pays for that is the other half of the trade.
 *
 * red-proof, for the class rather than the five: add
 * `[data-profile-backup-section] > p:first-of-type { width: 1200px; max-width: none }` to `style.css` ->
 *   `settings@desktop: p.management-settings-hint is 1200px wide (395..1595) in a 1408px region whose measure is 640px -
 *   its right edge at 1595 is past the column's 1035`, at every cell wide enough to have two edges. That block is in no
 *   list; before the fix, the five blocks themselves were the listing, 1398 px at 16..1414 beside the column at
 *   395..1035.
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

type SurfaceReading = Readonly<{
  measure: number;
  scroller: Readonly<{ width: number; left: number; right: number; scrollHeight: number }>;
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

    const scrollerRect = scroller.getBoundingClientRect();
    const read = laidOut.map(describe);
    return {
      measure,
      scroller: {
        width: round(scrollerRect.width),
        left: round(scrollerRect.left),
        right: round(scrollerRect.right),
        scrollHeight: Math.round(scroller.scrollHeight),
      },
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
        `[measure-column] ${name}@${cell.name} measure=${reading.measure} region=${JSON.stringify(reading.scroller)} ` +
          `onColumn=${JSON.stringify(reading.keepsMeasure)} offenders=${JSON.stringify(reading.offenders)} ` +
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

    // FAIL LOUDLY ON ZERO. A cell where nothing takes the measure is not a cell the invariant holds in; it is a cell
    // where this gate read the wrong region.
    if (reading.keepsMeasure.length === 0)
      failures.push(
        `${surface}@${cell}: no block on the surface takes the ${measure}px measure - the gate read the wrong region`,
      );

    // THE COLUMN. The blocks that take the measure ARE the column: they must agree with each other about both edges,
    // and every other block on the measure must sit inside them. Derived from the population, so a block that lands
    // on a second column is the failure, not a missing entry in a list.
    const taken = reading.keepsMeasure.filter((block) => Math.abs(block.width - measure) <= 1);
    const column = taken.length > 0 ? taken[0] : null;
    if (column !== null) {
      const lefts = new Set(taken.map((block) => block.left));
      const rights = new Set(taken.map((block) => block.right));
      if (lefts.size > 1 || rights.size > 1)
        failures.push(
          `${surface}@${cell}: the blocks on the ${measure}px measure do not share one column - ` +
            taken.map((block) => `${block.name} is ${block.width}px at ${block.left}..${block.right}`).join(", ") +
            ` (a ${reading.scroller.width}px region from ${reading.scroller.left})`,
        );
      for (const block of reading.keepsMeasure) {
        if (block.left < column.left - 1 || block.right > column.right + 1)
          failures.push(
            `${surface}@${cell}: ${block.name} takes the measure but sits at ${block.left}..${block.right}, outside ` +
              `the column at ${column.left}..${column.right} the blocks beside it establish`,
          );
      }
    } else if (reading.scroller.width >= measure) {
      // A region this wide has room for the column, so a population with no block actually taking it is a block that
      // lost the measure - reported by name rather than skipped.
      failures.push(
        `${surface}@${cell}: no block is actually ${measure}px wide inside a ${reading.scroller.width}px region`,
      );
    }

    // THE OFFENDERS. Wider than the declared measure, at the top of the chain, with no written reason. The column is
    // where the block belongs, so the failure says which of the block's own edges is off it.
    const columnLeft = column?.left ?? reading.scroller.left;
    const columnRight = column?.right ?? reading.scroller.right;
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

  // THE READING VISITED THE COLUMN. Below the measure every block is inside the region by construction, so a run
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
