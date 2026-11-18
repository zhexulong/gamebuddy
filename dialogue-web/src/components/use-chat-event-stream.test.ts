import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ChatSnapshotPair } from "../chat-snapshot-pair";
import type {
  ComposedReferenceGameBrowserApi,
  ComposedReferenceGameBrowserRootV1,
} from "../composed-reference-game-browser-api";
import { messages } from "../i18n";
import type { BrowserEventV1, ReferencePipelineApi, TavernStateSnapshotV1 } from "../reference-pipeline-api";
import { ReferencePipelineSessionError, createReferencePipelineSession } from "../reference-pipeline-session";
import type { ReadyView, ViewState } from "./composed-reference-game-view";
import { startChatEventStream } from "./use-chat-event-stream";

/**
 * The live cursor, driven through its own lifecycle function.
 *
 * What it must keep true, and what the shell would lose if the effect were still spelled inline: the
 * stream opens on the cursor the committed snapshot published, and a socket error is a RESYNC rather
 * than a restart - one authoritative `/state` read whose Chat half is committed through the shell's
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
function snapshot(epoch = EPOCH, cursor = CURSOR): TavernStateSnapshotV1 {
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
      transcript: [],
      draft: { revision: 1, present: false },
      turn: null,
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
 * The two clients are casts: the stream takes one route off each (`readState`, `openEvents`), and the
 * rest of their surface belongs to the routes it does not call. `window` is replaced for the reason
 * the stream needs it at all - the retry timer and the preview hold - so the test owns when they fire.
 */
function harness(view: ViewState) {
  const committed: ViewState[] = [];
  const notices: (string | null)[] = [];
  const problems: unknown[] = [];
  const sources: OpenedSource[] = [];
  const timers: Timer[] = [];
  const reads = { count: 0 };
  let answer: () => Promise<ComposedReferenceGameBrowserRootV1> = () =>
    Promise.resolve(view.kind === "ready" ? view.root : root(snapshot()));

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
  const composedApi = {
    readState: (): Promise<ComposedReferenceGameBrowserRootV1> => {
      reads.count += 1;
      return answer();
    },
  } as unknown as ComposedReferenceGameBrowserApi;
  const tavernApi = {
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
    composedApiRef: { current: composedApi },
    tavernApiRef: { current: tavernApi },
    localeRef: { current: "en" },
    eventSourceRef,
    streamLiveRef,
    streamFailedRef,
    turnKeyRef,
    setPreview: () => undefined,
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
    answer: (next: () => Promise<ComposedReferenceGameBrowserRootV1>) => {
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
  h.answer(() => Promise.resolve(root(state)));

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
  h.answer(() => Promise.resolve(root(snapshot("epoch-2", "cursor-2"))));

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

test("the shell has no second copy of the stream", () => {
  const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ComposedReferenceGameApp.tsx"), "utf8");
  assert.match(shell, /from "\.\/use-chat-event-stream";/u);
  assert.match(shell, /useChatEventStream\(\{/u);
  assert.doesNotMatch(shell, /openEvents\(/u);
  assert.doesNotMatch(shell, /createSerialDrain/u);
  assert.doesNotMatch(shell, /window\.setTimeout/u);
  assert.doesNotMatch(shell, /const recover =/u);
});
