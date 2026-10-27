import { expect, test, type Page } from "@playwright/test";

/**
 * Arriving at the conversation shows the Host's state as it is *now*, not as it was when the
 * shell last happened to read.
 *
 * The owner's report: granting the cloud-TTS consent in Settings left the conversation's mic
 * disabled (`MicOff`) until a reload. The mic is a fact of the composed root's Chat half - the
 * shell read it at mount and never again - so the pre-consent projection stood until an F5.
 *
 * The fix reuses the read path the shell already had: arriving at the conversation re-reads the
 * composed root through `rereadChat`, the same authoritative read every Chat mutation performs.
 * No timer, no poll, and no second copy of the state - the surface renders the projection the
 * shell committed, and an arrival replaces that projection with a fresh read of the authority.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const connectionId = `${"F".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The composed root over one committed Chat state; `voice` is the snapshot's own mic fact. */
function composedRoot(voice: "unavailable" | "ready") {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: {
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
        companion: { name: "Mira", handle: companionHandle },
        title: null,
        transcript: [],
        draft: { revision: 4, present: true },
        turn: null,
        worldInfo: null,
      },
      memory: { readAvailable: true, mutationAvailable: true, projectionRevision: `${"E".repeat(42)}A` },
      eventStream: null,
      voice: { state: voice },
    },
    game: {
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
    },
  };
}

/**
 * The Host behind the shell, as one mutable record the routes answer from, so a journey can make
 * the Host move a fact and then assert what the surface shows afterwards. The voice preference
 * moves with `voice`: it is the player's own consent, which is what the Settings panel writes.
 */
async function stubHost(page: Page, state: { voice: "unavailable" | "ready" }): Promise<void> {
  const root = () => composedRoot(state.voice);

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  // A saved, ready connection, so Settings renders its real connection group beside the voice one.
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: {
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
        },
        connections: [
          {
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
          },
        ],
        providers: [
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
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) => {
    const accepted = state.voice === "ready";
    return route.fulfill(
      jsonOk({
        revision: accepted ? 2 : 1,
        disclosureVersion: accepted ? "mimo-cloud-tts-v1" : null,
        consent: accepted ? "accepted" : "undecided",
        decidedAtMs: accepted ? 1_900_000_000_000 : null,
        outputDevice: null,
        persona: null,
      }),
    );
  });
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(jsonOk({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
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
}

test("granting voice consent in Settings reaches the conversation's mic on the way back, without a reload", async ({
  page,
}) => {
  const state = { voice: "unavailable" as "unavailable" | "ready" };
  await stubHost(page, state);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const chat = page.getByTestId("chat-surface");
  await expect(chat).toBeVisible();
  // Where the player starts: no consent, so the Host projects `unavailable` and the composer
  // shows the disabled mic.
  await expect(chat.locator("[data-voice-state]")).toHaveAttribute("data-voice-state", "unavailable");
  await expect(chat).toContainText("Voice unavailable");

  // The player goes to Settings and grants the consent there. The Host moves; nothing on the
  // conversation has read since it mounted.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-surface")).toBeVisible();
  state.voice = "ready";

  // Back on the conversation, the mic the player is looking at is the Host's current answer.
  // Before the arrival read this failed with `unavailable`: the projection the shell committed
  // at mount stood until a reload.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(chat).toBeVisible();
  await expect(chat.locator("[data-voice-state]")).toHaveAttribute("data-voice-state", "ready");
  await expect(chat).toContainText("Voice ready — press to talk");
  await expect(chat).not.toContainText("Voice unavailable");

  // No reload happened: the one-shot boot token is spent for good, and a reload would need it.
  await expect(page).not.toHaveURL(/boot=/u);
});
