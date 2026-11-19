import {
  EXPRESSION_ONLY_ACTION_IDS,
  isExpressionOnlyAction,
  STARDEW_ACTION_TOOL_NAMES,
} from "./action-registry.js";

/**
 * The one Host-owned answer to "may an expression result end THIS turn", written by the turn boundary and read by the
 * expression action's own tool result.
 *
 * <p>
 * THE TOOL CALL IS THE ONE CHANNEL THAT NEVER WRITES PROSE. Measured `round78` (2026-11-19, 32 consumed batches, 88
 * assistant rounds): `tool rounds 62 · with text 0`, and every line she wrote sat in a SEPARATE no-tool round after the
 * last tool result - `no-tool rounds 26 · with text 25 · chars 322`, of which 21 were narration. Pi sends that round
 * because a tool result asks the model again, and the only interface Pi offers to skip it is the result's own
 * `terminate` hint (`pi-agent-core` `AgentToolResult`: "Hint that the agent should stop after the current tool batch.
 * Early termination only happens when every finalized tool result in the batch sets this to true").
 * </p>
 * <p>
 * WHY THE ALGEBRA GUARDS THE GUARD. Termination needs EVERY finalized result in the batch to set the hint, so
 * `emote + cut_weeds` cannot end the turn - the work action's own result does not set it, and no rule here has to look at
 * the batch. The predicate therefore only has to be right about the expression action itself.
 * </p>
 * <p>
 * WHY THE OPENER DECIDES IT. A turn the PLAYER opened is owed an answer: if she says hello or replies to a question, that
 * line is the product, and ending the turn at her gesture would swallow it. So this gate opens only for a turn a fact
 * opened, and its default is CLOSED: an unwritten gate, an unknown opener, or a surface with no turn boundary never
 * terminates anything - the failure direction is one extra narrated line, never a swallowed answer.
 * </p>
 */
export type ExpressionTurnGate = { worldOpened: boolean };

/** The gate before any turn has bound it. Closed, so a tool that runs outside a turn can never end one. */
export function createExpressionTurnGate(): ExpressionTurnGate {
  return { worldOpened: false };
}

/** Whether this action's result may carry the early-termination hint for the turn currently bound to the gate. */
export function expressionResultEndsTurn(actionId: string, gate: ExpressionTurnGate | undefined): boolean {
  return gate !== undefined && gate.worldOpened === true && isExpressionOnlyAction(actionId);
}

/**
 * The tool names the hint may ride on, derived from the declaration rather than listed.
 *
 * <p>
 * The turn boundary sees Pi's `tool_execution_end` (a tool NAME) and the action registry speaks action ids, so the two
 * spellings meet here - derived from `EXPRESSION_ONLY_ACTION_IDS` crossed with the registry's own tool names, so a third
 * expression action arrives without anyone returning to this file.
 * </p>
 */
export const EXPRESSION_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  EXPRESSION_ONLY_ACTION_IDS.map((actionId) => STARDEW_ACTION_TOOL_NAMES[actionId]),
);
