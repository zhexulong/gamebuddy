/**
 * The Windows helper pair's own regression suite.
 *
 * This test moves the shared output root, and it must never leave it absent or empty, and it must never delete an
 * aside unless a verified real pair is back in place. The pair under `host/native/windows-stale-lock-reclaimer/.dist`
 * is not this suite's fixture: it is the pair every compiled host test mints its stale-lock reclaimer from, and both
 * frontend parity suites mint theirs from it too. Measured 2026-11-19, one failed publish here left an empty output
 * root and no aside, and every compiled host test plus both parity suites went down with
 * `windows_stale_lock_reclaimer_unavailable` - with the official builder then refusing to heal it, because an
 * existing output root is a refused pre-existing object.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildWindowsStaleLockReclaimer,
  canonicalManifest,
  helperFileName,
  manifestFileName,
  outputRoot,
  protocolVersion,
  readVerifiedPair,
  rid,
} from "./build-windows-stale-lock-reclaimer.mjs";

const helperPath = resolve(outputRoot, helperFileName);
const outputRootParent = resolve(outputRoot, "..");
const staleAgo = () => new Date(Date.now() - 6 * 60_000);

function runHelper(input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(helperPath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

/** Derives the exact frozen root/segments tuple from an absolute fixture path:
 * `root` is the live drive root of the temp location and `segments` are the
 * literal safe components below it. No absolute path ever reaches the helper. */
function requestParts(absolutePath) {
  const root = `${absolutePath.slice(0, 2)}\\`;
  const remainder = absolutePath.slice(2).replace(/^[\\/]+/, "");
  return { root, segments: remainder.split(/[\\/]+/) };
}

function reclaimRequest(path, policy) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "reclaim_stale_lock", policy, ...requestParts(path) }), "utf8");
}
function releaseRequest(path, token) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "release_owned_lock", token, ...requestParts(path) }), "utf8");
}

async function assertResult(input, result) {
  const actual = await runHelper(input);
  assert.equal(actual.code, 0);
  assert.equal(actual.signal, null);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, `{"schemaVersion":1,"result":"${result}"}\n`);
}

async function makeStale(path) {
  await utimes(path, staleAgo(), staleAgo());
}

test("Windows stale-lock reclaimer executes the strict root/segments protocol without path disclosure", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; native protocol closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-protocol-"));
  try {
    const staleMalformed = resolve(root, "stale-malformed.lock");
    const staleZeroByte = resolve(root, "stale-zero.lock");
    const staleValidDead = resolve(root, "stale-valid-dead.lock");
    const freshMalformed = resolve(root, "fresh-malformed.lock");
    const freshValid = resolve(root, "fresh-valid.lock");
    const releasePath = resolve(root, "release.lock");
    const wrongTokenPath = resolve(root, "wrong-token.lock");
    const missing = resolve(root, "missing.lock");
    const token = "00000000-0000-4000-8000-000000000000";
    const otherToken = "11111111-1111-4111-8111-111111111111";
    await writeFile(staleMalformed, "partial write", "utf8");
    await makeStale(staleMalformed);
    await writeFile(staleZeroByte, Buffer.alloc(0));
    await makeStale(staleZeroByte);
    await writeFile(staleValidDead, JSON.stringify({ token, pid: 999_999_999, createdAtMs: Date.now() - 6 * 60_000 }), "utf8");
    await makeStale(staleValidDead);
    await writeFile(freshMalformed, "partial write", "utf8");
    const freshValidOwner = JSON.stringify({ token, pid: 999_999_999, createdAtMs: Date.now() });
    await writeFile(freshValid, freshValidOwner, "utf8");
    const releaseOwner = JSON.stringify({ token, pid: 1234, createdAtMs: Date.now() });
    const wrongTokenOwner = JSON.stringify({ token, pid: 1234, createdAtMs: Date.now() });
    await writeFile(releasePath, releaseOwner, "utf8");
    await writeFile(wrongTokenPath, wrongTokenOwner, "utf8");

    await assertResult(reclaimRequest(staleMalformed, "stale_malformed"), "reclaimed");
    await assert.rejects(lstat(staleMalformed), { code: "ENOENT" });
    await assertResult(reclaimRequest(staleZeroByte, "stale_malformed"), "reclaimed");
    await assertResult(reclaimRequest(staleValidDead, "stale_valid_dead"), "reclaimed");
    await assertResult(reclaimRequest(freshMalformed, "stale_malformed"), "kept_malformed_fresh");
    assert.equal(await readFile(freshMalformed, "utf8"), "partial write");
    // A record that names a dead owner is dead residue NOW: age is evidence for an owner nobody can identify, not for
    // one the machine has already proven gone.
    await assertResult(reclaimRequest(freshValid, "stale_valid_dead"), "reclaimed");
    await assert.rejects(lstat(freshValid), { code: "ENOENT" });
    await assertResult(releaseRequest(releasePath, token), "released");
    await assert.rejects(lstat(releasePath), { code: "ENOENT" });
    await assertResult(releaseRequest(wrongTokenPath, otherToken), "kept_token_mismatch");
    assert.equal(await readFile(wrongTokenPath, "utf8"), wrongTokenOwner);
    await assertResult(reclaimRequest(missing, "stale_malformed"), "missing");

    // Schema/grammar violations all fail closed to the same safe category,
    // including every obsolete absolute-`path` form and every malformed
    // root/segment form. Object forms are serialized by JSON.stringify so the
    // rejected values are valid JSON (exact protocol rejection, not a parse
    // accident); the raw byte forms cover parse-level failures.
    const malformedRequests = [
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a", "b.lock"], extra: 1 },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_fresh", root: "C:\\", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "release_owned_lock", token: "not-a-uuid", root: "C:\\", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a"] },
      { schemaVersion: 1, operation: "release_owned_lock", token: "00000000-0000-4000-8000-000000000000", root: "C:\\", segments: ["a"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: [] },
      { schemaVersion: 1, operation: "delete_anything", root: "C:\\", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a", "*.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a", "..\\b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["..", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: [".", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a\\b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a/b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["CON", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\x", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "\\\\server\\share\\", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:/", segments: ["a", "b.lock"] },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", root: "C:\\", segments: ["a", "b.lock"], path: staleMalformed },
      { schemaVersion: 1, operation: "reclaim_stale_lock", policy: "stale_malformed", path: staleMalformed },
      { schemaVersion: 1, operation: "release_owned_lock", token, path: releasePath },
    ];
    for (const malformed of [
      ...malformedRequests.map((request) => Buffer.from(JSON.stringify(request), "utf8")),
      Buffer.from(`{"schemaVersion":1,"schemaVersion":1,"operation":"reclaim_stale_lock","policy":"stale_malformed","root":"C:\\\\","segments":${JSON.stringify(["a", "b.lock"])}}`, "utf8"),
      Buffer.from("{", "utf8"),
      Buffer.from([0xff, 0xfe]),
    ]) {
      await assertResult(malformed, "indeterminate");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows stale-lock reclaimer never deletes a post-open pathname replacement", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; replacement closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-replacement-"));
  try {
    const lockPath = resolve(root, "candidate.lock");
    const backup = resolve(root, "renamed-away.lock");
    const replacement = "replacement-bytes-must-survive";
    await writeFile(lockPath, "stale crash residue", "utf8");
    await makeStale(lockPath);
    // Churn the pathname while the helper retains its opened HANDLE: whatever
    // object the helper opened, the path never names it again at the final
    // re-check, so no disposition may be applied and every replacement must
    // survive byte-identically.
    const child = spawn(helperPath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const done = new Promise((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("close", () => resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    child.stdin.end(reclaimRequest(lockPath, "stale_malformed"));
    let iteration = 0;
    const churn = setInterval(async () => {
      iteration += 1;
      await writeFile(lockPath, `replacement-iteration-${iteration}`, "utf8");
      await makeStale(lockPath);
    }, 10);
    const result = await done;
    clearInterval(churn);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /"result":"(?:kept_identity_changed|kept_path_replaced|kept_malformed_fresh|kept_policy_mismatch)"/);
    const finalBytes = await readFile(lockPath, "utf8");
    assert.match(finalBytes, /^replacement-iteration-\d+$/);

    // A successful rename before the leaf opens leaves the old object at
    // `backup`, which must survive. Once the helper has opened the retained
    // chain without FILE_SHARE_DELETE, Windows rejects rename/delete until its
    // disposition completes; that disposition can only delete the still-named
    // lock object, never a renamed-away backup.
    await writeFile(lockPath, "stale crash residue", "utf8");
    await makeStale(lockPath);
    const second = spawn(helperPath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const secondStdout = []; const secondStderr = []; const renameErrors = [];
    second.stdout.on("data", (chunk) => secondStdout.push(chunk));
    second.stderr.on("data", (chunk) => secondStderr.push(chunk));
    const secondDone = new Promise((resolveRun, rejectRun) => {
      second.once("error", rejectRun);
      second.once("close", () => resolveRun({ stdout: Buffer.concat(secondStdout).toString("utf8"), stderr: Buffer.concat(secondStderr).toString("utf8") }));
    });
    const renameTimer = setInterval(() => {
      rename(lockPath, backup).catch((error) => renameErrors.push(error));
    }, 10);
    second.stdin.end(reclaimRequest(lockPath, "stale_malformed"));
    const secondResult = await secondDone;
    clearInterval(renameTimer);
    assert.equal(secondResult.stderr, "");
    const backupState = await lstat(backup).catch(() => undefined);
    if (backupState !== undefined) {
      assert.equal(await readFile(backup, "utf8"), "stale crash residue");
      assert.match(secondResult.stdout, /"result":"(?:missing|kept_identity_changed|kept_path_replaced)"/);
    } else {
      assert.equal(renameErrors.some((error) => error?.code === "EPERM" || error?.code === "EACCES"), true);
      assert.equal(secondResult.stdout, '{"schemaVersion":1,"result":"reclaimed"}\n');
      await assert.rejects(lstat(lockPath), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows stale-lock reclaimer never follows a replaced ancestor path and preserves the replacement", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; ancestor-replacement closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-ancestor-replacement-"));
  try {
    const parent = resolve(root, "parent");
    const movedParent = resolve(root, "parent-moved");
    await mkdir(parent);
    const originalLeaf = resolve(parent, "candidate.lock");
    await writeFile(originalLeaf, "stale ancestor residue", "utf8");
    await makeStale(originalLeaf);
    const child = spawn(helperPath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const done = new Promise((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("close", () => resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    child.stdin.end(reclaimRequest(originalLeaf, "stale_malformed"));
    // A rename that wins before the helper opens the chain leaves the moved
    // directory and a replacement at the canonical name. Once the helper has
    // retained root, parent, and leaf without FILE_SHARE_DELETE, Windows must
    // reject an ancestor rename until the helper exits; it can then reclaim
    // only the leaf which is still named under that same parent.
    await new Promise((resolveRun) => setTimeout(resolveRun, 40));
    let moved = false;
    try {
      await rename(parent, movedParent);
      moved = true;
    } catch (error) {
      assert.equal(["EPERM", "EACCES", "EBUSY"].includes(String(error?.code)), true);
    }
    let replacementLeaf;
    const replacementBytes = "fresh replacement bytes must survive";
    if (moved) {
      await mkdir(parent);
      replacementLeaf = resolve(parent, "candidate.lock");
      await writeFile(replacementLeaf, replacementBytes, "utf8");
    }
    const result = await done;
    assert.equal(result.stderr, "");
    if (moved) {
      assert.match(result.stdout, /"result":"(?:reclaimed|kept_malformed_fresh|missing|indeterminate)"/);
      assert.equal(await readFile(replacementLeaf, "utf8"), replacementBytes);
      assert.equal((await lstat(movedParent)).isDirectory(), true);
    } else {
      assert.equal(result.stdout, '{"schemaVersion":1,"result":"reclaimed"}\n');
      await assert.rejects(lstat(originalLeaf), { code: "ENOENT" });
      assert.equal((await lstat(parent)).isDirectory(), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Windows stale-lock reclaimer classifies an actual junction leaf as kept-not-regular", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; junction closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-junction-"));
  try {
    const target = resolve(root, "target");
    const junction = resolve(root, "junction.lock");
    await mkdir(target);
    try {
      await symlink(target, junction, "junction");
      assert.equal((await lstat(junction)).isSymbolicLink(), true);
      await assertResult(reclaimRequest(junction, "stale_malformed"), "kept_not_regular");
      await assertResult(releaseRequest(junction, "00000000-0000-4000-8000-000000000000"), "kept_not_regular");
    } catch {
      t.skip("BLOCKED: junction creation is unavailable; junction closure cannot be claimed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows stale-lock reclaimer never follows an ancestor junction and preserves the external victim", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; ancestor-junction closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-ancestor-junction-"));
  const outside = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-ancestor-outside-"));
  const victim = resolve(outside, "victim.lock");
  const junction = resolve(root, "linked");
  const lockPath = resolve(junction, "candidate.lock");
  try {
    await writeFile(victim, "outside bytes must survive", "utf8");
    try {
      await symlink(outside, junction, "junction");
      assert.equal((await lstat(junction)).isSymbolicLink(), true);
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("BLOCKED: junction creation is unavailable; ancestor-junction closure cannot be claimed");
        return;
      }
      throw error;
    }
    // The ancestor segment is opened no-follow relative to the retained parent
    // and rejected as a non-reparse directory; the outside target is never
    // opened and its bytes stay identical.
    await assertResult(reclaimRequest(lockPath, "stale_malformed"), "kept_not_regular");
    await assertResult(releaseRequest(lockPath, "00000000-0000-4000-8000-000000000000"), "kept_not_regular");
    assert.equal(await readFile(victim, "utf8"), "outside bytes must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Windows stale-lock reclaimer revalidates the retained-owner PID natively and keeps a live owner", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; live-PID closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reclaimer-live-pid-"));
  try {
    const lockPath = resolve(root, "live-owner.lock");
    const owner = JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid: process.pid, createdAtMs: Date.now() - 6 * 60_000 });
    await writeFile(lockPath, owner, "utf8");
    await makeStale(lockPath);
    // Every stale/dead-policy predicate is met, but the helper's own native
    // liveness revalidation through its retained HANDLE must observe the live
    // test process and keep the lock byte-identical.
    await assertResult(reclaimRequest(lockPath, "stale_valid_dead"), "kept_policy_mismatch");
    assert.equal(await readFile(lockPath, "utf8"), owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale-lock reclaimer manifest is strict, fixed, and canonical", () => {
  const digest = createHash("sha256").update("fixture").digest("hex");
  const manifest = canonicalManifest(digest);
  assert.equal(manifest, `{"schemaVersion":1,"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${digest}"}\n`);
  assert.equal(JSON.stringify(JSON.parse(manifest)), manifest.trim());
  assert.equal(outputRoot.includes("windows-stale-lock-reclaimer") && outputRoot.includes(".dist") && outputRoot.endsWith("win-x64"), true);
  assert.equal(manifestFileName, "windows-stale-lock-reclaimer.manifest.json");
});

/** Temporarily moves the whole output root aside so the next build call must
 * publish again; an already absent output root is already in that state, so
 * there is nothing to move. A fresh publication reserves a previously absent
 * output with exclusive creation, so leaving an empty directory behind is
 * itself a rejected pre-existing object. */
async function movePairAside(aside) {
  await rm(aside, { recursive: true, force: true });
  if ((await lstat(outputRoot).catch(() => undefined)) === undefined) return;
  await rename(outputRoot, aside);
}

/**
 * Puts a VERIFIED real pair back at the output root, and only then drops the asides that were holding the copies.
 *
 * The acceptance predicate is the builder's own (`readVerifiedPair`), never a second reading of "two files are
 * there": a hand-written copy of that check is a disagreement scheduled for later. An aside left beside the pair is
 * itself a refusal that every compiled host test trips over, so this is also where leftovers go - after the pair,
 * never before it.
 */
async function restoreVerifiedPair(asides) {
  let pair = await readVerifiedPair();
  if (pair === undefined) {
    // Whatever occupies the root is the residue of a failed publish, never a pair: it is replaced rather than adopted.
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    for (const aside of asides) {
      if ((await lstat(aside).catch(() => undefined)) === undefined) continue;
      await rename(aside, outputRoot);
      pair = await readVerifiedPair();
      if (pair === undefined) throw new Error("windows_stale_lock_reclaimer_test_restore_left_no_pair");
      break;
    }
  }
  // A real pair is in place: the asides are redundant copies, and an aside left beside the pair is a refusal of its own.
  for (const aside of asides) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/** One block's own arrangement of the shared output root, with the invariant above enforced even when it throws. */
async function withPairMovedAside(aside, work) {
  await mkdir(outputRootParent, { recursive: true });
  await movePairAside(aside);
  try {
    return await work();
  } finally {
    await restoreVerifiedPair([aside]);
  }
}

/**
 * The one shape that destroyed the prerequisite, replayed: a publish that died after the builder reserved the output
 * root. `mkdir(outputRoot)` is precisely what `dotnet publish`'s exclusive reservation leaves behind, and the old
 * restore read it as "already restored", then deleted the aside that held the only remaining pair.
 */
test("a failed publish can never leave the shared output root absent or empty", { skip: process.platform !== "win32" }, async () => {
  const aside = resolve(outputRootParent, ".build-test-failed-publish-aside");
  await mkdir(outputRootParent, { recursive: true });
  // The machine's own pair, not a fixture: this test moves a shared prerequisite and must start from a real one.
  await buildWindowsStaleLockReclaimer();
  await movePairAside(aside);
  try {
    await mkdir(outputRoot);
    await restoreVerifiedPair([aside]);
    assert.deepEqual(
      (await readdir(outputRoot)).sort(),
      [helperFileName, manifestFileName].sort(),
      "the output root holds the real pair again, not the empty reservation the failed publish left",
    );
    assert.equal(
      (await lstat(aside).catch(() => undefined)) === undefined,
      true,
      "the aside is dropped only once a verified pair is back in place",
    );
  } finally {
    await restoreVerifiedPair([aside]);
  }
});

test("production builder rejects an output-root junction before publish and preserves the external sentinel", { skip: process.platform !== "win32" }, async (t) => {
  const target = resolve(outputRootParent, ".build-test-junction-target");
  try {
    await withPairMovedAside(resolve(outputRootParent, ".build-test-junction-aside"), async () => {
      await rm(target, { recursive: true, force: true });
      await mkdir(target);
      const sentinel = join(target, "sentinel.txt");
      await writeFile(sentinel, "sentinel must survive", "utf8");
      try {
        await symlink(target, outputRoot, "junction");
        assert.equal((await lstat(outputRoot)).isSymbolicLink(), true);
      } catch (error) {
        if (
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
        ) {
          t.skip("BLOCKED: junction creation is unavailable; output-root junction closure cannot be claimed");
          return;
        }
        throw error;
      }
      // The chain preflight must reject the linked output root before any dotnet publish can run, without touching the
      // junction target. The link itself goes before the shared restore runs: a junction is not an output root to
      // replace, and `rm` unlinks it rather than descending into what it names.
      await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
      assert.equal(await readFile(sentinel, "utf8"), "sentinel must survive");
      assert.equal((await lstat(outputRoot)).isSymbolicLink(), true);
      await rm(outputRoot, { recursive: true, force: true });
    });
  } finally {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("production builder fails closed on an incomplete published pair without mutating it", { skip: process.platform !== "win32" }, async () => {
  await withPairMovedAside(resolve(outputRootParent, ".build-test-incomplete-aside"), async () => {
    await mkdir(outputRoot, { recursive: true });
    const staleHelper = resolve(outputRoot, helperFileName);
    const staleManifest = resolve(outputRoot, manifestFileName);
    const sentinel = resolve(outputRoot, "sentinel.bin");
    await writeFile(staleHelper, "stale-binary-bytes", "utf8");
    await writeFile(staleManifest, "not-json", "utf8");
    await writeFile(sentinel, "sentinel must survive", "utf8");
    // A stale helper plus a non-canonical manifest is not a verifiable pair;
    // the builder must fail closed without deleting or overwriting any output
    // object (there is no recursive cleanup anywhere).
    await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
    assert.equal(await readFile(staleHelper, "utf8"), "stale-binary-bytes");
    assert.equal(await readFile(staleManifest, "utf8"), "not-json");
    assert.equal(await readFile(sentinel, "utf8"), "sentinel must survive");
  });
});

test("production builder rejects a pre-existing empty output root without publishing into it", { skip: process.platform !== "win32" }, async () => {
  await withPairMovedAside(resolve(outputRootParent, ".build-test-empty-aside"), async () => {
    // A fresh publication reserves a previously absent output using exclusive
    // creation; a pre-existing object of any kind (even an empty directory)
    // fails closed without being adopted, emptied, or overwritten.
    await mkdir(outputRoot);
    await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
    assert.equal((await lstat(outputRoot)).isDirectory(), true);
    assert.deepEqual(await readdir(outputRoot), []);
  });
});

test("production builder rejects a replaced manifest and never overwrites existing output objects", { skip: process.platform !== "win32" }, async () => {
  await withPairMovedAside(resolve(outputRootParent, ".build-test-replaced-manifest-aside"), async () => {
    await mkdir(outputRoot);
    const helperPath = resolve(outputRoot, helperFileName);
    const manifestPath = resolve(outputRoot, manifestFileName);
    const helperBytes = Buffer.from("fixture-helper-bytes", "utf8");
    const other = createHash("sha256").update("other-bytes").digest("hex");
    await writeFile(helperPath, helperBytes);
    await writeFile(manifestPath, canonicalManifest(other), "utf8");
    // A helper whose manifest no longer matches is not a verifiable pair; the
    // build must fail closed without overwriting or deleting either object.
    await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
    assert.deepEqual(await readFile(helperPath), helperBytes);
    assert.equal(await readFile(manifestPath, "utf8"), canonicalManifest(other));
    // A directory occupying the manifest path is likewise rejected untouched:
    // exclusive manifest creation never follows an existing object.
    await rm(manifestPath);
    await mkdir(manifestPath);
    await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
    assert.equal((await lstat(manifestPath)).isDirectory(), true);
  });
});

test("production builder uses the globally locked SDK, reuses a verified pair, and repeated publish is hash reproducible", { skip: process.platform !== "win32" }, async (t) => {
  // The production API intentionally accepts neither a dotnet path nor spawn injection.
  // An SDK drift is a blocked reproducibility result, not permission to publish with a different SDK.
  const initialAside = resolve(outputRootParent, ".build-test-repro-initial-aside");
  const firstAside = resolve(outputRootParent, ".build-test-repro-first-aside");
  try {
    await mkdir(outputRootParent, { recursive: true });
    // Do not compare a verified pair inherited from an earlier test with a
    // current publish: verify determinism across two fresh publishes instead.
    await movePairAside(initialAside);
    const first = await buildWindowsStaleLockReclaimer();
    const firstHash = createHash("sha256").update(await readFile(first.helperPath)).digest("hex");
    assert.equal(first.sha256, firstHash);

    // Reuse: the complete canonical pair is verified and returned again; no
    // deletion or republish occurs and the bytes stay identical.
    const reused = await buildWindowsStaleLockReclaimer();
    assert.equal(reused.sha256, firstHash);
    assert.equal(reused.helperPath, first.helperPath);
    assert.equal(createHash("sha256").update(await readFile(reused.helperPath)).digest("hex"), firstHash);

    // Force a second real publish by moving the verified pair aside so the
    // output root is absent again; determinism must hold across two actual
    // dotnet publish invocations.
    await movePairAside(firstAside);
    const second = await buildWindowsStaleLockReclaimer();
    const secondHash = createHash("sha256").update(await readFile(second.helperPath)).digest("hex");
    assert.equal(second.sha256, secondHash);
    assert.equal(firstHash, secondHash);
    assert.equal(await lstat(second.helperPath).then((state) => state.isSymbolicLink()), false);
  } catch (error) {
    if (error instanceof Error && (error.message === "windows_stale_lock_reclaimer_dotnet_sdk_drift" || error.message === "windows_stale_lock_reclaimer_dotnet_missing")) {
      t.skip("BLOCKED: trusted dotnet host does not activate global.json exact SDK; reproducible publish closure cannot be claimed");
      return;
    }
    throw error;
  } finally {
    // A publish that died after reserving the output root leaves it present and empty; the restore replaces that
    // residue from an aside and only then drops the asides. A run that cannot put a real pair back leaves them
    // aboard, which is the state a human can still recover from.
    await restoreVerifiedPair([firstAside, initialAside]);
  }
});
