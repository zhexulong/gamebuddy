/**
 * The Memory notebook card states one fact, in one vocabulary.
 *
 * The collapse measured here is the card the player reads first. A notebook nobody had read was
 * reported as a notebook with nothing in it: `idle` fell through the panel's chain into `ready` and
 * the card printed the count of a list no read had returned - a zero that means "not measured" shown
 * in the same sentence as the zero that means "measured, and empty". The shipped DOM, mounted with
 * `idle`, read `0 memories written down so far.` and carried `data-memory-count="0"`.
 *
 * That state is unreachable through the shipped shell (a mount reads, and a refused read is `error`),
 * which is why this spec mounts the panel directly (`memory-panel-probe.tsx`).
 */
import { expect, test, type Page } from "./frontend-coverage";
import { memoryNotebookLabels } from "../src/components/memory-notebook-labels";

const PROBE = "/tests/memory-panel-probe.html";

/** What the notebook card carries, read from the DOM the probe mounted. */
const readNotebook = (page: Page) =>
  page.evaluate(() => {
    const notebook = document.querySelector<HTMLElement>("[data-memory-notebook]");
    if (notebook === null) throw new Error("the panel renders no notebook");
    const line = notebook.querySelector<HTMLElement>(".memory-notebook-count");
    if (line === null) throw new Error("the notebook renders no count line");
    const state = line.getAttribute("data-memory-state");
    return {
      text: (line.textContent ?? "").replace(/\s+/gu, " ").trim(),
      state,
      count: line.getAttribute("data-memory-count"),
      // Every element in this render that names a state, so the vocabulary can be checked as a set.
      states: [...document.querySelectorAll<HTMLElement>("[data-memory-state]")].map(
        (node) => node.getAttribute("data-memory-state") ?? "",
      ),
    };
  });

async function mount(page: Page, view: string): Promise<void> {
  await page.goto(PROBE);
  await expect(page.locator("[data-memory-panel]")).toBeVisible();
  await page.evaluate((name) => {
    (window as unknown as { memoryProbe: { mount: (view: string) => void } }).memoryProbe.mount(name);
  }, view);
}

test("a notebook nobody read says so, and prints no count", async ({ page }) => {
  await mount(page, "idle");
  const reading = await readNotebook(page);
  console.log(`[memory-notebook/idle] ${JSON.stringify(reading)}`);
  const notebook = memoryNotebookLabels("en");

  // `null` is "this state carries no count at all" - the opposite of the shipped card, which printed
  // 0 for a list no read had returned.
  expect(reading.count, "a notebook nobody read carries no count").toBeNull();
  expect(reading.text, "a notebook nobody read says exactly that").toBe(notebook.unknown);
  expect(reading.text, "no digit is printed for a count that was never taken").not.toMatch(/\d/u);
  expect(reading.state, "the not-read state has a name of its own").toBe("unknown");
});
