import { expect, test, type Page } from "@playwright/test";

/**
 * The P1/P2 tail of the three-reviewer UI audit: the items the earlier polish
 * lane (`ui-polish-defects.spec.ts`) did not own. Every item is asserted through
 * a value the browser computes - a measured width, a computed `text-align`, the
 * ring that is actually painted - rather than through the source that produced it,
 * and every assertion quotes the number it decided on.
 *
 * Item 6 of the same list (action-beat contrast) needed no change on this tree
 * and is already pinned, with its before/after ratios, by
 * `ui-polish-defects.spec.ts` defect 1 - this lane re-ran that suite instead of
 * duplicating its measurement.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const chatHandle = "B".repeat(42) + "A";
const turnHandle = "T".repeat(42) + "A";
const importIdHandle = "D".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";

const CHARS_PANEL = "characters";

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

type TurnFixture = Readonly<{ state: string; canCancel: boolean }>;

type RootOptions = Readonly<{
  /** The mounted Chat's authoritative turn, or null for an idle conversation. */
  turn?: TurnFixture | null;
  transcript?: readonly Readonly<Record<string, unknown>>[];
}>;

function composedRoot(options: RootOptions = {}) {
  const turn = options.turn ?? null;
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations:
        turn === null
          ? [
              {
                operationId: "chat.submit",
                labelKey: "tavern.operation.submit",
                availability: "available",
                routeId: "chat.submit",
              },
            ]
          : [
              { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "busy", routeId: "chat.submit" },
              {
                operationId: "chat.cancel",
                labelKey: "tavern.operation.cancel",
                availability: turn.canCancel ? "available" : "unavailable",
                routeId: "chat.cancel",
              },
            ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle, generation: 1, stateRevision: chatHandle },
      chat: {
        companion: { name: "Mira" },
        title: null,
        transcript: options.transcript ?? [],
        draft: { revision: 0, present: false },
        turn:
          turn === null
            ? null
            : { handle: turnHandle, state: turn.state, projectionRevision: 1, canCancel: turn.canCancel },
        worldInfo: null,
      },
      memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
      eventStream: null,
    },
    game: {
      apiVersion: 1,
      build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
      csrfToken,
      browserSession: { expiresAtMs },
      game: {
        prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
        instance: { status: "none", gameTitle: null, generation: 0 },
        compatibility: { status: "unchecked", message: null },
        attachment: { status: "none", generation: 0 },
        connectionStatus: "none",
        actionAuthority: "unavailable",
        role: null,
        companionName: null,
        selectedWorld: null,
        selectedSave: null,
        capabilitySummary: { available: false, count: 0 },
        latestOutcome: "none",
      },
    },
  };
}

/** The reads every surface on this shell performs before it paints. */
async function stubShell(page: Page, options: RootOptions = {}): Promise<void> {
  const root = composedRoot(options);
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: chatHandle, name: "Mira", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
}

// --- item 1: the card-import review and result are prose, not a label/value pair ---

/**
 * The fields the Host reports as kept. Six of them, with the card's own field
 * names, so the "will keep" sentence the review prints wraps at every width the
 * surface is measured at: a one-line sentence cannot show where its lines are
 * anchored, and the defect the audit's screenshot caught was exactly the wrap.
 */
const KEPT_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example"] as const;

function stageResult() {
  return {
    apiVersion: 1,
    importId: importIdHandle,
    name: "Nova",
    candidateRevision: 1,
    fields: KEPT_FIELDS.map((field, index) => ({
      field,
      eligibility: "profile_eligible_after_explicit_review",
      chars: 10 + index,
    })),
    dispositions: [{ field: "creator_notes", classification: "preserved_opaque", reason: "not_interpreted" }],
  };
}

async function stubCardImport(page: Page): Promise<void> {
  await page.route("**/api/tavern/v1/imports", (route) => route.fulfill(jsonOk(stageResult())));
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, importId: importIdHandle, reviewedFields: [...KEPT_FIELDS], approvedAtMs: 1 })),
  );
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" })),
  );
}

async function openCharacters(page: Page): Promise<void> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=${CHARS_PANEL}`);
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

const CARD_TEXT = JSON.stringify({
  spec: "chara_card_v3",
  data: { name: "Nova", description: "A quiet astronomer." },
});

/**
 * Where a block's own text lines are anchored: the left and right edges of every
 * line box, read from a Range over the block's contents. A left-aligned block has
 * one left edge and many right edges; a right-aligned one is its mirror. This is
 * an alignment measurement, not a class check.
 */
async function lineAnchors(page: Page, selector: string) {
  return page.evaluate((wanted: string) => {
    const element = document.querySelector<HTMLElement>(wanted);
    if (element === null) return null;
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
    const round = (value: number) => Math.round(value);
    const box = element.getBoundingClientRect();
    return {
      text: (element.textContent ?? "").trim().slice(0, 80),
      textAlign: getComputedStyle(element).textAlign,
      lines: rects.length,
      lefts: [...new Set(rects.map((rect) => round(rect.left)))],
      rights: [...new Set(rects.map((rect) => round(rect.right)))],
      boxLeft: round(box.left),
      boxRight: round(box.right),
    };
  }, selector);
}

test("item 1: the import review's own sentences are left-aligned prose", async ({ page }) => {
  // A narrow surface, so the review's own sentences wrap: this is the width the
  // audit's screenshot was taken at, and where a right-aligned block shows it.
  await page.setViewportSize({ width: 400, height: 800 });
  await stubShell(page);
  await stubCardImport(page);
  await openCharacters(page);

  const surface = page.getByTestId("characters-surface");
  await surface.locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(CARD_TEXT, "utf8"),
  });
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();

  // The "will keep" row is the review's longest sentence and the one a screenshot
  // showed ragged-left: measured before the fix, its two lines ended on one right
  // edge (371, 371) and started on two (93, 66).
  const measured = await lineAnchors(page, "[data-card-import-review-details] > div:nth-child(2) > dd");
  console.log(`[item-1 review] ${JSON.stringify(measured)}`);

  expect(measured, "the review prints its keep sentence").not.toBeNull();
  expect(measured!.lines, "the measured sentence wraps, so its alignment is visible").toBeGreaterThan(1);
  expect(
    measured!.lefts.length,
    `the sentence's lines share one left edge (lefts ${JSON.stringify(measured!.lefts)}, rights ${JSON.stringify(measured!.rights)})`,
  ).toBe(1);
  expect(
    measured!.rights.length,
    `the sentence's lines end where their words end, not on a common right edge (rights ${JSON.stringify(measured!.rights)})`,
  ).toBeGreaterThan(1);

  // The result block the same class carried is prose too.
  await review.locator("[data-card-import-review-confirm]").click();
  const result = surface.locator("[data-card-import-result=created]");
  await expect(result).toBeVisible();
  const resultAnchors = await lineAnchors(page, "[data-card-import-details] > div:nth-child(1) > dd");
  console.log(`[item-1 result] ${JSON.stringify(resultAnchors)}`);
  expect(resultAnchors!.textAlign, "the result sentence reads from the left like the review").toBe("left");
});

// --- item 3: one focus ring, drawn by the composer container ---

/**
 * The composer drew two concentric rings while the player typed: the container's
 * `:focus-within` border + shadow, and the field's own `:focus` shadow 1px inside
 * it. Measured before the fix, with the field focused: the container painted
 * `rgb(200,120,125) 0px 0px 0px 1px` (the accent) and the field painted
 * `rgb(214,168,91) 0px 0px 0px 1px` (the gold keyboard ring) inside it.
 *
 * The container owns the highlight - it is the control the player sees, and the
 * focus-visibility gate already verifies (against the JSX) that this container
 * really holds the field whose outline it replaces.
 */
test("item 3: the focused composer draws the container's ring and no inner duplicate", async ({ page }) => {
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();

  const read = async () =>
    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".composer-container")!;
      const textarea = document.querySelector<HTMLElement>(".composer-textarea")!;
      const boxOf = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return { boxShadow: style.boxShadow };
      };
      return {
        focused: document.activeElement === textarea,
        container: boxOf(container),
        textarea: boxOf(textarea),
      };
    });

  const blurred = await read();
  await surface.locator(".composer-textarea").focus();
  const focused = await read();
  console.log(`[item-3] blurred ${JSON.stringify(blurred)} focused ${JSON.stringify(focused)}`);

  expect(focused.focused, "the field really holds focus").toBe(true);
  // The container is the focused composer's visible state: it draws the ring that
  // replaces the field's own outline.
  expect(focused.container.boxShadow, "the container draws the ring").not.toBe(blurred.container.boxShadow);
  expect(focused.container.boxShadow, "and the ring is drawn, not none").not.toBe("none");
  // The duplicate: the field drew a second ring inside the container's. The
  // container above still carries focus, so the inner one is not what makes the
  // keyboard position visible.
  expect(focused.textarea.boxShadow, "the field draws no second ring inside the container's").toBe(
    blurred.textarea.boxShadow,
  );
  expect(focused.textarea.boxShadow, "no ring at all on the field").toBe("none");
});

// --- item 4: the queued window is busy, and Stop only where the Host allows it ---

/**
 * The Host's `accepted_queued` window as the browser sees it: the turn state is
 * `queued` and `canCancel` is false, because the prompt has not reached durable
 * arm yet (`reference-pipeline-state.ts` `isCancellableLedger`). The composer read
 * `canCancel` as "a turn is in flight", so for that whole window it rendered the
 * *send* button - disabled, since the player had just cleared the field - with no
 * spinner and no stop: the frozen UI the audit measured.
 *
 * Measured before the fix: `sendButtons:1, stopButtons:0, busy:null`. After: no
 * send button and no stop, one busy indicator named with the same word the app
 * bar already uses for the turn.
 */
test("item 4: a queued turn reads as busy instead of a greyed-out send button", async ({ page }) => {
  await stubShell(page, { turn: { state: "queued", canCancel: false } });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".composer-container")).toBeVisible();

  const measured = await page.evaluate(() => {
    const section = document.querySelector<HTMLElement>(".composer-section")!;
    const busy = section.querySelector<HTMLElement>("[data-composer-busy]");
    const status = document.querySelector<HTMLElement>(".app-bar-status");
    return {
      sendButtons: section.querySelectorAll(".send-button").length,
      stopButtons: section.querySelectorAll(".stop-button").length,
      busy: busy === null ? null : { tag: busy.tagName.toLowerCase(), label: busy.getAttribute("aria-label") },
      statusWord: status === null ? null : status.getAttribute("aria-label"),
    };
  });
  console.log(`[item-4 queued] ${JSON.stringify(measured)}`);

  expect(measured.sendButtons, "no greyed send button stands in for a running turn").toBe(0);
  expect(measured.stopButtons, "and no Stop is offered where the Host cannot cancel").toBe(0);
  expect(measured.busy, "the slot carries a busy indicator").not.toBeNull();
  expect(
    measured.busy!.label,
    `the busy slot is named ${JSON.stringify(measured.busy!.label)}; the app bar words the same turn ${JSON.stringify(measured.statusWord)}`,
  ).toBe(measured.statusWord);
  expect(measured.busy!.label, "and the name is a real one").toBeTruthy();
});

test("item 4: Stop is offered exactly while the Host allows cancelling", async ({ page }) => {
  await stubShell(page, { turn: { state: "running", canCancel: true } });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".composer-container")).toBeVisible();

  const measured = await page.evaluate(() => ({
    sendButtons: document.querySelectorAll(".composer-section .send-button").length,
    stopButtons: document.querySelectorAll(".composer-section .stop-button").length,
    busy: document.querySelectorAll(".composer-section [data-composer-busy]").length,
  }));
  console.log(`[item-4 running] ${JSON.stringify(measured)}`);

  expect(measured.stopButtons, "a cancellable turn offers Stop").toBe(1);
  expect(measured.sendButtons, "and not Send").toBe(0);
  expect(measured.busy, "the busy indicator gives way to the Stop control").toBe(0);
});
