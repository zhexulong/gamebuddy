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
 * that this table has since recorded and lost again, in the light theme's `--banner-wash`.
 *
 * THE CELLS ARE PROVEN, NOT ASSUMED
 *
 * Each appearance cell stubs the OPPOSITE answer from `prefers-color-scheme`, so a cell whose record
 * read failed reddens on the wait below instead of quietly judging the other appearance. The `en`
 * cell matches both the record and what Chromium asks for - `en` is the browser's own answer either
 * way - while the `zh-CN` cell can only come from the record, because the browser still asks `en-US`.
 *
 * THE ENTRY THIS TABLE USED TO CARRY
 *
 * The light appearance had one serious violation: `color-contrast` on `.warning-banner > span`, the
 * "no model yet" banner the Chat surface shows on a fresh install. Measured by the engine in both
 * languages: foreground `#7a5713` (the light `--warning` gold) on background `#dcd1bf` (the token's
 * own 12% wash over the light `--surface-canvas`), 4.34:1 at 13px normal weight where 4.5:1 is
 * required. It was recorded rather than relaxed, on the rule that the entry fails if a second
 * violation appears AND fails as soon as the defect is fixed - so the fix could not land quietly,
 * and it did not: the light theme's plate is now 6%, the same cell reads the warning notice at
 * 4.72:1, and this table is empty in both appearances. The recorded shape stays, because the next
 * defect to arrive will be recorded the same way rather than relaxed.
 *
 * THE NOTICES THE LAUNCH DOES NOT RENDER
 *
 * A launched shell shows one of the three notices, so the cells above judge one. The family is
 * measured by the last test in this file, on the same engine.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { type AccessibilityFinding, BASELINE_TAGS, readAccessibility } from "./frontend-criteria.js";
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
 * Both appearances record none: the light appearance's one contrast defect is fixed, and the entry it
 * used to carry is explained in the header. The shape is kept rather than deleted, because the next
 * defect to arrive is recorded here - named by the rule, the impact and the selector - instead of
 * being tolerated.
 */
const RECORDED_VIOLATIONS = {
  dark: [],
  light: [],
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
      // Written as an `expect` rather than a bare `assert` for the reason `check:assertion-substance`
      // exists: the verdict is a value this gate claims, and a journey whose whole claim reads as
      // "something is visible" is counted as debt by the ratchet.
      expect(
        observed.violations,
        `the ${cell.appearance}/${cell.locale} shell reports exactly the violations this gate records - none, in ` +
          "either appearance; a new one is recorded in RECORDED_VIOLATIONS with the rule, the impact and the " +
          "selector it fires on, and not tolerated",
      ).toEqual(RECORDED_VIOLATIONS[cell.appearance]);
    });
  }
});

/**
 * The three notices this product can show, with the sentence each is read as. The text is the
 * measurement's carriage only - axe weighs the ink against the plate, and it needs something to read.
 */
const NOTICES = [
  { className: "error-banner", text: "The connection to the model provider failed." },
  { className: "warning-banner", text: "No model is chosen for this conversation yet." },
  { className: "success-banner", text: "The world book was imported into the library." },
] as const;

/**
 * The appearances the shell can be launched in, and the authority that declares them.
 *
 * The token roots in `style.css` decide every colour a notice paints; a third appearance joins this
 * list by being written there, and the drift check in the test fails loudly instead of leaving it
 * unmeasured.
 */
const APPEARANCES = ["dark", "light"] as const;

/**
 * The notices' own ink over their own wash, as a family, in every appearance the shell paints.
 *
 * The four cells above judge the page a launch paints, and that page carries one notice: the Chat
 * surface's "no model yet" warning. A failed connection and a finished import are reached later, so a
 * wash that put either of the other two under the floor was reported by nothing - and the measured
 * family disagreed with itself: at the light theme's original 12%/14% the warning notice read 4.35:1,
 * the danger notice 4.25:1 and the success notice 4.43:1, all under AA, while the launch rendered only
 * the first of them. This test mounts all three on the shell that is already running - the product's
 * own classes, tokens and cascade, no styles of its own - and asks the same engine the same question,
 * so a plate strength can no longer pass notice by notice.
 *
 * WHY THE APPEARANCE IS A CELL AND THE LANGUAGE IS NOT. The plate each notice is drawn on is a
 * per-appearance strength - `--banner-wash` is 12% in the dark root and 6% in the light one - so one
 * cell can only say that one of the two washes reads at AA. This test judged the light appearance only,
 * and the light appearance is the one whose numbers are already recorded in the stylesheet's own
 * comment: the half of the family with no recorded reading was the dark one, which is the appearance the
 * product is mostly played in. The language is not a cell here because what axe weighs is ink against
 * plate; the sentence is the measurement's carriage, and a longer Chinese sentence does not change the
 * colour it is painted in. Each cell below launches the shell from the Host's own appearance record and
 * proves the appearance it claims, and the printed table carries every notice's ink, plate and the ratio
 * the engine settled it at.
 */
test("every notice reads its own ink over its own wash, in both appearances", async ({ page }) => {
  const failures: string[] = [];
  const plates = new Map<string, readonly string[]>();

  for (const appearance of APPEARANCES) {
    // The record is re-answered per cell, and a route registered for the previous cell would answer
    // first: the appearance is the one fact that changes between these two loads.
    await page.unroute("**/api/tavern/v1/settings/appearance");
    await stubRoutes(page, { appearance, locale: "en" });
    // A real load per cell: the two cells share one URL, and a same-document hash navigation would
    // keep the first cell's appearance on screen and read it under the second cell's name.
    await page.goto("about:blank");
    // As in every cell: the OS asks for the other appearance, so the painted one is the record's.
    await page.emulateMedia({ colorScheme: appearance === "dark" ? "light" : "dark" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();
    await expect
      .poll(async () => (await readPainted(page)).appearance, {
        message: `the shell paints the ${appearance} appearance the Host's record holds`,
      })
      .toBe(appearance);

    const paints = await page.evaluate((notices) => {
      const host = document.createElement("div");
      host.setAttribute("data-notice-probe", "");
      for (const notice of notices) {
        const banner = document.createElement("div");
        banner.className = notice.className;
        const span = document.createElement("span");
        span.textContent = notice.text;
        banner.append(span);
        host.append(banner);
      }
      const shell = document.querySelector(".tavern-app-shell");
      if (shell === null) throw new Error("the shell did not render: `.tavern-app-shell` is absent");
      shell.append(host);
      return [...host.children].map((banner) => ({
        className: banner.className,
        ink: getComputedStyle(banner).color,
        plate: getComputedStyle(banner).backgroundColor,
      }));
    }, NOTICES);
    plates.set(
      appearance,
      paints.map((paint) => paint.plate),
    );

    const observed = await new AxeBuilder({ page })
      .withTags([...BASELINE_TAGS])
      .include("[data-notice-probe]")
      .analyze();
    for (const violation of observed.violations)
      for (const node of violation.nodes)
        failures.push(`${appearance}: ${violation.id} on ${node.target.join(" ")}: ${node.any[0]?.message ?? ""}`);
    // The ratio the engine settled each passing notice at, so a green run states the margin it keeps
    // rather than only that it cleared the floor.
    const settled = observed.passes
      .filter((rule) => rule.id === "color-contrast")
      .flatMap((rule) => rule.nodes.map((node) => `${node.target.join(" ")} ${node.any[0]?.data?.contrastRatio}:1`));
    // The population, printed rather than implied: three notices, the pair each one paints, and the
    // ratio the engine settled - per appearance, because the wash is a per-appearance strength.
    console.log(`[notices ${appearance}] examined=${NOTICES.length} violations=${observed.violations.length}`);
    for (const paint of paints) console.log(`  ${paint.className.padEnd(16)} ink=${paint.ink} plate=${paint.plate}`);
    for (const reading of settled) console.log(`  settled ${reading}`);
  }

  // The cells are proven, not assumed: two appearances that paint the same three plates would let an
  // unstyled page be judged twice under two names.
  assert.notDeepEqual(plates.get("dark"), plates.get("light"), "the two appearances paint different notice plates");
  // The appearance list is held to the token roots, so a third appearance cannot arrive unmeasured.
  const stylesheet = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//gu,
    " ",
  );
  const painted = [...new Set([...stylesheet.matchAll(/:root\[data-theme="([^"]+)"\]/gu)].map((match) => match[1]))];
  assert.deepEqual(painted.sort(), [...APPEARANCES].sort(), "this test measures every appearance the stylesheet paints");

  // An `expect` for the same reason the four cells' verdict is one: the claim is a value, and the
  // substance ratchet has to be able to read it.
  expect(failures, "every notice's own ink reads at AA over its own wash, in both appearances").toEqual([]);
});
