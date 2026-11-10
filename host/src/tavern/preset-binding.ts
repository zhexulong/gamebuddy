/**
 * WHICH PRESET IS IN FORCE: one durable fact, one file, one writer.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md` §2.1/§2.4) makes a preset the template a request is
 * assembled from; nothing else in this product says which template that is. `preset-store.ts` holds the imported
 * documents and `preset-assembly-read.ts` reads them, but "a preset is exported and called by nothing" was the live
 * run's own reading of the gap: a stored preset had no consumer because no fact ever named it. This module is that
 * fact.
 *
 * WHY ONE CHOICE FOR THE INSTALLATION, AND NOT ONE PER CHAT. The reference keeps the chat-completion preset in its
 * global settings: switching it changes how EVERY conversation is assembled, and a conversation carries no preset of
 * its own. What a preset decides - the `prompt_order` the request is assembled in, and the sampling values the model
 * is called with - are properties of the runtime, not of a transcript, so a per-Chat copy would be a second authority
 * for a fact that has one. A Chat that ever needs its own preset would have to own that revision in its thread record
 * (`chat-thread-store.ts`), and that is the place to add it if it is ever asked for; nothing asks for it today, so it
 * is not built here.
 *
 * WHAT THIS FILE DOES NOT DO: it never names a revision. The one legal mutation of a stored preset
 * (`PresetStore.setEnabled`, A4 §2.2) bumps the revision, so a binding that pinned one would go stale every time a
 * player switched an entry off. "In force" therefore means "the exact preset the store holds under this id, at
 * whatever revision it holds", and the store's own read - which re-derives and re-checks the summary - is what keeps
 * that one fact one fact.
 *
 * A bound id the store no longer holds is NOT silently "no binding": the file keeps naming it, so the readout can
 * report it by name. Forgetting a deletion would turn a player's preset into a missing one nobody can see.
 */
import { join, resolve } from "node:path";
import { atomicWriteFile, removeSafeFile, verifySafePathBoundary, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";
import type { PresetStore } from "./preset-store.js";

/** The preset in force, by the id the store holds it under. */
export type PresetBinding = Readonly<{ presetId: string }>;

export type PresetBindingStore = Readonly<{
  /** The binding as stored, or `null` when none was ever written. A broken file is refused by name, not as `null`. */
  read(): Promise<PresetBinding | null>;
  /** Binds one preset the store actually holds. An id it does not hold is refused by the store's own code. */
  bind(presetId: string): Promise<PresetBinding>;
  /** Removes the binding, returning what it named, or `null` when there was none. */
  clear(): Promise<PresetBinding | null>;
}>;

/** Where the binding lives, relative to the player root: a player-scoped fact, like the presets themselves. */
const PRESET_BINDING_FILE = "preset-binding.json";

export function createPresetBindingStore(
  paths: Readonly<{ runtimeRoot: string; playerRoot: string }>,
  presets: Pick<PresetStore, "read">,
): PresetBindingStore {
  const root = resolve(paths.runtimeRoot);
  const path = join(resolve(paths.playerRoot), PRESET_BINDING_FILE);

  const readBinding = async (): Promise<PresetBinding | null> => {
    let value: unknown;
    try {
      await verifySafePathBoundary(path, root);
      value = await readStrictJsonFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new Error("invalid_preset_binding", { cause: error });
    }
    if (
      !isRecord(value) ||
      !Object.keys(value).every((key) => key === "schemaVersion" || key === "presetId") ||
      value.schemaVersion !== 1 ||
      typeof value.presetId !== "string" ||
      value.presetId.length === 0
    )
      throw new Error("invalid_preset_binding");
    return Object.freeze({ presetId: value.presetId });
  };

  const withBindingLock = <T>(work: () => Promise<T>): Promise<T> =>
    withPathLock(path, work, { containmentRoot: root });

  return Object.freeze({
    read: readBinding,

    async bind(presetId) {
      if (typeof presetId !== "string" || presetId.length === 0) throw new Error("invalid_preset_binding");
      // The store is the authority for which presets exist, so its own refusal (`preset_not_found:<id>`) is the one
      // answer to an id it does not hold. Writing first and validating later would leave a binding nothing can honour.
      await presets.read(presetId);
      return withBindingLock(async () => {
        await atomicWriteFile(path, JSON.stringify({ schemaVersion: 1, presetId }, null, 2), root);
        const bound = await readBinding();
        if (bound === null || bound.presetId !== presetId) throw new Error("preset_binding_readback_mismatch");
        return bound;
      });
    },

    async clear() {
      return withBindingLock(async () => {
        const current = await readBinding();
        if (current === null) return null;
        await removeSafeFile(path, root);
        return current;
      });
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
