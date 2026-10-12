import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateIdentityProfile } from "../identity-profile.js";
import { candidateToIdentityProfile, previewStCard } from "../st-card-import.js";
import { validateWorldBook } from "../worldbook.js";
import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";

/**
 * The reviewed preset card is a dev seed OUTSIDE every generation, and the raw
 * bytes must never ship inside one (the release-persona-hygiene gate refuses a
 * card-shaped file by name and a card payload by bytes). What ships instead is
 * `default-companion-preset.ts`, which carries this exact converter's output.
 *
 * That makes the compiled file a copy that can go stale the moment the card is
 * edited. This test is the anti-drift guard: it recompiles the card through the
 * SAME product functions (`previewStCard` + `candidateToIdentityProfile`) and
 * fails if the shipped copy no longer equals them.
 */
function presetDirectory(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")]) {
    if (existsSync(join(candidate, "assets", "tavern", "presets", "default-companion", "card.json")))
      return join(candidate, "assets", "tavern", "presets", "default-companion");
  }
  throw new Error("reviewed_preset_card_not_findable");
}

test("the shipped compiled preset equals the product converter's output for the reviewed card", async () => {
  const directory = presetDirectory();
  const card = JSON.parse(await readFile(join(directory, "card.json"), "utf8")) as unknown;
  const rawBook = JSON.parse(await readFile(join(directory, "worldbook.json"), "utf8")) as unknown;

  const preview = previewStCard(card, "gamebuddy.companion.default");
  const profile = validateIdentityProfile(candidateToIdentityProfile(preview, 1));
  assert.equal(profile.identity.name, "琥珀");
  assert.deepEqual(DEFAULT_COMPANION_PRESET.profile, profile);

  assert.deepEqual(DEFAULT_COMPANION_PRESET.worldBook, validateWorldBook(rawBook));

  const candidate = preview.profileCandidate;
  const greetings: Array<Readonly<{ label: string; text: string }>> = [];
  if (typeof candidate.firstGreeting === "string" && candidate.firstGreeting.trim() !== "")
    greetings.push(Object.freeze({ label: "Default", text: candidate.firstGreeting }));
  (candidate.alternateGreetings ?? []).forEach((text, index) => {
    if (typeof text === "string" && text.trim() !== "")
      greetings.push(Object.freeze({ label: `Alternate ${index + 1}`, text }));
  });
  assert.deepEqual(DEFAULT_COMPANION_PRESET.greetings, greetings);
});
