// The run root's companion language, seeded through the PRODUCT's own preference record before the
// Host child boots.
//
// WHY IT IS SEEDED AT ALL. The player's language choice is one fact with several consumers: the
// Agent's prompt language, the Mod's `PresentationLocale`, and - through that field - the language
// the formal Player Host world is entered in (`integrations/stardew/WorldCreationBootstrap.cs` holds
// the native entry until the live game locale is the configured one). A fresh run root has never
// chosen a language, so the Host projects NO `PresentationLocale` into the Mod, the Mod falls back to
// the live game locale, and the game comes up in whatever the player's own Stardew preference says
// (measured 2026-11-16: the frontend run's game logged `locale set to .` - English, the game's only
// empty localized-asset suffix - while the product and its prompts were zh-CN). The harness owns the
// root, so it states the choice the way a player's Settings screen does: the store's own
// `update({ action: "setLocale" })`, loaded from the exact generation this launch is about to install.
// No file is hand-written and no second default is invented.
//
// THE VALUE IS THE RUN'S OWN, not a copy: `COMPANION_LOCALE` (`tools/lib/companion-locale.mjs`) is the
// same constant the game live run's prompts and the native-local fixture's ModConfig read, so a run
// cannot test one language and declare another.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGenerationRoot } from "./seed-connection.mjs";

/**
 * Writes `locale` into `runtimeRoot`'s player-preference record and answers what the product now holds.
 *
 * Returns a closed outcome rather than throwing: a root that cannot be seeded leaves the Mod without a
 * `PresentationLocale` exactly as it was before, and the game-launch driver's own locale verdict names
 * the mismatch instead of this helper pretending to have fixed it.
 */
export async function seedRunLocale({ artifactRoot, runtimeRoot, locale }) {
  if (typeof locale !== "string" || locale.length === 0)
    return Object.freeze({ kind: "skipped", reason: "locale_absent" });
  try {
    const generationRoot = await resolveGenerationRoot(artifactRoot);
    const load = (module) => import(pathToFileURL(join(generationRoot, module)).href);
    // The same two modules the launcher's own settlement-path writers bind (`lib/preset-seed.mjs`):
    // the record takes a `.lock`, and releasing a handle-bound lock from another process reaches the
    // Windows helper through the generation's own reclaimer. Without it every write fails closed at
    // release (`durable_path_lock_release_failed`) rather than finishing.
    const locks = await load("path-lock.js");
    const reclaimer = await load("windows-stale-lock-reclaimer/index.js");
    const capability = await reclaimer.requestWindowsStaleLockReclaimer();
    if (capability !== undefined) locks.bindWindowsStaleLockReclaimer(capability);
    const { PlayerPreferenceStore, playerPreferencePath } = await load("settings/player-preference-store.js");

    const preferencePath = playerPreferencePath(runtimeRoot);
    await mkdir(dirname(preferencePath), { recursive: true });
    const store = new PlayerPreferenceStore(preferencePath);
    // A fresh root has no record at all: `read()` answers the default projection at revision 0, which
    // is the revision the first write must carry.
    const before = await store.read();
    const after = await store.update(before.revision, { action: "setLocale", locale });
    return Object.freeze({ kind: "seeded", locale: after.locale, revision: after.revision });
  } catch (error) {
    return Object.freeze({ kind: "skipped", reason: `seed_failed:${String(error?.message ?? error).slice(0, 200)}` });
  }
}
