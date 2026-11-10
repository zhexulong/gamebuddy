import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";
import { decidePresetTailBlock, PRESET_TAIL_PUBLICATION_BYTE_BOUND } from "./preset-tail-block.js";
import {
  formatPresetOverlap,
  GAME_SESSION_PRESET_FILE,
  type GameSessionPreset,
  gameSessionPreset,
  presetOverlaps,
  readGameSessionPreset,
  renderPresetMainSegment,
} from "./preset-game-session.js";

/**
 * THE GAME SURFACE'S VIEW OF ITS GENERATION PRESET.
 *
 * <p>
 * The operator's question was "did the live run load the preset?", and it could only be answered by reading code.
 * Every assertion here is about the ANSWER being a reading rather than an intention: what the shipped file actually
 * contributes, where each taken entry goes, and what the three "nothing was applied" words each mean.
 * </p>
 *
 * <p>
 * The input is the REAL shipped preset (`assets/tavern/presets/amber-deepseek-v4.1.json`), not a fixture, for the
 * reason the conformance suite uses it too: a fixture can only prove this module agrees with its author, and the
 * question is what this product's own file does.
 * </p>
 */

function repositoryRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "host", "package.json")) && existsSync(join(current, "assets", "tavern", "presets")))
      return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`repository_root_not_found:${start}`);
    current = parent;
  }
}

const ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));
const SHIPPED_PRESET_PATH = join(ROOT, "assets", "tavern", "presets", "amber-deepseek-v4.1.json");

function shippedDocument(): Record<string, unknown> {
  return JSON.parse(readFileSync(SHIPPED_PRESET_PATH, "utf8")) as Record<string, unknown>;
}

function shippedPreset(document: Record<string, unknown> = shippedDocument()): GameSessionPreset {
  return gameSessionPreset(document, {
    source: SHIPPED_PRESET_PATH,
    profile: DEFAULT_COMPANION_PRESET.profile,
  });
}

/** The shipped document with one entry's `prompts[]` and `prompt_order` switches set together, as SillyTavern writes them. */
function withEntryDisabled(document: Record<string, unknown>, identifier: string): Record<string, unknown> {
  const prompts = (document.prompts as Record<string, unknown>[]).map((entry) =>
    entry.identifier === identifier ? { ...entry, enabled: false } : entry,
  );
  const promptOrder = (document.prompt_order as { character_id: number; order: unknown[] }[]).map((group) => ({
    ...group,
    order: group.order.map((row) =>
      (row as { identifier: string }).identifier === identifier ? { ...(row as object), enabled: false } : row,
    ),
  }));
  return { ...document, prompts, prompt_order: promptOrder };
}

test("the shipped preset contributes its sampler values, its `main` to the system segment and its post-history entry at the tail", () => {
  const preset = shippedPreset();
  // The source is the reading's provenance, not a decoration: the tail block's authority is which file it came from.
  assert.equal(preset.source, SHIPPED_PRESET_PATH);
  assert.deepEqual(Object.keys(preset.sampling), [
    "temperature",
    "top_p",
    "top_k",
    "repetition_penalty",
    "presence_penalty",
    "frequency_penalty",
  ]);
  assert.equal(preset.sampling.temperature, 1);
  assert.equal(preset.sampling.repetition_penalty, 1);
  // Nothing is refused as "not applied" for our own file: the budget field is gone from it (`preset-sampling.ts`).
  assert.deepEqual(preset.notApplied, []);

  assert.equal(preset.main.disposition, "applied");
  assert.equal(preset.main.segment, "system");
  assert.match(preset.main.text, /系统总纲与角色扮演框架|你正在扮演/u);
  assert.equal(preset.postHistory.disposition, "applied");
  assert.equal(preset.postHistory.segment, "tail");
  assert.match(preset.postHistory.text, /最新回复约束/u);
  // `{{user}}`/`{{char}}` are rendered by the preset's own evaluator, with the companion's name from the profile.
  assert.ok(!preset.postHistory.text.includes("{{char}}"), "an entry's macros must be rendered, never published raw");
  assert.deepEqual(preset.disabled, []);
});

test("a preset that switches `main` off produces no system segment and says `disabled_by_preset`, not an empty string", () => {
  const preset = shippedPreset(withEntryDisabled(shippedDocument(), "main"));
  assert.deepEqual(preset.disabled, ["main"]);
  assert.equal(preset.main.disposition, "disabled_by_preset");
  assert.equal(preset.main.text, "");
  // Absence is rendered as absence: no frame around nothing.
  assert.equal(renderPresetMainSegment(preset.main), "");
  // And the entry that IS on still arrives, so one switch does not silence the rest.
  assert.equal(preset.postHistory.disposition, "applied");
});

test("a post-history entry the preset moved inside the transcript is named, not relocated to the tail", () => {
  const document = shippedDocument();
  const prompts = (document.prompts as Record<string, unknown>[]).map((entry) =>
    entry.identifier === "jailbreak" ? { ...entry, injection_depth: 3 } : entry,
  );
  const preset = shippedPreset({ ...document, prompts });
  assert.equal(preset.postHistory.disposition, "placed_inside_transcript");
  assert.equal(preset.postHistory.text, "");
});

test("a preset that does not define the entry at all says `absent_from_preset`", () => {
  const document = shippedDocument();
  const prompts = (document.prompts as Record<string, unknown>[]).filter((entry) => entry.identifier !== "jailbreak");
  const promptOrder = (document.prompt_order as { character_id: number; order: unknown[] }[]).map((group) => ({
    ...group,
    order: group.order.filter((row) => (row as { identifier: string }).identifier !== "jailbreak"),
  }));
  const preset = shippedPreset({ ...document, prompts, prompt_order: promptOrder });
  assert.equal(preset.postHistory.disposition, "absent_from_preset");
  assert.equal(preset.postHistory.text, "");
  assert.equal(renderPresetMainSegment(preset.main).length > 0, true, "the rest of the preset is still applied");
});

test("the system segment frames the preset under the floor and says the floor still wins", () => {
  const segment = renderPresetMainSegment(shippedPreset().main);
  assert.match(segment, /<<<PRESET MAIN>>>/u);
  assert.match(segment, /<<<END PRESET MAIN>>>/u);
  // The three-part protection, the same one `renderPlayerPromptAddition` uses: name, delimit, re-assert.
  assert.match(segment, /cannot add to, take away from, or loosen what is stated above/u);
  assert.match(segment, /what is stated above still holds/u);
  assert.ok(segment.includes(shippedPreset().main.text), "the preset's own words ride verbatim inside the frame");
});

test("an overlap with the floor is reported with both lengths and the floor's own line, and both texts are kept", () => {
  const floor = ["【总纲】", "Stay in character at all times.", "Answer briefly."].join("\n");
  const preset = shippedPreset();
  const overlapping: GameSessionPreset = Object.freeze({
    ...preset,
    main: Object.freeze({ ...preset.main, text: `${preset.main.text}\nStay in character at all times.` }),
  });
  const overlaps = presetOverlaps({ preset: overlapping, floor });
  assert.equal(overlaps.length, 1);
  assert.deepEqual(
    { segment: overlaps[0]?.segment, identifier: overlaps[0]?.identifier, anchor: overlaps[0]?.floorAnchor },
    { segment: "system", identifier: "main", anchor: "Stay in character at all times." },
  );
  assert.equal(overlaps[0]?.presetChars, overlapping.main.text.length);
  assert.equal(overlaps[0]?.floorChars, floor.length);
  const line = formatPresetOverlap(overlaps[0]!);
  assert.equal(
    line,
    `preset_overlap:system:main:preset=${String(overlapping.main.text.length)}ch:floor=${String(floor.length)}ch:anchor=Stay in character at all times.`,
  );
  // The ruling is "apply the preset": the overlap is reported, and the segment still carries both.
  assert.ok(renderPresetMainSegment(overlapping.main).includes("Stay in character at all times."));
  assert.ok(floor.includes("Stay in character at all times."));
  // A short shared fragment is punctuation, not a duplicated instruction.
  assert.deepEqual(presetOverlaps({ preset: overlapping, floor: "a" }), []);
});

test("the tail block decision is published, absent or refused by name - the three answers never collapse into one", () => {
  const preset = shippedPreset();
  assert.equal(decidePresetTailBlock(preset.postHistory).kind, "published");
  assert.equal(decidePresetTailBlock(undefined).kind, "absent");
  const disabled: GameSessionPreset = Object.freeze({
    ...preset,
    postHistory: Object.freeze({ ...preset.postHistory, disposition: "disabled_by_preset", text: "" }),
  });
  assert.equal(decidePresetTailBlock(disabled.postHistory).kind, "absent");
  // A macro the preset's evaluator left standing is refused, and the reason survives.
  const macroLeft: GameSessionPreset = Object.freeze({
    ...preset,
    postHistory: Object.freeze({ ...preset.postHistory, text: "结尾说一句 {{unknownThing}}。" }),
  });
  assert.deepEqual(decidePresetTailBlock(macroLeft.postHistory), {
    kind: "refused",
    reason: "unrecognised_macro",
    detail: "{{unknownThing}}",
  });
  // Over the published byte bound: refused whole, never truncated. The fixture is derived FROM the bound, so a
  // changed bound moves the fixture with it instead of making this assertion silently stop measuring.
  const overBoundText = "长".repeat(Math.ceil(PRESET_TAIL_PUBLICATION_BYTE_BOUND / 3) + 1);
  assert.ok(Buffer.byteLength(overBoundText, "utf8") > PRESET_TAIL_PUBLICATION_BYTE_BOUND);
  const huge: GameSessionPreset = Object.freeze({
    ...preset,
    postHistory: Object.freeze({ ...preset.postHistory, text: overBoundText }),
  });
  const overBound = decidePresetTailBlock(huge.postHistory);
  assert.equal(overBound.kind, "refused");
  assert.equal(overBound.kind === "refused" ? overBound.reason : null, "over_byte_bound");
});

test("a runtime cwd with no preset file answers null, and one with an unreadable file fails by name", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const cwd = await mkdtemp(join(tmpdir(), "gamebuddy-preset-game-session-"));
  try {
    assert.equal(await readGameSessionPreset(cwd, { profile: DEFAULT_COMPANION_PRESET.profile }), null);
    await writeFile(join(cwd, GAME_SESSION_PRESET_FILE), "{ not json", "utf8");
    await assert.rejects(readGameSessionPreset(cwd, { profile: DEFAULT_COMPANION_PRESET.profile }), {
      message: `game_session_preset_unreadable:${join(cwd, GAME_SESSION_PRESET_FILE)}`,
    });
    // And the real file, mounted as provisioning mounts it, reads back as the same preset.
    await writeFile(join(cwd, GAME_SESSION_PRESET_FILE), readFileSync(SHIPPED_PRESET_PATH, "utf8"), "utf8");
    const mounted = await readGameSessionPreset(cwd, { profile: DEFAULT_COMPANION_PRESET.profile });
    assert.equal(mounted?.main.disposition, "applied");
    assert.equal(mounted?.source, join(cwd, GAME_SESSION_PRESET_FILE));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
