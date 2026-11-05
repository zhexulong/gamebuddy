/**
 * The interaction-value gate: a run can be mechanically green and still be a screensaver.
 *
 * <p>
 * `crossings 2 of 2`, zero violations, every action green - and the player sat through twenty-five minutes of a
 * companion that said four lines and reported its own chores. That is a product failure, so it is measured here and
 * published beside the mechanical verdict, in `result.json` under `interactionValue`.
 * </p>
 *
 * <h2>Binding: the session file this run opened, not a guess</h2>
 *
 * <p>
 * The game surface writes `<runtimeCwd>/surface-sessions/<surfaceSessionId>/sessions/<utc>_<sessionId>.jsonl`, and a
 * capture copies that whole tree under the run directory - so a copied runtime root carries the profile's whole history,
 * dozens of records and some of them days old. Two runs launched thirty-eight minutes apart once published the SAME
 * foreign record as each run's own measurement (2026-10-22 audit), so the population is decided by the FILE NAME: the
 * `<utc>` prefix is the moment the runtime opened that session, and only a file stamped inside the run's own window (its
 * `result.json` `startedAtMs`/`endedAtMs`, plus one minute of slack) can be this run's session at all. Older history is
 * not an ambiguity to resolve - it is not a candidate, and it is counted as excluded so the next reader can see that.
 * </p>
 *
 * <p>
 * Among the files inside the window the latest stamp at or before the run's end is bound and the rest are published as
 * `superseded`: a run that restarted its surface session leaves the earlier record behind, and measuring that one would
 * describe a conversation which had already stopped. The chosen file's own message timestamps are then asserted against
 * the same window with `SESSION_BINDING_SLACK_MS`, so a name filter that picked a file whose conversation belongs
 * elsewhere fails loudly as `chosen_session_outside_window`, naming the file, instead of being measured as this run's.
 * `measurements.sessionBinding` carries the window, the counts and the file, because the next reader has to be able to
 * see why that one was chosen.
 * </p>
 *
 * <h2>Register: the classification rule, stated so it can be argued with</h2>
 *
 * <p>
 * A false "step report" verdict is worse than none: a companion that says "草浇完了，石头也敲完了" is reporting, while
 * one that says "石头搬不动，我先去清草" is not, and a classifier that cannot tell them apart would red a good run. So
 * each line is assigned by the FIRST rule it satisfies, and the rules are narrow by construction:
 * </p>
 *
 * <ol>
 *   <li><b>step_report</b> - the line is a BARE sequence of completed actions. Every clause (split on
 *   `，,、。；;！!？?` and newlines) must contain an action stem IMMEDIATELY followed by a completion marker
 *   (`浇完`/`修好了`/`清完`), and the line as a whole must contain no second person, no question, no stance, no plan
 *   word, and no obstacle word. "我把草清了" qualifies; "草浇完了，不过石头太多搬不动" does not (obstacle word), and
 *   "我把草清了，你去浇水吧" does not (second person). The adjacency is not decoration: an action stem anywhere plus a
 *   completion marker anywhere also matched "这一片终于干净了" (干 of 干净 + 了) on the 2026-11-04 multiday run, which
 *   is a satisfied observation, not a report of an action.</li>
 *   <li><b>obstacle</b> - names a concrete setback or refusal (卡/挡/堵/够不着/搬不动/太重/没水/坏了/来不及/天黑/下雨
 *   …).</li>
 *   <li><b>choice</b> - hands a decision to the player (要不要/还是/你定/你说/听你的/选哪/你觉得 …).</li>
 *   <li><b>player_or_day</b> - an unprompted remark about the PLAYER or the day, not about the task. Two structural
 *   asks, either one enough: the line <b>addresses the player</b> (a 你/您 that is not the plural 你们 or the greeting
 *   你好/您早), or it <b>locates the day</b> - a named part of it (清早/中午/傍晚/半夜), a clock reading with its own
 *   suffix (十点了/六点半), the state of the light (天亮/擦黑/天色/入夜), or bedtime itself (晚安/早点睡). A day word
 *   only counts in a clause
 *   that is not itself a finished action, so "擦黑前我把草清了" stays the chore it is. This rule used to be a list of
 *   care collocations with the player (你累/你先歇/晚安/早点睡), and the 2026-11-05 multiday run - ten lines to the
 *   player, not one of them a collocation - was measured as a single remark. The lesson is the same one the rule above
 *   already encodes: second person is proof a line is not a report, so it is proof it is speaking to someone.</li>
 *   <li><b>other</b> - the residual: a line that neither reports, nor names a setback, nor hands over a decision, nor
 *   speaks to the player. It is a line the classifier does not recognise, never a line that is fine.</li>
 * </ol>
 *
 * <h2>Clauses: `not_exercised` is not a pass</h2>
 *
 * <p>
 * Each of the four 30-minute clauses answers `pass`, `fail` or `not_exercised`, and only `pass` counts toward
 * `verdict: "passed"`. `not_exercised` carries the fact that stopped it (no player input was found, the world never
 * refused anything) so a reader can tell an untriggered clause from a satisfied one; the verdict is `failed` for any
 * run whose gate did not pass, and `not_established` only when the session could not be bound to the run at all.
 * </p>
 *
 * <p>
 * This is not `lib/latency-silence.mjs`: that instrument measures the gap between OBSERVABLE events (dispatch, receipt,
 * spoken line) to judge felt latency. The silence measured here is the companion's own - between spoken lines - and its
 * companion figure is what the world did during it, which is the difference between "it was working quietly" and "it
 * had nothing to say".
 * </p>
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { TERMINAL_STATES } from "../lib/stardew-native-smoke-harness-v1.mjs";

export const SCHEMA = "gamebuddy_interaction_value_gate/v1";

/** The clause's own rate: at least one player-or-day remark per this many wall-clock minutes. */
export const PLAYER_OR_DAY_REMARK_PER_WALL_MINUTES = 5;

/**
 * How far outside the run's window the chosen session's own messages may reach.
 *
 * The session is created within a second of the run's start and its last entry lands during teardown, so a few seconds
 * would do; five minutes tolerates a slow teardown while staying far below the thirty-eight minutes that separated the
 * two runs whose records were once mixed.
 */
export const SESSION_BINDING_SLACK_MS = 5 * 60_000;

/**
 * How far outside the run's window a session file's NAME may be stamped and still be a candidate.
 *
 * A minute covers the gap between the runner's start clock and the runtime opening its session file; anything older is
 * the profile's history rather than this run's session, which is the whole reason the population is filtered by name
 * before any file is read.
 */
export const SESSION_FILE_WINDOW_SLACK_MS = 60_000;

/** How long after an obstacle the next spoken line may still be its plan. */
export const PLAN_LOOKAHEAD_MS = 90_000;

/** A refusal is a terminal receipt that is not an accomplishment, derived from the shared terminal-state union. */
const ACCOMPLISHMENT_STATES = new Set(["succeeded", "partially_succeeded"]);
export const SETBACK_STATES = new Set([...TERMINAL_STATES].filter((state) => !ACCOMPLISHMENT_STATES.has(state)));

/** The two product tools through which a player's line becomes a plan or a submitted program. */
const PLAN_TOOL_NAMES = new Set(["stardew_plan_work", "stardew_submit_action_program"]);

const STEP_ACTION_COMPLETION =
  /(?:浇|种|收|割|砍|敲|挖|搬|清|除|整理|摆|放|修|铺|擦|洗|拿|装|填|喂|挪|拆|建|做|干|弄|捡|采|摘|钓|煮|烧|刷|扫|倒)(?:完|好|搞定|结束|完成|妥|了)/u;
const STEP_IN_PROGRESS = /正在|还在|在(?:浇|种|收|弄|做|干|搬|清)/u;
const STEP_REPORT_DISQUALIFIER =
  /你|您|？|\?|吧|要不要|还是|我(?:想|觉得|看|担心|怕)|累|困|饿|先|然后|接着|要不|待会|一会儿|回头|卡|挡|堵|够不着|搬不动|来不及|天黑|下雨|不够|满了/u;
const OBSTACLE =
  /卡住|卡在|卡了|挡住|堵|过不去|够不着|走不到|搬不动|砍不动|敲不动|弄不动|太重|进不去|满了|被占|没(?:水|钱|地方|位置|路|空|时间)|空着|坏了|来不及|天黑|下雨|太远|失败|不行|不够|没法/u;
const CHOICE = /要不要|还是|你定|你说|听你的|选哪|哪个|哪块|哪边|你想|你觉得|拿个主意|你挑|行不行|好不好/u;
const PLAN = /先|然后|接着|再|换个|绕|去拿|回头|一会儿|待会|明早|等会|试试|要不/u;

/**
 * A word that locates the day rather than the task: a named part of it, a clock reading, or the state of the light.
 *
 * The clock form requires its own suffix (`了`/`半`/`钟`/`整`), so "a bit faster" (快一点) is not a time of day. `天黑`
 * is deliberately absent: it is an obstacle word, checked before this rule, and a second spelling of one fact is how the
 * two drift apart.
 */
const DAY_REFERENCE =
  /清早|早上|早晨|上午|中午|下午|傍晚|夜里|半夜|深夜|凌晨|今晚|昨儿晚|昨晚|明早|天亮|擦黑|天色|入夜|晚安|早点(?:睡|歇|休息)|(?:十|十一|十二|[一二三四五六七八九两])点(?:了|半|钟|整)/u;

/** The clause boundary every rule in this file splits on. */
const CLAUSE_SEPARATOR = /[，,、。；;！!？?\n]+/u;

/** Words that carry 你/您 without addressing the player as a person: a plural, and two bare greetings. */
const NOT_A_PLAYER_ADDRESS = ["你们", "你好", "您早"];

const CJK_RUN = /[\u4e00-\u9fff]{2,}/gu;
const SELF_TAG = /^§\d+§\s*/u;
const STOP_TOKENS = new Set([
  "现在",
  "今天",
  "明天",
  "然后",
  "已经",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "什么",
  "怎么",
  "可以",
  "一个",
  "就是",
  "不是",
  "还有",
  "所以",
  "因为",
  "但是",
  "自己",
  "时候",
  "东西",
]);

/** The register tally, empty: the counts, and the two kinds of `player_or_day` remark kept apart. */
function emptyRegister() {
  return {
    counts: { step_report: 0, obstacle: 0, choice: 0, player_or_day: 0, other: 0 },
    player_or_day: { addressed_to_player: 0, day_only: 0 },
  };
}

/**
 * Every spoken line counted by register, and the `player_or_day` remarks split by which structural ask found them.
 *
 * The split is not gated: it is what tells a reader whether the run talked to the player or merely narrated the clock.
 */
function tallyRegisters(lines) {
  const register = emptyRegister();
  for (const line of lines) {
    register.counts[line.register] += 1;
    if (line.basis === "addressed_to_player") register.player_or_day.addressed_to_player += 1;
    if (line.basis === "day_only") register.player_or_day.day_only += 1;
  }
  return register;
}

const isTime = (value) => typeof value === "number" && Number.isFinite(value);

/** The clauses, in the order the gate reports them. */
const CLAUSE_REQUIREMENTS = Object.freeze([
  { id: "player_or_day_rate", requirement: ">= 1 player_or_day remark per 5 wall-minutes" },
  { id: "player_agency", requirement: ">= 1 player input with an observable consequence" },
  { id: "obstacle_with_plan", requirement: ">= 1 obstacle narrated WITH a next plan (quoted pair)" },
  { id: "no_step_reports", requirement: "0 step_report lines" },
]);

/** An ISO timestamp, or a number already in milliseconds, on the one clock everything else is on. */
function clockMs(value) {
  if (isTime(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The Mod's own `HHMM` game clock as minutes after 00:00, including the engine's 24:00-26:00 tail. */
function minuteOfDay(gameTime) {
  if (typeof gameTime !== "string") return null;
  const digits = gameTime.trim();
  if (!/^\d{3,4}$/u.test(digits)) return null;
  const hours = Math.floor(Number(digits) / 100);
  const minutes = Number(digits) % 100;
  if (minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The UTC stamp a run directory or a session file names itself with: `2026-11-04T10-32-09-415Z`. */
const UTC_NAME_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u;

function stampedNameMs(name) {
  const match = UTC_NAME_STAMP.exec(name);
  if (match === null) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `2026-11-04T10-32-09-415Z-multiday_routine` - the run directory names its own start. */
function runDirectoryStartMs(runDir) {
  if (typeof runDir !== "string") return null;
  return stampedNameMs(runDir.split(/[\\/]/u).at(-1) ?? "");
}

/** `2026-11-04T10-32-10-246Z_<sessionId>.jsonl` - the session file names the moment the runtime opened it. */
function sessionFileStampedAtMs(path) {
  return stampedNameMs(basename(path));
}

function readJsonl(path) {
  const rows = [];
  let unreadable = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      unreadable += 1;
    }
  }
  return { rows, unreadable };
}

/** The candidate session records a run directory can hold, by the product's own path shape. */
function sessionCandidatesInRunDirectory(runDir) {
  const candidates = [];
  for (const root of [join(runDir, "runtime-root"), runDir]) {
    const contexts = join(root, "contexts");
    if (!existsSync(contexts)) continue;
    for (const context of safeDirectories(contexts)) {
      const surfaces = join(contexts, context, "surface-sessions");
      if (!existsSync(surfaces)) continue;
      for (const surface of safeDirectories(surfaces)) {
        const sessions = join(surfaces, surface, "sessions");
        if (!existsSync(sessions)) continue;
        for (const name of safeJsonlFiles(sessions)) candidates.push(join(sessions, name));
      }
    }
  }
  return candidates;
}

function safeDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function safeJsonlFiles(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Every message in a session record, whichever role, with its entry timestamp. */
function sessionMessages(rows) {
  return rows
    .filter((row) => row?.type === "message" && typeof row?.message === "object" && row.message !== null)
    .map((row) => ({ atMs: clockMs(row.timestamp), role: row.message.role, content: row.message.content }));
}

function textParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0);
}

function userText(content) {
  if (typeof content === "string") return content;
  return textParts(content).join("\n");
}

function parseFactBatch(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed?.kind === "gamebuddy_fact_batch" ? parsed : null;
  } catch {
    return null;
  }
}

/** The two-character content tokens of a player's line, used to see whether a reply took it up. */
function contentTokens(text) {
  const tokens = new Set();
  for (const run of String(text).match(CJK_RUN) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const token = run.slice(index, index + 2);
      if (!STOP_TOKENS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function sharedToken(inputText, lineText) {
  for (const token of contentTokens(inputText)) if (lineText.includes(token)) return token;
  return null;
}

/** The register a spoken line is in, by the rules stated in this module's header. */
export function classifySpokenLine(text) {
  const line = String(text ?? "")
    .replace(SELF_TAG, "")
    .trim();
  if (line.length === 0) return { register: "other", matched: null, basis: null };
  if (isStepReport(line))
    return { register: "step_report", matched: "every_clause_is_a_completed_action", basis: null };
  const obstacle = OBSTACLE.exec(line);
  if (obstacle !== null) return { register: "obstacle", matched: obstacle[0], basis: null };
  // Before the player-or-day rule: a decision handed over is a choice even when it is also addressed to the player.
  const choice = CHOICE.exec(line);
  if (choice !== null) return { register: "choice", matched: choice[0], basis: null };
  const address = playerAddress(line);
  if (address !== null) return { register: "player_or_day", matched: address, basis: "addressed_to_player" };
  const day = dayReference(line);
  if (day !== null) return { register: "player_or_day", matched: day, basis: "day_only" };
  return { register: "other", matched: null, basis: null };
}

function clausesOf(line) {
  return line
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isStepReport(line) {
  if (STEP_REPORT_DISQUALIFIER.test(line)) return false;
  if (STEP_IN_PROGRESS.test(line)) return false;
  const clauses = clausesOf(line);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => STEP_ACTION_COMPLETION.test(clause));
}

/**
 * The pronoun that addresses the player, or null when the line does not speak to them.
 *
 * 你们 is a plural and 你好/您早 are greetings: all three carry the character without turning the line into a remark
 * about the person in front of the companion.
 */
function playerAddress(line) {
  if (!/[你您]/u.test(line)) return null;
  let bare = line;
  for (const word of NOT_A_PLAYER_ADDRESS) bare = bare.replaceAll(word, "");
  const pronoun = /[你您]/u.exec(bare);
  return pronoun === null ? null : pronoun[0];
}

/**
 * The day word that locates the time, or null when the line is about the task.
 *
 * Only a clause that is not itself a finished action counts: "擦黑前我把草清了" is a report of a chore that happens
 * to name the hour, and counting it would let a run of pure narration pass the clause it exists to fail.
 */
function dayReference(line) {
  for (const clause of clausesOf(line)) {
    const match = DAY_REFERENCE.exec(clause);
    if (match !== null && !STEP_ACTION_COMPLETION.test(clause)) return match[0];
  }
  return null;
}

/**
 * The Mod's game clock, accumulated across day rollovers and readable at any wall-clock instant.
 *
 * The Mod publishes `gameTime` on some world facts (the `time_milestone` family, `day_started`, paged dialogue), which
 * is a sequence of samples rather than a continuous clock: a `HHMM` value that goes backwards is a new day, and the
 * minute between two samples is interpolated. An instant outside the sampled range answers `null` - a game-time
 * duration that the samples cannot cover is not measured, never zero.
 */
function gameClock(timelineRows) {
  const samples = [];
  let dayOffset = 0;
  let previous = null;
  for (const row of timelineRows) {
    const raw = row?.gameTime ?? row?.worldFactPayload?.gameTime ?? null;
    const minute = minuteOfDay(raw);
    if (minute === null) continue;
    if (previous !== null && minute < previous) dayOffset += 1440;
    previous = minute;
    samples.push({ atMs: isTime(row?.atMs) ? row.atMs : null, minutes: minute + dayOffset, gameTime: String(raw) });
  }
  const timed = samples.filter((sample) => sample.atMs !== null).sort((left, right) => left.atMs - right.atMs);
  const spanMinutes = samples.length < 2 ? null : samples[samples.length - 1].minutes - samples[0].minutes;
  const minutesAt = (atMs) => {
    if (!isTime(atMs) || timed.length === 0) return null;
    if (atMs < timed[0].atMs || atMs > timed[timed.length - 1].atMs) return null;
    for (let index = 1; index < timed.length; index += 1) {
      const before = timed[index - 1];
      const after = timed[index];
      if (atMs < before.atMs || atMs > after.atMs) continue;
      if (after.atMs === before.atMs) return before.minutes;
      const ratio = (atMs - before.atMs) / (after.atMs - before.atMs);
      return before.minutes + (after.minutes - before.minutes) * ratio;
    }
    return timed[timed.length - 1].minutes;
  };
  return {
    sampleCount: samples.length,
    timedSampleCount: timed.length,
    first: samples.length === 0 ? null : samples[0].gameTime,
    last: samples.length === 0 ? null : samples[samples.length - 1].gameTime,
    // The run's own game-time span, from the first to the last `gameTime` value the Mod published. This is the span of
    // the samples themselves, so it is measurable even when no spoken line falls inside the sampled range.
    spanMinutes,
    minutesAt,
  };
}

/** How many facts of each kind the timeline recorded strictly inside a window. */
function worldActivity(timelineRows, fromAtMs, toAtMs) {
  if (!(isTime(fromAtMs) && isTime(toAtMs))) return null;
  const byType = {};
  let total = 0;
  for (const row of timelineRows) {
    if (!isTime(row?.atMs) || row.atMs <= fromAtMs || row.atMs >= toAtMs) continue;
    const kind = typeof row.type === "string" ? row.type : "unknown";
    byType[kind] = (byType[kind] ?? 0) + 1;
    total += 1;
  }
  return { total, byType };
}

function collectSpokenLines(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const text of textParts(message.content)) {
      const { register, matched, basis } = classifySpokenLine(text);
      lines.push({ atMs: message.atMs, text, register, matched, basis });
    }
  }
  return lines.sort((left, right) => (left.atMs ?? 0) - (right.atMs ?? 0));
}

function collectToolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "toolCall" && typeof part.name === "string")
        calls.push({ atMs: message.atMs, name: part.name });
    }
  }
  return calls;
}

function collectPlayerInputs(messages) {
  const inputs = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = userText(message.content);
    const batch = parseFactBatch(text);
    if (batch !== null) {
      for (const input of Array.isArray(batch.playerInputs) ? batch.playerInputs : []) {
        if (typeof input?.text !== "string" || input.text.trim().length === 0) continue;
        inputs.push({
          atMs: message.atMs,
          inputId: typeof input.inputId === "string" ? input.inputId : null,
          source: typeof input.source === "string" ? input.source : null,
          text: input.text.trim(),
        });
      }
      continue;
    }
    if (text.trim().length > 0)
      inputs.push({ atMs: message.atMs, inputId: null, source: "unattributed_user_message", text: text.trim() });
  }
  return inputs.sort((left, right) => (left.atMs ?? 0) - (right.atMs ?? 0));
}

/** What the run did after one player's line, inside that line's own window. */
function consequencesFor({ input, windowEndMs, toolCalls, receipts, lines }) {
  const inside = (atMs) => isTime(atMs) && isTime(input.atMs) && atMs > input.atMs && atMs <= windowEndMs;
  const kinds = { plan_submitted: 0, action_attempted: 0, refused: 0, spoken_to: 0 };
  const evidence = [];
  const record = (kind, row) => {
    kinds[kind] += 1;
    if (evidence.length < 8) evidence.push(row);
  };
  for (const call of toolCalls) {
    if (!(inside(call.atMs) && PLAN_TOOL_NAMES.has(call.name))) continue;
    record("plan_submitted", { kind: "plan_submitted", atMs: call.atMs, detail: call.name });
  }
  for (const receipt of receipts) {
    if (!inside(receipt.atMs)) continue;
    const kind = SETBACK_STATES.has(receipt.state) ? "refused" : "action_attempted";
    record(kind, { kind, atMs: receipt.atMs, detail: `${receipt.state}/${receipt.reasonCode ?? "unknown"}` });
  }
  for (const line of lines) {
    if (!inside(line.atMs)) continue;
    const token = sharedToken(input.text, line.text);
    if (token === null) continue;
    record("spoken_to", { kind: "spoken_to", atMs: line.atMs, detail: token, line: line.text });
  }
  const observed = kinds.plan_submitted + kinds.action_attempted + kinds.refused + kinds.spoken_to;
  return { kinds, evidence, state: observed === 0 ? "no_consequence" : "consequence_observed" };
}

function quoteLines(lines, indexes, limit = 5) {
  return indexes.slice(0, limit).map((index) => ({ atMs: lines[index].atMs, text: lines[index].text }));
}

/**
 * The obstacle/plan pairs, quoting both halves.
 *
 * A plan is either in the same line ("石头搬不动，我先去清草") or in the very next spoken line within
 * `PLAN_LOOKAHEAD_MS`. One line of lookahead is deliberate: two lines later the companion has moved on, and a plan
 * paired with a setback it does not answer would pass the clause on a coincidence.
 */
function obstaclePlanPairs(lines) {
  const pairs = [];
  for (let index = 0; index < lines.length; index += 1) {
    const obstacle = lines[index];
    if (obstacle.register !== "obstacle") continue;
    const same = PLAN.exec(obstacle.text) !== null;
    const next = lines[index + 1];
    const nextIsPlan =
      next !== undefined &&
      PLAN.exec(next.text) !== null &&
      next.register !== "step_report" &&
      isTime(obstacle.atMs) &&
      isTime(next.atMs) &&
      next.atMs - obstacle.atMs <= PLAN_LOOKAHEAD_MS;
    if (!(same || nextIsPlan)) continue;
    pairs.push({
      obstacleIndex: index,
      planIndex: same ? index : index + 1,
      obstacle: { atMs: obstacle.atMs, text: obstacle.text },
      plan: { atMs: same ? obstacle.atMs : next.atMs, text: same ? obstacle.text : next.text },
    });
  }
  return pairs;
}

function measureSilence({ lines, runStartMs, runEndMs, clock, timelineRows }) {
  const timed = lines.filter((line) => isTime(line.atMs));
  // A timeline recorded before it carried `atMs` cannot place its facts inside a gap, and "0 facts" would read as
  // "nothing happened" - the one reading that is certainly wrong.
  const placeable = timelineRows.some((row) => isTime(row?.atMs));
  let longest = null;
  for (let index = 1; index < timed.length; index += 1) {
    const before = timed[index - 1];
    const after = timed[index];
    const wallMs = after.atMs - before.atMs;
    if (longest !== null && wallMs <= longest.wallMs) continue;
    const fromGame = clock.minutesAt(before.atMs);
    const toGame = clock.minutesAt(after.atMs);
    longest = {
      wallMs,
      fromAtMs: before.atMs,
      toAtMs: after.atMs,
      fromText: before.text,
      toText: after.text,
      gameMinutes: fromGame === null || toGame === null ? null : toGame - fromGame,
      world: placeable ? worldActivity(timelineRows, before.atMs, after.atMs) : null,
    };
  }
  const first = timed[0];
  const last = timed[timed.length - 1];
  return {
    longest,
    measuredBetweenLines: timed.length >= 2,
    headMs: first === undefined || !isTime(runStartMs) ? null : first.atMs - runStartMs,
    tailMs: last === undefined || !isTime(runEndMs) ? null : runEndMs - last.atMs,
  };
}

function clause(id, state, observed, evidence = [], reason = null) {
  const requirement = CLAUSE_REQUIREMENTS.find((entry) => entry.id === id).requirement;
  return { id, requirement, state, observed, evidence, reason };
}

/** The run's start, from the runner's own phase clock, the timeline, or the run directory's name. */
function resolveRunStartMs({ runStartedAtMs, timelineTimes, runDir }) {
  if (isTime(runStartedAtMs)) return runStartedAtMs;
  if (timelineTimes.length > 0) return Math.min(...timelineTimes);
  return runDirectoryStartMs(runDir) ?? null;
}

/**
 * The run's end: the last timed fact, or - for a run recorded before the timeline carried `atMs` - the moment the
 * timeline file stopped being written, which is the same boundary observed from outside.
 */
function resolveRunEndMs({ timelineTimes, timelinePath }) {
  if (timelineTimes.length > 0) return Math.max(...timelineTimes);
  if (timelinePath === null) return null;
  try {
    return statSync(timelinePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The window the run's own `result.json` recorded: the runner's `startedAtMs` and `endedAtMs`.
 *
 * The candidate population is decided on this window, because it is the run's own statement about when it was running.
 * The timeline's first and last fact lie inside the same interval, so they are the fallback for a run captured before its
 * result carried the phase clock - not the authority, since the capture can stop writing the timeline before teardown.
 */
function runResultWindowMs(runDir) {
  if (runDir === null) return { startedAtMs: null, endedAtMs: null };
  const path = join(runDir, "result.json");
  if (!existsSync(path)) return { startedAtMs: null, endedAtMs: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      startedAtMs: isTime(parsed?.startedAtMs) ? parsed.startedAtMs : null,
      endedAtMs: isTime(parsed?.endedAtMs) ? parsed.endedAtMs : null,
    };
  } catch {
    return { startedAtMs: null, endedAtMs: null };
  }
}

/**
 * The one session record this run owns, or the reason none could be shown to be its own.
 *
 * The population is the files whose NAME stamp falls inside the run's window (plus `SESSION_FILE_WINDOW_SLACK_MS`); the
 * chosen file is then re-checked on its own message timestamps, so a filter that picked a file whose conversation
 * belongs elsewhere says so by name instead of being measured.
 */
function bindSessionToRun({ candidates, runWindow, explicit }) {
  const fromMs = runWindow.startMs - SESSION_FILE_WINDOW_SLACK_MS;
  const toMs = runWindow.endMs + SESSION_FILE_WINDOW_SLACK_MS;
  const stamped = candidates.map((path) => ({ path, fileStampedAtMs: sessionFileStampedAtMs(path) }));
  const insideWindow = (entry) =>
    isTime(entry.fileStampedAtMs) && entry.fileStampedAtMs >= fromMs && entry.fileStampedAtMs <= toMs;
  // A path the caller named is already the caller's claim about which file this is; it is not filtered by name, it is
  // asserted on its messages below, which is the stronger check and the one that names it when it fails.
  const considered = explicit ? stamped : stamped.filter(insideWindow);
  const excludedOutsideWindow = stamped.length - considered.length;

  if (considered.length === 0)
    return {
      bound: false,
      reason: "no_session_inside_run_window",
      considered,
      excludedOutsideWindow,
      inspected: stamped.map((entry) => ({ ...entry, bound: false, reason: "outside_run_window" })),
      superseded: [],
      chosen: null,
      window: null,
    };

  // The latest session the run opened that is not after its end; if every candidate is later than the end (a session
  // opened during teardown), the latest of them is the closest to this run.
  const atOrBeforeEnd = considered.filter((entry) => entry.fileStampedAtMs <= runWindow.endMs);
  const chosen = (atOrBeforeEnd.length > 0 ? atOrBeforeEnd : considered).reduce((latest, entry) =>
    entry.fileStampedAtMs > latest.fileStampedAtMs ? entry : latest,
  );
  const superseded = considered
    .filter((entry) => entry.path !== chosen.path)
    .map((entry) => ({ path: entry.path, fileStampedAtMs: entry.fileStampedAtMs }));
  const inspected = stamped.map((entry) => {
    if (entry.path === chosen.path) return { ...entry, bound: true, reason: null };
    if (considered.some((candidate) => candidate.path === entry.path))
      return { ...entry, bound: false, reason: "superseded_by_later_session" };
    return { ...entry, bound: false, reason: "outside_run_window" };
  });
  const result = { considered, excludedOutsideWindow, inspected, superseded, chosen: chosen.path };

  let rows;
  try {
    rows = readJsonl(chosen.path).rows;
  } catch {
    return { ...result, bound: false, reason: "session_not_readable", window: null };
  }
  const messages = sessionMessages(rows);
  const stamps = messages.map((message) => message.atMs).filter(isTime);
  if (stamps.length === 0) return { ...result, bound: false, reason: "session_has_no_message_timestamp", window: null };
  const window = { startMs: Math.min(...stamps), endMs: Math.max(...stamps) };
  const insideRunWindow =
    window.startMs <= runWindow.endMs + SESSION_BINDING_SLACK_MS &&
    window.endMs >= runWindow.startMs - SESSION_BINDING_SLACK_MS;
  if (!insideRunWindow) return { ...result, bound: false, reason: "chosen_session_outside_window", window };
  // Completeness, from the record's own shape: a bound file with no assistant message is a record the runtime has only
  // opened (or a turn that never ran), so there is nothing to measure and `not_established` is the honest answer - never
  // a smaller count. A record whose turns produced no TEXT is a different fact and is measured as silence.
  if (!messages.some((message) => message.role === "assistant"))
    return { ...result, bound: false, reason: "session_has_no_assistant_message", window };
  return { ...result, bound: true, reason: null, window, messages };
}

/** Where the session record may be, and which paths were searched - so a missing record names its search. */
function resolveSessionCandidates({ sessionPath, sessionDir, runDir }) {
  if (sessionPath !== null) return { searched: [sessionPath], candidates: [sessionPath], explicit: true };
  if (sessionDir !== null) {
    return {
      searched: [sessionDir],
      candidates: safeJsonlFiles(sessionDir).map((name) => join(sessionDir, name)),
      explicit: false,
    };
  }
  if (runDir === null) return { searched: [], candidates: [], explicit: false };
  const found = sessionCandidatesInRunDirectory(runDir);
  return { searched: [...new Set(found.map((path) => dirname(path)))], candidates: found, explicit: false };
}

/** The report for a run whose gate could not be established: every clause unexercised, carrying the reason. */
function unestablishedReport({ reason, measurements, establishment, nowMs }) {
  establishment.reason = reason;
  return Object.freeze({
    schema: SCHEMA,
    verdict: "not_established",
    clauses: CLAUSE_REQUIREMENTS.map((entry) =>
      clause(entry.id, "not_exercised", {}, [], `session_not_bound:${reason}`),
    ),
    measurements: Object.freeze(measurements),
    establishment: Object.freeze(establishment),
    unestablishedReason: reason,
    computedAtMs: nowMs,
  });
}

/**
 * The four 30-minute clauses, decided from the measurements. `not_exercised` is not a pass: only a `pass` in every
 * clause makes the run's gate pass, and every non-pass names the fact that stopped it.
 */
function assessClauses({
  lines,
  agencyInputs,
  withConsequence,
  pairs,
  rateWindowMinutes,
  speechSpanMinutes,
  refusals,
}) {
  const indexesWhere = (register) =>
    lines.map((line, index) => (line.register === register ? index : -1)).filter((index) => index >= 0);
  const playerOrDayIndexes = indexesWhere("player_or_day");
  const stepReportIndexes = indexesWhere("step_report");
  const obstacleIndexes = indexesWhere("obstacle");
  const clauses = [];

  // Clause 1: a companion that never says anything about the player or the day is narrating a task, not accompanying.
  if (lines.length === 0) {
    clauses.push(
      clause(
        "player_or_day_rate",
        "fail",
        { remarks: 0, rateWindowMinutes: 0, perFiveMinutes: 0 },
        [],
        "no_spoken_lines",
      ),
    );
  } else if (rateWindowMinutes > 0) {
    const perFiveMinutes = (playerOrDayIndexes.length / rateWindowMinutes) * PLAYER_OR_DAY_REMARK_PER_WALL_MINUTES;
    const pass = playerOrDayIndexes.length * PLAYER_OR_DAY_REMARK_PER_WALL_MINUTES >= rateWindowMinutes;
    clauses.push(
      clause(
        "player_or_day_rate",
        pass ? "pass" : "fail",
        {
          remarks: playerOrDayIndexes.length,
          rateWindowMinutes: Number(rateWindowMinutes.toFixed(2)),
          perFiveMinutes: Number(perFiveMinutes.toFixed(2)),
          speechSpanMinutes: Number(speechSpanMinutes.toFixed(2)),
        },
        quoteLines(lines, playerOrDayIndexes),
        pass ? null : "fewer_remarks_than_one_per_five_minutes",
      ),
    );
  } else {
    clauses.push(
      clause(
        "player_or_day_rate",
        "not_exercised",
        { remarks: playerOrDayIndexes.length, rateWindowMinutes: null, perFiveMinutes: null },
        quoteLines(lines, playerOrDayIndexes),
        "wall_window_unmeasured",
      ),
    );
  }

  // Clause 2: if nothing a player said changed anything, the player is watching a screensaver.
  if (agencyInputs.length === 0) {
    clauses.push(
      clause("player_agency", "not_exercised", { inputs: 0, withConsequence: 0 }, [], "no_player_input_found"),
    );
  } else {
    clauses.push(
      clause(
        "player_agency",
        withConsequence > 0 ? "pass" : "fail",
        { inputs: agencyInputs.length, withConsequence, noConsequence: agencyInputs.length - withConsequence },
        agencyInputs
          .filter((entry) => entry.state === "no_consequence")
          .slice(0, 5)
          .map((entry) => ({ atMs: entry.atMs, text: entry.text })),
        withConsequence > 0 ? null : "every_player_input_went_unanswered",
      ),
    );
  }

  // Clause 3: a setback narrated as a plan, not as a status code. The pair is the evidence, so both halves are quoted.
  const refusalsInTimeline = refusals;
  if (pairs.length > 0) {
    clauses.push(
      clause(
        "obstacle_with_plan",
        "pass",
        { obstacles: obstacleIndexes.length, pairs: pairs.length, refusalsInTimeline },
        pairs.slice(0, 3),
      ),
    );
  } else if (obstacleIndexes.length > 0) {
    clauses.push(
      clause(
        "obstacle_with_plan",
        "fail",
        { obstacles: obstacleIndexes.length, pairs: 0, refusalsInTimeline },
        quoteLines(lines, obstacleIndexes),
        "obstacle_narrated_without_a_next_plan",
      ),
    );
  } else if (refusalsInTimeline > 0) {
    clauses.push(
      clause(
        "obstacle_with_plan",
        "fail",
        { obstacles: 0, pairs: 0, refusalsInTimeline },
        [],
        "setback_happened_and_was_never_narrated",
      ),
    );
  } else {
    clauses.push(
      clause(
        "obstacle_with_plan",
        "not_exercised",
        { obstacles: 0, pairs: 0, refusalsInTimeline: 0 },
        [],
        "no_setback_in_this_run",
      ),
    );
  }

  // Clause 4: zero bare step reports. Zero reports out of zero lines is vacuous, so silence is `not_exercised`.
  if (lines.length === 0) {
    clauses.push(clause("no_step_reports", "not_exercised", { stepReports: 0, lines: 0 }, [], "no_spoken_lines"));
  } else {
    clauses.push(
      clause(
        "no_step_reports",
        stepReportIndexes.length === 0 ? "pass" : "fail",
        { stepReports: stepReportIndexes.length, lines: lines.length },
        quoteLines(lines, stepReportIndexes),
        stepReportIndexes.length === 0 ? null : "bare_step_reports",
      ),
    );
  }

  return clauses;
}

/**
 * Judge the run's interaction value.
 *
 * `input` accepts either a run directory (whose `timeline.jsonl` and captured `surface-sessions` tree are read) or
 * explicit paths, and the runner passes the facts it already holds (`timelineFacts`) plus the session record it bound
 * (`sessionPath`) so the published gate is computed from the same artifacts the result describes.
 */
export function assessInteractionValue(input = {}) {
  const {
    runDir = null,
    timelinePath = null,
    timelineFacts = null,
    sessionPath = null,
    sessionDir = null,
    sessionUnboundReason = null,
    runStartedAtMs = null,
    nowMs = Date.now(),
  } = input;

  const resolvedTimelinePath = timelinePath ?? (runDir === null ? null : join(runDir, "timeline.jsonl"));
  let timelineRows = [];
  let timelineUnreadable = 0;
  let timelineError = null;
  if (Array.isArray(timelineFacts)) {
    timelineRows = timelineFacts;
  } else if (resolvedTimelinePath !== null && existsSync(resolvedTimelinePath)) {
    try {
      const read = readJsonl(resolvedTimelinePath);
      timelineRows = read.rows;
      timelineUnreadable = read.unreadable;
    } catch (error) {
      timelineError = String(error?.message ?? error).slice(0, 120);
    }
  } else {
    timelineError = "timeline_not_found";
  }

  const timelineTimes = timelineRows.map((row) => row?.atMs).filter(isTime);
  const resultWindow = runResultWindowMs(runDir);
  const runStartMs = isTime(runStartedAtMs)
    ? runStartedAtMs
    : (resultWindow.startedAtMs ?? resolveRunStartMs({ timelineTimes, runDir }));
  const runEndMs = resultWindow.endedAtMs ?? resolveRunEndMs({ timelineTimes, timelinePath: resolvedTimelinePath });
  const runWindow = { startMs: runStartMs, endMs: runEndMs };

  const { searched, candidates, explicit } = resolveSessionCandidates({ sessionPath, sessionDir, runDir });

  const established = { bound: false, reason: null, path: null, searched, candidates: [], sessionWindow: null };
  const measurements = {
    lines: [],
    spokenLines: {
      count: 0,
      wallMinutes: null,
      rateWindowMinutes: null,
      gameSpanMinutes: null,
      spokenGameSpanMinutes: null,
      gameSpan: { from: null, to: null, samples: 0 },
      firstAtMs: null,
      lastAtMs: null,
    },
    register: emptyRegister(),
    playerAgency: { inputs: [], withConsequence: 0, noConsequence: 0 },
    longestSilence: { longest: null, measuredBetweenLines: false, headMs: null, tailMs: null },
    // Why this file and no other: the window the population was filtered by, how many were seen, how many the name
    // filter excluded, which one was bound and which files inside the window it superseded.
    sessionBinding: {
      runWindow: [runWindow.startMs, runWindow.endMs],
      considered: 0,
      excludedOutsideWindow: 0,
      chosen: null,
      superseded: [],
    },
    timeline: {
      path: resolvedTimelinePath,
      rows: timelineRows.length,
      unreadable: timelineUnreadable,
      error: timelineError,
      timedRows: timelineTimes.length,
      gameSamples: 0,
      refusals: 0,
    },
  };

  const unestablished = (reason) => unestablishedReport({ reason, measurements, establishment: established, nowMs });

  if (candidates.length === 0) return unestablished(sessionUnboundReason ?? "no_session_record_found");
  if (!(isTime(runWindow.startMs) && isTime(runWindow.endMs))) return unestablished("run_window_unmeasured");

  const binding = bindSessionToRun({ candidates, runWindow, explicit });
  measurements.sessionBinding = {
    runWindow: [runWindow.startMs, runWindow.endMs],
    considered: binding.considered.length,
    excludedOutsideWindow: binding.excludedOutsideWindow,
    chosen: binding.chosen,
    superseded: binding.superseded,
  };
  established.candidates = binding.inspected;
  if (binding.bound === false) return unestablished(binding.reason);
  established.bound = true;
  established.path = binding.chosen;
  established.sessionWindow = binding.window;
  const messages = binding.messages;

  const lines = collectSpokenLines(messages);
  const clock = gameClock(timelineRows);
  const receipts = timelineRows
    .filter((row) => row?.type === "execution_receipt")
    .map((row) => ({
      atMs: isTime(row.atMs) ? row.atMs : null,
      state: typeof row?.worldFactPayload?.state === "string" ? row.worldFactPayload.state : null,
      reasonCode: typeof row?.reasonCode === "string" ? row.reasonCode : null,
    }));
  const toolCalls = collectToolCalls(messages);
  const inputs = collectPlayerInputs(messages);

  const timed = lines.filter((line) => isTime(line.atMs));
  const speechSpanMinutes = timed.length >= 2 ? (timed[timed.length - 1].atMs - timed[0].atMs) / 60_000 : 0;
  // The denominator is the window the player actually sat through. A speech span shorter than the run must not shrink
  // it: two lines in the first minute of a thirty-minute run is one remark per thirty minutes, not one per minute.
  const runMinutes =
    isTime(runWindow.startMs) && isTime(runWindow.endMs) ? (runWindow.endMs - runWindow.startMs) / 60_000 : 0;
  const rateWindowMinutes = Math.max(speechSpanMinutes, runMinutes);

  const register = tallyRegisters(lines);

  const firstGame = timed.length === 0 ? null : clock.minutesAt(timed[0].atMs);
  const lastGame = timed.length === 0 ? null : clock.minutesAt(timed[timed.length - 1].atMs);

  measurements.lines = lines.map((line) => {
    const minutes = clock.minutesAt(line.atMs);
    return { ...line, gameMinutes: minutes === null ? null : Math.round(minutes) };
  });
  measurements.spokenLines = {
    count: lines.length,
    wallMinutes: Number(speechSpanMinutes.toFixed(2)),
    rateWindowMinutes: Number(rateWindowMinutes.toFixed(2)),
    // Both figures, because they answer different questions: the span of the run's own game clock, and how much of it
    // the spoken window covered (null when a line falls outside the sampled range - an uncovered span is not zero).
    gameSpanMinutes: clock.spanMinutes === null ? null : Math.round(clock.spanMinutes),
    spokenGameSpanMinutes: firstGame === null || lastGame === null ? null : Math.round(lastGame - firstGame),
    gameSpan: { from: clock.first, to: clock.last, samples: clock.sampleCount },
    firstAtMs: timed.length === 0 ? null : timed[0].atMs,
    lastAtMs: timed.length === 0 ? null : timed[timed.length - 1].atMs,
  };
  measurements.register = register;
  measurements.longestSilence = measureSilence({
    lines,
    runStartMs: runWindow.startMs,
    runEndMs: runWindow.endMs,
    clock,
    timelineRows,
  });
  measurements.timeline = {
    ...measurements.timeline,
    gameSamples: clock.sampleCount,
    refusals: receipts.filter((receipt) => SETBACK_STATES.has(receipt.state)).length,
  };

  const agencyInputs = inputs.map((input, index) => {
    const nextAtMs = inputs[index + 1]?.atMs;
    const windowEndMs = isTime(nextAtMs) ? nextAtMs : runWindow.endMs;
    return {
      ...input,
      windowEndMs,
      ...consequencesFor({ input, windowEndMs, toolCalls, receipts, lines }),
    };
  });
  const withConsequence = agencyInputs.filter((entry) => entry.state === "consequence_observed").length;
  measurements.playerAgency = {
    inputs: agencyInputs,
    withConsequence,
    noConsequence: agencyInputs.length - withConsequence,
  };

  const clauses = assessClauses({
    lines,
    agencyInputs,
    withConsequence,
    pairs: obstaclePlanPairs(lines),
    rateWindowMinutes,
    speechSpanMinutes,
    refusals: measurements.timeline.refusals,
  });

  const failed = clauses.some((entry) => entry.state === "fail");
  const allPassed = clauses.every((entry) => entry.state === "pass");
  return Object.freeze({
    schema: SCHEMA,
    verdict: failed ? "failed" : allPassed ? "passed" : "not_established",
    unestablished: failed ? [] : clauses.filter((entry) => entry.state === "not_exercised").map((entry) => entry.id),
    clauses,
    measurements: Object.freeze(measurements),
    establishment: Object.freeze(established),
    computedAtMs: nowMs,
  });
}

/** `1830` -> `30.5 game-hours`; a reader should not have to divide by sixty. */
function gameHours(minutes) {
  return `${(minutes / 60).toFixed(1)} game-h`;
}

function measuredFor(entry) {
  if (entry.id === "player_or_day_rate") {
    if (entry.observed.rateWindowMinutes === null || entry.observed.rateWindowMinutes === undefined)
      return `${entry.observed.remarks ?? 0} remarks, wall window unmeasured (need 1 per 5 min)`;
    return `${entry.observed.remarks ?? 0} remarks in ${entry.observed.rateWindowMinutes} min (need 1 per 5)`;
  }
  if (entry.id === "player_agency")
    return `${entry.observed.withConsequence ?? 0} of ${entry.observed.inputs ?? 0} inputs changed something`;
  if (entry.id === "obstacle_with_plan")
    return `${entry.observed.pairs ?? 0} obstacle+plan pair(s), ${entry.observed.obstacles ?? 0} obstacle line(s), ${entry.observed.refusalsInTimeline ?? 0} refusal(s)`;
  return `${entry.observed.stepReports ?? 0} step report(s) of ${entry.observed.lines ?? 0} line(s)`;
}

/** `2026-11-05T11:37:35.170Z` - a window boundary a reader can compare against a file name by eye. */
function isoTimestamp(atMs) {
  return isTime(atMs) ? new Date(atMs).toISOString() : "unmeasured";
}

/** The compact table the CLI prints and a reader skims before the JSON. */
export function formatInteractionValueTable(report) {
  const rows = [];
  const binding = report.measurements.sessionBinding;
  rows.push(
    `interaction value  verdict=${report.verdict.toUpperCase()}  session=${
      report.establishment.bound === true
        ? report.establishment.path
        : `unbound:${report.establishment.reason}${binding.chosen === null ? "" : ` (chosen ${binding.chosen})`}`
    }`,
  );
  rows.push(
    `session binding  window ${isoTimestamp(binding.runWindow[0])}..${isoTimestamp(binding.runWindow[1])} | ${
      binding.considered + binding.excludedOutsideWindow
    } file(s), ${binding.excludedOutsideWindow} excluded outside window, ${binding.considered} considered, chosen ${
      binding.chosen ?? "none"
    }${binding.superseded.length === 0 ? "" : ` (${binding.superseded.length} superseded)`}`,
  );
  const width = Math.max(...report.clauses.map((entry) => entry.id.length), "clause".length);
  rows.push(`${"clause".padEnd(width)}  ${"state".padEnd(13)}  measured`);
  for (const entry of report.clauses) {
    const reason = entry.reason === null ? "" : ` [${entry.reason}]`;
    rows.push(`${entry.id.padEnd(width)}  ${entry.state.padEnd(13)}  ${measuredFor(entry)}${reason}`);
  }
  const spoken = report.measurements.spokenLines;
  const silence = report.measurements.longestSilence.longest;
  const game =
    spoken.gameSpanMinutes === null
      ? "game span unmeasured"
      : `${gameHours(spoken.gameSpanMinutes)} (${spoken.gameSpan.from}->${spoken.gameSpan.to})`;
  const silentText =
    silence === null
      ? "no two lines to measure a silence between"
      : `${(silence.wallMs / 60_000).toFixed(1)} min${
          silence.gameMinutes === null ? "" : ` / ${gameHours(silence.gameMinutes)}`
        }, ${silence.world === null ? "world activity unmeasured" : `${silence.world.total} fact(s) during it`}`;
  rows.push(
    `lines ${spoken.count} | wall ${spoken.wallMinutes} min | ${game} | longest silence ${silentText} | register ${Object.entries(
      report.measurements.register.counts,
    )
      .map(([register, count]) => `${register}=${count}`)
      .join(" ")}`,
  );
  // The rate clause counts both kinds; a reader deciding whether the companion accompanied anyone needs them apart.
  const remarks = report.measurements.register.player_or_day;
  rows.push(
    `remarks ${remarks.addressed_to_player + remarks.day_only} player_or_day | ${
      remarks.addressed_to_player
    } addressed to the player | ${remarks.day_only} day only`,
  );
  return rows.join("\n");
}

/**
 * `node tools/live-run/interaction-value-gate.mjs --run <dir> [--session <path>] [--session-dir <dir>] [--json]`
 *
 * Exit codes: 0 `passed`, 1 `failed`, 2 `not_established`. A gate that cannot be established is not a success, so it
 * cannot share the success code.
 */
function main(argv) {
  const args = { run: null, session: null, sessionDir: null, timeline: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") args.json = true;
    else if (argument === "--run") args.run = argv[++index] ?? null;
    else if (argument === "--session") args.session = argv[++index] ?? null;
    else if (argument === "--session-dir") args.sessionDir = argv[++index] ?? null;
    else if (argument === "--timeline") args.timeline = argv[++index] ?? null;
  }
  const report = assessInteractionValue({
    runDir: args.run,
    sessionPath: args.session,
    sessionDir: args.sessionDir,
    timelinePath: args.timeline,
  });
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : formatInteractionValueTable(report)}\n`);
  if (report.verdict === "passed") return 0;
  return report.verdict === "failed" ? 1 : 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
