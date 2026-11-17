/**
 * A quarantined launch says the one step that really exists, and says what this page cannot do.
 *
 * Measured defect: once a launch is quarantined the panel withdraws every launch entry - correctly,
 * because the Host refuses all of them for the life of its own process - and the only thing left on
 * screen was a sentence telling the player to "close GameBuddy completely, open it again". The screen
 * offered no control that does it, and nothing said that reloading the page does not either: the lock
 * lives in GameBuddy's process, so F5 comes back to the same screen. A player reading that had one
 * instruction and no way to tell whether the page was the place to carry it out.
 *
 * **Why no control can be added here.** The explicit endgame is the product's only authenticated way
 * to end a session, and it is not reachable from this state, for two independent reasons:
 *
 *   - the surface derives `endgameAvailable: false` for it (`deriveGameSessionControls`: endgame is a
 *     control of an ATTACHED session, and a quarantined launch has no attachment at all), and
 *   - the Host refuses it anyway without a live attachment generation
 *     (`stardew-production-lifecycle-coordinator.internal.ts`: `stardew_game_endgame_unavailable`), and
 *     even a successful endgame does not clear the launch quarantine - `launchTerminal` stays set, so
 *     the next launch is still refused (`stardew_player_host_launch_quarantined`).
 *
 * So the honest repair is the sentence: it must name the one step that exists (quitting GameBuddy
 * itself), and it must say that nothing on this page lifts the lock and that reloading does not. That
 * sentence is the whole of the screen's forward path - which is why the controls the panel offers are
 * measured here and not assumed.
 *
 * The population of quarantined sentences is derived from the catalogue (every key ending
 * `Quarantined`), and each one is driven through the projection its phase really publishes, so a third
 * quarantine string cannot appear without being measured by name.
 */
import { messages } from "../src/i18n";
import { draft, game, jsonOk, root, token } from "./composed-reference-game-fixtures";
import { expect, test, type Page } from "./frontend-coverage";

const en = messages("en");
const zh = messages("zh-CN");

type QuarantineKey = "gameLaunchQuarantined" | "gameEndedQuarantined";

/**
 * The projection each quarantined sentence belongs to.
 *
 * A failed launch is the instance the coordinator quarantined (`crashed`); the game the player quit
 * before the companion moved in is the same terminal attempt reported as `stopped`. The two are told
 * apart only by that word, which is why they have two sentences and one step.
 */
const QUARANTINED_ROOT: Readonly<Record<QuarantineKey, unknown>> = {
  gameLaunchQuarantined: {
    ...root,
    game: {
      ...game,
      game: {
        ...game.game,
        prerequisites: { status: "met", detectedGame: "Stardew Valley" },
        instance: { status: "crashed", gameTitle: "Stardew Valley", generation: 0 },
        latestOutcome: "failed",
      },
    },
  },
  gameEndedQuarantined: {
    ...root,
    game: {
      ...game,
      game: {
        ...game.game,
        prerequisites: { status: "met", detectedGame: "Stardew Valley" },
        instance: { status: "stopped", gameTitle: "Stardew Valley", generation: 0 },
      },
    },
  },
};

/** The facts the sentence has to state, one pattern per fact, in each catalogue. */
const FACTS = {
  /** The lock lives in GameBuddy's own process - the reason this page cannot lift it. */
  pageCannot: { en: /no control on this page/iu, "zh-CN": /本页没有任何控件/u },
  /** Reloading is not the step, however much it looks like one. */
  reloadDoesNot: { en: /reloading this page does not/iu, "zh-CN": /刷新本页也不行/u },
  /** The one step that exists, named rather than implied. */
  oneAction: { en: /quit GameBuddy itself/iu, "zh-CN": /退出 GameBuddy 本身/u },
  /**
   * …and where it is carried out. The step is the product's own tray ( `TrayShell`'s "Quit GameBuddy"),
   * which serves no browser route, so a sentence that names the step without naming the tray sends the
   * player to the task manager - the one place the product never meant to point at.
   */
  whereItIsCarriedOut: { en: /tray icon/iu, "zh-CN": /托盘图标/u },
} as const;

async function mountQuarantined(page: Page, key: QuarantineKey, locale: "en" | "zh-CN"): Promise<void> {
  const composed = QUARANTINED_ROOT[key];
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composed)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composed)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_handoff_unavailable" }),
    }),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: locale === "zh-CN" ? "zh-CN" : "en-US" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  const surface = page.getByTestId("game-surface");
  if (!(await surface.isVisible()))
    await page.getByRole("button", { name: locale === "zh-CN" ? "游戏" : "Game", exact: true }).click();
  await expect(surface).toBeVisible();
}

type QuarantinedReading = Readonly<{
  sentence: string;
  /** Every control the panel itself offers: the screen's whole forward path. */
  controls: readonly Readonly<{ tag: string; testId: string; name: string }>[];
}>;

/** What the screen says, and every control it offers to carry it out. */
async function readQuarantined(page: Page): Promise<QuarantinedReading> {
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("game-launch-quarantined")).toBeVisible();
  return await panel.evaluate((node) => {
    const squash = (value: string | null | undefined): string => (value ?? "").replace(/\s+/gu, " ").trim();
    const controls = [...node.querySelectorAll<HTMLElement>('button, a[href], summary, input, select, [role="button"]')]
      .filter((control) => control.checkVisibility())
      .map((control) => ({
        tag: control.tagName.toLowerCase(),
        testId: control.getAttribute("data-testid") ?? "",
        name: squash(control.getAttribute("aria-label") ?? control.textContent),
      }));
    return {
      sentence: squash(node.querySelector('[data-testid="game-launch-quarantined"]')?.textContent),
      controls,
    };
  });
}

/** The catalogue's own population of quarantined sentences, rather than a list written here. */
const QUARANTINE_KEYS = Object.keys(en).filter((key): key is QuarantineKey => /Quarantined$/u.test(key));

test("the quarantine population is the catalogue's, and every member is driven here", () => {
  expect(QUARANTINE_KEYS.sort()).toEqual(["gameEndedQuarantined", "gameLaunchQuarantined"]);
  expect(QUARANTINE_KEYS.every((key) => key in QUARANTINED_ROOT)).toBe(true);
});

for (const locale of ["en", "zh-CN"] as const) {
  for (const key of QUARANTINE_KEYS) {
    test(`${locale}: ${key} names the one step that exists, and says the page cannot lift the lock`, async ({ page }) => {
      const labels = locale === "en" ? en : zh;
      await mountQuarantined(page, key, locale);
      const reading = await readQuarantined(page);
      console.log(`[quarantine/${locale}/${key}] ${JSON.stringify(reading)}`);

      // The panel offers nothing to press: no launch entry, and no second way out either. That is
      // the fact this sentence has to carry, so it is measured rather than assumed.
      expect(
        reading.controls,
        `${locale}/${key}: the quarantined screen offers no control at all, so the sentence is the whole of its ` +
          `forward path and must name the step that exists outside this page`,
      ).toEqual([]);

      // …and the sentence is the catalogue's own, rendered from the phase it belongs to.
      expect(reading.sentence).toBe(labels[key]);

      for (const [fact, pattern] of Object.entries(FACTS)) {
        expect(
          pattern[locale].test(reading.sentence),
          `${locale}/${key}: the sentence must state "${fact}" - it names the one step out of a quarantined ` +
            `launch, and it stops reading as an instruction this page can carry out`,
        ).toBe(true);
      }

      // The sentence that had the player looking for a control that does not exist is gone.
      expect(reading.sentence).not.toMatch(/Close GameBuddy completely/u);
    });
  }
}
