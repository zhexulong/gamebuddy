/**
 * The screen a player meets: what the conversation says before anything has been
 * set up, and what the settings surface puts in front of them.
 *
 * Four owner decisions live here, one describe each, over the shipped composed
 * shell with its management routes mocked (the same fixture style as
 * `management-surface-panels.spec.ts`):
 *
 *  - A: the conversation's claim about a model is the send path's own answer, in
 *    three states - no saved connection but the shipped profile (silent, and the
 *    message still gets a reply), no saved connection and no servable profile (the
 *    sentence and the way to Settings), and a saved connection (silent).
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

/** A refusal in the frozen problem shape: what the Host answers when it cannot serve a route. */
function problem(status: number, code: string, retryable: boolean) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({
      type: "about:blank",
      title: "Refused",
      status,
      code,
      requestId: `${'R'.repeat(42)}A`,
      retryable,
    }),
  };
}

/** Every route the composed shell and the four settings panels read. */
async function stubProductRoutes(
  page: Page,
  options: Readonly<{
    activeConnection: boolean;
    chatVoice?: "unavailable" | "ready";
    /** What the Chat model profile route answers: served, or the store refusing. */
    chatProfile?: "served" | "store_unavailable";
  }>,
) {
  const chat = options.chatVoice === undefined ? composedChat : { ...composedChat, voice: { state: options.chatVoice } };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(json200({ ...composedRoot, chat })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200(connectionState(options.activeConnection))),
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
    options.chatProfile === "store_unavailable"
      ? // The Host's own mapping for a profile store it cannot read
        // (`invalid_model_profile_store` -> 503 `storage_unavailable`).
        route.fulfill(problem(503, "storage_unavailable", false))
      : route.fulfill(
          json200({
            apiVersion: 1,
            recommendedModels: [],
            chat: { revision: 0, thinkingLevel: "high" },
            game: { revision: 0, thinkingLevel: "high" },
          }),
        ),
  );
}

test.describe("A: the conversation's claim about a model is the send path's own answer", () => {
  /**
   * (a) A BYOK connection the player activated: the conversation is silent and a message really
   * does get a reply.
   *
   * What the old code did here, measured on the pinned build: `readConnection().active === null`
   * painted `data-chat-connection-missing` reading "No model connection is set up yet" on a Chat
   * whose very next send was answered by the shipped profile through the operator gateway. The
   * assertion below fails on that build twice: the banner exists, and the reply never lands
   * because the banner's claim was never true in the first place.
   *
   * The premise moved once more with the BYOK ruling: there is no shipped profile any more, so
   * "a send works" now means "the player activated a connection" - and that is the state this
   * journey mounts. The silence is the same invariant; only what produces it changed.
   */
  test("with an activated connection it says nothing, and a send gets a reply", async ({ page }) => {
    const playerText = "Are you there?";
    const replyText = "I am. The kettle is on.";
    const playerHandle = `${'P'.repeat(42)}A`;
    const replyHandle = `${'Q'.repeat(42)}A`;
    const turnHandle = `${'T'.repeat(42)}A`;
    let submitted = false;
    const projection = () => ({
      ...composedRoot,
      chat: {
        ...composedChat,
        chat: {
          ...composedChat.chat,
          transcript: submitted
            ? [
                { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 0, revision: 1 },
                { handle: replyHandle, role: "companion", text: replyText, locale: "und", order: 1, revision: 1 },
              ]
            : [],
          turn: submitted ? { handle: turnHandle, state: "completed", projectionRevision: 1, canCancel: false } : null,
        },
      },
    });

    await stubProductRoutes(page, { activeConnection: true });
    // The composed root is re-read by the fallback poll, so it is stubbed with the same projection.
    await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(projection())));
    await page.route("**/api/tavern/v1/messages", async (route) => {
      submitted = true;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          apiVersion: 1,
          disposition: "accepted",
          message: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 0, revision: 1 },
          turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
        }),
      });
    });
    await page.route("**/api/tavern/v1/message-submission-status", (route) =>
      route.fulfill(json200({ apiVersion: 1, disposition: "terminal" })),
    );
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();
    // The claim the surface makes is the route a send takes: an activated connection, so no sentence.
    await expect(chat.locator("[data-chat-no-model]")).toHaveCount(0);
    await expect(chat).not.toContainText("No model can answer right now");

    // …and the send path agrees, which is the invariant the banner is derived from.
    await chat.locator("textarea").fill(playerText);
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat.locator(".message-list")).toContainText(replyText);
  });

  /**
   * (b) No saved connection: a reply has no model, so the conversation says so and offers the one
   * surface where a model is chosen - without taking the composer.
   *
   * With BYOK there is no shipped profile to fall back on, so "no connection" IS "no model" and the
   * route is `none` whether or not the profile store answers. The sentence is the state a fresh
   * install meets, which is why it must not be weakened into silence: it is the only place the
   * product tells the player what is missing and where it is fixed, and the transcript stays readable
   * and the composer writable while it does.
   */
  test("with no saved connection the sentence names the problem and its button opens Settings", async ({
    page,
  }) => {
    await stubProductRoutes(page, { activeConnection: false });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();

    const banner = chat.locator("[data-chat-no-model]");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("No model yet");
    await expect(banner).toContainText("keep reading meanwhile");

    // The composer is still there and still takes text: the sentence is not a replacement for
    // writing, it is the reason this send cannot succeed.
    const composer = chat.locator("textarea");
    await expect(composer).toBeVisible();
    await composer.fill("Are you there?");
    await expect(composer).toHaveValue("Are you there?");

    // The button goes to the surface that fixes it.
    await banner.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await expect(page.getByTestId("chat-surface")).toHaveCount(0);
  });

  test("a profile store the Host cannot serve reads the same way, because the player's next step is the same", async ({
    page,
  }) => {
    await stubProductRoutes(page, { activeConnection: false, chatProfile: "store_unavailable" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    await expect(page.getByTestId("chat-surface").locator("[data-chat-no-model]")).toBeVisible();
  });

  test("with an active connection the sentence is absent and the composer unchanged", async ({ page }) => {
    await stubProductRoutes(page, { activeConnection: true });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    const chat = page.getByTestId("chat-surface");
    await expect(chat).toBeVisible();
    await expect(chat.locator("[data-chat-no-model]")).toHaveCount(0);
    const composer = chat.locator("textarea");
    await expect(composer).toBeVisible();
    await composer.fill("Are you there?");
    await expect(composer).toHaveValue("Are you there?");
  });
});

/**
 * The four settings groups in the order the surface renders them.
 *
 * Read off the DOM rather than trusted from the source: the order a player meets
 * is the order the elements sit in, and `compareDocumentPosition` is that fact.
 */
async function settingsGroupOrder(page: Page): Promise<string[]> {
  return await page.getByTestId("settings-surface").evaluate((surface) => {
    const rows: Array<readonly [string, string]> = [
      ["connection", "[data-connection-settings]"],
      ["language", "[data-language-settings]"],
      ["voice", "[data-voice-settings]"],
      ["modelProfiles", "[data-model-profiles]"],
    ];
    return [...surface.querySelectorAll(rows.map(([, selector]) => selector).join(","))].map(
      (element) => rows.find(([, selector]) => element.matches(selector))![0],
    );
  });
}

/** Where one settings group starts, in page pixels, with the surface scrolled to its top. */
async function settingsGroupTop(page: Page, selector: string): Promise<number> {
  const box = await page.getByTestId("settings-surface").locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not laid out`);
  return box.y;
}

const VIEWPORT = { width: 1280, height: 720 };

test.describe("B: the connection section is the first thing in Settings", () => {
  test("the model connection comes before language and voice, inside the first screen", async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await stubProductRoutes(page, { activeConnection: false });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await expect(page.getByTestId("settings-surface").locator("[data-connection-settings]")).toBeVisible();

    // The order a player meets, measured: the connection group is first, and both
    // the language and the voice group come after it. Before this change the
    // connection group sat at 878 px - below the 720 px viewport, behind language
    // and the whole voice section - and now starts at 56 px.
    const order = await settingsGroupOrder(page);
    expect(order[0]).toBe("connection");
    expect(order.indexOf("connection")).toBeLessThan(order.indexOf("language"));
    expect(order.indexOf("connection")).toBeLessThan(order.indexOf("voice"));

    const connectionTop = await settingsGroupTop(page, "[data-connection-settings]");
    const languageTop = await settingsGroupTop(page, "[data-language-settings]");
    const voiceTop = await settingsGroupTop(page, "[data-voice-settings]");
    expect(connectionTop).toBeLessThan(languageTop);
    expect(connectionTop).toBeLessThan(voiceTop);
    // Inside the first viewport, not merely before something else: the whole
    // section a player must act on is on the screen they land on.
    const connectionBox = await page.getByTestId("settings-surface").locator("[data-connection-settings]").boundingBox();
    expect(connectionBox!.y).toBeGreaterThanOrEqual(0);
    expect(connectionBox!.y + connectionBox!.height).toBeLessThan(VIEWPORT.height);
  });

  test("every control and data hook the connection group had is still there", async ({ page }) => {
    await stubProductRoutes(page, { activeConnection: true });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const connection = page.getByTestId("settings-surface").locator("[data-connection-settings]");
    await expect(connection).toBeVisible();
    await expect(connection.locator("[data-connection-active]")).toBeVisible();
    await expect(connection.locator("[data-connection-form]")).toBeVisible();
    await expect(connection.locator("#connection-provider")).toBeVisible();
    await expect(connection.locator("[data-connection-list]")).toBeVisible();
    await expect(connection.getByRole("button", { name: "Save connection", exact: true })).toBeVisible();
  });
});

test.describe("C: the voice consent leaves the first settings screen", () => {
  test("the consent is the last group, still there, and its controls are below the first viewport", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await stubProductRoutes(page, { activeConnection: true });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const surface = page.getByTestId("settings-surface");
    await expect(surface.locator("[data-voice-settings]")).toBeAttached();

    // The voice group is the last group the surface renders, so the disclosure and
    // its consent are not among the first things a player reads. Measured at
    // 1280x720: the group starts at 1529 px and its Accept/Revoke pair at 1673 px,
    // where before this decision they stood at 405 px and 548 px - inside the
    // first screen.
    const order = await settingsGroupOrder(page);
    expect(order[order.length - 1]).toBe("voice");

    const consent = surface.locator("[data-voice-settings]").getByRole("button", { name: "Accept", exact: true });
    await expect(consent).toHaveCount(1);
    const consentBox = await consent.boundingBox();
    expect(consentBox!.y).toBeGreaterThan(VIEWPORT.height);
  });

  test("accepting it still writes the one durable consent the runtime reads", async ({ page }) => {
    const writes: unknown[] = [];
    await page.setViewportSize(VIEWPORT);
    await stubProductRoutes(page, { activeConnection: true });
    // Replaces the read stub for this test: the read keeps its answer, the write
    // is recorded and answered with the accepted read-back.
    await page.route("**/api/tavern/v1/settings/voice-preference", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill(
          json200({
            revision: 1,
            disclosureVersion: null,
            consent: "undecided",
            decidedAtMs: null,
            outputDevice: null,
            persona: null,
          }),
        );
        return;
      }
      writes.push(route.request().postDataJSON());
      await route.fulfill(
        json200({
          revision: 2,
          disclosureVersion: "mimo-cloud-tts-v1",
          consent: "accepted",
          decidedAtMs: 1_900_000_000_000,
          outputDevice: null,
          persona: null,
        }),
      );
    });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const voice = page.getByTestId("settings-surface").locator("[data-voice-settings]");
    await expect(voice).toContainText("Cloud TTS consent");
    await expect(voice).toContainText("Not decided");
    await voice.getByRole("button", { name: "Accept", exact: true }).click();

    // The disclosure version rides with the consent: agreement to a version, not
    // a boolean, so a later disclosure cannot inherit an older yes.
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ action: "accept", expectedRevision: 1, disclosureVersion: "mimo-cloud-tts-v1" });
    await expect(voice).toContainText("Accepted");
  });

  test("the conversation offers voice only as the Host's own record grants it", async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await stubProductRoutes(page, { activeConnection: true, chatVoice: "unavailable" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const chat = page.getByTestId("chat-surface");
    await expect(chat.locator("[data-voice-state='unavailable']")).toBeAttached();
    await expect(chat).toContainText("Voice unavailable");
  });

  test("an accepted consent is what turns the conversation's voice control on", async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await stubProductRoutes(page, { activeConnection: true, chatVoice: "ready" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    // The gate is the record the Host projects, never the settings screen the
    // player happens to have open: the same control reads as the talking one only
    // once that record says `ready`.
    const chat = page.getByTestId("chat-surface");
    await expect(chat.locator("[data-voice-state='ready']")).toBeAttached();
    await expect(chat).toContainText("Voice ready — press to talk");
  });
});

test.describe("D: the credential sentence tells the truth about who provides it", () => {
  test("the operator's gateway says the operator provides it, a third-party provider says bring your own", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await stubProductRoutes(page, { activeConnection: false });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const form = page.getByTestId("settings-surface").locator("[data-connection-form]");
    const picker = form.locator("#connection-provider");
    await expect(picker).toBeVisible();

    // The operator's own local gateway: `cpa-oai`. Its credential is this machine's
    // environment variables, and the form must not invite a key it cannot accept.
    await picker.selectOption("cpa-oai");
    const operatorHelp = form.locator("[data-connection-credential-help='operator']");
    await expect(operatorHelp).toHaveText(
      "This connection is provided by the operator of this machine through environment variables. There is no key to enter here.",
    );
    await expect(operatorHelp).toContainText("provided by the operator");
    await expect(operatorHelp).not.toContainText("Bring your own key");
    const operatorText = await operatorHelp.textContent();
    // Nothing to type: the entry declares no API-key field at all.
    await expect(form.locator("#connection-api-key")).toHaveCount(0);

    // A third-party provider: the key is the player's own, from their own account.
    await picker.selectOption("deepseek");
    const playerHelp = form.locator("[data-connection-credential-help='player']");
    await expect(playerHelp).toHaveText(
      "Bring your own key: it comes from your own account with this provider, and GameBuddy does not supply one.",
    );
    await expect(playerHelp).not.toContainText("provided by the operator");
    await expect(form.locator("#connection-api-key")).toBeVisible();

    // The two sentences are different text, not one merged sentence shown twice.
    expect(operatorText).not.toBe(await playerHelp.textContent());
    expect(operatorText).toContain("operator");
    expect(await playerHelp.textContent()).toContain("Bring your own key");
  });
});
