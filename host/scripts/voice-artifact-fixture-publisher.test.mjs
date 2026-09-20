import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { publishVoiceGatewayFixture } from "./voice-artifact-fixture-publisher.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-voice-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

 test("descriptor absent creates no output", async (t) => {
  const root = await fixtureRoot(t);
  assert.equal(await publishVoiceGatewayFixture({ stagingRoot: root, descriptor: undefined }), undefined);
  assert.deepEqual(await readdir(root), []);
});

test("single-file entry and protocol are copied and bound by the sidecar", async (t) => {
  const root = await fixtureRoot(t);
  const input = await mkdtemp(join(tmpdir(), "gamebuddy-voice-input-"));
  t.after(() => rm(input, { recursive: true, force: true }));
  const entry = Buffer.from("entry fixture\n");
  const protocol = Buffer.from("protocol fixture\n");
  const entryInput = join(input, "entry"); const protocolInput = join(input, "protocol");
  await mkdir(entryInput); await mkdir(protocolInput);
  await writeFile(join(entryInput, "entry.mjs"), entry);
  await writeFile(join(protocolInput, "protocol.json"), protocol);

  const result = await publishVoiceGatewayFixture({
    stagingRoot: root,
    descriptor: {
      generation: "generation-test",
      entry: { source: entryInput, destination: "runtime/entry" },
      protocol: { source: protocolInput, destination: "runtime/protocol" },
    },
  });
  assert.equal(result.admission.schema, "gamebuddy-host-voice-gateway-admission/v1");
  assert.equal(result.admission.generation, "generation-test");
  assert.equal(result.admission.entryPath, "runtime/entry/entry.mjs");
  assert.equal(result.admission.protocolPath, "runtime/protocol/protocol.json");
  assert.equal(result.admission.entrySha256, digest(entry));
  assert.equal(result.admission.protocolSha256, digest(protocol));
  assert.equal(await readFile(resolve(root, result.admission.entryPath), "utf8"), entry.toString());
  assert.equal(await readFile(resolve(root, result.admission.protocolPath), "utf8"), protocol.toString());
  assert.match(result.admission.inventoryDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.admission.entrySha256, digest(await readFile(resolve(root, result.admission.entryPath))));
  assert.equal(result.admission.protocolSha256, digest(await readFile(resolve(root, result.admission.protocolPath))));
});

test("missing input is rejected", async (t) => {
  const root = await fixtureRoot(t);
  await assert.rejects(
    publishVoiceGatewayFixture({ stagingRoot: root, descriptor: { entry: { source: join(root, "missing"), destination: "entry" }, protocol: { source: join(root, "missing-protocol"), destination: "protocol" } } }),
    /voice_fixture_entry_missing/,
  );
});

test("traversal destination is rejected", async (t) => {
  const root = await fixtureRoot(t);
  await assert.rejects(
    publishVoiceGatewayFixture({ stagingRoot: root, descriptor: { entry: { source: join(root, "missing"), destination: "../escape" }, protocol: { source: join(root, "missing"), destination: "protocol" } } }),
    /voice_fixture_entry_destination_unsafe_path/,
  );
});

test("symlink input is rejected, or explicitly skipped when symlinks are unavailable", async (t) => {
  const root = await fixtureRoot(t);
  const target = join(root, "target");
  const link = join(root, "link");
  await writeFile(target, "target");
  try { await symlink(target, link); } catch (error) { t.skip(`symlink creation unavailable: ${error.code ?? error.message}`); return; }
  await assert.rejects(
    publishVoiceGatewayFixture({ stagingRoot: root, descriptor: { entry: { source: link, destination: "entry" }, protocol: { source: target, destination: "protocol" } } }),
    /voice_fixture_entry_missing/,
  );
});

test("multi-file entry and protocol inputs are rejected", async (t) => {
  const root = await fixtureRoot(t);
  const entry = join(root, "entry"); const protocol = join(root, "protocol");
  await mkdir(entry); await mkdir(protocol);
  await writeFile(join(entry, "one"), "one"); await writeFile(join(entry, "two"), "two");
  await writeFile(join(protocol, "one"), "one"); await writeFile(join(protocol, "two"), "two");
  await assert.rejects(
    publishVoiceGatewayFixture({ stagingRoot: root, descriptor: { entry: { source: entry, destination: "entry-out" }, protocol: { source: protocol, destination: "protocol-out" } } }),
    /voice_fixture_entry_protocol_must_be_single_files/,
  );
});
