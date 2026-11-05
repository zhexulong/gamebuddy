import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, type WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import type { LocalStardewBridgeFact } from "./local-stardew-bridge.js";
import type { Scope, Snapshot } from "./protocol.js";
import { formatSnapshotHud } from "./snapshot-hud.js";
import { toWorldFact } from "./stardew-integration-launcher-body-program.internal.js";

/**
 * The state block has to reach the model on EVERY turn, including a turn whose only news is a receipt.
 *
 * This is where the defect lived: the pump holds a snapshot as latest state and hands it to the next batch, so
 * the block is present exactly once and then absent for every turn until the world is observed again. The Host
 * re-states the snapshot before composing each turn (`CompanionHostService.#restateWorldSnapshot`), and these
 * two turns are the assertion - the second one has no observation of its own.
 *
 * A re-stated block also has to admit that it is a re-statement: nothing refreshes a snapshot between turns, so a
 * block that reads like the current world is a three-turn-old clock presented as now (`snapshot-hud.test.ts` pins
 * the wording). Here the assertion is that the age is the ONLY thing a re-statement changes.
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
  const batches: string[] = [];
  const loop = {
    pump,
    async flush() {
      return await pump.flush({
        async deliver(text) {
          batches.push(text);
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

function batchAt(batches: readonly string[], index: number) {
  return JSON.parse(batches[index] ?? "{}") as {
    worldFacts: ReadonlyArray<{ kind: string; payload: Readonly<Record<string, unknown>> }>;
  };
}

function hudOf(batch: ReturnType<typeof batchAt>): string {
  const snapshot = batch.worldFacts.find((fact) => fact.kind === "snapshot");
  const hud = snapshot?.payload.hud;
  assert.equal(typeof hud, "string", "the delivered batch carried no state block");
  return hud as string;
}

/**
 * The block with any age clause removed.
 *
 * A re-stated block is allowed to say how old the reading is - it is NOT allowed to say anything else differently,
 * which is what this makes assertable byte for byte.
 */
function withoutAge(hud: string): string {
  return hud.replace(/ \(observed \d+ turns? ago - not the current world\)/gu, "");
}

test("a turn that carries an event and a turn that carries none both carry the same state block", async () => {
  const testHarness = harness();
  const service = new CompanionHostService(testHarness.loop as never, testHarness.events);

  testHarness.emit(snapshotFact(worldSnapshot));
  testHarness.emit(receiptFact("exec_watered_1", 7));
  await tick();

  assert.equal(testHarness.batches.length, 1, "the observation and the receipt coalesced into one turn");
  const first = batchAt(testHarness.batches, 0);
  assert.ok(
    first.worldFacts.some((fact) => fact.kind === "execution_receipt"),
    "the first turn was supposed to carry an event",
  );
  const firstHud = hudOf(first);
  assert.equal(firstHud, formatSnapshotHud(worldSnapshot));
  assert.match(firstHud, /stamina: 82/u);

  // No observation of its own: the only news is a receipt. The state must still be there, and it must say that it is
  // a reading from one turn back rather than present itself as the world as it stands.
  testHarness.emit(receiptFact("exec_watered_2", 8));
  await tick();

  assert.equal(testHarness.batches.length, 2);
  const second = batchAt(testHarness.batches, 1);
  assert.equal(
    second.worldFacts.some((fact) => fact.kind === "execution_receipt"),
    true,
    "the second turn was supposed to carry an event and no observation",
  );
  assert.equal(withoutAge(hudOf(second)), firstHud, "the age clause is the only difference a re-statement may make");
  assert.match(hudOf(second), /^- time: 06:20 \(observed 1 turn ago - not the current world\)$/mu);

  // "Nothing to say": the player spoke, the world did not. No event fact enters this turn at all, and the
  // state still arrives - otherwise the model answers from whatever it remembers.
  await service.acceptPlayerText("看看农场", "zh-CN", 1);
  assert.equal(testHarness.batches.length, 3);
  const third = batchAt(testHarness.batches, 2);
  assert.deepEqual(
    third.worldFacts.map((fact) => fact.kind),
    ["snapshot"],
    "the third turn was supposed to carry state and no event",
  );
  assert.equal(withoutAge(hudOf(third)), firstHud);
  assert.match(hudOf(third), /^- time: 06:20 \(observed 2 turns ago - not the current world\)$/mu);

  service.close();
});
