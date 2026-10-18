#!/usr/bin/env node
/**
 * compile-default-companion-preset.mjs
 *
 * Regenerates `host/src/tavern/default-companion-preset.ts` — the COMPILED form of
 * the reviewed default companion preset that ships inside a generation.
 *
 * Why this exists: the raw preset card (`assets/tavern/presets/default-companion/
 * card.json`) is a dev seed that must NOT ship inside a generation — the
 * release-persona-hygiene gate refuses a card-shaped file by name and a
 * `"spec": "chara_card_v2"` payload by bytes. What ships is this compiled module,
 * which carries no card-shaped bytes. The same is true of the preset's own
 * `avatar.png`: nothing in a generation reads `assets/`, so the picture is carried
 * here too (base64-encoded) and written by `default-companion-seed.ts`.
 *
 * It reuses the product's OWN converter — `previewStCard` + `candidateToIdentityProfile`
 * from `st-card-import.ts`, the same two functions `provisionLiveRunPersona`
 * (tools/live-run/core/persona.mjs) and the ST-card import flow call — so there is
 * exactly one card→profile converter in the codebase.
 *
 * Usage (from the repository root):
 *   npx tsc -p host/tsconfig.focus-persona-compile.json
 *   node host/scripts/compile-default-companion-preset.mjs
 *
 * `--committed` reads the COMMITTED card + world book (`git show HEAD:...`)
 * instead of the working tree, and asks git (not this checkout) whether the preset
 * carries a picture. The working tree of the assets dir is routinely owned by a
 * lane editing the terminology; the shipped compiled preset must reflect the
 * committed review, so regeneration for a release uses `--committed`.
 *
 * `host/src/tavern/default-companion-preset.test.ts` re-runs the same conversion
 * and fails if the committed module is stale, so an edited preset cannot ship
 * uncompiled.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const presetDirectory = join(repositoryRoot, "assets", "tavern", "presets", "default-companion");
const compiledRoot = join(repositoryRoot, "host", ".tmp-persona-compile");
const fromCommitted = process.argv.includes("--committed");

if (!existsSync(join(compiledRoot, "st-card-import.js"))) {
  console.log("compiling the product converter (tsc -p host/tsconfig.focus-persona-compile.json)…");
  execSync("npx tsc -p host/tsconfig.focus-persona-compile.json", { cwd: repositoryRoot, stdio: "inherit" });
}

const buildUrl = (module) => pathToFileURL(join(compiledRoot, module)).href;
const { previewStCard, candidateToIdentityProfile } = await import(buildUrl("st-card-import.js"));
const { validateIdentityProfile } = await import(buildUrl("identity-profile.js"));
const { validateWorldBook } = await import(buildUrl("worldbook.js"));

const readAsset = async (name) => {
  if (!fromCommitted) return JSON.parse(await readFile(join(presetDirectory, name), "utf8"));
  const bytes = execFileSync("git", ["show", `HEAD:assets/tavern/presets/default-companion/${name}`], { cwd: repositoryRoot, encoding: "utf8" });
  return JSON.parse(bytes);
};
const card = await readAsset("card.json");
const rawBook = await readAsset("worldbook.json");

/**
 * The reviewed preset's own picture, as the bytes the compiled module carries - or
 * `undefined` when the preset directory has none, which is an ordinary state: the
 * picture is the owner's asset, not something the card's own decode produces.
 *
 * Read from the same two sources `readAsset` reads, for the same reason. Under
 * `--committed` the shipped bytes must be the ones a review accepted, so presence
 * is asked of git itself (`cat-file -e`'s exit status IS the answer) rather than
 * inferred from this checkout. The bytes travel base64-encoded because a generated
 * TypeScript module cannot hold binary; `default-companion-seed.ts` decodes them
 * and the avatar module's own container check decides whether they are a picture.
 */
const readAvatar = async () => {
  const spec = "HEAD:assets/tavern/presets/default-companion/avatar.png";
  if (!fromCommitted) {
    const path = join(presetDirectory, "avatar.png");
    return existsSync(path) ? await readFile(path) : undefined;
  }
  try {
    execFileSync("git", ["cat-file", "-e", spec], { cwd: repositoryRoot, stdio: "ignore" });
  } catch {
    return undefined;
  }
  return execFileSync("git", ["show", spec], { cwd: repositoryRoot });
};
const avatar = await readAvatar();

// Provenance of the text this run compiled, stated on the line below so the
// caller never has to remember which mode it invoked. `--committed` reads
// `git show HEAD:...`, so the named revision is exactly HEAD.
const sourceDescription = fromCommitted
  ? `committed (HEAD ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim()})`
  : "worktree";

const preview = previewStCard(card, "gamebuddy.companion.default");
const profile = validateIdentityProfile(candidateToIdentityProfile(preview, 1));
// The card's own recent-message scan window (`character_book.scan_depth`) must
// ride the shipped book exactly the way card-import provisioning folds it into
// the `worldbook.json` it writes (`new-companion-service.ts`): the decoder
// carries the declared depth as `preview.worldBookScanDepth`, and without this
// fold a freshly-seeded default companion's per-turn World Info selection
// silently applies the documented default even though the reviewed card
// declared one. The depth is part of the canonical book hash, so the binding
// and its re-verification both carry the declared value.
const book = validateWorldBook({
  ...rawBook,
  ...(preview.worldBookScanDepth === undefined ? {} : { scanDepth: preview.worldBookScanDepth }),
});
const candidate = preview.profileCandidate;
// The card's `scenario` is deliberately NOT profile text (the decoder keeps it
// candidate-only: `st-card-import.ts`), so the profile half of the preset cannot
// carry it. But the preset is ALSO what a fresh runtime root is seeded from, and
// the companion's own scenario lives as a durable player-scenario record — the
// same one `new-companion-service.ts` writes at card-import provisioning and
// every reader (`resolveCompanionOwnScenario`, the character panel's
// `scenario.read`) resolves by `companionScenarioId`. Carry the decoder's own
// text on the preset so `default-companion-seed.ts` can install that record
// instead of a fresh player meeting "还没有保存场景" for a card that has one.
const scenario =
  typeof preview.scenario === "string" && preview.scenario.trim() !== "" ? preview.scenario : undefined;
const greetings = [];
if (typeof candidate.firstGreeting === "string" && candidate.firstGreeting.trim() !== "")
  greetings.push({ label: "Default", text: candidate.firstGreeting });
(candidate.alternateGreetings ?? []).forEach((text, index) => {
  if (typeof text === "string" && text.trim() !== "") greetings.push({ label: `Alternate ${index + 1}`, text });
});

const json = (value) => JSON.stringify(value, null, 2);
const worldBookScanDepth = book.scanDepth;
// The picture is the file's own bytes, base64-encoded for the generated module and
// decoded again by the seed. `undefined` (no picture in the preset directory) keeps
// the field off the generated object entirely.
const avatarBase64 = avatar === undefined ? undefined : avatar.toString("base64");
const source = `/**
 * COMPILED from \`assets/tavern/presets/default-companion/{card.json,worldbook.json,avatar.png}\`
 * through the product's OWN card converter — \`previewStCard\` + \`candidateToIdentityProfile\`
 * from \`st-card-import.ts\`, the same two functions \`provisionLiveRunPersona\`
 * (tools/live-run/core/persona.mjs) reuses and the same ones the ST-card import
 * flow calls. No second converter exists here: this file only carries that
 * converter's output into the Host build.
 *
 * Why it is compiled rather than the raw card: a generation may not carry a
 * card-shaped file or card payload (\`host/scripts/check-release-persona-hygiene.mjs\`
 * refuses \`card.json\` by name and a \`"spec": "chara_card_v2"\` payload by bytes),
 * so the reviewed preset's raw bytes stay a dev seed outside every generation and
 * this COMPILED form is what ships inside it. Regenerate with
 * \`node host/scripts/compile-default-companion-preset.mjs\`; the drift test
 * (\`default-companion-preset.test.ts\`) recompiles the card and fails if this
 * file is stale.
 *
 * The world book's \`scanDepth\` is the card's own \`character_book.scan_depth\`,
 * folded by the converter exactly the way card-import provisioning folds it into
 * the \`worldbook.json\` it writes (\`new-companion-service.ts\`). It is part of
 * the synchronous book hash, so a fresh root seeds the declared per-turn scan
 * window rather than the documented default.
 *
 * The preset directory's own \`avatar.png\` rides here too, base64-encoded: it is a
 * binary the secret-free generated source cannot hold as bytes. It is not the
 * card's payload and never was — the hygiene gate's \`embedded_card_png\` rule
 * refuses a PNG that carries a \`chara\`/\`ccv3\`/\`character\` text chunk, and this
 * picture has none. \`default-companion-seed.ts\` decodes it and writes it into
 * the new companion's own root through the same \`writeAvatarFile\` the card-import
 * confirm step uses. Absent when the preset directory carries no picture.
 *
 * The Host installs it on the FIRST creation of a fresh runtime root
 * (\`default-companion-seed.ts\`), so a fresh root presents as 琥珀 rather than
 * the mechanical placeholder, and a player's later edits are never overwritten.
 */
import type { IdentityProfile } from "../identity-profile.js";
import type { WorldBook } from "../worldbook.js";

export type DefaultCompanionPreset = Readonly<{
  schemaVersion: 1;
  profile: IdentityProfile;
  worldBook: WorldBook;
  /**
   * The reviewed card's own \`scenario\` field, verbatim as the decoder read it.
   *
   * It is not profile text — the decoder keeps a card's scenario candidate-only
   * — but a fresh root's companion owns a durable scenario record, and this is
   * the value \`default-companion-seed.ts\` installs through
   * \`createScenarioManagementService\`. Absent when the card wrote none.
   */
  scenario?: string;
  /**
   * The reviewed preset's own picture (\`avatar.png\`), base64-encoded because a
   * generated module cannot carry binary. Absent when the preset directory has
   * none, which is an ordinary state.
   *
   * \`default-companion-seed.ts\` decodes it at first creation and writes it into
   * the companion's own root through \`writeAvatarFile\`, after the avatar module's
   * own ceiling and container check — so a picture that is present and unusable
   * fails by name rather than seeding a companion without one.
   */
  avatarBase64?: string;
  greetings: readonly Readonly<{ label: string; text: string }>[];
}>;

export const DEFAULT_COMPANION_PRESET: DefaultCompanionPreset = Object.freeze({
  schemaVersion: 1,
  profile: ${json(profile)} as IdentityProfile,
  worldBook: ${json(book)} as WorldBook,
${scenario === undefined ? "" : `  scenario: ${json(scenario)},\n`}${avatarBase64 === undefined ? "" : `  avatarBase64: "${avatarBase64}",\n`}  greetings: ${json(greetings)} as readonly Readonly<{ label: string; text: string }>[],
});
`;
await writeFile(join(repositoryRoot, "host", "src", "tavern", "default-companion-preset.ts"), source, "utf8");
console.log(
  `wrote default-companion-preset.ts from ${sourceDescription}: name=${profile.identity.name} profileId=${profile.profileId} greetings=${greetings.length} worldbookEntries=${book.entries.length} worldBookScanDepth=${worldBookScanDepth === undefined ? "none" : worldBookScanDepth} characterVoice=${profile.characterVoice === undefined ? "none" : "present"} scenario=${scenario === undefined ? "none" : `present(${scenario.length})`} avatar=${avatar === undefined ? "none" : `present(${avatar.length})`}`,
);
