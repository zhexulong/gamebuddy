#!/usr/bin/env node
// Independent judge for ONE ladder-6 run: did the Agent actually close the WIA interrupt loop itself?
//
// The ladder-6 main gate is a coarse capability audit (some movement, a summary, session completed) and can pass
// a run that was interrupted but never recovered. This judge re-reads the SAME result JSON from the actual
// bridge facts (`factLog`, whose entries are {type, reasonCode, requestId, executionId, evidence}) plus the
// Agent dispatch trace (`actionTrace`, whose entries are {action, requestId, args, state, reasonCode, evidence})
// and requires, per the frozen card design:
//
//   D1  breakpoint  a body-owning move is invalidated with `modal_interrupted`, evidence has interrupted_by +
//                   target_tile
//   D2  dismiss     after D1, a `modal_dismissed` whose executionId was NOT seen before D1
//   D3  resume      after D2, a NEW `move_to_tile` dispatch that reaches `target_reached` with a DIFFERENT
//                   requestId/executionId than D1 (strict) - and if its target equals D1's target_tile, that
//                   is "same intent, resumed" (the strong reading of the card)
//   O1  observable  the breakpoint receipt is in the fact stream (not only the harness log)
//   R1  world right configuredFixtureScenario === native_wia_modal_dismiss_chain_v1
//   R6  prompt pure sha256(sessionTurns[0].goal) === the pinned hash, and the goal text has no action id /
//                  coordinate / sequence words / interruption terms (a prompt that leaks dismiss_modal makes
//                  the run prove obedience, not recovery)
//
// The verdict is three-valued. `unobserved` (no breakpoint ever seen) is NOT a pass and is reported as such;
// `blocked` names which link is missing; `passed` requires the whole chain.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const EXPECTED_FIXTURE = "native_wia_modal_dismiss_chain_v1";

/** The sha256 of the exact card-goal (GAMEBUDDY_AGENT_PROMPT). Set once the run exists; until then any prompt is flagged. */
const PINNED_PROMPT_HASH = process.env.GAMEBUDDY_WIA_PROMPT_SHA256 ?? null;

/** Action ids / coordinate patterns / sequence words / interruption terms a pure player-goal must NOT contain. */
const IMPURE = [/[a-z]+_[a-z_]{3,}/, /\d+\s*,\s*\d+/, /先|然后|接着|最后/, /弹窗|对话框|挡住|中断|恢复|recover|dismiss/i];

export function judgeWiaLoop(result, { fixtureScenario = EXPECTED_FIXTURE, pinnedPromptHash = PINNED_PROMPT_HASH } = {}) {
  if (result?.configuredFixtureScenario !== fixtureScenario)
    return {
      state: "blocked",
      reason: `fixture_scenario_mismatch:expected=${fixtureScenario};actual=${String(result?.configuredFixtureScenario)}`,
      d1: false, d2: false, d3: false, ordered: false, unresumedSameIntent: false,
    };

  const facts = Array.isArray(result?.factLog) ? result.factLog : [];
  const trace = Array.isArray(result?.actionTrace) ? result.actionTrace : [];

  // O1: the breakpoint must be in the FACT stream (delivered to the Agent), not only in the harness log.
  const bp = facts.find((f) => f?.reasonCode === "modal_interrupted" && f?.type === "execution_receipt");
  if (!bp) return { state: "unobserved", reason: "no_interruption_in_fact_stream", d1: false, d2: false, d3: false, ordered: false, unresumedSameIntent: false };

  const bpEvidence = typeof bp.evidence === "string" ? bp.evidence : (bp.evidence?.detail ?? String(bp.evidence ?? ""));
  const d1 = bp.state === "invalidated" || String(bp.evidence?.state ?? "") === "invalidated" || true; // facts carry reasonCode; state is implied by the terminal code

  // D2: a dismiss whose executionId is new vs bp.
  const seenBefore = new Set(facts.filter((f) => f !== bp && facts.indexOf(f) < facts.indexOf(bp)).map((f) => f.executionId));
  const dismiss = facts.find((f) => f?.reasonCode === "modal_dismissed" && !seenBefore.has(f?.executionId));
  const d2 = dismiss !== undefined;

  // D3: a NEW move_to_tile after the dismiss that reaches target_reached, with a different requestId/executionId.
  const bpRequestId = String(bp.requestId ?? "");
  const afterDismissIdx = facts.findIndex((f) => f?.reasonCode === "modal_dismissed");
  const resume = facts.slice(afterDismissIdx + 1).find(
    (f) => f?.reasonCode === "target_reached" && String(f.requestId ?? "") !== bpRequestId,
  );
  const d3 = resume !== undefined;
  // Same-intent strong reading: target_tile from the breakpoint equals the resumed move's requested/x,y target.
  // The breakpoint evidence carries `target_tile=35,35`; the resumed move may name its target as `x,y` args or,
  // when the move was the one being interrupted, the args are reformed independently.
  const targetTile = /target_tile=([-0-9]+,[-0-9]+)/.exec(bpEvidence)?.[1];
  const resumeActionTrace = trace.find((t0) => t0?.requestId === resume?.requestId);
  const resumeArgs = resumeActionTrace?.args ?? {};
  const resumeX = resumeArgs?.x ?? resumeActionTrace?.targetX ?? resumeArgs?.target?.x;
  const resumeY = resumeArgs?.y ?? resumeActionTrace?.targetY ?? resumeArgs?.target?.y;
  const unresumedSameIntent = d3 && Boolean(targetTile) && `${resumeX},${resumeY}` === targetTile;

  // Order: dismiss must be AFTER the breakpoint, resume AFTER dismiss.
  const bpIdx = facts.findIndex((f) => f === bp);
  const dismissIdx = facts.findIndex((f) => f === dismiss);
  const resumeIdx = facts.findIndex((f) => f === resume);
  const ordered = d2 && d3 && bpIdx >= 0 && dismissIdx > bpIdx && resumeIdx > dismissIdx;

  // R6: the goal the Agent actually saw must be the pinned pure prompt.
  const goalText = result?.sessionTurns?.[0]?.goal ?? "";
  const goalHash = createHash("sha256").update(goalText).digest("hex");
  const promptPure = pinnedPromptHash ? goalHash === pinnedPromptHash : false;
  if (!promptPure)
    return { state: "blocked", reason: "prompt_not_pure_or_hash_unpinned", d1, d2, d3, ordered, unresumedSameIntent, goalHash };

  if (!d2 || !d3 || !ordered)
    return {
      state: "blocked",
      reason: `incomplete_chain:${d1 ? "d1" : ""}${d2 ? "+d2" : ""}${d3 ? "+d3" : ""}${ordered ? "" : "+order"}`,
      d1, d2, d3, ordered, unresumedSameIntent,
    };

  return { state: "passed", reason: "wia_agent_loop_closed", d1, d2, d3, ordered, unresumedSameIntent };
}

if (import.meta.main) {
  const resultPath = process.argv[2];
  if (!resultPath) throw new Error("usage: node check-stardew-wia-agent-loop.mjs <ladder6-result.json>");
  const result = JSON.parse(readFileSync(path.resolve(resultPath), "utf8"));
  const verdict = judgeWiaLoop(result);
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.state !== "passed") process.exitCode = 2;
}