import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const cabinChoiceHandle = "E".repeat(42) + "A";

const chat = {
  apiVersion: 1,
  build: {
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.chat-core.reference-pipeline",
  },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira" },
    title: "Reference Game Chat",
    transcript: [
      {
        handle: "D".repeat(42) + "A",
        role: "companion",
        text: "The game projection is read-only.",
        locale: "und",
        order: 0,
        revision: 1,
      },
    ],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const game = {
  apiVersion: 1,
  build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
  csrfToken,
  browserSession: { expiresAtMs },
  game: {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none",
  },
};

const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat,
  game,
};

const draft = { apiVersion: 1, revision: 4, text: "A durable delegated draft." };

test("composed profile redeems once, renders nested Chat and redacted Game, then reloads from composed state", async ({ page }) => {
  let bootstrapRequests = 0;
  let composedStateRequests = 0;
  let tavernBootstrapRequests = 0;
  let tavernStateRequests = 0;
  let draftRequests = 0;
  let cabinReadRequests = 0;
  let cabinConfirmRequests = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", async (route) => {
    bootstrapRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, bootstrapToken: token });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    composedStateRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", async (route) => {
    cabinReadRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        choices: [{ displayLabel: "North cabin", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", async (route) => {
    cabinConfirmRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    const body = route.request().postDataJSON();
    expect(body).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      choiceHandle: cabinChoiceHandle,
      confirmed: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "manifest_admitted" }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernBootstrapRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/state", async (route) => {
    tavernStateRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", async (route) => {
    draftRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page.getByText("The game projection is read-only.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Saved draft" })).toContainText(draft.text);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("Connectionnone");
  await expect(panel).toContainText("Compatibilityunchecked");
  await expect(panel.getByText("North cabin")).toBeVisible();
  const confirmButton = panel.getByRole("button", { name: "Confirm cabin" });
  await confirmButton.dblclick();
  await expect(confirmButton).toBeDisabled();
  await expect(panel.getByText("Cabin request admitted. Waiting for the next game setup step.")).toBeVisible();
  expect(cabinConfirmRequests).toBe(1);
  await expect(panel).not.toContainText(cabinChoiceHandle);
  await expect(panel).not.toContainText("cabinId");
  await expect(panel).not.toContainText(/ready|connected/i);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  expect(bootstrapRequests).toBe(1);
  expect(tavernBootstrapRequests).toBe(0);
  expect(tavernStateRequests).toBe(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect.poll(() => composedStateRequests).toBe(1);
  expect(bootstrapRequests).toBe(1);
  expect(tavernBootstrapRequests).toBe(0);
  expect(tavernStateRequests).toBe(0);
  expect(draftRequests).toBe(2);
  expect(cabinReadRequests).toBe(2);
});

test("composed profile renders game null honestly without exposing mutation controls", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: null }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("Game state is unavailable for this profile.");
  await expect(panel.locator("button, input, textarea, select, form")).toHaveCount(0);
});

test("composed profile fails closed on a malformed root", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...root, leakedAuthority: { path: "C:\\secret", token: "secret" } }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await expect(page.getByRole("alert")).toContainText("Unable to read chat");
  await expect(page.getByText("The chat state could not be safely reconciled.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Game state" })).toHaveCount(0);
});


test("uncertain Stardew handoff waits for manual recovery without refetch or retry", async ({ page }) => {
  let cabinReadRequests = 0;
  let cabinConfirmRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReadRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        choices: [{ displayLabel: "North cabin", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_manifest_handoff_uncertain" }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect(panel.getByText(/still awaiting verification/i)).toBeVisible();
  await page.waitForTimeout(200);
  expect(cabinReadRequests).toBe(1);
  expect(cabinConfirmRequests).toBe(1);
  await expect(panel.getByRole("button", { name: "Confirm cabin" })).toHaveCount(0);
});

test("stale Stardew handoff alone refetches choices and preserves one confirmation", async ({ page }) => {
  let cabinReadRequests = 0;
  let cabinConfirmRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReadRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        choices: [{ displayLabel: `North cabin ${cabinReadRequests}`, availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_choice_stale" }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect(panel.getByText("North cabin 2")).toBeVisible();
  expect(cabinReadRequests).toBe(2);
  expect(cabinConfirmRequests).toBe(1);
});
