/**
 * GATE `stale_world_state_reaches_the_model`.
 *
 * <p>
 * The block's own first line already knows how old it is - `（这是 50 轮之前看到的，世界已经不一样了）` is the measured
 * sentence from `round45`'s last turn - and knowing it changed nothing: the parenthetical sits inside the block it
 * invalidates, reads as prose, names no number a gate can check, and asks for nothing. A reading that old is a FACT
 * about the session, so it must be a fact the model receives: `world_state_stale:<turns>;<revision>;<ageMs>`, at the
 * same time as the block it warns about, bounded to once per re-arm so a long freeze costs three lines and not fifty.
 * </p>
 *
 * <p>
 * The population here is every age a delivered block can state: the block is composed by ONE function, so the property
 * is asserted across the whole age range rather than at the two ages somebody remembered to write down.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, type PendingBatch, type WorldFact } from "./event-pump.js";
import { composeWorldState, WORLD_STATE_STALE_TURNS, worldStateStaleCode } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";

/** The reading the frozen window re-stated 50 times (`revision 352`, day 6, 06:00, standing in the farmhouse). */
const STUCK_READING = {
  revision: 352,
  location: "FarmHouse",
  tile: { x: 9, y: 9 },
  stamina: 270,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 600,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  currentTool: "(T)Axe",
  currentToolSlot: 0,
  toolSlots: [],
  inventoryItemFacts: [],
  cropTargets: [],
  harvestTargets: [],
} as unknown as Snapshot;

const STALE = "world_state_stale:";

test("a block older than the bound carries the stale token verbatim, and a fresh one does not", () => {
  const ages = Array.from({ length: 50 }, (_, index) => index + 1);
  assert.ok(ages.length > 0, "examined 0 ages - a check whose population is empty agrees with itself");
  for (const ageTurns of ages) {
    const text = composeWorldState({ snapshot: STUCK_READING, revision: 352, ageTurns, ageMs: ageTurns * 30_000 });
    if (ageTurns < WORLD_STATE_STALE_TURNS) {
      assert.ok(!text.includes(STALE), `stale token before the bound: age ${String(ageTurns)}`);
      continue;
    }
    const expected = worldStateStaleCode({ ageTurns, revision: 352, ageMs: ageTurns * 30_000 });
    assert.ok(
      text.includes(expected),
      `a block ${String(ageTurns)} turns old must carry ${expected} - it is the one number that says the world block is a memory`,
    );
  }
  console.log(`stale gate: examined ${String(ages.length)} block ages; bound ${String(WORLD_STATE_STALE_TURNS)} turns`);
});

test("the token names the reading it invalidates, so two stale blocks are not the same statement", () => {
  const older = composeWorldState({ snapshot: STUCK_READING, revision: 352, ageTurns: 48, ageMs: 1_500_000 });
  const newer = composeWorldState({
    snapshot: { ...STUCK_READING, revision: 400 } as Snapshot,
    revision: 400,
    ageTurns: 48,
    ageMs: 1_500_000,
  });
  assert.ok(older.includes("world_state_stale:48;352;1500000"), older);
  assert.ok(newer.includes("world_state_stale:48;400;1500000"), newer);
});

test("a delivered turn carries the stale token in the block, not only in prose", async () => {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  const flush = async () => {
    await pump.flush({
      async deliver(batch) {
        batches.push(batch);
      },
    });
  };
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    eventId: "snapshot_352",
    correlationId: "observe_352",
    revision: 352,
    payload: STUCK_READING as never,
  } satisfies WorldFact);
  await flush();
  // Forty-eight turns of narration from the reading that brought the first one: the measured shape of the freeze, where
  // the player said nothing and the world published nothing that reached her state block.
  for (let turn = 0; turn < 48; turn++) {
    pump.enqueuePlayerInput({
      source: "player_text",
      inputId: `input_${String(turn)}`,
      text: "接着做。",
      locale: "zh-CN",
      timestampMs: 1_790_000_000_000 + turn,
    });
    await flush();
  }
  const last = batches.at(-1);
  assert.ok(last !== undefined, "the last turn was delivered");
  assert.match(String(last.text), /<world-state>\n[\s\S]*world_state_stale:4[0-9];352;\d+/u);
});
