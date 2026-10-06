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
 * Which obligations actually ran for the surface currently under judgement.
 *
 * A criteria function that nobody calls cannot fail, so a conformance test that
 * quietly drops one would keep passing while the requirement it stood for stopped
 * being checked. Each checker records itself here, and `assertCriteriaCoverage`
 * fails naming anything the surface declared but never executed.
 */
const executedObligations = new Set<string>();

export function resetCriteriaLedger(): void {
  executedObligations.clear();
}

export function executedCriteriaObligations(): readonly string[] {
  return [...executedObligations].sort();
}

/**
 * Obligation: the surface was judged by every criterion it declares. Call last.
 * Adding an obligation to the contract without implementing it fails here, and so
 * does removing a checker from an existing conformance test.
 */
export function assertCriteriaCoverage(
  surface: string,
  declared: readonly string[],
): void {
  const missing = declared.filter((obligation) => !executedObligations.has(obligation));
  assert.deepEqual(missing, [], `the ${surface} surface was judged by every declared criterion`);
}

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
  executedObligations.add("frontend-accessibility-baseline");
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
  executedObligations.add("frontend-keyboard-reach");
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
 *
 * One full focus cycle is walked — Tab until focus leaves the document — rather
 * than a fixed number of presses: a bound that is too small reports a section as
 * unreachable simply because the walk ran out of tabs, which is a false negative
 * and would make this criterion untrustworthy. The cap only guards against a page
 * that never releases focus.
 */
export async function assertSectionsKeyboardReachable(
  page: Page,
  sectionSelector: string,
  maxTabs = 500,
): Promise<void> {
  executedObligations.add("frontend-keyboard-reach");
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
  // Tag every focusable once so the walk can stop on a TRUE cycle (a focus target
  // it has already visited) instead of on a transient `body` observation: a React
  // re-render can drop focus to the body mid-page, and treating that as the end of
  // the cycle reports rendered, reachable sections as unreachable.
  await page.evaluate((selector) => {
    document
      .querySelectorAll(selector)
      .forEach((element, index) => element.setAttribute("data-criteria-tab-order", String(index)));
  }, focusable);
  const touched = new Set<string>();
  const visited = new Set<string>();
  for (let press = 0; press < maxTabs; press += 1) {
    await page.keyboard.press("Tab");
    const step = await page.evaluate((selector) => {
      const active = document.activeElement;
      if (active === null || active === document.body || active === document.documentElement)
        return { key: null, labels: [] };
      // Every enclosing section counts, not just the nearest one: the management
      // surface nests labelled sub-sections inside a labelled group, so a control
      // in "Your Persona" also reaches "Characters". Counting only the closest
      // ancestor reported the wrapping group as unreachable.
      const labels = [];
      for (
        let node = active.closest(selector);
        node !== null;
        node = node.parentElement === null ? null : node.parentElement.closest(selector)
      ) {
        const label = node.getAttribute("aria-label");
        if (label !== null) labels.push(label);
      }
      return {
        key: active.getAttribute("data-criteria-tab-order") ?? `other:${active.tagName}`,
        labels,
      };
    }, sectionSelector);
    if (step.key === null) continue;
    if (visited.has(step.key)) break;
    visited.add(step.key);
    for (const label of step.labels) touched.add(label);
    if (process.env.GAMEBUDDY_CRITERIA_DIAG === "1")
      console.log(`[criteria] tab ${press}: ${step.key} sections=${step.labels.join(">") || "-"}`);
  }
  const missed = labels.filter((label) => !touched.has(label));
  // Say why a missed section could not be reached: a control that is present but
  // not rendered (inside a collapsed disclosure, a hidden subtree) is a different
  // defect from one that is rendered and simply skipped by the Tab order.
  const diagnosis =
    missed.length === 0
      ? []
      : await page.locator(sectionSelector).evaluateAll(
          (nodes, input) => {
            const [selector, wanted] = input;
            return nodes
              .filter((node) => wanted.includes(node.getAttribute("aria-label") ?? ""))
              .map((node) => {
                const controls = [...node.querySelectorAll(selector)];
                return {
                  label: node.getAttribute("aria-label"),
                  controls: controls.length,
                  rendered: controls.filter((control) => control.offsetParent !== null).length,
                  inCollapsedDetails: controls.filter((control) => {
                    const details = control.closest("details");
                    return details !== null && !details.open;
                  }).length,
                };
              });
          },
          [focusable, missed],
        );
  assert.deepEqual(
    missed.map((label) => ({ label, why: diagnosis.find((row) => row.label === label) ?? null })),
    [],
    "every operable section is reachable by keyboard alone",
  );
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
  executedObligations.add("frontend-layout-floor");
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
  executedObligations.add("frontend-quiet-walk");
  assert.deepEqual(noise.pageErrors, [], `the ${surface} surface throws no uncaught error`);
  assert.deepEqual(noise.serverErrors, [], `the ${surface} surface answers no 5xx`);
  assert.deepEqual(noise.consoleErrors, [], `the ${surface} surface logs no console error`);
}
