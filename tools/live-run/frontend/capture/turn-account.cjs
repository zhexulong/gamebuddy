// The Host's own account of the turns it opened, read from the product entry's stderr.
//
// WHY THIS MODULE EXISTS. The step of daily use nobody speaks for is `daily-agent-awake` ("her agent is
// awake while the world runs, opened by the world's own facts and not by the player"). The Host owns those
// turns: `acceptHostMintedFact` enqueues the fact and starts the flush with nothing awaiting it
// (`host/src/host-service.ts:976-982`, single-flighted in `#flushScheduled`), and `CompanionLoop.flush`
// answers one Pi turn per delivered batch and prints `GAME_TURN_ACCOUNT` (`host/src/companion-loop.ts:385`,
// `#reportTurnDecision`, through `turnAccountLine` in `host/src/event-pump.ts:1037`). The launch phase
// already held those bytes - it reads the entry's stderr into `stderr` - and only counted them, so the
// reading gap this module closes was a parser, not a run.
//
// WHAT IS READ, AND WHAT IS NOT. Only the `per delivered batch: turns opened N {…}` segment: one line per
// opened turn, cumulative, so the LAST line is the run's account so far. The rest of the line (assistant
// turns, not-owed reasons, traces, carry ledger) is printed by the same producer and deliberately ignored -
// this step asks one question, and a reader that counted every member of that line would answer it by
// accident.
//
// NOT A ZERO WHEN NOTHING WAS HELD. A stderr holding no account line, an account whose `turns opened` block
// cannot be parsed, and an account with no `world_fact` member are three different readings, and each is
// refused by name (`agentAwakeOf`). A session where only `player_input` turns opened does NOT prove the
// step: somebody spoke, and the question is what happens when nobody does.

const { readFileSync } = require("node:fs");

const TURN_ACCOUNT_FACT = "GAME_TURN_ACCOUNT";

/**
 * The account's shape, in the words a refusal quotes, so a reader can see what was looked for:
 * `GAME_TURN_ACCOUNT turns opened 12 {player_input: 0, world_fact: 12 {adapter_ingress: 11}, due: 0}`.
 */
const ACCOUNT_LINE_SHAPE =
  "GAME_TURN_ACCOUNT turns opened <n> {player_input: <n>, world_fact: <n> {<producer>: <n>}, due: <n>}";

/** The one reason a turn opens that this step is about: a world fact, with no player input behind it. */
const WORLD_FACT = "world_fact";

const OPENED = /turns opened (\d+) \{/u;
const MEMBER = /^([a-z_]+): (\d+)(?: \{(.*)\})?$/u;

/** The members of one `{…}` block, split on its top-level commas: `world_fact`'s own block nests inside. */
function members(text) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      if (current.trim().length > 0) out.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/** `{ producer: count }` from a nested block, or `{}` when the member carries none. */
function producerCounts(text) {
  const counts = {};
  if (typeof text !== "string") return counts;
  for (const entry of members(text)) {
    const match = MEMBER.exec(entry);
    if (match !== null) counts[match[1]] = Number(match[2]);
  }
  return counts;
}

/**
 * One account line as the reading it is, or `null` when the line carries no `turns opened` block.
 *
 * The block is brace-matched rather than matched by a pattern because `world_fact` prints its own producers
 * inside braces, so any `\{[^}]*\}` stops at the first nested `}` and reads `due` as a member of
 * `world_fact`.
 */
function parseAccountLine(line) {
  const opened = OPENED.exec(line);
  if (opened === null) return null;
  const start = opened.index + opened[0].length - 1;
  let depth = 0;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const byReason = {};
        const worldFactByProducer = {};
        let total = 0;
        for (const entry of members(line.slice(start + 1, index))) {
          const match = MEMBER.exec(entry);
          if (match === null) continue;
          const [, name, count, nested] = match;
          byReason[name] = Number(count);
          total += Number(count);
          if (name === WORLD_FACT) Object.assign(worldFactByProducer, producerCounts(nested));
        }
        return { raw: line, opened: Number(opened[1]), byReason, worldFactByProducer, total };
      }
    }
  }
  return null;
}

/**
 * Every account line in a block of stderr, and the lines that named one without parsing.
 *
 * A trailing fragment without its newline is dropped: the file is appended by another process while a driver
 * polls it, and half a line is not a reading. Lines the producer did not write are not counted as
 * unreadable - the entry's stderr carries other sentences (`[tavern-gate] runtime marker unavailable:
 * no_reporter`) and none of them is a missing reading.
 */
function readTurnAccountText(text) {
  if (typeof text !== "string") return { lines: [], unreadable: [], last: null };
  const complete = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n").slice(0, -1);
  const lines = [];
  const unreadable = [];
  for (const raw of complete.map((line) => line.replace(/\r$/u, ""))) {
    if (!raw.startsWith(`${TURN_ACCOUNT_FACT} `)) continue;
    const parsed = parseAccountLine(raw);
    if (parsed === null) unreadable.push(raw);
    else lines.push(parsed);
  }
  return { lines, unreadable, last: lines.length === 0 ? null : lines[lines.length - 1] };
}

/** The run's stderr file, as `held` (could it be read at all), its bytes, and the account inside it. */
function readTurnAccount(file) {
  if (typeof file !== "string" || file.length === 0)
    return { path: null, held: false, bytes: 0, lines: [], unreadable: [], last: null };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { path: file, held: false, bytes: 0, lines: [], unreadable: [], last: null };
  }
  return { path: file, held: true, bytes: Buffer.byteLength(text, "utf8"), ...readTurnAccountText(text) };
}

/**
 * The step's verdict on one reading: awake only when a turn opened for a world fact.
 *
 * Four answers, and each names what was missing. `unreadable` is the harness's absence (no file was held);
 * `absent` is bytes with no account in them (the Host opened no turn at all); `member_absent` is an account
 * whose `turns opened` block no longer prints `world_fact` (the producer's vocabulary moved); and
 * `no_world_fact` is an account that opened turns for other reasons only. None of the four is a zero.
 */
function agentAwakeOf(reading) {
  if (reading === null || reading === undefined || reading.held !== true)
    return {
      kind: "unreadable",
      reason: "host_turn_account_unreadable",
      detail: `the product entry's stderr was not held for this run (${reading?.path ?? "no path in the launch state"}), so ${ACCOUNT_LINE_SHAPE} could not be looked for`,
      reading: reading ?? null,
    };
  const { last } = reading;
  if (last === null)
    return {
      kind: "absent",
      reason: "turn_account_absent",
      detail: `${String(reading.bytes)} byte(s) of the product entry's stderr were read and none of them is ${ACCOUNT_LINE_SHAPE}${reading.unreadable.length === 0 ? "" : ` (${String(reading.unreadable.length)} line(s) named ${TURN_ACCOUNT_FACT} and could not be parsed: ${JSON.stringify(reading.unreadable.slice(-1))})`}`,
      reading,
    };
  if (last.byReason[WORLD_FACT] === undefined)
    return {
      kind: "member_absent",
      reason: "turn_account_without_world_fact_member",
      detail: `the account's turns-opened block names ${JSON.stringify(Object.keys(last.byReason))} and no ${WORLD_FACT}, so the member this step reads is gone from the producer: ${JSON.stringify(last.raw)}`,
      reading,
    };
  if (last.byReason[WORLD_FACT] === 0)
    return {
      kind: "no_world_fact",
      reason: "turn_account_without_world_fact",
      detail: `${String(last.opened)} turn(s) opened and none of them for a world fact (${JSON.stringify(last.byReason)}); a session where only the player's own words opened turns does not prove this step: ${JSON.stringify(last.raw)}`,
      reading,
    };
  return {
    kind: "awake",
    reason: null,
    detail: `${String(last.byReason[WORLD_FACT])} of ${String(last.opened)} opened turn(s) were opened by a world fact ${JSON.stringify(last.worldFactByProducer)}, with the player's own words accounting for ${String(last.byReason.player_input ?? 0)}`,
    reading,
  };
}

/** The awake reading as one line of the driver's facts file: the counts, the producers, and the line's index. */
function describeTurnAccount(awake) {
  if (awake === null || awake === undefined) return "the turn account was not read";
  if (awake.kind !== "awake") return `${awake.reason}: ${awake.detail}`;
  const { last } = awake.reading;
  return `her agent is awake: ${awake.detail}; read from ${String(awake.reading.lines.length)} ${TURN_ACCOUNT_FACT} line(s) in ${String(awake.reading.bytes)} byte(s) of the entry's stderr, the last of them the run so far (${JSON.stringify(last.raw)})`;
}

module.exports = {
  ACCOUNT_LINE_SHAPE,
  TURN_ACCOUNT_FACT,
  WORLD_FACT,
  agentAwakeOf,
  describeTurnAccount,
  parseAccountLine,
  readTurnAccount,
  readTurnAccountText,
};
