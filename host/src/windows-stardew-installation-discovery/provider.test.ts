import assert from "node:assert/strict";
import test from "node:test";
import type {
  StardewGogInstallRootSource,
  StardewMicrosoftStoreInstallRootSource,
  StardewSteamSource,
} from "./index.js";
import { createStardewInstallationDiscoveryProvider } from "./index.js";
import type { DiscoveryDiagnostic } from "./internal.js";

const manifest = '"appid" "413150" "installdir" "Stardew Valley"';

function source(
  roots: readonly (readonly ["steam-registry" | "steam-vdf" | "known-location", string])[],
): StardewSteamSource {
  return Object.freeze({ read: async () => Object.freeze({ roots, diagnostics: [] as const }) });
}

/**
 * The loader fact is per folder, not per scan.
 *
 * A machine can hold several installations and the loader is the player's to install, so two rows can differ in
 * exactly this: one is ready and the other is not. A single value for the whole scan would make the panel's "ready"
 * label a lie on one of them, which is the failure this asserts against.
 */
test("each candidate reports the loader state of its own folder", async () => {
  const ready = "C:\\Steam\\steamapps\\appmanifest_413150.acf";
  const notReady = "D:\\SteamLibrary\\steamapps\\appmanifest_413150.acf";
  const provider = createStardewInstallationDiscoveryProvider({
    source: source([
      ["steam-registry", "C:\\Steam"],
      ["steam-vdf", "D:\\SteamLibrary"],
    ]),
    readFile: async (path) => {
      if (path === ready || path === notReady) return manifest;
      return Promise.reject(new Error("missing"));
    },
    // The probe answers per root, exactly as the real one does: it looks inside the folder it is given.
    probe: async (installRoot) =>
      installRoot.startsWith("C:") ? { readable: true, smapi: true } : { readable: true, smapi: false },
  });

  const result = await provider.discover();
  const byRootLocation = new Map(result.candidates.map((candidate) => [candidate.location, candidate.modLoader]));
  assert.deepEqual([...byRootLocation.entries()].sort(), [
    ["C: · Steam", "present"],
    ["D: · SteamLibrary", "missing"],
  ]);
});

test("a library without the game is not a library with a broken manifest", async () => {
  // Both used to report `invalid-app-manifest`, which made an ordinary scan read as a fault: most libraries do not
  // hold a given game, and the absence of `appmanifest_413150.acf` is the normal state.
  const broken = "C:\\Broken\\steamapps\\appmanifest_413150.acf";
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([
      ["steam-vdf", "C:\\Absent"],
      ["steam-vdf", "C:\\Broken"],
    ]),
    readFile: async (path) => {
      if (path === broken) return '"appid" "1"';
      // The same error shape `readFile` produces for a file that is not there.
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (error as { code?: string }).code = "ENOENT";
      return Promise.reject(error);
    },
  });

  const result = await provider.discover();
  assert.equal(result.candidates.length, 0);
  assert.deepEqual([...result.diagnostics].sort(), ["invalid-app-manifest", "library-without-game", "no-candidates"]);
});

test("binds each source root to its own manifest and only publishes valid roots", async () => {
  const files = new Map([
    ["C:\\Good\\steamapps\\appmanifest_413150.acf", manifest],
    ["C:\\Bad\\steamapps\\appmanifest_413150.acf", '"appid" "1"'],
  ]);
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([
      ["steam-vdf", "C:\\Good"],
      ["steam-vdf", "C:\\Bad"],
    ]),
    readFile: async (path) => files.get(path) ?? Promise.reject(new Error("missing")),
  });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.includes("invalid-app-manifest"), true);
  assert.equal(Object.keys(result.candidates[0] ?? {}).includes("root"), false);
});

test("reads manifests from the canonical normalized source root", async () => {
  const paths: string[] = [];
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([["steam-vdf", "c:\\Steam"]]),
    readFile: async (path) => {
      paths.push(path);
      return manifest;
    },
  });
  const result = await provider.discover();
  assert.deepEqual(paths, ["C:\\Steam\\steamapps\\appmanifest_413150.acf"]);
  assert.equal(result.candidates.length, 1);
});

test("does not read manifests for invalid source roots", async () => {
  const paths: string[] = [];
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([
      ["steam-vdf", "C:\\Steam\\..\\Other"],
      ["steam-vdf", "relative"],
      ["steam-vdf", "C:\\Steam\\"],
    ]),
    readFile: async (path) => {
      paths.push(path);
      return manifest;
    },
  });
  const result = await provider.discover();
  assert.deepEqual(paths, []);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic === "invalid-app-manifest").length, 3);
});

test("empty source roots produce no candidates without reading manifests", async () => {
  let reads = 0;
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([]),
    readFile: async () => {
      reads += 1;
      return manifest;
    },
  });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, ["no-candidates"]);
  assert.equal(reads, 0);
});

test("fails closed on oversized app manifests", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([["steam-registry", "C:\\Steam"]]),
    readFile: async () => "x".repeat(4 * 1024 * 1024 + 1),
  });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.diagnostics, ["invalid-app-manifest", "no-candidates"]);
});

test("reports source diagnostics and manifest failures without exposing locators", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([["steam-registry", "C:\\Steam"]]),
    readFile: async () => {
      throw new Error("manifest missing");
    },
  });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.includes("invalid-app-manifest"), true);
  assert.equal(Object.keys(result.candidates).includes("root"), false);
});

test("binds a known-location source root to its own manifest like any other source", async () => {
  const paths: string[] = [];
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([["known-location", "D:\\Steam"]]),
    readFile: async (path) => {
      paths.push(path);
      return manifest;
    },
  });
  const result = await provider.discover();
  assert.deepEqual(paths, ["D:\\Steam\\steamapps\\appmanifest_413150.acf"]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.source, "known-location");
});

test("maps a source failure to unavailable and no-candidates without reading manifests", async () => {
  let read = false;
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: {
      read: async () => {
        throw new Error("source failure");
      },
    },
    readFile: async () => {
      read = true;
      return manifest;
    },
  });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, ["source-unavailable", "no-candidates"]);
  assert.equal(read, false);
});

/** A mounted Steam source that finds nothing: the profile the GOG-only tests compose. */
function steamWithoutRoots(): StardewSteamSource {
  return Object.freeze({
    read: async () => Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze([]) }),
  });
}

/**
 * A GOG proposal source for tests: fixed roots and a fixed set of roots the probe finds
 * a game in. `readable` is separate from `gameExecutable` for the same reason the real
 * probe separates them - "could not look" is not "no game here".
 */
function gogSource(
  roots: readonly string[],
  installed: readonly string[],
  diagnostics: readonly DiscoveryDiagnostic[] = [],
): StardewGogInstallRootSource {
  return Object.freeze({
    read: async () => Object.freeze({ roots: Object.freeze([...roots]), diagnostics: Object.freeze([...diagnostics]) }),
    probe: async (installRoot: string) =>
      Object.freeze({ readable: true, gameExecutable: installed.includes(installRoot) }),
  });
}

/**
 * The measured gap this covers: the panel's provider mounted Steam alone, so a player whose
 * Stardew Valley came from GOG Galaxy was told no installation was found on a machine where
 * it is installed. Both sources are now queried, and the GOG candidate is a candidate like
 * any other - an opaque handle whose root the same admission later reads.
 */
test("queries both mounted sources and offers a GOG installation Steam does not hold", async () => {
  let steamRead = false;
  let gogRead = false;
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: {
      read: async () => {
        steamRead = true;
        return Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze([]) });
      },
    },
    gog: Object.freeze({
      read: async () => {
        gogRead = true;
        return Object.freeze({
          roots: Object.freeze(["D:\\GOG Games\\Stardew Valley"]),
          diagnostics: Object.freeze([]),
        });
      },
      probe: async () => Object.freeze({ readable: true, gameExecutable: true }),
    }),
    readFile: async () => {
      throw new Error("no steam library on this machine");
    },
  });
  const result = await provider.discover();
  assert.equal(steamRead, true, "the Steam source is queried");
  assert.equal(gogRead, true, "the GOG source is queried");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.source),
    ["gog"],
  );
  assert.equal(provider.confirm(result.candidates[0]!.candidateId), "D:\\GOG Games\\Stardew Valley");
});

/**
 * GOG's two default library layouts are unconditional guesses, so an unverified proposal would
 * put a row on a Steam-only player's screen for a game that is not there. Only the root the
 * probe actually found the game in is offered, and the fact that the guess was checked is what
 * makes the empty scan honest.
 */
test("offers only the GOG roots the game is actually installed in", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    gog: gogSource(
      ["C:\\Program Files (x86)\\GOG Galaxy\\Games\\Stardew Valley", "D:\\GOG Games\\Stardew Valley"],
      ["D:\\GOG Games\\Stardew Valley"],
    ),
  });
  const result = await provider.discover();
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.source),
    ["gog"],
  );
  // The label names the folder that holds the root, not the drive alone: two GOG copies on one drive both read
  // `D:` otherwise, which is the "nothing to choose by" fault this label exists to fix.
  assert.equal(result.candidates[0]?.location, "D: · GOG Games");
  assert.equal(provider.confirm(result.candidates[0]!.candidateId), "D:\\GOG Games\\Stardew Valley");
});

/**
 * A folder both sources name is one candidate, and it is attributed to Steam: Steam is the
 * channel that proves the game is there through its own app manifest, so its attribution is
 * the one carrying evidence rather than a library path.
 */
test("a folder both sources name is one candidate, attributed to the proving source", async () => {
  const installRoot = "D:\\Steam\\steamapps\\common\\Stardew Valley";
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([["steam-vdf", "D:\\Steam"]]),
    readFile: async () => manifest,
    // GOG's registry names the very same folder, in different case: one installation, not two.
    gog: gogSource(["d:\\steam\\STEAMAPPS\\common\\stardew valley"], [installRoot]),
  });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.source, "steam-vdf");
  assert.equal(provider.confirm(result.candidates[0]!.candidateId), installRoot);
});

/**
 * The two sources fail independently: GOG's unreadable metadata is named without erasing the
 * Steam candidate, and the Steam failure is named without erasing the GOG one. A player with
 * both stores installed must not lose one because the other could not be read.
 */
test("one source's failure never erases the other source's candidate", async () => {
  const steamOnly = createStardewInstallationDiscoveryProvider({
    source: source([["steam-vdf", "C:\\Steam"]]),
    probe: async () => ({ readable: true, smapi: false }),
    readFile: async () => manifest,
    gog: Object.freeze({
      read: async () => {
        throw new Error("registry unreadable");
      },
      probe: async () => Object.freeze({ readable: true, gameExecutable: false }),
    }),
  });
  const steam = await steamOnly.discover();
  assert.deepEqual(
    steam.candidates.map((candidate) => candidate.source),
    ["steam-vdf"],
  );
  assert.deepEqual(steam.diagnostics, ["gog-unavailable"]);

  const gogOnly = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: {
      read: async () => {
        throw new Error("steam registry unreadable");
      },
    },
    gog: gogSource(["D:\\GOG Games\\Stardew Valley"], ["D:\\GOG Games\\Stardew Valley"]),
  });
  const gog = await gogOnly.discover();
  assert.deepEqual(
    gog.candidates.map((candidate) => candidate.source),
    ["gog"],
  );
  assert.equal(gog.diagnostics.includes("source-unavailable"), true);
  assert.equal(gog.diagnostics.includes("no-candidates"), false);
});

/**
 * The boundary of the probe: a GOG root this process could not inspect is a read that failed,
 * not a folder without a game - so it is named, and no candidate is minted from it. Reporting
 * it as an empty folder would be a statement about the player's disk the Host never made.
 */
test("a GOG root the probe could not read is named, never treated as empty", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: steamWithoutRoots(),
    gog: Object.freeze({
      read: async () =>
        Object.freeze({ roots: Object.freeze(["D:\\GOG Games\\Stardew Valley"]), diagnostics: Object.freeze([]) }),
      probe: async () => Object.freeze({ readable: false, gameExecutable: false }),
    }),
  });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, ["gog-metadata-unreadable", "no-candidates"]);
});

/**
 * A Microsoft Store proposal source for tests: the roots the Xbox app's mods-enabled layout really
 * holds, and the diagnostics that source's own read produced. The real source probes the drives
 * itself (`microsoft-store-source.test.ts` owns that behaviour), so this arm only adds the loader
 * fact - exactly as the GOG arm does.
 */
function microsoftStoreSource(
  roots: readonly string[],
  diagnostics: readonly DiscoveryDiagnostic[] = [],
): StardewMicrosoftStoreInstallRootSource {
  return Object.freeze({
    read: async () => Object.freeze({ roots: Object.freeze([...roots]), diagnostics: Object.freeze([...diagnostics]) }),
  });
}

/**
 * The reported gap: the panel's provider mounted Steam and GOG, so a player whose Stardew Valley came
 * from PC Game Pass was told no installation was found on a machine where it is installed. The Store
 * channel is now a third source, and its candidate is a candidate like any other - an opaque handle
 * whose root the same admission later reads.
 */
test("offers a Microsoft Store installation no Steam library or GOG record names", async () => {
  const installRoot = "C:\\Program Files\\ModifiableWindowsApps\\Stardew Valley";
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: steamWithoutRoots(),
    microsoftStore: microsoftStoreSource([installRoot]),
  });
  const result = await provider.discover();
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.source, candidate.location]),
    [["microsoft-store", "C: · ModifiableWindowsApps"]],
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(provider.confirm(result.candidates[0]!.candidateId), installRoot);
});

/**
 * The half of the channel that must never become a row: a Store copy in the layout no mod loader can
 * run in. The source names it, the provider publishes the name and offers nothing, because choosing
 * it would send the player to install SMAPI into a folder that cannot accept it.
 */
test("names the Store copy that cannot load a mod loader instead of offering it", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: steamWithoutRoots(),
    microsoftStore: microsoftStoreSource([], ["microsoft-store-install-not-mod-enabled"]),
  });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, ["microsoft-store-install-not-mod-enabled", "no-candidates"]);
});

/** The Store channel fails independently too: its own unavailability is named beside the others. */
test("a Store source that cannot be read is named without erasing another source's candidate", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: source([["steam-vdf", "C:\\Steam"]]),
    readFile: async () => manifest,
    microsoftStore: {
      read: async () => {
        throw new Error("drive sweep failed");
      },
    },
  });
  const result = await provider.discover();
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.source),
    ["steam-vdf"],
  );
  assert.deepEqual(result.diagnostics, ["microsoft-store-unavailable"]);
});

/**
 * And the GOG source's own named failures reach the reply unchanged rather than being folded
 * into Steam's vocabulary: the surface says which search it could not run.
 */
test("GOG's own metadata diagnostics are carried through by name", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    probe: async () => ({ readable: true, smapi: false }),
    source: steamWithoutRoots(),
    gog: gogSource([], [], ["gog-metadata-malformed"]),
  });
  assert.deepEqual((await provider.discover()).diagnostics, ["gog-metadata-malformed", "no-candidates"]);
});
