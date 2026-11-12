import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesktopTemporaryDataMaintenance,
  type TemporaryDataMaintenance,
  type TemporaryDataRootIdentity,
} from "./desktop-temporary-data-maintenance.js";
import {
  type TemporaryDataClearProbe,
  TemporaryDataClearRefused,
  type TemporaryDataRootId,
  type TemporaryDataRootLayout,
  clearTemporaryData,
  declaredTemporaryDataRoots,
  inspectTemporaryData,
  retainedTemporaryDataKinds,
  updateStagingDirectory,
} from "./temporary-data-clear.js";

const roots: string[] = [];

test.afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * A real four-root layout on disk: the launcher's shape, with the durable root
 * holding something a clear must never reach and the operational root holding
 * the deployment manifest beside the host-exit diagnostics.
 */
async function realLayout(): Promise<TemporaryDataRootLayout> {
  const base = await mkdtemp(join(tmpdir(), "gamebuddy-temporary-data-"));
  roots.push(base);
  const layout = {
    programRoot: join(base, "Programs", "GameBuddy"),
    dataRoot: join(base, "GameBuddy", "data"),
    operationalRoot: join(base, "GameBuddy", "operational"),
    presentationRoot: join(base, "GameBuddy", "presentation"),
  };
  await Promise.all([
    mkdir(layout.programRoot, { recursive: true }),
    mkdir(layout.dataRoot, { recursive: true }),
    mkdir(layout.operationalRoot, { recursive: true }),
    mkdir(layout.presentationRoot, { recursive: true }),
  ]);
  await writeFile(join(layout.dataRoot, "gamebuddy-continuity-v1.sqlite"), "durable", "utf8");
  await writeFile(join(layout.operationalRoot, "deployment-manifest.json"), "{}", "utf8");
  return layout;
}

function probe(
  overrides: Readonly<{
    openWriterRootIds?: readonly TemporaryDataRootId[];
    rootIdentityVerified?: boolean;
  }> = {},
): TemporaryDataClearProbe {
  return Object.freeze({
    openWriterRootIds: () => overrides.openWriterRootIds ?? [],
    rootIdentityVerified: async () => overrides.rootIdentityVerified ?? true,
  });
}

async function writeHostExitRecord(layout: TemporaryDataRootLayout, name: string, body: string): Promise<string> {
  const directory = declaredTemporaryDataRoots(layout)[1]!.directory;
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, body, "utf8");
  return path;
}

test("a clear empties the declared roots and reports what each one lost", async () => {
  const layout = await realLayout();
  const record = await writeHostExitRecord(layout, "host-exit-1-7.json", '{"kind":"crash"}\n');
  await mkdir(join(layout.presentationRoot, "profile", "cache"), { recursive: true });
  await writeFile(join(layout.presentationRoot, "profile", "cache", "blob"), "presentation", "utf8");
  assert.notEqual(record, undefined);

  const report = await clearTemporaryData(layout, probe());

  assert.deepEqual(
    report.roots.map((entry) => [entry.rootId, entry.outcome, entry.files]),
    [
      ["presentation", "cleared", 1],
      ["host_exit_records", "cleared", 1],
    ],
  );
  assert.equal(report.removedFiles, 2);
  assert.deepEqual(await readdir(layout.presentationRoot), []);
  assert.deepEqual(await readdir(declaredTemporaryDataRoots(layout)[1]!.directory), []);
});

test("a clear leaves every declared root directory itself in place", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");

  await clearTemporaryData(layout, probe());

  // The launcher's derivation refuses a missing root, so emptying one is the
  // whole of what a clear may do to it.
  for (const root of declaredTemporaryDataRoots(layout)) {
    assert.notEqual((await readdir(root.directory)).length, undefined, root.id);
  }
});

test("the durable root, the deployment manifest and the update staging survive a clear", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");
  await mkdir(updateStagingDirectory(layout), { recursive: true });
  assert.deepEqual(
    retainedTemporaryDataKinds(layout).map((entry) => entry.kind),
    ["durable_data", "credentials", "chat", "memory", "game_lifecycle", "update_staging"],
  );

  await clearTemporaryData(layout, probe());

  assert.equal(await readFile(join(layout.dataRoot, "gamebuddy-continuity-v1.sqlite"), "utf8"), "durable");
  assert.equal(await readFile(join(layout.operationalRoot, "deployment-manifest.json"), "utf8"), "{}");
  assert.deepEqual(await readdir(updateStagingDirectory(layout)), []);
});

test("a second clear of the same roots removes nothing and says so", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");
  const first = await clearTemporaryData(layout, probe());
  assert.equal(first.removedFiles, 1);

  const second = await clearTemporaryData(layout, probe());

  assert.equal(second.removedFiles, 0);
  assert.equal(second.removedBytes, 0);
  assert.deepEqual(
    second.roots.map((entry) => entry.files),
    [0, 0],
  );
});

test("the clear refuses while the updater holds its staging directory", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");
  await mkdir(updateStagingDirectory(layout), { recursive: true });
  await writeFile(join(updateStagingDirectory(layout), "installer.exe"), "staged", "utf8");

  await assert.rejects(
    clearTemporaryData(layout, probe()),
    (error: unknown) => error instanceof TemporaryDataClearRefused && error.code === "temporary_data_update_in_flight",
  );
  // Refused means nothing was removed, not "removed the rest".
  assert.deepEqual(await readdir(declaredTemporaryDataRoots(layout)[1]!.directory), ["host-exit-1-7.json"]);
});

test("a root whose writer is open is named and left alone while the other root is cleared", async () => {
  const layout = await realLayout();
  const record = await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");

  const report = await clearTemporaryData(layout, probe({ openWriterRootIds: ["presentation"] }));

  assert.deepEqual(
    report.roots.map((entry) => [entry.rootId, entry.outcome]),
    [
      ["presentation", "writer_open"],
      ["host_exit_records", "cleared"],
    ],
  );
  assert.equal(report.removedFiles, 1);
  assert.deepEqual(await readdir(declaredTemporaryDataRoots(layout)[1]!.directory), []);
  assert.notEqual(record, undefined);
});

test("the clear refuses with its own code when every requested root has an open writer", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");

  await assert.rejects(
    clearTemporaryData(layout, probe({ openWriterRootIds: ["presentation", "host_exit_records"] })),
    (error: unknown) => error instanceof TemporaryDataClearRefused && error.code === "temporary_data_writer_open",
  );
  assert.deepEqual(await readdir(declaredTemporaryDataRoots(layout)[1]!.directory), ["host-exit-1-7.json"]);
});

test("the clear refuses when the roots are no longer the objects the launch admitted", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");

  await assert.rejects(
    clearTemporaryData(layout, probe({ rootIdentityVerified: false })),
    (error: unknown) =>
      error instanceof TemporaryDataClearRefused && error.code === "temporary_data_root_identity_unverified",
  );
  assert.deepEqual(await readdir(declaredTemporaryDataRoots(layout)[1]!.directory), ["host-exit-1-7.json"]);
});

test("a requested root id the declaration does not hold is refused", async () => {
  const layout = await realLayout();

  for (const requested of [["data_root"], [], ["presentation", "rotated_logs"]]) {
    await assert.rejects(
      clearTemporaryData(layout, probe(), requested),
      (error: unknown) =>
        error instanceof TemporaryDataClearRefused && error.code === "temporary_data_path_outside_declared_roots",
      `requested ${JSON.stringify(requested)} must not resolve to a path`,
    );
  }
});

test("an inspect still prints what a refused clear would have removed", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");
  await mkdir(updateStagingDirectory(layout), { recursive: true });
  await writeFile(join(updateStagingDirectory(layout), "installer.exe"), "staged", "utf8");

  const inspection = await inspectTemporaryData(layout, probe());

  assert.equal(inspection.updateInFlight, true);
  assert.equal(inspection.updateStagingDirectory, updateStagingDirectory(layout));
  assert.deepEqual(
    inspection.roots.map((entry) => [entry.rootId, entry.files]),
    [
      ["presentation", 0],
      ["host_exit_records", 1],
    ],
  );
  assert.deepEqual(
    inspection.retained.map((entry) => entry.directory),
    [layout.dataRoot, null, layout.dataRoot, layout.dataRoot, layout.dataRoot, updateStagingDirectory(layout)],
  );
});

test("an inspect names the root whose writer is open", async () => {
  const layout = await realLayout();

  const inspection = await inspectTemporaryData(layout, probe({ openWriterRootIds: ["presentation"] }));

  assert.deepEqual(inspection.writerOpenRootIds, ["presentation"]);
});

test("a declared root that overlaps the durable root is refused instead of emptied", async () => {
  const layout = await realLayout();
  // The injected violation: a later descriptor that names a directory inside the
  // durable root. Nothing about the call changes; only the declaration is wrong.
  const misDeclared = { ...layout, presentationRoot: join(layout.dataRoot, "presentation") };
  await mkdir(misDeclared.presentationRoot, { recursive: true });
  await writeFile(join(misDeclared.presentationRoot, "keep"), "durable", "utf8");

  await assert.rejects(
    clearTemporaryData(misDeclared, probe()),
    (error: unknown) =>
      error instanceof TemporaryDataClearRefused && error.code === "temporary_data_path_outside_declared_roots",
  );
  await assert.rejects(
    inspectTemporaryData(misDeclared, probe()),
    (error: unknown) =>
      error instanceof TemporaryDataClearRefused && error.code === "temporary_data_path_outside_declared_roots",
  );
  assert.equal(await readFile(join(misDeclared.presentationRoot, "keep"), "utf8"), "durable");
});

test("the maintenance handle reports the presentation root busy exactly while the presenter serves", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");
  const identity: TemporaryDataRootIdentity = { volumeIdentity: "v", fileId: "f", isReparsePoint: false };
  const maintenance: TemporaryDataMaintenance = await createDesktopTemporaryDataMaintenance(
    layout,
    async () => identity,
  );

  assert.deepEqual((await maintenance.inspect()).writerOpenRootIds, []);
  maintenance.presentationServing(true);
  assert.deepEqual((await maintenance.inspect()).writerOpenRootIds, ["presentation"]);
  const report = await maintenance.clear();
  assert.deepEqual(
    report.roots.map((entry) => [entry.rootId, entry.outcome]),
    [
      ["presentation", "writer_open"],
      ["host_exit_records", "cleared"],
    ],
  );
  maintenance.presentationServing(false);
  // Served again from the same handle: the write it just did is invisible to the
  // identity reading the launch admitted, so the root still verifies.
  assert.equal((await maintenance.inspect()).rootIdentityVerified, true);
});

test("the maintenance handle refuses when a root is no longer the admitted object", async () => {
  const layout = await realLayout();
  await writeHostExitRecord(layout, "host-exit-1-7.json", "{}\n");
  let reads = 0;
  const maintenance = await createDesktopTemporaryDataMaintenance(layout, async () => {
    reads += 1;
    const admitted: TemporaryDataRootIdentity = { volumeIdentity: "v", fileId: "f", isReparsePoint: false };
    return reads <= 2 ? admitted : { volumeIdentity: "v", fileId: "swapped", isReparsePoint: false };
  });

  await assert.rejects(
    maintenance.clear(),
    (error: unknown) =>
      error instanceof TemporaryDataClearRefused && error.code === "temporary_data_root_identity_unverified",
  );
  assert.deepEqual(await readdir(declaredTemporaryDataRoots(layout)[1]!.directory), ["host-exit-1-7.json"]);
});
