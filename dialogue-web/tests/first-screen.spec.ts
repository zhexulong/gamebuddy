/**
 * The screen a player meets: what the conversation says before anything has been
 * set up, and what the settings surface puts in front of them.
 *
 * Four owner decisions live here, one describe each, over the shipped composed
 * shell with its management routes mocked (the same fixture style as
 * `management-surface-panels.spec.ts`):
 *
 *  - A: no model connection is a sentence on the conversation, with the way to
 *    the surface that fixes it - and the composer stays.
 *  - B: the connection section is the first section of Settings, above language
 *    and voice, in DOM order.
 *  - C: the voice consent is not in the first settings viewport, and it is still
 *    the consent that gates voice.
 *  - D: the operator's own gateway says the operator provides it; a third-party
 *    provider keeps "bring your own key".
 */
import { type Page, expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA";

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [{ operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" }],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
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

const composedDraft = { apiVersion: 1, revision: 4, text: "A durable delegated draft." };

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

const CONNECTION_ID = `${"E".repeat(42)}A`;

/** The provider catalogue the Host publishes: the operator's gateway and one third-party entry. */
const providers = [
  {
    providerId: "cpa-oai",
    label: "Operator gateway",
    setupFields: [],
    allowedPlayerModels: [
      {
        modelId: "deepseek-v4.1-flash",
        modelLabel: "DeepSeek V4.1 Flash",
        allowedThinkingLevels: ["low", "high"],
        defaultThinkingLevel: "high",
      },
    ],
    escapeHatch: false,
    environmentManaged: true,
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    setupFields: ["apiKey", "modelId"],
    allowedPlayerModels: [
      {
        modelId: "deepseek-v4-pro",
        modelLabel: "DeepSeek V4 Pro",
        allowedThinkingLevels: ["high", "max"],
        defaultThinkingLevel: "high",
      },
    ],
    escapeHatch: false,
    environmentManaged: false,
  },
];

function connectionState(active: boolean) {
  return {
    apiVersion: 1,
    revision: 3,
    active: active
      ? {
          connectionId: CONNECTION_ID,
          label: "DeepSeek",
          providerLabel: "DeepSeek",
          modelId: "deepseek-v4-pro",
          modelLabel: "DeepSeek V4 Pro",
          thinkingLevel: "high",
          readiness: "ready",
          baseUrl: null,
          failure: null,
          lastCheckedAtMs: null,
        }
      : null,
    connections: active
      ? [
          {
            connectionId: CONNECTION_ID,
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
          },
        ]
      : [],
    providers,
  };
}

/** Every route the composed shell and the four settings panels read. */
async function stubProductRoutes(page: Page, options: Readonly<{ activeConnection: boolean }>) {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200(connectionState(options.activeConnection))),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(json200({ revision: 0, locale: "en-US" })),
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

test.describe("A: the conversation speaks before the player sends", () => {
  test("with no active connection it says so, and its button opens Settings without taking the composer", async ({
    page,
  }) => {
    await stubProductRoutes(page, { activeConnection: false });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();

    // The standing sentence, in the player's own words, naming what is missing.
    const banner = chat.locator("[data-chat-connection-missing]");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("No model connection is set up yet");

    // The composer is still there and still takes text: the sentence is not a
    // replacement for writing, it is the reason a send cannot succeed.
    const composer = chat.locator("textarea");
    await expect(composer).toBeVisible();
    await composer.fill("Are you there?");
    await expect(composer).toHaveValue("Are you there?");

    // The button goes to the surface that fixes it.
    await banner.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  });

  test("with an active connection the sentence is absent and the composer unchanged", async ({ page }) => {
    await stubProductRoutes(page, { activeConnection: true });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();
    await expect(chat.locator("[data-chat-connection-missing]")).toHaveCount(0);
    const composer = chat.locator("textarea");
    await expect(composer).toBeVisible();
    await composer.fill("Are you there?");
    await expect(composer).toHaveValue("Are you there?");
  });
});
