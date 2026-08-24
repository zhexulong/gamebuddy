import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  recheckProductionEntry,
  resolveProductionEntry,
  resolveProductionModule,
} from "../../host/scripts/production-artifact.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hostRoot = resolve(repositoryRoot, "host");
const outputRoot = resolve(hostRoot, "dist");

/**
 * Loads an emitted Host module only from the immutable production generation
 * selected after complete inventory verification. It intentionally never
 * imports the mutable `host/dist` root directly.
 */
export async function selectHostProductionArtifact() {
  const selected = await resolveProductionEntry({ hostRoot, outputRoot, entry: "main.js" });
  await recheckProductionEntry({ hostRoot, selected });
  return selected;
}

/** Load from one already-selected immutable generation. */
export async function loadSelectedHostProductionModule(selected, module) {
  const resolved = await resolveProductionModule({ selected, module });
  return await import(pathToFileURL(resolved.modulePath).href);
}

/** Select and load one Host module. Use `selectHostProductionArtifact()` with
 * `loadSelectedHostProductionModule()` when a runner needs multiple modules. */
export async function loadHostProductionModule(module) {
  return await loadSelectedHostProductionModule(await selectHostProductionArtifact(), module);
}
