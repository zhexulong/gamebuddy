/**
 * The connection section words its own section; the send path words delivery.
 *
 * Measured on the pinned build (`80a69c86`, capture `shots-final43`): Settings opened with
 * "No connection is selected, so a reply cannot reach a model, and a normal install has none to
 * fall back on …", while in the same run `f-turn-variant.txt` read `turn settled: true`,
 * `surface notice after the turn: null`, and `10-chat-1440x900.png` carried no banner at all. A
 * turn WAS served with no connection configured: the Host resolved the Chat model profile this
 * build ships and sent through this machine's operator gateway. Two surfaces answered one
 * question, and only one of them had read the answer.
 *
 * `chat-model-route.ts` is that answer, and it is the Chat's: `connection` and `builtin` both mean
 * a send works, `none` is the one state where a reply has no model, `unknown` says nothing. A
 * panel whose inputs are the connection records cannot restate it - its own read
 * (`state.active === null`) is true in the `builtin` state, which is exactly how the two surfaces
 * came to disagree. So the section says only what a player can do here, and the delivery verdict
 * stays where it is derived.
 *
 * The three readings below are the same mount read three ways:
 *   (i)  with no saved connection but the shipped profile, Settings claims nothing about delivery;
 *   (ii) when the route DOES have a verdict (`none`), only the Chat states it - Settings' own text
 *        is byte-identical in the two states, which is what "one reading" means in one mount;
 *   (iii) the sentence asks for the control the form has: `Save connection` saves, and the test
 *        and activate steps happen on the saved row below, where those controls are.
 *
 * On the pinned build all of them fail. Quoted from the run before the change:
 *
 *   (i)/(ii)  Error: the section states no delivery verdict (/cannot reach a model/iu)
 *             Received string: "No connection is selected, so a reply cannot reach a model, and a
 *             normal install has none to fall back on — configure a connection here: choose a
 *             provider and the model it serves, then save and enable it."
 *   (iii)     Error: the sentence does not ask for a control that is absent
 *             (the same string says "save and enable it" while the form's only submit is
 *             "Save connection", which saves only).
 *   zh-CN     Error: 中文目录也不对送达下结论 (/无法送达/iu)
 *             Received string: "尚未选择连接，回复无法送达模型，普通安装没有它可回退——请在这里配置一条连接……然后保存并启用。"
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

const OPERATOR = {
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
};

/**
 * Every route the composed shell and the Settings panels read.
 *
 * `chatProfile` is the one input that moves the send path's answer: `served` is the ordinary
 * install (the shipped Chat profile, so a send works), and `store_unavailable` is the Host's own
 * mapping for a profile store it cannot read (`invalid_model_profile_store` -> 503
 * `storage_unavailable`), which is the only state in which a reply really has no model.
 *
 * The returned counter is the number of times the Chat model-profile route was READ, so a test can
 * wait for the send path's answer to have arrived before reading either surface's silence: a
 * sentence that is absent because it has not mounted yet would prove nothing.
 */
async function stubRoutes(
  page: Page,
  options: Readonly<{ chatProfile: "served" | "store_unavailable"; locale?: "en" | "zh-CN" }>,
): Promise<{ profileReads: () => number }> {
  if (options.locale !== undefined)
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), options.locale);
  let profileReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  // A fresh install: no connection saved, and nothing active. The escape hatch is the entry the
  // panel preselects, so the form below is the one a player actually meets.
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 3, active: null, connections: [], providers: [OPERATOR] })),
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
    return options.chatProfile === "store_unavailable"
      ? route.fulfill(problem(503, "storage_unavailable"))
      : route.fulfill(
          json200({
            apiVersion: 1,
            recommendedModels: [],
            chat: { revision: 0, modelId: "deepseek-v4-pro", thinkingLevel: "high" },
            game: { revision: 0, modelId: "deepseek-v4-pro", thinkingLevel: "high" },
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
 * Open Settings and read the sentence the connection section opens with, together with the
 * controls that actually exist beneath it.
 */
async function openSettingsAndRead(page: Page, locale: "en" | "zh-CN" = "en") {
  await page.getByRole("button", { name: SETTINGS_ENTRY[locale], exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface.locator("[data-connection-form]")).toBeVisible();
  return await surface.evaluate((node) => {
    const sentence = node.querySelector<HTMLElement>("[data-connection-no-selection]");
    const submit = node.querySelector<HTMLElement>("[data-connection-form] button[type=submit]");
    const list = node.querySelector<HTMLElement>("[data-connection-list]");
    const buttons = [...node.querySelectorAll<HTMLElement>("button")].map((button) => (button.textContent ?? "").trim());
    return {
      sentence: (sentence?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      hasSentence: sentence !== null,
      submitLabel: (submit?.textContent ?? "").trim(),
      hasSavedList: list !== null,
      buttonLabels: buttons,
    };
  });
}

/**
 * The vocabulary that states a delivery verdict. The list is the claim itself, not prose
 * classification: a sentence that says a reply cannot reach, has no, or cannot be answered by a
 * model is answering the send path's question, and the connection section has no basis for it.
 */
const DELIVERY_CLAIMS = {
  en: [/cannot reach a model/iu, /no model/iu, /has none to fall back on/iu, /replies? (?:can|could)not/iu],
  "zh-CN": [/无法送达/iu, /没有模型/iu, /没有它可回退/iu, /回复无法/iu],
} as const;

test.describe("the connection section states what it configures, never whether a reply can be delivered", () => {
  test("(i) with no saved connection but the usable shipped profile, Settings makes no delivery claim", async ({
    page,
  }) => {
    const stubs = await stubRoutes(page, { chatProfile: "served" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);

    // The Chat's own answer, once it has one: the shipped profile answers, so nothing is said
    // there. Waiting for that read is what makes the silence evidence rather than a race.
    await expect.poll(stubs.profileReads, "the send path's own read has landed").toBeGreaterThan(0);
    await expectChatVerdict(page, false);

    const reading = await openSettingsAndRead(page);
    console.log(`[settings-connection-sentence/served] ${JSON.stringify(reading)}`);

    expect(reading.hasSentence, "the fresh-install state opens the section with its own sentence").toBe(true);
    for (const claim of DELIVERY_CLAIMS.en)
      expect(reading.sentence, `the section states no delivery verdict (${claim})`).not.toMatch(claim);
  });

  test("(ii) the same mount in both states: only the Chat's reading changes, Settings' sentence does not", async ({
    page,
  }) => {
    const servedStubs = await stubRoutes(page, { chatProfile: "served" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect.poll(servedStubs.profileReads, "the send path's read has landed").toBeGreaterThan(0);
    await expectChatVerdict(page, false);
    const servedSettings = await openSettingsAndRead(page);

    const unservableStubs = await stubRoutes(page, { chatProfile: "store_unavailable" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect.poll(unservableStubs.profileReads, "the send path's read has landed").toBeGreaterThan(0);
    // The one reading, and it moved: the Host cannot serve the Chat profile its send path
    // resolves, so the Chat states the verdict.
    await expectChatVerdict(page, true);
    const unservableSettings = await openSettingsAndRead(page);

    console.log(`[settings-connection-sentence/both] ${JSON.stringify({ servedSettings, unservableSettings })}`);

    // Settings is not a second reading of the same question: its sentence is the same string in
    // both states, and neither is a delivery verdict.
    expect(unservableSettings.sentence, "the section's sentence does not move with the send path").toBe(
      servedSettings.sentence,
    );
    for (const claim of DELIVERY_CLAIMS.en)
      expect(unservableSettings.sentence, `the section states no delivery verdict (${claim})`).not.toMatch(claim);
  });

  test("(iii) the sentence asks for the control the form has, and points at where activate really lives", async ({
    page,
  }) => {
    await stubRoutes(page, { chatProfile: "served" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const reading = await openSettingsAndRead(page);
    console.log(`[settings-connection-sentence/controls] ${JSON.stringify(reading)}`);

    // The form's only submit is Save connection, and it saves: activation is a separate Host
    // operation that refuses a record whose probe has not passed (`connection_not_ready`).
    expect(reading.submitLabel, "the form's submit is named for what it does").toBe("Save connection");
    // A fresh install has no saved row, so the activate control does not exist on the surface at
    // all - a sentence that sends the player to it names a control that is not there.
    expect(reading.hasSavedList, "a fresh install has no saved-connection list").toBe(false);
    expect(reading.buttonLabels, "no activate control is rendered before a connection is saved").not.toContain(
      "Save and activate",
    );
    expect(reading.sentence, "the sentence asks for a save, which the form can do").toMatch(/save/iu);
    expect(reading.sentence, "the sentence does not ask for a control that is absent").not.toMatch(
      /save and enable|保存并启用/iu,
    );
    expect(reading.sentence, "the sentence says where test and activate live").toMatch(/test|activate/iu);
  });

  test("the same two readings hold in zh-CN, from that catalogue's own sentence", async ({ page }) => {
    await stubRoutes(page, { chatProfile: "served", locale: "zh-CN" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const reading = await openSettingsAndRead(page, "zh-CN");
    console.log(`[settings-connection-sentence/zh] ${JSON.stringify(reading)}`);

    for (const claim of DELIVERY_CLAIMS["zh-CN"])
      expect(reading.sentence, `中文目录也不对送达下结论 (${claim})`).not.toMatch(claim);
    expect(reading.sentence, "中文句子要求的是表单上真正存在的保存控件").not.toMatch(/保存并启用/u);
    expect(reading.sentence, "中文句子说明测试与启用发生在已保存的记录上").toMatch(/测试/u);
  });
});
