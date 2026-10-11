/**
 * TEMPORARY lane probe (deleted before the change lands).
 *
 * The mounted-management spec needs a built production generation under
 * host/dist, which this lane must not touch. This probe drives the same
 * ManagementApp through vite with fully route-mocked `/api/tavern/v1/*`
 * responses, the way the composed spec mocks its own routes, so the shared
 * management panels can be exercised on the management surface: the seed of the
 * companion language, the Chats rename (including the session's title fold), the
 * Memory authoring path and the World Info bind through the mounted snapshot.
 */
import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const worldInfoItemHandle = `${"V".repeat(42)}A`;
const memoryRevision = `${"M".repeat(42)}A`;
const memoryNextRevision = `${"P".repeat(42)}A`;
const worldInfoRevision = `${"W".repeat(42)}A`;
const worldInfoNextRevision = `${"X".repeat(42)}A`;
const memoryHandle = `${"N".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

// The composed product root, mirroring the composed spec's own fixture: a real
// composed Chat projection (whose Memory and World Info capability fields are
// the frozen reference contract's) plus a redacted Game projection.
const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira" },
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

const composedDraft = { apiVersion: 1, revision: 4, text: "A durable delegated draft." };

const operations = [
  { operationId: "draft.save", labelKey: "tavern.operation.draft.save", availability: "available", routeId: "draft.save" },
  { operationId: "draft.discard", labelKey: "tavern.operation.draft.discard", availability: "available", routeId: "draft.discard" },
  { operationId: "chat.rename", labelKey: "tavern.operation.rename", availability: "available", routeId: "chat.rename" },
  { operationId: "memory.mutate", labelKey: "tavern.operation.memory.mutate", availability: "available", routeId: "memory.mutate" },
  { operationId: "world-info.bind", labelKey: "tavern.operation.world-info.bind", availability: "available", routeId: "world-info.bind" },
  { operationId: "chat.archive", labelKey: "tavern.operation.chat.archive", availability: "available", routeId: "chat.archive" },
  { operationId: "chat.trash", labelKey: "tavern.operation.chat.trash", availability: "available", routeId: "chat.trash" },
] as const;

function worldInfo(selected: boolean, revision: string) {
  return {
    state: selected ? "selected" : "none",
    revision,
    items: [
      {
        handle: worldInfoItemHandle,
        title: "Pelican Town",
        summary: null,
        selected,
        pending: false,
      },
    ],
  };
}

function snapshot(worldInfoState: ReturnType<typeof worldInfo>) {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern-management.chat-list-title" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations,
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira" },
      title: null,
      transcript: [],
      draft: { revision: 4, present: true },
      turn: null,
      worldInfo: worldInfoState,
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: memoryRevision },
    eventStream: null,
  };
}

test("the management surface mounts the shared panels: language seed, Chats rename, Memory authoring and the World Info bind", async ({ page }) => {
  let worldInfoState = worldInfo(false, worldInfoRevision);
  const languageWrites: unknown[] = [];
  const titleWrites: unknown[] = [];
  const memoryWrites: unknown[] = [];
  const bindingWrites: unknown[] = [];
  const strayRequests: string[] = [];
  let memories: unknown[] = [];

  await page.route("**/api/tavern/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot(worldInfoState)) }),
  );
  await page.route("**/api/tavern/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot(worldInfoState)) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable draft." }) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: null, status: "active", managementRevision: 1, isSelected: true }],
      }),
    }),
  );
  await page.route("**/api/tavern/v1/chat/title", async (route) => {
    titleWrites.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, title: "A probe title", managementRevision: 2 }),
    });
  });
  await page.route("**/api/tavern/v1/memory", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ apiVersion: 1, projectionRevision: memoryRevision, memories }),
      });
      return;
    }
    memoryWrites.push(route.request().postDataJSON());
    memories = [
      {
        handle: memoryHandle,
        title: "Semantic memory",
        content: "A memory written by the shared panel.",
        category: "semantic",
        status: "active",
        origin: "player",
        pinned: false,
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, projectionRevision: memoryNextRevision, memories }),
    });
  });
  await page.route("**/api/tavern/v1/world-info", async (route) => {
    bindingWrites.push(route.request().postDataJSON());
    const bound = (route.request().postDataJSON() as { sourceHandle: string | null }).sourceHandle;
    worldInfoState = worldInfo(bound !== null, bound === null ? worldInfoRevision : worldInfoNextRevision);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(worldInfoState) });
  });
  await page.route("**/api/tavern/v1/settings/language", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 0, locale: null }) });
      return;
    }
    languageWrites.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, locale: "en-US" }) });
  });
  for (const unavailable of ["settings/voice-preference", "settings/voice-devices", "settings/connection", "settings/profiles", "companions"]) {
    await page.route(`**/api/tavern/v1/${unavailable}`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
    );
  }
  for (const stray of ["messages", "events", "persona", "scenario", "greeting"]) {
    await page.route(`**/api/tavern/v1/${stray}*`, (route) => {
      strayRequests.push(stray);
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
    });
  }

  await page.goto(`/#profile=management&boot=${token}`);
  await expect(page.locator("[data-language-settings]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chats", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Memory", exact: true })).toBeVisible();

  // The never-configured companion language is seeded from the display language,
  // exactly once, and the control shows the durable read-back.
  await expect(page.locator("#companion-language")).toHaveValue("en-US");
  await expect.poll(() => languageWrites.length).toBe(1);
  expect(languageWrites[0]).toEqual({ expectedRevision: 0, locale: "en-US" });
  // A profile whose voice routes are absent says so instead of showing controls.
  await expect(page.locator("[data-voice-settings]")).toContainText("Voice settings are unavailable");

  // The Chats drawer is the same panel the composed shell's Chats surface mounts.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Chats" });
  await expect(drawer.getByText("New chat", { exact: true })).toBeVisible();
  await drawer.getByTitle("Rename Chat").click();
  await drawer.locator("input.form-input").fill("A probe title");
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => titleWrites.length).toBe(1);
  expect(titleWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    chatHandle,
    expectedManagementRevision: 1,
    title: "A probe title",
  });
  await expect(drawer.getByText("A probe title", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Saved successfully.");
  // The rename read-back is folded into the mounted session, so the transcript
  // heading follows it without a reload.
  await expect(page.getByRole("heading", { name: "A probe title" })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();

  // Memory authoring on the management surface goes through the same panel.
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.locator("[data-memory-panel]")).toBeVisible();
  await expect(page.locator("[data-memory-state=empty]")).toBeVisible();
  await page.getByRole("textbox", { name: "Memory content" }).fill("A memory written by the shared panel.");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => memoryWrites.length).toBe(1);
  expect(memoryWrites[0]).toEqual({
    apiVersion: 1,
    operation: "create",
    expectedProjectionRevision: memoryRevision,
    content: "A memory written by the shared panel.",
  });
  await expect(page.getByText("A memory written by the shared panel.", { exact: true })).toBeVisible();

  // World Info binds from the mounted snapshot and re-reads it, so the panel
  // shows the authoritative revision rather than the local click.
  const binding = page.locator("[data-world-info-binding]");
  await expect(binding.getByRole("button", { name: "Bind: Pelican Town" })).toBeEnabled();
  await binding.getByRole("button", { name: "Bind: Pelican Town" }).click();
  await expect.poll(() => bindingWrites.length).toBe(1);
  expect(bindingWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: worldInfoRevision,
    sourceHandle: worldInfoItemHandle,
  });
  await expect(binding.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
  await expect(page.getByRole("status")).toContainText("Saved successfully.");

  expect(strayRequests).toEqual([]);
});

/**
 * The composed shell's Chats surface: the same panel, over the same route, and
 * the rename moves this shell's own Chat projection through the composed
 * `/state` read (the shell cannot fold a management read-back into the frozen
 * reference Chat session by hand).
 */
test("the product Chats surface renames through chat/title and moves the conversation heading from the composed state", async ({ page }) => {
  const titleWrites: unknown[] = [];
  const composedStateReads = { count: 0 };
  let rootTitle: string | null = null;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...composedRoot, chat: { ...composedChat, chat: { ...composedChat.chat, title: rootTitle } } }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    composedStateReads.count += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...composedRoot, chat: { ...composedChat, chat: { ...composedChat.chat, title: rootTitle } } }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: rootTitle, status: "active", managementRevision: 1, isSelected: true }],
      }),
    }),
  );
  await page.route("**/api/tavern/v1/chat/title", async (route) => {
    titleWrites.push(route.request().postDataJSON());
    rootTitle = "A renamed product chat";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, title: rootTitle, managementRevision: 2 }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect(surface.getByText("New chat", { exact: true })).toBeVisible();
  // The mount cannot see the management profile's operation projection, so the
  // served list is the capability: the rename and the selected chat's retention
  // controls are shown rather than silently hidden.
  await expect(surface.getByTitle("Rename Chat")).toBeVisible();
  await expect(surface.getByRole("button", { name: "Archive", exact: true })).toBeVisible();

  await surface.getByTitle("Rename Chat").click();
  await surface.locator("input.form-input").fill("A renamed product chat");
  await surface.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => titleWrites.length).toBe(1);
  expect(titleWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    chatHandle,
    expectedManagementRevision: 1,
    title: "A renamed product chat",
  });
  await expect(surface.getByText("A renamed product chat", { exact: true })).toBeVisible();
  await expect(surface.getByRole("status")).toContainText("Saved successfully.");
  // The rename reaches this shell's Chat projection through the composed state.
  await expect.poll(() => composedStateReads.count).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "A renamed product chat" })).toBeVisible();
});

/**
 * The composed shell's World Info surface: the same panel and bind state machine,
 * reading the dedicated management route because the composed Chat projection
 * carries no World Info at all.
 */
test("the product World Info surface binds through world-info.bind and shows the authoritative revision", async ({ page }) => {
  const worldInfoItemHandle = `${"V".repeat(42)}A`;
  const revision = `${"W".repeat(42)}A`;
  const nextRevision = `${"X".repeat(42)}A`;
  const writes: unknown[] = [];
  const reads = { count: 0 };
  let selected = false;

  const currentWorldInfo = () => ({
    state: selected ? "selected" : "none",
    revision: selected ? nextRevision : revision,
    items: [{ handle: worldInfoItemHandle, title: "Pelican Town", summary: null, selected, pending: false }],
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/world-info", async (route) => {
    if (route.request().method() === "GET") {
      reads.count += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWorldInfo()) });
      return;
    }
    const command = route.request().postDataJSON() as { sourceHandle: string | null };
    writes.push(command);
    selected = command.sourceHandle !== null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWorldInfo()) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "World Info", exact: true }).click();
  const surface = page.getByTestId("world-info-surface");
  await expect(surface).toBeVisible();
  const binding = surface.locator("[data-world-info-binding]");
  await expect(binding.getByText("Pelican Town", { exact: true })).toBeVisible();
  expect(reads.count).toBe(1);

  await binding.getByRole("button", { name: "Bind: Pelican Town" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: revision,
    sourceHandle: worldInfoItemHandle,
  });
  // The service result is never applied locally: the panel re-reads the
  // authoritative revision, which is what turns the control into Unbind.
  await expect(binding.getByRole("button", { name: "Unbind: Pelican Town" })).toBeEnabled();
  expect(reads.count).toBe(2);
  await expect(surface.getByRole("status")).toContainText("Saved successfully.");
});

/**
 * The composed shell's Settings surface: the same four field groups over the
 * same routes, including the one-time companion-language seed and the interface's
 * own display language, which the composed shell had no control for.
 */
test("the product Settings surface shows the real settings panels and moves both languages", async ({ page }) => {
  const languageWrites: unknown[] = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/settings/language", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 0, locale: null }) });
      return;
    }
    languageWrites.push(route.request().postDataJSON());
    const locale = (route.request().postDataJSON() as { locale: string }).locale;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: languageWrites.length, locale }) });
  });
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true }),
    }),
  );
  for (const absent of ["settings/connection", "settings/profiles"]) {
    await page.route(`**/api/tavern/v1/${absent}`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
    );
  }

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();

  // The never-configured companion language is seeded once from the display
  // language and the control shows the durable read-back.
  await expect(surface.locator("#companion-language")).toHaveValue("en-US");
  await expect.poll(() => languageWrites.length).toBe(1);
  expect(languageWrites[0]).toEqual({ expectedRevision: 0, locale: "en-US" });
  await expect(surface.locator("[data-voice-settings]")).toContainText("Cloud TTS consent");
  await expect(surface.locator("[data-voice-settings]")).toContainText("Not decided");
  // A profile whose connection and model-profile routes are absent shows no
  // editor it could not serve.
  await expect(surface.locator("[data-connection-settings]")).toHaveCount(0);
  await expect(surface.locator("[data-model-profiles]")).toHaveCount(0);

  // The player's own companion tag round-trips, and it is not the interface's.
  await surface.locator("#companion-language").fill("ja-JP");
  await surface.locator("#companion-language").press("Enter");
  await expect.poll(() => languageWrites.length).toBe(2);
  expect(languageWrites[1]).toEqual({ expectedRevision: 1, locale: "ja-JP" });
  await expect(surface.locator("[data-companion-language-value]")).toHaveAttribute("data-companion-language-value", "ja-JP");
  await expect(surface.getByRole("status")).toContainText("Saved successfully.");

  // The interface's own language is a separate control, and moving it does not
  // drag the companion's tag with it.
  await surface.locator("#ui-language").selectOption("zh-CN");
  await expect(surface.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(surface.locator("#companion-language")).toHaveValue("ja-JP");
  expect(languageWrites.length).toBe(2);
});
