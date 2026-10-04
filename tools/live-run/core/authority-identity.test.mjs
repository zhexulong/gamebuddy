import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AUTHORITY_DIRECTORY_NAME,
  authorityMarkerPath,
  explainAuthorityIdentityMismatch,
  readAuthorityOperationId,
} from "./authority-identity.mjs";

async function rootWithMarker(t, operationId) {
  const root = await mkdtemp(join(tmpdir(), "authority-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, AUTHORITY_DIRECTORY_NAME), { recursive: true });
  await writeFile(
    authorityMarkerPath(root),
    JSON.stringify({ version: 21, bootstrapOperationId: operationId }),
    "utf8",
  );
  return root;
}

test("names both ids when the manifest disagrees with the authority marker", async (t) => {
  // The exact live-run shape: marker from the run that provisioned the root,
  // manifest overwritten by a later run.
  const root = await rootWithMarker(t, "agent-ab-1791121825880");
  const original = new Error("dialogue_exited_before_ready:1:production_authority_artifact_present");
  const explained = explainAuthorityIdentityMismatch(original, root, {
    bootstrapOperationId: "agent-ab-1791122324799",
  });
  assert.notEqual(explained, original);
  assert.match(explained.message, /runtime_root_authority_identity_mismatch/);
  assert.match(explained.message, /agent-ab-1791121825880/);
  assert.match(explained.message, /agent-ab-1791122324799/);
  // The original diagnosis is preserved, not replaced.
  assert.match(explained.message, /production_authority_artifact_present/);
  assert.equal(explained.cause, original);
});

test("a matching pair returns the original error untouched", async (t) => {
  const root = await rootWithMarker(t, "agent-ab-same");
  const original = new Error("production_authority_artifact_present");
  assert.equal(explainAuthorityIdentityMismatch(original, root, { bootstrapOperationId: "agent-ab-same" }), original);
});

test("an unreadable marker returns the original error instead of masking a real failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "authority-identity-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new Error("production_authority_artifact_present");
  assert.equal(readAuthorityOperationId(root), undefined);
  assert.equal(explainAuthorityIdentityMismatch(original, root, { bootstrapOperationId: "x" }), original);
  // A malformed marker is a read miss, never a throw.
  await mkdir(join(root, AUTHORITY_DIRECTORY_NAME), { recursive: true });
  await writeFile(authorityMarkerPath(root), "{not json", "utf8");
  assert.equal(explainAuthorityIdentityMismatch(original, root, { bootstrapOperationId: "x" }), original);
});
