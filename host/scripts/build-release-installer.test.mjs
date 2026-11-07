import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPlayerRelease, releaseIdentity } from "./build-release-installer.mjs";

/**
 * The release assembly refuses before it builds, when it cannot sign.
 *
 * The MSBuild target in `GameBuddy.Setup.csproj` also refuses (`GBSIGN001`), but that surfaces as a dotnet exit code
 * inside a wall of SDK output, one step after the launcher publish and the payload seal have already run. A protected
 * release that cannot be signed has to stop before it spends minutes producing an artifact nobody may publish, and it
 * has to say which fact is missing.
 *
 * Proven here without a certificate and without dotnet: the check runs before anything is spawned, so a fake `spawn`
 * records zero invocations.
 */

async function publishedGeneration() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-release-build-"));
  const output = join(root, "dist");
  await mkdir(join(output, "generations", "g-mvv0x7l0-5804-8da51661227b48afb71fce58dd723b4a"), { recursive: true });
  await writeFile(
    join(output, "current.json"),
    JSON.stringify({
      schema: "gamebuddy-host-production-current/v2",
      generation: "g-mvv0x7l0-5804-8da51661227b48afb71fce58dd723b4a",
      inventoryDigest: "b".repeat(64),
      runtimeAdmissionSha256: "c".repeat(64),
    }),
    "utf8",
  );
  return { root, output };
}

test("a protected release refuses before building when no signing identity is configured", async () => {
  const { root, output } = await publishedGeneration();
  const spawned = [];
  await assert.rejects(
    buildPlayerRelease({
      generationOutputRoot: output,
      outputDirectory: join(root, "release"),
      version: "0.1.0",
      repository: "zhexulong/gamebuddy",
      protectedRelease: true,
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        throw new Error("spawn must not be reached when the identity is absent");
      },
    }),
    /release_installer_failed:signing_identity_required/u,
  );
  assert.deepEqual(
    spawned.map((call) => call.command),
    [],
    "no build step may run before the identity check",
  );
});

test("a version that is not a version is refused, so the download URL cannot be invented", async () => {
  assert.throws(() => releaseIdentity({ version: "latest", repository: "zhexulong/gamebuddy" }), /version_invalid/u);
  assert.throws(() => releaseIdentity({ version: "0.1.0", repository: "not a repo" }), /repository_invalid/u);
  const identity = releaseIdentity({ version: "0.1.0-rc.1", repository: "zhexulong/gamebuddy" });
  assert.equal(
    identity.downloadUrl,
    "https://github.com/zhexulong/gamebuddy/releases/download/v0.1.0-rc.1/GameBuddy.Setup.exe",
  );
});
