import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPublishedWindowsStaleLockReclaimer,
  reclaimStaleLock,
  releaseOwnedLock,
  requestWindowsStaleLockReclaimer,
  type WindowsStaleLockReclaimCategory,
  type WindowsStaleLockReleaseCategory,
} from "./index.js";
import { createTestWindowsStaleLockReclaimer } from "./index.test-support.js";
import { reclaimerState } from "./internal.js";

/** Drive-rooted on Windows, POSIX-absolute elsewhere; both are admitted by the
 * frozen root/segments derivation so the request grammar is tested identically
 * on every platform. */
const absoluteCandidate = process.platform === "win32" ? "C:\\absolute\\candidate.lock" : "/absolute/candidate.lock";

function responseLine(category: string): string {
  return `{"schemaVersion":1,"result":"${category}"}\n`;
}
const RECLAIM_CATEGORIES: readonly WindowsStaleLockReclaimCategory[] = [
  "reclaimed",
  "missing",
  "kept_malformed_fresh",
  "kept_valid_fresh",
  "kept_policy_mismatch",
  "kept_identity_changed",
  "kept_path_replaced",
  "kept_not_regular",
  "indeterminate",
];
const RELEASE_CATEGORIES: readonly WindowsStaleLockReleaseCategory[] = [
  "released",
  "missing",
  "kept_token_mismatch",
  "kept_not_regular",
  "indeterminate",
];

for (const category of RECLAIM_CATEGORIES) {
  test(`reclaimStaleLock maps the ${category} native category through the frozen protocol`, async () => {
    const capability = createTestWindowsStaleLockReclaimer(() => syntheticChild(category));
    assert.equal(await reclaimStaleLock(capability, absoluteCandidate, "stale_malformed"), category);
  });
}

for (const category of RELEASE_CATEGORIES) {
  test(`releaseOwnedLock maps the ${category} native category through the frozen protocol`, async () => {
    const capability = createTestWindowsStaleLockReclaimer(() => syntheticChild(category));
    assert.equal(
      await releaseOwnedLock(capability, absoluteCandidate, "00000000-0000-4000-8000-000000000000"),
      category,
    );
  });
}

for (const outcome of ["malformed", "unavailable", "timeout", "nonzero", "stderr", "overflow"] as const) {
  test(`reclaimStaleLock ${outcome} child behavior fails closed`, async () => {
    const capability = createTestWindowsStaleLockReclaimer(() => syntheticChild(outcome));
    await assert.rejects(
      reclaimStaleLock(capability, absoluteCandidate, "stale_malformed"),
      /windows_stale_lock_reclaimer_unavailable/,
    );
  });
}

test("reclaimStaleLock sends exactly the frozen root/segments request grammar for each operation", async () => {
  const requests: string[] = [];
  let calls = 0;
  const capability = createTestWindowsStaleLockReclaimer(() =>
    syntheticChild(calls++ === 0 ? "reclaimed" : "released", requests),
  );
  const root = process.platform === "win32" ? "C:\\" : "/";
  await reclaimStaleLock(capability, absoluteCandidate, "stale_valid_dead");
  assert.deepEqual(JSON.parse(requests[0]!), {
    schemaVersion: 1,
    operation: "reclaim_stale_lock",
    policy: "stale_valid_dead",
    root,
    segments: ["absolute", "candidate.lock"],
  });
  await releaseOwnedLock(capability, absoluteCandidate, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual(JSON.parse(requests[1]!), {
    schemaVersion: 1,
    operation: "release_owned_lock",
    token: "00000000-0000-4000-8000-000000000000",
    root,
    segments: ["absolute", "candidate.lock"],
  });
});

test("reclaimStaleLock rejects invalid capabilities and unsupported paths before any spawn", async () => {
  await assert.rejects(
    reclaimStaleLock({} as never, absoluteCandidate, "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  const capability = createTestWindowsStaleLockReclaimer(() => syntheticChild("reclaimed"));
  // Relative paths and every grammar-unsafe absolute form fail closed before
  // the spawn helper is even asked to run.
  await assert.rejects(
    reclaimStaleLock(capability, "relative/candidate.lock", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    releaseOwnedLock(capability, "relative/candidate.lock", "00000000-0000-4000-8000-000000000000"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/candidate.json", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/../candidate.lock", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/./candidate.lock", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute//candidate.lock", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/*.lock", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/CoN.lock", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/candidate.lock ", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  await assert.rejects(
    reclaimStaleLock(capability, "/absolute/candidate.lock.", "stale_malformed"),
    /windows_stale_lock_reclaimer_unavailable/,
  );
  if (process.platform === "win32") {
    await assert.rejects(
      reclaimStaleLock(capability, "\\\\server\\share\\candidate.lock", "stale_malformed"),
      /windows_stale_lock_reclaimer_unavailable/,
    );
    await assert.rejects(
      reclaimStaleLock(capability, "\\\\?\\C:\\candidate.lock", "stale_malformed"),
      /windows_stale_lock_reclaimer_unavailable/,
    );
    await assert.rejects(
      reclaimStaleLock(capability, "\\.\\C:\\candidate.lock", "stale_malformed"),
      /windows_stale_lock_reclaimer_unavailable/,
    );
    await assert.rejects(
      reclaimStaleLock(capability, "C:relative.lock", "stale_malformed"),
      /windows_stale_lock_reclaimer_unavailable/,
    );
    await assert.rejects(
      reclaimStaleLock(capability, "C:\\", "stale_malformed"),
      /windows_stale_lock_reclaimer_unavailable/,
    );
  }
});

test("source adapter never falls back to a repository helper pair", async () => {
  // This source module is not co-located with a published `native/` pair.
  // Production emission supplies that pair beside the emitted adapter; source
  // and test callers must mint the explicit build/test capability instead.
  assert.equal(await requestWindowsStaleLockReclaimer(), undefined);
});

// ---------------------------------------------------------------------------
// Published-pair provenance regressions (design/73). The production mint is
// Windows/x64-only; the mutation tests use deterministic fixture bytes that
// are never executed, so the fail-closed checks are exercised without a real
// helper. The positive control needs the exact built helper and reports
// BLOCKED when it is unavailable.
// ---------------------------------------------------------------------------

const publishedHelperFileName = "GameBuddy.WindowsStaleLockReclaimer.exe";
const publishedManifestFileName = "windows-stale-lock-reclaimer.manifest.json";
const publishedPairDestination = "native/windows-stale-lock-reclaimer/win-x64";
const publishedInventorySchema = "gamebuddy-host-production-inventory/v4";
const publishedOriginKind = "verified_windows_stale_lock_reclaimer";
const staleAgo = () => new Date(Date.now() - 6 * 60_000);

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
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-published-")));
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
      const capability = await createPublishedWindowsStaleLockReclaimer(fixture.root);
      assert.equal(reclaimerState(capability)?.executable, fixture.helperPath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }

    // Without the generation inventory the pair is not bound to a verified
    // Host-TCB deployment generation: the published capability is unavailable.
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-published-noinv-")));
    try {
      const pairRoot = resolve(root, ...publishedPairDestination.split("/"));
      await mkdir(pairRoot, { recursive: true });
      const helperBytes = Buffer.from("fixture-helper-bytes-v2", "utf8");
      const sha256 = createHash("sha256").update(helperBytes).digest("hex");
      await writeFile(resolve(pairRoot, publishedHelperFileName), helperBytes);
      await writeFile(resolve(pairRoot, publishedManifestFileName), fixtureCanonicalManifest(sha256), "utf8");
      await assert.rejects(createPublishedWindowsStaleLockReclaimer(root), /windows_stale_lock_reclaimer_unavailable/);
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
          createPublishedWindowsStaleLockReclaimer(fixture.root),
          /windows_stale_lock_reclaimer_unavailable/,
        );
      };
      await tamper((parsed) => {
        parsed.entries[0].sha256 = "0".repeat(64);
      });
      await tamper((parsed) => {
        parsed.entries[0].origin.kind = "typescript_emit";
      });
      await tamper((parsed) => {
        parsed.schema = "gamebuddy-host-production-inventory/v3";
      });
      await tamper((parsed) => {
        parsed.entries = parsed.entries.slice(0, 1);
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter fails closed on a pair-directory junction before mint and before spawn",
  { skip: process.platform !== "win32" },
  async (t) => {
    const fixture = await makePublishedPairFixture();
    const moved = resolve(fixture.root, "pair-moved");
    try {
      const capability = await createPublishedWindowsStaleLockReclaimer(fixture.root);
      // Replace the pair directory with a junction to a directory containing a
      // byte-identical pair: the physical ancestor proof must fail closed both
      // at mint and immediately before the next spawn.
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
        reclaimStaleLock(capability, resolve(fixture.root, "candidate.lock"), "stale_malformed"),
        /windows_stale_lock_reclaimer_unavailable/,
      );
      await assert.rejects(
        createPublishedWindowsStaleLockReclaimer(fixture.root),
        /windows_stale_lock_reclaimer_unavailable/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter revalidates the helper digest immediately before each spawn",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const capability = await createPublishedWindowsStaleLockReclaimer(fixture.root);
      // A helper replaced after mint must fail closed before the next spawn:
      // the capability never caches an unchecked pathname.
      await writeFile(fixture.helperPath, Buffer.from("replacement-helper-bytes", "utf8"));
      await assert.rejects(
        reclaimStaleLock(capability, resolve(fixture.root, "candidate.lock"), "stale_malformed"),
        /windows_stale_lock_reclaimer_unavailable/,
      );
      await assert.rejects(
        releaseOwnedLock(capability, resolve(fixture.root, "candidate.lock"), "00000000-0000-4000-8000-000000000000"),
        /windows_stale_lock_reclaimer_unavailable/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter revalidates the canonical manifest immediately before each spawn",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await makePublishedPairFixture();
    try {
      const capability = await createPublishedWindowsStaleLockReclaimer(fixture.root);
      const other = createHash("sha256").update("other-helper-bytes").digest("hex");
      await writeFile(fixture.manifestPath, fixtureCanonicalManifest(other), "utf8");
      await assert.rejects(
        reclaimStaleLock(capability, resolve(fixture.root, "candidate.lock"), "stale_malformed"),
        /windows_stale_lock_reclaimer_unavailable/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "published adapter reclaims a real stale lock through a verified emitted pair",
  { skip: process.platform !== "win32" },
  async (t) => {
    const hostRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const realHelper = resolve(
      hostRoot,
      "native",
      "windows-stale-lock-reclaimer",
      ".dist",
      "win-x64",
      publishedHelperFileName,
    );
    let helperState;
    try {
      helperState = await lstat(realHelper);
    } catch {
      t.skip("BLOCKED: exact helper publication is unavailable; published-pair positive control cannot be claimed");
      return;
    }
    if (!helperState.isFile() || helperState.isSymbolicLink()) {
      t.skip("BLOCKED: exact helper publication is unavailable; published-pair positive control cannot be claimed");
      return;
    }
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-published-real-")));
    try {
      const pairRoot = resolve(root, ...publishedPairDestination.split("/"));
      await mkdir(pairRoot, { recursive: true });
      const helperBytes = await readFile(realHelper);
      const sha256 = createHash("sha256").update(helperBytes).digest("hex");
      const manifest = fixtureCanonicalManifest(sha256);
      await writeFile(resolve(pairRoot, publishedHelperFileName), helperBytes);
      await writeFile(resolve(pairRoot, publishedManifestFileName), manifest, "utf8");
      await writeFile(
        resolve(root, "production-inventory.json"),
        fixtureInventory(sha256, createHash("sha256").update(manifest).digest("hex")),
        "utf8",
      );
      const capability = await createPublishedWindowsStaleLockReclaimer(root);
      const lockPath = resolve(root, "candidate.lock");
      await writeFile(lockPath, "stale crash residue", "utf8");
      await utimes(lockPath, staleAgo(), staleAgo());
      assert.equal(await reclaimStaleLock(capability, lockPath, "stale_malformed"), "reclaimed");
      await assert.rejects(lstat(lockPath), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("public policy entry does not expose test-only capability minting", async () => {
  const source = await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "src", "windows-stale-lock-reclaimer", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /__testOnly|test-support/);
});

function syntheticChild(outcome: string, requests: string[] = []): ChildProcess {
  if (outcome === "unavailable") throw new Error("spawn unavailable");
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      if (outcome === "timeout") queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    },
  });
  child.stdin.on("data", (chunk) => {
    if (outcome === "timeout") return;
    requests.push(chunk.toString("utf8"));
    if (outcome === "overflow") child.stdout.end(Buffer.alloc(64 * 1024 + 1));
    else if (outcome === "malformed") child.stdout.end('{"schemaVersion":1,"result":"other"}\n');
    else child.stdout.end(responseLine(outcome));
    if (outcome === "stderr") child.stderr.end("unexpected");
    else child.stderr.end();
    queueMicrotask(() => child.emit("close", outcome === "nonzero" ? 1 : 0, null));
  });
  return child as unknown as ChildProcess;
}
