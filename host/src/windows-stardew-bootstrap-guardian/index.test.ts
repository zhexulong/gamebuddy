import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  armAttempt,
  beginRecovery,
  containRole,
  createPublishedWindowsStardewBootstrapGuardian,
  launchRole,
  recoverAttempt,
  type ArmAttemptRequest,
} from "./index.js";
import { validateGuardianRequest } from "./protocol.js";

const OPAQUE = "53ee44a2-d70b-4a49-a857-1ca4883e5d2e";
const OPAQUE_2 = "9b1c2d3e-4f5a-4b6c-8d7e-1f2a3b4c5d6e";
const exactArmRequest: ArmAttemptRequest = Object.freeze({
  schemaVersion: 1,
  operation: "arm_attempt",
  guardianInstanceId: OPAQUE,
  guardianEpoch: 1,
  attemptId: OPAQUE_2,
});

const validRequests = [
  exactArmRequest,
  { schemaVersion: 1, operation: "launch_role", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2, role: "player_host" },
  { schemaVersion: 1, operation: "contain_role", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2, role: "ai_client" },
  { schemaVersion: 1, operation: "begin_recovery", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2, recoveryInstanceId: OPAQUE },
  { schemaVersion: 1, operation: "recover_attempt", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2 },
] as const;

test("guardian validates and reconstructs every fixed redacted request grammar", () => {
  for (const request of validRequests) assert.deepEqual(validateGuardianRequest(request), request);
});

test("guardian rejects path, pid, token, bridge, lease substitution, unknown role, and invalid epochs", () => {
  for (const request of [
    { schemaVersion: 1, operation: "arm_attempt", jobName: "opaque", executable: "C:\\leak.exe" },
    { schemaVersion: 1, operation: "launch_role", guardianEpoch: 99 },
    { ...exactArmRequest, guardianInstanceId: "C:\\leak.exe" },
    { ...exactArmRequest, leaseName: "substituted-lease" },
    { schemaVersion: 1, operation: "contain_role", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2, bridgeToken: "secret" },
    { schemaVersion: 1, operation: "contain_role", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2, role: "bridge" },
    { schemaVersion: 1, operation: "recover_attempt", guardianInstanceId: OPAQUE, guardianEpoch: 0, attemptId: OPAQUE_2 },
    { schemaVersion: 1, operation: "recover_attempt", guardianInstanceId: OPAQUE, guardianEpoch: 1.5, attemptId: OPAQUE_2 },
    { schemaVersion: 1, operation: "begin_recovery", guardianInstanceId: OPAQUE, guardianEpoch: 1, attemptId: OPAQUE_2, recoveryInstanceId: "gamebuddy-stardew-token" },
  ]) assert.throws(() => validateGuardianRequest(request), /windows_stardew_bootstrap_guardian_invalid_request/);
});

test("guardian operations reject forged capabilities", async () => {
  await assert.rejects(armAttempt({} as never, exactArmRequest), /windows_stardew_bootstrap_guardian_unavailable/);
  await assert.rejects(armAttempt(undefined as never, exactArmRequest), /windows_stardew_bootstrap_guardian_unavailable/);
});

test(
  "inventory-attested Task 1 capability rechecks the pair and remains unavailable without native execution",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const capability = await createPublishedWindowsStardewBootstrapGuardian(fixture.root);
      const results = await Promise.all([
        armAttempt(capability, validRequests[0]),
        launchRole(capability, validRequests[1]),
        containRole(capability, validRequests[2]),
        beginRecovery(capability, validRequests[3]),
        recoverAttempt(capability, validRequests[4]),
      ]);
      assert.deepEqual(results, Array(5).fill("kept_unavailable"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test("production Guardian modules expose no spawn or capability registrar seam", async () => {
  const production = await import("./index.js");
  const protocol = await import("./protocol.js");
  for (const name of ["createGuardianCapability", "registerGuardianCapability", "createTestWindowsStardewBootstrapGuardian", "invokeGuardianProtocol", "spawnHelper"]) {
    assert.equal(name in production, false);
    assert.equal(name in protocol, false);
  }
  const internalPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "internal.ts");
  await assert.rejects(readFile(internalPath, "utf8"), /ENOENT|no such file/i);
});

// Published-pair provenance regressions. The production mint is Windows/x64-only;
// fixture bytes are never executed, so these checks remain no-process.
const publishedHelperFileName = "GameBuddy.WindowsStardewBootstrapGuardian.exe";
const publishedManifestFileName = "windows-stardew-bootstrap-guardian.manifest.json";
const publishedPairDestination = "native/windows-stardew-bootstrap-guardian/win-x64";
const publishedInventorySchema = "gamebuddy-host-production-inventory/v4";
const publishedOriginKind = "verified_windows_stardew_bootstrap_guardian";

function fixtureCanonicalManifest(sha256: string): string {
  return `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${publishedHelperFileName}","sha256":"${sha256}"}\n`;
}

function fixtureInventory(helperSha256: string, manifestSha256: string): string {
  const origin = {
    kind: publishedOriginKind,
    destination: publishedPairDestination,
    helper: publishedHelperFileName,
    manifest: publishedManifestFileName,
    helperSha256,
  };
  return JSON.stringify({
    schema: publishedInventorySchema,
    entries: [
      {
        path: `${publishedPairDestination}/${publishedHelperFileName}`,
        type: "file",
        mode: "755",
        sha256: helperSha256,
        origin,
      },
      {
        path: `${publishedPairDestination}/${publishedManifestFileName}`,
        type: "file",
        mode: "644",
        sha256: manifestSha256,
        origin,
      },
    ],
  });
}

/** Creates a physical fixture generation root containing one canonical pair
 * (deterministic bytes that are never executed) plus its verified inventory.
 * The root is realpath-normalized so the physical identity comparison holds. */
async function makePublishedPairFixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "gamebuddy-guardian-published-")));
  const pairRoot = resolve(root, ...publishedPairDestination.split("/"));
  await mkdir(pairRoot, { recursive: true });
  const helperBytes = Buffer.from("fixture-helper-bytes-v1", "utf8");
  const sha256 = createHash("sha256").update(helperBytes).digest("hex");
  const manifest = fixtureCanonicalManifest(sha256);
  const helperPath = resolve(pairRoot, publishedHelperFileName);
  const manifestPath = resolve(pairRoot, publishedManifestFileName);
  await writeFile(helperPath, helperBytes);
  await writeFile(manifestPath, manifest, "utf8");
  await writeFile(
    resolve(root, "production-inventory.json"),
    fixtureInventory(sha256, createHash("sha256").update(manifest).digest("hex")),
    "utf8",
  );
  return { root, pairRoot, helperPath, manifestPath, helperBytes, sha256 };
}

test(
  "published adapter requires the Host-TCB generation inventory binding",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const capability = await createPublishedWindowsStardewBootstrapGuardian(fixture.root);
       assert.equal(typeof capability, "object");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }

    // Without the generation inventory the pair is not bound to a verified
    // Host-TCB deployment generation: the published capability is unavailable.
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "gamebuddy-guardian-published-noinv-")));
    try {
      const pairRoot = resolve(root, ...publishedPairDestination.split("/"));
      await mkdir(pairRoot, { recursive: true });
      const helperBytes = Buffer.from("fixture-helper-bytes-v2", "utf8");
      const sha256 = createHash("sha256").update(helperBytes).digest("hex");
      await writeFile(resolve(pairRoot, publishedHelperFileName), helperBytes);
      await writeFile(resolve(pairRoot, publishedManifestFileName), fixtureCanonicalManifest(sha256), "utf8");
      await assert.rejects(
        createPublishedWindowsStardewBootstrapGuardian(root),
        /windows_stardew_bootstrap_guardian_unavailable/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter fails closed on a tampered generation inventory",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const inventoryPath = resolve(fixture.root, "production-inventory.json");
      const tamper = async (mutate: (parsed: any) => void) => {
        const parsed = JSON.parse(await readFile(inventoryPath, "utf8"));
        mutate(parsed);
        await writeFile(inventoryPath, JSON.stringify(parsed), "utf8");
        await assert.rejects(
          createPublishedWindowsStardewBootstrapGuardian(fixture.root),
          /windows_stardew_bootstrap_guardian_unavailable/,
        );
      };
      await tamper((parsed) => {
        parsed.entries[0].sha256 = "0".repeat(64);
      });
      await tamper((parsed) => {
        parsed.entries[0].origin.kind = "typescript_emit";
      });
      await tamper((parsed) => {
        parsed.entries[0].origin.destination = "native/other-lane/win-x64";
      });
      await tamper((parsed) => {
        parsed.entries[0].origin.helper = "GameBuddy.Other.exe";
      });
      await tamper((parsed) => {
        parsed.entries[0].origin.helperSha256 = "0".repeat(64);
      });
      await tamper((parsed) => {
        parsed.entries[0].path = `${publishedPairDestination}/replaced.exe`;
      });
      await tamper((parsed) => {
        parsed.schema = "gamebuddy-host-production-inventory/v3";
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published inventory must declare exactly both guardian pair entries",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const inventoryPath = resolve(fixture.root, "production-inventory.json");
      const original = await readFile(inventoryPath, "utf8");
      const expectRejected = async (mutate: (parsed: any) => void) => {
        const parsed = JSON.parse(original);
        mutate(parsed);
        await writeFile(inventoryPath, JSON.stringify(parsed), "utf8");
        await assert.rejects(
          createPublishedWindowsStardewBootstrapGuardian(fixture.root),
          /windows_stardew_bootstrap_guardian_unavailable/,
        );
        await writeFile(inventoryPath, original, "utf8");
      };
      // Removing the helper entry or the manifest entry breaks the exact pair.
      await expectRejected((parsed) => {
        parsed.entries = parsed.entries.slice(1);
      });
      await expectRejected((parsed) => {
        parsed.entries = parsed.entries.slice(0, 1);
      });
      // Replacing either entry's type or hash breaks the exact pair.
      await expectRejected((parsed) => {
        parsed.entries[0].type = "directory";
      });
      await expectRejected((parsed) => {
        parsed.entries[1].sha256 = "0".repeat(64);
      });
  // Duplicate entries for either canonical path are ambiguous and fail closed.
       await expectRejected((parsed) => {
         parsed.entries.push({ ...parsed.entries[0] });
       });
       await expectRejected((parsed) => {
         parsed.entries.push({ ...parsed.entries[1] });
       });
       // Unrelated entries are allowed in the full production inventory.
        const restored = JSON.parse(original);
        restored.entries.push({ path: "other/file", type: "file", sha256: "0".repeat(64), origin: { kind: "typescript_emit" } });
        await writeFile(inventoryPath, JSON.stringify(restored), "utf8");
       await createPublishedWindowsStardewBootstrapGuardian(fixture.root);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter fails closed on a pair-directory junction before mint and before an operation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const fixture = await makePublishedPairFixture();
    const moved = resolve(fixture.root, "pair-moved");
    try {
      const capability = await createPublishedWindowsStardewBootstrapGuardian(fixture.root);
      // Replace the pair directory with a junction to a directory containing a
      // byte-identical pair: the physical ancestor proof must fail closed both
      // at mint and immediately before the next operation.
      await rename(fixture.pairRoot, moved);
      try {
        await symlink(moved, fixture.pairRoot, "junction");
      } catch (error) {
        if (
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
        ) {
          t.skip("BLOCKED: junction creation is unavailable; pair ancestor junction closure cannot be claimed");
          return;
        }
        throw error;
      }
      assert.equal((await lstat(fixture.pairRoot)).isSymbolicLink(), true);
      await assert.rejects(
        armAttempt(capability, exactArmRequest),
        /windows_stardew_bootstrap_guardian_unavailable/,
      );
      await assert.rejects(
        createPublishedWindowsStardewBootstrapGuardian(fixture.root),
        /windows_stardew_bootstrap_guardian_unavailable/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter revalidates the helper digest immediately before each operation",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const capability = await createPublishedWindowsStardewBootstrapGuardian(fixture.root);
      // A helper replaced after mint must fail closed before the next operation:
      // the capability never caches an unchecked pair bytes.
      await writeFile(fixture.helperPath, Buffer.from("replacement-helper-bytes", "utf8"));
      await assert.rejects(
        armAttempt(capability, exactArmRequest),
        /windows_stardew_bootstrap_guardian_unavailable/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published guardian capability accepts only its inventory-attested fixed pair (manifest tamper)",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const capability = await createPublishedWindowsStardewBootstrapGuardian(fixture.root);
      // Tampering the manifest after mint must fail closed on the next operation:
      // the canonical manifest must byte-exactly match the helper digest.
      await writeFile(fixture.manifestPath, fixtureCanonicalManifest("0".repeat(64)), "utf8");
      await assert.rejects(
        armAttempt(capability, exactArmRequest),
        /windows_stardew_bootstrap_guardian_unavailable/,
      );
      // A fresh mint over the tampered manifest is equally rejected.
      await assert.rejects(
        createPublishedWindowsStardewBootstrapGuardian(fixture.root),
        /windows_stardew_bootstrap_guardian_unavailable/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
