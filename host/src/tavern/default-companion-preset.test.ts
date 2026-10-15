import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
 *
 * Two measurements live here, each named for the text it actually reads:
 *
 *  - COMMITTED parity (the gate). The shipped preset is produced from the
 *    committed card + world book — `host/scripts/compile-default-companion-preset.mjs
 *    --committed` exists for exactly that reason, because the working tree of the
 *    assets dir is routinely owned by a lane editing the terminology. So the gate
 *    reads that same text with `git show HEAD:...` and NEVER the file on disk. A
 *    lane that edits the card commits the card edit AND the regenerated preset in
 *    the same commit; until then this parity test stays red for them on purpose.
 *    If git cannot be reached the gate fails with `committed_asset_unreadable`
 *    instead of falling back to the working tree, because such a fallback makes
 *    the gate compare the working tree against itself and enforce nothing.
 *
 *  - WORKING-TREE parity (an editing-time check, not the gate). While a card edit
 *    is in flight, "the preset matches the files on disk" is the question that
 *    separates "I regenerated after my edit" from "I forgot to"; it is named for
 *    the text it reads and it is never the assertion that guards a release.
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

/** The COMMITTED text of one preset asset, read from git at HEAD. */
function committedAsset(name: string): unknown {
  const spec = `HEAD:assets/tavern/presets/default-companion/${name}`;
  let bytes: string;
  try {
    bytes = execFileSync("git", ["show", spec], { cwd: repositoryRoot(), encoding: "utf8" });
  } catch (error) {
    throw new Error(
      `committed_asset_unreadable: git could not show ${spec} (${error instanceof Error ? error.message : String(error)}); ` +
        "reading the file on disk here would compare the working tree against itself",
    );
  }
  return JSON.parse(bytes);
}

/** The WORKING TREE's text of one preset asset. */
async function workingTreeAsset(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(presetDirectory(), name), "utf8"));
}

/** What the product converter produces for a given card + world book. */
function convertedPreset(card: unknown, rawBook: unknown) {
  const preview = previewStCard(card, "gamebuddy.companion.default");
  const profile = validateIdentityProfile(candidateToIdentityProfile(preview, 1));
  const candidate = preview.profileCandidate;
  const scenario =
    typeof preview.scenario === "string" && preview.scenario.trim() !== "" ? preview.scenario : undefined;
  const greetings: Array<Readonly<{ label: string; text: string }>> = [];
  if (typeof candidate.firstGreeting === "string" && candidate.firstGreeting.trim() !== "")
    greetings.push(Object.freeze({ label: "Default", text: candidate.firstGreeting }));
  (candidate.alternateGreetings ?? []).forEach((text, index) => {
    if (typeof text === "string" && text.trim() !== "")
      greetings.push(Object.freeze({ label: `Alternate ${index + 1}`, text }));
  });
  return { profile, worldBook: validateWorldBook(rawBook), scenario, greetings };
}

function assertPresetMatches(expected: ReturnType<typeof convertedPreset>): void {
  assert.deepEqual(DEFAULT_COMPANION_PRESET.profile, expected.profile);
  assert.deepEqual(DEFAULT_COMPANION_PRESET.worldBook, expected.worldBook);
  // The card's scenario is not profile text (the decoder keeps it candidate-only),
  // so it has its own field on the preset — and it must be the card's own text,
  // because `default-companion-seed.ts` installs the durable scenario record from it.
  assert.deepEqual(DEFAULT_COMPANION_PRESET.scenario, expected.scenario);
  assert.deepEqual(DEFAULT_COMPANION_PRESET.greetings, expected.greetings);
}

test("the shipped compiled preset equals the product converter's output for the COMMITTED card", () => {
  const card = committedAsset("card.json") as { data: { scenario: string } };
  const expected = convertedPreset(card, committedAsset("worldbook.json"));
  assert.equal(expected.profile.identity.name, "琥珀");
  assertPresetMatches(expected);
  // The card's own scenario travels with the compiled preset verbatim — it is the
  // value the fresh-root seed turns into the companion's durable scenario record.
  assert.equal(DEFAULT_COMPANION_PRESET.scenario, card.data.scenario);
  assert.ok((DEFAULT_COMPANION_PRESET.scenario ?? "").includes("星露谷"));
});

test("the committed card's system_prompt is carried into the shipped profile as characterVoice", () => {
  const profile = convertedPreset(committedAsset("card.json"), committedAsset("worldbook.json")).profile;
  // The card's own performance directive — including "动率先于言" and the rule
  // that the companion never calls the player 搭档 — must reach the model on
  // the DEFAULT path too, exactly the way an imported card's directive does.
  assert.deepEqual(profile.characterVoice, {
    text: DEFAULT_COMPANION_PRESET.profile.characterVoice?.text,
    source: "card",
  });
  assert.ok(profile.characterVoice !== undefined);
  assert.ok(
    profile.characterVoice.text.includes("动率先于言"),
    "the card's own 动率先于言 rule reaches the default path",
  );
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

test("the shipped compiled preset also matches the WORKING-TREE card and world book (editing-time check, not committed parity)", async () => {
  assertPresetMatches(convertedPreset(await workingTreeAsset("card.json"), await workingTreeAsset("worldbook.json")));
});
