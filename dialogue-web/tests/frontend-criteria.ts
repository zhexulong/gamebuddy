import { AxeBuilder } from "@axe-core/playwright";
import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";

/**
 * Frontend criteria as executable properties.
 *
 * These are the *superset* the shipped browser journeys are instances of: a
 * journey says "the card import works today"; a criterion says "whatever we ship
 * is accessible, keyboard operable, laid out at phone and desktop widths, quiet,
 * and reachable" - so a frontend change that drops the property fails even when
 * nobody wrote a journey for the new screen.
 *
 * Authority: design/architecture/tavern-frontend-criteria.md. Each function below
 * is one obligation there; keep them one-to-one so the gate report and the
 * document cannot drift apart.
 */

/** Console/network noise collected across a walk, asserted empty by `assertQuiet`. */
export type SurfaceNoise = Readonly<{
  consoleErrors: readonly string[];
  pageErrors: readonly string[];
  serverErrors: readonly string[];
}>;

/**
 * Start collecting the two kinds of failure that a passing journey otherwise
 * hides: an exception thrown inside the app and a request the Host answered 5xx.
 * Call before `goto` - a failure during first paint is exactly what matters.
 */
export function watchSurface(page: Page): SurfaceNoise {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error).slice(0, 300)));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  return { consoleErrors, pageErrors, serverErrors };
}

/**
 * Obligation: no serious or critical accessibility violation on a rendered
 * surface, judged by the standard engine rather than by hand-rolled heuristics.
 */
export async function assertAccessibilityBaseline(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  assert.deepEqual(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
    })),
    [],
    `the ${surface} surface has no serious/critical accessibility violation`,
  );
}

/**
 * Obligation: the primary control of a surface is reachable with Tab alone,
 * starting from the document - no programmatic focus, no pointer event.
 */
export async function assertKeyboardReachable(
  page: Page,
  target: ReturnType<Page["locator"]>,
  label: string,
  maxTabs = 40,
): Promise<void> {
  let reached = false;
  for (let press = 0; press < maxTabs && !reached; press += 1) {
    await page.keyboard.press("Tab");
    reached = await target.evaluate(
      (node) => node === document.activeElement || node.contains(document.activeElement),
    );
  }
  assert.equal(reached, true, `${label} is reachable with Tab alone`);
}

/**
 * Obligation: every named region that offers a control can be reached by keyboard
 * alone. A section with nothing focusable inside it is not part of the obligation
 * (there is nothing to reach), so those are excluded rather than silently passing.
 * One bounded Tab walk records which sections received focus; the rest are named.
 */
export async function assertSectionsKeyboardReachable(
  page: Page,
  sectionSelector: string,
  maxTabs = 160,
): Promise<void> {
  const focusable =
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const labels = await page.locator(sectionSelector).evaluateAll(
    (nodes, selector) =>
      nodes
        .filter((node) => node.getAttribute("aria-label") !== null)
        .filter((node) => node.querySelector(selector) !== null)
        .map((node) => node.getAttribute("aria-label") ?? ""),
    focusable,
  );
  assert.ok(labels.length > 0, `the surface renders at least one operable ${sectionSelector}`);
  const touched = new Set<string>();
  for (let press = 0; press < maxTabs; press += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate((selector) => {
      const active = document.activeElement;
      const section = active?.closest(selector) ?? null;
      return section === null ? null : section.getAttribute("aria-label");
    }, sectionSelector);
    if (label !== null) touched.add(label);
  }
  const missed = labels.filter((label) => !touched.has(label));
  assert.deepEqual(missed, [], "every operable section is reachable by keyboard alone");
}

/**
 * Obligation: the layout floor holds at phone, tablet and desktop width - the
 * document does not scroll sideways, the primary composer stays inside the
 * viewport with a usable width, and the transcript clips nothing. Clipping is
 * measured inside the container because the app hides its own overflow, where a
 * document-level check would report 0 while text was cut.
 */
export async function assertLayoutFloor(
  page: Page,
  widths: readonly Readonly<{ width: number; height: number }>[] = [
    { width: 375, height: 667 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ],
): Promise<void> {
  for (const viewport of widths) {
    await page.setViewportSize(viewport);
    const metrics = await page.evaluate(() => {
      const transcript = document.querySelector('[role="region"][aria-label]');
      const composer = document.querySelector("textarea, input[type=text], [contenteditable=true]");
      const rect = composer?.getBoundingClientRect();
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        transcriptClipped:
          transcript === null ? null : transcript.scrollWidth - transcript.clientWidth,
        composerWidth: rect?.width ?? 0,
        composerLeft: rect?.left ?? Number.NaN,
        composerRight: rect?.right ?? Number.NaN,
        viewportWidth: window.innerWidth,
      };
    });
    const at = `${viewport.width}x${viewport.height}`;
    assert.equal(metrics.documentOverflow, 0, `the document does not scroll horizontally at ${at}`);
    assert.ok(metrics.composerWidth > 100, `the composer keeps a usable width at ${at}`);
    assert.ok(
      metrics.composerLeft >= -1 && metrics.composerRight <= metrics.viewportWidth + 1,
      `the composer stays inside the viewport at ${at}`,
    );
    if (metrics.transcriptClipped !== null)
      assert.ok(
        metrics.transcriptClipped <= 1,
        `the transcript clips no content at ${at} (${metrics.transcriptClipped})`,
      );
    // Visibility is re-checked per width: a control can be laid out and hidden,
    // and this loop just changed the viewport it was checked at.
    await expect(page.locator("body")).toBeVisible();
  }
}

/**
 * Obligation: the walk stays quiet. A surface that logs errors or answers its own
 * requests 5xx is broken even when the asserted control still works.
 */
export function assertQuiet(noise: SurfaceNoise, surface: string): void {
  assert.deepEqual(noise.pageErrors, [], `the ${surface} surface throws no uncaught error`);
  assert.deepEqual(noise.serverErrors, [], `the ${surface} surface answers no 5xx`);
  assert.deepEqual(noise.consoleErrors, [], `the ${surface} surface logs no console error`);
}
