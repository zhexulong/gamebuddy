import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import {
  AUTO_OBSERVE_ON_STALE,
  AUTO_OBSERVE_UNAVAILABLE,
  AUTO_OBSERVE_UNAVAILABLE_REASONS,
  AUTO_OBSERVE_UNAVAILABLE_TOKEN,
  CompanionEventPump,
  WORLD_STATE_REFRESH_ATTEMPTS,
  type WorldFact,
  type WorldStateRefreshPort,
  autoObserveOnStaleToken,
  autoObserveUnavailableToken,
  turnAccountLine,
} from "./event-pump.js";
import { WORLD_STATE_STALE_TURNS, worldStateStaleThreshold } from "./fact-brief.js";

/**
 * A stale observation triggers an OBSERVATION, not a conversation.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`): of 64 delivered turns, 41 carried speech and nothing else, and 22 of those 41 were
 * handed `world_state_stale:...`. The Host opened a turn to tell her that the world she could not see was out of date,
 * and the cheapest thing she could do with that turn was describe it. She said so herself, verbatim: "a line of speech
 * passes, the cost is zero; submitting a plan may be refused, may fail, and has to be awaited".
 * </p>
 *
 * <p>
 * The observation is not a thing she has to be told about. `StardewBridgeConnection.observe`
 * (`host/src/local-stardew-bridge.ts:366`) sends `observe_request` and the Mod answers a snapshot only when asked, so the
 * Host owns the ask; `stardew_observe`, the execute path's `stale_snapshot` re-take and `refreshAfterCatalogUpdate` all
 * call it. The pump already held the same ask (`WorldStateRefreshPort.observe`, attached in
 * `continuity-semantic-game-runtime-materializer.ts:1495`) but fired it BESIDE the turn instead of instead of it.
 * </p>
 *
 * <p>
 * So this suite is one property: a crossed reading produces either one refresh (and no turn) or one named reason the
 * world could not be asked (and the turn opens as it always did). Both directions are proved on the REAL pre-change
 * module, compiled out of `2c5526ea`, because a hand-written old line proves only that a reader refuses a string.
 * </p>
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(HERE, "..");

/** The commit whose `event-pump.ts` is the module BEFORE this unit: `2c5526ea` is `c63a5763`'s blob, restored. */
const PRE_CHANGE_REVISION = "2c5526ea";

/** The world as the Mod admitted it: a free body standing on the Farm. */
const FREE_BODY = Object.freeze({ location: "Farm", gameTime: "0740", actionable: true, revision: 352 });

function snapshotFact(revision: number, observedTick: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: 1_790_000_000_000 + observedTick,
    payload: { ...FREE_BODY, revision },
  });
}

/** A fact the world really published: the clock moving is what makes the held reading a picture the world contradicted. */
function movedFact(index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 900,
    observedTick: index,
    occurredAtMs: 1_790_000_000_000 + index * 1_000,
    semanticKind: "time_milestone",
    payload: Object.freeze({ kind: "time_milestone", milestone: 1200 }),
  });
}

/** The number of delivered turns that reach the FIRST crossing of `WORLD_STATE_STALE_TURNS`. */
const FIRST_CROSSING_TURNS = worldStateStaleThreshold(0) + 1;

/** One turn, admitted the way the Host admits it: the fact, then whatever the pump minted for it, then the delivery. */
async function deliverTurn(
  pump: CompanionEventPump,
  fact: WorldFact,
  minted: WorldFact[] = [],
): Promise<{ opened: boolean; batchKinds: readonly string[] }> {
  pump.enqueueFact(fact);
  const stale = pump.takeWorldStateStaleFact();
  if (stale !== undefined) {
    minted.push(stale);
    pump.enqueueFact(stale);
  }
  const before = pump.turnAccount.opened;
  let batchKinds: readonly string[] = Object.freeze([]);
  await pump.flush({
    async deliver(batch) {
      batchKinds = Object.freeze(batch.facts.map((one) => one.semanticKind ?? one.kind));
    },
  });
  return { opened: pump.turnAccount.opened > before, batchKinds };
}

/** The refusal is published from a promise continuation, so it lands after the turn that produced it. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The pump and the window `round47` measured over: one reading, then `FIRST_CROSSING_TURNS` turns of a clock that moved
 * while the reading did not. Returns the account line a run would print.
 */
async function crossedReadingLine(port?: WorldStateRefreshPort): Promise<{
  pump: CompanionEventPump;
  line: string;
  turns: readonly Readonly<{ opened: boolean; batchKinds: readonly string[] }>[];
}> {
  const pump = new CompanionEventPump();
  if (port !== undefined) pump.attachWorldStateRefresh(port);
  const turns: Array<Readonly<{ opened: boolean; batchKinds: readonly string[] }>> = [];
  turns.push(await deliverTurn(pump, snapshotFact(352, 0)));
  for (let turn = 1; turn <= FIRST_CROSSING_TURNS; turn += 1) turns.push(await deliverTurn(pump, movedFact(turn)));
  await drained();
  return { pump, line: turnAccountLine(pump.turnAccount), turns };
}

/**
 * `2c5526ea`'s `event-pump.ts`, emitted and made importable, or `undefined` when that revision is not in this clone.
 *
 * The file is written outside the repository: `dist-test` is a locked, inventoried artifact, and a stray module in it
 * would be indistinguishable from a half-written build.
 */
function compilePreChangePump(): string | undefined {
  let source: string;
  try {
    source = execFileSync("git", ["-C", HOST_ROOT, "show", `${PRE_CHANGE_REVISION}:host/src/event-pump.ts`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  // The pin must BE the pre-change module: if it ever named a tree that already carries this unit, the red proof below
  // would pass by agreeing with itself.
  assert.equal(
    source.includes(AUTO_OBSERVE_ON_STALE),
    false,
    `${PRE_CHANGE_REVISION}:host/src/event-pump.ts already carries ${AUTO_OBSERVE_ON_STALE}, so it is not the pre-change module`,
  );
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "event-pump.ts",
  }).outputText;
  const rewritten = emitted.replace(
    /from "(\.[^"]+)"/gu,
    (_match, specifier: string) => `from "${pathToFileURL(resolve(HERE, specifier)).href}"`,
  );
  const directory = mkdtempSync(join(tmpdir(), "gamebuddy-pre-change-pump-"));
  const file = join(directory, "event-pump.pre-change.mjs");
  writeFileSync(file, rewritten, "utf8");
  return file;
}

test("auto_observe_on_stale: a stale-world FLUSH opens no turn, and asks the integration instead", async () => {
  // THE PROPERTY, on this tree: the crossing that used to mint a fact and open a turn now asks, the batch that would have
  // carried the notice does not exist, and nothing is left pending behind it.
  const asked: number[] = [];
  const published: WorldFact[] = [];
  const { pump, line, turns } = await crossedReadingLine(
    Object.freeze({
      async observe() {
        asked.push(asked.length + 1);
        return Object.freeze({});
      },
      publish: (fact: WorldFact) => published.push(fact),
    }),
  );

  assert.equal(asked.length, 1, "the crossing asked the integration exactly once");
  assert.deepEqual(
    published,
    [],
    "an observation the integration served is its own answer: nothing is stated about it",
  );
  assert.equal(
    turns.filter((turn) => turn.batchKinds.includes("world_state_stale")).length,
    0,
    "no delivered batch carried a stale notice, which is the turn this unit removes",
  );
  assert.equal(
    pump.turnAccount.autoObserve.refreshed,
    1,
    `one refresh: ${autoObserveOnStaleToken(FIRST_CROSSING_TURNS)}`,
  );
  assert.equal(
    pump.turnAccount.autoObserve.lastAgeTurns,
    worldStateStaleThreshold(0),
    "and it says the age of the reading it was asked about, which is the bound the crossing was read at",
  );
  assert.equal(
    pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.noBridge] +
      pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.attemptsSpent] +
      pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.refused],
    0,
    "nothing was declined",
  );
  assert.match(
    line,
    new RegExp(`· ${AUTO_OBSERVE_ON_STALE} 1 \\{ageTurns: ${String(worldStateStaleThreshold(0))}\\}`, "u"),
    `the refresh is on the account line: ${line}`,
  );
});

test("auto_observe_on_stale: the pre-change module opens a turn for the same input, and this one does not", async () => {
  // THE RED PROOF, BOTH DIRECTIONS, on the REAL pre-change module. With the branch removed (that module), the same
  // crossing mints `world_state_stale:...` and the flush that follows OPENS a turn - which is the whole defect: a turn
  // whose only new information is "your observation is old".
  const preChange = compilePreChangePump();
  if (preChange === undefined) {
    console.log(
      `not_measured: the pre-change module was not compiled, so the red reading is BLOCKED - ` +
        `${PRE_CHANGE_REVISION}:host/src/event-pump.ts is not reachable from this clone`,
    );
  } else {
    const pre = (await import(pathToFileURL(preChange).href)) as {
      CompanionEventPump: new () => CompanionEventPump;
      turnAccountLine(account: never): string;
    };
    const before = new pre.CompanionEventPump();
    const minted: WorldFact[] = [];
    const turns: Array<Readonly<{ opened: boolean; batchKinds: readonly string[] }>> = [];
    const deliverBefore = async (fact: WorldFact): Promise<void> => {
      before.enqueueFact(fact);
      const stale = before.takeWorldStateStaleFact();
      if (stale !== undefined) {
        minted.push(stale);
        before.enqueueFact(stale);
      }
      const openedBefore = before.turnAccount.opened;
      let batchKinds: readonly string[] = Object.freeze([]);
      await before.flush({
        async deliver(batch) {
          batchKinds = Object.freeze(batch.facts.map((one) => one.semanticKind ?? one.kind));
        },
      });
      turns.push({ opened: before.turnAccount.opened > openedBefore, batchKinds });
    };
    await deliverBefore(snapshotFact(352, 0));
    for (let turn = 1; turn <= FIRST_CROSSING_TURNS; turn += 1) await deliverBefore(movedFact(turn));
    await drained();

    assert.equal(minted.length, 1, "the pre-change module minted the stale notice the turn is made of");
    assert.equal(minted[0]?.semanticKind, "world_state_stale");
    assert.ok(
      turns.some((turn) => turn.opened && turn.batchKinds.includes("world_state_stale")),
      `a stale-world turn OPENED: ${JSON.stringify(turns.map((turn) => turn.batchKinds))}`,
    );
    const beforeLine = pre.turnAccountLine(before.turnAccount as never);
    assert.equal(
      beforeLine.includes(AUTO_OBSERVE_ON_STALE),
      false,
      `and the account could not say a refresh stood in for it: ${beforeLine}`,
    );
  }

  // The same input, on this tree: nothing is minted, no batch carries the notice, and the account says why.
  const now = await crossedReadingLine(
    Object.freeze({ observe: () => Promise.resolve(Object.freeze({})), publish: () => undefined }),
  );
  assert.equal(
    now.turns[0]?.opened,
    false,
    "the first reading opens nothing on its own (`#snapshotAdvanced`: no delivered predecessor), which is unchanged here",
  );
  assert.equal(
    now.turns.slice(1).every((turn) => turn.opened),
    true,
    `every turn after that was opened by the world's own facts, so none is missing: ${JSON.stringify(now.turns.map((turn) => turn.opened))}`,
  );
  assert.equal(now.turns.filter((turn) => turn.batchKinds.includes("world_state_stale")).length, 0);
  assert.match(now.line, new RegExp(`· ${AUTO_OBSERVE_ON_STALE} 1 \\{`, "u"));
});

test("auto_observe_unavailable:no_bridge - a pump nobody wired still says the world is old, and says why", async () => {
  // The synchronous reason: no port at all. The turn opens exactly as before, and the account names the condition rather
  // than leaving "nobody asked" to be inferred from a refresh that never appears.
  const { pump, line, turns } = await crossedReadingLine();
  assert.equal(
    turns.filter((turn) => turn.batchKinds.includes("world_state_stale")).length,
    1,
    "with no way to ask, the stale notice still reaches her",
  );
  assert.equal(pump.turnAccount.autoObserve.refreshed, 0);
  assert.equal(pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.noBridge], 1);
  assert.match(
    line,
    new RegExp(`· ${AUTO_OBSERVE_ON_STALE} 0 · ${AUTO_OBSERVE_UNAVAILABLE_TOKEN} 1 \\{no_bridge: 1,`, "u"),
    `the account names the missing route: ${line}`,
  );
  assert.equal(autoObserveUnavailableToken(AUTO_OBSERVE_UNAVAILABLE.noBridge), "auto_observe_unavailable:no_bridge");
});

test("auto_observe_unavailable:refresh_refused - an ask that comes back refused opens the turn with the reason", async () => {
  const published: WorldFact[] = [];
  const { pump, line } = await crossedReadingLine(
    Object.freeze({
      observe: () => Promise.reject(new Error("bridge_not_authenticated")),
      publish: (fact: WorldFact) => published.push(fact),
    }),
  );
  assert.equal(published.length, 1, "one refusal per crossed reading");
  assert.equal(published[0]?.payload.code, "world_state_refresh_refused:bridge_not_authenticated");
  assert.equal(pump.turnAccount.autoObserve.refreshed, 1, "the ask was made...");
  assert.equal(
    pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.refused],
    1,
    "...and it was not answered: both halves are counted, so `asked and served` stays distinguishable",
  );
  assert.match(
    line,
    new RegExp(
      `· ${AUTO_OBSERVE_UNAVAILABLE_TOKEN} 1 \\{no_bridge: 0, refresh_attempts_spent: 0, refresh_refused: 1\\}`,
      "u",
    ),
  );
});

test("the refresh is bounded: one ask per crossing, WORLD_STATE_REFRESH_ATTEMPTS per revision, and then it declines", async () => {
  // THE BOUND, and the reason this cannot become a poll. Fifty turns of one frozen revision: the crossing is re-armed by
  // `worldStateStaleThreshold(published)` (5, 20, 35, 50), the probe is bounded per REVISION, and past the bound the
  // notice opens the turn again with `refresh_attempts_spent` printed - a fixed number of asks, not one per turn.
  const asked: number[] = [];
  const pump = new CompanionEventPump();
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe() {
        asked.push(asked.length + 1);
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await deliverTurn(pump, snapshotFact(352, 0));
  for (let turn = 1; turn <= 60; turn += 1) await deliverTurn(pump, movedFact(turn));

  assert.equal(
    asked.length,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `sixty turns of one frozen revision asked ${String(asked.length)} times`,
  );
  assert.equal(
    pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.attemptsSpent] >= 1,
    true,
    "and the crossing past the bound says so instead of asking again",
  );
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, /refresh_attempts_spent: [1-9]/u, `the decline is printed with its reason: ${line}`);
  console.log(
    `bound: examined 61 turns, asked ${String(asked.length)}, declined ${line.split("auto_observe_unavailable")[1]}`,
  );
});

test("the account prints every unavailability reason, so a zero is a statement rather than an absence", () => {
  const pump = new CompanionEventPump();
  const line = turnAccountLine(pump.turnAccount);
  for (const reason of AUTO_OBSERVE_UNAVAILABLE_REASONS) assert.match(line, new RegExp(`${reason}: 0`, "u"));
  assert.match(line, new RegExp(`· ${AUTO_OBSERVE_ON_STALE} 0(?![\\d])`, "u"), "and no age is printed for no refresh");
  assert.equal(WORLD_STATE_STALE_TURNS > 0, true, "the threshold this file derives its crossing from is a real bound");
});

/**
 * The `round47`-shaped window: 64 delivered turns over ONE frozen reading.
 *
 * Each turn re-states the reading the way the Host does (`#restateWorldSnapshot`), carries a clock milestone so the world
 * keeps saying it moved, and every fifth turn also carries a settlement - so the window is not one fact repeated, and the
 * crossings recur at the thresholds the block itself uses. A serving port is attached in BOTH runs: the composition
 * installed one before this unit too, and that is the whole point - it asked, and the turn opened anyway.
 */
async function sixtyFourTurnLine(
  module: Readonly<{
    CompanionEventPump: new () => CompanionEventPump;
    turnAccountLine(account: never): string;
  }>,
  pump: CompanionEventPump,
  onStaleNotice: () => void,
): Promise<string> {
  let asked = 0;
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe() {
        asked += 1;
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  pump.enqueueFact(snapshotFact(352, 0));
  await pump.flush({ async deliver() {} });
  for (let turn = 1; turn <= 63; turn += 1) {
    pump.enqueueFact(snapshotFact(352, turn));
    pump.enqueueFact(movedFact(turn));
    if (turn % 5 === 0)
      pump.enqueueFact(
        Object.freeze({
          source: "host_game_session",
          kind: "world_fact" as const,
          eventId: `program_settled_plan_round47_${String(turn)}`,
          correlationId: "plan_round47",
          revision: 352,
          occurredAtMs: 1_790_000_000_000 + turn * 1_000,
          semanticKind: "program_settled",
          payload: Object.freeze({ programId: "plan_round47", state: "failed", decided: turn }),
        }),
      );
    const stale = pump.takeWorldStateStaleFact();
    if (stale !== undefined) {
      onStaleNotice();
      pump.enqueueFact(stale);
    }
    await pump.flush({ async deliver() {} });
  }
  await drained();
  return module.turnAccountLine(pump.turnAccount as never);
}

test("sixty-four turns on one frozen reading: the stale-notice turns fall, and the account says what replaced them", async () => {
  const preChange = compilePreChangePump();
  let beforeStaleTurns = 0;
  let beforeLine = "not_measured: the pre-change module is not reachable from this clone";
  if (preChange === undefined) {
    console.log(beforeLine);
  } else {
    const pre = (await import(pathToFileURL(preChange).href)) as {
      CompanionEventPump: new () => CompanionEventPump;
      turnAccountLine(account: never): string;
    };
    beforeLine = await sixtyFourTurnLine(pre, new pre.CompanionEventPump(), () => {
      beforeStaleTurns += 1;
    });
  }

  let afterStaleTurns = 0;
  const afterLine = await sixtyFourTurnLine({ CompanionEventPump, turnAccountLine }, new CompanionEventPump(), () => {
    afterStaleTurns += 1;
  });

  console.log(`64-turn fixture BEFORE: stale-notice facts ${String(beforeStaleTurns)} · ${beforeLine}`);
  console.log(`64-turn fixture AFTER:  stale-notice facts ${String(afterStaleTurns)} · ${afterLine}`);
  assert.equal(
    afterStaleTurns < beforeStaleTurns || preChange === undefined,
    true,
    "the same input produces fewer turns",
  );
  assert.equal(
    afterStaleTurns,
    1,
    "the one crossing past the probe bound still opens, and it is named `refresh_attempts_spent`",
  );
  assert.match(afterLine, new RegExp(`· ${AUTO_OBSERVE_ON_STALE} [1-9]`, "u"), "the refreshes it replaced them with");
  assert.match(
    afterLine,
    /refresh_attempts_spent: [1-9]/u,
    "and the crossing the world would not be asked about again",
  );
  if (beforeLine !== "") assert.equal(beforeLine.includes(AUTO_OBSERVE_ON_STALE), false);
});
