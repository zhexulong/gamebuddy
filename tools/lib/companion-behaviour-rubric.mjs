/**
 * Companion behaviour rubric for a live run — the instrument a reviewer holds a
 * companion's spoken turns to.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A NEW VOCABULARY
 * ---------------------------------------------------
 * The project already owns three pieces that answer "how should the companion
 * behave" and "what did it actually do":
 *
 *   * the character card and its prompt floor — `host/src/identity-profile.ts`
 *     (`renderIdentityProfile`, `buildCompanionSystemPrompt`, and the
 *     Game-surface conduct at `:383-390`);
 *   * two hard-signal sets — `tools/lib/companion-interaction-gate.mjs`
 *     (`summary_too_long` / `step_checklist` / `machine_token_leak` /
 *     `unobserved_event`) and `tools/lib/stardew-companion-presence-projection.mjs`
 *     (`claimsMade` / `claimsVisible` / `claimsReceipted` plus
 *     `claim_not_visible` / `claim_unreceipted`);
 *   * the dimension names in
 *     `design/architecture/stardew-companion-presence-audit-dimensions.md`.
 *
 * What was missing is the thing `design/architecture/historian-prompt-rubric.md`
 * supplied for the memory surface: a stated list of obligations, each classified
 * by whether a machine can decide it, so that a live run reports "obligations
 * 1–7 green, 8–10 unmeasured" instead of the unfalsifiable "the behaviour looked
 * good". This module is that list for the companion's spoken behaviour, and it
 * adds only the checks the two existing sets do not make:
 *
 *   * `internal_self_reference` — the companion explaining itself, its
 *     instructions, a model, or a system. The prompt floor forbids it
 *     (`identity-profile.ts:290`), and nothing checked it before.
 *   * `ooc_meta_reference` — breaking the fiction: calling this a game, a
 *     roleplay, or addressing the player as a user of software. The floor
 *     forbids it (`identity-profile.ts:288`, `:289`).
 *   * `text_stage_direction` — a gesture written as a parenthesised stage
 *     direction where the Game surface has a native action channel
 *     (`identity-profile.ts:388`). Recorded as a Preference, not a failure:
 *     `（轻声）` is a legitimate voice tag the voice layer performs.
 *
 * Everything else is DELEGATED, never restated: a change to the gate or to the
 * presence projection must move this rubric with it, because this module calls
 * them rather than copying their patterns.
 *
 * CLAIM BOUNDARY (inherited, and stated so it is not over-read)
 * ------------------------------------------------------------
 * The delegated detectors are high-precision and LOW-RECALL, and they say so
 * themselves (`companion-interaction-gate.mjs:27-32`). The two checks this
 * module adds are the same kind: a closed pattern set over phrasing. A green
 * verdict means "no KNOWN-class breach in the turns this run recorded" — never
 * "the companion stayed in character". Character-card conformance itself is an
 * Unjudged obligation below, named so it cannot be claimed.
 */

import { assessCompanionInteraction } from "./companion-interaction-gate.mjs";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export class CompanionBehaviourRubricError extends Error {
  constructor(code) {
    super(code);
    this.name = "CompanionBehaviourRubricError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new CompanionBehaviourRubricError(code);
};

/**
 * The obligations, in the `historian-prompt-rubric.md` shape: every entry names
 * where the obligation comes from, and whether a machine decides it.
 *
 * `source` is the module that decides an Invariant or a Preference, so a reader
 * can find the real pattern instead of trusting this table.
 */
export const COMPANION_BEHAVIOUR_OBLIGATIONS = Object.freeze([
  Object.freeze({
    id: "no_machine_token_leak",
    class: "Invariant",
    statement:
      "Spoken text never reads machine identifiers aloud (wire action ids, reason codes, evidence keys, enum values).",
    provenance: "identity-profile.ts:387 (Game conduct: never in the game's internal language)",
    source: "companion-interaction-gate.mjs:machine_token_leak",
  }),
  Object.freeze({
    id: "no_step_recital",
    class: "Invariant",
    statement: "Spoken text talks to the player, never recites the companion's own steps.",
    provenance: "identity-profile.ts:385; companion-interaction-gate.mjs:8-10 (RP convention)",
    source: "companion-interaction-gate.mjs:step_checklist",
  }),
  Object.freeze({
    id: "no_unobserved_world_reaction",
    class: "Invariant",
    statement: "Spoken text asserts no world reaction the receipts do not prove.",
    provenance: "identity-profile.ts:386; measured run narrated an NPC reaction with showed_response=false",
    source: "companion-interaction-gate.mjs:unobserved_event",
  }),
  Object.freeze({
    id: "spoken_within_ceiling",
    class: "Invariant",
    statement: "One spoken turn stays within the 120-character ceiling.",
    provenance: "companion-interaction-gate.mjs:13",
    source: "companion-interaction-gate.mjs:summary_too_long",
  }),
  Object.freeze({
    id: "no_internal_self_reference",
    class: "Invariant",
    statement: "The companion never explains itself, its instructions, a model, or a system.",
    provenance: "identity-profile.ts:290 (Never mention prompts, instructions, models, or systems)",
    source: "companion-behaviour-rubric.mjs:internal_self_reference",
  }),
  Object.freeze({
    id: "no_ooc_meta_reference",
    class: "Invariant",
    statement: "The companion never breaks the fiction (no game/roleplay framing, no customer-service voice).",
    provenance: "identity-profile.ts:288 (do not remind the player this is a game), :289 (not a helper)",
    source: "companion-behaviour-rubric.mjs:ooc_meta_reference",
  }),
  Object.freeze({
    id: "claim_fulfillable",
    class: "Unjudged",
    statement:
      "Every first-person action commitment resolves inside the visible capability face and is receipted in the same turn.",
    provenance: "stardew-companion-presence-audit-dimensions.md:39-43 (§3 承诺可兑现性)",
    source: "stardew-companion-presence-projection.mjs:buildPresenceProjection",
    // Unjudged until a runner passes the projection: the loop has no caller for it, and an Invariant that can never be
    // decided is worse than an honest Unjudged (an audit caught it advertised as Invariant while permanently unmeasured).
  }),
  Object.freeze({
    id: "addresses_the_player",
    class: "Preference",
    statement: "A turn usually addresses the player or invites them, rather than closing on itself.",
    provenance: "identity-profile.ts:389 (ask or invite when it fits)",
    source: "companion-interaction-gate.mjs:hasPlayerAddress",
  }),
  Object.freeze({
    id: "not_a_narrator",
    class: "Preference",
    statement: "The companion does not spend its turns announcing what it is about to look at.",
    provenance:
      "a real session: 2 of 4 turns were `I'll take a look around first.` / `Let me step outside and see the farm.`",
    evidence: "intent-announcement pattern over the run's turns",
  }),
  Object.freeze({
    id: "native_stage_direction",
    class: "Preference",
    statement:
      "A gesture goes through the native action channel where one exists, not a parenthesised stage direction.",
    provenance: "identity-profile.ts:388 (body language goes through stardew_express_emote / stardew_face_direction)",
    source: "companion-behaviour-rubric.mjs:text_stage_direction",
  }),
  Object.freeze({
    id: "observation_continuity",
    class: "Performance",
    statement:
      "The run observed throughout: the session does not end with a stretch in which nothing could be observed.",
    provenance: "insight#4271 (a 600 s session went 216 s unobserved and still reported a pass)",
    evidence: "runReport.unobservedTailMs",
  }),
  Object.freeze({
    id: "trace_snapshot_share",
    class: "Performance",
    statement: "Snapshot frames do not dominate the trace; the payload a reviewer pays for stays proportionate.",
    provenance: "audit of run loop-1792028924954: snapshots 2.35 MB of 2.43 MB (96.7%), ~12.4 KB per cycle",
    evidence: "runReport.traceBytes.snapshot / runReport.traceBytes.total",
  }),
  Object.freeze({
    id: "trace_duplicate_payload_bounded",
    class: "Performance",
    statement:
      "The trace does not spend most of its bytes repeating one record; a large SINGLE record is a different fact.",
    provenance: "the same run: 107 identical 84 B observation-failure records",
    evidence: "runReport.traceBytes.largestRepeatedRecordBytes / runReport.traceBytes.total",
  }),
  Object.freeze({
    id: "player_language_consistency",
    class: "Invariant",
    statement: "The companion speaks the player's language, as the character card requires.",
    provenance:
      "the card's own system prompt: 'Consistently converse in the player's language' (read from a live session transcript). Two of four turns in a real session were English for a Chinese-speaking player.",
    evidence: "turn text vs the run's declared locale (default zh-CN)",
  }),
  Object.freeze({
    id: "proactive_authenticity",
    class: "Unjudged",
    statement:
      "Whether a self-initiated turn reads as the companion's own impulse rather than an instruction to greet.",
    provenance: "stardew-companion-presence-audit-dimensions.md:189-198 (§7 主动交流真实性: 被逼 vs 自主 未定义)",
    source: null,
  }),
  Object.freeze({
    id: "character_card_conformance",
    class: "Unjudged",
    statement:
      "Whether the voice matches the character card (persona.core / interactionStyle / expressionStyle, examples).",
    provenance: "host/src/identity-profile.ts:29-62 (IdentityProfile), :146-172 (renderIdentityProfile)",
    source: null,
  }),
]);

/**
 * The companion explaining its own machinery. Phrase-level (never a bare `系统`,
 * which occurs in ordinary sentences such as 农场系统), so precision stays high;
 * recall is low by construction and the class is documented as such.
 */
const INTERNAL_SELF_REFERENCE = [
  "系统提示",
  "系统指令",
  "提示词",
  "我的指令",
  "我的设定",
  "我的提示",
  "底层模型",
  "语言模型",
  "大模型",
  "人工智能",
  "算法",
  "workflow",
  "system prompt",
  "my instructions",
  "my prompt",
  "language model",
  "as an ai",
  "i am an ai",
  "programmed to",
];

/** Breaking the fiction. `NPC` is internal vocabulary; the rest is meta framing. */
const OOC_META_REFERENCE = [
  "这是一个游戏",
  "这只是一个游戏",
  "这是个游戏",
  "这只是个游戏",
  "游戏里",
  "角色扮演",
  "我在扮演",
  "扮演的",
  "游戏角色",
  "玩家",
  "npc",
  "game character",
  "roleplay",
  "role-playing",
  "as a game",
  "in this game",
];

/**
 * A physical gesture described inside parentheses, where the Game surface has an action.
 *
 * The list is deliberately PHYSICAL so that a tone tag stays legitimate: （轻声）（开心）（有点得意） are delivery
 * instructions the voice layer performs, while （甩了甩发酸的手腕）（抬手遮了下日头） are body actions the card tells
 * the companion to perform through `stardew_express_emote`. The last two were missing from the first version and a
 * real session passed the obligation while containing both.
 */
const BODY_ACTION =
  /(点头|摇头|挥手|招手|抬手|鞠躬|耸肩|叹气|皱眉|微笑|笑|拍|拥抱|眨眼|叉腰|摊手|挠|抓|握|竖起|伸手|甩|揉|摸|擦|捶|扶|拽|推|踢|转身|低头|抬头|转头|侧头|瞪|眯|蹲下|站起|wave|nod|shrug|sigh|smile|bow|hug|reach|rub|wipe)/i;

/**
 * One spoken turn, measured. Returns the delegated gate outcome verbatim plus the
 * two checks this module owns, so a caller never has to guess which detector
 * produced which signal.
 */
export function assessCompanionUtterance(text, { observedEvents = [] } = {}) {
  if (!Array.isArray(observedEvents)) fail("companion_behaviour_observed_events_invalid");
  const trimmed = String(text ?? "").trim();
  const gate = assessCompanionInteraction(trimmed, observedEvents);
  return Object.freeze({
    text: trimmed,
    gate,
    internalSelfReference: matchesAny(trimmed, INTERNAL_SELF_REFERENCE),
    oocMetaReference: matchesAny(trimmed, OOC_META_REFERENCE),
    textStageDirection: matchesTextStageDirection(trimmed),
  });
}

function matchesAny(text, phrases) {
  const lower = text.toLowerCase();
  return Object.freeze(phrases.filter((phrase) => lower.includes(phrase.toLowerCase())));
}

function matchesTextStageDirection(text) {
  // The voice tag `（轻声）` is a delivery instruction the voice layer performs,
  // so only a parenthesised BODY ACTION counts here; a parenthesised tone does not.
  const parenthesised = text.match(/[（(][^）)]{0,60}[）)]/g) ?? [];
  return Object.freeze(parenthesised.filter((fragment) => BODY_ACTION.test(fragment)));
}

/**
 * The rubric verdict for one run's recorded turns.
 *
 * `turns` carries one entry per spoken turn the run actually presented:
 *   `{ turnId, text, observedEvents? }` — `observedEvents` is the receipt-proved
 *   event kinds for that turn (`["npc_dialogue", ...]`), the same input the gate
 *   takes.
 *
 * `presence` is the optional `buildPresenceProjection` output. It is passed in
 * rather than computed here so the projection keeps its single owner; when it is
 * absent the claim obligation reports `unmeasured`, never green.
 *
 * Every obligation is reported. An obligation whose detector could not run is
 * `unmeasured` — the historian rubric's rule that unjudged things are NAMED, not
 * approximated (`historian-prompt-rubric.md:46-54`).
 */
export function assessCompanionBehaviourRubric({ turns, presence = null, runReport = null, locale = "zh-CN" } = {}) {
  if (!Array.isArray(turns)) fail("companion_behaviour_turns_invalid");
  if (presence !== null && (typeof presence !== "object" || Array.isArray(presence)))
    fail("companion_behaviour_presence_invalid");
  // `runReport` carries what the RUN measured about itself (observation continuity, trace byte shares). It is a
  // separate evidence source from speech on purpose: a performance obligation cannot be decided by reading turns.
  if (runReport !== null && (typeof runReport !== "object" || Array.isArray(runReport)))
    fail("companion_behaviour_run_report_invalid");

  const utterances = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) fail("companion_behaviour_turn_invalid");
    if (typeof turn.turnId !== "string" || !IDENTIFIER.test(turn.turnId)) fail("companion_behaviour_turn_id_invalid");
    if (typeof turn.text !== "string") fail("companion_behaviour_turn_text_invalid");
    utterances.push({
      turnId: turn.turnId,
      ...assessCompanionUtterance(turn.text, { observedEvents: turn.observedEvents ?? [] }),
    });
  }

  const findings = [];
  for (const utterance of utterances) {
    for (const reason of utterance.gate.reasons) {
      if (reason === "empty") continue;
      findings.push({ turnId: utterance.turnId, obligation: reasonToObligation(reason), detail: reason });
    }
    if (utterance.internalSelfReference.length > 0)
      findings.push({
        turnId: utterance.turnId,
        obligation: "no_internal_self_reference",
        detail: utterance.internalSelfReference.join(","),
      });
    if (utterance.oocMetaReference.length > 0)
      findings.push({
        turnId: utterance.turnId,
        obligation: "no_ooc_meta_reference",
        detail: utterance.oocMetaReference.join(","),
      });
    // A parenthesised gesture is a finding, and it is collected HERE so the
    // obligation verdict below counts it: an earlier version appended it after the
    // counts were taken, and the Preference read green on a turn that broke it.
    if (utterance.textStageDirection.length > 0)
      findings.push({
        turnId: utterance.turnId,
        obligation: "native_stage_direction",
        detail: utterance.textStageDirection.join(","),
      });
  }

  // The presence projection owns its own findings; they are copied in with their
  // obligation id so one rubric covers both sources without a second vocabulary.
  const presenceFindings = [];
  if (presence !== null) {
    const present = presence.findings;
    if (!Array.isArray(present)) fail("companion_behaviour_presence_findings_invalid");
    for (const finding of present) {
      if (!finding || typeof finding.turnId !== "string" || typeof finding.finding !== "string")
        fail("companion_behaviour_presence_finding_invalid");
      presenceFindings.push({ turnId: finding.turnId, obligation: "claim_fulfillable", detail: finding.finding });
    }
  }

  const allFindings = [...findings, ...presenceFindings];
  const spokenTurns = utterances.filter((utterance) => utterance.text.length > 0);
  const addressed = spokenTurns.filter((utterance) => utterance.gate.metrics.hasPlayerAddress === true).length;
  const stageDirections = utterances.filter((utterance) => utterance.textStageDirection.length > 0);
  // An intent announcement is a line whose whole content is "I am about to do X": the reviewer of a real session found
  // half its turns were exactly that, and the recital-template detector cannot see them.
  const INTENT_ANNOUNCEMENT = /^\s*(i'?ll|i will|let me|i'?m going to|我先|我去|我这就|我来)/iu;
  const announcements = spokenTurns.filter((utterance) => INTENT_ANNOUNCEMENT.test(utterance.text));

  // Language: measured as the ABSENCE of the expected script rather than as a ratio, so a turn like
  // "南边那一片割了十来丛草" with a few English tool names is not called a breach while "I'll take a look around" is.
  // The locale is the run's declared one (the loop runs zh-CN by default). The findings must land in `allFindings`,
  // which is what the obligation verdicts read -- pushing them into the earlier array after it was spread produced a
  // green verdict for turns with no CJK at all.
  const expectedCjk = String(locale ?? "zh-CN")
    .toLowerCase()
    .startsWith("zh");
  if (expectedCjk)
    for (const utterance of spokenTurns)
      if (!/[\u3400-\u9fff]/u.test(utterance.text))
        allFindings.push({
          turnId: utterance.turnId,
          obligation: "player_language_consistency",
          detail: "no CJK in a zh-CN run",
        });

  const brokenFor = (id) => allFindings.filter((finding) => finding.obligation === id).length;
  // Performance obligations are decided from the run report, and the thresholds are named rather than scored: a
  // 36%-unobserved session and a trace that is 97% repeated frames are properties, not opinions.
  const performanceVerdict = (obligation) => {
    if (runReport === null) return { verdict: "unmeasured", detail: "no_run_report" };
    const tail = Number(runReport.unobservedTailMs);
    if (obligation.id === "observation_continuity") {
      // A mode that declares its tail meaningless must not be judged by it: the agent path observes on demand, so its
      // tail is model generation plus the harness quiet window. Reported as unmeasured WITH the reason, never as green.
      if (runReport.observationMeasurement === "not_applicable_agent_mode")
        return { verdict: "unmeasured", detail: "agent_mode_observes_on_demand" };
      if (!Number.isFinite(tail)) return { verdict: "unmeasured", detail: "no_observation_measurement" };
      return {
        verdict: tail > 30_000 ? "broken" : "green",
        detail:
          `unobserved tail ${Math.round(tail / 1000)}s of ${Math.round(Number(runReport.durationSeconds ?? 0))}s` +
          (Number.isFinite(Number(runReport.observationFailures)) &&
          Number.isFinite(Number(runReport.observationCycles))
            ? "; failures " + String(runReport.observationFailures) + "/" + String(runReport.observationCycles)
            : "; failures not_measured") +
          "; tail spans model generation and the harness quiet window",
      };
    }
    const bytes = runReport.traceBytes ?? null;
    const total = Number(bytes?.total);
    if (!Number.isFinite(total) || total <= 0) return { verdict: "unmeasured", detail: "no_trace_byte_measurement" };
    if (obligation.id === "trace_snapshot_share") {
      const share = Number(bytes.snapshot ?? 0) / total;
      return {
        verdict: share > 0.8 ? "broken" : "green",
        detail: `snapshots ${(share * 100).toFixed(1)}% of ${total} B`,
      };
    }
    // DUPLICATION means a record written MORE THAN ONCE. A single large record is a different fact (reported through
    // `trace_snapshot_share` and `bytes.largestRecordBytes`), and treating it as duplication made this obligation fire
    // on a session that had no duplicated record at all.
    const repeated = Number(bytes.largestRepeatedRecordBytes ?? 0) / total;
    return {
      verdict: repeated > 0.05 ? "broken" : "green",
      detail: `largest repeated record = ${(repeated * 100).toFixed(1)}% of the trace; largest single record = ${(Number(bytes.largestRecordBytes ?? 0) / 1024).toFixed(0)} KiB`,
    };
  };
  const obligations = COMPANION_BEHAVIOUR_OBLIGATIONS.map((obligation) => {
    if (obligation.class === "Unjudged") {
      // `claim_fulfillable` is Unjudged because no run passes a presence projection -- but when one IS supplied, the
      // projection decided something and the obligation is judged from it. The inherently Unjudged ones (they need a
      // judge, not a projection) keep a null detail: labelling them `no_presence_projection` said the wrong thing about
      // why they are unmeasured.
      if (obligation.id === "claim_fulfillable")
        return presence === null
          ? Object.freeze({ ...obligation, verdict: "unmeasured", detail: "no_presence_projection" })
          : Object.freeze({
              ...obligation,
              verdict: presenceFindings.length > 0 ? "broken" : "green",
              detail: `${presenceFindings.length} finding(s)`,
            });
      return Object.freeze({ ...obligation, verdict: "unmeasured", detail: null });
    }
    if (obligation.class === "Performance") return Object.freeze({ ...obligation, ...performanceVerdict(obligation) });
    if (obligation.source === null) return Object.freeze({ ...obligation, verdict: "unmeasured", detail: null });
    // An Invariant/Preference with no evidence to judge is unmeasured, never green:
    // a run with no spoken turn cannot clear the leak obligations.
    const measured = obligation.id === "claim_fulfillable" ? presence !== null : spokenTurns.length > 0;
    if (!measured) return Object.freeze({ ...obligation, verdict: "unmeasured", detail: "no_recorded_turn" });
    if (obligation.id === "native_stage_direction")
      return Object.freeze({
        ...obligation,
        verdict: brokenFor(obligation.id) > 0 ? "broken" : "green",
        detail: `${stageDirections.length}/${spokenTurns.length} carry a parenthesised gesture`,
      });
    // The Preference is a preference about the RUN, not a per-utterance pattern, so
    // it breaks when NO recorded turn addresses the player; a single finding cannot
    // express that, which is why this one is decided from the count.
    if (obligation.id === "not_a_narrator")
      return Object.freeze({
        ...obligation,
        verdict: announcements.length * 2 >= spokenTurns.length ? "broken" : "green",
        detail: `${announcements.length}/${spokenTurns.length} turns only announce intent`,
      });
    if (obligation.id === "addresses_the_player")
      return Object.freeze({
        ...obligation,
        verdict: addressed === 0 ? "broken" : "green",
        detail: `${addressed}/${spokenTurns.length} address the player`,
      });
    const broken = brokenFor(obligation.id);
    return Object.freeze({ ...obligation, verdict: broken > 0 ? "broken" : "green", detail: `${broken} finding(s)` });
  });

  const broken = obligations.filter((obligation) => obligation.verdict === "broken").map((obligation) => obligation.id);
  const unmeasured = obligations
    .filter((obligation) => obligation.verdict === "unmeasured")
    .map((obligation) => obligation.id);
  return Object.freeze({
    turnsChecked: turns.length,
    spokenTurns: spokenTurns.length,
    obligations: Object.freeze(obligations),
    findings: Object.freeze(allFindings),
    // The verdict is deliberately the two lists, not a scalar: a reader must be
    // able to say "invariants green, preferences broken, two unjudged" exactly.
    verdict: Object.freeze({ broken: Object.freeze(broken), unmeasured: Object.freeze(unmeasured) }),
    passed: broken.length === 0 && spokenTurns.length > 0,
  });
}

function reasonToObligation(reason) {
  switch (reason) {
    case "machine_token_leak":
      return "no_machine_token_leak";
    case "step_checklist":
      return "no_step_recital";
    case "unobserved_event":
      return "no_unobserved_world_reaction";
    case "summary_too_long":
      return "spoken_within_ceiling";
    case "empty":
      return "spoken_within_ceiling";
    default:
      return "spoken_within_ceiling";
  }
}
