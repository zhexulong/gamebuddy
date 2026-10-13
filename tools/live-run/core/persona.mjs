/**
 * The live-run persona: one canonical card, compiled for EVERY loop.
 *
 * The product's authored-context path is a FILE CONVENTION, not a parameter: provisioning writes the
 * card's world book to `<runtimeCwd>/worldbook.json` (`host/src/tavern/new-companion-service.ts:202`),
 * and each runtime reads it back from that cwd — Game via
 * `game-runtime-context-assembly.ts:42` (`readCanonicalWorldBook(runtimePaths.runtimeCwd)`), Chat via
 * `continuity-semantic-chat-runtime-construction.internal.ts:306` (`readWorldBook(join(runtimeCwd,
 * "worldbook.json"))`) — before both are injected as `initialProfile`/`worldBook` in
 * `continuity-semantic-game-runtime-materializer.ts:813-814`.
 *
 * So a run that does not place those two files in its runtime cwd has NO persona, and every naturalness
 * judgement made against it is a judgement of a bare assistant. That was true of the chat loop (its
 * deployment manifest carried no profile and its identity was synthetic), which is exactly why a real
 * conversation read as flat and generic.
 *
 * The identity half is a COMPILED file, not the card: the Host reads
 * `<runtimeCwd>/identity-profile.json` (`host/src/identity-profile.ts`,
 * `host/src/runtime-core.internal.ts:715`) and never opens `card.json`. Copying only the card is what
 * made every live run present as the placeholder `DEFAULT_IDENTITY_PROFILE` — "GameBuddy Companion" —
 * while the reviewed card's own name and persona sat unread beside it. The compile below is the
 * EXISTING product path (`decodeStCard`/`previewStCard` + `candidateToIdentityProfile`, the same two
 * functions the ST-card import flow calls), so a live run and a player's import cannot disagree about
 * what a given card means.
 *
 * The opening has the same shape: the reviewed card's `first_mes` becomes a durable greeting record at
 * provisioning, and the product's initial Chat saga draws message zero from that record's default
 * variant (`host/src/tavern/initial-chat-exact-content-port.ts`). A run that seeds only the card files
 * therefore opens on an empty transcript instead of the card's opening.
 *
 * So does the scenario: the card's `scenario` field becomes a durable player-scenario record
 * (`scenarioService.create`), which is what the character panel shows in its Scenario block. A run
 * that skips it renders 还没有保存场景 for a card that carries one, which reads as "this card has no
 * scenario" rather than "the run did not install it".
 *
 * This module is the one place that knows:
 *   - WHICH card (the reviewed live-run card, `assets/tavern/presets/default-companion`),
 *   - that the card itself is copied **byte for byte, with no modification or preprocessing** (the
 *     operator's rule: load it directly; if that fails, the failure is a system problem, not a reason
 *     to rewrite the card),
 *   - how to COMPILE it into the files the Host actually reads, through the product's own decode and
 *     write paths,
 *   - and how to ASSERT that a run really mounted it, so an absent persona is a failure instead of a
 *     silent, generic-sounding companion.
 */

import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** `<repo>/assets/tavern/presets/default-companion` — resolved from this module, never from a caller's cwd. */
export const LIVE_RUN_PERSONA_DIR = path.resolve(
  fileURLToPath(new URL("../../../assets/tavern/presets/default-companion", import.meta.url)),
);

/** The card and its world book travel together; naming them here keeps every loop identical. */
export const LIVE_RUN_PERSONA_FILES = Object.freeze(["card.json", "worldbook.json"]);

export function liveRunPersonaPaths({ dir = LIVE_RUN_PERSONA_DIR } = {}) {
  return Object.freeze({
    dir,
    cardPath: path.join(dir, "card.json"),
    worldbookPath: path.join(dir, "worldbook.json"),
  });
}

/**
 * The Host build whose compiled modules this harness reuses, so the card is decoded and compiled by
 * the product's own code rather than by a second implementation living in the harness.
 *
 * Candidates in order: an explicit root, `GAMEBUDDY_HOST_DIST`, then the two roots the live-run loops
 * already build (`host/dist-test` for the AB runner, `host/dist` for the audited generation). A root
 * without the two modules is not a candidate; when none is usable the run fails by name instead of
 * silently provisioning a card nobody can read.
 */
export function resolveLiveRunHostBuildRoot({ hostBuildRoot, env = process.env } = {}) {
  const candidates = [
    hostBuildRoot,
    env.GAMEBUDDY_HOST_DIST,
    path.join(REPOSITORY_ROOT, "host", "dist-test"),
    path.join(REPOSITORY_ROOT, "host", "dist"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (existsSync(path.join(root, "st-card-import.js")) && existsSync(path.join(root, "identity-profile.js")))
      return root;
  }
  throw new Error("live_run_host_build_missing");
}

async function loadHostBuild(hostBuildRoot) {
  const root = hostBuildUrl(hostBuildRoot);
  const [cardImport, identityProfile] = await Promise.all([
    import(new URL("st-card-import.js", root)),
    import(new URL("identity-profile.js", root)),
  ]);
  return Object.freeze({
    previewStCard: cardImport.previewStCard,
    candidateToIdentityProfile: cardImport.candidateToIdentityProfile,
    validateIdentityProfile: identityProfile.validateIdentityProfile,
    writeIdentityProfile: identityProfile.writeIdentityProfile,
    readIdentityProfile: identityProfile.readIdentityProfile,
    identityProfileMetadata: identityProfile.identityProfileMetadata,
  });
}

function hostBuildUrl(hostBuildRoot) {
  return pathToFileURL(`${resolveLiveRunHostBuildRoot({ hostBuildRoot })}${path.sep}`);
}

let pathLockBound = false;
/**
 * The product's durable path lock releases through the Windows stale-lock reclaimer a PROCESS binds
 * (`host/src/path-lock.ts:49`). The runtime binds its own at startup, but a harness writes through the
 * same store modules before any child runtime exists, so it has to bind the same capability itself —
 * exactly as `tools/live-run/memory/run-memory-live-loop.mjs:354-361` does for the preference store.
 * Without it every product write fails closed with `durable_path_lock_release_failed`.
 */
async function bindHostPathLock(hostBuildRoot) {
  if (pathLockBound) return;
  const root = hostBuildUrl(hostBuildRoot);
  const [{ bindWindowsStaleLockReclaimer }, { createBuildWindowsStaleLockReclaimer }] = await Promise.all([
    import(new URL("path-lock.js", root)),
    import(new URL("windows-stale-lock-reclaimer/index.js", root)),
  ]);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  pathLockBound = true;
}

/**
 * What the card IS, read (never written) for the evidence: the run must say which persona spoke, or
 * two runs judged for naturalness are not comparable.
 */
export async function readLiveRunPersonaIdentity({ dir = LIVE_RUN_PERSONA_DIR } = {}) {
  const { cardPath, worldbookPath } = liveRunPersonaPaths({ dir });
  if (!existsSync(cardPath)) throw new Error("live_run_persona_card_missing");
  if (!existsSync(worldbookPath)) throw new Error("live_run_persona_worldbook_missing");
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  const book = JSON.parse(await readFile(worldbookPath, "utf8"));
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  return Object.freeze({
    dir: path.basename(dir),
    // CCv2 keeps the display name under `data.name`; a v1 card keeps it at the top level.
    name: card?.data?.name ?? card?.name ?? null,
    cardSchema: card?.spec ?? card?.spec_version ?? null,
    worldBookEntries: entries.length,
    alwaysOnEntries: entries.filter((entry) => entry?.alwaysOnPremise === true || entry?.constant === true).length,
  });
}

/**
 * The card's own openings, as the reviewed import flow reads them: the default first, then each
 * alternate in the card's stable 1-based order (the ST v2/v3 spec attaches no per-entry label).
 * Nothing is invented here — the texts are the decoder's, unmodified.
 */
function greetingVariantsFromPreview(profileCandidate) {
  const variants = [];
  const first = profileCandidate.firstGreeting;
  if (typeof first === "string" && first.trim() !== "") variants.push({ label: "Default", text: first });
  (profileCandidate.alternateGreetings ?? []).forEach((text, index) => {
    if (typeof text !== "string" || text.trim() === "") return;
    variants.push({ label: `Alternate ${index + 1}`, text });
  });
  return variants;
}

/**
 * Compiles the card into the exact `<runtimeCwd>/identity-profile.json` the Host reads, through the
 * product's own decoder, converter, validator and writer. Returns the identity the runtime will
 * present, so the caller can put it in its own evidence instead of asserting that a call happened.
 */
export async function compileLiveRunIdentityProfile(runtimeCwd, { cardPath, hostBuildRoot } = {}) {
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  const host = await loadHostBuild(hostBuildRoot);
  await bindHostPathLock(hostBuildRoot);
  const preview = host.previewStCard(card);
  const profile = host.validateIdentityProfile(host.candidateToIdentityProfile(preview, 1));
  const profilePath = path.join(runtimeCwd, "identity-profile.json");
  await host.writeIdentityProfile(profilePath, profile);
  const metadata = host.identityProfileMetadata(profile);
  return Object.freeze({
    profilePath,
    profileId: metadata.profileId,
    canonicalHash: metadata.canonicalHash,
    name: profile.identity.name,
    // The runtime root the Host will read, so a mismatch with this process's cwd is visible rather
    // than sampled from files this run never mounted.
    readBack: await host.readIdentityProfile(profilePath),
  });
}

/**
 * Seeds the companion's durable greeting record, the record message zero of a new Chat is drawn from.
 *
 * Product provisioning writes it (`new-companion-service.ts`, `greetingService.create`) for a
 * card-imported companion, and the initial-Chat saga reads the record's default variant. A live-run
 * root has no provisioning step, so without this the run opens on `opening: "blank"`. The record is
 * written through the product's own greeting service — the same store and the same set identity — so
 * the run's opening is the record a real player's Chat would have, not a harness imitation.
 */
export async function seedLiveRunGreetingRecord(runtimeCwd, { cardPath, hostBuildRoot, identity, root } = {}) {
  if (identity === undefined || typeof root !== "string" || root.length === 0)
    throw new Error("live_run_persona_identity_required");
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  const host = await loadHostBuild(hostBuildRoot);
  await bindHostPathLock(hostBuildRoot);
  const buildRoot = hostBuildUrl(hostBuildRoot);
  const [{ resolveRuntimePaths }, { resolveTavernPaths }, { TavernArtifactStore }, { createGreetingManagementService }] =
    await Promise.all([
      import(new URL("runtime-identity.js", buildRoot)),
      import(new URL("tavern/tavern-paths.js", buildRoot)),
      import(new URL("tavern/artifact-store.js", buildRoot)),
      import(new URL("tavern/greeting-management/greeting-management.js", buildRoot)),
    ]);
  const paths = resolveRuntimePaths(identity, root);
  if (path.resolve(paths.runtimeCwd) !== path.resolve(runtimeCwd))
    throw new Error("live_run_persona_runtime_cwd_mismatch");
  const tavernPaths = resolveTavernPaths(paths, identity);
  const service = createGreetingManagementService(
    new TavernArtifactStore(paths.root),
    tavernPaths.companionRoot,
  );
  const existing = await service.readExact();
  if (existing !== null) {
    // A resumed run keeps the record it already has: rewriting revisions would move the opening out
    // from under a thread that already committed against the earlier one.
    return Object.freeze({
      created: false,
      greetingSetId: existing.greetingSetId,
      revision: existing.revision,
      canonicalHash: existing.canonicalHash,
      variantIds: existing.variants.map((variant) => variant.variantId),
    });
  }
  const variants = greetingVariantsFromPreview(host.previewStCard(card).profileCandidate);
  if (variants.length === 0) throw new Error("live_run_persona_greeting_missing");
  await service.create({ label: "Initial Greeting", variants });
  // Reported from the durable readback, not from the write's own echo: the ids are what a thread's
  // `GreetingSource.variantId` has to name, and the projection `create` returns carries no ids.
  const written = await service.readExact();
  if (written === null) throw new Error("live_run_persona_greeting_unreadable");
  return Object.freeze({
    created: true,
    greetingSetId: written.greetingSetId,
    revision: written.revision,
    canonicalHash: written.canonicalHash,
    variantIds: written.variants.map((variant) => variant.variantId),
  });
}

/**
 * Seeds the companion's durable scenario record, the text the character panel shows under "Scenario".
 *
 * Product provisioning writes it (`new-companion-service.ts:216-219`, `scenarioService.create`) from
 * the card's own `scenario` field for a card-imported companion; a live-run root has no provisioning
 * step, so without this the panel answers `scenarioNotPresent` (还没有保存场景) for a card that
 * carries one. The text is the decoder's, unmodified — the card's field verbatim, exactly the value
 * the product's import path stores, so a live run and a player's import cannot disagree.
 */
export async function seedLiveRunScenarioRecord(runtimeCwd, { cardPath, hostBuildRoot, identity, root } = {}) {
  if (identity === undefined || typeof root !== "string" || root.length === 0)
    throw new Error("live_run_persona_identity_required");
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  const host = await loadHostBuild(hostBuildRoot);
  await bindHostPathLock(hostBuildRoot);
  const buildRoot = hostBuildUrl(hostBuildRoot);
  const [{ resolveRuntimePaths }, { resolveTavernPaths }, { TavernArtifactStore }, { createScenarioManagementService }] =
    await Promise.all([
      import(new URL("runtime-identity.js", buildRoot)),
      import(new URL("tavern/tavern-paths.js", buildRoot)),
      import(new URL("tavern/artifact-store.js", buildRoot)),
      import(new URL("tavern/scenario-management/scenario-management.js", buildRoot)),
    ]);
  const paths = resolveRuntimePaths(identity, root);
  if (path.resolve(paths.runtimeCwd) !== path.resolve(runtimeCwd))
    throw new Error("live_run_persona_runtime_cwd_mismatch");
  const tavernPaths = resolveTavernPaths(paths, identity);
  const service = createScenarioManagementService(
    new TavernArtifactStore(paths.root),
    tavernPaths.companionRoot,
  );
  const existing = await service.read();
  if (existing !== null) {
    // A resumed run keeps the record it already has, for the same reason the greeting does: the
    // player's own edit must not be rewritten by a re-provision.
    return Object.freeze({ created: false, revision: existing.revision, name: existing.name });
  }
  // The card's field is candidate-only (`st-card-import.ts:66-67`): it lives beside the profile
  // candidate, never inside it. A card WITHOUT one is a real answer, and the named failure here is
  // what keeps an empty scenario field from being read as a populated one.
  const scenario = host.previewStCard(card).scenario;
  if (typeof scenario !== "string" || scenario.trim() === "") throw new Error("live_run_persona_scenario_missing");
  await service.create({ name: "Default Scenario", description: scenario });
  const written = await service.read();
  if (written === null) throw new Error("live_run_persona_scenario_unreadable");
  return Object.freeze({ created: true, revision: written.revision, name: written.name, preview: written.preview });
}

/**
 * Places the card in a runtime cwd exactly as provisioning does — byte for byte — and compiles the
 * identity profile, greeting record and scenario record the Host actually reads. Returns the evidence
 * so the caller can put it in its own report.
 */
export async function provisionLiveRunPersona(
  runtimeCwd,
  { dir = LIVE_RUN_PERSONA_DIR, hostBuildRoot, identity, root } = {},
) {
  if (typeof runtimeCwd !== "string" || runtimeCwd.length === 0) throw new Error("live_run_persona_cwd_invalid");
  const { cardPath, worldbookPath } = liveRunPersonaPaths({ dir });
  const identityFacts = await readLiveRunPersonaIdentity({ dir });
  for (const [source, name] of [
    [cardPath, "card.json"],
    [worldbookPath, "worldbook.json"],
  ]) {
    await copyFile(source, path.join(runtimeCwd, name));
  }
  const profile = await compileLiveRunIdentityProfile(runtimeCwd, { cardPath, hostBuildRoot });
  const greeting =
    identity === undefined
      ? null
      : await seedLiveRunGreetingRecord(runtimeCwd, { cardPath, hostBuildRoot, identity, root });
  const scenario =
    identity === undefined
      ? null
      : await seedLiveRunScenarioRecord(runtimeCwd, { cardPath, hostBuildRoot, identity, root });
  return Object.freeze({ identity: identityFacts, cardPath, worldbookPath, profile, greeting, scenario });
}

/**
 * Is this runtime cwd mounted with the persona? Both card files present, the book parseable, at least
 * one entry, a named card, and — the half that used to be missing — a COMPILED identity profile whose
 * name is the card's. A run that fails this has no persona, so it cannot support any claim about
 * persona fidelity or naturalness — and it says why instead of sounding merely bland.
 *
 * The stored `canonicalHash` is checked by the product's own `readIdentityProfile` at runtime
 * construction, so this assert does not re-implement that gate; it catches the failure the product
 * cannot catch, namely a profile that is valid but is not this card's.
 */
export async function assertLiveRunPersonaMounted(runtimeCwd, { identity, root, hostBuildRoot } = {}) {
  const problems = [];
  const cardPath = path.join(runtimeCwd, "card.json");
  const worldbookPath = path.join(runtimeCwd, "worldbook.json");
  if (!existsSync(cardPath)) problems.push("card_json_absent");
  if (!existsSync(worldbookPath)) problems.push("worldbook_json_absent");
  let entries = 0;
  let name = null;
  if (!problems.includes("card_json_absent")) {
    try {
      const card = JSON.parse(await readFile(cardPath, "utf8"));
      name = card?.data?.name ?? card?.name ?? null;
      if (typeof name !== "string" || name.length === 0) problems.push("card_name_absent");
    } catch {
      problems.push("card_json_unparseable");
    }
  }
  if (!problems.includes("worldbook_json_absent")) {
    try {
      const book = JSON.parse(await readFile(worldbookPath, "utf8"));
      entries = Array.isArray(book?.entries) ? book.entries.length : 0;
      if (entries === 0) problems.push("worldbook_empty");
    } catch {
      problems.push("worldbook_json_unparseable");
    }
  }
  const profilePath = path.join(runtimeCwd, "identity-profile.json");
  let profileName = null;
  if (!existsSync(profilePath)) problems.push("identity_profile_absent");
  else {
    try {
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profileName = typeof profile?.identity?.name === "string" ? profile.identity.name : null;
      if (profileName === null) problems.push("identity_profile_name_absent");
      if (typeof profile?.canonicalHash !== "string") problems.push("identity_profile_hash_absent");
      // A placeholder profile is valid and is exactly the failure this assert exists for: the Host
      // reads the compiled name, so a mismatch means the run presents as somebody else.
      if (profileName !== null && typeof name === "string" && profileName !== name)
        problems.push("identity_profile_name_mismatch");
    } catch {
      problems.push("identity_profile_unparseable");
    }
  }
  let greeting = null;
  let scenario = null;
  if (identity !== undefined && typeof root === "string" && root.length > 0) {
    try {
      const buildRoot = hostBuildUrl(hostBuildRoot);
      const [
        { resolveRuntimePaths },
        { resolveTavernPaths },
        { TavernArtifactStore },
        { createGreetingManagementService },
        { createScenarioManagementService },
      ] = await Promise.all([
        import(new URL("runtime-identity.js", buildRoot)),
        import(new URL("tavern/tavern-paths.js", buildRoot)),
        import(new URL("tavern/artifact-store.js", buildRoot)),
        import(new URL("tavern/greeting-management/greeting-management.js", buildRoot)),
        import(new URL("tavern/scenario-management/scenario-management.js", buildRoot)),
      ]);
      const paths = resolveRuntimePaths(identity, root);
      const tavernPaths = resolveTavernPaths(paths, identity);
      const artifacts = new TavernArtifactStore(paths.root);
      const record = await createGreetingManagementService(artifacts, tavernPaths.companionRoot).readExact();
      if (record === null || record.variants.length === 0) problems.push("greeting_record_absent");
      else greeting = Object.freeze({ greetingSetId: record.greetingSetId, revision: record.revision, variants: record.variants.length });
      // The character panel answers from this record, so its absence is the "还没有保存场景" panel
      // on a card that carries a scenario: a defect, not a neutral empty state.
      try {
        const scenarioRecord = await createScenarioManagementService(artifacts, tavernPaths.companionRoot).read();
        if (scenarioRecord === null) problems.push("scenario_record_absent");
        else scenario = Object.freeze({ revision: scenarioRecord.revision, name: scenarioRecord.name });
      } catch {
        problems.push("scenario_record_unreadable");
      }
    } catch {
      problems.push("greeting_record_unreadable");
    }
  }
  // Authored templating (char/user tokens) is PART OF the card format, not a defect: the reviewed card
  // ships it. Whether the runtime substitutes those tokens when it injects the book is a separate product
  // fact to observe downstream, so the count is recorded here instead of being called a failure.
  const raw = existsSync(worldbookPath) ? await readFile(worldbookPath, "utf8") : "";
  const macroTokens = (raw.match(/\{\{[^}]*\}\}/g) ?? []).length;
  return Object.freeze({
    ok: problems.length === 0,
    problems,
    name,
    profileName,
    worldBookEntries: entries,
    macroTokens,
    greeting,
    scenario,
  });
}
