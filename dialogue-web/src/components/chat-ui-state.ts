import type { ChatModelRoute } from "../chat-model-route";

/**
 * The one state the Chat surface's controls are rendered from.
 *
 * The surface used to be driven by a handful of independent booleans and nullable handles - a turn
 * in flight, a second one for "the Host would let you stop it", a third for the field's lock, a
 * fourth for "a reply has no model", and three separate armed-message handles. Each combination
 * those flags could take was reachable in the type even where the product forbids it: a Stop with no
 * turn to stop, two confirmations open on two rows, a submission whose text had nowhere to live.
 *
 * The state below is that whole question as one value, so a control reads its own enablement, its
 * disabled state and its label from `switch (uiState.phase)` and an illegal combination has no shape
 * to be written in.
 */

/**
 * The one act the surface is asking the player to confirm, with the fact the row it belongs to was
 * rendered at.
 *
 * It is one value rather than one nullable handle per verb: two confirmations open at once would
 * leave the player unable to tell what the next press removes, so the shell holds exactly one of
 * these and arming a second act replaces the first by construction instead of by three handlers each
 * remembering to clear the other two.
 *
 * `from_here` is the choice a message offers over what comes after it - fork the conversation here, or
 * rewind back to it - and it is armed like the destructive ones even though only one of its two answers
 * removes anything: the player has to be told what each branch does before the press that does it, and the
 * destructive answer must never be the button beside a quiet one.
 */
export type ChatArmedAction =
  | Readonly<{ action: "delete"; targetId: string; expectedOrder: number }>
  | Readonly<{ action: "from_here"; targetId: string; expectedOrder: number }>
  | Readonly<{ action: "swipe_remove"; targetId: string }>;

/**
 * Why a message written in this field would not go out.
 *
 * Two facts, four states: the Host would not take a submission now (`chat.submit` is not available -
 * a turn exists, a submission is in flight, or the surface is not mounted), and a reply has no model
 * to reach (`ChatModelRoute` is `none`). They are independent - a turn can be streaming while the
 * connection it started on has since been deactivated - and both refuse the SEND. One value, so the
 * button's disabled state and the standing sentence above it are read from the same answer instead
 * of two spellings of it.
 *
 * Neither is a fact about the FIELD. The box is where the next line is written while this one is
 * answered - the ordinary case, and what every mainstream chat client does - so no state here may
 * disable it. The variants are named `refused` rather than `locked` for exactly that reason: the
 * gate answers a question about sending, and a reader who mistakes it for the field's lock re-creates
 * the defect this vocabulary was renamed out of.
 */
export type ChatSendGate =
  /** A send would be accepted and would reach a model. */
  | Readonly<{ gate: "open" }>
  /** The Host would not take a submission now, or this surface is rewriting the transcript. */
  | Readonly<{ gate: "refused" }>
  /** The Host would take it, but nothing would answer it. */
  | Readonly<{ gate: "no_model" }>
  /** Both: the send is refused, and there is still nothing to send to. */
  | Readonly<{ gate: "refused_no_model" }>;

/**
 * The optimistic player line: the text just sent, shown on the transcript until the authoritative
 * row lands. `idempotencyKey` is the submission's own identity and the pending row is keyed by it
 * (`Timeline`), which is why the line travels as a pair rather than as bare text.
 */
type ChatPendingLine = Readonly<{ idempotencyKey: string; text: string }>;

/** The facts that are true of the surface whichever phase it is in. */
type ChatUIFacts = Readonly<{
  send: ChatSendGate;
  armed: ChatArmedAction | null;
  pendingLine: ChatPendingLine | null;
}>;

/**
 * What the conversation itself is doing.
 *
 * `submitting` and `streaming` are two phases rather than one "busy" flag because they answer the
 * only question the action slot asks differently: a submission the Host holds but has not mounted a
 * turn for has nothing to cancel yet, while a mounted turn may be the player's to stop.
 *
 * `armed` is deliberately NOT a phase. A row's confirmation does not displace the turn: the row's
 * destructive controls stay live while a reply streams (their `busy` is the message mutation, not
 * the turn - `MessageBubble`), so a flat `armed` phase would have to drop `turnId` and `canStop` and
 * the Stop control would vanish from under the player the moment they armed a delete.
 */
export type ChatUIState =
  | (ChatUIFacts & Readonly<{ phase: "idle" }>)
  | (ChatUIFacts & Readonly<{ phase: "submitting" }>)
  | (ChatUIFacts & Readonly<{ phase: "streaming"; turnId: string; canStop: boolean }>);

/** The facts the surface is derived from, exactly as the shell holds them. */
export type ChatUIStateInputs = Readonly<{
  /** The Host holds a submission for this conversation whose disposition is not terminal yet. */
  submissionInFlight: boolean;
  /** The mounted turn, while it has not reached a terminal state. */
  turn: Readonly<{ handle: string; canCancel: boolean }> | null;
  /** The optimistic player line, while the shell still holds its submission. */
  pendingLine: ChatPendingLine | null;
  /** True only while the Host says this exact turn can be cancelled now. */
  stopAvailable: boolean;
  /** True while the Host would accept a submission now (`chat.submit` availability). */
  submitAvailable: boolean;
  /**
   * True while this surface is rewriting the mounted conversation (a rewind truncating it, an edit,
   * a delete, a variant discard, a regeneration).
   *
   * It is not a second "busy": it is the reason a submission cannot be admitted right now, and the
   * reason is not in the snapshot - the store is idle until the command lands, so `chat.submit` still
   * reads available. Every message mutation takes the same single-flight latch, so reading it here
   * makes the gate and the mutations answer the one question with the one fact: a surface that is
   * changing the transcript has no room for a message written into it.
   */
  messageMutationInFlight: boolean;
  /** The route a message written here would reach a model through. */
  modelRoute: ChatModelRoute;
  /** The one destructive act being confirmed, if any. */
  armed: ChatArmedAction | null;
}>;

/**
 * The surface's state, from the facts the shell holds.
 *
 * A mounted turn outranks a held submission: while both are true the turn is the thing the player
 * can act on, and its own `canStop` is what the action slot offers. A turn with no submission behind
 * it - a reload, or a conversation read back mid-turn - is the same phase for the same reason.
 */
export function deriveChatUIState(inputs: ChatUIStateInputs): ChatUIState {
  const send = sendGate(inputs.submitAvailable, inputs.messageMutationInFlight, inputs.modelRoute);
  const armed = inputs.armed;
  const pendingLine = inputs.pendingLine;
  if (inputs.turn !== null) {
    return { phase: "streaming", turnId: inputs.turn.handle, canStop: inputs.stopAvailable, send, armed, pendingLine };
  }
  if (inputs.submissionInFlight) return { phase: "submitting", send, armed, pendingLine };
  return { phase: "idle", send, armed, pendingLine };
}

function sendGate(
  submitAvailable: boolean,
  messageMutationInFlight: boolean,
  modelRoute: ChatModelRoute,
): ChatSendGate {
  const noModel = modelRoute.kind === "none";
  if (!submitAvailable || messageMutationInFlight) return { gate: noModel ? "refused_no_model" : "refused" };
  return { gate: noModel ? "no_model" : "open" };
}

/** Send is refused whenever the gate is anything but open; the draft text decides the rest. */
export function sendRefused(send: ChatSendGate): boolean {
  return send.gate !== "open";
}

/** A reply written here would have no model to reach, which is the standing sentence's own fact. */
export function replyHasNoModel(send: ChatSendGate): boolean {
  return send.gate === "no_model" || send.gate === "refused_no_model";
}

/**
 * The row each confirmation is open on, if any.
 *
 * `Timeline` takes one nullable handle per verb because a row asks only "is this mine"; this is the
 * one place the surface's single arm is spelled back into that per-row shape, so no second reader
 * has to know how the arm is stored.
 */
export function armedRows(state: ChatUIState): Readonly<{
  swipeRemove: string | null;
  fromHere: string | null;
  delete: string | null;
}> {
  const armed = state.armed;
  return {
    swipeRemove: armed?.action === "swipe_remove" ? armed.targetId : null,
    fromHere: armed?.action === "from_here" ? armed.targetId : null,
    delete: armed?.action === "delete" ? armed.targetId : null,
  };
}

/**
 * The turn the surface is showing is in flight: the one fact `Timeline` reads to withhold Regenerate
 * from a player's tail row, which a live turn may still answer.
 */
export function isTurnInFlight(state: ChatUIState): boolean {
  return state.phase !== "idle";
}

/**
 * A phase the surface cannot enter is a compile error rather than a fallback.
 *
 * Every `switch (state.phase)` in the components ends here, so a phase added to the union without a
 * control decision for it fails `tsc` instead of silently rendering the idle branch.
 */
export function assertKnownPhase(state: never): never {
  throw new Error(`unhandled chat UI phase: ${String((state as { phase?: unknown } | null)?.phase)}`);
}
