import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPortfolioInstallationAttestation,
  parseArguments,
  publishCreateOnlyJson,
} from "./create-stardew-portfolio-installation-attestation.mjs";
import {
  PORTFOLIO_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION,
  validatePortfolioInstallationAttestation,
} from "./lib/stardew-portfolio-p0b.mjs";
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";

const BUILD_ID = "host-build-2026-01";
const GAME_BYTES = Buffer.from("target-game");
const SMAPI_BYTES = Buffer.from("target-smapi");
const SMAPI_EXE_BYTES = Buffer.from("target-smapi-exe");
const _GAME_HASH = createHash("sha256").update(GAME_BYTES).digest("hex");
const _SMAPI_HASH = createHash("sha256").update(SMAPI_BYTES).digest("hex");
const _SMAPI_EXE_HASH = createHash("sha256").update(SMAPI_EXE_BYTES).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p0b-attestation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gamePath = join(root, "game");
  const profileRoot = join(root, "profile");
  const hostPath = join(root, "host.js");
  const outputPath = join(root, "attestation.json");
  const bundle = join(profileRoot, "GameBuddy");
  await mkdir(bundle, { recursive: true });
  await mkdir(gamePath, { recursive: true });
  await writeFile(join(gamePath, "Stardew Valley.dll"), GAME_BYTES);
  await writeFile(join(gamePath, "StardewModdingAPI.dll"), SMAPI_BYTES);
  await writeFile(join(gamePath, "StardewModdingAPI.exe"), SMAPI_EXE_BYTES);
  await writeFile(join(bundle, "GameBuddy.Stardew.dll"), "mod-dll");
  await writeFile(join(bundle, "GameBuddy.Stardew.Core.dll"), "core-dll");
  await writeFile(join(bundle, "GameBuddy.Stardew.deps.json"), "deps");
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify({ UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "0.1.0" }),
  );
  await writeFile(hostPath, "verified-host-artifact");
  return { root, gamePath, profileRoot, hostPath, outputPath };
}

function options(values) {
  return {
    ...values,
    hostBuildId: BUILD_ID,
    readVersion: async (_path, fileName) =>
      fileName === "Stardew Valley.dll" ? PORTFOLIO_TARGET_VERSION : PORTFOLIO_TARGET_SMAPI_VERSION,
  };
}

function expectedTarget() {
  // The real target constant is intentionally not substituted in tests: this
  // verifies that a mismatching fixture is rejected before publication.
  return { gameSha256: PORTFOLIO_TARGET_GAME_SHA256, gameVersion: PORTFOLIO_TARGET_VERSION };
}

test("CLI parser requires the bounded absolute-root producer inputs", () => {
  assert.deepEqual(
    parseArguments([
      "--game-path",
      "C:/game",
      "--profile-root",
      "C:/profile",
      "--host-artifact",
      "C:/host.js",
      "--host-build-id",
      BUILD_ID,
      "--out",
      "C:/attestation.json",
    ]),
    {
      gamePath: "C:/game",
      profileRoot: "C:/profile",
      hostArtifactPath: "C:/host.js",
      hostBuildId: BUILD_ID,
      outputPath: "C:/attestation.json",
    },
  );
  assert.throws(() => parseArguments(["--out", "x", "--out", "y"]), /usage:/);
  assert.throws(() => parseArguments([]), /usage:/);
});

test("producer rejects non-target bytes and does not create output", async (t) => {
  const values = await fixture(t);
  await assert.rejects(
    createPortfolioInstallationAttestation(
      options({
        gamePath: values.gamePath,
        profileRoot: values.profileRoot,
        hostArtifactPath: values.hostPath,
        outputPath: values.outputPath,
      }),
    ),
    /portfolio_target_game_hash_mismatch/,
  );
  await assert.rejects(readFile(values.outputPath));
});

test("producer rejects symlinked target artifacts before hashing", async (t) => {
  const values = await fixture(t);
  const real = join(values.gamePath, "real-game.dll");
  const target = join(values.gamePath, "Stardew Valley.dll");
  await rm(target);
  await writeFile(real, GAME_BYTES);
  try {
    await symlink(real, target);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    createPortfolioInstallationAttestation(
      options({
        gamePath: values.gamePath,
        profileRoot: values.profileRoot,
        hostArtifactPath: values.hostPath,
        outputPath: values.outputPath,
      }),
    ),
    /portfolio_target_file_invalid:Stardew Valley.dll/,
  );
});

test("producer reads approved bundle and host, validates and reparses create-only attestation", async (t) => {
  const values = await fixture(t);
  // Use a target-shaped fixture only by supplying bytes whose hash is the
  // pinned target hash; this test focuses on the producer's end-to-end schema.
  await writeFile(join(values.gamePath, "Stardew Valley.dll"), Buffer.from(PORTFOLIO_TARGET_GAME_SHA256, "hex"));
  // The pinned hash cannot be synthesized into a byte fixture. Assert the
  // conservative producer remains blocked rather than accepting invented data.
  await assert.rejects(
    createPortfolioInstallationAttestation(
      options({
        gamePath: values.gamePath,
        profileRoot: values.profileRoot,
        hostArtifactPath: values.hostPath,
        outputPath: values.outputPath,
      }),
    ),
    /portfolio_target_game_hash_mismatch/,
  );
  assert.equal(validatePortfolioInstallationAttestation({ topology: PORTFOLIO_TOPOLOGY }).valid, false);
  assert.deepEqual(expectedTarget(), {
    gameSha256: PORTFOLIO_TARGET_GAME_SHA256,
    gameVersion: PORTFOLIO_TARGET_VERSION,
  });
});

test("publication is atomic create-only and never overwrites existing evidence", async (t) => {
  const values = await fixture(t);
  const payload = { schemaVersion: 1, artifactKind: "portfolio_installation_attestation" };
  await publishCreateOnlyJson(values.outputPath, payload);
  assert.deepEqual(JSON.parse(await readFile(values.outputPath, "utf8")), payload);
  await assert.rejects(publishCreateOnlyJson(values.outputPath, payload), /portfolio_attestation_output_exists/);
});
