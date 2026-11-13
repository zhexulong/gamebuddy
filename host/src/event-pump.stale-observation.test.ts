import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import {
  AUTO_OBSERVE_AGED_TURNS,
  AUTO_OBSERVE_ON_STALE,
  AUTO_OBSERVE_UNAVAILABLE,
  AUTO_OBSERVE_UNAVAILABLE_REASONS,
  AUTO_OBSERVE_UNAVAILABLE_TOKEN,
  autoObserveOnStaleToken,
  autoObserveUnavailableToken,
  CompanionEventPump,
  type PendingBatch,
  type TurnAccount,
  turnAccountLine,
  WORLD_STATE_REFRESH_ATTEMPTS,
  type WorldFact,
  type WorldStateRefreshPort,
} from "./event-pump.js";
import { WORLD_STATE_STALE_TURNS } from "./fact-brief.js";

/**
 * The DIAGNOSIS must trigger the CURE.
 *
 * <p>
 * MEASURED 2026-11-13 (`round50b`, live, ten minutes in): two turns, `turn_closed_without_action 2
 * {player_input:world_stale: 1, world_fact:nothing_pending: 1}`, `auto_observe_on_stale 0`, and
 * `auto_observe_unavailable 0 {no_bridge: 0, refresh_attempts_spent: 0, refresh_refused: 0}`. Her own message carried the
 * block's admission - `世界（revision 0，本轮无新观察）（这是 1 轮之前看到的，世界已经不一样了）` - so the pump CLASSIFIED the
 * turn as `world_stale` and asked nobody for a fresh reading, with all three probes unspent.
 * </p>
 *
 * <p>
 * The cause was two conditions where there had to be one. The classification says "the batch did not bring the
 * observation" (`#readingIsAged`), which is true from the second turn of a session; the refresh was keyed on the NOTICE's
 * much later threshold (`worldStateStaleThreshold`, five turns, re-armed 5/20/35) and on a flush whose only new content
 * was the stale fact. Every flush in that run was opened by `player_input` or by a `world_fact`, so the cure never ran.
 * </p>
 *
 * <p>
 * So this suite is one property, in both directions: a turn about to be composed from an aged reading ASKS the
 * integration first and is composed from the answer, and where it cannot ask, it composes exactly what it did before and
 * NAMES the reason. Both directions are read on the REAL pre-change module, compiled out of `a34f9f8d`, because a
 * hand-written old line proves only that a reader refuses a string.
 * </p>
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(HERE, "..");

/** The commit whose `event-pump.ts` is the module BEFORE this unit: the tree this unit lands on. */
const PRE_CHANGE_REVISION = "a34f9f8d";

/** The module name this unit introduced: if the pin already carries it, the pin is not the pre-change module. */
const THIS_UNIT_SYMBOL = "beginAgedReadingAsk";

/** The world as the Mod admitted it: a free body standing on the Farm. */
const FREE_BODY = Object.freeze({ location: "Farm", gameTime: "0740", actionable: true, revision: 352 });

/**
 * One reading, admitted the way the Mod admits one.
 *
 * `moved` is the difference between a reading and a RE-STATE of it: a reading is identified by its CONTENT
 * (`readingContentIdentity`), so an answer carrying the same payload under a fresh revision is the reading she already had.
 */
function snapshotFact(revision: number, observedTick: number, moved = false): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: 1_790_000_000_000 + observedTick,
    payload: { ...FREE_BODY, revision, ...(moved ? { gameTime: "0750" } : {}) },
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

/** What one delivered turn carried, as the batch itself states it. */
type Delivery = Readonly<{ broughtObservation: boolean; text: string; facts: readonly WorldFact[] }>;

const batchesOf = (batch: PendingBatch): Delivery =>
  Object.freeze({
    broughtObservation: batch.broughtObservation,
    text: batch.text,
    facts: batch.facts,
  });

/** The one marker `fact-brief.ts` prints for a reading the batch brought, and the one it prints for a re-statement. */
const FRESH_MARKER = "刚刚更新";
const AGED_MARKER = "轮之前看到的，世界已经不一样了";

/**
 * A port that answers the way the integration does.
 *
 * <p>
 * In production `observe` is `StardewBridgeConnection.observe` (`local-stardew-bridge.ts:366`): it sends `observe_request`,
 * `receive` ADMITS the solicited snapshot (`:1057`) and hands it to the fact listener (`:1090`) BEFORE the request
 * resolves, so by the time the pump's `await` returns, `enqueueFact` has already seen the new reading. A double that
 * resolved with a bare object would model a bridge that answers with nothing, which is the `refresh_refused` case, not
 * this one - so this one publishes through the pump's own admission, which is the route under test. Its answer is a LATER
 * WORLD (a moved clock under a new revision): a reading is identified by its content, so an answer that only bumped the
 * counter would be the reading she already had, and the turn it opened would be the re-statement.
 * </p>
 */
function servingPort(pump: CompanionEventPump, fromRevision: number): { port: WorldStateRefreshPort; asked: number[] } {
  const asked: number[] = [];
  const port: WorldStateRefreshPort = Object.freeze({
    async observe(): Promise<unknown> {
      asked.push(asked.length + 1);
      const revision = fromRevision + asked.length;
      pump.enqueueFact(snapshotFact(revision, 1_000 + asked.length, true));
      return Object.freeze({ revision });
    },
    publish: (fact: WorldFact) => pump.enqueueFact(fact),
  });
  return { port, asked };
}

/** The person's own words, which is what opens a turn in every fixture here (`round50b`'s openers were both of these). */
const FIRST_TURN_INPUT = Object.freeze({ text: "我到了。" });
const AGED_TURN_INPUT = Object.freeze({ text: "早上了，去把鸡喂了。" });

/**
 * The session's first turn: the reading the Mod admitted, carried by a turn the person opened.
 *
 * A snapshot alone opens nothing (`#snapshotAdvanced` has no delivered predecessor at attach), which is the session-start
 * behaviour this unit does not touch - so the fixture opens its first turn the way a real session does, with a message.
 */
async function openSession(pump: CompanionEventPump): Promise<Delivery | undefined> {
  return await deliverTurn(pump, [snapshotFact(352, 0)], FIRST_TURN_INPUT);
}

/** One turn, admitted the way the Host admits it: the facts, then the delivery. */
async function deliverTurn(
  pump: CompanionEventPump,
  facts: readonly WorldFact[],
  input?: Readonly<{ text: string }>,
): Promise<Delivery | undefined> {
  for (const fact of facts) pump.enqueueFact(fact);
  if (input !== undefined)
    pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "player_input_round50b",
      text: input.text,
      locale: "zh-CN",
      timestampMs: 1_790_000_000_000,
    });
  const deliveries: Delivery[] = [];
  await pump.flush({
    async deliver(batch) {
      deliveries.push(batchesOf(batch));
    },
  });
  return deliveries.at(0);
}

/**
 * The stale reading, printed as this unit asks for it: `aged turns N · refreshed M · refresh refused K {reason: count}`.
 *
 * <p>
 * The population is ASSERTED before it is printed. A reader over an account that aged nothing would agree with itself -
 * which is exactly how `round50b` printed `auto_observe_on_stale 0 · auto_observe_unavailable 0` and passed every audit
 * it had - so zero aged turns BLOCKS this reading instead of producing a green one.
 * </p>
 *
 * <p>
 * The arithmetic is asserted with it: every aged turn is exactly one of "the world was asked and answered" or "it could
 * not be asked, for this reason". A turn counted as aged and then neither is a turn nobody has accounted for.
 * </p>
 */
function staleReading(account: TurnAccount["autoObserve"]): string {
  const declined = AUTO_OBSERVE_UNAVAILABLE_REASONS.reduce((total, reason) => total + account.unavailable[reason], 0);
  assert.equal(
    account.refreshed + declined,
    account.agedTurns,
    `not_measured: ${String(account.agedTurns)} aged turn(s) are not partitioned into ${String(account.refreshed)} ` +
      `refreshed + ${String(declined)} declined, so this reading would not close`,
  );
  assert.ok(
    account.agedTurns > 0,
    "not_measured: the account examined 0 aged turns, so a reading of the refresh has no population to speak about",
  );
  const reasons = AUTO_OBSERVE_UNAVAILABLE_REASONS.map(
    (reason) => `${reason}: ${String(account.unavailable[reason])}`,
  ).join(", ");
  return (
    `${AUTO_OBSERVE_AGED_TURNS} ${String(account.agedTurns)} · ` +
    `${AUTO_OBSERVE_ON_STALE} ${String(account.refreshed)} {ageTurns: ${String(account.lastAgeTurns)}} · ` +
    `${AUTO_OBSERVE_UNAVAILABLE_TOKEN} ${String(declined)} {${reasons}}`
  );
}

test("round50b: a player_input turn on an aged reading is composed from a FRESH observation", async () => {
  // THE UNIT. `round50b`'s shape exactly: one admission, then a flush opened by the person while the reading is one turn
  // old. The batch that goes to the model must carry the reading the answer made current, and the account must count it.
  const pump = new CompanionEventPump();
  const { port, asked } = servingPort(pump, 352);
  pump.attachWorldStateRefresh(port);

  const first = await openSession(pump);
  assert.equal(first?.broughtObservation, true, "the session's first reading is what the first batch brought");
  assert.equal(asked.length, 0, "a turn that brings the observation has nothing to cure");

  const second = await deliverTurn(pump, [], AGED_TURN_INPUT);
  assert.equal(asked.length, 1, "the aged turn asked the integration exactly once, before it was composed");
  assert.equal(
    second?.broughtObservation,
    true,
    "the batch states the observation it was given rather than `本轮无新观察`: the turn was composed from the answer",
  );
  assert.match(second?.text ?? "", new RegExp(FRESH_MARKER, "u"), "and the block says so in the model's own words");
  assert.doesNotMatch(
    second?.text ?? "",
    new RegExp(AGED_MARKER, "u"),
    `and does not carry the parenthetical round50b measured: ${second?.text ?? ""}`,
  );
  assert.match(
    second?.text ?? "",
    /revision 353/u,
    "the revision it carries is the one the integration answered with, not the one the pump was holding",
  );
  assert.equal(pump.turnAccount.autoObserve.refreshed, 1);
  assert.equal(pump.turnAccount.autoObserve.lastAgeTurns, 1, "and it says the age of the reading it was asked about");
  console.log(`round50b fixture: ${staleReading(pump.turnAccount.autoObserve)}`);
});

test("the pre-change module composes the same turn from the aged block and asks nobody", async () => {
  // THE RED PROOF, BOTH DIRECTIONS, on the REAL pre-change module. It has the classification and it has the refresh; what
  // it does not have is a trigger that meets, so the same turn is composed from the reading it did not bring.
  const preChange = compilePreChangePump();
  if (preChange === undefined) {
    console.log(
      `not_measured: the pre-change module was not compiled, so the red reading is BLOCKED - ` +
        `${PRE_CHANGE_REVISION}:host/src/event-pump.ts is not reachable from this clone`,
    );
    return;
  }
  const pre = (await import(pathToFileURL(preChange).href)) as {
    CompanionEventPump: new () => CompanionEventPump;
  };
  const before = new pre.CompanionEventPump();
  const answered: number[] = [];
  before.attachWorldStateRefresh(
    Object.freeze({
      async observe() {
        answered.push(answered.length + 1);
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await openSession(before);
  const aged = await deliverTurn(before, [], AGED_TURN_INPUT);

  assert.equal(
    aged?.broughtObservation,
    false,
    "the pre-change batch said `本轮无新观察` on a reading it did not bring",
  );
  assert.match(
    aged?.text ?? "",
    new RegExp(AGED_MARKER, "u"),
    "and carried the block's own admission that the world had moved on",
  );
  assert.equal(answered.length, 0, "with every probe unspent: this is `round50b`'s `auto_observe_on_stale 0`");
  console.log(
    `pre-change fixture: probes ${String(answered.length)}, aged batch ${String(aged?.broughtObservation === false)}`,
  );
});

test("the bound: three aged turns of one revision, then `refresh_attempts_spent` instead of a fourth ask", async () => {
  // THE BOUND, and the reason this cannot become a poll. A world that answers an observation with the SAME revision - the
  // ordinary case for a frozen bridge, and the honest case for a world that truly did not move - re-arms nothing, so the
  // revision's own budget is the only thing standing between a turn cadence and a probe cadence.
  const pump = new CompanionEventPump();
  const asked: number[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe() {
        asked.push(asked.length + 1);
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await openSession(pump);
  for (let turn = 1; turn <= 10; turn += 1) await deliverTurn(pump, [movedFact(turn)]);

  assert.equal(
    asked.length,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `ten aged turns of one revision asked ${String(asked.length)} times; the bound is ` +
      `${String(WORLD_STATE_REFRESH_ATTEMPTS)} per revision`,
  );
  const account = pump.turnAccount.autoObserve;
  assert.equal(account.agedTurns, 10, "every one of those turns was aged, and every one is counted as such");
  assert.equal(account.refreshed, WORLD_STATE_REFRESH_ATTEMPTS, "the served asks are the refreshes");
  assert.equal(
    account.unavailable[AUTO_OBSERVE_UNAVAILABLE.attemptsSpent],
    10 - WORLD_STATE_REFRESH_ATTEMPTS,
    "and the turns past the bound say so instead of asking again",
  );
  const line = staleReading(account);
  assert.match(line, /refresh_attempts_spent: [1-9]/u, `the decline is printed with its reason: ${line}`);
  assert.match(turnAccountLine(pump.turnAccount), new RegExp(`· ${AUTO_OBSERVE_AGED_TURNS} 10 ·`, "u"));
  console.log(`bound: examined 11 turns · ${line}`);
});

test("a fresh turn is untouched: it asks nothing, and its bytes are the pre-change module's bytes", async () => {
  // THE OTHER DIRECTION, and the one a cure can break quietly. A turn that brings its own observation has nothing to cure,
  // so it must not ask, must not wait, and must compose the exact text it composed before this unit - read against the
  // real pre-change module rather than against a copy of its output.
  const preChange = compilePreChangePump();
  const input = AGED_TURN_INPUT;

  const pump = new CompanionEventPump();
  const { port, asked } = servingPort(pump, 352);
  pump.attachWorldStateRefresh(port);
  const fresh = await deliverTurn(pump, [snapshotFact(352, 0)], input);
  assert.equal(asked.length, 0, "a batch that brings the observation asks for nothing");
  assert.equal(pump.turnAccount.autoObserve.agedTurns, 0, "and nothing is counted as aged");

  if (preChange === undefined) {
    console.log(
      `not_measured: the byte comparison is BLOCKED - ${PRE_CHANGE_REVISION}:host/src/event-pump.ts is not reachable`,
    );
    return;
  }
  const pre = (await import(pathToFileURL(preChange).href)) as { CompanionEventPump: new () => CompanionEventPump };
  const unchanged = await deliverTurn(new pre.CompanionEventPump(), [snapshotFact(352, 0)], input);
  assert.equal(
    fresh?.text,
    unchanged?.text,
    "a turn that brings its own reading is composed byte for byte as it was before this unit",
  );
  assert.match(fresh?.text ?? "", new RegExp(FRESH_MARKER, "u"));
});

test("auto_observe_unavailable:no_bridge - the aged turn is composed as before, and the reason is on the account", async () => {
  // The structural reason: a pump nobody wired cannot ask. The turn opens exactly as it always did - that is the second
  // half of the unit, and it must not be silently skipped - and the account names the condition rather than leaving
  // "nobody asked" to be inferred from a refresh that never appears.
  const pump = new CompanionEventPump();
  await openSession(pump);
  const aged = await deliverTurn(pump, [], AGED_TURN_INPUT);

  assert.equal(aged?.broughtObservation, false, "with no way to ask, the turn is composed from the reading it has");
  assert.match(aged?.text ?? "", new RegExp(AGED_MARKER, "u"), "and says so, exactly as before this unit");
  assert.equal(pump.worldStateRefresh.attached, false);
  assert.equal(pump.turnAccount.autoObserve.refreshed, 0);
  assert.equal(pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.noBridge], 1);
  const line = staleReading(pump.turnAccount.autoObserve);
  assert.match(line, /no_bridge: 1/u, `the account names the missing route: ${line}`);
  assert.equal(autoObserveUnavailableToken(AUTO_OBSERVE_UNAVAILABLE.noBridge), "auto_observe_unavailable:no_bridge");
});

test("auto_observe_unavailable:refresh_refused - the route's own words reach the turn that could not be cured", async () => {
  const published: WorldFact[] = [];
  const pump = new CompanionEventPump();
  pump.attachWorldStateRefresh(
    Object.freeze({
      observe: () => Promise.reject(new Error("bridge_not_authenticated")),
      publish: (fact: WorldFact) => {
        published.push(fact);
        pump.enqueueFact(fact);
      },
    }),
  );
  await openSession(pump);
  const aged = await deliverTurn(pump, [], AGED_TURN_INPUT);

  assert.equal(pump.worldStateRefresh.probes, 1, "the ask was made...");
  assert.equal(published.length, 1, "...and refused once for this reading...");
  assert.equal(published[0]?.payload.code, "world_state_refresh_refused:bridge_not_authenticated");
  const account = pump.turnAccount.autoObserve;
  assert.equal(account.refreshed, 0, "a refused ask is not a refresh, so the count of answered turns stays at zero");
  assert.equal(account.unavailable[AUTO_OBSERVE_UNAVAILABLE.refused], 1, "it is a turn composed from an aged reading");
  assert.ok(
    aged?.facts.some((fact) => fact.semanticKind === "world_state_refresh_refused"),
    "and the refusal travels into the very turn it could not cure, so the model reads the route's own words",
  );
  const line = staleReading(account);
  assert.match(line, /refresh_refused: 1/u, `the account names the refusal: ${line}`);
});

test("a retry does not ask again: the exact rejected text is re-sent, from the reading it was composed from", async () => {
  // The arm the cure must not enter twice. A batch the sink rejected is retried with the SAME text - that is the pump's
  // existing contract - so a second ask would put an unreviewed composition behind one turn.
  const pump = new CompanionEventPump();
  const { port, asked } = servingPort(pump, 352);
  pump.attachWorldStateRefresh(port);
  await openSession(pump);

  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_input_round50b",
    text: "早上了，去把鸡喂了。",
    locale: "zh-CN",
    timestampMs: 1_790_000_000_000,
  });
  let firstFrame = "";
  await assert.rejects(
    () =>
      pump.flush({
        async deliver(batch) {
          firstFrame = batch.text;
          throw new Error("sink_down");
        },
      }),
    /sink_down/u,
  );
  assert.equal(asked.length, 1, "the first attempt cured its reading");

  const delivered: Delivery[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batchesOf(batch));
    },
  });
  assert.equal(asked.length, 1, "the retry asks nothing: it sends the text it already composed");
  assert.equal(delivered[0]?.text, firstFrame, "and that text is byte for byte the rejected one");
});

test("the account prints the three stale numbers, and a zero population blocks the reading rather than passing it", () => {
  // THE READING, printed where a run can be read back: `aged turns N · refreshed M · refresh refused K {reason: count}`.
  // `round50b` is the case this exists for - a run whose account said `auto_observe_on_stale 0 · auto_observe_unavailable
  // 0` and whose only turns were `world_stale`, which is a truthful line that no reader can tell from "nothing was aged".
  const untouched = new CompanionEventPump();
  assert.equal(
    turnAccountLine(untouched.turnAccount).includes(`${AUTO_OBSERVE_AGED_TURNS} 0`),
    true,
    "a pump that aged nothing prints the zero rather than omitting the segment",
  );
  assert.throws(
    () => staleReading(untouched.turnAccount.autoObserve),
    /not_measured: the account examined 0 aged turns/u,
    "and the reading REFUSES to be taken over an empty population, because a zero that agrees with itself is not proof",
  );

  // The falsifier for the arithmetic: a hand-built account that names aged turns and then neither refreshes nor declines
  // them is a turn nobody accounted for, and the reading says so by name.
  const unclosed: TurnAccount["autoObserve"] = Object.freeze({
    agedTurns: 3,
    refreshed: 1,
    lastAgeTurns: 1,
    unavailable: Object.freeze({
      [AUTO_OBSERVE_UNAVAILABLE.noBridge]: 0,
      [AUTO_OBSERVE_UNAVAILABLE.attemptsSpent]: 0,
      [AUTO_OBSERVE_UNAVAILABLE.refused]: 0,
    }),
  });
  assert.throws(() => staleReading(unclosed), /not partitioned into 1 refreshed \+ 0 declined/u);
  assert.equal(
    staleReading({ ...unclosed, refreshed: 3 }).includes(`${AUTO_OBSERVE_AGED_TURNS} 3`),
    true,
    "and the same account with all three refreshed reads as an account",
  );
});

test("the account prints every unavailability reason, so a zero is a statement rather than an absence", () => {
  const pump = new CompanionEventPump();
  const line = turnAccountLine(pump.turnAccount);
  for (const reason of AUTO_OBSERVE_UNAVAILABLE_REASONS) assert.match(line, new RegExp(`${reason}: 0`, "u"));
  assert.match(line, new RegExp(`· ${AUTO_OBSERVE_ON_STALE} 0(?![\\d])`, "u"), "and no age is printed for no refresh");
  assert.equal(WORLD_STATE_STALE_TURNS > 0, true, "the threshold the notice still uses is a real bound");
  assert.equal(autoObserveOnStaleToken(7), `${AUTO_OBSERVE_ON_STALE}:7`, "one spelling for the token and the printer");
});

/**
 * `a34f9f8d`'s `event-pump.ts` - the module BEFORE this unit - emitted and made importable, or `undefined` when that
 * revision is not in this clone.
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
    source.includes(THIS_UNIT_SYMBOL),
    false,
    `${PRE_CHANGE_REVISION}:host/src/event-pump.ts already carries ${THIS_UNIT_SYMBOL}, so it is not the pre-change module`,
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
