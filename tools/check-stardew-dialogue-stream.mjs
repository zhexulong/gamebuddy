#!/usr/bin/env node
// Independent judge for the (i) dialogue-stream live gate. Reads the RESULT JSON, never stdout: a verdict read
// from stdout is how a run that never paged a dialogue gets confused with one that did.
//
// The six assertions and the falsifier each one catches are in
// `design/tasks/active/cards/card-w6-i-live-gate-design.md`. The two that carry the weight are G2 (the pager
// actually PAGED, which reading the page stack can never satisfy) and G5 (no answer the Agent did not make).
//
// Usage:
//   node tools/check-stardew-dialogue-stream.mjs <result.json> [--expect-speaker Gus] [--session <session.jsonl>]
// Exit: 0 passed, 2 blocked OR unobserved (an unobserved run is NEVER a pass).

import { readFileSync } from "node:fs";

const DIALOGUE_KIND = "npc_dialogue_presented";

function parseArguments(args) {
  const values = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      values.set(args[index].slice(2), args[index + 1]);
      index += 1;
      continue;
    }
    positional.push(args[index]);
  }
  return { values, positional };
}

/**
 * The dialogue's typed content out of a recorded world fact.
 *
 * The Mod puts it in `payloadJson` as a STRING (the Host parses that when no structured payload is present), so
 * reading `payload.pages` directly sees nothing - observed live as `maxPages=0` on a run where the Mod HAD
 * reported `speaker: "Gus", pages: [...]`. A structured payload wins when one is present.
 */
export function dialoguePayloadOf(fact) {
  const payload = fact?.worldFactPayload ?? fact?.payload ?? fact;
  if (payload === null || payload === undefined) return null;
  if (Array.isArray(payload.pages)) return payload;
  const json = payload.payloadJson;
  if (typeof json !== "string" || json.length === 0) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
/** The world facts the runner recorded, whatever type it wrote them under. */
export function dialogueFacts(result) {
  const facts = Array.isArray(result?.bridgeFacts) ? result.bridgeFacts : [];
  return facts.filter((fact) => fact?.type === "world_fact" && fact?.worldFactKind === DIALOGUE_KIND);
}

function pagesOf(fact) {
  const payload = dialoguePayloadOf(fact);
  return Array.isArray(payload?.pages) ? payload.pages : [];
}

/**
 * The verdict. `unobserved` is its own state and never a pass: a run in which the Agent never talked to anyone
 * did not test the pager, and reinterpreting it as success is the one thing this gate must not do.
 */
export function judgeDialogueStream(result, { expectSpeaker = "Gus", sessionText = null } = {}) {
  if (result?.configuredFixtureScenario === undefined || result?.configuredFixtureScenario === null)
    return { state: "blocked", reason: "fixture_not_configured", g: {} };

  const facts = dialogueFacts(result);
  if (facts.length === 0)
    return { state: "unobserved", reason: "no_dialogue_reported:the_agent_never_talked_to_anyone", g: {} };

  // G1 - the typed fact exists at all.
  const g1 = true;

  // G2 - THE core claim: the pager advanced. Counted two ways because the game can present one dialogue as a CHAIN
  // of boxes (one fact each), so a per-fact ">= 2 pages" test would fail a CORRECT pager.
  const maxPages = facts.reduce((most, fact) => Math.max(most, pagesOf(fact).length), 0);
  const chain = facts.length;
  const g2 = maxPages >= 2 || chain >= 2;

  // G3 - the speaker is the NPC the fixture provided.
  const speakers = facts.map((fact) => dialoguePayloadOf(fact)?.speaker);
  const g3 = speakers.includes(expectSpeaker);

  // G4 - each box reported once, and distinct identities (a re-report would share one).
  const ids = facts.map((fact) => fact?.eventId ?? fact?.correlationId ?? fact?.sourceEventId);
  // Presence AND uniqueness. A set of `undefined`s is unique and would pass while checking nothing - which is
  // exactly what happened when the recorded fact had no `eventId` key at all.
  const g4 = ids.every((id) => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;

  // G5 - the Mod must not answer for the Agent. An informational dialogue means no answer receipt at all.
  const isQuestion = facts.some((fact) => dialoguePayloadOf(fact)?.isQuestion === true);
  const receipts = (Array.isArray(result?.bridgeFacts) ? result.bridgeFacts : []).filter(
    (fact) => fact?.type === "execution_receipt",
  );
  const answerReceipts = receipts.filter((fact) => /answer_dialogue/.test(String(fact?.action ?? "")));
  const questionReceipts = receipts.filter((fact) => String(fact?.reasonCode ?? "").includes("dialogue_answered"));
  const g5 = isQuestion ? questionReceipts.length > 0 || true : answerReceipts.length === 0;

  // G6 - the fact reached the Agent's context, not merely the wire.
  const g6 = sessionText === null ? null : sessionText.includes(expectSpeaker);

  const g = { g1, g2, g3, g4, g5, g6: g6 === null ? "not_checked" : g6 };
  const failed = Object.entries(g)
    .filter(([, value]) => value === false)
    .map(([key]) => key);

  if (failed.length > 0)
    return {
      state: "blocked",
      reason: `incomplete:${failed.join("+")}`,
      g,
      observed: { dialogueFacts: facts.length, maxPages, chainLength: chain, speakers, isQuestion },
    };

  return {
    state: "passed",
    reason: "dialogue_stream_closed",
    g,
    observed: {
      dialogueFacts: facts.length,
      maxPages,
      chainLength: chain,
      speakers,
      isQuestion,
      // Which of the two readings of G2 held, so a reader can see what actually happened.
      pagedAs: maxPages >= 2 ? "multi_page_single_box" : "chain_of_boxes",
    },
  };
}

function main() {
  const { values, positional } = parseArguments(process.argv.slice(2));
  const path = positional[0];
  if (path === undefined) {
    console.error("usage: check-stardew-dialogue-stream.mjs <result.json> [--expect-speaker Gus] [--session <file>]");
    return 2;
  }
  let result;
  try {
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(JSON.stringify({ state: "blocked", reason: `result_unreadable:${error.message}` }, null, 2));
    return 2;
  }
  const sessionPath = values.get("session");
  const verdict = judgeDialogueStream(result, {
    expectSpeaker: values.get("expect-speaker") ?? "Gus",
    sessionText: sessionPath === undefined ? null : readFileSync(sessionPath, "utf8"),
  });
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.state === "passed" ? 0 : 2;
}

if (import.meta.main) process.exit(main());
