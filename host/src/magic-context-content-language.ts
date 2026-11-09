/**
 * The `language` value that makes Magic Context write its OWN prose in the player's language.
 *
 * Not all of her memory is written by her. The fold's `<new-compartments>` block and its one-line `compaction`
 * titles are authored by Magic Context's embedded historian, and that prompt follows the extension's `language`
 * setting rather than the companion system prompt (vendor `packages/pi-plugin/src/index.ts:1113` carries it into
 * the historian deps, `pi-historian-runner.ts:562-566` appends the directive with it). Unset, the vendor returns
 * that system prompt untouched and the summary comes out in whatever language the model defaults to - measured on
 * a 35-minute Chinese Game session: 6,396 characters of first-person English, which reads as somebody else's notes
 * rather than her own memory.
 *
 * The vendor accepts exactly one shape: a 2-letter ISO 639-1 code it can also resolve to a language name
 * (`isValidLanguageCode` in `packages/plugin/src/agents/language-directive.ts`, enforced by the schema's refine at
 * `packages/plugin/src/config/schema/magic-context.ts:1159-1178`). The player's companion locale is a BCP-47 tag
 * (`zh-CN`, `zh-Hant-TW`, `yue-Hant-TW`), so this maps the primary subtag - and REFUSES what the vendor's own
 * validator would reject instead of writing it. The vendor would not honour a rejected value either: its loader
 * prunes the invalid top-level key and keeps the rest of the file, with a warning no player reads
 * (`packages/pi-plugin/src/config/index.ts:337-439`), which leaves the summaries in whatever language the model
 * defaults to - the silent failure this module exists to remove.
 * The value is USER-scope only, the scope the runtime already owns: a project-tier copy is deleted on load
 * (`config/project-security.ts:432-437`).
 */

/** Named diagnostic for a locale the vendor cannot express, so an unset key is never a silent one. */
export const MAGIC_CONTEXT_CONTENT_LANGUAGE_UNSUPPORTED = "magic_context_content_language_unsupported";

/** The vendor's own resolution mechanism: a code with no entry here is one its validator rejects. */
const ISO_639_1_LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * Reduce a companion locale to the code Magic Context's `language` accepts, or `undefined` (with a diagnostic)
 * when the locale names no such language.
 */
export function magicContextContentLanguage(companionLocale: string): string | undefined {
  const primary = companionLocale.split("-")[0]?.toLowerCase() ?? "";
  if (/^[a-z]{2}$/u.test(primary) && ISO_639_1_LANGUAGE_NAMES.of(primary) !== undefined) return primary;
  process.stderr.write(
    `[historian] ${MAGIC_CONTEXT_CONTENT_LANGUAGE_UNSUPPORTED}: companion locale ${JSON.stringify(companionLocale)} names no 2-letter ISO 639-1 language, so Magic Context's \`language\` stays unset and its own prose will mirror the model instead of the player\n`,
  );
  return undefined;
}
