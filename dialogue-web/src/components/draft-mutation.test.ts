import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import { composedProblemView } from "../composed-problem-view";
import { messages } from "../i18n";
import { type BrowserDraftV1, TavernProblemError, type TavernStateSnapshotV1 } from "../reference-pipeline-api";
import { createReferencePipelineSession } from "../reference-pipeline-session";
import type { ReadyView, ViewState } from "./composed-reference-game-view";
import { createDraftMutation, type DraftNotice } from "./draft-mutation";

/**
 * The durable-draft envelope, driven through its own factory.
 *
 * What it must keep true, and what the shell would lose if the two controls spelled it for
 * themselves: a save sends the composer's trimmed text under the generation and revision this mount
 * holds, and its kept read-back becomes the field; a refusal says the catalogue's sentence for it and
 * takes only the REVISION from the read-back that follows - never the words - because the text in the
 * field is the player's and not the Host's to replace (AGENTS.md, "Draft preservation"); and a press
 * with no mounted Chat, or no selection to be stale against, sends nothing at all.
 *
 * The last test is the extraction's own guard: the shell must not grow a second copy of the seam.
 */

const CSRF = "csrf-token";
/** The generation and revision the mounted projection holds, which every command must carry. */
const GENERATION = 3;
const REVISION = 7;

/** The smallest snapshot a session accepts, with the selection the draft routes are bound to. */
function snapshot(): TavernStateSnapshotV1 {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: CSRF,
    browserSession: { expiresAtMs: 1 },
    operations: [],
    navigation: [],
    selection: { chatHandle: "chat-1", generation: GENERATION, stateRevision: "revision-1" },
    chat: {
      companion: { name: "Mira", handle: "mira" },
      title: null,
      transcript: [],
      draft: { revision: REVISION, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
    eventStream: null,
  };
}

function ready(): ReadyView {
  const state = snapshot();
  const root: ComposedReferenceGameBrowserRootV1 = {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: state,
    game: null,
  };
  return {
    kind: "ready",
    root,
    session: createReferencePipelineSession(state),
    draft: { apiVersion: 1, revision: REVISION, text: null },
    locale: "en",
    chatProblem: null,
  };
}

/** The draft a landed write read back: what the Host kept, at the revision it kept it at. */
const kept: BrowserDraftV1 = { apiVersion: 1, revision: REVISION + 1, text: "the Host's copy" };
/** The draft a refusal's read-back answers with: the same authority, moved to a revision this mount does not hold. */
const durable: BrowserDraftV1 = { apiVersion: 1, revision: REVISION + 2, text: "an older copy the tab never saw" };

/** A refusal of the draft route: the Host answered, and what it answered is a stale revision. */
const conflicted = (): TavernProblemError =>
  new TavernProblemError({
    type: "https://gamebuddy.dev/problems/draft-conflict",
    title: "The draft moved",
    status: 409,
    code: "draft_conflict",
    requestId: "request-1",
    retryable: false,
  });

type HarnessOptions = Readonly<{ field?: string; refusal?: unknown; readBackFails?: boolean }>;

function harness(view: ViewState, options: HarnessOptions = {}) {
  const calls: { route: "save" | "discard"; command: unknown; csrfToken: string }[] = [];
  const committed: ViewState[] = [];
  const notices: DraftNotice[] = [];
  const seeded: BrowserDraftV1[] = [];
  const viewRef = { current: view };
  const inputTextRef = { current: options.field ?? "" };
  const draftMutation = createDraftMutation({
    viewRef,
    inputTextRef,
    api: {
      readDraft: async () => {
        if (options.readBackFails === true) throw new Error("the read-back never arrived");
        return durable;
      },
      saveDraft: async (command, csrfToken) => {
        calls.push({ route: "save", command, csrfToken });
        if (options.refusal !== undefined) throw options.refusal;
        return kept;
      },
      discardDraft: async (command, csrfToken) => {
        calls.push({ route: "discard", command, csrfToken });
        if (options.refusal !== undefined) throw options.refusal;
        return kept;
      },
    },
    seedDraft: (draft) => {
      seeded.push(draft);
    },
    setDraftNotice: (notice) => {
      notices.push(notice);
    },
    commit: (next) => {
      committed.push(next);
      viewRef.current = next;
    },
    labels: () => messages("en"),
  });
  return { draftMutation, calls, committed, notices, seeded };
}

test("a save sends the field's trimmed words under the generation and revision the mount holds", async () => {
  const h = harness(ready(), { field: "  the words in flight  " });

  await h.draftMutation("save");

  assert.deepEqual(h.calls, [
    {
      route: "save",
      command: {
        apiVersion: 1,
        selectionGeneration: GENERATION,
        expectedRevision: REVISION,
        text: "the words in flight",
      },
      csrfToken: CSRF,
    },
  ]);
  // The kept read-back IS the field's new truth, and the durable revision the mount now CASes against.
  assert.deepEqual(h.seeded, [kept]);
  assert.deepEqual(h.notices, [{ kind: "success", text: messages("en").success }]);
  assert.equal(h.committed.length, 1);
  assert.deepEqual(h.committed[0].kind === "ready" ? h.committed[0].draft : null, kept);
});

test("a discard sends no words at all", async () => {
  const h = harness(ready(), { field: "text a discard must not carry" });

  await h.draftMutation("discard");

  assert.deepEqual(h.calls, [
    {
      route: "discard",
      command: { apiVersion: 1, selectionGeneration: GENERATION, expectedRevision: REVISION },
      csrfToken: CSRF,
    },
  ]);
  // A discard that landed still hands the field the Host's kept (now empty) draft.
  assert.deepEqual(h.seeded, [kept]);
  assert.deepEqual(h.notices, [{ kind: "success", text: messages("en").success }]);
  assert.equal(h.committed.length, 1);
});

test("a refused save says the refusal and takes only the revision - never the words", async () => {
  const refusal = conflicted();
  const h = harness(ready(), { field: "the sentence the player is writing", refusal });

  await h.draftMutation("save");

  // The refusal's own sentence, which is the catalogue's for the code the Host named - not the
  // generic failure, which is what a player cannot act on.
  assert.deepEqual(h.notices, [{ kind: "failure", text: messages("en").problemRevisionConflictDetail }]);
  assert.notEqual(h.notices[0].text, messages("en").failure);
  // THE RULE: the read-back may never reach the composer. A 409 replaced the sentence in flight with
  // the Host's older copy once, which is player input discarded by a failure they did not cause.
  assert.deepEqual(h.seeded, []);
  assert.equal(h.calls.length, 1);
  // The revision it read IS committed, because that is what the next save compare-and-swaps against.
  assert.equal(h.committed.length, 1);
  assert.deepEqual(h.committed[0].kind === "ready" ? h.committed[0].draft : null, durable);
});

test("a refusal whose read-back also failed keeps the revision it had and says nothing else", async () => {
  const h = harness(ready(), { field: "still the player's", refusal: conflicted(), readBackFails: true });

  await h.draftMutation("save");

  assert.deepEqual(h.notices, [{ kind: "failure", text: messages("en").problemRevisionConflictDetail }]);
  // No read-back arrived, so there is no revision to take and no text to take either: the mount keeps
  // the one it had and the next save states the same conflict rather than guessing.
  assert.deepEqual(h.committed, []);
  assert.deepEqual(h.seeded, []);
});

test("a shell whose mount never became ready sends nothing at all", async () => {
  // The two unready states a mount can hold: the opening read, and the problem page that replaced it.
  for (const view of [
    { kind: "loading" } as const,
    composedProblemView(new Error("the read failed"), messages("en")),
  ]) {
    for (const kind of ["save", "discard"] as const) {
      const h = harness(view, { field: "the words the player typed before the read failed" });
      await h.draftMutation(kind);
      // Not a partial press: no wire call, no notice about a press that never ran, no commitment.
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.notices, []);
      assert.deepEqual(h.committed, []);
      assert.deepEqual(h.seeded, []);
    }
  }
});

test("the shell has no second copy of the seam", () => {
  const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ComposedReferenceGameApp.tsx"), "utf8");
  assert.match(shell, /from "\.\/draft-mutation";/u);
  assert.match(shell, /createDraftMutation\(/u);
  // The CAS, the read-back and the three routes are the module's, so the shell cannot spell either
  // press for itself again.
  assert.doesNotMatch(shell, /const handleDraftMutation = async/u);
  assert.doesNotMatch(shell, /saveDraft\(/u);
  assert.doesNotMatch(shell, /discardDraft\(/u);
  assert.doesNotMatch(shell, /readDraft\(/u);
});
