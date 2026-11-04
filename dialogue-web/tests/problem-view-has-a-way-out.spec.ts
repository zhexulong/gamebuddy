import { expect, test, type Page } from "./frontend-coverage";

/**
 * The problem screen has a way out, and the way out is a real call.
 *
 * The defect: `ProblemView.tsx` was ten lines - an `<h1>` and a `<p>` in a `role="alert"` card, no
 * retry, no refresh, no way back. Once the shell degraded, the player's only remaining move was to
 * clear their storage, because nothing on the screen could be pressed. Every read the shell makes is
 * repeatable (`rereadChat`: the composed root and the draft it carries), so the screen can offer the
 * read again - and it must be that read, not `location.reload()`, because a reload throws away the
 * place the player had for a screen that is already there.
 *
 * Two facts, and either alone is a half-fix: the control exists and is enabled, and pressing it
 * takes the read. A retry the Host refuses again is not a dead end either - the refusal's own
 * sentence lands in the same card, with the same step still offered, so the screen is never both
 * wrong and stuck.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "D".repeat(42) + "A";

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "A conversation behind a failed read",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: handle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Mounts the shell with the read that opens it refusing, and reports how often the composed state
 * read was taken - so "the press takes the read" is measured rather than inferred from the screen.
 */
async function mountOverARefusedRead(
  page: Page,
  options: Readonly<{ stateRecovers: boolean }>,
): Promise<{ stateReads: () => number }> {
  let stateReads = 0;
  // The composed boundary's refusal is the bounded `{ code }` document
  // (`composed-reference-game-browser-api.ts`, `problemFromResponse`).
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "storage_unavailable" }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    if (!options.stateRecovers)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "storage_unavailable" }),
      });
    return route.fulfill(jsonOk(root));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".problem-view")).toBeVisible();
  return { stateReads: () => stateReads };
}

/** The problem card's own reading: its words, and the controls standing in it. */
const readProblemCard = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".problem-view");
    const card = view?.querySelector<HTMLElement>(".problem-card") ?? null;
    const controls = [...(card?.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea") ?? [])].map(
      (control) => {
        const box = control.getBoundingClientRect();
        return {
          name: (control.getAttribute("aria-label") ?? control.textContent ?? "").replace(/\s+/gu, " ").trim(),
          disabled: control instanceof HTMLButtonElement ? control.disabled : false,
          width: Math.round(box.width),
          height: Math.round(box.height),
          inViewport: box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.left >= -1,
        };
      },
    );
    return {
      present: view !== null,
      title: (card?.querySelector("h1")?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      detail: (card?.querySelector("p")?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      controls,
    };
  });

test("a problem view offers the read again, and takes it", async ({ page }) => {
  const host = await mountOverARefusedRead(page, { stateRecovers: true });
  const reading = await readProblemCard(page);
  console.log(`[problem-view] ${JSON.stringify(reading)}`);

  // The card is the screen, and it says what went wrong - the part that already worked.
  expect(reading.present).toBe(true);
  expect(reading.title).not.toBe("");
  expect(reading.detail).not.toBe("");

  // The forward path: one control, enabled, painted inside the window.
  expect(
    reading.controls.map((control) => control.name),
    "the problem screen offers a step out of it",
  ).toEqual(["Read it again"]);
  const [step] = reading.controls;
  expect(step!.disabled, "the step out is not disabled").toBe(false);
  expect(step!.width, "the step out has a real box").toBeGreaterThan(0);
  expect(step!.height).toBeGreaterThan(0);
  expect(step!.inViewport, "the step out is on screen without scrolling").toBe(true);

  // Nothing had read the composed state yet: the mount spends its one-time boot token through
  // `/bootstrap`, which is the call that failed.
  expect(host.stateReads(), "the mount did not fall back to the state read").toBe(0);

  // Pressing it takes that read - the real call, not a reload - and the conversation it publishes
  // replaces the card.
  await page.getByRole("button", { name: "Read it again" }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toContainText("The kettle is on.");
  await expect(page.locator(".problem-view")).toHaveCount(0);
  expect(host.stateReads(), "the step out was the composed state read").toBeGreaterThanOrEqual(1);
});

test("a retry the Host refuses again restates the refusal and keeps the step", async ({ page }) => {
  const host = await mountOverARefusedRead(page, { stateRecovers: false });
  await page.getByRole("button", { name: "Read it again" }).click();

  // The read really was taken and really refused: the card is still the screen, and the one
  // sentence it shows is the refusal's own.
  await expect.poll(() => host.stateReads()).toBeGreaterThanOrEqual(1);
  const reading = await readProblemCard(page);
  console.log(`[problem-view/refused again] ${JSON.stringify(reading)}`);
  expect(reading.present, "a refused retry keeps the screen that describes it").toBe(true);
  expect(reading.detail).not.toBe("");
  // ...and the step is still there, so pressing again is possible without a reload.
  expect(reading.controls.map((control) => control.name)).toEqual(["Read it again"]);
  expect(reading.controls[0]!.disabled).toBe(false);
});
