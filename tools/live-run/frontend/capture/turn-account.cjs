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
 * The producer's OTHER record of a turn, written once per turn that delivered: the witness a missing account line is
 * measured against.
 *
 * A batch is composed on exactly one branch of `EventPump.flush` - the branch that increments `turns opened` - so a
 * `NATIVE_COMPANION_TURN_DELIVERY` line whose `carried` names a batch cannot exist unless the pump opened a turn. That
 * makes this line, and not the reader's hope, the proof that an absent account is a producer's silence rather than a
 * window in which no turn opened.
 */
const TURN_DELIVERY_FACT = "NATIVE_COMPANION_TURN_DELIVERY";

/** The companion body program's mount record: the second marker, and the one that says the world-driven path was live. */
const BODY_PROGRAM_MOUNT_FACT = "BODY_PROGRAM_MOUNT";

/**
 * The account's shape, in the words a refusal quotes, so a reader can see what was looked for:
 * `GAME_TURN_ACCOUNT turns opened 12 {player_input: 0, world_fact: 12 {adapter_ingress: 11}, due: 0}`.
 */
const ACCOUNT_LINE_SHAPE =
  "GAME_TURN_ACCOUNT turns opened <n> {player_input: <n>, world_fact: <n> {<producer>: <n>}, due: <n>}";

/** The one reason a turn opens that this step is about: a world fact, with no player input behind it. */
const WORLD_FACT = "world_fact";

/**
 * The reason a turn opens because the person spoke, as the producer prints it.
 *
 * Named here as well as above because two chain steps read this one account for opposite questions:
 * `daily-agent-awake` proves her turn came from the WORLD (`world_fact` at least once), and `daily-play`
 * proves the player's own words reached her (`player_input` at least once). The declaration of the second
 * derives its fact from this constant, so the step and the reader cannot drift into two spellings.
 */
const PLAYER_INPUT = "player_input";

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

/** The JSON a `FACT {…}` line carries, or `null` when the line carries none this reader can read. */
function payloadOf(raw, fact) {
  try {
    const record = JSON.parse(raw.slice(fact.length));
    return typeof record === "object" && record !== null ? record : null;
  } catch {
    return null;
  }
}

/**
 * The two markers in one block of stderr: what the Host DELIVERED, beside what it said about its turns.
 *
 * Kept apart from the account reader because they answer different questions. The account is the producer's statement
 * about the turns it opened; these records are what it did, printed once per turn - so a reading that has the second and
 * not the first is a contradiction the verdict has to name, never an answer of "no turns".
 */
function readTurnEvidence(complete) {
  const deliveries = [];
  let bodyProgramMounted = false;
  for (const raw of complete) {
    if (raw.startsWith(`${TURN_DELIVERY_FACT} `)) {
      const record = payloadOf(raw, TURN_DELIVERY_FACT);
      if (record === null) continue;
      deliveries.push({
        raw,
        presented: Number(record.presented ?? 0),
        bubbles: Number(record.bubbles ?? 0),
        carried: Array.isArray(record.carried) ? record.carried : [],
        leaseAdmitted: record.lease?.admitted === true,
      });
    } else if (raw.startsWith(`${BODY_PROGRAM_MOUNT_FACT} `)) {
      bodyProgramMounted = payloadOf(raw, BODY_PROGRAM_MOUNT_FACT)?.mounted === true;
    }
  }
  return { deliveries, bodyProgramMounted };
}

/**
 * The sentence that names a silence the producer's own records contradict, or `null` when nothing in the file proves a
 * turn.
 *
 * A delivery record proves one only when it names what its batch was made of (`carried`) or something it presented: the
 * record exists for a turn that produced text, and a batch exists only on the pump's opened branch.
 */
function openedTurnEvidence(reading) {
  const proving = reading.deliveries.filter((delivery) => delivery.carried.length > 0 || delivery.presented > 0);
  if (proving.length === 0) return null;
  const last = proving[proving.length - 1];
  const mounted = reading.bodyProgramMounted
    ? `${BODY_PROGRAM_MOUNT_FACT} says mounted:true in the same file`
    : `no ${BODY_PROGRAM_MOUNT_FACT} line in the same file says the companion body program was mounted`;
  return `THE ACCOUNT IS SILENT ABOUT A TURN THIS RUN OPENED AND PRESENTED: ${String(proving.length)} ${TURN_DELIVERY_FACT} record(s) in the same stderr name a composed batch and its presentation (the last: carried ${JSON.stringify(last.carried)}, presented ${String(last.presented)}, bubbles ${String(last.bubbles)}, lease admitted ${String(last.leaseAdmitted)}), and a batch is composed only on the pump's opened branch - so a turn opened and the missing line is the producer's own silence, not a window without a turn; ${mounted}: ${JSON.stringify(last.raw)}`;
}

/**
 * One account line as the reading it is, or `null` when the line carries no `turns opened` block.
 *
 * The block is brace-matched rather than matched by a pattern because `world_fact` prints its own producers inside
 * braces, so any `\{[^}]*\}` stops at the first nested `}` and reads `due` as a member of `world_fact`.
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
  if (typeof text !== "string")
    return { lines: [], unreadable: [], last: null, deliveries: [], bodyProgramMounted: false };
  const complete = (text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n").slice(0, -1)).map((line) =>
    line.replace(/\r$/u, ""),
  );
  const lines = [];
  const unreadable = [];
  for (const raw of complete) {
    if (!raw.startsWith(`${TURN_ACCOUNT_FACT} `)) continue;
    const parsed = parseAccountLine(raw);
    if (parsed === null) unreadable.push(raw);
    else lines.push(parsed);
  }
  return { lines, unreadable, last: lines.length === 0 ? null : lines[lines.length - 1], ...readTurnEvidence(complete) };
}

/** The run's stderr file, as `held` (could it be read at all), its bytes, and the account inside it. */
function readTurnAccount(file) {
  if (typeof file !== "string" || file.length === 0)
    return {
      path: null,
      held: false,
      bytes: 0,
      lines: [],
      unreadable: [],
      last: null,
      deliveries: [],
      bodyProgramMounted: false,
    };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {
      path: file,
      held: false,
      bytes: 0,
      lines: [],
      unreadable: [],
      last: null,
      deliveries: [],
      bodyProgramMounted: false,
    };
  }
  return { path: file, held: true, bytes: Buffer.byteLength(text, "utf8"), ...readTurnAccountText(text) };
}

/**
 * The step's verdict on one reading: awake only when a turn opened for a world fact.
 *
 * Four answers, and each names what was missing. `unreadable` is the harness's absence (no file was held);
 * `absent` is bytes with no account in them (the Host opened no turn at all) - and when those same bytes carry the
 * producer's own record of a composed batch and its presentation, the refusal cites both markers, because a silent
 * account about a turn that opened is the producer's defect and not a zero; `member_absent` is an account
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
  if (last === null) {
    const silent = openedTurnEvidence(reading);
    return {
      kind: "absent",
      reason: "turn_account_absent",
      detail: `${String(reading.bytes)} byte(s) of the product entry's stderr were read and none of them is ${ACCOUNT_LINE_SHAPE}${reading.unreadable.length === 0 ? "" : ` (${String(reading.unreadable.length)} line(s) named ${TURN_ACCOUNT_FACT} and could not be parsed: ${JSON.stringify(reading.unreadable.slice(-1))})`}${silent === null ? "" : `. ${silent}`}`,
      reading,
    };
  }
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
    detail: `${String(last.byReason[WORLD_FACT])} of ${String(last.opened)} opened turn(s) were opened by a world fact ${JSON.stringify(last.worldFactByProducer)}, with the player's own words accounting for ${String(last.byReason[PLAYER_INPUT] ?? 0)}`,
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
  BODY_PROGRAM_MOUNT_FACT,
  TURN_ACCOUNT_FACT,
  TURN_DELIVERY_FACT,
  PLAYER_INPUT,
  WORLD_FACT,
  agentAwakeOf,
  describeTurnAccount,
  parseAccountLine,
  readTurnAccount,
  readTurnAccountText,
  readTurnEvidence,
};
