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


test("cancelled Game setup rereads unknown and a later player retry uses a fresh key", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});

test("terminal Game setup failure permits only an authoritative fresh-key player retry", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  await expect(panel).toContainText("Game setup could not be verified");
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});

test("uncertain Game setup reread preserves the exact key for manual replay", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).toContainText("Game setup could not be verified");
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});

test("Game STOP is generation-bound, single-flight, rereads stopped, and remains independent from Chat Stop", async ({ page }) => {
  let stopRequests = 0;
  let stateRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const stoppedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "stopped" },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    stopRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: stoppedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  const gameStop = panel.getByRole("button", { name: "Stop game" });
  await expect(gameStop).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await gameStop.dblclick();
  await expect.poll(() => stopRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("Connectionstopped");
  await expect(gameStop).toHaveCount(0);
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
});

test("stale-generation Game STOP rereads a newer attachment without mutating it", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const newerGame = {
    ...attachedGame,
    game: { ...attachedGame.game, attachment: { status: "attached", generation: 2 } },
  };
  let stopRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    stopRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({ expectedAttachmentGeneration: 1 });
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_attachment_conflict" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: newerGame }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => stopRequests).toBe(1);
  await expect(panel.getByRole("button", { name: "Stop game" })).toBeVisible();
  await expect(panel).not.toContainText("The game stop result is uncertain");
  await page.waitForTimeout(50);
  expect(stopRequests).toBe(1);
});

test("uncertain Game STOP preserves its generation key and renders authoritative failed state without retry", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "connected_idle",
    },
  };
  const failedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "failed" },
  };
  const keys: string[] = [];
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("Connectionfailed");
  await expect(panel.getByRole("button", { name: "Stop game" })).toHaveCount(0);
  await expect(panel).toContainText("The game stop result is uncertain");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(1);
});

test("failed Game disconnect reread permits a fresh-key user retry", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const failedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "failed" },
  };
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/disconnect", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stateReads === 1 ? { ...root, game: failedGame } : root),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  const disconnect = panel.getByRole("button", { name: "Disconnect game" });
  await disconnect.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).toContainText("Connectionfailed");
  await disconnect.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(disconnect).toHaveCount(0);
});

test("attached Game drawer disconnect is distinct, double-activation is one command, and rereads none", async ({ page }) => {
  let disconnectRequests = 0;
  let stateRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/disconnect", async (route) => {
    disconnectRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  const disconnect = panel.getByRole("button", { name: "Disconnect game" });
  await expect(disconnect).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await disconnect.dblclick();
  await expect.poll(() => disconnectRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("Connectionnone");
  await expect(disconnect).toHaveCount(0);
});
