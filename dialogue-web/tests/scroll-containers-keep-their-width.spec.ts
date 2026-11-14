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
 * THE POPULATION IS THE STYLESHEET, and the reading of it lives in `style-scroll-containers.ts`
 *
 * The containers are read out of `src/style.css`: every ruleset that declares a block-axis
 * (`overflow-y`, or `overflow`) value of `auto` or `scroll`, which is the set of boxes whose own
 * scrollbar can appear and disappear. Nothing lists the containers by hand, so a new scroller joins
 * by being written into the sheet, and inline-axis scrollers (`overflow-x` alone, a code block's
 * `<pre>`) stay outside it: `scrollbar-gutter` reserves the gutter a *block-axis* scrollbar
 * occupies, and a horizontally scrolling box is served by neither.
 *
 * That reader, and the exemption list it is judged against, is shared with
 * `layout-stability-gate.test.mjs` in the static zone, which holds the class - every container
 * reserves the gutter or is exempt with a reason, and no exemption outlives its selector. This file
 * keeps the half a browser is needed for: what those containers DO when the content arrives.
 */
import { type Page, expect, test } from "./frontend-coverage";

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
