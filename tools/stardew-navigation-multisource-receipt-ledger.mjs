#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OBSERVATION_SCOPE,
  PASS_PREDICATE,
  TARGET_BUILD,
  validateMultiSourceTransitionCharacterization,
} from "./stardew-navigation-multisource-characterization-validator.mjs";

/**
 * Reviewed production receipt registry. It begins empty: adding a record is a
 * code-reviewed action after an independently audited real passed artifact.
 */
export const PRODUCTION_RECEIPT_REGISTRY = Object.freeze([]);
export const PRODUCTION_RECEIPT_LEDGER_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".task5-multisource-receipt-ledger",
);

const MARKER_SCHEMA_VERSION = 1;
const RECEIPT_ID = /^[a-z0-9_]+$/;
const DIGEST = /^[a-f0-9]{64}$/;
const claimRecords = new WeakMap();

function validRegistryRecord(record) {
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 4 &&
    Object.hasOwn(record, "receiptId") &&
    Object.hasOwn(record, "artifactSha256") &&
    Object.hasOwn(record, "targetBuild") &&
    Object.hasOwn(record, "observationScope") &&
    typeof record.receiptId === "string" && RECEIPT_ID.test(record.receiptId) &&
    typeof record.artifactSha256 === "string" && DIGEST.test(record.artifactSha256) &&
    record.targetBuild === TARGET_BUILD &&
    record.observationScope === OBSERVATION_SCOPE;
}

function validRegistry(registry) {
  return Array.isArray(registry) &&
    registry.every(validRegistryRecord) &&
    new Set(registry.map((record) => record.receiptId)).size === registry.length &&
    new Set(registry.map((record) => record.artifactSha256)).size === registry.length;
}

function blocked() {
  return Object.freeze({ ok: false });
}

/**
 * Creates a receipt ledger. The production instance has a fixed project root
 * and fixed reviewed registry. Test instances may inject both explicitly.
 */
function createMultiSourceReceiptLedger({ root, registry, io = { lstat, mkdir, writeFile } }) {
  if (typeof root !== "string" || !validRegistry(registry) || !io || typeof io.lstat !== "function" || typeof io.mkdir !== "function" || typeof io.writeFile !== "function") {
    throw new TypeError("invalid_multisource_receipt_ledger_configuration");
  }
  const frozenRegistry = Object.freeze(registry.map((record) => Object.freeze({ ...record })));

  function preparePassedClaim({ rawArtifact }) {
    if (!Buffer.isBuffer(rawArtifact)) return blocked();
    let artifact = null;
    try { artifact = JSON.parse(rawArtifact.toString("utf8")); } catch { return blocked(); }
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return blocked();
    if (!validateMultiSourceTransitionCharacterization(artifact).valid) return blocked();
    if (artifact.terminalStatus !== "passed" || artifact.predicateCode !== PASS_PREDICATE || artifact.targetBuild !== TARGET_BUILD || artifact.observationScope !== OBSERVATION_SCOPE) return blocked();
    const artifactSha256 = createHash("sha256").update(rawArtifact).digest("hex");
    const record = frozenRegistry.find((entry) =>
      entry.artifactSha256 === artifactSha256 &&
      entry.targetBuild === artifact.targetBuild &&
      entry.observationScope === artifact.observationScope,
    );
    if (!record) return blocked();
    const claim = Object.freeze({});
    claimRecords.set(claim, record);
    return Object.freeze({ ok: true, claim });
  }

  async function consume(claim) {
    const record = claimRecords.get(claim);
    if (!record) return false;
    const markerPath = join(root, `${record.receiptId}.json`);
    const marker = JSON.stringify({ schemaVersion: MARKER_SCHEMA_VERSION, receiptId: record.receiptId });
    try {
      await io.mkdir(root, { recursive: true });
      const rootStats = await io.lstat(root);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return false;
      await io.writeFile(markerPath, marker, { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ preparePassedClaim, consume });
}

export const productionMultiSourceReceiptLedger = createMultiSourceReceiptLedger({
  root: PRODUCTION_RECEIPT_LEDGER_ROOT,
  registry: PRODUCTION_RECEIPT_REGISTRY,
});

export function createTestMultiSourceReceiptLedger({ root, registry, io } = {}) {
  return createMultiSourceReceiptLedger({ root, registry, ...(io === undefined ? {} : { io }) });
}
