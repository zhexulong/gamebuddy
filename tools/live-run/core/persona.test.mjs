import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { glob, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assessLiveRunPresetSurface,
  buildReport,
  censusLine,
  gateDeclaration,
  RULES,
} from "../../check-live-run-preset-surface.mjs";
import { assertNonVacuous } from "../../lib/assert-non-vacuous.mjs";
import {
  assertLiveRunPersonaMounted,
  LIVE_RUN_PERSONA_DIR,
  LIVE_RUN_SURFACE,
  liveRunPersonaPaths,
  provisionLiveRunPersona,
  readLiveRunPersonaIdentity,
  readPresetDeclarations,
  resolveLiveRunGenerationPreset,
  resolveLiveRunHostBuildRoot,
} from "./persona.mjs";

/**
 * A preset that declares no surface at all: as many surfaces as an empty list. The model-named card this unit was built
 * for is one of these, so every assertion about that bucket reads the same predicate instead of spelling `length === 0`.
 */
const NO_SURFACES = Object.freeze([]);
const declaresNothing = (entry) => entry.surfaces.length === NO_SURFACES.length;

/** What each preset in a population says about itself, for a failure message that names members rather than a count. */
const censusOf = (declarations) =>
  declarations.map((entry) => `${entry.file}: ${entry.surfaces.join("+") || "no surface"}`).join("; ");

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

test("the generation preset is the one whose own declaration is this surface's - not a file named here", () => {
  // The defect this replaces: the binding was the literal `amber-deepseek-v4.1.json`, whose declaration reads
  // 「琥珀 · DeepSeek-V4.1 星露谷伴侣预设」 - a model, not a surface. Every Game run mounted it, and the preset that
  // declares itself the Game surface's never reached a run. So the binding is READ OUT OF THE DECLARATIONS, and this
  // test asserts the property rather than the file name: the run mounts the unique preset that declares its surface.
  const declarations = readPresetDeclarations();
  assert.ok(
    declarations.length > 0,
    "an empty preset population agrees with itself; the binding must be read from real declarations",
  );
  const declaring = declarations.filter((entry) => entry.surfaces.includes(LIVE_RUN_SURFACE));
  // Named, not counted. The binding refuses an ambiguous or a missing surface by naming every preset and what it declares,
  // so both directions of drift read as members: two declarers are the refusal's candidate list, none is its census.
  const resolved = resolveLiveRunGenerationPreset();
  assert.deepEqual(
    declaring.map((entry) => entry.file),
    [resolved.file],
    `examined ${declarations.length} preset(s): the run mounts ${resolved.file}, so that file alone may declare ` +
      `${LIVE_RUN_SURFACE} - declaring: [${declaring.map((entry) => entry.file).join(", ")}]`,
  );
  assert.equal(resolved.surface, LIVE_RUN_SURFACE);
  // The file provisioning copies IS the resolved one - the same fact, read through the path the run uses.
  assert.equal(path.basename(liveRunPersonaPaths().presetPath), resolved.file);
  // A preset that names no surface must exist in the population, and must not be the binding: that pairing is the
  // whole unit, and without it this test would pass on a directory where every preset declared the same thing.
  assert.ok(
    declarations.filter(declaresNothing).length > 0,
    `examined ${declarations.length} preset(s) and found none that declares no surface, so the model-named case this \
unit was built for is no longer represented: [${censusOf(declarations)}]`,
  );
  assert.ok(
    declarations.some((entry) => entry.surfaces.length > 0 && !entry.surfaces.includes(LIVE_RUN_SURFACE)),
    "another surface must be declared by some preset, or telling the two apart proves nothing",
  );
});

test("the binding refuses a directory where its surface is declared twice, and one where it is declared nowhere", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-presets-"));
  const write = (name, document) => writeFile(path.join(dir, name), JSON.stringify(document), "utf8");
  const preset = (name) => ({ name, description: "", prompts: [], prompt_order: [] });
  try {
    await write("game-a.json", preset("琥珀 (Game Surface)"));
    await write("game-b.json", preset("第二版 (Game Surface)"));
    assert.throws(
      () => resolveLiveRunGenerationPreset({ presetsDir: dir }),
      (error) => {
        assert.equal(error.code, "live_run_generation_preset_ambiguous");
        // The refusal names both claimants; "ambiguous" alone sends the reader to the directory to re-derive which.
        assert.match(error.message, /game-a\.json,game-b\.json/u);
        return true;
      },
    );
    await rm(path.join(dir, "game-b.json"));
    await rm(path.join(dir, "game-a.json"));
    // A preset that names a model and a preset that declares the other surface: the run's surface is declared nowhere.
    await write("chat.json", preset("琥珀 (Chat Surface)"));
    await write("amber-deepseek-v4.1.json", preset("琥珀 · DeepSeek-V4.1 星露谷伴侣预设"));
    assert.throws(
      () => resolveLiveRunGenerationPreset({ presetsDir: dir }),
      (error) => {
        assert.equal(error.code, "live_run_generation_preset_missing");
        // Every preset is named WITH what it declares, so the model-named file and the other surface's file are both
        // visible in the refusal rather than left for the reader to look up.
        assert.match(error.message, /chat\.json declares Chat Surface/u);
        assert.match(error.message, /amber-deepseek-v4\.1\.json declares no surface/u);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "provisioning copies the card, its book AND the generation preset byte for byte, with no preprocessing",
  {
    skip: REQUIRES_HOST_BUILD,
  },
  async () => {
    const { root, identity, runtimeCwd } = await runtimeRoot();
    try {
      const provisioned = await provisionLiveRunPersona(runtimeCwd, { identity, root });
      const [{ cardPath, worldbookPath, presetPath }] = [{ ...provisioned }];
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
      // The generation preset is the same kind of input: the reviewed file, byte for byte, mounted under the name the
      // Host reads it by (`host/src/tavern/preset-game-session.ts`). A run whose review asks whether the preset shaped
      // the session needs the file to be the authored one, not a copy that was normalised on the way in.
      assert.deepEqual(
        await readFile(presetPath, "utf8"),
        await readFile(path.join(runtimeCwd, "preset.json"), "utf8"),
        "preset.json must be identical after provisioning",
      );
      const mounted = await assertLiveRunPersonaMounted(runtimeCwd, { identity, root });
      assert.equal(mounted.ok, true, JSON.stringify(mounted.problems));
      assert.equal(mounted.worldBookEntries, provisioned.identity.worldBookEntries);
      assert.equal(mounted.generationPreset, path.join(runtimeCwd, "preset.json"));
      assert.ok(mounted.generationPrompts > 0, "the mounted preset must declare its prompt entries");
      assert.ok(mounted.generationEnabled > 0, "and at least one of them must be switched on");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
      // The durable profile carries the AUTHOR's text, macros and all (`candidateToIdentityProfile`): that
      // record is what a card export writes back, and rendering belongs to the READER - `renderIdentityProfile`
      // expands the profile through `identityProfileMacros` when it builds the Tier-1 prefix. A stored
      // `{{char}}` is therefore correct authored form, and "no raw macro reaches the prefix" is a claim about
      // the RENDERED text. The render below is the built product's own, never a copy of its rules here: a
      // hand-rolled converter would consume the macro before storage (first assert) or resolve it by rules of
      // its own (second assert).
      const buildRoot = pathToFileURL(`${BUILD_ROOT}${path.sep}`);
      const [{ renderMacros }, { identityProfileMacros }] = await Promise.all([
        import(new URL("tavern/macro-engine.js", buildRoot).href),
        import(new URL("identity-profile.js", buildRoot).href),
      ]);
      assert.match(
        profile.persona.core,
        /\{\{\s*(?:char|user)\s*\}\}/u,
        "the reviewed card's persona must still carry authored macros, or the render asserted below is vacuous",
      );
      // `identityProfileMacros` is the one table `renderIdentityProfile` renders a profile through: `{{char}}`
      // is her name and `{{user}}` is the run's word for the player - a noun under every locale, so which
      // locale a run picks does not change what this asserts.
      const renderedCore = renderMacros(profile.persona.core, identityProfileMacros(profile));
      assert.doesNotMatch(renderedCore, /\{\{\s*(?:char|user)\s*\}\}/u);
      assert.ok(renderedCore.includes(profile.identity.name), "{{char}} must resolve to her name, not to nothing");
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
        path.join(
          root,
          "tavern",
          "v1",
          "companions",
          "*",
          "greetings",
          provisioned.greeting.greetingSetId,
          "revisions",
          "*.json",
        ),
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

test("provisioning seeds the scenario record the character panel reads", { skip: REQUIRES_HOST_BUILD }, async () => {
  // The third block of an empty character panel: the panel renders the scenario record, so a run
  // that never creates one answers 还没有保存场景 for a card that carries a scenario - which reads
  // as "this card has none" rather than "the run did not install it".
  const { root, identity, runtimeCwd } = await runtimeRoot();
  try {
    const card = JSON.parse(await readFile(path.join(LIVE_RUN_PERSONA_DIR, "card.json"), "utf8"));
    const provisioned = await provisionLiveRunPersona(runtimeCwd, { identity, root });
    assert.notEqual(provisioned.scenario, null);
    assert.equal(provisioned.scenario.created, true);
    const mounted = await assertLiveRunPersonaMounted(runtimeCwd, { identity, root });
    assert.deepEqual(mounted.problems, []);
    assert.deepEqual(mounted.scenario, { revision: provisioned.scenario.revision, name: "Default Scenario" });
    // The stored text is the decoder's own, unmodified: a harness that rewrote the card's scenario
    // would make a live run and a player's import disagree about what the same card means.
    const companions = [];
    for await (const match of glob(path.join(root, "tavern", "v1", "companions", "*"))) companions.push(match);
    const scenarioFiles = [];
    for await (const match of glob(path.join(companions[0], "scenarios", "*", "revisions", "*.json")))
      scenarioFiles.push(match);
    assert.equal(scenarioFiles.length, 1);
    const stored = JSON.parse(await readFile(scenarioFiles[0], "utf8"));
    assert.equal((stored.artifact ?? stored).description, card.data.scenario);
    // And the record's absence is what the mount assertion is for.
    await rm(path.join(companions[0], "scenarios"), { recursive: true, force: true });
    const unmounted = await assertLiveRunPersonaMounted(runtimeCwd, { identity, root });
    assert.equal(unmounted.problems.includes("scenario_record_absent"), true, JSON.stringify(unmounted.problems));
    assert.equal(unmounted.scenario, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unmounted run is a failure that names itself, never a bland companion", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-empty-"));
  try {
    const mounted = await assertLiveRunPersonaMounted(cwd);
    assert.equal(mounted.ok, false);
    assert.deepEqual(mounted.problems.sort(), ["card_json_absent", "identity_profile_absent", "worldbook_json_absent"]);
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
    await writeFile(
      path.join(cwd, "card.json"),
      JSON.stringify({ spec: "chara_card_v2", data: { name: "琥珀" } }),
      "utf8",
    );
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

// ---------------------------------------------------------------------------------------------------------------------
// The gate that pairs the mounted preset with its own declaration.
//
// These cases live in THIS suite, not beside the gate, for one reason: this file is the one a package.json script runs
// (`suite:live-run-harness`), and a falsifier nothing invokes is indistinguishable from a passing one - the red-proof
// audit reports exactly that as `red_proof_nothing_runs`. The subject is the same either way: the preset the live run
// mounts must be the preset that declares itself this surface's.
// ---------------------------------------------------------------------------------------------------------------------

const GATE = fileURLToPath(new URL("../../check-live-run-preset-surface.mjs", import.meta.url));

/** The reviewable document a preset is, reduced to the two fields a declaration is read from. */
const preset = (name, description = "") =>
  JSON.stringify({ name, description, prompts: [], prompt_order: [] }, null, 2);

/** A world book is not a preset: it carries `entries` and no `prompts`. */
const worldbook = () => JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2);

async function syntheticPresets(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "preset-surface-"));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text, "utf8");
  return dir;
}

function runGate(argv) {
  const result = spawnSync(process.execPath, [GATE, ...argv], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("the gate's declaration keeps it in the one gate registry", () => {
  // The registry refuses `gate_declaration_invalid:<path>:id` unless the id is the file's slug, and a gate whose
  // declaration drifts out of the closed sets leaves the population silently - so the pairing is asserted, not assumed.
  assert.equal(gateDeclaration.id, "check-live-run-preset-surface");
  assert.equal(gateDeclaration.domain, "product");
  assert.equal(gateDeclaration.tier, "l1");
  assert.equal(gateDeclaration.kind, "contract");
});

test("the gate on the real tree: the run mounts the preset whose own declaration is the Game surface's", () => {
  const assessment = assessLiveRunPresetSurface();
  const declarations = readPresetDeclarations();
  assert.equal(assessment.status, "passed", JSON.stringify(assessment.findings));
  // Derived, not pinned to a count: the population is every preset document in the reviewed directory.
  assert.equal(assessment.examined, declarations.length);
  assert.equal(assessment.declaredSurface + assessment.declaredNone, assessment.examined);
  assert.ok(assessment.examined > 0);
  // The two halves of the pair, from their own authorities: the file the harness copies, and that file's declaration.
  const resolved = resolveLiveRunGenerationPreset();
  assert.equal(assessment.binding, resolved.file);
  assert.equal(assessment.bindingSurface, LIVE_RUN_SURFACE);
  const declaringNothing = declarations.filter(declaresNothing);
  assert.equal(assessment.declaredNone, declaringNothing.length, "the gate's own census of the surfaceless presets");
  // The file that produced the defect is IN the "declares none" bucket, classified by its own text, so a reader of the
  // census sees the model-named preset rather than a number that hides it.
  assert.deepEqual(
    declaringNothing.filter((entry) => entry.name === null).map((entry) => entry.file),
    [],
    `examined ${declarations.length} preset(s): every one that declares no surface must still carry the name that says ` +
      `why, and these do not: [${censusOf(declaringNothing)}]`,
  );
  const declaringSurface = declarations.filter((entry) => entry.surfaces.includes(LIVE_RUN_SURFACE));
  assert.deepEqual(
    declaringSurface.map((entry) => entry.file),
    [resolved.file],
    `exactly one preset may declare ${LIVE_RUN_SURFACE}, and the run must mount it - declaring: ` +
      `[${declaringSurface.map((entry) => entry.file).join(", ")}]`,
  );
});

test("RED on the shipped binding: the model-named preset this lane replaced is refused by name", () => {
  // The literal `persona.mjs` carried. Nothing is edited to replay it: the gate judges the binding it is given, which is
  // what makes this the falsifier for the gate rather than a restatement of the fix.
  const shipped = path.join(LIVE_RUN_PERSONA_DIR, "..", "amber-deepseek-v4.1.json");
  const assessment = assessLiveRunPresetSurface({ bindingPath: shipped });
  assert.equal(assessment.status, "failed");
  assert.deepEqual(
    assessment.findings.map((finding) => `${finding.code}:${finding.id}`),
    ["live_run_uses_a_preset_for_another_surface:amber-deepseek-v4.1.json:none"],
  );
  // The finding says WHY none: a declaration naming a model is the case that shipped, and a bare "none" would send the
  // next reader to the file to re-derive that.
  assert.match(assessment.findings[0].detail, /names a model, not a surface/u);
  assert.match(assessment.findings[0].detail, /DeepSeek-V4\.1/u);
});

test("RED when the bound preset declares the other surface", async () => {
  const dir = await syntheticPresets({
    "game.json": preset("琥珀 (Game Surface)"),
    "chat.json": preset("琥珀 (Chat Surface)"),
  });
  try {
    const assessment = assessLiveRunPresetSurface({ presetsDir: dir, bindingPath: path.join(dir, "chat.json") });
    assert.equal(assessment.status, "failed");
    assert.deepEqual(
      assessment.findings.map((finding) => `${finding.code}:${finding.id}`),
      ["live_run_uses_a_preset_for_another_surface:chat.json:Chat Surface"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RED when two presets claim the run's surface, and when none does", async () => {
  const ambiguous = await syntheticPresets({
    "game-a.json": preset("琥珀 (Game Surface)"),
    "game-b.json": preset("第二版 (Game Surface)"),
  });
  const missing = await syntheticPresets({ "chat.json": preset("琥珀 (Chat Surface)"), "book.json": worldbook() });
  try {
    const both = assessLiveRunPresetSurface({ presetsDir: ambiguous });
    assert.equal(both.status, "failed");
    assert.equal(both.findings[0].code, "live_run_preset_surface_ambiguous");
    assert.equal(both.findings[0].id, "Game Surface:game-a.json,game-b.json");
    // A refusal that says "ambiguous" and not WHICH presets, and what each declares, sends the next reader to the
    // directory to re-derive the one fact the gate already had.
    assert.match(both.findings[0].detail, /game-a\.json declares Game Surface/u);
    assert.match(both.findings[0].detail, /game-b\.json declares Game Surface/u);

    // A world book is not a preset, so this directory's population is one preset that declares the other surface: the
    // run's surface is declared nowhere and the gate must say so rather than fall back to the only file it can see.
    const none = assessLiveRunPresetSurface({ presetsDir: missing });
    assert.equal(none.status, "failed");
    assert.equal(none.examined, 1, "a world book must not join the preset population");
    assert.equal(none.findings[0].code, "live_run_preset_surface_missing");
    assert.match(none.findings[0].detail, /chat\.json declares Chat Surface/u);
  } finally {
    await rm(ambiguous, { recursive: true, force: true });
    await rm(missing, { recursive: true, force: true });
  }
});

test("RED on a preset that declares two surfaces, and on a bound file that is not a preset at all", async () => {
  const dir = await syntheticPresets({
    "both.json": preset("双表面预设 (Game Surface) (Chat Surface)"),
    "book.json": worldbook(),
  });
  try {
    const conflict = assessLiveRunPresetSurface({ presetsDir: dir, bindingPath: path.join(dir, "both.json") });
    const conflictFinding = conflict.findings.find((entry) => entry.code === "live_run_preset_surface_conflict");
    assert.notEqual(conflictFinding, undefined, JSON.stringify(conflict.findings));
    assert.equal(conflictFinding.id, "both.json");
    // `book.json` is a real file in the directory but not a preset document: the binding must not be excused by being
    // present, only by declaring this surface.
    const notPreset = assessLiveRunPresetSurface({ presetsDir: dir, bindingPath: path.join(dir, "book.json") });
    const notPresetFinding = notPreset.findings.find((entry) => entry.code === "live_run_preset_not_in_population");
    assert.notEqual(notPresetFinding, undefined, JSON.stringify(notPreset.findings));
    assert.equal(notPresetFinding.id, "book.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BLOCKED, not green, when the directory carries no presets at all", async () => {
  const dir = await syntheticPresets({ "book.json": worldbook() });
  try {
    const assessment = assessLiveRunPresetSurface({ presetsDir: dir });
    assert.equal(assessment.status, "blocked");
    assert.equal(assessment.reason, "presets_population_empty");
    assert.equal(assessment.examined, 0);
    assert.equal(assessLiveRunPresetSurface({ presetsDir: path.join(dir, "absent") }).status, "blocked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the gate's report is a measurement a harness can refuse on, and its exit code follows the verdict", async () => {
  const assessment = assessLiveRunPresetSurface();
  const report = buildReport(assessment);
  assert.equal(report.status, "passed");
  assert.equal(report.population, assessment.examined);
  assert.ok(report.checks.length >= RULES.length);
  // The shared judge, not a restatement of it: `passed` beside a zero population is not a measurement.
  assert.notEqual(assertNonVacuous(report).status, "blocked");
  for (const rule of RULES)
    assert.ok(
      report.checks.some((check) => check.id === rule),
      `${rule} has no verdict entry`,
    );
  assert.match(censusLine(assessment), /^presets examined \d+ · declare a surface \d+ · declare none \d+$/u);

  const green = runGate([]);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /^presets examined \d+ · declare a surface \d+ · declare none \d+$/mu);

  const red = runGate(["--binding", path.join(LIVE_RUN_PERSONA_DIR, "..", "amber-deepseek-v4.1.json")]);
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /^live_run_uses_a_preset_for_another_surface:amber-deepseek-v4\.1\.json:none/mu);

  const empty = await syntheticPresets({ "book.json": worldbook() });
  try {
    const blocked = runGate(["--presets-dir", empty, "--json"]);
    assert.equal(blocked.status, 2, blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).status, "blocked");
    assert.equal(JSON.parse(blocked.stdout).population, 0);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
