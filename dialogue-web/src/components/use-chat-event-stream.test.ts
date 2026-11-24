import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import { messages } from "../i18n";
import type {
  BrowserEventV1,
  BrowserMessageV1,
  BrowserTurnV1,
  ReferencePipelineApi,
  TavernStateSnapshotV1,
} from "../reference-pipeline-api";
import { ReferencePipelineSessionError, createReferencePipelineSession } from "../reference-pipeline-session";
import type { ReadyView, ViewState } from "./composed-reference-game-view";
import { startChatEventStream } from "./use-chat-event-stream";
import type { ComposedPreviewV1 } from "./use-composed-bootstrap";

/**
 * The live cursor, driven through its own lifecycle function.
 *
 * What it must keep true, and what the shell would lose if the effect were still spelled inline: the
 * stream opens on the cursor the committed snapshot published, and a socket error is a RESYNC rather
 * than a restart - one authoritative read of the Chat half's own route, committed through the shell's
 * own `withChatHalf` rule, then a new connection from the position that read published. A resync the
 * link refuses keeps the projection on screen, says which read it could not take, and retries on the
 * fallback poll's own backoff (1 s doubling to a 5 s ceiling, one timer at a time); a resync the Host
 * describes as terminal is the Chat problem instead, with no sentence and no retry. The cleanup closes
 * the socket and clears the timers, so a torn-down cursor reads nothing afterwards.
 *
 * The effect's dependency identity (`[view.kind, commit, eventStreamEpoch]`) is not testable here; it
 * is carried over unchanged and pinned by the mounted journeys.
 *
 * The last test is the extraction's own guard: the shell must not grow a second copy of the seam.
 */

const CSRF = "csrf-token";
const EPOCH = "epoch-1";
const CURSOR = "cursor-1";

/** The smallest snapshot a session accepts, with the live cursor the stream arms from. */
function snapshot(
  epoch = EPOCH,
  cursor = CURSOR,
  turn: BrowserTurnV1 | null = null,
  transcript: readonly BrowserMessageV1[] = [],
): TavernStateSnapshotV1 {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: CSRF,
    browserSession: { expiresAtMs: 1 },
    operations: [],
    navigation: [],
    selection: { chatHandle: "chat-1", generation: 1, stateRevision: "revision-1" },
    chat: {
      companion: { name: "Mira", handle: "mira" },
      title: null,
      transcript: [...transcript],
      draft: { revision: 1, present: false },
      turn,
      worldInfo: null,
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
    eventStream: { epoch, cursor },
  };
}

function root(state: TavernStateSnapshotV1): ComposedReferenceGameBrowserRootV1 {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: state,
    game: null,
  };
}

function ready(state: TavernStateSnapshotV1): ReadyView {
  return {
    kind: "ready",
    root: root(state),
    session: createReferencePipelineSession(state),
    draft: { apiVersion: 1, revision: 1, text: null },
    locale: "en",
    chatProblem: null,
  };
}

type Timer = { delay: number; fire: () => void; cleared: boolean };

const TURN_HANDLE = "turn-1";
const REPLY_HANDLE = "reply-1";
const HALF_REPLY = "The kettle is on,";
const REPLY = "The kettle is on, and the porch is quiet.";

/** The turn the Host projects for one reply being written: one handle, one state. */
function turnIn(state: BrowserTurnV1["state"]): BrowserTurnV1 {
  return { handle: TURN_HANDLE, state, projectionRevision: 1, canCancel: true };
}

/** The reply `message.committed` publishes, and the transcript row the read that follows carries. */
function committedReply(): BrowserMessageV1 {
  return { handle: REPLY_HANDLE, role: "companion", text: REPLY, locale: "und", order: 1, revision: 1 };
}

function deltaFrame(sequence: number, delta: string): BrowserEventV1 {
  return {
    apiVersion: 1,
    epoch: EPOCH,
    sequence,
    selectionGeneration: 1,
    eventType: "companion.delta",
    payload: { turnHandle: TURN_HANDLE, delta },
  };
}

function committedFrame(sequence: number): BrowserEventV1 {
  return {
    apiVersion: 1,
    epoch: EPOCH,
    sequence,
    selectionGeneration: 1,
    eventType: "message.committed",
    payload: committedReply(),
  };
}

function turnFrame(sequence: number, state: BrowserTurnV1["state"]): BrowserEventV1 {
  return {
    apiVersion: 1,
    epoch: EPOCH,
    sequence,
    selectionGeneration: 1,
    eventType: "turn.state_changed",
    payload: turnIn(state),
  };
}

type OpenedOptions = Readonly<{
  cursor?: string;
  onEvent(event: BrowserEventV1, lastEventId: string): void;
  onError(error: Event): void;
}>;

type OpenedSource = { cursor: string | undefined; options: OpenedOptions; closed: boolean; close(): void };

/** Flushes the recovery read's promise chain: a macrotask outlives every microtask queued behind it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * One armed cursor over fake seams.
 *
 * The one client is a cast: the stream takes one route off the Chat client (`readState`), arms one
 * cursor off it (`openEvents`), and the rest of its surface belongs to the routes it does not call. It
 * is handed no composed client at all, so the aggregate read the Chat half must never take is not one
 * the stream can reach (`gates/product/check-chat-reads-the-chat-route.mjs`). `window` is replaced for the
 * reason the stream needs it at all - the retry timer and the preview hold - so the test owns when they fire.
 */
function harness(view: ViewState) {
  const committed: ViewState[] = [];
  const notices: (string | null)[] = [];
  const problems: unknown[] = [];
  const sources: OpenedSource[] = [];
  const timers: Timer[] = [];
  const reads = { count: 0 };
  // The streaming preview, as the shell holds it: one cell the stream writes through the setter's
  // own two shapes, so a test reads exactly what the player would be watching.
  const previewCell: { current: ComposedPreviewV1 | null } = { current: null };
  let answer: () => Promise<TavernStateSnapshotV1> = () =>
    Promise.resolve((view.kind === "ready" ? view.root.chat : null) ?? snapshot());

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (fire: () => void, delay: number): number => {
        timers.push({ delay, fire, cleared: false });
        return timers.length;
      },
      clearTimeout: (handle: number): void => {
        const timer = timers[handle - 1];
        if (timer !== undefined) timer.cleared = true;
      },
    },
  });

  const viewRef = { current: view };
  const eventSourceRef = { current: null as { close(): void } | null };
  const streamLiveRef = { current: false };
  const streamFailedRef = { current: false };
  const turnKeyRef = { current: null as string | null };
  const tavernApi = {
    readState: (): Promise<TavernStateSnapshotV1> => {
      reads.count += 1;
      return answer();
    },
    openEvents(options: OpenedOptions) {
      const source: OpenedSource = {
        cursor: options.cursor,
        options,
        closed: false,
        close(): void {
          source.closed = true;
        },
      };
      sources.push(source);
      return source;
    },
  } as unknown as ReferencePipelineApi;

  const stop = startChatEventStream({
    view,
    viewRef,
    tavernApiRef: { current: tavernApi },
    localeRef: { current: "en" },
    eventSourceRef,
    streamLiveRef,
    streamFailedRef,
    turnKeyRef,
    setPreview: (next) => {
      previewCell.current = typeof next === "function" ? next(previewCell.current) : next;
    },
    setStreamNotice: (notice) => {
      notices.push(notice);
    },
    commit: (next) => {
      committed.push(next);
      viewRef.current = next;
    },
    commitChatProblem: (error) => {
      problems.push(error);
    },
    eventStreamEpoch: `${EPOCH}#0`,
  });

  return {
    stop,
    committed,
    notices,
    problems,
    sources,
    timers,
    reads,
    /** The reply the player is watching right now, or null when no preview stands. */
    preview: () => previewCell.current,
    answer: (next: () => Promise<TavernStateSnapshotV1>) => {
      answer = next;
    },
    viewRef,
    eventSourceRef,
    streamLiveRef,
    streamFailedRef,
  };
}

test("the stream opens on the cursor the committed snapshot published", () => {
  const h = harness(ready(snapshot()));

  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].cursor, CURSOR);
  assert.equal(h.streamLiveRef.current, true);
  assert.equal(h.streamFailedRef.current, false);
  // A fresh cursor starts from no stated failure; nothing is read and nothing is committed.
  assert.deepEqual(h.notices, [null]);
  assert.deepEqual(h.committed, []);
  assert.equal(h.reads.count, 0);
  h.stop();
});

test("a socket error resyncs through the shell's Chat rule and reconnects from the same position", async () => {
  const h = harness(ready(snapshot()));
  const state = snapshot();
  h.answer(() => Promise.resolve(state));

  h.sources[0].options.onError(new Event("error"));
  await settle();

  // The socket is gone and the projection is the read's: one commit, through the Chat rule, against
  // the view that was current when the answer landed.
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.streamFailedRef.current, true);
  assert.equal(h.committed.length, 1);
  assert.equal(h.committed[0].kind === "ready" ? h.committed[0].root.chat : null, state);
  // Same epoch, so the validated frames still stand: the new connection resumes at the old cursor.
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[1].cursor, CURSOR);
  assert.equal(h.streamLiveRef.current, true);
  assert.deepEqual(h.notices, [null, null]);
  assert.deepEqual(h.problems, []);
  h.stop();
});

test("an epoch the read reports is a new position, not a resumed one", async () => {
  const h = harness(ready(snapshot(EPOCH, CURSOR)));
  h.answer(() => Promise.resolve(snapshot("epoch-2", "cursor-2")));

  h.sources[0].options.onError(new Event("error"));
  await settle();

  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[1].cursor, "cursor-2");
  assert.equal(h.committed.length, 1);
  h.stop();
});

test("a refused resync keeps the projection, says which read, and backs off to the ceiling", async () => {
  const h = harness(ready(snapshot()));
  h.answer(() => Promise.reject(new Error("the link dropped")));

  h.sources[0].options.onError(new Event("error"));
  await settle();

  // Nothing committed: a refresh that failed did not make the conversation wrong.
  assert.deepEqual(h.committed, []);
  assert.deepEqual(h.notices, [null, messages("en").chatArrivalNotice]);
  assert.equal(h.sources.length, 1);
  assert.deepEqual(h.problems, []);
  // One attempt is ever outstanding, and its delay is the fallback poll's shape.
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 1_000);

  const delays: number[] = [];
  for (let attempt = 1; attempt < 5; attempt += 1) {
    const timer = h.timers[h.timers.length - 1];
    timer.fire();
    await settle();
    delays.push(h.timers[h.timers.length - 1].delay);
  }
  // 1 s doubling to a 5 s ceiling, and the read taken once per attempt.
  assert.deepEqual(delays, [2_000, 4_000, 5_000, 5_000]);
  assert.equal(h.reads.count, 5);
  assert.deepEqual(h.committed, []);
  h.stop();
});

test("a resync the Host calls terminal is the Chat problem, never a sentence and never a retry", async () => {
  const h = harness(ready(snapshot()));
  const terminal = new ReferencePipelineSessionError("state_reconciliation_required");
  h.answer(() => Promise.reject(terminal));

  h.sources[0].options.onError(new Event("error"));
  await settle();

  assert.deepEqual(h.problems, [terminal]);
  assert.deepEqual(h.notices, [null]);
  assert.deepEqual(h.timers, []);
  // No retry and no sentence - but the cursor is still armed for this epoch, so the socket it tore
  // down is opened again rather than left dead behind a problem card.
  assert.equal(h.sources.length, 2);
  h.stop();
});

test("the cleanup closes the socket and clears the retry it had scheduled", async () => {
  const h = harness(ready(snapshot()));
  h.answer(() => Promise.reject(new Error("the link dropped")));
  h.sources[0].options.onError(new Event("error"));
  await settle();
  assert.equal(h.timers.length, 1);

  h.stop();

  assert.equal(h.sources[0].closed, true);
  assert.equal(h.eventSourceRef.current, null);
  assert.equal(h.streamLiveRef.current, false);
  assert.equal(h.timers[0].cleared, true);
  // A timer that fires anyway reads nothing: the torn-down cursor is disposed, not merely idle.
  h.timers[0].fire();
  await settle();
  assert.equal(h.reads.count, 1);
  assert.deepEqual(h.committed, []);
});

test("a view with no live cursor arms nothing at all", () => {
  const h = harness({ kind: "loading" });

  assert.deepEqual(h.sources, []);
  assert.deepEqual(h.notices, []);
  assert.equal(h.streamLiveRef.current, false);
  h.stop();
});

/**
 * The streaming preview: the only copy of the words on screen until the reply is durable.
 *
 * A reply is not durable until `message.committed`, and the row that shows it only exists once the
 * read carrying it has landed - so the preview may be spent only by a fact that replaces it (the
 * read that carries the committed row) or by a turn that is no longer owed to the transcript. Three
 * separate paths spend it, and they are held apart below; the fourth test is the other half of the
 * rule, because a fix that simply never spends would pass the defect's own test.
 *
 * What each test names is what a player would have seen, not what the state cell holds.
 */

test("a committed frame holds the reply on screen until the read that carries its row lands", async () => {
  const h = harness(ready(snapshot()));
  // The reply streams: the preview is the only copy of these words.
  h.sources[0].options.onEvent(deltaFrame(1, REPLY), "cursor-2");
  await settle();
  assert.deepEqual(h.preview(), { turnHandle: TURN_HANDLE, text: REPLY });

  // The commit is durable and the row that shows it is in the read below, which this test keeps open.
  let land: () => void = () => undefined;
  h.answer(
    () =>
      new Promise((resolve) => {
        land = () => resolve(snapshot(EPOCH, "cursor-3", null, [committedReply()]));
      }),
  );
  h.sources[0].options.onEvent(committedFrame(2), "cursor-3");
  await settle();
  assert.equal(
    h.preview()?.text,
    REPLY,
    "the reply vanished between the committed frame and the read that carries its row",
  );

  land();
  await settle();
  assert.equal(h.preview(), null, "the committed row replaced the preview, so the preview is spent");
  h.stop();
});

test("a stream blip mid-turn keeps the words already on screen", async () => {
  const h = harness(ready(snapshot()));
  h.sources[0].options.onEvent(deltaFrame(1, HALF_REPLY), "cursor-2");
  await settle();
  assert.equal(h.preview()?.text, HALF_REPLY);

  // The link drops while the turn is open. Nothing about this reply is durable and no row anywhere
  // carries these words, so the Host still holds them: a reconnect is not a disappearance.
  h.answer(() => Promise.resolve(snapshot(EPOCH, "cursor-3", turnIn("running"))));
  h.sources[0].options.onError(new Event("error"));
  assert.equal(h.preview()?.text, HALF_REPLY, "the half-written reply vanished when the link dropped");

  await settle();
  assert.equal(h.preview()?.text, HALF_REPLY, "the recovery read threw away the only copy of the half-written reply");
  // ...and the read really did land, so what kept the words was the rule rather than a read that
  // never happened.
  assert.equal(h.committed.length, 1);
  h.stop();
});

test("a recovery read that finds no open turn spends the reply that was never committed", async () => {
  for (const [label, settled] of [
    ["cancelled", turnIn("cancelled")],
    ["gone", null],
  ] as const) {
    const h = harness(ready(snapshot()));
    h.sources[0].options.onEvent(deltaFrame(1, HALF_REPLY), "cursor-2");
    await settle();

    // The turn ended while the link was down: a cancelled turn commits no reply, so its partial text
    // is owed to nothing and a reply the Host may not have kept must not stand on screen.
    h.answer(() => Promise.resolve(snapshot(EPOCH, "cursor-3", settled)));
    h.sources[0].options.onError(new Event("error"));
    await settle();

    assert.equal(h.preview(), null, `a turn that is ${label} owes the transcript nothing`);
    h.stop();
  }
});

test("a turn state change spends the preview only when that turn is over", async () => {
  const h = harness(ready(snapshot()));
  h.sources[0].options.onEvent(deltaFrame(1, HALF_REPLY), "cursor-2");
  await settle();
  // The read every state frame triggers is held open, so what the assertions below see is the
  // frame's own decision rather than a read's.
  h.answer(() => new Promise(() => undefined));

  // The Host publishes the turn's admission too; that frame replaces no words.
  h.sources[0].options.onEvent(turnFrame(2, "queued"), "cursor-3");
  await settle();
  assert.equal(
    h.preview()?.text,
    HALF_REPLY,
    "a state change that leaves the turn open emptied the reply being written",
  );

  // Cancelled: this partial reply is not owed to the transcript, so it goes at once - not on the
  // read that follows, and not when some later delta arrives.
  h.sources[0].options.onEvent(turnFrame(3, "cancelled"), "cursor-4");
  await settle();
  assert.equal(h.preview(), null, "a cancelled turn's partial reply stayed on screen");
  h.stop();
});

test("the shell has no second copy of the stream", () => {
  const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ComposedReferenceGameApp.tsx"), "utf8");
  assert.match(shell, /from "\.\/use-chat-event-stream";/u);
  assert.match(shell, /useChatEventStream\(\{/u);
  assert.doesNotMatch(shell, /openEvents\(/u);
  assert.doesNotMatch(shell, /createSerialDrain/u);
  assert.doesNotMatch(shell, /window\.setTimeout/u);
  assert.doesNotMatch(shell, /const recover =/u);
});
