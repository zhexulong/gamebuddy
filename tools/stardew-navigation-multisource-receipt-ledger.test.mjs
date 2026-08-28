import assert from "node:assert";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createTestMultiSourceReceiptLedger,
  PRODUCTION_RECEIPT_REGISTRY,
  PRODUCTION_RECEIPT_LEDGER_ROOT,
} from "./stardew-navigation-multisource-receipt-ledger.mjs";

const BUILD = "1.6.15.24356";
const SCOPE = "multi_hop_ordinary_warp";
const PASS = "successful_multisource_characterization";

function rawArtifact(overrides = {}) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    terminalStatus: "passed",
    targetBuild: BUILD,
    observationScope: SCOPE,
    productionExtractorInvoked: true,
    productionExtractorInvocationCount: 1,
    gameThreadObserved: true,
    worldReadyObserved: true,
    multiSourceObserved: true,
    ordinaryWarpFamilyObserved: true,
    correlationApiShapeVerified: true,
    gameplayMutationCount: 0,
    playerWarpEventCount: 0,
    executionReceiptCount: 0,
    bridgeOrCatalogPublicationCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true },
    predicateCode: PASS,
    ...overrides,
  }));
}

function ledgerFor(raw, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "nav-receipt-ledger-"));
  const registry = [{
    receiptId: "task5d_test_receipt",
    artifactSha256: createHash("sha256").update(raw).digest("hex"),
    targetBuild: BUILD,
    observationScope: SCOPE,
  }];
  return {
    root,
    ledger: createTestMultiSourceReceiptLedger({ root, registry, ...options }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function prepare(ledger, raw) {
  return ledger.preparePassedClaim({ rawArtifact: raw });
}

test("receipt ledger: production registry is fixed empty and root is project-owned", () => {
  assert.deepEqual(PRODUCTION_RECEIPT_REGISTRY, []);
  assert.match(PRODUCTION_RECEIPT_LEDGER_ROOT, /\.task5-multisource-receipt-ledger$/);
});

test("receipt ledger: topology CLI cannot select a registry or ledger root", async () => {
  const topologySource = await readFile(new URL("./stardew-navigation-topology-preflight.mjs", import.meta.url), "utf8");
  assert.equal(topologySource.includes("--ledger-root"), false);
  assert.equal(topologySource.includes("--receipt-registry"), false);
});

test("receipt ledger: a registry-pinned exact raw artifact claim consumes only once with a minimal marker", async () => {
  const raw = rawArtifact();
  const t = ledgerFor(raw);
  try {
    const prepared = prepare(t.ledger, raw);
    assert.equal(prepared.ok, true);
    assert.equal(await t.ledger.consume(prepared.claim), true);
    assert.equal(await t.ledger.consume(prepared.claim), false);
    const marker = JSON.parse(readFileSync(join(t.root, "task5d_test_receipt.json"), "utf8"));
    assert.deepEqual(Object.keys(marker).sort(), ["receiptId", "schemaVersion"]);
    assert.deepEqual(marker, { schemaVersion: 1, receiptId: "task5d_test_receipt" });
  } finally { t.cleanup(); }
});

test("receipt ledger: no registry entry, byte edits, blocked, malformed, build and scope mismatches fail closed", () => {
  const raw = rawArtifact();
  const t = ledgerFor(raw);
  try {
    assert.equal(createTestMultiSourceReceiptLedger({ root: t.root, registry: [] }).preparePassedClaim({ rawArtifact: raw }).ok, false);
    assert.equal(prepare(t.ledger, Buffer.from(`${raw}\n`)).ok, false);
    assert.equal(prepare(t.ledger, rawArtifact({ terminalStatus: "blocked", predicateCode: "world_not_ready", worldReadyObserved: false, productionExtractorInvoked: false, productionExtractorInvocationCount: 0 })).ok, false);
    assert.equal(prepare(t.ledger, Buffer.from(JSON.stringify({ terminalStatus: "passed" }))).ok, false);
    assert.equal(prepare(t.ledger, rawArtifact({ fixtureCleanup: { restored: false } })).ok, false);
    assert.equal(prepare(t.ledger, rawArtifact({ targetBuild: "other" })).ok, false);
    assert.equal(prepare(t.ledger, rawArtifact({ observationScope: "other" })).ok, false);
  } finally { t.cleanup(); }
});

test("receipt ledger: existing marker, collision and ledger I/O failure fail closed", async () => {
  const raw = rawArtifact();
  const t = ledgerFor(raw);
  try {
    const prepared = prepare(t.ledger, raw);
    writeFileSync(join(t.root, "task5d_test_receipt.json"), "existing");
    assert.equal(await t.ledger.consume(prepared.claim), false);
  } finally { t.cleanup(); }

  const collision = ledgerFor(raw);
  try {
    const first = prepare(collision.ledger, raw);
    const second = prepare(collision.ledger, raw);
    assert.equal(await collision.ledger.consume(first.claim), true);
    assert.equal(await collision.ledger.consume(second.claim), false);
  } finally { collision.cleanup(); }

  const failing = ledgerFor(raw, { io: {
    mkdir: async () => {},
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    writeFile: async () => { throw new Error("nope"); },
  } });
  try {
    const prepared = prepare(failing.ledger, raw);
    assert.equal(await failing.ledger.consume(prepared.claim), false);
  } finally { failing.cleanup(); }
});

test("receipt ledger: a symlink/reparse ledger root fails closed before marker creation", async () => {
  const raw = rawArtifact();
  let writeAttempted = false;
  const t = ledgerFor(raw, { io: {
    mkdir: async () => {},
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }),
    writeFile: async () => { writeAttempted = true; },
  } });
  try {
    const prepared = prepare(t.ledger, raw);
    assert.equal(await t.ledger.consume(prepared.claim), false);
    assert.equal(writeAttempted, false);
  } finally { t.cleanup(); }
});
