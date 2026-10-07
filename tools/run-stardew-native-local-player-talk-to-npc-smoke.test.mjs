import assert from "node:assert/strict";
import test from "node:test";
import { runTalkToNpcSmoke } from "./run-stardew-native-local-player-talk-to-npc-smoke.mjs";

const ACTION = "talk_to_npc";
const UNKNOWN_TARGET_ID = "npc_relationship_0000000000000000";
const VILLAGER = { targetId: "npc_relationship_abcdef0123456789", npcName: "Abigail", x: 31, y: 20 };

/** A snapshot the runner can act on: one adjacent villager and a free actor. */
function snapshotWith({ revision, actionable = true, activeExecution = null, targets = [VILLAGER] }) {
  return {
    revision,
    location: "Town",
    tile: { x: 30, y: 21 },
    actionable,
    activeExecution,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    npcRelationshipTargets: targets,
  };
}

const TALK_EVIDENCE = (target, { dialogueUp = "true", boxUp = "true", handled = "true" } = {}) =>
  `location=Town;target=${target};npc=Abigail;tile=${VILLAGER.x},${VILLAGER.y}` +
  `;native_handled=${handled};dialogue_up_before=false;dialogue_up_after=${dialogueUp};` +
  `dialogue_box_after=${boxUp};menu_open_after=${boxUp === "true" ? "DialogueBox" : "none"};` +
  `talked_to_today_before=false;talked_to_today_after=true;points_before=100;points_after=120;` +
  `player_can_move_after=${dialogueUp === "true" ? "false" : "true"}`;

/**
 * The runner is the thing under test, so the client is a real one in shape: it answers the
 * same calls the harness makes and moves the world the way the native seam would. A talk
 * only succeeds when the actor is free and the request named a published villager, and it
 * leaves the actor inside the native DialogueBox — which is exactly the rule under test.
 */
function makeClient({ holdingItem = false, targets = [VILLAGER] } = {}) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, targets }) },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const live = client.state.snapshot;
      const base = { requestId: request.requestId, revision: live.revision + 1 };
      // An id nobody published: the Mod's own re-resolution refuses it and nothing moves.
      if (request.args.expectedTargetId === UNKNOWN_TARGET_ID) {
        const receipt = {
          ...base,
          executionId: "talk-execution-unknown-target",
          state: "rejected",
          reasonCode: "talk_to_npc_target_not_found",
          evidence: { detail: `target=${UNKNOWN_TARGET_ID};location=Town;villagers_present=1` },
        };
        receipts.push(receipt);
        return receipt;
      }
      if (!live.actionable) {
        const receipt = {
          ...base,
          executionId: "talk-execution-not-actionable",
          state: "rejected",
          reasonCode: "player_not_actionable",
          evidence: { detail: null },
        };
        receipts.push(receipt);
        return receipt;
      }
      if (holdingItem) {
        const receipt = {
          ...base,
          executionId: "talk-execution-hands-not-empty",
          state: "rejected",
          reasonCode: "hands_not_empty",
          evidence: { detail: `target=${VILLAGER.targetId};npc=Abigail;hand_item=(O)24` },
        };
        receipts.push(receipt);
        return receipt;
      }
      const receipt = {
        ...base,
        executionId: "talk-execution",
        state: "succeeded",
        reasonCode: "talk_to_npc_talked",
        evidence: { detail: TALK_EVIDENCE(VILLAGER.targetId) },
      };
      client.state.snapshot = snapshotWith({
        revision: receipt.revision,
        actionable: false,
        targets,
      });
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

const run = (options) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runTalkToNpcSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

/** Replace the client's answer for one predicate, keeping everything else real. */
function withForcedReceipt(session, predicate, change) {
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (predicate(receipt)) change(receipt, session);
    return receipt;
  };
}

test("talk_to_npc: the dialogue is asserted from the world, and both negatives hold", async () => {
  const session = run();
  const result = await session.result();

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "talk_to_npc_talked");
  assert.equal(result.npc, "Abigail");
  // The talk left the actor inside the native dialog, so the Mod's actionability projection
  // says the actor is no longer free.
  assert.equal(result.dialogue.actionableAfter, false);
  assert.equal(result.negatives.unknownTarget.reasonCode, "talk_to_npc_target_not_found");
  assert.equal(result.negatives.unknownTarget.actionable, true);
  assert.equal(result.negatives.repeat.reasonCode, "player_not_actionable");
  assert.equal(result.negatives.repeat.actionable, false);
});

test("talk_to_npc: an unknown target that is not refused fails the run", async () => {
  // A forged success on an id nobody published is the failure this negative exists for.
  const session = run();
  withForcedReceipt(session, (receipt) => receipt.executionId === "talk-execution-unknown-target", (receipt) => {
    receipt.state = "succeeded";
    receipt.reasonCode = "talk_to_npc_talked";
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_unknown_target_not_refused/);
});

test("talk_to_npc: a claimed talk that left the world actionable fails the run", async () => {
  // The receipt says the dialog is up, but the Mod's own snapshot still says the actor is
  // free. A green receipt is not evidence.
  const session = run();
  withForcedReceipt(session, (receipt) => receipt.state === "succeeded", (receipt, current) => {
    current.client.state.snapshot = snapshotWith({ revision: receipt.revision, actionable: true });
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_world_unchanged/);
});

test("talk_to_npc: a successful repeat while the dialog is up fails the run", async () => {
  // Stacking a second conversation on an open DialogueBox is the failure this pins.
  const session = run();
  withForcedReceipt(
    session,
    (receipt) => receipt.reasonCode === "player_not_actionable",
    (receipt) => {
      receipt.state = "succeeded";
      receipt.reasonCode = "talk_to_npc_talked";
    },
  );
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_repeat_stacked_dialogue/);
});

test("talk_to_npc: a repeat refused for another reason fails the run", async () => {
  const session = run();
  withForcedReceipt(
    session,
    (receipt) => receipt.reasonCode === "player_not_actionable",
    (receipt) => {
      receipt.reasonCode = "talk_to_npc_target_not_found";
    },
  );
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_repeat_not_refused/);
});

test("talk_to_npc: a refusal that still released the dialog fails the run", async () => {
  // The repeat is refused honestly, but the world moved anyway: the first dialog was lost.
  const session = run();
  withForcedReceipt(
    session,
    (receipt) => receipt.reasonCode === "player_not_actionable",
    (receipt, current) => {
      current.client.state.snapshot = snapshotWith({ revision: receipt.revision, actionable: true });
    },
  );
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_repeat_moved_world/);
});

test("talk_to_npc: evidence that omits the observed dialogue fails the run", async () => {
  // The evidence is checked as evidence, separately from the world.
  const session = run();
  withForcedReceipt(session, (receipt) => receipt.state === "succeeded", (receipt) => {
    receipt.evidence = { detail: `location=Town;target=${VILLAGER.targetId};npc=Abigail;native_handled=true` };
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_evidence_dialogue_up_after/);
});

test("talk_to_npc: an actor who is holding something is the declared Given absent", async () => {
  // The talk branch is the EMPTY-HANDED half; with an object in hand native takes the gift
  // path instead. The fixture owes an empty-handed actor, so this is a run precondition,
  // not a product verdict.
  const session = run({ holdingItem: true });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "talk_to_npc_declared_given_absent:Abigail");
});

test("talk_to_npc: no adjacent advertised villager means the run cannot start", async () => {
  const far = { ...VILLAGER, x: 40, y: 40 };
  const session = run({ targets: [far] });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "talk_to_npc_no_adjacent_villager:tile=30,21;location=Town;actionable=true;targets=Abigail@40,40");
});
