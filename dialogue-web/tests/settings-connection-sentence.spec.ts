/**
 * One authority answers "can she reply", and the connection section words itself from it.
 *
 * The history of this assertion, because it moved twice and each move is a product decision:
 *
 *  1. On `80a69c86` the section opened with "No connection is selected, so a reply cannot reach a
 *     model, and a normal install has none to fall back on", while the same run settled a turn
 *     through the shipped Chat profile on this machine's operator gateway. Two surfaces answered
 *     one question, and only one had read the answer - so the rule became "the section states what
 *     it configures and NEVER whether a reply can be delivered".
 *
 *  2. That rule was correct only while a gateway was shipped. With BYOK there is no shipped
 *     channel: a root with no connection genuinely cannot answer, "no connection" and "no model"
 *     are the same fact again, and a section that stayed silent would be hiding the one thing a
 *     newcomer must learn. So the section states it - but it must still not DERIVE it. It reads
 *     `readChatModelRoute`, the one function that applies the Host's own precedence, exactly as
 *     the Chat does. `data-connection-model-route` is that answer, so these tests can prove the
 *     sentence moves with the authority rather than with the panel's own records.
 *
 * The three readings below:
 *   (i)   an active connection: the section says what it configures, and makes no delivery claim -
 *         there is nothing wrong, and a warning would be a lie in the other direction;
 *   (ii)  no active connection: the section says she has no model and names the next step, and the
 *         sentence is byte-identical to the third reading, because the next step is the same;
 *   (iii) a profile store the Host cannot serve: the same sentence again - "you configured nothing"
 *         and "the Host cannot serve the profile" are different causes with one action.
 *
 * KNOWN GAP, deliberately not papered over: in (ii) the route is `builtin`, and `ChatSurface` only
 * renders its banner for `none`. So the Chat is silent while Settings speaks. `chat-model-route.ts`
 * is not this change's file; making the Chat say the same sentence means `builtin` must stop meaning
 * "a send works". That is reported rather than worked around here.
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

/** A refusal in the frozen problem shape. */
function problem(status: number, code: string) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({
      type: "about:blank",
      title: "Refused",
      status,
      code,
      requestId: `${"R".repeat(42)}A`,
      retryable: false,
    }),
  };
}

const DEEPSEEK = {
  providerId: "deepseek",
  label: "DeepSeek",
  setupFields: ["apiKey", "modelId"],
  allowedPlayerModels: [
    {
      modelId: "deepseek-v4.1-flash",
      modelLabel: "DeepSeek V4.1 Flash",
      allowedThinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
    },
  ],
  escapeHatch: false,
  environmentManaged: false,
};

const CONNECTION_ID = `${"E".repeat(42)}A`;

/**
 * Every route the composed shell and the Settings panels read.
 *
 * `connection` is the one input that moves the send path's answer between the two readable states:
 * `active` is a player who activated a connection, `none` is a fresh root. `profileStore` is the
 * other axis: the Host's own mapping for a profile store it cannot read is 503 `storage_unavailable`,
 * which is the `none` route.
 *
 * The returned counter is the number of times the Chat model-profile route was READ, so a test can
 * wait for the send path's answer to have arrived before reading either surface's silence: a
 * sentence that is absent because it has not mounted yet would prove nothing.
 */
async function stubRoutes(
  page: Page,
  options: Readonly<{
    connection: "active" | "none";
    profileStore: "served" | "store_unavailable";
    locale?: "en" | "zh-CN";
  }>,
): Promise<{ profileReads: () => number }> {
  if (options.locale !== undefined)
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), options.locale);
  let profileReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        revision: 3,
        active:
          options.connection === "active"
            ? {
                connectionId: CONNECTION_ID,
                label: "DeepSeek \u00b7 deepseek-v4.1-flash",
                providerLabel: "DeepSeek",
                modelId: "deepseek-v4.1-flash",
                modelLabel: "DeepSeek V4.1 Flash",
                thinkingLevel: "high",
                readiness: "ready",
                baseUrl: null,
                failure: null,
                lastCheckedAtMs: null,
              }
            : null,
        connections:
          options.connection === "active"
            ? [
                {
                  connectionId: CONNECTION_ID,
                  label: "DeepSeek \u00b7 deepseek-v4.1-flash",
                  providerId: "deepseek",
                  providerLabel: "DeepSeek",
                  configured: true,
                  readiness: "ready",
                  active: true,
                  modelId: "deepseek-v4.1-flash",
                  modelLabel: "DeepSeek V4.1 Flash",
                  thinkingLevel: "high",
                  allowedThinkingLevels: ["low", "high"],
                  modelIds: ["deepseek-v4.1-flash"],
                  baseUrl: null,
                  failure: null,
                  lastCheckedAtMs: null,
                },
              ]
            : [],
        providers: [DEEPSEEK],
      }),
    ),
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
  await page.route("**/api/tavern/v1/settings/profiles", (route) => {
    profileReads += 1;
    return options.profileStore === "store_unavailable"
      ? route.fulfill(problem(503, "storage_unavailable"))
      : route.fulfill(
          json200({
            apiVersion: 1,
            recommendedModels: [],
            chat: { revision: 0, thinkingLevel: "high" },
            game: { revision: 0, thinkingLevel: "high" },
          }),
        );
  });
  return { profileReads: () => profileReads };
}

/**
 * What the Chat surface says about delivery, once its own read of the send path has arrived.
 *
 * Waits for the expected answer rather than sampling: the Chat's sentence is derived
 * asynchronously, and an absence read before that read lands would prove nothing.
 */
async function expectChatVerdict(page: Page, statesTheProblem: boolean): Promise<void> {
  const chat = page.getByTestId("chat-surface");
  await expect(chat).toBeVisible();
  const banner = chat.locator("[data-chat-no-model]");
  await expect(banner).toHaveCount(statesTheProblem ? 1 : 0);
}

/** The panel's own name in each catalogue, used to reach Settings the way a player does. */
const SETTINGS_ENTRY = { en: "Settings", "zh-CN": "设置" } as const;

/**
 * Open Settings and read the sentence the connection section opens with, together with the answer
 * the section derived it from and the controls that actually exist beneath it.
 */
async function openSettingsAndRead(page: Page, locale: "en" | "zh-CN" = "en") {
  await page.getByRole("button", { name: SETTINGS_ENTRY[locale], exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface.locator("[data-connection-form]")).toBeVisible();
  return await surface.evaluate((node) => {
    const sentence = node.querySelector<HTMLElement>("[data-connection-no-selection]");
    const submit = node.querySelector<HTMLElement>("[data-connection-form] button[type=submit]");
    const buttons = [...node.querySelectorAll<HTMLElement>("button")].map((button) => (button.textContent ?? "").trim());
    return {
      sentence: (sentence?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      hasSentence: sentence !== null,
      // The authority the sentence was worded from, asserted rather than assumed.
      route: sentence?.getAttribute("data-connection-model-route") ?? null,
      submitLabel: (submit?.textContent ?? "").trim(),
      buttonLabels: buttons,
    };
  });
}

/** The vocabulary that promises a reply is delivered. It has no place in the configured state. */
const DELIVERY_PROMISES = {
  en: [/no model/iu, /she has no model/iu, /supplies no endpoint/iu],
  "zh-CN": [/没有可用的模型/u, /不提供任何端点/u],
} as const;

test.describe("the connection section words itself from the one send-path authority", () => {
  test("(i) with an active connection it says what it configures, and makes no no-model claim", async ({ page }) => {
    const stubs = await stubRoutes(page, { connection: "active", profileStore: "served" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    await expect.poll(stubs.profileReads, "the send path's own read has landed").toBeGreaterThan(0);
    // With a connection active the Chat has nothing to complain about.
    await expectChatVerdict(page, false);

    const reading = await openSettingsAndRead(page);
    console.log(`[settings-connection-sentence/active] ${JSON.stringify(reading)}`);

    // The section's sentence here is the row above it: an active connection renders the summary,
    // not the first-run hint. What matters is that nothing claims a missing model.
    for (const claim of DELIVERY_PROMISES.en)
      expect(reading.sentence, `a configured root makes no no-model claim (${claim})`).not.toMatch(claim);
  });

  test("(ii) with no connection it states the truth and names the next step", async ({ page }) => {
    const stubs = await stubRoutes(page, { connection: "none", profileStore: "served" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect.poll(stubs.profileReads, "the send path's read has landed").toBeGreaterThan(0);

    const reading = await openSettingsAndRead(page);
    console.log(`[settings-connection-sentence/unconfigured] ${JSON.stringify(reading)}`);

    expect(reading.hasSentence, "the fresh-install state opens the section with its own sentence").toBe(true);
    // The sentence is the one for THIS derived route, and it says the two things a newcomer needs:
    // she cannot answer yet, and the form below is where that changes.
    expect(reading.route, "the sentence is worded from the derived route, not from the records").not.toBe(
      "connection",
    );
    expect(reading.sentence, "it says she has no model").toMatch(/no model/iu);
    expect(reading.sentence, "it says who supplies one").toMatch(/bring your own/iu);
    expect(reading.sentence, "it names the control this form has").toMatch(/save/iu);
    expect(reading.sentence, "it does not promise a product endpoint").toMatch(/supplies no endpoint/iu);
    expect(reading.submitLabel, "and that control exists").toBe("Save connection");
  });

  test("(iii) a store the Host cannot serve gets the same sentence: one action, one wording", async ({ page }) => {
    const unservable = await stubRoutes(page, { connection: "none", profileStore: "store_unavailable" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect.poll(unservable.profileReads, "the send path's read has landed").toBeGreaterThan(0);
    // The Host cannot serve the Chat profile its send path resolves, so the Chat states the verdict.
    await expectChatVerdict(page, true);
    const unservableSettings = await openSettingsAndRead(page);

    const served = await stubRoutes(page, { connection: "none", profileStore: "served" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect.poll(served.profileReads, "the send path's read has landed").toBeGreaterThan(0);
    const servedSettings = await openSettingsAndRead(page);

    console.log(
      `[settings-connection-sentence/both] ${JSON.stringify({ servedSettings, unservableSettings })}`,
    );

    // Two causes, one action: "you configured nothing" and "the Host cannot serve the profile" both
    // mean the player must bring a connection, so the section says one sentence for both rather
    // than inventing a difference the player cannot act on.
    expect(unservableSettings.sentence, "the two unserved causes read the same").toBe(servedSettings.sentence);
    expect(unservableSettings.route).not.toBe("connection");
    expect(servedSettings.route).not.toBe("connection");
  });

  test("the same two readings hold in zh-CN, from that catalogue's own sentence", async ({ page }) => {
    await stubRoutes(page, { connection: "none", profileStore: "served", locale: "zh-CN" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const reading = await openSettingsAndRead(page, "zh-CN");
    console.log(`[settings-connection-sentence/zh] ${JSON.stringify(reading)}`);

    expect(reading.sentence, "中文句子说明她暂时没有可用模型").toMatch(/没有可用的模型/u);
    expect(reading.sentence, "中文句子说明产品不提供端点").toMatch(/不提供任何端点/u);
    expect(reading.sentence, "中文句子要求的是表单上真正存在的保存控件").toMatch(/保存/u);
    for (const claim of DELIVERY_PROMISES["zh-CN"])
      expect(reading.sentence, `中文句子与路由一致 (${claim})`).toMatch(claim);
  });
});
