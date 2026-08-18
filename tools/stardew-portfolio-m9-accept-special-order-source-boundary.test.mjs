import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHORS,
  BLOCKER_CODE,
  ILSPY_EXECUTION_ENVIRONMENT_POLICY,
  OPTIONS,
  TARGET_LENGTH,
  TARGET_SHA256,
  TOOL_PATH,
  TOOL_PAYLOAD_ROOT,
  TOOL_SHA256,
  TOOL_VERSION,
  TRUST_BOUNDARY,
  assertNoReparsePoint,
  configurationDigest,
  decompile,
  ilspyExecutionEnvironment,
  lockedTool,
  methodSlice,
  validate,
} from "./lib/stardew-portfolio-m9-accept-special-order-source-boundary.mjs";
const authorityHash = "a".repeat(64);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestDigest = (files) =>
  digest(files.map((f) => `${f.relativePath}\t${f.lengthBytes}\t${f.sha256}`).join("\n") + "\n");
function sourceText(definition) {
  const [, , signature, required] = definition;
  return `${signature}\n{\n${required.map((value) => `  ${value};`).join("\n")}\n}\n`;
}
function fixture() {
  return Object.fromEntries(ANCHORS.map((definition) => [definition[1], Buffer.from(sourceText(definition))]));
}
function state(files = fixture()) {
  const manifest = Object.entries(files)
    .map(([relativePath, bytes]) => ({ relativePath, lengthBytes: bytes.length, sha256: digest(bytes) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files: manifest, buffers: files };
}
const payloadFiles = [{ relativePath: "ilspycmd.dll", lengthBytes: 1, sha256: digest(Buffer.from("x")) }];
const payload = { files: payloadFiles, sha256: manifestDigest(payloadFiles) };
function model() {
  const source = state();
  return {
    schemaVersion: 3,
    artifactKind: "portfolio_m9_accept_special_order_source_boundary",
    attestationId: "portfolio_m9_accept_special_order_source_boundary_v1",
    extractedAtUtc: "2026-01-01T00:00:00.000Z",
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
      toolPayload: {
        fileCount: payload.files.length,
        sha256: payload.sha256,
        files: payload.files.map((file) => ({ ...file })),
      },
      options: OPTIONS,
      executionEnvironmentPolicy: ILSPY_EXECUTION_ENVIRONMENT_POLICY,
      configurationDigest,
    },
    trustBoundary: TRUST_BOUNDARY,
    actionContractAuthority: {
      relativePath: "tools/stardew-portfolio-m9-special-order-action-contract.json",
      sha256: authorityHash,
    },
    sourceManifest: { fileCount: source.files.length, sha256: manifestDigest(source.files), files: source.files },
    anchors: ANCHORS.map(([anchorId, relativePath, methodSignature, required, forbidden, semanticRole]) => {
      const bytes = source.buffers[relativePath];
      const slice = methodSlice(bytes, methodSignature);
      return {
        anchorId,
        relativePath,
        methodSignature,
        startByte: slice.startByte,
        endByte: slice.endByte,
        fileSha256: digest(bytes),
        methodSliceSha256: digest(slice.bytes),
        required,
        forbidden,
        semanticRole,
      };
    }),
    boundary: {
      prohibitedIngress: "StardewValley.Menus.SpecialOrdersBoard.receiveLeftClick",
      nonUiMethod: "StardewValley.FarmerTeam.AddSpecialOrder",
      missingSemantics: [
        "fresh selected available-offer membership",
        "accepted board-type commit",
        "single native acceptance transaction",
      ],
      approvedRoute: "none",
    },
    conclusion: {
      primitiveSourceRealizationStatus: "blocked",
      projectionState: "blocked",
      liveState: "not_performed",
      blockerCode: BLOCKER_CODE,
      nonClaim: "source boundary only",
    },
  };
}
test("M9 accepts only complete method-bound anchors and its fixed blocked conclusion", () => {
  const result = validate(model(), authorityHash, state(), payload);
  assert.equal(result.blockerCode, BLOCKER_CODE);
  assert.equal(result.anchorCount, 2);
});
test("M9 rejects conclusion promotion, payload closure drift, and complete-tree mismatch", () => {
  const promoted = model();
  promoted.conclusion.primitiveSourceRealizationStatus = "realized";
  assert.throws(() => validate(promoted, authorityHash, state(), payload), { code: "conclusion_invalid" });
  const drift = model();
  drift.decompilation.toolPayload.files[0].sha256 = "0".repeat(64);
  assert.throws(() => validate(drift, authorityHash, state(), payload), { code: "tool_payload_invalid" });
  const missing = model();
  missing.sourceManifest.files.pop();
  missing.sourceManifest.fileCount--;
  missing.sourceManifest.sha256 = manifestDigest(missing.sourceManifest.files);
  assert.throws(() => validate(missing, authorityHash, state(), payload), { code: "manifest_tree_mismatch" });
});
test("M9 rejects duplicate/decoy signatures and semantics outside the exact method slice", () => {
  const duplicate = fixture();
  duplicate[ANCHORS[0][1]] = Buffer.from(`${sourceText(ANCHORS[0])}\n${sourceText(ANCHORS[0])}`);
  assert.throws(() => validate(model(), authorityHash, state(duplicate), payload), { code: "manifest_tree_mismatch" });
  const decoy = fixture();
  decoy[ANCHORS[1][1]] = Buffer.from(
    `${ANCHORS[1][2]}\n{\n SpecialOrder specialOrder = SpecialOrder.GetSpecialOrder(id, generationSeed);\n specialOrders.Add(specialOrder);\n}\n// acceptedSpecialOrderTypes\n`,
  );
  const candidate = model();
  const decoyState = state(decoy);
  candidate.sourceManifest = {
    fileCount: decoyState.files.length,
    sha256: manifestDigest(decoyState.files),
    files: decoyState.files,
  };
  assert.throws(() => validate(candidate, authorityHash, decoyState, payload), { code: "anchor_semantics_missing" });
});
test("M9 rejects Windows FileAttributes.ReparsePoint through the portable helper seam", async () => {
  const normal = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, mode: 0o100000 };
  await assert.rejects(
    () =>
      assertNoReparsePoint("C:/fixture", {
        platform: "win32",
        lstatPath: async () => normal,
        statPath: async () => normal,
        windowsAttributesOf: async () => 0x400,
      }),
    { code: "reparse_point_detected" },
  );
  await assert.doesNotReject(() =>
    assertNoReparsePoint("C:/fixture", {
      platform: "win32",
      lstatPath: async () => normal,
      statPath: async () => normal,
      windowsAttributesOf: async () => 0,
    }),
  );
});
test("M9 executes ILSpy under the explicit sanitized environment policy", () => {
  const env = ilspyExecutionEnvironment({
    SystemRoot: "C:/Windows",
    WINDIR: "C:/Windows",
    TEMP: "C:/Temp",
    TMP: "C:/Temp",
    ILSPYCMD_PATH: "poison",
    DOTNET_ROOT: "poison",
    ILSPY_CONFIG: "poison",
  });
  assert.deepEqual(env, { SystemRoot: "C:/Windows", WINDIR: "C:/Windows", TEMP: "C:/Temp", TMP: "C:/Temp" });
});
test("M9 rejects schema and trust-boundary drift", () => {
  const closureDrift = model();
  closureDrift.decompilation.executionEnvironmentPolicy = { ...ILSPY_EXECUTION_ENVIRONMENT_POLICY, mode: "inherited" };
  assert.throws(() => validate(closureDrift, authorityHash, state(), payload), { code: "decompile_config_drift" });
  const tcbDrift = model();
  tcbDrift.trustBoundary = { localCheckerTcb: [...TRUST_BOUNDARY.localCheckerTcb], outsideLocalCheckerBoundary: [] };
  assert.throws(() => validate(tcbDrift, authorityHash, state(), payload), { code: "trust_boundary_drift" });
});
test("M9 rejects reparse snapshot roots where supported and ignores ILSPYCMD_PATH", async (t) => {
  const previous = process.env.ILSPYCMD_PATH;
  process.env.ILSPYCMD_PATH = "definitely-not-ilspycmd";
  try {
    const tool = await lockedTool();
    assert.equal(tool.path, TOOL_PATH);
    assert.equal(tool.payload.files.length > 0, true);
  } finally {
    if (previous === undefined) delete process.env.ILSPYCMD_PATH;
    else process.env.ILSPYCMD_PATH = previous;
  }
  await assert.rejects(() => decompile({ lengthBytes: TARGET_LENGTH, sha256: TARGET_SHA256 }), {
    code: "target_snapshot_required",
  });
  if (process.platform === "win32") {
    t.skip("Windows reparse behavior is covered by targetAssembly/validateSnapshot during target derive.");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-m9-reparse-"));
  try {
    await writeFile(path.join(root, "target"), "x");
    await symlink(path.join(root, "target"), path.join(root, "link"));
    const { validateSnapshot } = await import("./lib/stardew-portfolio-m9-accept-special-order-source-boundary.mjs");
    await assert.rejects(
      () =>
        validateSnapshot({
          snapshotRoot: root,
          snapshotPath: path.join(root, "link"),
          lengthBytes: TARGET_LENGTH,
          sha256: TARGET_SHA256,
        }),
      { code: "snapshot_boundary_invalid" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
