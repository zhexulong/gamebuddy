import assert from "node:assert/strict";
import test from "node:test";

import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import { TavernProblemError, type TavernStateSnapshotV1 } from "../reference-pipeline-api";
import { createReferencePipelineSession } from "../reference-pipeline-session";
import { messages } from "../i18n";
import type { Locale } from "../i18n";
import type { ReadyView, ViewState } from "./composed-reference-game-view";
import {
  CHAT_MUTATION_KINDS,
  FOLD_REACHING_REMOVAL_KINDS,
  type ChatMutationKind,
  type MessageMutationOutcome,
  createMessageMutation,
} from "./message-mutation";

/**
 * The envelope's one sentence after a press LANDS.
 *
 * Every mutation here rewrites the conversation and returns nothing to the player: the transcript
 * pays for it, the reread reports it, and the words are the whole of what they are told. For the two
 * kinds that take words away that silence was also a false promise - a rewind and a delete reach the
 * transcript and the model's session, and they do NOT reach what the fold already summarised from
 * those words (`design/tasks/active/finding-tavern-cut-leaves-folded-history.md`). So the family
 * that removes words owes one sentence saying where the removed words still live, and every other
 * kind owes nothing - a swipe that lands is not a loss and must not read as one.
 *
 * The population these cases walk is `FOLD_REACHING_REMOVAL_KINDS`, not a literal list here: a kind
 * that joins the removal family is judged by the same cases the moment it is declared.
 */

const CSRF = "csrf-token";

function snapshot(): TavernStateSnapshotV1 {
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
    eventStream: null,
  };
}

function ready(locale: Locale = "en"): ReadyView {
  const chat = snapshot();
  const root: ComposedReferenceGameBrowserRootV1 = {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat,
    game: null,
  };
  return {
    kind: "ready",
    root,
    session: createReferencePipelineSession(chat),
    draft: { apiVersion: 1, revision: 1, text: null },
    locale,
    chatProblem: null,
  };
}

function harness(view: ViewState) {
  const notices: (string | null)[] = [];
  let rereads = 0;
  const mutation = createMessageMutation({
    viewRef: { current: view },
    chatMutationRef: { current: false },
    beginMessageMutation: (_kind, _handle) => undefined,
    rereadChat: async () => {
      rereads += 1;
    },
    commit: () => undefined,
    setMessageMutationNotice: (sentence) => {
      notices.push(sentence);
    },
    setChatMutation: () => undefined,
  });
  return { mutation, notices, rereads: () => rereads };
}

/** One press of one kind, against a wire call that answers with nothing. */
async function press(kind: ChatMutationKind, view = ready()) {
  const h = harness(view);
  const outcome = await h.mutation({ kind, handle: "handle-1", send: async () => undefined });
  return { h, outcome };
}

test("message-mutation.1: the removal family tells the player where the removed words still live", async (t) => {
  assert.notEqual(FOLD_REACHING_REMOVAL_KINDS.length, 0, "the family must not be empty");
  let checked = 0;
  for (const locale of ["en", "zh-CN"] as const) {
    const sentence = messages(locale).removedWordsMayStillBeInMemory;
    assert.equal(
      typeof sentence,
      "string",
      `the ${locale} catalogue must carry the sentence a landed removal owes the player`,
    );
    assert.ok(sentence.length > 0, `the ${locale} sentence must not be empty`);
    for (const kind of FOLD_REACHING_REMOVAL_KINDS) {
      const { h, outcome } = await press(kind, ready(locale));
      checked += 1;
      assert.deepEqual(outcome, { kind: "landed" }, `${kind} must land`);
      assert.deepEqual(h.notices, [sentence], `${kind} must say it once, in ${locale}`);
    }
  }
  t.diagnostic(`message-mutation.1: ${checked} landed removal press(es) said the sentence, both locales`);
});

test("message-mutation.2: no other mutation says it, and none of them says anything", async (t) => {
  const others = CHAT_MUTATION_KINDS.filter(
    (kind) => !(FOLD_REACHING_REMOVAL_KINDS as readonly ChatMutationKind[]).includes(kind),
  );
  assert.notEqual(others.length, 0, "the complement must not be empty, or this case measures nothing");
  for (const kind of others) {
    const { h, outcome } = await press(kind);
    assert.deepEqual(outcome, { kind: "landed" });
    assert.deepEqual(h.notices, [], `${kind} takes nothing away and must not speak of a loss`);
  }
  t.diagnostic(`message-mutation.2: ${others.length} non-removal kind(s) said nothing`);
});

test("message-mutation.3: a refused removal says the refusal and not the limit", async () => {
  // The sentence is true only of a press that LANDED. A refused rewind took nothing away, so saying
  // the words are gone would be the second lie on the same row.
  for (const kind of FOLD_REACHING_REMOVAL_KINDS) {
    const h = harness(ready());
    const outcome: MessageMutationOutcome = await h.mutation({
      kind,
      handle: "handle-1",
      send: async () => {
        throw new TavernProblemError({
          type: "https://gamebuddy.dev/problems/rewind-busy",
          title: "The turn is still running",
          status: 409,
          code: "chat_rewind_turn_active",
          requestId: "request-1",
          retryable: false,
        });
      },
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(h.notices.length, 1, `${kind} says exactly one sentence on a refusal`);
    assert.notEqual(h.notices[0], messages("en").removedWordsMayStillBeInMemory);
  }
});

test("message-mutation.4: the family names only kinds the envelope knows, once each", () => {
  const declared = new Set<ChatMutationKind>(CHAT_MUTATION_KINDS);
  assert.equal(new Set(FOLD_REACHING_REMOVAL_KINDS).size, FOLD_REACHING_REMOVAL_KINDS.length, "no duplicates");
  for (const kind of FOLD_REACHING_REMOVAL_KINDS) assert.ok(declared.has(kind), `${kind} is not a mutation kind`);
});
