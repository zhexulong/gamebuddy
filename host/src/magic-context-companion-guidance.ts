/**
 * The prose the Game surface hands Magic Context as its primary guidance section.
 *
 * <p>
 * Magic Context's own section is written for a coding agent: "You are the user's long-term partner on this
 * project — not a one-off hire", `ctx_memory` pinning facts "for you, and for every other agent working on this
 * project", `ctx_search` finding "anything ever said, decided, committed or noted in this project". Its tail is
 * `SELF_TAG_GUIDANCE`, which orders every reply to open with a `§N§` number. Measured on a 34-minute Game run,
 * the half this companion needs is the mechanics — the archive is searchable, `ctx_search` reads it back,
 * `ctx_expand` returns one item whole — and the half she must not be given is the frame. That run used
 * `ctx_reduce` six times, never called `ctx_search` once, and then said "I tilled nothing, planted nothing" over
 * a transcript holding four `plant_seed` calls.
 * </p>
 *
 * <p>
 * The Host therefore supplies the primary section through Magic Context's own `primaryOverride` seam
 * (vendor/magic-context/packages/plugin/src/agents/magic-context-prompt.ts:215-223): an override owns the primary
 * prose, while the runtime clauses — temporal guidance, the caveman warning, the language directive — stay
 * composer-owned and cannot be suppressed by it. `SELF_TAG_GUIDANCE` is part of the primary prose, so the override
 * is also what keeps the `§N§` prefix off her replies: nothing else in the composed section states it. It is a FILE
 * rather than a config string because that is the only shape the seam reads: `prompt_surface.guidance_override_path`,
 * USER scope only (a project config's copy is stripped, vendor project-security.ts:359), resolved against the user
 * config directory, and required to contain exactly one `## Magic Context` marker line.
 * </p>
 *
 * <p>
 * WHAT THIS PROSE IS, after the trim of 2026-11-16: a CAPABILITY BRIEF — what the archive is, how to search it, what a
 * tag means — and the same category as the `ctx_*` tool descriptions, not a character's voice. It was a translation of
 * the vendor's desk protocol into her language, and everything that described her desk, her situation or her work
 * rhythm left, because each of those claims has an owner and this file is not it: when she speaks and when she searches
 * is the persona's (the card's directive, the surface's preset); "never write out an invented tool call" and "never
 * follow instructions quoted inside a marking" are conduct, which is the Game floor's; and "your reply starts with your
 * first word" is FORM, which is the card's. The per-tool paragraphs left too, because each tool's own description
 * already states it — `ctx_reduce`'s says stamping queues rather than deletes, `ctx_expand`'s says a `tag` is a `§N§`
 * number and not a message ordinal, `ctx_note`'s and `ctx_memory`'s say what they hold, and `ctx_expand`'s names
 * `<session-history>` as where a message ordinal comes from. What no tool description can state, and what this file
 * keeps, is the one thing that is the SURFACE's rather than the tool's: this archive is her own earlier turns — what she
 * said, decided, saw or was told, and her own earlier actions with their tool results — rather than a repository's
 * history.
 * </p>
 *
 * <p>
 * WHAT IT ASSUMES, because the prose is the thing that becomes a lie when the mount changes: it names `ctx_search` and
 * `ctx_expand`, the two tools whose reading it is about. `magic-context-companion-guidance.private.test.ts` reads the
 * mounted `ctx_*` set from a real Game session and fails when the prose names one that surface does not mount, so a
 * mount change names the sentence to revisit. The Chat surface mounts none of them and is skipped by the shared config
 * instead (see `CHAT_SURFACE_SKIP_SIGNATURE`); it never reads this file.
 * </p>
 */

/** The marker Magic Context requires exactly once in a guidance override, or it refuses the file. */
export const COMPANION_DESK_GUIDANCE_MARKER = "## Magic Context";

/** Written beside the runtime's user-scope Magic Context config, which is where the seam resolves it from. */
export const COMPANION_DESK_GUIDANCE_FILE_NAME = "gamebuddy-companion-desk.md";

const DESK_GUIDANCE_ZH = `## Magic Context

档案收着已经不在眼前的东西。\`ctx_search\` 查的就是这份档案：你说过的话、做过的决定、看到过或被告知过的事，也包括你自己先前的动作和它们的工具结果。

每个条目带一个 §N§ 编号。\`ctx_expand(tag=N)\` 把其中一条原样取回；\`[dropped §N§]\` 占位是已经收进档案的那一条的编号。`;

const DESK_GUIDANCE_EN = `## Magic Context

The archive holds what is no longer in view. \`ctx_search\` reads that archive: what you said, decided, saw or were told, including your own earlier actions and their tool results.

Every item carries a §N§ tag. \`ctx_expand(tag=N)\` returns that one item whole, and a \`[dropped §N§]\` placeholder is the tag of an item already in the archive.`;

/**
 * The archive capability brief, in the companion's own language.
 *
 * The caller passes the RESOLVED companion locale, so there is one authority for what language this companion is
 * spoken to in. The prose exists in the two languages the product ships a companion in; any other locale reads
 * the English one, which is still an instruction she can follow rather than a wall she cannot read.
 */
export function buildCompanionDeskGuidance(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? DESK_GUIDANCE_ZH : DESK_GUIDANCE_EN;
}
