import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const candidateId = "Q".repeat(22);
const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: { apiVersion: 1, build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" }, csrfToken, browserSession: { expiresAtMs: 1900000000000 }, operations: [], navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }], selection: { chatHandle: handle, generation: 1, stateRevision: handle }, chat: { companion: { name: "Mira" }, title: "Reference Game Chat", transcript: [{ handle: "D".repeat(42) + "A", role: "companion", text: "The game projection is read-only.", locale: "und", order: 0, revision: 1 }], draft: { revision: 4, present: true }, turn: null, worldInfo: null }, memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null }, eventStream: null },
  game: { apiVersion: 1, build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" }, csrfToken, browserSession: { expiresAtMs: 1900000000000 }, game: { prerequisites: { status: "unknown", detectedGame: null, missingItems: [] }, instance: { status: "none", gameTitle: null, generation: 0 }, compatibility: { status: "unchecked", message: null }, attachment: { status: "none", generation: 0 }, connectionStatus: "none", actionAuthority: "unavailable", role: null, companionName: null, selectedWorld: null, selectedSave: null, capabilitySummary: { available: false, count: 0 }, latestOutcome: "none" } },
};
const discovery = { apiVersion: 1, candidates: [{ candidateId, source: "steam", label: "Stardew Valley", hint: "Detected installation", status: "candidate" }], diagnostics: [] };
const realTopologySkipReason =
  "requires the approved composed shell fixture; route-mocked dialogue-web tests cannot prove real bootstrap/session/CSRF topology";

test.describe("B2 installation discovery: route-mocked UI behavior", () => {
  test("confirms a safe candidate and rereads authoritative state", async ({ page }) => {
    let reads = 0;
    let confirms = 0;
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => { reads++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(discovery) }); });
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery/confirm", async route => { confirms++; expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, candidateId }); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "registered" }) }); });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const setup = page.locator('section[aria-label="Game installation setup"]');
    await expect(page.getByText("Stardew Valley", { exact: true })).toBeVisible();
    await setup.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => reads).toBe(2);
    expect(confirms).toBe(1);
    await expect(setup).not.toContainText(candidateId);
    await expect(setup).toContainText("steam");
  });

  test("renders source-unavailable as a typed problem", async ({ page }) => {
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) }));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const setup = page.locator('section[aria-label="Game installation setup"]');
    await expect(setup).toHaveAttribute("data-state", "source-unavailable");
  });

  test("surfaces malformed and unauthorized responses without candidates", async ({ page }) => {
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/composed-reference-game/v1/state", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, candidates: [{ candidateId: "bad", source: "steam" }] }) }));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const setup = page.locator('section[aria-label="Game installation setup"]');
    await expect(setup).toHaveAttribute("data-state", "error");

    await page.unroute("**/api/composed-reference-game/v1/game/installation/discovery");
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "unauthorized" }) }));
    await page.reload();
    await expect(page.locator('section[aria-label="Game installation setup"]')).toHaveAttribute("data-state", "error");
  });
});

test.describe("B2 composed topology evidence", () => {
  test.skip(realTopologySkipReason, async () => {
    // The approved fixture is host/src/tavern/composed-reference-game-static-shell-composition.ts,
    // exercised by host composed-reference-game-browser tests. It is not exposed
    // by dialogue-web's Playwright webServer and importing it would create a
    // second listener outside the approved topology.
  });
});
