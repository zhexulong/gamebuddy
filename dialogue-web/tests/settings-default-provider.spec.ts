/**
 * A newcomer's Settings opens on NO channel, because the product ships none.
 *
 * The owner's ruling: the operator's own gateway (`cpa-oai`,
 * `http://127.0.0.1:8317/v1`) is THEIR cliproxyapi instance, not something this
 * product ships or assumes. The product is BYOK only. So a player who has
 * configured nothing must be told they need their own connection - never
 * silently pointed at a gateway that does not exist on their machine.
 *
 * What this file pinned before the change, and why each assertion moved:
 *
 *  - `reading.selected` was `"cpa-oai"`: "a fresh open lands on the entry whose
 *    setupFields is empty", with a long comment about SillyTavern's AI Horde - an
 *    entry that answers with a shared anonymous key. That was the wrong analogy
 *    for this product, and the entry it selected does not exist on a player's
 *    disk. It is `""` now: the form opens on an explicit empty option and no
 *    provider is chosen until the player chooses one.
 *  - `reading.options` was `["cpa-oai", "deepseek", "openai-compatible"]`. The
 *    Host no longer offers `cpa-oai` to a browser at all, so the operator entry is
 *    absent from the picker unless the operator opted in
 *    (`GAMEBUDDY_OPERATOR_GATEWAY=1`); the third reading below mounts a catalogue
 *    that still names it, and asserts the panel does not preselect it either - the
 *    rule is "nothing is preselected", not "the operator entry is filtered out".
 *  - `reading.fields` was `[]` because the preselected entry asked for nothing.
 *    It is still `[]`, and for the opposite reason: with no provider chosen there
 *    is no field to render at all, so the first screen asks a newcomer for nothing
 *    while the sentence above it says what to do.
 *
 * The failure this catches: the first screen of the settings surface preselects a
 * channel, which is a claim that the product already has one.
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
 * The catalogue as the Host publishes it for a player: BYOK entries only. The
 * operator's gateway is deliberately absent, because a browser is never offered a
 * channel whose endpoint and credential live on the operator's own machine.
 */
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

const OPENAI = {
  providerId: "openai",
  label: "OpenAI",
  setupFields: ["apiKey", "modelId"],
  allowedPlayerModels: [
    {
      modelId: "gpt-5.6-luna",
      modelLabel: "GPT-5.6 Luna",
      allowedThinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "high",
    },
  ],
  escapeHatch: false,
  environmentManaged: false,
};

const ESCAPE_HATCH = {
  providerId: "gamebuddy-openai-compatible",
  label: "OpenAI-compatible endpoint",
  setupFields: ["baseUrl", "apiShape", "apiKey", "modelId", "apiKeyRequired"],
  allowedPlayerModels: [],
  escapeHatch: true,
  environmentManaged: false,
};

/**
 * The operator's own gateway, as an operator who opted in still sees it: a
 * developer path, labelled as one, and still not preselected.
 */
const OPERATOR = {
  providerId: "cpa-oai",
  label: "Operator gateway (developer only)",
  setupFields: [],
  allowedPlayerModels: [],
  escapeHatch: false,
  environmentManaged: true,
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
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
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
    const submit = node.querySelector<HTMLButtonElement>("button[type=submit]");
    return {
      selected: picker?.value ?? "(no picker)",
      options: picker === null ? [] : [...picker.options].map((option) => option.value),
      fields,
      saveDisabled: submit?.disabled ?? null,
      saveLabel: (submit?.textContent ?? "").trim(),
    };
  });
}

test.describe("a fresh install opens the connection form on nothing chosen", () => {
  test("the browser is offered BYOK entries only, and none of them is preselected", async ({ page }) => {
    await stubRoutes(page, [DEEPSEEK, OPENAI, ESCAPE_HATCH]);
    const reading = await openSettings(page);
    console.log(`[settings-default-provider/byok-only] ${JSON.stringify(reading)}`);

    // The operator's gateway is not in the list a player is offered at all: this
    // product ships no endpoint, so offering one would be a channel that does not
    // exist on their machine.
    expect(reading.options, "the picker offers every player-configured entry").toEqual([
      "",
      "deepseek",
      "openai",
      "gamebuddy-openai-compatible",
    ]);
    expect(reading.options, "the operator's own gateway is never offered").not.toContain("cpa-oai");
    // Nothing chosen: the form has not been answered yet.
    expect(reading.selected, "a fresh open selects no provider").toBe("");
    expect(reading.fields, "with nothing chosen, no entry renders a field").toEqual([]);
    // And the form does not offer to save an answer that does not exist.
    expect(reading.saveDisabled, "there is nothing to save before a provider is chosen").toBe(true);
  });

  test("the selection never follows list position, and the operator entry is still not preselected", async ({ page }) => {
    // The picker's order is the Host's to choose, so a default read off the first
    // row would move with it. Here the escape hatch is FIRST and the operator entry
    // is present but LAST - and the landing selection is still nothing.
    await stubRoutes(page, [ESCAPE_HATCH, DEEPSEEK, OPERATOR]);
    const reading = await openSettings(page);
    console.log(`[settings-default-provider/escape-hatch-first] ${JSON.stringify(reading)}`);

    expect(reading.options[1], "this mount really does put the escape hatch first").toBe(
      "gamebuddy-openai-compatible",
    );
    expect(reading.options, "an opted-in operator sees their own gateway").toContain("cpa-oai");
    expect(reading.selected, "the landing selection is nothing, wherever the entries sit").toBe("");
    expect(reading.fields, "and the first screen still asks for no field").toEqual([]);
  });

  test("the escape hatch is still one choice away, with its own fields", async ({ page }) => {
    await stubRoutes(page, [DEEPSEEK, OPENAI, ESCAPE_HATCH]);
    await openSettings(page);
    const form = page.getByTestId("settings-surface").locator("[data-connection-form]");
    await expect(form.locator("#connection-provider")).toBeVisible();

    await form.locator("#connection-provider").selectOption("gamebuddy-openai-compatible");
    await expect(form.locator("#connection-base-url")).toBeVisible();
    await expect(form.locator("#connection-api-key")).toBeVisible();
    await expect(form.locator("#connection-model-id")).toBeVisible();
    const reading = await form.evaluate((node) => ({
      selected: node.querySelector<HTMLSelectElement>("#connection-provider")?.value ?? "",
      required: [...node.querySelectorAll<HTMLElement>("input[required]")].map((control) => control.id),
      saveDisabled: node.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled ?? null,
    }));
    console.log(`[settings-default-provider/escape-hatch-chosen] ${JSON.stringify(reading)}`);
    expect(reading.selected, "the player's own choice wins").toBe("gamebuddy-openai-compatible");
    expect(reading.required, "the escape hatch is where the endpoint's own requirements are stated").toContain(
      "connection-model-id",
    );
    // A real player-configured entry is saveable: the disable above is about an
    // unanswered form, not about the form refusing to work.
    expect(reading.saveDisabled, "a chosen entry can be saved").toBe(false);
  });
});
