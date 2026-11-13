/**
 * The projected event stream the composed conversation opens.
 *
 * A delta is previewed before the authoritative read lands, a resync recovers through that
 * read exactly once, and a burst of frames costs two authoritative reads rather than one per
 * frame - with the last frame's state still landing and no gap in what the player is shown.
 */
import { expect, test } from "./frontend-coverage";
import { token, draft, chat, root, jsonOk } from "./composed-reference-game-fixtures";

/**
 * The composed conversation's live event stream, at the client contract.
 *
 * The Host publishes the composed Chat projection with a non-null `eventStream`
 * (the composed tavern profile declares the `events` route), and this client
 * opens the stream, previews `companion.delta` frames, and repairs a rejected
 * frame by rereading authoritative state. The mounted reference journeys that
 * asserted the wire behaviour went with the reference shell; the *decisions*
 * this client makes are this surface's own, so they are asserted here.
 *
 * The transport is a synthetic EventSource (the composed lane has no real Host
 * SSE endpoint, and `route.fulfill` cannot stream): it proves which URL and
 * cursor the surface subscribes with and how it reacts to frames, not how
 * Chromium reassembles bytes - which is the Host's own suite's subject.
 *
 * The assertions, and the failure each one catches:
 *  - the subscription carries the projected checkpoint: catches a surface that
 *    opens the stream at the wrong position, or ignores the projection entirely;
 *  - a delta becomes a preview with no authoritative read: catches a typewriter
 *    that rereads the whole conversation on every token;
 *  - a frame the session rejects (a generation the mounted conversation is not
 *    on) recovers exactly once, through `/state` and the draft, and reconnects on
 *    the cursor that state names: catches a recovery loop, a reconnect on the
 *    stale frame id, and a surfaced failure where a repair was required;
 *  - an explicit `stream.resync_required` frame repairs the same way: catches a
 *    resync marker treated as a fatal problem.
 */
test("the composed conversation opens the projected event stream, previews a delta, and recovers through authoritative state once per resync", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${"E".repeat(42)}A`;
  const initialCursor = `${"F".repeat(42)}A`;
  const recoveredCursor = `${"G".repeat(42)}A`;
  const deltaHandle = `${"T".repeat(42)}A`;
  const frameId = `${"H".repeat(42)}A`;
  let currentCursor = initialCursor;
  let stateReads = 0;
  let draftReads = 0;
  // What the repair read is given: a draft that moved while the stream was open.
  // It can only reach the field through the authoritative snapshot, so the field
  // holding this text is the proof that the body came in that one read.
  const repairedDraft = { revision: draft.revision + 1, present: true, text: "The draft the repair carried." };

  // `chat` here is the nested Chat snapshot, so the override goes one level in:
  // the draft belongs to `chat.chat`, beside the transcript it is committed with.
  const projection = (draftBody: typeof chat.chat.draft | null = null) => ({
    ...root,
    chat: {
      ...chat,
      chat: { ...chat.chat, ...(draftBody === null ? {} : { draft: draftBody }) },
      eventStream: { epoch: streamEpoch, cursor: currentCursor },
    },
  });

  await page.addInitScript(() => {
    const state = window as unknown as {
      __streams: Array<{ url: string; closed: boolean }>;
      __streamHandlers: Array<Map<string, Array<(raw: unknown) => void>>>;
      __emit: (index: number, type: string, data: string, id: string) => void;
    };
    state.__streams = [];
    state.__streamHandlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      constructor(url: string | URL) {
        const index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__streamHandlers.push(new Map());
        this.__index = index;
      }
      __index = -1;
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      const handlers = state.__streamHandlers[index]?.get(type) ?? [];
      for (const handler of handlers) handler({ data, lastEventId: id, type });
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    // The repair's own read moves the checkpoint: the reconnect must carry the
    // cursor this answer names, never the id of the frame that was rejected.
    currentCursor = recoveredCursor;
    return route.fulfill(jsonOk(projection(repairedDraft)));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill(jsonOk(draft));
  });

  const streamUrls = async (): Promise<string[]> =>
    await page.evaluate(() => (window as unknown as { __streams: Array<{ url: string }> }).__streams.map((stream) => stream.url));
  const emit = async (index: number, type: string, event: unknown, id: string): Promise<void> => {
    await page.evaluate(
      (input: { index: number; type: string; data: string; id: string }) => {
        (window as unknown as { __emit: (i: number, t: string, d: string, e: string) => void }).__emit(
          input.index,
          input.type,
          input.data,
          input.id,
        );
      },
      { index, type, data: JSON.stringify(event), id },
    );
  };
  const frame = (sequence: number, selectionGeneration: number, eventType: string, payload: unknown) => ({
    apiVersion: 1,
    epoch: streamEpoch,
    sequence,
    selectionGeneration,
    eventType,
    payload,
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect.poll(streamUrls).toHaveLength(1);
  expect((await streamUrls())[0]).toContain(`/api/tavern/v1/events?`);
  expect((await streamUrls())[0]).toContain(`cursor=${initialCursor}`);

  // A delta is a preview: it costs no authoritative read.
  await emit(0, "companion.delta", frame(1, 1, "companion.delta", { turnHandle: deltaHandle, delta: "A provisional reply." }), frameId);
  await expect(surface).toContainText("A provisional reply.");
  expect(stateReads).toBe(0);

  // A frame for a generation this conversation is not on is rejected by the
  // session and repaired once, through the authoritative read.
  await emit(0, "draft.changed", frame(2, 2, "draft.changed", { revision: 2, present: false }), `${"I".repeat(42)}A`);
  await expect.poll(() => stateReads).toBe(1);
  await expect.poll(streamUrls).toHaveLength(2);
  expect((await streamUrls())[1]).toContain(`cursor=${recoveredCursor}`);
  // The repair is one `/state`, and the draft is in it: the moved revision above
  // reached the field without a second route being read. This is where the old
  // `draftReads === 2` went - `state` says once per resync, `draft` says the body
  // now travels inside that same answer instead of a pair that could disagree.
  expect(draftReads).toBe(0);
  await expect(surface.locator(".composer-textarea")).toHaveValue(repairedDraft.text);
  expect(await page.evaluate(() => (window as unknown as { __streams: Array<{ closed: boolean }> }).__streams[0]!.closed)).toBe(true);
  await expect(page.locator(".problem-view"), "the repair kept the conversation instead of replacing it with a problem card").toHaveCount(0);

  // No recovery loop: the repaired stream carries the new cursor and one frame
  // does not become a second read.
  await page.waitForTimeout(750);
  expect(stateReads).toBe(1);
  expect(await streamUrls()).toHaveLength(2);

  // An explicit resync marker repairs the same way instead of becoming a fault.
  await emit(1, "stream.resync_required", frame(3, 1, "stream.resync_required", { reason: "gap" }), `${"J".repeat(42)}A`);
  await expect.poll(() => stateReads).toBe(2);
  await expect(page.locator(".problem-view"), "the repair kept the conversation instead of replacing it with a problem card").toHaveCount(0);
});


/**
 * A burst of stream frames is confirmed by one authoritative read per pass, not one per frame.
 *
 * The measured defect: `message.committed` and `turn.state_changed` each performed
 * `GET /state` and then `GET /draft`, so a burst paid two serial round trips per
 * frame and the queue of reads outran the stream it was confirming - the state
 * lagged the very frames it was meant to confirm. The pair is one request now (the
 * snapshot carries the draft's body), so the cost of a frame is a single read and
 * the measurement below reads `draft: 0` where it used to read `draft: frames`.
 *
 * The two directions this pins:
 *  - N frames must not produce N authoritative reads;
 *  - the last frame's own state must still land. The first read is served the
 *    durable state at the moment it was dispatched, which is before the final
 *    frame exists - so only a read issued *after* that frame carries the committed
 *    reply. A coalescer that drops its pending pass leaves the surface on the
 *    intermediate projection forever, and the reply row never appears.
 *
 * A recovery during the burst would also show up here: `__streams` stays at one
 * connection, so the frames that arrive while a read is in flight were threaded
 * into the session's checkpoint rather than rejected as a gap.
 */
test("a burst of stream frames costs two authoritative reads, not one per frame, and the last frame's state still lands", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${'E'.repeat(42)}A`;
  const streamCursor = `${'F'.repeat(42)}A`;
  const frames = 12;
  const turnHandle = `${'T'.repeat(42)}A`;
  const replyHandle = `${'R'.repeat(42)}A`;
  const replyText = "The last frame's own state.";
  const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true };
  const completedTurn = { handle: turnHandle, state: "completed", projectionRevision: 2, canCancel: false };
  // The Host's durable effect of the burst: the turn is running for every frame
  // but the last, and the last frame is what commits the companion's reply.
  let turnRunning = false;
  let replyCommitted = false;
  let stateReads = 0;
  let draftReads = 0;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
      chat: {
        ...chat.chat,
        transcript: replyCommitted
          ? [
              ...chat.chat.transcript,
              { handle: replyHandle, role: "companion", text: replyText, locale: "und", order: 1, revision: 2 },
            ]
          : chat.chat.transcript,
        turn: replyCommitted ? completedTurn : turnRunning ? runningTurn : null,
      },
    },
  });

  await page.addInitScript(() => {
    const state = window as unknown as {
      __streams: Array<{ url: string; closed: boolean }>;
      __streamHandlers: Array<Map<string, Array<(raw: unknown) => void>>>;
      __emit: (index: number, type: string, data: string, id: string) => void;
    };
    state.__streams = [];
    state.__streamHandlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__streamHandlers.push(new Map());
      }
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      for (const handler of state.__streamHandlers[index]?.get(type) ?? []) handler({ data, lastEventId: id, type });
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    stateReads += 1;
    // Served from the durable state this read was dispatched against - captured
    // now, so the answer cannot borrow the state of a later frame.
    const body = projection();
    // The burst is delivered while this read is in flight: that window is what the
    // coalescing is about, and it is what makes the intermediate answer the one a
    // dropped pending pass would leave on screen.
    if (stateReads === 1) await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill(jsonOk(body));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill(jsonOk(draft));
  });

  const streamCount = async (): Promise<number> =>
    await page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length);
  // A tally of what the browser actually put on the wire, beside the route counts:
  // the two must agree, so neither a route that answered without a request nor a
  // read this surface made off the intercepted paths can hide in the numbers.
  const statePath = "/api/composed-reference-game/v1/state";
  const draftPath = "/api/tavern/v1/draft";
  const wireRequests: string[] = [];
  page.on("request", (request) => wireRequests.push(new URL(request.url()).pathname));
  const wireCounts = (from: number) => ({
    state: wireRequests.slice(from).filter((pathname) => pathname === statePath).length,
    draft: wireRequests.slice(from).filter((pathname) => pathname === draftPath).length,
  });
  // A cursor is a canonical opaque handle, so the frames carry real ones: 43 chars
  // whose final base64url character has its two spare bits clear.
  const cursorSuffixes = "AEIMQUYcgkosw048";
  const burst = (from: number, to: number): Array<{ data: string; id: string }> => {
    const sent: Array<{ data: string; id: string }> = [];
    for (let sequence = from; sequence <= to; sequence += 1) {
      sent.push({
        id: `${'H'.repeat(42)}${cursorSuffixes[sequence - 1]}`,
        data: JSON.stringify({
          apiVersion: 1,
          epoch: streamEpoch,
          sequence,
          selectionGeneration: 1,
          eventType: "turn.state_changed",
          payload: sequence === frames ? completedTurn : runningTurn,
        }),
      });
    }
    return sent;
  };
  // One synchronous delivery: every frame of the list reaches the surface in the
  // same task, which is the burst the defect could not keep up with.
  const emit = async (sent: Array<{ data: string; id: string }>): Promise<void> => {
    await page.evaluate((input: Array<{ data: string; id: string }>) => {
      for (const item of input) {
        (window as unknown as { __emit: (i: number, t: string, d: string, e: string) => void }).__emit(
          0,
          "turn.state_changed",
          item.data,
          item.id,
        );
      }
    }, sent);
  };

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect.poll(streamCount).toBe(1);
  // The mount's own reads are not the burst's cost.
  const baseline = { state: stateReads, draft: draftReads };
  const wireBaseline = wireRequests.length;

  turnRunning = true;
  await emit(burst(1, frames - 1));
  replyCommitted = true;
  await emit(burst(frames, frames));

  // The final frame's own state landed: the reply the intermediate projection did
  // not have is on screen.
  const reply = page.locator(`li[data-handle='${replyHandle}']`);
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(replyText);

  const measured = { state: stateReads - baseline.state, draft: draftReads - baseline.draft };
  const wire = wireCounts(wireBaseline);
  console.log(
    `sse-coalesce: ${frames} frames -> route state=${measured.state} draft=${measured.draft}, wire state=${wire.state} draft=${wire.draft}; one read per frame would be state=${frames}`,
  );
  expect(measured).toEqual({ state: 2, draft: 0 });
  expect(wire).toEqual(measured);
  // No gap was manufactured by the frames that arrived mid-read: the burst needed
  // no recovery and no reconnect.
  expect(await streamCount()).toBe(1);
  await expect(page.locator(".problem-view"), "the repair kept the conversation instead of replacing it with a problem card").toHaveCount(0);
});

