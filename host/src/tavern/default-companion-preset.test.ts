import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
 *
 * The compile sources are the COMMITTED card + world book, not the working
 * tree: the working tree of the assets dir is routinely owned by a lane
 * editing the terminology, and the shipped preset must reflect the committed
 * review (`host/scripts/compile-default-companion-preset.mjs --committed`).
 * This test reads `git show HEAD:...` the same way, so the two sides always
 * measure the same text. A lane that edits the card commits the card edit AND
 * regenerates the preset in the same commit; until then this parity test stays
 * red for them on purpose.
 */
function presetDirectory(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")]) {
    if (existsSync(join(candidate, "assets", "tavern", "presets", "default-companion", "card.json")))
      return join(candidate, "assets", "tavern", "presets", "default-companion");
  }
  throw new Error("reviewed_preset_card_not_findable");
}

function repositoryRoot(): string {
  return resolve(presetDirectory(), "..", "..", "..");
}

async function committedAsset(name: string): Promise<unknown> {
  const bytes = execFileSync("git", ["show", `HEAD:assets/tavern/presets/default-companion/${name}`], {
    cwd: repositoryRoot(),
    encoding: "utf8",
  });
  return JSON.parse(bytes);
}

test("the shipped compiled preset equals the product converter's output for the committed card", async () => {
  const card = await committedAsset("card.json");
  const rawBook = await committedAsset("worldbook.json");

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

test("the committed card's system_prompt is carried into the shipped profile as characterVoice", async () => {
  const card = await committedAsset("card.json");

  const preview = previewStCard(card, "gamebuddy.companion.default");
  const profile = validateIdentityProfile(candidateToIdentityProfile(preview, 1));
  // The card's own performance directive — including "动率先于言" and the rule
  // that the companion never calls the player 搭档 — must reach the model on
  // the DEFAULT path too, exactly the way an imported card's directive does.
  assert.deepEqual(profile.characterVoice, {
    text: DEFAULT_COMPANION_PRESET.profile.characterVoice?.text,
    source: "card",
  });
  assert.ok(profile.characterVoice !== undefined);
  assert.ok(profile.characterVoice.text.includes("动率先于言"), "the card's own 动率先于言 rule reaches the default path");
  assert.ok(
    profile.characterVoice.text.includes("称谓规范"),
    "the card's own 称谓规范 directive reaches the default path",
  );
  // profileId attribution: `.default` belongs to the SHIPPED preset (this
  // parity test's identity); `.imported` belongs to the ST-card IMPORT path,
  // which carries a different profileId by construction. Both flows share the
  // same profileId-free characterVoice semantics — the import-path half is
  // asserted by st-card-import.test.ts, this half by the deepEqual above.
  assert.equal(DEFAULT_COMPANION_PRESET.profile.profileId, "gamebuddy.companion.default");
  assert.equal(profile.profileId, "gamebuddy.companion.default");
});