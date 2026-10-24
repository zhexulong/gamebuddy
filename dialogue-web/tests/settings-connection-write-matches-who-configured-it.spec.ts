/**
 * A write control exists only where the player configured something.
 *
 * Measured on the build before this change: the connection section's form ended in one control,
 * `button[type=submit]` reading "Save connection", for every entry in the picker. Selecting the
 * environment-managed entry (`cpa-oai`: `setupFields: []`, `environmentManaged: true`), whose
 * endpoint and credential both live in this machine's environment, left the section offering a
 * write with no player input behind it - while the sentence beside the picker said, in the same
 * breath, that the operator provides everything. Read at 1440x900 on that build:
 *
 *   `#connection-provider` = cpa-oai, `[data-connection-credential-help="operator"]` =
 *   "This connection is provided by the operator of this machine through environment variables.
 *   There is no key to enter here.", and the form's only submit = "Save connection" - a record for a
 *   channel the player did not configure.
 *
 * Two things moved under this defect before it was fixed, and both are measured here rather than
 * assumed away:
 *
 *  - the operator entry left the browser's catalogue. `playerOfferedProviders()` withholds it unless
 *    `GAMEBUDDY_OPERATOR_GATEWAY=1`, so a player's picker cannot land on it at all, and the form now
 *    opens on an empty choice instead of a preselected entry. That removes the DEFAULT contradiction
 *    by construction - which is why the first test below is an assertion about the catalogue rather
 *    than about the form.
 *  - the entry is still reachable on the one path that remains: the explicit developer switch, whose
 *    label says so (`Operator gateway (developer only)`). There the form still renders no field, and
 *    before this change it still ended in a submit. That is the state the second test drives.
 *
 * The rule: a control that writes must correspond to something the player configured. The value of
 * an environment-managed entry comes from the environment, so there is no player input to persist and
 * therefore no submit. Where the submit was, the section states the state instead: a disabled button
 * would still stand where an action belongs, and would read as "the save is unavailable right now".
 *
 * The other half is the path that must not move: a bring-your-own-key entry (a URL, a key, a model,
 * or a key and a model) still renders the submit, and it still writes exactly what the player typed.
 *
 * The failure this catches: a rewrite that removes the submit for every entry (the BYOK lane would
 * lose its only save control), or one that leaves it for the environment entry (a record written for
 * a channel whose endpoint this player does not have).
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

/** The Host's own environment-managed entry: no setup field, its endpoint and key in this machine's env. */
const OPERATOR = {
  providerId: "cpa-oai",
  label: "Operator gateway",
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

/** A bring-your-own-key entry: the player's own account, so the key and the model are theirs to state. */
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

const apiKey = "sk-byok-key-for-deepseek";
const modelId = "deepseek-v4.1-flash";

/** The escape hatch: the player names the endpoint and the API shape their own server speaks. */
const ESCAPE_HATCH = {
  providerId: "openai-compatible",
  label: "OpenAI-compatible endpoint",
  setupFields: ["baseUrl", "apiShape", "apiKey", "modelId", "apiKeyRequired"],
  allowedPlayerModels: [],
  escapeHatch: true,
  environmentManaged: false,
};

/**
 * Every route the composed shell and the Settings panels read, with the connection write recorded.
 *
 * `providers` is the catalogue THIS mount publishes: the player's own default offer (no environment
 * entry) and the developer-switch offer (with it) are two mounts, because the picker's contents are
 * the Host's projection and not something a test may assume.
 */
async function stubRoutes(
  page: Page,
  options: Readonly<{ providers: readonly unknown[]; locale?: "en" | "zh-CN" }>,
): Promise<{ writes: Array<{ method: string; body: unknown }> }> {
  if (options.locale !== undefined)
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), options.locale);
  const writes: Array<{ method: string; body: unknown }> = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 3, active: null, connections: [], providers: options.providers })),
  );
  await page.route("**/api/tavern/v1/settings/connections", async (route) => {
    writes.push({ method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill(
      json200({ apiVersion: 1, revision: 4, active: null, connections: [], providers: options.providers }),
    );
  });
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
  return { writes };
}

const SETTINGS_ENTRY = { en: "Settings", "zh-CN": "设置" } as const;

/** Settings, with the connection group's read resolved. */
async function openSettings(page: Page, locale: "en" | "zh-CN" = "en"): Promise<void> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: SETTINGS_ENTRY[locale], exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface.locator("[data-connection-form]")).toBeVisible();
  await expect(surface.locator("#connection-provider")).toBeVisible();
}

/**
 * Every control inside the connection form, named, with the one fact this spec is about: whether
 * pressing it writes a connection record. The picker is a choice, not a write; a submit is a write.
 */
async function readControls(page: Page) {
  return await page.getByTestId("settings-surface").locator("[data-connection-form]").evaluate((node) => {
    const controls = [
      ...node.querySelectorAll<HTMLElement>("select, input, textarea, button"),
    ].map((control) => ({
      id: control.id === "" ? control.tagName.toLowerCase() : control.id,
      tag: control.tagName.toLowerCase(),
      type: control.getAttribute("type"),
      name: (control.textContent ?? "").trim() || control.getAttribute("placeholder") || "",
      disabled: "disabled" in control ? (control as HTMLButtonElement).disabled : false,
      writes: control.tagName.toLowerCase() === "button" && control.getAttribute("type") === "submit",
    }));
    const state = node.querySelector<HTMLElement>("[data-connection-no-save]");
    return {
      selected: node.querySelector<HTMLSelectElement>("#connection-provider")?.value ?? "(no picker)",
      controls,
      writesSomething: controls.some((control) => control.writes),
      noSaveState: state === null ? null : (state.textContent ?? "").replace(/\s+/gu, " ").trim(),
    };
  });
}

test.describe("the connection form writes only what the player configured", () => {
  test("(a) the player's catalogue does not publish the environment-managed entry at all", async ({ page }) => {
    // The default offer is bring-your-own-key only, so the form a player meets has no
    // environment-managed choice to land on. Mounted with exactly the entries the Host's own
    // `playerOfferedProviders()` yields without the developer switch.
    await stubRoutes(page, { providers: [DEEPSEEK, ESCAPE_HATCH] });
    await openSettings(page);
    const reading = await readControls(page);
    console.log(`[connection-write/player-catalogue] ${JSON.stringify(reading)}`);

    const offered = await page
      .getByTestId("settings-surface")
      .locator("#connection-provider option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(offered, "the operator's own gateway is not one of the choices").not.toContain("cpa-oai");
    expect(reading.selected, "and the form does not land on it").not.toBe("cpa-oai");

    // Every entry a player CAN choose is one they fill in, so every one of them keeps its write.
    for (const entry of [DEEPSEEK, ESCAPE_HATCH]) {
      await page.getByTestId("settings-surface").locator("#connection-provider").selectOption(entry.providerId);
      const chosen = await readControls(page);
      expect(
        chosen.controls.filter((control) => control.writes).length,
        `${entry.providerId} keeps the submit that saves what the player types`,
      ).toBe(1);
      expect(chosen.noSaveState, `${entry.providerId} carries no nothing-to-save line`).toBeNull();
    }
  });

  test("(b) where the entry IS published (the developer switch), it presents no write - only the state", async ({
    page,
  }) => {
    // `GAMEBUDDY_OPERATOR_GATEWAY=1` puts the entry back in the picker, labelled as the developer
    // path it is. That is the one mount where the form can still be pointed at it, and it is the
    // measured defect: no field to fill, and a submit under it.
    const stubs = await stubRoutes(page, { providers: [OPERATOR, DEEPSEEK] });
    await openSettings(page);
    const form = page.getByTestId("settings-surface").locator("[data-connection-form]");
    await form.locator("#connection-provider").selectOption("cpa-oai");
    const reading = await readControls(page);
    console.log(`[connection-write/operator] ${JSON.stringify(reading)}`);

    expect(reading.selected, "this mount really does reach the environment-managed entry").toBe("cpa-oai");
    expect(reading.writesSomething, "it offers no control that writes a record").toBe(false);
    expect(
      reading.controls.filter((control) => control.writes).map((control) => control.name),
      "there is no submit at all, not a disabled one",
    ).toEqual([]);
    // The state stands where the action stood: the operator provides it, so there is nothing to save.
    expect(reading.noSaveState, "the section states the state in the submit's place").toBe(
      "Provided by the operator — nothing to save.",
    );

    // Nothing was written by mounting it, and the form cannot write: pressing Enter does not submit
    // a form that has no submitter either.
    await form.locator("#connection-provider").press("Enter");
    await page.waitForTimeout(150);
    expect(stubs.writes, "no connection record is written for a channel the player did not configure").toEqual([]);
  });

  test("(c) a bring-your-own-key entry presents the write, and it writes what the player typed", async ({ page }) => {
    const stubs = await stubRoutes(page, { providers: [OPERATOR, DEEPSEEK] });
    await openSettings(page);
    const form = page.getByTestId("settings-surface").locator("[data-connection-form]");

    await form.locator("#connection-provider").selectOption("deepseek");
    await expect(form.locator("#connection-api-key")).toBeVisible();
    await expect(form.locator("#connection-model-id")).toBeVisible();
    const reading = await readControls(page);
    console.log(`[connection-write/byok] ${JSON.stringify(reading)}`);

    expect(reading.selected, "the player's own choice wins").toBe("deepseek");
    expect(reading.writesSomething, "the entry that asks for a key and a model keeps its write").toBe(true);
    const submits = reading.controls.filter((control) => control.writes);
    expect(submits.map((control) => control.name), "one submit, named for what it does").toEqual(["Save connection"]);
    expect(submits[0]!.disabled, "and it is the player's to press").toBe(false);
    expect(reading.noSaveState, "the nothing-to-save line belongs to the other entry alone").toBeNull();

    await form.locator("#connection-api-key").fill(apiKey);
    await form.locator("#connection-model-id").fill(modelId);
    await form.getByRole("button", { name: "Save connection" }).click();

    await expect.poll(() => stubs.writes.length).toBe(1);
    expect(stubs.writes[0], "the write carries exactly the entry and the values the player supplied").toEqual({
      method: "POST",
      body: { apiVersion: 1, providerId: "deepseek", apiKey, modelId },
    });

    // And the two states are two states of ONE form: choosing back to the environment entry removes
    // the submit again, so neither rendering is a mount-time accident.
    await form.locator("#connection-provider").selectOption("cpa-oai");
    const back = await readControls(page);
    expect(back.writesSomething, "the operator entry has no write again").toBe(false);
    expect(back.noSaveState, "its state line is back with it").toBe("Provided by the operator — nothing to save.");
  });

  test("the two sentences are the catalogue's own, in both languages", async ({ page }) => {
    await stubRoutes(page, { providers: [OPERATOR, DEEPSEEK], locale: "zh-CN" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await openSettings(page, "zh-CN");
    const form = page.getByTestId("settings-surface").locator("[data-connection-form]");

    await form.locator("#connection-provider").selectOption("cpa-oai");
    const operator = await readControls(page);
    console.log(`[connection-write/zh-operator] ${JSON.stringify(operator)}`);
    expect(operator.writesSomething, "中文目录里，运营方的连接同样没有可写之处").toBe(false);
    expect(operator.noSaveState, "中文目录说明由运营方提供，无需保存").toBe("由运营方提供，无需保存。");

    await form.locator("#connection-provider").selectOption("deepseek");
    const byok = await readControls(page);
    console.log(`[connection-write/zh-byok] ${JSON.stringify(byok)}`);
    expect(
      byok.controls.filter((control) => control.writes).map((control) => control.name),
      "中文目录的自备密钥条目保留自己的保存控件",
    ).toEqual(["保存连接"]);
    expect(byok.noSaveState, "and it does not carry the other entry's state line").toBeNull();
  });
});
