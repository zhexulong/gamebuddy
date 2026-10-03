import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assessCapturedIdentityProfile, assessIdentityProfile, DEFAULT_PROFILE_ID } from "./content-gate.mjs";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "content-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const emptyDefaultProfile = Object.freeze({
  schemaVersion: 1,
  profileId: DEFAULT_PROFILE_ID,
  revision: 1,
  identity: Object.freeze({
    name: "GameBuddy Companion",
    role: "the player's game companion",
    continuity: "Maintain one continuous shared experience with the player across chat and game surfaces.",
  }),
});

const personatedProfile = Object.freeze({
  schemaVersion: 1,
  profileId: "gamebuddy.companion.imported",
  revision: 1,
  identity: Object.freeze({ name: "Whale Maiden", role: "guide", continuity: "shared" }),
  persona: Object.freeze({
    core: "A warm, quietly persistent companion who notices small details.",
    interactionStyle: "Listens first, asks briefly, never lectures.",
    expressionStyle: "Natural, plain-spoken, lightly playful.",
  }),
});

test("an empty default profile is reported as present=false and complete=false", () => {
  const assessed = assessIdentityProfile(emptyDefaultProfile);
  assert.equal(assessed.profileRead, true);
  assert.equal(assessed.isDefaultProfile, true);
  assert.equal(assessed.personaPresent, false);
  assert.equal(assessed.personaComplete, false);
  assert.deepEqual(assessed.personaFields, { core: false, interactionStyle: false, expressionStyle: false });
  assert.deepEqual(assessed.macroResidue, []);
});

test("a full persona is present and complete", () => {
  const assessed = assessIdentityProfile(personatedProfile);
  assert.equal(assessed.personaPresent, true);
  assert.equal(assessed.personaComplete, true);
  assert.equal(assessed.isDefaultProfile, false);
});

test("a single filled persona field is present but not complete", () => {
  const profile = { ...personatedProfile, persona: { core: "warm" } };
  const assessed = assessIdentityProfile(profile);
  assert.equal(assessed.personaPresent, true);
  assert.equal(assessed.personaComplete, false);
});

test("unrendered SillyTavern macros are detected as residue", () => {
  const profile = {
    ...personatedProfile,
    persona: { core: "{{char}} is a whale girl who lives in {{user}}'s world." },
  };
  const assessed = assessIdentityProfile(profile);
  assert.equal(assessed.personaPresent, true);
  assert.deepEqual(assessed.macroResidue, ["{{char}}", "{{user}}"]);
});

test("null/undefined profile is a read gap, not an assertion", () => {
  const assessed = assessIdentityProfile(null);
  assert.equal(assessed.profileRead, false);
  assert.equal(assessed.personaPresent, false);
  assert.deepEqual(assessed.macroResidue, []);
});

test("assessCapturedIdentityProfile finds the deep runtime-root profile and returns its facts", async (t) => {
  const dir = await scratch(t);
  const deep = join(dir, "runtime-root", "contexts", "abc", "surface-sessions", "s");
  await mkdir(deep, { recursive: true });
  await writeFile(join(dir, "runtime-root", "contexts", "abc", "identity-profile.json"), JSON.stringify(emptyDefaultProfile), "utf8");
  await writeFile(join(deep, "session.jsonl"), "{}", "utf8");

  const assessed = await assessCapturedIdentityProfile(dir);
  assert.equal(assessed.profileRead, true);
  assert.equal(assessed.personaPresent, false);
  assert.equal(assessed.isDefaultProfile, true);
});

test("a capture directory without a profile is a read gap", async (t) => {
  const dir = await scratch(t);
  await mkdir(join(dir, "runtime-root"), { recursive: true });
  const assessed = await assessCapturedIdentityProfile(dir);
  assert.equal(assessed.profileRead, false);
});

test("missing capture directory is a read gap", async (t) => {
  const dir = await scratch(t);
  const assessed = await assessCapturedIdentityProfile(join(dir, "nope"));
  assert.equal(assessed.profileRead, false);
});