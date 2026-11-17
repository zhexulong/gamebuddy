import { isRecord } from "./protocol-target-facts.js";

/**
 * The Host's answer to "may these program nodes be submitted against THIS connection", and the refusal that names the one
 * thing to fix.
 *
 * <p>
 * THE HOST DECLARES NO PLAN FORM. It declared one for a while - `for_each`, a single node that expanded into many
 * dispatches on the game thread - and this file admitted it as a form rather than as an action, because it never appeared
 * in the action catalogue the connection offers. The script is JavaScript, so a batch is a `for` loop over a snapshot
 * family and every node this compiler writes is an ordinary published action: there is nothing left to admit as a form,
 * and a node that still carries that form's one argument is refused here by name (`plan_form_not_declared`) instead of
 * being judged against a catalogue it was never in.
 * </p>
 * <p>
 * THE REFUSAL NAMES THE NODE, NEVER THE CATALOGUE. The message this replaced appended every allowed id - 100+ of them,
 * 1.5 KB - to a refusal that named no node and no reason, so the caller paid tokens for a list it could not act on and
 * retried the same shape. Three classes are named apart because each needs a different correction: an id the Mod
 * publishes nowhere, an id this connection does not offer, and a node carrying a form this Host does not declare.
 * </p>
 * <p>
 * THE SAME DECISION ANSWERS ADMISSION. `refusalsForNode` is the only implementation of "may this node be a member of a
 * program against this catalogue"; the two exported entries differ only in what they answer with - the preflight names
 * the node, admission answers `policy_denied`. Measured 2026-11-10: the preflight was taught this in `d66d86d4` and
 * admission still tested the node's action id against the action catalogue, so the one loop of the run was answered
 * `rejected: policy_denied` at node admission - a second gate judging the same question with its own implementation.
 * </p>
 */

/** What one submission is judged against: the ids this connection offers, and every id the attached Mod publishes. */
export type BodyProgramNodeCatalogue = Readonly<{
  /** The ids this connection can dispatch right now. */
  visibleActionIds: readonly string[];
  /** Every id the attached Mod registers, offered or not - what tells a typo from a policy refusal. */
  registeredActionIds: readonly string[];
}>;

/**
 * Why one node may not be submitted, in the caller's terms.
 *
 * `unknown_action` is a name to correct; `action_not_enabled` is the same name against a connection that does not offer
 * it; `plan_form_not_declared` is a node carrying a plan form's document under a vocabulary this Host does not have.
 */
type NodeRefusalReason = "no_action_id" | "unknown_action" | "action_not_enabled" | "plan_form_not_declared";

type NodeRefusal = Readonly<{
  nodeId: string;
  actionId: string;
  reason: NodeRefusalReason;
}>;

/**
 * How many refusals one answer carries back.
 *
 * A plan may name 256 nodes, so the list is a bounded diagnostic and the count is not: the same rule the plan compiler's
 * `dropped`/`droppedCount` pair follows. A truncated list says how many it left out rather than reading as the whole
 * population.
 */
const MAX_REPORTED_NODE_REFUSALS = 8;

/** The placeholders a malformed node is answered with - id-shaped, so a refusal is always one readable code. */
const NO_NODE_ID = "no_node_id";
const NO_ACTION_ID = "no_action_id";

/**
 * The one argument a plan form's node carried.
 *
 * Read by NAME rather than by grammar: the Host has no form to parse it against, and a second reader for a vocabulary
 * nothing writes is a second thing to keep true. What the name buys is the refusal - a program carrying a form from an
 * older Host, or from anything else that still speaks it, is named instead of quietly dispatched to an action id that
 * does not exist.
 */
const LOOP_ARGUMENT = "loop";

const REFUSAL_PREFIX = "body_program_preflight_rejected";

/**
 * The refusal for the nodes that may not be submitted, or `null` when every node may.
 *
 * `nodes` is read as the wire carries it, not as a typed request: this runs BEFORE the request validator, so a malformed
 * node is answered by name rather than thrown at.
 */
export function bodyProgramPreflightRefusal(nodes: unknown, catalogue: BodyProgramNodeCatalogue): string | null {
  if (!Array.isArray(nodes)) return null;
  const visible = new Set(catalogue.visibleActionIds);
  const registered = new Set(catalogue.registeredActionIds);
  const refusals: NodeRefusal[] = [];
  for (const node of nodes) refusals.push(...nodeRefusals(node, visible, registered));
  if (refusals.length === 0) return null;
  const shown = refusals.slice(0, MAX_REPORTED_NODE_REFUSALS).map(refusalText);
  const omitted = refusals.length - shown.length;
  return `${REFUSAL_PREFIX}:${shown.join(",")}${omitted === 0 ? "" : `,+${String(omitted)}_more`}`;
}

/** One refusal as `node:action:reason`. */
function refusalText(refusal: NodeRefusal): string {
  return [refusal.nodeId, refusal.actionId, refusal.reason].join(":");
}

/**
 * The refusal code one node's admission is answered with, or `null` when it may be admitted.
 *
 * This is the preflight's decision - `refusalsForNode` - asked of the node as the Mod's ADMISSION CHALLENGE carries it, so
 * a node cannot be admitted by one gate and refused by the next.
 */
export function bodyProgramNodeAdmissionRefusal(
  challenge: Readonly<{ actionId: string; canonicalBoundArgs: Readonly<Record<string, unknown>> }>,
  catalogue: BodyProgramNodeCatalogue,
): string | null {
  const refusal = refusalsForNode(
    NO_NODE_ID,
    challenge.actionId,
    Object.hasOwn(challenge.canonicalBoundArgs, LOOP_ARGUMENT),
    new Set(catalogue.visibleActionIds),
    new Set(catalogue.registeredActionIds),
  )[0];
  return refusal === undefined ? null : "policy_denied";
}

/** Every refusal one node contributes: none when it may be submitted, one otherwise. */
function nodeRefusals(
  node: unknown,
  visible: ReadonlySet<string>,
  registered: ReadonlySet<string>,
): readonly NodeRefusal[] {
  if (!isRecord(node))
    return [Object.freeze({ nodeId: NO_NODE_ID, actionId: NO_ACTION_ID, reason: "no_action_id" as const })];
  const nodeId = typeof node.nodeId === "string" && node.nodeId.length > 0 ? node.nodeId : NO_NODE_ID;
  const actionId = node.actionId;
  if (typeof actionId !== "string" || actionId.length === 0)
    return [Object.freeze({ nodeId, actionId: NO_ACTION_ID, reason: "no_action_id" as const })];
  const arguments_ = node.arguments;
  const carriesForm = isRecord(arguments_) && Object.hasOwn(arguments_, LOOP_ARGUMENT);
  return refusalsForNode(nodeId, actionId, carriesForm, visible, registered);
}

/**
 * THE ONE DECISION: may this action id be a member of a program against this catalogue?
 *
 * Every reader of it supplies the same three facts and re-derives none of them: the action id, whether the node carries a
 * plan form's document at all, what this connection offers now, and what the attached Mod publishes.
 */
function refusalsForNode(
  nodeId: string,
  actionId: string,
  carriesForm: boolean,
  visible: ReadonlySet<string>,
  registered: ReadonlySet<string>,
): readonly NodeRefusal[] {
  // A form DOCUMENT is the evidence: no catalogue can make it runnable, because this Host compiles no such node and the
  // action id beside it is not one the Mod publishes as an action.
  if (carriesForm) return [Object.freeze({ nodeId, actionId, reason: "plan_form_not_declared" as const })];
  if (visible.has(actionId)) return [];
  return [
    Object.freeze({
      nodeId,
      actionId,
      reason: registered.has(actionId) ? ("action_not_enabled" as const) : ("unknown_action" as const),
    }),
  ];
}
