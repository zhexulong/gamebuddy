import { expect, test, type Page } from "@playwright/test";

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

/**
 * The Game surface is one of the shell's peer surfaces (design/104 §2), so a
 * journey reaches it the way a player does: through the AppBar entry. Every
 * assertion about the panel stays a behavioural assertion about the panel - it
 * just has to be selected first.
 */
async function openGameDrawer(page: Page): Promise<void> {
  const surface = page.getByTestId("game-surface");
  // The selected surface restores itself from the URL, so this is "select if not
  // already selected": a journey that already has it shown (after a refresh)
  // does not click the entry again.
  if (await surface.isVisible()) return;
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(surface).toBeVisible();
}

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
  // The durable draft is not a resident block between the transcript and the
  // input: it prefills the composer's own field, and its verbs live in the
  // composer band (Composer.tsx).
  await expect(page.getByTestId("chat-surface").locator(".composer-textarea")).toHaveValue(draft.text);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("ConnectionNo game connection");
  await expect(panel).toContainText("CompatibilityNot checked yet");
  await expect(panel.getByText("North cabin")).toBeVisible();
  const confirmButton = panel.getByRole("button", { name: "Confirm cabin" });
  await confirmButton.dblclick();
  await expect(confirmButton).toBeDisabled();
  await expect(panel.getByText("Cabin request admitted. Waiting for the next game setup step.")).toBeVisible();
  expect(cabinConfirmRequests).toBe(1);
  await expect(panel).not.toContainText(cabinChoiceHandle);
  await expect(panel).not.toContainText("cabinId");
  await expect(panel).not.toContainText(/ready|connected/i);
  // The one-time boot token is gone and the profile marker is kept; the drawer
  // this journey opened is the URL's `panel` fact, which survives the reload
  // below and is what restores it (design/26 §7.2).
  await expect(page).toHaveURL(/#profile=composed-reference-game&panel=game$/);
  expect(bootstrapRequests).toBe(1);
  expect(tavernBootstrapRequests).toBe(0);
  expect(tavernStateRequests).toBe(0);

  await page.reload();
  // A reload restores the selected surface, so the conversation is not on screen yet.
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect.poll(() => composedStateRequests).toBe(1);
  // Back from it shows the same conversation the journey left; no second bootstrap
  // was redeemed to get there.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  expect(bootstrapRequests).toBe(1);
  expect(tavernBootstrapRequests).toBe(0);
  expect(tavernStateRequests).toBe(0);
  expect(draftRequests).toBe(2);
  expect(cabinReadRequests).toBe(2);
});

/**
 * The Game surface's read-only data disclosure.
 *
 * Reachability first: `game.instances.read` and `game.diagnostics.read` are
 * declared by `host/src/game-browser-contract/index.ts` (operation ids plus the
 * two command bodies) but have no route on the composed shell, no producer and
 * no result schema, so the only Host game data a browser can actually obtain is
 * the projection `game.state.read` serves. The disclosure renders exactly that,
 * collapsed, and says plainly that no diagnostics are published.
 *
 * The failures this catches: a disclosure that starts open (a debug box pushing
 * the panel's own facts down the surface), a body that is placeholder text
 * rather than the Host's own response (the assertions read fixture values this
 * test chose), and a dump that leaks a session secret (the CSRF token never
 * crosses into it).
 */
test("the Game data disclosure is closed by default and reveals the Host's own published projection", async ({ page }) => {
  const published = {
    ...game,
    game: {
      ...game.game,
      instance: { status: "running", gameTitle: "Stardew Valley", generation: 7 },
      connectionStatus: "active",
      actionAuthority: "active",
      capabilitySummary: { available: true, count: 42 },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: published }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);

  const disclosure = page.getByTestId("game-diagnostics-disclosure");
  await expect(disclosure).toBeVisible();
  // Closed by default: the dump is not part of the panel's reading order until
  // the player asks for it.
  expect(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);

  await disclosure.locator("summary").click();
  const dump = page.getByTestId("game-diagnostics-json");
  await expect(dump).toBeVisible();
  const text = (await dump.textContent()) ?? "";
  // The values are the Host's own, taken from this response: a hardcoded or
  // placeholder dump cannot carry the fixture values this test chose.
  expect(text).toContain('"generation": 7');
  expect(text).toContain('"count": 42');
  expect(text).toContain("Stardew Valley");
  // Only the nested game projection crosses, so no session secret is renderable.
  expect(text).not.toContain(csrfToken);
  // The disclosure is the region's sibling, so the region still reads as
  // localized player outcomes and never as the Host's raw enum spellings.
  const panelText = await page.getByTestId("game-state-panel").innerText();
  expect(panelText).not.toContain("connected_idle");
});

test("composed profile renders game null honestly without exposing mutation controls", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: null }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("Game state is unavailable for this profile.");
  await expect(panel.locator("button, input, textarea, select, form")).toHaveCount(0);
  // Nothing is published, so the read-only disclosure says so instead of
  // rendering an empty box.
  await expect(page.getByTestId("game-diagnostics-disclosure")).toContainText(
    "No game data is published for this profile",
  );
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
  // The root was malformed, so this is an internal error and the presentation says
  // so, naming the code the client actually got. It must not claim a reconciliation
  // conflict: that wording sent the reader after a consistency fault that was not
  // the fault.
  await expect(page.getByRole("alert")).toContainText(
    "GameBuddy reported an internal error (code invalid_composed_root).",
  );
  await expect(page.getByText("The chat state could not be safely reconciled.")).toHaveCount(0);
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
  await openGameDrawer(page);
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
  await openGameDrawer(page);
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
  await openGameDrawer(page);
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
  await openGameDrawer(page);
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
  await openGameDrawer(page);
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

test("Game setup projects Host-owned launch generation and launch rereads actual lifecycle state", async ({ page }) => {
  let setupRequests = 0;
  let launchRequests = 0;
  let stateReads = 0;
  const stagedGame = {
    ...game,
    game: {
      ...game.game,
      prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
      instance: { status: "none", gameTitle: null, generation: 1 },
    },
  };
  const launchingGame = {
    ...stagedGame,
    game: {
      ...stagedGame.game,
      instance: { status: "launching", gameTitle: "Stardew Valley", generation: 0 },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    setupRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/game/launch", async (route) => {
    launchRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedInstanceGeneration: 1,
    });
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    const state = stateReads === 1 ? stagedGame : launchingGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: state }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Set up Stardew Valley" }).click();
  await expect.poll(() => setupRequests).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  const launch = panel.getByRole("button", { name: "Play with companion" });
  await expect(launch).toBeVisible();
  await expect(panel).not.toContainText("generation: 1");
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
  await launch.dblclick();
  await expect.poll(() => launchRequests).toBe(1);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).toContainText("InstanceStardew Valley");
  await expect(launch).toHaveCount(0);
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
});

/**
 * The surfaces are peers (design/architecture/product-surfaces.md): neither owns
 * or interrupts the other. A Game operation's authoritative reread must depend
 * only on the Game projection, so a Chat draft revision that moves underneath it
 * - the player typing in the conversation, another tab, a background poll - can
 * never turn into a Game failure. Here the ONLY thing that moves between the
 * composed root and draft reads is Chat's draft: the Game projection is
 * unchanged and the setup command succeeds, so the operation must complete.
 */
test("Game setup ignores a Chat draft that moves between the composed state and draft reads", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  let draftReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 204, body: "" });
  });
  // The Game projection never moves: only the composed root's Game half is
  // served, exactly as it was, so any Game failure here can only come from Chat.
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  // The first read is the mount bootstrap, which legitimately reconciles the
  // nested Chat projection (revision 4). Every later read reports the Chat draft
  // the player moved to while the Game operation was in flight (revision 5).
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    const body = draftReads === 1 ? draft : { ...draft, revision: 5, text: "The player kept typing." };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  // The command was admitted and its authoritative Game reread converged.
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  // A Game reread never reads the Chat draft at all: the moved revision cannot
  // be observed by the Game path, so it cannot fail the Game operation.
  expect(draftReads).toBe(1);
  // The Game operation completed: no reconciliation problem was surfaced, and
  // the unchanged authoritative projection was applied (the control stays
  // offered and a later attempt is a fresh-key attempt, not a stuck replay).
  await expect(panel).not.toContainText("Game setup could not be verified");
  await expect(setup).toBeVisible();
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(draftReads).toBe(1);
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
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const gameStop = panel.getByRole("button", { name: "Stop game" });
  await expect(gameStop).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await gameStop.dblclick();
  await expect.poll(() => stopRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("ConnectionStopped");
  await expect(gameStop).toHaveCount(0);
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
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
  await openGameDrawer(page);
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
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("ConnectionConnection failed");
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
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const disconnect = panel.getByRole("button", { name: "Disconnect game" });
  await disconnect.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).toContainText("ConnectionConnection failed");
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
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const disconnect = panel.getByRole("button", { name: "Disconnect game" });
  await expect(disconnect).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await disconnect.dblclick();
  await expect.poll(() => disconnectRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("ConnectionNo game connection");
  await expect(disconnect).toHaveCount(0);
});

test("Game Resume is generation-bound and single-flight, rereads authoritative state, and renders no synthetic completion", async ({ page }) => {
  let resumeRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const resumedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "connected_idle" },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    resumeRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "attached" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: resumedGame }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/messages**", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await expect(resume).toBeVisible();
  await resume.dblclick();
  await expect.poll(() => resumeRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("ConnectionConnected");
  await expect(resume).toHaveCount(0);
  await expect(panel).not.toContainText("The game could not be resumed");
  await expect(panel).not.toContainText("accepted");
  await expect(panel).not.toContainText("generation: 1");
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  expect(tavernMutationRequests).toBe(0);
});

test("Game Resume stays in flight on an accepted admission while authoritative state stays disconnected", async ({ page }) => {
  let resumeRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "disconnected",
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    resumeRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "accepted" }) });
  });
  // The authoritative projection keeps returning the same-generation
  // attached/disconnected state: the accepted admission is never runtime
  // completion, so the bounded convergence rereads keep going.
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/messages**", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await expect(resume).toBeVisible();
  await resume.dblclick();
  await expect.poll(() => resumeRequests).toBe(1);
  // The accepted admission keeps the attempt visibly in flight and disabled.
  await expect(panel.getByRole("status")).toContainText("Resuming the game connection...");
  await expect(resume).toBeDisabled();
  // At least one authoritative reread confirms the projection is still the
  // same-generation attached/disconnected state rather than converged.
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(panel).toContainText("ConnectionDisconnected");
  // The Resume stays visibly in progress and disabled across the rereads, with
  // no synthetic success/accepted/completion text projected.
  await expect(panel.getByRole("status")).toContainText("Resuming the game connection...");
  await expect(resume).toBeDisabled();
  await expect(panel).not.toContainText("accepted");
  await expect(panel).not.toContainText("could not be resumed");
  await expect(panel).not.toContainText("ConnectionConnected");
  await page.waitForTimeout(100);
  expect(resumeRequests).toBe(1);
  // The transcript is the conversation surface, so reaching it means returning to
  // it: the Game surface is a peer, not an overlay over the transcript.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  expect(tavernMutationRequests).toBe(0);
  // The test returns while the bounded reread budget (60 x 500ms) still has
  // time left; page teardown cancels the outstanding reread timers.
});

test("unavailable Game Resume preserves its generation key for an idempotent exact player replay", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "failed",
    },
  };
  const keys: string[] = [];
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await resume.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("ConnectionConnection failed");
  await expect(panel).toContainText("could not be resumed right now");
  // One command, one control: the failed attempt hands the same generation-bound
  // retry over to the failure rollup, so `Resume game` is not offered a second
  // time beside its own recovery name.
  await expect(resume).toHaveCount(0);
  const retry = panel.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("could not be resumed right now");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});

test("stale-generation Game Resume rereads a newer attachment without mutating or failing it", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const newerGame = {
    ...attachedGame,
    game: { ...attachedGame.game, attachment: { status: "attached", generation: 2 } },
  };
  const keys: string[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      expect(command.expectedAttachmentGeneration).toBe(1);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_attachment_conflict" }) });
      return;
    }
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "attached" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: newerGame }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await resume.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).not.toContainText("The game could not be resumed");
  const newerResume = panel.getByRole("button", { name: "Resume game" });
  await newerResume.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(panel).not.toContainText("The game could not be resumed");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});

test("resume-phase syncing projection passes the browser gate, visualizes sync, and never claims connected or resumable", async ({ page }) => {
  const syncingGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "syncing",
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: syncingGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // The syncing resume-phase status passes the browser gate: the authoritative
  // projection renders instead of failing closed.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(panel).toContainText("ConnectionSyncing");
  await expect(panel.getByRole("status")).toContainText("Syncing the game connection...");
  // syncing is neither resumable nor connected, so no Resume/Stop control is
  // offered and the connected vocabulary is never claimed.
  await expect(panel.getByRole("button", { name: "Resume game" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Stop game" })).toHaveCount(0);
  await expect(panel).not.toContainText("connected_idle");
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
});
test("ready-actions-paused renders the Resume actions control and converges on the authoritative reopened projection", async ({ page }) => {
  let reopenRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  const pausedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
    },
  };
  const reopenedGame = {
    ...pausedGame,
    game: { ...pausedGame.game, actionAuthority: "active" },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/reopen", async (route) => {
    reopenRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "reopened" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: reopenedGame }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/messages**", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("ConnectionConnected");
  const reopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await expect(reopen).toBeVisible();
  await expect(panel.getByText("Game actions are paused.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await reopen.dblclick();
  await expect.poll(() => reopenRequests).toBe(1);
  // The strict `reopened` result is never projected as synthetic success; the
  // composed authoritative Game projection must converge to actionAuthority
  // active at the same attachment generation before the drawer updates.
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(1);
  await expect(reopen).toHaveCount(0);
  await expect(panel.getByText("Game actions are paused.")).toHaveCount(0);
  await expect(panel).not.toContainText("could not be resumed");
  await expect(panel).not.toContainText("reopened");
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  expect(tavernMutationRequests).toBe(0);
});

test("Resume actions stays hidden outside the ready-actions-paused projection", async ({ page }) => {
  const scenarios = [
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "connected_idle", actionAuthority: "active" }, connectionText: "Connected" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "connected_idle", actionAuthority: "unavailable" }, connectionText: "Connected" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "syncing", actionAuthority: "paused" }, connectionText: "Syncing…" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "reconnecting", actionAuthority: "paused" }, connectionText: "Reconnecting…" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "failed", actionAuthority: "paused" }, connectionText: "Connection failed" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "disconnected", actionAuthority: "paused" }, connectionText: "Disconnected" },
    { overrides: {}, connectionText: "No game connection" },
  ];
  let currentGame = game;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: currentGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    currentGame = { ...game, game: { ...game.game, ...scenario.overrides } };
    // A fresh query keeps every iteration a real document navigation: the app
    // strips the boot token from the hash on first mount, so fragment-only
    // gotos would skip the bootstrap fetch and replay the previous projection.
     await page.goto(`/?scenario=${scenarioIndex}#profile=composed-reference-game&boot=${token}`);
     await openGameDrawer(page);
     const panel = page.getByRole("region", { name: "Game state" });
    await expect(panel).toContainText(`Connection${scenario.connectionText}`);
    await expect(panel.getByRole("button", { name: "Resume actions", exact: true })).toHaveCount(0);
    await expect(panel.getByText("Game actions are paused.")).toHaveCount(0);
  }
});

test("failed Game reopen renders no synthetic success and preserves its generation key for an idempotent exact replay", async ({ page }) => {
  const pausedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
    },
  };
  const keys: string[] = [];
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/reopen", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const reopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await reopen.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  // Fail closed: the failure is presented, the authoritative paused projection
  // is retained, and no synthetic reopened success is ever projected.
  await expect(panel).toContainText("The game actions could not be resumed");
  await expect(panel.getByText("Game actions are paused.")).toBeVisible();
  await expect(panel).not.toContainText("reopened");
  await expect(reopen).toBeVisible();
  // A player retry replays the exact same idempotent envelope at the same
  // generation because no side effect or success was ever established.
  await reopen.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("The game actions could not be resumed");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});

test("stale-generation Game reopen rereads a newer attachment without mutating or failing it", async ({ page }) => {
  const pausedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
    },
  };
  const newerGame = {
    ...pausedGame,
    game: { ...pausedGame.game, attachment: { status: "attached", generation: 2 } },
  };
  const keys: string[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/reopen", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      expect(command.expectedAttachmentGeneration).toBe(1);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_attachment_conflict" }) });
      return;
    }
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "reopened" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: newerGame }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const reopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await reopen.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).not.toContainText("The game actions could not be resumed");
  // The newer attached generation stays paused and connected, so the drawer
  // keeps offering the exact generation-bound Reopen with a fresh key.
  const newerReopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await expect(newerReopen).toBeVisible();
  await newerReopen.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(panel).not.toContainText("The game actions could not be resumed");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});test("failed GAME Resume surface offers Retry, Cancel, and Start new game; Cancel pins the exact reconnect generation", async ({ page }) => {
  const failedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const cancelledGame = {
    ...failedGame,
    game: { ...failedGame.game, connectionStatus: "disconnected" },
  };
  const keys: string[] = [];
  let cancelRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/game/resume/cancel", async (route) => {
    cancelRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "cancelled" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    // After the cancellation the authoritative projection shows the same
    // armed generation as disconnected; the session stays resumable.
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: cancelledGame }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/messages**", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await resume.click();
  await expect(panel).toContainText("could not be resumed right now");
  const retry = panel.getByRole("button", { name: "Retry", exact: true });
  const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
  const startNew = panel.getByRole("button", { name: "Start new game" });
  await expect(retry).toBeVisible();
  await expect(cancel).toBeVisible();
  await expect(startNew).toBeVisible();
  await cancel.dblclick();
  await expect.poll(() => cancelRequests).toBe(1);
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(panel).toContainText("ConnectionDisconnected");
  // The cancelled epoch clears the failure surface: no stale Reopen, no
  // Retry/Cancel/Start rollup, no synthetic success text, and the session
  // stays resumable at the same armed generation.
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Start new game" })).toHaveCount(0);
  await expect(panel).not.toContainText("cancelled");
  await expect(panel).not.toContainText("could not be resumed");
  await expect(resume).toBeVisible();
  await page.waitForTimeout(50);
  expect(cancelRequests).toBe(1);
  expect(keys).toHaveLength(1);
  expect(tavernMutationRequests).toBe(0);
});

test("Start new game form submits the exact create command and converges on the authoritative ready-actions-paused projection", async ({ page }) => {
  const failedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const createdGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
      selectedWorld: "farm-2",
      selectedSave: "save-2",
    },
  };
  const sessionId = "S".repeat(32);
  const createKeys: string[] = [];
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/game/create", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; integrationId: string; continuityIdentityId: string | null };
    createKeys.push(command.idempotencyKey);
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(command).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      integrationId: "stardew",
      continuityIdentityId: "continuity-identity-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "attached", gameSessionId: sessionId }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    // Before the create is admitted the authoritative rereads keep returning
    // the failed surface; once the session is resumable the projection shows
    // the new ready-actions-paused attachment generation.
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: createKeys.length === 0 ? failedGame : createdGame }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/messages**", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Resume game" }).click();
  await expect(panel.getByRole("button", { name: "Start new game" })).toBeVisible();
  await panel.getByRole("button", { name: "Start new game" }).click();
  await expect(panel.getByText("Start a new game session")).toBeVisible();
  await expect(panel.locator("form")).toContainText("stardew");
  await expect(panel).not.toContainText(sessionId);
  const continuity = panel.getByLabel("Continuity binding");
  await continuity.fill("continuity-identity-1");
  const submit = panel.getByRole("button", { name: "Create", exact: true });
  await submit.dblclick();
  await expect.poll(() => createKeys.length).toBe(1);
  // The bounded authoritative rereads converge on the new ready-actions-paused
  // attachment: the paused projection is the sole runtime success, no
  // accepted/attached transport text and no session handle is projected.
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(panel.getByText("Start a new game session")).toHaveCount(0);
  await expect(panel.getByText("Game actions are paused.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Resume actions", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Start new game" })).toHaveCount(0);
  await expect(panel).not.toContainText("accepted");
  await expect(panel).not.toContainText("attached");
  await expect(panel).not.toContainText(sessionId);
  await expect(panel).not.toContainText("continuity-identity-1");
  await page.waitForTimeout(50);
  expect(createKeys).toHaveLength(1);
  expect(tavernMutationRequests).toBe(0);
});

test("Start new game fails closed on Create, never projects a session, and keeps a fresh per-attempt idempotency key", async ({ page }) => {
  const failedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const sessionId = "S".repeat(32);
  const keys: string[] = [];
  let createRequests = 0;
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/game/create", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    createRequests += 1;
    if (createRequests === 1) {
      // Fail closed with the null-handle unavailable outcome: no resumable
      // half-record was left behind, so a next attempt is a new attempt.
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable", gameSessionId: null }) });
      return;
    }
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Resume game" }).click();
  await expect(panel).toContainText("could not be resumed right now");
  await panel.getByRole("button", { name: "Start new game" }).click();
  const submit = panel.getByRole("button", { name: "Create", exact: true });
  await submit.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).toContainText("could not be created right now");
  // The form stays open and the failure surface survives: no session handle,
  // no ready projection, no synthetic success.
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start new game" })).toBeVisible();
  await expect(panel).not.toContainText("Game actions are paused.");
  await expect(panel).not.toContainText(sessionId);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(panel).toContainText("could not be created");
  await expect(panel).not.toContainText(sessionId);
  await page.waitForTimeout(50);
  expect(createRequests).toBe(2);
});

test("Retry, Cancel, and Start new game stay hidden outside the failed-resume surface", async ({ page }) => {
  const scenarios = [
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "connected_idle" }, connectionText: "Connected" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "failed" }, connectionText: "Connection failed" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "disconnected" }, connectionText: "Disconnected" },
    { overrides: { attachment: { status: "none", generation: 0 }, connectionStatus: "none" }, connectionText: "No game connection" },
  ];
  let currentGame = game;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: currentGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    currentGame = { ...game, game: { ...game.game, ...scenario.overrides } };
     await page.goto(`/?scenario=${scenarioIndex}#profile=composed-reference-game&boot=${token}`);
     await openGameDrawer(page);
     const panel = page.getByRole("region", { name: "Game state" });
    await expect(panel).toContainText(`Connection${scenario.connectionText}`);
    await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Start new game" })).toHaveCount(0);
    await expect(panel.locator("form")).toHaveCount(0);
  }
});

/**
 * The staged projection the Host really produces once the lifecycle owns a
 * staged Player Host (`game-browser-state-provider.test.ts` pins this exact
 * shape): prerequisites met, no instance yet, and the one expected generation.
 * It is the only wire signal that activation happened.
 */
const stagedGame = {
  ...game,
  game: {
    ...game.game,
    prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 1 },
  },
};

test("a first run activates the lifecycle with a fieldless POST before launch is ever offered", async ({ page }) => {
  let activationRequests = 0;
  let activationBody: string | null | undefined;
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", async (route) => {
    activationRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().headers()["content-type"]).toBe("application/json");
    activationBody = route.request().postData();
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      // The first authoritative reread after activation is the staged projection.
      body: JSON.stringify({ ...root, game: stagedGame }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // Before activation the coordinator owns no staged Player Host, so the exact
  // expected generation is absent and launch must not be on offer at all.
  await expect(panel.getByRole("button", { name: "Play with companion" })).toHaveCount(0);
  const activate = panel.getByRole("button", { name: "Enable companion play" });
  await expect(activate).toBeVisible();
  await activate.click();
  await expect.poll(() => activationRequests).toBe(1);
  // The route refuses any body with 409; the admission alone names the session.
  expect(activationBody).toBeNull();
  await expect.poll(() => stateReads).toBe(1);
  // 204 is the activation; the authoritative reread is what puts launch on offer.
  await expect(panel.getByRole("button", { name: "Play with companion" })).toBeVisible();
  await expect(activate).toHaveCount(0);
});

test("a launch refused as not staged names activation as the reason instead of an uncertain launch", async ({ page }) => {
  let launchRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: stagedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/launch", async (route) => {
    launchRequests += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "game_prerequisites_missing" }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: stagedGame }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Play with companion" }).click();
  await expect.poll(() => launchRequests).toBe(1);
  await expect(panel).toContainText("Companion play is not ready yet. Enable companion play, then try again.");
  await expect(panel).not.toContainText("The game launch result is uncertain");
});

test("an activation refusal stays a drawer fact with its own reason, and an unmounted seam says so", async ({ page }) => {
  const scenarios = [
    { refusal: { status: 409, code: "game_unavailable" }, expected: "Companion play could not be enabled" },
    // The shell answers 404 when the owner mounted no activation seam at all;
    // that is not the same thing as an activation that failed.
    { refusal: { status: 404, code: "not_found" }, expected: "This build cannot enable companion play" },
  ];
  let current = scenarios[0];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) =>
    route.fulfill({
      status: current.refusal.status,
      contentType: "application/json",
      body: JSON.stringify({ code: current.refusal.code }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    current = scenario;
     await page.goto(`/?activation=${scenarioIndex}#profile=composed-reference-game&boot=${token}`);
     await openGameDrawer(page);
     const panel = page.getByRole("region", { name: "Game state" });
    await panel.getByRole("button", { name: "Enable companion play" }).click();
    await expect(panel).toContainText(scenario.expected);
    // The refusal is a Game-surface fact; the conversation returns when the
    // player goes back to it.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
    await openGameDrawer(page);
    const panelAgain = page.getByRole("region", { name: "Game state" });
    await expect(panelAgain.getByRole("button", { name: "Enable companion play" })).toBeVisible();
  }
});

/**
 * The single contextual panel itself (design/26 §4.2, §7.2; design/104 §2):
 * the AppBar entry opens it, the URL names it while it is open, Browser Back
 * closes it before it leaves the chat, and a refresh restores it.
 */
test("the AppBar Game entry selects the Game surface, the URL names it, and Back returns to the conversation without dropping the draft", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // Closed until a player selects it: the Game surface is a peer of the
  // conversation, never an inline technical status block (design/104 §2).
  await expect(page.getByTestId("game-state-panel")).toHaveCount(0);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  const entry = page.getByRole("button", { name: "Game", exact: true });
  await expect(entry).toBeVisible();

  await entry.click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toBeVisible();
  // A peer surface, not a modal overlay: it takes the main region, it is a
  // region rather than a dialog, and nothing dims or covers the shell.
  await expect(surface).toHaveAttribute("role", "region");
  await expect(page.locator("[aria-modal='true']")).toHaveCount(0);
  await expect(page.locator(".composed-drawer-backdrop")).toHaveCount(0);
  // The panel keeps its frozen anchors inside the surface.
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toHaveAttribute("data-game-state", "available");
  await expect(page.getByRole("region", { name: "Game state" })).toBeVisible();
  // Selecting names the surface in the URL and moves focus into it.
  await expect(page).toHaveURL(/#profile=composed-reference-game&panel=game$/);
  await expect(surface.getByRole("heading", { name: "Game", exact: true })).toBeFocused();
  // A player reads localized outcomes, never a raw Host enum (design/104 §10).
  const panelText = await panel.innerText();
  expect(panelText).not.toContain("connected_idle");
  expect(panelText).not.toContain("unchecked");
  expect(panelText).not.toContain("not_configured");

  // Browser Back re-shows the surface the player came from; the conversation and
  // the draft are untouched, and no message is replayed.
  await page.goBack();
  await expect(surface).toHaveCount(0);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();

  // Escape returns to the conversation from any other surface.
  await entry.click();
  await expect(surface).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(surface).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
});

test("the selected surface is restored from the URL after a refresh and takes keyboard focus into itself", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  await page.reload();
  // Refresh restores the selected surface without touching the conversation it
  // replaced: going back shows the same chat and draft the player left.
  const surface = page.getByTestId("game-surface");
  await expect(surface).toBeVisible();
  await expect(page.getByTestId("game-state-panel")).toHaveAttribute("data-game-state", "available");
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();

  // Selecting a surface moves focus to its heading, and Tab then reaches the
  // surface's own controls: it is a peer region, not a modal trap, so the
  // keyboard path in is one-way and the way out is Escape or Browser Back.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(surface.getByRole("heading", { name: "Game", exact: true })).toBeFocused();
  let reachedSurfaceControl = false;
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => document.activeElement?.closest('[data-testid="game-surface"]') !== null);
    if (inside) reachedSurfaceControl = true;
  }
  expect(reachedSurfaceControl, "tabbing reaches the surface's own controls").toBe(true);

  await page.keyboard.press("Escape");
  await expect(surface).toHaveCount(0);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
});

test("the Game surface renders localized player outcomes in zh-CN with no English chrome", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.addInitScript(() => window.localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByRole("button", { name: "游戏", exact: true }).click();
  // The surface's own accessible name is the localized entry text; the fixture's
  // other regions (the game state region and the installation panel) are named
  // separately, so match this one by its test id.
  const localizedSurface = page.getByTestId("game-surface");
  await expect(localizedSurface).toBeVisible();
  await expect(localizedSurface).toHaveAccessibleName("游戏");
  const panel = page.getByTestId("game-state-panel");
  // Group vocabulary, fact labels and fact values all come from the zh-CN
  // catalog; the panel is not a mix of English chrome and Chinese content.
  await expect(panel).toContainText("连接尚未连接游戏");
  await expect(panel).toContainText("兼容性尚未检查");
  await expect(panel).toContainText("下一步");
  await expect(panel).toContainText("启用伙伴陪玩");
  await expect(panel).toContainText("当前会话");
  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/Game state|Connection|Compatibility|Not checked|unchecked|connected_idle/);
});

/**
 * The product's Memory surface is the management surface's own panel, not a
 * read-only lookalike: it authors through the frozen `memory.mutate` route and
 * shows only the durable read-back the Host returns.
 *
 * The two assertions below own the two ways this can silently regress:
 *
 * 1. "the product Memory surface authors the exact memory.mutate command and
 *    shows the Host read-back" fails if the surface never posts `memory.mutate`
 *    (the read-only stub the product shipped with), if it posts a command the
 *    frozen route would reject (no `expectedProjectionRevision` compare-and-swap,
 *    a wrong operation), if it posts it without the broker session's CSRF token,
 *    or if it renders a locally invented row instead of the Host's own title and
 *    handle for the written memory.
 * 2. "a rejected Memory mutation is reported, never shown as saved" fails if a
 *    refused write is optimistically rendered as a created memory (the surface
 *    must re-read the authority and then report the failure), and it also pins
 *    that the failure notice is player-visible.
 */
test("the product Memory surface authors through memory.mutate and shows the Host read-back, and reports a rejected write instead of showing it as saved", async ({ page }) => {
  const projectionRevision = `${"M".repeat(42)}A`;
  const nextProjectionRevision = `${"P".repeat(42)}A`;
  const memoryHandle = `${"N".repeat(42)}A`;
  const writtenContent = "The player keeps a spare watering can by the cabin door.";
  const refusedContent = "A memory the Host refused to write.";

  const writes: Array<{ body: unknown; csrf: string | undefined }> = [];
  let reads = 0;
  let memories: ReadonlyArray<Record<string, unknown>> = [];
  let refuseWrites = false;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/memory", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      reads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ apiVersion: 1, projectionRevision, memories }),
      });
      return;
    }
    writes.push({ body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
    if (refuseWrites) {
      // The management route's own mapping of a Memory projection conflict: a
      // safe 409 with no stale success projection.
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Memory projection conflict",
          status: 409,
          code: "state_reconciliation_required",
          requestId: nextProjectionRevision,
          retryable: false,
        }),
      });
      return;
    }
    // The validated mutation response IS the durable read-back: the row carries a
    // Host-chosen title and handle no local state could have guessed.
    memories = [
      {
        handle: memoryHandle,
        title: "Semantic memory",
        content: writtenContent,
        category: "semantic",
        status: "active",
        origin: "player",
        pinned: false,
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, projectionRevision: nextProjectionRevision, memories }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  // The surface reads the management route itself; the composed Chat projection
  // carries no Memory capability for it to hide behind.
  await expect(surface.locator("[data-memory-state=empty]")).toBeVisible();
  expect(reads).toBe(1);

  // Manual authoring is secondary now: it opens from the quiet button beneath
  // the notebook and then writes through the same `memory.mutate` route.
  await surface.locator("[data-memory-authoring-toggle]").click();
  await surface.getByRole("textbox", { name: "Memory content" }).fill(writtenContent);
  await surface.getByRole("button", { name: "Create", exact: true }).click();

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({
    apiVersion: 1,
    operation: "create",
    expectedProjectionRevision: projectionRevision,
    content: writtenContent,
  });
  expect(writes[0]?.csrf).toBe(csrfToken);
  // The row carries the Host's own opaque handle for the written memory, so a
  // locally invented row cannot pass this.
  await expect(surface.locator(`[data-memory-handle="${memoryHandle}"]`)).toBeVisible();
  await expect(surface.getByText(writtenContent, { exact: true })).toBeVisible();

  // A refresh re-reads the authority, and the written row is still the store's.
  await surface.getByRole("button", { name: "Refresh Memory" }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(surface.getByText(writtenContent, { exact: true })).toBeVisible();

  // A refused write is re-read and reported, never rendered as a written memory.
  refuseWrites = true;
  memories = [];
  await surface.getByRole("textbox", { name: "Memory content" }).fill(refusedContent);
  await surface.getByRole("button", { name: "Create", exact: true }).click();
  await expect(surface.getByRole("status")).toContainText("Operation failed.");
  await expect.poll(() => reads).toBe(3);
  await expect(surface.getByText(refusedContent, { exact: true })).toHaveCount(0);
  await expect(surface.locator("[data-memory-state=empty]")).toBeVisible();
});

/**
 * The Memory surface reads as the companion's notebook, not as a database form
 * (the owner's report: "我得像程序员填数据一样手动往里写记忆").
 *
 * The failure each assertion catches:
 *
 * 1. `explains the notebook while it is empty` - an empty Memory projection that
 *    paints a blank form (no historian card, no honest zero) is the reported
 *    defect; the card must say what the notebook is and that it fills from
 *    ordinary play even when the Host returns no rows.
 * 2. `counts exactly what the Host returned` - a fabricated or locally guessed
 *    number, or a count that ignores the mounted rows, fails; the card's number is
 *    compared to the two rows the route returned.
 * 3. `says the category in player words` - a badge that prints the contract's own
 *    member (`semantic`/`interaction`) or drops the label fails, and the surface's
 *    own text is asserted to contain neither member.
 * 4. `keeps manual authoring behind the quiet button` - a surface that either
 *    always shows the create form (a form, not a notebook) or hides authoring
 *    entirely fails; the textbox is absent until the toggle opens it.
 */
test("the Memory surface reads as the companion's notebook, with a real count and player-word badges", async ({ page }) => {
  const memoryRevision = "M".repeat(42) + "A";
  const semanticHandle = "N".repeat(42) + "A";
  const interactionHandle = "Q".repeat(42) + "A";

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  let memories: ReadonlyArray<Record<string, unknown>> = [];
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, projectionRevision: memoryRevision, memories }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();

  // 1. Zero memories still explains the notebook, with an honest zero.
  const notebook = surface.locator("[data-memory-notebook]");
  await expect(notebook).toBeVisible();
  await expect(notebook).toContainText("Your companion writes this down");
  await expect(notebook.locator("[data-memory-count]")).toHaveAttribute("data-memory-count", "0");
  await expect(notebook.locator("[data-memory-count]")).toContainText("Nothing written down yet");

  // 4. Authoring is secondary: it opens on demand and does not define the surface.
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toHaveCount(0);
  await surface.locator("[data-memory-authoring-toggle]").click();
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toBeVisible();

  // 2 + 3. Two rows, two life-flavoured badges, and a count that equals them.
  memories = [
    { handle: semanticHandle, title: "Semantic memory", content: "The farmer keeps a spare watering can by the door.", category: "semantic", status: "active", origin: "player", pinned: false },
    { handle: interactionHandle, title: "Interaction memory", content: "They shared a rainy afternoon by the sea.", category: "interaction", status: "active", origin: "companion", pinned: false },
  ];
  await surface.getByRole("button", { name: "Refresh Memory" }).click();
  const rows = surface.locator("[data-memory-state=ready] [role=listitem]");
  await expect(rows).toHaveCount(2);
  await expect(notebook.locator("[data-memory-count]")).toHaveAttribute("data-memory-count", "2");
  await expect(notebook.locator("[data-memory-count]")).toContainText("2 memories written down");

  const badges = surface.locator("[data-memory-category]");
  await expect(badges).toHaveCount(2);
  await expect(badges.first()).toHaveText("Things she keeps");
  await expect(badges.nth(1)).toHaveText("Times you shared");

  // The raw contract members never reach the player (design/104 §10).
  const text = await surface.innerText();
  expect(text).not.toMatch(/\bsemantic\b/iu);
  expect(text).not.toMatch(/\binteraction\b/iu);
});


/**
 * The product Settings surface's connection journey (design/28 §1, §5.1).
 *
 * The owner reported that Settings showed neither an API key field nor model
 * selection. This is the end-to-end proof over the frozen routes: the
 * OpenAI-compatible entry (the one catalog entry that declares `apiKey` and
 * `baseUrl`) creates a draft record whose credential is write-only, the
 * Host-owned probe is run, the now-ready record is activated, and the record's
 * own thinking-level control goes through `/model`. A catalog provider with a
 * real model dropdown is mounted alongside it, so both "API key" and "model
 * selection" are exercised rather than asserted from source alone.
 *
 * The credential assertion is the point of the test: the typed key must be sent
 * exactly once, and must never be readable from the document afterwards.
 */
test("the product Settings surface creates, tests and activates a connection whose API key never reaches the document", async ({ page }) => {
  const connectionId = "H".repeat(42) + "A";
  const baseUrl = "http://127.0.0.1:11434/v1";
  const apiKey = "sk-local-probe-secret-0001";
  const modelId = "qwen2.5-coder:7b";
  const escapeHatch = {
    providerId: "openai-compatible",
    label: "OpenAI-compatible",
    setupFields: ["apiKey", "baseUrl", "apiShape", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    environmentManaged: false,
  };
  const catalogProvider = {
    providerId: "openai",
    label: "OpenAI",
    setupFields: ["apiKey"],
    allowedPlayerModels: [
      { modelId: "gpt-4o", modelLabel: "GPT-4o", allowedThinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
      { modelId: "gpt-4o-mini", modelLabel: "GPT-4o mini", allowedThinkingLevels: ["low", "high"], defaultThinkingLevel: "low" },
    ],
    escapeHatch: false,
    environmentManaged: false,
  };

  const writes: Array<{ path: string; method: string; body: unknown; csrf: string | undefined }> = [];
  let recordCreated = false;
  let readiness: "configured" | "ready" = "configured";
  let active = false;
  let recordModelId = modelId;
  let recordThinkingLevel = "high";

  // The active selection is a narrower projection than a list row (it has no
  // `providerId`/`configured`/`active`/`allowedThinkingLevels`), and the client
  // validates it with an exact key set; emitting the row shape here is rejected.
  const activeRow = () => ({
    connectionId,
    label: escapeHatch.label,
    providerLabel: escapeHatch.label,
    modelId: recordModelId,
    modelLabel: recordModelId,
    thinkingLevel: recordThinkingLevel,
    readiness,
    baseUrl,
    failure: null,
    lastCheckedAtMs: null,
  });
  const connectionRow = () => ({
    connectionId,
    label: escapeHatch.label,
    providerId: escapeHatch.providerId,
    providerLabel: escapeHatch.label,
    configured: true,
    readiness,
    active,
    modelId: recordModelId,
    modelLabel: recordModelId,
    thinkingLevel: recordThinkingLevel,
    allowedThinkingLevels: ["low", "high"],
    baseUrl,
    failure: null,
    lastCheckedAtMs: null,
  });
  const connectionState = () => ({
    apiVersion: 1,
    revision: 1,
    active: active ? activeRow() : null,
    connections: recordCreated ? [connectionRow()] : [],
    providers: [escapeHatch, catalogProvider],
  });

  const record = (route: import("@playwright/test").Route): void => {
    writes.push({
      path: new URL(route.request().url()).pathname,
      method: route.request().method(),
      body: route.request().postDataJSON(),
      csrf: route.request().headers()["x-csrf-token"],
    });
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, locale: "en-US" }) }),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], defaultSelectable: true }) }),
  );
  // The read route is singular and the create route plural: the frozen contract,
  // and the reason each one has its own anchored pattern (the plural is a prefix
  // of the singularity, so an unanchored glob would let either serve the other).
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, async (route) => {
    record(route);
    recordCreated = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    record(route);
    readiness = "ready";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, connectionId, outcome: "ready", failure: null, state: connectionState() }),
    });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/activate$/, async (route) => {
    record(route);
    active = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/model$/, async (route) => {
    record(route);
    const command = route.request().postDataJSON() as { modelId: string; thinkingLevel: string };
    recordModelId = command.modelId;
    recordThinkingLevel = command.thinkingLevel;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  const panel = surface.locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  // The catalog entry really offers a model dropdown; the escape hatch offers
  // the API key and base URL the owner was missing. Both are reachable from the
  // one provider control.
  await panel.locator("#connection-provider").selectOption("openai");
  await expect(panel.locator("#connection-model")).toBeVisible();
  await expect(panel.locator("#connection-model option")).toHaveCount(2);
  await panel.locator("#connection-provider").selectOption("openai-compatible");
  await expect(panel.locator("#connection-api-key")).toBeVisible();
  await expect(panel.locator("#connection-base-url")).toBeVisible();
  await expect(panel.locator("#connection-model-id")).toBeVisible();

  await panel.locator("#connection-base-url").fill(baseUrl);
  await panel.locator("#connection-api-key").fill(apiKey);
  await panel.locator("#connection-model-id").fill(modelId);
  await panel.getByRole("button", { name: "Save connection" }).click();

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: "/api/tavern/v1/settings/connections",
    method: "POST",
    body: {
      apiVersion: 1,
      providerId: "openai-compatible",
      apiKey,
      baseUrl,
      apiShape: "openai-completions",
      modelId,
    },
    csrf: csrfToken,
  });
  // The credential is write-only: the request carried it once, and once the
  // durable save has cleared the field the document must carry no copy of it -
  // neither as markup (the controlled input reflects its value as an attribute)
  // nor as rendered text. The poll waits for React to apply the clear, then
  // holds the document to zero occurrences.
  const documentCarriesKey = async (): Promise<boolean> => {
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const text = await page.evaluate(() => document.body.innerText);
    return html.includes(apiKey) || text.includes(apiKey);
  };
  await expect(panel.locator("#connection-api-key")).toHaveValue("");
  await expect.poll(documentCarriesKey).toBe(false);

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/test`,
    method: "POST",
    body: { apiVersion: 1, expectedRevision: 1 },
    csrf: csrfToken,
  });
  await expect(panel.locator("[data-connection-row]")).toContainText("Ready");
  await expect.poll(documentCarriesKey).toBe(false);

  await panel.getByRole("button", { name: "Save and activate" }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/activate`,
    method: "POST",
    body: { apiVersion: 1, expectedRevision: 1 },
    csrf: csrfToken,
  });
  await expect(panel.locator("[data-connection-active-value]")).toHaveText("OpenAI-compatible");

  // The record's own model control is the `/model` route, not a second create.
  await panel.locator(`#connection-level-${connectionId}`).selectOption("low");
  await expect.poll(() => writes.length).toBe(4);
  expect(writes[3]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/model`,
    method: "POST",
    body: { apiVersion: 1, expectedRevision: 1, modelId, thinkingLevel: "low" },
    csrf: csrfToken,
  });
  // The whole journey - create, test, activate, model - never surfaces the key.
  await expect.poll(documentCarriesKey).toBe(false);
});


/**
 * ---------------------------------------------------------------------------
 * The Characters surface: the character domain and its world book in one place
 * ---------------------------------------------------------------------------
 *
 * These pin the owner's two standing complaints about this surface:
 *
 * 1. Importing a character card must be a file picker, not a staged review
 *    ceremony, and the result must be the Host's own read-back - never a local
 *    guess - with a refusal reported instead of shown as success.
 * 2. A character's card and its world book live in ONE place, so World Info is
 *    no longer a peer surface of the shell.
 */

const importIdHandle = `${"I".repeat(42)}A`;
const worldBookRevision = `${"W".repeat(42)}A`;

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * The GET routes the Characters surface reads once on mount: the identity list,
 * the persona, the scenario, the character's opening, its world book and the
 * durable import history.
 */
async function stubCharacterReads(
  page: Page,
  overrides: Readonly<{
    companions?: readonly Readonly<{ handle: string; name: string; isCurrent: boolean }>[];
  }> = {},
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: overrides.companions ?? [] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
}

/** The card decoder's report for a card with two lorebook entries, as the Host would stage it. */
const stagedCard = (): Record<string, unknown> => ({
  apiVersion: 1,
  importId: importIdHandle,
  name: "Nova",
  candidateRevision: 1,
  fields: [
    { field: "name", eligibility: "profile_eligible_after_explicit_review", chars: 4 },
    { field: "persona_core", eligibility: "profile_eligible_after_explicit_review", chars: 19 },
    { field: "worldbook_st-v3-1", eligibility: "candidate_only", chars: 30 },
    { field: "worldbook_st-v3-2", eligibility: "candidate_only", chars: 18 },
  ],
  dispositions: [
    { field: "character_book", classification: "accepted_typed", reason: "bounded_inert_candidate" },
    {
      field: "alternate_greetings",
      classification: "dropped_unsupported",
      reason: "executable_or_prompt_control_field",
    },
  ],
});

async function stubImportSuccess(page: Page): Promise<{
  imports: Array<Readonly<{ body: unknown; csrf: string | undefined }>>;
  reviews: Array<Readonly<{ body: unknown; csrf: string | undefined }>>;
  confirms: Array<Readonly<{ body: unknown; csrf: string | undefined }>>;
}> {
  const imports: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  const reviews: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  const confirms: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  await page.route("**/api/tavern/v1/imports", async (route) => {
    imports.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill(jsonOk(stagedCard()));
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, async (route) => {
    reviews.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        importId: importIdHandle,
        reviewedFields: ["name", "persona_core"],
        approvedAtMs: 1,
      }),
    );
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, async (route) => {
    confirms.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" }));
  });
  return { imports, reviews, confirms };
}

async function openCharactersSurface(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

async function chooseCardFile(page: Page, text: string): Promise<void> {
  await page.getByTestId("characters-surface").locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(text, "utf8"),
  });
}

/**
 * "choosing a card file imports it in one action and reports the Host's own
 * result" fails if the primary path is not a real file input (the owner's
 * complaint: a staged review ceremony instead of a picker), if choosing a file
 * does not post the file's own text as `character.import.stage`, if the review
 * is not the Host's own eligible field set, if confirm is not CSRF-bound, if
 * the notice claims a companion the Host never confirmed, or if the "could not
 * use" list is locally invented instead of read from the Host's dispositions.
 * It also pins that the paste path still produces the same durable result.
 */
test("choosing a character card file imports it in one action, and reports what the Host kept and could not use", async ({
  page,
}) => {
  const cardText = JSON.stringify({
    spec: "chara_card_v3",
    data: { name: "Nova", description: "A quiet astronomer." },
  });
  await stubCharacterReads(page);
  const { imports, reviews, confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  // The file picker is the primary path: the player chooses a file their own
  // browser reads; the card text is what the Host receives.
  await chooseCardFile(page, cardText);
  await expect.poll(() => confirms.length).toBe(1);

  expect(imports[0]?.body).toEqual({ apiVersion: 1, card: cardText });
  expect(imports[0]?.csrf).toBe(csrfToken);
  const reviewedFields = (body: unknown): unknown => (body as { reviewedFields?: unknown }).reviewedFields;
  expect(reviewedFields(reviews[0]?.body)).toEqual(["name", "persona_core"]);
  expect(reviews[0]?.csrf).toBe(csrfToken);
  expect(confirms[0]?.body).toEqual({ apiVersion: 1 });
  expect(confirms[0]?.csrf).toBe(csrfToken);

  const created = surface.locator("[data-card-import-result=created]");
  await expect(created).toContainText("Imported Nova.");
  await expect(created).toContainText("Kept 2 card fields.");
  await expect(created).toContainText("Could not use: alternate_greetings.");

  // The secondary paste path produces the same durable result as the picker.
  await surface.locator("[data-card-import] summary").click();
  await surface
    .getByRole("textbox", { name: "Paste card text" })
    .fill(JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } }));
  await surface.getByRole("button", { name: "Import card" }).click();
  await expect.poll(() => confirms.length).toBe(2);
  expect(reviewedFields(reviews[1]?.body)).toEqual(reviewedFields(reviews[0]?.body));
  expect(confirms[1]?.body).toEqual(confirms[0]?.body);
});

/**
 * "a card's lorebook entries and the character's world book live in one place"
 * fails if the imported lorebook entries are not surfaced on the character's
 * own view, if the world book is still a separate peer surface, or if World
 * Info remains an AppBar entry after it was folded into Characters.
 */
test("a card whose lorebook entries import produces them on the character's own view, where its world book also lives", async ({
  page,
}) => {
  const cardText = JSON.stringify({
    spec: "chara_card_v3",
    data: {
      name: "Nova",
      description: "A quiet astronomer.",
      character_book: {
        entries: [
          { comment: "Observatory", content: "The hilltop observatory is open at night.", constant: true },
          { comment: "Comet", content: "A comet is expected next week.", keys: ["comet"] },
        ],
      },
    },
  });
  await stubCharacterReads(page);
  const { confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await chooseCardFile(page, cardText);
  await expect.poll(() => confirms.length).toBe(1);
  await expect(surface.locator("[data-card-import-result=created]")).toContainText("Carries 2 lorebook entries.");

  // The world book is the character's own view on the same surface ...
  await expect(surface.locator("[data-world-book]")).toBeVisible();
  await expect(surface.locator("[data-world-book]")).toContainText("World book");
  // ... and it is no longer a peer surface of the shell.
  await expect(page.getByTestId("world-info-surface")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "World Info", exact: true })).toHaveCount(0);
});

/**
 * "an alternate opening is stored with the character" fails if a second opening
 * variant is dropped from the save, if the save is not a revision-CAS update of
 * the character's opening, or if the read-back does not carry both variants.
 * It is the honest local counterpart of the card's `alternate_greetings`, which
 * the Host decoder drops (see the field-mapping report).
 */
test("an alternate opening variant is stored with the character and read back with it", async ({ page }) => {
  await stubCharacterReads(page);
  let greeting: Record<string, unknown> = {
    apiVersion: 1,
    present: true,
    revision: 1,
    label: "Morning",
    variants: [{ label: "Default", text: "Good morning." }],
  };
  const saves: unknown[] = [];
  await page.route("**/api/tavern/v1/greeting", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonOk(greeting));
      return;
    }
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      label?: string;
      variants: readonly { label?: string; text: string }[];
    };
    saves.push(body);
    greeting = {
      apiVersion: 1,
      present: true,
      revision: body.expectedRevision + 1,
      label: body.label ?? null,
      variants: body.variants.map((variant) => ({ label: variant.label ?? null, text: variant.text })),
    };
    await route.fulfill(jsonOk(greeting));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await expect(surface.locator("#opening-variant-0-text")).toHaveValue("Good morning.");
  await surface.getByRole("button", { name: "Add opening" }).click();
  await surface.locator("#opening-variant-1-text").fill("Good evening, farmer.");
  await surface.getByRole("button", { name: "Save opening" }).click();

  await expect.poll(() => saves.length).toBe(1);
  expect((saves[0] as { expectedRevision: number }).expectedRevision).toBe(1);
  expect((saves[0] as { variants: unknown }).variants).toEqual([
    { label: "Default", text: "Good morning." },
    { text: "Good evening, farmer." },
  ]);
  await expect(surface.locator("#opening-variant-1-text")).toHaveValue("Good evening, farmer.");
});

/**
 * "a Host refusal is reported instead of shown as success" fails if a refused
 * confirm is optimistically rendered as a created companion, or if the failure
 * is swallowed. The import path must surface the closed failure and never a
 * success banner.
 */
test("a refused import is reported as a failure and never as a created companion", async ({ page }) => {
  const cardText = JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } });
  await stubCharacterReads(page);
  await page.route("**/api/tavern/v1/imports", (route) => route.fulfill(jsonOk(stagedCard())));
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        importId: importIdHandle,
        reviewedFields: ["name", "persona_core"],
        approvedAtMs: 1,
      }),
    ),
  );
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Card import rejected",
        status: 422,
        code: "st_card_import_rejected",
        requestId: importIdHandle,
        retryable: false,
      }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await chooseCardFile(page, cardText);
  await expect(surface.locator("[data-card-import-result=error]")).toContainText(
    "The card could not be imported.",
  );
  await expect(surface.locator("[data-card-import-result=created]")).toHaveCount(0);
});

/**
 * The conversation column's composition, which is the whole of reviewer point 1.
 *
 * The failures this catches, in order:
 *
 * 1. A resident form coming back into the reading flow. The conversation column
 *    must be the transcript and the composer band and nothing else, so the
 *    direct children of the surface's content are asserted by class: a
 *    `reference-draft-section` or a `surface-model-settings` inserted between
 *    them fails here, which is exactly the measured "首屏被挤压" regression.
 * 2. The durable draft silently stopping at the boundary. It must reach the
 *    composer's own field, so a draft that is read but never prefilled fails -
 *    and the same command (`PUT /api/tavern/v1/draft` under the mounted
 *    revision CAS) must still be what saving sends.
 * 3. The model settings becoming unreachable when they left the column. The
 *    popout must open the same controls and the column must still hold no form
 *    while it is open; closing must return focus to the control that opened it.
 */
test("the conversation column is the transcript and the composer, with the model settings as a popout", async ({ page }) => {
  const draftWrites: unknown[] = [];
  let draftState = { apiVersion: 1, revision: draft.revision, text: draft.text };
  // The composer's own enablement is a projection of the nested Chat snapshot:
  // `submitAvailable` needs the published `chat.submit` operation, exactly as a
  // real profile declares it (the reference profile composition publishes the
  // same record). The base `chat` fixture lists no operations, so the composer
  // renders disabled and a journey that must *type* has to publish the
  // operation rather than work around it.
  const submittable = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
    },
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(submittable) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(submittable) }),
  );
  await page.route("**/api/tavern/v1/draft", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draftState) });
      return;
    }
    draftWrites.push(route.request().postDataJSON());
    draftState =
      route.request().method() === "DELETE"
        ? { apiVersion: 1, revision: 6, text: null }
        : { apiVersion: 1, revision: 5, text: draft.text };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draftState) });
  });
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        recommendedModels: [
          {
            providerId: "cpa-oai",
            providerLabel: "CPA OAI",
            modelId: "deepseek-v4",
            modelLabel: "DeepSeek V4",
            allowedThinkingLevels: ["off", "medium", "high"],
            defaultThinkingLevel: "medium",
          },
        ],
      }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();

  // The reading flow is the transcript and the composer band, in that order.
  const content = chatSurface.locator(".surface-content > *");
  await expect(content).toHaveCount(2);
  await expect(content.nth(0)).toHaveClass(/timeline/);
  await expect(content.nth(1)).toHaveClass(/composer-section/);
  // Nothing in the conversation column is a form, and the only field in it is
  // the composer's own.
  await expect(chatSurface.locator("form")).toHaveCount(0);
  await expect(chatSurface.locator(".surface-model-settings")).toHaveCount(0);
  await expect(chatSurface.locator("input, select, textarea")).toHaveCount(1);

  // The draft reached the composer, and its verbs are in the composer band.
  const composer = chatSurface.locator(".composer-textarea");
  await expect(composer).toHaveValue(draft.text);
  const draftRow = chatSurface.locator(".composer-draft");
  await expect(draftRow).toBeVisible();
  await expect(draftRow).toContainText("Saved draft");

  // Saving sends the same command it always did: the composed field's text under
  // the mounted draft's revision CAS.
  await composer.fill("Edited in the composer.");
  await draftRow.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => draftWrites.length).toBe(1);
  expect(draftWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: 4,
    text: "Edited in the composer.",
  });

  // Discarding clears the field and takes its own row with it.
  await draftRow.getByRole("button", { name: "Discard", exact: true }).click();
  await expect.poll(() => draftWrites.length).toBe(2);
  expect(draftWrites[1]).toEqual({ apiVersion: 1, selectionGeneration: 1, expectedRevision: 5 });
  await expect(chatSurface.locator(".composer-draft")).toHaveCount(0);
  await expect(composer).toHaveValue("");

  // The model settings are one click away, over the conversation.
  const drawer = page.getByTestId("chat-model-drawer");
  const trigger = chatSurface.getByTestId("chat-model-trigger");
  await expect(drawer).toHaveCount(0);
  await expect(chatSurface.locator(".surface-model-settings")).toHaveCount(0);
  await trigger.click();
  const popout = page.getByRole("dialog", { name: "Chat model settings" });
  await expect(popout).toBeVisible();
  // The product's own drawer, under its frozen testid: the assertion is about
  // `chat-model-drawer`, not about the shared primitive's own tests.
  await expect(drawer).toBeVisible();
  await expect(popout.locator(".surface-model-settings")).toBeVisible();
  await expect(popout.getByLabel("Model ID")).toHaveValue("deepseek-v4");
  await expect(popout.getByLabel("Thinking level")).toHaveValue("medium");
  await expect(popout.getByRole("button", { name: "deepseek-v4" })).toBeVisible();
  // ...and the conversation column still carries no form while it is open.
  await expect(chatSurface.locator("input, select, textarea")).toHaveCount(1);

  // Escape closes this exact drawer and gives focus back to the button that
  // opened it. The failure this catches: a popout whose only way out is its
  // backdrop strands a keyboard player over the conversation, and focus
  // dropped on <body> makes the next Tab restart from the top of the shell.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(popout).toHaveCount(0);
  await expect(page.getByTestId("chat-model-trigger")).toBeFocused();
});

/**
 * The Memory surface's origin filter (reviewer point 4).
 *
 * The failure each assertion catches:
 *
 * 1. `narrows to one origin` - without the filter the panel renders every row
 *    in one mixed list, which is the reported "只能在混杂长列表里逐条肉眼查找": a
 *    player auditing what the companion remembered on its own has no way to
 *    ask. The assertion is on the rows actually rendered, not on a control
 *    being present, so a filter that is painted but not wired fails.
 * 2. `and back` - a filter that narrows but cannot be released strands the
 *    player in a slice of their own memory, so the return to All is asserted
 *    with the full row count - both by pressing the All chip and by pressing the
 *    chip that is currently pressed.
 */
test("the Memory surface narrows to one origin and back", async ({ page }) => {
  const playerMemoryHandle = `${"N".repeat(42)}A`;
  const companionMemoryHandle = `${"Q".repeat(42)}A`;
  const memoryRevision = `${"M".repeat(42)}A`;

  const memoryWrites: unknown[] = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/memory", (route) => {
    // The filter is presentation state over the projection the Host already
    // sent, so a filter click must issue no request at all; a write reaching
    // this route is recorded and refused instead of being answered.
    if (route.request().method() !== "GET") {
      memoryWrites.push(route.request().postDataJSON());
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        projectionRevision: memoryRevision,
        memories: [
          {
            handle: playerMemoryHandle,
            title: "Player memory",
            content: "You told her about the farm.",
            category: "semantic",
            status: "active",
            origin: "player",
            pinned: false,
          },
          {
            handle: companionMemoryHandle,
            title: "Companion memory",
            content: "She remembers the rainy afternoon.",
            category: "interaction",
            status: "active",
            origin: "companion",
            pinned: false,
          },
        ],
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  const rows = surface.locator("[data-memory-state=ready] [role=listitem]");
  await expect(rows).toHaveCount(2);

  const filter = surface.locator("[data-memory-filter-group]");
  await expect(filter).toBeVisible();
  // The group is named by the panel's heading, and the two origin chips reuse the
  // labels the rows themselves carry: the filter is the same split, said twice.
  await expect(filter).toHaveAccessibleName("Your companion's notebook");
  const chips = {
    all: filter.locator("[data-memory-filter=all]"),
    player: filter.locator("[data-memory-filter=player]"),
    companion: filter.locator("[data-memory-filter=companion]"),
  };
  await expect(chips.all).toHaveText("All");
  await expect(chips.player).toHaveText("I told her this");
  await expect(chips.companion).toHaveText("She remembers this");
  await expect(chips.all).toHaveAttribute("aria-pressed", "true");

  await chips.player.click();
  await expect(chips.player).toHaveAttribute("aria-pressed", "true");
  await expect(chips.all).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("[data-memory-origin]")).toHaveAttribute("data-memory-origin", "player");
  await expect(surface).not.toContainText("She remembers the rainy afternoon.");

  await chips.companion.click();
  await expect(chips.companion).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("[data-memory-origin]")).toHaveAttribute("data-memory-origin", "companion");
  await expect(surface).not.toContainText("You told her about the farm.");

  // The pressed chip releases itself: pressing it again clears back to All.
  await chips.companion.click();
  await expect(chips.all).toHaveAttribute("aria-pressed", "true");
  await expect(chips.companion).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(2);

  // ...and the All chip reaches the same place from a fresh selection.
  await chips.player.click();
  await expect(rows).toHaveCount(1);
  await chips.all.click();
  await expect(chips.all).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(2);
  // Nothing here mutates anything: the filter is presentation state over the
  // projection the Host already sent.
  expect(memoryWrites).toEqual([]);
});

/**
 * The mini-window floor (owner's item 3).
 *
 * GameBuddy is usually a 400-500 px strip floating beside Stardew Valley, and
 * the composed shell's AppBar carries six peer entries there. At 400 px that is
 * more control than bar, so the entries degrade to icons - while staying
 * *named* (an icon-only button whose only name is a hover tooltip has no name)
 * and while keeping the 44 px targets. The failures this catches, in the order
 * they would bite:
 *
 * 1. a bar that overflows its own window - the floating strip grows a sideways
 *    scrollbar and the conversation column is laid out against a width it does
 *    not have;
 * 2. a bar that "fits" by squeezing the entries under the touch floor or by
 *    pushing the last ones past the right edge, where the shell's own
 *    `overflow: hidden` makes them invisible *and* unreachable (each entry's
 *    rect is asserted against the window, because a bar can leak out of its
 *    window without the document ever scrolling);
 * 3. a bar that fits by clipping its own companion block to nothing, which is
 *    the layout misalignment the same item names - the monogram and the status
 *    dot have to fit, and the status word may only be retired deliberately (it
 *    is out of flow, so `role="status"` still announces it) rather than cut in
 *    half.
 */
test("the AppBar degrades to named icon entries in a 400px window without sideways scroll", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.setViewportSize({ width: 400, height: 720 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // The conversation surface is the one shown, so the strip is measured in the
  // state a player actually works in.
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();

  const measured = await page.evaluate(() => {
    const entries = [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")];
    const companion = document.querySelector<HTMLElement>(".app-bar-companion");
    const status = document.querySelector<HTMLElement>(".app-bar-status");
    return {
      viewport: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      companion: companion === null ? null : { clientWidth: companion.clientWidth, scrollWidth: companion.scrollWidth },
      statusDotVisible: status?.querySelector(".status-dot")?.getBoundingClientRect().width ?? 0,
      entries: entries.map((entry) => {
        const rect = entry.getBoundingClientRect();
        const label = entry.querySelector<HTMLElement>(".nav-label");
        return {
          name: entry.getAttribute("aria-label"),
          title: entry.getAttribute("title"),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          labelDisplay: label === null ? null : getComputedStyle(label).display,
        };
      }),
    };
  });

  // The document itself never scrolls sideways at 400 px (owner's assertion).
  expect(measured.documentScrollWidth).toBeLessThanOrEqual(measured.viewport);
  // Six peers are published for this profile: a bar that silently dropped one
  // would pass every check below while losing a whole surface.
  expect(measured.entries).toHaveLength(6);
  for (const entry of measured.entries) {
    expect(entry.name, "every icon-only entry keeps its accessible name").toBeTruthy();
    expect(entry.title).toBe(entry.name);
    expect(entry.labelDisplay, "the visible label is retired, the name is not").toBe("none");
    expect(entry.width).toBeGreaterThanOrEqual(44);
    expect(entry.height).toBeGreaterThanOrEqual(44);
    expect(entry.left).toBeGreaterThanOrEqual(0);
    expect(entry.right).toBeLessThanOrEqual(measured.viewport);
  }
  // The bar still says who is in it and what it is doing: the monogram and the
  // status dot are rendered, not clipped away.
  expect(measured.companion).not.toBeNull();
  expect(measured.companion?.scrollWidth).toBeLessThanOrEqual((measured.companion?.clientWidth ?? 0) + 1);
  expect(measured.statusDotVisible).toBeGreaterThan(0);
});

/**
 * Regeneration's own polling fallback, with the event stream genuinely absent.
 *
 * `regenerate` starts a real turn, so it is the same kind of mutation as
 * `submit` and must take the same path: publish the pending submission record
 * before the wire call. `startPolling`'s first tick returns for a session with
 * nothing pending - the guard that keeps every idle session from polling - so
 * without that record the fallback poll is dead on its first tick. With a
 * healthy event stream nobody notices; with no stream at all the transcript
 * never leaves the pre-regenerate variant and the turn never settles.
 *
 * The route-mocked setup is the spec's own, with one fact made explicit:
 * `eventStream: null` opens no stream, so the authoritative rereads the poll
 * makes are the only reader of the turn's terminal state. The `/state` route
 * keeps returning the turn-running projection until the poll's second read, so
 * the settled variant exists only after polling has advanced.
 */
const regenerationPlayerHandle = `${"P".repeat(42)}A`;
const regenerationCompanionHandle = `${"D".repeat(42)}A`;
const regenerationTurnHandle = `${"T".repeat(42)}A`;
const regenerationOldVariant = "The game projection is read-only.";
const regenerationNewVariant = "The projection is a reading, not the valley itself.";

function regenerationProjections(): {
  idleRoot: typeof root;
  runningRoot: typeof root;
  settledRoot: typeof root;
} {
  const idleOperations = [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ];
  const idleChat = {
    ...chat,
    operations: idleOperations,
    chat: {
      ...chat.chat,
      transcript: [
        { handle: regenerationPlayerHandle, role: "player", text: "Where are we?", locale: "und", order: 0, revision: 1 },
        { handle: regenerationCompanionHandle, role: "companion", text: regenerationOldVariant, locale: "und", order: 1, revision: 1 },
      ],
      turn: null,
    },
  };
  return {
    idleRoot: { ...root, chat: idleChat },
    // The accepted, still-running projection: the transcript is unchanged and
    // `chat.submit` is busy, exactly as the Host projects a live turn.
    runningRoot: {
      ...root,
      chat: {
        ...idleChat,
        operations: [{ ...idleOperations[0], availability: "busy" }],
        chat: {
          ...idleChat.chat,
          turn: { handle: regenerationTurnHandle, state: "running", projectionRevision: 1, canCancel: false },
        },
      },
    },
    // The terminal projection: the same companion message now carries the
    // regenerated variant, and the turn has settled.
    settledRoot: {
      ...root,
      chat: {
        ...idleChat,
        chat: {
          ...idleChat.chat,
          transcript: [
            idleChat.chat.transcript[0],
            { ...idleChat.chat.transcript[1], text: regenerationNewVariant },
          ],
          turn: { handle: regenerationTurnHandle, state: "completed", projectionRevision: 2, canCancel: false },
        },
      },
    },
  };
}

test("regeneration settles through the polling fallback with no event stream", async ({ page }) => {
  const { idleRoot, runningRoot, settledRoot } = regenerationProjections();
  let stateReads = 0;
  let statusReads = 0;
  let regenerateRequests = 0;
  const statusKeys: string[] = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(idleRoot) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/messages/regenerate", async (route) => {
    regenerateRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      selectionGeneration: 1,
      messageHandle: regenerationCompanionHandle,
    });
    // A real acceptance takes a moment; the busy presentation must be visible
    // across it, exactly as it is for a real round trip.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: runningRoot.chat.chat.transcript[1],
        turn: runningRoot.chat.chat.turn,
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    // The reread that immediately follows acceptance still sees the running
    // turn and the old variant; only the poll's later read sees the settled one.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stateReads >= 2 ? settledRoot : runningRoot),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    statusReads += 1;
    const query = route.request().postDataJSON() as { idempotencyKey: string; selectionGeneration: number };
    statusKeys.push(query.idempotencyKey);
    expect(query.selectionGeneration).toBe(1);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "terminal" }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const bubble = page.locator(`li[data-handle='${regenerationCompanionHandle}']`);
  await expect(bubble).toContainText(regenerationOldVariant);
  const composer = chatSurface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  await bubble.getByRole("button", { name: "Regenerate" }).click();
  // The mutation's own busy presentation lands on the exact bubble...
  await expect(bubble).toHaveAttribute("data-pending", "regenerate");
  await expect(bubble).not.toHaveAttribute("data-pending", "regenerate");
  // ...and the regenerated variant reaches the transcript on the polling
  // fallback alone: no stream is open, and the projection only carries it once
  // the poll has advanced past the accepted, still-running read.
  await expect(bubble).toContainText(regenerationNewVariant);
  // The turn-level busy presentation resolves with the same poll: `chat.submit`
  // comes back available and the composer re-enables.
  await expect(composer).toBeEnabled();
  expect(regenerateRequests).toBe(1);
  expect(stateReads).toBeGreaterThanOrEqual(2);
  expect(statusReads).toBeGreaterThanOrEqual(1);
  // Every status read is correlated by the one key the regenerate was sent
  // under - the pending record, not a second identity.
  expect(new Set(statusKeys).size).toBe(1);
});

/**
 * The invariant the fix must not weaken: a session with nothing pending does
 * not poll. That guard lives in `startPolling`'s first tick, and it is what
 * keeps an idle conversation - the overwhelmingly common state - from issuing a
 * status read and a full authoritative reread every second forever. This
 * journey sits on the idle conversation for longer than the poll's first delay
 * plus one interval and asserts that neither route was touched at all.
 */
test("an idle conversation with nothing pending never starts polling", async ({ page }) => {
  const { idleRoot } = regenerationProjections();
  let stateReads = 0;
  let statusReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(idleRoot) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(idleRoot) });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, disposition: "unknown" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(stateReads).toBe(0);
  expect(statusReads).toBe(0);
});

/**
 * The fallback poll's own budget, and the last thing it must do.
 *
 * `startPolling` is the only reader of a turn's terminal state when no event
 * stream is open. When it spends `MAX_POLL_ATTEMPTS` without an authoritative
 * settlement it used to just return, leaving `session.pending` set - and with it
 * `submitAvailable` false, so the input stayed disabled forever with no message.
 * The client's budget also expired before the Host's own 120 s admission
 * ceiling, so it abandoned a turn the Host still believed was running.
 *
 * The fixture holds the turn running and keeps answering the submission status
 * as non-terminal, so only the budget can end the poll. The clock is
 * virtualized, because the subject is the budget's shape, not 130 real seconds.
 */
test("a turn that never settles ends the poll with the composer usable and the failure reported", async ({ page }) => {
  test.setTimeout(120_000);
  const operations = [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ];
  const neverSettlingRoot = {
    ...root,
    chat: {
      ...chat,
      operations,
      chat: {
        ...chat.chat,
        transcript: [
          { handle: regenerationPlayerHandle, role: "player", text: "Where are we?", locale: "und", order: 0, revision: 1 },
          { handle: regenerationCompanionHandle, role: "companion", text: regenerationOldVariant, locale: "und", order: 1, revision: 1 },
        ],
        turn: { handle: regenerationTurnHandle, state: "running", projectionRevision: 1, canCancel: false },
      },
    },
  };
  let statusReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(neverSettlingRoot) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(neverSettlingRoot) }),
  );
  await page.route("**/api/tavern/v1/messages/regenerate", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: neverSettlingRoot.chat.chat.transcript[1],
        turn: neverSettlingRoot.chat.chat.turn,
      }),
    }),
  );
  // "Never answers" in the only sense that matters here: the status route never
  // reports a terminal disposition, so only the budget can end the poll.
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "pending" }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.clock.install();
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const composer = chatSurface.locator(".composer-textarea");
  const bubble = page.locator(`li[data-handle='${regenerationCompanionHandle}']`);
  await expect(composer).toBeEnabled();

  await bubble.getByRole("button", { name: "Regenerate" }).click();
  // The pending record is published before the wire call, so the input locks
  // immediately - and stays locked while the poll still has budget.
  await expect(composer).toBeDisabled();
  // Step the virtual clock one poll interval at a time, yielding to the real
  // event loop between ticks so each mocked round trip can settle.
  for (let tick = 0; tick < 200; tick += 1) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(10);
  }
  // Past the budget: the pending record is cleared, the failure is reported, and
  // the player can try again. The budget itself must outlast the Host's 120 s
  // ceiling, or the client would abandon a turn the Host still believes runs.
  await expect(composer).toBeEnabled();
  await expect(chatSurface).toContainText("The reply failed. You can try again.");
  expect(statusReads, "the poll budget outlasts the Host's 120 s ceiling").toBeGreaterThanOrEqual(121);
});
/**
 * The first draft (owner's item C).
 *
 * The failure this catches: Save/Discard used to render only when the Host
 * already held a durable draft, so the one case where a player most needs to
 * keep what they typed - a chat with no draft yet - offered no way to save it.
 * Four things are asserted, in the order they can go wrong:
 *
 * 1. with no draft and no text the row offers neither action at all;
 * 2. typing offers Save, and not Discard, which no draft exists to honour;
 * 3. activating it issues the same `draft.save` command the existing path
 *    issues, and what the surface then shows is the Host's read-back - the
 *    "saved" state and the revision the next command CASes on both come from
 *    the Host's answer, not from the click;
 * 4. a refused save is reported in the row and never reads as saved - the row
 *    is still there to say so, because a failure is what keeps it alive.
 */
test("a chat with no durable draft lets the player save the first one from the composer", async ({ page }) => {
  const draftWrites: Readonly<{ method: string; body: unknown }>[] = [];
  let snapshotDraft: Readonly<{ revision: number; present: boolean }> = { revision: 0, present: false };
  let durable: Readonly<{ apiVersion: number; revision: number; text: string | null }> = {
    apiVersion: 1,
    revision: 0,
    text: null,
  };
  let refuseNextSave = false;

  const submittable = {
    ...root,
    // `chat.submit` published, exactly as the reference profile declares it: the
    // composer's own enablement is a projection of the nested Chat snapshot, so
    // a journey that has to type publishes the operation rather than working
    // around a disabled field.
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
    },
  };
  // The nested Chat projection and the draft route are read together and
  // cross-checked (`rereadChat` fails closed when they disagree), so both sides
  // of the fixture move together.
  const composed = () => ({
    ...submittable,
    chat: { ...submittable.chat, chat: { ...submittable.chat.chat, draft: snapshotDraft } },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composed()) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composed()) }),
  );
  await page.route("**/api/tavern/v1/draft", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(durable) });
      return;
    }
    const body = route.request().postDataJSON() as { text?: string };
    draftWrites.push({ method: route.request().method(), body });
    if (refuseNextSave || route.request().method() === "DELETE") {
      // A refused save, and the authoritative re-read that follows it: the
      // durable draft the surface must take instead is older and empty.
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "chat_draft_revision_conflict" }) });
      durable = { apiVersion: 1, revision: 3, text: null };
      snapshotDraft = { revision: 3, present: false };
      return;
    }
    // The Host answers with its own revision, which is not the revision the
    // client asked under: only the read-back can be the surface's truth.
    durable = { apiVersion: 1, revision: 9, text: body.text ?? null };
    snapshotDraft = { revision: 9, present: durable.text !== null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(durable) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const composer = chatSurface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();
  const row = chatSurface.locator(".composer-draft");
  const save = row.getByRole("button", { name: "Save", exact: true });
  const discard = row.getByRole("button", { name: "Discard", exact: true });

  // 1. Nothing to save and nothing to discard: no row.
  await expect(row).toHaveCount(0);

  // 2. Typing offers Save and only Save.
  await composer.fill("A first draft.");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Unsaved draft");
  await expect(save).toBeVisible();
  await expect(discard).toHaveCount(0);

  // 3. The same command, under the revision the Host gave this mount.
  await save.click();
  await expect.poll(() => draftWrites.length).toBe(1);
  expect(draftWrites[0]).toEqual({
    method: "PUT",
    body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: 0, text: "A first draft." },
  });
  // The click itself cannot do this: `durable` comes from the Host's answer, so
  // "Saved draft", Discard and the success line all appear only because the
  // read-back was taken as the truth.
  await expect(row).toContainText("Saved draft");
  await expect(discard).toBeVisible();
  await expect(row.getByRole("status")).toContainText("Saved successfully.");

  // 4. A refused save is reported, and the row never claims it was saved. The
  // command carries revision 9 - the revision the Host answered with in step 3,
  // which no local rule could have derived from the 0 this mount started at.
  refuseNextSave = true;
  await composer.fill("A draft the Host will refuse.");
  await save.click();
  await expect.poll(() => draftWrites.length).toBe(2);
  expect(draftWrites[1]).toEqual({
    method: "PUT",
    body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: 9, text: "A draft the Host will refuse." },
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Unsaved draft");
  await expect(row.getByRole("status")).toContainText("Operation failed.");
  await expect(row).not.toContainText("Saved draft");
  await expect(discard).toHaveCount(0);
});

/**
 * The conversation's first screen: the card's own openings (owner's item 1).
 *
 * The owner looked at the first screen and found a void with one line in it -
 * "开启一段新的旅程" - and nothing a player could say first. The correction that
 * decides the content is explicit: the chips are the character card's own
 * opening lines ("首屏场景破冰胶囊应该按角色卡开场白来"), not reviewer-invented
 * starters. The card's opening material is real data - the companion's greeting
 * record carries its variants, and `PUT /api/tavern/v1/chat/opening` chooses
 * among them - so the chips are read from that record and each tap records the
 * opening *and* says it through the composer's one submit path.
 *
 * The failure each assertion catches, in order:
 *
 * 1. `reflects the card's own openings` - chips that carry reviewer prose
 *    (a generic "今天农场有什么要忙的") or a truncated variant label instead of
 *    the card's line fail; the visible chip text is compared to the greeting
 *    record, line for line.
 * 2. `records the opening through the Host's own route` - a chip that only
 *    fills the composer, or that holds the chosen variant locally, fails; the
 *    route body, the CSRF header and the target index are asserted.
 * 3. `says it through the one submit path` - a second composer or a second
 *    submit authority fails; the send is the composed `POST /messages` with the
 *    idempotency key, and the surface still holds exactly one textarea.
 * 4. `adopts the Host's read-back, never its own optimism` - a shell that
 *    appends the sent message itself fails; while the state route still reports
 *    an empty conversation, nothing is rendered, and the chips only leave once
 *    the Host's own projection carries the committed transcript.
 */
test("the first screen offers the card's own openings, and a tap says one and records it as the opening", async ({ page }) => {
  const openings = [
    { label: "Default", text: "The lantern over the porch is still lit." },
    { label: "Alternate 1", text: "Rain has been falling since dawn." },
  ];
  const openingVariantId = "V".repeat(42) + "A";
  const openedMessageHandle = "W".repeat(42) + "A";
  const playerMessageHandle = "X".repeat(42) + "A";
  const turnHandle = "Y".repeat(42) + "A";

  const emptyRoot = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      chat: {
        ...chat.chat,
        transcript: [],
        draft: { revision: 0, present: false },
      },
    },
  };

  /** The Host's projection, before and after its own opening commit. */
  let openingCommitted = false;
  const projection = () =>
    openingCommitted
      ? {
          ...emptyRoot,
          chat: {
            ...emptyRoot.chat,
            chat: {
              ...emptyRoot.chat.chat,
              transcript: [
                {
                  handle: openedMessageHandle,
                  role: "companion",
                  text: openings[1]!.text,
                  locale: "und",
                  order: 0,
                  revision: 1,
                  openingVariant: { variantId: openingVariantId, index: 1, count: 2, label: openings[1]!.label, locked: false },
                },
                { handle: playerMessageHandle, role: "player", text: openings[1]!.text, locale: "und", order: 1, revision: 1 },
              ],
              turn: { handle: turnHandle, state: "completed", projectionRevision: 1, canCancel: false },
            },
          },
        }
      : emptyRoot;

  const greetingReads: number[] = [];
  const openingCommits: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  const sends: Array<Readonly<{ body: unknown; csrf: string | undefined; idempotencyKey: string | undefined }>> = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(emptyRoot)),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads.push(1);
    return route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: openings }),
    );
  });
  await page.route("**/api/tavern/v1/chat/opening", async (route) => {
    openingCommits.push({
      body: route.request().postDataJSON(),
      csrf: route.request().headers()["x-csrf-token"],
    });
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        openingVariant: { variantId: openingVariantId, index: 1, count: 2, label: openings[1]!.label, locked: false },
      }),
    );
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sends.push({
      body: route.request().postDataJSON(),
      csrf: route.request().headers()["x-csrf-token"],
      idempotencyKey: route.request().headers()["idempotency-key"],
    });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: {
          handle: playerMessageHandle,
          role: "player",
          text: openings[1]!.text,
          locale: "und",
          order: 1,
          revision: 1,
        },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        disposition: "accepted",
        committedResult: {
          apiVersion: 1,
          disposition: "accepted",
          message: {
            handle: playerMessageHandle,
            role: "player",
            text: openings[1]!.text,
            locale: "und",
            order: 1,
            revision: 1,
          },
          turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
        },
      }),
    ),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-empty-anchor]")).toBeVisible();

  // 1. The chips are the greeting record's own variants, named by the card's line.
  const chips = surface.locator(".composer-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText(openings[0]!.text);
  await expect(chips.nth(1)).toHaveText(openings[1]!.text);
  await expect(surface.locator(".composer-chips-row")).toHaveAccessibleName("Openings");
  expect(greetingReads.length, "the card's opening record is read for the empty conversation").toBeGreaterThan(0);

  // Above the input, not in the reading flow, and a real 44 px target.
  const geometry = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".composer-chips-row");
    const chip = document.querySelector<HTMLElement>(".composer-chip");
    const input = document.querySelector<HTMLElement>(".composer-textarea");
    return {
      rowBottom: row === null ? -1 : row.getBoundingClientRect().bottom,
      chipHeight: chip === null ? 0 : chip.getBoundingClientRect().height,
      inputTop: input === null ? -1 : input.getBoundingClientRect().top,
    };
  });
  expect(geometry.rowBottom, "the chips sit above the input").toBeLessThanOrEqual(geometry.inputTop + 1);
  expect(geometry.chipHeight, "a chip clears the 44 px touch floor").toBeGreaterThanOrEqual(44);

  // The composer's own keys are untouched by the chips beside them.
  const composer = surface.locator(".composer-textarea");
  await composer.fill("kept");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("kept\n");
  await composer.fill("");

  await chips.nth(1).click();

  // 2 + 3. One tap: the Host's opening route with that variant's index, then the
  // composed send under the same CSRF and a fresh idempotency key.
  await expect.poll(() => openingCommits.length).toBe(1);
  await expect.poll(() => sends.length).toBe(1);
  expect(openingCommits[0]!.body).toEqual({ apiVersion: 1, selectionGeneration: 1, targetIndex: 1 });
  expect(openingCommits[0]!.csrf).toBe(csrfToken);
  expect(sends[0]!.body).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    text: openings[1]!.text,
    locale: "en",
    expectedDraftRevision: 0,
  });
  expect(sends[0]!.csrf).toBe(csrfToken);
  expect(sends[0]!.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
  await expect(surface.locator(".composer-textarea")).toHaveCount(1);

  // 4. The Host has not published the committed opening yet, so the surface still
  // paints the first screen's own zero state: no local echo of the line it sent,
  // and no second submit while the admitted turn is in flight.
  expect(openingCommitted, "the fixture has not published the opening yet").toBe(false);
  await expect(surface.locator(".message-list")).toHaveCount(0);
  await expect(surface.locator("[data-empty-anchor]")).toBeVisible();
  await expect(chips).toHaveCount(0);

  // The Host's own projection is the only thing that can move the screen on.
  openingCommitted = true;
  await expect(chips).toHaveCount(0, { timeout: 15_000 });
  await expect(surface.locator(".message-list > li")).toHaveCount(2);
  await expect(surface.locator(".message-bubble").first()).toContainText(openings[1]!.text);
});

/**
 * The first screen only: a conversation that has already started keeps its
 * openings out of the way, and the shell does not even read the card's record
 * for it. The failure this catches: chips that survive the first message (an
 * affordance offered where it can no longer mean anything), and a shell that
 * reads the greeting record on every chat - the read itself is asserted here,
 * not only the rendering.
 */
test("a conversation with a message offers no opening chips and does not read the card's record", async ({ page }) => {
  let greetingReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads += 1;
    return route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        label: "Initial Greeting",
        variants: [{ label: "Default", text: "The lantern over the porch is still lit." }],
      }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".message-list > li")).toHaveCount(1);
  await expect(surface.locator(".composer-chip")).toHaveCount(0);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);
  expect(greetingReads, "a started conversation asks for no opening material").toBe(0);
});

/**
 * The honest empty case: a card whose greeting record carries nothing (the state
 * the owner's own screenshot was taken in - "还没有保存开场白") offers no chip at
 * all, and the surface does not invent one. The failure this catches: fabricated
 * starters and a greeting read that never completes leaving the first screen
 * blank instead of falling back to the conversation's own zero state.
 */
test("a card with no opening material shows no chip and invents none", async ({ page }) => {
  const emptyRoot = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      chat: { ...chat.chat, transcript: [], draft: { revision: 0, present: false } },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(emptyRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(emptyRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface.locator("[data-empty-anchor]")).toBeVisible();
  await expect(surface.locator(".composer-chip")).toHaveCount(0);
  await expect(surface.locator(".composer-chips-row")).toHaveCount(0);
  // The first screen is still the conversation's own, with a usable composer.
  await expect(surface.locator(".composer-textarea")).toBeEnabled();
});
