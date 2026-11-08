/**
 * The appearance the player chose, and the one the operating system asks for.
 *
 * WHY THIS IS A BROWSER TEST AND NOT A UNIT TEST
 *
 * The rule `resolveAppearance` states is trivial; what can go wrong is the cascade it drives. The
 * stylesheet carries two token roots, and which one wins depends on the attribute landing on
 * `<html>` before anything reads it. So every assertion here is what the browser computes - the
 * custom property the theme resolved to, and the painted background of a real surface - rather than
 * the attribute string this code wrote.
 *
 * The two facts in the brief, in the order the product promises them:
 *
 *   1. UNCHOSEN FOLLOWS THE SYSTEM. A player who has never chosen gets `prefers-color-scheme`'s
 *      answer, emulated here at both values against the same unchosen record.
 *   2. A CHOICE OUTLIVES A RELOAD. The choice is stored in the Host's one player-preference record,
 *      not in this browser, so the second half of that test reloads with the operating system still
 *      asking for the OTHER appearance: the only thing that can repaint the page light is the
 *      stored choice coming back.
 */
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

/** The two appearances' page colour, as the browser reports it. */
const CANVAS = { light: "rgb(233, 226, 214)", dark: "rgb(12, 11, 11)" } as const;

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: "D".repeat(42) + "A" },
    title: null,
    transcript: [],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const composedGame = {
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
};

const json200 = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The record the Host would answer, mutable so a write is visible to the reload the same page performs. */
type StoredAppearance = { revision: number; appearance: "system" | "light" | "dark" };

/**
 * Every route this shell reads, with the appearance record supplied by the caller.
 *
 * The PUT handler is not a formality: it refuses a write without the CSRF header the contract
 * requires, and it answers with the read-back the panel is documented to adopt. A stub that accepted
 * anything would let a broken client pass.
 */
async function stubRoutes(page: Page, record: StoredAppearance): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200({ apiVersion: 1, build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" }, chat: composedChat, game: composedGame })));
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(json200({ apiVersion: 1, build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" }, chat: composedChat, game: composedGame })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 0, text: "" })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(json200({ revision: 0, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({
        revision: 0,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(json200({ devices: [] })));
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 0, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/appearance", async (route) => {
    if (route.request().method() === "GET") return await route.fulfill(json200(record));
    expect(
      route.request().headers()["x-csrf-token"],
      "the appearance write carries the session's CSRF header",
    ).toBe(csrfToken);
    const body = JSON.parse(route.request().postData() ?? "{}") as StoredAppearance;
    if (body.appearance !== "system" && body.appearance !== "light" && body.appearance !== "dark")
      return await route.fulfill({ status: 400, contentType: "application/problem+json", body: "{}" });
    record.revision += 1;
    record.appearance = body.appearance;
    return await route.fulfill(json200(record));
  });
}

/** What the browser actually paints, read from the document and from a real surface. */
async function readAppearance(page: Page) {
  return await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".tavern-app-shell");
    if (shell === null) throw new Error("the composed shell is not mounted");
    const root = getComputedStyle(document.documentElement);
    return {
      attribute: document.documentElement.getAttribute("data-theme"),
      canvasToken: root.getPropertyValue("--surface-canvas").trim(),
      shellBackground: getComputedStyle(shell).backgroundColor,
      prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    };
  });
}

test.describe("the appearance is the player's choice, and the system's until they make one", () => {
  test("an unchosen record follows prefers-color-scheme, at both of its answers", async ({ page }) => {
    const record: StoredAppearance = { revision: 0, appearance: "system" };
    await stubRoutes(page, record);

    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.locator(".tavern-app-shell")).toBeVisible();
    const light = await readAppearance(page);
    console.log(`[appearance-system-light] ${JSON.stringify(light)}`);
    expect(light.attribute, "an unchosen record paints the light token root when the OS asks for it").toBe("light");
    expect(light.shellBackground, "and the shell is painted the light canvas").toBe(CANVAS.light);
    expect(light.canvasToken, "the token the shell reads is the light one").toBe("#e9e2d6");

    // The same record, the other OS answer: nothing about the stored choice changed.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(async () => (await readAppearance(page)).attribute, {
        message: "switching the OS answer while the choice is `system` repaints without a reload",
      })
      .toBe("dark");
    const dark = await readAppearance(page);
    console.log(`[appearance-system-dark] ${JSON.stringify(dark)}`);
    expect(dark.shellBackground, "and the shell is painted the dark canvas").toBe(CANVAS.dark);
    expect(record.appearance, "following the system wrote nothing to the record").toBe("system");
    expect(record.revision, "and advanced no revision").toBe(0);
  });

  test("a chosen appearance survives a reload, and outranks the system's answer", async ({ page }) => {
    const record: StoredAppearance = { revision: 0, appearance: "system" };
    await stubRoutes(page, record);
    // The OS asks for DARK throughout, so a light page after the reload can only be the stored choice.
    await page.emulateMedia({ colorScheme: "dark" });

    await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
    const surface = page.getByTestId("settings-surface");
    const control = surface.locator("#ui-appearance");
    await expect(control).toBeVisible();
    await expect(control, "the control shows the stored choice, not a local one").toHaveValue("system");
    expect((await readAppearance(page)).attribute, "which currently resolves to the OS answer").toBe("dark");

    await control.selectOption("light");
    await expect
      .poll(async () => record.appearance, { message: "the choice reached the Host's record" })
      .toBe("light");
    await expect
      .poll(async () => (await readAppearance(page)).attribute, {
        message: "the validated read-back is what the page then paints",
      })
      .toBe("light");
    expect((await readAppearance(page)).shellBackground, "the painted surface is the light one").toBe(CANVAS.light);

    // A reload starts from nothing but the cookie and the stored record.
    await page.reload();
    await expect(page.locator(".tavern-app-shell")).toBeVisible();
    const reloaded = await readAppearance(page);
    console.log(`[appearance-reloaded] ${JSON.stringify(reloaded)}`);
    expect(reloaded.prefersLight, "the OS still asks for dark after the reload").toBe(false);
    expect(reloaded.attribute, "the stored choice outlives the reload and outranks the OS").toBe("light");
    expect(reloaded.shellBackground, "and the reloaded page is painted light").toBe(CANVAS.light);

    // Returning to `system` is a choice too, and it hands the page back to the OS answer.
    const surfaceAfterReload = page.getByTestId("settings-surface");
    await expect(surfaceAfterReload.locator("#ui-appearance")).toHaveValue("light");
    await surfaceAfterReload.locator("#ui-appearance").selectOption("system");
    await expect
      .poll(async () => (await readAppearance(page)).attribute, {
        message: "`system` hands the page back to the OS answer",
      })
      .toBe("dark");
  });
});
