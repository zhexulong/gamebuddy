/**
 * How a running turn settles, and what the surface does while it waits.
 *
 * The polling fallback carries a turn that has no event stream; an idle conversation never
 * starts polling at all; a healthy stream suspends the fallback and a failing one resumes it;
 * and a turn that never settles still ends with the composer usable and the failure named.
 */
import { expect, test } from "./frontend-coverage";
import { token, csrfToken, draft, chat, root, jsonOk } from "./composed-reference-game-fixtures";
import {
  regenerationPlayerHandle,
  regenerationCompanionHandle,
  regenerationTurnHandle,
  regenerationOldVariant,
  regenerationNewVariant,
  regenerationProjections,
} from "./regeneration-fixtures";

/**
 * Regeneration's own polling fallback, with the event stream genuinely absent.
 *
 * `regenerate` starts a real turn, so it is the same kind of mutation as
 * `submit` and must take the same path: publish the pending submission record
 * before the wire call. `startPolling`'s first tick returns for a session with
 * nothing pending - the guard that keeps every idle session from polling - so
 * without that record the fallback poll is dead on its first tick. With a
 * healthy event stream nobody notices; with no stream at all the transcript
 * never leaves the pre-regenerate variant and the turn never settles.
 *
 * The route-mocked setup is the spec's own, with one fact made explicit:
 * `eventStream: null` opens no stream, so the authoritative rereads the poll
 * makes are the only reader of the turn's terminal state. The `/state` route
 * keeps returning the turn-running projection until the poll's second read, so
 * the settled variant exists only after polling has advanced.
 */

test("regeneration settles through the polling fallback with no event stream", async ({ page }) => {
  const { idleRoot, runningRoot, settledRoot } = regenerationProjections();
  let stateReads = 0;
  let statusReads = 0;
  let regenerateRequests = 0;
  const statusKeys: string[] = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(idleRoot) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/messages/regenerate", async (route) => {
    regenerateRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      selectionGeneration: 1,
      messageHandle: regenerationCompanionHandle,
    });
    // A real acceptance takes a moment; the busy presentation must be visible
    // across it, exactly as it is for a real round trip.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: runningRoot.chat.chat.transcript[1],
        turn: runningRoot.chat.chat.turn,
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    // The reread that immediately follows acceptance still sees the running
    // turn and the old variant; only the poll's later read sees the settled one.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stateReads >= 2 ? settledRoot : runningRoot),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    statusReads += 1;
    const query = route.request().postDataJSON() as { idempotencyKey: string; selectionGeneration: number };
    statusKeys.push(query.idempotencyKey);
    expect(query.selectionGeneration).toBe(1);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "terminal" }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const bubble = page.locator(`li[data-handle='${regenerationCompanionHandle}']`);
  await expect(bubble).toContainText(regenerationOldVariant);
  const composer = chatSurface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  await bubble.getByRole("button", { name: "Regenerate" }).click();
  // The mutation's own busy presentation lands on the exact bubble...
  await expect(bubble).toHaveAttribute("data-pending", "regenerate");
  await expect(bubble).not.toHaveAttribute("data-pending", "regenerate");
  // ...and the regenerated variant reaches the transcript on the polling
  // fallback alone: no stream is open, and the projection only carries it once
  // the poll has advanced past the accepted, still-running read.
  await expect(bubble).toContainText(regenerationNewVariant);
  // The turn-level busy presentation resolves with the same poll: `chat.submit`
  // comes back available and the composer re-enables.
  await expect(composer).toBeEnabled();
  expect(regenerateRequests).toBe(1);
  expect(stateReads).toBeGreaterThanOrEqual(2);
  expect(statusReads).toBeGreaterThanOrEqual(1);
  // Every status read is correlated by the one key the regenerate was sent
  // under - the pending record, not a second identity.
  expect(new Set(statusKeys).size).toBe(1);
});


/**
 * The invariant the fix must not weaken: a session with nothing pending does
 * not poll. That guard lives in `startPolling`'s first tick, and it is what
 * keeps an idle conversation - the overwhelmingly common state - from issuing a
 * status read and a full authoritative reread every second forever. This
 * journey sits on the idle conversation for longer than the poll's first delay
 * plus one interval and asserts that neither route was touched at all.
 */
test("an idle conversation with nothing pending never starts polling", async ({ page }) => {
  const { idleRoot } = regenerationProjections();
  let stateReads = 0;
  let statusReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(idleRoot) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(idleRoot) });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, disposition: "unknown" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(stateReads).toBe(0);
  expect(statusReads).toBe(0);
});


/**
 * The fallback poll is the *fallback*: while the event stream is connected and
 * delivering, it must not run at all.
 *
 * The measured defect: one turn opened two overlapping channels - the SSE stream
 * and the 250 ms/1000 ms poll - and every poll hop read `/draft` as well, so a
 * single regeneration cost a full authoritative `/state` read, a submission-status
 * read and a draft read per second for as long as the turn ran, on top of the
 * frames the stream was already delivering. The failure each direction catches:
 *
 *  - a healthy stream that still polls: the surface pays a second full
 *    authoritative reread every second for a turn the stream is delivering, and
 *    two channels race to settle the same turn;
 *  - a stream that fails with a poll that does not resume: the composer stays
 *    locked because nothing reads the turn's terminal state - the one job the
 *    fallback exists for.
 *
 * A submission-status read is the poll's exclusive signature: nothing else in
 * this shell performs one (`handleEvent` rereads `/state` and the draft; the chat
 * mutations reread the same pair). So `statusReads` is what tells a poll hop
 * apart from the stream's own work.
 */
test("a healthy event stream suspends the fallback poll, and a stream that fails resumes it", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${"E".repeat(42)}A`;
  const cursor = `${"F".repeat(42)}A`;
  const frameId = `${"H".repeat(42)}A`;
  const { idleRoot, runningRoot, settledRoot } = regenerationProjections();
  const streamed = (value: typeof idleRoot) => ({
    ...value,
    chat: { ...value.chat, eventStream: { epoch: streamEpoch, cursor } },
  });
  let stateReads = 0;
  let draftReads = 0;
  let statusReads = 0;
  let regenerateRequests = 0;
  // The authoritative read that first answers with the settled turn. Direction 1
  // settles on the stream's own reread; direction 2 settles on the recovery read
  // and then on the poll's hop, so the hop is the read that carries it.
  let settledFromRead = Number.POSITIVE_INFINITY;

  await page.addInitScript(() => {
    const state = window as unknown as {
      __instances: Array<{ onerror: ((event: unknown) => void) | null }>;
      __handlers: Array<Map<string, Array<(raw: unknown) => void>>>;
      __emit: (index: number, type: string, data: string, id: string) => void;
      __fail: (index: number) => void;
    };
    state.__instances = [];
    state.__handlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        void url;
        this.__index = state.__instances.length;
        state.__instances.push(this);
        state.__handlers.push(new Map());
      }
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__handlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__handlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        this.onerror = null;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      for (const handler of state.__handlers[index]?.get(type) ?? []) handler({ data, lastEventId: id, type });
    };
    state.__fail = (index) => {
      state.__instances[index]?.onerror?.(new Event("error"));
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(streamed(idleRoot))),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(streamed(stateReads >= settledFromRead ? settledRoot : runningRoot)));
  });
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill(jsonOk(draft));
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" }));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/messages/regenerate", async (route) => {
    regenerateRequests += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: runningRoot.chat.chat.transcript[1],
        turn: runningRoot.chat.chat.turn,
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const composer = chatSurface.locator(".composer-textarea");
  const bubble = page.locator(`li[data-handle='${regenerationCompanionHandle}']`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __instances: unknown[] }).__instances.length)).toBe(1);

  // Direction 1: a live stream suspends the poll. The click's own reread is the
  // only authoritative read there is; the poll's first tick and a full interval
  // after it add nothing at all.
  settledFromRead = stateReads + 2;
  await bubble.getByRole("button", { name: "Regenerate" }).click();
  await expect.poll(() => regenerateRequests).toBe(1);
  await expect.poll(() => stateReads).toBeGreaterThan(0);
  await expect(composer).toBeDisabled();
  await page.waitForTimeout(2_500);
  // The measurement: every HTTP request this turn made under a live stream. The
  // authoritative read is ONE request - `/state` carries the draft's body beside
  // the transcript - so `draft=0` is the same fact as `state=1`, not a read that
  // went missing.
  console.log(
    `poll-measure: live stream, one turn -> state=${stateReads} draft=${draftReads} status=${statusReads}`,
  );
  expect({ stateReads, draftReads, statusReads }).toEqual({ stateReads: 1, draftReads: 0, statusReads: 0 });

  // The stream settles the turn itself: one frame, one authoritative reread, and
  // still no status read - so the settle came from the stream, not from a poll.
  const settledTurn = settledRoot.chat.chat.turn;
  await page.evaluate(
    (input: { data: string; id: string }) =>
      (window as unknown as { __emit: (index: number, type: string, data: string, id: string) => void }).__emit(
        0,
        "turn.state_changed",
        input.data,
        input.id,
      ),
    {
      data: JSON.stringify({
        apiVersion: 1,
        epoch: streamEpoch,
        sequence: 1,
        selectionGeneration: 1,
        eventType: "turn.state_changed",
        payload: settledTurn,
      }),
      id: frameId,
    },
  );
  await expect(bubble).toContainText(regenerationNewVariant);
  await expect(composer).toBeEnabled();
  expect(statusReads).toBe(0);
  expect(stateReads).toBe(2);

  // Direction 2: the stream fails. The next turn is admitted under the same
  // suspension, and once the stream is gone it is the poll that has to settle the
  // turn - the recovery read still sees the running projection, and only the
  // poll's own hop sees the settled one.
  settledFromRead = stateReads + 3;
  await bubble.getByRole("button", { name: "Regenerate" }).click();
  await expect.poll(() => regenerateRequests).toBe(2);
  await expect.poll(() => stateReads).toBe(3);
  await expect(composer).toBeDisabled();
  await page.waitForTimeout(1_500);
  expect(statusReads).toBe(0);

  await page.evaluate(() => (window as unknown as { __fail: (index: number) => void }).__fail(0));
  await expect.poll(() => statusReads).toBeGreaterThan(0);
  await expect(composer).toBeEnabled();
  // The only submission-status read in this whole journey is the poll's own, so
  // this settle came from the fallback rather than from the stream - and the
  // authoritative read it needed was the one the recovery had just performed.
  expect(statusReads).toBe(1);
  expect(stateReads).toBe(settledFromRead);
  // That recovery read is one `/state` and the poll's hop reuses it rather than
  // spending a read of its own - the guarantee the line above states. It used to
  // need a second clause here for the draft half of the pair; the body now arrives
  // in the same snapshot, so a draft request anywhere in this journey is the
  // regression.
  expect(draftReads).toBe(0);
});


/**
 * The fallback poll's own budget, and the last thing it must do.
 *
 * `startPolling` is the only reader of a turn's terminal state when no event
 * stream is open. When it spends `MAX_POLL_ATTEMPTS` without an authoritative
 * settlement it used to just return, leaving `session.pending` set - and with it
 * `submitAvailable` false, so the input stayed disabled forever with no message.
 * The client's budget also expired before the Host's own 120 s admission
 * ceiling, so it abandoned a turn the Host still believed was running.
 *
 * The fixture holds the turn running and keeps answering the submission status
 * as non-terminal, so only the budget can end the poll. The clock is
 * virtualized, because the subject is the budget's shape, not 130 real seconds.
 */
test("a turn that never settles ends the poll with the composer usable and the failure reported", async ({ page }) => {
  test.setTimeout(120_000);
  const operations = [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ];
  const neverSettlingRoot = {
    ...root,
    chat: {
      ...chat,
      operations,
      chat: {
        ...chat.chat,
        transcript: [
          { handle: regenerationPlayerHandle, role: "player", text: "Where are we?", locale: "und", order: 0, revision: 1 },
          { handle: regenerationCompanionHandle, role: "companion", text: regenerationOldVariant, locale: "und", order: 1, revision: 1 },
        ],
        turn: { handle: regenerationTurnHandle, state: "running", projectionRevision: 1, canCancel: false },
      },
    },
  };
  let statusReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(neverSettlingRoot) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(neverSettlingRoot) }),
  );
  await page.route("**/api/tavern/v1/messages/regenerate", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: neverSettlingRoot.chat.chat.transcript[1],
        turn: neverSettlingRoot.chat.chat.turn,
      }),
    }),
  );
  // "Never answers" in the only sense that matters here: the status route never
  // reports a terminal disposition, so only the budget can end the poll.
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "pending" }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.clock.install();
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const composer = chatSurface.locator(".composer-textarea");
  const bubble = page.locator(`li[data-handle='${regenerationCompanionHandle}']`);
  await expect(composer).toBeEnabled();

  await bubble.getByRole("button", { name: "Regenerate" }).click();
  // The pending record is published before the wire call, so the input locks
  // immediately - and stays locked while the poll still has budget.
  await expect(composer).toBeDisabled();
  // Step the virtual clock one poll interval at a time, yielding to the real
  // event loop between ticks so each mocked round trip can settle. A fixed yield
  // races those round trips, and the race costs steps rather than answers: the
  // poll arms its next interval only after the tick's own reads have landed, so
  // a tick whose reads land after the next `runFor` has already advanced the
  // clock arms its timer a whole interval in the future - one poll attempt then
  // costs two loop steps. The step ceiling is therefore well above the attempt
  // budget, and the loop stops at the poll's own unlock; the assertions below
  // still pin that unlock, the notice, and the budget's length.
  for (let step = 0; step < 600 && await composer.isDisabled(); step += 1) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(10);
  }
  // Past the budget: the pending record is cleared, the failure is reported, and
  // the player can try again. The budget itself must outlast the Host's 120 s
  // ceiling, or the client would abandon a turn the Host still believes runs.
  await expect(composer).toBeEnabled();
  await expect(chatSurface).toContainText("The reply failed. You can try again.");
  expect(statusReads, "the poll budget outlasts the Host's 120 s ceiling").toBeGreaterThanOrEqual(121);
});
