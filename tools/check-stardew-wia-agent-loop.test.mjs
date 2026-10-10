import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { judgeWiaLoop } from "./check-stardew-wia-agent-loop.mjs";

const PROMPT = "现在是星露谷春季的一个早晨,你在农场里。农场另一头那片地我还没顾上看——你过去看看那边是什么情况,顺手做点该做的。回来跟我说说那边什么样、你做了什么(两三句话就行,总共控制在 120 字以内)。";
const PROMPT_HASH = createHash("sha256").update(PROMPT).digest("hex");

const bp = {
  type: "execution_receipt",
  reasonCode: "modal_interrupted",
  requestId: "req_bp",
  executionId: "exec_bp",
  evidence: { detail: "interrupted_by=DialogueBox;target_tile=35,35;interrupted_at=20,20;remaining_distance=15" },
};
const dismiss = { type: "execution_receipt", reasonCode: "modal_dismissed", requestId: "req_d", executionId: "exec_d", evidence: { detail: "modal_type=DialogueBox" } };
const resume = { type: "execution_receipt", reasonCode: "target_reached", requestId: "req_r", executionId: "exec_r", evidence: { detail: "target=35,35;arrived=true" } };

const OK = {
  ladder: "6",
  state: "passed",
  configuredFixtureScenario: "native_wia_modal_dismiss_chain_v1",
  sessionTurns: [{ goal: PROMPT }],
  factLog: [bp, dismiss, resume],
  actionTrace: [
    { action: "move_to_tile", requestId: "req_r", args: { x: 35, y: 35 }, state: "succeeded", reasonCode: "target_reached" },
  ],
};

test("the full chain with the pinned pure prompt passes (strong: same intent)", () => {
  const verdict = judgeWiaLoop(OK, { pinnedPromptHash: PROMPT_HASH });
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.d1, true);
  assert.equal(verdict.unresumedSameIntent, true);
});

test("a never-interrupted run is UNOBSERVED, not passed", () => {
  const never = { ...OK, factLog: [{ type: "execution_receipt", reasonCode: "target_reached", requestId: "r", executionId: "e" }] };
  const verdict = judgeWiaLoop(never, { pinnedPromptHash: PROMPT_HASH });
  assert.equal(verdict.state, "unobserved");
});

test("dismiss before the breakpoint is a wrong order, blocked", () => {
  const wrongOrder = { ...OK, factLog: [dismiss, bp, resume] };
  const verdict = judgeWiaLoop(wrongOrder, { pinnedPromptHash: PROMPT_HASH });
  assert.equal(verdict.state, "blocked");
  assert.equal(verdict.ordered, false);
});

test("a resumed move that REUSES the breakpoint requestId is blocked (not a new resume)", () => {
  const replay = { ...OK, factLog: [bp, dismiss, { ...resume, requestId: "req_bp", executionId: "exec_bp" }] };
  const verdict = judgeWiaLoop(replay, { pinnedPromptHash: PROMPT_HASH });
  assert.equal(verdict.d3, false);
  assert.equal(verdict.state, "blocked");
});

test("wrong fixture is blocked and names it", () => {
  const wrongWorld = { ...OK, configuredFixtureScenario: "native_till_soil_v1" };
  const verdict = judgeWiaLoop(wrongWorld, { pinnedPromptHash: PROMPT_HASH });
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /fixture_scenario_mismatch/);
});

test("a prompt that leaks the recovery word fails R6 even if the receipts close the loop", () => {
  const leaky = { ...OK, sessionTurns: [{ goal: "…如果有弹窗就把它 dismiss 掉…" }] };
  const verdict = judgeWiaLoop(leaky, { pinnedPromptHash: PROMPT_HASH });
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /prompt_not_pure/);
});

test("an unpinned prompt hash is itself blocked (the hash has to be set when the run exists)", () => {
  const verdict = judgeWiaLoop(OK, { pinnedPromptHash: null });
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /prompt_not_pure_or_hash_unpinned/);
});