import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertAccessibilityBaseline,
  assertCriteriaCoverage,
  assertKeyboardReachable,
  assertLayoutFloor,
  assertQuiet,
  assertSectionsKeyboardReachable,
  resetCriteriaLedger,
  watchSurface,
} from "./frontend-criteria.js";

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
  // A peer surface, not a modal overlay: it takes the main region, it is a named
  // region rather than a dialog, and nothing dims or covers the shell. `region` is
  // the implicit role of the surface's named `<section>` (`SurfaceView`), which is
  // what names it for assistive technology alongside its heading - so the assertion
  // is the role rather than a `role` attribute (removed as redundant by `0f6b09ec`,
  // and `eslint.config.mjs` relies on the same implicit role).
  await expect(surface).toHaveRole("region");
  await expect(surface).toHaveAccessibleName("Game");
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
        body: JSON.stringify({ apiVersion: 1, projectionRevision, memories, chapters: [] }),
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
      body: JSON.stringify({ apiVersion: 1, projectionRevision: nextProjectionRevision, memories, chapters: [] }),
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
 *    paints a blank form (no notebook card, no honest zero) is the reported
 *    defect; the card must say what the notebook is and how it fills - the player
 *    asking her to keep something - even when the Host returns no rows. It must
 *    NOT promise a writer production does not run: promotion is gated off and the
 *    historian fold that would carry it fires at 65% of the usable window, so
 *    `memory-notebook-promise-gate.test.mjs` pins the wording and this spec pins
 *    what the mounted card actually renders.
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
      body: JSON.stringify({ apiVersion: 1, projectionRevision: memoryRevision, memories, chapters: [] }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();

  // 1. Zero memories still explains the notebook, with an honest zero - and it
  // states the route that exists (the player telling her), not an automatic
  // writer (see the file header and memory-notebook-promise-gate.test.mjs).
  const notebook = surface.locator("[data-memory-notebook]");
  await expect(notebook).toBeVisible();
  await expect(notebook).toContainText("This is her notebook");
  await expect(notebook).not.toContainText("writes this down");
  await expect(notebook).not.toContainText("fills in as you talk");
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
        chapters: [],
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
 * The mini-window floor (owner's item 3, corrected).
 *
 * GameBuddy is usually a 400-500 px strip floating beside Stardew Valley, and
 * the composed shell's AppBar carries six peer entries. At 400 px the rail was
 * about 300 px of a 400 px bar, so the companion block - the one thing that says
 * who the player is talking to - was squeezed to a bare "(". The correction:
 * fold the trailing peers behind one `More` affordance at ≤480 px, keep the
 * conversation and the game surface visible, and give the name its width back.
 *
 * The failure each assertion catches, in order:
 *
 * 1. a bar that overflows its own window - the floating strip grows a sideways
 *    scrollbar and the conversation column is laid out against a width it does
 *    not have;
 * 2. a name that "fits" by being clipped - the measurement is the name's own
 *    box, not the bar's, and the name must be whole (no ellipsis) and at least
 *    150 px wide, which is the width the fold frees;
 * 3. entries that fit by being dropped or shrunk below the touch floor - every
 *    peer is still in the bar, named, 44 px, and inside the window, and the four
 *    folded ones are reachable through the disclosure and really select their
 *    surface (a hidden button that exists only in the DOM is not reachable);
 * 4. a wide bar that changed - at 1440 px the bar must be exactly the row it
 *    was: six peers in order, labels visible, and the fold wrapper no box at all.
 */
test("the 400px strip folds its trailing peers behind one More and gives the companion's name back", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/chats", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, chats: [] }) }),
  );

  await page.setViewportSize({ width: 400, height: 720 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // The conversation surface is the one shown, so the strip is measured in the
  // state a player actually works in.
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();

  const narrow = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>(".app-bar-title");
    const trigger = document.querySelector<HTMLElement>(".app-bar-more-trigger");
    return {
      viewport: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      name: {
        text: (title?.textContent ?? "").trim(),
        clientWidth: title?.clientWidth ?? 0,
        scrollWidth: title?.scrollWidth ?? 0,
      },
      triggerWidth: trigger === null ? 0 : Math.round(trigger.getBoundingClientRect().width),
      entries: [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].map((entry) => {
        const box = entry.getBoundingClientRect();
        return {
          name: entry.getAttribute("aria-label"),
          title: entry.getAttribute("title"),
          visible: box.width > 0 && box.height > 0,
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
    };
  });

  // 1. The document itself never scrolls sideways at 400 px.
  expect(narrow.documentScrollWidth).toBeLessThanOrEqual(narrow.viewport);
  // 2. The name the strip exists for is whole, and has its 150 px back.
  expect(narrow.name.text, "the strip still names the companion").toBe("Mira");
  expect(narrow.name.scrollWidth, "the companion's name is rendered in full, not ellipsised").toBeLessThanOrEqual(
    narrow.name.clientWidth + 1,
  );
  expect(narrow.name.clientWidth, "the companion's name gets back 150 px or more").toBeGreaterThanOrEqual(150);
  // 3. Two peers and the disclosure are the strip's rail; every one is a real target.
  expect(narrow.entries.filter((entry) => entry.visible).map((entry) => entry.name)).toEqual([
    "Chat",
    "Game",
    "More",
  ]);
  // The other four are in the bar, not dropped: six peers plus the trigger.
  expect(narrow.entries).toHaveLength(7);
  expect(narrow.entries.filter((entry) => !entry.visible).map((entry) => entry.name)).toEqual([
    "Chats",
    "Characters",
    "Settings",
    "Memory",
  ]);
  for (const entry of narrow.entries.filter((candidate) => candidate.visible)) {
    expect(entry.name, "every entry keeps its accessible name").toBeTruthy();
    expect(entry.title).toBe(entry.name);
    expect(entry.width).toBeGreaterThanOrEqual(44);
    expect(entry.height).toBeGreaterThanOrEqual(44);
    expect(entry.left).toBeGreaterThanOrEqual(0);
    expect(entry.right).toBeLessThanOrEqual(narrow.viewport);
  }
  expect(narrow.triggerWidth).toBeGreaterThanOrEqual(44);
  console.log(
    `[appbar] 400px: name "${narrow.name.text}" ${narrow.name.clientWidth}px (scrollWidth ${narrow.name.scrollWidth}); rail ${narrow.entries
      .filter((entry) => entry.visible)
      .map((entry) => entry.name)
      .join(" > ")}; folded ${narrow.entries
      .filter((entry) => !entry.visible)
      .map((entry) => entry.name)
      .join(", ")}; document ${narrow.documentScrollWidth}/${narrow.viewport}`,
  );

  // The four folded peers are reachable, named, and the same size as the rail's.
  await page.getByRole("button", { name: "More", exact: true }).click();
  const panel = page.locator(".app-bar-more-menu");
  const folded = await panel.locator(".nav-button").evaluateAll((entries) =>
    entries.map((entry) => {
      const box = entry.getBoundingClientRect();
      return {
        name: entry.getAttribute("aria-label"),
        label: (entry.querySelector(".nav-label")?.textContent ?? "").trim(),
        width: Math.round(box.width),
        height: Math.round(box.height),
        right: Math.round(box.right),
      };
    }),
  );
  expect(folded.map((entry) => entry.name)).toEqual(["Chats", "Characters", "Settings", "Memory"]);
  for (const entry of folded) {
    expect(entry.label, "a folded entry reads by name inside the panel").toBe(entry.name);
    expect(entry.height).toBeGreaterThanOrEqual(44);
    expect(entry.right).toBeLessThanOrEqual(narrow.viewport);
  }

  // Escape closes the disclosure and gives focus back to the control that opened
  // it, without also stepping the shell back to the conversation behind it.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeFocused();

  // A folded entry really selects its surface - the whole point of keeping it.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await panel.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await expect(panel).toBeHidden();

  // 4. At 1440 px the bar is the row it always was: six peers, labels and all,
  // and the fold wrapper is not a box at all.
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(".app-bar-more");
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      wrapper: wrapper === null ? null : { width: Math.round(wrapper.getBoundingClientRect().width), display: getComputedStyle(wrapper).display },
      entries: [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].map((entry) => ({
        name: entry.getAttribute("aria-label"),
        labelDisplay: entry.querySelector<HTMLElement>(".nav-label") === null ? null : getComputedStyle(entry.querySelector<HTMLElement>(".nav-label")!).display,
        width: Math.round(entry.getBoundingClientRect().width),
        top: Math.round(entry.getBoundingClientRect().top),
        right: Math.round(entry.getBoundingClientRect().right),
      })),
    };
  });
  expect(wide.documentScrollWidth).toBeLessThanOrEqual(wide.viewport);
  // Six peers, in order, each with the width it has always had; the trigger is in
  // the DOM but has no box and no name in the accessibility tree.
  const widePeers = wide.entries.filter((entry) => entry.width > 0);
  expect(widePeers.map((entry) => entry.name)).toEqual([
    "Chat",
    "Game",
    "Chats",
    "Characters",
    "Settings",
    "Memory",
  ]);
  expect(new Set(widePeers.map((entry) => entry.top)).size, "the peers share one row").toBe(1);
  for (const entry of widePeers)
    expect(entry.labelDisplay, "a wide bar shows every peer's name").not.toBe("none");
  expect(wide.entries.find((entry) => entry.name === "More")?.width, "the trigger is not a box on a wide bar").toBe(0);
  expect(wide.wrapper?.display, "the fold wrapper is no box at all on a wide bar").toBe("contents");
  expect(wide.wrapper?.width).toBe(0);
  // The trigger does not exist where nothing folds.
  expect(await page.getByRole("button", { name: "More", exact: true }).count()).toBe(0);
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
 * The fallback poll is the *fallback*: while the event stream is connected and
 * delivering, it must not run at all.
 *
 * The measured defect: one turn opened two overlapping channels - the SSE stream
 * and the 250 ms/1000 ms poll - and every poll hop read `/draft` as well, so a
 * single regeneration cost a full authoritative `/state` read, a submission-status
 * read and a draft read per second for as long as the turn ran, on top of the
 * frames the stream was already delivering. The failure each direction catches:
 *
 *  - a healthy stream that still polls: the surface pays a second full
 *    authoritative reread every second for a turn the stream is delivering, and
 *    two channels race to settle the same turn;
 *  - a stream that fails with a poll that does not resume: the composer stays
 *    locked because nothing reads the turn's terminal state - the one job the
 *    fallback exists for.
 *
 * A submission-status read is the poll's exclusive signature: nothing else in
 * this shell performs one (`handleEvent` rereads `/state` and the draft; the chat
 * mutations reread the same pair). So `statusReads` is what tells a poll hop
 * apart from the stream's own work.
 */
test("a healthy event stream suspends the fallback poll, and a stream that fails resumes it", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${"E".repeat(42)}A`;
  const cursor = `${"F".repeat(42)}A`;
  const frameId = `${"H".repeat(42)}A`;
  const { idleRoot, runningRoot, settledRoot } = regenerationProjections();
  const streamed = (value: typeof idleRoot) => ({
    ...value,
    chat: { ...value.chat, eventStream: { epoch: streamEpoch, cursor } },
  });
  let stateReads = 0;
  let draftReads = 0;
  let statusReads = 0;
  let regenerateRequests = 0;
  // The authoritative read that first answers with the settled turn. Direction 1
  // settles on the stream's own reread; direction 2 settles on the recovery read
  // and then on the poll's hop, so the hop is the read that carries it.
  let settledFromRead = Number.POSITIVE_INFINITY;

  await page.addInitScript(() => {
    const state = window as unknown as {
      __instances: Array<{ onerror: ((event: unknown) => void) | null }>;
      __handlers: Array<Map<string, Array<(raw: unknown) => void>>>;
      __emit: (index: number, type: string, data: string, id: string) => void;
      __fail: (index: number) => void;
    };
    state.__instances = [];
    state.__handlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        void url;
        this.__index = state.__instances.length;
        state.__instances.push(this);
        state.__handlers.push(new Map());
      }
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__handlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__handlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        this.onerror = null;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      for (const handler of state.__handlers[index]?.get(type) ?? []) handler({ data, lastEventId: id, type });
    };
    state.__fail = (index) => {
      state.__instances[index]?.onerror?.(new Event("error"));
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(streamed(idleRoot))),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(streamed(stateReads >= settledFromRead ? settledRoot : runningRoot)));
  });
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill(jsonOk(draft));
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" }));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/messages/regenerate", async (route) => {
    regenerateRequests += 1;
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

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const composer = chatSurface.locator(".composer-textarea");
  const bubble = page.locator(`li[data-handle='${regenerationCompanionHandle}']`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __instances: unknown[] }).__instances.length)).toBe(1);

  // Direction 1: a live stream suspends the poll. The click's own reread is the
  // only authoritative read there is; the poll's first tick and a full interval
  // after it add nothing at all.
  settledFromRead = stateReads + 2;
  await bubble.getByRole("button", { name: "Regenerate" }).click();
  await expect.poll(() => regenerateRequests).toBe(1);
  await expect.poll(() => stateReads).toBeGreaterThan(0);
  await expect(composer).toBeDisabled();
  await page.waitForTimeout(2_500);
  // The measurement: every HTTP request this turn made under a live stream.
  console.log(
    `poll-measure: live stream, one turn -> state=${stateReads} draft=${draftReads} status=${statusReads}`,
  );
  expect({ stateReads, draftReads, statusReads }).toEqual({ stateReads: 1, draftReads: 2, statusReads: 0 });

  // The stream settles the turn itself: one frame, one authoritative reread, and
  // still no status read - so the settle came from the stream, not from a poll.
  const settledTurn = settledRoot.chat.chat.turn;
  await page.evaluate(
    (input: { data: string; id: string }) =>
      (window as unknown as { __emit: (index: number, type: string, data: string, id: string) => void }).__emit(
        0,
        "turn.state_changed",
        input.data,
        input.id,
      ),
    {
      data: JSON.stringify({
        apiVersion: 1,
        epoch: streamEpoch,
        sequence: 1,
        selectionGeneration: 1,
        eventType: "turn.state_changed",
        payload: settledTurn,
      }),
      id: frameId,
    },
  );
  await expect(bubble).toContainText(regenerationNewVariant);
  await expect(composer).toBeEnabled();
  expect(statusReads).toBe(0);
  expect(stateReads).toBe(2);

  // Direction 2: the stream fails. The next turn is admitted under the same
  // suspension, and once the stream is gone it is the poll that has to settle the
  // turn - the recovery read still sees the running projection, and only the
  // poll's own hop sees the settled one.
  settledFromRead = stateReads + 3;
  await bubble.getByRole("button", { name: "Regenerate" }).click();
  await expect.poll(() => regenerateRequests).toBe(2);
  await expect.poll(() => stateReads).toBe(3);
  await expect(composer).toBeDisabled();
  await page.waitForTimeout(1_500);
  expect(statusReads).toBe(0);

  const draftsBeforeFailure = draftReads;
  await page.evaluate(() => (window as unknown as { __fail: (index: number) => void }).__fail(0));
  await expect.poll(() => statusReads).toBeGreaterThan(0);
  await expect(composer).toBeEnabled();
  // The only submission-status read in this whole journey is the poll's own, so
  // this settle came from the fallback rather than from the stream - and the
  // authoritative read it needed was the one the recovery had just performed.
  expect(statusReads).toBe(1);
  expect(stateReads).toBe(settledFromRead);
  // The recovery read spends one `/draft`; the poll's hop reuses what that
  // snapshot described instead of spending a second read on it.
  expect(draftReads).toBe(draftsBeforeFailure + 1);
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
  // event loop between ticks so each mocked round trip can settle. A fixed yield
  // races those round trips, and the race costs steps rather than answers: the
  // poll arms its next interval only after the tick's own reads have landed, so
  // a tick whose reads land after the next `runFor` has already advanced the
  // clock arms its timer a whole interval in the future - one poll attempt then
  // costs two loop steps. The step ceiling is therefore well above the attempt
  // budget, and the loop stops at the poll's own unlock; the assertions below
  // still pin that unlock, the notice, and the budget's length.
  for (let step = 0; step < 600 && await composer.isDisabled(); step += 1) {
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
 * The shipped companion card's own openings, read from the asset the product
 * installs. The defect this journey pins was measured on a fresh runtime root
 * against exactly these three paragraphs - 4578 / 3161 / 3315 px of single-line
 * chip text, one per variant - so the chip journeys run against the real
 * material and not a comfortable fixture.
 */
const shippedCard = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../assets/tavern/presets/default-companion/card.json", import.meta.url)),
    "utf8",
  ),
) as Readonly<{ data: Readonly<{ first_mes: string; alternate_greetings: readonly string[] }> }>;

/** The chip's own facts, read from the rendered DOM. */
async function chipFacts(surface: Locator) {
  return await surface.locator(".composer-chip").evaluateAll((nodes) =>
    nodes.map((node) => {
      const chip = node as HTMLElement;
      return {
        text: (chip.textContent ?? "").trim(),
        title: chip.getAttribute("title"),
        name: chip.getAttribute("aria-label"),
        width: chip.getBoundingClientRect().width,
        clientWidth: chip.clientWidth,
        scrollWidth: chip.scrollWidth,
      };
    }),
  );
}

/** The width of the composer band the chips sit in: their own bound. */
async function composerWidth(page: Page): Promise<number> {
  return await page.locator(".composer-container").evaluate((node) => node.getBoundingClientRect().width);
}

/**
 * The chip contract, asserted from the rendered DOM rather than from a second
 * copy of the label rule: the *payload* stays the card's opening verbatim while
 * the *label* is a short prefix of that opening, renders inside its own box, and
 * fits the composer band; the accessible name is the tap's action, not prose.
 *
 * A chip that renders the paragraph (the measured 4578 / 3161 / 3315 px slab)
 * fails the overflow and prefix assertions; a chip that quietly shortened the
 * message fails the verbatim one; a chip named after the paragraph fails the
 * name's own bound.
 */
function expectChipsCarryTheOpenings(
  facts: readonly Readonly<{
    text: string;
    title: string | null;
    name: string | null;
    width: number;
    clientWidth: number;
    scrollWidth: number;
  }>[],
  openings: readonly Readonly<{ text: string }>[],
  composerBandWidth: number,
): void {
  expect(facts.length, "one chip per opening the card carries").toBe(openings.length);
  facts.forEach((chip, index) => {
    const opening = openings[index]!.text;
    // The opening as the label is derived from it: whitespace collapsed and a
    // leading roleplay marker dropped. The label must be a prefix of *this* and
    // not a summarised rewrite of it.
    const source = opening.replace(/\s+/gu, " ").trim().replace(/^\*+/u, "");
    expect(chip.title, `chip ${index} carries the card's opening verbatim as the text it sends`).toBe(opening);
    const stem = chip.text.endsWith("…") ? chip.text.slice(0, -1).trimEnd() : chip.text;
    expect(stem.length, `chip ${index} shows a label`).toBeGreaterThan(0);
    expect(chip.text.length, `chip ${index}'s label is no longer than the opening`).toBeLessThanOrEqual(
      opening.length,
    );
    expect(source.startsWith(stem), `chip ${index}'s label is the opening's own words, not a summary`).toBe(true);
    expect(
      chip.scrollWidth,
      `chip ${index} renders exactly its label: nothing is hidden behind an ellipsis`,
    ).toBeLessThanOrEqual(chip.clientWidth + 1);
    expect(chip.width, `chip ${index} fits the composer band`).toBeLessThanOrEqual(composerBandWidth);
    expect(chip.name ?? "", `chip ${index} is named by what a tap does`).toMatch(/^Say this opening: /u);
    expect((chip.name ?? "").length, `chip ${index}'s accessible name is an action, not a paragraph`).toBeLessThan(80);
  });
}

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
 *    (a generic "今天农场有什么要忙的") fail; each chip's payload is compared to
 *    the greeting record, line for line, and its short label must be the
 *    opening's own first words - never a summary and never the paragraph.
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

  // 1. The chips are the greeting record's own variants: each carries the card's
  // line verbatim as the payload it will send, while the visible label is the
  // opening's own short first sentence so the row stays a row of invitations.
  const chips = surface.locator(".composer-chip");
  await expect(chips).toHaveCount(2);
  expectChipsCarryTheOpenings(await chipFacts(surface), openings, await composerWidth(page));
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
 * The regression the lane measured on a fresh runtime root: the chip's rendered
 * content was the whole opening, so the three shipped openings reached the first
 * screen as single-line slabs - 4578 / 3161 / 3315 px, one per variant, exactly
 * the card's paragraphs on one line. The owner's first screen must be a few
 * tappable invitations, not a wall of prose.
 *
 * This journey mounts the shipped card's own openings and asserts the fix in the
 * terms the defect was measured, without weakening the payload:
 *
 * 1. `a chip never carries the paragraph` - every chip renders its label inside
 *    its own box (`scrollWidth <= clientWidth`, so nothing is hidden behind an
 *    ellipsis) and no chip is wider than the composer band. The failure this
 *    catches: the measured slab itself, and its cousin - a chip that looks short
 *    only because the paragraph is clipped below the ellipsis.
 * 2. `the payload is still the card's opening` - each chip's `title` is the
 *    opening verbatim and the label is the opening's own first words, so a chip
 *    whose short label quietly became the message fails.
 * 3. `the whole opening is readable before it is sent` - hovering or focusing a
 *    chip reveals the full text, verbatim, with nothing sent. The failure this
 *    catches: a truncation that hides the payload from a pointer or keyboard
 *    player, the one thing a short label must not do.
 * 4. `the first screen does not overflow` - the document's own scroll width
 *    stays inside the window, so the row wraps instead of running off the page.
 */
test("the shipped card's real openings stay short invitations, and hovering one shows what it will send", async ({
  page,
}) => {
  const openings = [
    { label: "Default", text: shippedCard.data.first_mes },
    ...shippedCard.data.alternate_greetings.map((text, index) => ({ label: `Alternate ${index + 1}`, text })),
  ];
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
    route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: openings }),
    ),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  const chips = surface.locator(".composer-chip");
  await expect(chips).toHaveCount(openings.length);

  const composerBandWidth = await composerWidth(page);
  const facts = await chipFacts(surface);
  console.log(
    `[chip-width] composer=${Math.round(composerBandWidth)} chips=${JSON.stringify(
      facts.map((chip) => ({ width: Math.round(chip.width), scrollWidth: chip.scrollWidth, label: chip.text })),
    )}`,
  );
  expectChipsCarryTheOpenings(facts, openings, composerBandWidth);

  // 3. The whole opening is one hover - or one Tab - away, verbatim.
  const preview = surface.locator("[data-chip-preview]");
  await expect(preview).toHaveCount(0);
  await chips.nth(2).hover();
  expect(await preview.textContent(), "hovering a chip reveals the opening verbatim").toBe(openings[2]!.text);
  await chips.nth(1).focus();
  expect(await preview.textContent(), "focusing a chip reveals the opening verbatim").toBe(openings[1]!.text);

  // 4. The row holds the page: no horizontal overflow anywhere.
  const scroll = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    window: window.innerWidth,
  }));
  expect(scroll.document, "the first screen does not scroll sideways").toBeLessThanOrEqual(scroll.window);
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

/**
 * The first screen of a card-provisioned Chat is NOT an empty transcript.
 *
 * The product's own initial-Chat saga draws message zero from the greeting record
 * whenever the companion was provisioned from a card
 * (`initial-chat-exact-content-port.ts` `companionOwnOpening`, invoked from
 * `continuity-semantic-production-coordinator.internal.ts`
 * `materializeExpectedChatContent`), so by the time a player looks at the first
 * screen it already carries the companion's committed opening, projected with
 * `openingVariant`. The chips must be offered THERE - the card's own openings are
 * exactly what a player needs to know what to say - and must leave once the player
 * speaks.
 *
 * The failure this catches: chips gated on `transcript.length === 0`. That state
 * holds only for a Chat that opened on a *blank* opening, and a blank opening has
 * no greeting material to offer, so the state the gate required and the state that
 * can supply a chip were mutually exclusive - the chips could never appear in a
 * real product, which is what the acceptance run measured (`chipCount: 0` with the
 * card's opening on screen).
 */
test("the first screen offers the card's openings when the companion's own opening is already message zero", async ({ page }) => {
  const openings = [
    { label: "Default", text: "The lantern over the porch is still lit." },
    { label: "Alternate 1", text: "Rain has been falling since dawn." },
  ];
  const openingVariantId = "V".repeat(42) + "A";
  const openedMessageHandle = "W".repeat(42) + "A";
  let greetingReads = 0;

  const firstScreenRoot = {
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
        transcript: [
          {
            handle: openedMessageHandle,
            role: "companion",
            text: openings[0]!.text,
            locale: "und",
            order: 0,
            revision: 1,
            openingVariant: { variantId: openingVariantId, index: 0, count: 2, label: openings[0]!.label, locked: false },
          },
        ],
        draft: { revision: 0, present: false },
      },
    },
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(firstScreenRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(firstScreenRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads += 1;
    return route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: openings }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();

  // The companion's committed opening is on screen ...
  await expect(surface.locator(".message-list > li")).toHaveCount(1);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);

  // ... and the chips are the greeting record's own variants, still offered.
  const chips = surface.locator(".composer-chip");
  await expect(chips).toHaveCount(2);
  expectChipsCarryTheOpenings(await chipFacts(surface), openings, await composerWidth(page));
  await expect(surface.locator(".composer-chips-row")).toHaveAccessibleName("Openings");
  expect(greetingReads, "the card's opening record is read for the not-yet-started conversation").toBeGreaterThan(0);
});

/**
 * Once the player has spoken, the opening is no longer the whole first screen and
 * the chips leave - the shell does not even read the card's record for it.
 *
 * The failure this catches: chips that survive the first player message, and a
 * first-screen predicate that treats the companion's opening as "nothing has
 * happened yet" forever.
 */
test("chips leave once a player message follows the companion's opening", async ({ page }) => {
  const openings = [
    { label: "Default", text: "The lantern over the porch is still lit." },
    { label: "Alternate 1", text: "Rain has been falling since dawn." },
  ];
  const startedRoot = {
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
        transcript: [
          {
            handle: "W".repeat(42) + "A",
            role: "companion",
            text: openings[0]!.text,
            locale: "und",
            order: 0,
            revision: 1,
            openingVariant: { variantId: "V".repeat(42) + "A", index: 0, count: 2, label: openings[0]!.label, locked: true },
          },
          { handle: "X".repeat(42) + "A", role: "player", text: "I'll be right out.", locale: "und", order: 1, revision: 1 },
        ],
        draft: { revision: 0, present: false },
      },
    },
  };
  let greetingReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(startedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(startedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads += 1;
    return route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: openings }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".message-list > li")).toHaveCount(2);
  await expect(surface.locator(".composer-chip")).toHaveCount(0);
  await expect(surface.locator(".composer-chips-row")).toHaveCount(0);
  expect(greetingReads, "a conversation the player has spoken in asks for no opening material").toBe(0);
});


/**
 * The one terminal operation (`game.endgame`). It is deliberately not a routine
 * session control: the player must confirm it, and only the confirm sends the
 * command. This journey drives it the way a player would, over the real shell
 * against the composed routes, and asserts both directions of the honesty:
 * the confirm step happens before the POST, and the control is absent - not a
 * disabled lookalike - when no live session can be ended.
 */
test("Game endgame requires an explicit confirm before the POST and reaches the terminal route once", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const endedGame = {
    ...attachedGame,
    game: {
      ...attachedGame.game,
      attachment: { status: "none", generation: 0 },
      connectionStatus: "stopped",
      actionAuthority: "unavailable",
      latestOutcome: "succeeded",
    },
  };
  let endgameRequests = 0;
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk({ ...root, game: attachedGame })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/endgame", async (route) => {
    endgameRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
      confirm: true,
    });
    // A slow confirmation proves in-flight single-flight: the button stays
    // disabled and a double activation is still one command.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill(jsonOk({ apiVersion: 1, status: "gameended" }));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill(jsonOk({ ...root, game: endedGame }));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk(draft)),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const endgame = panel.getByTestId("game-endgame");
  await expect(endgame).toBeVisible();

  // Step one only arms the confirm: no command has been sent yet.
  await endgame.getByTestId("game-endgame-open").click();
  const confirm = panel.getByTestId("game-endgame-confirm");
  await expect(confirm).toBeVisible();
  expect(endgameRequests, "arming the confirm must not send the terminal command").toBe(0);

  // The confirm is the one and only sender, and it is single-flight.
  await confirm.getByTestId("game-endgame-confirm-yes").dblclick();
  await expect.poll(() => endgameRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(endgame).toHaveCount(0);
  await expect(panel).toContainText("ConnectionStopped");
  await expect(panel).not.toContainText("The game could not be ended");
});

test("Game endgame control is absent when no live session can be ended", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(root)),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // The default root has no attachment, so there is nothing to end: absent
  // rather than a disabled lookalike (design/26 §1).
  await expect(panel.getByTestId("game-endgame")).toHaveCount(0);
});


/**
 * Chat selection (ADR-0009, turn-level). Choosing another Chat must switch the mounted
 * conversation inside the same process while the runtime is idle, and must refuse with a reason the
 * player can act on while a turn is generating. The surface may never claim a switch it did not
 * make, and it may never leave the player with a raw code or a "restart the app" dead end.
 */
test("Chats surface switches the mounted conversation on click and refuses a stale generation", async ({ page }) => {
  const secondHandle = "C".repeat(42) + "A";
  const thirdHandle = "D".repeat(42) + "A";
  let selectRequests = 0;
  let listReads = 0;
  let selectStatus = 200;
  let selectTarget = secondHandle;
  // The Host's own mounted Chat: a real switch changes it, so the next /state read is the target's.
  let mountedHandle = handle;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle },
      { handle: secondHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === secondHandle },
      { handle: thirdHandle, title: "Third conversation", status: "active", managementRevision: 1, isSelected: false },
    ],
  });
  const secondChat = {
    ...chat,
    selection: { chatHandle: secondHandle, generation: 2, stateRevision: secondHandle },
    chat: {
      ...chat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: "E".repeat(42) + "A",
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? chat : secondChat });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      listReads += 1;
      return route.fulfill(jsonOk(listOf()));
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, selectionGeneration: 1, chatHandle: selectTarget });
    if (selectStatus !== 200)
      return route.fulfill({ status: selectStatus, contentType: "application/json", body: JSON.stringify({ code: "selection_conflict" }) });
    mountedHandle = selectTarget;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The conversation the app opens on is the first chat's.
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect(surface.getByTestId("chat-item")).toHaveCount(3);

  // The mounted chat is the selected row.
  await expect(surface.getByTestId("chat-item").first()).toHaveAttribute("data-selected", "true");
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "false");

  // Clicking the already-mounted chat is a no-op: no selection admission at all.
  await surface.getByTestId("chat-item").first().getByTestId("chat-select").click();
  await page.waitForTimeout(50);
  expect(selectRequests, "selecting the mounted chat must not create a second admission").toBe(0);

  // A stale generation is a bounded refusal: the failure is reported and the list re-read.
  selectStatus = 409;
  selectTarget = thirdHandle;
  const readsBefore = listReads;
  await surface.getByTestId("chat-item").nth(2).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);
  await expect(surface.getByRole("status")).toContainText("Operation failed.");
  await expect.poll(() => listReads).toBeGreaterThan(readsBefore);

  // An idle switch: the Host switches the mounted conversation in process and answers `switched`, so
  // the browser reloads the mounted conversation and the transcript shown is the target's. No restart
  // happens anywhere, and no "next start" promise is made.
  selectStatus = 200;
  selectTarget = secondHandle;
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(2);
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "true");
  await expect(surface.getByRole("status")).toContainText("Chat switched.");

  // The mounted conversation is the target's: returning to the conversation shows its transcript.
  await page.goBack();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText("The game projection is read-only.");

  // The now-mounted chat is a no-op again: the switch did not leave a second admission behind.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "true");
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await page.waitForTimeout(50);
  expect(selectRequests, "re-selecting the mounted chat must not create a second admission").toBe(2);
});

/**
 * The unified action rule (ADR-0010), Class A: selecting another Chat is a focus transfer, and a
 * focus transfer is never withheld. While a turn is generating the rows stay ENABLED, the click
 * reaches the selection route, the Host aborts the running turn through the same cancel path an
 * explicit Stop uses, the outcome is `switched`, and the conversation the app shows is the
 * target's.
 *
 * The assertions, and the failure each one catches:
 *  - `chat-select` is enabled with no `chat-select-blocked` notice: catches the grey-out, which held
 *    the player's attention hostage while another conversation was one click away.
 *  - The selection route is reached exactly once: catches a control that silently swallows the
 *    click.
 *  - `chat-select-pending` while the request is out, gone once it lands: catches a click that looks
 *    ignored - the acknowledgement is a request, never a refusal.
 *  - The switched notice and the target row marked selected: catches a Host answer that refuses the
 *    switch (the old `turn_in_flight` reading) instead of performing it.
 *  - The transcript being the target's and no longer the first chat's: catches a `switched` answer
 *    that did not actually move the mounted conversation - the failure mode where only the *next*
 *    start would have honoured the choice.
 *  - The interrupted turn's produced text present again after switching back, with its Stop gone:
 *    catches an abort that throws away the part of the reply the player had already been shown.
 */
test("clicking another chat while a turn generates aborts that turn and switches", async ({ page }) => {
  let selectRequests = 0;
  let mountedHandle = handle;
  const targetHandle = "C".repeat(42) + "A";
  const runningTurnHandle = "F".repeat(42) + "A";
  // What the interrupted turn had already produced: aborting it to switch must keep this text, not
  // discard the part of the reply the player had already been shown.
  const producedText = "And then she said, before the switch interrupted her,";
  let selectTarget = targetHandle;
  let selectGeneration = 1;
  // A generating turn on the first conversation. The switch aborts it; its produced text stays.
  let turnRunning = true;
  const firstChat = () => ({
    ...chat,
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    operations: turnRunning
      ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
      : [],
    chat: {
      ...chat.chat,
      transcript: [
        ...chat.chat.transcript,
        {
          handle: runningTurnHandle,
          role: "companion",
          text: producedText,
          locale: "und",
          order: 1,
          revision: 1,
        },
      ],
      turn: turnRunning
        ? { handle: runningTurnHandle, state: "running", projectionRevision: 1, canCancel: true }
        : null,
    },
  });
  const targetChat = {
    ...chat,
    selection: { chatHandle: targetHandle, generation: 2, stateRevision: targetHandle },
    chat: {
      ...chat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: "E".repeat(42) + "A",
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
      turn: null,
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? firstChat() : targetChat });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chats: [
            { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle },
            { handle: targetHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === targetHandle },
          ],
        }),
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, selectionGeneration: selectGeneration, chatHandle: selectTarget });
    // Hold the answer so the transient acknowledgement is observable, exactly as a Host that has to
    // abort and settle a running turn before it can switch.
    await new Promise((resolve) => setTimeout(resolve, 300));
    turnRunning = false;
    mountedHandle = selectTarget;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The turn really is generating, and it has already produced text the abort must preserve.
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(chatSurface.getByRole("region", { name: "Chat transcript" })).toContainText(producedText);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect(surface.getByTestId("chat-item")).toHaveCount(2);

  const target = surface.getByTestId("chat-item").nth(1).getByTestId("chat-select");
  // Nothing is greyed out and no "stop first" reason is posted: the gesture is available.
  await expect(target).toBeEnabled();
  await expect(surface.getByTestId("chat-select-blocked")).toHaveCount(0);

  await target.click();
  // The click is acknowledged while the request is out - a request, never a refusal.
  await expect(surface.getByTestId("chat-select-pending")).toContainText("Switching");
  await expect.poll(() => selectRequests).toBe(1);
  await expect(surface.getByRole("status")).toContainText("Chat switched.");
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "true");
  await expect(surface.getByTestId("chat-select-pending")).toHaveCount(0);

  // The mounted conversation really moved: the transcript is the target's, not the first chat's.
  await page.goBack();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText("The game projection is read-only.");

  // The interrupted turn's produced text survived the abort, and that turn is no longer running:
  // switching back shows both. This catches an abort that throws away what the turn had written.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  selectTarget = handle;
  selectGeneration = 2;
  await surface.getByTestId("chat-item").first().getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(2);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(producedText);
  await expect(chatSurface.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

/**
 * The unified action rule (ADR-0010), Class B: state, configuration and metadata writes never abort,
 * block or refuse a running generation - they take effect on the next turn. Two members are driven
 * here, the surface's own model parameters and another Chat's title, both while a turn generates.
 *
 * The assertions, and the failure each one catches:
 *  - Both writes reach their routes: catches a Class B action withheld because a turn runs.
 *  - The app bar still reports the generation after each write: catches a Class B write that tore the
 *    running turn down - the same defect family as the greyed-out Chats rows.
 *  - The durable read-backs are what the surfaces show (the saved model, the renamed title): catches
 *    a write that only looked applied locally.
 *  - The authoritative state after the turn settles is a COMPLETED turn carrying the reply: catches a
 *    Class B write that silently cancelled or parked the generation instead of letting it finish.
 *  - The model editor still reads the chosen value back after that settlement: catches a value the
 *    surface only kept locally, which the next turn would then not start from.
 */
test("a Class B action mid-turn reaches its route and leaves the running turn alone", async ({ page }) => {
  const targetHandle = "C".repeat(42) + "A";
  const replyText = "A reply that finished while the settings changed.";
  const renamedTitle = "Second conversation, renamed";
  const recommendedModels = [
    {
      providerId: "cpa-oai",
      providerLabel: "CPA OAI",
      modelId: "deepseek-v4",
      modelLabel: "DeepSeek V4",
      allowedThinkingLevels: ["off", "medium", "high"],
      defaultThinkingLevel: "medium",
    },
  ];
  let turnSettled = false;
  // The durable title the list projects: the rename route's read-back is the only thing that moves it.
  let targetTitle = "Second conversation";
  let targetTitleRevision = 1;
  let chatProfile = { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" };
  const gameProfile = { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" };
  const profileWrites: unknown[] = [];
  const titleWrites: unknown[] = [];
  const projected = () => ({
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" },
      ],
      chat: {
        ...chat.chat,
        transcript: turnSettled
          ? [
              ...chat.chat.transcript,
              { handle: "G".repeat(42) + "A", role: "companion", text: replyText, locale: "und", order: 1, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: turnSettled
          ? { handle: "F".repeat(42) + "A", state: "completed", projectionRevision: 2, canCancel: false }
          : { handle: "F".repeat(42) + "A", state: "running", projectionRevision: 1, canCancel: true },
      },
    },
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projected())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projected())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/settings/profiles", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill(
        jsonOk({ apiVersion: 1, chat: chatProfile, game: gameProfile, recommendedModels }),
      );
    const body = route.request().postDataJSON() as { modelId: string; thinkingLevel: string };
    profileWrites.push(route.request().postDataJSON());
    chatProfile = { revision: chatProfile.revision + 1, modelId: body.modelId, thinkingLevel: body.thinkingLevel };
    return route.fulfill(jsonOk({ apiVersion: 1, chat: chatProfile, game: gameProfile, recommendedModels }));
  });
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chats: [
            { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true },
            { handle: targetHandle, title: targetTitle, status: "active", managementRevision: targetTitleRevision, isSelected: false },
          ],
        }),
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/title", (route) => {
    titleWrites.push(route.request().postDataJSON());
    targetTitle = renamedTitle;
    targetTitleRevision = 2;
    return route.fulfill(
      jsonOk({ apiVersion: 1, handle: targetHandle, title: renamedTitle, managementRevision: 2 }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The turn really is generating before either Class B write.
  await expect(page.getByText("Thinking…")).toBeVisible();

  // Class B, member one: this surface's model parameters.
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  await chatSurface.getByTestId("chat-model-trigger").click();
  const popout = page.getByRole("dialog", { name: "Chat model settings" });
  await expect(popout).toBeVisible();
  await popout.getByLabel("Model ID").fill("deepseek-v5");
  await popout.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => profileWrites.length).toBe(1);
  expect(profileWrites[0]).toEqual({
    apiVersion: 1,
    surface: "chat",
    expectedRevision: 1,
    modelId: "deepseek-v5",
    thinkingLevel: "medium",
  });
  // The durable read-back is what the editor shows, and the generation is untouched.
  await expect(popout.locator('[data-model-notice="saved"]')).toBeVisible();
  await expect(popout.getByLabel("Model ID")).toHaveValue("deepseek-v5");
  await expect(page.getByText("Thinking…")).toBeVisible();
  // The drawer's own close control, not Escape: the Save that just ran disabled itself and dropped
  // focus to <body>, so this asserts the surface's close affordance rather than a keyboard accident.
  await popout.getByRole("button", { name: "Close", exact: true }).click();
  await expect(popout).toHaveCount(0);

  // Class B, member two: another Chat's title.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  // Two controls, two names: the row's rename BUTTON carries the affordance ("Rename Chat") and
  // the input it opens is the FIELD ("Chat title"). While both carried `labels.renameChat`, a
  // surface-wide `getByLabel("Rename Chat")` matched the other row's button and this input at once
  // and Playwright's strict mode failed the journey before it could fill anything. So name the
  // control that is meant, and assert no second control answers to that name so a duplicate cannot
  // come back silently.
  const renameRow = surface.getByTestId("chat-item").nth(1);
  await renameRow.getByRole("button", { name: "Rename Chat" }).click();
  const titleField = renameRow.getByLabel("Chat title");
  await expect(titleField).toBeVisible();
  await expect(surface.getByLabel("Rename Chat")).toHaveCount(1);
  await expect(surface.getByLabel("Chat title")).toHaveCount(1);
  await titleField.fill(renamedTitle);
  await surface.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => titleWrites.length).toBe(1);
  expect(titleWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    chatHandle: targetHandle,
    expectedManagementRevision: 1,
    title: renamedTitle,
  });
  // The durable read-back is what the list shows, and the generation survived the rename.
  await expect(surface.getByTestId("chat-item").nth(1)).toContainText(renamedTitle);
  await expect(page.getByText("Thinking…")).toBeVisible();

  // The turn reaches its own settlement: the authoritative state is a COMPLETED turn whose reply is
  // in the transcript, so no Class B write cancelled or parked the generation.
  turnSettled = true;
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(replyText);
  await expect(page.getByText("Thinking…")).toHaveCount(0);

  // The value the next turn starts from is the one the player chose mid-turn: re-opening this
  // surface's own model settings reads it back from the Host, never from anything the surface kept
  // locally through the switch and the completion.
  await page.getByTestId("chat-surface").getByTestId("chat-model-trigger").click();
  await expect(page.getByRole("dialog", { name: "Chat model settings" }).getByLabel("Model ID")).toHaveValue(
    "deepseek-v5",
  );
});



/**
 * The optimistic send (design/26 §6): the input cleared and then nothing happened for the seconds
 * the Host spends thinking - the "anxiety wait". The sent text must be visible in the reading flow
 * immediately, marked pending, and must collapse into the Host's authoritative message for the same
 * idempotency key. It must never duplicate, and a re-read that no longer carries the key must leave
 * no ghost.
 */
test("sending shows the player's text immediately with a pending marker, then collapses into the authoritative message", async ({ page }) => {
  const playerText = "Meet me at the mine entrance.";
  const playerHandle = "P".repeat(42) + "A";
  const turnHandle = "T".repeat(42) + "A";
  let submitted = false;
  const submittable = {
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      chat: { ...chat.chat, draft: { revision: 0, present: false } },
    },
  };
  const projection = () => ({
    ...submittable,
    chat: {
      ...submittable.chat,
      chat: {
        ...submittable.chat.chat,
        transcript: submitted
          ? [
              ...chat.chat.transcript,
              { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: submitted ? { handle: turnHandle, state: "completed", projectionRevision: 1, canCancel: false } : null,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/messages", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Hold the submit so the optimistic entry is observable before the Host answers.
    await new Promise((resolve) => setTimeout(resolve, 300));
    submitted = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await surface.locator(".composer-textarea").fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();

  // Before any Host response: the sent text is visible and marked pending, while the authoritative
  // transcript does not yet carry it.
  const optimistic = surface.getByTestId("optimistic-player-message");
  await expect(optimistic).toBeVisible();
  await expect(optimistic).toHaveAttribute("data-pending", "true");
  await expect(optimistic).toContainText(playerText);
  await expect(surface.locator(".message-list > li", { hasText: playerText })).toHaveCount(0);

  // The authoritative message lands: the pair collapses to exactly one message and the optimistic
  // entry is gone (never a duplicate).
  await expect(optimistic).toHaveCount(0);
  await expect(surface.locator(".message-list > li", { hasText: playerText })).toHaveCount(1);

  // A reload re-reads the authoritative transcript and leaves no optimistic ghost.
  await page.reload();
  const reloaded = page.getByTestId("chat-surface");
  await expect(reloaded).toBeVisible();
  await expect(reloaded.getByTestId("optimistic-player-message")).toHaveCount(0);
  await expect(reloaded.locator(".message-list > li", { hasText: playerText })).toHaveCount(1);
});

/**
 * The obligations the product surface declares for itself. The reference and
 * management surfaces' criteria journeys went with their shells (13c4c70a,
 * 6406dd0a); the one remaining surface carries their obligations, and this list
 * is what keeps a checker from being dropped quietly.
 */
const PRODUCT_CRITERIA_OBLIGATIONS = [
  "frontend-accessibility-baseline",
  "frontend-keyboard-reach",
  "frontend-layout-floor",
  "frontend-quiet-walk",
] as const;

/**
 * The criteria the journeys above are instances of, asserted as properties of
 * the product surface.
 *
 * The failures this catches: a frontend change that drops an accessibility,
 * keyboard, layout or quietness property while every behavioural journey still
 * passes - which is what the conformance contract (`frontend-criteria.ts`,
 * design/architecture/tavern-frontend-criteria.md) exists to prevent. The
 * conversation carries real content first, because an empty transcript never
 * overflows and has nothing to reach with a keyboard, so a floor measured on it
 * would report a pass that means nothing.
 */
test("conformance: the product surface meets the frontend criteria", async ({ page }) => {
  test.setTimeout(60_000);
  const noise = watchSurface(page);
  // `chat.submit` is published, exactly as the reference profile declares it: the
  // composer's own enablement is a projection of the nested Chat snapshot, so the
  // surface judged here is the operable one a player is actually given.
  const operable = {
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(operable)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.getByRole("textbox", { name: /Type a message/u });
  await expect(composer).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );

  // Keyboard reach is measured from the document as loaded: no programmatic
  // focus, no pointer event, and before anything has been typed into the
  // composer (typing would leave focus there and Tab would walk away from it).
  resetCriteriaLedger();
  await assertKeyboardReachable(page, composer, "the chat composer");
  await assertSectionsKeyboardReachable(page, "[aria-label]");

  await assertAccessibilityBaseline(page, "composed");
  await assertLayoutFloor(page);
  assertQuiet(noise, "composed");
  assertCriteriaCoverage("composed", PRODUCT_CRITERIA_OBLIGATIONS);
});

/**
 * The Chat surface's own Stop control, end to end on the product shell.
 *
 * The mounted reference journey that asserted this ("reference browser stops an
 * armed response, reloads its durable cancellation, and sends again") went with
 * the reference shell. The capability is this surface's own - the stop control,
 * the durable cancelled turn it rereads, and the composer it hands back - so the
 * journey is asserted here rather than lost with the shell.
 *
 * The assertions, and the failure each one catches:
 *  - Stop is offered only for a turn the Host published `chat.cancel` for:
 *    catches a stop control offered for a turn the Host never offered to cancel;
 *  - the click posts exactly one `chat.cancel`, with this session's csrf token
 *    and the mounted generation: catches a double-submitted stop and a stop aimed
 *    at a generation the Host is not serving;
 *  - the notice is what the authoritative reread says, not what the click hoped:
 *    catches a surface that prints "stopped" for a cancellation nobody confirmed;
 *  - a reload still shows it: catches a stop the surface only kept in memory;
 *  - the player can send again afterwards: catches a stopped conversation left
 *    permanently locked.
 */
test("the mounted conversation stops an armed reply, keeps the stop durable across a reload, and sends again", async ({ page }) => {
  test.setTimeout(60_000);
  const turnHandle = `${"T".repeat(42)}A`;
  const nextTurnHandle = `${"U".repeat(42)}A`;
  const stoppedTurn = { handle: turnHandle, state: "cancelled", projectionRevision: 2, canCancel: false };
  const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true };
  const nextMessage = {
    handle: `${'P'.repeat(42)}A`,
    role: "player",
    text: "A second message after Stop",
    locale: "und",
    order: 1,
    revision: 1,
  };
  let turn: Readonly<{ handle: string; state: string; projectionRevision: number; canCancel: boolean }> = runningTurn;
  let cancels = 0;
  let sends = 0;
  let sent = false;
  let stateReads = 0;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
        ...(turn.canCancel
          ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
          : []),
      ],
      chat: {
        ...chat.chat,
        transcript: sent ? [...chat.chat.transcript, nextMessage] : chat.chat.transcript,
        turn: sent ? { handle: nextTurnHandle, state: "running", projectionRevision: 1, canCancel: true } : turn,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(projection()));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    cancels += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, selectionGeneration: 1 });
    turn = stoppedTurn;
    await route.fulfill(jsonOk({ apiVersion: 1, disposition: "cancelled", turn: stoppedTurn }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sends += 1;
    sent = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: nextMessage,
        turn: { handle: nextTurnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  const stop = surface.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeEnabled();

  await stop.click();
  await expect.poll(() => cancels).toBe(1);
  // The notice is the reread's fact, and the control goes with the cancellable
  // turn: both come from the authoritative projection, not from the click.
  await expect(surface).toContainText("Reply stopped. You can send another message.");
  await expect(stop).toHaveCount(0);
  await expect(composer).toBeEnabled();
  expect(stateReads).toBe(1);
  expect(cancels).toBe(1);

  await page.reload();
  const reloaded = page.getByTestId("chat-surface");
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("Reply stopped. You can send another message.");

  await reloaded.locator(".composer-textarea").fill("A second message after Stop");
  await reloaded.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await expect(reloaded.locator(".message-list")).toContainText("A second message after Stop");
});

/**
 * The composed conversation's live event stream, at the client contract.
 *
 * The Host publishes the composed Chat projection with a non-null `eventStream`
 * (the composed tavern profile declares the `events` route), and this client
 * opens the stream, previews `companion.delta` frames, and repairs a rejected
 * frame by rereading authoritative state. The mounted reference journeys that
 * asserted the wire behaviour went with the reference shell; the *decisions*
 * this client makes are this surface's own, so they are asserted here.
 *
 * The transport is a synthetic EventSource (the composed lane has no real Host
 * SSE endpoint, and `route.fulfill` cannot stream): it proves which URL and
 * cursor the surface subscribes with and how it reacts to frames, not how
 * Chromium reassembles bytes - which is the Host's own suite's subject.
 *
 * The assertions, and the failure each one catches:
 *  - the subscription carries the projected checkpoint: catches a surface that
 *    opens the stream at the wrong position, or ignores the projection entirely;
 *  - a delta becomes a preview with no authoritative read: catches a typewriter
 *    that rereads the whole conversation on every token;
 *  - a frame the session rejects (a generation the mounted conversation is not
 *    on) recovers exactly once, through `/state` and the draft, and reconnects on
 *    the cursor that state names: catches a recovery loop, a reconnect on the
 *    stale frame id, and a surfaced failure where a repair was required;
 *  - an explicit `stream.resync_required` frame repairs the same way: catches a
 *    resync marker treated as a fatal problem.
 */
test("the composed conversation opens the projected event stream, previews a delta, and recovers through authoritative state once per resync", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${"E".repeat(42)}A`;
  const initialCursor = `${"F".repeat(42)}A`;
  const recoveredCursor = `${"G".repeat(42)}A`;
  const deltaHandle = `${"T".repeat(42)}A`;
  const frameId = `${"H".repeat(42)}A`;
  let currentCursor = initialCursor;
  let stateReads = 0;
  let draftReads = 0;

  const projection = () => ({ ...root, chat: { ...chat, eventStream: { epoch: streamEpoch, cursor: currentCursor } } });

  await page.addInitScript(() => {
    const state = window as unknown as {
      __streams: Array<{ url: string; closed: boolean }>;
      __streamHandlers: Array<Map<string, Array<(raw: unknown) => void>>>;
      __emit: (index: number, type: string, data: string, id: string) => void;
    };
    state.__streams = [];
    state.__streamHandlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      constructor(url: string | URL) {
        const index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__streamHandlers.push(new Map());
        this.__index = index;
      }
      __index = -1;
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      const handlers = state.__streamHandlers[index]?.get(type) ?? [];
      for (const handler of handlers) handler({ data, lastEventId: id, type });
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    // The repair's own read moves the checkpoint: the reconnect must carry the
    // cursor this answer names, never the id of the frame that was rejected.
    currentCursor = recoveredCursor;
    return route.fulfill(jsonOk(projection()));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill(jsonOk(draft));
  });

  const streamUrls = async (): Promise<string[]> =>
    await page.evaluate(() => (window as unknown as { __streams: Array<{ url: string }> }).__streams.map((stream) => stream.url));
  const emit = async (index: number, type: string, event: unknown, id: string): Promise<void> => {
    await page.evaluate(
      (input: { index: number; type: string; data: string; id: string }) => {
        (window as unknown as { __emit: (i: number, t: string, d: string, e: string) => void }).__emit(
          input.index,
          input.type,
          input.data,
          input.id,
        );
      },
      { index, type, data: JSON.stringify(event), id },
    );
  };
  const frame = (sequence: number, selectionGeneration: number, eventType: string, payload: unknown) => ({
    apiVersion: 1,
    epoch: streamEpoch,
    sequence,
    selectionGeneration,
    eventType,
    payload,
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect.poll(streamUrls).toHaveLength(1);
  expect((await streamUrls())[0]).toContain(`/api/tavern/v1/events?`);
  expect((await streamUrls())[0]).toContain(`cursor=${initialCursor}`);

  // A delta is a preview: it costs no authoritative read.
  await emit(0, "companion.delta", frame(1, 1, "companion.delta", { turnHandle: deltaHandle, delta: "A provisional reply." }), frameId);
  await expect(surface).toContainText("A provisional reply.");
  expect(stateReads).toBe(0);

  // A frame for a generation this conversation is not on is rejected by the
  // session and repaired once, through the authoritative read.
  await emit(0, "draft.changed", frame(2, 2, "draft.changed", { revision: 2, present: false }), `${"I".repeat(42)}A`);
  await expect.poll(() => stateReads).toBe(1);
  await expect.poll(streamUrls).toHaveLength(2);
  expect((await streamUrls())[1]).toContain(`cursor=${recoveredCursor}`);
  expect(draftReads).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __streams: Array<{ closed: boolean }> }).__streams[0]!.closed)).toBe(true);
  await expect(surface).not.toContainText("Unable to read chat");

  // No recovery loop: the repaired stream carries the new cursor and one frame
  // does not become a second read.
  await page.waitForTimeout(750);
  expect(stateReads).toBe(1);
  expect(await streamUrls()).toHaveLength(2);

  // An explicit resync marker repairs the same way instead of becoming a fault.
  await emit(1, "stream.resync_required", frame(3, 1, "stream.resync_required", { reason: "gap" }), `${"J".repeat(42)}A`);
  await expect.poll(() => stateReads).toBe(2);
  await expect(surface).not.toContainText("Unable to read chat");
});
