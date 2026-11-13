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
import { MEMORY_NOTEBOOK_STATES, MEMORY_READ_STATES } from "../src/components/management-panels";
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

test("every element that names a state names one the panel declares, and one fact per render", async ({ page }) => {
  // The vocabulary is read from the panel's own declaration, not spelled again here.
  const declared = new Set<string>([...MEMORY_NOTEBOOK_STATES]);
  const readStates = new Set<string>([...MEMORY_READ_STATES]);
  expect(declared.size, "the panel declares the vocabulary its attribute carries").toBeGreaterThan(readStates.size);
  let renders = 0;
  let elements = 0;
  const failures: string[] = [];
  for (const view of ["idle", "loading", "unavailable", "error", "empty", "ready"]) {
    await mount(page, view);
    const reading = await readNotebook(page);
    renders += 1;
    elements += reading.states.length;
    if (reading.states.length === 0) failures.push(`${view}: no element names a state at all`);
    for (const value of reading.states)
      if (!declared.has(value)) failures.push(`${view}: ${JSON.stringify(value)} is not one of the panel's states`);
    // The notebook always states the read, explicitly: a missing attribute is not "ready".
    if (reading.state === null) failures.push(`${view}: the notebook leaves its state off the card`);
    // One read cannot be in two states at once: the count line and the list describe one fact, so they
    // carry one value - which is what "one render was `empty` and `ready`" broke.
    const facts = [...new Set(reading.states.filter((value) => readStates.has(value)))];
    if (facts.length > 1) failures.push(`${view}: one render is ${facts.join(" and ")} at once`);
    // A ready notebook renders its list, and the list says the same thing the count line says.
    const listed = reading.states.filter((value) => value === "ready").length;
    if (view === "ready" && listed !== 2) failures.push(`ready: ${listed} of the two ready elements named the state`);
    if (view !== "ready" && listed !== 0) failures.push(`${view}: ${listed} element(s) claim a ready list`);
  }
  expect(renders, "the probe really mounted every state").toBe(6);
  expect(elements, "the renders really carry state elements").toBeGreaterThan(0);
  expect(failures, "one attribute, one vocabulary, one fact per render").toEqual([]);
});
