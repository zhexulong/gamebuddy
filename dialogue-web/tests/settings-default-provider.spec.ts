/**
 * A newcomer's Settings opens on the channel that asks nothing of them.
 *
 * Measured on the build before this change: the panel resolved its selection as
 * `providers.find(providerId) ?? providers.find(p => p.escapeHatch) ?? providers[0]`
 * (`components/management-panels.tsx`), so a fresh open landed on the escape hatch -
 * `OpenAI-compatible endpoint`, an empty Base URL and a required API key - while the
 * catalogue's own first entry is the zero-configuration `GameBuddy Agent (CPA)`
 * (`host/src/tavern/provider-catalog.ts`, `setupFields: []`). Read in the browser:
 * `#connection-provider` = `openai-compatible`, and the form carried
 * `#connection-base-url` (empty), `#connection-api-shape`, `#connection-api-key`
 * (empty, required) and `#connection-model-id` (required).
 *
 * What SillyTavern does, which is the rule this follows rather than a threshold of
 * ours: its API panel opens on the one channel that needs no URL and no key from the
 * player. The shipped first-run settings carry `"main_api": "koboldhorde"`
 * (`default/content/settings.json`) - AI Horde - and the Horde endpoint substitutes a
 * shared anonymous key when the player has none of their own:
 *
 *     const ANONYMOUS_KEY = '000000000000';                      // src/endpoints/horde.js
 *     const apiKey = readSecret(...SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
 *
 * SillyTavern's own escape hatch, "Custom (OpenAI-compatible)", is in the same list
 * (`public/index.html`, `#chat_completion_source`) but is never what the panel starts
 * on: it is the entry a player chooses once nothing else fits. The match here is
 * therefore positional in the same sense - the default is the entry that needs
 * nothing typed, and the entry that needs a URL and a key is one choice away, in the
 * same picker.
 *
 * The failure this catches: the first screen of the settings surface asks a player
 * who has configured nothing for a URL and a credential they do not have, and the
 * entry that would have worked for them is one row below the wrong selection.
 */
import { type Page, expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
    title: null,
    transcript: [],
    draft: { revision: 4, present: true },
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

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: composedChat,
  game: composedGame,
};

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/**
 * The catalogue's own three shapes, in the order `host/src/tavern/provider-catalog.ts`
 * publishes them: the zero-configuration entry the operator runs, one curated
 * third-party entry, and the escape hatch whose endpoint the player supplies.
 * `setupFields` is the Host's own answer to "what does this entry need from the
 * form", so the panel's default can be read off it rather than out of a name.
 */
const OPERATOR = {
  providerId: "cpa-oai",
  label: "GameBuddy Agent (CPA)",
  setupFields: [],
  allowedPlayerModels: [
    {
      modelId: "deepseek-v4.1-flash",
      modelLabel: "DeepSeek V4.1 Flash",
      allowedThinkingLevels: ["low", "high", "max"],
      defaultThinkingLevel: "high",
    },
  ],
  escapeHatch: false,
  environmentManaged: true,
};

const DEEPSEEK = {
  providerId: "deepseek",
  label: "DeepSeek",
  setupFields: ["apiKey", "modelId"],
  allowedPlayerModels: [
    {
      modelId: "deepseek-v4.1-flash",
      modelLabel: "DeepSeek V4.1 Flash",
      allowedThinkingLevels: ["low", "high", "max"],
      defaultThinkingLevel: "high",
    },
  ],
  escapeHatch: false,
  environmentManaged: false,
};

const ESCAPE_HATCH = {
  providerId: "openai-compatible",
  label: "OpenAI-compatible endpoint",
  setupFields: ["baseUrl", "apiShape", "apiKey", "modelId", "apiKeyRequired"],
  allowedPlayerModels: [],
  escapeHatch: true,
  environmentManaged: false,
};

async function stubRoutes(page: Page, providers: readonly unknown[]): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 3, active: null, connections: [], providers })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(json200({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({
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
    route.fulfill(json200({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, modelId: "deepseek-v4-pro", thinkingLevel: "high" },
        game: { revision: 0, modelId: "deepseek-v4-pro", thinkingLevel: "high" },
      }),
    ),
  );
}

/**
 * A fresh install opened on Settings, and the form beneath the picker: which entry
 * it resolved, and every control that entry asks the player to fill in.
 */
async function openSettings(page: Page) {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  const form = surface.locator("[data-connection-form]");
  await expect(form.locator("#connection-provider")).toBeVisible();
  return await form.evaluate((node) => {
    const picker = node.querySelector<HTMLSelectElement>("#connection-provider");
    // Every control the selected entry renders. The picker itself is not an input
    // the player must fill: it is the choice that decides the fields.
    const fields = [...node.querySelectorAll<HTMLElement>("input, select, textarea")]
      .filter((control) => control.id !== "connection-provider")
      .map((control) => ({
        id: control.id === "" ? control.tagName.toLowerCase() : control.id,
        required: control.hasAttribute("required"),
        value: (control as HTMLInputElement).value ?? "",
      }));
    return {
      selected: picker?.value ?? "(no picker)",
      options: picker === null ? [] : [...picker.options].map((option) => option.value),
      fields,
    };
  });
}

test.describe("a fresh install opens the connection form on the entry that needs nothing typed", () => {
  test("the zero-configuration entry is selected and the form asks for no field", async ({ page }) => {
    await stubRoutes(page, [OPERATOR, DEEPSEEK, ESCAPE_HATCH]);
    const reading = await openSettings(page);
    console.log(`[settings-default-provider/catalogue-order] ${JSON.stringify(reading)}`);

    expect(reading.options, "the picker offers every catalog entry").toEqual(["cpa-oai", "deepseek", "openai-compatible"]);
    expect(reading.selected, "a fresh open lands on the entry whose setupFields is empty").toBe("cpa-oai");
    expect(reading.fields, "and that entry renders no field to fill in").toEqual([]);
    expect(
      reading.fields.filter((field) => field.required).map((field) => field.id),
      "nothing on the form is required of a player who has configured nothing",
    ).toEqual([]);
  });

  test("the selection follows the entry's own requirements, not its position in the list", async ({ page }) => {
    // The Host may publish the catalogue in any order; a default read off the first
    // row would move with it. Here the escape hatch is FIRST and the zero-config
    // entry LAST - the same two readings have to come back.
    await stubRoutes(page, [ESCAPE_HATCH, DEEPSEEK, OPERATOR]);
    const reading = await openSettings(page);
    console.log(`[settings-default-provider/escape-hatch-first] ${JSON.stringify(reading)}`);

    expect(reading.options[0], "this mount really does put the escape hatch first").toBe("openai-compatible");
    expect(reading.selected, "the default is the entry that needs nothing, wherever it sits").toBe("cpa-oai");
    expect(
      reading.fields.filter((field) => field.required).map((field) => field.id),
      "no field of the landing selection is required",
    ).toEqual([]);
  });

  test("the escape hatch is still one choice away, with its own fields", async ({ page }) => {
    await stubRoutes(page, [OPERATOR, DEEPSEEK, ESCAPE_HATCH]);
    await openSettings(page);
    const form = page.getByTestId("settings-surface").locator("[data-connection-form]");
    await expect(form.locator("#connection-provider")).toBeVisible();

    await form.locator("#connection-provider").selectOption("openai-compatible");
    await expect(form.locator("#connection-base-url")).toBeVisible();
    await expect(form.locator("#connection-api-key")).toBeVisible();
    await expect(form.locator("#connection-model-id")).toBeVisible();
    const reading = await form.evaluate((node) => ({
      selected: node.querySelector<HTMLSelectElement>("#connection-provider")?.value ?? "",
      required: [...node.querySelectorAll<HTMLElement>("input[required]")].map((control) => control.id),
    }));
    console.log(`[settings-default-provider/escape-hatch-chosen] ${JSON.stringify(reading)}`);
    expect(reading.selected, "the player's own choice still wins").toBe("openai-compatible");
    expect(reading.required, "the escape hatch is where the endpoint's own requirements are stated").toContain(
      "connection-model-id",
    );
  });
});
