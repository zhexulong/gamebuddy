import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { readIdentityProfile, writeIdentityProfile } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { keepAuthoredText } from "./companion-authored-text.js";
import { projectCompanionVoice, updateMountedCompanionVoice } from "./companion-voice-service.js";
import { DEFAULT_IDENTITY_PROFILE } from "../identity-profile.js";
import {
  createGreetingManagementService,
  withGreetingSurfaceMacros,
} from "./greeting-management/greeting-management.js";
import { macroTable, renderMacros } from "./macro-engine.js";
import {
  createScenarioManagementService,
  withScenarioSurfaceMacros,
} from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const identity = Object.freeze({
  playerId: "player_edit",
  companionId: "companion_edit",
  continuityId: "continuity_edit",
});

/**
 * `{{char}}` is her name and `{{user}}` is the run's word - the same derivation the prompt and
 * every surface use. A stored `{{user}}` renders to 你 here, and `{{char}}` to 琥珀.
 */
const MACROS = macroTable({ char: "琥珀", locale: "zh-CN" });

/**
 * The whole family this file holds out, in one function: a value that still says what the
 * authored text renders to IS the authored text. `companion-world-book-service.ts` applies
 * the same rule to world-book bodies.
 */
test("keepAuthoredText keeps the authored record when the edit did not change what it says", () => {
  assert.equal(keepAuthoredText("你 把水壶递给她。", "{{user}} 把水壶递给她。", MACROS), "{{user}} 把水壶递给她。");
  // A value the player actually rewrote is theirs, verbatim - even where it happens to hold
  // a brace pair that is not a macro this run resolves.
  assert.equal(keepAuthoredText("琥珀 把水壶递给她。", "{{user}} 把水壶递给她。", MACROS), "琥珀 把水壶递给她。");
  // An authored text with no macro at all is unchanged either way, so an edit never has to
  // think about whether a field "was rendered".
  assert.equal(keepAuthoredText("他们把水壶递给她。", "他们把水壶递给她。", MACROS), "他们把水壶递给她。");
  // Only this run's rendering is recoverable: another run's word is the player's text.
  assert.equal(keepAuthoredText("User 把水壶递给她。", "{{user}} 把水壶递给她。", MACROS), "User 把水壶递给她。");
});

/**
 * The scenario editor: the browser reads the rendering and sends it back unchanged when the
 * player edited something ELSE. The durable record must stay the author's - the failure this
 * catches is the one that looks fixed until the player touches the panel, and then the card
 * export starts writing 你 where the author wrote `{{user}}`.
 */
test("a scenario save that did not change the description leaves the author's macros in the record", async () => {
  const root = await canonicalTestRoot("tavern-edit-scenario-");
  try {
    const paths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
    const store = new TavernArtifactStore(root);
    const record = createScenarioManagementService(store, paths.companionRoot);
    const surface = withScenarioSurfaceMacros(record, async () => MACROS);
    await record.create({ name: "The ridge", description: "{{char}} 和 {{user}} 在冬天的山脊上。" });

    // What the player sees, and what the browser therefore sends back.
    const read = await surface.read();
    assert.equal(read?.description, "琥珀 和 你 在冬天的山脊上。");

    // A save that changed only the NAME still carries the rendered description.
    const saved = await surface.update({ expectedRevision: 1, name: "The pass", description: read!.description });
    assert.equal(saved.name, "The pass");
    // What was stored is the author's line, not this run's rendering of it.
    assert.equal((await record.read())?.description, "{{char}} 和 {{user}} 在冬天的山脊上。");
    // A save that DID rewrite the description stores the player's own words.
    const rewritten = await surface.update({
      expectedRevision: 2,
      name: "The pass",
      description: "你们在冬天的山脊上。",
    });
    assert.equal(rewritten.description, "你们在冬天的山脊上。");
    assert.equal((await record.read())?.description, "你们在冬天的山脊上。");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an opening save that did not change a line leaves the author's macros in the record", async () => {
  const root = await canonicalTestRoot("tavern-edit-greeting-");
  try {
    const paths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
    const store = new TavernArtifactStore(root);
    const record = createGreetingManagementService(store, paths.companionRoot);
    const surface = withGreetingSurfaceMacros(record, async () => MACROS);
    await record.create({
      label: "The porch",
      variants: [
        { label: "Default", text: "{{char}} 在门廊上等 {{user}}。" },
        { label: "Warm", text: "{{user}} 来了，水还热着。" },
      ],
    });

    const read = await surface.read();
    assert.deepEqual(
      read?.variants.map((variant) => variant.text),
      ["琥珀 在门廊上等 你。", "你 来了，水还热着。"],
    );
    // The player renames the set and edits only the SECOND opening.
    const saved = await surface.update({
      expectedRevision: 1,
      label: "The farmhouse porch",
      variants: [
        { label: "Default", text: read!.variants[0]!.text },
        { label: "Warm", text: "你来了，我把水烧上了。" },
      ],
    });
    assert.deepEqual(
      saved.variants.map((variant) => variant.text),
      ["琥珀 在门廊上等 你。", "你来了，我把水烧上了。"],
    );
    const durable = await record.readExact();
    assert.deepEqual(
      durable?.variants.map((variant) => variant.text),
      // The untouched row is the author's; the edited one is the player's, verbatim.
      ["{{char}} 在门廊上等 {{user}}。", "你来了，我把水烧上了。"],
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The performance directive's editor, and its read: the panel is handed her rendered line, and
 * a save that did not change it leaves `{{char}}`/`{{user}}` in the profile - which is the
 * record the card export writes back.
 */
test("a directive save that did not change the text leaves the author's macros in the profile", async () => {
  const root = await canonicalTestRoot("tavern-edit-voice-");
  try {
    const paths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(paths, identity);
    await writeIdentityProfile(paths.identityProfilePath, {
      ...DEFAULT_IDENTITY_PROFILE,
      profileId: "gamebuddy.companion.edit",
      identity: { ...DEFAULT_IDENTITY_PROFILE.identity, name: "琥珀" },
      characterVoice: { text: "{{char}} 每次开口前先对 {{user}} 做一个动作。", source: "card" },
    });
    const original = await readIdentityProfile(paths.identityProfilePath);
    // The panel reads the rendering, never the raw macro.
    assert.equal(
      projectCompanionVoice(original)?.text,
      "{{char}} 每次开口前先对 {{user}} 做一个动作。",
      "the projection is the durable record, and rendering is the surface's own seam",
    );
    assert.equal(renderMacros(projectCompanionVoice(original)!.text, MACROS), "琥珀 每次开口前先对 你 做一个动作。");

    await updateMountedCompanionVoice({
      identityProfilePath: paths.identityProfilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: "e".repeat(64),
      expectedProfileRevision: original.revision,
      macros: MACROS,
      // What the browser sends back: the rendering, unchanged by the player.
      voice: { text: "琥珀 每次开口前先对 你 做一个动作。" },
      refreshThreadBindings: async () => 0,
    });
    assert.equal(
      (await readIdentityProfile(paths.identityProfilePath)).characterVoice?.text,
      "{{char}} 每次开口前先对 {{user}} 做一个动作。",
      "a save that changed nothing must not freeze this run's rendering into her profile",
    );
    // A save that DID rewrite it stores the player's words, and re-authors the source.
    const current = await readIdentityProfile(paths.identityProfilePath);
    await updateMountedCompanionVoice({
      identityProfilePath: paths.identityProfilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: "e".repeat(64),
      expectedProfileRevision: current.revision,
      macros: MACROS,
      voice: { text: "每次开口前先做一个动作。" },
      refreshThreadBindings: async () => 0,
    });
    const rewritten = await readIdentityProfile(paths.identityProfilePath);
    assert.deepEqual(rewritten.characterVoice, { text: "每次开口前先做一个动作。", source: "player" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
