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
  rid,
} from "./build-windows-stale-lock-reclaimer.mjs";

const helperPath = resolve(outputRoot, helperFileName);
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
    await assertResult(reclaimRequest(freshValid, "stale_valid_dead"), "kept_valid_fresh");
    assert.equal(await readFile(freshValid, "utf8"), freshValidOwner);
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
      assert.equal(error?.code === "EPERM" || error?.code === "EACCES", true);
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
 * publish again; the caller is responsible for restoring it. A fresh
 * publication reserves a previously absent output with exclusive creation, so
 * leaving an empty directory behind is itself a rejected pre-existing object. */
async function movePairAside(aside) {
  await rm(aside, { recursive: true, force: true });
  await rename(outputRoot, aside);
}

test("production builder rejects an output-root junction before publish and preserves the external sentinel", { skip: process.platform !== "win32" }, async (t) => {
  const parent = resolve(outputRoot, "..");
  const aside = resolve(parent, ".build-test-junction-aside");
  const target = resolve(parent, ".build-test-junction-target");
  let moved = false;
  try {
    const state = await lstat(outputRoot).catch(() => undefined);
    if (state !== undefined) {
      await rm(aside, { recursive: true, force: true });
      await rename(outputRoot, aside);
      moved = true;
    } else {
      await mkdir(parent, { recursive: true });
    }
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
    // The chain preflight must reject the linked output root before any dotnet
    // publish can run, without touching the junction target.
    await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
    assert.equal(await readFile(sentinel, "utf8"), "sentinel must survive");
    assert.equal((await lstat(outputRoot)).isSymbolicLink(), true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    if (moved) await rename(aside, outputRoot);
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("production builder fails closed on an incomplete published pair without mutating it", { skip: process.platform !== "win32" }, async (t) => {
  const parent = resolve(outputRoot, "..");
  const aside = resolve(parent, ".build-test-incomplete-aside");
  let moved = false;
  try {
    const state = await lstat(outputRoot).catch(() => undefined);
    if (state !== undefined) {
      await rm(aside, { recursive: true, force: true });
      await rename(outputRoot, aside);
      moved = true;
    } else {
      await mkdir(parent, { recursive: true });
    }
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
  } finally {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    if (moved) await rename(aside, outputRoot);
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("production builder rejects a pre-existing empty output root without publishing into it", { skip: process.platform !== "win32" }, async (t) => {
  const parent = resolve(outputRoot, "..");
  const aside = resolve(parent, ".build-test-empty-aside");
  let moved = false;
  try {
    const state = await lstat(outputRoot).catch(() => undefined);
    if (state !== undefined) {
      await rm(aside, { recursive: true, force: true });
      await rename(outputRoot, aside);
      moved = true;
    } else {
      await mkdir(parent, { recursive: true });
    }
    // A fresh publication reserves a previously absent output using exclusive
    // creation; a pre-existing object of any kind (even an empty directory)
    // fails closed without being adopted, emptied, or overwritten.
    await mkdir(outputRoot);
    await assert.rejects(buildWindowsStaleLockReclaimer(), /windows_stale_lock_reclaimer_output_unsafe/);
    assert.equal((await lstat(outputRoot)).isDirectory(), true);
    assert.deepEqual(await readdir(outputRoot), []);
  } finally {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    if (moved) await rename(aside, outputRoot);
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("production builder rejects a replaced manifest and never overwrites existing output objects", { skip: process.platform !== "win32" }, async (t) => {
  const parent = resolve(outputRoot, "..");
  const aside = resolve(parent, ".build-test-replaced-manifest-aside");
  let moved = false;
  try {
    const state = await lstat(outputRoot).catch(() => undefined);
    if (state !== undefined) {
      await rm(aside, { recursive: true, force: true });
      await rename(outputRoot, aside);
      moved = true;
    } else {
      await mkdir(parent, { recursive: true });
    }
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
  } finally {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    if (moved) await rename(aside, outputRoot);
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("production builder uses the globally locked SDK, reuses a verified pair, and repeated publish is hash reproducible", { skip: process.platform !== "win32" }, async (t) => {
  // The production API intentionally accepts neither a dotnet path nor spawn injection.
  // An SDK drift is a blocked reproducibility result, not permission to publish with a different SDK.
  const initialAside = resolve(outputRoot, "..", ".build-test-repro-initial-aside");
  const firstAside = resolve(outputRoot, "..", ".build-test-repro-first-aside");
  try {
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
    await rm(firstAside, { recursive: true, force: true }).catch(() => undefined);
    await rm(initialAside, { recursive: true, force: true }).catch(() => undefined);
  }
});
