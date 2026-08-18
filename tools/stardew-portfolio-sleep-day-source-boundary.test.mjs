import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHORS,
  BLOCKER_CODE,
  CANDIDATE_INGRESSES,
  ILSPY_EXECUTION_ENVIRONMENT_POLICY,
  NON_CLAIM,
  OPTIONS,
  PROHIBITIONS,
  TARGET_LENGTH,
  TARGET_SHA256,
  TOOL_PATH,
  TOOL_PAYLOAD_ROOT,
  TOOL_SHA256,
  TOOL_VERSION,
  TRUST_BOUNDARY,
  WINDOWS_SNAPSHOT_VALIDATOR_SOURCE,
  assertNoReparsePoint,
  assertPathBoundary,
  capturePathBoundary,
  checkedAtomicWrite,
  checkedReadFile,
  configurationDigest,
  ilspyExecutionEnvironment,
  methodSlice,
  validate,
  validateWindowsSnapshotAclFacts,
  windowsSnapshotValidatorEnvironment,
  windowsSnapshotValidatorInvocation,
} from "./lib/stardew-portfolio-sleep-day-source-boundary.mjs";
const exec = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (files) =>
  sha(files.map((file) => `${file.relativePath}\t${file.lengthBytes}\t${file.sha256}`).join("\n") + "\n");
function state() {
  const buffers = {};
  for (const [, relativePath, signature, required] of ANCHORS)
    buffers[relativePath] = Buffer.from(
      `${buffers[relativePath]?.toString() || ""}${signature}\n{\n${required.map((token) => `${token};`).join("\n")}\n}\n`,
    );
  const files = Object.entries(buffers)
    .map(([relativePath, bytes]) => ({ relativePath, lengthBytes: bytes.length, sha256: sha(bytes) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, buffers };
}
const payload = {
  files: [{ relativePath: "x", lengthBytes: 1, sha256: sha("x") }],
  sha256: digest([{ relativePath: "x", lengthBytes: 1, sha256: sha("x") }]),
};
function model() {
  const sources = state();
  return {
    schemaVersion: 3,
    artifactKind: "portfolio_sleep_day_source_boundary",
    attestationId: "portfolio_sleep_day_source_boundary_v3",
    extractedAtUtc: "2026-01-01T00:00:00.000Z",
    action: "single_player_sleep_and_advance_day",
    topology: "single_player_native_companion",
    target: {
      gameVersion: "1.6.15.24356",
      assembly: "Stardew Valley.dll",
      lengthBytes: TARGET_LENGTH,
      sha256: TARGET_SHA256,
    },
    decompilation: {
      tool: "ilspycmd",
      toolPath: TOOL_PATH,
      toolSha256: TOOL_SHA256,
      toolVersion: TOOL_VERSION,
      toolPayloadRoot: TOOL_PAYLOAD_ROOT,
      toolPayload: { fileCount: 1, ...payload },
      options: OPTIONS,
      executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY,
      configurationDigest,
    },
    trustBoundary: TRUST_BOUNDARY,
    sourceManifest: { fileCount: sources.files.length, sha256: digest(sources.files), files: sources.files },
    anchors: ANCHORS.map((definition) => {
      const bytes = sources.buffers[definition[1]],
        slice = methodSlice(bytes, definition[2]);
      return {
        anchorId: definition[0],
        relativePath: definition[1],
        methodSignature: definition[2],
        startByte: slice.startByte,
        endByte: slice.endByte,
        fileSha256: sha(bytes),
        methodSliceSha256: sha(slice.bytes),
        required: definition[3],
        forbidden: definition[4],
        semanticRole: definition[5],
      };
    }),
    candidateIngressClassification: CANDIDATE_INGRESSES.map((candidate) => ({ ...candidate })),
    prohibitions: [...PROHIBITIONS],
    conclusion: {
      attestationState: "blocked_attested",
      blockerCode: BLOCKER_CODE,
      approvedTypedNonUiIngress: "none",
      nonClaim: NON_CLAIM,
    },
  };
}
test("sleep/day direct boundary rejects every anchor, candidate, prohibition, target, and M9 artifact drift", () => {
  const sources = state();
  assert.equal(validate(model(), sources, payload).blockerCode, BLOCKER_CODE);
  for (let index = 0; index < ANCHORS.length; index++) {
    const candidate = model();
    candidate.anchors[index].methodSliceSha256 = "0".repeat(64);
    assert.throws(() => validate(candidate, sources, payload), { code: "anchor_drift" });
  }
  for (let index = 0; index < CANDIDATE_INGRESSES.length; index++) {
    const candidate = model();
    candidate.candidateIngressClassification[index] = {
      ...candidate.candidateIngressClassification[index],
      classification: "approved",
    };
    assert.throws(() => validate(candidate, sources, payload), { code: "candidate_universe_drift" });
  }
  for (let index = 0; index < PROHIBITIONS.length; index++) {
    const candidate = model();
    candidate.prohibitions.splice(index, 1);
    assert.throws(() => validate(candidate, sources, payload), { code: "prohibition_drift" });
  }
  const target = model();
  target.target.sha256 = "0".repeat(64);
  assert.throws(() => validate(target, sources, payload), { code: "target_drift" });
  const m9 = model();
  m9.attestationId = "portfolio_m9_accept_special_order_source_boundary_v1";
  m9.anchors = [{ anchorId: "ui_board_acceptance_transaction" }];
  assert.throws(() => validate(m9, sources, payload), { code: "schema_invalid" });
});
test("sleep/day boundary has a canonical non-claim and fails closed on its mutation", () => {
  const candidate = model();
  candidate.conclusion.nonClaim = `${NON_CLAIM} drift`;
  assert.throws(() => validate(candidate, state(), payload), { code: "conclusion_invalid" });
});
test("sleep/day boundary exact-shape validates its canonical trust boundary", () => {
  const value = model();
  assert.equal(validate(value, state(), payload).blockerCode, BLOCKER_CODE);
  for (const mutate of [
    (candidate) => {
      candidate.trustBoundary.localCheckerTcb[0] = "untrusted checker";
    },
    (candidate) => {
      candidate.trustBoundary.outsideLocalCheckerBoundary.push("invented external control");
    },
    (candidate) => {
      candidate.trustBoundary.unchecked = true;
    },
    (candidate) => {
      delete candidate.trustBoundary.outsideLocalCheckerBoundary;
    },
  ]) {
    const candidate = model();
    candidate.trustBoundary = structuredClone(candidate.trustBoundary);
    mutate(candidate);
    assert.throws(
      () => validate(candidate, state(), payload),
      (error) => error.code === "trust_boundary_drift" || error.code === "schema_invalid",
    );
  }
});
test("sleep/day Windows attribute queries use a bootstrap-validated PowerShell path", async () => {
  const source = await readFile("tools/lib/stardew-portfolio-sleep-day-source-boundary.mjs", "utf8"),
    attributes = source.slice(
      source.indexOf("async function windowsAttributes(file)"),
      source.indexOf("function tuple("),
    ),
    validated = source.slice(
      source.indexOf("async function validatedWindowsPowerShellPath"),
      source.indexOf("async function windowsAttributes(file)"),
    );
  assert.ok(
    attributes.startsWith("async function windowsAttributes(file)"),
    "windowsAttributes implementation must exist",
  );
  assert.match(attributes, /await validatedWindowsPowerShellPath\(\)/);
  assert.match(attributes, /exec\(powershellPath,/);
  assert.doesNotMatch(attributes, /path\.join\(systemRoot, "System32"/);
  assert.match(validated, /bootstrapNoLinkAncestors\(executable, reparseCode\)/);
  assert.match(validated, /GB_SLEEP_BOOTSTRAP_PATHS: JSON\.stringify\(ancestors\)/);
  assert.match(validated, /\(value & 0x400\) !== 0/);
});
test("sleep/day boundary rejects symlink and Windows ReparsePoint observations", async () => {
  const info = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
  await assert.rejects(
    assertNoReparsePoint("x", {
      platform: "win32",
      lstatPath: async () => info,
      statPath: async () => info,
      windowsAttributesOf: async () => 0x400,
    }),
    { code: "reparse_point_detected" },
  );
  for (const attributes of [NaN, Infinity, 1.5, "0"])
    await assert.rejects(
      assertNoReparsePoint("x", {
        platform: "win32",
        lstatPath: async () => info,
        statPath: async () => info,
        windowsAttributesOf: async () => attributes,
      }),
      { code: "reparse_point_detected" },
    );
  assert.deepEqual(ilspyExecutionEnvironment({ SystemRoot: "x", PATH: "hostile", DOTNET_ROOT: "hostile" }), {
    SystemRoot: "x",
  });
});
test("sleep/day Windows snapshot validator accepts only one explicit current-SID FullControl inherited-to-child ACE", () => {
  const rule = {
    sid: "S-1-5-21-42",
    accessType: "Allow",
    rights: 2032127,
    inheritanceFlags: 3,
    propagationFlags: 0,
    isInherited: false,
  };
  assert.deepEqual(validateWindowsSnapshotAclFacts({ currentSid: rule.sid, ownerSid: rule.sid, rules: [rule] }).rules, [
    rule,
  ]);
  for (const facts of [
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [rule, { ...rule, sid: "S-1-5-21-420" }] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [{ ...rule, sid: "S-1-5-21-420" }] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [{ ...rule, accessType: "Deny" }] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [{ ...rule, isInherited: true }] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [{ ...rule, inheritanceFlags: 0 }] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [{ ...rule, propagationFlags: 1 }] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [{ ...rule, injected: true }] },
    { currentSid: rule.sid, ownerSid: "S-1-5-21-420", rules: [rule] },
    { currentSid: rule.sid, ownerSid: rule.sid, rules: [rule], injected: true },
  ])
    assert.throws(() => validateWindowsSnapshotAclFacts(facts), { code: "snapshot_boundary_invalid" });
  assert.match(
    WINDOWS_SNAPSHOT_VALIDATOR_SOURCE,
    /GetAccessRules\(\$true,\$true,\[Security\.Principal\.SecurityIdentifier\]\)/,
  );
  assert.match(WINDOWS_SNAPSHOT_VALIDATOR_SOURCE, /\.User\.Value/);
  assert.doesNotMatch(WINDOWS_SNAPSHOT_VALIDATOR_SOURCE, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.doesNotMatch(WINDOWS_SNAPSHOT_VALIDATOR_SOURCE, /-match/);
  assert.doesNotMatch(WINDOWS_SNAPSHOT_VALIDATOR_SOURCE, /& icacls(?:\.exe)?\b/i);
});
test(
  "sleep/day Windows snapshot validator child probe uses production-sanitized environment and absolute paths",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gb-sleep-validator-probe-")),
      leaf = path.join(root, "Stardew Valley.dll");
    try {
      await writeFile(leaf, "probe");
      const invocation = await windowsSnapshotValidatorInvocation(root, leaf);
      const { stdout } = await exec(
        invocation.executable,
        ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
        { encoding: "utf8", env: invocation.options.env },
      );
      await exec(
        invocation.options.env.GB_SLEEP_ICACLS,
        [root, "/inheritance:r", "/grant:r", `*${stdout.trim()}:(OI)(CI)F`],
        { encoding: "utf8", env: ilspyExecutionEnvironment() },
      );
      const expectedEnvironment = windowsSnapshotValidatorEnvironment(
        root,
        leaf,
        invocation.options.env.GB_SLEEP_ICACLS,
      );
      assert.deepEqual(invocation.options.env, expectedEnvironment);
      assert.deepEqual(
        Object.keys(invocation.options.env).sort(),
        ["GB_SLEEP_FILE", "GB_SLEEP_ICACLS", "GB_SLEEP_ROOT", "SystemRoot", "WINDIR"]
          .filter((name) => expectedEnvironment[name])
          .sort(),
      );
      await exec(invocation.executable, invocation.args, invocation.options);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("sleep/day boundary revalidates accepted manifest/output leaves around reads and atomic replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-sleep-boundary-test-")),
    leaf = path.join(root, "leaf.json");
  try {
    await checkedAtomicWrite(leaf, "first", "test_path_invalid");
    assert.equal(await checkedReadFile(leaf, "test_path_invalid", "utf8"), "first");
    await checkedAtomicWrite(leaf, "second", "test_path_invalid");
    assert.equal(await checkedReadFile(leaf, "test_path_invalid", "utf8"), "second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("sleep/day boundary rejects identity replacement and reparse ancestors before external access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-sleep-boundary-identity-")),
    leaf = path.join(root, "leaf");
  try {
    await checkedAtomicWrite(leaf, "one", "test_path_invalid");
    const boundary = await capturePathBoundary(leaf, "test_path_invalid");
    await rm(leaf);
    await checkedAtomicWrite(leaf, "two", "test_path_invalid");
    await assert.rejects(assertPathBoundary(boundary, "identity_drift"), { code: "identity_drift" });
    const info = {
      isSymbolicLink: () => false,
      isFile: () => true,
      isDirectory: () => false,
      dev: 1,
      ino: 1,
      mode: 0o100600,
      size: 1,
      ctimeMs: 1,
    };
    await assert.rejects(
      assertNoReparsePoint("x", {
        platform: "win32",
        lstatPath: async () => info,
        statPath: async () => info,
        windowsAttributesOf: async () => 0x400,
      }),
      { code: "reparse_point_detected" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("sleep/day output creation is parent-validated before the new leaf is accessed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-sleep-boundary-order-")),
    leaf = path.join(root, "new.json");
  try {
    await checkedAtomicWrite(leaf, "created", "test_path_invalid");
    assert.equal(await checkedReadFile(leaf, "test_path_invalid", "utf8"), "created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("sleep/day model validation rejects locked-tool and fresh-snapshot content drift", () => {
  const sources = state(),
    changedPayload = {
      files: [{ relativePath: "x", lengthBytes: 1, sha256: sha("y") }],
      sha256: digest([{ relativePath: "x", lengthBytes: 1, sha256: sha("y") }]),
    };
  assert.throws(() => validate(model(), sources, changedPayload), { code: "tool_payload_drift" });
  const drifted = state();
  drifted.buffers[ANCHORS[0][1]] = Buffer.from("changed");
  drifted.files = Object.entries(drifted.buffers)
    .map(([relativePath, bytes]) => ({ relativePath, lengthBytes: bytes.length, sha256: sha(bytes) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  assert.throws(() => validate(model(), drifted, payload), { code: "manifest_tree_mismatch" });
});
test("sleep/day boundary rejects the actual M9 artifact rather than relabeling it", async () => {
  const m9 = JSON.parse(await readFile("tools/stardew-portfolio-m9-accept-special-order-source-boundary.json", "utf8"));
  assert.throws(() => validate(m9, state(), payload), { code: "schema_invalid" });
});
