#!/usr/bin/env node
/**
 * Independent judge for the DIALOGUE autonomy claim: did the Agent decide, on its own, to talk to a villager - and
 * did what the villager said reach its context?
 *
 * Why a separate judge. `dialogue_stream` (the bridge-level gate) proves the Mod PAGES a native multi-page
 * dialogue and reports it; it drives the requests itself, so it cannot say anything about the Agent. This judge
 * reads a LADDER-6 result, where the only thing the harness supplied is a player-level goal, and requires:
 *
 *   A1  prompt purity   the goal carries no action id, no coordinate pair, no step words and no dialogue vocabulary
 *                       (a goal that says "expect a dialogue" makes the run prove obedience, not autonomy), and
 *                       matches the pinned hash when one is supplied
 *   A2  the fact        a `world_fact` with `worldFactKind === npc_dialogue_presented` is in the result's facts
 *   A3  the Agent acted a talk receipt reached a terminal (the dispatch came from the TOOL layer, not the harness)
 *   A4  identity        the dispatch's requestId is present and carries no harness prefix
 *   A5  it reached the Agent  the session transcript contains the speaker or the dialogue text - the difference
 *                       between "the Mod emitted it" and "the Agent could read it"
 *
 * Three-valued, and the vacuous state is not a pass: `unobserved` means the Agent never talked to anyone, which did
 * not test the mechanism, and reinterpreting it as success is the one thing this judge must not do.
 *
 * Usage:
 *   node tools/check-stardew-dialogue-autonomy.mjs <ladder-result.json> [--session <session.jsonl>]
 * Exit: 0 passed, 2 blocked OR unobserved.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

const DIALOGUE_KIND = "npc_dialogue_presented";

/**
 * The dialogue's typed content out of a recorded world fact.
 *
 * The Mod puts it in `payloadJson` as a STRING (the Host parses that when no structured payload is present), so
 * reading `payload.pages` directly sees nothing - the exact defect the bridge-level runner had.
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

/** Tier-2 action ids are snake_case; a pure player goal has none, nor a coordinate pair, nor a tool name. */
const IMPURE = [
  [/[a-z]+_[a-z_]{3,}/, "an action id or snake_case identifier"],
  [/\d+\s*[,，]\s*\d+/, "a coordinate pair"],
  [/对话框|弹窗|交谈动作|期望看到|dialogue box|expect a/i, "dialogue vocabulary that leaks the mechanism"],
  [/talk_to_npc|stardew_/, "a tool name"],
];

// WHAT THIS DOES NOT FLAG, and why: connective words (然后 / 先 / 接着) were on the list and had to come off. They
// are ordinary player speech - the frozen card's own example goal is “去跟 <村民> 说句话，然后回来告诉我你做了
// 什么” - and flagging them made the judge reject the very prompt the design prescribes. A rule that fails correct
// input is the failure mode this repo keeps meeting, so the list now carries only things that actually leak the
// MECHANISM: an action id, a coordinate, a tool name, or dialogue vocabulary.

export function judgeDialogueAutonomy(result, { sessionText = null, pinnedPromptHash = null } = {}) {
  const g = { a1: null, a2: false, a3: false, a4: false, a5: null };
  const goals = Array.isArray(result?.sessionTurns) ? result.sessionTurns.map((turn) => String(turn?.goal ?? "")) : [];
  const goal = goals[0] ?? "";

  // A1: prompt purity. Without a goal the run cannot be judged for autonomy at all.
  if (goal.length === 0) return { state: "blocked", reason: "no_player_goal_recorded", g };
  const impure = IMPURE.filter(([pattern]) => pattern.test(goal)).map(([, what]) => what);
  if (impure.length > 0) return { state: "blocked", reason: `prompt_not_pure:${impure.join("+")}`, g };
  if (pinnedPromptHash !== null) {
    const actual = createHash("sha256").update(goal).digest("hex");
    if (actual !== pinnedPromptHash)
      return { state: "blocked", reason: `prompt_hash_mismatch:${actual.slice(0, 12)}`, g };
  }
  g.a1 = true;

  const facts = Array.isArray(result?.bridgeFacts) ? result.bridgeFacts : [];
  const dialogueFacts = facts.filter(
    (fact) => fact?.type === "world_fact" && fact?.worldFactKind === DIALOGUE_KIND,
  );
  g.a2 = dialogueFacts.length > 0;
  if (!g.a2)
    return {
      state: "unobserved",
      reason: "no_dialogue_fact:the_agent_never_talked_to_a_villager",
      g,
      observed: { facts: facts.length, attempted: result?.attemptedActionIds ?? [], succeeded: result?.succeededActionIds ?? [] },
    };

  // A3 + A4: a talk receipt reached a terminal, dispatched with an identity that is not the harness's.
  const receipts = facts.filter((fact) => fact?.type === "execution_receipt");
  const talkReceipts = receipts.filter((receipt) => /talk_to_npc|npc_talk|talked/.test(String(receipt?.reasonCode ?? "")));
  g.a3 = talkReceipts.length > 0;
  const requestIds = talkReceipts.map((receipt) => String(receipt?.requestId ?? ""));
  g.a4 = requestIds.length > 0 && requestIds.every((id) => id.length > 0 && !/^native_local_(wia|dialogue_stream)_/.test(id));

  // A5: the fact reached the Agent's CONTEXT. Only assertable when a session transcript is supplied, and reported
  // as `not_checked` (not as a pass) when it is not.
  //
  // IT MUST LOOK FOR THE TEXT, NOT THE SPEAKER. A first version searched for the speaker's name alone - and that is
  // satisfied by the TALK RECEIPT (`npc=Lewis`), so it would have passed a run whose dialogue text never reached the
  // model. The transcript may store the payload JSON-escaped, so both forms are searched: the literal page and its
  // `JSON.stringify` form.
  if (sessionText === null) g.a5 = "not_checked";
  else {
    const pages = dialogueFacts.flatMap((fact) => {
      const payload = dialoguePayloadOf(fact);
      return Array.isArray(payload?.pages) ? payload.pages : [];
    });
    const present = (text) =>
      typeof text === "string" &&
      text.length > 0 &&
      (sessionText.includes(text) || sessionText.includes(JSON.stringify(text).slice(1, -1)));
    // EVERY page, not one: a truncating delivery would otherwise pass on the first page it managed to carry.
    g.a5 = pages.length > 0 && pages.every((page) => present(page));
  }

  const failed = Object.entries(g)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  if (failed.length > 0)
    return {
      state: "blocked",
      reason: `incomplete:${failed.join("+")}`,
      g,
      observed: { dialogueFacts: dialogueFacts.length, talkReceipts: talkReceipts.length, requestIds },
    };

  return {
    state: "passed",
    reason: "dialogue_autonomy_observed",
    g,
    observed: {
      dialogueFacts: dialogueFacts.length,
      talkReceipts: talkReceipts.length,
      attestedInContext: g.a5 === true,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : null;
  };
  const path = args.find((arg) => !arg.startsWith("--") && arg !== option("session"));
  if (path === undefined) {
    console.error("usage: check-stardew-dialogue-autonomy.mjs <ladder-result.json> [--session <file>]");
    return 2;
  }
  let result;
  try {
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(JSON.stringify({ state: "blocked", reason: `result_unreadable:${error.message}` }));
    return 2;
  }
  const session = option("session");
  const verdict = judgeDialogueAutonomy(result, {
    sessionText: session === null ? null : readFileSync(session, "utf8"),
    pinnedPromptHash: process.env.GAMEBUDDY_DIALOGUE_PROMPT_SHA256 ?? null,
  });
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.state === "passed" ? 0 : 2;
}

if (import.meta.main) process.exit(main());
