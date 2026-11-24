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
 * retried the same shape. Four classes are named apart because each needs a different correction: an id the Mod
 * publishes nowhere, an id this connection does not offer, a node carrying a form this Host does not declare, and a node
 * carrying no action at all.
 * </p>
 * <p>
 * EVERY REFUSAL IS ONE ENVELOPE (`BodyProgramRefusal`): the clause, the node and action it was about, and the delta the
 * clause compared. A bare code is what this product paid a live run to learn not to answer with.
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
 * One refusal, in the shape every layer of this product answers with.
 *
 * <p>
 * A CODE ALONE IS WHAT COST THE RUN. `body_program_preflight_rejected` with nothing after it, and `policy_denied`
 * settling a node for a reason the refusing layer had in hand: in both, the answer carried the word "refused" and the
 * companion could only conclude that batching does not work - which is what it did, falling back to single steps.
 * </p>
 * <p>
 * EVERY FIELD IS THE REFUSING LAYER'S OWN. `field`, `expected` and `actual` state the comparison that was made; a layer
 * that refused without comparing one says `field=unknown` and lets `rejectionCode` name the clause - it never invents a
 * value it does not hold. `failedNodeId`/`failedAction` are `null` only where the clause refused the connection rather
 * than a node, which the renderer states as `node=none` instead of leaving a reader to guess.
 * </p>
 */
export type BodyProgramRefusal = Readonly<{
  /** The clause that refused: one closed name, never prose. */
  rejectionCode: string;
  /** The node this clause refused, or `null` when it refused the connection rather than one node. */
  failedNodeId: string | null;
  /** That node's action, or `null` for the same reason. */
  failedAction: string | null;
  delta: Readonly<{
    /** The field the clause compared, or `unknown` when it compared none it can name. */
    field: string;
    /** This layer's own reading of it, or `null` when it holds none. */
    expected: string | null;
    /** What it read instead, or `null` when it holds none. */
    actual: string | null;
    /** What the caller can change to make the clause pass. */
    remedy: string;
  }>;
}>;

/** The one word for "this clause compared no field it can name". */
export const UNKNOWN_REFUSAL_FIELD = "unknown";

/** The one word for a side of the delta this layer holds no value for. */
const NO_VALUE = "none";

/**
 * One refusal as one sentence, in ONE spelling, so a reader never has to work out which layer answered.
 *
 * This is what the Host's own `Error` messages carry, and it is the sentence the Mod writes beside a settled node's
 * `rejectionCode`: one list of `key=value` pairs on both surfaces, because "which of the four refusals am I looking at"
 * is a question the companion should never have to ask.
 */
export function bodyProgramRefusalText(refusal: BodyProgramRefusal): string {
  return [
    `rejectionCode=${refusal.rejectionCode}`,
    `node=${refusal.failedNodeId ?? NO_VALUE}`,
    `action=${refusal.failedAction ?? NO_VALUE}`,
    `field=${refusal.delta.field}`,
    `expected=${refusal.delta.expected ?? NO_VALUE}`,
    `actual=${refusal.delta.actual ?? NO_VALUE}`,
    `remedy=${refusal.delta.remedy}`,
  ].join(";");
}

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

/**
 * What each clause's delta states, from the node this Host judged and from nothing else.
 *
 * `field` is what the refusal was ABOUT, `actual` the reading that made it fire, `expected` the side the node would have
 * had to be on. None of the three is a value this layer does not hold: the node's action id and the presence of a form
 * document are the whole evidence for these four clauses.
 *
 * <p>
 * THE KEYS ARE THE POPULATION. The type forces every refusal reason into this table, and `body-program-preflight.test.ts`
 * asks the table - not a hand-written list - whether each one answers with a clause, a node, an action and a remedy, so a
 * reason added tomorrow cannot arrive with prose missing.
 * </p>
 */
export const NODE_REFUSAL_DELTAS: Readonly<
  Record<
    NodeRefusalReason,
    Readonly<{ field: string; expected: string | null; actual: (actionId: string) => string; remedy: string }>
  >
> = Object.freeze({
  no_action_id: Object.freeze({
    field: "actionId",
    expected: "present",
    actual: () => "absent",
    remedy: "name the actionId the node runs, then resubmit",
  }),
  unknown_action: Object.freeze({
    field: "actionId",
    expected: "published",
    actual: (actionId: string) => actionId,
    remedy: "use an actionId the attached Mod publishes as an action, then resubmit",
  }),
  action_not_enabled: Object.freeze({
    field: "actionId",
    expected: "enabled",
    actual: (actionId: string) => actionId,
    remedy: "this connection does not offer that action now: re-observe and plan from what it offers",
  }),
  plan_form_not_declared: Object.freeze({
    field: `arguments.${LOOP_ARGUMENT}`,
    expected: NO_VALUE,
    actual: () => "present",
    remedy: "write the node as published actions - a script `for` loop over a snapshot family - not as a plan form",
  }),
});

/** One node's refusal in the envelope's shape, built from the decision and nothing else. */
function bodyProgramNodeRefusal(node: NodeRefusal): BodyProgramRefusal {
  const rule = NODE_REFUSAL_DELTAS[node.reason];
  return Object.freeze({
    rejectionCode: node.reason,
    failedNodeId: node.nodeId,
    failedAction: node.actionId,
    delta: Object.freeze({
      field: rule.field,
      expected: rule.expected,
      actual: rule.actual(node.actionId),
      remedy: rule.remedy,
    }),
  });
}

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
  const shown = refusals
    .slice(0, MAX_REPORTED_NODE_REFUSALS)
    .map((refusal) => bodyProgramRefusalText(bodyProgramNodeRefusal(refusal)));
  const omitted = refusals.length - shown.length;
  return `${shown.join(" | ")}${omitted === 0 ? "" : ` | +${String(omitted)}_more`}`;
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
