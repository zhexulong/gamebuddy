import { expect, test, type Page } from "./frontend-coverage";
import {
  emitStreamEvent,
  failStream,
  installSyntheticEventStream,
  streamUrls,
  turnMarks,
} from "./synthetic-event-stream";

/**
 * A turn's idempotency key ends with its turn, on every path that ends one.
 *
 * `turn-timings.ts` states the rule where it is used: the marks carry the idempotency key "so a
 * DevTools recording with several interleaved turns can still be attributed", and `observeTurnEvent`
 * returns `terminal` precisely "so the caller can forget the key - a key that outlives its turn
 * attaches the next turn's timing to the previous turn's name".
 *
 * The defect: only the stream's terminal frame forgot it. A turn settled by the fallback poll, a
 * send the Host refused before anything ran, and a conversation switch that released the Chat all
 * left the key set - so the next turn's first token was marked with a key that names a turn
 * somebody else started, and `turnDurations(key)` mixed two turns into one reading.
 *
 * The reading is the browser's own timeline, not a private field: a `companion.delta` for a turn
 * this page did NOT start must not carry any key. Three of the four settle paths are driven here;
 * the fourth (a committed Chat switch) shares the one seam both switch paths use
 * (`adoptMountedChat`), and driving it needs the Chats management routes, which this journey does
 * not stub.
 */

const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const replyHandle = `${"R".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;
/** A turn this page never started: another device, another tab, or a recovered session. */
const unrelatedTurn = `${"U".repeat(42)}A`;
const frameId = `${"H".repeat(42)}A`;
const nextFrameId = `${"H".repeat(42)}E`;
const playerText = "The lantern is lit. Tell me what you see from the porch.";

const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true };
const completedTurn = { handle: turnHandle, state: "completed", projectionRevision: 2, canCancel: false };

type ChatHost = Readonly<{
  /** What the authoritative read publishes for the mounted chat's turn. */
  turn: (turn: unknown) => void;
  /** Whether the transcript the read publishes carries the companion's reply. */
  commitReply: (committed: boolean) => void;
  /** How `POST /messages` answers: the Host accepted the turn, or refused before it ran. */
  submit: (answer: "accepted" | "refused") => void;
  /** How many submit requests the page really sent. */
  submits: () => number;
}>;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

function frame(sequence: number, eventType: string, payload: unknown) {
  return { apiVersion: 1, epoch: streamEpoch, sequence, selectionGeneration: 1, eventType, payload };
}

const companionRow = {
  handle: `${"C".repeat(42)}A`,
  role: "companion",
  text: "The kettle is on.",
  locale: "und",
  order: 0,
  revision: 1,
};

const playerRow = { handle: playerHandle, role: "player", text: playerText, locale: "en", order: 1, revision: 2 };
const replyRow = { handle: replyHandle, role: "companion", text: "A heron on the fence post.", locale: "und", order: 2, revision: 3 };

async function mountShell(page: Page): Promise<ChatHost> {
  await installSyntheticEventStream(page);
  let turn: unknown = null;
  let replyCommitted = false;
  let submitAnswer: "accepted" | "refused" = "accepted";
  let submits = 0;

  const chat = () => ({
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: `${"K".repeat(42)}A`,
    browserSession: { expiresAtMs: 1_900_000_000_000 },
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      },
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: `${"B".repeat(42)}A`, generation: 1, stateRevision: `${"B".repeat(42)}A` },
    chat: {
      companion: { name: "Mira", handle: companionRow.handle },
      title: "A turn that ends",
      transcript: replyCommitted ? [companionRow, playerRow, replyRow] : [companionRow],
      draft: { revision: 0, present: false },
      turn,
      worldInfo: { state: "none", revision: `${"B".repeat(42)}A`, items: [] },
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: { epoch: streamEpoch, cursor: streamCursor },
  });
  const root = () => ({
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: chat(),
    game: null,
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/messages", (route) => {
    submits += 1;
    if (submitAnswer === "refused")
      // The client takes only the RFC-9457 problem document as "the Host answered"
      // (`isProblem`); a bare `{ code }` is an opaque protocol failure, i.e. an unanswered
      // attempt, which is a different case entirely.
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://gamebuddy.invalid/problems/turn_busy",
          title: "That turn is still running.",
          status: 409,
          code: "turn_busy",
          requestId: `${`Q`.repeat(42)}A`,
          retryable: false,
        }),
      });
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "accepted", message: playerRow, turn: runningTurn }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "accepted" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${"A".repeat(43)}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect.poll(() => streamUrls(page)).toHaveLength(1);

  return {
    turn: (next: unknown) => {
      turn = next;
    },
    commitReply: (committed: boolean) => {
      replyCommitted = committed;
    },
    submit: (answer: "accepted" | "refused") => {
      submitAnswer = answer;
    },
    submits: () => submits,
  };
}

/** Press send, and wait until the page has marked the attempt (which is where the key is set). */
async function sendOnce(page: Page): Promise<void> {
  const surface = page.getByTestId("chat-surface");
  await surface.locator(".composer-textarea").fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => turnMarks(page, "submit"), { message: "the press was marked" }).toHaveLength(1);
}

/** The one reading: the first token of a turn this page did not start carries no key. */
async function expectTheNextTurnCarriesNoKey(page: Page, index: number, sequence: number): Promise<void> {
  await emitStreamEvent(
    page,
    index,
    frame(sequence, "companion.delta", { turnHandle: unrelatedTurn, delta: "A heron, on the fence post." }),
    nextFrameId,
  );
  await expect.poll(() => turnMarks(page, "first-token"), { message: "the unrelated turn's first token was marked" }).toHaveLength(1);
  const marks = await turnMarks(page, "first-token");
  expect(marks.at(-1), "the previous turn's key was attached to a turn it does not name").toBeNull();
}

test("a turn that ends on the stream leaves no key behind", async ({ page }) => {
  test.setTimeout(90_000);
  const host = await mountShell(page);
  await sendOnce(page);
  const [sentKey] = await turnMarks(page, "submit");
  expect(sentKey, "the press published its own key").not.toBeNull();

  host.turn(runningTurn);
  host.commitReply(true);
  await emitStreamEvent(page, 0, frame(2, "turn.state_changed", completedTurn), frameId);
  await expect(page.locator(`li[data-handle="${replyHandle}"]`)).toBeVisible();

  // The stream's next frame is the one after the settle: a gap is a resync, not a frame.
  await expectTheNextTurnCarriesNoKey(page, 0, 3);
});

test("a turn the fallback poll settles leaves no key behind", async ({ page }) => {
  test.setTimeout(90_000);
  const host = await mountShell(page);
  host.turn(runningTurn);
  await sendOnce(page);

  // The link drops, so the poll - the one channel that can still settle the record - takes over.
  await failStream(page, 0);
  await expect.poll(() => streamUrls(page), { message: "the shell reconnected on a fresh connection" }).toHaveLength(2);

  // The Host's own read now says the turn is over: this is the poll's settle, not the stream's.
  host.turn(completedTurn);
  host.commitReply(true);
  await expect(page.locator(`li[data-handle="${replyHandle}"]`), "the poll's settle landed").toBeVisible();

  // The reconnected stream starts from the checkpoint the recovery read published.
  await expectTheNextTurnCarriesNoKey(page, 1, 1);
});

test("a send the Host refuses before it runs leaves no key behind", async ({ page }) => {
  test.setTimeout(90_000);
  const host = await mountShell(page);
  host.submit("refused");
  await sendOnce(page);

  // The refusal was the game's own operation: the page really sent the press and the Host really
  // refused it, so nothing will ever settle this attempt on the wire.
  await expect.poll(() => host.submits(), { message: "the press left the page" }).toBe(1);

  await expectTheNextTurnCarriesNoKey(page, 0, 1);
});
