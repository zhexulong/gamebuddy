import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHORS,
  actionContractAuthorityHash,
  assertContainedNoReparse,
  assertNoReparseAncestors,
  assertNoReparsePoint,
  BLOCKER_CODE,
  configurationDigest,
  derive,
  NON_CLAIM,
  OPTIONS,
  readContainedFile,
  resolveLockedToolPath,
  TARGET_LENGTH,
  TARGET_SHA256,
  TOOL_CLOSURE_SHA256,
  TOOL_LAUNCHER_RELATIVE_PATH,
  TOOL_LAUNCHER_SHA256,
  TOOL_PAYLOAD_RELATIVE_PATH,
  TOOL_VERSION,
  validate,
  verifySnapshot,
  verifyToolClosure,
  writeVerifiedAtomicJson,
} from "./lib/stardew-portfolio-m10-donate-museum-source-boundary.mjs";

const contract = await readFile("tools/stardew-portfolio-m10-museum-action-contract.json");
const contractHash = actionContractAuthorityHash(contract);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function state() {
  const buffers = {};
  for (const [, relativePath, needle] of ANCHORS)
    buffers[relativePath] = Buffer.from(`${buffers[relativePath]?.toString() || "prefix\n"}${needle}\nsuffix\n`);
  const files = Object.entries(buffers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, buffer]) => ({ relativePath, lengthBytes: buffer.length, sha256: digest(buffer) }));
  return { files, buffers };
}
function model() {
  const sources = state();
  return derive(
    { lengthBytes: TARGET_LENGTH, sha256: TARGET_SHA256 },
    sources,
    contractHash,
    "2026-03-18T00:00:00.000Z",
  );
}
test("M10 boundary accepts only the exact blocked target conclusion", () => {
  const sources = state(),
    result = validate(model(), contractHash, sources, "/decompile");
  assert.equal(result.blockerCode, BLOCKER_CODE);
  assert.equal(result.primitiveSourceRealizationStatus, "blocked");
});
test("M10 boundary rejects target, pinned tool closure, unknown-field, and anchor drift", () => {
  const sources = state();
  const target = model();
  target.target.sha256 = "0".repeat(64);
  assert.throws(() => validate(target, contractHash, sources, "/decompile"), { code: "target_drift" });
  const tool = model();
  tool.decompilation.closureSha256 = "0".repeat(64);
  assert.throws(() => validate(tool, contractHash, sources, "/decompile"), { code: "decompile_config_drift" });
  const unknown = model();
  unknown.unapproved = true;
  assert.throws(() => validate(unknown, contractHash, sources, "/decompile"), { code: "schema_invalid" });
  const anchor = model();
  anchor.anchors[2].needle = "other";
  assert.throws(() => validate(anchor, contractHash, sources, "/decompile"), { code: "anchor_drift" });
});
test("M10 boundary rejects a deleted unanchored source file from the complete manifest", () => {
  const sources = state(),
    candidate = model();
  candidate.sourceManifest.files.pop();
  candidate.sourceManifest.fileCount--;
  candidate.sourceManifest.sha256 = digest(
    `${candidate.sourceManifest.files
      .map((file) => `${file.relativePath}\t${file.lengthBytes}\t${file.sha256}`)
      .join("\n")}\n`,
  );
  assert.throws(() => validate(candidate, contractHash, sources, "/decompile"), { code: "source_manifest_incomplete" });
});
test("M10 boundary rejects completed claims and source mutation", () => {
  const sources = state();
  const completed = model();
  completed.conclusion.primitiveSourceRealizationStatus = "realized";
  assert.throws(() => validate(completed, contractHash, sources, "/decompile"), { code: "unsupported_claim" });
  const changed = state(),
    anchor = model().anchors[3];
  changed.buffers[anchor.relativePath] = Buffer.from(
    changed.buffers[anchor.relativePath].toString().replace(anchor.needle, "museum.museumPieces.Remove(x);"),
  );
  assert.throws(() => validate(model(), contractHash, changed, "/decompile"), { code: "source_drift" });
});
test("M10 ignores ILSPYCMD_PATH and pins launcher plus payload closure", () => {
  const forged = "C:/attacker/ilspycmd.exe",
    prior = process.env.ILSPYCMD_PATH;
  process.env.ILSPYCMD_PATH = forged;
  try {
    assert.equal(
      resolveLockedToolPath("C:/Users/example"),
      path.join("C:/Users/example", ...TOOL_LAUNCHER_RELATIVE_PATH.split("/")),
    );
    assert.notEqual(resolveLockedToolPath("C:/Users/example"), forged);
    assert.throws(
      () => verifyToolClosure([{ relativePath: "launcher/ilspycmd.exe", lengthBytes: 1, sha256: "0".repeat(64) }]),
      { code: "tool_closure_drift" },
    );
  } finally {
    if (prior === undefined) delete process.env.ILSPYCMD_PATH;
    else process.env.ILSPYCMD_PATH = prior;
  }
});
test("M10 Windows reparse helper rejects every FileAttributes ReparsePoint result and query ambiguity", async () => {
  const normal = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
  const options = {
    platform: "win32",
    lstatPath: async () => normal,
    statPath: async () => normal,
    execPath: async () => ({ stdout: "false\n" }),
  };
  await assert.doesNotReject(() => assertNoReparsePoint("C:\\safe\\file", options));
  await assert.rejects(
    () => assertNoReparsePoint("C:\\junction", { ...options, execPath: async () => ({ stdout: "true\n" }) }),
    { code: "reparse_point_detected" },
  );
  await assert.rejects(
    () => assertNoReparsePoint("C:\\unknown", { ...options, execPath: async () => ({ stdout: "unknown\n" }) }),
    { code: "reparse_point_detected" },
  );
  await assert.rejects(
    () =>
      assertNoReparsePoint("C:\\query-error", {
        ...options,
        execPath: async () => {
          throw new Error("denied");
        },
      }),
    { code: "reparse_point_detected" },
  );
});
test("M10 snapshot verification rejects changed bytes, replaced identity, and reparse paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-m10-snapshot-test-")),
    snapshot = path.join(root, "Stardew Valley.dll"),
    replacement = path.join(root, "replacement.dll"),
    link = path.join(root, "linked.dll");
  try {
    await writeFile(snapshot, Buffer.alloc(TARGET_LENGTH));
    const info = await lstat(snapshot),
      target = {
        path: snapshot,
        snapshotRoot: root,
        lengthBytes: TARGET_LENGTH,
        sha256: TARGET_SHA256,
        identity: `${info.dev}:${info.ino}:${info.size}:${info.nlink}`,
      };
    await assert.rejects(() => verifySnapshot(target), { code: "target_hash_mismatch" });
    await rm(snapshot);
    await writeFile(snapshot, Buffer.alloc(TARGET_LENGTH));
    await writeFile(replacement, Buffer.alloc(TARGET_LENGTH));
    await assert.rejects(() => verifySnapshot(target), { code: "target_snapshot_identity_drift" });
    try {
      await symlink(replacement, link);
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      return;
    }
    const linkInfo = await lstat(link);
    await assert.rejects(
      () =>
        verifySnapshot({
          ...target,
          path: link,
          identity: `${linkInfo.dev}:${linkInfo.ino}:${linkInfo.size}:${linkInfo.nlink}`,
        }),
      { code: "snapshot_reparse_detected" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("M10 constants and generated dossier lock launcher and resolved tool closure", async () => {
  assert.equal(TARGET_LENGTH, 6268416);
  assert.equal(TARGET_SHA256, "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee");
  assert.deepEqual(OPTIONS, ["--disable-updatecheck", "-p", "--nested-directories"]);
  assert.equal(TOOL_VERSION, "ilspycmd: 9.1.0.7988");
  assert.equal(TOOL_LAUNCHER_SHA256, "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f");
  assert.equal(TOOL_LAUNCHER_RELATIVE_PATH, ".dotnet/tools/ilspycmd.exe");
  assert.equal(
    TOOL_PAYLOAD_RELATIVE_PATH,
    ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any",
  );
  assert.equal(TOOL_CLOSURE_SHA256, "660c68db0da4f412c3294728453654fe9714c0ee19748bea94031bf57fd0c166");
  assert.equal(typeof configurationDigest, "string");
  assert.equal(model().conclusion.nonClaim, NON_CLAIM);
  const generated = JSON.parse(
    await readFile("tools/stardew-portfolio-m10-donate-museum-source-boundary.json", "utf8"),
  );
  assert.deepEqual(generated.decompilation, {
    tool: "ilspycmd",
    toolVersion: TOOL_VERSION,
    launcherInstallRelativePath: TOOL_LAUNCHER_RELATIVE_PATH,
    launcherSha256: TOOL_LAUNCHER_SHA256,
    payloadInstallRelativePath: TOOL_PAYLOAD_RELATIVE_PATH,
    closureSha256: TOOL_CLOSURE_SHA256,
    options: OPTIONS,
    configurationDigest,
  });
  assert.equal(generated.conclusion.nonClaim, NON_CLAIM);
});

test("M10 ancestor and containment helpers reject reparse ancestors and revalidate reads", async () => {
  const safe = path.resolve("safe"),
    file = path.join(safe, "file"),
    root = path.parse(safe).root;
  const normal = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
  const directory = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
  const seen = [];
  const lstatPath = async (candidate) => {
    seen.push(candidate);
    return candidate === root || candidate === safe ? directory : normal;
  };
  const options = { platform: "linux", lstatPath, statPath: lstatPath };
  await assertNoReparseAncestors(file, options);
  assert.ok(seen.length >= 3, "must inspect root, ancestor, and target");
  await assert.rejects(() => assertContainedNoReparse(safe, path.resolve("other/file"), options), {
    code: "path_escape",
  });
  await assert.rejects(
    () =>
      assertNoReparseAncestors(file, {
        ...options,
        lstatPath: async (candidate) =>
          candidate === safe ? { ...directory, isSymbolicLink: () => true } : lstatPath(candidate),
      }),
    { code: "reparse_point_detected" },
  );
  let checks = 0;
  await readContainedFile(safe, file, {
    ...options,
    readFilePath: async () => Buffer.from("safe"),
    lstatPath: async (candidate) => {
      checks++;
      return lstatPath(candidate);
    },
    statPath: lstatPath,
  });
  assert.ok(checks >= 6, "read containment must check before and after reading");
});
test("M10 contained read rejects replacement identity and double-read content races", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-m10-contained-read-"));
  const candidate = path.join(root, "input.txt"),
    replacement = path.join(root, "replacement.txt");
  try {
    await writeFile(candidate, "before");
    await writeFile(replacement, "after");
    let calls = 0;
    await assert.rejects(
      () =>
        readContainedFile(root, candidate, {
          readFilePath: async (file) => {
            const value = await readFile(file);
            if (++calls === 1) await rm(file).then(() => writeFile(file, "after"));
            return value;
          },
        }),
      { code: "contained_file_identity_drift" },
    );
    await writeFile(candidate, "stable");
    calls = 0;
    await assert.rejects(
      () =>
        readContainedFile(root, candidate, {
          readFilePath: async () => Buffer.from(++calls === 1 ? "first" : "second"),
        }),
      { code: "contained_file_content_drift" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("M10 verified artifact write rejects a reparse parent and validates temporary/final paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gb-m10-output-test-"));
  try {
    const output = path.join(directory, "artifact.json");
    await writeVerifiedAtomicJson(output, { state: "blocked" });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { state: "blocked" });
    await assert.rejects(
      () =>
        writeVerifiedAtomicJson(
          path.join(directory, "blocked.json"),
          {},
          {
            writeFilePath: async () => {
              throw Object.assign(new Error("reparse"), { code: "artifact_output_reparse_detected" });
            },
          },
        ),
      { code: "artifact_output_reparse_detected" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
