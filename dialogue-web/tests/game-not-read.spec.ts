import { expect, test, type Page } from "./frontend-coverage";

/**
 * The state whose step is the read itself, driven over the real shell.
 *
 * `game.state.read` publishes `instance.status: "unread"` when the Host has no read of the
 * player's game - the coordinator's own Player Host slot answered `unavailable` (the
 * evidence read failed) or `unknown` (a player-external game it could not verify). Before
 * this state existed that case was published as `"none"`, the word for "nothing is running
 * yet", so the panel offered the getting-going guide: "Enable companion play" and setup,
 * two controls that act on an installation standing and a staged attempt the failed read
 * never established. A player who pressed them could only be refused, and nothing on the
 * page said what had actually happened.
 *
 * What this journey holds, on a 400x800 window:
 *
 *  - the sentence that names the subject says so, and the one control that answers it -
 *    the panel's own read - is fully inside the first viewport;
 *  - none of the controls whose premise is missing is drawn;
 *  - pressing it really re-reads: the state route is asked again and the answer reaches
 *    the panel.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: null,
    transcript: [],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
  eventStream: null,
};

/**
 * A registered installation, and a Host that has not read the player's game: the exact
 * shape that used to publish `met` + `none` + generation 0, i.e. the state the surface
 * answers with setup and activation.
 */
const UNREAD_GAME = {
  prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
  instance: { status: "unread", gameTitle: null, generation: 0 },
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
} as const;

function composedRoot(gameFacts: unknown) {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat,
    game: {
      apiVersion: 1,
      build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
      csrfToken,
      browserSession: { expiresAtMs },
      game: gameFacts,
    },
  };
}

async function stubHost(page: Page): Promise<{ stateReads: () => number }> {
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(composedRoot(UNREAD_GAME))),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(composedRoot(UNREAD_GAME)));
  });
  // The cabin handoff is read while a launched Player Host awaits attestation; here there is
  // nothing to hand over, and the panel's own state is what this journey is about.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  return { stateReads: () => stateReads };
}

test("an unread game offers the read itself, first in a 400x800 window", async ({ page }) => {
  const host = await stubHost(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toBeVisible();

  await page.setViewportSize({ width: 400, height: 800 });
  // The panel is the scrollable region itself (`composed-game-drawer`, tabIndex 0), so the
  // first viewport is measured from its own top rather than from whatever scroll the
  // browser restored.
  await panel.evaluate((node) => {
    node.scrollTop = 0;
  });

  // The sentence names the subject: the Host has not read the player's game. It must not
  // describe the player's setup as missing, and it must not offer a step that does not exist.
  const sentence = panel.getByTestId("game-not-read");
  await expect(sentence).toBeVisible();
  await expect(sentence).toContainText(/has not read your game/u);

  // The one step this state has, measured where the player lands.
  const reread = panel.getByTestId("game-reread");
  await expect(reread).toBeVisible();
  const reading = await reread.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      fullyInside: rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  console.log(`[game-not-read-first-viewport] ${JSON.stringify(reading)}`);
  expect(
    reading.fullyInside,
    `"Read my game again" must be fully inside the 400x800 window - it reads top ${reading.top}, ` +
      `bottom ${reading.bottom}, viewport height ${reading.viewportHeight}`,
  ).toBe(true);
  expect(reading.height, "the control keeps the 44 px touch floor").toBeGreaterThanOrEqual(44);

  // The negative half: every control the getting-going guide draws acts on a premise this
  // read never established, so none of them is drawn at all.
  for (const testId of ["game-activate", "game-setup", "game-launch", "game-start-guide"]) {
    await expect(panel.getByTestId(testId), `${testId} has no premise in this state`).toHaveCount(0);
  }

  // And the step is real: the panel asks the Host again, and the answer it gets is drawn.
  const before = host.stateReads();
  await reread.click();
  await expect
    .poll(() => host.stateReads(), { message: "the re-read asks the Host for its state again" })
    .toBeGreaterThan(before);
  await expect(sentence).toBeVisible();
});
