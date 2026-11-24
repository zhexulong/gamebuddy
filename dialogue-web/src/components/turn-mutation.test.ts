import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import { TavernProblemError, type TavernStateSnapshotV1 } from "../reference-pipeline-api";
import {
  type PendingSubmission,
  ReferencePipelineSessionError,
  createReferencePipelineSession,
} from "../reference-pipeline-session";
import type { ReadyView, ViewState } from "./composed-reference-game-view";
import { createTurnMutation } from "./turn-mutation";

/**
 * The turn-starting envelope, driven through its own factory.
 *
 * What it must keep true, and what the shell would lose if it were spelled by hand again: a press
 * that the profile cannot accept sends nothing and says nothing; an admitted press publishes the
 * record that keeps the fallback poll alive BEFORE its wire call, and spends the sentence about the
 * attempt it supersedes; and a failure resolves that record by whether the Host answered at all -
 * an answered refusal spends it, an unanswered attempt keeps it, because handing it back invites a
 * second player row for one press.
 *
 * The last test is the extraction's own guard: the shell must not grow a second copy of the seam.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 characters, the contract's own idempotency-key alphabet.
const CSRF = "csrf-token";

type Availability = "available" | "busy" | "unavailable";

/** The smallest snapshot `pendingSubmission` and a session accept, with the one operation that matters. */
function snapshot(submit: Availability | "absent", withChat = true): TavernStateSnapshotV1 {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: CSRF,
    browserSession: { expiresAtMs: 1 },
    operations:
      submit === "absent"
        ? []
        : [
            {
              operationId: "chat.submit",
              labelKey: "tavern.operation.submit",
              availability: submit,
              routeId: "chat/submit",
            },
          ],
    navigation: [],
    selection: { chatHandle: "chat-1", generation: 1, stateRevision: "revision-1" },
    chat: withChat
      ? {
          companion: { name: "Mira", handle: "mira" },
          title: null,
          transcript: [],
          draft: { revision: 1, present: false },
          turn: null,
          worldInfo: null,
        }
      : null,
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
    eventStream: null,
  };
}

function ready(snapshot: TavernStateSnapshotV1, pending: PendingSubmission | null = null): ReadyView {
  const session = createReferencePipelineSession(snapshot);
  const root: ComposedReferenceGameBrowserRootV1 = {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: snapshot,
    game: null,
  };
  return {
    kind: "ready",
    root,
    session: pending === null ? session : session.withPending(pending),
    draft: { apiVersion: 1, revision: 1, text: null },
    locale: "en",
    chatProblem: null,
  };
}

/** A refusal the Host itself answered. */
const refused = (): TavernProblemError =>
  new TavernProblemError({
    type: "https://gamebuddy.dev/problems/turn-busy",
    title: "The companion is still answering",
    status: 409,
    code: "turn_busy",
    requestId: "request-1",
    retryable: false,
  });

function harness(view: ViewState) {
  const committed: ViewState[] = [];
  const sentences: (string | null)[] = [];
  const pollFailures: (PendingSubmission | null)[] = [];
  const problems: unknown[] = [];
  let polls = 0;
  const viewRef = { current: view };
  const turnKeyRef = { current: "turn-key-of-the-attempt" as string | null };
  const turnMutation = createTurnMutation({
    viewRef,
    turnKeyRef,
    commit: (next) => {
      committed.push(next);
      viewRef.current = next;
    },
    commitChatProblem: (error) => {
      problems.push(error);
    },
    setSendFailure: (sentence) => {
      sentences.push(sentence);
    },
    setPollFailure: (submission) => {
      pollFailures.push(submission);
    },
    startPolling: () => {
      polls += 1;
    },
  });
  return { turnMutation, committed, sentences, pollFailures, problems, polls: () => polls, viewRef, turnKeyRef };
}

test("an admitted press publishes its record before the wire call and spends the last refusal", () => {
  const view = ready(snapshot("available"));
  const h = harness(view);

  const pending = h.turnMutation.begin(KEY, view);

  assert.notEqual(pending, null);
  assert.equal(pending?.idempotencyKey, KEY);
  // The record is IN the committed view: that is what `startPolling`'s first tick reads, and what
  // keeps the send gate closed for the turn it names.
  assert.equal(h.committed.length, 1);
  const published = h.committed[0];
  assert.equal(published.kind, "ready");
  assert.equal(published.kind === "ready" ? (published.session?.pending?.idempotencyKey ?? null) : null, KEY);
  // The sentence about the attempt this one answers, and the poll failure that described it too.
  assert.deepEqual(h.sentences, [null]);
  assert.deepEqual(h.pollFailures, [null]);
  assert.equal(h.polls(), 1);
  assert.deepEqual(h.problems, []);
});

test("a profile that offers no available chat.submit sends nothing at all", () => {
  for (const availability of ["busy", "unavailable", "absent"] as const) {
    const view = ready(snapshot(availability));
    const h = harness(view);

    assert.equal(h.turnMutation.begin(KEY, view), null);
    // Not a partial press: no commit, no cleared sentence, no poll. A poll started here would be dead
    // on its first tick (it returns for a session with nothing pending) and the field would stay shut.
    assert.deepEqual(h.committed, []);
    assert.deepEqual(h.sentences, []);
    assert.deepEqual(h.pollFailures, []);
    assert.equal(h.polls(), 0);
  }
});

test("a record the state cannot produce is reported as the chat's problem, and still nothing is sent", () => {
  // `chat.submit` is available but there is no mounted Chat, so `pendingSubmission` rejects: the
  // projection the press was admitted against is not one a turn can start from.
  const view = ready(snapshot("available", false));
  const h = harness(view);

  assert.equal(h.turnMutation.begin(KEY, view), null);
  assert.equal(h.problems.length, 1);
  assert.ok(h.problems[0] instanceof ReferencePipelineSessionError);
  assert.equal((h.problems[0] as ReferencePipelineSessionError).code, "state_reconciliation_required");
  assert.deepEqual(h.committed, []);
  assert.equal(h.polls(), 0);
});

test("an answered refusal spends the record it published and forgets the turn it named", () => {
  const view = ready(snapshot("available"));
  const h = harness(view);
  const pending = h.turnMutation.begin(KEY, view);
  assert.notEqual(pending, null);

  h.turnMutation.settleFailure(refused());

  // Nothing ran, so no turn will ever settle the attempt: the record goes back to the composer and
  // the key stops naming a turn no one will finish.
  assert.equal(h.committed.length, 2);
  const settled = h.committed[1];
  assert.equal(settled.kind === "ready" ? (settled.session?.pending ?? null) : "not-ready", null);
  assert.equal(h.turnKeyRef.current, null);
});

test("an unanswered attempt keeps its record and its turn key for the poll to resolve", () => {
  const view = ready(snapshot("available"));
  const h = harness(view);
  const pending = h.turnMutation.begin(KEY, view);
  assert.notEqual(pending, null);

  h.turnMutation.settleFailure(new Error("the answer never arrived"));

  // Handing it back here would invite a resend of a message the Host may already be answering.
  assert.equal(h.committed.length, 1);
  assert.equal(h.turnKeyRef.current, "turn-key-of-the-attempt");
});

test("a shell holding no record commits nothing, and a view that is not ready is left alone", () => {
  const idle = ready(snapshot("available"));
  const h = harness(idle);
  h.turnMutation.settleFailure(refused());
  assert.deepEqual(h.committed, []);
  assert.equal(h.turnKeyRef.current, null);

  const unready = harness({ kind: "loading" });
  unready.turnMutation.settleFailure(refused());
  assert.deepEqual(unready.committed, []);
});

test("the shell has no second copy of the seam", () => {
  const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ComposedReferenceGameApp.tsx"), "utf8");
  assert.match(shell, /from "\.\/turn-mutation";/u);
  assert.match(shell, /createTurnMutation\(/u);
  assert.doesNotMatch(shell, /const beginTurnMutation =/u);
  assert.doesNotMatch(shell, /const settleFailedTurnMutation =/u);
  assert.doesNotMatch(shell, /const hostAnswered =/u);
});
