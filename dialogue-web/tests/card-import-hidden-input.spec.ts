import { expect, test } from "@playwright/test";

/**
 * U-06: the card-import file input has no box for an overflow tool to report,
 * and the rule that excludes it from the touch floor still describes it.
 *
 * The measured defect: the input was hidden with the classic visually-hidden
 * recipe - `width: 1px; height: 1px; margin: -1px` plus `clip-path: inset(50%)`.
 * The 1 px box is still a content box, so the platform's own "No file chosen"
 * text laid out inside it and the element's own `scrollWidth` was ~139 px: every
 * layout/overflow tool reported an overflowing control (1 px high, `overX 139`).
 *
 * The fix is to give it no box at all. The hiding stays exactly the pair the
 * runtime touch-floor gate names - out of the visual flow by
 * `clip-path: inset(50%)`, out of the tab order by `tabIndex = -1` - so that
 * gate's explicit exclusion (`ui-hygiene-runtime.spec.ts`, the
 * "out of the visual flow" branch of `touchFloor()`, pinned by its own
 * "gate 3 (touch floor, exclusion)" test) keeps matching the element it was
 * written for, and this file asserts it still does.
 *
 * The assertions, and the failure each one catches:
 *  - `offsetWidth`/`offsetHeight`/`clientWidth`/`scrollWidth` are 0 and the
 *    element's rect is 0x0: catches a box that came back, which is what makes the
 *    element reportable as overflow again;
 *  - `clipPath === "inset(50%)"` and `tabIndex === -1`: catches a hiding method
 *    that stopped being the one the runtime gate's rule names;
 *  - the exclusion predicate from that gate excludes this element *by the
 *    visual-flow branch*: catches a change where the element is only excluded
 *    because it happens not to be rendered, which would silently widen the rule;
 *  - the themed trigger beside it still measures at the 44 px floor: catches a fix
 *    that left the player with no control at all.
 */

const token = "A".repeat(43);
const chatHandle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

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

/** The Characters surface's own reads, so the card-import control pair renders. */
const characterReads: Readonly<Record<string, unknown>> = {
  companions: { apiVersion: 1, companions: [] },
  persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
  scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
  greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
  "import-history": { apiVersion: 1, entries: [] },
  "world-info": { state: "none", revision: chatHandle, items: [] },
};

test("the card-import file input has no box, and the touch-floor rule still excludes it", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  for (const [path, body] of Object.entries(characterReads))
    await page.route(`**/api/tavern/v1/${path}`, (route) => route.fulfill(jsonOk(body)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();

  const measured = await surface.evaluate((node) => {
    const input = node.querySelector<HTMLElement>("[data-card-import-file]");
    const trigger = node.querySelector<HTMLElement>("[data-card-import-trigger]");
    if (input === null || trigger === null) throw new Error("the card-import control pair is not rendered");

    // The touch-floor gate's own exclusion predicate, verbatim: the two named
    // branches, in the order that gate applies them.
    const exclude = (element: HTMLElement): string | null => {
      if (element.getClientRects().length === 0) return "not rendered (no client rects)";
      if (getComputedStyle(element).clipPath === "inset(50%)")
        return "out of the visual flow (clip-path: inset(50%))";
      return null;
    };

    const box = input.getBoundingClientRect();
    return {
      input: {
        clipPath: getComputedStyle(input).clipPath,
        opacity: getComputedStyle(input).opacity,
        position: getComputedStyle(input).position,
        tabIndex: input.tabIndex,
        offsetWidth: input.offsetWidth,
        offsetHeight: input.offsetHeight,
        clientWidth: input.clientWidth,
        clientHeight: input.clientHeight,
        scrollWidth: input.scrollWidth,
        scrollHeight: input.scrollHeight,
        rectWidth: Math.round(box.width),
        rectHeight: Math.round(box.height),
        overX: input.scrollWidth - input.clientWidth,
        overY: input.scrollHeight - input.clientHeight,
      },
      excludedBy: exclude(input),
      trigger: {
        tag: trigger.tagName.toLowerCase(),
        width: Math.round(trigger.getBoundingClientRect().width),
        height: Math.round(trigger.getBoundingClientRect().height),
      },
    };
  });

  console.log(`[card-import] ${JSON.stringify(measured)}`);

  expect(measured.input.offsetWidth, "the input must have no box to overflow").toBe(0);
  expect(measured.input.offsetHeight, "the input must have no box to overflow").toBe(0);
  expect(measured.input.clientWidth, "no content box").toBe(0);
  expect(measured.input.scrollWidth, "nothing laid out inside the input").toBe(0);
  expect(measured.input.overX, "the reported overflow is gone").toBe(0);
  expect(measured.input.overY, "the reported overflow is gone").toBe(0);
  expect(measured.input.rectWidth, "no laid-out box").toBe(0);
  expect(measured.input.rectHeight, "no laid-out box").toBe(0);

  // The hiding is still the pair the runtime gate's rule names, so that rule and
  // its pinned test stay true: this is the rule that excludes it.
  expect(measured.input.clipPath, "out of the visual flow, by clip-path").toBe("inset(50%)");
  expect(measured.input.tabIndex, "not a tab stop").toBe(-1);
  expect(
    measured.excludedBy,
    "the exclusion must come from the visual-flow rule, not from the element being unrendered",
  ).toBe("out of the visual flow (clip-path: inset(50%))");

  // The player still has the control the product drew.
  expect(measured.trigger.tag).toBe("button");
  expect(measured.trigger.height, "the themed trigger keeps the 44 px floor").toBeGreaterThanOrEqual(44);
  expect(measured.trigger.width, "the themed trigger keeps the 44 px floor").toBeGreaterThanOrEqual(44);
});
