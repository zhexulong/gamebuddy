import { expect, test } from "./frontend-coverage";

/**
 * An authoritative reread must be applied to the state that is current when it LANDS, not to the one
 * it saw when it started.
 *
 * `rereadChat` is the shell's one read path for the composed Chat projection, and it takes a round
 * trip. The view it committed was captured before that trip began, so any commit that landed inside
 * the trip was overwritten by a photograph of the screen it replaced. The arrivals read makes the
 * window ordinary rather than exotic: the conversation re-reads every time the player comes back to
 * it, so "a slow read and a send in the same second" is an ordinary afternoon, not a contrived race.
 *
 * What gets erased is not decoration. A turn-starting mutation publishes a content-free pending
 * record before its wire call (`beginTurnMutation`): that record is what keeps the fallback poll
 * alive (its first tick returns for a session with nothing pending) and what keeps the send gate
 * shut while the Host holds the submission. Erasing it takes the player's own just-sent line off the
 * screen, unlocks the composer mid-turn, and leaves the turn with nothing that can settle it.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;

const playerText = "The miller left his coat on the step and walked on.";

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs: 1_900_000_000_000 },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "A read that outlived its subject",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: chatHandle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  // The Game half, so the surface the journey switches through is the real one.
  game: {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken,
    browserSession: { expiresAtMs: 1_900_000_000_000 },
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

test("a read that started before a send does not erase the submission the send published", async ({ page }) => {
  test.setTimeout(120_000);
  /** The Host accepted the send and is answering it. */
  let accepted = false;
  const submits: string[] = [];
  /** Set for the one read the journey holds open, so a send can land inside it. */
  let holdNextState = false;
  let releaseHeld: (() => void) | null = null;
  const held = { reading: false };

  /** The Host's projection as it is at the moment the read is answered FROM. */
  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      operations: accepted
        ? [
            {
              operationId: "chat.submit",
              labelKey: "tavern.operation.submit",
              availability: "busy",
              routeId: "chat.submit",
            },
            {
              operationId: "chat.cancel",
              labelKey: "tavern.operation.cancel",
              availability: "available",
              routeId: "chat.cancel",
            },
          ]
        : chat.operations,
      chat: {
        ...chat.chat,
        transcript: accepted
          ? [
              ...chat.chat.transcript,
              { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: accepted ? { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true } : null,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    // The Host's answer is fixed when the read is taken; only its delivery is slow. That is what a
    // round trip is, and it is the whole interleaving: the reading describes the screen before the send.
    const body = projection();
    if (holdNextState) {
      holdNextState = false;
      held.reading = true;
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    }
    await route.fulfill(jsonOk(body));
  });
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/messages", async (route) => {
    submits.push(route.request().headers()["idempotency-key"] ?? "(none)");
    accepted = true;
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    );
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "accepted" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  // The player leaves the conversation and comes back: that arrival is the shell's own reread.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  holdNextState = true;
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(surface).toBeVisible();
  await expect.poll(() => held.reading).toBe(true);

  // The read is still in flight, and the player sends into it.
  await composer.fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submits.length).toBe(1);
  // The submission the send published is on screen while the read is still open.
  await expect(surface.getByTestId("optimistic-player-message")).toBeVisible();

  // The read lands, carrying the reading it took before the send existed.
  if (releaseHeld !== null) (releaseHeld as () => void)();
  await page.waitForTimeout(150);

  const send = surface.getByTestId("composer-send");
  const measured = await page.evaluate(() => ({
    optimistic: document.querySelectorAll('[data-testid="optimistic-player-message"]').length,
    playerRows: document.querySelectorAll(".message-list > li").length,
    busy: document.querySelectorAll("[data-composer-busy]").length,
    send: document.querySelectorAll('[data-testid="composer-send"]').length,
    stop: document.querySelectorAll(".stop-button").length,
    fieldDisabled: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled ?? null,
  }));
  // If the erasure unlocked the composer, pressing Send again is the duplicate the erased record
  // would have prevented; it is measured rather than assumed.
  if ((await send.count()) > 0) await send.click();
  console.log(`MEASURE reread raced a send: ${JSON.stringify(measured)} submits=${JSON.stringify(submits)}`);

  // THE DEFECT: the record the send published was overwritten by the pre-send view, so the line the
  // player just sent left the screen and the gate reopened while the Host held the turn.
  await expect(send).toHaveCount(0);
  await expect(
    surface.getByTestId("optimistic-player-message").or(surface.locator(".message-list > li", { hasText: playerText })).first(),
  ).toBeVisible();
  expect(submits).toHaveLength(1);

  // And the submission is still the one the poll is watching, so the turn's own truth reaches the
  // surface: a running turn the player can stop.
  await expect(surface.locator(".stop-button")).toHaveCount(1);
  await expect(surface.locator(".message-list > li", { hasText: playerText })).toHaveCount(1);
  await expect(page.locator(".problem-view")).toHaveCount(0);
});
