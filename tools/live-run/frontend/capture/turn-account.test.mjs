// The Host's turn account, read the way `w-game-launch` reads it.
//
// Every reading below is the producer's own line: `round66`'s account, quoted whole from
// `tools/fixtures/declared-deleted/round66-facts.runner-log:19`. The boundary cases change exactly one member
// of that line on purpose, because the boundary IS a member (`world_fact` at 0, or gone from the block) and a
// hand-built line would answer a question the producer never prints.
//
// red-proof: inject  counted `player_input` as proof of the step (returning `awake` whenever any turn opened,
//                   instead of only when `world_fact` did): `✖ a session where only the player's own words
//                   opened turns does not prove the step` fails with reason `null` against
//                   `turn_account_without_world_fact`, exit 1.
// red-proof: inject  dropped the `held` guard in `agentAwakeOf`, so an unheld stderr read as "no turns":
//                   `✖ a run whose stderr was never held is refused as unreadable, not read as zero turns`
//                   fails with `turn_account_absent`, exit 1.
// red-proof: measured  2026-11-22, the reading this file exists for: the same classifier, pointed at a real
//                   run's 142-byte entry stderr (`frontend--r24`/`--r25`, quoted below), answers
//                   `turn_account_absent`; pointed at the live run's own `state/entry-stderr.log` it answers
//                   `awake` with the counts (`.tmp/lane-agentawake.md`).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  ACCOUNT_LINE_SHAPE,
  TURN_ACCOUNT_FACT,
  agentAwakeOf,
  describeTurnAccount,
  parseAccountLine,
  readTurnAccount,
  readTurnAccountText,
} = require("./turn-account.cjs");

/**
 * The product entry's stderr, as a run that opened no turn leaves it: 142 bytes, quoted from
 * `D:\gb-modcheck\frontend--r24.stage\logs\launch.log` ("ENTRY STDERR BYTES (=0 required): 142", both lines).
 */
const NO_TURN_STDERR =
  "[tavern-gate] runtime marker unavailable: no_reporter\nGameBuddy Stardew bootstrap registration reconcile: examined 0, released 0, finalised 0\n";

/** `round66`'s account line, whole, as `turnAccountLine` printed it. */
const ROUND66 =
  "GAME_TURN_ACCOUNT assistant turns examined 9 {worked: 2, worked_silently: 4, spoke: 3, said_nothing: 0} · with text 5 · tool-only 4 · per delivered batch: turns opened 3 {player_input: 1, world_fact: 2 {adapter_ingress: 1, companion_arrival: 1}, due: 0} · flushes examined 3 · not owed 1 {observation_restated: 0, observation_moved: 0, world_fact_restated: 0, in_flight_progress: 0, progress: 1 {adapter_ingress: 1}, nothing_pending: 0} · carried 1 {pending: 0} · traces 8 {receipt:accepted: 5, receipt:meaningful_progress: 0, receipt:running: 3, semantic:body_idle: 0, semantic:execution_started: 0, semantic:route_progress: 0} · bubbles delivered 2 · lost 1 {no_presentation_lease: 1} · stalled 0 · turn_closed_without_action 1 {player_input:world_stale: 0, player_input:body_held: 0, player_input:nothing_pending: 0, world_fact:world_stale: 0, world_fact:body_held: 0, world_fact:nothing_pending: 1, due:world_stale: 0, due:body_held: 0, due:nothing_pending: 0} · turn_settled_silent 0 {world_fact: 0, due: 0} · turn_settled_with_execution_in_flight 1 · aged readings 1 · auto_observe_on_stale 1 {ageTurns: 1} · auto_observe_unavailable 0 {no_bridge: 0, refresh_attempts_spent: 0, refresh_refused: 0} · refresh_rearmed 0 {reading_moved: 0, world_moved: 0} · receipts with provenance 13 {programme: 11, standalone: 2, unattributed: 0, unstated: 0} · unattributed_execution 0";

/** The same line with its turns-opened block replaced: the one member under test, and nothing else. */
const withOpenedBlock = (block) =>
  ROUND66.replace(
    "turns opened 3 {player_input: 1, world_fact: 2 {adapter_ingress: 1, companion_arrival: 1}, due: 0}",
    block,
  );

const inTemporaryFile = (text) => {
  const root = mkdtempSync(join(tmpdir(), "turn-account-"));
  const file = join(root, "entry-stderr.log");
  writeFileSync(file, text, "utf8");
  return file;
};

test("a run whose stderr carries no account line is refused by name, not read as zero turns", () => {
  const reading = readTurnAccount(inTemporaryFile(NO_TURN_STDERR));
  assert.equal(reading.held, true, "the run's stderr file was there and had to be read");
  const awake = agentAwakeOf(reading);
  assert.equal(awake.kind, "absent");
  assert.equal(awake.reason, "turn_account_absent");
  assert.match(awake.detail, /142 byte\(s\)/u);
  assert.ok(
    awake.detail.includes(ACCOUNT_LINE_SHAPE),
    "the refusal quotes the shape it looked for, so the next reader knows what is missing",
  );
});

test("a run whose stderr was never held is refused as unreadable, not read as zero turns", () => {
  const missing = readTurnAccount(join(tmpdir(), "turn-account-does-not-exist", "entry-stderr.log"));
  assert.equal(missing.held, false);
  const awake = agentAwakeOf(missing);
  assert.equal(awake.kind, "unreadable");
  assert.equal(awake.reason, "host_turn_account_unreadable");
  assert.notEqual(agentAwakeOf(readTurnAccount(null)).kind, "awake", "no path is the same absence");
});

test("the world's own facts open her turns, and the producers travel with the count", () => {
  const awake = agentAwakeOf(readTurnAccount(inTemporaryFile(`${ROUND66}\n`)));
  assert.equal(awake.kind, "awake");
  assert.equal(awake.reading.last.byReason.world_fact, 2);
  assert.equal(awake.reading.last.byReason.player_input, 1);
  assert.deepEqual(
    awake.reading.last.worldFactByProducer,
    { adapter_ingress: 1, companion_arrival: 1 },
    "the producers are the ones the world_fact block names, and NOT `due` from beside it",
  );
  assert.match(describeTurnAccount(awake), /^her agent is awake: 2 of 3 opened turn\(s\)/u);
});

test("a session where only the player's own words opened turns does not prove the step", () => {
  const onlyThePlayer = withOpenedBlock("turns opened 1 {player_input: 3, world_fact: 0, due: 0}");
  assert.notEqual(onlyThePlayer, ROUND66, "the fixture had to change, or this case would be the green one");
  const awake = agentAwakeOf(readTurnAccount(inTemporaryFile(`${onlyThePlayer}\n`)));
  assert.equal(awake.kind, "no_world_fact");
  assert.equal(awake.reason, "turn_account_without_world_fact");
  assert.match(awake.detail, /"player_input":3/u);
});

test("an account whose turns-opened block stopped printing world_fact names the members it does print", () => {
  const renamed = withOpenedBlock("turns opened 1 {player_input: 1, due: 0}");
  const awake = agentAwakeOf(readTurnAccount(inTemporaryFile(`${renamed}\n`)));
  assert.equal(awake.kind, "member_absent");
  assert.equal(awake.reason, "turn_account_without_world_fact_member");
  assert.match(awake.detail, /\["player_input","due"\]/u);
});

test("the last line is the run so far, and a trailing fragment is not a line", () => {
  const later = withOpenedBlock(
    "turns opened 9 {player_input: 1, world_fact: 8 {adapter_ingress: 7, program_settlement: 1}, due: 0}",
  );
  const both = readTurnAccountText(`${ROUND66}\n${later}\n`);
  assert.equal(both.lines.length, 2);
  assert.equal(both.last.byReason.world_fact, 8, "the account is cumulative, so the last line answers for the run");
  assert.deepEqual(both.last.worldFactByProducer, { adapter_ingress: 7, program_settlement: 1 });
  const interrupted = readTurnAccountText(`${ROUND66}\n${later.slice(0, 400)}`);
  assert.equal(interrupted.lines.length, 1, "half a line is not a reading");
  assert.equal(interrupted.last.byReason.world_fact, 2);
});

test("a line that names the account without its shape is counted, never silently skipped", () => {
  const broken = `${TURN_ACCOUNT_FACT} turns opened many {player_input: 0}\n`;
  const reading = readTurnAccountText(`${broken}${ROUND66}\n`);
  assert.equal(reading.unreadable.length, 1);
  assert.equal(reading.lines.length, 1);
  assert.equal(parseAccountLine(broken), null);
});
