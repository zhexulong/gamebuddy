/**
 * Every step of the first-run guide is named after the work its own control does.
 *
 * Measured defect: step 1 was titled "Start Stardew" / "启动星露谷" while the control under it posts
 * `/lifecycle/activate` - the staging call that reserves and stages this session's attempt, which
 * starts nothing - and step 2 was titled "Load your farm" / "载入你的农场" while the control under
 * *it* posts `/game/launch`, the call that starts the game. The two titles described each other's
 * work, and the second described work no control on this page performs at all: a farm is loaded
 * inside the game, by the player, after the game is running.
 *
 * What is measured here is the tie between the three things a step is, read from the running shell
 * rather than from the catalogue: the words of its title, the words on its button, and the request
 * that button really sends. A title that names a game start over a control that stages, or a button
 * that stages under a title that promises a farm, fails by the step it is.
 */
import { messages } from "../src/i18n";
import {
  draft,
  installedRoot,
  jsonOk,
  root,
  stagedGame,
  token,
} from "./composed-reference-game-fixtures";
import { expect, test, type Page } from "./frontend-coverage";

const en = messages("en");
const zh = messages("zh-CN");

/** The request each staging phase's control really sends, and the fact it performs. */
const ACTIVATE_PATH = "/api/composed-reference-game/v1/lifecycle/activate";
const LAUNCH_PATH = "/api/composed-reference-game/v1/game/launch";

/** The words that say "this step starts the game". */
const NAMES_GAME_START =
  /start(?:s|ing)? (?:the game|stardew)|launch(?:es|ing)? (?:the game|stardew)|启动(?:游戏|星露谷|《星露谷物语》)/iu;
/** The words that say "this step prepares the play environment" - what `/lifecycle/activate` performs. */
const NAMES_PREPARATION = /prepar|ready|set up|准备|设置/iu;
/** The words that say "this step loads a farm": work no control on this page performs. */
const NAMES_FARM_LOAD = /load (?:your|the) farm|载入(?:你的|这个)?农场/iu;

/** The two first-run phases, and the projection the product itself publishes for each. */
const PHASE_ROOT = {
  /** An installation registered and nothing staged: step 1's staging control is what is offered. */
  pre_activation: installedRoot,
  /** The attempt staged and the expected generation published: step 2's launch is what is offered. */
  activated_not_launched: { ...root, game: stagedGame },
} as const;

/** Mounts the real shell over the composed routes, and records every POST the surface sends. */
async function mountStep(
  page: Page,
  phase: keyof typeof PHASE_ROOT,
  locale: "en" | "zh-CN",
): Promise<readonly string[]> {
  const composed = PHASE_ROOT[phase];
  const posted: string[] = [];
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posted.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composed)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composed)));
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/api/composed-reference-game/v1/game/launch", (route) => route.fulfill({ status: 204, body: "" }));
  // The Host's own answer while no Player Host instance has been launched: the third step's
  // not-yet state, which this journey does not measure.
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
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: locale === "zh-CN" ? "zh-CN" : "en-US" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  // The AppBar entry is the surface's own name in the catalogue, so the journey reaches the panel
  // the way a player in that language does.
  const surface = page.getByTestId("game-surface");
  if (!(await surface.isVisible()))
    await page.getByRole("button", { name: locale === "zh-CN" ? "游戏" : "Game", exact: true }).click();
  await expect(surface).toBeVisible();
  return posted;
}

type StepReading = Readonly<{
  step: number;
  title: string;
  detail: string;
  button: string;
  /** The request the button sent, or `null` when pressing it sent none. */
  request: string | null;
}>;

/** What one step says, and what pressing its one control really does. */
async function readAndPress(page: Page, posted: readonly string[], step: number): Promise<StepReading> {
  const stepRow = page.locator(`[data-guide-step="${step}"]`);
  await expect(stepRow).toBeVisible();
  const written = await stepRow.evaluate((node) => {
    const squash = (value: string | null | undefined): string => (value ?? "").replace(/\s+/gu, " ").trim();
    return {
      title: squash(node.querySelector(".game-guide-step-title")?.textContent),
      detail: squash(node.querySelector(".game-guide-step-detail")?.textContent),
      button: squash(node.querySelector(".game-action.primary")?.textContent),
    };
  });
  const before = posted.length;
  await stepRow.locator(".game-action.primary").click();
  await expect.poll(() => posted.length, { message: `step ${step}'s control sends its own request` }).toBeGreaterThan(
    before,
  );
  const request = posted[before] ?? null;
  return { step, ...written, request };
}

const render = (reading: StepReading): string =>
  `step ${reading.step}: title=${JSON.stringify(reading.title)} button=${JSON.stringify(reading.button)} ` +
  `request=${JSON.stringify(reading.request)}`;

for (const locale of ["en", "zh-CN"] as const) {
  const labels = locale === "en" ? en : zh;

  test(`${locale}: step 1 is named for preparing the session, and its button stages rather than starts`, async ({
    page,
  }) => {
    const posted = await mountStep(page, "pre_activation", locale);
    const reading = await readAndPress(page, posted, 1);
    console.log(`[step-names/${locale}/1] ${render(reading)}`);

    // What the step really does: the staging call, not the launch.
    expect(reading.request, `${render(reading)}: the staging step's own request`).toBe(ACTIVATE_PATH);

    // …and the two things a player reads say that, not the other step's work.
    expect(
      NAMES_GAME_START.test(reading.title),
      `${render(reading)}: step 1's title must not promise a game start its control does not perform ` +
        `(the game starts in step 2)`,
    ).toBe(false);
    expect(
      NAMES_GAME_START.test(reading.button),
      `${render(reading)}: step 1's button must not promise a game start`,
    ).toBe(false);
    expect(
      NAMES_PREPARATION.test(reading.title),
      `${render(reading)}: step 1's title names its own fact - preparing the play environment`,
    ).toBe(true);
    // The step says where the start happens rather than leaving the player to guess why nothing opened.
    expect(
      /next step|下一步/iu.test(reading.detail),
      `${render(reading)}: step 1's copy names the step the game is actually started in`,
    ).toBe(true);
  });

  test(`${locale}: step 2 is named for starting the game, and its button starts it`, async ({ page }) => {
    const posted = await mountStep(page, "activated_not_launched", locale);
    const reading = await readAndPress(page, posted, 2);
    console.log(`[step-names/${locale}/2] ${render(reading)}`);

    // What the step really does: it launches, which is the game starting.
    expect(reading.request, `${render(reading)}: the second step's own request`).toBe(LAUNCH_PATH);

    expect(
      NAMES_GAME_START.test(reading.title),
      `${render(reading)}: step 2's title names the game start its control performs`,
    ).toBe(true);
    expect(
      NAMES_GAME_START.test(reading.button),
      `${render(reading)}: step 2's button is named after the same fact as its step`,
    ).toBe(true);
    expect(
      NAMES_FARM_LOAD.test(reading.title),
      `${render(reading)}: no control on this page loads a farm - the title must not name that as the step`,
    ).toBe(false);
    expect(reading.title).toBe(labels.gameGuideStepTwoTitle);
    expect(reading.button).toBe(labels.gameLaunch);
  });
}
