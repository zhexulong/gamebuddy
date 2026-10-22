import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STARDEW_GAME_EXECUTABLE_FILE,
  STARDEW_MOD_LOADER_MISSING,
  STARDEW_NOT_A_STARDEW_INSTALL,
  STARDEW_SMAPI_EXECUTABLE_FILE,
  discoverStardewGameInstallation,
  probeStardewGameRoot,
  requireStardewGameInstalled,
  requireStardewModLoaderInstalled,
  resolveStardewGameInstallation,
  type StardewGameInstallationResolverInput,
  type StardewGameRootProbe,
} from "./index.js";

function probeFrom(installed: readonly string[], withSmapi: readonly string[] = [installed[0] ?? ""]) {
  return async (installRoot: string): Promise<StardewGameRootProbe> =>
    Object.freeze({ gameExecutable: installed.includes(installRoot), smapi: withSmapi.includes(installRoot) });
}

function resolverInput(
  overrides: Partial<StardewGameInstallationResolverInput> & Pick<StardewGameInstallationResolverInput, "probe">,
): StardewGameInstallationResolverInput {
  return Object.freeze({
    steamInstallRoots: [],
    gogInstallRoots: [],
    sourceDiagnostics: [],
    ...overrides,
  });
}

test("one installed game resolves without asking the player", async () => {
  const root = "C:\\Games\\Stardew Valley";
  const resolution = await resolveStardewGameInstallation(
    resolverInput({ steamInstallRoots: [root], probe: probeFrom([root]) }),
  );
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  assert.deepEqual(resolution.installation, {
    source: "steam",
    installRoot: root,
    gameExecutable: `${root}\\${STARDEW_GAME_EXECUTABLE_FILE}`,
    smapiExecutable: `${root}\\${STARDEW_SMAPI_EXECUTABLE_FILE}`,
  });
});

test("several installed games require an explicit choice, in steam-then-gog order", async () => {
  const steam = "C:\\Steam\\Stardew Valley";
  const gog = "D:\\GOG Games\\Stardew Valley";
  const resolution = await resolveStardewGameInstallation(
    resolverInput({ steamInstallRoots: [steam], gogInstallRoots: [gog], probe: probeFrom([steam, gog]) }),
  );
  assert.equal(resolution.kind, "choice_required");
  if (resolution.kind !== "choice_required") return;
  assert.deepEqual(
    resolution.installations.map((installation) => [installation.source, installation.installRoot]),
    [
      ["steam", steam],
      ["gog", gog],
    ],
  );
});

test("no installed game is a named not-found result, and a non-game root is named", async () => {
  const empty = await resolveStardewGameInstallation(resolverInput({ probe: probeFrom([]) }));
  assert.deepEqual(empty, { kind: "not_found", diagnostics: [] });

  const notAGame = await resolveStardewGameInstallation(
    resolverInput({ steamInstallRoots: ["C:\\Steam\\Stardew Valley"], probe: probeFrom([]) }),
  );
  assert.deepEqual(notAGame, { kind: "not_found", diagnostics: ["candidate-not-a-stardew-install"] });
});

test("a game without SMAPI is still discovered, and its SMAPI path is null", async () => {
  const root = "C:\\Games\\Stardew Valley";
  const resolution = await resolveStardewGameInstallation(
    resolverInput({ steamInstallRoots: [root], probe: probeFrom([root], []) }),
  );
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  assert.equal(resolution.installation.smapiExecutable, null);
  assert.equal(resolution.installation.gameExecutable, `${root}\\${STARDEW_GAME_EXECUTABLE_FILE}`);
});

test("duplicate roots from two sources are probed once and deduplicated case-insensitively", async () => {
  const probed: string[] = [];
  const resolution = await resolveStardewGameInstallation(
    resolverInput({
      steamInstallRoots: ["C:\\Games\\Stardew Valley"],
      gogInstallRoots: ["c:\\games\\stardew valley"],
      probe: async (installRoot) => {
        probed.push(installRoot);
        return Object.freeze({ gameExecutable: true, smapi: true });
      },
    }),
  );
  assert.equal(resolution.kind, "resolved");
  assert.deepEqual(probed, ["C:\\Games\\Stardew Valley"]);
});

test("a player-chosen installation wins over every discovered root", async () => {
  const chosen = "E:\\My Games\\Stardew Valley";
  const steam = "C:\\Steam\\Stardew Valley";
  const resolution = await resolveStardewGameInstallation(
    resolverInput({ chosenInstallRoot: chosen, steamInstallRoots: [steam], probe: probeFrom([chosen, steam]) }),
  );
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  assert.equal(resolution.installation.source, "chosen");
  assert.equal(resolution.installation.installRoot, chosen);
});

test("an unusable player choice is a named refusal instead of a silent fallback", async () => {
  const steam = "C:\\Steam\\Stardew Valley";
  const invalid = await resolveStardewGameInstallation(
    resolverInput({
      chosenInstallRoot: "relative\\Stardew Valley",
      steamInstallRoots: [steam],
      probe: probeFrom([steam]),
    }),
  );
  assert.deepEqual(invalid, { kind: "not_found", diagnostics: ["chosen-root-invalid"] });

  const notAGame = await resolveStardewGameInstallation(
    resolverInput({ chosenInstallRoot: "E:\\Not Stardew", steamInstallRoots: [steam], probe: probeFrom([steam]) }),
  );
  assert.deepEqual(notAGame, { kind: "not_found", diagnostics: ["chosen-root-not-a-stardew-install"] });
});

test(
  "the discovery entry reports an unusable player choice without touching any other source",
  { skip: process.platform === "win32" },
  async () => {
    const resolution = await discoverStardewGameInstallation({ chosenInstallRoot: "relative\\Stardew Valley" });
    assert.equal(resolution.kind, "not_found");
    if (resolution.kind !== "not_found") return;
    assert.equal(resolution.diagnostics.includes("chosen-root-invalid"), true);
    assert.equal(resolution.diagnostics.includes("steam-unavailable"), true);
  },
);

test("the discovery entry resolves a real Windows installation", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-stardew-discovery-"));
  try {
    await mkdir(join(root, "Mods"));
    await writeFile(join(root, STARDEW_GAME_EXECUTABLE_FILE), "game");
    await writeFile(join(root, STARDEW_SMAPI_EXECUTABLE_FILE), "smapi");
    assert.deepEqual(await probeStardewGameRoot(root), { gameExecutable: true, smapi: true });
    const resolution = await discoverStardewGameInstallation({ chosenInstallRoot: root });
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind !== "resolved") return;
    assert.equal(resolution.installation.source, "chosen");
    assert.equal(resolution.installation.installRoot, await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probing a missing installation reports no executables", { skip: process.platform !== "win32" }, async () => {
  assert.deepEqual(await probeStardewGameRoot("C:\\Definitely Not Installed\\Stardew Valley"), {
    gameExecutable: false,
    smapi: false,
  });
});

/**
 * The falsifier for the mod-loader requirement. A game directory holding only
 * `Stardew Valley.exe` is exactly the machine the first-run review describes: the
 * game starts, the Companion Mod never loads, and nobody told the player why. The
 * probe must report the absence, and the refusal must name it in a bounded code,
 * so the launch can stop there and the player can read what to install.
 */
test(
  "a game directory without the mod loader is detected and refused by name",
  { skip: process.platform !== "win32" },
  async () => {
    assert.equal(STARDEW_MOD_LOADER_MISSING, "stardew_mod_loader_missing");
    const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-stardew-no-loader-"));
    try {
      await writeFile(join(root, STARDEW_GAME_EXECUTABLE_FILE), "game");
      assert.deepEqual(await probeStardewGameRoot(root), { gameExecutable: true, smapi: false });
      await assert.rejects(requireStardewModLoaderInstalled(root), { message: STARDEW_MOD_LOADER_MISSING });

      await writeFile(join(root, STARDEW_SMAPI_EXECUTABLE_FILE), "smapi");
      await requireStardewModLoaderInstalled(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * The named refusal may not swallow another installation's fault: an empty or
 * wrong directory is the installation admission's own refusal, and reporting it
 * as a missing mod loader would send the player to install SMAPI over a game that
 * is not there. The requirement therefore stands down when no game is present.
 */
test(
  "a directory that holds no game is not refused as a missing mod loader",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-not-stardew-"));
    try {
      await requireStardewModLoaderInstalled(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
/**
 * The falsifier for "this folder is not Stardew". The comment above says the mod-loader
 * requirement stands down when no game is present - which left the wrong folder with no
 * name at all, so the panel reported it as a search that could not run. The refusal is its
 * own bounded code, and it may only claim what the read actually found: absence.
 */
test(
  "a directory holding no game is refused by its own bounded name",
  { skip: process.platform !== "win32" },
  async () => {
    assert.equal(STARDEW_NOT_A_STARDEW_INSTALL, "stardew_not_a_stardew_install");
    const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-wrong-folder-"));
    try {
      await assert.rejects(requireStardewGameInstalled(root), { message: STARDEW_NOT_A_STARDEW_INSTALL });
      // A folder that does not exist is the same fact: there is no game there.
      await assert.rejects(requireStardewGameInstalled(join(root, "missing")), {
        message: STARDEW_NOT_A_STARDEW_INSTALL,
      });
      // The game is there (with or without SMAPI): this refusal stands down.
      await writeFile(join(root, STARDEW_GAME_EXECUTABLE_FILE), "game");
      await requireStardewGameInstalled(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * The other half of the same boundary: absence is a read that COMPLETED. A path this
 * process cannot look at is not a folder without a game in it - the caller keeps its
 * unnamed `unavailable` refusal rather than telling the player to pick another folder
 * when the disk (or a permission) is what failed.
 */
test("a path that cannot be read is not reported as a folder without a game", async () => {
  await assert.rejects(requireStardewGameInstalled("C:\\gamebuddy\u0000unreadable"), (error: unknown) => {
    return error instanceof Error && error.message !== STARDEW_NOT_A_STARDEW_INSTALL;
  });
});
