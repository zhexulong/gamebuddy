import { expect, test, type Page } from "@playwright/test";
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
/** A second opaque handle, so a companion is never keyed by the Chat's own handle. */
const characterHandle = "D".repeat(42) + "A";
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
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
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
    // The mount's World Info, which the Host projects from the same read its
    // `GET /world-info` answers from: empty is where a fresh product's library is.
    worldInfo: { state: "none", revision: handle, items: [] },
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
  // The concern here is that the panel leaks wire vocabulary or an internal identity, not that it may never use an
  // ordinary English word: the guide's own hint says "Gets the companion ready to play in this session", which the
  // earlier `/ready|connected/i` also matched - a false positive that pinning the surface's copy made inevitable.
  // The identifiers are what must never appear.
  await expect(panel).not.toContainText(/\bready[a-z]*Id\b|\bconnected[A-Z]\w*/u);
  await expect(panel).not.toContainText(/cabin_choice_|attestation_|handoff_/u);
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

test("a management refusal keeps its own problem code instead of none reported", async ({ page }) => {
  // The opening choice is a *management* mutation (`PUT /api/tavern/v1/chat/opening`
  // through `management-pipeline-api`), and the shell hands what it caught straight to
  // `composedProblemView`. The management client used to declare its own
  // `TavernProblemError`, so that check was false for everything this path threw and the
  // shell's only diagnostic - which of the opening's closed refusals happened - was
  // replaced by "none reported".
  const opening = {
    ...chat,
    chat: {
      ...chat.chat,
      transcript: [
        {
          handle: characterHandle,
          role: "companion",
          text: "Good morning.",
          locale: "und",
          order: 0,
          revision: 1,
          openingVariant: { variantId: "greeting-1", index: 0, count: 2, label: null, locked: false },
        },
      ],
    },
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, chat: opening }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/chat/opening", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Opening already sealed",
        status: 409,
        code: "chat_opening_locked",
        requestId: characterHandle,
        retryable: false,
      }),
    }),
  );
  // A refusal is resolved by the authoritative reread, so it becomes the player's
  // problem only when that reread cannot run either - the state this journey puts the
  // mount in, and the state in which the message is the only thing the player has.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "State unavailable",
        status: 503,
        code: "state_unavailable",
        requestId: characterHandle,
        retryable: true,
      }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Next variant" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "This conversation has already started, so the greeting it opened on can no longer change.",
  );
  await expect(page.getByRole("alert")).not.toContainText("none reported");
  // The refusal is a fact about this conversation, never a system fault. This assertion was the
  // internal-error sentence naming `chat_opening_locked` until every member of the contract's union
  // got its own words (`problem-code.8`); the force is kept and inverted - the code is not printed,
  // and the reading is not "internal error".
  await expect(page.getByRole("alert")).not.toContainText("internal error");
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

/**
 * The refusal a first run really produces, measured in the live product (2026-10-19, the composed Game
 * surface at HEAD): with no Stardew installation registered for the session, pressing "Enable companion
 * play" answers `409 {"code":"state_unavailable","cause":"stardew_bootstrap_registration_unavailable"}`
 * (`scratch/probe-game-activation.mjs`). Activation reserves and stages the owned Player Host against the
 * registered installation, so with none bound the attempt can only be refused - the player has not set the
 * game up yet, and the installation panel on this same surface is where they do that.
 *
 * The failure this catches: that refusal rendered as "companion play could not be enabled. The latest
 * authoritative game state is shown." - a dead-end fault over a state the player fixes on this very screen.
 * It now states the missing prerequisite and names the control that supplies it, the way the cabin handoff
 * renders its own not-yet state.
 */
test("an activation refused for a missing installation reads as the prerequisite, and lays out as one status line", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable", cause: "stardew_bootstrap_registration_unavailable" }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Enable companion play" }).click();

  const statusLine = panel.locator('[data-guide-step="1"] .game-status');
  // The attempt's own in-progress line is already one `.game-status` in step 1, so waiting for the count
  // alone measures the press rather than its answer: wait for the refusal's sentence to land, and for that
  // line to be laid out, before anything is measured.
  await expect(statusLine).toContainText("Companion play needs a Stardew Valley installation");
  await expect(statusLine).toBeVisible();
  await expect(statusLine).toHaveCount(1);
  const measurement = await statusLine.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const step = node.closest('[data-guide-step="1"]');
    return Object.freeze({
      tone: node.getAttribute("data-tone"),
      textLength: node.textContent?.length ?? 0,
      width: box.width,
      height: box.height,
      stepWidth: step === null ? 0 : step.getBoundingClientRect().width,
    });
  });
  console.log(`[activation-not-configured] ${JSON.stringify(measurement)}`);

  // A missing installation is a state to act on, not a failure to report: the line carries the informative
  // tone the cabin handoff's own not-yet state carries, and it says which prerequisite is missing and where
  // the player supplies it.
  expect(measurement.tone).toBe("info");
  await expect(statusLine).toContainText("Companion play needs a Stardew Valley installation");
  await expect(statusLine).toContainText("Choose your game folder in Game installation below");
  await expect(panel).not.toContainText("Companion play could not be enabled");
  // It is really laid out inside step 1: a line that renders, fits the step, and is not a zero-height ghost.
  expect(measurement.textLength).toBeGreaterThan(0);
  expect(measurement.height).toBeGreaterThan(0);
  expect(measurement.width).toBeGreaterThan(0);
  expect(measurement.width).toBeLessThanOrEqual(measurement.stepWidth);
  // The refusal is not a dead end: once the installation is chosen the same control is what the player presses.
  await expect(panel.getByRole("button", { name: "Enable companion play" })).toBeVisible();
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
  await expect(surface.getByRole("status")).toContainText("The chat state could not be safely reconciled.");
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

  // 1. Zero memories still explains the notebook, and the zero is readable: the
  // digits are in the sentence the player sees, not only in an element attribute
  // (the attribute is kept in step with the words, and the words are what is
  // asserted here). It states the route that exists (the player telling her), not
  // an automatic writer (see the file header and memory-notebook-promise-gate.test.mjs).
  const notebook = surface.locator("[data-memory-notebook]");
  await expect(notebook).toBeVisible();
  await expect(notebook).toContainText("This is her notebook");
  await expect(notebook).not.toContainText("writes this down");
  await expect(notebook).not.toContainText("fills in as you talk");
  const notebookCount = notebook.locator("[data-memory-count]");
  await expect(notebookCount).toContainText("Nothing written down yet (0 so far)");
  await expect(notebookCount).toHaveAttribute("data-memory-count", "0");

  // 4. Authoring is secondary: it opens on demand and does not define the surface.
  // Closed by default, but it is still a control a player finds without being told:
  // it is visible, it is the surface's last line, and its own words say what it does.
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toHaveCount(0);
  const authoringToggle = surface.locator("[data-memory-authoring-toggle]");
  await expect(authoringToggle).toBeVisible();
  await expect(authoringToggle).toHaveAttribute("aria-expanded", "false");
  await expect(authoringToggle).toContainText("Whisper something to your companion");
  await authoringToggle.click();
  await expect(authoringToggle).toHaveAttribute("aria-expanded", "true");
  await expect(surface.getByRole("textbox", { name: "Memory content" })).toBeVisible();

  // 2 + 3. Two rows, two life-flavoured badges, and a count that equals them.
  memories = [
    { handle: semanticHandle, title: "Semantic memory", content: "The farmer keeps a spare watering can by the door.", category: "semantic", status: "active", origin: "player", pinned: false },
    { handle: interactionHandle, title: "Interaction memory", content: "They shared a rainy afternoon by the sea.", category: "interaction", status: "active", origin: "companion", pinned: false },
  ];
  await surface.getByRole("button", { name: "Refresh Memory" }).click();
  const rows = surface.locator("[data-memory-state=ready] [role=listitem]");
  await expect(rows).toHaveCount(2);
  await expect(notebookCount).toContainText("2 memories written down");
  await expect(notebookCount).toHaveAttribute("data-memory-count", "2");

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
    // A pinned entry declares `modelId` too: the curated ids are suggestions it offers beside the
    // endpoint's own listing, and the player may type any id this endpoint serves.
    setupFields: ["apiKey", "modelId"],
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
  // What the endpoint's own `/models` listing served, as of the last probe. Null before one.
  let servedModels: readonly string[] | null = null;
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
    modelIds: servedModels,
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
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
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
    // The endpoint answers with its own listing, which includes the model the player named.
    servedModels = [modelId, "llama-3.1-8b", "phi-4"];
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

  // Both entries reach the same model control: the catalog entry offers its own
  // curated ids as suggestions, and the player can type any id either entry's
  // endpoint serves. The escape hatch additionally offers the API key and base URL.
  await panel.locator("#connection-provider").selectOption("openai");
  await expect(panel.locator("#connection-model-id")).toBeVisible();
  await expect(panel.locator("#connection-model-id")).toHaveAttribute("list", "connection-model-options");
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
  // The test result is legible where the endpoint and model fields are, and it says how many
  // models the endpoint offered and whether the one this record names is among them.
  await expect(panel.locator("[data-connection-row] [data-connection-model-count]")).toHaveText(
    "3 models offered; the one you picked is among them.",
  );
  // The row now offers the endpoint's own listing, so the player can pick one of those instead.
  const rowModel = panel.locator(`#connection-model-${connectionId}`);
  await expect(rowModel).toBeVisible();
  await expect(rowModel.locator("option")).toHaveCount(3);
  // ...and the draft form offers them too, beside the entries marked as suggestions.
  await expect(panel.locator("#connection-model-options option")).toHaveCount(3);
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
 * A local endpoint that needs no credential at all (design/28 §1, §5.2).
 *
 * Ollama, LM Studio and vLLM need no key, and the panel used to demand one: the fact is the
 * player's to state, and once stated the connection saves without a credential and probes ready
 * against a `/models` that asks for none.
 */
test("a local endpoint that needs no credential saves keyless and probes ready", async ({ page }) => {
  const connectionId = "K".repeat(42) + "A";
  const baseUrl = "http://127.0.0.1:11434/v1";
  const modelId = "qwen2.5-coder:7b";
  const escapeHatch = {
    providerId: "openai-compatible",
    label: "OpenAI-compatible",
    setupFields: ["apiKey", "apiKeyRequired", "baseUrl", "apiShape", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    environmentManaged: false,
  };
  const writes: Array<{ path: string; body: unknown }> = [];
  let readiness: "configured" | "ready" = "configured";

  const connectionState = () => ({
    apiVersion: 1,
    revision: 1,
    active: null,
    connections: [
      {
        connectionId,
        label: `OpenAI-compatible \u00b7 ${modelId}`,
        providerId: escapeHatch.providerId,
        providerLabel: escapeHatch.label,
        configured: true,
        readiness,
        active: false,
        modelId,
        modelLabel: modelId,
        thinkingLevel: "high",
        allowedThinkingLevels: ["low", "high", "max"],
        modelIds: [modelId, "llama-3.1-8b"],
        baseUrl,
        failure: null,
        lastCheckedAtMs: null,
      },
    ],
    providers: [escapeHatch],
  });

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
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], defaultSelectable: true }) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, async (route) => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    readiness = "ready";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, connectionId, outcome: "ready", failure: null, state: connectionState() }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("settings-surface").locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  await panel.locator("#connection-provider").selectOption("openai-compatible");
  await panel.locator("#connection-base-url").fill(baseUrl);
  await panel.locator("#connection-model-id").fill(modelId);
  // Stating that this endpoint needs no credential is one choice, and the key field goes away with it.
  await expect(panel.locator("#connection-api-key-required")).toHaveValue("required");
  await expect(panel.locator("#connection-api-key")).toBeVisible();
  await panel.locator("#connection-api-key-required").selectOption("none");
  await expect(panel.locator("#connection-api-key")).toHaveCount(0);

  await panel.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: "/api/tavern/v1/settings/connections",
    body: {
      apiVersion: 1,
      providerId: "openai-compatible",
      baseUrl,
      apiShape: "openai-completions",
      modelId,
      apiKeyRequired: false,
    },
  });

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(panel.locator("[data-connection-row]")).toContainText("Ready");
  await expect(panel.getByRole("button", { name: "Save and activate" })).toBeEnabled();
});

/**
 * The endpoint's own model listing, in the draft form and on the record, and the
 * probe still deciding whether a typed id becomes usable (design/28 §5.1, §5.3).
 *
 * The owner's comparison with SillyTavern and Liyuan came down to one thing: they
 * render the model list their endpoint serves and this product read it and threw it
 * away. Here the endpoint serves three models, the form offers them beside the two
 * curated ids it marks as suggestions, a typed id that is not among them never
 * becomes ready, and picking one that is turns the same record ready.
 *
 * Measured at both widths: the endpoint-listing select's box and the test-result note's
 * box, and that neither the surface nor the document overflows.
 */
test("the endpoint's own listing is what the form offers, and a typed id it does not serve never becomes ready", async ({ page }) => {
  const connectionId = "L".repeat(42) + "A";
  const apiKey = "sk-typed-model-secret-0001";
  const invented = "gpt-9-invented";
  const suggestions = [
    { modelId: "gpt-5.6-luna", modelLabel: "GPT-5.6 Luna", allowedThinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
    { modelId: "gpt-5.5", modelLabel: "GPT-5.5", allowedThinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
  ];
  const catalogProvider = {
    providerId: "openai",
    label: "OpenAI",
    setupFields: ["apiKey", "modelId"],
    allowedPlayerModels: suggestions,
    escapeHatch: false,
    environmentManaged: false,
  };
  // What the endpoint says it serves. `gpt-4o-mini` is served and NOT curated, which
  // is exactly the case the curated list used to make unreachable.
  const listed = ["gpt-4o-mini", "gpt-5.6-luna", "gpt-5.5"];

  const writes: Array<{ path: string; body: unknown }> = [];
  let created = false;
  let recordModelId = "";
  let readiness: "configured" | "ready" | "failed" = "configured";
  let failure: string | null = null;

  const rowModelIds = (): readonly string[] | null => (readiness === "configured" ? null : listed);
  const connectionRow = () => ({
    connectionId,
    label: `${catalogProvider.label} \u00b7 ${recordModelId}`,
    providerId: catalogProvider.providerId,
    providerLabel: catalogProvider.label,
    configured: true,
    readiness,
    active: false,
    modelId: recordModelId,
    modelLabel: recordModelId,
    thinkingLevel: "high",
    allowedThinkingLevels: ["low", "high"],
    modelIds: rowModelIds(),
    baseUrl: null,
    failure,
    lastCheckedAtMs: null,
  });
  const connectionState = () => ({
    apiVersion: 1,
    revision: 1,
    active: null,
    connections: created ? [connectionRow()] : [],
    providers: [catalogProvider],
  });

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
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], defaultSelectable: true }) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) }),
  );
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, async (route) => {
    const body = route.request().postDataJSON() as { modelId?: string };
    writes.push({ path: new URL(route.request().url()).pathname, body });
    recordModelId = body.modelId ?? suggestions[0]!.modelId;
    created = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/test$/, async (route) => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    // The probe's own answer: the endpoint listed these models, and only the model this
    // record names decides whether that is a ready connection.
    if (listed.includes(recordModelId)) {
      readiness = "ready";
      failure = null;
    } else {
      readiness = "failed";
      failure = "not_found";
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        connectionId,
        outcome: readiness === "ready" ? "ready" : "failed",
        failure,
        state: connectionState(),
      }),
    });
  });
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/model$/, async (route) => {
    const body = route.request().postDataJSON() as { modelId: string };
    writes.push({ path: new URL(route.request().url()).pathname, body });
    recordModelId = body.modelId;
    readiness = "configured";
    failure = null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectionState()) });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("settings-surface").locator("[data-connection-settings]");
  await expect(panel).toBeVisible();

  // The entry pins its endpoint, so no base URL and no API shape: one key and one model field.
  await panel.locator("#connection-provider").selectOption("openai");
  await expect(panel.locator("#connection-base-url")).toHaveCount(0);
  await expect(panel.locator("#connection-model-id")).toBeVisible();
  // Both curated ids are offered, and both say they are suggestions rather than rules.
  await expect(panel.locator("#connection-model-options option")).toHaveCount(2);
  await expect(panel.locator("#connection-model-options option").first()).toHaveAttribute(
    "label",
    `${suggestions[0]!.modelLabel} \u00b7 suggestion`,
  );

  // A typed id the endpoint does not serve is accepted as a draft and never becomes ready.
  await panel.locator("#connection-api-key").fill(apiKey);
  await panel.locator("#connection-model-id").fill(invented);
  await panel.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: "/api/tavern/v1/settings/connections",
    body: { apiVersion: 1, providerId: "openai", apiKey, modelId: invented },
  });
  // Not probed yet: no listing is claimed, so there is neither a listing select nor a count.
  await expect(panel.locator("[data-connection-model-count]")).toHaveCount(0);
  await expect(panel.locator(`#connection-model-${connectionId}`)).toHaveCount(0);

  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(2);
  // The closed outcome, named at the field it is about, and the listing it was decided against.
  await expect(panel.locator("[data-connection-failure]")).toHaveText(
    "The endpoint did not offer the selected model.",
  );
  await expect(panel.locator("[data-connection-model-count]")).toHaveText(
    `${listed.length} models offered, but not the one you picked.`,
  );
  // The record is not ready, so it cannot be activated - the invariant the probe protects.
  await expect(panel.getByRole("button", { name: "Save and activate" })).toBeDisabled();

  // The endpoint's own listing is now what the form offers, and the record offers it too.
  await expect(panel.locator("#connection-model-options option")).toHaveCount(listed.length + suggestions.length);
  const listingSelect = panel.locator(`#connection-model-${connectionId}`);
  await expect(listingSelect).toBeVisible();
  await expect(listingSelect.locator("option")).toHaveCount(listed.length + 1);

  // Picking one of the models the endpoint actually serves is a `/model` write, not a second create.
  await listingSelect.selectOption("gpt-4o-mini");
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({
    path: `/api/tavern/v1/settings/connections/${connectionId}/model`,
    body: { apiVersion: 1, expectedRevision: 1, modelId: "gpt-4o-mini", thinkingLevel: "high" },
  });

  // Tested again, the model the endpoint lists is ready, and the result says so where it stands.
  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect.poll(() => writes.length).toBe(4);
  await expect(panel.locator("[data-connection-failure]")).toHaveCount(0);
  await expect(panel.locator("[data-connection-model-count]")).toHaveText(
    `${listed.length} models offered; the one you picked is among them.`,
  );
  await expect(panel.getByRole("button", { name: "Save and activate" })).toBeEnabled();

  /** The two boxes the owner asked to be measured, plus both overflow checks. */
  const measure = async (viewport: string) =>
    await page.evaluate(
      ({ connectionId, viewport }) => {
        const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
        const box = (node: Element | null) => {
          if (node === null) return null;
          const box = node.getBoundingClientRect();
          return {
            top: Math.round(box.top),
            left: Math.round(box.left),
            width: Math.round(box.width),
            height: Math.round(box.height),
            right: Math.round(box.right),
          };
        };
        return {
          viewport,
          select: box(surface?.querySelector(`#connection-model-${connectionId}`) ?? null),
          note: box(surface?.querySelector("[data-connection-model-count]") ?? null),
          surface: box(surface),
          documentOverflows: document.documentElement.scrollWidth > window.innerWidth,
          surfaceOverflows: surface === null ? null : surface.scrollWidth > surface.clientWidth + 1,
        };
      },
      { connectionId, viewport },
    );
  const atWide = await measure("1440x900");
  console.log(`[model-listing @1440x900] ${JSON.stringify(atWide)}`);
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(panel.locator(`#connection-model-${connectionId}`)).toBeVisible();
  const atNarrow = await measure("400x800");
  console.log(`[model-listing @400x800] ${JSON.stringify(atNarrow)}`);

  for (const measured of [atWide, atNarrow]) {
    expect(measured.select, `the listing select is rendered at ${measured.viewport}`).not.toBeNull();
    expect(measured.note, `the test-result note is rendered at ${measured.viewport}`).not.toBeNull();
    expect(measured.select!.width, `the listing select keeps a usable width at ${measured.viewport}`).toBeGreaterThan(80);
    expect(measured.note!.width, `the note has a width at ${measured.viewport}`).toBeGreaterThan(0);
    expect(measured.note!.right, `the note stays inside the surface at ${measured.viewport}`).toBeLessThanOrEqual(
      measured.surface!.right + 1,
    );
    expect(measured.documentOverflows, `the document does not overflow at ${measured.viewport}`).toBe(false);
    expect(measured.surfaceOverflows, `the settings surface does not overflow at ${measured.viewport}`).toBe(false);
  }
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
    /**
     * The current companion's OWN world book, as `companion.worldbook.read` serves
     * it. Absent means the companion has no book (`present: false`), which is the
     * state a directly-named companion is in.
     */
    companionWorldBook?: Readonly<Record<string, unknown>>;
  }> = {},
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // The surface's own World Info read is this snapshot's Chat half (the Host builds
  // both from one read), so the mount re-enters through the same root the bootstrap
  // served rather than through the `GET /world-info` route it no longer reads.
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: overrides.companions ?? [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
     route.fulfill(jsonOk(overrides.companionWorldBook ?? { apiVersion: 1, present: false, revision: null, entries: [] })),
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
 * "choosing a character card file stages a review the player approves, and
 * reports what the Host kept and could not use" fails if the primary path is not
 * a real file input (the owner's complaint: a staged review ceremony *instead of*
 * a picker), if choosing a file does not post the file's own text as
 * `character.import.stage`, if the Host's staged report is not what the player
 * sees before approving it, if anything is confirmed before that approval, if the
 * review is not the Host's own eligible field set, if confirm is not CSRF-bound,
 * if the notice claims a companion the Host never confirmed, or if the "could not
 * use" list is locally invented instead of read from the Host's dispositions.
 * It also pins that the paste path still produces the same durable result.
 */
test("choosing a character card file stages a review, and reports what the Host kept and could not use", async ({
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
  // browser reads; the card text is what the Host receives, and what comes back
  // is the Host's own staged report - not a companion yet.
  await chooseCardFile(page, cardText);
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await expect(review).toContainText("The card names it Nova.");
  await expect(review).toContainText("Will keep 2 card field entries: Name, Persona.");
  await expect(review).toContainText("Carries 2 lorebook entries.");
  await expect(review).toContainText("Could not use: Alternate opening.");
  await expect(surface.locator("[data-card-import-result=created]")).toHaveCount(0);
  expect(confirms.length, "the companion was confirmed before the player approved the review").toBe(0);
  expect(reviews.length, "a review was recorded before the player approved it").toBe(0);

  await review.locator("[data-card-import-review-confirm]").click();
  await expect.poll(() => confirms.length).toBe(1);

  expect(imports[0]?.body).toEqual({ apiVersion: 1, cardSource: "json", card: cardText });
  expect(imports[0]?.csrf).toBe(csrfToken);
  const reviewedFields = (body: unknown): unknown => (body as { reviewedFields?: unknown }).reviewedFields;
  expect(reviewedFields(reviews[0]?.body)).toEqual(["name", "persona_core"]);
  expect(reviews[0]?.csrf).toBe(csrfToken);
  expect(confirms[0]?.body).toEqual({ apiVersion: 1 });
  expect(confirms[0]?.csrf).toBe(csrfToken);

  const created = surface.locator("[data-card-import-result=created]");
  await expect(created).toContainText("Imported Nova.");
  await expect(created).toContainText("Kept 2 card field entries.");
  await expect(created).toContainText("Could not use: Alternate opening.");
  await expect(review).toHaveCount(0);

  // The secondary paste path produces the same durable result as the picker,
  // and it stages the same review: the paste button is not the approval either.
  await surface.locator("[data-card-import] summary").click();
  await surface
    .getByRole("textbox", { name: "Paste card text" })
    .fill(JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } }));
  await surface.getByRole("button", { name: "Import card" }).click();
  await expect(review).toBeVisible();
  expect(confirms.length).toBe(1);
  await review.locator("[data-card-import-review-confirm]").click();
  await expect.poll(() => confirms.length).toBe(2);
  expect(reviewedFields(reviews[1]?.body)).toEqual(reviewedFields(reviews[0]?.body));
  expect(confirms[1]?.body).toEqual(confirms[0]?.body);
});

/**
 * "a staged card can be cancelled without importing anything" fails if the
 * cancel leaves a companion behind, if it records a review, or if the surface
 * keeps claiming the staged card afterwards. The durable companion list is the
 * authority: the mount reads it once and nothing in this journey may change it.
 */
test("cancelling the staged review imports nothing and leaves the companion list unchanged", async ({ page }) => {
  const cardText = JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } });
  await stubCharacterReads(page, { companions: [{ handle: characterHandle, name: "Nova", isCurrent: true }] });
  const companionReads: unknown[] = [];
  await page.route("**/api/tavern/v1/companions", async (route) => {
    companionReads.push(route.request().method());
    await route.fulfill(
      jsonOk({ apiVersion: 1, companions: [{ handle: characterHandle, name: "Nova", isCurrent: true }] }),
    );
  });
  const { imports, reviews, confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");
  const readsBefore = companionReads.length;

  await chooseCardFile(page, cardText);
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await review.locator("[data-card-import-review-cancel]").click();

  // The staged card is dropped, nothing was confirmed and no review was signed.
  await expect(review).toHaveCount(0);
  expect(imports.length, "the card was staged").toBe(1);
  expect(reviews.length, "cancel recorded a review").toBe(0);
  expect(confirms.length, "cancel confirmed the card").toBe(0);
  await expect(surface.locator("[data-card-import-result=created]")).toHaveCount(0);
  // The durable companion list is unchanged: the same single companion, and not
  // one extra read of it either - a cancel is not a mutation.
  await expect(surface.locator("[data-companion-entry]")).toContainText("Nova");
  expect(companionReads.length).toBe(readsBefore);
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
  await stubCharacterReads(page, {
    companions: [{ handle: characterHandle, name: "Nova", isCurrent: true }],
    // What the Host would serve after this card was confirmed: the companion's
    // own world book, entry by entry, with the trigger words the card supplied.
      companionWorldBook: {
        apiVersion: 1,
        present: true,
        // The durable revision the projection carries: an edit CASes on it, and the
        // client mirror rejects a book without it exactly as it rejects one without a body.
        revision: 4,
        entries: [
          // The body is part of the entry's shape and the client mirror validates
          // it exactly, so a fixture without it is rejected whole and the section
          // then renders nothing at all.
          { title: "Observatory", keys: [], constant: true, content: "The old observatory on the ridge." },
          { title: "Comet", keys: ["comet"], constant: false, content: "A comet is expected next week." },
        ],
      },
  });
  const { confirms } = await stubImportSuccess(page);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  await chooseCardFile(page, cardText);
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await expect(review).toContainText("Carries 2 lorebook entries.");
  await review.locator("[data-card-import-review-confirm]").click();
  await expect.poll(() => confirms.length).toBe(1);
  await expect(surface.locator("[data-card-import-result=created]")).toContainText("Carries 2 lorebook entries.");

  // The world book is the character's own view on the same surface: the book the
  // card carried, its count, and the words that actually reach each entry ...
  const own = surface.locator("[data-companion-world-book]");
  await expect(own).toBeVisible();
  await expect(own.locator("h3")).toHaveText("Your companion's own world book");
  await expect(own.locator("[data-companion-world-book-count]")).toHaveText("Entries in her own book: 2");
  const ownEntries = own.locator("[data-companion-world-book-entry]");
  await expect(ownEntries).toHaveCount(2);
  await expect(ownEntries.first()).toContainText("Always with her");
  await expect(ownEntries.nth(1)).toContainText("Trigger words: comet");
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
  // The refusal is reported at the confirm step: the Host's staged report is what
  // the player approves, and the 422 is what the surface shows - never a created
  // companion.
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  await review.locator("[data-card-import-review-confirm]").click();
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
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
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
  // This surface owns the level it reasons at; the model comes from the active connection.
  await expect(popout.getByLabel("Thinking level")).toHaveValue("medium");
  await expect(popout.getByRole("button", { name: "deepseek-v4" })).toHaveCount(0);
  await expect(popout.locator(".surface-model-chip").first()).toContainText("deepseek-v4");
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
 * The current peer surface is marked by a shape, not only by a colour.
 *
 * At 1440 the bar is the whole of "where am I": the surface's own `<h2>` is
 * clipped away, so a player's only on-screen answer is the nav entry carrying
 * `aria-current="page"`. What that entry had was colour - `--accent` instead of
 * `--text-secondary`, `--surface-raised` instead of transparent,
 * `--border-strong` instead of transparent - and a state that is three colour
 * steps apart from its peers is invisible to a colour-blind player and to a
 * low-contrast theme. The bar (`.nav-button.active { box-shadow: inset 0 -2px 0 0
 * currentColor }`, style.css) is the channel that does not depend on colour, and
 * being `currentColor` it adds no colour step to the sheet.
 *
 * The bar and not an absolutely positioned `::after`: a pseudo element needs
 * `position: relative` on the entry and declares `bottom` on it, which turns the
 * entry's own `transition: all` into a motion site
 * (`tests/reduced-motion-gate.test.mjs`) and owes a reduced-motion escape for a
 * bar that never moves. An inset shadow is paint, and it costs the entry no box,
 * so the 400 px strip's measured widths are what they were.
 *
 * The readings quoted below are this same journey, mounted, with the pointer
 * parked away from the bar, taken from a run with the one rule reverted:
 *
 *  - 1440, Chat current - before: `box-shadow: none`, identical to Game's, and the
 *    two differed only in colour - `color: rgb(200, 120, 125)` vs
 *    `rgb(200, 192, 182)`, `background: rgb(32, 29, 29)` vs `rgba(0, 0, 0, 0)`,
 *    `border-color: rgba(255, 255, 255, 0.15)` vs `rgba(0, 0, 0, 0)` - with
 *    `font-weight: 500` on both. After: `rgb(200, 120, 125) 0px -2px 0px 0px
 *    inset` against Game's `none`. So the assertion below is exactly the one
 *    that failed before.
 *  - 400, Memory current (one of the four folded peers) - before: `Memory` and
 *    the `More` trigger both read `box-shadow: none`, and the trigger carried no
 *    `active` state (`class="nav-button app-bar-more-trigger"`), so the strip said
 *    nothing about which of the four was showing. After: both read
 *    `rgb(200, 120, 125) 0px -2px 0px 0px inset` while the other five entries
 *    read `none`.
 *
 * Each assertion, and the failure it catches:
 *  - the selected entry draws the bar and a non-current sibling does not:
 *    catches a state that is still colour-only;
 *  - the bar is painted in the entry's own `color`: catches a bar that quietly
 *    introduced a second accent (or a hardcoded one);
 *  - `aria-current="page"` stays on exactly one entry and never on the trigger:
 *    catches the visual state drifting away from the accessible one, and a
 *    disclosure claiming to be the page;
 *  - the trigger carries the state only while the current surface is folded
 *    inside it: catches a `More` that is always lit (which would be the same
 *    "nothing on screen tells you" one state over) and one that never is;
 *  - a hovered entry draws no bar, and a keyboard-focused one draws the sheet's
 *    gold ring instead of it: catches the bar leaking out of the selected state,
 *    which would make hover, focus and current indistinguishable from each other.
 *  - hover and the current entry keep the SAME raised paint (`rgb(32, 29, 29)`
 *    on both) and differ only in colour: that is the bar with no bar, and it is
 *    why the bar - not a fourth colour - is what has to separate them.
 */
test("the current peer surface is marked by a shape in the bar, at both widths and through the More disclosure", async ({ page }) => {
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

  const readBar = () =>
    page.evaluate(() => {
      const read = (node: HTMLElement) => {
        const entry = getComputedStyle(node);
        return {
          name: node.getAttribute("aria-label"),
          current: node.getAttribute("aria-current"),
          active: node.classList.contains("active"),
          color: entry.color,
          background: entry.backgroundColor,
          weight: entry.fontWeight,
          outline: `${entry.outlineWidth} ${entry.outlineStyle} ${entry.outlineColor}`,
          bar: entry.boxShadow,
        };
      };
      const entries = [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")];
      const trigger = document.querySelector<HTMLElement>(".app-bar-more-trigger");
      return {
        entries: entries.map(read),
        trigger: trigger === null ? null : { ...read(trigger), expanded: trigger.getAttribute("aria-expanded") },
        triggerDrawn: trigger !== null && trigger.getBoundingClientRect().width > 0,
      };
    });
  /** No bar: the entry paints no shadow at all. */
  const unmarked = "none";

  // The strip this product lives in: Memory is one of the four peers that fold
  // behind `More` at 400 px, so the trigger is the only thing on screen that can
  // report it.
  await page.setViewportSize({ width: 400, height: 720 });
  await page.mouse.move(1, 700);
  await page.goto(`/#profile=composed-reference-game&panel=memory&boot=${token}`);
  await expect(page.getByTestId("memory-surface")).toBeVisible();
  // The bar's `active` state follows the shell's own `shownSurface`, which is restored from the URL after the
  // boot read settles. A fixed sleep raced it on CI: the panel painted, the entry said `current=page`, and the
  // `More` trigger had not taken the folded state yet. Waiting for the state itself, not for a duration.
  // Both facts have to hold before the snapshot is taken: the folded entry is the surface in view, and the trigger
  // reports it. Waiting for the trigger alone timed out on CI because the two are read from the same render - when the
  // entry is not yet the current one, neither is true, and the loop was watching the shadow instead of the cause.
  await expect
    .poll(
      async () => {
        const sampled = await readBar();
        const folded = sampled.entries.filter((entry) => entry.active);
        return folded.length > 0 && (sampled.trigger?.active ?? false);
      },
      { message: "the folded entry is current and the trigger carries it" },
    )
    .toBe(true);
  await page.waitForTimeout(200);

  const narrow = await readBar();
  const narrowCurrent = narrow.entries.filter((entry) => entry.current === "page");
  console.log(
    `[nav-current] 400 memory: ${narrow.entries
      .map((entry) => `${entry.name}{current=${entry.current ?? "-"} active=${entry.active} bar=${entry.bar}}`)
      .join(" ")}`,
  );
  expect(narrow.triggerDrawn, "the strip folds at 400 px").toBe(true);
  expect(narrow.trigger?.name).toBe("More");
  expect(narrowCurrent.map((entry) => entry.name)).toEqual(["Memory"]);
  expect(narrowCurrent[0]!.bar, "the folded current entry draws the bar itself").not.toBe(unmarked);
  expect(narrow.trigger?.current, "the disclosure is not the page").toBeNull();
  expect(narrow.trigger?.active, "the trigger carries the folded current surface's state").toBe(true);
  expect(narrow.trigger?.bar, "the trigger reports the surface it is hiding").toBe(narrowCurrent[0]!.bar);
  // Everything else - the rail's own two visible entries and the three peers
  // that are not current - draws nothing: the bar is the selection's alone.
  for (const entry of narrow.entries.filter((candidate) => !candidate.active))
    expect(entry.bar, `${entry.name} is not current and must not draw the bar`).toBe(unmarked);

  // Returning to a surface the rail shows directly releases the trigger: a
  // `More` that stayed lit would be the same "nothing tells you" one state over.
  await page.locator('.app-bar-actions .nav-button[aria-label="Chat"]').click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.mouse.move(1, 700);
  await page.waitForTimeout(200);
  const narrowChat = await readBar();
  console.log(
    `[nav-current] 400 chat: ${narrowChat.entries
      .map((entry) => `${entry.name}{current=${entry.current ?? "-"} active=${entry.active} bar=${entry.bar}}`)
      .join(" ")}`,
  );
  expect(narrowChat.trigger?.current, "selecting a rail surface does not mark the disclosure").toBeNull();
  expect(narrowChat.trigger?.active, "Chat is on the rail, so nothing folded is current").toBe(false);
  expect(narrowChat.trigger?.bar).toBe(unmarked);
  expect(narrowChat.entries.filter((entry) => entry.current === "page").map((entry) => entry.name)).toEqual(["Chat"]);

  // The wide bar, where the entry's own word is the only other thing that could
  // say where the player is.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(1, 890);
  await page.waitForTimeout(200);

  const wide = await readBar();
  const currentWide = wide.entries.filter((entry) => entry.current === "page");
  const selected = currentWide[0]!;
  const sibling = wide.entries.find((entry) => entry.name === "Game")!;
  console.log(
    `[nav-current] 1440 chat: ${wide.entries
      .map((entry) => `${entry.name}{current=${entry.current ?? "-"} color=${entry.color} weight=${entry.weight} bar=${entry.bar}}`)
      .join(" ")}`,
  );
  expect(wide.triggerDrawn, "the trigger is no box on a wide bar").toBe(false);
  expect(currentWide.map((entry) => entry.name), "exactly one peer reports the page").toEqual(["Chat"]);
  expect(selected.bar, "the current entry draws a bar a sibling does not").not.toBe(unmarked);
  // An inset shadow along the bottom edge, painted in the entry's own colour.
  expect(selected.bar, "the bar is inset, so it costs the entry no box").toContain("inset");
  expect(selected.bar, "the bar is the entry's own colour, not a new palette step").toContain(selected.color);
  expect(sibling.bar, "a non-current sibling in the same row draws no bar").toBe(unmarked);

  // Hover and focus keep their own channels and never draw the bar.
  await page.hover('.app-bar-actions .nav-button[aria-label="Game"]');
  await page.waitForTimeout(200);
  const hovered = (await readBar()).entries.find((entry) => entry.name === "Game")!;
  await page.locator('.app-bar-actions .nav-button[aria-label="Game"]').focus();
  // Keyboard focus has its own channel - the sheet's `:focus-visible` ring - and
  // a programmatic `.focus()` is not it, so the ring is measured the way a
  // keyboard player reaches the rail: by tabbing to it.
  for (let hop = 0; hop < 8; hop += 1) {
    await page.keyboard.press("Tab");
    if (
      await page.evaluate(() => {
        const node = document.activeElement;
        return (
          node instanceof HTMLElement && node.classList.contains("nav-button") && node.getAttribute("aria-current") === null
        );
      })
    )
      break;
  }
  // The ring is a transitioned property (`transition: all` on the entry), so the
  // reading is taken once it has settled.
  await page.waitForTimeout(200);
  const tabbed = await page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement) || !node.classList.contains("nav-button")) return null;
    const style = getComputedStyle(node);
    return {
      name: node.getAttribute("aria-label"),
      current: node.getAttribute("aria-current"),
      outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
      bar: style.boxShadow,
    };
  });
  console.log(
    `[nav-current] 1440 states: hovered Game color=${hovered.color} bg=${hovered.background} bar=${hovered.bar}; tabbed ${tabbed?.name} outline=${tabbed?.outline} bar=${tabbed?.bar}`,
  );
  expect(hovered.bar, "a hovered entry is not the current one").toBe(unmarked);
  // Hover and the current entry share one raised paint, so on a colour-blind
  // player's screen the bar is the only thing that separates them - which is
  // exactly why a hover must never draw it.
  expect(hovered.background, "hover paints the same raised surface the current entry keeps").toBe(selected.background);
  expect(hovered.color, "hover and current differ in colour, and only the bar survives that").not.toBe(selected.color);
  expect(tabbed, "Tab reaches the bar's own entries").not.toBeNull();
  expect(tabbed?.current, "a non-current entry is what the ring is measured on").toBeNull();
  expect(tabbed?.outline, "the keyboard-focused entry draws the focus ring").toContain("solid");
  expect(tabbed?.bar, "focus is not the current state").toBe(unmarked);
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
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Draft revision conflict",
            status: 409,
            code: "draft_conflict",
            requestId: handle,
            retryable: false,
          }),
        });
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
  await expect(row.getByRole("status")).toContainText("The conversation moved on since the page read it, so your change was not applied. Reload the chat to see the current state, then try again.");
  await expect(row).not.toContainText("Saved draft");
  await expect(discard).toHaveCount(0);
});

/**
 * The first screen only: a conversation that has already started offers no
 * opening row and the shell does not read the card's record for it. The failure
 * this catches: an opening affordance that survives the first message (offered
 * where it can no longer mean anything), and a shell that reads the greeting
 * record on every chat - the read itself is asserted here, not only the
 * rendering.
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
  await expect(surface.locator(".composer-chips-row")).toHaveCount(0);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);
  expect(greetingReads, "a started conversation asks for no opening material").toBe(0);
});

/**
 * The honest empty case: a card whose greeting record carries nothing (the state
 * the owner's own screenshot was taken in - "还没有保存开场白") offers no opening
 * row at all, and the surface invents none. The failure this catches: fabricated
 * starters, and a first screen that stays blank instead of falling back to the
 * conversation's own zero state.
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
 * `openingVariant`. Choosing among those variants is that message's own switcher
 * (`Default 1/2` - the Host's label for the committed variant and its position in
 * the set), which records the choice through the Host's `chat.opening` route.
 *
 * The failure this catches: a variant chooser anywhere but that switcher - a
 * composer row whose taps submitted the companion's own paragraph as the
 * player's line, which is the inverted path this replaces.
 */
test("the opening's variant switcher lives on the opening bubble, and the composer offers no opening row", async ({ page }) => {
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

  // ... and choosing among the variants is the opening bubble's own control, not
  // a composer row: the message carries the Host's unlocked switcher, worded with
  // the Host's own label for the committed variant and its position in the set.
  await expect(surface.locator(".composer-chip, .composer-chips-row")).toHaveCount(0);
  const opening = surface.locator(".message.companion").first();
  await expect(opening.locator(".swipe-indicator")).toHaveText("Default 1/2");
  await expect(opening.locator(".swipe-btn")).toHaveCount(2);
  expect(greetingReads, "the composer column reads no opening material").toBe(0);
});

/**
 * Once the player has spoken, the opening can no longer be re-chosen: the Host
 * seals it (`openingVariant.locked`), so the bubble's own variant switcher is
 * gone and the composer carries no opening row either.
 *
 * The failure this catches: a switcher that survives the first player message,
 * and a first-screen predicate that treats the companion's opening as "nothing
 * has happened yet" forever.
 */
test("the opening's variant switcher is sealed once a player message follows the opening", async ({ page }) => {
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
  // The opening is sealed once the player has spoken, so its own variant
  // switcher is gone too: the choice cannot be reopened behind the transcript.
  await expect(surface.locator(".swipe-controls")).toHaveCount(0);
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
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      { handle: secondHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === secondHandle, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
      { handle: thirdHandle, title: "Third conversation", status: "active", managementRevision: 1, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: null },
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
      return route.fulfill({
        status: selectStatus,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Chat selection conflict",
          status: selectStatus,
          code: "selection_conflict",
          requestId: handle,
          retryable: false,
        }),
      });
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

  // Clicking the already-mounted chat is not a selection: no admission at all. It is still the
  // player choosing the conversation in front of them, so it shows it and adds the list's own step
  // back rather than swallowing the gesture.
  await surface.getByTestId("chat-item").first().getByTestId("chat-select").click();
  await page.waitForTimeout(50);
  expect(selectRequests, "selecting the mounted chat must not create a second admission").toBe(0);
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );
  await page.goBack();
  await expect(surface).toBeVisible();

  // A stale generation is a bounded refusal: the failure is reported and the list re-read.
  selectStatus = 409;
  selectTarget = thirdHandle;
  const readsBefore = listReads;
  await surface.getByTestId("chat-item").nth(2).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);
  await expect(surface.getByRole("status")).toContainText("The conversation moved on since the page read it, so your change was not applied. Reload the chat to see the current state, then try again.");
  await expect.poll(() => listReads).toBeGreaterThan(readsBefore);

  // An idle switch: the Host switches the mounted conversation in process and answers `switched`, and
  // the shell adopts the target's snapshot and brings the player to it (ADR-0010 Class A - choosing a
  // conversation is a focus transfer). No restart happens anywhere, and no "next start" promise is made.
  selectStatus = 200;
  selectTarget = secondHandle;
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(2);

  // Choosing the conversation is what shows it: the Chats list is gone and the target's transcript is
  // the conversation on screen.
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText("The game projection is read-only.");

  // Browser Back returns to the list, where the chosen row is the selected one - the move added the
  // conversation's own entry rather than replacing the list's.
  await page.goBack();
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "true");

  // The now-mounted chat is chosen again: still no second admission, and the click is answered -
  // the conversation it names is what the player is looking at.
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await page.waitForTimeout(50);
  expect(selectRequests, "re-selecting the mounted chat must not create a second admission").toBe(2);
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );
});

/**
 * The row's own click, when the row IS the mounted Chat. The Host has nothing to switch to and no
 * selection may be admitted - a second admission for the Chat the runtime already holds is exactly
 * what the mounted-handle guard stops - but the gesture is still the player choosing the
 * conversation in front of them.
 *
 * The defect this pins: `selectChat` returned early on the mounted handle, so the click did nothing
 * at all. The list showed a title button, the player pressed it, and neither the surface moved nor
 * was the gesture acknowledged, while every other row moved them to its conversation.
 *
 * The assertions, and the failure each one catches:
 *  - no `chat/select` request is issued: catches the no-op turned into a request, admitting a
 *    selection for a Chat the runtime already has mounted;
 *  - the Chat surface is the shown one, carrying the mounted conversation's own heading and
 *    transcript: catches the silent no-op this test exists for;
 *  - Browser Back returns to the Chats list with that row still selected: catches a move that
 *    replaced the list's own history entry instead of adding the conversation's.
 */
test("clicking the already-mounted Chat shows it and issues no selection", async ({ page }) => {
  let selectRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
          { handle: `${'C'.repeat(42)}A`, title: "Second conversation", status: "active", managementRevision: 1, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: "She is already on the porch with the lantern." },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selectRequests += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The journey starts where the player does: the conversation, not the list.
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);
  const mountedRow = chats.getByTestId("chat-item").first();
  await expect(mountedRow).toHaveAttribute("data-selected", "true");
  await expect(mountedRow.getByTestId("chat-select")).toBeEnabled();

  await mountedRow.getByTestId("chat-select").click();

  // The click is a choice, not a selection request.
  await page.waitForTimeout(50);
  expect(selectRequests, "the already-mounted Chat must not create a selection admission").toBe(0);
  // And the choice is answered: the conversation is what the player is looking at, and it is the
  // one the row named.
  const conversation = page.getByTestId("chat-surface");
  await expect(conversation).toBeVisible();
  await expect(chats).toHaveCount(0);
  await expect(conversation.locator(".timeline-heading h1")).toHaveText("Reference Game Chat");
  await expect(conversation.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );

  // The move added the conversation's own history entry, so the list is one step back.
  await page.goBack();
  await expect(page.getByTestId("chats-surface").getByTestId("chat-item").first()).toHaveAttribute(
    "data-selected",
    "true",
  );
});

/**
 * The row is a select control across its whole surface, not only across its title.
 *
 * The measured defect: only the title line is inside `[data-testid="chat-select"]`,
 * while the preview and the stamp - the rest of the row's area, and almost all of it
 * on a phone - are outside it, so a thumb that lands on the preview does nothing at
 * all. The row's own surface now carries the same gesture its title does, and the
 * row's action buttons stop the event rather than the row wrapping them in a button
 * that would nest one control inside another.
 *
 * The assertions, and the failure each one catches:
 *  - the mounted row's preview opens the conversation with no `chat/select` request:
 *    catches the dead preview and a preview that admits a selection for the Chat the
 *    runtime already holds;
 *  - another row's preview sends the selection naming *that* row's Chat: catches a
 *    surface that selects the wrong conversation, or none;
 *  - a row's action button still only arms its own confirmation and sends no
 *    selection: catches the new surface swallowing the buttons that live inside it;
 *  - the armed confirmation is outside the surface: catches a press on the
 *    confirmation's own words selecting the Chat behind it.
 */
test("the whole Chats row selects its conversation: the preview and stamp too, never the row's own buttons", async ({
  page,
}) => {
  const secondHandle = "C".repeat(42) + "A";
  const selections: string[] = [];
  let mountedHandle = handle;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      { handle: secondHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === secondHandle, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
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
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => route.fulfill(jsonOk(listOf())));
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    const body = route.request().postDataJSON() as { chatHandle: string };
    selections.push(body.chatHandle);
    mountedHandle = body.chatHandle;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);
  const first = chats.getByTestId("chat-item").first();
  const second = chats.getByTestId("chat-item").nth(1);
  await expect(first).toHaveAttribute("data-selected", "true");

  // The preview is most of the row and it is inside the surface now, so choosing the
  // mounted conversation needs no admission - exactly as choosing its title does not.
  await first.getByTestId("chat-item-preview").click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(chats).toHaveCount(0);
  expect(selections, "the mounted Chat must not create a selection admission").toEqual([]);
  await page.goBack();
  await expect(first).toBeVisible();

  // Another row's preview names that row's conversation, and moves to it.
  await second.getByTestId("chat-item-preview").click();
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toBe(secondHandle);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );
  await page.goBack();
  await expect(first).toBeVisible();
  expect(selections.length, "returning to the list selects nothing").toBe(1);

  // The row's own action button still does only its own action: it arms the
  // confirmation in place and admits no selection.
  await first.getByRole("button", { name: "Archive", exact: true }).click();
  const confirm = first.getByTestId("chat-retention-confirm");
  await expect(confirm).toBeVisible();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  expect(selections, "the Archive button must not also select the conversation").toHaveLength(1);

  // …and the confirmation it opened is outside the surface: its own words are not a
  // second way to select the Chat behind it.
  await confirm.locator(".chat-item-confirm-prompt").click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  expect(selections, "the armed confirmation must not be inside the click surface").toHaveLength(1);
});

/**
 * Selecting a Chat is a focus transfer: the conversation it names is what the
 * player is looking at next (ADR-0010 Class A - "click another conversation and
 * it shows immediately", the behaviour ChatGPT, Claude and SillyTavern all have).
 *
 * The measured defect this pins: the row's click moved the mount, the selected
 * cursor and the live stream, but the shell stayed on the Chats list, so the
 * player had to find the Chat entry in the app bar and click it by hand to see
 * the conversation they had just chosen.
 *
 * The assertions, and the failure each one catches:
 *  - after the `switched` answer the Chat surface is the shown one and the Chats
 *    list is gone: catches a selection that only moved the cursor;
 *  - the conversation's own title and transcript are what the player sees:
 *    catches a switch that showed the Chat surface but kept the previous
 *    conversation mounted in it;
 *  - Browser Back returns to the Chats list with the chosen row selected:
 *    catches a surface move that replaced the list's history entry instead of
 *    adding the conversation's own.
 */
test("selecting a chat from the Chats list shows that conversation", async ({ page }) => {
  const secondHandle = "C".repeat(42) + "A";
  let mountedHandle = handle;
  let selectRequests = 0;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      {
        handle: secondHandle,
        title: "Second conversation",
        status: "active",
        managementRevision: 1,
        isSelected: mountedHandle === secondHandle,
        updatedAtMs: 1_760_086_400_000,
        preview: "She is already on the porch with the lantern.",
      },
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
    if (route.request().method() === "GET") return route.fulfill(jsonOk(listOf()));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    const body = route.request().postDataJSON() as { chatHandle: string };
    mountedHandle = body.chatHandle;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);

  await chats.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);

  // The chosen conversation is what the player is now looking at.
  const conversation = page.getByTestId("chat-surface");
  await expect(conversation).toBeVisible();
  await expect(chats).toHaveCount(0);
  await expect(conversation.locator(".timeline-heading h1")).toHaveText("Second conversation");
  await expect(conversation.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );

  // The list is a real step back, not a replaced entry.
  await page.goBack();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await expect(page.getByTestId("chats-surface").getByTestId("chat-item").nth(1)).toHaveAttribute(
    "data-selected",
    "true",
  );
});

/**
 * The other side of the focus transfer: a `turn_in_flight` answer is not a switch.
 * The Host deliberately stayed where it was (ADR-0010's narrow `accepted_queued`
 * window, where there is no cancel migration to abort with and the mount cannot be
 * torn down), so the shell must not move the region either - the player keeps the
 * list, the recorded selection stays durable, and the refusal is stated rather than
 * silently ignored.
 *
 * The assertions, and the failure each one catches:
 *  - the refusal notice is what the surface shows: catches a `turn_in_flight` answer
 *    being reported as a completed switch;
 *  - the Chats list is still the shown surface and no Chat surface was mounted:
 *    catches a surface move keyed on the click rather than on the Host's answer.
 */
test("a turn_in_flight selection answer leaves the player on the Chats list", async ({ page }) => {
  const secondHandle = "C".repeat(42) + "A";
  let selectRequests = 0;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      {
        handle: secondHandle,
        title: "Second conversation",
        status: "active",
        managementRevision: 1,
        isSelected: false,
        updatedAtMs: 1_760_086_400_000,
        preview: "She is already on the porch with the lantern.",
      },
    ],
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") return route.fulfill(jsonOk(listOf()));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selectRequests += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "turn_in_flight" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await chats.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);

  // The refusal is stated, and the player is still where they were.
  await expect(chats.getByRole("status")).toContainText("runtime stayed where it is");
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
});

/**
 * A Chat switch reseeds the composer from the target chat's own durable draft.
 *
 * The failure this catches: the field-seeding rule keyed only on the durable
 * revision and a local dirty flag, both of which are chat-local. Text typed in
 * one chat (or a revision that happens to match the other chat's) survived the
 * switch and sat in the new chat's box as a message the player never wrote
 * there. The field belongs to the mounted conversation, so a switch takes the
 * target's own draft as its truth - never a dirty flag from the chat just left.
 */
test("switching chats reseeds the composer from the target chat's own durable draft", async ({ page }) => {
  const secondHandle = `${'C'.repeat(42)}A`;
  const secondDraft = { apiVersion: 1, revision: 7, text: "The second chat's own draft." };
  let mountedHandle = handle;
  let selectRequests = 0;
  let sentText = "";

  const firstChat = {
    ...chat,
    operations: [
      { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
    ],
  };
  const secondChat = {
    ...firstChat,
    selection: { chatHandle: secondHandle, generation: 2, stateRevision: secondHandle },
    chat: {
      ...firstChat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: `${'E'.repeat(42)}A`,
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
      draft: { revision: secondDraft.revision, present: true },
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? firstChat : secondChat });
  const mountedDraft = () => (mountedHandle === handle ? draft : secondDraft);

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(mountedDraft())));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
          {
            handle: secondHandle,
            title: "Second conversation",
            status: "active",
            managementRevision: 1,
            isSelected: mountedHandle === secondHandle,
            updatedAtMs: 1_760_086_400_000,
            preview: "She is already on the porch with the lantern.",
          },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    const body = route.request().postDataJSON() as { chatHandle: string };
    mountedHandle = body.chatHandle;
    await route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sentText = (route.request().postDataJSON() as { text: string }).text;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: `${'P'.repeat(42)}A`, role: "player", text: sentText, locale: "und", order: 1, revision: 1 },
        turn: { handle: `${'T'.repeat(42)}A`, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  // The first chat seeds its own durable draft.
  await expect(composer).toHaveValue("A durable delegated draft.");

  // The player types something the Host has not been told about.
  await composer.fill("Unsaved line typed in the first chat");

  // Switch to the second conversation. Choosing it shows it (ADR-0010 Class A), so the composer
  // asserted below belongs to the conversation that was just mounted, not to the list.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);
  await chats.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");

  // The box shows the target chat's own draft, not the text typed in the chat
  // the player just left.
  await expect(composer).toHaveValue("The second chat's own draft.");
  await expect(composer).not.toHaveValue("Unsaved line typed in the first chat");

  // And what is sent is that draft, not the leaked text.
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sentText).toBe("The second chat's own draft.");
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
 *  - The Chats list giving way to the target's transcript: catches a Host answer that refuses the
 *    switch (the old `turn_in_flight` reading) instead of performing it, and a switch that moved the
 *    mount but left the player on the list.
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
            { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
            { handle: targetHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === targetHandle, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
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
  await expect(chatSurface.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
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

  // The switched answer moved the mount and brought the player to it: the transcript is the target's,
  // not the first chat's, and the list is gone. The reply was held 300 ms while the aborted turn
  // settled, so this also catches a switch that claimed to happen before the abort settled.
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText("The game projection is read-only.");

  // The interrupted turn's produced text survived the abort, and that turn is no longer running:
  // switching back shows both. This catches an abort that throws away what the turn had written.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  selectTarget = handle;
  selectGeneration = 2;
  await surface.getByTestId("chat-item").first().getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(2);
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(producedText);
  await expect(chatSurface.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
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
  // A profile names the level its surface reasons at: the model belongs to the active connection.
  let chatProfile = { revision: 1, thinkingLevel: "medium" };
  const gameProfile = { revision: 1, thinkingLevel: "medium" };
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
    const body = route.request().postDataJSON() as { thinkingLevel: string };
    profileWrites.push(route.request().postDataJSON());
    chatProfile = { revision: chatProfile.revision + 1, thinkingLevel: body.thinkingLevel };
    return route.fulfill(jsonOk({ apiVersion: 1, chat: chatProfile, game: gameProfile, recommendedModels }));
  });
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chats: [
            { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
            { handle: targetHandle, title: targetTitle, status: "active", managementRevision: targetTitleRevision, isSelected: false, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
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
  await popout.getByLabel("Thinking level").selectOption("high");
  await popout.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => profileWrites.length).toBe(1);
  expect(profileWrites[0]).toEqual({
    apiVersion: 1,
    surface: "chat",
    expectedRevision: 1,
    thinkingLevel: "high",
  });
  // The durable read-back is what the editor shows, and the generation is untouched.
  await expect(popout.locator('[data-model-notice="saved"]')).toBeVisible();
  await expect(popout.getByLabel("Thinking level")).toHaveValue("high");
  await expect(page.getByText("Thinking…")).toBeVisible();
  // The drawer's own close control, not Escape: the Save that just ran disabled itself and dropped
  // focus to <body>, so this asserts the surface's close affordance rather than a keyboard accident.
  await popout.getByRole("button", { name: "Close", exact: true }).click();
  await expect(popout).toHaveCount(0);

  // Class B, member two: another Chat's title.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  // Every row carries the pencil now (`chat.rename` names its target by the row's own handle), and
  // the two names stay apart: the buttons answer to "Rename Chat" and the field they open answers to
  // "Chat title", so a surface-wide lookup for either name resolves to exactly what it means.
  const renameRow = surface.getByTestId("chat-item").nth(1);
  await expect(surface.getByRole("button", { name: "Rename Chat" })).toHaveCount(2);
  await renameRow.getByRole("button", { name: "Rename Chat" }).click();
  const titleField = renameRow.getByLabel("Chat title");
  await expect(titleField).toBeVisible();
  await expect(surface.getByLabel("Chat title")).toHaveCount(1);
  await titleField.fill(renamedTitle);
  await surface.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => titleWrites.length).toBe(1);
  expect(titleWrites[0]).toEqual({
    apiVersion: 1,
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
  await expect(page.getByRole("dialog", { name: "Chat model settings" }).getByLabel("Thinking level")).toHaveValue(
    "high",
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
  // The optimistic line IS the conversation's first message, so the zero state
  // yields to it: the conversation the player just started is not still showing
  // the invitation to start one.
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);

  // …and it is already **the row** the authoritative message will be, not a
  // second shape of one: same avatar, same bubble tone and radius, same measure.
  // The defect this pins: the pending text used to be a grey box of its own, so
  // sending made the player's own line jump into a wine bubble on landing.
  const pendingRow = await readPlayerRow(optimistic);

  // The authoritative message lands: the pair collapses to exactly one message and the optimistic
  // entry is gone (never a duplicate).
  await expect(optimistic).toHaveCount(0);
  const settled = surface.locator(".message-list > li", { hasText: playerText });
  await expect(settled).toHaveCount(1);
  const settledRow = await readPlayerRow(settled);
  console.log(`[optimistic row] pending=${JSON.stringify(pendingRow)} settled=${JSON.stringify(settledRow)}`);
  expect(pendingRow.isPlayerRow, "the pending line is a player row").toBe(true);
  expect(pendingRow.hasAvatar, "and it carries the same monogram the settled row does").toBe(settledRow.hasAvatar);
  expect(pendingRow.bubbleBackground, "the bubble is the same tone before and after").toBe(settledRow.bubbleBackground);
  expect(pendingRow.bubbleRadius, "and the same shape").toBe(settledRow.bubbleRadius);
  expect(pendingRow.bubbleFontSize, "and the same type").toBe(settledRow.bubbleFontSize);
  expect(
    Math.abs(pendingRow.bubbleRight - settledRow.bubbleRight),
    `and the same right edge (${pendingRow.bubbleRight} vs ${settledRow.bubbleRight})`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(pendingRow.bubbleWidth - settledRow.bubbleWidth),
    `and the same measure (${pendingRow.bubbleWidth} vs ${settledRow.bubbleWidth})`,
  ).toBeLessThanOrEqual(8);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);

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
 * Stop's own reread is the composer's only release when the event stream is up
 * but silent.
 *
 * The failure this catches: the terminal-settle rule - an authoritative read that
 * sees a terminal turn spends the content-free pending record - applied at every
 * place the turn is read *except* `rereadChat`, which is exactly the read Stop
 * performs. The event stream is open (a live stream is what keeps the fallback
 * poll from hopping) but never delivers the terminal frame, so Stop's reread is
 * the one read that can hand the field back. A `rereadChat` that preserved
 * `pending` left the composer disabled forever behind a cancelled turn.
 */
test("Stop hands the composer back when the stream stays silent and the reread is the only settle", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${'E'.repeat(42)}A`;
  const streamCursor = `${'F'.repeat(42)}A`;
  const turnHandle = `${'T'.repeat(42)}A`;
  const playerHandle = `${'P'.repeat(42)}A`;
  const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 2, canCancel: true };
  const stoppedTurn = { handle: turnHandle, state: "cancelled", projectionRevision: 3, canCancel: false };
  const playerMessage = {
    handle: playerHandle,
    role: "player",
    text: "Wait for me here",
    locale: "und",
    order: 1,
    revision: 1,
  };
  // `idle` -> the player sends; `running` -> the Host admits the turn; `stopped`
  // -> the cancel is durable. The stream never delivers the terminal turn, so
  // only an authoritative read can move the composer out of `running`.
  let phase: "idle" | "running" | "stopped" = "idle";
  let sends = 0;
  let cancels = 0;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
        ...(phase !== "idle"
          ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
          : []),
      ],
      chat: {
        ...chat.chat,
        transcript: phase === "idle" ? chat.chat.transcript : [...chat.chat.transcript, playerMessage],
        turn: phase === "running" ? runningTurn : phase === "stopped" ? stoppedTurn : null,
      },
    },
  });

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
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__streamHandlers.push(new Map());
      }
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
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sends += 1;
    phase = "running";
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "accepted", message: playerMessage, turn: runningTurn }),
    });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    cancels += 1;
    phase = "stopped";
    await route.fulfill(jsonOk({ apiVersion: 1, disposition: "cancelled", turn: stoppedTurn }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  const stop = surface.getByRole("button", { name: "Stop", exact: true });
  // The stream is open before the send: a live, silent stream is what keeps the
  // fallback poll from hopping, so Stop's reread stays the only settle.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length))
    .toBe(1);

  await composer.fill("Wait for me here");
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  // The send published the pending record: the field is held until a settle.
  await expect(composer).toBeDisabled();

  // The Host admits the turn. The frame carries it, and the authoritative read
  // behind the frame publishes the `chat.cancel` offer.
  await page.evaluate(
    (input: { epoch: string; turn: unknown; id: string }) => {
      (window as unknown as { __emit: (i: number, t: string, d: string, e: string) => void }).__emit(
        0,
        "turn.state_changed",
        JSON.stringify({
          apiVersion: 1,
          epoch: input.epoch,
          sequence: 1,
          selectionGeneration: 1,
          eventType: "turn.state_changed",
          payload: input.turn,
        }),
        input.id,
      );
    },
    { epoch: streamEpoch, turn: runningTurn, id: `${'H'.repeat(42)}A` },
  );

  await expect(stop).toBeEnabled();
  await expect(composer).toBeDisabled();

  await stop.click();
  await expect.poll(() => cancels).toBe(1);

  // The cancelled turn is the authoritative fact, and Stop's own reread is what
  // carries it into the shell: no stream frame ever did. The composer must be
  // usable again, not left disabled behind a spent pending record.
  await expect(surface).toContainText("Reply stopped. You can send another message.");
  await expect(composer).toBeEnabled();
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

/**
 * A burst of stream frames is confirmed by one authoritative read pair, not one per frame.
 *
 * The measured defect: `message.committed` and `turn.state_changed` each performed
 * `GET /state` and then `GET /draft`, so a burst paid two serial round trips per
 * frame and the queue of reads outran the stream it was confirming - the state
 * lagged the very frames it was meant to confirm.
 *
 * The two directions this pins:
 *  - N frames must not produce N state reads and N draft reads;
 *  - the last frame's own state must still land. The first read is served the
 *    durable state at the moment it was dispatched, which is before the final
 *    frame exists - so only a read issued *after* that frame carries the committed
 *    reply. A coalescer that drops its pending pass leaves the surface on the
 *    intermediate projection forever, and the reply row never appears.
 *
 * A recovery during the burst would also show up here: `__streams` stays at one
 * connection, so the frames that arrive while a read is in flight were threaded
 * into the session's checkpoint rather than rejected as a gap.
 */
test("a burst of stream frames costs one read pair plus one, and the last frame's state still lands", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${'E'.repeat(42)}A`;
  const streamCursor = `${'F'.repeat(42)}A`;
  const frames = 12;
  const turnHandle = `${'T'.repeat(42)}A`;
  const replyHandle = `${'R'.repeat(42)}A`;
  const replyText = "The last frame's own state.";
  const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true };
  const completedTurn = { handle: turnHandle, state: "completed", projectionRevision: 2, canCancel: false };
  // The Host's durable effect of the burst: the turn is running for every frame
  // but the last, and the last frame is what commits the companion's reply.
  let turnRunning = false;
  let replyCommitted = false;
  let stateReads = 0;
  let draftReads = 0;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
      chat: {
        ...chat.chat,
        transcript: replyCommitted
          ? [
              ...chat.chat.transcript,
              { handle: replyHandle, role: "companion", text: replyText, locale: "und", order: 1, revision: 2 },
            ]
          : chat.chat.transcript,
        turn: replyCommitted ? completedTurn : turnRunning ? runningTurn : null,
      },
    },
  });

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
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__streamHandlers.push(new Map());
      }
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
      for (const handler of state.__streamHandlers[index]?.get(type) ?? []) handler({ data, lastEventId: id, type });
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    stateReads += 1;
    // Served from the durable state this read was dispatched against - captured
    // now, so the answer cannot borrow the state of a later frame.
    const body = projection();
    // The burst is delivered while this read is in flight: that window is what the
    // coalescing is about, and it is what makes the intermediate answer the one a
    // dropped pending pass would leave on screen.
    if (stateReads === 1) await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill(jsonOk(body));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill(jsonOk(draft));
  });

  const streamCount = async (): Promise<number> =>
    await page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length);
  // A tally of what the browser actually put on the wire, beside the route counts:
  // the two must agree, so neither a route that answered without a request nor a
  // read this surface made off the intercepted paths can hide in the numbers.
  const statePath = "/api/composed-reference-game/v1/state";
  const draftPath = "/api/tavern/v1/draft";
  const wireRequests: string[] = [];
  page.on("request", (request) => wireRequests.push(new URL(request.url()).pathname));
  const wireCounts = (from: number) => ({
    state: wireRequests.slice(from).filter((pathname) => pathname === statePath).length,
    draft: wireRequests.slice(from).filter((pathname) => pathname === draftPath).length,
  });
  // A cursor is a canonical opaque handle, so the frames carry real ones: 43 chars
  // whose final base64url character has its two spare bits clear.
  const cursorSuffixes = "AEIMQUYcgkosw048";
  const burst = (from: number, to: number): Array<{ data: string; id: string }> => {
    const sent: Array<{ data: string; id: string }> = [];
    for (let sequence = from; sequence <= to; sequence += 1) {
      sent.push({
        id: `${'H'.repeat(42)}${cursorSuffixes[sequence - 1]}`,
        data: JSON.stringify({
          apiVersion: 1,
          epoch: streamEpoch,
          sequence,
          selectionGeneration: 1,
          eventType: "turn.state_changed",
          payload: sequence === frames ? completedTurn : runningTurn,
        }),
      });
    }
    return sent;
  };
  // One synchronous delivery: every frame of the list reaches the surface in the
  // same task, which is the burst the defect could not keep up with.
  const emit = async (sent: Array<{ data: string; id: string }>): Promise<void> => {
    await page.evaluate((input: Array<{ data: string; id: string }>) => {
      for (const item of input) {
        (window as unknown as { __emit: (i: number, t: string, d: string, e: string) => void }).__emit(
          0,
          "turn.state_changed",
          item.data,
          item.id,
        );
      }
    }, sent);
  };

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect.poll(streamCount).toBe(1);
  // The mount's own reads are not the burst's cost.
  const baseline = { state: stateReads, draft: draftReads };
  const wireBaseline = wireRequests.length;

  turnRunning = true;
  await emit(burst(1, frames - 1));
  replyCommitted = true;
  await emit(burst(frames, frames));

  // The final frame's own state landed: the reply the intermediate projection did
  // not have is on screen.
  const reply = page.locator(`li[data-handle='${replyHandle}']`);
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(replyText);

  const measured = { state: stateReads - baseline.state, draft: draftReads - baseline.draft };
  const wire = wireCounts(wireBaseline);
  console.log(
    `sse-coalesce: ${frames} frames -> route state=${measured.state} draft=${measured.draft}, wire state=${wire.state} draft=${wire.draft}; one pair per frame would be state=${frames} draft=${frames}`,
  );
  expect(measured).toEqual({ state: 2, draft: 2 });
  expect(wire).toEqual(measured);
  // No gap was manufactured by the frames that arrived mid-read: the burst needed
  // no recovery and no reconnect.
  expect(await streamCount()).toBe(1);
  await expect(surface).not.toContainText("Unable to read chat");
});

/**
 * One player row's own shape, read from the row itself.
 *
 * It exists so the send journey can compare the optimistic row with the settled
 * one on the things a player actually sees change: the monogram beside the
 * bubble, the bubble's tone, radius, type and measure.
 */
async function readPlayerRow(row: import("@playwright/test").Locator) {
  return await row.evaluate((node) => {
    // The caller may hand this either the row itself or the block that carries it
    // (the optimistic line's marker element wraps the row), so the row is found
    // rather than assumed.
    const element = node.classList.contains("message") ? node : (node.querySelector(".message") ?? node);
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const avatar = element.querySelector<HTMLElement>(".avatar");
    const box = bubble?.getBoundingClientRect() ?? null;
    const style = bubble === null || bubble === undefined ? null : getComputedStyle(bubble);
    return {
      isPlayerRow: element.classList.contains("player"),
      hasAvatar: avatar !== null && (avatar.textContent ?? "").trim().length > 0,
      bubbleBackground: style?.backgroundColor ?? null,
      bubbleRadius: style?.borderRadius ?? null,
      bubbleFontSize: style?.fontSize ?? null,
      bubbleWidth: Math.round(box?.width ?? 0),
      bubbleRight: Math.round(box?.right ?? 0),
    };
  });
}

/**
 * The first-run handoff, measured against design/research/game-first-run-review-2026-10-21.md: three
 * places where the panel only said what to do after the player had already done it wrong, or said
 * nothing at all. Each assertion fails against the copy those screens shipped.
 */

test("step 1 numbers its two controls, so their order is read before either is pressed", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/?step-one-order=1#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const order = panel.getByTestId("game-guide-step-one-order");
  await expect(order).toBeVisible();

  // Both controls, before anything is pressed, in the one order the Host accepts them in.
  await expect(order.getByRole("listitem")).toHaveCount(2);
  const offered = await order
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-testid")));
  expect(offered, "activation is offered before setup, which is the order the Host refuses in reverse").toEqual([
    "game-activate",
    "game-setup",
  ]);

  // The step says so in words, and the two controls are an ordered list, so the order is the list's
  // own semantics rather than a convention the copy has to carry alone.
  await expect(panel.locator('[data-guide-step="1"] .game-guide-step-detail')).toContainText(
    "enable companion play, then set up Stardew Valley",
  );
  expect(await order.evaluate((node) => node.tagName), "an ordered list is what makes the order readable").toBe("OL");
});

test("a cabin list read before the game started says what happened, and why reloading fixes it", async ({ page }) => {
  // The shape a launch leaves behind: a Player Host instance exists, so the handoff no longer reads as
  // "there is no session yet" - the read that failed ran when the page opened.
  const launched = {
    ...root,
    game: {
      ...game,
      game: {
        ...game.game,
        instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 },
        connectionStatus: "active",
        actionAuthority: "active",
        capabilitySummary: { available: true, count: 1 },
      },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(launched) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(launched) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_handoff_unavailable" }),
    }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/?after-launch=1#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const handoff = page.locator(".stardew-cabin-handoff");
  await expect(handoff).toContainText("Cabins can only be read while the game you launched is starting up");
  // What happened (the read ran when the page opened), what to do, and that doing it costs nothing.
  await expect(handoff).toContainText("reload this page to pick a cabin");
  await expect(handoff).toContainText("the game keeps running");
  await expect(handoff, "no internal vocabulary reaches the player").not.toContainText("Host");
  // A state with a next step, not a fault: a warning tone here taught the player that a correct first
  // run had broken.
  expect(await handoff.locator("[data-tone]").first().getAttribute("data-tone")).toBe("info");
});

test("an empty cabin list names the next step instead of only the absence", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/?empty-cabins=1#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const handoff = page.locator(".stardew-cabin-handoff");
  await expect(handoff).toContainText("no empty cabin");
  await expect(handoff, "the player is told what to build and where").toContainText("Robin's carpenter shop");
  await expect(handoff, "and how the new cabin reaches this list").toContainText("reload this page to choose it");
  await expect(handoff).not.toContainText("No cabins are currently available.");
});
