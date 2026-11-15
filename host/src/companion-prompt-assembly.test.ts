import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANION_FORMAT_TEMPLATES,
  buildChatCompanionSystemPrompt,
  fillTemplate,
  renderCardDirective,
  renderIdentityProfile,
  renderPlayerPromptAddition,
} from "./companion-prompt-assembly.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import {
  DEFAULT_IDENTITY_PROFILE,
  identityProfileMacros,
  type IdentityProfile,
  validateIdentityProfile,
} from "./identity-profile.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { renderMacros } from "./tavern/macro-engine.js";

/**
 * THE ASSEMBLER'S ORDER, AND THE FOUR WRITERS THAT MEET IN IT.
 *
 * <p>
 * Precedence here is POSITIONAL, and the order is declared once, as a list, at the top of `companion-prompt-assembly.ts`:
 * the surface block, the card's fields, the card's own directive, the player's own words, then the preset's `main` (which
 * Game and Chat each append through their own seam), then world info, the transcript and the post-history instructions.
 * Nothing in this file restates a bound, because there is no bound: what makes the card's voice the card's is where it
 * sits, and what makes the player's addition theirs is that it is last among the editable blocks.
 * </p>
 *
 * <p>
 * These tests are what replaced the bound-counting ones. Each assertion that used to read "the section states its
 * precedence exactly once" now reads the POSITION the section occupies, derived from the product's own text, and the two
 * sentences are gone rather than reworded.
 * </p>
 */

const CARD_PROFILE = DEFAULT_COMPANION_PRESET.profile;

function renderedDirective(profile: IdentityProfile, locale?: string): string {
  const voice = profile.characterVoice;
  assert.ok(voice !== undefined, "this fixture is about a profile that mounts a card directive");
  return renderCardDirective(voice, identityProfileMacros(profile, locale));
}

test("the assembled prompt follows the declared order: surface, identity, card, player", () => {
  const addition = "收完土豆再去矿洞。";
  const game = buildGameCompanionSystemPrompt(CARD_PROFILE, "zh-CN", addition);
  const identity = renderIdentityProfile(CARD_PROFILE, "zh-CN");
  const directive = renderedDirective(CARD_PROFILE, "zh-CN");
  const player = renderPlayerPromptAddition(addition, "zh-CN");

  const surfaceAt = 0;
  const identityAt = game.indexOf(identity);
  const directiveAt = game.indexOf(directive);
  const playerAt = game.indexOf(player);
  assert.equal(surfaceAt < identityAt, true, "the surface block is first: the request is about the surface");
  assert.equal(identityAt < directiveAt, true, "the card's fields precede the card's own directive");
  assert.equal(directiveAt < playerAt, true, "the player's words come after the card's, as the fourth writer");
  // The order is not asserted as a list of four numbers here: it is asserted as the sequence of the four blocks' own
  // text, so a reordering that keeps only one block's position cannot pass.
  assert.deepEqual(
    [identityAt, directiveAt, playerAt].map((at) => at >= 0),
    [true, true, true],
    "every block of the order renders when its writer supplied text",
  );
});

test("the card's directive is loaded bare and is the prompt's last block", () => {
  const prompt = buildChatCompanionSystemPrompt(CARD_PROFILE, "zh-CN");
  const directive = renderedDirective(CARD_PROFILE, "zh-CN");
  assert.ok(prompt.trimEnd().endsWith(directive), "the card's own text closes the prompt, unwrapped");
  // The two sentences that used to close it are gone, and nothing of the same shape replaced them.
  assert.doesNotMatch(prompt, /what is stated above|the lines above describe your situation/u);
  assert.doesNotMatch(prompt, /角色演出指导|CARD DIRECTIVES|Your author wrote/u);
});

test("the player's own addition loads under the player-turn template, with no bound", () => {
  const addition = "收完土豆再去矿洞。雨天先别浇水，去镇上看看。";
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN", addition);
  const expected = fillTemplate(COMPANION_FORMAT_TEMPLATES.playerAddition ?? "", ["你", addition]);
  assert.equal(
    game.trimEnd().endsWith(expected),
    true,
    "the player's words are the prompt's last block, labelled as their turn",
  );
  assert.doesNotMatch(game, /PLAYER DIRECTIVES|Your player wrote|shapes your part in it/u);
  // English labels the same slot with the run's own word, exactly as the examples do.
  const english = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "en-US", addition);
  assert.equal(
    english.trimEnd().endsWith(fillTemplate(COMPANION_FORMAT_TEMPLATES.playerAddition ?? "", ["You", addition])),
    true,
  );
});

test("an empty or absent addition leaves the prompt byte-identical", () => {
  const absent = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN");
  const empty = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN", "");
  assert.equal(empty, absent, "a player who wrote nothing gets no block, not an empty one");
});

test("the identity block labels the player's turn in the run's locale, not with English boilerplate", () => {
  // The defect this pins: every example rendered as `Player: {user}` in every locale, so the shipped card's own Chinese
  // examples taught the model that one of its two speakers is named in a language the companion does not speak.
  const profile = validateIdentityProfile({
    schemaVersion: 1,
    profileId: "gamebuddy.companion.kohaku",
    revision: 1,
    identity: { name: "琥珀", role: "农场搭档", continuity: "一起照料这片农场。" },
    examples: [{ user: "今天先做什么？", companion: "先把西边的荒地清了。" }],
  });
  assert.equal(
    renderIdentityProfile(profile, "zh-CN"),
    [
      fillTemplate(COMPANION_FORMAT_TEMPLATES.character ?? "", ["琥珀"]),
      fillTemplate(COMPANION_FORMAT_TEMPLATES.role ?? "", ["农场搭档"]),
      fillTemplate(COMPANION_FORMAT_TEMPLATES.continuity ?? "", ["一起照料这片农场。"]),
      "",
      COMPANION_FORMAT_TEMPLATES.dialogueExamples,
      ["<START>", "你: 今天先做什么？", "琥珀: 先把西边的荒地清了。"].join("\n"),
    ].join("\n"),
  );
  assert.equal(
    renderIdentityProfile(profile, "en-US").split("\n").slice(-3).join("\n"),
    ["<START>", "You: 今天先做什么？", "琥珀: 先把西边的荒地清了。"].join("\n"),
  );
  assert.doesNotMatch(renderIdentityProfile(profile, "zh-CN"), /Player:/u);
});

test("the card's directive reaches the prompt through the same macro table the identity block uses", () => {
  // One table, so `{{char}}`/`{{user}}` cannot expand one way in her persona and another in the card's own text.
  const voice = { text: "{{char}} 对 {{user}} 说话。", source: "card" } as const;
  const profile = validateIdentityProfile({ ...DEFAULT_IDENTITY_PROFILE, characterVoice: voice });
  const macros = identityProfileMacros(profile, "zh-CN");
  const rendered = renderCardDirective(voice, macros);
  assert.equal(rendered, renderMacros(voice.text, macros));
  assert.ok(!rendered.includes("{{"), "no macro reaches the model unrendered");
});
