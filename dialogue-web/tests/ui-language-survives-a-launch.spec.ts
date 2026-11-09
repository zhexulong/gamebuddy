/**
 * The interface language survives a launch, and the Host is what carries it.
 *
 * WHY THIS IS A BROWSER TEST
 *
 * The choice has no cascade and no rendering rule worth measuring; what it has is a STORE, and the
 * store is the defect. `dialogue-web/src/i18n.ts` used to persist the language in `localStorage`, and
 * the Desktop serves this shell from an ephemeral `127.0.0.1` origin
 * (`host/src/desktop-presentation-handoff.internal.ts`): every launch is a new origin, so every launch
 * is an empty `localStorage`, so the interface language reset every time the player started GameBuddy.
 * Nothing in the component tree can show that; only a reload with the cache thrown away can.
 *
 * WHAT THIS PROVES
 *
 *   1. A CHOSEN LANGUAGE REACHES THE HOST. The select writes `/settings/ui-language`; the stub record
 *      below is the mutable Host side, so the choice landing there is the write, not a local state.
 *   2. The PAGE repaints in the language the store ANSWERED with (the read-back, not the request).
 *   3. IT SURVIVES A RELAUNCH WITH NO LOCAL STORE. `localStorage` is emptied and the browser still asks
 *      for `en-US`, which is exactly the fresh-origin condition; after the reload the interface is
 *      Chinese, and the only place that can have said so is the Host record. The cache is rewritten
 *      from that answer afterwards, which is what makes the next launch's first frame right - it is a
 *      cache, and this test states that by emptying it rather than by trusting it.
 */
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

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
const composedRoot = () => ({
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: composedChat,
  game: composedGame,
});

/** The Host's own record for this one field group, mutable so a write is visible to the reload. */
type StoredUiLanguage = { revision: number; locale: "en" | "zh-CN" | null };

/**
 * Every route this shell reads on the way to the Settings surface.
 *
 * The PUT handler refuses a write without the CSRF header the contract requires and answers with the
 * read-back the panel adopts, so a broken client cannot pass by writing something the Host would never
 * accept.
 */
async function stubRoutes(page: Page, record: StoredUiLanguage): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot())));
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
  await page.route("**/api/tavern/v1/settings/appearance", (route) =>
    route.fulfill(json200({ revision: 0, appearance: "system" })),
  );
  await page.route("**/api/tavern/v1/settings/ui-language", async (route) => {
    if (route.request().method() === "GET") return await route.fulfill(json200(record));
    expect(
      route.request().headers()["x-csrf-token"],
      "the language write carries the session's CSRF header",
    ).toBe(csrfToken);
    const body = JSON.parse(route.request().postData() ?? "{}") as { expectedRevision: number; locale: unknown };
    if (body.locale !== "en" && body.locale !== "zh-CN")
      return await route.fulfill({ status: 400, contentType: "application/problem+json", body: "{}" });
    if (body.expectedRevision !== record.revision)
      return await route.fulfill({ status: 409, contentType: "application/problem+json", body: "{}" });
    record.revision += 1;
    record.locale = body.locale;
    return await route.fulfill(json200(record));
  });
}

/** What the player reads: the document's own language, and the interface-language control. */
async function readInterfaceLanguage(page: Page) {
  return await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("#ui-language");
    const label = document.querySelector<HTMLLabelElement>('label[for="ui-language"]');
    if (select === null || label === null) throw new Error("the interface-language control is not mounted");
    return {
      documentLang: document.documentElement.lang,
      value: select.value,
      label: (label.textContent ?? "").trim(),
      cached: localStorage.getItem("gamebuddy.tavern.ui-locale"),
    };
  });
}

test("a chosen interface language outlives a relaunch, and the Host's record is what carries it", async ({ page }) => {
  const record: StoredUiLanguage = { revision: 0, locale: null };
  await stubRoutes(page, record);
  // The browser asks for English throughout, so a Chinese interface after the reload cannot be the
  // browser's own answer either.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "language", { get: () => "en-US" });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US"] });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  await expect(page.getByTestId("settings-surface")).toBeVisible();
  const control = page.locator("#ui-language");
  await expect(control).toBeVisible();

  // 1. The page opens in the language the browser asks for, because the Host has no choice stored.
  const opening = await readInterfaceLanguage(page);
  console.log(`[ui-language opening] ${JSON.stringify(opening)}`);
  expect(record.locale, "an unchosen record stores no language").toBeNull();
  expect(opening.value, "the control shows the language in force, not an invented default").toBe("en");
  expect(opening.documentLang, "and the document says so").toBe("en");

  // 2. Choosing a language writes the HOST record, and the page adopts what the store answered.
  await control.selectOption("zh-CN");
  await expect
    .poll(async () => record.locale, { message: "the choice reached the Host's player-preference record" })
    .toBe("zh-CN");
  expect(record.revision, "the write advanced the record's one revision").toBe(1);
  await expect
    .poll(async () => (await readInterfaceLanguage(page)).documentLang, {
      message: "the page repaints in the language the store confirmed",
    })
    .toBe("zh-CN");
  const chosen = await readInterfaceLanguage(page);
  console.log(`[ui-language chosen] ${JSON.stringify(chosen)}`);
  expect(chosen.label, "every label on the surface is the chosen catalogue's").toBe("界面语言");
  expect(chosen.cached, "the first-paint cache was rewritten from the confirmed choice").toBe("zh-CN");

  // 3. The relaunch: a fresh origin has no local store at all, which is what the Desktop does on every
  //    start. Everything the browser could remember is emptied first.
  await page.evaluate(() => localStorage.clear());
  expect(await page.evaluate(() => localStorage.getItem("gamebuddy.tavern.ui-locale"))).toBeNull();
  await page.reload();

  await expect(page.getByTestId("settings-surface")).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.lang), {
      message: "the interface language survived a launch with no local store",
    })
    .toBe("zh-CN");
  await expect(page.locator("#ui-language")).toBeVisible();
  const relaunched = await readInterfaceLanguage(page);
  console.log(`[ui-language relaunched] ${JSON.stringify(relaunched)}`);
  expect(relaunched.value, "and the control shows the stored choice, not the browser's language").toBe("zh-CN");
  expect(relaunched.label, "the surface is the chosen catalogue's").toBe("界面语言");
  expect(record.locale, "the record still holds the choice the reload came from").toBe("zh-CN");
  // The cache is derived again from the Host's answer, so the NEXT launch's first frame is right too.
  expect(relaunched.cached, "and the first-paint cache is rebuilt from the Host's answer").toBe("zh-CN");
});
