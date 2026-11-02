import { expect, test, type Page } from "./frontend-coverage";

/**
 * The card-import review's decision row must be in the first viewport.
 *
 * `AGENTS.md` names this defect family: "First-viewport reachability: primary
 * action controls must remain fully visible within the baseline viewport ...
 * without requiring container scroll". The sibling gate for it is
 * `installation-panel-actions.spec.ts`, which repaired the same defect on the Game
 * surface's installation panel by moving the height cap off the panel and onto the
 * candidate list.
 *
 * Here the review block itself was the offender, and the layout case was "one long
 * column with no internal scroll": the report rendered as `overflow-y: visible`,
 * one row per sentence the Host staged. Measured at 1440x900 with a thirteen-row
 * report, the review was 923 px tall inside an 844 px scrollport - its title at
 * y 805, its prose cut mid-sentence at the viewport edge, and `导入此角色卡` at
 * y 1682..1726 against a 900 px window. The player never saw the control they were
 * being asked to press.
 *
 * The assertions below are about the CONTROL, not about a class name: wherever the
 * report's bound comes from next, the confirm row must lie inside the window and
 * inside the visible box of every scroll container above it.
 */

const token = "A".repeat(43);
const chatHandle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const importIdHandle = "D".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

/**
 * The card's own fields, all of them eligible for review.
 *
 * Thirty, which is the decoder's own ceiling (`isImportFields`: at most 32), because
 * the review's report is one row per sentence and the "will keep" sentence is at its
 * longest on a card like this. The identifiers are distinct so the sentence names
 * thirty different things rather than collapsing to one (`fieldNames` de-duplicates
 * by the player's word).
 */
const KEPT = [
  "name",
  "persona_core",
  "system_prompt",
  ...Array.from({ length: 27 }, (_, index) => `persona_attribute_${String(index + 1).padStart(2, "0")}`),
] as const;

/**
 * The card keys the decoder refuses.
 *
 * `notUsed` is one sentence naming every one of them, so this is the second row
 * whose length the machine decides rather than the player.
 */
const REFUSED = Array.from({ length: 40 }, (_, index) => `unsupported_extension_${String(index + 1).padStart(2, "0")}`);

const composedRoot = {
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
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
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

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The Host's staged report for a card whose review does not fit one screen. */
function stageResult(): Record<string, unknown> {
  return {
    apiVersion: 1,
    importId: importIdHandle,
    name: "Nova",
    candidateRevision: 1,
    // The rows the report renders, in the order `reportRows` emits them: the
    // card's name, the kept fields, the refused fields, the preserved count, the
    // long-`persona_core` warning and the carried directive. Six, none of them
    // dependent on a field the review does not have yet.
    fields: KEPT.map((field) => ({
      field,
      eligibility: "profile_eligible_after_explicit_review",
      chars: field === "persona_core" ? 4_200 : 10,
    })),
    dispositions: [
      ...REFUSED.map((field) => ({
        field,
        classification: "dropped_unsupported",
        reason: "executable_or_prompt_control_field",
      })),
      { field: "card_extension_blob", classification: "preserved_opaque", reason: "bounded_inert_candidate" },
      { field: "card_extension_note", classification: "preserved_opaque", reason: "bounded_inert_candidate" },
    ],
  };
}

/**
 * A roster the player would really have.
 *
 * The import card is one block of the character panel's column flow and follows
 * this roster, so the roster's own height is part of the premise: a review that is
 * only reachable on an empty library is not reachable.
 */
const COMPANIONS = [1, 2, 3].map((index) => ({
  handle: `${"E".repeat(41)}${index}A`,
  name: `Companion ${index}`,
  isCurrent: index === 1,
}));

const characterReads: Readonly<Record<string, unknown>> = {
  companions: { apiVersion: 1, companions: COMPANIONS },
  persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
  scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
  greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
  "import-history": { apiVersion: 1, entries: [] },
  "world-info": { state: "none", revision: chatHandle, items: [] },
};

async function stubRoutes(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  for (const [path, body] of Object.entries(characterReads))
    await page.route(`**/api/tavern/v1/${path}`, (route) => route.fulfill(jsonOk(body)));
  await page.route("**/api/tavern/v1/imports", (route) => route.fulfill(jsonOk(stageResult())));
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, importId: importIdHandle, reviewedFields: [...KEPT], approvedAtMs: 1 })),
  );
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" })),
  );
}

/**
 * Stages the Host's report through the real file picker and returns the surface.
 *
 * The picker is the card's primary path, and the paste box beside it stays closed -
 * the smaller of the two amounts of content above the review. The larger one (the
 * paste path, with its textarea open) is a strictly worse premise for the same
 * assertion, so a green reading here is green there too; the fix does not depend on
 * what is above the card at all, which is what the reveal below is for.
 */
async function stageCard(page: Page) {
  await stubRoutes(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  await surface.locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } }), "utf8"),
  });
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  // The review is revealed by the product, not by this test: nothing here scrolls.
  await page.waitForTimeout(150);
  return surface;
}

/**
 * The reading: the decision controls' boxes, the window's own scroll, and every
 * scroll container above each control with whether it actually hides it.
 *
 * Nothing is scrolled into view here - the rule is that the player finds the
 * control where the product put them.
 */
const MEASURE = () => {
  const confirm = document.querySelector<HTMLElement>("[data-card-import-review-confirm]");
  const cancel = document.querySelector<HTMLElement>("[data-card-import-review-cancel]");
  const review = document.querySelector<HTMLElement>("[data-card-import-review]");
  if (confirm === null || cancel === null || review === null) return null;
  const round = (value: number) => Math.round(value);
  const box = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    return {
      top: round(rect.top),
      bottom: round(rect.bottom),
      left: round(rect.left),
      right: round(rect.right),
      width: round(rect.width),
      height: round(rect.height),
      insideViewport:
        rect.top >= -0.5 &&
        rect.bottom <= window.innerHeight + 0.5 &&
        rect.left >= -0.5 &&
        rect.right <= window.innerWidth + 0.5,
    };
  };
  /**
   * Every ancestor that scrolls its own overflow, and whether this control lies
   * inside the part of it the player can actually see. A scroll container with the
   * control outside its client box is the container hiding the control, whichever
   * one it is and whether or not anybody enumerated it.
   */
  const scrollAncestors = (node: HTMLElement) => {
    const found: { className: string; overflowY: string; scrollTop: number; scrolls: boolean; clips: boolean }[] = [];
    const rect = node.getBoundingClientRect();
    for (let ancestor = node.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const computed = getComputedStyle(ancestor);
      if (computed.overflowY !== "auto" && computed.overflowY !== "scroll") continue;
      const parentRect = ancestor.getBoundingClientRect();
      const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
      found.push({
        className: ancestor.className.toString().trim().split(/\s+/u)[0] ?? ancestor.tagName.toLowerCase(),
        overflowY: computed.overflowY,
        scrollTop: round(ancestor.scrollTop),
        scrolls: ancestor.scrollHeight > ancestor.clientHeight + 1,
        clips: rect.top < parentRect.top + borderTop - 0.5 || rect.bottom > parentRect.top + borderTop + ancestor.clientHeight + 0.5,
      });
    }
    return found;
  };
  const report = review.querySelector<HTMLElement>(".card-import-report");
  const card = document.querySelector<HTMLElement>("[data-card-import]");
  const roster = document.querySelector<HTMLElement>("[data-companion-list-section]");
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    windowScrollY: round(window.scrollY),
    card: card === null ? null : box(card),
    roster: roster === null ? null : box(roster),
    surfaceContent: [...document.querySelectorAll<HTMLElement>(".surface-content")]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => ({ scrollTop: round(node.scrollTop), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })),
    review: box(review),
    confirm: { ...box(confirm), scrollAncestors: scrollAncestors(confirm) },
    cancel: { ...box(cancel), scrollAncestors: scrollAncestors(cancel) },
    report:
      report === null
        ? null
        : {
            ...box(report),
            overflowY: getComputedStyle(report).overflowY,
            scrollHeight: report.scrollHeight,
            clientHeight: report.clientHeight,
            rows: report.querySelectorAll("li").length,
          },
  };
};

type Ancestor = { className: string; overflowY: string; scrollTop: number; scrolls: boolean; clips: boolean };
type Reading = {
  viewport: { width: number; height: number };
  windowScrollY: number;
  card: { top: number; height: number } | null;
  roster: { top: number; height: number } | null;
  surfaceContent: { scrollTop: number; scrollHeight: number; clientHeight: number }[];
  review: { top: number; bottom: number; height: number; insideViewport: boolean };
  confirm: { top: number; bottom: number; height: number; insideViewport: boolean; scrollAncestors: Ancestor[] };
  cancel: { top: number; bottom: number; height: number; insideViewport: boolean; scrollAncestors: Ancestor[] };
  report: {
    top: number;
    bottom: number;
    height: number;
    overflowY: string;
    scrollHeight: number;
    clientHeight: number;
    rows: number;
  } | null;
};

async function measure(page: Page): Promise<Reading> {
  const reading = (await page.evaluate(MEASURE)) as unknown as Reading | null;
  if (reading === null) throw new Error("the characters surface renders no card-import review");
  console.log(`[card-import-review] ${JSON.stringify(reading)}`);
  return reading;
}

test.describe("the card-import review's decision row is in the first viewport", () => {
  test("at 1440x900 the confirm control is fully inside the window", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await stageCard(page);
    const reading = await measure(page);

    expect(reading.viewport).toEqual({ width: 1440, height: 900 });
    // The window itself never scrolls: what moves is the surface's own region, and
    // it is moved by the product when the review appears, not by the player.
    expect(reading.windowScrollY, "the page is not scrolled").toBe(0);

    expect(
      reading.confirm.insideViewport,
      `导入此角色卡 reads y ${reading.confirm.top}..${reading.confirm.bottom} against a 900 px window ` +
        `(the review starts at ${reading.review.top}, a ${reading.review.height} px box)`,
    ).toBe(true);
    expect(reading.confirm.top, "the confirm control is not above the window").toBeGreaterThanOrEqual(0);
    expect(reading.confirm.bottom, "the confirm control is not below the fold").toBeLessThanOrEqual(900);
    expect(reading.confirm.height, "and it keeps its 44 px touch floor").toBeGreaterThanOrEqual(44);
    expect(reading.cancel.insideViewport, "取消 is beside it and equally reachable").toBe(true);

    // The whole review, not only its last row: a decision presented half off-screen
    // is the defect this gate exists for.
    //
    // What is asserted here is the CONTROL and the row it sits in, and deliberately
    // not "the review block is in the window". The review's own top is decided by
    // the companion roster above it in this surface's column flow - measured at
    // 737 px on a three-companion roster - which no rule inside the card can move.
    // The row is therefore pinned to the card's own bottom edge instead, and the
    // two statements that make that a footer rather than a floating bar are: the
    // row is inside the card's box (below), and the card is reachable in one scroll
    // (the next test).
    expect(
      reading.confirm.top >= reading.review.top && reading.confirm.bottom <= reading.review.bottom,
      `the decision row stays inside its own card - row ${reading.confirm.top}..${reading.confirm.bottom}, ` +
        `card ${reading.review.top}..${reading.review.bottom}`,
    ).toBe(true);

    // Nothing scrolls a decision control: the report may scroll the prose, and the
    // surface region may scroll to the review, but neither may hide the controls.
    for (const [what, control] of [
      ["导入此角色卡", reading.confirm],
      ["取消", reading.cancel],
    ] as const)
      expect(
        control.scrollAncestors.filter((ancestor) => ancestor.clips),
        `no scroll container hides ${what} (${JSON.stringify(control.scrollAncestors)})`,
      ).toEqual([]);

    // The one region that does scroll is the report - the part the machine fills.
    expect(reading.report, "the review renders its staged report as one list").not.toBeNull();
    expect(["auto", "scroll"], "the report is the region that scrolls its overflow").toContain(
      reading.report!.overflowY,
    );
  });

  /**
   * The other half of the rule: pinning the row may not hide the prose it asks the
   * player to confirm. One scroll of the surface - the scroll a reader makes anyway -
   * brings the whole review into the window, and the decision row is still there.
   */
  test("one scroll brings the whole review into view and the row comes with it", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const surface = await stageCard(page);

    // The player scrolls the surface's own region to the review - exactly what the
    // revealed review has to survive. This is the reader's scroll, not a programmatic
    // focus jump: the region is the thing that scrolls.
    await surface.locator(".surface-content").evaluate((content) => {
      const review = content.querySelector<HTMLElement>("[data-card-import-review]");
      if (review === null) return;
      content.scrollTop += review.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
    });
    const reading = await measure(page);

    expect(reading.review.insideViewport, "the whole review is readable in the window").toBe(true);
    expect(reading.confirm.insideViewport, "and the decision row is still visible beside it").toBe(true);
    expect(reading.report, "the report is on screen too, not hidden behind the pinned row").not.toBeNull();
    expect(
      reading.report!.top,
      `the report starts at its own place in the card, above the pinned row (row top ${reading.confirm.top})`,
    ).toBeLessThanOrEqual(reading.confirm.top);
    expect(reading.windowScrollY, "still nothing scrolls the window itself").toBe(0);
  });

  /**
   * The other half of the rule: bounding the report may not clip it. Every row the
   * Host staged is still rendered, and all of it is reachable by scrolling inside
   * the report's own region - the prose is never shortened or cut off to make the
   * decision row fit.
   *
   * Measured at 1440x600, where `min(32dvh, 300px)` really bites (192 px), so the
   * overflow this asserts is the cap's own and not a coincidence of one card's
   * vocabulary.
   */
  test("the staged report stays fully readable by scrolling inside its own region", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 600 });
    await stageCard(page);
    const reading = await measure(page);
    const report = reading.report!;

    // Six sentences: the card's name, the kept-field line, the refused-field line,
    // the preserved count, the long-persona warning and the carried directive.
    // Bounding the region is not dropping rows.
    expect(report.rows, "one row per staged sentence").toBe(6);
    expect(report.height, "the report does not take the whole card").toBeLessThanOrEqual(320);
    expect(
      report.scrollHeight,
      "the rows are all still there, taller than the region that shows them",
    ).toBeGreaterThan(report.clientHeight + 1);

    const lastRow = (await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>("[data-card-import-review] .card-import-report");
      if (list === null) return null;
      const rows = list.querySelectorAll<HTMLElement>("li");
      const last = rows[rows.length - 1] ?? null;
      if (last === null) return null;
      list.scrollTop = list.scrollHeight;
      const listRect = list.getBoundingClientRect();
      const rowRect = last.getBoundingClientRect();
      const result = {
        rowTop: Math.round(rowRect.top),
        rowBottom: Math.round(rowRect.bottom),
        listTop: Math.round(listRect.top),
        listBottom: Math.round(listRect.bottom),
        scrolled: list.scrollTop > 0,
      };
      list.scrollTop = 0;
      return result;
    })) as { rowTop: number; rowBottom: number; listTop: number; listBottom: number; scrolled: boolean } | null;
    expect(lastRow, "the report has a last row").not.toBeNull();
    expect(lastRow!.scrolled, "the report really scrolls its own overflow").toBe(true);
    expect(lastRow!.rowTop, "the last row's top is inside the report once it is scrolled to the end").toBeGreaterThanOrEqual(
      lastRow!.listTop - 1,
    );
    expect(
      lastRow!.rowBottom,
      "and its bottom is inside the report - the prose is not clipped away",
    ).toBeLessThanOrEqual(lastRow!.listBottom + 1);

    // Scrolling the prose does not move the decision row.
    const after = await measure(page);
    expect(after.confirm.top, "the confirm control holds its place while the prose scrolls").toBe(reading.confirm.top);
  });
});
