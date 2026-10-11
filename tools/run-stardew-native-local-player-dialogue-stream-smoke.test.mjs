import assert from "node:assert/strict";
import test from "node:test";

import { runDialogueStreamSmoke } from "./run-stardew-native-local-player-dialogue-stream-smoke.mjs";

/**
 * The dialogue-stream runner's decisions, offline.
 *
 * This runner had NO suite, and every defect it produced in one session was of the kind an offline test catches:
 * reading a field the wire does not carry (`payloadJson`, a JSON STRING - the Mod's shape), checking the wrong
 * page count, and taking the speaker from a constant instead of from the villager the fixture actually picked.
 * The fake therefore speaks the REAL wire shape; a fake that paraphrases it is what let those defects through.
 */

/** A client whose facts the test can emit, plus a talk runner that emits them at the right moment. */
function makeClient({ pages, speaker = "Lewis", emit = true }) {
  const listeners = [];
  const client = {
    onFact(listener) {
      listeners.push(listener);
      return () => {};
    },
    emitDialogue() {
      for (const listener of listeners)
        listener({
          type: "world_fact",
          eventId: "npc_dialogue_94_1",
          correlationId: "npc_dialogue_94_1",
          payload: {
            eventId: "npc_dialogue_94_1",
            sourceEventId: "npc_dialogue_94_1",
            kind: "npc_dialogue_presented",
            observedTick: 143,
            gameTime: "0600",
            revision: 3,
            // THE REAL SHAPE: the Mod carries the typed content as a JSON string.
            payloadJson: JSON.stringify({ speaker, pages, isQuestion: false, choices: [] }),
            deduplicationKey: "npc_dialogue_94_1",
          },
        });
    },
  };
  const talkRunner = async () => {
    if (emit) client.emitDialogue();
    return { state: "passed", reasonCode: "talk_to_npc_talked", npc: speaker, configuredFixtureScenario: "native_talk_to_npc_multi_page_v1" };
  };
  return { client, talkRunner };
}

const CONFIG = { NativeLocalPlayerFixture: { FixtureScenario: "native_talk_to_npc_multi_page_v1" } };

test("a native multi-page dialogue passes, and the pages come out of the payloadJson string", async () => {
  const { client, talkRunner } = makeClient({ pages: ["第一页", "第二页"] });
  const result = await runDialogueStreamSmoke(client, [], CONFIG, { talkRunner, factWindowMs: 50 });

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "dialogue_stream_paged_and_reported");
  assert.equal(result.observed.maxPages, 2);
  assert.deepEqual(result.observed.speakers, ["Lewis"]);
  assert.equal(result.observed.pagedAs, "multi_page_single_box");
  // And the recorded fact carries the payload shape the checker reads.
  assert.equal(result.bridgeFacts[0].worldFactKind, "npc_dialogue_presented");
  assert.equal(JSON.parse(result.bridgeFacts[0].worldFactPayload.payloadJson).pages.length, 2);
});

test("one page is BLOCKED, not passed: the claim is that the pager advanced", async () => {
  const { client, talkRunner } = makeClient({ pages: ["只有一页"] });
  const result = await runDialogueStreamSmoke(client, [], CONFIG, { talkRunner, factWindowMs: 50 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^dialogue_stream_only_one_page:maxPages=1/);
});

test("the speaker is the villager the fixture PICKED, not a hard-coded one", async () => {
  // The fixture's content search may choose Lewis; a runner that insisted on Gus failed a correct run.
  const { client, talkRunner } = makeClient({ pages: ["a", "b"], speaker: "Robin" });
  const result = await runDialogueStreamSmoke(client, [], CONFIG, { talkRunner, factWindowMs: 50 });
  assert.equal(result.state, "passed", "the talk runner reports Robin, so Robin is the expected speaker");

  const wrong = makeClient({ pages: ["a", "b"], speaker: "Robin" });
  const mismatch = await runDialogueStreamSmoke(wrong.client, [], CONFIG, {
    talkRunner: async () => {
      // It must still emit: this fake REPLACES the built-in talk runner, and a replacement that never speaks would
      // make the case `unobserved` instead of the speaker mismatch under test.
      wrong.client.emitDialogue();
      return { state: "passed", reasonCode: "talk_to_npc_talked", npc: "Gus" };
    },
    factWindowMs: 50,
  });
  assert.equal(mismatch.state, "blocked");
  assert.match(mismatch.reasonCode, /speaker_unexpected/);
});

test("no fact at all is UNOBSERVED, never passed", async () => {
  const { client, talkRunner } = makeClient({ pages: ["a"], emit: false });
  const result = await runDialogueStreamSmoke(client, [], CONFIG, { talkRunner, factWindowMs: 50 });

  assert.equal(result.state, "unobserved");
  assert.match(result.reasonCode, /npc_dialogue_not_reported/);
  assert.deepEqual(result.bridgeFacts, []);
});

test("a talk that blocks is reported with ITS reason, not folded into this gate's verdict", async () => {
  const { client } = makeClient({ pages: [] });
  const result = await runDialogueStreamSmoke(client, [], CONFIG, {
    talkRunner: async () => ({ state: "blocked", reasonCode: "native_snapshot_not_actionable" }),
    factWindowMs: 50,
  });

  assert.equal(result.state, "unobserved");
  assert.equal(result.talk.reasonCode, "native_snapshot_not_actionable");
});

test("a payload that is not the Mod's shape is refused rather than half-read", async () => {
  const listeners = [];
  const client = {
    onFact(listener) {
      listeners.push(listener);
      return () => {};
    },
  };
  const talkRunner = async () => {
    // Structured payload instead of the JSON string: must NOT be invented into pages.
    for (const listener of listeners)
      listener({
        type: "world_fact",
        eventId: "e1",
        correlationId: "e1",
        payload: { kind: "npc_dialogue_presented", observedTick: 1, revision: 1 },
      });
    return { state: "passed", reasonCode: "talk_to_npc_talked", npc: "Lewis" };
  };
  const result = await runDialogueStreamSmoke(client, [], CONFIG, { talkRunner, factWindowMs: 50 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /without_readable_content/);
});
