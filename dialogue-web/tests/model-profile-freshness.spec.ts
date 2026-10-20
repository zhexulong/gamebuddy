/**
 * One durable model-profile authority, three editors, and whether they can disagree.
 *
 * `ModelProfileStore` (`<runtimeRoot>/settings/model-profiles.json`) is the one
 * record; three UI entries write it through the same contract operations
 * (`readModelProfiles` / `updateModelProfile`, `GET`/`PUT
 * /api/tavern/v1/settings/profiles`):
 *
 *  - the **Game** surface's `<SurfaceModelSettings surface="game">` (GameSurface.tsx);
 *  - the **Chat** composer's drawer, `<SurfaceModelSettings surface="chat">`
 *    (ComposedReferenceGameApp.tsx, testid `chat-model-drawer`);
 *  - the **Settings** surface's `ModelProfilesPanel`, one editor per surface
 *    (management-panels.tsx).
 *
 * These journeys save in one entry and then read what the other two SHOW, so the
 * freshness claim is measured rather than assumed: the value each entry displays,
 * and whether it needed a remount (a fresh `GET`) to catch up. They also pin the
 * key each entry edits, read from the DOM the player sees, so an entry can never
 * be quietly pointed at the other surface's profile.
 *
 * The construction-time fact (the game runtime reads its profile when a session
 * is constructed, so an edit lands on the next session) is a report item, not a
 * behavior here: the save notice (`modelProfilesApplied`) already says it, and
 * this file asserts only that the notice is the one the player sees.
 */
import { type Page, expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 4, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: {
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
  },
};

const recommendedModels = [
  {
    providerId: "cpa-oai",
    providerLabel: "CPA OAI",
    modelId: "deepseek-v4",
    modelLabel: "DeepSeek V4",
    allowedThinkingLevels: ["off", "low", "high"],
    defaultThinkingLevel: "low",
  },
];

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

type Surface = "chat" | "game";

/** One mounted Host session's model-profile store, at the wire the product uses. */
type ProfileMount = Readonly<{
  store: Record<Surface, { revision: number; modelId: string; thinkingLevel: string }>;
  puts: ReadonlyArray<Record<string, unknown>>;
  gets: { count: number };
}>;

/**
 * Mounts the composed shell with a mutable profile store behind
 * `/api/tavern/v1/settings/profiles`, and the readiness stubs the nav needs.
 * Every GET is counted, so "did it re-read" is a measurement rather than a guess.
 */
async function mountWithProfiles(page: Page, seed: { chat: string; game: string }): Promise<ProfileMount> {
  const store: ProfileMount["store"] = {
    chat: { revision: 1, modelId: seed.chat, thinkingLevel: "low" },
    game: { revision: 1, modelId: seed.game, thinkingLevel: "low" },
  };
  const puts: Array<Record<string, unknown>> = [];
  const gets = { count: 0 };
  const profilesBody = () => ({ apiVersion: 1, chat: store.chat, game: store.game, recommendedModels });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200({ apiVersion: 1, revision: 4, text: null })));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(json200({ revision: 1, locale: "en-US" })));
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(json200({ devices: [], defaultSelectable: true })));
  // A mounted profile without the connection routes: the Settings surface still
  // renders its model profiles (the read-probe is per group).
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
  );
  await page.route("**/api/tavern/v1/settings/profiles", async (route) => {
    if (route.request().method() === "GET") {
      gets.count += 1;
      await route.fulfill(json200(profilesBody()));
      return;
    }
    const command = route.request().postDataJSON() as {
      surface: Surface;
      expectedRevision: number;
      modelId: string;
      thinkingLevel: string;
    };
    puts.push(command);
    const current = store[command.surface];
    if (command.expectedRevision !== current.revision) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "settings_revision_conflict" }) });
      return;
    }
    store[command.surface] = { revision: current.revision + 1, modelId: command.modelId, thinkingLevel: command.thinkingLevel };
    await route.fulfill(json200(profilesBody()));
  });

  return { store, puts, gets };
}

/** The Game surface's own editor, read through the DOM the player sees. */
function gameSurfaceEditor(page: Page) {
  return page.getByTestId("game-surface").locator('.surface-model-settings[data-surface="game"]');
}

/** The Chat drawer's editor. */
function chatDrawerEditor(page: Page) {
  return page.getByTestId("chat-model-drawer").locator('.surface-model-settings[data-surface="chat"]');
}

/** The Settings surface's per-surface editors. */
function settingsEditor(page: Page, surface: Surface) {
  return page.getByTestId("settings-surface").locator(`.model-profile-editor[data-model-profile-surface="${surface}"]`);
}

/**
 * The Game entry and the Settings entry both write `"game"`.
 *
 * Sequence: Settings saves `game` → Game surface; Game surface saves `game` →
 * Settings. The value each entry shows after the switch is the durable one, and
 * each switch is one fresh read (the counter proves the remount).
 */
test("the Settings game profile and the Game surface's editor show each other's writes", async ({ page }) => {
  const mount = await mountWithProfiles(page, { chat: "chat-initial", game: "game-initial" });

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const settings = page.getByTestId("settings-surface");
  await expect(settings).toBeVisible();
  const gameEditor = settingsEditor(page, "game");
  await expect(gameEditor).toBeVisible();
  await expect(gameEditor.locator("h3")).toHaveText("Game companion");
  await expect(gameEditor.locator("#model-profile-model-game")).toHaveValue("game-initial");
  const readsBeforeSettingsSave = mount.gets.count;

  await gameEditor.locator("#model-profile-model-game").fill("written-by-settings");
  await gameEditor.getByRole("button", { name: "Save Game companion" }).click();
  await expect.poll(() => mount.puts.length).toBe(1);
  expect(mount.puts[0]).toEqual({
    apiVersion: 1,
    surface: "game",
    expectedRevision: 1,
    modelId: "written-by-settings",
    thinkingLevel: "low",
  });
  await expect(gameEditor.locator("#model-profile-model-game")).toHaveValue("written-by-settings");
  // The Settings entry's own write re-reads nothing: its validated read-back is
  // the durable value (management-surface-panels.tsx:1262).
  expect(mount.gets.count, "the Settings entry re-read after its own save").toBe(readsBeforeSettingsSave);

  // The Game entry is a different mount, reached by a surface switch. It must
  // show the Settings entry's write, not the value it seeded with.
  const readsBeforeGame = mount.gets.count;
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const surfaceEditor = gameSurfaceEditor(page);
  await expect(surfaceEditor).toBeVisible();
  await expect(surfaceEditor.locator("h3")).toHaveText("Game companion");
  await expect(surfaceEditor.getByLabel("Model ID")).toHaveValue("written-by-settings");
  expect(mount.gets.count, "the Game entry issued its own fresh read on mount").toBe(readsBeforeGame + 1);
  console.log(`[profile-freshness] settings->game: entry shows ${await surfaceEditor.getByLabel("Model ID").inputValue()}`);

  // ...and the write travels back the other way.
  const readsBeforeSettingsReturn = mount.gets.count;
  await surfaceEditor.getByLabel("Model ID").fill("written-by-game-surface");
  await surfaceEditor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => mount.puts.length).toBe(2);
  expect(mount.puts[1]).toEqual({
    apiVersion: 1,
    surface: "game",
    expectedRevision: 2,
    modelId: "written-by-game-surface",
    thinkingLevel: "low",
  });
  await expect(surfaceEditor.getByLabel("Model ID")).toHaveValue("written-by-game-surface");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const returnedGameEditor = settingsEditor(page, "game");
  await expect(returnedGameEditor.locator("#model-profile-model-game")).toHaveValue("written-by-game-surface");
  expect(mount.gets.count, "the Settings entry issued its own fresh read on remount").toBe(readsBeforeSettingsReturn + 1);
  console.log(
    `[profile-freshness] game->settings: entry shows ${await returnedGameEditor.locator("#model-profile-model-game").inputValue()}`,
  );
});

/**
 * The Chat drawer and the Settings entry both write `"chat"`.
 *
 * The drawer must be closed before the AppBar is reachable (its backdrop covers
 * the shell), so the Chat entry is a fresh mount each time it is opened - which
 * is exactly the freshness this journey measures, in both directions.
 */
test("the Chat drawer's chat profile and the Settings chat editor show each other's writes", async ({ page }) => {
  const mount = await mountWithProfiles(page, { chat: "chat-initial", game: "game-initial" });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  await page.getByTestId("chat-model-trigger").click();
  const drawerEditor = chatDrawerEditor(page);
  await expect(drawerEditor).toBeVisible();
  await expect(drawerEditor.locator("h3")).toHaveText("Chat");
  await expect(drawerEditor.getByLabel("Model ID")).toHaveValue("chat-initial");

  await drawerEditor.getByLabel("Model ID").fill("written-by-chat-drawer");
  await drawerEditor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => mount.puts.length).toBe(1);
  expect(mount.puts[0]).toEqual({
    apiVersion: 1,
    surface: "chat",
    expectedRevision: 1,
    modelId: "written-by-chat-drawer",
    thinkingLevel: "low",
  });
  await expect(drawerEditor.getByLabel("Model ID")).toHaveValue("written-by-chat-drawer");
  // The player is told the edit lands on the next runtime start, in this exact
  // notice (i18n.ts `modelProfilesApplied`).
  await expect(drawerEditor.locator("[data-model-notice]")).toHaveText(
    "Saved. It applies the next time that surface's runtime starts.",
  );

  // The drawer's backdrop covers the shell, so the AppBar cannot switch surfaces
  // while it is open - which is what keeps the Chat entry and the Settings entry
  // from ever being mounted at the same time (the freshness this file measures).
  // Measured, not assumed: a trial click asserts the entry is not reachable.
  let appBarReachable = true;
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click({ trial: true, timeout: 1_500 });
  } catch {
    appBarReachable = false;
  }
  expect(appBarReachable, "the drawer backdrop must intercept the AppBar entry while it is open").toBe(false);

  // It closes through its own affordance. The close button is used rather than
  // Escape: the Save button is disabled while saving, which drops focus to <body>,
  // so Escape would have no drawer to reach - a real affordance question, but not
  // the freshness this journey measures.
  await page.getByTestId("chat-model-drawer").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("chat-model-drawer")).toHaveCount(0);

  const readsBeforeSettings = mount.gets.count;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const chatEditor = settingsEditor(page, "chat");
  await expect(chatEditor.locator("h3")).toHaveText("Chat");
  await expect(chatEditor.locator("#model-profile-model-chat")).toHaveValue("written-by-chat-drawer");
  expect(mount.gets.count, "the Settings entry issued its own fresh read on mount").toBe(readsBeforeSettings + 1);
  console.log(`[profile-freshness] chat drawer->settings: entry shows ${await chatEditor.locator("#model-profile-model-chat").inputValue()}`);

  await chatEditor.locator("#model-profile-model-chat").fill("written-by-settings");
  await chatEditor.getByRole("button", { name: "Save Chat" }).click();
  await expect.poll(() => mount.puts.length).toBe(2);
  expect(mount.puts[1]).toEqual({
    apiVersion: 1,
    surface: "chat",
    expectedRevision: 2,
    modelId: "written-by-settings",
    thinkingLevel: "low",
  });

  const readsBeforeDrawer = mount.gets.count;
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByTestId("chat-model-trigger").click();
  const reopened = chatDrawerEditor(page);
  await expect(reopened.getByLabel("Model ID")).toHaveValue("written-by-settings");
  expect(mount.gets.count, "the drawer issued its own fresh read on open").toBe(readsBeforeDrawer + 1);
  console.log(`[profile-freshness] settings->chat drawer: entry shows ${await reopened.getByLabel("Model ID").inputValue()}`);
});

/**
 * The entries edit their own key: a save on one surface never bleeds into the
 * other's displayed profile.
 *
 * The failure this catches: an entry editing (or reading) the wrong key would
 * make a `game` write appear as a `chat` value, which the cross-key read below
 * would show.
 */
test("each entry edits its own key and a save on one surface leaves the other's displayed profile untouched", async ({ page }) => {
  const mount = await mountWithProfiles(page, { chat: "chat-initial", game: "game-initial" });

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const settings = page.getByTestId("settings-surface");
  await expect(settings).toBeVisible();
  await expect(settingsEditor(page, "chat").locator("#model-profile-model-chat")).toHaveValue("chat-initial");
  await expect(settingsEditor(page, "game").locator("#model-profile-model-game")).toHaveValue("game-initial");
  // The panel is on the Settings surface, and each editor names the surface it
  // edits, so "Game companion" here is the same key the Game surface edits - not
  // a second, mislabelled profile.
  await expect(settingsEditor(page, "game").locator("h3")).toHaveText("Game companion");

  // A Settings write to `game` only moves the `game` profile.
  await settingsEditor(page, "game").locator("#model-profile-model-game").fill("game-only");
  await settingsEditor(page, "game").getByRole("button", { name: "Save Game companion" }).click();
  await expect.poll(() => mount.puts.length).toBe(1);
  expect(mount.puts[0]).toMatchObject({ surface: "game" });
  await expect(settingsEditor(page, "chat").locator("#model-profile-model-chat")).toHaveValue("chat-initial");
  expect(mount.store.chat.modelId).toBe("chat-initial");
  expect(mount.store.game.modelId).toBe("game-only");

  // The Chat entry still shows the chat profile, untouched by the game write.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByTestId("chat-model-trigger").click();
  await expect(chatDrawerEditor(page).getByLabel("Model ID")).toHaveValue("chat-initial");
  console.log(`[profile-freshness] cross-key: chat entry shows ${await chatDrawerEditor(page).getByLabel("Model ID").inputValue()} after a game-only write`);
});
