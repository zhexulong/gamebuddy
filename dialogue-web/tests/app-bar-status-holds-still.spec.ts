/**
 * The app bar holds still while its status words change: the space a word occupies is taken from the
 * companion's name, never from the bar's own controls.
 *
 * THE DEFECT THIS NAMES. The bar now carries two status badges (`.app-bar-status` for the model,
 * `.app-bar-game-status` for the game), and the game's four readings are four different widths - measured
 * in this file, "Game connected" 108.28 px against "Game disconnected" 137.70 px at 1440x900, a 29.42 px
 * swing; the Chinese catalogue swings 13.00 px ("游戏已连接" 71 px against "游戏连接中" 84 px). A row that
 * re-lays itself out whenever a status word changes width is a row whose own buttons cannot be clicked:
 * a pointer target that moves between two frames never satisfies "stable", and a player aiming at
 * `游戏` while the game reconnects is aiming at a target that is not where it was.
 *
 * WHERE THE SPACE COMES FROM (and why this is a CSS invariant, not a pixel number). `.app-bar-title` is
 * `flex: 1 1 auto; min-width: 0` with ellipsis (style.css), so the companion block's flex line gives the
 * difference to the name, which is the one item that can be shortened without losing a fact. The bar's
 * actions are then `flex: 0 1 auto` at the end of a bar that is not overfull, so their x is a function of
 * the bar's width and nothing else. At 400x800 both badges are `position: absolute` dots on the
 * monogram's two corners with both labels retired (`@container (max-width: 480px)`), so at that cell the
 * word cannot reach a sibling by construction.
 *
 * WHAT IS ASSERTED, per locale and per cell of the layout pair:
 *
 *   1. every app-bar control reports the same `boundingBox().x` across all four catalogue readings of the
 *      game's status, read from `messages(locale)` rather than transcribed - and at the wide cell the
 *      badge's own width is asserted to have MORE THAN ONE value, so the pass is not the pass of a
 *      measurement that never changed anything;
 *   2. a Playwright `click` on the Game entry lands while those four readings are rewritten on every
 *      animation frame under the pointer - the flips are faster than the two frames a stability check
 *      needs, so this pin covers the click class the harness reports as a 30 s timeout. (The harness's own
 *      21 timeouts were NOT this class: `capture.log` reads `not stable` zero times, `visible, enabled and
 *      stable` 54 times, and 21 of 21 failures are `intercepts pointer events` by an open modal drawer -
 *      `dialog.context-panel` in the top layer, whose `.drawer-header` is one `--appbar-height` row at the
 *      right edge, over the action cluster. This file pins the geometry so the other reading can never be
 *      true of this bar.)
 *
 * red-proof: inject  make nothing in the companion block shrinkable (`.app-bar-companion { flex: 1 0 auto }`
 *   and `.app-bar-title { flex: 0 0 auto }`, so the row's leftover is taken out of the action cluster the
 *   way it is in any row where a status word is a plain flex item), and mount a name long enough to have
 *   spent the bar's slack -> `en/desktop/a name that fills the bar: "Chat" moved between game readings -
 *   x=957.9375, 961.8125, 974.359375, 946.203125` (spread 28.16 px, tracking the badge's own 121.28 ->
 *   137.70), and the click test's long-name case times out at 5000 ms. With the two declarations as they
 *   ship, the same eight readings are 0.00 px and the four clicks land in 50-63 ms.
 *
 * WHAT THIS DOES NOT GUARD, stated so it is not read as a claim about the whole bar: the model badge's
 * own x DOES move with the game's word (`.app-bar-status`, 647.59 / 630.72 / 618.17 / 646.33 at 1440x900
 * en, width constant 61.77), because it is the game badge's left neighbour in the same run — and the
 * companion's name moves with it by the same 29.42 px / 13 px, since that name is what gives the space up.
 * Both are cosmetic and deliberately not pinned: the badge is a `role="status"` span with no pointer
 * affordance, so its movement cannot cost a click, and holding it still would mean reserving the word's
 * longest width out of the name at every viewport - a permanent 29.42 px / 13 px for nothing a player can
 * act on differently.
 */
import { type Page, expect, test } from "./frontend-coverage";
import { game, jsonOk, root, token } from "./composed-reference-game-fixtures";
import { messages } from "../src/i18n";
import { LAYOUT_PAIR } from "./viewport-policy";

const connectionId = `${"E".repeat(42)}A`;

const ACTIVE_CONNECTION = {
  connectionId,
  label: "DeepSeek",
  providerLabel: "DeepSeek",
  modelId: "deepseek-v4-pro",
  modelLabel: "DeepSeek V4 Pro",
  thinkingLevel: "high",
  readiness: "ready",
  baseUrl: null,
  failure: null,
  lastCheckedAtMs: null,
};

const ACTIVE_CONNECTION_ROW = {
  connectionId,
  label: "DeepSeek",
  providerId: "deepseek",
  providerLabel: "DeepSeek",
  configured: true,
  readiness: "ready",
  active: true,
  modelId: "deepseek-v4-pro",
  modelLabel: "DeepSeek V4 Pro",
  thinkingLevel: "high",
  allowedThinkingLevels: ["high", "max"],
  modelIds: null,
  baseUrl: null,
  failure: null,
  lastCheckedAtMs: null,
};

const MODEL_PROFILES = {
  apiVersion: 1,
  recommendedModels: [],
  chat: { revision: 0, thinkingLevel: "high" },
  game: { revision: 0, thinkingLevel: "high" },
};

const LOCALES = ["en", "zh-CN"] as const;

/**
 * The two companion-name states the bar has to survive.
 *
 * A bar with a two-word name has slack the name can give back, and slack is why a width change does not
 * reach the controls there. A name long enough to have already spent that slack is the state where a
 * row that shares its leftover width out of the wrong item has nothing left to share - so the pair is
 * the assertion, not just the short name.
 */
const NAME_STATES = [
  { name: "two words", companionName: "Mira" },
  {
    name: "a name that fills the bar",
    companionName: "Mira Vexahlia Thornwood the Unreasonably Loquacious Cartographer of Pelican Town",
  },
] as const;

/** The four readings of the game's status, in the order the badge's derivation produces them. */
function gameReadings(locale: (typeof LOCALES)[number]): string[] {
  const catalogue = messages(locale);
  return [
    catalogue.gameStatusConnected,
    catalogue.gameStatusConnecting,
    catalogue.gameStatusDisconnected,
    catalogue.gameStatusNoSession,
  ];
}

async function mount(page: Page, locale: string, companionName: string): Promise<void> {
  const projection = {
    ...root,
    chat: {
      ...root.chat,
      chat: { ...root.chat.chat, companion: { ...root.chat.chat.companion, name: companionName } },
    },
    game: { ...game, game: { ...game.game, connectionStatus: "connected_idle" } },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: ACTIVE_CONNECTION,
        connections: [ACTIVE_CONNECTION_ROW],
        providers: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) => route.fulfill(jsonOk(MODEL_PROFILES)));
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.goto(`/?locale=${locale}#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  // The reading is about one locale's words, so the bar has to be drawing them before it is read: the
  // shell's first paint uses the catalogue it boots with, and a measurement taken across that switch
  // would compare a Chinese badge against English nav labels (measured: 13.125 px, exactly the width of
  // the two catalogues' difference on the action cluster, and nothing to do with the status word).
  await expect(
    page.locator(`.app-bar-actions .nav-button[aria-label="${messages(locale).gamePanel}"]`),
    `${locale}: the bar is drawing this locale's own entry names`,
  ).toBeVisible();
}

/**
 * Rewrite the game badge to one catalogue reading, in the shape `AppBar` renders: the label text, the
 * region's own accessible name, and the dot the tone draws (absent for `no session`, which has none).
 */
async function showGameReading(page: Page, reading: string, withDot: boolean): Promise<void> {
  await page.evaluate(
    ({ label, dot }) => {
      const badge = document.querySelector('[data-testid="app-bar-game-status"]');
      if (badge === null) throw new Error("app_bar_game_status_missing");
      const text = badge.querySelector(".app-bar-game-status-label");
      if (text === null) throw new Error("app_bar_game_status_label_missing");
      text.textContent = label;
      badge.setAttribute("aria-label", label);
      badge.setAttribute("title", label);
      const existing = badge.querySelector(".status-dot");
      if (!dot) {
        existing?.remove();
        return;
      }
      if (existing !== null) {
        existing.setAttribute("data-tone", "warning");
        return;
      }
      const created = document.createElement("span");
      created.className = "status-dot";
      created.setAttribute("data-tone", "warning");
      created.setAttribute("aria-hidden", "true");
      badge.insertBefore(created, text);
    },
    { label: reading, dot: withDot },
  );
  // Two frames: the reading is only measurable after the row has laid itself out for it.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/**
 * Wait until the action cluster's own column holds still across two animation frames.
 *
 * The clock a viewport change or a locale switch leaves behind is not a status change: the first bars of a
 * new layout are measured while the row is still taking the new width, and a reading taken inside that
 * window compares two layouts rather than two status words (measured: 5.94 px, and the Chinese labels'
 * own metrics were still arriving). This waits for the row to be the row it is going to be, and says
 * nothing about the status word - which is rewritten AFTER it, one reading at a time.
 */
async function awaitSettledBar(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const cluster = document.querySelector(".app-bar-actions");
        if (cluster === null) throw new Error("app_bar_actions_missing");
        let previous = Number.NaN;
        let frames = 0;
        const settle = (): void => {
          const { x } = cluster.getBoundingClientRect();
          if (x === previous || frames > 60) {
            resolve();
            return;
          }
          previous = x;
          frames += 1;
          requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
      }),
  );
}

/** The x of every control in the bar's own action cluster, keyed by its accessible name. */
async function controlColumns(page: Page): Promise<Record<string, number>> {
  const controls = page.locator(".app-bar-actions .nav-button");
  const count = await controls.count();
  const columns: Record<string, number> = {};
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    if (box === null) continue;
    const name = (await control.getAttribute("aria-label")) ?? `#${index}`;
    columns[name] = box.x;
  }
  return columns;
}

const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);

test("the game's status word never moves a bar control", async ({ page }) => {
  for (const state of NAME_STATES) {
    for (const locale of LOCALES) {
      await mount(page, locale, state.companionName);
      const readings = gameReadings(locale);
      for (const cell of LAYOUT_PAIR) {
        await page.setViewportSize({ width: cell.width, height: cell.height });
        await awaitSettledBar(page);
        const columns: Record<string, number[]> = {};
        const badgeWidths: number[] = [];
        for (const [index, reading] of readings.entries()) {
          // `no session` is the one reading with no dot: nothing is lit for a game that was never started.
          await showGameReading(page, reading, index < readings.length - 1);
          for (const [name, x] of Object.entries(await controlColumns(page))) {
            (columns[name] ??= []).push(x);
          }
          const badge = await page.getByTestId("app-bar-game-status").boundingBox();
          expect(badge, `${locale}/${cell.name}: the game badge is the element under measurement`).not.toBeNull();
          badgeWidths.push(badge!.width);
        }
        const where = `${locale}/${cell.name}/${state.name}`;
        expect(Object.keys(columns).length, `${where}: the bar has controls to measure`).toBeGreaterThan(0);
        for (const [name, xs] of Object.entries(columns)) {
          expect(
            spread(xs),
            `${where}: "${name}" moved between game readings — x=${xs.join(", ")} (readings: ${readings.join(", ")})`,
          ).toBe(0);
        }
        // The reading is about a word that really changes width. Above the 480px container fold both
        // labels are drawn, so the four readings are not one width; the phone cell retires them on
        // purpose (`@container (max-width: 480px)`) and its badge is a dot whose tone is the whole claim.
        if (cell.width > 480) {
          expect(
            spread(badgeWidths),
            `${where}: the four catalogue readings are one width (${badgeWidths.join(", ")}), so this cell proves nothing about a word changing width`,
          ).toBeGreaterThan(0);
        }
        console.log(
          `[app-bar-holds-still] ${where} ${cell.width}x${cell.height} controls=${Object.keys(columns).length} ` +
            `badgeWidths=${badgeWidths.map((width) => Math.round(width * 100) / 100).join(",")}`,
        );
      }
    }
  }
});

test("the Game entry still takes a click while its own status word changes underneath", async ({ page }) => {
  for (const state of NAME_STATES) {
    for (const locale of LOCALES) {
      await mount(page, locale, state.companionName);
      await page.setViewportSize({ width: LAYOUT_PAIR[0].width, height: LAYOUT_PAIR[0].height });
      await awaitSettledBar(page);
      const readings = gameReadings(locale);
      // Every animation frame, not every second: this is faster than the two frames Playwright's
      // stability check needs, which is the condition that fails a click when a control moves.
      await page.evaluate((labels: string[]) => {
        let index = 0;
        const badge = document.querySelector('[data-testid="app-bar-game-status"]') as HTMLElement;
        const text = badge.querySelector(".app-bar-game-status-label") as HTMLElement;
        const flip = (): void => {
          const label = labels[index % labels.length] as string;
          index += 1;
          text.textContent = label;
          badge.setAttribute("aria-label", label);
          requestAnimationFrame(flip);
        };
        requestAnimationFrame(flip);
      }, readings);
      const gameEntry = page.locator(`.app-bar-actions .nav-button[aria-label="${messages(locale).gamePanel}"]`);
      const started = Date.now();
      await gameEntry.first().click({ timeout: 5_000 });
      console.log(`[app-bar-holds-still] ${locale}: the Game entry took the click in ${Date.now() - started} ms`);
      // The click is the assertion; this states that the surface it asked for is the one that arrived.
      await expect(page.getByTestId("game-surface")).toBeVisible();
    }
  }
});
