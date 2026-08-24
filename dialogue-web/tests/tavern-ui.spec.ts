import { expect, test, type Page } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(43);

const snapshot = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.p3" },
  csrfToken: token,
  browserSession: { expiresAtMs: 1_900_000_000_000 },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira" },
    title: "Exact Chat",
    transcript: [
      { handle: "C".repeat(43), role: "companion", text: "A durable opening.", locale: "und", order: 0, revision: 1 },
      { handle: "D".repeat(43), role: "player", text: "A durable reply.", locale: "und", order: 1, revision: 1 },
    ],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

test("P3 browser renders only the exact v1 snapshot and draft", async ({ page }) => {
  let bootstrapRequests = 0;
  let draftRequests = 0;
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    bootstrapRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, bootstrapToken: token });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
  });
  await page.route("**/api/tavern/v1/draft", async (route) => {
    draftRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "Saved locally by Host." }) });
  });

  await page.goto(`/#boot=${token}`);

  await expect(page.getByRole("heading", { name: "Exact Chat" })).toBeVisible();
  await expect(page.locator(".app-bar").getByText("Mira", { exact: true })).toBeVisible();
  await expect(page.getByText("A durable opening.")).toBeVisible();
  await expect(page.getByText("A durable reply.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Saved draft" })).toContainText("Saved locally by Host.");
  await expect(page.getByText("Read-only chat")).toBeVisible();
  await expect(page.locator("textarea, button[type=submit], [data-testid=memory]")).toHaveCount(0);
  await expect.poll(() => bootstrapRequests).toBe(1);
  await expect.poll(() => draftRequests).toBe(1);
  await expect(page).toHaveURL(/^(?!.*#boot=)/);
});

test("P3 browser accepts safe additive projection data and renders only the exact transcript and draft", async ({ page }) => {
  const additiveSnapshot = {
    ...snapshot,
    operations: [{ operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "submit.message" }],
    navigation: [
      ...snapshot.navigation,
      { itemId: "memory", labelKey: "tavern.nav.memory", availability: "unavailable" },
    ],
    chat: {
      ...snapshot.chat,
      turn: { handle: "E".repeat(43), state: "running", projectionRevision: 1, canCancel: false },
      worldInfo: { state: "none", items: [] },
    },
    memory: { readAvailable: true, mutationAvailable: false, projectionRevision: "F".repeat(43) },
    eventStream: { epoch: "G".repeat(43), cursor: "H".repeat(43) },
  };
  await page.route("**/api/tavern/v1/bootstrap", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(additiveSnapshot) }));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "Saved locally by Host." }) }));

  await page.goto(`/#boot=${token}`);

  await expect(page.getByRole("heading", { name: "Exact Chat" })).toBeVisible();
  await expect(page.locator(".message-list li")).toHaveCount(2);
  await expect(page.getByText("A durable opening.")).toBeVisible();
  await expect(page.getByText("A durable reply.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Saved draft" })).toContainText("Saved locally by Host.");
  await expect(page.getByText("Read-only chat")).toBeVisible();
  // Additive projection data must never mint a capability surface.
  await expect(page.locator("textarea, button[type=submit], [data-testid=memory]")).toHaveCount(0);
});

test("P3 browser fails safely when the browser contract identity does not match", async ({ page }) => {
  await expectSafeReconciliationFailure(page, {
    ...snapshot,
    build: { browserContract: "tavern_browser_api/v2", profileId: "gamebuddy.chat-core.p3" },
  });
});

test("P3 browser fails safely when the profile identity does not match", async ({ page }) => {
  await expectSafeReconciliationFailure(page, {
    ...snapshot,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.p4" },
  });
});

test("P3 browser fails safely when a required P3 transcript fact is malformed", async ({ page }) => {
  await expectSafeReconciliationFailure(page, {
    ...snapshot,
    chat: {
      ...snapshot.chat,
      transcript: [{ handle: "C".repeat(43), role: "companion", text: 42, locale: "und", order: 0, revision: 1 }],
    },
  });
});

async function expectSafeReconciliationFailure(page: Page, bootstrapBody: unknown) {
  await page.route("**/api/tavern/v1/bootstrap", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapBody) }));
  await page.goto(`/#boot=${token}`);
  await expect(page.getByRole("alert")).toContainText("Unable to read chat");
  await expect(page.getByText("The chat state could not be safely reconciled.")).toBeVisible();
}

test("P3 browser shows an explicit safe problem when bootstrap cannot reconcile", async ({ page }) => {
  await page.route("**/api/tavern/v1/bootstrap", (route) => route.fulfill({
    status: 409,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: "urn:gamebuddy:tavern:state_reconciliation_required",
      title: "State reconciliation required",
      status: 409,
      code: "state_reconciliation_required",
      requestId: token,
      retryable: false,
    }),
  }));

  await page.goto(`/#boot=${token}`);
  await expect(page.getByRole("alert")).toContainText("Unable to read chat");
  await expect(page.getByText("The chat state could not be safely reconciled.")).toBeVisible();
});

test("P3 browser settings drawer allows bilingual switching while authored content remains exact", async ({ page }) => {
  await page.route("**/api/tavern/v1/bootstrap", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) }));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "Saved locally by Host." }) }));

  await page.goto(`/#boot=${token}`);

  // Open settings drawer
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\?panel=settings/);

  // Switch to Simplified Chinese
  await page.locator("#language-select").selectOption("zh-CN");

  // Chrome translates to Chinese
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await expect(page.getByText("只读会话")).toBeVisible();
  await expect(page.getByRole("region", { name: "已保存草稿" })).toBeVisible();

  // Authored content remains exact byte-for-byte
  await expect(page.getByRole("heading", { name: "Exact Chat" })).toBeVisible();
  await expect(page.locator(".app-bar").getByText("Mira", { exact: true })).toBeVisible();
  await expect(page.getByText("A durable opening.")).toBeVisible();
  await expect(page.getByText("A durable reply.")).toBeVisible();
  await expect(page.getByText("Saved locally by Host.")).toBeVisible();

  // Close with Escape key
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/panel=settings/);
});

test("P3 browser keyboard navigation skip-link and minimum touch targets meet accessibility standards", async ({ page }) => {
  await page.route("**/api/tavern/v1/bootstrap", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) }));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "Saved locally by Host." }) }));

  await page.goto(`/#boot=${token}`);
  await expect(page.getByRole("heading", { name: "Exact Chat" })).toBeVisible();

  // Skip link is focusable
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to chat" });
  await expect(skipLink).toBeFocused();

  // Settings button meets 44px touch target
  const settingsBtn = page.getByRole("button", { name: "Settings" });
  const box = await settingsBtn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
