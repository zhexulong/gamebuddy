import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const candidateId = "Q".repeat(22);
const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: { apiVersion: 1, build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" }, csrfToken, browserSession: { expiresAtMs: 1900000000000 }, operations: [], navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }], selection: { chatHandle: handle, generation: 1, stateRevision: handle }, chat: { companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" }, title: "Reference Game Chat", transcript: [{ handle: "D".repeat(42) + "A", role: "companion", text: "The game projection is read-only.", locale: "und", order: 0, revision: 1 }], draft: { revision: 4, present: true }, turn: null, worldInfo: null }, memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null }, eventStream: null },
  game: { apiVersion: 1, build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" }, csrfToken, browserSession: { expiresAtMs: 1900000000000 }, game: { prerequisites: { status: "unknown", detectedGame: null, missingItems: [] }, instance: { status: "none", gameTitle: null, generation: 0 }, compatibility: { status: "unchecked", message: null }, attachment: { status: "none", generation: 0 }, connectionStatus: "none", actionAuthority: "unavailable", role: null, companionName: null, selectedWorld: null, selectedSave: null, capabilitySummary: { available: false, count: 0 }, latestOutcome: "none" } },
};
const discovery = { apiVersion: 1, candidates: [{ candidateId, source: "steam", label: "Stardew Valley", hint: "Detected installation", status: "candidate" }], diagnostics: [] };
const realTopologySkipReason =
  "requires the approved composed shell fixture; route-mocked dialogue-web tests cannot prove real bootstrap/session/CSRF topology";

/**
 * Installation discovery lives inside the Game drawer (design/104 §5.1), so a
 * journey opens the drawer the way a player does - through the AppBar entry -
 * before reaching for the panel.
 */
async function openGameDrawer(page: import("@playwright/test").Page): Promise<void> {
  const surface = page.getByTestId("game-surface");
  const entry = page.getByRole("button", { name: "Game", exact: true });
  // The selected surface restores itself from the URL, so "it is already
  // selected" is a normal outcome - including straight after a reload. The entry
  // is the shell's own control and is present either way, so wait for the shell
  // and then select only when the surface really is not shown.
  await expect(entry).toBeVisible();
  if (await surface.isVisible()) return;
  await entry.click().catch(async (error: unknown) => {
    if (!(await surface.isVisible())) throw error;
  });
  await expect(surface).toBeVisible();
}

const panel = (page: import("@playwright/test").Page) =>
  page.locator('section[aria-label="Game installation setup"]');

/** The one sentence the panel is asserting - read from the panel's own status line. */
const sentenceOf = (page: import("@playwright/test").Page) =>
  panel(page).locator(".installation-state");

async function mountWithDiscovery(
  page: import("@playwright/test").Page,
  discoveryReply: unknown,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(discoveryReply) }),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
}

test.describe("B2 installation discovery: route-mocked UI behavior", () => {
  test("confirms a safe candidate and rereads authoritative state", async ({ page }) => {
    let reads = 0;
    let confirms = 0;
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => { reads++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(discovery) }); });
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery/confirm", async route => { confirms++; expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, candidateId }); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "registered" }) }); });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    const setup = panel(page);
    await expect(page.getByText("Stardew Valley", { exact: true })).toBeVisible();
    await expect(sentenceOf(page)).toHaveText("We found possible installations. Choose one to connect.");
    await setup.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => reads).toBe(2);
    expect(confirms).toBe(1);
    await expect(setup).not.toContainText(candidateId);
    await expect(setup).toContainText("steam");
  });

  /**
   * The machine the owner reported: the registry named no Steam client, one
   * candidate's app manifest was unreadable, and the bounded known-location
   * fallback still found the game. A candidate is a candidate whatever else the
   * scan reported, and the panel may not let the diagnostics hide it.
   */
  test("a candidate found while a source could not be read is still a candidate", async ({ page }) => {
    await mountWithDiscovery(page, {
      apiVersion: 1,
      candidates: [{ candidateId, source: "known-location", label: "Stardew Valley", hint: "Detected installation (path hidden)", status: "admission_required" }],
      diagnostics: ["registry-unavailable", "invalid-app-manifest"],
    });
    await expect(panel(page)).toHaveAttribute("data-state", "candidates");
    await expect(sentenceOf(page)).toHaveText("We found possible installations. Choose one to connect.");
  });

  test("an empty scan that could not read a source says so", async ({ page }) => {
    await mountWithDiscovery(page, {
      apiVersion: 1,
      candidates: [],
      diagnostics: ["registry-unavailable", "source-unavailable", "no-candidates"],
    });
    await expect(panel(page)).toHaveAttribute("data-state", "source-unavailable");
    await expect(sentenceOf(page)).toHaveText("The installation search is unavailable right now.");
    await expect(panel(page)).not.toContainText("No Stardew Valley installation was found.");
  });

  test("an empty scan that read everything says nothing was found", async ({ page }) => {
    await mountWithDiscovery(page, { apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] });
    await expect(panel(page)).toHaveAttribute("data-state", "no-candidates");
    await expect(sentenceOf(page)).toHaveText("No Stardew Valley installation was found.");
  });

  test("renders source-unavailable as a typed problem", async ({ page }) => {
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    await page.route("**/api/composed-reference-game/v1/game/installation/discovery", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) }));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "source-unavailable");
    await expect(sentenceOf(page)).toHaveText("The installation search is unavailable right now.");
  });

  /**
   * A rejected read is named by the code that rejected it.
   *
   * This test used to assert `error` for BOTH a malformed reply and a 401. The panel
   * read the code off `error.code`, which a thrown protocol error never carries (it
   * carries `reason`), so both collapsed into "The installation search failed." The
   * force is unchanged - neither may render as candidates and neither may be silent -
   * but each now says only what is true, and the one refusal that really is the search
   * failing (`state_unavailable`) stays distinguishable from them.
   */
  test("surfaces malformed, unauthorized and refused reads without candidates", async ({ page }) => {
    await page.route("**/api/composed-reference-game/v1/bootstrap", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/composed-reference-game/v1/state", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }));
    await page.route("**/api/tavern/v1/draft", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "A durable delegated draft." }) }));
    const discoveryRoute = "**/api/composed-reference-game/v1/game/installation/discovery";
    await page.route(discoveryRoute, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, candidates: [{ candidateId: "bad", source: "steam" }] }) }));
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "result-unavailable");
    await expect(sentenceOf(page)).toHaveText("We couldn't read the installation search result.");

    await page.unroute(discoveryRoute);
    await page.route(discoveryRoute, route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "unauthorized" }) }));
    await page.reload();
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "result-unavailable");
    await expect(sentenceOf(page)).toHaveText("We couldn't read the installation search result.");

    await page.unroute(discoveryRoute);
    await page.route(discoveryRoute, route => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) }));
    await page.reload();
    await openGameDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-state", "error");
    await expect(sentenceOf(page)).toHaveText("The installation search failed.");
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
