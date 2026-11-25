import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * THE TWO ARCHIVE READERS, IN THIS SURFACE'S OWN VOICE.
 *
 * <p>
 * Magic Context registers `ctx_search` and `ctx_expand` for every runtime it loads into, and its text is written for a
 * coding agent: "everything that ever happened in this project", with `opencode` and `git_commit` among its examples. A
 * Game session mounts both, so that text is the register of the tool a farmhand is handed - measured on `round78`, where
 * the same session was asked to remember a morning's work.
 * </p>
 *
 * <p>
 * THIS IS NOT THE OVERRIDE `tool-surface.ts` DELETED, and the difference is the whole policy. That one was keyed by
 * CAPABILITY CLASS: one paragraph replaced every session-inspection tool's words, so a tool the extension registered
 * tomorrow arrived carrying a sentence written before it existed, and its author never saw the tool it rewrote. This
 * table NAMES two tools, gives each its own sentence, and its subject is this surface - her own memory of this world -
 * and nothing else. `tool-surface.private.test.ts` holds both halves: a named per-tool projection is expected to be here,
 * and a class-keyed one is still refused.
 * </p>
 *
 * <p>
 * THE MECHANICS STAY THE TOOLS': the phrasing hint and the `tag`/`message`/`start`/`end` senses are what the extension's
 * own definitions declare, and what is replaced is the AUDIENCE and the examples - the one thing the extension cannot say,
 * because it does not know which surface mounts it. Nothing here states when to call them: that is the persona's.
 * </p>
 */
export const COMPANION_ARCHIVE_TOOL_DESCRIPTIONS: Readonly<
  Record<string, Readonly<{ why: string; description: string }>>
> = Object.freeze({
  ctx_search: Object.freeze({
    why: "the archive reader the Game surface's own memory claim is about",
    description:
      "Search your own memory for what has dropped out of view: what you said, what you did and what came back from it, and what you saw or were told in this world. Retrieval matches meaning and exact words together, so phrase `query` as a natural-language question that still carries the terms you expect (a place, an item, a name, an error string); a bare keyword stack finds less. An item the archive already holds comes back with a §N§ number you can hand to `ctx_expand`.",
  }),
  ctx_expand: Object.freeze({
    why: "the reader that returns one earlier turn whole, which a `ctx_search` result points at",
    description:
      "Read one earlier piece of that memory whole, once an answer has shown you the number it carries. `tag=N` is that number; `message=N` and `start`/`end` are message ordinals, the positions shown in the headings. It returns the original text, not a summary of it.",
  }),
  ctx_memory: Object.freeze({
    why: "the durable companion memory writer and manager aligned with ongoing-interaction categories",
    description:
      "Durable facts from your shared life with the player, carried across sessions.\n\nYour active memories are already in <project-memory> as `#id: fact` lines. Keep Magic Context's standard restraint: write only when a durable player preference, boundary, promise, or shared milestone should stay remembered across sessions, not ordinary routine chores or transient state. One standalone fact per memory, phrased to make sense on its own. A pending reminder or follow-up intention is `ctx_note`, not memory.\n\nActions:\n- write: new memory (content + category: SEMANTIC_MEMORY for durable facts/preferences/boundaries, INTERACTION_EPISODE for consequential promises or relationship milestones).\n- update: rewrite one memory whose fact changed (ids: [one], content; category optional).\n- archive: retire wrong or obsolete memories (ids: [one or more], optional reason).\n- merge: collapse duplicates into one (ids: [two or more], content).\n- get: fetch by id (ids: 1-20), readable in every status.",
  }),
  ctx_note: Object.freeze({
    why: "the session and project follow-up note tool stripped of coding-repository smart-note wording",
    description:
      "Session notes are pending intentions: things to revisit later with your partner, with context attached.\n\nUse notes for:\n- Something to bring up or follow up on later when the moment returns\n- A reminder or open thread the player explicitly asks you to keep track of\n\nDon't use notes for: the immediate next step in a routine, or a plain snapshot of current world state that expires in seconds; durable cross-session facts belong in `ctx_memory`, not notes.\n\nFirst line is the short title (under 80 chars), followed by detail. Operations:\n- write: save a new note (content required)\n- read: one row per note — `#id · age · title` — pass note_ids to read full bodies; limit/offset page; filter selects other statuses.\n- update: change one note (note_ids=[N])\n- dismiss: retire 1-50 notes (note_ids) once resolved or dropped.",
  }),
  ctx_reduce: Object.freeze({
    why: "the desk-clearing tool adapted so companion turns clear old tool results without coding examples",
    description:
      'Stamp an older item on your desk as no longer needed for what comes next. Not a delete: stamping QUEUES it, the item stays readable until Magic Context clears stamped items together, and the newest frame of protected tools stays safe. A cleared item leaves `[dropped §N§]` (or nothing when older), and `ctx_expand(tag=N)` brings it back.\n\nStamp: superseded observations, finished plan results, old emote acknowledgements, or redundant outputs the work ahead no longer needs.\nKeep: player messages, your own spoken replies, unresolved issues, and the latest world/plan result you are actively acting on.\n\nCheck each tag before stamping; never blanket-stamp wide ranges like "1-50". `drop` accepts "3-5", "1,2,9", "1-5,8,12-15".',
  }),
});

/**
 * The registered definition with this surface's description - every other member exactly as the extension wrote it.
 *
 * <p>
 * A projection, never a replacement: the definition is spread from the one the loader holds, so `parameters`, `execute`
 * and everything the tool declares about itself stay that tool's. A name this table does not carry comes back untouched,
 * which is what keeps the projection from spreading over the class the way the deleted override did.
 * </p>
 */
export function projectArchiveToolDescription(definition: ToolDefinition): ToolDefinition {
  const entry = COMPANION_ARCHIVE_TOOL_DESCRIPTIONS[definition.name];
  if (entry === undefined) return definition;
  return Object.freeze({ ...definition, description: entry.description });
}
