import { expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * A reconnect whose read fails once must not end reconnection for the session.
 *
 * Measured defect: the recovery read's catch replaced the whole shell with its problem page, and the
 * `finally` after it reconnected only while the view was still `ready` - which the catch had just
 * stopped it being. So one transient read failure (a 503, a dropped link, a blip exactly while the
 * stream was reconnecting) unmounted the conversation, ended the event stream, and the problem page
 * offered no way back but a reload. The live stream is the only channel that settles a turn on this
 * surface, so the surface stayed dead.
 *
 * Two facts have to survive together, and either alone is a half-fix: a genuinely unreachable Host
 * must still be visible, and a transient failure must not be terminal. The rule this asserts is the
 * one the arrival read already follows (`use-arrival-reread.ts`): a refresh that failed did not make
 * the projection wrong, so the projection stays, the read the shell could not make is stated in the
 * conversation's own line, and the reconnect keeps trying - with backoff - until the link is back.
 *
 * A failure class that says the conversation itself is unusable (a protocol fault, a non-retryable
 * refusal, a state that cannot be reconciled) still earns the problem page; that is what the
 * classification in the fix is for. This journey drives the transient class.
 *
 * The stream is a synthetic `EventSource`, so the failure is caused exactly once and on purpose
 * rather than by hoping a real socket errors at the right moment.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;
const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const COMPANION_LINE = "The kettle is on.";
/** The row only the authoritative re-read can produce: proof the retry's answer was committed. */
const RECOVERED_LINE = "The lamp is lit, then.";

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
    title: "A refused read",
    transcript: [{ handle: companionHandle, role: "companion", text: COMPANION_LINE, locale: "und", order: 0, revision: 1 }],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: chatHandle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  // A live cursor, so mounting this conversation opens the stream the reconnect lives on.
  eventStream: { epoch: streamEpoch, cursor: streamCursor },
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game: null,
};

/** What the authoritative read answers once the link is back: the conversation has moved on. */
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

/**
 * One transient refusal of the authoritative read: the composed contract's own refusal shape - an
 * exact `{code}` body - with a 5xx status, which is what the client classifies as retryable.
 */
const temporaryRefusal = {
  status: 503,
  contentType: "application/json",
  body: JSON.stringify({ code: "storage_unavailable" }),
};

test("a reconnect read that fails once keeps the conversation and reconnects on its own", async ({ page }) => {
  test.setTimeout(120_000);
  let stateReads = 0;

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
    // The event a dead socket produces, caused exactly once and on purpose. The shell's own
    // `onerror` is the reconnect's entry point, so this is the real seam, not a stand-in for it.
    state.__fail = (index) => {
      state.__sources[index]?.onerror?.({});
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    stateReads += 1;
    // The first two reads after the stream dies are the transient outage; the third is the link back.
    if (stateReads <= 2) {
      await route.fulfill(temporaryRefusal);
      return;
    }
    await route.fulfill(jsonOk(recovered));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const rows = surface.locator(".message-list > li");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(COMPANION_LINE);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length)).toBe(1);

  // The stream dies. The recovery read that follows is refused - twice.
  await page.evaluate(() => (window as unknown as { __fail: (index: number) => void }).__fail(0));
  await expect.poll(() => stateReads).toBe(1);

  // THE DEFECT: a refused refresh is not a broken conversation. Before this change the shell became
  // its problem page here and never reconnected, because the `finally` only connected while the view
  // was still the conversation the catch had just replaced.
  await expect(page.locator(".problem-view")).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(COMPANION_LINE);

  // What could not be read is stated, in the surface's own sync line - the same sentence the arrival
  // read uses for the same fact.
  const notice = surface.locator(".reference-turn-notice");
  await expect(notice).toHaveText(messages("en").chatArrivalNotice);

  // …and the reconnect keeps trying: its third read lands, its answer is committed (the row only the
  // authoritative read carries), the notice is spent, and the stream is open again.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText(RECOVERED_LINE);
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length)).toBe(2);
});
