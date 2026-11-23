/**
 * A Game projection that cannot be read is not a conversation that broke.
 *
 * The claim this file settles: the Chat stream's reconnect read is the Chat half's own route
 * (`readChatSnapshotPair` -> `GET /api/tavern/v1/state`), so a Game projection that refuses the
 * aggregate never answers it at all - the aggregate stub here refuses for the whole journey and is
 * never asked, which is the fact the journey holds.
 *
 * Measured: what the read CAN be handed is a transient refusal of its own route, and the Chat client
 * keeps that class non-terminal (`terminalReadFailure`): the projection stays, the surface says which
 * read it could not take, the stream's recovery keeps trying, and the live channel re-arms itself from
 * the first read that lands. This journey pins exactly that, with the Game half refused throughout.
 *
 * The residual the older shape of this file measured - "while the Game projection keeps failing, every
 * Chat read fails with it" - is gone with the route: `game-projection-failure-is-not-the-chats.spec.ts`
 * measures `aggregateReads=0` in session, and this journey's aggregate stub is the proof it is unread.
 */
import { expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";
import { game, tavernRefusal } from "./composed-reference-game-fixtures";

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;

const COMPANION_LINE = "The kettle is on.";
/** The row only a read that landed can produce: proof the re-armed stream's read was committed. */
const RECOVERED_LINE = "The lamp is lit, then.";

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken: game.csrfToken,
  browserSession: game.browserSession,
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "A game that cannot be read",
    transcript: [
      { handle: companionHandle, role: "companion", text: COMPANION_LINE, locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: chatHandle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  // A live cursor, so mounting this conversation opens the stream this journey kills.
  eventStream: { epoch: streamEpoch, cursor: streamCursor },
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game,
};

/** What the read answers once the Game half answers again: the conversation has moved on. */
const recovered = {
  ...root,
  chat: {
    ...chat,
    chat: {
      ...chat.chat,
      transcript: [
        ...chat.chat.transcript,
        { handle: playerHandle, role: "player", text: RECOVERED_LINE, locale: "und", order: 1, revision: 1 },
      ],
    },
  },
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The Host's own refusal when the Game projection is the half that broke, verbatim. */
const gameProjectionRefusal = {
  status: 409,
  contentType: "application/json",
  body: JSON.stringify({ code: "state_unavailable", cause: "game_projection_failed" }),
};

test("a Game projection failure does not end the conversation's live stream", async ({ page }) => {
  test.setTimeout(120_000);
  let stateReads = 0;
  let gameBroken = false;

  await page.addInitScript(() => {
    type Source = { onerror: ((event: unknown) => void) | null; close(): void };
    const state = window as unknown as {
      __streams: Array<{ url: string; closed: boolean }>;
      __sources: Source[];
      __fail: (index: number) => void;
    };
    state.__streams = [];
    state.__sources = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      private readonly index: number;
      constructor(url: string | URL) {
        this.index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__sources.push(this as unknown as Source);
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {
        state.__streams[this.index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__fail = (index) => {
      state.__sources[index]?.onerror?.({});
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // The aggregate is refused for the whole journey and nothing reads it: the Chat stream's reconnect
  // takes the Chat half's own route (`readChatSnapshotPair`), which is the fact this journey holds - a
  // Game projection failure cannot end the conversation's stream because it never answers its read.
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(gameProjectionRefusal));
  await page.route("**/api/tavern/v1/state", async (route) => {
    stateReads += 1;
    await route.fulfill(gameBroken ? tavernRefusal(503, "storage_unavailable", true) : jsonOk(recovered.chat));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(jsonOk(game)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const rows = surface.locator(".message-list > li");
  await expect(rows).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length)).toBe(1);

  // The Game projection is the half that broke, and the Chat stream loses its link - so the reopen
  // reads the Chat half and is handed a transient refusal of its own route.
  gameBroken = true;
  await page.evaluate(() => (window as unknown as { __fail: (index: number) => void }).__fail(0));
  await expect.poll(() => stateReads).toBeGreaterThanOrEqual(1);

  // The conversation is still the conversation: not the shell's problem page, not the Chat
  // region's card, and not a lost row.
  await expect(page.locator(".problem-view")).toHaveCount(0);
  await expect(page.getByTestId("chat-problem")).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(COMPANION_LINE);
  // ...and the read it could not take is stated in the surface's own sync line.
  await expect(surface.locator(".reference-turn-notice")).toHaveText(messages("en").chatArrivalNotice);
  console.log(`MEASURE game-projection-failure: stateReads=${stateReads} streamDeath=not-terminal`);

  // The Game half answers again. The next attempt lands, its answer is committed, and the live
  // channel is re-armed from the cursor that read published.
  gameBroken = false;
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.nth(1)).toContainText(RECOVERED_LINE);
  await expect(surface.locator(".reference-turn-notice")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length)).toBe(2);
  console.log(`MEASURE game-projection-failure: streamRearmed at read ${stateReads}`);
});
