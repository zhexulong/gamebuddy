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
 * which carries no card-shaped bytes.
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
 * `host/src/tavern/default-companion-preset.test.ts` re-runs the same conversion
 * and fails if the committed module is stale, so an edited preset cannot ship
 * uncompiled.
 */
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const presetDirectory = join(repositoryRoot, "assets", "tavern", "presets", "default-companion");
const compiledRoot = join(repositoryRoot, "host", ".tmp-persona-compile");

if (!existsSync(join(compiledRoot, "st-card-import.js"))) {
  console.log("compiling the product converter (tsc -p host/tsconfig.focus-persona-compile.json)…");
  execSync("npx tsc -p host/tsconfig.focus-persona-compile.json", { cwd: repositoryRoot, stdio: "inherit" });
}

const buildUrl = (module) => pathToFileURL(join(compiledRoot, module)).href;
const { previewStCard, candidateToIdentityProfile } = await import(buildUrl("st-card-import.js"));
const { validateIdentityProfile } = await import(buildUrl("identity-profile.js"));
const { validateWorldBook } = await import(buildUrl("worldbook.js"));

const card = JSON.parse(await readFile(join(presetDirectory, "card.json"), "utf8"));
const rawBook = JSON.parse(await readFile(join(presetDirectory, "worldbook.json"), "utf8"));

const preview = previewStCard(card, "gamebuddy.companion.default");
const profile = validateIdentityProfile(candidateToIdentityProfile(preview, 1));
const book = validateWorldBook(rawBook);
const candidate = preview.profileCandidate;
const greetings = [];
if (typeof candidate.firstGreeting === "string" && candidate.firstGreeting.trim() !== "")
  greetings.push({ label: "Default", text: candidate.firstGreeting });
(candidate.alternateGreetings ?? []).forEach((text, index) => {
  if (typeof text === "string" && text.trim() !== "") greetings.push({ label: `Alternate ${index + 1}`, text });
});

const json = (value) => JSON.stringify(value, null, 2);
const source = `/**
 * COMPILED from \`assets/tavern/presets/default-companion/{card.json,worldbook.json}\`
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
  greetings: readonly Readonly<{ label: string; text: string }>[];
}>;

export const DEFAULT_COMPANION_PRESET: DefaultCompanionPreset = Object.freeze({
  schemaVersion: 1,
  profile: ${json(profile)} as IdentityProfile,
  worldBook: ${json(book)} as WorldBook,
  greetings: ${json(greetings)} as readonly Readonly<{ label: string; text: string }>[],
});
`;
await writeFile(join(repositoryRoot, "host", "src", "tavern", "default-companion-preset.ts"), source, "utf8");
console.log(
  `wrote default-companion-preset.ts: name=${profile.identity.name} profileId=${profile.profileId} greetings=${greetings.length} worldbookEntries=${book.entries.length}`,
);
