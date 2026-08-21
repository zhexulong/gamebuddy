import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildChatCompanionSystemPrompt,
  buildCompanionSystemPrompt,
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
  const prompt = buildCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.match(
    prompt,
    /<gamebuddy_companion_identity profile_id="gamebuddy\.companion\.default" revision="1" canonical_hash="[a-f0-9]{64}">/,
  );
  assert.match(prompt, /This is a Host-owned stable identity block/);
  assert.equal(renderIdentityProfile(DEFAULT_IDENTITY_PROFILE).includes("tool output"), true);
});

test("buildChatCompanionSystemPrompt and buildGameCompanionSystemPrompt render pure character persona without companion_text", () => {
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(chatPrompt, /companion_text/);
  assert.doesNotMatch(chatPrompt, /private/);
  assert.match(chatPrompt, /<gamebuddy_companion_identity/);

  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(gamePrompt, /companion_text/);
  assert.doesNotMatch(gamePrompt, /private/);
  assert.match(gamePrompt, /<gamebuddy_companion_identity/);
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
        identity: { ...DEFAULT_IDENTITY_PROFILE.identity, role: "bad\nrole" },
      }),
    /invalid_identity_profile/,
  );
  assert.throws(
    () => validateIdentityProfile({ ...DEFAULT_IDENTITY_PROFILE, examples: [{ user: "ok", companion: "bad\nreply" }] }),
    /invalid_identity_profile/,
  );
});

test("IdentityProfile canonicalizes a bounded reviewed persona guide", () => {
  const profile = validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "gamebuddy.companion.rin",
    persona: { core: "calm", interactionStyle: "listen first", expressionStyle: "brief" },
    examples: [{ user: "tired", companion: "let us slow down" }],
  });
  assert.match(renderIdentityProfile(profile), /Core disposition: calm/);
  assert.match(renderIdentityProfile(profile), /Example 1 companion: let us slow down/);
  assert.notEqual(identityProfileHash(profile), identityProfileHash(DEFAULT_IDENTITY_PROFILE));
});

test("IdentityProfile writes reject a replaced symlink target without touching the outside sentinel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-identity-profile-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-identity-profile-outside-"));
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
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-identity-profile-"));
  const binding = createIdentityProfileBinding("a".repeat(64), DEFAULT_IDENTITY_PROFILE, "session.jsonl");
  const path = join(root, "binding.json");
  await writeFile(path, JSON.stringify(binding), "utf8");
  const stored = await readFile(path, "utf8");
  assert.match(stored, /canonicalHash/);
  assert.doesNotMatch(stored, /GameBuddy Companion/);
  assert.doesNotMatch(stored, /continuity/);
});
