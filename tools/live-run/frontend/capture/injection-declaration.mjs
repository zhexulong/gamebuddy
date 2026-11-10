/**
 * The sections a provider request can carry, named by the declarations that render them.
 *
 * The reader that prints INJECTION must be able to say which sections a request did NOT carry, and a
 * hand-kept list of names cannot say that: it drifts silently the first time the product adds, renames
 * or stops emitting one, and a section that vanished then reads exactly like a section that was empty.
 * So the population is read from the emitters themselves, as text - they are TypeScript, and importing
 * compiled Host output would make the reading depend on a build.
 *
 * Three files own one section family each. Every parse below is anchored on a literal that file emits,
 * and a failed anchor is returned by name (`injection_declaration_unreadable:<file>:<anchor>`) rather
 * than silently narrowing the population to whatever still parses.
 *
 *   gamebuddy-stable-context-source.ts   the m[0] authored block (`<gamebuddy-authored-context>`, one
 *                                        `<gamebuddy-authored-source kind=...>` per declared kind),
 *                                        the declared kind union (and the runtime `kinds` Set that
 *                                        validates the same fact a second time) and the m[1] volatile
 *                                        block that carries the selected world-book entries.
 *   inject-compartments-pi.ts            the memory the head carries: the compartment directory
 *                                        (`<session-history>`, rendered empty when nothing is decayed -
 *                                        which is why a carried-but-empty directory and a vanished one must
 *                                        be two different readings) and the player's promoted memories
 *                                        (`<project-memory>`, omitted entirely when there are none).
 *                                        The rest of that head's siblings (docs, profile, mural) are not
 *                                        sections this kit's game surface carries; the delta envelope
 *                                        (`<session-history-since>`) is transport for them, not a section.
 *   post-history-instructions-pi.ts      the card's closing direction, rendered after the transcript.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const STABLE_CONTEXT_SOURCE = "vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.ts";
const COMPARTMENT_INJECTION_SOURCE = "vendor/magic-context/packages/pi-plugin/src/inject-compartments-pi.ts";
const POST_HISTORY_SOURCE = "vendor/magic-context/packages/pi-plugin/src/post-history-instructions-pi.ts";

const quoted = (body) => [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);

const unreadable = (file, anchor) => ({ ok: false, reason: `injection_declaration_unreadable:${file}:${anchor}` });

function anchorOf(text, pattern, file, anchor) {
  const match = pattern.exec(text);
  return match === null ? unreadable(file, anchor) : { ok: true, value: match[1] };
}

/**
 * The declared section population, or a named reason it could not be read.
 *
 * `read` defaults to the file system so a caller can hand in a source of its own (a test pinning the
 * unreadable path); it receives a repo-relative path.
 */
export function readInjectionDeclaration(read = (file) => readFileSync(join(REPO, file), "utf8")) {
  const textOf = (file) => {
    try {
      return { ok: true, value: read(file) };
    } catch (error) {
      return { ok: false, reason: `injection_declaration_unreadable:${file}:absent:${String(error).slice(0, 60)}` };
    }
  };

  const stableFile = textOf(STABLE_CONTEXT_SOURCE);
  if (!stableFile.ok) return stableFile;
  const stable = stableFile.value;

  /* `const renderedBlock = \`<gamebuddy-authored-context version="v2" ...>` - the block that also
   * carries the turn's scope attributes, and the head of the cached prefix. */
  const authoredTag = anchorOf(
    stable,
    /const renderedBlock = `<([a-z][a-z0-9-]+)\s/u,
    STABLE_CONTEXT_SOURCE,
    "authored_block_tag",
  );
  if (!authoredTag.ok) return authoredTag;
  /* One `<gamebuddy-authored-source kind="${source.kind}">` element per authored section. */
  const authoredSourceTag = anchorOf(
    stable,
    /`<([a-z][a-z0-9-]+) kind="\$\{source\.kind\}">/u,
    STABLE_CONTEXT_SOURCE,
    "authored_source_tag",
  );
  if (!authoredSourceTag.ok) return authoredSourceTag;
  /* `<gamebuddy-volatile-context>` wrapping `<gamebuddy-volatile-source>` entries: the world book. */
  const volatileTag = anchorOf(stable, /return `<([a-z][a-z0-9-]+)>/u, STABLE_CONTEXT_SOURCE, "volatile_block_tag");
  if (!volatileTag.ok) return volatileTag;
  const volatileSourceTag = anchorOf(
    stable,
    /`<([a-z][a-z0-9-]+)>\\n\$\{escapeXmlContent\(source\.content\)\}/u,
    STABLE_CONTEXT_SOURCE,
    "volatile_source_tag",
  );
  if (!volatileSourceTag.ok) return volatileSourceTag;

  /* `GameBuddyAuthoredSourceKind` is the declaration; the `kinds` Set beside it is the runtime gate that
   * accepts or refuses a catalog. Two spellings of one fact, so they are compared here instead of one
   * being trusted: a kind in the union but not the Set is a section that renders and is then refused. */
  const union = /export type GameBuddyAuthoredSourceKind\s*=\s*([\s\S]*?);/u.exec(stable);
  if (union === null) return unreadable(STABLE_CONTEXT_SOURCE, "authored_kind_union");
  const unionKinds = quoted(union[1]);
  if (unionKinds.length === 0) return unreadable(STABLE_CONTEXT_SOURCE, "authored_kind_union_empty");
  const set = /const kinds = new Set<GameBuddyAuthoredSourceKind>\(\[([\s\S]*?)\]\)/u.exec(stable);
  if (set === null) return unreadable(STABLE_CONTEXT_SOURCE, "authored_kind_set");
  const setKinds = quoted(set[1]);
  const drifted = [...new Set([...unionKinds, ...setKinds])].filter(
    (kind) => !(unionKinds.includes(kind) && setKinds.includes(kind)),
  );
  if (drifted.length > 0)
    return {
      ok: false,
      reason: `injection_declaration_drift:${STABLE_CONTEXT_SOURCE}:kind_not_in_both_declarations=${drifted.join(",")}`,
    };

  /* `GameBuddyAuthoredVolatileSource.kind` - the one kind a world-book entry can be. */
  const volatileKind = anchorOf(
    stable,
    /export type GameBuddyAuthoredVolatileSource\s*=\s*Readonly<\{\s*sourceId: string;\s*kind: "([a-z_]+)";/u,
    STABLE_CONTEXT_SOURCE,
    "volatile_kind",
  );
  if (!volatileKind.ok) return volatileKind;

  const compartments = textOf(COMPARTMENT_INJECTION_SOURCE);
  if (!compartments.ok) return compartments;
  /* The empty form is the anchor: an empty memory block is exactly the case this census must tell apart
   * from a memory block that never reached the request. */
  const historyTag = anchorOf(
    compartments.value,
    /"<([a-z][a-z0-9-]+)><\/[a-z][a-z0-9-]+>"/u,
    COMPARTMENT_INJECTION_SOURCE,
    "memory_block_tag",
  );
  if (!historyTag.ok) return historyTag;
  const memoryTag = anchorOf(
    compartments.value,
    /renderMemoryBlockV2\(memories, "([a-z0-9-]+)"/u,
    COMPARTMENT_INJECTION_SOURCE,
    "player_memory_block_tag",
  );
  if (!memoryTag.ok) return memoryTag;
  const memoryBlocks = [historyTag.value, memoryTag.value];

  const postHistory = textOf(POST_HISTORY_SOURCE);
  if (!postHistory.ok) return postHistory;
  const closingTag = anchorOf(
    postHistory.value,
    /return `<([a-z][a-z0-9-]+)>\\n\$\{FRAME_OPENING\}/u,
    POST_HISTORY_SOURCE,
    "closing_direction_tag",
  );
  if (!closingTag.ok) return closingTag;

  const authored = { tag: authoredTag.value, source: authoredSourceTag.value };
  const volatile = { tag: volatileTag.value, source: volatileSourceTag.value, kind: volatileKind.value };
  return {
    ok: true,
    authored,
    volatile,
    stableKinds: unionKinds,
    memoryBlocks,
    closing: closingTag.value,
    /**
     * Every census section, in the order its own file declares it: the authored block, one section per
     * authored kind, the world-book block, the memory blocks and the closing direction.
     */
    sections: [authored.tag, ...unionKinds, volatile.kind, ...memoryBlocks, closingTag.value],
    /** The tags these emitters render. A `<gamebuddy-...>` tag outside this set is a section nobody counted. */
    tags: [authored.tag, authored.source, volatile.tag, volatile.source],
  };
}
