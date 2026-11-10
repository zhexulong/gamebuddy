// The run's bound preset, put into and taken out of the real run root through the product's own store.
//
// WHY THE HARNESS AND NOT A ROUTE. The product has no route that imports a preset and none that binds one:
// `context/tavern/browser-contract` declares exactly one preset route (`presets.read`, a read-only readout)
// and `tavern/preset-binding.ts`'s `bind`/`clear` are called from nothing in `host/src`. So a browser
// cannot put a preset in the store, and a driver that waited for a control that does not exist would report
// a missing capability as a missing feature. This module therefore calls the SAME two write APIs the
// product's own tests and its future panel will call - `createPresetStore().import` and
// `createPresetBindingStore().bind` - loaded from the exact generation this launch is about to install, so
// the document on disk is the store's own envelope (`<playerRoot>/presets/<id>/preset.json` with its
// canonical hash and derived summary) rather than a JSON file written by hand.
//
// WHAT IT IS NOT. It is not a second authority for "which preset is in force": the Host re-reads
// `preset-binding.json` through this same module's store on every prompt
// (`host/src/tavern/p4-provider-start-execution.ts:660` -> `preset-request-segments.ts`
// `publishPresetRequestSegments`), so a clear performed here stops the very next request for the same reason
// a player's own binding change would. It also cannot change the SAMPLER half after boot: that is spliced
// into `models.json` once, when the runtime is constructed (`host/src/runtime-core.internal.ts:1456`).
//
// THE PATH IS THE PRODUCT'S OWN LADDER, not a guessed one: `resolveRuntimePaths` -> `resolveTavernPaths`
// gives `<runtimeRoot>/tavern/v1/players/<sha256(playerId)>`, which is where
// `host/src/tavern/tavern-paths.ts` puts a player's presets.
//
// LOCKS. Importing and binding take each file's `.lock`, and releasing it is a handle-bound operation the
// Windows helper performs. A foreign process reaches that helper through the generation's own
// `requestWindowsStaleLockReclaimer()`, exactly as the Host does, so this binds the capability before the
// first write. Without it every write fails closed at release (`durable_path_lock_release_failed`), which is
// a named skip here rather than a half-written store.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FIXTURE_PRESET_ID,
  FIXTURE_PRESET_MARKERS,
  FIXTURE_PRESET_SAMPLING,
  fixturePresetDocument,
} from "./preset-fixture.mjs";
import { resolveGenerationRoot } from "./seed-connection.mjs";

/**
 * The generation's preset store and binding, opened over the run root this launch will mount.
 *
 * Every module is loaded from the generation (never from the repository sources): the store's envelope,
 * Hash and summary rules are then the ones the launched Host will read back, which is the whole reason the
 * harness may write durable state at all.
 */
async function openPresetRoot({ artifactRoot, runtimeRoot, principal }) {
  const generationRoot = await resolveGenerationRoot(artifactRoot);
  const load = (module) => import(pathToFileURL(join(generationRoot, module)).href);
  const { resolveRuntimePaths } = await load("runtime-identity.js");
  const { resolveTavernPaths } = await load("tavern/tavern-paths.js");
  const locks = await load("path-lock.js");
  const { createPresetStore } = await load("tavern/preset-store.js");
  const { createPresetBindingStore } = await load("tavern/preset-binding.js");
  const reclaimer = await load("windows-stale-lock-reclaimer/index.js");
  const capability = await reclaimer.requestWindowsStaleLockReclaimer();
  if (capability !== undefined) locks.bindWindowsStaleLockReclaimer(capability);
  const playerRoot = resolveTavernPaths(resolveRuntimePaths(principal, runtimeRoot), principal).playerRoot;
  const presets = createPresetStore({ runtimeRoot, playerRoot });
  const binding = createPresetBindingStore({ runtimeRoot, playerRoot }, presets);
  return { presets, binding, playerRoot };
}

/** A named outcome for every state this can legitimately end in; only a skipped one blocks the claim. */
export async function seedRunPreset({ artifactRoot, runtimeRoot, principal }) {
  try {
    const { presets, binding, playerRoot } = await openPresetRoot({ artifactRoot, runtimeRoot, principal });
    let revision;
    try {
      revision = (await presets.import({ presetId: FIXTURE_PRESET_ID, document: fixturePresetDocument() })).revision;
    } catch (error) {
      // A resumed `launch` phase finds the fixture already imported. Re-importing over it is refused by the
      // store (`preset_already_imported`), and that refusal is the store telling the truth about a
      // read-only store: read the revision it holds instead of pretending the write happened.
      if (!/preset_already_imported/u.test(String(error?.message ?? error))) throw error;
      revision = (await presets.read(FIXTURE_PRESET_ID)).revision;
    }
    const bound = await binding.bind(FIXTURE_PRESET_ID);
    return Object.freeze({
      kind: "seeded",
      presetId: bound.presetId,
      revision,
      markers: FIXTURE_PRESET_MARKERS,
      sampling: FIXTURE_PRESET_SAMPLING,
      playerRoot,
    });
  } catch (error) {
    return Object.freeze({
      kind: "skipped",
      reason: `preset_seed_failed:${String(error?.message ?? error).slice(0, 200)}`,
    });
  }
}

/**
 * Unbind the preset, so the next prompt is assembled with nothing in force.
 *
 * `presetId` is what the binding named, and `null` means there was nothing to clear - a different fact from
 * a failed clear, which is why the failure has its own kind.
 */
export async function clearRunPreset({ artifactRoot, runtimeRoot, principal }) {
  try {
    const { binding } = await openPresetRoot({ artifactRoot, runtimeRoot, principal });
    const cleared = await binding.clear();
    return Object.freeze({ kind: "cleared", presetId: cleared === null ? null : cleared.presetId });
  } catch (error) {
    return Object.freeze({
      kind: "failed",
      reason: `preset_clear_failed:${String(error?.message ?? error).slice(0, 200)}`,
    });
  }
}
