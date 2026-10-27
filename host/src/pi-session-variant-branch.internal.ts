/**
 * The Pi-side half of the three Chat operations that reshape a conversation for the model.
 *
 * One is a same-position variant turn (`branchPiVariantAnchor`), one a rewind
 * (`rewindPiTranscriptTail`), one an in-place edit of a message the conversation already carries
 * (`editPiTranscriptEntry`). All three make the model's ACTIVE PATH equal the transcript the player
 * reads, all three refuse a session shape they cannot prove, and each hands its caller a `revert()`,
 * because the store and Pi cannot be atomic.
 *
 * They differ in what the session file ends with, and that is what decides each one's mechanism. Pi
 * appends the prompt and the reply as children of the current leaf, and `SessionManager._buildIndex`
 * resets the leaf to the file's LAST entry whenever a session is re-opened
 * (`runtime-core.internal.ts` mounts one with `SessionManager.continueRecent`), so a leaf pointer is
 * not itself durable. The variant half is safe because a prompt always follows it - the new reply
 * becomes the file's last entry, and the path to it excludes the reply it replaced. A rewind appends
 * nothing, so a bare leaf move would be undone by the next mount: the dropped turns would come back
 * into the model's context while the transcript the player reads stayed shortened. The rewind half
 * therefore makes the cut durable with the vendor's own append-only edit - see
 * `rewindPiTranscriptTail`. The edit half appends that same kind of edit and nothing else: the
 * replacement is the file's last entry, so it survives a re-open, and the entries after the edited
 * one stay on the path - only the one entry's contribution changes.
 *
 * The variant half, in detail:
 *
 * The visible transcript and the model's context are two authorities: the
 * transcript is the store's own message row, while what a request carries is
 * Pi's own append-only session tree (`SessionManager`, `runtime-core.internal.ts`).
 * Pi appends the prompt and the reply as children of the current leaf, so
 * re-asking one player line on the same leaf would leave both the old and the
 * new reply on the path and the player's line twice. This module regenerates the
 * way the session tree itself is built: move the leaf to the entry before the
 * player's line, so the next prompt appends one fresh player line and one reply
 * there. The projection the next request carries is then exactly one player
 * line and one reply, and the reply the player replaced is off the active
 * branch instead of duplicated in it.
 *
 * TRANSITIONAL BINDING. The session-shape facts below stand in for a durable
 * Host-message-id to Pi-entry-id binding, which no authority records yet; the
 * durable owner is the prepared-response transaction and branch binding of
 * `design/archive/legacy-sources/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md:341`.
 * Until that exists, this derivation is the only exact one available, so it
 * proves rather than guesses: the branch's newest reply must carry one of the
 * position's own committed variant texts, and the player line before it must
 * carry the exact text this turn is re-asking. A shape it cannot prove refuses,
 * and the caller must then leave the position unchanged.
 *
 * The walk consumes every consecutive `[player line, reply]` pair the position
 * owns. A session a previous same-leaf regeneration polluted
 * (`[…, P, A1, P, A2]`) is therefore cut back to before its first `P` in one
 * branch, exactly like a clean one, so the fix also repairs the shape the
 * context-edit mechanism left behind.
 */

import type {
  AgentSession,
  ContextEditableContent,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { chatTranscriptAssistantText, chatTranscriptPlayerText } from "./native-companion-content.js";

/** Every variant text one durable reply position has committed, oldest first. */
export type PiVariantPosition = Readonly<{ variantTexts: readonly string[] }>;

/**
 * Why a refused branch left the model's context exactly as it was. Each reason
 * is a statement about the session shape a same-position turn expected and did
 * not find, so the caller refuses the visible variant instead of branching an
 * entry it cannot prove belongs to the position.
 */
type PiVariantBranchRefusal =
  | "variant_position_has_no_variant"
  | "variant_reply_tail_unavailable"
  | "variant_reply_tail_text_mismatch"
  | "variant_anchor_unavailable";

export type PiVariantBranchResult =
  | Readonly<{
      status: "branched";
      /**
       * Puts the leaf back where it was before this branch, so a variant that
       * never became visible leaves the model's context exactly as it found it.
       * The store and Pi cannot be atomic, so the caller owns this compensation
       * when its durable commit refuses.
       */
      revert(): void;
    }>
  | Readonly<{ status: "refused"; reason: PiVariantBranchRefusal }>;

/** The branched half of a variant branch, which its caller keeps to revert it. */
export type PiVariantBranch = Extract<PiVariantBranchResult, { status: "branched" }>;

/** The two Pi capabilities this operation needs: the session tree and its re-derivation. */
export type PiVariantBranchSession = Pick<AgentSession, "sessionManager" | "refreshContext">;

/**
 * Moves the active leaf to the entry before `anchorText`'s player line, so the
 * next prompt appends one player line and one reply there and the projection
 * carries each exactly once.
 */
export function branchPiVariantAnchor(
  session: PiVariantBranchSession,
  position: PiVariantPosition,
  anchorText: string,
): PiVariantBranchResult {
  if (position.variantTexts.length === 0) return { status: "refused", reason: "variant_position_has_no_variant" };
  const messages = branchMessageEntries(session);
  const tail = messages[messages.length - 1];
  if (tail === undefined || tail.reply === null) return { status: "refused", reason: "variant_reply_tail_unavailable" };
  if (!position.variantTexts.includes(tail.reply))
    return { status: "refused", reason: "variant_reply_tail_text_mismatch" };
  let anchor = tail;
  let cursor = messages.length - 1;
  while (cursor - 1 >= 0) {
    const player = messages[cursor - 1];
    const reply = messages[cursor];
    if (reply === undefined || reply.reply === null) break;
    if (!position.variantTexts.includes(reply.reply)) break;
    if (player === undefined || player.player !== anchorText) break;
    anchor = player;
    cursor -= 2;
  }
  if (anchor === tail) return { status: "refused", reason: "variant_anchor_unavailable" };
  return branchedTo(session, anchor.parentId);
}

/**
 * The rewind half: makes every dropped transcript row contribute nothing to the model, durably.
 *
 * TRANSITIONAL BINDING, the same one `branchPiVariantAnchor` documents: no authority records which
 * Pi entry a durable `tavern_messages` row corresponds to, so the proof is positional. The session
 * branch's own newest message entries must carry the dropped messages, in order, with the exact
 * role and text the transcript holds - Pi appends the prompt the Host passed and the reply the
 * provider returned, so a healthy transcript's tail matches entry for entry. A shape it cannot
 * prove refuses, and the caller must then leave the transcript unchanged.
 *
 * What it does with that proof is two shapes of ONE vendor mechanism, chosen by what survives:
 *
 *   - The transcript keeps a message the model still carries: move the leaf to that entry and
 *     append a no-op context edit OF ITS OWN CONTENT. That edit is a child of the kept entry, so
 *     the session file now ends on the kept side of the cut, and re-opening the session lands the
 *     leaf there - the dropped entries are not merely passed over, they are off the path.
 *   - The transcript keeps nothing the model carries (a rewind back to an empty conversation, or
 *     back to nothing but the greeting, which is never prompted): there is no kept entry to pin the
 *     cut to, so every dropped entry is omitted instead, with one `null` replacement each. The last
 *     such edit is then the file's last entry, which is what makes the omission survive a re-open.
 *
 * The dropped messages are every row AFTER the one the player named, which is why the proof is a
 * suffix and not a single lookup: the named row is the one the cut is pinned to - it is what the
 * transcript now ends at - and a session a rewind already shortened still carries the rows the player
 * kept, so a second rewind from an earlier point still matches. An empty suffix is not a refusal: the
 * transcript's own last row asks for nothing to be removed, and the cut then lands on the entry the
 * conversation already ends at.
 */
export function rewindPiTranscriptTail(
  session: PiVariantBranchSession,
  dropped: readonly PiTranscriptMessage[],
): PiTranscriptRewindResult {
  const messages = branchMessageEntries(session);
  if (messages.length < dropped.length) return { status: "refused", reason: "rewind_tail_unavailable" };
  const start = messages.length - dropped.length;
  for (const [offset, expected] of dropped.entries()) {
    const entry = messages[start + offset];
    const actual = expected.role === "player" ? entry?.player : entry?.reply;
    if (actual !== expected.text) return { status: "refused", reason: "rewind_tail_text_mismatch" };
  }
  const kept = start === 0 ? undefined : messages[start - 1];
  const keptContent = kept === undefined ? null : editableContentOf(session.sessionManager.getEntry(kept.id));
  // The kept entry has to be one an edit can put back byte for byte; an entry that carries no
  // editable model content (a bash or tool entry between two messages) cannot pin the cut, so the
  // rewind refuses rather than cutting with nothing durable behind it.
  if (kept !== undefined && keptContent === null) return { status: "refused", reason: "rewind_keep_unavailable" };
  const previousLeafId = session.sessionManager.getLeafId();
  if (kept === undefined || keptContent === null) {
    for (const entry of messages.slice(start)) session.sessionManager.appendContextEdit(entry.id, null);
  } else {
    branchTo(session, kept.id);
    session.sessionManager.appendContextEdit(kept.id, { content: keptContent });
  }
  session.refreshContext();
  return Object.freeze({
    status: "rewound",
    revert: (): void => {
      branchTo(session, previousLeafId);
    },
  });
}

/** One Chat transcript message a rewind drops, as the transcript itself holds it. */
export type PiTranscriptMessage = Readonly<{ role: "player" | "companion"; text: string }>;

/**
 * The one mount-time alignment: after the Pi session is reopened, take back whatever it still carries past the transcript's
 * own last row.
 *
 * The store and the session are two authorities over one conversation. A delete or a rewind performed while nothing was
 * mounted changes only the store - there is no live session to reshape - and re-opening the session file lands the leaf where
 * the file last ended, which resurrects exactly the rows the player removed. This is that disagreement, settled the same way a
 * mounted rewind settles it: the kept prefix is proved text by text against what the session still carries, and the tail past
 * it is cut with the same append-only edit, so the cut survives the next re-open too.
 *
 * Refusals are reported rather than thrown. A mount whose session shape this function cannot prove is still a mount - the
 * player's conversation must open - and a silent cut would damage a conversation on a guess.
 */
export function alignSessionToTranscriptRows(
  session: PiVariantBranchSession,
  rows: readonly Readonly<{ role: string; text: string }>[],
): Readonly<{ status: "aligned"; dropped: number }> | Readonly<{ status: "refused"; reason: string }> {
  const messages = branchMessageEntries(session);
  // What each side thinks the conversation is, in the same shape: a player line or a companion line, with its text.
  const sessionRows = messages.map((entry, index) =>
    Object.freeze({
      role: entry.player !== null ? ("player" as const) : ("companion" as const),
      text: (entry.player ?? entry.reply ?? "").trim(),
      index,
    }),
  );
  const expected = rows.map((row) =>
    Object.freeze({
      role: row.role === "player" ? ("player" as const) : ("companion" as const),
      text: row.text.trim(),
    }),
  );
  if (sessionRows.length <= expected.length) return Object.freeze({ status: "aligned", dropped: 0 });
  // The prefix has to be the same conversation before anything is cut: this is a re-alignment, not a repair.
  for (const [offset, row] of expected.entries()) {
    const actual = sessionRows[offset];
    if (actual === undefined || actual.role !== row.role || actual.text !== row.text)
      return Object.freeze({ status: "refused", reason: "transcript_prefix_mismatch" });
  }
  const trailing = sessionRows.slice(expected.length);
  const dropped = trailing.map((row): PiTranscriptMessage => Object.freeze({ role: row.role, text: row.text }));
  // An empty companion reply cannot be proved byte for byte, so it is left alone rather than cut on a guess.
  if (dropped.some((row) => row.text.length === 0))
    return Object.freeze({ status: "refused", reason: "trailing_row_unprovable" });
  const rewound = rewindPiTranscriptTail(session, dropped);
  if (rewound.status !== "rewound") return Object.freeze({ status: "refused", reason: rewound.reason });
  return Object.freeze({ status: "aligned", dropped: dropped.length });
}

/** Why a refused rewind left the model's context exactly as it was. */
type PiTranscriptRewindRefusal = "rewind_tail_unavailable" | "rewind_tail_text_mismatch" | "rewind_keep_unavailable";

export type PiTranscriptRewindResult =
  | Readonly<{
      status: "rewound";
      /**
       * Puts the leaf back where it was, so a rewind whose durable truncation refused leaves the
       * model's context exactly as it found it. The store and Pi cannot be atomic, so the caller
       * owns this compensation when its durable commit refuses.
       */
      revert(): void;
    }>
  | Readonly<{ status: "refused"; reason: PiTranscriptRewindRefusal }>;

/** Why a refused edit left the model's context exactly as it was. Each reason is a statement about
 * the entry the caller named and the session did not carry, so the caller refuses instead of
 * replacing text in an entry it cannot prove belongs to the message the player is looking at. */
type PiTranscriptEditRefusal = "edit_target_unavailable";

export type PiTranscriptEditResult =
  | Readonly<{
      status: "edited";
      /**
       * Puts the entry's own original contribution back, as another append-only edit of the same
       * entry, so a store write that refuses leaves the model reading the transcript it did before -
       * and leaves the session file agreeing with that, because the restoring edit is the file's last
       * entry. The store and Pi cannot be atomic, so the caller owns this compensation when its
       * durable commit refuses.
       */
      revert(): void;
    }>
  | Readonly<{ status: "refused"; reason: PiTranscriptEditRefusal }>;

/**
 * One entry the model carries, as the transcript row it contributes: the entry an edit names, the row's
 * role, the exact words that row holds, and the contribution an edit replaces and a revert puts back
 * (`null` for a message an edit could not replace).
 */
type PiModelCarriedRow = Readonly<{
  id: string;
  role: "player" | "companion";
  text: string;
  content: ContextEditableContent | null;
}>;

/**
 * The entries the model's own context carries, in order, as the transcript rows they contribute.
 *
 * Read off the session's projection rather than its branch, because a context edit changes what an
 * entry contributes without changing the entry: an entry the player already rewrote contributes its
 * new words - and they are also what a revert of a later edit has to put back, since a store write that
 * refuses leaves the row holding exactly those words. An entry that contributes no transcript line -
 * the Host's own system prompt, a tool result, a reply of pure scaffolding - contributes no row either.
 */
function modelCarriedRows(session: PiVariantBranchSession): readonly PiModelCarriedRow[] {
  const rows: PiModelCarriedRow[] = [];
  for (const { sourceEntry, messages } of session.sessionManager.buildSessionProjection().entries) {
    if (sourceEntry.type !== "message") continue;
    for (const message of messages) {
      const content = editableContentOfMessage(message);
      const player = chatTranscriptPlayerText(message);
      if (player !== null)
        rows.push(Object.freeze({ id: sourceEntry.id, role: "player" as const, text: player, content }));
      const reply = chatTranscriptAssistantText(message);
      if (reply !== null)
        rows.push(Object.freeze({ id: sourceEntry.id, role: "companion" as const, text: reply, content }));
    }
  }
  return rows;
}

/**
 * The exact content one projected message contributes, or `null` for a message a context edit could not
 * replace. Pairing names the entry by its words, so this answers the one question an edit still has:
 * what to replace, and what a refused store write puts back.
 */
function editableContentOfMessage(message: unknown): ContextEditableContent | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return null;
  return value.content as ContextEditableContent;
}

/**
 * Pairs every transcript row with the entry that carries it: the next entry contributing exactly that
 * row's words in that row's role, over the entries between them that no row names. One slot per row,
 * `null` where the session carries nothing for that row.
 *
 * A row the session carries nothing for consumes no entry, because one disagreement in the middle of a
 * conversation - a turn whose Pi prompt carried words its transcript row does not, which is refused as
 * its own row - must not accuse every row after it. The rows that do pair keep their order, which is
 * what tells two rows of the same words apart, and the row the player named is the one the caller reads.
 */
function pairTranscriptRows(
  entries: readonly PiModelCarriedRow[],
  rows: readonly PiTranscriptMessage[],
): readonly (PiModelCarriedRow | null)[] {
  const paired: (PiModelCarriedRow | null)[] = [];
  let cursor = 0;
  for (const row of rows) {
    const start = cursor;
    while (cursor < entries.length && (entries[cursor]!.role !== row.role || entries[cursor]!.text !== row.text)) {
      cursor += 1;
    }
    const entry = entries[cursor];
    if (entry === undefined) {
      cursor = start;
      paired.push(null);
      continue;
    }
    paired.push(entry);
    cursor += 1;
  }
  return paired;
}

/**
 * The edit half: one entry the model already carries contributes `text` from now on.
 *
 * TRANSITIONAL BINDING, the same one the other two halves document: no authority records which Pi
 * entry a durable `tavern_messages` row corresponds to, so the proof is the pairing of the two
 * sequences. `rows` are the transcript rows up to and including the one the player named, and each one
 * is paired with the next entry that contributes exactly that row's words in that row's role - so an
 * entry no row names (the Host's own system prompt, an intermediate tool-use commentary, a greeting
 * anchor whose words the row projection drops) is passed over instead of occupying a position, and the
 * LAST paired entry is the target. The row the player named must pair - one the model carries nothing
 * for refuses as `edit_target_unavailable` - and a paired entry whose contribution an edit cannot
 * replace refuses; a shape it cannot prove refuses and the caller must
 * then leave the transcript unchanged.
 *
 * What it does with that proof is the vendor's append-only edit of one entry: the target keeps its
 * place on the active path, the entries after it stay on it, and only its contribution changes. The
 * appended edit is the session file's last entry, so a mount that re-opens the file lands on it and
 * the replacement is what the next request carries - the same durability the rewind pins its cut
 * with, in the one shape that fits a conversation that is not being shortened.
 */
export function editPiTranscriptEntry(
  session: PiVariantBranchSession,
  rows: readonly PiTranscriptMessage[],
  text: string,
): PiTranscriptEditResult {
  const paired = pairTranscriptRows(modelCarriedRows(session), rows);
  const target = paired[paired.length - 1];
  if (target === undefined || target === null) return { status: "refused", reason: "edit_target_unavailable" };
  // The contribution the entry makes now is what a revert puts back, and it is the fact the pairing
  // above cannot answer: pairing names the entry by its words, while an edit replaces its content.
  // Unreachable in the shapes the product writes (see the union's note), but a session whose entry cannot be
  // replaced must still refuse rather than write: the refusal is the same one - this session cannot edit it.
  if (target.content === null) return { status: "refused", reason: "edit_target_unavailable" };
  const original = target.content;
  session.sessionManager.appendContextEdit(target.id, { content: editedContentOf(original, text) });
  session.refreshContext();
  return Object.freeze({
    status: "edited",
    revert: (): void => {
      session.sessionManager.appendContextEdit(target.id, { content: original });
      session.refreshContext();
    },
  });
}

/**
 * The one Pi capability the binding capture reads: the session's own append-only entry list. Taking
 * the manager rather than the session keeps the capture usable from a runner that holds the runtime
 * session, without reaching through the agent session for something the runtime already exposes.
 */
export type PiSessionEntrySource = Pick<SessionManager, "getEntries">;

/**
 * Every entry id a session currently carries, as the starting point for "what did this prompt
 * append". Pi's session is append-only, so a set difference across one prompt names the entries
 * that prompt produced and nothing else.
 */
export function sessionEntryIds(source: PiSessionEntrySource): ReadonlySet<string> {
  return new Set(source.getEntries().map((entry) => entry.id));
}

/**
 * What one settled prompt appended, resolved to the durable rows a turn writes.
 *
 * This is the durable binding the other three shapes all document a stand-in for
 * ("TRANSITIONAL BINDING"): which Pi entry a `tavern_messages` row is carried by. Pi persists the
 * prompt it was given and the provider's reply as its own `message` entries
 * (`SessionManager.appendMessage`, called from `agent-session.js` `_handleAgentEvent` on
 * `message_end`), but that id reaches no session listener - `entry_appended` is emitted only for
 * extension, boundary, recovery, cache-warmer and custom-entry appends - and `AgentSession` keeps
 * its own message -> entry map private. The exact fact Pi does expose is the session itself: the
 * entries are append-only and readable, so the entries that did not exist before this prompt are
 * exactly the ones it produced.
 *
 * Which of those carries WHICH row is then a content question, and it is answered with the same
 * projection the row was written from (`chatTranscriptPlayerText` for a player row,
 * `chatTranscriptAssistantText` for a reply row, both of which the transcript itself uses). A role
 * with zero or more than one candidate is not proof, so that row records no binding at all - never
 * "the nth entry of that role", which is the positional stand-in this exists to replace.
 */
export function bindSettledPromptEntries(
  source: PiSessionEntrySource,
  entriesBefore: ReadonlySet<string>,
  expected: Readonly<{ playerText: string; replyText: string | null }>,
): readonly Readonly<{ role: "player" | "companion"; entryId: string }>[] {
  const appended = source.getEntries().filter((entry) => !entriesBefore.has(entry.id));
  const bindings: Readonly<{ role: "player" | "companion"; entryId: string }>[] = [];
  const playerEntry = uniqueAppendedEntry(
    appended,
    (message) => chatTranscriptPlayerText(message) === expected.playerText,
  );
  if (playerEntry !== null) bindings.push(Object.freeze({ role: "player", entryId: playerEntry }));
  if (expected.replyText !== null) {
    const replyEntry = uniqueAppendedEntry(
      appended,
      (message) => chatTranscriptAssistantText(message) === expected.replyText,
    );
    if (replyEntry !== null) bindings.push(Object.freeze({ role: "companion", entryId: replyEntry }));
  }
  return Object.freeze(bindings);
}

/** The one appended message entry a projection names, or `null` when none or several do. */
function uniqueAppendedEntry(appended: readonly SessionEntry[], matches: (message: unknown) => boolean): string | null {
  const matched = appended.filter(
    (entry) => entry.type === "message" && matches((entry as { message?: unknown }).message),
  );
  return matched.length === 1 ? matched[0]!.id : null;
}

/**
 * The one entry a single-row delete may omit: exactly one of the row's recorded entries is on the
 * model's own active path. A row carried by two path entries at once is ambiguous, and a row whose
 * every recorded entry is off the path has no contribution left to remove, so both answer `null` -
 * the caller refuses rather than omitting an entry it cannot prove is the row the player named.
 */
export function boundEntryOnActivePath(
  session: PiVariantBranchSession,
  boundEntryIds: readonly string[],
): string | null {
  if (boundEntryIds.length === 0) return null;
  const onPath = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
  const present = [...new Set(boundEntryIds)].filter((entryId) => onPath.has(entryId));
  return present.length === 1 ? present[0]! : null;
}

/** Why a refused single-row delete left the model's context exactly as it was. */
type PiTranscriptDeleteRefusal = "delete_target_unavailable" | "delete_target_off_path";

export type PiTranscriptDeleteResult =
  | Readonly<{
      status: "deleted";
      /**
       * Puts the entry's own contribution back, as another append-only edit, so a store write that
       * refuses leaves the model reading the transcript it did before. The tool and the session
       * cannot be atomic, so the caller owns this compensation when its durable commit refuses.
       */
      revert(): void;
    }>
  | Readonly<{ status: "refused"; reason: PiTranscriptDeleteRefusal }>;

/**
 * The delete half: ONE entry the model carries stops contributing anything, and everything after it
 * stays on the path.
 *
 * This is the mirror image of the edit's refusal of a cut, and it is why a delete needs the durable
 * binding: the rewind drops a suffix and proves that suffix positionally, but a hole in the middle
 * has to name the exact entry the player pointed at, because there is no tail to match against and
 * no way to tell two entries of the same role apart by position.
 *
 * What it does with that entry is the vendor's append-only edit of it with `null`: the entry keeps
 * its place, the entries after it keep theirs, and only its contribution disappears. The appended
 * edit is the session file's LAST entry, so a mount that re-opens the file lands on it and reads the
 * hole - the same durability the rewind pins its cut with, in the one shape that leaves a gap
 * instead of shortening the path.
 *
 * What the Transcript is NOT: the durable row this entry was carried by is removed too, so the
 * player's transcript shows a gap exactly where the model's path shows one. Memory is a separate
 * store with its own records; a fact promoted from this exchange is not a view of it and is not
 * retracted by removing it (`design/40` - the Chat transcript and the Memory partition are separate
 * durability scopes).
 */
export function deletePiTranscriptEntry(session: PiVariantBranchSession, entryId: string): PiTranscriptDeleteResult {
  const entry = session.sessionManager.getEntry(entryId);
  const original = entry === undefined ? null : editableContentOf(entry);
  if (original === null) return { status: "refused", reason: "delete_target_unavailable" };
  if (!session.sessionManager.getBranch().some((candidate) => candidate.id === entryId))
    return { status: "refused", reason: "delete_target_off_path" };
  session.sessionManager.appendContextEdit(entryId, null);
  session.refreshContext();
  return Object.freeze({
    status: "deleted",
    revert: (): void => {
      session.sessionManager.appendContextEdit(entryId, { content: original });
      session.refreshContext();
    },
  });
}

/**
 * One entry's content with its text replaced, in the shape the entry already has: an edit changes the
 * words the model reads, never the shape of the message it reads them from, so a part array stays a
 * part array and a plain string stays a plain string.
 */
function editedContentOf(original: ContextEditableContent, text: string): ContextEditableContent {
  return Array.isArray(original) ? [{ type: "text", text }] : text;
}

/**
 * The exact content one session entry contributes, when an edit could put it back: `null` for an
 * entry that contributes no editable model content, which is also the one shape a rewind cannot pin
 * a cut to.
 */
function editableContentOf(
  entry: ReturnType<PiVariantBranchSession["sessionManager"]["getEntry"]>,
): ContextEditableContent | null {
  if (entry?.type !== "message") return null;
  const message = entry.message;
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") return message.content;
  return null;
}

/** The session branch's message entries in order, each with the text it contributed. */
function branchMessageEntries(session: PiVariantBranchSession): readonly Readonly<{
  id: string;
  parentId: string | null;
  reply: string | null;
  player: string | null;
}>[] {
  const messages: Readonly<{
    id: string;
    parentId: string | null;
    reply: string | null;
    player: string | null;
  }>[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    messages.push(
      Object.freeze({
        id: entry.id,
        parentId: entry.parentId,
        reply: chatTranscriptAssistantText(entry.message),
        player: chatTranscriptPlayerText(entry.message),
      }),
    );
  }
  return messages;
}

/** Moves the leaf, and hands back the one call that puts it where it was. */
function branchedTo(session: PiVariantBranchSession, entryId: string | null): PiVariantBranch {
  const previousLeafId = session.sessionManager.getLeafId();
  branchTo(session, entryId);
  return Object.freeze({
    status: "branched",
    revert: (): void => {
      branchTo(session, previousLeafId);
    },
  });
}

function branchTo(session: PiVariantBranchSession, entryId: string | null): void {
  if (entryId === null) session.sessionManager.resetLeaf();
  else session.sessionManager.branch(entryId);
  session.refreshContext();
}
