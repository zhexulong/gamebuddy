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

type TurnFixture = Readonly<{ state: string; canCancel: boolean; problemCode?: string }>;

type RootOptions = Readonly<{
  /** The mounted Chat's authoritative turn, or null for an idle conversation. */
  turn?: TurnFixture | null;
  /**
   * Project `chat.submit` as available while that turn exists. The real Host
   * never does (it projects the operation as `busy` whenever a turn exists); the
   * poll-budget journeys use this shape, so the composer's own lock can be told
   * apart from the turn fact.
   */
  submitAvailableWithTurn?: boolean;
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
              {
                operationId: "chat.submit",
                labelKey: "tavern.operation.submit",
                availability: options.submitAvailableWithTurn === true ? "available" : "busy",
                routeId: "chat.submit",
              },
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
            : {
                handle: turnHandle,
                state: turn.state,
                projectionRevision: 1,
                canCancel: turn.canCancel,
                ...(turn.problemCode === undefined ? {} : { problemCode: turn.problemCode }),
              },
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
 * The fields the Host reports as kept. Six of them, with the Host's own field
 * names - the identifiers the review has to translate into the player's words -
 * so the "will keep" sentence it prints wraps at every width the surface is
 * measured at: a one-line sentence cannot show where its lines are anchored, and
 * the defect the audit's screenshot caught was exactly the wrap.
 */
const KEPT_FIELDS = ["name", "persona_core", "scenario", "system_prompt", "example_1", "first_greeting"] as const;

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
  const measured = await lineAnchors(page, "[data-card-import-review-details] > li:nth-child(2)");
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
  const resultAnchors = await lineAnchors(page, "[data-card-import-details] > li:nth-child(1)");
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
      fieldDisabled: section.querySelector<HTMLTextAreaElement>(".composer-textarea")!.disabled,
    };
  });
  console.log(`[item-4 queued] ${JSON.stringify(measured)}`);

  expect(measured.fieldDisabled, "the Host projects chat.submit as busy, so the field is locked").toBe(true);

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

// --- item 7: the card-import trigger keeps its own width ---

/**
 * The import card is a column flex container
 * (`style.css` `.management-settings-section > section`), so the shared
 * `.small-button` inside it stretched to the panel's full width: measured
 * 742px inside a 744px card, with `align-self: auto`. The button is a label with
 * a 44 px floor, not a field, so it keeps its own width at the start of its column.
 */
test("item 7: the choose-file trigger is the width of its label, not the panel's", async ({ page }) => {
  await stubShell(page);
  await stubCardImport(page);
  await openCharacters(page);

  const measured = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>("[data-card-import-trigger]")!;
    const card = document.querySelector<HTMLElement>("[data-card-import]")!;
    const cardBox = card.getBoundingClientRect();
    return {
      triggerWidth: Math.round(trigger.getBoundingClientRect().width),
      cardContentWidth: Math.round(cardBox.width - 24),
      alignSelf: getComputedStyle(trigger).alignSelf,
      label: (trigger.textContent ?? "").trim(),
    };
  });
  console.log(`[item-7] ${JSON.stringify(measured)}`);

  expect(measured.label, "the trigger is the product's own labelled control").toBe("Choose card file");
  expect(
    measured.triggerWidth,
    `the trigger measures ${measured.triggerWidth}px inside a ${measured.cardContentWidth}px card`,
  ).toBeLessThan(measured.cardContentWidth / 2);
  expect(measured.triggerWidth, "and it never falls below the 44 px touch floor").toBeGreaterThanOrEqual(44);
  expect(measured.alignSelf, "the button keeps its own width in the card's column flex").toBe("flex-start");
});

// --- item 8: a Chats card clamps the created Chat's opening ---

/**
 * The text a newly created Chat's card shows is the durable opening the Host
 * minted, rendered through the companion's own Markdown renderer and clamped to
 * a few lines. A companion's first message is a paragraph, so at 400x800 the
 * card measured 217px with 168px of that being the opening alone - the first
 * screen belonged to the greeting rather than to the Chats surface. The card is
 * the acknowledgement; the conversation itself is one selection away.
 *
 * The renderer is the transcript's (`MarkdownMessage`), so the opening's `*beat*`
 * delimiters are consumed by the parse instead of printed: the card must carry
 * the opening's words with no asterisk left in front of the player.
 *
 * The card is the **refused** case's own screen. Creation now selects the new Chat
 * (the surface lands in the conversation it just made), so a player who lands back
 * on the list is one whose switch the mounted turn refused - and then this card is
 * the acknowledgement of what was created, which is why it must stay small enough
 * not to fill the list's first screen. The happy path is its own journey
 * ("creating a Chat lands in it").
 */
const LONG_OPENING = [
  "*The porch lantern is still lit when she comes out, and the morning has that",
  "washed grey light that means the frost has not lifted yet. She carries the",
  "watering can in one hand and the seed satchel in the other, and she stops at",
  "the edge of the tilled ground to look at what the two of you did yesterday.*",
  '"The parsnips took. All of them, by the look of it. Come and see."',
].join(" ");

/** The opening as the renderer reads it: the beat's own delimiters are markup. */
const RENDERED_OPENING = LONG_OPENING.replace(/\*/gu, "");

test("item 8: one long opening does not fill the whole Chats card", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await stubShell(page);
  const chatList = {
    apiVersion: 1,
    chats: [{ handle: chatHandle, title: "Farm morning", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." }],
  };
  await page.route("**/api/tavern/v1/chats?*", (route) => route.fulfill(jsonOk(chatList)));
  await page.route("**/api/tavern/v1/chats", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { handle: turnHandle, title: null, status: "active", managementRevision: 1, isSelected: false, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took." },
        opening: LONG_OPENING,
      }),
    ),
  );
  // The switch the creation asks for is refused, so the player stays on the list
  // with the card - the case this test measures.
  await page.route("**/api/tavern/v1/chat/select", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "turn_in_flight" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await surface.getByRole("button", { name: "New Chat", exact: true }).click();

  // The created Chat's card is the one that is not a list row.
  const card = surface.locator(".chat-item-card").first();
  await expect(card).toContainText("New Chat");
  const measured = await card.evaluate((node) => {
    const preview = node.querySelector<HTMLElement>(".chat-item-main")!;
    const style = getComputedStyle(preview);
    return {
      cardHeight: Math.round(node.getBoundingClientRect().height),
      previewHeight: Math.round(preview.getBoundingClientRect().height),
      text: (preview.textContent ?? "").trim(),
      beatCount: preview.querySelectorAll("em").length,
      clamp: style.getPropertyValue("-webkit-line-clamp"),
      viewportHeight: window.innerHeight,
    };
  });
  console.log(`[item-8] ${JSON.stringify({ ...measured, textLength: measured.text.length })}`);

  // The card carries the whole opening, read through the renderer: every word
  // survived the parse and the beat's delimiters did not.
  expect(measured.text, "the card carries the opening's own words, with no markup left in them").toBe(RENDERED_OPENING);
  expect(measured.text, "the player never sees the beat's asterisks").not.toContain("*");
  expect(measured.beatCount, "and the beat is the narration `<em>` the transcript renders").toBe(1);
  expect(
    measured.previewHeight,
    `the opening preview is clamped to a few lines, not the ${measured.previewHeight}px of prose it carries`,
  ).toBeLessThan(80);
  expect(
    measured.cardHeight,
    `the card measures ${measured.cardHeight}px of the ${measured.viewportHeight}px first screen`,
  ).toBeLessThan(200);
  expect(Number.parseInt(measured.clamp, 10), "and the clamp is a real line clamp").toBeGreaterThanOrEqual(2);
});

/**
 * The field's own lock and the action slot answer two different questions, and
 * this pins the split: the field follows the Host's own "would a submission be
 * accepted now" (`disabled` = `!submitAvailable`), while the slot shows the turn.
 *
 * The poll-budget journeys run with a turn the Host still reports as `running`
 * while its submit operation stays available - a shape the real Host never
 * projects (`chat.submit` is `busy` whenever a turn exists, per
 * `reference-pipeline-state.ts` `projectOperations`) - and there the field must
 * stay usable: a client-side lock keyed to the turn would outlive the poll's own
 * budget and keep the player out of the conversation for good, which is exactly
 * what `composed-reference-game-browser.spec.ts` ("a turn that never settles")
 * measures after the budget expires.
 */
test("item 4: the field's lock is the Host's submit availability, not the turn", async ({ page }) => {
  await stubShell(page, { turn: { state: "running", canCancel: false }, submitAvailableWithTurn: true });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const measured = await page.evaluate(() => ({
    fieldDisabled: document.querySelector<HTMLTextAreaElement>(".composer-textarea")!.disabled,
    busy: document.querySelectorAll(".composer-section [data-composer-busy]").length,
    stop: document.querySelectorAll(".composer-section .stop-button").length,
  }));
  console.log(`[item-4 split] ${JSON.stringify(measured)}`);

  expect(measured.busy, "the turn in flight is still shown in the action slot").toBe(1);
  expect(measured.stop, "and Stop is still withheld where the Host cannot cancel").toBe(0);
  expect(measured.fieldDisabled, "the field follows the Host's submit availability, not the turn").toBe(false);
});

// --- item 10: the opening switcher shows the Host's own variant label ---

const OPENING_VARIANT_ID = "V".repeat(42) + "A";
const openingMessageHandle = "W".repeat(42) + "A";

function openingTranscript(label: string | null) {
  return [
    {
      handle: openingMessageHandle,
      role: "companion",
      text: "The lantern over the porch is still lit.",
      locale: "und",
      order: 0,
      revision: 1,
      openingVariant: { variantId: OPENING_VARIANT_ID, index: 0, count: 2, label, locked: false },
    },
  ];
}

/**
 * The switcher printed the position and dropped the Host's own label for the
 * committed variant, which the projection has always carried: `openingVariant.label`
 * (`reference-pipeline-state.ts` `projectOpeningVariant`) is the greeting set's own
 * name for the variant - `Default`, `Alternate 1`, built from the card's 1-based
 * order (`new-companion-service.ts` `buildGreetingVariants`) - and both DTOs type
 * and validate it (`reference-pipeline-api.ts`, `management-pipeline-api.ts`).
 * Measured before the fix: the indicator read `"1/2"` for a payload labelled
 * `Default`.
 */
test("item 10: the opening switcher renders the variant label the Host published", async ({ page }) => {
  await stubShell(page, { transcript: openingTranscript("Default") });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const indicator = page.locator(".swipe-indicator");
  await expect(indicator).toBeVisible();

  const measured = await indicator.evaluate((node) => (node.textContent ?? "").trim());
  console.log(`[item-10 labelled] ${JSON.stringify(measured)}`);

  expect(measured, "the Host's own name for the variant reaches the player").toContain("Default");
  expect(measured, "and the position in the set is still shown").toContain("1/2");
});

test("item 10: a variant the Host published no label for keeps the plain position", async ({ page }) => {
  await stubShell(page, { transcript: openingTranscript(null) });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const indicator = page.locator(".swipe-indicator");
  await expect(indicator).toBeVisible();

  const measured = await indicator.evaluate((node) => (node.textContent ?? "").trim());
  console.log(`[item-10 unlabelled] ${JSON.stringify(measured)}`);

  expect(measured, "an unpublished label invents no name").toBe("1/2");
});

// --- item 11: a failed turn says which failure it was -------------------------

/**
 * The Host publishes *why* a turn failed as a closed `problemCode` on the turn
 * (`BrowserTurnV1Schema.problemCode`, `tavern_browser_api/v1`): `interrupted`,
 * `no_visible_presentation`, `runtime_unavailable` or `storage_unavailable`. The
 * surface collapsed all four into one "The reply failed. You can try again.",
 * which is a sentence about nothing the player can act on - the four outcomes
 * differ (the connection dropped, the model answered but nothing was shown, the
 * runtime was not up, the reply could not be written).
 *
 * Each code must render its own player-words sentence, and none may render the
 * raw member. The last case is the forward-compatibility one the collapse was
 * really protecting: a code this build does not know falls back to the generic
 * failure line rather than putting an enum member in front of the player.
 */
const FOUR_TURN_PROBLEM_CODES = [
  "interrupted",
  "no_visible_presentation",
  "runtime_unavailable",
  "storage_unavailable",
] as const;

test("item 11: each failed-turn problem code renders its own player sentence, never the raw member", async ({ page }) => {
  // The URL is one document with a fragment, so a second `goto` is a same-document
  // navigation and would leave the previous turn on screen. One projection is
  // served instead, its problem code read from this variable, and the page is
  // reloaded between codes.
  let problemCode: string = FOUR_TURN_PROBLEM_CODES[0];
  await stubShell(page, { turn: { state: "failed", canCancel: false } });
  // Registered after `stubShell` so these are the routes Playwright matches: it
  // resolves in reverse registration order, and the projection's own problem code
  // is the one thing this test varies.
  const projected = () => {
    const root = composedRoot({ turn: { state: "failed", canCancel: false } });
    return jsonOk({
      ...root,
      chat: {
        ...root.chat,
        chat: { ...root.chat.chat, turn: { ...root.chat.chat.turn!, problemCode } },
      },
    });
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(projected()));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(projected()));

  const readings: Record<string, string> = {};
  for (const [index, code] of FOUR_TURN_PROBLEM_CODES.entries()) {
    problemCode = code;
    if (index === 0) await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    else await page.reload();
    const notice = page.locator(".reference-turn-notice");
    await expect(notice).toContainText(/\S/u);
    readings[code] = (await notice.textContent())?.trim() ?? "";
  }
  console.log(`[item-11] ${JSON.stringify(readings)}`);

  // One distinct sentence per code - not one sentence four times.
  const known = FOUR_TURN_PROBLEM_CODES.map((code) => readings[code]);
  expect(new Set(known).size, `the four codes render four different sentences: ${JSON.stringify(readings)}`).toBe(4);
  for (const code of FOUR_TURN_PROBLEM_CODES) {
    expect(readings[code], `${code} renders a sentence`).toBeTruthy();
    expect(readings[code], `${code} never renders the raw enum member`).not.toBe(code);
    expect(readings[code], `${code}'s sentence carries no machine vocabulary`).not.toContain("_");
  }

  // A code this build's contract mirror does not know is *rejected at the
  // boundary* rather than rendered: the projection validator refuses the whole
  // turn rather than putting an unknown member in front of the player. That is the
  // stronger half of the same rule, so it is pinned here - the code reaches no
  // surface at all.
  problemCode = "a_code_from_a_newer_host";
  await page.reload();
  const body = (await page.locator("body").textContent()) ?? "";
  expect(body, "an unknown problem code is refused, not printed").not.toContain("a_code_from_a_newer_host");
  await expect(page.locator("[role=alert]"), "and the refusal is the surface's own problem view").toBeVisible();
});
