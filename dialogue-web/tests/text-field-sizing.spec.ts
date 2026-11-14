import { expect, test, type Page } from "./frontend-coverage";

/**
 * The two prose fields - the composer's and a message's editor - are as tall as their words,
 * between a floor and a ceiling.
 *
 * The defect this file replaces: both fields computed that height in a `useLayoutEffect` that
 * wrote `height: auto` and then read `scrollHeight`. That read forces a synchronous layout, and it
 * ran once per keystroke in a long-lived view with the whole transcript above it, so every
 * character the player typed paid for a reflow of the conversation.
 *
 * `field-sizing: content` does the same job inside the layout engine, and the two fields now
 * declare their floor and ceiling as `min-height`/`max-height` in `style.css`. What is asserted
 * here is the property, not the mechanism:
 *
 *  1. `no layout read per keystroke` - the read-after-write pattern is counted, not assumed. The
 *     instrumentation marks a field dirty on every inline `height` write and counts the
 *     `scrollHeight` read that follows it, so the number quoted is forced layouts, not style
 *     writes. The supported path must read zero; the fallback must read non-zero, which is what
 *     proves a fallback that no longer runs is not silently covering for the primary path.
 *  2. `the clamps did not move` - a one-line value, a mid value and a value past the ceiling
 *     render inside the same bounds as before, and a value past the ceiling makes the field
 *     scroll instead of growing. The same assertion runs over both paths, so the fallback cannot
 *     drift from the sheet.
 *  3. `the fallback is only the fallback` - with `CSS.supports("field-sizing", "content")`
 *     reporting false, the honest stand-in for a browser that does not have the property, the
 *     three readings still hold and the measurement runs again.
 *
 * Both fields are mounted through `tests/chat-surface-probe.html`, which renders the real
 * `Composer` and the real `Timeline` -> `MessageBubble` -> `MessageEditor` over the real
 * stylesheet. Nothing here stubs a component.
 */

type ChatProbe = Readonly<{
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  editForm(handle: string): Readonly<{ value: string | null }> | null;
}>;

type FieldReading = Readonly<{
  height: number;
  clientHeight: number;
  scrollHeight: number;
  inlineHeight: string;
  minHeight: number;
  maxHeight: number;
  /** Two lines plus the field's own vertical box: the floor `.message-edit-field` declares as a calc. */
  twoLineFloor: number;
  overflowY: string;
  fieldSizing: string;
}>;

type LayoutCounts = Readonly<{ heightWrites: number; contentReads: number; forcedLayouts: number }>;

async function openProbe(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => (window as unknown as { chatProbe?: unknown }).chatProbe !== undefined);
}

/**
 * Count what the field itself does between keystrokes: its inline `height` writes, its
 * `scrollHeight` reads, and how many of those reads came after a write in the same turn.
 *
 * The dirty flag is what makes this a count of forced layouts rather than of reads: a read is
 * only a synchronous layout when nothing has laid the box out since the write, which is exactly
 * the `height = "auto"` -> `scrollHeight` pair this file measures.
 */
async function countFieldLayout(page: Page, selector: string): Promise<void> {
  await page.evaluate((chosen) => {
    const field = document.querySelector<HTMLTextAreaElement>(chosen);
    if (field === null) throw new Error(`no field matched ${chosen}`);
    // Chromium exposes a CSS property on the declaration as a synthesised data property, so the
    // inline write is intercepted by shadowing `height` on the declaration itself and forwarding the
    // value through `setProperty` - which is what makes the measurement reach the real CSS.
    // `scrollHeight` is a normal accessor, inherited: the chain is walked rather than a prototype
    // named by hand, because Chromium 148 moved the style accessors off `CSSStyleDeclaration`.
    const inherited = (object: object, key: string) => {
      for (let cursor: object | null = object; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const accessor = Object.getOwnPropertyDescriptor(cursor, key)?.get;
        if (typeof accessor === "function") return accessor;
      }
      throw new Error(`the harness cannot instrument ${key} on this browser`);
    };
    const contentGet = inherited(field, "scrollHeight");
    const counts = { heightWrites: 0, contentReads: 0, forcedLayouts: 0 };
    let written = false;
    Object.defineProperty(field.style, "height", {
      configurable: true,
      get: () => field.style.getPropertyValue("height"),
      set: (value: string) => {
        counts.heightWrites += 1;
        written = true;
        field.style.setProperty("height", value);
      },
    });
    Object.defineProperty(field, "scrollHeight", {
      configurable: true,
      get: () => {
        counts.contentReads += 1;
        if (written) {
          counts.forcedLayouts += 1;
          written = false;
        }
        return contentGet.call(field) as number;
      },
    });
    (window as unknown as { fieldLayoutCounts: LayoutCounts }).fieldLayoutCounts = counts;
  }, selector);
}

async function fieldLayoutCounts(page: Page): Promise<LayoutCounts> {
  return page.evaluate(() => (window as unknown as { fieldLayoutCounts: LayoutCounts }).fieldLayoutCounts);
}

async function readField(page: Page, selector: string): Promise<FieldReading> {
  return page.evaluate((chosen) => {
    const field = document.querySelector<HTMLTextAreaElement>(chosen);
    if (field === null) throw new Error(`no field matched ${chosen}`);
    const style = getComputedStyle(field);
    const verticalBox = ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"]
      .map((property) => Number.parseFloat(style.getPropertyValue(property)))
      .reduce((total, value) => total + value, 0);
    return {
      height: Math.round(field.getBoundingClientRect().height),
      clientHeight: field.clientHeight,
      scrollHeight: field.scrollHeight,
      inlineHeight: field.style.height,
      minHeight: Number.parseFloat(style.minHeight),
      maxHeight: Number.parseFloat(style.maxHeight),
      twoLineFloor: Number.parseFloat(style.lineHeight) * 2 + verticalBox,
      overflowY: style.overflowY,
      fieldSizing: style.getPropertyValue("field-sizing"),
    };
  }, selector);
}

/** Lines of a fixture value, as the field lays them out: one `<textarea>` line per `\n`. */
const lines = (count: number): string => Array.from({ length: count }, (_unused, index) => `line ${index + 1}`).join("\n");

/** The clamp reading, shared by the sheet's own path and the measured fallback. */
function expectClamps(oneLine: FieldReading, mid: FieldReading, pastMax: FieldReading, where: string): void {
  // The floor and the ceiling are read off the field the browser laid out, so the two paths cannot
  // disagree about them: whichever path produced the height, the sheet's own box limits still apply.
  expect(oneLine.height, `${where}: a one-line value sits on the floor the sheet declares`).toBe(
    Math.round(oneLine.minHeight),
  );
  expect(mid.height, `${where}: a mid value grows past the floor`).toBeGreaterThan(oneLine.height);
  expect(mid.height, `${where}: a mid value stays under the ceiling`).toBeLessThanOrEqual(
    Math.round(mid.maxHeight),
  );
  expect(pastMax.height, `${where}: a value past the ceiling stops at the ceiling`).toBe(
    Math.round(pastMax.maxHeight),
  );
  expect(pastMax.scrollHeight, `${where}: past the ceiling the words overflow the box`).toBeGreaterThan(
    pastMax.clientHeight,
  );
  expect(pastMax.overflowY, `${where}: past the ceiling the field scrolls instead of growing`).toBe("auto");
}

const COMPOSER = ".composer-textarea";
const EDITOR = '[data-testid="message-edit-field"]';

test("typing into the composer costs no forced layout per keystroke", async ({ page }) => {
  await openProbe(page);
  const field = page.locator(COMPOSER);
  await field.click();
  await countFieldLayout(page, COMPOSER);

  const typed = "Twelve chars";
  await page.keyboard.type(typed);
  const counts = await fieldLayoutCounts(page);
  const reading = await readField(page, COMPOSER);
  console.log(
    `MEASURE composer ${typed.length} keys: ${JSON.stringify(counts)} | field ${reading.height}px ` +
      `(${reading.fieldSizing || "no field-sizing"}) min ${reading.minHeight} max ${reading.maxHeight}`,
  );

  expect(await field.inputValue(), "every keystroke reached the field").toBe(typed);
  expect(counts.forcedLayouts, `${JSON.stringify(counts)}: the field must not force a layout per keystroke`).toBe(0);
});

test("editing a message costs no forced layout per keystroke", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() =>
    (window as unknown as { chatProbe: ChatProbe }).chatProbe.setConversation([{ role: "companion", text: "On the pier." }]),
  );
  await page.click('[data-handle="h0"] [data-testid="message-edit"]');
  await expect(page.locator(EDITOR)).toHaveCount(1);
  await page.locator(EDITOR).click();
  await countFieldLayout(page, EDITOR);

  const typed = "At the pier";
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(typed);
  const counts = await fieldLayoutCounts(page);
  const reading = await readField(page, EDITOR);
  console.log(
    `MEASURE editor ${typed.length} keys: ${JSON.stringify(counts)} | field ${reading.height}px ` +
      `(${reading.fieldSizing || "no field-sizing"}) min ${reading.minHeight} max ${reading.maxHeight}`,
  );

  expect(await page.locator(EDITOR).inputValue(), "every keystroke reached the field").toBe(typed);
  expect(counts.forcedLayouts, `${JSON.stringify(counts)}: the field must not force a layout per keystroke`).toBe(0);
});

test("the composer keeps its floor, its growth and its ceiling", async ({ page }) => {
  await openProbe(page);
  const supported = await page.evaluate(() => CSS.supports("field-sizing", "content"));
  console.log(`MEASURE this browser supports field-sizing: ${supported}`);

  await page.fill(COMPOSER, "Hello there.");
  const oneLine = await readField(page, COMPOSER);
  await page.fill(COMPOSER, lines(3));
  const mid = await readField(page, COMPOSER);
  await page.fill(COMPOSER, lines(20));
  const pastMax = await readField(page, COMPOSER);
  console.log(
    `MEASURE composer clamps: one-line ${oneLine.height} mid ${mid.height} past-max ${pastMax.height} ` +
      `(scroll ${pastMax.scrollHeight}/${pastMax.clientHeight}) max ${pastMax.maxHeight}`,
  );

  expectClamps(oneLine, mid, pastMax, "composer");
  // The pair the removed measurement wrote, and the pair the sheet now declares: 48 px floor
  // (`--composer-min-height`) and the 176 px ceiling `max-height` already had.
  expect(oneLine.minHeight, "composer: the floor is the composer token").toBe(48);
  expect(oneLine.maxHeight, "composer: the ceiling is the 176 px it always was").toBe(176);
  expect(supported, "this harness's Chromium is the path the sheet's own field-sizing covers").toBe(true);
});

test("a message's editor keeps its floor, its growth and its ceiling", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() =>
    (window as unknown as { chatProbe: ChatProbe }).chatProbe.setConversation([{ role: "companion", text: "On the pier." }]),
  );
  await page.click('[data-handle="h0"] [data-testid="message-edit"]');

  await page.fill(EDITOR, "At the pier.");
  const oneLine = await readField(page, EDITOR);
  await page.fill(EDITOR, lines(5));
  const mid = await readField(page, EDITOR);
  await page.fill(EDITOR, lines(30));
  const pastMax = await readField(page, EDITOR);
  console.log(
    `MEASURE editor clamps: one-line ${oneLine.height} mid ${mid.height} past-max ${pastMax.height} ` +
      `(scroll ${pastMax.scrollHeight}/${pastMax.clientHeight}) max ${pastMax.maxHeight}`,
  );

  expectClamps(oneLine, mid, pastMax, "editor");
  // The two-row floor is the same calc it was, derived here from the line box, the padding and the
  // border it is built from rather than from a second copy of the arithmetic.
  expect(oneLine.minHeight, "editor: the floor is two lines plus the field's own box").toBeCloseTo(
    oneLine.twoLineFloor,
    1,
  );
  expect(oneLine.minHeight, "editor: and that floor is the 62.8 px the strip always opened at").toBeCloseTo(62.8, 1);
  expect(oneLine.maxHeight, "editor: the ceiling is the 300 px `EDIT_FIELD_MAX_HEIGHT`").toBe(300);
});

test("a browser without field-sizing is served by the measured fallback, inside the same clamps", async ({ page }) => {
  // The honest stand-in for a browser that does not have the property: the product's own capability
  // check reports false, which is the only fact deciding whether the measurement runs.
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((property: string, value?: string) =>
      property === "field-sizing" ? false : supports(property, value as string)) as typeof CSS.supports;
  });
  await openProbe(page);
  expect(
    await page.evaluate(() => CSS.supports("field-sizing", "content")),
    "the capability check is the thing being falsified",
  ).toBe(false);

  const field = page.locator(COMPOSER);
  await field.click();
  await countFieldLayout(page, COMPOSER);

  await page.fill(COMPOSER, "Hello there.");
  const oneLine = await readField(page, COMPOSER);
  await page.fill(COMPOSER, lines(3));
  const mid = await readField(page, COMPOSER);
  await page.fill(COMPOSER, lines(20));
  const pastMax = await readField(page, COMPOSER);
  const counts = await fieldLayoutCounts(page);
  console.log(
    `MEASURE fallback composer: ${JSON.stringify(counts)} clamps one-line ${oneLine.height} mid ${mid.height} ` +
      `past-max ${pastMax.height} (scroll ${pastMax.scrollHeight}/${pastMax.clientHeight})`,
  );

  expectClamps(oneLine, mid, pastMax, "fallback composer");
  // A fallback that does not run is not a fallback: on this path the measurement is the one in use.
  expect(counts.heightWrites, `${JSON.stringify(counts)}: the fallback writes a height`).toBeGreaterThan(0);
  expect(counts.forcedLayouts, `${JSON.stringify(counts)}: the fallback measures its content`).toBeGreaterThan(0);
  expect(pastMax.inlineHeight, "the fallback is the path that writes an inline height").toBe("176px");
});

test("a browser without field-sizing is served by the measured fallback for the editor too", async ({ page }) => {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((property: string, value?: string) =>
      property === "field-sizing" ? false : supports(property, value as string)) as typeof CSS.supports;
  });
  await openProbe(page);
  await page.evaluate(() =>
    (window as unknown as { chatProbe: ChatProbe }).chatProbe.setConversation([{ role: "companion", text: "On the pier." }]),
  );
  await page.click('[data-handle="h0"] [data-testid="message-edit"]');
  await expect(page.locator(EDITOR)).toHaveCount(1);
  await countFieldLayout(page, EDITOR);

  await page.fill(EDITOR, "At the pier.");
  const oneLine = await readField(page, EDITOR);
  await page.fill(EDITOR, lines(5));
  const mid = await readField(page, EDITOR);
  await page.fill(EDITOR, lines(30));
  const pastMax = await readField(page, EDITOR);
  const counts = await fieldLayoutCounts(page);
  console.log(
    `MEASURE fallback editor: ${JSON.stringify(counts)} clamps one-line ${oneLine.height} mid ${mid.height} ` +
      `past-max ${pastMax.height} (scroll ${pastMax.scrollHeight}/${pastMax.clientHeight})`,
  );

  expectClamps(oneLine, mid, pastMax, "fallback editor");
  expect(counts.forcedLayouts, `${JSON.stringify(counts)}: the fallback measures its content`).toBeGreaterThan(0);
  expect(pastMax.inlineHeight, "the fallback is the path that writes an inline height").toBe("300px");
});
