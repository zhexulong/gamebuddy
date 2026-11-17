import assert from "node:assert/strict";
import test from "node:test";
import { type FactBriefBlock, FACT_BRIEF_BLOCKS } from "./fact-brief.js";

/**
 * `push_fact_has_no_pull:<block>` - every block a delivery assembles answers something she can point at.
 *
 * <p>
 * THE AUTHORITY (`design/fact-authority.md` §1b). A world fact reaches the model in exactly four cases: she asked for it
 * (`stardew_observe`), it is the RESULT of her own call, it is a DECISION she must see to correct herself (a refusal),
 * or the PLAYER SPOKE. Everything else is silence - the world changing while she did not ask, and it was not her own
 * action, is not news.
 * </p>
 * <p>
 * A block is therefore either part of Pi's own shape (`<world-state>`, which is where her observation tool's answer is
 * placed), a result/refusal, the player's words, or the arrival. A block that states something she never asked for and
 * that no call of hers returned is a PUSH, and Pi has no such shape: it is the pump feeding a stream the model did not
 * request.
 * </p>
 * <p>
 * THE POPULATION IS THE PRODUCT'S OWN DECLARATION (`FACT_BRIEF_BLOCKS`), so a block added to the composition appears here
 * without anyone remembering to extend a second table, and a block that LEAVES the composition makes this file fail to
 * compile until its justification row is deleted with it - the drift fails loudly in both directions.
 * </p>
 * <p>
 * THE VERDICT IS PER BLOCK AND THE JUSTIFICATION IS THE ANSWER: `undefined` means nobody has said why she would see it,
 * which is the state `<world-facts>` (a push of every event that happened) and `<in-flight>` (a row per unfinished node,
 * where the settlement is the answer) are in today. Measured 2026-11-16 (`round64`): 260 of 401 facts were her body
 * moving one tile, stated twice, and the block that carried them existed for no reason she could name.
 * </p>
 */
const BLOCK_JUSTIFICATION: Readonly<Record<FactBriefBlock, string | undefined>> = Object.freeze({
  // Her own observation, rendered where the model asked for it. This is the PULL answer, and it is the whole reason the
  // push does not have to exist.
  "world-state":
    "the answer to `stardew_observe`: the state she asked for, placed where Pi's own observation shape goes",
  // RESULT. Her own call's outcome: the settlement states what the call did, and it is the one block that answers a call
  // she made rather than something that happened around her.
  "execution-result": "the result of her own call: the programme's settlement, per node",
  // DECISIONS. What remains of this block after the push half was deleted: a refusal, a notice, an arrival, the bridge
  // going away - the news she must see to correct herself. The world itself is what `stardew_observe` answers, and a
  // successful step of her own programme is stated by `<execution-result>`.
  "world-facts": "the decisions she has to see: a refusal, a notice, an arrival, the bridge going away",
});

test("push_fact_has_no_pull: every assembled block is a pull answer, a result, a refusal, the player, or an arrival", () => {
  assert.ok(FACT_BRIEF_BLOCKS.length > 0, "an empty population agrees with itself: nothing was examined");
  const pushed = FACT_BRIEF_BLOCKS.filter((block) => BLOCK_JUSTIFICATION[block] === undefined);
  const justified = FACT_BRIEF_BLOCKS.length - pushed.length;
  const reading = `blocks examined ${String(FACT_BRIEF_BLOCKS.length)} · pull-answers ${String(justified)} · results and refusals and player words ${String(justified)} · pushed ${String(pushed.length)}`;
  assert.deepEqual(
    pushed,
    [],
    `push_fact_has_no_pull:${pushed.map((block) => `<${block}>`).join(",")}: a block that states something she never asked for is the push shape Pi does not have - 把踪迹算进事实里，等于把洪水当成水位 (${reading})`,
  );
  for (const block of FACT_BRIEF_BLOCKS)
    assert.equal(
      typeof BLOCK_JUSTIFICATION[block],
      "string",
      `push_fact_has_no_pull:${block}: no justification declared`,
    );
});
