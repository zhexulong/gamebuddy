/**
 * The shell, judged by the standard accessibility engine in every cell it can be launched in.
 *
 * WHY FOUR CELLS AND NOT ONE
 *
 * `playwright.config.ts` pins `locale: "en-US"` for the whole run, so the browser can never ask for
 * Chinese here: a zh-CN cell has to state its own language, and the only source the shell reads that
 * outlives a launch is the Host's player-preference record. The appearance has the same shape - it is
 * the Host's record, not the browser's - so a cell stubs the record it judges and then waits until the
 * page has actually painted it. Neither axis is cosmetic to this engine: axe decides contrast from the
 * computed colours over the token canvas, and it reads the catalogue's own text, so both change with
 * the cell. The single cell that was judged before this file existed (the composed surface, English,
 * whatever appearance the OS answered) stayed green while the light appearance carried the defect
 * recorded below.
 *
 * THE CELLS ARE PROVEN, NOT ASSUMED
 *
 * Each appearance cell stubs the OPPOSITE answer from `prefers-color-scheme`, so a cell whose record
 * read failed reddens on the wait below instead of quietly judging the other appearance. The `en`
 * cell matches both the record and what Chromium asks for - `en` is the browser's own answer either
 * way - while the `zh-CN` cell can only come from the record, because the browser still asks `en-US`.
 *
 * THE KNOWN-RED ENTRY
 *
 * The light appearance has one serious violation today: `color-contrast` on `.warning-banner > span`,
 * the "no model yet" banner the Chat surface shows on a fresh install. Measured by the engine in both
 * languages: foreground `#7a5713` (the light `--warning` gold) on background `#dcd1bf` (the token's
 * own 12% wash over the light `--surface-canvas`), 4.34:1 at 13px normal weight where 4.5:1 is
 * required. It is recorded here rather than relaxed, because the fix is a token change in
 * `src/style.css` (the light warning tone against its own wash) and this lane does not touch the
 * product's source. The entry is a gate, not a comment: it fails if a second violation appears, and
 * it fails as soon as the tone is fixed, because the recorded set is then no longer what the engine
 * reports - at which point this table becomes empty and the fix is complete.
 */
import assert from "node:assert/strict";
import { type AccessibilityFinding, readAccessibility } from "./frontend-criteria.js";
import { type Page, expect, test } from "./frontend-coverage";
import { jsonOk, root, token } from "./composed-reference-game-fixtures";

const CELLS = [
  { appearance: "dark", locale: "zh-CN" },
  { appearance: "dark", locale: "en" },
  { appearance: "light", locale: "zh-CN" },
  { appearance: "light", locale: "en" },
] as const;

/**
 * Every violation the engine reports, per appearance, and nothing else.
 *
 * `dark` records none. `light` records the one contrast defect explained in the header; the selector
 * is the element it fired on, so an empty table here is the whole fix.
 */
const RECORDED_VIOLATIONS = {
  dark: [],
  light: [{ id: "color-contrast", impact: "serious", targets: [".warning-banner > span"] }],
} as const satisfies Readonly<Record<"dark" | "light", readonly AccessibilityFinding[]>>;

/**
 * Every route the shell reads on the way to its first settled frame, with the two preference records
 * supplied by the cell. The Settings sections' records are stubbed too, because the model route they
 * answer is what shows the Chat surface's standing "no model yet" banner - the element the light
 * appearance fails on - and a cell that hid it would be judging a page nobody launches into.
 */
async function stubRoutes(
  page: Page,
  cell: Readonly<{ appearance: "dark" | "light"; locale: "zh-CN" | "en" }>,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: "" })),
  );
  await page.route("**/api/tavern/v1/settings/appearance", (route) =>
    route.fulfill(jsonOk({ revision: 0, appearance: cell.appearance })),
  );
  await page.route("**/api/tavern/v1/settings/ui-language", (route) =>
    route.fulfill(jsonOk({ revision: 0, locale: cell.locale })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 0, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({
        revision: 0,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(jsonOk({ devices: [] })));
}

/** What the page actually painted, read from the document rather than from the code that wrote it. */
async function readPainted(page: Page) {
  return await page.evaluate(() => ({
    appearance: document.documentElement.getAttribute("data-theme"),
    lang: document.documentElement.lang,
  }));
}

test.describe("the shell is accessible in every appearance and every language", () => {
  for (const cell of CELLS) {
    test(`${cell.appearance} appearance, ${cell.locale}`, async ({ page }) => {
      await stubRoutes(page, cell);
      // The OS asks for the OTHER appearance, so the painted one can only be the record's answer.
      await page.emulateMedia({ colorScheme: cell.appearance === "dark" ? "light" : "dark" });

      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      await expect(page.getByTestId("chat-surface")).toBeVisible();
      await expect
        .poll(async () => (await readPainted(page)).appearance, {
          message: `the shell paints the ${cell.appearance} appearance the Host's record holds`,
        })
        .toBe(cell.appearance);
      await expect
        .poll(async () => (await readPainted(page)).lang, {
          message: `the shell paints itself in ${cell.locale}, the language the Host's record holds`,
        })
        .toBe(cell.locale);

      const observed = await readAccessibility(page);
      // The population, printed rather than implied: "0 violations" says nothing without the number
      // of rules that passed and the rules the engine could not settle.
      console.log(
        `[axe ${cell.appearance} ${cell.locale}] passed=${observed.passedRules} ` +
          `violations=${observed.violations.length} incomplete=${observed.incomplete.length}`,
      );
      assert.deepEqual(
        observed.incomplete,
        [],
        `the ${cell.appearance}/${cell.locale} shell leaves no rule undecided`,
      );
      assert.deepEqual(
        observed.violations,
        RECORDED_VIOLATIONS[cell.appearance],
        `the ${cell.appearance}/${cell.locale} shell violates exactly what this gate records: none in the dark ` +
          "appearance, and the one known-red light-appearance contrast defect on `.warning-banner > span`",
      );
    });
  }
});
