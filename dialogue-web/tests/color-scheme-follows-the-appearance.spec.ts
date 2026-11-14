/**
 * The platform's own widgets are drawn in the appearance the player is looking at.
 *
 * THE DEFECT
 *
 * `style.css` declared `color-scheme: dark` on exactly one selector - `.form-select`, a form control -
 * and declared nothing on `:root`. `color-scheme` is what tells the platform which way round to draw
 * the widgets no rule of ours reaches: a `<select>`'s `<option>` popup, a scrollbar, a date picker's
 * calendar. A control that states `dark` for itself therefore renders a dark popup on the light
 * appearance, whatever the page around it is doing.
 *
 * WHY THE ROOT HAS TO FOLLOW `data-theme` AND NOT `prefers-color-scheme`
 *
 * The obvious repair - `color-scheme: light dark` on `:root` - asks the *platform's* preference,
 * which is not this product's appearance. `appearance.ts` resolves the player's choice against the
 * system's answer and writes the result onto `<html data-theme>`; a player who picks the light
 * appearance on a machine set to dark would then get a dark popup on a light page. The two readings
 * this file takes are the two cells that tell those repairs apart: each cell stubs the appearance
 * record AND emulates the OPPOSITE operating-system answer, so a `color-scheme` that came from the
 * media query cannot agree with the page it is painted on.
 *
 * The control is read too, not just the root: a per-control `color-scheme` is exactly how this defect
 * arrived, so the assertion is that the control inherits the page's answer instead of stating one.
 */
import { type Page, expect, test } from "./frontend-coverage";
import { jsonOk, root, token } from "./composed-reference-game-fixtures";

const CELLS = ["dark", "light"] as const;

/** Every route the shell reads on the way to a settled Settings surface, with the appearance stubbed. */
async function stubRoutes(page: Page, appearance: (typeof CELLS)[number]): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: "" })));
  await page.route("**/api/tavern/v1/settings/appearance", (route) =>
    route.fulfill(jsonOk({ revision: 0, appearance })),
  );
  await page.route("**/api/tavern/v1/settings/ui-language", (route) =>
    route.fulfill(jsonOk({ revision: 0, locale: "en" })),
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
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 0,
        active: null,
        connections: [],
        providers: [
          {
            providerId: "openai-compatible",
            label: "OpenAI-compatible",
            setupFields: ["apiKey", "baseUrl", "apiShape", "modelId"],
            allowedPlayerModels: [],
            escapeHatch: true,
            environmentManaged: false,
          },
        ],
      }),
    ),
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

/** The scheme the document and one of its selects are actually drawn in, with the page's appearance. */
async function readScheme(page: Page): Promise<{ painted: string | null; root: string; select: string }> {
  return await page.evaluate(() => {
    const control = document.querySelector(".form-select");
    if (!(control instanceof HTMLElement)) throw new Error("the settings surface rendered no .form-select");
    return {
      painted: document.documentElement.getAttribute("data-theme"),
      root: getComputedStyle(document.documentElement).colorScheme,
      select: getComputedStyle(control).colorScheme,
    };
  });
}

test.describe("the platform's widgets follow the appearance the page is painted in", () => {
  for (const appearance of CELLS) {
    test(`${appearance} appearance, on a machine asking for the other one`, async ({ page }) => {
      await stubRoutes(page, appearance);
      // The OS asks for the OTHER appearance, so a scheme that came from the media query cannot match.
      await page.emulateMedia({ colorScheme: appearance === "dark" ? "light" : "dark" });
      await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
      await expect(page.getByTestId("settings-surface")).toBeVisible();
      await expect(page.locator("#connection-provider")).toBeVisible();

      const scheme = await readScheme(page);
      console.log(`[color-scheme] ${JSON.stringify(scheme)}`);
      expect(scheme.painted, "the shell paints the appearance the Host's record holds").toBe(appearance);
      expect(scheme.root, "the document states the scheme it is painted in, so its widgets agree").toBe(appearance);
      expect(scheme.select, "the select inherits the page's scheme instead of stating one of its own").toBe(appearance);
    });
  }
});
