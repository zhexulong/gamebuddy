/**
 * An untested connection says so, and says what to press.
 *
 * Measured on the build before this change: a player saves a key, and the saved row renders
 * `Configured, not tested` beside a disabled `Save and activate`. The only sentence explaining
 * that gate was the button's own `title` attribute - a tooltip, which a touch player never sees
 * and a keyboard player never reaches - so the panel state read as "activating is not available
 * right now" rather than "one step is missing". And the control that IS that step, `Test
 * connection`, sat in the same `.composer-actions` strip as `Save and activate` and `Remove`,
 * all three the same `.small-button`: three equally-weighted choices beside a greyed-out one.
 *
 * The order is deliberate and does not move here: activating an endpoint nothing has answered
 * from is how a broken provider becomes the active one. What moves is that the panel now states
 * the step and paints the control that performs it. The `title` is gone with it - one fact does
 * not need two spellings, and the visible sentence is the one every player can read.
 *
 * Testing and enabling became one act in `settings-connection-activates-on-a-passing-test.spec.ts`:
 * a probe that passes enables the record when nothing is active, so the third reading below is
 * about the two-connection state, where a probe on the second record leaves the first one active
 * and the row's sentence says so.
 *
 * The three readings below:
 *   (i)   untested (`configured`): the sentence is visible and names the outcome of testing, the
 *         disabled activate button is still disabled, and `Test connection` carries the primary
 *         treatment;
 *   (ii)  tested (`ready`): the sentence is gone and activation is enabled;
 *   (iii) a failed probe: the probe's own category and the same "test first" sentence stand
 *         together, because retesting is exactly what a failure calls for.
 *
 * Both catalogues are read, from their own sentences rather than from one translated string.
 */
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const connectionId = "F".repeat(42) + "A";
const apiKey = "sk-untested-key-0001";
const modelId = "deepseek-v4.1-flash";

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
    prerequisites: { status: "unknown", detectedGame: null },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { status: "not_measured", reason: "no_attached_runtime" },
    latestOutcome: "none",
  },
};

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: composedChat,
  game: composedGame,
};

const DEEPSEEK = {
  providerId: "deepseek",
  label: "DeepSeek",
  setupFields: ["apiKey", "modelId"],
  allowedPlayerModels: [
    {
      modelId,
      modelLabel: "DeepSeek V4.1 Flash",
      allowedThinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
    },
  ],
  escapeHatch: false,
  environmentManaged: false,
};

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

type Readiness = "configured" | "ready" | "failed";

/**
 * One saved connection whose readiness the probe moves, plus the routes the composed shell and
 * the Settings panels read. `probe` is the answer the Host's `/test` route gives, so a test
 * chooses whether the player's next press succeeds - and, because a passing probe enables the
 * record when nothing is active, the `/activate` route answers too and moves the document's own
 * active selection. `activated` counts the times the panel asked for it.
 */
async function stubRoutes(
  page: Page,
  options: Readonly<{ readiness: Readiness; probe: Readiness; locale?: "en" | "zh-CN"; anotherActive?: boolean }>,
): Promise<{ tests: () => number; activations: () => number }> {
  if (options.locale !== undefined)
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), options.locale);
  let readiness: Readiness = options.readiness;
  let tests = 0;
  let activations = 0;
  let active = options.anotherActive === true;

  const connectionState = () => ({
    apiVersion: 1,
    revision: 3,
    active: active
      ? {
          connectionId,
          label: `DeepSeek · ${modelId}`,
          providerLabel: "DeepSeek",
          modelId,
          modelLabel: "DeepSeek V4.1 Flash",
          thinkingLevel: "high",
          readiness,
          baseUrl: null,
          failure: null,
          lastCheckedAtMs: null,
        }
      : null,
    connections: [
      {
        connectionId,
        label: `DeepSeek · ${modelId}`,
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        configured: true,
        readiness,
        active,
        modelId,
        modelLabel: "DeepSeek V4.1 Flash",
        thinkingLevel: "high",
        allowedThinkingLevels: ["low", "high"],
        modelIds: null,
        baseUrl: null,
        failure: readiness === "failed" ? "unauthorized" : null,
        lastCheckedAtMs: null,
      },
    ],
    providers: [DEEPSEEK],
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill(json200(connectionState())),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    tests += 1;
    readiness = options.probe;
    await route.fulfill(
      json200({
        apiVersion: 1,
        connectionId,
        outcome: readiness === "ready" ? "ready" : "failed",
        failure: readiness === "failed" ? "unauthorized" : null,
        state: connectionState(),
      }),
    );
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/activate$/, async (route) => {
    activations += 1;
    active = true;
    await route.fulfill(json200(connectionState()));
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
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  return { tests: () => tests, activations: () => activations };
}

const SETTINGS_ENTRY = { en: "Settings", "zh-CN": "设置" } as const;

/**
 * The saved row, read whole: the sentence that explains the gate, whether it is visible, the
 * disabled state of both controls, and which control the panel decided is the next action.
 *
 * The primary treatment is read off `classList`, and its own painted background is read from the
 * same element in the same run - a class that exists but paints nothing would be a claim rather
 * than an affordance.
 */
async function readRow(page: Page, locale: "en" | "zh-CN" = "en") {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: SETTINGS_ENTRY[locale], exact: true }).click();
  await expect(page.getByTestId("settings-surface").locator("[data-connection-row]")).toBeVisible();
  return await page.getByTestId("settings-surface").locator("[data-connection-row]").evaluate((row) => {
    const step = row.querySelector<HTMLElement>("[data-connection-untested]");
    const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
    const describe = (button: HTMLButtonElement | null) =>
      button === null
        ? null
        : {
            label: (button.textContent ?? "").trim(),
            disabled: button.disabled,
            primary: button.classList.contains("primary"),
            background: getComputedStyle(button).backgroundColor,
            title: button.getAttribute("title"),
          };
    return {
      step: step === null ? null : (step.textContent ?? "").replace(/\s+/gu, " ").trim(),
      stepVisible: step !== null && step.getClientRects().length > 0,
      // The readiness value is the `dd` of the row that the catalogue's `connectionReadiness`
      // `dt` names. Reading the first `dd` in the row returns the provider label, which would
      // make this assertion say nothing about state; matching one hardcoded word would make it
      // say nothing in the other language.
      readiness: (() => {
        const labels = ["readiness", "状态"];
        for (const term of row.querySelectorAll("dt"))
          if (labels.includes((term.textContent ?? "").trim().toLowerCase()))
            return (term.nextElementSibling?.textContent ?? "").trim();
        return "(no readiness row)";
      })(),
      buttons: buttons.map((button) => (button.textContent ?? "").trim()),
      // The two controls this spec is about, found by the label this catalogue gives them.
      testControl: describe(buttons.find((button) => (button.textContent ?? "").trim().toLowerCase().includes("test") || (button.textContent ?? "").trim().includes("测试")) ?? null),
      activateControl: describe(
        buttons.find((button) => {
          const text = (button.textContent ?? "").trim();
          return text === "Save and activate" || text === "保存并启用";
        }) ?? null,
      ),
      namedSample: describe(buttons.find((button) => !button.classList.contains("primary") && !button.disabled) ?? null),
    };
  });
}

test.describe("an untested connection states the step it still needs", () => {
  test("(i) configured: the sentence is visible, activation stays shut, and the test control is the one pointed at", async ({
    page,
  }) => {
    await stubRoutes(page, { readiness: "configured", probe: "ready" });
    const reading = await readRow(page);
    console.log(`[connection-untested/configured] ${JSON.stringify(reading)}`);

    // The sentence the player never had: visible text, not a tooltip, and it names what the press
    // will achieve rather than only what it is.
    expect(reading.step, "the row states what testing achieves").toBe(
      "Test the connection. If it passes, it becomes the active connection and the next message you send uses it.",
    );
    expect(reading.stepVisible, "and it is rendered text, not a title attribute").toBe(true);
    expect(reading.readiness, "beside the readiness fact it explains").toContain("Configured, not tested");

    // The gate itself does not move: activation is still the probe's to unlock.
    expect(reading.activateControl?.disabled, "an endpoint nothing answered from still cannot be activated").toBe(true);
    // The tip that used to stand in for the sentence is gone - one fact, one spelling.
    expect(reading.activateControl?.title, "the tooltip is not kept beside the visible sentence").toBeNull();

    // ...and the control that performs the missing step is the one painted as the next action.
    expect(reading.testControl?.primary, "the test control is the row's next action").toBe(true);
    expect(reading.activateControl?.primary, "and the shut control is not").toBe(false);
    expect(reading.testControl?.background, "the primary treatment actually paints").not.toBe(
      reading.namedSample?.background,
    );
  });

  test("(ii) ready: one press is the whole journey, so the sentence goes and the record is active", async ({ page }) => {
    const stubs = await stubRoutes(page, { readiness: "configured", probe: "ready" });
    const before = await readRow(page);
    expect(before.step, "the untested state speaks first").not.toBeNull();

    // Press the control the panel just pointed at, and only that one.
    await page
      .getByTestId("settings-surface")
      .locator("[data-connection-row] button.primary")
      .click();
    await expect.poll(stubs.tests).toBe(1);
    // The route answering is not the panel re-rendering: the row states its own readiness, so wait for that rather than for the
    // request, then read a settled DOM.
    await expect(page.getByTestId("settings-surface").locator("[data-connection-row]")).toHaveAttribute(
      "data-readiness",
      "ready",
    );

    const after = await page.getByTestId("settings-surface").locator("[data-connection-row]").evaluate((row) => {
      const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
      return {
        step: row.querySelector("[data-connection-untested]") === null,
        testPrimary:
          buttons.find((button) => (button.textContent ?? "").trim() === "Test connection")?.classList.contains("primary") ??
          null,
        activateDisabled:
          buttons.find((button) => (button.textContent ?? "").trim() === "Save and activate")?.disabled ?? null,
      };
    });
    console.log(`[connection-untested/after-test] ${JSON.stringify(after)}`);

    expect(after.step, "a tested connection no longer needs the sentence").toBe(true);
    // The second half of the press: the Host's own `ready` is what the panel asked activation on,
    // so the player never meets a "ready but not enabled" row they must enable themselves.
    expect(stubs.activations(), "one press asked for the enabling too").toBe(1);
    await expect(page.getByTestId("settings-surface").locator("[data-connection-active-value]")).toHaveText(
      `DeepSeek · ${modelId}`,
    );
    expect(after.testPrimary, "the step just done is no longer painted as the next one").toBe(false);
    expect(after.activateDisabled, "and the enable control is shut because the record is the active one").toBe(true);
  });

  test("(iii) a failed probe keeps both sentences: what happened, and what to do about it", async ({ page }) => {
    const stubs = await stubRoutes(page, { readiness: "configured", probe: "failed" });
    await readRow(page);
    await page.getByTestId("settings-surface").locator("[data-connection-row] button.primary").click();
    await expect.poll(stubs.tests).toBe(1);

    const row = page.getByTestId("settings-surface").locator("[data-connection-row]");
    // The probe's own closed category, and the same step sentence: retesting is the action.
    await expect(row.locator("[data-connection-failure]")).toHaveText("The endpoint rejected the credential.");
    await expect(row.locator("[data-connection-untested]")).toHaveText(
      "Test the connection. If it passes, it becomes the active connection and the next message you send uses it.",
    );
    await expect(row.getByRole("button", { name: "Save and activate" })).toBeDisabled();
  });

  test("both catalogues say it, from their own sentence and their own labels", async ({ page }) => {
    await stubRoutes(page, { readiness: "configured", probe: "ready", locale: "zh-CN" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const reading = await readRow(page, "zh-CN");
    console.log(`[connection-untested/zh] ${JSON.stringify(reading)}`);

    expect(reading.step, "中文句子说明测试通过后会自动启用").toBe(
      "测试连接。通过后会自动启用，你下一条消息就会用它发送。",
    );
    expect(reading.stepVisible, "而且这句话是正文，不是悬停提示").toBe(true);
    expect(reading.testControl?.primary, "测试是这一行的下一步").toBe(true);
    expect(reading.activateControl?.disabled, "未测试的连接依然不能启用").toBe(true);
  });
});
