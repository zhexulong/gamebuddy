/**
 * A container that can start scrolling mid-use reserves the strip its scrollbar will take.
 *
 * THE DEFECT CLASS
 *
 * `scrollbar-gutter` appeared zero times in this package. Every bounded scroll container therefore
 * grew a classic scrollbar the moment its content outgrew it and lost exactly that width on the
 * inline axis: the chat timeline re-wraps every bubble when a streamed reply crosses the viewport
 * height, a drawer body moves sideways when a section opens, and a management surface's form column
 * jumps when a list resolves. The fix is one declaration per container - which is exactly the kind of
 * fact a later rule can quietly delete - so the class needs a gate, not a fixed instance.
 *
 * WHAT THIS BROWSER CAN AND CANNOT SHOW (measured, not assumed)
 *
 * The shift itself cannot be reproduced in this harness. The Chromium these journeys run in draws
 * overlay scrollbars in every mode it offers - the headless shell, `channel: "chromium"`, and a
 * `--disable-features=OverlayScrollbar` launch were each measured - so `overflow-y: scroll` reports
 * `offsetWidth - clientWidth === 0` and a scrollbar takes no width from the content at all. A
 * `clientWidth` comparison across the two states is therefore green here whether or not the
 * stylesheet was fixed, and asserting it alone would be a check that agrees with itself.
 *
 * What IS measurable in this browser, and is exactly what the fix does: the reservation. A container
 * with `scrollbar-gutter: stable` reserves the scrollbar's strip **while it is still short** -
 * measured 15 px in a 400 px frame, identical in the short and the overflowing state - and a
 * container without it reserves nothing. That reading separates the fixed stylesheet from the unfixed
 * one here *and* in a browser that paints classic scrollbars, because it is taken before any
 * scrollbar exists. It is the load-bearing assertion below; the width comparison is kept beside it as
 * the invariant to protect the day a classic-scrollbar environment runs this file.
 *
 * THE POPULATION IS THE STYLESHEET
 *
 * The containers are read out of `src/style.css`: every ruleset that declares a block-axis
 * (`overflow-y`, or `overflow`) value of `auto` or `scroll`, which is the set of boxes whose own
 * scrollbar can appear and disappear. Nothing lists the containers by hand, so a new scroller joins
 * the gate by being written into the sheet. Inline-axis scrollers (`overflow-x` alone, a code block's
 * `<pre>`) are outside it: `scrollbar-gutter` reserves the gutter a *block-axis* scrollbar occupies,
 * and a horizontally scrolling box is served by neither.
 *
 * The source-reading half lives here rather than in a `tests/*.test.mjs` gate because the static
 * zone's single command line is the one place every static suite is registered, and it belongs to
 * another lane while this was written; `disabled-controls-are-quieter.spec.ts` reads the stylesheet
 * from this zone for the same reason.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "./frontend-coverage";

const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** The values that make a box a scroll container on an axis. */
const SCROLLING = new Set(["auto", "scroll"]);

/** The values that reserve the gutter. `both-edges` is the same promise with the strip mirrored. */
const RESERVING = /^stable(\s+both-edges)?$/u;

/**
 * Containers deliberately left without a reserved gutter, each with the reason it is left alone.
 *
 * Two bands: a box with no block-axis bound of its own, which can never draw a scrollbar and would
 * only lose width; and a nested list or preview that is capped and filled in one answer, where the
 * shift happens as the content is replaced wholesale and a permanent strip would narrow every short
 * state of it.
 */
const EXEMPT = new Map([
  [
    ".tavern-memory-section",
    "declares `overflow-y: auto` but no block-axis bound of its own - it is a column child of the " +
      "surface and grows with its content, so it never becomes a scroller; a reserved gutter would " +
      "only take 15 px off the notebook",
  ],
  [
    ".draft-content",
    "a `max-height: 120px` preview inside the drawer, replaced wholesale when a draft arrives: " +
      "reserving the strip would narrow every two-line draft to avoid a shift that happens while the " +
      "text under it is being replaced anyway",
  ],
  [".reference-draft-section p", "the same capped preview in the reference drawer, one selector over"],
  [
    ".composer-textarea",
    "the field the player types into: two lines at rest, the band's 176 px ceiling when the draft is long, " +
      "and it scrolls only past that ceiling. A reserved strip would narrow every line of every short draft " +
      "to avoid one reflow of the field's own text at the ceiling",
  ],
  [
    ".message-edit-field",
    "the same field on the other side of the exchange - two rows at rest, 300 px at the ceiling - and " +
      "exempt for the same reason",
  ],
  [
    ".opening-variants",
    "a nested list capped to `min(32dvh, 300px)` and generated in one answer; the region a machine " +
      "fills is the region that scrolls, and a permanent strip in a 420 px card costs the rows more " +
      "than the one-off reflow",
  ],
  [".installation-candidates", "the same capped, machine-filled list on the installation panel"],
  [
    "[data-card-import-review] .card-import-report",
    "the same capped report, filled once by an import, with the decision row kept outside it",
  ],
  [
    ".game-diagnostics-json",
    "a `<pre>` that scrolls on both axes; the gutter a horizontal scrollbar occupies is on the block " +
      "axis, which `scrollbar-gutter` does not reserve",
  ],
]);

/** Comments blanked so a `;` or `{}` inside them cannot be read as syntax. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length));
}

/** The declarations of one rule body, as `[property, value]` pairs with whitespace collapsed. */
function declarationsOf(body: string): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const part of body.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.includes("{")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    out.push([trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/\s+/gu, " ")]);
  }
  return out;
}

/** One innermost ruleset: its selector and its declarations, in source order. */
function rulesOf(css: string): readonly { selector: string; declarations: readonly (readonly [string, string])[] }[] {
  const text = blankComments(css);
  const out: { selector: string; declarations: readonly (readonly [string, string])[] }[] = [];
  const stack: { prelude: string; start: number }[] = [];
  let preludeStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      stack.push({ prelude: text.slice(preludeStart, index).trim().replace(/\s+/gu, " "), start: index });
      preludeStart = index + 1;
      continue;
    }
    if (character === "}") {
      const entry = stack.pop();
      if (entry !== undefined && !entry.prelude.startsWith("@")) {
        out.push({ selector: entry.prelude, declarations: declarationsOf(text.slice(entry.start + 1, index)) });
      }
      preludeStart = index + 1;
      continue;
    }
    if (character === ";") preludeStart = index + 1;
  }
  return out;
}

/** The block-axis overflow a rule's declarations resolve to, or null when it declares none. */
function blockAxisOverflow(declarations: readonly (readonly [string, string])[]): string | null {
  const declared = new Map(declarations);
  const shorthand = declared.get("overflow");
  if (shorthand !== undefined) {
    // `overflow: <inline> <block>`; a single value applies to both axes.
    const values = shorthand.split(" ");
    return values.length === 1 ? values[0] : values[1];
  }
  return declared.get("overflow-y") ?? null;
}

/** Every ruleset whose own block axis can scroll: the gate's population. */
function scrollContainers(css: string): readonly { selector: string; reserving: boolean }[] {
  return rulesOf(css)
    .filter((rule) => SCROLLING.has(blockAxisOverflow(rule.declarations) ?? ""))
    .map((rule) => ({
      selector: rule.selector,
      reserving: rule.declarations.some(([property, value]) => property === "scrollbar-gutter" && RESERVING.test(value)),
    }));
}

test("every scroll container in the stylesheet reserves its gutter, or is exempt with a reason", () => {
  const containers = scrollContainers(readFileSync(STYLESHEET, "utf8"));
  expect(
    containers.length,
    "blocked: the stylesheet declares no scroll container, so this gate has nothing to hold and cannot pass",
  ).toBeGreaterThan(0);
  const findings = containers
    .filter((container) => !container.reserving && !EXEMPT.has(container.selector))
    .map(
      (container) =>
        `${container.selector} can start scrolling mid-use but reserves no gutter - declare ` +
        "`scrollbar-gutter: stable`, or add it to EXEMPT with the reason it is left alone",
    );
  const reserving = containers.filter((container) => container.reserving).length;
  console.log(
    `[gutter-population] ${containers.length} examined, ${reserving} reserving, ${EXEMPT.size} exempt: ` +
      containers.map((container) => container.selector).join(", "),
  );
  expect(findings, findings.join("\n")).toEqual([]);
});

test("every gutter exemption still names a scroll container, so none outlives its reason", () => {
  const declared = new Set(scrollContainers(readFileSync(STYLESHEET, "utf8")).map((container) => container.selector));
  const stale = [...EXEMPT.keys()].filter((selector) => !declared.has(selector));
  expect(
    stale,
    `these exemptions no longer name a scroll container, so the reason they recorded is gone: ${stale.join(", ")}`,
  ).toEqual([]);
});

test("the stylesheet reader tells a reservation, an inline-axis scroller and a hidden one apart", () => {
  const selectors = (css: string) => scrollContainers(css).map((container) => container.selector);
  expect(selectors(".gate-probe-body {\n  overflow-y: auto;\n}\n"), "a block-axis scroller is the population").toEqual([
    ".gate-probe-body",
  ]);
  expect(
    scrollContainers(".gate-probe-body {\n  overflow-y: auto;\n  scrollbar-gutter: stable;\n}\n")[0]?.reserving,
    "`stable` is read as the reservation",
  ).toBe(true);
  expect(
    scrollContainers(".gate-probe-body {\n  overflow: auto;\n  scrollbar-gutter: stable both-edges;\n}\n")[0]?.reserving,
    "`stable both-edges` reserves as well",
  ).toBe(true);
  expect(
    scrollContainers(".gate-probe-body {\n  overflow: auto;\n  scrollbar-gutter: auto;\n}\n")[0]?.reserving,
    "`auto` reserves nothing",
  ).toBe(false);
  expect(selectors(".gate-probe-pre {\n  overflow-x: auto;\n}\n"), "an inline-axis scroller is outside the population").toEqual(
    [],
  );
  expect(selectors(".gate-probe-field {\n  overflow-y: hidden;\n}\n"), "`hidden` draws no scrollbar to reserve for").toEqual(
    [],
  );
});

/* ==========================================================================
   The behavioural half: the containers the player actually meets.
   ========================================================================== */

type Boxes = Readonly<{
  clientWidth: number;
  offsetWidth: number;
  gutter: number;
  scrollHeight: number;
  clientHeight: number;
  childLeft: number | null;
  childWidth: number | null;
}>;

declare global {
  interface Window {
    chatProbe: {
      setTranscript(texts: readonly string[]): void;
    };
    gutterProbe: {
      mount(parentClass: string, childClass: string): void;
      fill(childClass: string, rows: number): void;
      boxes(childClass: string): Boxes | null;
    };
  }
}

/** A transcript long enough to overflow any cell: measured in pixels, not assumed. */
const OVERFLOWING = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}. ${"x".repeat(160)}`);

/** Let React flush its commit and the browser settle layout before measuring. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The gallery: a bounded frame holding one of the product's own scroll containers, built from the
 * stylesheet's live classes rather than from a copy of their geometry. A definite height and a flex
 * column are the two things each of these containers needs before its own `overflow-y` can scroll.
 */
async function installGallery(page: Page): Promise<void> {
  await page.evaluate(() => {
    const subject = (childClass: string) => `[data-gutter-subject="${childClass}"]`;
    window.gutterProbe = {
      mount(parentClass: string, childClass: string): void {
        document.getElementById(`gutter-frame-${childClass}`)?.remove();
        const frame = document.createElement("div");
        frame.id = `gutter-frame-${childClass}`;
        frame.className = parentClass;
        frame.style.cssText =
          "position: fixed; left: 0; top: 0; width: 420px; height: 220px; display: flex; flex-direction: column;";
        const inner = document.createElement("div");
        inner.className = childClass;
        inner.setAttribute("data-gutter-subject", childClass);
        frame.appendChild(inner);
        document.body.appendChild(frame);
      },
      fill(childClass: string, rows: number): void {
        const inner = document.querySelector(subject(childClass));
        if (inner === null) return;
        inner.innerHTML = "";
        for (let index = 0; index < rows; index += 1) {
          const row = document.createElement("p");
          row.textContent = `Row ${index}. ${"x".repeat(120)}`;
          row.style.margin = "0";
          inner.appendChild(row);
        }
      },
      boxes(childClass: string): Boxes | null {
        const inner = document.querySelector(subject(childClass));
        if (inner === null) return null;
        const child = inner.firstElementChild?.getBoundingClientRect() ?? null;
        return {
          clientWidth: inner.clientWidth,
          offsetWidth: inner.offsetWidth,
          gutter: inner.offsetWidth - inner.clientWidth,
          scrollHeight: inner.scrollHeight,
          clientHeight: inner.clientHeight,
          childLeft: child === null ? null : Math.round(child.left * 100) / 100,
          childWidth: child === null ? null : Math.round(child.width * 100) / 100,
        };
      },
    };
  });
}

/** The chat timeline's own boxes, read from the real `Timeline` the product renders. */
async function timelineBoxes(page: Page): Promise<Boxes> {
  return await page.evaluate(() => {
    const box = document.querySelector("section.timeline");
    if (!(box instanceof HTMLElement)) throw new Error("the probe rendered no section.timeline");
    // The list, not a bubble: a bubble is as wide as its own line, so its box answers a question
    // about the words rather than about the column the scrollbar takes its width from.
    const rect = box.querySelector("ol.message-list")?.getBoundingClientRect() ?? null;
    return {
      clientWidth: box.clientWidth,
      offsetWidth: box.offsetWidth,
      gutter: box.offsetWidth - box.clientWidth,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      childLeft: rect === null ? null : Math.round(rect.left * 100) / 100,
      childWidth: rect === null ? null : Math.round(rect.width * 100) / 100,
    };
  });
}

/**
 * The invariant, stated once. The first assertion is the one that separates a fixed stylesheet from
 * an unfixed one in every browser; the rest are the layout promises that follow from it.
 */
function expectStable(before: Boxes, after: Boxes, where: string): void {
  expect(
    before.gutter,
    `${where}: the gutter is reserved while the container is still short - a scrollbar that arrives later has nowhere to take its width from`,
  ).toBeGreaterThan(0);
  expect(after.scrollHeight, `${where}: the content really overflows the container`).toBeGreaterThan(after.clientHeight);
  expect(after.gutter, `${where}: the reservation is the same once the content overflows`).toBe(before.gutter);
  expect(after.clientWidth, `${where}: the content column does not narrow when the scrollbar arrives`).toBe(
    before.clientWidth,
  );
  expect(after.childLeft, `${where}: the content does not move sideways`).toBe(before.childLeft);
  expect(after.childWidth, `${where}: the content does not re-wrap`).toBe(before.childWidth);
}

test("the chat timeline keeps its width while the reply streams past the viewport", async ({ page }) => {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  // The shared probe is unbounded; bound it so the transcript really scrolls.
  await page.addStyleTag({ content: "#probe-root { height: 320px; display: flex; flex-direction: column; }" });

  await page.evaluate(() => window.chatProbe.setTranscript(["The kettle is on."]));
  await settle(page);
  const before = await timelineBoxes(page);
  expect(before.scrollHeight, "the short transcript fits: this is the pre-scrollbar state").toBeLessThanOrEqual(
    before.clientHeight,
  );

  // The stream crosses the viewport height, which is the moment the player sees the jump.
  await page.evaluate((texts) => window.chatProbe.setTranscript(texts), OVERFLOWING);
  await settle(page);
  const after = await timelineBoxes(page);

  expectStable(before, after, "chat timeline");
});

test("a drawer body and a management surface keep their width when their content outgrows them", async ({ page }) => {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await installGallery(page);

  for (const selector of ["drawer-content", "surface-content"]) {
    await page.evaluate((name) => window.gutterProbe.mount("", name), selector);
    await page.evaluate((name) => window.gutterProbe.fill(name, 1), selector);
    const before = await page.evaluate((name) => window.gutterProbe.boxes(name), selector);
    expect(before, `${selector} mounted from the stylesheet's own class`).not.toBeNull();
    expect(before!.scrollHeight, `${selector}: one row fits, so no scrollbar is drawn`).toBeLessThanOrEqual(
      before!.clientHeight,
    );

    await page.evaluate((name) => window.gutterProbe.fill(name, 40), selector);
    const after = await page.evaluate((name) => window.gutterProbe.boxes(name), selector);
    expectStable(before!, after!, selector);
  }
});

test("the conversation surface reserves no gutter of its own, because the transcript inside it does", async ({
  page,
}) => {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await installGallery(page);

  // `overflow: hidden` creates a scroll container all the same, so a shared `scrollbar-gutter: stable`
  // reaches this box too and would spend the column's width on a scrollbar it can never draw.
  await page.evaluate(() => {
    window.gutterProbe.mount("surface-conversation", "surface-content");
    window.gutterProbe.fill("surface-content", 40);
  });
  const conversation = await page.evaluate(() => window.gutterProbe.boxes("surface-content"));
  expect(conversation, "the conversation's content box is mounted").not.toBeNull();
  expect(conversation!.gutter, "the conversation surface hands the gutter back to the transcript").toBe(0);
  expect(conversation!.clientWidth, "and lays its content out in the whole column").toBe(conversation!.offsetWidth);
});
