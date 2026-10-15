/**
 * Companion experience evidence: the CONTENT half of a Chat live run.
 *
 * The trace (`chat_run_audit/v1`) is content-free by construction and must stay
 * that way — its readers and the audit kernel's meta allow-list depend on it. A
 * reviewer asked to judge tone, immersion or register therefore has nothing to
 * quote, which is why every naturalness verdict so far read `inconclusive`.
 *
 * This module produces the missing half as a SEPARATE artifact: the redacted
 * exchange plus three deterministic gates evaluated at the moment the reply
 * lands. It never touches the trace, and it never invents a rule it cannot
 * point at in the product or in measured dialogue.
 *
 * The three gates, and where each rule comes from:
 *
 *  1. `first_person_anchoring` — narration about the companion in the third
 *     person is a persona break. The observed breach was
 *     `*琥珀已经蹲在门廊前的磨石旁了*` (the companion's own name as the subject
 *     of her own action beat) followed by `*她把锄头往腰边一靠*` (a pronoun that
 *     only resolves because the previous beat named her). The gate therefore
 *     fires on exactly two shapes: (a) a narration beat that names the companion
 *     while carrying no first-person marker, and (b) a narration beat that
 *     carries a third-person pronoun, no first-person marker, and is
 *     COREFFERENT with the companion. The reply IS the companion's turn, so
 *     coreference is a property of the whole reply rather than of one unbroken
 *     beat run: the companion is bound as the referent once she voices herself
 *     in the first person anywhere in the reply (her dialogue or a first-person
 *     beat) or is named in a beat, and dialogue between beats no longer unbinds
 *     her. That last clause is the live false negative this rule was widened
 *     for: real turns interleave narration and speech, so a pronoun beat after a
 *     quoted line used to lose its antecedent. Quoted speech is removed before
 *     the analysis, so her own name inside her own dialogue never fires; a beat
 *     with its own first-person marker — including one about another character,
 *     e.g. `*阿比盖尔…朝我们…*` — never fires; and a lone bound-less pronoun
 *     with no first-person voice anywhere in the reply is undecidable, so it
 *     stays silent.
 *
 *  2. `pacing` — a light greeting must not become an essay. The bound is
 *     MEASURED, not chosen: see `PACING_MEASUREMENTS` for the numbers this
 *     machine actually had on disk and for the arithmetic that turns them into
 *     the two ladder rungs.
 *
 *  3. `hygiene` — unrendered macros/placeholders and register breakage. The
 *     register vocabulary is not invented either: the reviewed card's own
 *     `system_prompt` rule 5 forbids `搭档` / `您` / `主人`, and the archived
 *     audit names `玩家` as an observed wall-break.
 *
 * Every verdict is `pass` | `fail` | `skipped`, and a `skipped` gate always
 * carries the reason it could not be evaluated: absence is never a pass.
 */

import { LIVE_RUN_TEXT_MAX_CHARS, redactLiveRunSecrets } from "./capture-text.mjs";

export const COMPANION_EXPERIENCE_SCHEMA = "companion_experience/v1";

/**
 * The measurements the pacing ladder is derived from. Kept as data so the test
 * suite can assert the ladder still follows from them: a threshold that drifts
 * away from its measurement is exactly the invented round number this must not
 * become.
 *
 * Sources (2026-10-15, this machine):
 * - `liveGreetingReplies` — every distinct committed companion reply that exists
 *   in a Chat authority `tavern.sqlite` on disk, plus the one the archived
 *   frontend audit quotes from `chat-naturalness-run2-transcript.json`. There is
 *   no task-class reply on disk: every real run so far asked a greeting.
 * - `authoredCompanionTurns` — the reviewed card's own `mes_example` companion
 *   halves, which are the only on-disk statement of how long a full scene turn is
 *   allowed to be.
 * - `captureEntryBound` — the live-run capture policy's per-entry text bound,
 *   i.e. the machine's own existing answer to "how long is too long to read as
 *   an utterance".
 */
export const PACING_MEASUREMENTS = Object.freeze({
  liveGreetingReplies: Object.freeze([19, 20, 20, 33]),
  liveGreetingSentences: Object.freeze([1, 2, 3, 3]),
  authoredCompanionTurns: Object.freeze([238, 280, 304]),
  authoredCompanionSentences: Object.freeze([8, 11, 14]),
  authoredOpenings: Object.freeze([341, 432, 482]),
  captureEntryBound: LIVE_RUN_TEXT_MAX_CHARS,
});

/**
 * The ladder. `greetingChars` is 3x the longest observed live greeting (33 -> 99,
 * rounded up to 100, which is still 0.42x the shortest authored scene turn, so no
 * scene-length reply can pass as a greeting); `greetingSentences` is the observed
 * maximum (3) plus one. `taskChars` is the capture policy's own bound (600), 1.97x
 * the longest authored companion turn (304) — the exact failure the owner named,
 * a 500-word screenplay dump, is an order of magnitude past it.
 */
export const PACING_LADDER = Object.freeze({
  greeting: Object.freeze({ maxChars: 100, maxSentences: 4 }),
  task: Object.freeze({ maxChars: 600, maxSentences: 20 }),
});

/**
 * Unrendered templating and raw transport artifacts. A companion that ships
 * `{{user}}` to a player has leaked the authoring layer.
 */
const PLACEHOLDER_PATTERNS = Object.freeze([
  Object.freeze({ rule: "macro_residue", pattern: /\{\{[^{}\n]{0,80}\}\}/g }),
  Object.freeze({ rule: "reasoning_leak", pattern: /<\/?thinking>/gi }),
  Object.freeze({ rule: "transport_leak", pattern: /<\|[^|\n]{0,40}\|>/g }),
  Object.freeze({ rule: "harness_marker_leak", pattern: /\[DEBUG-[A-Za-z0-9_-]{1,40}\]/g }),
  Object.freeze({ rule: "host_marker_leak", pattern: /<\/?gamebuddy-[a-z-]{1,40}>/gi }),
  Object.freeze({ rule: "code_fence_leak", pattern: /```/g }),
]);

/**
 * Register breakage. `card_forbidden` is quoted from the reviewed card's own
 * `system_prompt` rule 5 (`绝不使用"搭档"、"您"、"主人"等生硬客套称呼`);
 * `wall_break` is the archived audit's `玩家` plus the neighbouring vocabulary a
 * model reaches for when it narrates itself instead of living in the scene.
 */
export const REGISTER_TERMS = Object.freeze([
  Object.freeze({ term: "搭档", source: "card_forbidden" }),
  Object.freeze({ term: "您", source: "card_forbidden" }),
  Object.freeze({ term: "主人", source: "card_forbidden" }),
  Object.freeze({ term: "玩家", source: "wall_break" }),
  Object.freeze({ term: "用户", source: "wall_break" }),
  Object.freeze({ term: "人工智能", source: "wall_break" }),
  Object.freeze({ term: "语言模型", source: "wall_break" }),
  Object.freeze({ term: "系统提示", source: "wall_break" }),
  Object.freeze({ term: "角色扮演", source: "wall_break" }),
  Object.freeze({ term: "assistant", source: "wall_break" }),
  Object.freeze({ term: "AI", source: "wall_break" }),
]);

/** Reply classes the ladder distinguishes. */
export const REPLY_SCENARIOS = Object.freeze(["greeting", "task"]);

const FIRST_PERSON = /我|俺|咱|\bI\b|\bme\b|\bmy\b/;
const THIRD_PERSON = /她|他|它|她们|他们|它们|\bshe\b|\bhe\b|\bthey\b|\bher\b|\bhis\b/i;

/**
 * Everything the analysis treats as SPEECH rather than narration. Straight double
 * quotes are included: in companion prose they delimit dialogue, not inches.
 */
const QUOTED_SPANS = /“[^”\n]{0,400}”|「[^」\n]{0,400}」|『[^』\n]{0,400}』|"[^"\n]{0,400}"/g;

/** Narration beats: markdown `*beat*` and the full-width `（beat）` a real run used. */
const BEAT_SPANS = /(?<!\*)\*(?!\*)([^*\n]{1,400})\*(?!\*)|（([^）\n]{1,400})）/g;

const GREETING_PROMPTS =
  /^(你好|您好|嗨|哈喽|哈啰|在吗|早|早上好|早安|晚上好|下午好|晚安|hi|hey|hello|yo|good morning|good evening)[!！。.~～\s]*$/i;

/** The content-free default prompt cannot be classified by content, so it is a greeting probe. */
const DEFAULT_PROMPT_SENTINEL = "Please respond naturally.";

function codePointLength(value) {
  return typeof value === "string" ? [...value].length : 0;
}

function countSentences(value) {
  return typeof value === "string" ? (value.match(/[。！？!?…]+/g) ?? []).length : 0;
}

/**
 * Which rung of the ladder a player turn belongs to. Deterministic and stated:
 * a short greeting-shaped line is a greeting, everything else — including the
 * content-free default prompt — is a task, because it asks the companion to
 * produce something rather than to answer a hello.
 */
export function classifyPlayerTurn(playerText) {
  const text = typeof playerText === "string" ? playerText.trim() : "";
  if (text.length === 0 || text === DEFAULT_PROMPT_SENTINEL) return "greeting";
  // A greeting is a single short line: anything with a newline, or longer than
  // twice the longest observed greeting, is carrying a request.
  if (text.includes("\n") || codePointLength(text) > PACING_LADDER.greeting.maxChars) return "task";
  return GREETING_PROMPTS.test(text) ? "greeting" : "task";
}

/**
 * Quoted spans with their offsets, so a beat can be told apart from dialogue.
 */
function quotedRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(QUOTED_SPANS)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Narration beats in order, each with the span it occupies. A `*…*` or `（…）`
 * that falls inside a quoted span is dialogue punctuation, not narration.
 */
function narrationBeats(text) {
  const quoted = quotedRanges(text);
  const beats = [];
  for (const match of text.matchAll(BEAT_SPANS)) {
    if (inRanges(match.index, quoted)) continue;
    const body = match[1] ?? match[2] ?? "";
    if (body.trim().length === 0) continue;
    beats.push({ start: match.index, end: match.index + match[0].length, body });
  }
  return beats;
}

/**
 * First-person anchoring over one companion reply.
 *
 * Returns `pass`, or `fail` with every offending beat quoted (the reviewer wants
 * to jump straight to the text, not to a rule name), or `skipped` when the run
 * mounted no companion identity — without a name there is nothing to anchor
 * against, and a silent `pass` would be a fabricated verdict.
 */
export function evaluateFirstPersonAnchoring({ text, companionNames }) {
  const names = [
    ...new Set(
      (Array.isArray(companionNames) ? companionNames : []).filter((n) => typeof n === "string" && n.trim().length > 0),
    ),
  ];
  if (names.length === 0) {
    return Object.freeze({
      verdict: "skipped",
      rule: "companion_identity_name_unavailable",
      detail:
        "the run mounted no companion display name, so third-person narration about the companion is not decidable",
      matched: Object.freeze([]),
    });
  }
  const source = typeof text === "string" ? text : "";
  const beats = narrationBeats(source);
  const matched = [];
  // The reply is the companion's own turn. Once she voices herself in the first
  // person anywhere — her dialogue or a first-person beat — every third-person
  // narration beat in the same turn is coreferent with her, and speech between
  // beats must not unbind her.
  let bound = FIRST_PERSON.test(source);
  for (const beat of beats) {
    const namesCompanion = names.some((name) => beat.body.includes(name));
    const firstPerson = FIRST_PERSON.test(beat.body);
    const thirdPerson = THIRD_PERSON.test(beat.body);
    if (namesCompanion && !firstPerson) {
      matched.push({ rule: "companion_named_in_narration", text: beat.body, offset: beat.start });
      bound = true;
      continue;
    }
    if (!(namesCompanion || firstPerson) && thirdPerson && bound) {
      matched.push({ rule: "coreferent_third_person_narration", text: beat.body, offset: beat.start });
    }
  }
  return Object.freeze({
    verdict: matched.length === 0 ? "pass" : "fail",
    rule: "third_person_narration_about_the_companion",
    detail:
      matched.length === 0
        ? `${beats.length} narration beat(s) checked against ${names.join(", ")}; none narrated the companion in the third person`
        : `${matched.length} narration beat(s) narrated the companion in the third person; the companion must speak and move as "I"`,
    companionNames: Object.freeze(names),
    beatsChecked: beats.length,
    matched: Object.freeze(
      matched.map((entry) => Object.freeze({ ...entry, text: redactLiveRunSecrets(entry.text, { maxChars: 200 }) })),
    ),
  });
}

/**
 * Pacing over one companion reply, against the rung its player turn selected.
 * Both measures are reported so a fail shows how far past the bound the reply
 * went rather than only that it did.
 */
export function evaluatePacing({ text, scenario }) {
  const ladder = PACING_LADDER[scenario];
  if (ladder === undefined) {
    return Object.freeze({
      verdict: "skipped",
      rule: "scenario_unknown",
      detail: `no ladder rung for scenario ${JSON.stringify(scenario)}`,
      matched: Object.freeze([]),
    });
  }
  const source = typeof text === "string" ? text : "";
  const chars = codePointLength(source);
  const sentences = countSentences(source);
  const overChars = chars > ladder.maxChars;
  const overSentences = sentences > ladder.maxSentences;
  const matched = [];
  if (overChars)
    matched.push({
      rule: "reply_longer_than_pacing_bound",
      chars,
      maxChars: ladder.maxChars,
      text: redactLiveRunSecrets(source, { maxChars: 200 }),
    });
  if (overSentences)
    matched.push({
      rule: "reply_has_more_sentences_than_pacing_bound",
      sentences,
      maxSentences: ladder.maxSentences,
      text: redactLiveRunSecrets(source, { maxChars: 200 }),
    });
  return Object.freeze({
    verdict: matched.length === 0 ? "pass" : "fail",
    rule: `pacing_ladder_${scenario}`,
    scenario,
    bound: Object.freeze({ ...ladder }),
    measured: Object.freeze({ chars, sentences }),
    detail:
      matched.length === 0
        ? `${scenario} reply measured ${chars} chars / ${sentences} sentences, within the ${ladder.maxChars} / ${ladder.maxSentences} bound`
        : `${scenario} reply measured ${chars} chars / ${sentences} sentences, past the ${ladder.maxChars} / ${ladder.maxSentences} bound`,
    matched: Object.freeze(matched),
  });
}

/**
 * Macro/placeholder residue and register hygiene over one companion reply.
 */
export function evaluateHygiene({ text }) {
  const source = typeof text === "string" ? text : "";
  const matched = [];
  for (const { rule, pattern } of PLACEHOLDER_PATTERNS) {
    for (const hit of source.matchAll(pattern)) {
      matched.push({ rule, text: redactLiveRunSecrets(hit[0], { maxChars: 120 }) });
    }
  }
  for (const { term, source: origin } of REGISTER_TERMS) {
    if (source.includes(term)) matched.push({ rule: `register_${origin}`, text: term });
  }
  return Object.freeze({
    verdict: matched.length === 0 ? "pass" : "fail",
    rule: "no_template_residue_and_no_register_break",
    detail:
      matched.length === 0
        ? "no unrendered macro, transport marker or wall-breaking register term found"
        : `${matched.length} hygiene finding(s): ${[...new Set(matched.map((entry) => entry.rule))].join(", ")}`,
    matched: Object.freeze(matched),
  });
}

/**
 * All three gates for one landed reply.
 */
export function evaluateCompanionReply({ playerText, companionText, companionNames, scenario }) {
  const resolvedScenario = REPLY_SCENARIOS.includes(scenario) ? scenario : classifyPlayerTurn(playerText);
  const gates = Object.freeze({
    first_person_anchoring: evaluateFirstPersonAnchoring({ text: companionText, companionNames }),
    pacing: evaluatePacing({ text: companionText, scenario: resolvedScenario }),
    hygiene: evaluateHygiene({ text: companionText }),
  });
  const verdicts = Object.values(gates).map((gate) => gate.verdict);
  return Object.freeze({
    scenario: resolvedScenario,
    verdict: verdicts.includes("fail") ? "fail" : verdicts.includes("skipped") ? "skipped" : "pass",
    gates,
  });
}

function bytesOf(value) {
  return Buffer.byteLength(typeof value === "string" ? value : "", "utf8");
}

/**
 * The whole companion-experience sidecar for one run.
 *
 * Text is `redactLiveRunSecrets`-ed (credentials removed, length bounded) but
 * deliberately NOT macro-redacted: the macro IS the evidence for the hygiene
 * gate, and replacing it with `<MACRO>` here would delete the finding the gate
 * just made.
 */
export function buildCompanionExperience({
  runId,
  artifact,
  persona,
  replies,
  browser,
  skipped = [],
  transcriptSideFilePath,
  captureDir,
}) {
  const safeReplies = (Array.isArray(replies) ? replies : []).map((reply) => {
    const companionText = typeof reply?.companionText === "string" ? reply.companionText : "";
    const playerText = typeof reply?.playerText === "string" ? reply.playerText : "";
    const evaluation =
      reply?.evaluation ??
      evaluateCompanionReply({
        playerText,
        companionText,
        companionNames: persona?.name === undefined ? [] : [persona.name],
      });
    return Object.freeze({
      turnIndex: reply?.turnIndex ?? null,
      scenario: evaluation.scenario,
      verdict: evaluation.verdict,
      player: Object.freeze({
        text: redactLiveRunSecrets(playerText, { maxChars: LIVE_RUN_TEXT_MAX_CHARS }),
        bytes: bytesOf(playerText),
      }),
      companion: Object.freeze({
        text: redactLiveRunSecrets(companionText, { maxChars: LIVE_RUN_TEXT_MAX_CHARS }),
        bytes: bytesOf(companionText),
        codePoints: codePointLength(companionText),
        sentences: countSentences(companionText),
        beats: Object.freeze(
          narrationBeats(companionText).map((beat) => redactLiveRunSecrets(beat.body, { maxChars: 200 })),
        ),
      }),
      gates: evaluation.gates,
    });
  });
  const failed = safeReplies.filter((reply) => reply.verdict === "fail").length;
  const skippedGates = safeReplies.filter((reply) => reply.verdict === "skipped").length;
  return Object.freeze({
    schema: COMPANION_EXPERIENCE_SCHEMA,
    runId,
    artifact:
      artifact === undefined
        ? null
        : Object.freeze({ generation: artifact.generation, inventoryDigest: artifact.inventoryDigest }),
    captureDir: captureDir ?? null,
    transcriptSideFilePath: transcriptSideFilePath ?? null,
    persona: persona ?? null,
    pacingLadder: PACING_LADDER,
    pacingMeasurements: PACING_MEASUREMENTS,
    replies: Object.freeze(safeReplies),
    summary: Object.freeze({
      replies: safeReplies.length,
      passed: safeReplies.length - failed - skippedGates,
      failed,
      skipped: skippedGates,
      failedTurnIndexes: Object.freeze(
        safeReplies.filter((reply) => reply.verdict === "fail").map((reply) => reply.turnIndex),
      ),
    }),
    browser: browser ?? null,
    skipped: Object.freeze([...skipped]),
    redaction: "credentials replaced by <REDACTED>; no prompt internals, no system prompt, no M0/M1 text",
  });
}
