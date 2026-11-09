import {
  forEachRules,
  PLAN_FOR_EACH_BY_KIND_ACTION,
  type PlanForEachLoop,
  readForEachLoop,
} from "./body-program-for-each.js";
import { PLAN_FORM_ACTION_IDS } from "./body-program-script.js";
import { isRecord } from "./protocol-target-facts.js";

/**
 * The Host's answer to "may these program nodes be submitted against THIS connection", and the refusal that names the one
 * thing to fix.
 *
 * <p>
 * A PLAN FORM IS ADMITTED AS A FORM. `for_each` is one node that expands into many dispatches, so it is not an action and
 * never appears in the action catalogue the connection offers; the live policy governs its ROWS. Measured 2026-11-09: the
 * companion wrote `builder.for_each({ source: { area: { x: 54, y: 16, w: 16, h: 2 } }, do: { action: "till_soil" } })` -
 * the only loop of its 68 plans, and the only construct that can address a 3x20 patch in one plan - and every node of it
 * was refused for not being a visible action. The identity of a form comes from `PLAN_FORM_ACTION_IDS`, the list the
 * compiler writes form nodes from, so no id is spelled here. The Mod answers the same question the same way: its verifier
 * moves the live-policy gate off the form and onto the row (`FarmhandPlanFormCatalog.IsPlanForm`, `row_action_not_enabled`).
 * </p>
 * <p>
 * THE REFUSAL NAMES THE NODE, NEVER THE CATALOGUE. The message this replaced appended every allowed id - 100+ of them,
 * 1.5 KB - to a refusal that named no node and no reason, so the caller paid tokens for a list it could not act on and
 * retried the same shape. Four classes are named apart because each needs a different correction: an id the Mod
 * publishes nowhere, an id this connection does not offer, a loop under an id the Host does not declare a form, and a loop
 * whose row names an action the policy does not offer.
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
 * it; `plan_form_not_declared` is a loop written under an id that is not a form here; `row_action_not_enabled` is a loop
 * whose own row names an action the connection does not offer. The last one is the Mod's own word for that fact.
 */
type NodeRefusalReason =
  | "no_action_id"
  | "unknown_action"
  | "action_not_enabled"
  | "plan_form_not_declared"
  | "row_action_not_enabled";

type NodeRefusal = Readonly<{
  nodeId: string;
  actionId: string;
  reason: NodeRefusalReason;
  /** The row's action, when the refused thing is one row of a loop rather than the node itself. */
  rowActionId?: string;
}>;

/**
 * How many refusals one answer carries back.
 *
 * A plan may name 256 nodes and a loop may carry 8 rules, so the list is a bounded diagnostic and the count is not: the
 * same rule the plan compiler's `dropped`/`droppedCount` pair follows. A truncated list says how many it left out rather
 * than reading as the whole population.
 */
const MAX_REPORTED_NODE_REFUSALS = 8;

/** The placeholders a malformed node is answered with - id-shaped, so a refusal is always one readable code. */
const NO_NODE_ID = "no_node_id";
const NO_ACTION_ID = "no_action_id";

const REFUSAL_PREFIX = "body_program_preflight_rejected";

/**
 * The refusal for the nodes that may not be submitted, or `null` when every node may.
 *
 * `nodes` is read as the wire carries it, not as a typed request: this runs BEFORE the request validator, so a malformed
 * node is answered by name rather than thrown at. A node whose loop document is unreadable is NOT refused here - the
 * request validator owns that shape - so nothing here duplicates the loop grammar.
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

/** One refusal as `node:action:reason`, plus the row's action when it is a row that was refused. */
function refusalText(refusal: NodeRefusal): string {
  const fields = [refusal.nodeId, refusal.actionId, refusal.reason];
  if (refusal.rowActionId !== undefined) fields.push(refusal.rowActionId);
  return fields.join(":");
}

/**
 * Every refusal one node contributes: none when it may be submitted, one for an ordinary refusal, one per refused ROW for
 * a loop.
 *
 * A row is refused on its own because the rest of the pass is fine: a 3x20 patch that tills 20 columns and weeds 20 more
 * loses the weeds' rule, not the till.
 */
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
  const loop = planFormLoopOf(node);
  if (PLAN_FORM_ACTION_IDS.includes(actionId))
    return refusedRowActions(loop, visible).map((rowActionId) =>
      Object.freeze({ nodeId, actionId, reason: "row_action_not_enabled" as const, rowActionId }),
    );
  // A plan-form DOCUMENT under an id the Host does not declare a form. The document is the evidence: no catalogue can
  // make it runnable, because the Mod dispatches an action and nothing dispatches an undeclared form.
  if (loop !== null) return [Object.freeze({ nodeId, actionId, reason: "plan_form_not_declared" as const })];
  if (visible.has(actionId)) return [];
  return [
    Object.freeze({
      nodeId,
      actionId,
      reason: registered.has(actionId) ? ("action_not_enabled" as const) : ("unknown_action" as const),
    }),
  ];
}

/**
 * The loop one node carries, or `null` when the node carries none this Host can read.
 *
 * The `loop` runtime value is the document plus its own wire tag, and the tag is a WIRE fact rather than part of the
 * loop's grammar - exactly as `isForEachLoopDocument` states before handing the rest to the one reader.
 */
function planFormLoopOf(node: Record<string, unknown>): PlanForEachLoop | null {
  const arguments_ = node.arguments;
  if (!isRecord(arguments_)) return null;
  const value = arguments_.loop;
  if (!isRecord(value) || value.type !== "loop") return null;
  const { type, ...document } = value;
  void type;
  const reading = readForEachLoop(document, null);
  return reading.ok ? reading.loop : null;
}

/**
 * The row actions this connection does not offer, in the order the rules name them.
 *
 * `by_kind` names no action of its own: the row's action is decided on the game thread by the Mod's own classifier, so
 * there is nothing here to compare it with - which is the same exemption the compiler makes when it reads a `do`.
 */
function refusedRowActions(loop: PlanForEachLoop | null, visible: ReadonlySet<string>): readonly string[] {
  if (loop === null) return [];
  const refused: string[] = [];
  for (const rule of forEachRules(loop)) {
    const action = rule.do?.action;
    if (action === undefined || action === PLAN_FOR_EACH_BY_KIND_ACTION || visible.has(action)) continue;
    if (!refused.includes(action)) refused.push(action);
  }
  return refused;
}
