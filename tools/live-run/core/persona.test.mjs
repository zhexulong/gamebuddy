import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertLiveRunPersonaMounted,
  LIVE_RUN_PERSONA_DIR,
  provisionLiveRunPersona,
  readLiveRunPersonaIdentity,
  resolveLiveRunHostBuildRoot,
} from "./persona.mjs";

/**
 * The persona is COMPILED by the product's own modules, so every test that provisions needs a built
 * Host — the same precondition the live-run loops themselves have. The assertion that catches a
 * placeholder identity needs no build: it reads the two files it compares.
 */
function hostBuildRoot() {
  try {
    return resolveLiveRunHostBuildRoot();
  } catch {
    return null;
  }
}
const BUILD_ROOT = hostBuildRoot();
const REQUIRES_HOST_BUILD = BUILD_ROOT === null ? "requires a built Host (host/dist-test or host/dist)" : false;

/** One runtime root per test, with the product's own path shape (`<root>/contexts/<identityKey>`). */
async function runtimeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "persona-run-"));
  const identity = Object.freeze({
    playerId: "player-live-test",
    companionId: "companion-live-test",
    continuityId: "continuity-live-test",
  });
  const { identityKey } = await import(new URL("runtime-identity.js", pathToFileURL(`${BUILD_ROOT}${path.sep}`)).href);
  const runtimeCwd = path.join(root, "contexts", identityKey(identity));
  await mkdir(runtimeCwd, { recursive: true });
  return { root, identity, runtimeCwd };
}

test("the canonical live-run card is present and identified", async () => {
  const identity = await readLiveRunPersonaIdentity();
  assert.equal(identity.dir, "default-companion");
  assert.equal(typeof identity.name, "string");
  assert.ok(identity.name.length > 0, "the card must carry a display name");
  assert.ok(identity.worldBookEntries > 0, "the card must ship its world book");
  // The reviewed preset directory is the CARD, not a runtime root: it carries no compiled profile, so
  // the mount assert has exactly one thing to say about it, and saying the card is mountable would be
  // the very confusion this unit exists to remove.
  const canonical = await assertLiveRunPersonaMounted(LIVE_RUN_PERSONA_DIR);
  assert.deepEqual(canonical.problems, ["identity_profile_absent"]);
  assert.ok(canonical.macroTokens > 0, "the reviewed card carries authored templating; that is recorded, not refused");
  // The card is the live-run persona by decision; a silently different directory is a change of subject.
  assert.ok(LIVE_RUN_PERSONA_DIR.endsWith(path.join("assets", "tavern", "presets", "default-companion")));
});

test("provisioning copies both files byte for byte, with no preprocessing", { skip: REQUIRES_HOST_BUILD }, async () => {
  const { root, identity, runtimeCwd } = await runtimeRoot();
  try {
    const provisioned = await provisionLiveRunPersona(runtimeCwd, { identity, root });
    const [{ cardPath, worldbookPath }] = [{ ...provisioned }];
    assert.deepEqual(
      await readFile(cardPath, "utf8"),
      await readFile(path.join(runtimeCwd, "card.json"), "utf8"),
      "card.json must be identical after provisioning",
    );
    assert.deepEqual(
      await readFile(worldbookPath, "utf8"),
      await readFile(path.join(runtimeCwd, "worldbook.json"), "utf8"),
      "worldbook.json must be identical after provisioning",
    );
    const mounted = await assertLiveRunPersonaMounted(runtimeCwd, { identity, root });
    assert.equal(mounted.ok, true, JSON.stringify(mounted.problems));
    assert.equal(mounted.worldBookEntries, provisioned.identity.worldBookEntries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "provisioning COMPILES the card into the identity profile the Host reads, not just the card file",
  { skip: REQUIRES_HOST_BUILD },
  async () => {
    // The failure this catches is the whole unit: the Host reads `<runtimeCwd>/identity-profile.json`
    // and never opens card.json, so before this the companion presented as the placeholder
    // "GameBuddy Companion" while the reviewed card's own name and persona sat unread beside it.
    const { root, identity, runtimeCwd } = await runtimeRoot();
    try {
      const card = JSON.parse(await readFile(path.join(LIVE_RUN_PERSONA_DIR, "card.json"), "utf8"));
      const cardName = card.data?.name ?? card.name;
      const provisioned = await provisionLiveRunPersona(runtimeCwd, { identity, root });
      const profile = JSON.parse(await readFile(path.join(runtimeCwd, "identity-profile.json"), "utf8"));
      assert.equal(profile.identity.name, cardName, "the compiled profile must carry the card's name");
      assert.equal(provisioned.profile.name, cardName);
      assert.match(profile.canonicalHash, /^[a-f0-9]{64}$/u, "the Host verifies this hash at read time");
      assert.ok(profile.persona.core.length > 0, "the card's described persona must survive the compile");
      // The card's own macros are rendered by the product's converter, so no raw {{char}} reaches the
      // Tier 1 prefix. If the compile were a hand-rolled second converter this is what would break.
      assert.doesNotMatch(profile.persona.core, /\{\{\s*(?:char|user)\s*\}\}/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "provisioning seeds the greeting record whose default variant is the card's opening",
  { skip: REQUIRES_HOST_BUILD },
  async () => {
    // The second half of the empty first screen: the initial-Chat saga opens on the greeting record's
    // default variant, so a run that only had card.json opened on `opening: "blank"`.
    const { root, identity, runtimeCwd } = await runtimeRoot();
    try {
      const card = JSON.parse(await readFile(path.join(LIVE_RUN_PERSONA_DIR, "card.json"), "utf8"));
      const provisioned = await provisionLiveRunPersona(runtimeCwd, { identity, root });
      assert.notEqual(provisioned.greeting, null);
      assert.equal(provisioned.greeting.created, true);
      assert.deepEqual(provisioned.greeting.variantIds, ["greeting-1", "greeting-2", "greeting-3"]);
      const records = [];
      for await (const match of glob(
        path.join(root, "tavern", "v1", "companions", "*", "greetings", provisioned.greeting.greetingSetId, "revisions", "*.json"),
      ))
        records.push(JSON.parse(await readFile(match, "utf8")));
      assert.equal(records.length, 1);
      const record = records[0].artifact ?? records[0];
      assert.equal(record.variants[0].label, "Default");
      assert.equal(record.variants[0].text, card.data.first_mes, "message zero must be the card's own opening");
      assert.equal(record.variants[1].text, card.data.alternate_greetings[0]);
      const mounted = await assertLiveRunPersonaMounted(runtimeCwd, { identity, root });
      assert.equal(mounted.ok, true, JSON.stringify(mounted.problems));
      assert.deepEqual(mounted.greeting, {
        greetingSetId: provisioned.greeting.greetingSetId,
        revision: 1,
        variants: 3,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an unmounted run is a failure that names itself, never a bland companion", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-empty-"));
  try {
    const mounted = await assertLiveRunPersonaMounted(cwd);
    assert.equal(mounted.ok, false);
    assert.deepEqual(mounted.problems.sort(), [
      "card_json_absent",
      "identity_profile_absent",
      "worldbook_json_absent",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a valid profile that is NOT this card's fails the mount assertion by name", async () => {
  // The pre-fix state was not a missing profile but a placeholder one: `readOrCreateIdentityProfile`
  // wrote DEFAULT_IDENTITY_PROFILE and locked it in. A profile that is merely valid must therefore
  // not pass; the assert compares the name the Host will present against the card's.
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-placeholder-"));
  try {
    await writeFile(path.join(cwd, "card.json"), JSON.stringify({ spec: "chara_card_v2", data: { name: "琥珀" } }), "utf8");
    await writeFile(path.join(cwd, "worldbook.json"), JSON.stringify({ entries: [{ content: "x" }] }), "utf8");
    await writeFile(
      path.join(cwd, "identity-profile.json"),
      JSON.stringify({
        schemaVersion: 1,
        profileId: "gamebuddy.companion.default",
        revision: 1,
        identity: { name: "GameBuddy Companion", role: "role", continuity: "continuity" },
        canonicalHash: "0".repeat(64),
      }),
      "utf8",
    );
    const mounted = await assertLiveRunPersonaMounted(cwd);
    assert.equal(mounted.ok, false);
    assert.deepEqual(mounted.problems, ["identity_profile_name_mismatch"]);
    assert.equal(mounted.profileName, "GameBuddy Companion");
    assert.equal(mounted.name, "琥珀");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an empty or macro-laden world book is refused", { skip: REQUIRES_HOST_BUILD }, async () => {
  const { root, identity, runtimeCwd } = await runtimeRoot();
  try {
    await provisionLiveRunPersona(runtimeCwd, { identity, root });
    // An empty book is the "hollow default" the game-side content gate already refuses.
    await writeFile(path.join(runtimeCwd, "worldbook.json"), JSON.stringify({ entries: [] }), "utf8");
    assert.equal((await assertLiveRunPersonaMounted(runtimeCwd)).problems.includes("worldbook_empty"), true);
    // The reviewed card itself ships templating, so its presence must NOT be a failure: it is counted,
    // and whether the runtime substitutes it is verified downstream.
    await writeFile(
      path.join(runtimeCwd, "worldbook.json"),
      JSON.stringify({ entries: [{ content: "{{char}} 你好" }] }),
      "utf8",
    );
    const templated = await assertLiveRunPersonaMounted(runtimeCwd);
    assert.equal(templated.ok, true, JSON.stringify(templated.problems));
    assert.equal(templated.macroTokens, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
