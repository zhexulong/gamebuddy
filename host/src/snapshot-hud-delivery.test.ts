import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, type PendingBatch, type WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import type { LocalStardewBridgeFact } from "./local-stardew-bridge.js";
import type { Scope, Snapshot } from "./protocol.js";
import { toWorldFact } from "./stardew-integration-launcher-body-program.internal.js";

/**
 * The world block has to reach the model on EVERY turn, including a turn whose only news is a receipt.
 *
 * <p>
 * This is where the defect lived. The pump holds a snapshot as latest state and hands it to the next batch, so the
 * state was present exactly once and then absent for every turn until the world was observed again. Measured on
 * `round44`: 102 of 109 delivered batches carried a snapshot at all, and the seven that carried none left the model
 * with only its own memory of the last one it saw.
 * </p>
 *
 * <p>
 * So the block is composed from the pump's own retained reading (`CompanionEventPump#lastSnapshot`) rather than from
 * the batch's snapshot slot, and it says WHICH reading it is: the revision, and whether this turn brought it. A
 * re-statement must not read as the current world.
 * </p>
 */

const scope: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_farm",
  worldId: "world_farm",
  playerId: "farmhand_01",
  companionId: "companion_01",
});

const worldSnapshot: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: { x: 5, y: 10 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: ["water_crop"],
  catalogRevision: 3,
  enabledActionIds: ["water_crop"],
  presentationLocale: "en-US",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "rain",
  currentTool: "Hoe",
  currentToolSlot: 1,
  cropTargets: [{ targetId: "crop_1", x: 4, y: 10, cropId: "24", displayName: "Cauliflower" }],
};

function snapshotFact(snapshot: Snapshot): WorldFact {
  return toWorldFact({
    type: "snapshot",
    messageId: `snapshot_${snapshot.revision}`,
    correlationId: `snapshot_${snapshot.revision}`,
    protocolVersion: 1,
    timestampMs: 1_700_000_000_000,
    scope,
    payload: snapshot,
  } as LocalStardewBridgeFact);
}

function receiptFact(executionId: string, revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: executionId,
    correlationId: executionId,
    revision,
    executionId,
    requestId: `request_${executionId}`,
    payload: Object.freeze({
      executionId,
      requestId: `request_${executionId}`,
      action: "water_crop",
      state: "succeeded",
      reasonCode: "watered",
      evidence: null,
      revision,
    }),
  }) as WorldFact;
}

function harness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  let lifecycleListener: ((event: { state: "disconnected"; reasonCode: string }) => void) | undefined;
  const events = {
    onFact(next: (fact: WorldFact) => void) {
      factListener = next;
      return () => {
        factListener = undefined;
      };
    },
    onLifecycle(next: (event: { state: "disconnected"; reasonCode: string }) => void) {
      lifecycleListener = next;
      return () => {
        lifecycleListener = undefined;
      };
    },
  };
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  const loop = {
    pump,
    async flush() {
      return await pump.flush({
        async deliver(batch) {
          batches.push(batch);
        },
      });
    },
    async steer() {
      return false;
    },
    async abortAndClear() {
      pump.clear();
    },
  };
  return {
    events,
    batches,
    emit: (fact: WorldFact) => factListener?.(fact),
    disconnect: (reasonCode = "adapter_closed") => lifecycleListener?.({ state: "disconnected", reasonCode }),
    loop,
  };
}

function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** The `<world-state>` block of one delivered batch, or a failure that names what is missing. */
function worldStateOf(batch: PendingBatch | undefined): string {
  const text = batch?.text ?? "";
  const matched = /<world-state>\n([\s\S]*?)\n<\/world-state>/u.exec(text);
  assert.ok(
    matched !== null,
    `the world block is missing from a batch whose text is: ${JSON.stringify(text.slice(0, 200))}`,
  );
  return matched[1] ?? "";
}

/** The block with the age clause removed: a re-statement may state its age and nothing else differently. */
function withoutAge(state: string): string {
  return state.replace(/（这是 \d+ 轮之前看到的，世界已经不一样了）(；)?/gu, "");
}

/** The block's BODY: everything after the first line, which names the revision and the freshness. */
function bodyOf(state: string): string {
  return withoutAge(state).split("\n").slice(1).join("\n");
}

test("a turn that carries an event and a turn that carries none both carry the same world block", async () => {
  const testHarness = harness();
  const service = new CompanionHostService(testHarness.loop as never, testHarness.events);

  testHarness.emit(snapshotFact(worldSnapshot));
  testHarness.emit(receiptFact("exec_watered_1", 7));
  await tick();

  assert.equal(testHarness.batches.length, 1, "the observation and the receipt coalesced into one turn");
  const first = testHarness.batches[0];
  assert.ok(
    first?.facts.some((fact) => fact.kind === "execution_receipt"),
    "the first turn was supposed to carry an event",
  );
  const firstState = worldStateOf(first);
  assert.match(firstState, /^世界（revision 7，刚刚更新）$/mu, "the block names the reading and that it is new");
  assert.match(firstState, /体力: 82/u, "and states the world it read");
  assert.match(firstState, /待浇水的作物 \(4,10\)/u, "including the objects she acts on, with their tiles");

  // No observation of its own: the only news is a receipt. The world must still be there, and it must say that it is
  // a reading from one turn back rather than present itself as the world as it stands.
  testHarness.emit(receiptFact("exec_watered_2", 8));
  await tick();

  assert.equal(testHarness.batches.length, 2);
  const second = testHarness.batches[1];
  assert.equal(
    second?.facts.some((fact) => fact.kind === "execution_receipt"),
    true,
    "the second turn was supposed to carry an event and no observation",
  );
  const secondState = worldStateOf(second);
  assert.match(secondState, /^世界（revision 7，本轮无新观察）$/mu, "a re-stated reading says so on its first line");
  assert.match(secondState, /（这是 1 轮之前看到的，世界已经不一样了）/u, "and how old it is");
  assert.equal(
    bodyOf(secondState),
    bodyOf(firstState),
    "the age is the only difference a re-statement makes: the block's body is byte for byte the same",
  );

  // "Nothing to say": the player spoke, the world did not.
  await service.acceptPlayerText("看看农场", "zh-CN", 1);
  assert.equal(testHarness.batches.length, 3);
  const third = testHarness.batches[2];
  assert.deepEqual(
    third?.facts.map((fact) => fact.kind),
    ["snapshot"],
    "the third turn was supposed to carry state and no event",
  );
  const thirdState = worldStateOf(third);
  assert.match(thirdState, /^世界（revision 7，本轮无新观察）$/mu);
  assert.match(thirdState, /（这是 2 轮之前看到的，世界已经不一样了）/u);

  service.close();
});

test("a session that has never been observed says so, and never invents a world", async () => {
  const testHarness = harness();
  const service = new CompanionHostService(testHarness.loop as never, testHarness.events);

  testHarness.emit(receiptFact("exec_before_any_observation", 1));
  await tick();

  assert.equal(testHarness.batches.length, 1);
  const state = worldStateOf(testHarness.batches[0]);
  assert.equal(state, "世界：尚未收到观察", "the absence of a reading is stated as an absence, in the same block");

  service.close();
});
