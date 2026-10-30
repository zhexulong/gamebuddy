import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { probeStardewGameRoot } from "./discovery.js";
import { deploySmapiPayload, type SmapiDeploymentResult } from "./smapi-deployment.js";
import { readSmapiPayload } from "./smapi-payload.js";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function payloadFileBytes(path: string): Buffer {
  return Buffer.from(`payload:${path}\n`);
}

function writePayloadFile(destination: string, bytes: Buffer): Promise<void> {
  return mkdir(resolve(destination, ".."), { recursive: true }).then(() => writeFile(destination, bytes));
}

/**
 * A disposable payload shaped exactly like the one a generation publishes: a manifest
 * naming the complete file set, the payload files themselves, and the licence the manifest
 * digests. Small stand-ins for SMAPI's own bytes - the deployment step is the subject here,
 * and the shipped payload is proven by its own reader against the real archive.
 */
async function writePayloadFixture(
  options: Readonly<{ files?: readonly string[]; playerOwnedFiles?: readonly string[]; licenseText?: string }> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-smapi-payload-"));
  const filePaths = options.files ?? [
    "StardewModdingAPI.exe",
    "StardewModdingAPI.dll",
    "StardewModdingAPI.runtimeconfig.json",
    "smapi-internal/config.json",
    "Mods/SaveBackup/manifest.json",
  ];
  const files = [];
  for (const path of filePaths) {
    const bytes = payloadFileBytes(path);
    await writePayloadFile(join(root, "native", "smapi", "win-x64", ...path.split("/")), bytes);
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  const licenseText = options.licenseText ?? "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";
  await writeFile(join(root, "native", "smapi", "SMAPI-LICENSE.txt"), licenseText);
  await writeFile(
    join(root, "native", "smapi", "payload-manifest.json"),
    `${JSON.stringify(
      {
        schema: "gamebuddy-smapi-payload-manifest/v1",
        version: "4.5.2",
        sourceUrl: "https://github.com/Pathoschild/SMAPI/releases/download/4.5.2/SMAPI-4.5.2-installer.zip",
        sourceArchiveSha256: "0".repeat(64),
        sourceArchiveEntry: "internal/windows/install.dat",
        license: { file: "SMAPI-LICENSE.txt", sha256: sha256(Buffer.from(licenseText)) },
        root: "win-x64",
        files,
        playerOwnedFiles: options.playerOwnedFiles ?? [],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

/** A vanilla Stardew installation: the game executable and its dependency file, no loader. */
async function writeVanillaGameRoot(options: Readonly<{ withDependencies?: boolean }> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-vanilla-game-"));
  await writeFile(join(root, "Stardew Valley.exe"), "game");
  if (options.withDependencies !== false)
    await writeFile(join(root, "Stardew Valley.deps.json"), '{"runtimeTarget":{}}\n');
  return root;
}

function isFailure(result: SmapiDeploymentResult, failure: string): boolean {
  return result.kind === "failed" && result.failure === failure;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function listTree(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await listTree(root, path)));
    else paths.push(path);
  }
  return paths.sort();
}

test("a vanilla installation with no mod loader is brought to a ready probe", async () => {
  const artifactRoot = await writePayloadFixture();
  const installRoot = await writeVanillaGameRoot();
  try {
    const payload = await readSmapiPayload(artifactRoot);
    assert.equal(payload.version, "4.5.2");
    assert.equal(payload.files.length, 5);

    // The state the button exists for: the game is there and the loader is not.
    assert.deepEqual(await probeStardewGameRoot(installRoot), { readable: true, gameExecutable: true, smapi: false });

    const result = await deploySmapiPayload({ installRoot, payload });
    assert.deepEqual(result, { kind: "installed", version: "4.5.2" });

    // Every payload file landed at its declared relative path, and the probe the launch
    // gate reads now says the mod loader is there.
    for (const file of payload.files) {
      assert.equal(await exists(join(installRoot, ...file.path.split("/"))), true, file.path);
    }
    assert.deepEqual(await probeStardewGameRoot(installRoot), { readable: true, gameExecutable: true, smapi: true });
    // SMAPI's own install step: the loader's dependencies come from the game's.
    assert.equal(
      await readFile(join(installRoot, "StardewModdingAPI.deps.json"), "utf8"),
      await readFile(join(installRoot, "Stardew Valley.deps.json"), "utf8"),
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("an installation that already carries a mod loader is written to zero times", async () => {
  const artifactRoot = await writePayloadFixture();
  const installRoot = await writeVanillaGameRoot();
  try {
    const payload = await readSmapiPayload(artifactRoot);
    await deploySmapiPayload({ installRoot, payload });
    const loader = join(installRoot, "StardewModdingAPI.exe");
    assert.equal(await readFile(loader, "utf8"), payloadFileBytes("StardewModdingAPI.exe").toString());
    // The player's own copy, replaced behind our back: a second click must not rewrite it,
    // because a running game may hold it and a mod loader is the player's to keep.
    await writeFile(loader, "player-managed-loader");
    const result = await deploySmapiPayload({ installRoot, payload });
    assert.deepEqual(result, { kind: "current", version: "4.5.2" });
    assert.equal(await readFile(loader, "utf8"), "player-managed-loader");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("a folder holding no game is refused before anything is written", async () => {
  const artifactRoot = await writePayloadFixture();
  const notAGame = await mkdtemp(join(tmpdir(), "gamebuddy-not-a-game-"));
  try {
    const payload = await readSmapiPayload(artifactRoot);
    assert.equal(
      isFailure(await deploySmapiPayload({ installRoot: notAGame, payload }), "game_installation_not_found"),
      true,
    );
    assert.equal(
      isFailure(
        await deploySmapiPayload({ installRoot: join(notAGame, "never-created"), payload }),
        "game_installation_not_found",
      ),
      true,
    );
    assert.equal(
      isFailure(
        await deploySmapiPayload({ installRoot: "relative\\Stardew Valley", payload }),
        "game_installation_not_found",
      ),
      true,
    );
    assert.deepEqual(await listTree(notAGame), []);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(notAGame, { recursive: true, force: true });
  }
});

test("a game folder without its dependency file is refused rather than half installed", async () => {
  const artifactRoot = await writePayloadFixture();
  const installRoot = await writeVanillaGameRoot({ withDependencies: false });
  try {
    const payload = await readSmapiPayload(artifactRoot);
    assert.equal(isFailure(await deploySmapiPayload({ installRoot, payload }), "game_dependencies_missing"), true);
    assert.deepEqual(await listTree(installRoot), ["Stardew Valley.exe"]);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("a conflicting installation file refuses the whole write instead of mixing two payloads", async () => {
  const artifactRoot = await writePayloadFixture();
  const installRoot = await writeVanillaGameRoot();
  try {
    const payload = await readSmapiPayload(artifactRoot);
    // A leftover file from something else that the payload would otherwise overwrite.
    await mkdir(join(installRoot, "smapi-internal"), { recursive: true });
    await writeFile(join(installRoot, "smapi-internal", "config.json"), "someone-elses-config");
    const result = await deploySmapiPayload({ installRoot, payload });
    assert.equal(isFailure(result, "installation_conflict"), true);
    // Nothing was written: the loader is still absent and the foreign file is untouched.
    assert.equal(await exists(join(installRoot, "StardewModdingAPI.exe")), false);
    assert.equal(await readFile(join(installRoot, "smapi-internal", "config.json"), "utf8"), "someone-elses-config");
    assert.equal(await exists(join(installRoot, "StardewModdingAPI.deps.json")), false);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("player-owned payload files are never overwritten", async () => {
  const artifactRoot = await writePayloadFixture({ playerOwnedFiles: ["smapi-internal/config.json"] });
  const installRoot = await writeVanillaGameRoot();
  try {
    const payload = await readSmapiPayload(artifactRoot);
    await mkdir(join(installRoot, "smapi-internal"), { recursive: true });
    await writeFile(join(installRoot, "smapi-internal", "config.json"), "player-tuned");
    const result = await deploySmapiPayload({ installRoot, payload });
    assert.deepEqual(result, { kind: "installed", version: "4.5.2" });
    assert.equal(await readFile(join(installRoot, "smapi-internal", "config.json"), "utf8"), "player-tuned");
    assert.equal(await exists(join(installRoot, "StardewModdingAPI.exe")), true);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("a payload that does not match its own manifest is refused", async () => {
  const artifactRoot = await writePayloadFixture();
  try {
    await writeFile(join(artifactRoot, "native", "smapi", "win-x64", "StardewModdingAPI.dll"), "tampered");
    await assert.rejects(readSmapiPayload(artifactRoot), /smapi_payload_unavailable/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a payload carrying a file its manifest does not name is refused", async () => {
  const artifactRoot = await writePayloadFixture();
  try {
    await writePayloadFile(join(artifactRoot, "native", "smapi", "win-x64", "extra.dll"), Buffer.from("extra\n"));
    await assert.rejects(readSmapiPayload(artifactRoot), /smapi_payload_unavailable/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a payload whose licence is not the LGPL text is refused", async () => {
  const artifactRoot = await writePayloadFixture({ licenseText: "no licence here\n" });
  try {
    await assert.rejects(readSmapiPayload(artifactRoot), /smapi_payload_unavailable/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
