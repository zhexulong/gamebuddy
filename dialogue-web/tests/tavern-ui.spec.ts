import { expect, test, type Page, type Route } from "@playwright/test";

const initialChat = {
  csrf: "test-csrf",
  companion: { name: "Mira" },
  transcript: [{ entryId: "initial-message", role: "companion", text: "Original fixture text." }],
  worldBook: null,
};
const switchedChat = {
  csrf: "test-csrf",
  companion: { name: "Mira" },
  transcript: [{ entryId: "switched-message", role: "companion", text: "Replacement fixture text." }],
  worldBook: null,
};
// Browser-visible navigation and selection values are opaque Host capabilities,
// not durable Tavern identifiers. Keep fixtures on the public 43-character contract.
const handles = {
  activeChat: "A".repeat(43),
  replacementChat: "B".repeat(43),
  persona: "C".repeat(43),
  newChat: "D".repeat(43),
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function boot(page: Page) {
  await page.route("**/bootstrap", (route) => json(route, initialChat));
  await page.route("**/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: "" }));
  await page.goto("/#boot=browser-fixture");
  await expect(page.getByText("Original fixture text.")).toBeVisible();
}

async function openDrawer(page: Page) {
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
}

test("TW-UI-001: English chrome follows the persisted locale without rewriting authored fixture text", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await boot(page);
  await openDrawer(page);

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  for (const chrome of [page.locator("header.app-bar"), page.locator("[data-testid=context-panel] .panel-header"), page.locator("[data-testid=panel-navigation]"), page.locator("[data-testid=context-panel] .panel-footer"), page.locator("form.composer")]) {
    await expect(chrome).not.toContainText(/[\u3400-\u9fff]/);
  }
  await expect(page.getByText("Original fixture text.")).toBeVisible();
});

test("TW-UI-002: a narrow English drawer has no horizontal navigation rail or shell overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await boot(page);
  await openDrawer(page);

  const geometry = await page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>("[data-testid=context-panel]")!;
    const nav = document.querySelector<HTMLElement>("[data-testid=panel-navigation]")!;
    const root = document.scrollingElement!;
    return {
      pageOverflow: root.scrollWidth > root.clientWidth,
      drawerOverflow: drawer.scrollWidth > drawer.clientWidth,
      navScroll: nav.scrollWidth > nav.clientWidth,
    };
  });

  expect(geometry).toEqual({ pageOverflow: false, drawerOverflow: false, navScroll: false });
});

test("TW-UI-003: English and Chinese chat shells fit the release viewport matrix", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await boot(page);
  await openDrawer(page);
  const localeSelect = page.getByRole("combobox");
  for (const [width, height, locale] of [[375, 667, "en"], [768, 900, "zh-CN"], [1024, 900, "en"], [1440, 1000, "zh-CN"]] as const) {
    await page.setViewportSize({ width, height });
    await localeSelect.selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const geometry = await page.evaluate(() => {
      const root = document.scrollingElement!;
      const drawer = document.querySelector<HTMLElement>("[data-testid=context-panel]")!;
      return { pageOverflow: root.scrollWidth > root.clientWidth, drawerOverflow: drawer.scrollWidth > drawer.clientWidth };
    });
    expect(geometry).toEqual({ pageOverflow: false, drawerOverflow: false });
  }
});

test("TW-UI-019: Characters retries and restores focus to the exact same duplicate-name row", async ({ page }) => {
  let listReads = 0;
  let detailReads = 0;
  const firstOldHandle = "E".repeat(43);
  const secondOldHandle = "F".repeat(43);
  const firstFreshHandle = "G".repeat(43);
  const secondFreshHandle = "H".repeat(43);
  const firstRowRef = "I".repeat(43);
  const secondRowRef = "J".repeat(43);
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/library", (route) => {
    listReads += 1;
    // The retry projection deliberately reverses same-name rows. Only the
    // opaque UI-local rowRef can identify the original second row safely.
    const initial = [
      { handle: firstOldHandle, rowRef: firstRowRef, name: "Mira" },
      { handle: secondOldHandle, rowRef: secondRowRef, name: "Mira" },
    ];
    const refreshed = [
      { handle: secondFreshHandle, rowRef: secondRowRef, name: "Mira" },
      { handle: firstFreshHandle, rowRef: firstRowRef, name: "Mira" },
    ];
    // React Strict Mode replays the initial effect; both initial loads expose
    // the same projection before the retry obtains a fresh one.
    return json(route, { companions: listReads <= 2 ? initial : refreshed });
  });
  await page.route("**/library/*", (route) => {
    detailReads += 1;
    expect(route.request().url()).toContain(detailReads === 1 ? secondOldHandle : secondFreshHandle);
    return detailReads === 1 ? json(route, { error: "invalid_request" }, 400) : json(route, { name: "Mira" });
  });
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "Characters" }).click();
  const detailsButtons = page.getByRole("button", { name: "Details", exact: true });
  await detailsButtons.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Couldn’t load character details.");
  await page.getByRole("button", { name: "Try again" }).click();
  const detail = page.getByTestId("character-detail");
  const back = page.getByRole("button", { name: "Back" });
  await expect(detail).toContainText("Mira");
  await expect(detail).not.toContainText(/profile|revision|current|switch|archive|delete/i);
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  // The original second row is first after the fresh projection, proving both
  // retry and return-focus followed rowRef rather than the duplicate name.
  await expect(detailsButtons.nth(0)).toBeFocused();
  expect(listReads).toBeGreaterThanOrEqual(3);
  expect(detailReads).toBe(2);
});

test("TW-UI-004: switching a chat gives immediate pending feedback, prevents duplicate opens, and replaces the transcript atomically", async ({ page }) => {
  let releaseOpen: (() => void) | undefined;
  const openHeld = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let openRequests = 0;
  let refreshRequests = 0;

  await page.route("**/manage-chats", (route) => json(route, {
    activeHandle: handles.activeChat,
    chats: [
      { handle: handles.activeChat, openingSelection: { kind: "blank" } },
      { handle: handles.replacementChat, openingSelection: { kind: "greeting" } },
    ],
  }));
  await page.route("**/open-chat", async (route) => { openRequests += 1; await openHeld; await json(route, {}); });
  await page.route("**/refresh", (route) => { refreshRequests += 1; return json(route, switchedChat); });
  await page.route("**/bootstrap", (route) => json(route, initialChat));
  await page.route("**/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: "" }));
  await page.goto("/#boot=browser-fixture");
  await expect(page.getByText("Original fixture text.")).toBeVisible();

  await openDrawer(page);
  await page.getByRole("button", { name: "Chat History" }).click();
  const replacement = page.getByRole("button", { name: "Open", exact: true });
  await replacement.click();

  await expect(page.getByRole("button", { name: "Opening…", exact: true })).toBeDisabled();
  await expect(page.getByText("Original fixture text.")).toBeVisible();
  await expect(page.getByText("Replacement fixture text.")).toBeHidden();
  expect(openRequests).toBe(1);

  releaseOpen?.();
  await expect(page.getByText("Replacement fixture text.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "More" })).toBeHidden();
  expect(openRequests).toBe(1);
  expect(refreshRequests).toBe(1);
});

test("TW-UI-005: Escape and browser Back close the modal drawer and restore focus to More", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await boot(page);
  const opener = page.getByRole("button", { name: "Open menu" });
  await opener.focus();
  await page.keyboard.press("Enter");

  const drawer = page.getByRole("dialog", { name: "More" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await page.getByRole("button", { name: "Chat History" }).click();
  await expect(page).toHaveURL(/\?panel=chats$/);
  await page.goBack();
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat History" })).toBeVisible();
});

test("TW-UI-006: World Info and import review use player-readable statuses without artifact internals", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/worldbook", (route) => route.request().method() === "GET" ? json(route, { bindings: [{ bindingId: "active", label: "World Info", selected: true }], activeChat: { chatThreadId: "thread", chatSurfaceSessionId: "surface", updatedAtMs: 1 } }) : json(route, {}));
  await boot(page);
  await openDrawer(page);
  await page.getByRole("button", { name: "World Info" }).click();
  await expect(page.getByText("Reviewed background for this chat. It is not a statement about the current game world.")).toBeVisible();
  await expect(page.locator("article.world-row strong")).toHaveText("World Info");
  await expect(page.locator("[data-testid=context-panel]")).not.toContainText(/worldBookId|canonicalHash|revision|provenance/);

  await page.getByRole("button", { name: "Import Character Card" }).click();
  await page.route("**/imports", (route) => json(route, {
    candidate: { reviewId: "opaque-id", fields: [{ reviewKey: "field-1", label: "persona", eligible: true }] },
    report: { reviewId: "opaque-import", dispositions: [
      { status: "available" },
      { status: "excluded" },
    ] },
  }, 201));
  await page.getByLabel("Character card JSON").fill('{"fixture":true}');
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Ready to review")).toBeVisible();
  await expect(page.getByText("Not used or run")).toBeVisible();
  await expect(page.getByLabel("Import details")).not.toContainText(/persona_core|description|extensions|bounded_inert_candidate|executable_or_prompt_control_field/);
  await expect(page.getByLabel("Persona")).toBeVisible();
});

test("TW-UI-014: Managed World Info creates, edits, and attaches only a public exact selection", async ({ page }) => {
  let items: Array<{ revision: number; publicTitle: string; summary: string; entries: [] }> = [];
  let selectedPublicTitle: string | null = null;
  let updatedAtMs = 1;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/worldbook", (route) => json(route, { bindings: [], activeChat: { chatThreadId: "thread", chatSurfaceSessionId: "surface", updatedAtMs } }));
  await page.route("**/managed-world-info/bindings", (route) => json(route, { items, activeChat: { chatThreadId: "thread", chatSurfaceSessionId: "surface", updatedAtMs }, selectedPublicTitle }));
  await page.route("**/managed-world-info/attach", (route) => { selectedPublicTitle = (route.request().postDataJSON() as { publicTitle: string | null }).publicTitle; updatedAtMs++; return json(route, { selectedPublicTitle, chatThreadId: "thread", chatSurfaceSessionId: "surface", updatedAtMs }); });
  await page.route("**/managed-world-info/Pelican%20Town", (route) => {
    const request = route.request().postDataJSON() as { publicTitle: string; summary: string; entries: [] };
    items = [{ revision: 2, ...request }];
    return json(route, { item: items[0] });
  });
  await page.route("**/managed-world-info", (route) => {
    const request = route.request().postDataJSON() as { publicTitle: string; summary: string; entries: [] };
    items = [{ revision: 1, ...request }];
    return json(route, { item: items[0] }, 201);
  });
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "World Info" }).click();
  await page.getByLabel("Title").fill("Pelican Town");
  await page.getByLabel("Summary").fill("A small valley town.");
  await page.getByRole("button", { name: "Add entry" }).click();
  await page.getByLabel("Entry title").fill("Square");
  await page.getByLabel("Entry summary").fill("The town square.");
  await page.getByRole("button", { name: "Create World Info" }).click();
  await expect(page.getByTestId("managed-world-info")).toContainText("Pelican Town");
  await page.getByTestId("managed-world-info").getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Summary", exact: true }).fill("A revised valley town.");
  await page.getByRole("button", { name: "Save World Info" }).click();
  await page.getByTestId("managed-world-info").getByRole("button", { name: "Use in this chat" }).click();
  await expect(page.getByTestId("managed-world-info").getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByTestId("managed-world-info")).not.toContainText(/revision|canonicalHash|premise|artifact|handle/i);
});

test("TW-UI-015: Managed World Info protects a dirty draft and shows conflict recovery without duplicate saves", async ({ page }) => {
  let saves = 0;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/worldbook", (route) => json(route, { bindings: [], activeChat: null }));
  await page.route("**/managed-world-info/bindings", (route) => json(route, { items: [], activeChat: null, selectedPublicTitle: null }));
  await page.route("**/managed-world-info", async (route) => { saves++; await new Promise((resolve) => setTimeout(resolve, 100)); await json(route, { error: "conflict" }, 409); });
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "World Info" }).click();
  await page.getByLabel("Title").fill("Pelican Town");
  await page.getByLabel("Summary").fill("A town.");
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  await page.getByRole("button", { name: "Create World Info" }).dblclick();
  await expect(page.getByRole("alert")).toContainText("This World Info changed elsewhere.");
  expect(saves).toBe(1);
  await expect(page.getByLabel("Title")).toHaveValue("Pelican Town");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("");
});

test("TW-UI-011: Persona Manager creates and reads the safe projection in English and Chinese", async ({ page }) => {
  let persona: { revision: number; name: string; description?: string } | null = null;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/persona-management", (route) => {
    if (route.request().method() === "GET") return json(route, { persona });
    const request = route.request().postDataJSON() as { name: string; description?: string };
    persona = { revision: 1, ...request };
    return json(route, { persona }, 201);
  });
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "Persona Manager" }).click();
  await expect(page.getByTestId("persona-manager")).toContainText("Scenario, greeting, and World Info editing are not available here.");
  await page.getByLabel("Persona name").fill("Alex");
  await page.getByLabel("Description (optional)").fill("A patient farmer");
  await page.getByRole("button", { name: "Create persona" }).click();
  await expect(page.getByTestId("persona-manager")).toContainText("Alex");
  await expect(page.getByTestId("persona-manager")).toContainText("A patient farmer");
  await page.getByRole("combobox").selectOption("zh-CN");
  await expect(page.getByRole("button", { name: "Persona 管理" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("TW-UI-013: Scenario and Greeting managers create and read authored content without locale rewriting", async ({ page }) => {
  let scenario: { revision: number; name: string; description: string; preview: string } | null = null;
  let greetingSet: { revision: number; label: string; variants: Array<{ label: string; text: string }> } | null = null;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/scenario-management", (route) => {
    if (route.request().method() === "GET") return json(route, { scenario });
    const value = route.request().postDataJSON() as { name: string; description: string };
    scenario = { revision: 1, ...value, preview: value.description };
    return json(route, { scenario }, 201);
  });
  await page.route("**/greeting-management", (route) => {
    if (route.request().method() === "GET") return json(route, { greetingSet });
    const value = route.request().postDataJSON() as { label: string; variants: Array<{ label: string; text: string }> };
    greetingSet = { revision: 1, ...value };
    return json(route, { greetingSet }, 201);
  });
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "Scenario Manager" }).click();
  await page.getByLabel("Scenario name").fill("Rainy evening");
  await page.getByLabel("Scenario description").fill("Rain falls softly outside.");
  await page.getByRole("button", { name: "Create scenario" }).click();
  await expect(page.getByTestId("scenario-manager")).toContainText("Rain falls softly outside.");
  await page.getByRole("button", { name: "Greeting Manager" }).click();
  await page.getByLabel("Greeting set name").fill("Campfire welcome");
  await page.getByLabel("Opening greeting").fill("Welcome to the campfire, traveler.");
  await page.getByRole("button", { name: "Create greeting" }).click();
  await expect(page.getByTestId("greeting-manager")).toContainText("Welcome to the campfire, traveler.");
  await page.getByRole("combobox").selectOption("zh-CN");
  await expect(page.getByTestId("greeting-manager")).toContainText("Welcome to the campfire, traveler.");
  await expect(page.getByTestId("greeting-manager")).not.toContainText(/greetingSetId|variantId|artifact|hash|path|revision/);
});

test("TW-UI-007: a pending message has one request and a failed send preserves the draft", async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/message", async (route) => { requests += 1; await held; await json(route, { accepted: false, duplicate: false }); });
  await boot(page);
  const input = page.getByLabel("Write a message");
  await input.fill("Keep this draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Writing…", exact: true })).toBeDisabled();
  await expect(input).toBeDisabled();
  expect(requests).toBe(1);
  release?.();
  await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  await expect(input).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(requests).toBe(1);
});

test("TW-UI-010: active chat title uses the metadata projection, fallback, save, conflict retry, and accessible input", async ({ page }) => {
  let title = { title: null as string | null, revision: 1 };
  let failFirstSave = true;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route(/\/chat-management$/, (route) => json(route, title));
  await page.route(/\/chat-management\/title$/, (route) => {
    expect(route.request().method()).toBe("PUT");
    const request = route.request().postDataJSON() as { title: string; expectedRevision: number };
    if (failFirstSave) { failFirstSave = false; return json(route, { error: "chat_title_conflict" }, 409); }
    expect(request.expectedRevision).toBe(title.revision);
    title = { title: request.title.trim(), revision: title.revision + 1 };
    return json(route, title);
  });
  await boot(page);
  await expect(page.getByText("Untitled chat", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "Chat title" });
  await expect(input).toBeFocused();
  await input.fill("A quiet morning");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t save the chat title.");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("A quiet morning", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Chat title" })).toBeHidden();
});

test("TW-UI-020: switching chats reloads title metadata and renames only the exact active chat", async ({ page }) => {
  let active = "first" as "first" | "second";
  const titles = {
    first: { title: "First chat title", revision: 3 },
    second: { title: "Second chat title", revision: 11 },
  };
  const renameRequests: Array<{ active: typeof active; title: string; expectedRevision: number }> = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route(/\/chat-management$/, (route) => json(route, titles[active]));
  await page.route(/\/chat-management\/title$/, (route) => {
    const request = route.request().postDataJSON() as { title: string; expectedRevision: number };
    renameRequests.push({ active, ...request });
    expect(request.expectedRevision).toBe(titles[active].revision);
    titles[active] = { title: request.title.trim(), revision: titles[active].revision + 1 };
    return json(route, titles[active]);
  });
  await page.route("**/manage-chats", (route) => json(route, {
    activeHandle: handles.activeChat,
    chats: [
      { handle: handles.activeChat, openingSelection: { kind: "blank" } },
      { handle: handles.replacementChat, openingSelection: { kind: "blank" } },
    ],
  }));
  await page.route("**/open-chat", (route) => { active = "second"; return json(route, {}); });
  await page.route("**/refresh", (route) => json(route, switchedChat));
  await boot(page);

  await expect(page.getByTestId("active-chat-title")).toContainText("First chat title");
  await openDrawer(page);
  await page.getByRole("button", { name: "Chat History" }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText("Replacement fixture text.")).toBeVisible();
  await expect(page.getByTestId("active-chat-title")).toContainText("Second chat title");
  await expect(page.getByTestId("active-chat-title")).not.toContainText("First chat title");

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Chat title" }).fill("Renamed second chat");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("active-chat-title")).toContainText("Renamed second chat");
  expect(renameRequests).toEqual([{ active: "second", title: "Renamed second chat", expectedRevision: 11 }]);
});

test("TW-UI-009: Settings is a fixed read-only model/thinking projection", async ({ page }) => {
  const secretLikeFixture = "fixture-secret-do-not-display";
  const forbiddenConfigKeys = ["provider", "endpoint", "apiKey", "secret"];
  let profilesRequests = 0;

  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/settings/profiles", (route) => {
    profilesRequests += 1;
    expect(route.request().method()).toBe("GET");
    return json(route, {
      chat: { modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      game: { modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    });
  });
  await page.route("**/game/status", (route) => { throw new Error("Settings must not request game status"); });
  await boot(page);
  await openDrawer(page);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat" })).toContainText("deepseek-v4-flash");
  await expect(page.getByRole("region", { name: "Game" })).toContainText("deepseek-v4-flash");
  expect(profilesRequests).toBe(1);
  await expect(page.getByRole("region", { name: "Chat" }).getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Game" }).getByRole("button")).toHaveCount(0);

  const exposure = await page.evaluate(() => ({
    text: document.body.textContent ?? "",
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    pageOverflow: document.scrollingElement!.scrollWidth > document.scrollingElement!.clientWidth,
    drawerOverflow: document.querySelector<HTMLElement>("[data-testid=context-panel]")!.scrollWidth > document.querySelector<HTMLElement>("[data-testid=context-panel]")!.clientWidth,
  }));
  expect(exposure.text).not.toContain(secretLikeFixture);
  expect(exposure.local).not.toContain(secretLikeFixture);
  expect(exposure.session).not.toContain(secretLikeFixture);
  for (const forbidden of forbiddenConfigKeys) expect(exposure.text).not.toContain(forbidden);
  expect(exposure).toMatchObject({ pageOverflow: false, drawerOverflow: false });
});

test("TW-UI-012: Game Status is a read-only safe projection without raw lifecycle identifiers", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/game/status", (route) => json(route, {
    availability: "available", category: "ready", label: "Ready", surfaceStatus: "active", freshnessLabel: "Current game state",
    availableCapabilityCount: 3, availableCapabilityCategory: "available", activeExecutionCategory: "none", latestAuthoritativeReceiptOutcome: "succeeded",
  }));
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "Game Status" }).click();
  const panel = page.getByTestId("game-status");
  await expect(panel).toContainText("Ready");
  await expect(panel).toContainText("Available capabilities: 3");
  await expect(panel).toContainText("Latest authoritative receipt: Succeeded");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel).not.toContainText(/playerId|companionId|continuityId|worldId|saveId|requestId|executionId|receiptId/i);
});

test("TW-UI-008: a failed chat switch preserves the active transcript and becomes retryable", async ({ page }) => {
  let openRequests = 0;
  let refreshRequests = 0;
  await page.route("**/manage-chats", (route) => json(route, {
    activeHandle: handles.activeChat,
    chats: [
      { handle: handles.activeChat, openingSelection: { kind: "blank" } },
      { handle: handles.replacementChat, openingSelection: { kind: "greeting" } },
    ],
  }));
  await page.route("**/open-chat", (route) => { openRequests += 1; return openRequests === 1 ? json(route, { code: "chat_open_failed" }, 503) : json(route, {}); });
  await page.route("**/refresh", (route) => { refreshRequests += 1; return json(route, switchedChat); });
  await page.route("**/bootstrap", (route) => json(route, initialChat));
  await page.route("**/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: "" }));
  await page.goto("/#boot=browser-fixture");
  await expect(page.getByText("Original fixture text.")).toBeVisible();

  await openDrawer(page);
  await page.getByRole("button", { name: "Chat History" }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Couldn’t open this chat.");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  await expect(page.getByText("Original fixture text.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  expect(openRequests).toBe(1);
  expect(refreshRequests).toBe(0);

  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Replacement fixture text.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "More" })).toBeHidden();
  expect(openRequests).toBe(2);
  expect(refreshRequests).toBe(1);
});

test("TW-UI-016: an exact chat switch saves the old draft before opening and atomically loads the target draft", async ({ page }) => {
  const requests: string[] = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/chat-draft", (route) => {
    requests.push(route.request().method());
    if (route.request().method() === "GET") return json(route, { revision: 0, text: null });
    return json(route, { revision: 1, text: "old thread draft" });
  });
  await page.route("**/manage-chats", (route) => json(route, { activeHandle: handles.activeChat, chats: [
    { handle: handles.activeChat, openingSelection: { kind: "blank" } },
    { handle: handles.replacementChat, openingSelection: { kind: "blank" } },
  ] }));
  await page.route("**/open-chat", (route) => { expect(requests).toContain("PUT"); return json(route, {}); });
  await page.route("**/refresh", (route) => json(route, { ...switchedChat, draft: { revision: 4, text: "target thread draft" } }));
  await boot(page);
  await page.getByLabel("Write a message").fill("old thread draft");
  await openDrawer(page);
  await page.getByRole("button", { name: "Chat History" }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText("Replacement fixture text.")).toBeVisible();
  await expect(page.getByLabel("Write a message")).toHaveValue("target thread draft");
  expect(requests).toContain("PUT");
});

test("TW-UI-017: New Chat uses opaque selection and navigation handles for the full happy path", async ({ page }) => {
  const requests: unknown[] = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/new-chat/selections", (route) => json(route, { personas: [{ handle: handles.persona, name: "Player" }], scenarios: [], greetings: [] }));
  await page.route("**/new-chat", (route) => { requests.push(route.request().postDataJSON()); return json(route, { chat: { handle: handles.newChat, openingSelection: { kind: "blank" } } }, 201); });
  await page.route("**/open-chat", (route) => { requests.push(route.request().postDataJSON()); return json(route, {}); });
  await page.route("**/refresh", (route) => json(route, { ...switchedChat, draft: { revision: 0, text: null } }));
  await boot(page); await openDrawer(page);
  await page.getByRole("button", { name: "New Chat" }).click();
  await page.getByLabel("Persona").selectOption(handles.persona);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Replacement fixture text.")).toBeVisible();
  expect(requests).toEqual([{ personaHandle: handles.persona, opening: { kind: "blank" } }, { chatHandle: handles.newChat }]);
});

test("TW-UI-018: New Chat persists a whitespace-only source draft and failure preserves its source UI", async ({ page }) => {
  const draftWrites: unknown[] = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/chat-draft", (route) => {
    if (route.request().method() === "PUT") draftWrites.push(route.request().postDataJSON());
    return json(route, { revision: 1, text: "   " });
  });
  await page.route("**/new-chat/selections", (route) => json(route, { personas: [], scenarios: [], greetings: [] }));
  await page.route("**/new-chat", (route) => json(route, { error: "invalid_request" }, 400));
  await boot(page);
  await page.getByLabel("Write a message").fill("   ");
  await openDrawer(page);
  await page.getByRole("button", { name: "New Chat" }).click();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Couldn’t create and open this chat. Your draft is still here.")).toBeVisible();
  await expect(page.getByText("Original fixture text.")).toBeVisible();
  await expect(page.getByLabel("Write a message")).toHaveValue("   ");
  expect(draftWrites).toEqual([{ expectedRevision: 0, text: "   " }]);
});
