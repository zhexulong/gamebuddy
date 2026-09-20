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

test("installation discovery confirms a safe candidate and rereads authoritative state", async ({ page }) => {
  let reads = 0;
  let confirms = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
  await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => { reads++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(discovery) }); });
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/confirm", async route => { confirms++; expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, candidateId }); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "registered" }) }); });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(page.getByText("Stardew Valley")).toBeVisible();
  await panel.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => reads).toBe(2);
  expect(confirms).toBe(1);
  await expect(panel).not.toContainText(candidateId);
  await expect(panel).toContainText("steam");
});
