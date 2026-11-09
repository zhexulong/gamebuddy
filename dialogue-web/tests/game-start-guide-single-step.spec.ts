/**
 * The getting-going guide names ONE next step, and never asks for a step the player has already
 * taken.
 *
 * design/research/game-first-run-review-2026-10-21.md measured the first run and found the first
 * guide step split into two buttons - "Enable companion play" and "Set up Stardew Valley" - with the
 * one order the Host accepts stated nowhere except in the refusal a player got for picking the
 * second one first. Two things were wrong with the shape, and they are separate defects:
 *
 *   1. Two equal-weight controls that only work in sequence make the primary action ambiguous, and
 *      the `<ol>` they sat in stated an order as markup that the product reached by refusal.
 *   2. The step was drawn from the projection alone, so a player whose attempt was already staged
 *      and whose installation was already registered - `activated_not_launched`, where the launch
 *      is what is next - was still walked through step 1, with no control in it and copy telling
 *      them to press two buttons that were not there.
 *
 * What is asserted here, at 400x800 AND 1440x900 (the narrow window is where a second control has
 * nowhere to hide):
 *
 *   (a) exactly one primary control is inside the first viewport while both staging actions apply;
 *   (b) that control is the action the phase itself declares (`forwardActions[0]` from
 *       `src/game-lifecycle-controls.ts`), so the panel's claim and the product's derivation are one
 *       fact rather than two that agree today;
 *   (c) with the projection where that precondition is already satisfied, step 1 is not offered at
 *       all and the next action (the launch) is;
 *   (d) the second staging action is still reachable - behind the disclosure - and is not a second
 *       `.primary`;
 *   (e) negatively: no ordered list enumerates the two as successive steps, which is the shape this
 *       replaces. `game-guide-step-one-order` must not exist and step 1 must carry no `<ol>`.
 *
 * The population is the product's own: both fixtures are `GAME_SESSION_INPUTS`' projections, and
 * every expectation about *which* action leads is read back out of `deriveGameSessionControls`. A
 * phase whose first action this spec has no control for fails by name instead of skipping the case.
 */
import { GAME_SESSION_INPUTS, deriveGameSessionControls } from "../src/game-lifecycle-controls";
import { messages } from "../src/i18n";
import { expect, test, type Page } from "./frontend-coverage";

const token = "A".repeat(43);
const chatHandle = "B".repeat(42) + "A";
const companionHandle = "D".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const en = messages("en");
const zh = messages("zh-CN");

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * The two Game phases this guide has to tell apart: the one where the staging step is next, and the
 * one where it is behind the player and the launch is.
 */
type Phase = "pre_activation" | "activated_not_launched";

/** The two windows every assertion is made in. */
const VIEWPORTS = [
  { width: 400, height: 800, label: "400x800" },
  { width: 1440, height: 900, label: "1440x900" },
] as const;

/** The projection the product itself declares for one phase, and not a second copy of it. */
function projection(phase: Phase): unknown {
  const envelope = GAME_SESSION_INPUTS[phase].game;
  if (envelope === null) throw new Error(`GAME_SESSION_INPUTS.${phase} publishes no Game projection`);
  return envelope.game;
}

/** The action the phase declares as its first step, from the derivation the panel reads. */
function declaredFirstAction(phase: Phase): string {
  const action = deriveGameSessionControls(GAME_SESSION_INPUTS[phase]).forwardActions[0];
  if (action === undefined) throw new Error(`game phase ${phase} declares no forward action`);
  return action;
}

/** The control the guide must draw one forward action as, for every action it can lead with here. */
const ACTION_CONTROL: Readonly<Record<string, string>> = {
  activate: "game-activate",
  setup: "game-setup",
  launch: "game-launch",
};

function controlOf(action: string): string {
  const control = ACTION_CONTROL[action];
  if (control === undefined)
    throw new Error(
      `the guide's step leads with "${action}", which this spec has no control for - declare it in ` +
        "ACTION_CONTROL so the case is measured instead of skipped",
    );
  return control;
}

/** The hint the step must show for the action it leads with: what the control is for. */
const ACTION_HINT: Readonly<Record<string, string>> = {
  activate: en.gameActivationHint,
  setup: en.gameSetupHint,
};

function hintOf(action: string): string {
  const hint = ACTION_HINT[action];
  if (hint === undefined) throw new Error(`the guide's step leads with "${action}", whose hint this spec does not know`);
  return hint;
}

/** The composed root around one Game projection: the Chat half the shell needs, then the Game half. */
function composedRoot(phase: Phase): unknown {
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
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle, generation: 1, stateRevision: chatHandle },
      chat: {
        companion: { name: "Mira", handle: companionHandle },
        title: "Reference Game Chat",
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
      game: projection(phase),
    },
  };
}

/** Mounts the real shell over the real routes, every one answered on this origin. */
async function mountGame(
  page: Page,
  phase: Phase,
  locale: "en" | "zh-CN",
  viewport: { width: number; height: number },
): Promise<void> {
  const root = composedRoot(phase);
  await page.setViewportSize(viewport);
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  // The Host's own answer while no Player Host instance has been launched: there is no session to
  // read cabins from, which is the third step's own not-yet state.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_handoff_unavailable" }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/retry", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/cancel", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "cancelled" })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/u, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: "P".repeat(42) + "A", memories: [], chapters: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: "W".repeat(42) + "A", items: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({
        revision: 1,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(jsonOk({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: locale === "zh-CN" ? "zh-CN" : "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
        recommendedModels: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: companionHandle, name: "Mira", isCurrent: true }] })),
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

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  const entry = page.getByRole("button", { name: locale === "zh-CN" ? "游戏" : "Game", exact: true });
  const surface = page.getByTestId("game-surface");
  if (!(await surface.isVisible())) await entry.click();
  await expect(surface).toBeVisible();
}

type GuideReading = Readonly<{
  /** Every `.primary` control that is painted and wholly inside the window, by `data-testid`. */
  primaryInViewport: readonly string[];
  /** `data-guide-action` of step 1: the one action it leads with. `null` while step 1 is absent. */
  stepOneAction: string | null;
  /** Whether step 1 exists at all - the shape that asked for work already done, with no control in it. */
  stepOnePresent: boolean;
  /** `<ol>` elements inside step 1: the shape that enumerated the two staging steps. */
  stepOneOrderedLists: number;
  /** The replaced ordered sub-list itself, if anything still renders it. */
  legacyOrderLists: number;
  /** The staging controls a player can actually see, by `data-testid`. */
  visibleStaging: readonly string[];
  /** The disclosure's own summary text, or `null` when it is not rendered. */
  summary: string | null;
  /** Step 1's hint sentence: what its control is for. */
  hint: string;
  /** Step 1's own line of copy. */
  detail: string;
}>;

/**
 * What the guide says, read off the browser's own layout after the region is scrolled to its top:
 * the first viewport is the landing view, not wherever a previous read left it.
 */
async function readGuide(page: Page): Promise<GuideReading> {
  return await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="game-state-panel"]');
    if (panel === null) throw new Error("game-state-panel never mounted");
    const scroller = panel.querySelector<HTMLElement>(".surface-content");
    if (scroller !== null) scroller.scrollTop = 0;
    const squash = (value: string | null | undefined): string => (value ?? "").replace(/\s+/gu, " ").trim();
    const style = (node: Element): CSSStyleDeclaration => getComputedStyle(node);
    // `checkVisibility` is the browser's own answer to "is this painted": a child of a closed
    // `<details>` keeps a layout box, so geometry alone would count a control the player cannot see.
    const painted = (node: Element): boolean => {
      if (!node.checkVisibility()) return false;
      const box = node.getBoundingClientRect();
      return style(node).visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const inWindow = (node: Element): boolean => {
      const box = node.getBoundingClientRect();
      return box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.left >= -1 && box.right <= window.innerWidth + 1;
    };
    const testId = (node: Element): string => node.getAttribute("data-testid") ?? "";
    const stepOne = panel.querySelector<HTMLElement>('[data-guide-step="1"]');
    return {
      primaryInViewport: [...panel.querySelectorAll(".game-action.primary")]
        .filter((node) => painted(node) && inWindow(node))
        .map(testId),
      stepOneAction: stepOne?.getAttribute("data-guide-action") ?? null,
      stepOnePresent: stepOne !== null,
      stepOneOrderedLists: stepOne === null ? 0 : stepOne.querySelectorAll("ol").length,
      legacyOrderLists: panel.querySelectorAll('[data-testid="game-guide-step-one-order"]').length,
      visibleStaging: [...panel.querySelectorAll('[data-testid="game-activate"], [data-testid="game-setup"]')]
        .filter((node) => painted(node) && inWindow(node))
        .map(testId),
      summary: squash(
        panel.querySelector('[data-testid="game-guide-step-one-alternate"] summary')?.textContent,
      ) || null,
      hint: squash(stepOne?.querySelector(".game-subpanel-note")?.textContent),
      detail: squash(stepOne?.querySelector(".game-guide-step-detail")?.textContent),
    };
  });
}

for (const viewport of VIEWPORTS) {
  test(`staging / ${viewport.label}: one primary control, named by the phase, the other behind a disclosure`, async ({
    page,
  }) => {
    await mountGame(page, "pre_activation", "en", viewport);
    const reading = await readGuide(page);
    console.log(`[start-guide/staging @${viewport.label}] ${JSON.stringify(reading)}`);

    const action = declaredFirstAction("pre_activation");
    const control = controlOf(action);

    // (b) The step is the one the phase declares, and its control is that action's.
    expect(reading.stepOneAction, "step 1 is present and names the phase's own first action").toBe(action);

    // (a) Exactly one primary control is inside the first viewport, and it is that control.
    expect(
      reading.primaryInViewport,
      `the first viewport must offer exactly one primary action at ${viewport.label}; it offers ` +
        `${JSON.stringify(reading.primaryInViewport)}`,
    ).toEqual([control]);

    // (d) The other staging action is offered but is not inside the first viewport and is not a
    // second primary: it waits behind the disclosure until the player says the first is done.
    expect(
      reading.visibleStaging,
      "the staging control that refuses before the first is not a visible button beside it",
    ).toEqual([control]);
    const disclosure = page.getByTestId("game-guide-step-one-alternate");
    await expect(disclosure).toBeVisible();
    expect(reading.summary, "the disclosure names the precondition that makes it worth opening").toBe(
      en.gameGuideStepOneAlternate,
    );
    await disclosure.locator("summary").click();
    const revealed = page.getByTestId("game-setup");
    await expect(revealed).toBeVisible();
    expect(
      await revealed.evaluate((node) => node.classList.contains("primary")),
      "the revealed staging control is a secondary action, not a second primary",
    ).toBe(false);

    // The words name the action the control performs, so the step is readable without pressing it.
    expect(reading.hint, "step 1's hint says what its one control is for").toBe(hintOf(action));
    expect(reading.detail, "the copy no longer states an order only the Host enforces").not.toMatch(
      /in this order|then set up/iu,
    );

    // (e) Negatively: the ordered enumeration of the two staging steps is gone.
    expect(reading.legacyOrderLists, "the ordered sub-list of the two staging steps is not rendered").toBe(0);
    expect(
      reading.stepOneOrderedLists,
      "step 1 carries no ordered list: the two staging actions are not successive steps of one list",
    ).toBe(0);
  });

  test(`staged / ${viewport.label}: the step whose premise is satisfied is not offered`, async ({ page }) => {
    await mountGame(page, "activated_not_launched", "en", viewport);
    const reading = await readGuide(page);
    console.log(`[start-guide/staged @${viewport.label}] ${JSON.stringify(reading)}`);

    const action = declaredFirstAction("activated_not_launched");
    const control = controlOf(action);

    // (c) The staging step is behind the player: neither it nor its controls are drawn.
    expect(
      reading.stepOnePresent,
      "step 1 is not presented at all once the attempt is staged and the game registered: an empty step " +
        "telling the player to press two controls that are not on the page is the shape this replaces",
    ).toBe(false);
    expect(reading.stepOneAction, "step 1 names no action, because it is not drawn").toBe(null);
    await expect(page.getByTestId("game-activate")).toHaveCount(0);
    await expect(page.getByTestId("game-setup")).toHaveCount(0);
    await expect(page.getByTestId("game-guide-step-one-alternate")).toHaveCount(0);

    // …and what is offered is the phase's own next action, once.
    expect(
      reading.primaryInViewport,
      `the first viewport must offer the launch alone at ${viewport.label}`,
    ).toEqual([control]);
    await expect(page.locator('[data-guide-step="2"]').getByTestId(control)).toHaveCount(1);
  });
}

test("zh-CN: the same step in the other catalogue, with no string left in English", async ({ page }) => {
  const viewport = { width: 400, height: 800 };
  await mountGame(page, "pre_activation", "zh-CN", viewport);
  const reading = await readGuide(page);
  console.log(`[start-guide/zh] ${JSON.stringify(reading)}`);

  const action = declaredFirstAction("pre_activation");
  expect(reading.stepOneAction).toBe(action);
  expect(reading.primaryInViewport).toEqual([controlOf(action)]);
  expect(reading.summary).toBe(zh.gameGuideStepOneAlternate);
  expect(reading.hint).toBe(zh.gameActivationHint);
  await expect(page.getByTestId(controlOf(action))).toHaveText(zh.gameActivation);
});
