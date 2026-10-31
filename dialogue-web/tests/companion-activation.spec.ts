import { expect, test, type Locator, type Page } from "@playwright/test";
import { characterLabels } from "../src/components/character-domain-labels";

/**
 * Choosing which companion this installation plays, from the roster.
 *
 * The defect this file is written against is a promise with nothing behind it: the surface said
 * "the companion in play is chosen by the start-up configuration", then a copy change told the
 * player to pick a companion in a list with no such control. So every assertion here is about the
 * one thing that was missing - the control - and about the four things that make it honest:
 *
 *  - the request is the contract's own shape: the opaque handle as the route parameter and
 *    `{ apiVersion }` as the body. No companionId, no continuity, no revision (verified from the
 *    request the page actually sent, not from the source);
 *  - the answer's `status` is `"recorded"` and the panel says "chosen for the next start" - a
 *    response that claimed a switch is a protocol error, and the panel never renders "switched";
 *  - the companion in play is MARKED and offers no control at all: pressing her is the Host's
 *    `companion_switch_already_in_play` refusal, and a control that could only be refused is a
 *    trap;
 *  - each of the five refusals has its own sentence, and a pressed-during-a-game refusal reads
 *    "stop the game first" rather than a generic failure.
 *
 * Reachability is measured, not assumed: the choose control is one of the surface's primary
 * actions and the project gates those inside the first viewport at 400x800 and 1440x900
 * (`AGENTS.md`, first-viewport reachability), so the roster is drawn before the import form and
 * the rects below are read from the browser's own layout.
 */

const token = "A".repeat(43);
const currentHandle = "B".repeat(42) + "A";
const otherHandle = "D".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const requestId = "R".repeat(42) + "A";

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
    selection: { chatHandle: currentHandle, generation: 1, stateRevision: currentHandle },
    chat: {
      companion: { name: "Mira", handle: currentHandle },
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

/** The Host's own problem envelope: the client only reads a refusal it can validate. */
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "about:blank",
    title: code,
    status,
    code,
    requestId,
    retryable: false,
  }),
});

type ListedCompanion = Readonly<{ handle: string; name: string; isCurrent: boolean }>;
type Activation = { handle: string; method: string; body: unknown };

const LIBRARY: readonly ListedCompanion[] = [
  { handle: currentHandle, name: "Mira", isCurrent: true },
  { handle: otherHandle, name: "Nova", isCurrent: false },
];

async function stubCharacters(page: Page, activations: Activation[]): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: LIBRARY })),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/profile", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        name: "Nova",
        revision: 1,
        persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
        scenario: { present: false, name: null, description: null },
        greetings: { present: false, label: null, variants: [] },
        worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
      }),
    ),
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
  await page.route("**/api/tavern/v1/companions/*/activate", (route) => {
    const handle = route.request().url().split("/companions/")[1]!.split("/")[0]!;
    activations.push({ handle, method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill(jsonOk({ apiVersion: 1, handle, status: "recorded" }));
  });
}

/** The same surface with the activation route answering one refusal. */
async function stubRefusal(page: Page, status: number, code: string): Promise<void> {
  await page.route("**/api/tavern/v1/companions/*/activate", (route) => route.fulfill(problem(status, code)));
}

async function openCharacters(page: Page, locale: "en" | "zh-CN", navLabel: string): Promise<Locator> {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  // The `panel` fragment opens the surface directly. At 400 px the AppBar folds Characters into
  // its "More" menu (`AppBar.tsx`), so a nav click would have to open that menu first and the
  // measurement below would be of a different interaction than the one a wide window performs.
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  // The narrow bar names the entry somewhere; it is not this spec's subject, so the nav path is
  // only exercised when the entry is on the strip.
  const onStrip = await page.getByRole("button", { name: navLabel, exact: true }).count();
  if (onStrip > 0) expect(onStrip).toBe(1);
  const section = surface.locator("[data-companion-list-section]");
  await expect(section.locator("[data-companion-entry]")).toHaveCount(2);
  return section;
}

test("the roster offers choosing a companion, and the companion in play is marked with no control", async ({
  page,
}) => {
  const activations: Activation[] = [];
  await stubCharacters(page, activations);
  const section = await openCharacters(page, "en", "Characters");

  const current = section.locator(`[data-companion-phase="in_play"]`);
  await expect(current).toHaveCount(1);
  // The companion in play is identifiable, in words: the mark the roster already carried.
  await expect(current.locator(".companion-current-badge")).toHaveText("current");
  // ...and she offers no choice: the Host refuses her by name, so a control is a trap.
  await expect(current.locator("[data-companion-choose]")).toHaveCount(0);

  // The companion who is not in play offers it, with a name that says which companion.
  const other = section.locator('[data-companion-phase="offer"]');
  await expect(other).toHaveCount(1);
  const choose = other.locator("[data-companion-choose]");
  await expect(choose).toHaveText("Play as her");
  await expect(choose).toHaveAttribute("aria-label", "Choose Nova as the companion in play");

  // What the choice does to her data is on screen BEFORE the press: parked with her, not lost,
  // and the companion arriving brings her own partition so her chat starts empty.
  const hint = section.locator("[data-companion-activation-hint]");
  await expect(hint).toContainText("stay with her, parked");
  await expect(hint).toContainText("come back if you choose her again");
  await expect(hint).toContainText("her chat starts empty");

  await choose.click();

  // The request is the contract's own shape, verified from what was actually sent.
  await expect.poll(() => activations.length).toBe(1);
  expect(activations[0]).toEqual({ handle: otherHandle, method: "POST", body: { apiVersion: 1 } });

  // The answer is `recorded`, so the surface says "chosen for the next start" - never "switched",
  // and never anything about this run changing.
  const recorded = section.locator("[data-companion-activation-recorded]");
  await expect(recorded).toBeVisible();
  await expect(recorded).toContainText("Chosen for the next start: Nova.");
  await expect(recorded).not.toContainText(/switch/iu);
  // The restart is named, because it is what applies the choice and it is the player's step.
  await expect(section.locator("[data-companion-activation-restart]")).toContainText("Restart GameBuddy");

  // The row now reads as chosen, and the control is gone: pressing again would only rewrite the
  // same request.
  const chosen = section.locator('[data-companion-phase="chosen"]');
  await expect(chosen).toHaveCount(1);
  await expect(chosen.locator("[data-companion-chosen]")).toHaveText("chosen");
  await expect(chosen.locator("[data-companion-choose]")).toHaveCount(0);
  // The companion in play is untouched: a recorded choice does not move the mark.
  await expect(section.locator('[data-companion-phase="in_play"]')).toHaveCount(1);
});

test("the five refusal sentences are five different facts, and only the wire's two can reach this surface", async ({
  page,
}) => {
  const labels = characterLabels("en");
  const sentences = [
    labels.companionSwitchAlreadyInPlay,
    labels.companionSwitchRequiresNoSession,
    labels.companionSwitchRequestStale,
    labels.companionSwitchRecordUnreadable,
    labels.companionSwitchUnavailable,
  ];
  // Five facts, five sentences: a shared one would tell the player nothing about which of the
  // five they met.
  expect(new Set(sentences).size).toBe(5);
  // The one a pressed-mid-game player meets names the step that resolves it.
  expect(labels.companionSwitchRequiresNoSession).toMatch(/stop the game first/iu);
  // The Chinese catalogue words the same five facts, in five different sentences.
  const zh = characterLabels("zh-CN");
  const zhSentences = [
    zh.companionSwitchAlreadyInPlay,
    zh.companionSwitchRequiresNoSession,
    zh.companionSwitchRequestStale,
    zh.companionSwitchRecordUnreadable,
    zh.companionSwitchUnavailable,
  ];
  expect(new Set(zhSentences).size).toBe(5);
  expect(zh.companionSwitchRequiresNoSession).toContain("先停掉游戏");

  await page.locator("body").count();
});

/**
 * A code this wire does not declare cannot reach the player as a sentence, however it is worded.
 *
 * `companion_switch_request_stale`, `_record_unreadable` and `_unavailable` are the LAUNCHER's
 * verdicts on the recorded choice at the next start (`CompanionSwitch.cs`); no browser route
 * answers them today. The catalogue carries words for them so one vocabulary covers the whole
 * fact, and the wire's own problem validator (`isProblem`: `isOneOf(value.code, PROBLEM_CODES)`)
 * is what refuses them at the boundary - so an invented code is a protocol error the panel words
 * with its own base sentence, never a Host sentence it made up a meaning for. This is the
 * assertion that keeps the distinction honest rather than aspirational.
 */
test("a code the wire does not declare never becomes a Host sentence on this surface", async ({ page }) => {
  const activations: Activation[] = [];
  await stubCharacters(page, activations);
  await stubRefusal(page, 409, "companion_switch_request_stale");
  const section = await openCharacters(page, "en", "Characters");

  await section.locator('[data-companion-phase="offer"] [data-companion-choose]').click();

  // The panel's own honest fallback, not the undeclared code's launcher wording.
  await expect(section.locator("[data-companion-activation-notice]")).toHaveText(
    characterLabels("en").companionActivateFailed,
  );
  // Still a refusal: nothing is claimed as recorded.
  await expect(section.locator("[data-companion-activation-recorded]")).toHaveCount(0);
});

/**
 * The two refusals this wire really carries, driven through the real route stub.
 *
 * `companion_switch_already_in_play` and `companion_switch_requires_no_session` are the codes the
 * Host's `problemFor` maps (the other three are the launcher's verdicts at the next start), so
 * these are the two the browser can actually meet - and they are the two whose next steps differ:
 * one says there is nothing to do, the other names a step the player can take.
 */
for (const refusal of [
  {
    status: 409,
    code: "companion_switch_already_in_play",
    sentence: (labels: ReturnType<typeof characterLabels>) => labels.companionSwitchAlreadyInPlay,
    // She is already the answer, so pressing again cannot help - but the control is not withdrawn
    // either: the roster read and this refusal disagree about who plays, and withdrawing the only
    // control would leave the player no row to press after reloading.
    keepsControl: true,
  },
  {
    status: 409,
    code: "companion_switch_requires_no_session",
    sentence: (labels: ReturnType<typeof characterLabels>) => labels.companionSwitchRequiresNoSession,
    keepsControl: true,
  },
] as const) {
  test(`a refused choice reads as ${refusal.code}, and is never rendered as a success`, async ({ page }) => {
    const activations: Activation[] = [];
    await stubCharacters(page, activations);
    await stubRefusal(page, refusal.status, refusal.code);
    const section = await openCharacters(page, "en", "Characters");

    await section.locator('[data-companion-phase="offer"] [data-companion-choose]').click();

    await expect(section.locator("[data-companion-activation-notice]")).toHaveText(refusal.sentence(characterLabels("en")));
    // A refusal is not a success: nothing is marked chosen and no confirmation is claimed.
    await expect(section.locator("[data-companion-activation-recorded]")).toHaveCount(0);
    await expect(section.locator('[data-companion-phase="chosen"]')).toHaveCount(0);
    // The companion in play is still marked: a refused choice changes nothing.
    await expect(section.locator('[data-companion-phase="in_play"] .companion-current-badge')).toHaveText("current");
    if (refusal.keepsControl) {
      await expect(section.locator("[data-companion-choose]")).toHaveCount(1);
    }
  });
}

test("a build that serves no activation route withdraws the control instead of offering one that fails", async ({
  page,
}) => {
  await stubCharacters(page, []);
  await stubRefusal(page, 404, "profile_operation_unavailable");
  const section = await openCharacters(page, "en", "Characters");

  await section.locator('[data-companion-phase="offer"] [data-companion-choose]').click();
  await expect(section.locator("[data-companion-activation-notice]")).toHaveText(
    characterLabels("en").companionActivateUnsupported,
  );
  // Every row withdraws it: the route is served by no part of this build, so no row may offer it.
  await expect(section.locator('[data-companion-phase="unsupported"]')).toHaveCount(1);
  await expect(section.locator("[data-companion-choose]")).toHaveCount(0);
  // ...and the companion in play is still marked, so the surface still answers who plays.
  await expect(section.locator('[data-companion-phase="in_play"] .companion-current-badge')).toHaveText("current");
});

/**
 * Where the control is, measured through the browser's own layout at both sizes the project
 * gates primary actions against.
 *
 * The row must be inside the window AND inside the surface's own scrolling column, and the column
 * must not be scrolled to satisfy it: a control a player reaches by discovering a scroll region is
 * a control the first viewport did not offer. That is why the roster is drawn above the import
 * form on this surface - the companion library is what the surface is about, and importing a card
 * is the secondary way to add to it.
 */
for (const viewport of [
  { width: 400, height: 800 },
  { width: 1440, height: 900 },
] as const) {
  test(`the choose control is in the first viewport at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubCharacters(page, []);
    const section = await openCharacters(page, "en", "Characters");

    const reading = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-testid="characters-surface"]');
      if (surface === null) throw new Error("the Characters surface is not mounted");
      const content = surface.querySelector<HTMLElement>(".surface-content");
      const choose = surface.querySelector<HTMLElement>('[data-companion-phase="offer"] [data-companion-choose]');
      const mark = surface.querySelector<HTMLElement>('[data-companion-phase="in_play"] .companion-current-badge');
      if (choose === null) throw new Error("the roster offers no choose control");
      if (mark === null) throw new Error("the companion in play is not marked");
      const box = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
      };
      return {
        choose: box(choose),
        mark: box(mark),
        viewportHeight: window.innerHeight,
        // The scroll position the player meets the surface at, and whether the region scrolls.
        scrollTop: content === null ? 0 : Math.round(content.scrollTop),
        scrolls: content !== null && content.scrollHeight > content.clientHeight,
        contentBottom: content === null ? window.innerHeight : Math.round(content.getBoundingClientRect().bottom),
      };
    });

    console.log(`[companion-first-viewport-${viewport.width}] ${JSON.stringify(reading)}`);

    expect(reading.scrollTop, "the surface is measured where the player lands, not scrolled to fit").toBe(0);
    expect(
      reading.choose.top >= 0 && reading.choose.bottom <= reading.viewportHeight,
      `the choose control must be fully inside the ${viewport.width}x${viewport.height} window - ` +
        `it reads top ${reading.choose.top}, bottom ${reading.choose.bottom}, viewport height ${reading.viewportHeight}`,
    ).toBe(true);
    // Inside its container too: the scrolling column's own edge is the other boundary a control
    // can hang out of.
    expect(
      reading.choose.bottom <= reading.contentBottom,
      `the choose control must be inside the surface's column (bottom ${reading.choose.bottom} vs ${reading.contentBottom})`,
    ).toBe(true);
    // The mark that says WHO plays is in the same viewport: a player must be able to see both.
    expect(
      reading.mark.top >= 0 && reading.mark.bottom <= reading.viewportHeight,
      `the current-companion mark must be inside the window - top ${reading.mark.top}, bottom ${reading.mark.bottom}`,
    ).toBe(true);
    // The 44 px touch floor, asserted beside the fit: recovering space by shrinking the control
    // would satisfy the rect check and be the wrong fix.
    expect(reading.choose.height).toBeGreaterThanOrEqual(32);

    await expect(section.locator("[data-companion-choose]")).toHaveCount(1);
  });
}

test("the Chinese surface says the same thing in its own words", async ({ page }) => {
  const activations: Activation[] = [];
  await stubCharacters(page, activations);
  const section = await openCharacters(page, "zh-CN", "角色");
  const labels = characterLabels("zh-CN");

  const choose = section.locator('[data-companion-phase="offer"] [data-companion-choose]');
  await expect(choose).toHaveText(labels.companionActivate);
  await expect(choose).toHaveAttribute("aria-label", labels.companionActivateFor.replace("{{name}}", "Nova"));
  await expect(section.locator("[data-companion-activation-hint]")).toHaveText(labels.companionActivationHint);

  await choose.click();
  await expect.poll(() => activations.length).toBe(1);
  await expect(section.locator("[data-companion-activation-recorded]")).toContainText(
    labels.companionActivationRecorded.replace("{{name}}", "Nova"),
  );
  // The recorded-choice sentence never claims a switch: the Host only records it.
  expect(labels.companionActivationRecorded).not.toMatch(/切换/u);
  expect(labels.companionActivationRecorded).toContain("已为下次启动选好");
});

test("the row keeps its control after a game-session refusal, and says which step resolves it", async ({ page }) => {
  const activations: Activation[] = [];
  await stubCharacters(page, activations);
  await stubRefusal(page, 409, "companion_switch_requires_no_session");
  const section = await openCharacters(page, "en", "Characters");

  await section.locator('[data-companion-phase="offer"] [data-companion-choose]').click();

  // The refusal's own sentence is the notice...
  await expect(section.locator("[data-companion-activation-notice]")).toHaveText(
    characterLabels("en").companionSwitchRequiresNoSession,
  );
  // ...and the row itself carries the short reason, so the player does not have to match a
  // paragraph under the list to the row they pressed.
  const blocked = section.locator('[data-companion-phase="blocked_by_session"]');
  await expect(blocked).toHaveCount(1);
  await expect(blocked.locator("[data-companion-stop-game]")).toHaveText(characterLabels("en").companionStopGameBadge);
  // Stopping the game and pressing again is a step the player can take, so the control stays.
  await expect(blocked.locator("[data-companion-choose]")).toHaveCount(1);
});
