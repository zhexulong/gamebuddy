import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import {
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
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
  assert.match(chatPrompt, /Write GameBuddy Companion's next reply in a fictional roleplay chat/);
  assert.match(chatPrompt, /\[Character: GameBuddy Companion\]/);

  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(gamePrompt, /companion_text/);
  assert.doesNotMatch(gamePrompt, /private/);
  assert.match(gamePrompt, /accompanying the player as an active in-game companion/);
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

test("the Game system prompt names the language the player actually speaks", () => {
  // A live run on a zh-CN fixture answered entirely in English: the system
  // prompt is written in English and only said "speak the player's language",
  // never which language that was. The locale now reaches the builder.
  const zh = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN");
  assert.match(zh, /Answer the player in Chinese \(Simplified\)\./);
  const en = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "en-US");
  assert.match(en, /Answer the player in English\./);
  // A tag we do not map still yields an instruction rather than silence.
  const other = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "fr-FR");
  assert.match(other, /Answer the player in fr-FR\./);
  // Omitting the locale keeps the previous prompt shape (no dangling sentence).
  const bare = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(bare, /Answer the player in/);
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
  // Parenthesised stage directions must stay out: body language goes through
  // express_emote / face_direction, which the conduct must still name.
  assert.match(gamePrompt, /express_emote \/ face_direction/);
  assert.match(gamePrompt, /do not write action or mood in parentheses/);
  assert.doesNotMatch(gamePrompt, /Never narrate your own actions step by step/);
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
