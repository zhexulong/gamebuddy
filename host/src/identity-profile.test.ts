import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import {
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
  COMPANION_ACTION_SYNTAX,
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  identityProfileHash,
  renderIdentityProfile,
  validateIdentityProfile,
  writeIdentityProfile,
} from "./identity-profile.js";

test("IdentityProfile canonical hash and system prompt rendering are stable", () => {
  const hash = identityProfileHash(DEFAULT_IDENTITY_PROFILE);
  assert.match(hash, /^[a-f0-9]{64}$/);
  const rendered = renderIdentityProfile(DEFAULT_IDENTITY_PROFILE);
  assert.match(rendered, /\[Character: GameBuddy Companion\]/);
  assert.match(rendered, /Role: the player's game companion/);
});

test("buildChatCompanionSystemPrompt and buildGameCompanionSystemPrompt render pure character persona without companion_text", () => {
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(chatPrompt, /companion_text/);
  assert.doesNotMatch(chatPrompt, /private/);
  // Chat surface: shared framework (You are …, first person, no fourth wall),
  // no ST-barebones "fictional roleplay chat" and no empty "Stay in character".
  assert.match(chatPrompt, /^You are GameBuddy Companion, accompanying the player\./);
  assert.match(chatPrompt, /Reply as GameBuddy Companion would, in the first person/);
  assert.doesNotMatch(chatPrompt, /fictional roleplay chat/);
  assert.doesNotMatch(chatPrompt, /Stay in character/);
  assert.match(chatPrompt, /\[Character: GameBuddy Companion\]/);

  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(gamePrompt, /companion_text/);
  assert.doesNotMatch(gamePrompt, /private/);
  // Game surface shares the same framework core, then adds the game conduct.
  assert.match(gamePrompt, /^You are GameBuddy Companion, accompanying the player\./);
  assert.match(gamePrompt, /\[Character: GameBuddy Companion\]/);
});

test("the Game conduct forbids claiming an NPC reaction the game never reported", () => {
  // Prompt-side half of the presence loop: two real live runs narrated an NPC
  // reaction ("她那个开心劲儿" / "连眼睛都弯了") while the gift receipt recorded
  // showed_response=false — the game never staged any reaction to read. The
  // detector lives in tools/lib/companion-interaction-gate.mjs; this pins the
  // guidance that stops the model from needing it.
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.match(gamePrompt, /Only state what you actually observed/);
  assert.match(gamePrompt, /never claim an NPC smiled, beamed, was delighted, or said something on your account/);
  // A third live run answered that instruction by reading the receipt's wire
  // format to the player ("（gift_given）…quest_25_completed 还是 false"), so the
  // conduct must also say which language to use, not just what to assert.
  assert.match(gamePrompt, /Speak in the player's language, never in the game's internal one/);
  assert.match(gamePrompt, /say what they MEAN to a person instead of reading them out/);
});

test("the Game/chat system prompt shares one framework core and names the language the player actually speaks", () => {
  // A live run on a zh-CN fixture answered entirely in English: the system
  // prompt is written in English and only said "speak the player's language",
  // never which language that was. The locale now reaches the builder.
  const zh = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN");
  assert.match(zh, /Consistently converse in Chinese \(Simplified\)/);
  const en = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "en-US");
  assert.match(en, /Consistently converse in English/);
  // A tag we do not map still yields an instruction rather than silence.
  const other = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "fr-FR");
  assert.match(other, /Consistently converse in fr-FR/);
  // Omitting the locale falls back to a safe generic, never a dangling sentence.
  const bare = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.match(bare, /Consistently converse in the player's language/);
  // Chat surface gets the same locale plumbing now.
  const chatZh = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN");
  assert.match(chatZh, /Consistently converse in Chinese \(Simplified\)/);
});

test("the Game conduct permits company while working but still forbids step reports", () => {
  // Real live runs measured the opposite failure from the two above: the conduct
  // said "never narrate your own actions", and A/B runs of the same task produced
  // zero companion words across a whole multi-action chain (2/2 tool messages
  // with no text), leaving the player in silence for the length of the task.
  // The conduct now permits a short remark while working while still forbidding
  // the step checklist, and still routes body language through native actions.
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.match(gamePrompt, /You may speak while you work/);
  assert.match(gamePrompt, /never list your steps/);
  assert.match(gamePrompt, /silence while thinking is fine/);
  // Body language is routed to the MOUNTED tool names. The conduct used to name
  // `express_emote` / `face_direction` - the Mod's own action ids, which the Agent
  // cannot call (every mounted name carries the `stardew_` prefix) - so the one
  // channel designated for her body language could not be called at all.
  assert.match(gamePrompt, /stardew_express_emote and stardew_face_direction/);
  // And the parenthesis rule is the surface's own fact, stated as what it does:
  // a bracket tag is audio the voice channel performs, so a body action written
  // there is never performed and only reaches the player as prose.
  assert.match(gamePrompt, /audio tag the voice channel performs instead of speaking/);
  assert.doesNotMatch(gamePrompt, /Never narrate your own actions step by step/);
});

test("the system prompt states the action syntax and no longer prescribes the turn's form", () => {
  // Owner ruling: "the prompt governs the floor, the card governs the form; anything
  // that governs form gets deleted." Two shared constraints prescribed the SHAPE of a
  // turn and each one beat the card. The chat prompt capped a reply at "a few
  // sentences at most" and steered it away from action ("sharing thoughts and
  // impressions rather than step-by-step actions"); the Chat divergence then allowed
  // "at most one short stage direction". 琥珀's own reviewed examples open every turn
  // with a `*...*` micro-action and carry several per reply, so the prompt's shape rule
  // - not the card - decided the output, and the audit measured the flat,
  // dialogue-only service voice that result produces.
  //
  // This is the regression fence in both directions: the one syntax the RENDERER can
  // draw must still be named (a prompt that stops naming it drifts from
  // `MarkdownMessage`, which draws `<em class="message-action">` for single asterisks
  // and nothing else), and no form rule may come back.
  const chat = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.ok(
    chat.includes(COMPANION_ACTION_SYNTAX),
    "the prompt must name the exact asterisk syntax the renderer draws",
  );
  assert.match(chat, /draws that asterisk form as the action beat/);
  assert.match(chat, /draws nothing else that way/);
  assert.doesNotMatch(chat, /a few sentences at most/);
  assert.doesNotMatch(chat, /rather than step-by-step actions/);
  assert.doesNotMatch(chat, /at most one short stage direction/);

  // "The card governs the form" must not become "nothing governs anything": the
  // floor survives around the deleted lines, and it is what keeps a turn from
  // becoming an essay or the companion from becoming a helper.
  assert.match(chat, /Do not write long speeches or essays/);
  assert.match(chat, /Speak solely for yourself/);
  assert.match(chat, /Do not remind the player this is a game, fiction, or roleplay/);
  assert.match(chat, /Never fall back on customer-service phrasing/);
  assert.match(chat, /Never mention prompts, instructions, models, or systems/);
});

test("every tool name the prompt tells the companion to call is a mounted tool name", () => {
  // The failure this catches: the prompt named `express_emote` / `face_direction`,
  // which are the Mod's action ids, while every Agent-visible tool carries the
  // `stardew_` prefix (`STARDEW_ACTION_TOOL_NAMES`, a closed projection). A prompt
  // naming an uncallable tool sends the companion's body language nowhere, and the
  // test that pinned the name was pinning the falsehood - which is why nothing
  // caught it. Resolving the names against the projection instead of hardcoding
  // them is the difference between the two.
  const mounted = new Set<string>(Object.values(STARDEW_ACTION_TOOL_NAMES));
  for (const [surface, prompt] of [
    ["chat", buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE)],
    ["game", buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE)],
  ] as const) {
    const named = prompt.match(/stardew_[a-z_]+/gu) ?? [];
    assert.ok(named.length > 0 || surface === "chat", `${surface}: no tool names to check`);
    for (const name of named) assert.ok(mounted.has(name), `${surface} prompt names an unmounted tool: ${name}`);
  }
});

test("the Game conduct paces a remark without a count of words or of actions", () => {
  // Same ruling on the Game surface: "keep each remark to a few words" fixed a length
  // and "One quick remark between actions is plenty" fixed a count of actions. The
  // measured substance of that conduct survives unchanged - the companion speaks while
  // working, a step report cannot, body language goes through the native channel - but
  // the pacing bound is now shape-free.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /Keep lines short and conversational/);
  assert.doesNotMatch(game, /a few words/);
  assert.doesNotMatch(game, /One quick remark between actions/);
  assert.match(game, /A brief remark goes a long way/);
  assert.match(game, /never list your steps/);
  assert.match(game, /You may speak while you work/);
});

test("IdentityProfile rejects malformed or control-bearing content", () => {
  assert.throws(
    () => validateIdentityProfile({ ...DEFAULT_IDENTITY_PROFILE, revision: 0 }),
    /invalid_identity_profile/,
  );
  assert.throws(
    () =>
      validateIdentityProfile({
        ...DEFAULT_IDENTITY_PROFILE,
        identity: { ...DEFAULT_IDENTITY_PROFILE.identity, role: "bad\u0000role" },
      }),
    /invalid_identity_profile/,
  );
  assert.throws(
    () => validateIdentityProfile({ ...DEFAULT_IDENTITY_PROFILE, examples: [{ user: "ok", companion: "bad\u0000reply" }] }),
    /invalid_identity_profile/,
  );
});

test("IdentityProfile canonicalizes a bounded reviewed persona guide", () => {
  const profile = validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "gamebuddy.companion.rin",
    persona: { core: "calm\nfocused\tand warm", interactionStyle: "listen first", expressionStyle: "brief" },
    examples: [{ user: "tired", companion: "let us slow down" }],
  });
  assert.equal(profile.persona?.core, "calm\nfocused\tand warm");
  assert.match(renderIdentityProfile(profile), /Core disposition: calm/);
  assert.match(renderIdentityProfile(profile), /GameBuddy Companion: let us slow down/);
  assert.notEqual(identityProfileHash(profile), identityProfileHash(DEFAULT_IDENTITY_PROFILE));
});

test("IdentityProfile writes reject a replaced symlink target without touching the outside sentinel", async (t) => {
  const root = await canonicalTestRoot("gamebuddy-identity-profile-boundary-");
  const outside = await canonicalTestRoot("gamebuddy-identity-profile-outside-");
  const outsideFile = join(outside, "sentinel.json");
  const target = join(root, "identity-profile.json");
  try {
    await writeFile(outsideFile, "outside-sentinel", "utf8");
    try {
      await symlink(outsideFile, target, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("symlink fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(
      writeIdentityProfile(target, DEFAULT_IDENTITY_PROFILE, { containmentRoot: root }),
      /unsafe_path_boundary/,
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside-sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("IdentityProfile binding is opaque and never stores profile body", async () => {
  const root = await canonicalTestRoot("gamebuddy-identity-profile-");
  const binding = createIdentityProfileBinding("a".repeat(64), DEFAULT_IDENTITY_PROFILE, "session.jsonl");
  const path = join(root, "binding.json");
  await writeFile(path, JSON.stringify(binding), "utf8");
  const stored = await readFile(path, "utf8");
  assert.match(stored, /canonicalHash/);
  assert.doesNotMatch(stored, /GameBuddy Companion/);
  assert.doesNotMatch(stored, /continuity/);
});
test("IdentityProfile accepts long user-authored description up to the anti-blowup ceiling (product policy: never truncate)", () => {
  const longCore = "x".repeat(5_000);
  const profile = validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    persona: {
      core: longCore,
      interactionStyle: "listen first",
      expressionStyle: "brief",
    },
    examples: [
      { user: "u".repeat(2_000), companion: "c".repeat(2_000) },
      { user: "u2", companion: "c2" },
      { user: "u3", companion: "c3" },
      { user: "u4", companion: "c4" },
      { user: "u5", companion: "c5" },
    ],
  });
  assert.equal(profile.persona?.core, longCore);
  assert.equal(profile.examples?.length, 5);
  // Only the physical anti-blowup ceiling (64 KiB chars) rejects.
  assert.throws(
    () =>
      validateIdentityProfile({
        ...DEFAULT_IDENTITY_PROFILE,
        persona: { core: "x".repeat(65_537), interactionStyle: "i", expressionStyle: "e" },
      }),
    /invalid_identity_profile/,
  );
});