/**
 * The companion's greeting as the conversation's own first line.
 *
 * Pi's session is what the model reads, and the transcript's own row zero is the greeting the Chat
 * opened on. Before this module the two disagreed about that line: the greeting was never prompted
 * into the session, so on turn one the model's context was the authored catalogue plus the player's
 * words and it did not know what it had just said to the player - the player's first reply ("the rain
 * came down hard") had no referent. Carrying it as a system-prompt fact instead does not work either:
 * the model reads that as setting, echoes it, and confuses persons. So the mount writes the greeting
 * into the session as its first `assistant` message.
 *
 * THE GUARD. That entry is a read-only history anchor (Order 0). It is written once, while the
 * conversation still carries nothing of its own, and nothing afterwards touches it. An attempt takes
 * the entries that existed before its own prompt as the entries it produced
 * (`bindSettledPromptEntries`), so the anchor can never be attributed to a turn, and the ledger has no
 * turn, attempt, generation or `presentation_commit` for it - it is context the model reads, not a
 * message any operation wrote. The transcript's own rewind and delete refuse row zero by name
 * (`chat_rewind_opening_retained`, `chat_delete_opening_retained`), so nothing drops it from the other
 * side; the one operation that does reach it is the in-place edit (`chat.edit`), which replaces this
 * entry's words for the session exactly as it replaces a reply's, and never touches the reviewed
 * greeting assets.
 *
 * WHAT DECIDES THAT IT IS ALREADY THERE. The session's own entries, which are the only authority that
 * cannot drift from the write: a file that already opens on a line of the conversation is exactly a
 * mount that has already run. No durable marker is added for this, because the anchor IS a session
 * entry and a later mount reads it back. The check is positional on the branch: its first message
 * entry the transcript can carry is the anchor when it is an assistant one, and a greeting the row
 * projection drops (all scaffolding, or longer than a transcript row may hold) is still recognized as
 * the mount's own write by its own words, so it is never written twice.
 */

import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { chatTranscriptAssistantText, chatTranscriptPlayerText } from "./native-companion-content.js";

/**
 * The anchor's own provenance. It is deliberately not the mounted model: the greeting is the
 * companion's authored opening line from the reviewed greeting card, no provider produced it, and
 * naming it as a foreign line keeps it out of the same-model replay paths (`pi-ai`
 * `transformMessages` treats a foreign api/provider/model as cross-model, which is exactly what it
 * is). `stopReason` is the neutral completed value and the usage counters are zero, so nothing in the
 * session accounts a provider response for these words.
 */
const GREETING_ANCHOR_API = "gamebuddy-authored";
const GREETING_ANCHOR_PROVIDER = "gamebuddy";
const GREETING_ANCHOR_MODEL = "companion-greeting";

/** The two Pi capabilities the anchor needs: the session tree and its re-derivation. */
export type PiGreetingAnchorSession = Pick<AgentSession, "sessionManager" | "refreshContext">;

/** One message entry the branch opens with, as the two questions below need it. */
type PiSessionHeadLine = Readonly<{
  entryId: string;
  /** The player's own line, when this entry carries one. */
  player: string | null;
  /** The entry's words as written, or `null` when it carries none; row zero's text is compared to this exactly. */
  words: string | null;
}>;

/** Why this mount wrote no anchor: the session already opens on a line of the conversation. */
type PiGreetingAnchorWithheldReason =
  /** The conversation's own first line is a player line: this Chat's session started before the anchor existed. */
  | "conversation_started"
  /**
   * The session's first line is an assistant one whose words are not row zero's: the opening was
   * re-chosen after the anchor was written, so the two authorities disagree. This mount rewrites
   * nothing and reports it - a mount is not an author of history.
   */
  | "greeting_superseded";

export type PiGreetingAnchorOutcome =
  | Readonly<{ status: "anchored"; entryId: string }>
  | Readonly<{ status: "present" }>
  | Readonly<{ status: "withheld"; reason: PiGreetingAnchorWithheldReason }>;

/**
 * Writes `greeting` into the session as the conversation's first assistant message, once.
 *
 * It writes only while the branch carries no line of the conversation (the session's own entries are
 * the authority: see the module doc), refreshes the live agent context so the very next prompt reads
 * it, and returns the entry it appended. Every later mount finds the anchor already there.
 */
export function anchorPiSessionGreeting(session: PiGreetingAnchorSession, greeting: string): PiGreetingAnchorOutcome {
  const head = firstTranscriptLine(session.sessionManager);
  if (head === undefined) {
    // The conversation carries no line the transcript could hold: either the branch is still empty and
    // this mount writes the anchor, or it already opens on an assistant line the row projection drops -
    // and then the mount's own write is there and is not written a second time.
    if (opensOnAssistantLine(session.sessionManager)) return Object.freeze({ status: "present" });
    const entryId = session.sessionManager.appendMessage(greetingAnchorMessage(greeting));
    // The live context is derived from the session only by this call (`agent-session.js`
    // `_refreshFinalizedContext`); without it the first prompt would read the pre-mount state.
    session.refreshContext();
    return Object.freeze({ status: "anchored", entryId });
  }
  if (head.player !== null) return Object.freeze({ status: "withheld", reason: "conversation_started" });
  return head.words === greeting
    ? Object.freeze({ status: "present" })
    : Object.freeze({ status: "withheld", reason: "greeting_superseded" });
}

/**
 * Whether the greeting anchor holds the first position among the entries that carry a transcript line -
 * the one fact the mounted mutations' positional proofs have to add to the transcript's own row order.
 *
 * The model's carried entries are the anchor (when the mount carried the greeting) followed by each
 * row after the opening, in order, so a row's position among them is its position among those rows
 * plus that one entry. It reduces to the rows alone for a Chat that opened on nothing, for a session
 * that predates the anchor, and for a greeting the row projection drops (an entry that holds no
 * transcript line holds no position either).
 */
export function greetingAnchorOccupiesFirstTranscriptEntry(session: Pick<SessionManager, "getBranch">): boolean {
  const head = firstTranscriptLine(session);
  return head !== undefined && head.player === null;
}

/**
 * The branch's first message entry that carries a transcript line, with the entry's words as written.
 *
 * "Carries a transcript line" is the projection pair the rows themselves were written from
 * (`chatTranscriptPlayerText` for a player line, `chatTranscriptAssistantText` for a reply), so an
 * entry a row can never hold - the Host's own system prompt, a tool result, a reply of pure
 * scaffolding - carries no position and is passed over.
 */
function firstTranscriptLine(session: Pick<SessionManager, "getBranch">): PiSessionHeadLine | undefined {
  for (const entry of session.getBranch()) {
    if (entry.type !== "message") continue;
    if (chatTranscriptPlayerText(entry.message) === null && chatTranscriptAssistantText(entry.message) === null)
      continue;
    return headLineOf(entry);
  }
  return undefined;
}

/**
 * Whether the branch's first message entry that speaks is an assistant one. A conversation's first
 * spoken entry is a player line unless a mount wrote the anchor before it, which is what makes this
 * the anchor's signature even where the row projection drops its words.
 */
function opensOnAssistantLine(session: Pick<SessionManager, "getBranch">): boolean {
  for (const entry of session.getBranch()) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
    return entry.message.role === "assistant";
  }
  return false;
}

function headLineOf(entry: SessionEntry & { type: "message" }): PiSessionHeadLine {
  return Object.freeze({
    entryId: entry.id,
    player: chatTranscriptPlayerText(entry.message),
    words: messageWords(entry.message),
  });
}

/**
 * The words one Pi message carries as written: its content, joined text part for text part. The
 * projection pair above answers what a durable transcript row holds for an entry, which drops model
 * scaffolding, trims and normalizes; this answers what the entry itself says, which is what the anchor
 * wrote and therefore what row zero's text is compared against.
 */
function messageWords(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length === 0 ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("");
}

/** The one anchor message shape, complete because Pi's assistant message requires its provenance. */
function greetingAnchorMessage(greeting: string): Parameters<SessionManager["appendMessage"]>[0] {
  return {
    role: "assistant",
    content: [{ type: "text", text: greeting }],
    api: GREETING_ANCHOR_API,
    provider: GREETING_ANCHOR_PROVIDER,
    model: GREETING_ANCHOR_MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
