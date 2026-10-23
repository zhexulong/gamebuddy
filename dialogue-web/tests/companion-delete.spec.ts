import { expect, test, type Page } from "@playwright/test";

/**
 * Removing a companion from the inspector - the one irreversible control on this surface.
 *
 * Three facts this file holds, each of them a way the control could be a trap:
 *
 *  - the pair is ARMED, not a bare button: the trigger is replaced by a confirmation that
 *    restates "for good", so a mis-click cannot delete her;
 *  - a cancel changes nothing: the row stays, no request is sent, and focus returns to the
 *    control that was pressed (`armed-confirmation.ts`);
 *  - the companion in play has NO control at all and the reason is on screen in words - her
 *    Chats are the mounted conversation, so the Host would refuse her by name.
 *
 * The confirmation's sentence is asserted for what it must NOT claim as well as what it
 * must: deleting her removes her records and her picture, and her conversations are not
 * deleted, so a sentence that promised they were would be the lie this spec exists to catch.
 */

const token = "A".repeat(43);
const currentHandle = "B".repeat(42) + "A";
const otherHandle = "D".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: currentHandle, generation: 1, stateRevision: currentHandle },
    chat: {
      companion: { name: "Mira", handle: currentHandle },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
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

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const profileFor = (name: string) => ({
  apiVersion: 1,
  name,
  revision: 1,
  persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
  scenario: { present: false, name: null, description: null },
  greetings: { present: false, label: null, variants: [] },
  worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
});

/**
 * The roster, the two companions' profiles, and a recorder for every DELETE the surface
 * sends. `deleted` starts empty and is appended to the moment a confirmation arrives, so
 * the cancel case can assert the request was never made rather than only that the row
 * survived.
 */
async function stubCharacters(
  page: Page,
  companions: readonly Readonly<{ handle: string; name: string; isCurrent: boolean }>[],
  deleted: { handle: string; body: unknown }[],
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) => route.fulfill(jsonOk({ apiVersion: 1, companions })));
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/profile", (route) => {
    const handle = route.request().url().split("/companions/")[1]!.split("/")[0]!;
    const named = companions.find((entry) => entry.handle === handle);
    return route.fulfill(jsonOk(profileFor(named?.name ?? "Unknown")));
  });
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: currentHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.route("**/api/tavern/v1/companions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const handle = route.request().url().split("/companions/")[1]!.split("?")[0]!;
    deleted.push({ handle, body: route.request().postDataJSON() });
    return route.fulfill(jsonOk({ apiVersion: 1, handle }));
  });
}

async function openCharacters(page: Page): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), "en");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

async function openInspector(page: Page, name: string) {
  await page
    .getByTestId("characters-surface")
    .locator(`[data-companion-entry] [data-companion-inspect][aria-label*="${name}"]`)
    .click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".loading-text")).toHaveCount(0);
  return drawer;
}

test("the confirmation says what goes and what stays, and only a second answer deletes her", async ({ page }) => {
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Nova");

  // The pair's own two sentences: what goes, and that this cannot be undone.
  await expect(drawer.locator("[data-companion-removal]")).toContainText("for good");
  const hint = await drawer.locator("[data-companion-removal]").innerText();
  expect(hint).toContain("her picture");
  // What must NOT be claimed: her conversations are not deleted.
  expect(hint).not.toContain("conversations you had with her are deleted");

  // Arming is not deleting: no request yet.
  await drawer.locator("[data-companion-removal-arm]").click();
  await expect(drawer.locator("[data-companion-removal-confirm]")).toBeVisible();
  expect(deleted).toHaveLength(0);
  // The confirmation restates it rather than asking whether the player is sure.
  await expect(drawer.locator("[data-companion-removal-confirm]")).toContainText("for good");

  await drawer.locator("[data-companion-removal-confirm-yes]").click();
  await expect.poll(() => deleted.length).toBe(1);
  expect(deleted[0]!.handle).toBe(otherHandle);
  expect(deleted[0]!.body).toEqual({ apiVersion: 1, expectedRevision: 1 });

  // The row goes and the drawer closes: a deleted companion must not remain on screen.
  await expect(page.getByTestId("companion-inspector")).toHaveCount(0);
  await expect(
    page.getByTestId("characters-surface").locator(`[data-companion-inspect][aria-label*="Nova"]`),
  ).toHaveCount(0);
  await expect(page.getByTestId("characters-surface").locator("[data-companion-removed]")).toContainText("Nova");
});

test("cancelling the armed pair changes nothing and gives focus back to the control", async ({ page }) => {
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Nova");

  const trigger = drawer.locator("[data-companion-removal-arm]");
  await trigger.click();
  await drawer.locator("[data-companion-removal-confirm-no]").click();

  // Back to the trigger, with focus on it - the safe answer was the one that had focus.
  await expect(drawer.locator("[data-companion-removal-arm]")).toBeFocused();
  expect(deleted).toHaveLength(0);
  await expect(page.getByTestId("companion-inspector")).toBeVisible();
  await expect(
    page.getByTestId("characters-surface").locator(`[data-companion-inspect][aria-label*="Nova"]`),
  ).toHaveCount(1);
});

test("Escape closes the armed pair without deleting her", async ({ page }) => {
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Nova");

  await drawer.locator("[data-companion-removal-arm]").click();
  await expect(drawer.locator("[data-companion-removal-confirm]")).toBeVisible();
  // The confirmation holds focus, so Escape reaches it before the drawer behind it.
  await page.keyboard.press("Escape");
  await expect(drawer.locator("[data-companion-removal-confirm]")).toHaveCount(0);
  expect(deleted).toHaveLength(0);
  // Escape stopped at the confirmation: the drawer it was opened in is still open.
  await expect(page.getByTestId("companion-inspector")).toBeVisible();
});

test("the companion in play has no removal control, and the drawer says why", async ({ page }) => {
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Mira");

  await expect(drawer.locator("[data-companion-removal-arm]")).toHaveCount(0);
  // The reason is text on screen, so a sighted and a screen-reader player both read it.
  await expect(drawer.locator("[data-companion-removal-in-play]")).toContainText("in play");
  expect(deleted).toHaveLength(0);
});
