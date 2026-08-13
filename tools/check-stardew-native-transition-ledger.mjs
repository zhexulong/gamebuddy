import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validateNativeTransitionLedger } from "./lib/stardew-native-transition-ledger.mjs";
import { validateNativeMechanismReviewRegister } from "./lib/stardew-native-mechanism-review-register.mjs";
import { validateNativeTransitionScopeManifest } from "./lib/stardew-native-transition-scope-manifest.mjs";

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) fail("transition_ledger_argument_invalid", `Unexpected argument ${option}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("transition_ledger_argument_invalid", `Missing value for ${option}.`);
    result[option.slice(2)] = value;
  }
  if (
    !result.ledger ||
    !result["mechanism-report"] ||
    !result["review-register"] ||
    !result["scope-manifest"] ||
    !result["source-root"]
  ) {
    fail(
      "transition_ledger_arguments_required",
      "Usage: --ledger <ledger.json> --mechanism-report <native-interaction-mechanisms.json> --review-register <complete-review-register.json> --scope-manifest <exact-scope.json> --source-root <fresh-exact-decompile-root>",
    );
  }
  return result;
}

async function json(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail("transition_ledger_json_invalid", `Could not read ${label} JSON.`, { filePath, cause: error.message });
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.endsWith(".cs") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function attestationFrom(report) {
  if (report?.artifactKind !== "native_interaction_mechanism_enumeration") {
    fail("transition_ledger_mechanism_report_invalid", "Expected a native interaction mechanism enumeration report.");
  }
  const targetAssemblySha256 = report?.target?.sha256;
  const sourceManifestSha256 = report?.source?.sourceManifestSha256;
  const mechanisms = report?.enumeration?.mechanisms;
  if (
    typeof targetAssemblySha256 !== "string" ||
    typeof sourceManifestSha256 !== "string" ||
    !Array.isArray(mechanisms)
  ) {
    fail(
      "transition_ledger_mechanism_report_invalid",
      "Mechanism report is missing exact-target attestation or mechanism rows.",
    );
  }
  const sourceFiles = report?.source?.files;
  if (!Array.isArray(sourceFiles))
    fail("transition_ledger_mechanism_report_invalid", "Mechanism report lacks the exact source file manifest.");
  if (!isSha256(targetAssemblySha256) || !isSha256(sourceManifestSha256))
    fail("transition_ledger_mechanism_report_invalid", "Mechanism report exact-target attestation is malformed.");
  const sourceFileHashes = {};
  for (const entry of sourceFiles) {
    if (
      !safeRelativePath(entry?.relativePath) ||
      !isSha256(entry?.sha256) ||
      !Number.isInteger(entry?.byteLength) ||
      entry.byteLength < 0 ||
      sourceFileHashes[entry.relativePath]
    ) {
      fail(
        "transition_ledger_mechanism_report_invalid",
        "Mechanism report source manifest has duplicate, unsafe, or malformed records.",
        { entry },
      );
    }
    sourceFileHashes[entry.relativePath] = entry.sha256;
  }
  const mechanismIds = mechanisms.map((row) => row?.mechanismId);
  if (mechanismIds.some((id) => typeof id !== "string" || !id) || new Set(mechanismIds).size !== mechanismIds.length) {
    fail("transition_ledger_mechanism_report_invalid", "Mechanism report contains missing or duplicate mechanism IDs.");
  }
  return { targetAssemblySha256, sourceManifestSha256, mechanismIds, mechanisms, sourceFileHashes };
}

async function exactSources(sourceRoot, expectedSourceFileHashes) {
  const result = {};
  for (const [relativePath, expectedHash] of Object.entries(expectedSourceFileHashes)) {
    const candidate = path.resolve(sourceRoot, relativePath);
    const relative = path.relative(sourceRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      fail("transition_ledger_source_root_unsafe", "Source manifest path escaped the declared source root.", {
        relativePath,
      });
    let text;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      fail("transition_ledger_source_missing", "Exact source root is missing a manifest file.", {
        relativePath,
        cause: error.message,
      });
    }
    const actualHash = sha256(text);
    if (actualHash !== expectedHash)
      fail("transition_ledger_source_root_stale", "Source-root file does not match the mechanism report manifest.", {
        relativePath,
        expectedHash,
        actualHash,
      });
    result[relativePath] = { sha256: actualHash, text };
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2).filter((argument) => argument !== "--"));
  const ledger = await json(args.ledger, "transition ledger");
  const report = await json(args["mechanism-report"], "mechanism report");
  const reviewRegister = await json(args["review-register"], "mechanism review register");
  const scopeManifest = await json(args["scope-manifest"], "transition scope manifest");
  const expected = attestationFrom(report);
  if (
    ledger?.attestation?.targetAssemblySha256 !== expected.targetAssemblySha256 ||
    ledger?.attestation?.sourceManifestSha256 !== expected.sourceManifestSha256
  ) {
    fail(
      "transition_ledger_attestation_stale",
      "Transition ledger attestation does not match the exact mechanism report.",
      {
        expected: {
          targetAssemblySha256: expected.targetAssemblySha256,
          sourceManifestSha256: expected.sourceManifestSha256,
        },
        actual: ledger?.attestation,
      },
    );
  }
  const sourceFiles = await exactSources(path.resolve(args["source-root"]), expected.sourceFileHashes);
  const exactAttestation = {
    targetAssemblySha256: expected.targetAssemblySha256,
    sourceManifestSha256: expected.sourceManifestSha256,
  };
  validateNativeTransitionScopeManifest(scopeManifest, { expectedAttestation: exactAttestation });
  const review = validateNativeMechanismReviewRegister(reviewRegister, {
    mechanismReport: report,
    sourceTexts: Object.fromEntries(
      Object.entries(sourceFiles).map(([sourcePath, source]) => [sourcePath, source.text]),
    ),
  });
  const result = validateNativeTransitionLedger(ledger, {
    expectedMechanismIds: expected.mechanismIds,
    expectedMechanismRecords: expected.mechanisms,
    reviewedMechanismDispositions: review.dispositionByMechanismId,
    scopeManifest,
    sourceFiles,
    expectedAttestation: exactAttestation,
  });
  const dispositionCounts = Object.values(review.dispositionByMechanismId).reduce(
    (counts, disposition) => ({ ...counts, [disposition]: (counts[disposition] ?? 0) + 1 }),
    {},
  );
  process.stdout.write(
    `${JSON.stringify({ artifactKind: "native_transition_ledger_check", sourceMechanismCount: expected.mechanismIds.length, mechanismReviewDispositionCounts: dispositionCounts, ...result }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.code ?? "transition_ledger_check_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
